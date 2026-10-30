import { phpDocumentation } from './php-types.js';
import { schemaComment } from './schema-documentation.js';
import type { Json, Schema } from './contract.js';
import {
  directionalSchema,
  exactValue,
  valueInstruction,
  nullableAlternative,
} from './codec-plan.js';
import { numericEnumDeclaration, valueScopes } from './schema-intersections.js';
const php = (s: string) => "'" + s.replaceAll('\\', '\\\\').replaceAll("'", "\\'") + "'";

/** The declaration policy is shared by text emission and compatibility facts. */
export function objectDeclaration(
  schema: Schema,
  response: boolean,
): {
  dictionary?: Schema;
  fields: [string, Schema][];
  required: string[];
  open: boolean;
} {
  const s = directionalSchema(schema, response);
  if (!Object.keys(s.properties ?? {}).length && typeof s.additionalProperties === 'object')
    return { dictionary: s.additionalProperties, fields: [], required: [], open: true };
  const fields = [...new Set([...Object.keys(s.properties ?? {}), ...(s.required ?? [])])]
    .map((key): [string, Schema] => [key, s.properties?.[key] ?? {}])
    .filter(([, child]) => !response || !child.writeOnly);
  return {
    fields,
    required: (s.required ?? []).filter((key) => !response || !s.properties?.[key]?.writeOnly),
    open:
      s.additionalProperties === true ||
      typeof s.additionalProperties === 'object' ||
      (!Object.keys(s.properties ?? {}).length &&
        !s.required?.length &&
        s.additionalProperties !== false),
  };
}

export function optionalPropertyType(key: string, value: string): string {
  // An omitted own property still exposes Object's inherited member in TypeScript.
  return [
    'constructor',
    'toString',
    'toLocaleString',
    'valueOf',
    'hasOwnProperty',
    'isPrototypeOf',
    'propertyIsEnumerable',
  ].includes(key)
    ? `(${value}) | Object[${JSON.stringify(key)}]`
    : value;
}
type ObjectContext = 'object' | 'nullableObject' | undefined;
type ArrayContext = 'array' | 'nullableArray' | undefined;
function arrayConstraint(s: Schema): ArrayContext {
  const constraints = [
    s.type === 'array'
      ? 'array'
      : Array.isArray(s.type) && s.type.includes('array')
        ? 'nullableArray'
        : undefined,
    ...(s.allOf ?? []).map(arrayConstraint),
  ];
  return constraints.includes('array')
    ? 'array'
    : constraints.includes('nullableArray')
      ? 'nullableArray'
      : undefined;
}
export function objectConstraint(s: Schema): ObjectContext {
  const constraints = [
    s.type === 'object'
      ? 'object'
      : Array.isArray(s.type) && s.type.includes('object')
        ? 'nullableObject'
        : undefined,
    ...(s.allOf ?? []).map(objectConstraint),
  ];
  return constraints.includes('object')
    ? 'object'
    : constraints.includes('nullableObject')
      ? 'nullableObject'
      : undefined;
}

