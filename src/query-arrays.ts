import type { Schema } from './contract.js';

/** Declaration view only; runtime wraps scalars before validating the original array branch. */
export function scalarQueryArray(schema: Schema): Schema | undefined {
  const parts = (value: Schema): Schema[] => [value, ...(value.allOf ?? []).flatMap(parts)];
  const scopes = parts(schema);
  if (
    !scopes.some(
      (part) => part.type === 'array' || (Array.isArray(part.type) && part.type.includes('array')),
    )
  )
    return undefined;
  const items = scopes.flatMap((part) => (part.items ? [part.items] : []));
  const first = items[0];
  if (!first) return undefined;
  const item = items.length === 1 ? first : { allOf: items };
  return {
    anyOf: [schema, item],
    'x-sdk-query-array-items': item,
    ...(schema.description ? { description: schema.description } : {}),
  };
}
