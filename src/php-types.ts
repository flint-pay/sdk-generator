import type { Schema } from './contract.js';
import { directionalSchema, exactValue, valueInstruction } from './codec-plan.js';

/** A declaration projection only: codecs continue to own validation and matching. */
export function phpDeclaration(
  schema: Schema,
  definitions: Readonly<Record<string, Schema>> = {},
  seen = new Set<string>(),
): Schema {
  definitions = schema['x-sdk-definitions'] ?? definitions;
  const ref = schema['x-sdk-ref'];
  if (ref) {
    const target = definitions[ref];
    if (!target || seen.has(ref)) return {};
    return phpDeclaration(target, definitions, new Set([...seen, ref]));
  }
  if (!schema.allOf) return schema;
  const { allOf, ...base } = schema;
  const parts = [base, ...allOf.map((child) => phpDeclaration(child, definitions, seen))];
  const typed = parts.filter((part) => part.type !== undefined);
  const types = typed.map(
    (part) =>
      new Set(Array.isArray(part.type) ? part.type : part.type === undefined ? [] : [part.type]),
  );
  // JSON Schema integers are a subset of numbers.
  const candidates = new Set(types.flatMap((set) => [...set]));
  const allowed = [...candidates].filter((type) =>
    types.every((set) => set.has(type) || (type === 'integer' && set.has('number'))),
  );
  if (allowed.includes('number') && allowed.includes('integer'))
    allowed.splice(allowed.indexOf('integer'), 1);
  const firstType = allowed[0];
  const format =
    typed.find((part) =>
      (Array.isArray(part.type) ? part.type : [part.type]).some((type) =>
        exactValue(valueInstruction(type, part.format)),
      ),
    )?.format ?? typed.find((part) => part.format)?.format;
  const properties: Record<string, Schema> = {};
  for (const part of parts)
    for (const [key, child] of Object.entries(part.properties ?? {}))
      properties[key] = properties[key]
        ? {
            allOf: [properties[key], child],
            ...(properties[key].readOnly || child.readOnly ? { readOnly: true } : {}),
            ...(properties[key].writeOnly || child.writeOnly ? { writeOnly: true } : {}),
            ...(properties[key]['x-sensitive'] || child['x-sensitive']
              ? { 'x-sensitive': true }
              : {}),
          }
        : child;
  const intersect = (values: Schema[]): Schema | undefined =>
    values.length > 1 ? { allOf: values } : values[0];
  const items = intersect(parts.flatMap((part) => (part.items ? [part.items] : [])));
  const extras = parts.flatMap((part) =>
    typeof part.additionalProperties === 'object' ? [part.additionalProperties] : [],
  );
  const extra = parts.some((part) => part.additionalProperties === false)
    ? false
    : intersect(extras);
  const union = parts.find((part) => part.oneOf || part.anyOf);
  return {
    ...base,
    ...(firstType !== undefined ? { type: allowed.length === 1 ? firstType : allowed } : {}),
    ...(format !== undefined ? { format } : {}),
    ...(Object.keys(properties).length ? { properties } : {}),
    required: [...new Set(parts.flatMap((part) => part.required ?? []))],
    ...(items ? { items } : {}),
    ...(extra !== undefined ? { additionalProperties: extra } : {}),
    ...(union?.oneOf ? { oneOf: union.oneOf } : {}),
    ...(union?.anyOf ? { anyOf: union.anyOf } : {}),
    ...(union?.discriminator ? { discriminator: union.discriminator } : {}),
    ...(parts.some((part) => part.readOnly) ? { readOnly: true } : {}),
    ...(parts.some((part) => part.writeOnly) ? { writeOnly: true } : {}),
  };
}

export function phpUnion(types: readonly string[]): string {
  const unique = [...new Set(types.flatMap((type) => type.split('|')))];
  return unique.includes('mixed') ? 'mixed' : unique.join('|') || 'mixed';
}

