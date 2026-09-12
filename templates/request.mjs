import { Model, SdkError } from './runtime.js';

export function requestInput(paths, values, fields, body, required, params) {
  if (params instanceof Model) params = params.toJSON();
  if (params !== undefined && (!params || typeof params !== 'object' || Array.isArray(params)))
    throw new SdkError('validation', 'Expected a params object', 'not_sent');
  const input = Object.fromEntries(paths.map((name, index) => [name, values[index]]));
  const rest = { ...(params ?? {}) };
  for (const name of fields) {
    if (Object.hasOwn(rest, name)) {
      Object.defineProperty(input, name, { value: rest[name], enumerable: true });
      delete rest[name];
    }
  }
  if (body) {
    if (
      params !== undefined &&
      (required || !Object.keys(params).length || Object.keys(rest).length)
    )
      input.body = rest;
  } else {
    // Keep unknown keys so the canonical request validator rejects them.
    for (const [name, value] of Object.entries(rest)) {
      if (Object.hasOwn(input, name))
        throw new SdkError('validation', 'Path values belong in positional arguments', 'not_sent');
      Object.defineProperty(input, name, { value, enumerable: true });
    }
  }
  return input;
}
