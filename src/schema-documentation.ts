import type { Schema } from './contract.js';
import { exactValue, valueInstruction } from './codec-plan.js';

/** Human-facing field semantics; kept out of codec and compatibility plans. */
export function schemaNotes(
  s: Schema,
  formatting: { literal?: (text: string) => string; description?: (text: string) => string } = {},
): string {
  const literal = formatting.literal ?? ((text: string) => text);
  const notes = s.description
    ? [(formatting.description ?? ((text: string) => text))(s.description)]
    : [];
  const types = Array.isArray(s.type) ? s.type : [s.type];
  if (types.some((type) => exactValue(valueInstruction(type, s.format))))
    notes.push(
      s['x-sdk-number-input'] === 'explicit'
        ? 'Use ExactNumber for an exact JSON number.'
        : 'Use an exact numeric string, not a floating-point number.',
    );
  if (s.format) notes.push('Format: ' + literal(s.format) + '.');
  for (const key of [
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'multipleOf',
    'minLength',
    'maxLength',
    'minItems',
    'maxItems',
    'pattern',
  ] as const)
    if (s[key] !== undefined) notes.push(key + ': ' + literal(String(s[key])) + '.');
  const example = Object.hasOwn(s, 'example')
    ? s.example
    : Array.isArray(s.examples)
      ? s.examples[0]
      : undefined;
  if (example !== undefined) notes.push('Example: ' + literal(JSON.stringify(example)) + '.');
  return notes.join(' ');
}
export function schemaComment(s: Schema): string {
  const notes = schemaNotes(s);
  return notes ? '/** ' + notes.replaceAll('*/', '* /').replace(/[\r\n]+/g, ' ') + ' */ ' : '';
}
