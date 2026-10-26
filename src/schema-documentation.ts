import type { Schema } from './contract.js';
import { exactValue, valueInstruction } from './codec-plan.js';

export function schemaLiteral(text: string, table = false): string {
  const value = (table ? text.replaceAll('|', '\\|') : text).replace(/[\r\n]+/g, ' ');
  const delimiter = '`'.repeat(
    Math.max(0, ...[...value.matchAll(/`+/g)].map((m) => m[0].length)) + 1,
  );
  const padding =
    value.startsWith('`') ||
    value.endsWith('`') ||
    (value.startsWith(' ') && value.endsWith(' ') && !/^ +$/.test(value))
      ? ' '
      : '';
  return `${delimiter}${padding}${value}${padding}${delimiter}`;
}
/** Human-facing field semantics; kept out of codec and compatibility plans. */
export function schemaNotes(
  s: Schema,
  formatting: { literal?: (text: string) => string; description?: (text: string) => string } = {},
): string {
  const literal = formatting.literal ?? ((text: string) => text);
  const notes = s.description
    ? [(formatting.description ?? ((text: string) => text))(s.description)]
    : [];
  const types = Array.isArray(s.type) ? s.type : [s.type];
  if (types.some((type) => exactValue(valueInstruction(type, s.format))))
    notes.push(
      s['x-sdk-number-input'] === 'explicit'
        ? 'Use ExactNumber for an exact JSON number.'
        : ['int64', 'uint64'].includes(s.format ?? '')
          ? 'Use an integer string (decimal digits), not a floating-point number.'
          : 'Use an exact numeric string, not a floating-point number.',
    );
  if (s.format) notes.push('Format: ' + literal(s.format) + '.');
  for (const key of [
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'multipleOf',
    'minLength',
    'maxLength',
    'minItems',
    'maxItems',
    'pattern',
  ] as const)
    if (s[key] !== undefined) notes.push(key + ': ' + literal(String(s[key])) + '.');
  const example = Object.hasOwn(s, 'example')
    ? s.example
    : Array.isArray(s.examples)
      ? s.examples[0]
      : undefined;
  if (example !== undefined) {
    const exact = types.some((type) => exactValue(valueInstruction(type, s.format)));
    notes.push(
      'Example: ' +
        literal(JSON.stringify(exact && typeof example === 'number' ? String(example) : example)) +
        '.',
    );
  }
  return notes.join(' ');
}
export function schemaComment(
  s: Schema,
  definitions: Readonly<Record<string, Schema>> = {},
): string {
  const notes = [
    schemaNotes(s),
    enumNotes(schemaEnumValues(s, definitions).filter((entry) => entry.path)),
  ]
    .filter(Boolean)
    .join(' ');
  return notes ? '\n/** ' + notes.replaceAll('*/', '* /').replace(/[\r\n]+/g, ' ') + ' */\n' : '';
}

export interface SchemaEnumValues {
  /** Empty for the value itself; [] for items and .* for dictionary values. */
  path: string;
  values: string[];
}
export type EnumLinks = ReadonlyMap<string, string>;
export const enumIdentity = (values: readonly string[]) => JSON.stringify([...values].sort());

/** Read declared enum metadata through references, compositions and collection elements. */
export function schemaEnumValues(
  schema: Schema,
  definitions: Readonly<Record<string, Schema>> = {},
  seen = new Set<string>(),
): SchemaEnumValues[] {
  definitions = schema['x-sdk-definitions'] ?? definitions;
  const enums = new Map<string, string[]>();
  const merge = (entries: SchemaEnumValues[], intersection: boolean) => {
    for (const { path, values } of entries) {
      const previous = enums.get(path);
      enums.set(
        path,
        previous
          ? intersection
            ? previous.filter((value) => values.includes(value))
            : [...new Set([...previous, ...values])]
          : values,
      );
    }
  };
  if (schema.enum)
    merge([{ path: '', values: schema.enum.map((value) => JSON.stringify(value)) }], true);
  if (schema.items)
    merge(
      schemaEnumValues(schema.items, definitions, seen).map((entry) => ({
        ...entry,
        path: '[]' + entry.path,
      })),
      true,
    );
  if (typeof schema.additionalProperties === 'object')
    merge(
      schemaEnumValues(schema.additionalProperties, definitions, seen).map((entry) => ({
        ...entry,
        path: '.*' + entry.path,
      })),
      true,
    );
  const ref = schema['x-sdk-ref'];
  if (ref && definitions[ref] && !seen.has(ref))
    merge(schemaEnumValues(definitions[ref]!, definitions, new Set(seen).add(ref)), true);
  for (const part of schema.allOf ?? []) merge(schemaEnumValues(part, definitions, seen), true);
  const alternatives = new Map<string, Set<string>>();
  for (const part of schema.oneOf ?? schema.anyOf ?? [])
    for (const { path, values } of schemaEnumValues(part, definitions, seen)) {
      const group = alternatives.get(path) ?? new Set<string>();
      for (const value of values) group.add(value);
      alternatives.set(path, group);
    }
  merge(
    [...alternatives].map(([path, values]) => ({ path, values: [...values] })),
    true,
  );
  return [...enums].map(([path, values]) => ({ path, values }));
}

export function enumNotes(
  entries: readonly SchemaEnumValues[],
  literal: (text: string) => string = (text) => text,
  links?: EnumLinks,
): string {
  return entries
    .map(({ path, values }) => {
      const label = path
        ? `${path.startsWith('[]') ? 'Items' : 'Map'}${path.slice(2)} values`
        : 'Values';
      const link = links?.get(enumIdentity(values));
      return `${label}: ${link ? `[${values.length} declared values](${link})` : values.map(literal).join(', ')}.`;
    })
    .join(' ');
}
