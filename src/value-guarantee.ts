/** Observable returned-value guarantees, independent of schema syntax and renderers. */
export type ValueGuarantee =
  | { kind: 'unknown' }
  | { kind: 'unresolved'; reason: string }
  | { kind: 'null' | 'string' | 'number' | 'boolean' | 'binary' | 'stream' }
  | { kind: 'array'; element: ValueGuarantee }
  | {
      kind: 'object';
      fields: Record<string, ValueGuarantee>;
      required: readonly string[];
      extra: ValueGuarantee;
    };

export type Inclusion =
  | { result: 'compatible' }
  | { result: 'incompatible'; path: string; reason: string }
  | { result: 'unresolved'; path: string; reason: string };

/** Every new returned value must preserve the old consumer's guarantees. */
export function valuesFit(previous: ValueGuarantee, next: ValueGuarantee, path: string): Inclusion {
  if (previous.kind === 'unknown') return { result: 'compatible' };
  if (previous.kind === 'unresolved' || next.kind === 'unresolved')
    return {
      result: 'unresolved',
      path,
      reason: 'Returned-value inclusion is outside the supported proof domain.',
    };
  if (previous.kind !== next.kind)
    return {
      result: 'incompatible',
      path,
      reason: `Returned ${next.kind} values do not preserve the previous ${previous.kind} guarantee.`,
    };
  if (previous.kind === 'array' && next.kind === 'array')
    return valuesFit(previous.element, next.element, path + '[]');
  if (previous.kind === 'array') throw new Error('Inconsistent array comparison');
  if (previous.kind !== 'object') {
    switch (previous.kind) {
      case 'null':
      case 'string':
      case 'number':
      case 'boolean':
      case 'binary':
      case 'stream':
        return { result: 'compatible' };
      default:
        return invalidGuarantee(previous);
    }
  }
  if (next.kind !== 'object') throw new Error('Inconsistent object comparison');
  const missing = previous.required.find((key) => !next.required.includes(key));
  if (missing !== undefined)
    return {
      result: 'incompatible',
      path: path + '.' + missing,
      reason: 'A previously guaranteed field can be absent.',
    };
  let uncertain: Inclusion | undefined;
  const keys = new Set([
    ...Object.keys(previous.fields),
    ...Object.keys(next.fields),
    ...previous.required,
    ...next.required,
  ]);
  const field = (value: typeof previous, key: string) =>
    Object.hasOwn(value.fields, key) ? (value.fields[key] ?? value.extra) : value.extra;
  for (const key of keys) {
    const result = valuesFit(field(previous, key), field(next, key), path + '.' + key);
    if (result.result === 'incompatible') return result;
    if (result.result === 'unresolved') uncertain = result;
  }
  const extra = valuesFit(previous.extra, next.extra, path + '.*');
  return extra.result === 'incompatible' ? extra : (uncertain ?? extra);
}

export function combineInclusion(publicType: Inclusion, runtime: Inclusion): Inclusion {
  if (publicType.result === 'incompatible') return publicType;
  if (runtime.result === 'incompatible') return runtime;
  if (publicType.result === 'unresolved') return publicType;
  return runtime;
}

function invalidGuarantee(value: never): never {
  throw new Error('Unknown value guarantee: ' + JSON.stringify(value));
}
