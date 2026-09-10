import { createHash } from 'node:crypto';
import type { Contract, Schema } from './contract.js';

/** Hash subtrees without ever materializing the expanded graph as one JSON string. */
function identities() {
  const cache = new WeakMap<object, string>();
  const identity = (value: unknown): string => {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
    const previous = cache.get(value);
    if (previous) return previous;
    const digest = createHash('sha256');
    digest.update(Array.isArray(value) ? '[' : '{');
    for (const [key, child] of Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en'))) {
      digest.update(JSON.stringify(key));
      digest.update(':');
      digest.update(identity(child));
      digest.update(',');
    }
    const result = digest.digest('hex');
    cache.set(value, result);
    return result;
  };
  return identity;
}

/** Share named schemas at value-descending edges; conjunction/tag policy stays at its use site. */
export function shareContractSchemas(contract: Contract): void {
  let identity = identities();
  const catalog = { ...contract.models, ...contract.definitions };
  const names = new Map(
    Object.entries(catalog).map(([name, schema]) => [identities()(schema), name]),
  );
  const compact = (schema: Schema, nested = false): Schema => {
    const name = nested ? names.get(identity(schema)) : undefined;
    if (name && !schema['x-sdk-ref'])
      return {
        'x-sdk-ref': name,
        ...(schema.readOnly ? { readOnly: true } : {}),
        ...(schema.writeOnly ? { writeOnly: true } : {}),
        ...(schema['x-sensitive'] ? { 'x-sensitive': true } : {}),
      };
    const out = { ...schema };
    if (schema.properties)
      out.properties = Object.fromEntries(
        Object.entries(schema.properties).map(([key, child]) => [key, compact(child, true)]),
      );
    if (schema.items) out.items = compact(schema.items, true);
    if (schema.additionalProperties && typeof schema.additionalProperties === 'object')
      out.additionalProperties = compact(schema.additionalProperties, true);
    for (const keyword of ['allOf', 'anyOf', 'oneOf'] as const)
      if (schema[keyword]) out[keyword] = schema[keyword].map((child) => compact(child));
    for (const keyword of ['not', 'contains', 'if', 'then', 'else'] as const)
      if (schema[keyword]) out[keyword] = compact(schema[keyword]);
    return out;
  };
  const compactRoot = (schema: Schema): Schema => {
    // A full export contains many independent expanded copies. Memoize within
    // one root, allowing previous roots' fingerprint tables to be collected.
    identity = identities();
    return compact(schema);
  };
  contract.models = Object.fromEntries(
    Object.entries(contract.models).map(([name, schema]) => [name, compactRoot(schema)]),
  );
  contract.definitions = Object.fromEntries(
    Object.entries(catalog).map(([name, schema]) => [name, compactRoot(schema)]),
  );
  for (const operation of contract.operations) {
    for (const parameter of operation.parameters) parameter.schema = compactRoot(parameter.schema);
    if (operation.body) operation.body = compactRoot(operation.body);
    for (const response of Object.values(operation.responses))
      if (response.schema) response.schema = compactRoot(response.schema);
    if (operation.streamEventSchemas)
      operation.streamEventSchemas = Object.fromEntries(
        Object.entries(operation.streamEventSchemas).map(([name, schema]) => [
          name,
          compactRoot(schema),
        ]),
      );
  }
  for (const incoming of contract.incoming ?? []) incoming.schema = compactRoot(incoming.schema);
  if (contract.config.webhook)
    contract.config.webhook.events = Object.fromEntries(
      Object.entries(contract.config.webhook.events).map(([name, schema]) => [
        name,
        compactRoot(schema),
      ]),
    );
}
