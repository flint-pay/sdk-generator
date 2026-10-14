import { EXAMPLE_PROTECTION_MARKER } from './example-protection.js';
/** Supported metadata does not change the referenced value's shape. */
export const schemaAnnotations: readonly string[] = [
  EXAMPLE_PROTECTION_MARKER,
  'description',
  'title',
  'default',
  'example',
  'examples',
  'deprecated',
  'readOnly',
  'writeOnly',
  'x-sensitive',
];

export const isSchemaAnnotation = (key: string): boolean =>
  schemaAnnotations.includes(key) || (key.startsWith('x-') && !key.startsWith('x-sdk-'));
