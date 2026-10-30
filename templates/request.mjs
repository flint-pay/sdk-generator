import { isModel, modelInputValue, createSdkError } from './runtime.js';

const invalid = (param, code, message) =>
  createSdkError('validation', message, 'not_sent', false, undefined, 'INVALID_REQUEST', [
    { code, param },
  ]);

export function requestInput(paths, values, fields, body, required, params, managed = []) {
  if (isModel(params)) params = modelInputValue(params);
  if (params !== undefined && (!params || typeof params !== 'object' || Array.isArray(params)))
    throw invalid('body', 'INVALID_VALUE', 'body must be an object');
  const input = Object.fromEntries(paths.map((name, index) => [name, values[index]]));
  const rest = { ...(params ?? {}) };
  for (const name of Object.keys(rest)) {
    const header = managed.find((field) => field.toLowerCase() === name.toLowerCase());
    if (header)
      throw invalid(
        header,
        'NOT_ALLOWED',
        `${header} can't be sent: supply this header through request options`,
      );
  }
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
        throw invalid(
          name,
          'NOT_ALLOWED',
          `${name} can't be sent: path values belong in positional arguments`,
        );
      Object.defineProperty(input, name, { value, enumerable: true });
    }
  }
  return input;
}
