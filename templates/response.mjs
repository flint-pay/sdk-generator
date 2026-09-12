import { inspect } from 'node:util';
import { SdkError } from './runtime.js';

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

export function responsePayload(result, path) {
  let value = result.data;
  for (const key of path) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) {
      throw new SdkError(
        'protocol',
        'Missing configured response payload: ' + path.join('.'),
        'response',
        false,
        result.meta,
      );
    }
    value = value[key];
  }
  return value;
}