/** Classify request bodies without widening the declaration renderer's object context. */
export function objectBodyConstraint(
  s: Schema,
  definitions: Readonly<Record<string, Schema>>,
  seen = new Set<string>(),
): boolean {
  const ref = s['x-sdk-ref'];
  if (ref)
    return (
      !!definitions[ref] &&
      !seen.has(ref) &&
      objectBodyConstraint(definitions[ref], definitions, new Set([...seen, ref]))
    );
  if (objectConstraint(s) === 'object') return true;
  return (
    (s.allOf ?? []).some((branch) => objectBodyConstraint(branch, definitions, seen)) ||
    [s.oneOf, s.anyOf].some(
      (branches) =>
        !!branches?.length &&
        branches.every((branch) => objectBodyConstraint(branch, definitions, seen)),
    )
  );
}
function hasDateInput(schema: Schema, definitions: Readonly<Record<string, Schema>>): boolean {
  return valueScopes(schema, definitions).some((shape) =>
    (Array.isArray(shape.type) ? shape.type : [shape.type]).some(
      (type) =>
        valueInstruction(type, shape.format, shape['x-sdk-integer-mode']).kind === 'date-time',
    ),
  );
}
export function typescriptType(
  s: Schema,
  response = false,
  discriminator?: string,
  known = false,
  objectContext?: ObjectContext,
  arrayContext?: ArrayContext,
  definitions: Readonly<Record<string, Schema>> = {},
  documentation = false,
): string {
  definitions = s['x-sdk-definitions'] ?? definitions;
  if (!response && s['x-sdk-query-array-items']) {
    const item = typescriptType(
      s['x-sdk-query-array-items'],
      false,
      undefined,
      false,
      undefined,
      undefined,
      definitions,
      documentation,
    );
    return `(${item}) | readonly (${item})[]`;
  }
  const render = (
    schema: Schema,
    output = false,
    tag?: string,
    knownVariant = false,
    object?: ObjectContext,
    array?: ArrayContext,
  ): string =>
    typescriptType(schema, output, tag, knownVariant, object, array, definitions, documentation);
  if (!response && Object.hasOwn(s, 'const')) {
    // A constant can wrap a reference or composition that supplies its numeric
    // representation. Follow positive declarations at each value path before
    // rendering the literal, just as the surrounding input declaration does.
    const literal = (value: Json, declarations: readonly Schema[]): string => {
      const shapes = declarations.flatMap((shape) => valueScopes(shape, definitions));
      if (Array.isArray(value))
        return (
          'readonly [' +
          value
            .map((child) =>
              literal(
                child,
                shapes.flatMap((shape) => (shape.items ? [shape.items] : [])),
              ),
            )
            .join(', ') +
          ']'
        );
      if (value && typeof value === 'object')
        return (
          '{ ' +
          Object.entries(value)
            .map(
              ([key, child]) =>
                JSON.stringify(key) +
                ': ' +
                literal(
                  child,
                  shapes.flatMap((shape) => {
                    const field = Object.hasOwn(shape.properties ?? {}, key)
                      ? shape.properties?.[key]
                      : undefined;
                    return field
                      ? [field]
                      : typeof shape.additionalProperties === 'object'
                        ? [shape.additionalProperties]
                        : [];
                  }),
                ) +
                ';',
            )
            .join(' ') +
          ' }'
        );
      if (typeof value === 'number') {
        const representations = shapes.flatMap((shape) => {
          const types = Array.isArray(shape.type) ? shape.type : [shape.type];
          return types.flatMap((type) => {
            const instruction = valueInstruction(type, shape.format, shape['x-sdk-integer-mode']);
            if (instruction.kind === 'exact-integer')
              return response
                ? ['`${bigint}`']
                : [
                    shape['x-sdk-number-input'] === 'explicit' ? 'ExactNumber' : '`${bigint}`',
                    'bigint',
                  ];
            if (exactValue(instruction))
              return [shape['x-sdk-number-input'] === 'explicit' ? 'ExactNumber' : 'string'];
            return type === 'integer' || type === 'number' ? [JSON.stringify(value)] : [];
          });
        });
        if (representations.length) return '(' + [...new Set(representations)].join(' | ') + ')';
      }
      return JSON.stringify(value);
    };
    const { const: value, ...rest } = s;
    const declaration =
      '(' +
      render(rest, response, discriminator, known, objectContext, arrayContext) +
      ') & (' +
      literal(value!, [s]) +
      ')';
    return hasDateInput(s, definitions) ? `(${declaration}) | globalThis.Date` : declaration;
  }
  const typeName =
    !known && s['x-sdk-type-name'] ? s['x-sdk-type-name'] + (response ? '' : 'Input') : undefined;
  if (typeName || s['x-sdk-ref']) {
    if (arrayContext) {
      // A named typeless component may admit nonarrays. Its items still constrain
      // an enclosing array conjunct, so render that view rather than the alias.
      const target = definitions[s['x-sdk-ref'] ?? s['x-sdk-type-name']!] ?? s;
      const { 'x-sdk-ref': _reference, 'x-sdk-type-name': _name, ...shape } = target;
      return render(shape, response, discriminator, known, objectContext, arrayContext);
    }
    const reference = typeName ?? s['x-sdk-ref'] + (response ? '' : 'Input');
    if (!objectContext) return reference;
    // A recursive alias may also admit nonobjects. Filter it at this use site
    // without expanding the recursive graph or narrowing the alias globally.
    const object = `Exclude<${reference} & object, readonly unknown[]>`;
    return objectContext === 'nullableObject' ? `(${object}) | (${reference} & null)` : object;
  }
  s = directionalSchema(s, response);
  if (!response && (s.allOf || s.oneOf || s.anyOf)) s = numericEnumDeclaration(s, definitions);
  if (
    !response &&
    s.type === 'object' &&
    s.properties &&
    s.oneOf &&
    !s.allOf &&
    !s.anyOf &&
    !s.not
  ) {
    const forbidden = (branch: Schema): string[] | undefined => {
      if (Object.keys(branch).some((key) => !['required', 'not'].includes(key))) return undefined;
      if (!branch.not) return [];
      return Object.keys(branch.not).length === 1 && branch.not.required?.length === 1
        ? branch.not.required
        : undefined;
    };
    const excluded = s.oneOf.map(forbidden);
    if (excluded.every((keys) => keys !== undefined)) {
      return s.oneOf
        .map((branch, index) => {
          const required = new Set([...(s.required ?? []), ...(branch.required ?? [])]);
          const absent = new Set(excluded[index]);
          if ([...required].some((key) => absent.has(key))) return 'never';
          const fields = objectDeclaration({ ...s, required: [...required] }, false).fields;
          return (
            '{ ' +
            fields
              .map(
                ([key, child]) =>
                  `${documentation ? schemaComment(child, definitions, response) : ''}${JSON.stringify(key)}${required.has(key) ? '' : '?'}: ${absent.has(key) || child.readOnly ? 'never' : render(child)};`,
              )
              .join(' ') +
            (objectDeclaration(s, false).open ? ' [key: string]: unknown;' : '') +
            ' }'
          );
        })
        .join(' | ');
    }
  }
  // Composition branches constrain the same value. Object keywords alone do
  // not exclude scalars, null or arrays, but an enclosing object type does.
  const inheritedObjectContext = objectContext !== undefined;
  const constraint = objectConstraint(s);
  objectContext =
    objectContext === 'object' || constraint === 'object'
      ? 'object'
      : (objectContext ?? constraint);
  const array = arrayConstraint(s);
  arrayContext = arrayContext === 'array' || array === 'array' ? 'array' : (arrayContext ?? array);
  if (s.oneOf || s.anyOf || s.allOf || s.not) {
    const fields = new Map<string, Schema[]>();
    const collect = (shape: Schema): void => {
      for (const [key, child] of Object.entries(shape.properties ?? {}))
        fields.set(key, [...(fields.get(key) ?? []), child]);
      for (const child of shape.allOf ?? []) collect(child);
    };
    collect(s);
    const specialize = (shape: Schema): Schema => {
      const missing = (shape.required ?? []).filter(
        (key) => !shape.properties?.[key] && fields.has(key),
      );
      return {
        ...shape,
        ...(missing.length
          ? {
              properties: {
                ...shape.properties,
                ...Object.fromEntries(
                  missing.map((key) => {
                    const declarations = fields.get(key)!;
                    return [
                      key,
                      declarations.length === 1 ? declarations[0]! : { allOf: declarations },
                    ];
                  }),
                ),
              },
            }
          : {}),
        ...(shape.allOf ? { allOf: shape.allOf.map(specialize) } : {}),
        ...(shape.oneOf ? { oneOf: shape.oneOf.map(specialize) } : {}),
        ...(shape.anyOf ? { anyOf: shape.anyOf.map(specialize) } : {}),
      };
    };
    const { oneOf, anyOf, allOf, not, discriminator: tag, ...base } = specialize(s);
    const parts = [render(base, response, discriminator, known, objectContext, arrayContext)];
    for (const branch of allOf ?? [])
      parts.push(render(branch, response, discriminator, known, objectContext, arrayContext));
    for (const branches of [oneOf, anyOf])
      if (branches) {
        const alternatives = branches.map((branch) =>
          render(branch, response, tag?.propertyName, known, objectContext, arrayContext),
        );
        if (response && !known && nullableAlternative(s) === undefined)
          alternatives.push(
            objectContext === 'object' || branches.every((v) => v.type === 'object')
              ? 'Record<string, unknown>'
              : 'unknown',
          );
        parts.push(alternatives.map((v) => '(' + v + ')').join(' | '));
      }
    if (not && !response) {
      const absent = (constraint: Schema): string => {
        // Negating a value constraint does not imply that the field must be absent.
        const keywords = Object.keys(constraint).filter(
          (key) =>
            ![
              'description',
              'title',
              'default',
              'example',
              'examples',
              'deprecated',
              'readOnly',
              'writeOnly',
            ].includes(key) && !key.startsWith('x-'),
        );
        if (keywords.length !== 1) return 'unknown';
        if (constraint.required?.length)
          return constraint.required
            .map(
              (key) =>
                '{ ' + JSON.stringify(key) + '?: ' + optionalPropertyType(key, 'never') + ' }',
            )
            .join(' | ');
        if (constraint.anyOf) return constraint.anyOf.map((v) => '(' + absent(v) + ')').join(' & ');
        return 'unknown';
      };
      parts.push(absent(not));
    }
    const intersection =
      parts
        .filter((v) => v !== 'unknown')
        .map((v) => '(' + v + ')')
        .join(' & ') || 'unknown';
    // A date is normalized before all same-value string constraints are checked.
    // Adding it outside the intersection keeps a sibling string from erasing it.
    return !response && hasDateInput(s, definitions)
      ? `(${intersection}) | globalThis.Date`
      : intersection;
  }
  const types = Array.isArray(s.type) ? s.type : [s.type];
  if (types.length > 1) return types.map((t) => render({ ...s, type: t! }, response)).join(' | ');
  // Equivalent numeric enum values have many valid spellings (1, 1.0, 1e0).
  // Their exact string representation is checked by the runtime, not a literal union.
  if (
    !response &&
    s['x-sdk-number-input'] === 'explicit' &&
    exactValue(valueInstruction(types[0], s.format, s['x-sdk-integer-mode']))
  )
    return valueInstruction(types[0], s.format, s['x-sdk-integer-mode']).kind === 'exact-integer'
      ? 'ExactNumber | bigint'
      : 'ExactNumber';
  if (s.enum && exactValue(valueInstruction(types[0], s.format, s['x-sdk-integer-mode'])))
    return valueInstruction(types[0], s.format, s['x-sdk-integer-mode']).kind === 'exact-integer'
      ? response
        ? '`${bigint}`'
        : '`${bigint}` | bigint'
      : 'string';
  if (s.enum && !response)
    return (
      (s.enum
        .filter(
          (v) =>
            !types[0] ||
            (v === null
              ? types[0] === 'null'
              : typeof v === 'number'
                ? ['number', 'integer'].includes(types[0])
                : typeof v === types[0]),
        )
        .map((v) =>
          JSON.stringify(
            v !== null && exactValue(valueInstruction(types[0], s.format, s['x-sdk-integer-mode']))
              ? String(v)
              : v,
          ),
        )
        .join(' | ') || 'never') +
      (types[0] === 'string' && s.format === 'date-time' ? ' | globalThis.Date' : '')
    );
  switch (types[0]) {
    case 'null':
      return 'null';
    case 'string':
      if (!response && s.format === 'date-time') return 'string | globalThis.Date';
      return s.enum
        ? s.enum.map((v) => JSON.stringify(v)).join(' | ') + ' | (string & {})'
        : 'string';
    case 'boolean':
      return 'boolean';
    case 'number':
      return exactValue(valueInstruction('number', s.format, s['x-sdk-integer-mode']))
        ? 'string'
        : 'number';
    case 'integer':
      return exactValue(valueInstruction('integer', s.format, s['x-sdk-integer-mode']))
        ? response
          ? '`${bigint}`'
          : '`${bigint}` | bigint'
        : 'number';
    case 'array':
      return `Array<${render(s.items!, response)}>`;
    case undefined:
      // Items constrain arrays without asserting the instance is an array.
      // A surrounding conjunction supplies that assertion at this use site.
      if (arrayContext && s.items) {
        const items = `Array<${render(s.items, response)}>`;
        return arrayContext === 'nullableArray' ? `null | (${items})` : items;
      }
      if (!s.properties && !s.required?.length) return 'unknown';
      if (objectContext === 'nullableObject')
        return `null | (${render({ ...s, type: 'object' }, response, discriminator)})`;
      if (!objectContext)
        return `null | boolean | number | string | unknown[] | (${render({ ...s, type: 'object' }, response, discriminator)})`;
    case 'object': {
      const declaration = objectDeclaration(s, response);
      if (declaration.dictionary)
        return `Record<string, ${render(declaration.dictionary, response)}>`;
      return (
        '{ ' +
        declaration.fields
          .map(
            ([k, v]) =>
              (documentation ? schemaComment(v, definitions, response) : '') +
              (!response && v.readOnly
                ? `${JSON.stringify(k)}?: ${optionalPropertyType(k, 'never')};`
                : `${JSON.stringify(k)}${s.required?.includes(k) ? '' : '?'}: ${s.required?.includes(k) ? render(v, response && k !== discriminator) : optionalPropertyType(k, render(v, response && k !== discriminator))};`),
          )
          .join(' ') +
        (declaration.open &&
        !(
          inheritedObjectContext &&
          !declaration.fields.length &&
          s.additionalProperties === undefined
        )
          ? ` [key: string]: unknown;`
          : '') +
        ' }'
      );
    }
    default:
      return 'unknown';
  }
}
export { phpNative as phpType, phpDocumentation as phpDocType } from './php-types.js';
export function phpShape(s: Schema, response = false): string {
  const doc = phpDocumentation(s, response);
  if (response && doc === '\\stdClass') {
    const value =
      typeof s.additionalProperties === 'object'
        ? phpDocumentation(s.additionalProperties, true, s['x-sdk-definitions'])
        : 'mixed';
    return `array<array-key, ${value}>|\\stdClass`;
  }
  if (response && doc.startsWith('object{')) {
    const fields = doc.slice(7, -1);
    return `array{${fields}${fields ? ', ' : ''}...}|object`;
  }
  return doc;
}
