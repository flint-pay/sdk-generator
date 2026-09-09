import type { Schema } from './contract.js';
import { directionalSchema, exactValue, valueInstruction } from './codec-plan.js';
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
    open: response || s.additionalProperties !== false,
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
export function typescriptType(
  s: Schema,
  response = false,
  discriminator?: string,
  known = false,
  objectContext?: ObjectContext,
): string {
  if (s['x-sdk-ref']) {
    const reference = s['x-sdk-ref'] + (response ? '' : 'Input');
    if (!objectContext) return reference;
    // A recursive alias may also admit nonobjects. Filter it at this use site
    // without expanding the recursive graph or narrowing the alias globally.
    const object = `Exclude<${reference} & object, readonly unknown[]>`;
    return objectContext === 'nullableObject' ? `(${object}) | (${reference} & null)` : object;
  }
  s = directionalSchema(s, response);
  // Composition branches constrain the same value. Object keywords alone do
  // not exclude scalars, null or arrays, but an enclosing object type does.
  const constraint = objectConstraint(s);
  objectContext =
    objectContext === 'object' || constraint === 'object'
      ? 'object'
      : (objectContext ?? constraint);
  if (s.oneOf || s.anyOf || s.allOf || s.not) {
    const { oneOf, anyOf, allOf, not, discriminator: tag, ...base } = s;
    const parts = [typescriptType(base, response, discriminator, false, objectContext)];
    for (const branch of allOf ?? [])
      parts.push(typescriptType(branch, response, discriminator, false, objectContext));
    for (const branches of [oneOf, anyOf])
      if (branches) {
        const alternatives = branches.map((branch) =>
          typescriptType(branch, response, tag?.propertyName, false, objectContext),
        );
        if (response && !known)
          alternatives.push(
            objectContext === 'object' || branches.every((v) => v.type === 'object')
              ? '{ [key: string]: unknown }'
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
    return (
      parts
        .filter((v) => v !== 'unknown')
        .map((v) => '(' + v + ')')
        .join(' & ') || 'unknown'
    );
  }
  const types = Array.isArray(s.type) ? s.type : [s.type];
  if (types.length > 1)
    return types.map((t) => typescriptType({ ...s, type: t! }, response)).join(' | ');
  // Equivalent numeric enum values have many valid spellings (1, 1.0, 1e0).
  // Their exact string representation is checked by the runtime, not a literal union.
  if (
    s.enum &&
    exactValue(valueInstruction(typeof s.type === 'string' ? s.type : undefined, s.format))
  )
    return 'string';
  if (s.enum && !response)
    return (
      s.enum
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
            v !== null && (exactValue(valueInstruction('integer', s.format)) || s.type === 'number')
              ? String(v)
              : v,
          ),
        )
        .join(' | ') || 'never'
    );
  switch (types[0]) {
    case 'null':
      return 'null';
    case 'string':
      return s.enum
        ? s.enum.map((v) => JSON.stringify(v)).join(' | ') + ' | (string & {})'
        : 'string';
    case 'boolean':
      return 'boolean';
    case 'number':
      return 'string';
    case 'integer':
      return exactValue(valueInstruction('integer', s.format)) ? 'string' : 'number';
    case 'array':
      return `Array<${typescriptType(s.items!, response)}>`;
    case undefined:
      if (!s.properties && !s.required?.length) return 'unknown';
      if (objectContext === 'nullableObject')
        return `null | (${typescriptType({ ...s, type: 'object' }, response, discriminator)})`;
      if (!objectContext)
        return `null | boolean | number | string | unknown[] | (${typescriptType({ ...s, type: 'object' }, response, discriminator)})`;
    case 'object': {
      const declaration = objectDeclaration(s, response);
      if (declaration.dictionary)
        return `Record<string, ${typescriptType(declaration.dictionary, response)}>`;
      return (
        '{ ' +
        declaration.fields
          .map(([k, v]) =>
            !response && v.readOnly
              ? `${JSON.stringify(k)}?: ${optionalPropertyType(k, 'never')};`
              : `${JSON.stringify(k)}${s.required?.includes(k) ? '' : '?'}: ${s.required?.includes(k) ? typescriptType(v, response && k !== discriminator) : optionalPropertyType(k, typescriptType(v, response && k !== discriminator))};`,
          )
          .join(' ') +
        (declaration.open ? ` [key: string]: unknown;` : '') +
        ' }'
      );
    }
    default:
      return 'unknown';
  }
}
export function phpType(s: Schema): string {
  if (s.oneOf || s.anyOf || s.allOf || s.type === undefined) return 'mixed';
  const types = Array.isArray(s.type) ? s.type : [s.type];
  return [
    ...new Set(
      types.map((t) =>
        t === 'null'
          ? 'null'
          : t === 'integer'
            ? exactValue(valueInstruction('integer', s.format))
              ? 'string'
              : 'int'
            : t === 'number'
              ? 'string'
              : t === 'boolean'
                ? 'bool'
                : t === 'object'
                  ? 'array|object'
                  : t === 'array'
                    ? 'array'
                    : 'string',
      ),
    ),
  ].join('|');
}
export function phpShape(s: Schema, response = false): string {
  if (s.type === 'object')
    return (
      'array{' +
      Object.entries(s.properties ?? {})
        .filter(([, v]) => (response ? !v.writeOnly : !v.readOnly))
        .map(([k, v]) => `${php(k)}${s.required?.includes(k) ? '' : '?'}: ${phpType(v)}`)
        .join(', ') +
      '}'
    );
  return 'array<string, mixed>';
}
export function phpDocType(s: Schema, response = false): string {
  if (s.oneOf || s.anyOf)
    return (
      (s.oneOf ?? s.anyOf)!.map((v) => phpDocType(v, response)).join('|') +
      (response ? '|mixed' : '')
    );
  if (s.allOf) return s.allOf.map((v) => phpDocType(v, response)).join('&');
  if (s.type === 'array') return `list<${phpDocType(s.items!, response)}>`;
  if (s.type === 'object')
    return `${response ? 'object' : 'array'}{${Object.entries(s.properties ?? {})
      .filter(([, v]) => (response ? !v.writeOnly : !v.readOnly))
      .map(([k, v]) => `${php(k)}${s.required?.includes(k) ? '' : '?'}: ${phpDocType(v, response)}`)
      .join(', ')}}`;
  return phpType(s);
}
