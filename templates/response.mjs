import { createSdkError } from './runtime.js';

export function responsePayload(result, path, decode) {
  let value = result.data;
  for (const key of path) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) {
      throw createSdkError(
        'protocol',
        'Missing configured response payload: ' + path.join('.'),
        'response',
        false,
        result.lastResponse,
        'missing_payload',
        undefined,
        undefined,
        result.raw,
      );
    }
    value = value[key];
  }
  const payload = decode ? decode(result, path) : value;
  Object.defineProperty(payload, 'lastResponse', {
    value: result.lastResponse,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return payload;
}

export async function* payloadPages(pages, path, decode) {
  for await (const result of pages) yield responsePayload(result, path, decode);
}