export function phpNative(
  schema: Schema,
  response = false,
  definitions: Readonly<Record<string, Schema>> = {},
): string {
  definitions = schema['x-sdk-definitions'] ?? definitions;
  const s = phpDeclaration(schema, definitions);
  // The shared codec preserves a float when numeric conjuncts mix ordinary
  // number and integer projections, even though only integral values match.
  const hasNumber = (value: Schema, seen = new Set<string>()): boolean => {
    const ref = value['x-sdk-ref'];
    if (ref)
      return (
        !seen.has(ref) &&
        Boolean(definitions[ref]) &&
        hasNumber(definitions[ref]!, new Set([...seen, ref]))
      );
    return (
      (Array.isArray(value.type) ? value.type : [value.type]).includes('number') ||
      Boolean(value.allOf?.some((part) => hasNumber(part, seen)))
    );
  };
  const floatIntersection = response && hasNumber(schema);
  if (s.oneOf || s.anyOf || s.type === undefined) return 'mixed';
  return phpUnion(
    (Array.isArray(s.type) ? s.type : [s.type]).map((type) => {
      switch (type) {
        case 'integer':
          return exactValue(valueInstruction(type, s.format))
            ? 'string'
            : floatIntersection
              ? 'float'
              : 'int';
        case 'number':
          return exactValue(valueInstruction(type, s.format))
            ? 'string'
            : response
              ? 'float'
              : 'int|float';
        case 'boolean':
          return 'bool';
        case 'object':
          return 'array|object';
        case 'array':
          return 'array';
        case 'null':
          return 'null';
        default:
          return type === 'string' && s.format === 'date-time' && !response
            ? 'string|\\DateTimeInterface'
            : 'string';
      }
    }),
  );
}

export function phpDocumentation(
  schema: Schema,
  response = false,
  definitions: Readonly<Record<string, Schema>> = {},
  seen = new Set<string>(),
): string {
  definitions = schema['x-sdk-definitions'] ?? definitions;
  const references = (value: Schema): string[] =>
    value['x-sdk-ref'] ? [value['x-sdk-ref']] : (value.allOf ?? []).flatMap(references);
  const conjunctReferences = references(schema);
  const ref = schema['x-sdk-ref'];
  if (conjunctReferences.some((name) => seen.has(name))) {
    const native = phpNative(phpDeclaration(schema, definitions), response);
    return native === 'array|object'
      ? response
        ? '\\stdClass'
        : 'array<array-key, mixed>|object'
      : native === 'array'
        ? 'list<mixed>'
        : native;
  }
  if (ref && !response && definitions[ref]) return `${ref}Input|array<array-key, mixed>|\\stdClass`;
  if (ref && seen.has(ref)) return response ? '\\stdClass' : 'array<array-key, mixed>|object';
  const next = new Set([...seen, ...conjunctReferences]);
  const s = directionalSchema(phpDeclaration(schema, definitions), response);
  const render = (child: Schema) => phpDocumentation(child, response, definitions, next);
  if (!response && s['x-sdk-number-input'] === 'explicit') return 'ExactNumber';
  if (s.oneOf || s.anyOf) {
    // Tolerant alternatives can retain values outside all known branches.
    if (response) return s.type === 'object' ? '\\stdClass' : 'mixed';
    const alternatives = [...new Set((s.oneOf ?? s.anyOf ?? []).map(render))];
    return alternatives.includes('mixed') ? 'mixed' : alternatives.join('|') || 'mixed';
  }
  const types = Array.isArray(s.type) ? s.type : [s.type];
  if (
    types.includes('null') &&
    types.length > 1 &&
    types.every((type) => type !== 'object' && type !== 'array')
  )
    return phpNative(schema, response, definitions);
  if (types.includes('null') && types.length > 1)
    return (
      render({
        ...s,
        type: types.filter((type): type is string => type !== 'null' && type !== undefined),
      }) + '|null'
    );
  const type = types[0];
  if (type === 'array') return `list<${render(s.items ?? {})}>`;
  if (type === 'object') {
    const extra = s.additionalProperties;
    const fields = [...new Set([...Object.keys(s.properties ?? {}), ...(s.required ?? [])])]
      .map((key): [string, Schema] => [
        key,
        s.properties?.[key] ?? (typeof extra === 'object' ? extra : {}),
      ])
      .filter(([, child]) => (response ? !child.writeOnly : !child.readOnly));
    if (!fields.length && extra !== false)
      return response
        ? '\\stdClass'
        : `array<array-key, ${typeof extra === 'object' ? render(extra) : 'mixed'}>|\\stdClass`;
    const quote = (key: string) => "'" + key.replaceAll('\\', '\\\\').replaceAll("'", "\\'") + "'";
    const entries = fields.map(
      ([key, child]) => `${quote(key)}${s.required?.includes(key) ? '' : '?'}: ${render(child)}`,
    );
    if (!response && extra !== false)
      entries.push(typeof extra === 'object' ? `...<array-key, ${render(extra)}>` : '...');
    const shape = `${response ? 'object' : 'array'}{${entries.join(', ')}}`;
    return response ? shape : shape + '|object';
  }
  return phpNative(schema, response, definitions);
}
