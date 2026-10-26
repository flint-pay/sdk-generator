import { inspect } from 'node:util';
import { createSdkError } from './runtime.js';

export function sdkResponse(result) {
  const response = { body: result.data, meta: result.meta, raw: result.raw };
  Object.defineProperty(response, inspect.custom, {
    value: () => {
      const safe = result[inspect.custom]();
      return { body: safe.data, meta: safe.meta };
    },
  });
  return response;
}

export function responsePayload(result, path, decode) {
  let value = result.data;
  for (const key of path) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) {
      throw createSdkError(
        'protocol',
        'Missing configured response payload: ' + path.join('.'),
        'response',
        false,
        result.meta,
        undefined,
        undefined,
        undefined,
        result.raw,
      );
    }
    value = value[key];
  }
  return decode ? decode(result, path) : value;
}

export async function* payloadPages(pages, path, decode) {
  for await (const result of pages) yield responsePayload(result, path, decode);
}

export async function* sdkResponsePages(pages) {
  for await (const result of pages) yield sdkResponse(result);
}
