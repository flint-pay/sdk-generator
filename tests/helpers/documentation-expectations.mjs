// Independent certifier input: codec instructions and finalized annotations only.
// Deliberately imports no documentation compiler, renderer or formatter.
import { compileCodec } from '../../dist/codec-plan.js';
const identity = (value) =>
  JSON.stringify(value, (_, v) =>
    v && !Array.isArray(v) && typeof v === 'object'
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
const modelIndexes = new WeakMap();
export function modelName(schema, definitions) {
  if (schema['x-sdk-ref'] || schema['x-sdk-type-name'])
    return schema['x-sdk-type-name'] ?? schema['x-sdk-ref'];
  let index = modelIndexes.get(definitions);
  if (!index) {
    index = new Map();
    for (const [name, shape] of Object.entries(definitions))
      if (!index.has(identity(shape))) index.set(identity(shape), name);
    modelIndexes.set(definitions, index);
  }
  return index.get(identity(schema));
}

export function schemaFields(schema, definitions, seen = new Set(), intersect = false) {
  const fields = { ...schema.properties },
    required = new Set(schema.required ?? []);
  const ref = schema['x-sdk-ref'];
  for (const part of [
    ...(schema.allOf ?? []),
    ...(ref && definitions[ref] && !seen.has(ref) ? [definitions[ref]] : []),
  ]) {
    const child = schemaFields(part, definitions, ref ? new Set(seen).add(ref) : seen, intersect);
    for (const [key, value] of Object.entries(child.fields))
      fields[key] =
        fields[key] && intersect && identity(fields[key]) !== identity(value)
          ? {
              allOf: [fields[key], value],
              ...(fields[key].readOnly || value.readOnly ? { readOnly: true } : {}),
              ...(fields[key].writeOnly || value.writeOnly ? { writeOnly: true } : {}),
            }
          : (fields[key] ?? value);
    for (const key of child.required) required.add(key);
  }
  return { fields, required };
}
/** Independent compiler facts for graph identity; no backend-only annotations. */
export function expectedDocumentationFacts(s, definitions, response, p = compileCodec(s)) {
  const child = (schema, plan) => expectedDocumentationFacts(schema, definitions, response, plan);
  return {
    value: p.value,
    nullable: p.nullable,
    reference: p.reference,
    model: modelName(s, definitions),
    fields: Object.fromEntries(
      Object.entries(p.fields ?? {})
        .filter(([, f]) => response === undefined || !(response ? f.hiddenOutput : f.rejectInput))
        .map(([name, f]) => [name, child(s.properties?.[name] ?? {}, f)]),
    ),
    required:
      response === undefined
        ? [...new Set([...p.requiredInput, ...p.requiredOutput])]
        : response
          ? p.requiredOutput
          : p.requiredInput,
    readOnly: p.rejectInput,
    writeOnly: p.hiddenOutput,
    item: p.element && child(s.items ?? {}, p.element),
    extra:
      typeof p.extra === 'object'
        ? child(typeof s.additionalProperties === 'object' ? s.additionalProperties : {}, p.extra)
        : p.extra,
    keys: p.propertyNames && child(s.propertyNames ?? {}, p.propertyNames),
    checks: p.checks,
    enum: p.members,
    constant: p.literal,
    numberInput: p.numberInput,
    format: s.format,
    description: s.description || undefined,
    default: Object.hasOwn(s, 'default') ? JSON.stringify(s.default) : undefined,
    example: JSON.stringify(Object.hasOwn(s, 'example') ? s.example : s.examples?.[0]),
    all: (p.every ?? []).map((part, i) => child(s.allOf?.[i] ?? {}, part)),
    one: (p.exactlyOne ?? []).map((part, i) => child(s.oneOf?.[i] ?? {}, part)),
    any: (p.some ?? []).map((part, i) => child(s.anyOf?.[i] ?? {}, part)),
    not: p.exclude && child(s.not ?? {}, p.exclude),
    contains: p.includes && child(s.contains ?? {}, p.includes),
    when: p.when && {
      test: child(s.if ?? {}, p.when.test),
      then: p.when.then && child(s.then ?? {}, p.when.then),
      else: p.when.else && child(s.else ?? {}, p.when.else),
    },
  };
}
export function documentationVariants(schema, definitions, seen = new Set(), response) {
  const common = [],
    groups = new Map();
  const collect = (value, refs) => {
    const { allOf, oneOf, anyOf, 'x-sdk-ref': ref, ...own } = value;
    common.push(own);
    for (const part of allOf ?? []) collect(part, refs);
    if (ref && definitions[ref] && !refs.has(ref))
      collect(definitions[ref], new Set(refs).add(ref));
    for (const [keyword, branches] of [
      ['oneOf', oneOf],
      ['anyOf', anyOf],
    ])
      if (branches)
        groups.set(
          keyword +
            identity(branches.map((s) => expectedDocumentationFacts(s, definitions, response))),
          { branches, refs },
        );
  };
  collect(schema, seen);
  if (!groups.size) return [{ schema: { allOf: common }, conditions: [] }];
  return [...groups.values()].flatMap(({ branches, refs }) =>
    branches.flatMap((branch, i) =>
      documentationVariants(branch, definitions, refs, response).flatMap((variant) => {
        const schema = { allOf: [...common, variant.schema] },
          shape = schemaFields(schema, definitions, new Set(), true);
        return Object.entries(shape.fields).some(
          ([key, child]) =>
            shape.required.has(key) &&
            expectedEnums(child, definitions).some((e) => !e.path && !e.values.length),
        )
          ? []
          : [{ schema, conditions: [i + 1, ...variant.conditions] }];
      }),
    ),
  );
}
function parts(schema, definitions, seen = new Set()) {
  const ref = schema['x-sdk-ref'];
  return [
    schema,
    ...(schema.allOf ?? []).flatMap((s) => parts(s, definitions, seen)),
    ...(ref && definitions[ref] && !seen.has(ref)
      ? parts(definitions[ref], definitions, new Set(seen).add(ref))
      : []),
  ];
}
function combine(kind, branches) {
  branches = branches.flatMap((b) => (b.kind === kind && !b.nullable ? b.branches : [b]));
  branches = [...new Map(branches.map((b) => [identity(b), b])).values()];
  if (kind === 'and') branches = branches.filter((b) => b.kind !== 'any');
  if (!branches.length) return { kind: 'any' };
  if (branches.length === 1) return branches[0];
  if (kind === 'or' && branches.length === 2 && branches.some((b) => b.kind === 'null'))
    return { ...branches.find((b) => b.kind !== 'null'), nullable: true };
  return { kind, branches: branches.sort((a, b) => identity(a).localeCompare(identity(b))) };
}
/** Derive the type tree directly from execution plans; metadata only supplies
 * public symbol identities and annotations absent from execution descriptors. */
export function expectedType(schema, definitions, names, seen = new Set(), structural) {
  const name = modelName(schema, definitions),
    label = names[name];
  if (label && !structural?.(label)) return { kind: 'model', name: label };
  const ref = schema['x-sdk-ref'];
  if (ref && definitions[ref] && !seen.has(ref))
    return expectedType(definitions[ref], definitions, names, new Set(seen).add(ref), structural);
  const plan = compileCodec(schema);
  if (plan.every?.length) {
    const nodes = parts(schema, definitions, seen),
      itemSchemas = nodes.flatMap((n) => (n.items ? [n.items] : [])),
      valueSchemas = nodes.flatMap((n) =>
        typeof n.additionalProperties === 'object' ? [n.additionalProperties] : [],
      );
    return combine(
      'and',
      nodes
        .filter(
          (n) =>
            n.type ||
            n.items ||
            typeof n.additionalProperties === 'object' ||
            n.oneOf ||
            n.anyOf ||
            modelName(n, definitions),
        )
        .map((n) => {
          const own = compileCodec(n),
            concrete = nodes.map(compileCodec).filter((p) => p.value.kind !== 'dynamic');
          const type =
            !n.type && concrete.length
              ? concrete.every((p) => p.nullable)
                ? ['array', 'null']
                : 'array'
              : n.type;
          const { allOf, ...ownSchema } = n;
          return expectedType(
            {
              ...(names[modelName(n, definitions)] ? n : ownSchema),
              ...(itemSchemas.length && (n.items || own.value.kind === 'array')
                ? { items: { allOf: itemSchemas }, ...(type ? { type } : {}) }
                : {}),
              ...(valueSchemas.length &&
              (typeof n.additionalProperties === 'object' || own.value.kind === 'object')
                ? { additionalProperties: { allOf: valueSchemas } }
                : {}),
            },
            definitions,
            names,
            seen,
            structural,
          );
        }),
    );
  }
  const branches = schema.oneOf ?? schema.anyOf;
  if (branches) {
    const trees = branches.map((s) => expectedType(s, definitions, names, seen, structural));
    const alternatives = trees.some((b) => ['object', 'any'].includes(b.kind))
      ? { kind: 'alternatives' }
      : combine('or', trees);
    const { oneOf, anyOf, ...siblings } = schema;
    return combine('and', [
      expectedType(siblings, definitions, names, seen, structural),
      alternatives,
    ]);
  }
  let tree;
  if (plan.element || plan.value.kind === 'array')
    tree = { kind: 'array', item: expectedType(schema.items ?? {}, definitions, names, seen) };
  else if (typeof plan.extra === 'object')
    tree = {
      kind: 'map',
      value: expectedType(schema.additionalProperties, definitions, names, seen),
    };
  else {
    const kind =
      {
        dynamic: 'any',
        'safe-integer': 'integer',
        'native-number': 'number',
        'date-time': 'string',
        'null-array': 'any',
        'exact-integer': 'integer string',
        decimal: 'exact numeric string',
      }[plan.value.kind] ?? plan.value.kind;
    tree = {
      kind:
        plan.numberInput === 'explicit' && ['exact-integer', 'decimal'].includes(plan.value.kind)
          ? 'ExactNumber input; exact numeric string response'
          : kind,
    };
  }
  return plan.nullable && !['any', 'null'].includes(tree.kind) ? { ...tree, nullable: true } : tree;
}
function splitTop(text, separator) {
  const parts = [];
  let depth = 0,
    start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(') depth++;
    if (text[i] === ')') depth--;
    if (!depth && text.startsWith(separator, i)) {
      parts.push(text.slice(start, i));
      start = i + separator.length;
      i = start - 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}
export function parsedType(text) {
  text = text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replaceAll('\\|', '|')
    .trim();
  const or = splitTop(text, ' or ');
  if (or.length > 1) return combine('or', or.map(parsedType));
  const and = splitTop(text, ' and ');
  if (and.length > 1) return combine('and', and.map(parsedType));
  if (text.startsWith('(') && text.endsWith(')') && !text.startsWith('(see'))
    return parsedType(text.slice(1, -1));
  if (text.startsWith('Array of ')) return { kind: 'array', item: parsedType(text.slice(9)) };
  if (text.startsWith('Map of ')) return { kind: 'map', value: parsedType(text.slice(7)) };
  if (text === 'Alternative shapes (see declared variants)') return { kind: 'alternatives' };
  return /^[A-Z]\w*$/.test(text) && text !== 'ExactNumber'
    ? { kind: 'model', name: text }
    : { kind: text };
}
export function typeLinks(tree) {
  return [
    ...new Set([
      ...(tree.kind === 'model' ? [tree.name] : []),
      ...(tree.item ? typeLinks(tree.item) : []),
      ...(tree.value ? typeLinks(tree.value) : []),
      ...(tree.branches ?? []).flatMap(typeLinks),
    ]),
  ].sort();
}
export function expectedEnums(schema, definitions, seen = new Set()) {
  const result = new Map();
  const merge = (entries, intersection = true) => {
    for (const { path, values } of entries) {
      const prev = result.get(path);
      result.set(
        path,
        prev
          ? intersection
            ? prev.filter((v) => values.includes(v))
            : [...new Set([...prev, ...values])]
          : values,
      );
    }
  };
  const plan = compileCodec(schema);
  if (plan.members) merge([{ path: '', values: plan.members.map((v) => JSON.stringify(v)) }]);
  if (plan.literal !== undefined) merge([{ path: '', values: [plan.literal] }]);
  if (plan.element)
    merge(
      expectedEnums(schema.items, definitions, seen).map((e) => ({ ...e, path: '[]' + e.path })),
    );
  if (typeof plan.extra === 'object')
    merge(
      expectedEnums(schema.additionalProperties, definitions, seen).map((e) => ({
        ...e,
        path: '.*' + e.path,
      })),
    );
  const ref = plan.reference;
  if (ref && definitions[ref] && !seen.has(ref))
    merge(expectedEnums(definitions[ref], definitions, new Set(seen).add(ref)));
  for (const s of schema.allOf ?? []) merge(expectedEnums(s, definitions, seen));
  const unions = new Map();
  for (const s of schema.oneOf ?? schema.anyOf ?? [])
    for (const { path, values } of expectedEnums(s, definitions, seen))
      unions.set(path, [...new Set([...(unions.get(path) ?? []), ...values])]);
  merge([...unions].map(([path, values]) => ({ path, values })));
  return [...result].map(([path, values]) => ({ path, values }));
}
export function expectedConstraints(schema, definitions, seen = new Set(), path = '') {
  const plan = compileCodec(schema);
  const own = [
    ...Object.entries(plan.checks).map(([k, v]) => `${path}:${k.toLowerCase()}:${v}`),
    ...(schema.format ? [`${path}:format:${schema.format}`] : []),
  ];
  const ref = plan.reference;
  return [
    ...new Set([
      ...own,
      ...(schema.allOf ?? []).flatMap((s) => expectedConstraints(s, definitions, seen, path)),
      ...(ref && definitions[ref] && !seen.has(ref)
        ? expectedConstraints(definitions[ref], definitions, new Set(seen).add(ref), path)
        : []),
      ...(schema.items ? expectedConstraints(schema.items, definitions, seen, path + '[]') : []),
      ...(typeof schema.additionalProperties === 'object'
        ? expectedConstraints(schema.additionalProperties, definitions, seen, path + '.*')
        : []),
    ]),
  ].sort();
}

function planShape(plan, definitions, response, refs = new Set()) {
  const fields = new Set(
    Object.entries(plan.fields ?? {})
      .filter(([, p]) => !(response ? p.hiddenOutput : p.rejectInput))
      .map(([key]) => key),
  );
  const required = new Set(response ? plan.requiredOutput : plan.requiredInput);
  const nested = [...(plan.every ?? [])];
  if (plan.reference && definitions[plan.reference] && !refs.has(plan.reference)) {
    refs = new Set(refs).add(plan.reference);
    nested.push(compileCodec(definitions[plan.reference]));
  }
  for (const child of nested) {
    const shape = planShape(child, definitions, response, refs);
    for (const key of shape.fields) fields.add(key);
    for (const key of shape.required) required.add(key);
  }
  return { fields, required };
}
export function expectedAnnotations(schema, definitions) {
  const descriptions = new Set(),
    defaults = new Set(),
    seen = new Set();
  const visit = (schema) => {
    const key = identity(schema);
    if (seen.has(key)) return;
    seen.add(key);
    for (const part of parts(schema, definitions)) {
      if (part.description) descriptions.add(part.description);
      if (Object.hasOwn(part, 'default')) defaults.add(JSON.stringify(part.default));
      if (part.items) visit(part.items);
      if (typeof part.additionalProperties === 'object') visit(part.additionalProperties);
    }
  };
  visit(schema);
  return { descriptions: [...descriptions], defaults: [...defaults] };
}
export function expectedFieldFacts(schema, definitions, names, response) {
  const shape = schemaFields(schema, definitions, new Set(), true);
  const declared = planShape(compileCodec(schema), definitions, response);
  return Object.entries(shape.fields)
    .filter(([field]) => declared.fields.has(field))
    .map(([field, s]) => {
      const type = expectedType(s, definitions, names);
      return {
        ...expectedAnnotations(s, definitions),
        field,
        type,
        links: typeLinks(type),
        presence: declared.required.has(field) ? 'Required' : 'Optional',
        constraints: expectedConstraints(s, definitions),
        enumEntries: normalizedEnums(expectedEnums(s, definitions)),
        enums: [...new Set(expectedEnums(s, definitions).flatMap((e) => e.values))],
      };
    });
}

/** Independent position walk for source comments. No production documentation
 * facts or formatting are used to derive expected rows. */
export function expectedPositions(
  schema,
  definitions,
  names,
  path = '$',
  presence = 'Value',
  seen = new Set(),
) {
  const key = identity(schema);
  if (seen.has(key)) return [];
  seen = new Set(seen).add(key);
  const type = expectedType(schema, definitions, names);
  const ownParts = parts(schema, definitions);
  const constraints = [
    ...new Set(
      ownParts.flatMap((s) => [
        ...Object.entries(compileCodec(s).checks).map(([k, v]) => `${k.toLowerCase()}:${v}`),
        ...(s.format ? [`format:${s.format}`] : []),
      ]),
    ),
  ].sort();
  const row = {
    path,
    presence,
    type,
    links: typeLinks(type),
    constraints,
    enums: expectedEnums(schema, definitions),
    descriptions: ownParts.flatMap((s) => (s.description ? [s.description] : [])),
    defaults: ownParts.flatMap((s) =>
      Object.hasOwn(s, 'default') ? [JSON.stringify(s.default)] : [],
    ),
  };
  const rows = [row];
  if (modelName(schema, definitions)) return rows;
  const shape = schemaFields(schema, definitions, new Set(), true);
  for (const [field, s] of Object.entries(shape.fields))
    rows.push(
      ...expectedPositions(
        s,
        definitions,
        names,
        path + '.' + field,
        shape.required.has(field) ? 'Required' : 'Optional',
        seen,
      ),
    );
  for (const s of ownParts) {
    if (s.items)
      rows.push(...expectedPositions(s.items, definitions, names, path + '[]', 'Value', seen));
    if (typeof s.additionalProperties === 'object')
      rows.push(
        ...expectedPositions(
          s.additionalProperties,
          definitions,
          names,
          path + '.*',
          'Value',
          seen,
        ),
      );
    for (const keyword of ['oneOf', 'anyOf'])
      for (const [index, branch] of (s[keyword] ?? []).entries())
        rows.push(
          ...expectedPositions(
            branch,
            definitions,
            names,
            `${path}.${keyword}[${index + 1}]`,
            'Value',
            seen,
          ),
        );
  }
  return [...new Map(rows.map((r) => [r.path + identity(r), r])).values()];
}

export const normalizedEnums = (entries) =>
  entries
    .map(({ path, values }) => ({ path, values: [...new Set(values)].sort() }))
    .sort((a, b) => a.path.localeCompare(b.path));
