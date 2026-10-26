import { EXAMPLE_PROTECTION_MARKER } from './example-protection.js';
import { createHash } from 'node:crypto';
import type { Contract, Schema } from './contract.js';
import { isSchemaAnnotation } from './schema-annotations.js';

/** Hash subtrees without ever materializing the expanded graph as one JSON string. */
function identities() {
  type Context = 'schema' | 'map' | 'data';
  const caches = {
    schema: new WeakMap<object, string>(),
    map: new WeakMap<object, string>(),
    data: new WeakMap<object, string>(),
  };
  const identity = (value: unknown, context: Context = 'schema'): string => {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
    const cache = caches[context];
    const previous = cache.get(value);
    if (previous) return previous;
    const digest = createHash('sha256');
    digest.update(Array.isArray(value) ? '[' : '{');
    for (const [key, child] of Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en'))) {
      // Publication provenance must not change sharing when this schema has no
      // annotation value to omit. Keep literal annotation payloads untouched.
      if (
        context === 'schema' &&
        key === EXAMPLE_PROTECTION_MARKER &&
        !['example', 'examples', 'default'].some((annotation) => Object.hasOwn(value, annotation))
      )
        continue;
      const nested: Context =
        context === 'map' || (context === 'schema' && Array.isArray(value))
          ? 'schema'
          : context === 'schema' &&
              ['properties', 'patternProperties', 'dependentSchemas'].includes(key)
            ? 'map'
            : context === 'schema' &&
                [
                  'items',
                  'additionalProperties',
                  'propertyNames',
                  'allOf',
                  'anyOf',
                  'oneOf',
                  'not',
                  'contains',
                  'if',
                  'then',
                  'else',
                  'prefixItems',
                ].includes(key)
              ? 'schema'
              : 'data';
      digest.update(JSON.stringify(key));
      digest.update(':');
      digest.update(identity(child, nested));
      digest.update(',');
    }
    const result = digest.digest('hex');
    cache.set(value, result);
    return result;
  };
  return identity;
}

/** Share named schemas at value-descending edges; conjunction/tag policy stays at its use site. */
export function shareContractSchemas(
  contract: Contract,
  referenceNames: Readonly<WeakMap<object, string>> = new WeakMap(),
  typeNames: Readonly<WeakMap<object, string>> = new WeakMap(),
  responseOnlyCandidates: ReadonlySet<string> = new Set(),
): string[] {
  // Public Node names are declaration hints, separate from shared codec references
  // and PHP class identities. Sharing must not rename a source component's return type.
  const identity = identities();
  const catalog = { ...contract.models, ...contract.definitions };
  const names = new Map(Object.entries(catalog).map(([name, schema]) => [identity(schema), name]));
  const responseOnly = new Set([...names.keys()]);
  // Sharing can alias otherwise unrelated names and inline request schemas.
  // Every alias must have source proof, and every request position vetoes it.
  for (const [name, schema] of Object.entries(catalog))
    if (!responseOnlyCandidates.has(name)) responseOnly.delete(identity(schema));
  const visited = new Set<Schema>();
  const input = (schema: Schema): void => {
    if (visited.has(schema)) return;
    visited.add(schema);
    responseOnly.delete(identity(schema));
    const reference = schema['x-sdk-ref'];
    if (reference) {
      const target = catalog[reference];
      if (target) input(target);
      else responseOnly.clear();
    }
    for (const child of Object.values(schema.properties ?? {})) input(child);
    if (schema.items) input(schema.items);
    if (typeof schema.additionalProperties === 'object') input(schema.additionalProperties);
    for (const keyword of ['allOf', 'anyOf', 'oneOf'] as const)
      for (const child of schema[keyword] ?? []) input(child);
    for (const keyword of ['not', 'contains', 'propertyNames', 'if', 'then', 'else'] as const)
      if (schema[keyword]) input(schema[keyword]);
  };
  for (const op of contract.operations) {
    for (const parameter of op.parameters) input(parameter.schema);
    if (op.body) input(op.body);
  }
  for (const incoming of contract.incoming ?? []) input(incoming.schema);
  for (const event of Object.values(contract.config.webhook?.events ?? {})) input(event);
  const proven = Object.entries(catalog)
    .filter(([, schema]) => responseOnly.has(identity(schema)))
    .map(([name]) => name)
    .sort();
  const compact = (schema: Schema, nested = false): Schema => {
    const reference = referenceNames.get(schema);
    if (nested && reference) {
      const target = catalog[reference];
      if (!target) throw new Error('Missing annotation reference ' + reference);
      // Reuse the identity assigned to an unannotated reference, including
      // existing aliases among identical components.
      const name = names.get(identity(target));
      if (!name) throw new Error('Missing named schema identity for ' + reference);
      return {
        'x-sdk-ref': name,
        ...(name !== reference ? { 'x-sdk-type-name': reference } : {}),
        ...Object.fromEntries(Object.entries(schema).filter(([key]) => isSchemaAnnotation(key))),
      };
    }
    const name = nested ? names.get(identity(schema)) : undefined;
    const typeName = typeNames.get(schema);
    if (name && !schema['x-sdk-ref'])
      return {
        'x-sdk-ref': name,
        ...(schema[EXAMPLE_PROTECTION_MARKER] ? { [EXAMPLE_PROTECTION_MARKER]: true } : {}),
        ...(typeName && typeName !== name ? { 'x-sdk-type-name': typeName } : {}),
        ...(schema.readOnly ? { readOnly: true } : {}),
        ...(schema.writeOnly ? { writeOnly: true } : {}),
        ...(schema['x-sensitive'] ? { 'x-sensitive': true } : {}),
      };
    const out = { ...schema };
    if (typeName) out['x-sdk-type-name'] = typeName;
    if (schema.properties)
      out.properties = Object.fromEntries(
        Object.entries(schema.properties).map(([key, child]) => [key, compact(child, true)]),
      );
    if (schema.items) out.items = compact(schema.items, true);
    if (schema.additionalProperties && typeof schema.additionalProperties === 'object')
      out.additionalProperties = compact(schema.additionalProperties, true);
    for (const keyword of ['allOf', 'anyOf', 'oneOf'] as const)
      if (schema[keyword]) out[keyword] = schema[keyword].map((child) => compact(child));
    for (const keyword of ['not', 'contains', 'propertyNames', 'if', 'then', 'else'] as const)
      if (schema[keyword]) out[keyword] = compact(schema[keyword]);
    return out;
  };
  const compactRoot = (schema: Schema): Schema => {
    // Resolution shares value-descending subgraphs. Weak keys let compacted
    // roots be collected while fingerprints are reused by the remaining roots.
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
    if (operation.body) {
      const name = typeNames.get(operation.body);
      operation.body = {
        ...compactRoot(operation.body),
        ...(name ? { 'x-sdk-type-name': name } : {}),
      };
    }
    for (const response of Object.values(operation.responses))
      if (response.schema) {
        const name = typeNames.get(response.schema);
        response.schema = {
          ...compactRoot(response.schema),
          ...(name ? { 'x-sdk-type-name': name } : {}),
        };
      }
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
  return proven;
}
