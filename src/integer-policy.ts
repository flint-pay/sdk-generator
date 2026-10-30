import type { Config } from './contract.js';

export const integerMode = (config: Pick<Config, 'integers'>): 'number' | 'exact' =>
  typeof config.integers === 'object' ? config.integers.mode : (config.integers ?? 'exact');

/** Apply to owned resolved schemas, never annotation data or source documents. */
export function markIntegerMode(
  value: object,
  mode: 'number' | 'exact',
  deep = false,
  changed: (value: object) => void = () => {},
): boolean {
  let modified = false;
  const type: unknown = Reflect.get(value, 'type');
  if (type === 'integer' || (Array.isArray(type) && type.includes('integer'))) {
    // Default exact mode preserves the historical int32/native distinction.
    const previous: unknown = Reflect.get(value, 'x-sdk-integer-mode');
    if ((deep || (mode === 'number' && previous === undefined)) && previous !== mode) {
      Reflect.set(value, 'x-sdk-integer-mode', mode);
      modified = true;
    }
  }
  const visit = (child: unknown): void => {
    if (child && typeof child === 'object')
      modified = markIntegerMode(child, mode, true, changed) || modified;
  };
  if (deep) {
    for (const key of ['properties', 'patternProperties', 'dependentSchemas']) {
      const map: unknown = Reflect.get(value, key);
      if (map && typeof map === 'object') Object.values(map).forEach(visit);
    }
    for (const key of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) {
      const list: unknown = Reflect.get(value, key);
      if (Array.isArray(list)) list.forEach(visit);
    }
    for (const key of [
      'items',
      'additionalProperties',
      'propertyNames',
      'not',
      'contains',
      'if',
      'then',
      'else',
    ])
      visit(Reflect.get(value, key));
  }
  if (modified) changed(value);
  return modified;
}

export function integerDocumentation(config: Pick<Config, 'integers'> = {}, node: boolean): string {
  if (integerMode(config) !== 'number')
    return (
      'int64/uint64 values are integer strings. ' +
      (node
        ? 'Their TypeScript type is `${bigint}`; inputs also accept bigint.'
        : 'Integer inputs use decimal digits with an optional minus sign, never fractional or exponent spellings.')
    );
  const exact = typeof config.integers === 'object' ? (config.integers.exactComponents ?? []) : [];
  return (
    `Integer counters such as version use ${node ? 'number' : 'int'} with a safe range of ±(2^53 − 1); values outside that range fail without rounding. ` +
    (exact.length
      ? `Integers inside exact components (${exact.join(', ')}) remain exact strings${node ? ' (TypeScript `${bigint}`; inputs also accept bigint)' : ''}. Money amounts stay exact strings when their component is listed. Sum money amounts with ${node ? '`BigInt(a.amount) + BigInt(b.amount)`' : '`bcadd($a->getAmount(), $b->getAmount(), 0)` (requires ext-bcmath)'}.`
      : '')
  );
}

/** Narrowed inline copies of a configured object retain its integer representation.
 * Bounds, enum narrowing, annotations and nullability do not change its field kinds. */
export function sameObjectShape(value: unknown, template: unknown): boolean {
  const record = (item: unknown): item is Record<string, unknown> =>
    !!item && typeof item === 'object' && !Array.isArray(item);
  const types = (item: Record<string, unknown>): string =>
    (Array.isArray(item.type) ? item.type : [item.type ?? (item.properties ? 'object' : '')])
      .filter((type) => type !== 'null')
      .sort()
      .join('|');
  const same = (left: unknown, right: unknown, depth = 0): boolean => {
    if (!record(left) || !record(right) || depth > 64) return false;
    if (!types(left) || types(left) !== types(right)) return false;
    if (left.format !== right.format) return false;
    const leftProperties = left.properties,
      rightProperties = right.properties;
    if (record(leftProperties) && record(rightProperties)) {
      const fields = Object.keys(leftProperties);
      return (
        fields.length === Object.keys(rightProperties).length &&
        fields.every((key) => same(leftProperties[key], rightProperties[key], depth + 1))
      );
    }
    if (left.items || right.items) return same(left.items, right.items, depth + 1);
    return !left.properties && !right.properties;
  };
  return (
    record(value) &&
    record(template) &&
    record(value.properties) &&
    record(template.properties) &&
    same(value, template)
  );
}
