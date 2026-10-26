import { stable } from './canonical.js';
import { compileRetry, requiresIdempotencyKey } from './runtime-plan.js';
import { directionalSchema, exactValue, valueInstruction } from './codec-plan.js';
import type { Contract, Operation, Schema } from './contract.js';
import {
  schemaNotes,
  schemaLiteral as literal,
  schemaEnumValues,
  enumIdentity,
  enumNotes,
  type EnumLinks,
} from './schema-documentation.js';

const cell = (text: string) =>
  text
    .replaceAll('|', '\\|')
    .replace(/[\r\n]+/g, ' ')
    .replaceAll('<', '&lt;');
const literalCell = (text: string) => literal(text, true);
const markdownNotes = (schema: Schema, table = false) =>
  schemaNotes(schema, {
    literal: (text) => literal(text, table),
    ...(table ? { description: cell } : {}),
  });
// Collection constraints belong to the item/value path, even when the
// collection's scalar type is shared by all alternatives.
function collectionNotes(schema: Schema, table = false): string {
  return [
    markdownNotes(schema, table),
    ...(schema.items ? [['Items', schema.items] as const] : []),
    ...(typeof schema.additionalProperties === 'object'
      ? [['Map values', schema.additionalProperties] as const]
      : []),
  ]
    .map((part) => {
      if (typeof part === 'string') return part;
      const notes = [part[1], ...(part[1].allOf ?? [])]
        .map((child) => collectionNotes(child, table))
        .filter(Boolean)
        .join(' ');
      return notes ? `${part[0]}: ${notes}` : '';
    })
    .filter(Boolean)
    .join(' ');
}
const anchor = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_\s-]/gu, '')
    .replace(/\s/g, '-');

