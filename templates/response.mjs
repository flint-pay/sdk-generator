import { SdkError } from './runtime.js';

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
