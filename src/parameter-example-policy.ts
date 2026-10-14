import type { Parameter, Schema } from './contract.js';

/** Conservative eligibility for parameter metadata, independent of its value. */
export function parameterExampleEligible(
  parameter: Parameter,
  definitions: Readonly<Record<string, Schema>>,
  apiKeyNames: ReadonlySet<string> = new Set(),
): boolean {
  const name = parameter.name.toLowerCase();
  const normalized = name.replace(/[^a-z0-9]/g, '');
  if (
    !['path', 'query'].includes(parameter.in) ||
    apiKeyNames.has(name) ||
    [
      'password',
      'passwd',
      'secret',
      'token',
      'apikey',
      'clientsecret',
      'privatekey',
      'accesskey',
      'authorization',
      'credential',
      'signature',
      'cookie',
      'session',
    ].some((token) => normalized.includes(token)) ||
    Reflect.get(parameter, 'x-sensitive') === true ||
    Reflect.get(parameter, 'writeOnly') === true ||
    Reflect.get(parameter, 'format') === 'password'
  )
    return false;

  const seen = new Set<object>();
  const sensitive = (schema: unknown): boolean => {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return false;
    if (seen.has(schema)) return false;
    seen.add(schema);
    if (
      Reflect.get(schema, 'x-sensitive') === true ||
      Reflect.get(schema, 'writeOnly') === true ||
      Reflect.get(schema, 'format') === 'password'
    )
      return true;
    // Local source $refs have already become x-sdk-ref. Inspect the use site
    // and its target independently; a missing target cannot prove eligibility.
    const reference: unknown = Reflect.get(schema, 'x-sdk-ref');
    if (typeof reference === 'string') {
      if (!Object.hasOwn(definitions, reference) || sensitive(definitions[reference])) return true;
    }
    for (const key of ['items', 'contains', 'additionalProperties', 'not', 'if', 'then', 'else'])
      if (sensitive(Reflect.get(schema, key))) return true;
    for (const key of ['prefixItems', 'allOf', 'anyOf', 'oneOf']) {
      const branches: unknown = Reflect.get(schema, key);
      if (Array.isArray(branches) && branches.some(sensitive)) return true;
    }
    const properties: unknown = Reflect.get(schema, 'properties');
    return Boolean(
      properties && typeof properties === 'object' && Object.values(properties).some(sensitive),
    );
  };
  return !sensitive(parameter.schema);
}