/** Format existing type expressions without changing compiler-owned type decisions. */
export function referenceType(label: string, source: string, target: 'node' | 'php'): string {
  if (source.length <= 140) return `${label}: ${literal(source)}\n\n`;
  // Quoted literals are atomic, including punctuation and escaped quotes.
  const tokens =
    source.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\s+|[A-Za-z_$][\w$]*|./g) ??
    [];
  const lines: string[] = [];
  let line = '',
    depth = 0,
    genericDepth = 0,
    recordDepth = 0,
    continuation = 0;
  const newline = () => {
    if (line.trim()) lines.push(line.trimEnd());
    line = '  '.repeat(depth + continuation);
  };
  const longUnion = (index: number) => {
    let first = index,
      last = index;
    while (first > 0 && ![';', '{', '}'].includes(tokens[first - 1]!)) first--;
    while (last < tokens.length && ![';', '{', '}'].includes(tokens[last]!)) last++;
    return tokens.slice(first, last).join('').length > 100;
  };
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token === '<') {
      genericDepth++;
      if (!recordDepth && tokens[index - 1] === 'Record') recordDepth = genericDepth;
      line += token;
    } else if (token === '>') {
      if (genericDepth === recordDepth) recordDepth = 0;
      genericDepth = Math.max(0, genericDepth - 1);
      line += token;
    } else if (recordDepth) line += token;
    else if (token === '{') {
      line += token;
      depth++;
      continuation = 0;
      newline();
    } else if (token === '}') {
      depth = Math.max(0, depth - 1);
      continuation = 0;
      newline();
      line += token;
    } else if (token === ';' || (token === ',' && !genericDepth)) {
      line += token;
      continuation = 0;
      newline();
    } else if (token === '|' && longUnion(index)) {
      line += token;
      continuation = 1;
      newline();
    } else if (!(/^\s+$/.test(token) && line.endsWith(' '))) line += token;
  }
  const output = [...lines, line].join('\n').trim();
  const delimiter = '`'.repeat(
    Math.max(2, ...[...output.matchAll(/`+/g)].map((match) => match[0].length)) + 1,
  );
  return `${label}:\n\n${delimiter}${target === 'node' ? 'typescript' : 'text'}\n${output.trim()}\n${delimiter}\n\n`;
}

export function schemaFields(
  schema: Schema,
  definitions: Record<string, Schema>,
  seen = new Set<string>(),
  intersect = false,
): { fields: Record<string, Schema>; required: Set<string> } {
  const fields: Record<string, Schema> = Object.assign(Object.create(null), schema.properties);
  const required = new Set(schema.required ?? []);
  const ref = schema['x-sdk-ref'];
  const branches = [...(schema.allOf ?? [])];
  if (ref && definitions[ref] && !seen.has(ref)) {
    seen = new Set(seen).add(ref);
    branches.push(definitions[ref]!);
  }
  for (const branch of branches) {
    const nested = schemaFields(branch, definitions, seen, intersect);
    for (const [key, value] of Object.entries(nested.fields)) {
      const previous = fields[key];
      fields[key] =
        intersect && previous && stable(previous) !== stable(value)
          ? {
              allOf: [previous, value],
              ...(previous.readOnly || value.readOnly ? { readOnly: true } : {}),
              ...(previous.writeOnly || value.writeOnly ? { writeOnly: true } : {}),
            }
          : (previous ?? value);
    }
    for (const key of nested.required) required.add(key);
  }
  return { fields, required };
}
const documentedModels = new WeakMap<Record<string, Schema>, Map<string, string>>();
export function modelName(schema: Schema, definitions: Record<string, Schema>): string | undefined {
  if (schema['x-sdk-ref']) return schema['x-sdk-ref'];
  if (schema['x-sdk-type-name']) return schema['x-sdk-type-name'];
  let index = documentedModels.get(definitions);
  if (!index) {
    index = new Map();
    for (const [name, shape] of Object.entries(definitions)) {
      const identity = stable(shape);
      if (!index.has(identity)) index.set(identity, name);
    }
    documentedModels.set(definitions, index);
  }
  return index.get(stable(schema));
}
type ModelNames = Readonly<Record<string, string>>;
function directionalFields(
  schema: Schema,
  definitions: Record<string, Schema>,
  seen = new Set<string>(),
): boolean {
  const ref = schema['x-sdk-ref'];
  if (
    ref &&
    definitions[ref] &&
    !seen.has(ref) &&
    directionalFields(definitions[ref]!, definitions, new Set(seen).add(ref))
  )
    return true;
  return Boolean(
    schema.readOnly ||
      schema.writeOnly ||
      [
        ...Object.values(schema.properties ?? {}).filter(
          (child) => child.readOnly || child.writeOnly || !modelName(child, definitions),
        ),
        ...(schema.allOf ?? []),
        ...(schema.oneOf ?? []),
        ...(schema.anyOf ?? []),
        ...(schema.items ? [schema.items] : []),
        ...(typeof schema.additionalProperties === 'object' ? [schema.additionalProperties] : []),
      ].some((child) => directionalFields(child, definitions, seen)),
  );
}
export interface ModelDocumentationExport {
  output: string;
  input?: string;
}

/** Enumerate same-instance alternatives, retaining all enclosing conjuncts. */
export function documentationVariants(
  schema: Schema,
  definitions: Record<string, Schema>,
  seen = new Set<string>(),
): { schema: Schema; conditions: string[] }[] {
  const common: Schema[] = [];
  const groups = new Map<
    string,
    { keyword: string; branches: Schema[]; references: Set<string> }
  >();
  const collect = (value: Schema, references: Set<string>) => {
    const { allOf, oneOf, anyOf, ['x-sdk-ref']: ref, ...own } = value;
    common.push(own);
    for (const part of allOf ?? []) collect(part, references);
    if (ref && definitions[ref] && !references.has(ref))
      collect(definitions[ref]!, new Set(references).add(ref));
    for (const [keyword, branches] of [
      ['oneOf', oneOf],
      ['anyOf', anyOf],
    ] as const)
      if (branches) groups.set(keyword + stable(branches), { keyword, branches, references });
  };
  collect(schema, seen);
  if (!groups.size) return [{ schema: { allOf: common }, conditions: [] }];
  // Independent allOf alternatives apply together. Document each declared
  // group, rather than multiplying them into an exponential Cartesian product.
  return [...groups.values()].flatMap(({ keyword, branches, references }, group) =>
    branches.flatMap((branch, index) =>
      documentationVariants(branch, definitions, references).flatMap((variant) => {
        const schema = { allOf: [...common, variant.schema] };
        const shape = schemaFields(schema, definitions, new Set(), true);
        const impossible = Object.entries(shape.fields).some(
          ([field, child]) =>
            shape.required.has(field) &&
            schemaEnumValues(child, definitions).some(
              (entry) => !entry.path && !entry.values.length,
            ),
        );
        return impossible
          ? []
          : [
              {
                schema,
                conditions: [
                  `${keyword}${groups.size > 1 ? ' group ' + (group + 1) : ''} variant ${index + 1}${branch.description ? ': ' + branch.description : ''}`,
                  ...variant.conditions,
                ],
              },
            ];
      }),
    ),
  );
}

export const modelDocumentationConventions =
  'Field definitions apply to all variants. Rules under each condition specify presence and additional constraints. Composed alternative groups apply together: satisfy a variant from each numbered group.\n\n';

export function fieldReferenceNotes(
  field: string,
  references: ReadonlyMap<string, Set<string>>,
): string {
  return [...references]
    .filter(
      ([path]) =>
        path === field ||
        path.startsWith(field + '.') ||
        path.startsWith(field + '[') ||
        path.startsWith(field + '{'),
    )
    .map(([path, links]) => `${literalCell(path)}: ${[...links].join(', ')}.`)
    .join(' ');
}

/** One registry per target package; identities retain direction and declared constraints. */
export class DocumentationFragments {
  private readonly locations = new Map<string, string>();
  private key(schema: Schema, response?: boolean): string {
    return stable([response, schema]);
  }
  register(schema: Schema, scope: string, response?: boolean): string | undefined {
    const key = this.key(schema, response);
    const previous = this.locations.get(key);
    if (!previous) this.locations.set(key, scope);
    return previous;
  }
}

/** Canonical field tables must retain the constraints of every alternative. */
export function modelFieldReference(
  schema: Schema,
  definitions: Record<string, Schema>,
  scope: string,
  names?: ModelNames,
  enumLinks?: EnumLinks,
  response?: boolean,
  includeFields = true,
  ancestors = new Set<string>(),
  fragments?: DocumentationFragments,
  fieldReferences = new Map<string, Set<string>>(),
): string {
  const identity = stable(schema);
  if (ancestors.has(identity)) return '';
  ancestors = new Set(ancestors).add(identity);
  const shapes = documentationVariants(schema, definitions).map((variant) => {
    const shape = schemaFields(variant.schema, definitions, new Set(), true);
    return {
      ...variant,
      fields: Object.fromEntries(
        Object.entries(shape.fields).filter(([, field]) =>
          response === undefined ? true : response ? !field.writeOnly : !field.readOnly,
        ),
      ),
      required: shape.required,
    };
  });
  const first = shapes[0];
  if (!first) return 'No satisfiable declared object variants.\n\n';
  const variants = shapes.some((shape) => shape.conditions.length);
  const declarations = (child: Schema): Schema[] => {
    const { allOf, ...own } = child;
    return [
      ...Object.entries(own).map(([key, value]) => ({ [key]: value }) as Schema),
      ...(allOf ?? []).flatMap(declarations),
    ];
  };
  const conjunction = (parts: Schema[]): Schema => {
    const combined: Schema = {};
    const additional: Schema[] = [];
    for (const part of parts)
      for (const [key, value] of Object.entries(part)) {
        if (Object.hasOwn(combined, key)) {
          if (stable(combined[key]) !== stable(value)) additional.push(part);
        } else Object.assign(combined, { [key]: value });
      }
    return additional.length ? { allOf: [combined, ...additional] } : combined;
  };
  // Presence is independent of a field's definition. Retain shared conjuncts
  // once, then document only the extra constraints under each condition.
  const fields: Record<string, Schema> = Object.create(null);
  const presence = new Map<string, string>();
  const types = new Map<string, string>();
  const shared = new Map<string, Set<string>>();
  for (const field of new Set(shapes.flatMap((shape) => Object.keys(shape.fields)))) {
    const children = shapes.flatMap((shape) => (shape.fields[field] ? [shape.fields[field]!] : []));
    const parts = children.map(declarations);
    const common = parts[0]!.filter((part) =>
      parts.every((entries) => entries.some((entry) => stable(entry) === stable(part))),
    );
    fields[field] = conjunction(common);
    const effectiveTypes = new Set(
      children.map((child) =>
        typeDescription(conjunction(declarations(child)), definitions, names),
      ),
    );
    types.set(field, effectiveTypes.size === 1 ? [...effectiveTypes][0]! : 'Varies by condition');
    shared.set(field, new Set(common.map(stable)));
    presence.set(
      field,
      shapes.every((shape) => shape.fields[field] && shape.required.has(field))
        ? 'Required'
        : shapes.every((shape) => shape.fields[field] && !shape.required.has(field))
          ? 'Optional'
          : 'Conditional',
    );
  }
  let output = '';
  if (variants) {
    if (!fragments) output += modelDocumentationConventions;
    const alternatives = new Map<
      string,
      { indices: number[]; rules: string; tags: string[]; conditions: string[] }
    >();
    for (const [index, shape] of shapes.entries()) {
      const tags = Object.entries(shape.fields).flatMap(([field, child]) =>
        schemaEnumValues(child, definitions)
          .filter((entry) => !entry.path && entry.values.length === 1)
          .map((entry) => `${literal(field)} = ${literal(entry.values[0]!)}`),
      );
      const condition = (value: Schema): string => {
        const parts = [
          ...(value.required?.length
            ? [`present(${value.required.map((field) => literal(field)).join(', ')})`]
            : []),
          ...Object.entries(value.properties ?? {}).map(
            ([field, child]) =>
              `${literal(field)}: ${enumNotes(schemaEnumValues(child, definitions), literal, enumLinks) || typeDescription(child, definitions, names)}`,
          ),
          ...(value.allOf ?? []).map(condition).filter(Boolean),
          ...(
            [
              ['oneOf', value.oneOf],
              ['anyOf', value.anyOf],
            ] as const
          ).flatMap(([keyword, branches]) =>
            branches
              ? [
                  `${keyword === 'oneOf' ? 'exactly one' : 'at least one'}(${branches.map(condition).join('; ')})`,
                ]
              : [],
          ),
          ...(value.not ? [`not (${condition(value.not)})`] : []),
        ];
        return parts.join(' and ');
      };
      const objectConstraints = (value: Schema): string[] => [
        ...(value.not ? [`- Condition: not (${condition(value.not)}).\n`] : []),
        ...(value.allOf ?? []).flatMap(objectConstraints),
      ];
      let rules = [...new Set(objectConstraints(shape.schema))].join('');
      for (const [label, selected] of [
        [
          'Required',
          Object.keys(shape.fields).filter(
            (field) => presence.get(field) === 'Conditional' && shape.required.has(field),
          ),
        ],
        [
          'Optional',
          Object.keys(shape.fields).filter(
            (field) => presence.get(field) === 'Conditional' && !shape.required.has(field),
          ),
        ],
        ['Undeclared', Object.keys(fields).filter((field) => !shape.fields[field])],
      ] as const)
        if (selected.length)
          rules += `- ${label}: ${selected.map((field) => literal(field)).join(', ')}.\n`;
      for (const [field, child] of Object.entries(shape.fields)) {
        const extra = declarations(child).filter((part) => !shared.get(field)!.has(stable(part)));
        if (!extra.length) continue;
        const delta = conjunction(extra);
        const notes = [delta, ...(delta.allOf ?? [])]
          .map((part) => collectionNotes(part))
          .filter(Boolean)
          .join(' ');
        const values = enumNotes(schemaEnumValues(child, definitions), literal, enumLinks);
        // Compare complete effective types, including item/value schemas and
        // named links. Looking only at scalar keywords loses collection deltas.
        const type = typeDescription(conjunction(declarations(child)), definitions, names);
        const facts = [type === types.get(field) ? '' : type + '.', notes, values]
          .filter(Boolean)
          .join(' ');
        if (facts) rules += `- Constraints for ${literal(field)}: ${facts}\n`;
      }
      if (!Object.keys(shape.fields).length)
        rules += `- Value shape: ${typeDescription(shape.schema, definitions, names)}.\n`;
      const key = stable([rules, tags]);
      const previous = alternatives.get(key);
      if (previous) {
        previous.indices.push(index + 1);
        previous.conditions.push(...shape.conditions);
      } else
        alternatives.set(key, {
          indices: [index + 1],
          rules,
          tags,
          conditions: [...shape.conditions],
        });
    }
    for (const alternative of alternatives.values())
      output += `### ${scope} variant ${alternative.indices.join(', ')}${alternative.tags.length ? ': ' + alternative.tags.join(', ') : ''}\n\n${alternative.conditions.join('; ')}.\n\n${alternative.rules || 'No additional constraints.\n'}\n`;
  }
  // Inline unions inside fields, array items and map values need their own
  // tables. Named children already link to their canonical model section.
  const visited = new Set<string>();
  const namedComposition = (child: Schema): boolean =>
    Boolean(modelName(child, definitions) && names?.[modelName(child, definitions)!]) ||
    Boolean(
      child.allOf?.length &&
        !child.properties &&
        !child.oneOf &&
        !child.anyOf &&
        child.allOf.every(namedComposition),
    ) ||
    Boolean(
      (child.oneOf ?? child.anyOf)?.every((part) => part.type === 'null' || namedComposition(part)),
    );
  const nested = (child: Schema, path: string, parents = ancestors, context = scope): string => {
    const reference = (link: string) => {
      const links = fieldReferences.get(path) ?? new Set<string>();
      links.add(link);
      fieldReferences.set(path, links);
    };
    if (namedComposition(child)) {
      if (
        !includeFields &&
        documentationVariants(child, definitions).some((variant) => variant.conditions.length)
      )
        reference(typeDescription(child, definitions, names));
      return '';
    }
    const childIdentity = stable(child);
    if (parents.has(childIdentity)) return '';
    const identity = context + '.' + path + childIdentity;
    if (visited.has(identity)) return '';
    visited.add(identity);
    const alternatives = documentationVariants(child, definitions);
    if (alternatives.some((variant) => variant.conditions.length)) {
      const scope = `${context}.${path}`;
      const previous = fragments?.register(child, scope, response);
      reference(`[declared alternatives](MODELS.md#${anchor(previous ?? scope)})`);
      if (previous)
        return `### ${scope}\n\nDeclared alternatives: [${previous}](MODELS.md#${anchor(previous)}).\n\n`;
      return (
        `### ${context}.${path}\n\n` +
        modelFieldReference(
          child,
          definitions,
          `${context}.${path}`,
          names,
          enumLinks,
          response,
          true,
          parents,
          fragments,
        )
      );
    }
    const shape = schemaFields(child, definitions, new Set(), true);
    const next = new Set(parents).add(childIdentity);
    return (
      Object.entries(shape.fields)
        .map(([field, value]) => nested(value, `${path}.${field}`, next, context))
        .join('') +
      (child.items ? nested(child.items, path + '[]', next, context) : '') +
      (typeof child.additionalProperties === 'object'
        ? nested(child.additionalProperties, path + '{}', next, context)
        : '')
    );
  };
  for (const [index, shape] of shapes.entries())
    for (const [field, child] of Object.entries(shape.fields))
      output += nested(
        child,
        field,
        ancestors,
        shapes.every((other) => stable(other.fields[field]) === stable(child))
          ? scope
          : `${scope} variant ${index + 1}`,
      );
  return (
    (includeFields
      ? fieldTable(
          { properties: fields },
          definitions,
          scope,
          true,
          names,
          enumLinks,
          presence,
          new Map(
            Object.keys(fields).map((field) => [
              field,
              fieldReferenceNotes(field, fieldReferences),
            ]),
          ),
          types,
        )
      : '') + output
  );
}
export function typeDescription(
  s: Schema,
  definitions: Record<string, Schema> = {},
  names?: ModelNames,
  seen = new Set<string>(),
): string {
  const source = modelName(s, definitions);
  const name = source && (names ? names[source] : source);
  const ref = s['x-sdk-ref'];
  if (!name && ref && definitions[ref] && !seen.has(ref))
    return typeDescription(definitions[ref]!, definitions, names, new Set(seen).add(ref));
  if (name) return `[${name}](MODELS.md#${anchor(name)})`;
  if (s.allOf) {
    // Conjuncts may declare a collection and its element separately. Assemble
    // their shared structure before describing types; a type-only conjunct
    // must not introduce an unconstrained element beside a concrete one.
    const parts = (value: Schema): Schema[] => {
      const { allOf, ...own } = value;
      return [own, ...(allOf ?? []).flatMap(parts)];
    };
    const combined: Schema = {};
    const additional: Schema[] = [];
    for (const part of parts(s))
      for (const [key, value] of Object.entries(part)) {
        if (!Object.hasOwn(combined, key)) Object.assign(combined, { [key]: value });
        else if (stable(combined[key]) !== stable(value)) {
          if (
            (key === 'items' || key === 'additionalProperties') &&
            typeof combined[key] === 'object' &&
            typeof value === 'object'
          )
            Object.assign(combined, { [key]: { allOf: [combined[key], value] } });
          else additional.push({ [key]: value });
        }
      }
    const types = new Set(
      [combined, ...additional].map((part) =>
        typeDescription(
          part.items
            ? { type: 'array', ...part }
            : part.type === 'array' && combined.items
              ? { items: combined.items, ...part }
              : part,
          definitions,
          names,
          seen,
        ),
      ),
    );
    return [...types].filter((type) => type !== 'any').join(' and ') || 'any';
  }
  if (s.oneOf || s.anyOf) {
    const types = [
      ...new Set(
        (s.oneOf ?? s.anyOf)!.map((part) => typeDescription(part, definitions, names, seen)),
      ),
    ];
    return types.every((type) => type !== 'object' && type !== 'any')
      ? types.join(' or ')
      : 'Alternative shapes (see declared variants)';
  }
  if (s.type === 'array' || s.items)
    return `Array of ${typeDescription(s.items ?? {}, definitions, names, seen)}`;
  if (typeof s.additionalProperties === 'object')
    return `Map of ${typeDescription(s.additionalProperties, definitions, names, seen)}`;
  const types = Array.isArray(s.type) ? s.type : [s.type ?? 'any'];
  return types
    .map((t) =>
      exactValue(valueInstruction(t, s.format))
        ? s['x-sdk-number-input'] === 'explicit'
          ? 'ExactNumber input; exact numeric string response'
          : ['int64', 'uint64'].includes(s.format ?? '')
            ? 'integer string'
            : 'exact numeric string'
        : t,
    )
    .join(' or ');
}
export function fieldTable(
  schema: Schema,
  definitions: Record<string, Schema>,
  scope = 'Field',
  includeExamples = true,
  names?: ModelNames,
  enumLinks?: EnumLinks,
  presence?: ReadonlyMap<string, string>,
  references?: ReadonlyMap<string, string>,
  types?: ReadonlyMap<string, string>,
): string {
  const { fields, required } = schemaFields(schema, definitions);
  if (!Object.keys(fields).length) return '';
  const enums: string[] = [];
  return (
    '| Field | Presence | Type | Description |\n| --- | --- | --- | --- |\n' +
    Object.entries(fields)
      .map(([name, child]) => {
        // Effective body fields retain conjuncts rather than overwriting parent
        // constraints with branch annotations. Render every retained declaration.
        const declarations = (s: Schema, seen = new Set<string>()): Schema[] => {
          const ref = s['x-sdk-ref'];
          return [
            s,
            ...(s.allOf ?? []).flatMap((part) => declarations(part, seen)),
            ...(ref && definitions[ref] && !seen.has(ref)
              ? declarations(definitions[ref]!, new Set(seen).add(ref))
              : []),
          ];
        };
        const parts = declarations(child);
        const entries = schemaEnumValues(child, definitions);
        const enumDescriptions = entries
          .map((entry) => {
            const { path, values } = entry;
            const label = path ? `${path} values` : 'values';
            const heading = `${scope} ${name} ${label}`;
            const link = enumLinks?.get(enumIdentity(values));
            if (!link && values.join(', ').length > 140) {
              enums.push(
                `#### ${heading}\n\n${values.map((value) => '- ' + literal(value)).join('\n')}\n\n`,
              );
              return enumNotes(
                [entry],
                literalCell,
                new Map([[enumIdentity(values), '#' + anchor(heading)]]),
              );
            }
            return enumNotes([entry], literalCell, enumLinks);
          })
          .join(' ');
        const notes = [
          [
            ...new Set(
              parts.map((part) =>
                collectionNotes(includeExamples ? part : withoutExamples(part), true),
              ),
            ),
          ]
            .filter(Boolean)
            .join(' '),
          enumDescriptions,
          child.readOnly ? 'Response only.' : '',
          child.writeOnly ? 'Input only.' : '',
          references?.get(name),
        ]
          .filter(Boolean)
          .join(' ');
        return `| \`${cell(name).replaceAll('`', '&#96;')}\` | ${presence?.get(name) ?? (required.has(name) ? 'Required' : 'Optional')} | ${types?.get(name) ?? typeDescription(child, definitions, names)} | ${notes} |`;
      })
      .join('\n') +
    '\n\n' +
    enums.join('')
  );
}
function withoutExamples({ example, examples, ...schema }: Schema): Schema {
  return schema;
}
/** Keep canonical body fields visible beside parameters in both target references. */
export function bodyReference(
  op: Operation,
  definitions: Record<string, Schema>,
  names?: ModelNames,
  sharedBodies?: ReadonlySet<string>,
  enumLinks?: EnumLinks,
): string {
  if (!op.body) return '';
  const body = op.body;
  const named = modelName(body, definitions);
  if (named && sharedBodies?.has(named) && names?.[named]) return '';
  const tables = new Map<string, { heading: string; destination: string }>();
  const headings = new Map<string, number>();
  const document = (
    schema: Schema,
    label: string,
    seen = new Set<string>(),
    inherited: Schema = {},
  ): string => {
    const effective = { allOf: [inherited, schema] };
    const shape = schemaFields(directionalSchema(effective, false), definitions, new Set(), true);
    const table = fieldTable(
      {
        properties: Object.fromEntries(
          Object.entries(shape.fields).filter(([, child]) => !child.readOnly),
        ),
        required: [...shape.required],
      },
      definitions,
      label,
      false,
      names,
      enumLinks,
    );
    let output = modelName(schema, definitions)
      ? `Body model: ${typeDescription(schema, definitions, names)}.\n\n`
      : '';
    if (table) {
      const previous = tables.get(table);
      if (previous) output += `Fields: [${previous.heading}](${previous.destination}).\n\n`;
      else {
        const heading = `${label} fields`;
        const base = anchor(heading);
        const occurrence = headings.get(base) ?? 0;
        headings.set(base, occurrence + 1);
        tables.set(table, {
          heading,
          destination: '#' + base + (occurrence ? '-' + occurrence : ''),
        });
        output += `#### ${heading}\n\n${table}`;
      }
    }
    // Carry only the common field view into alternatives. Reusing the enclosing
    // graph would traverse the same references/compositions again at every level.
    const parent = { properties: shape.fields, required: [...shape.required] };
    for (const keyword of ['oneOf', 'anyOf'] as const)
      for (const [index, variant] of (schema[keyword] ?? []).entries()) {
        const title = `${label} ${keyword} variant ${index + 1}`;
        output += `#### ${title}\n\n${markdownNotes(withoutExamples(variant))}\n\n`;
        output +=
          document(variant, title, seen, parent) ||
          `Body shape: ${typeDescription(variant, definitions, names)}.\n\n`;
      }
    // Composition-only wrappers can hide unions several allOf/reference levels
    // deep. Keep the complete common field view while following each wrapper.
    for (const branch of schema.allOf ?? [])
      if (branch.oneOf || branch.anyOf || branch.allOf || branch['x-sdk-ref'])
        output += document(branch, label, seen, parent);
    const ref = schema['x-sdk-ref'];
    if (ref && definitions[ref] && !seen.has(ref)) {
      const target = definitions[ref]!;
      if (target.oneOf || target.anyOf || target.allOf || target['x-sdk-ref'])
        output += document(target, label, new Set(seen).add(ref), parent);
    }
    return output;
  };
  return (
    document(body, `${op.resource}.${op.method} body`) ||
    `Body shape: ${typeDescription(body, definitions, names)}.\n\n`
  );
}
export function modelReference(
  c: Contract,
  exports?: Readonly<Record<string, ModelDocumentationExport>>,
  target: 'node' | 'php' = 'node',
  enumLinks?: EnumLinks,
  fieldAliases?: Map<string, string>,
): string {
  const outputs =
    exports &&
    Object.fromEntries(Object.entries(exports).map(([name, entry]) => [name, entry.output]));
  const inputs =
    exports &&
    Object.fromEntries(
      Object.entries(exports).flatMap(([name, entry]) =>
        entry.input ? [[name, entry.input]] : [],
      ),
    );
  const fragments = new DocumentationFragments();
  for (const [name, schema] of Object.entries(c.models)) {
    const entry = exports?.[name];
    if (!exports || entry?.output === name)
      fragments.register(
        exports ? directionalSchema(schema, true) : schema,
        name,
        exports ? true : undefined,
      );
    if (entry?.input) fragments.register(directionalSchema(schema, false), entry.input, false);
  }
  const section = (
    name: string,
    schema: Schema,
    names?: ModelNames,
    replacement = '',
    response?: boolean,
  ) =>
    `## ${name}\n\n${replacement}${markdownNotes(schema)}\n\n${enumNotes(schemaEnumValues(schema, c.definitions ?? c.models), literal, enumLinks)}\n\n${modelFieldReference(schema, c.definitions ?? c.models, name, names, enumLinks, response, true, new Set(), fragments)}`;
  return (
    `# ${c.title} models\n\n[API reference](REFERENCE.md) · [Runtime guide](RUNTIME.md)\n\nFields describe the API's declared shape. Inputs omit read-only fields; responses omit write-only fields and preserve unknown fields and enum values. ${target === 'node' ? 'Request enums are closed unions; response enums accept unknown strings. Input types use the Input suffix.' : 'Operation responses use presence-aware classes with typed getters; optional omitted fields return null.'}\n\nint64/uint64 values are integer strings${target === 'node' ? ' (TypeScript `${bigint}`); inputs also accept bigint' : ''}. Decimal fields use exact numeric strings. Use each field's declared units.\n\n` +
    modelDocumentationConventions +
    Object.entries(c.models)
      .map(([name, schema]) => {
        if (!exports) return section(name, schema);
        const entry = exports[name];
        if (!entry) return '';
        let document =
          entry.output === name
            ? section(name, directionalSchema(schema, true), outputs, '', true)
            : '';
        if (entry.input) {
          if (
            entry.output === name &&
            !directionalFields(schema, c.definitions ?? c.models) &&
            stable(directionalSchema(schema, false)) === stable(directionalSchema(schema, true))
          ) {
            fieldAliases?.set(entry.input, entry.output);
            document += `## ${entry.input}\n\nRequest input. Response: [${entry.output}](MODELS.md#${anchor(entry.output)}). Fields, descriptions and enum values are shared with that model; request enums accept only the listed values.\n\n`;
          } else
            document += section(
              entry.input,
              directionalSchema(schema, false),
              inputs,
              `Request input. Response: [${entry.output}](MODELS.md#${anchor(entry.output)}).\n\n`,
              false,
            );
        }
        return document;
      })
      .join('')
  );
}
export function authenticationGuide(c: Contract, target: 'node' | 'php' = 'node'): string {
  if (!c.authentication)
    return c.auth
      ? 'Supply `token` from your credential source.\n\n'
      : 'This SDK does not require a client credential for its selected operations.\n\n';
  const shortcuts = Object.entries(c.authShortcuts ?? {})
    .map(
      ([key, value]) =>
        `- \`${key}\` selects \`${value.mode}\` and supplies \`${value.scheme}\`.\n`,
    )
    .join('');
  return (
    (shortcuts
      ? 'Authentication shortcuts are accepted on both client and request options:\n\n' +
        shortcuts +
        '\nRequest shortcuts override client authentication for that call. Explicit request modes still work. Use only one shortcut, and do not combine it with authMode or credentials in the same options object.\n\n'
      : '') +
    (c.authShortcuts?.token
      ? ''
      : 'The legacy `token` option is not configured for this composed client and is rejected. Use a listed shortcut or explicit mode credentials.\n\n') +
    'Set `authMode` to one of the modes below and put its credentials under `credentials[mode]`. Request overrides use the mode’s credential map directly, without the outer mode key. A request credential map replaces the selected mode’s client map; supply every required key.\n\n| Mode | Required credential keys |\n| --- | --- |\n' +
    Object.entries(c.authentication)
      .map(
        ([name, auth]) =>
          `| \`${cell(name)}\` | ${auth.schemes.map((s) => '`' + cell(s.name) + '`').join(', ')} |`,
      )
      .join('\n') +
    `\n\n${target === 'node' ? 'TypeScript checks mode names, credential keys, and the modes permitted by each operation. ' : ''}Credentials themselves are never shown in SDK diagnostics.\n\n`
  );
}
export function operationGuidance(c: Contract, op: Operation): string {
  const { retry } = compileRetry(op);
  return (
    `#### Request behavior\n\nAttempt limit: ${retry.maxAttempts}; retry statuses: ${retry.statuses.join(', ') || 'none'}; transport retries: ${retry.transport ? 'enabled' : 'disabled'}. See [retries and idempotency](RUNTIME.md#retries-and-idempotency).\n\n` +
    (retry.errors?.length
      ? `Code-specific retries: ${retry.errors.map((rule) => `HTTP ${rule.status} (${rule.codes.map((code) => literal(code)).join(', ')})`).join('; ')}.\n\n`
      : '') +
    (op.response?.return === 'payload'
      ? `Complete body and metadata: ${literal(op.method + 'WithResponse')}. See [response modes](RUNTIME.md#responses-and-errors).\n\n`
      : '') +
    (op.idempotency
      ? `Idempotent: key ${requiresIdempotencyKey(op) ? 'required' : op.idempotency.auto ? 'automatic' : 'optional'} — [policy ${idempotencyPolicies(c).findIndex((policy) => policy.header === op.idempotency!.header && policy.retention === op.idempotency!.retention && policy.scope === op.idempotency!.scope) + 1}](RUNTIME.md#idempotency).\n\n`
      : '') +
    (c.authentication
      ? `Authentication modes: ${op.authModes?.map((mode) => literal(mode)).join(', ') || 'none (anonymous)'}. [Credential setup](RUNTIME.md#authentication).\n\n`
      : '') +
    (op.conditional
      ? `Conditional header: ${literal(op.conditional.header)}, supplied through ifMatch.\n\n`
      : '') +
    (op.pagination
      ? `Pagination: ${literal(op.method + 'Items')}, ${literal(op.method + 'Pages')}${op.response?.return === 'payload' ? ', ' + literal(op.method + 'PagesWithResponse') : ''}. [Canonical pagination example](RUNTIME.md#pagination-and-polling).\n\n`
      : '') +
    (op.polling
      ? `Polling: ${literal(op.method + 'Wait')}${op.response?.return === 'payload' ? ', ' + literal(op.method + 'WaitWithResponse') : ''}; state ${literal(op.polling.state)}; success ${op.polling.success.map((v) => literal(v)).join(', ')}; failure ${op.polling.failure.map((v) => literal(v)).join(', ')}. [Polling deadlines](RUNTIME.md#pagination-and-polling).\n\n`
      : '')
  );
}

/** Show top-level response alternatives without traversing nested object fields. */
export function responseReference(
  schema: Schema,
  definitions: Record<string, Schema>,
  scope: string,
  names?: ModelNames,
  enumLinks?: EnumLinks,
): string {
  const named = modelName(schema, definitions);
  if (named && names?.[named]) return '';
  const expand = (value: Schema, seen = new Set<string>()): Schema[] => {
    const { allOf, ['x-sdk-ref']: ref, ...own } = value;
    return [
      own,
      ...(allOf ?? []).flatMap((part) => expand(part, seen)),
      ...(ref && definitions[ref] && !seen.has(ref)
        ? expand(definitions[ref]!, new Set(seen).add(ref))
        : []),
    ];
  };
  const parts = expand(directionalSchema(schema, true));
  const alternative = parts.find((part) => part.oneOf || part.anyOf);
  const table = (value: Schema, label: string) => {
    const shape = schemaFields(value, definitions, new Set(), true);
    return fieldTable(
      {
        properties: Object.fromEntries(
          Object.entries(shape.fields).filter(([, field]) => !field.writeOnly),
        ),
        required: [...shape.required],
      },
      definitions,
      label,
      false,
      names,
      enumLinks,
    );
  };
  if (!alternative) return table(schema, scope);
  const common = parts.map(({ oneOf, anyOf, ...part }) => part);
  return (alternative.oneOf ?? alternative.anyOf ?? [])
    .map((variant, index) => {
      const shape = schemaFields(
        { allOf: [...common, directionalSchema(variant, true)] },
        definitions,
        new Set(),
        true,
      );
      return (
        `##### Response variant ${index + 1}\n\n${variant.description ?? ''}\n\n` +
        (table(
          { properties: shape.fields, required: [...shape.required] },
          `${scope} variant ${index + 1}`,
        ) || 'No top-level object fields in this variant.\n\n')
      );
    })
    .join('');
}

/** Preserve each distinct declared policy once; key selection remains operation-specific. */
export function idempotencyPolicies(c: Contract) {
  return [
    ...new Map(
      c.operations.flatMap((op) =>
        op.idempotency
          ? ([
              [
                JSON.stringify([
                  op.idempotency.header,
                  op.idempotency.retention,
                  op.idempotency.scope,
                ]),
                {
                  header: op.idempotency.header,
                  retention: op.idempotency.retention,
                  scope: op.idempotency.scope,
                },
              ],
            ] as const)
          : [],
      ),
    ).values(),
  ];
}
export function idempotencyReference(c: Contract): string {
  const policies = idempotencyPolicies(c);
  return policies.length
    ? '| Policy | Header | Retention | Scope |\n| --- | --- | --- | --- |\n' +
        policies
          .map(
            (policy, index) =>
              `| ${index + 1} | ${literalCell(policy.header)} | ${cell(policy.retention)} | ${cell(policy.scope)} |`,
          )
          .join('\n') +
        '\n\n'
    : '';
}

/** Provider error-code values are shared across model and operation field docs. */
export function errorCodeDocumentation(c: Contract): {
  links: Map<string, string>;
  reference: string;
} {
  const links = new Map<string, string>();
  const values = new Set<string>();
  if (c.config.errors?.codePath)
    for (const op of c.operations)
      for (const response of Object.values(op.responses)) {
        if (response.classification !== 'error' || !response.schema) continue;
        let shapes = [response.schema];
        for (const field of c.config.errors.codePath.split('.'))
          shapes = shapes.flatMap((shape) =>
            [shape, ...(shape.oneOf ?? shape.anyOf ?? [])].flatMap((part) => {
              const child = schemaFields(part, c.definitions ?? c.models).fields[field];
              return child ? [child] : [];
            }),
          );
        for (const shape of shapes)
          for (const entry of schemaEnumValues(shape, c.definitions ?? c.models)) {
            if (entry.path) continue;
            links.set(enumIdentity(entry.values), 'ERRORS.md#provider-error-codes');
            for (const value of entry.values) values.add(value);
          }
      }
  return {
    links,
    reference: values.size
      ? '# Provider error codes\n\n[Runtime error reference](RUNTIME.md#error-reference)\n\nInspect the provider code together with status and kind; retry only when the operation permits it. Declared values:\n\n' +
        [...values]
          .sort()
          .map((value) => '- ' + literal(value))
          .join('\n') +
        '\n\n'
      : '',
  };
}
