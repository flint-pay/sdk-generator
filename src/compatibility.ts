import { stable, type Schema } from './contract.js';

export interface Compatibility {
  severity: 'breaking' | 'additive' | 'review';
  subject: string;
  message: string;
}

/** Compare accepted caller inputs and promised response types in opposite directions. */
export function compareSchemas(
  before: Schema,
  after: Schema,
  subject: string,
  direction: 'input' | 'response',
): Compatibility[] {
  if (stable(before) === stable(after)) return [];
  const changes: Compatibility[] = [];
  const add = (severity: Compatibility['severity'], message: string) =>
    changes.push({ severity, subject, message });
  if (before['x-sdk-ref'] !== after['x-sdk-ref'])
    add(
      'review',
      'Recursive model target changed; review nested input and response compatibility.',
    );
  const unconstrainedTypes = ['null', 'boolean', 'object', 'array', 'string', 'number', 'integer'];
  const types = (s: Schema): string[] => {
    const declared = s.type === undefined ? undefined : Array.isArray(s.type) ? s.type : [s.type];
    // Inputs enforce enums even without type. Responses tolerate unknown enum
    // values, so their public type guarantees still need the declared type.
    if (direction === 'input' && s.enum) {
      const kinds: string[] = [
        ...new Set(
          s.enum.map((value) =>
            value === null ? 'null' : typeof value === 'number' ? 'integer' : typeof value,
          ),
        ),
      ];
      return declared
        ? declared.filter(
            (type) => kinds.includes(type) || (type === 'number' && kinds.includes('integer')),
          )
        : kinds;
    }
    if (declared) return declared;
    if (direction === 'input') {
      let accepted = unconstrainedTypes;
      for (const branch of s.allOf ?? []) {
        const allowed = types(branch);
        accepted = accepted.filter(
          (type) => allowed.includes(type) || (type === 'integer' && allowed.includes('number')),
        );
      }
      for (const branches of [s.anyOf, s.oneOf]) {
        if (!branches) continue;
        const allowed = new Set(branches.flatMap(types));
        accepted = accepted.filter(
          (type) => allowed.has(type) || (type === 'integer' && allowed.has('number')),
        );
      }
      // Activating a numeric type can change exact-string encoding and bound
      // checks in the enclosing schema. Keep those changes conservative.
      if (!accepted.includes('integer') && !accepted.includes('number')) return accepted;
    }
    // An absent, unconstrained type accepts every JSON kind, not an empty set.
    return unconstrainedTypes;
  };
  const oldTypes = types(before);
  const newTypes = types(after);
  if (stable([...oldTypes].sort()) !== stable([...newTypes].sort())) {
    const removed = oldTypes.filter((t) => !newTypes.includes(t));
    const added = newTypes.filter((t) => !oldTypes.includes(t));
    const breaking = direction === 'input' ? removed.length > 0 : added.length > 0;
    add(
      breaking ? 'breaking' : 'additive',
      `${direction} types changed from ${oldTypes.join('|')} to ${newTypes.join('|')}. ${direction === 'input' ? 'Update supplied values to the accepted types; preserve explicit null only where allowed.' : 'Update result handling and null checks to cover the new response types.'}`,
    );
  }
  if (before.format !== after.format)
    add(
      'breaking',
      `Wire/value representation changed from ${before.format ?? before.type} to ${after.format ?? after.type}; update serialization and consumers before upgrading.`,
    );
  for (const keyword of [
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'minLength',
    'maxLength',
    'minItems',
    'maxItems',
  ] as const) {
    const old = before[keyword],
      next = after[keyword];
    if (old === next) continue;
    const lower = ['minimum', 'exclusiveMinimum', 'minLength', 'minItems'].includes(keyword);
    const narrowed = next !== undefined && (old === undefined || (lower ? next > old : next < old));
    add(
      direction === 'input' && narrowed
        ? 'breaking'
        : direction === 'input'
          ? 'additive'
          : 'review',
      `${direction} ${keyword} changed from ${old ?? 'unbounded'} to ${next ?? 'unbounded'}; review validation and supplied values.`,
    );
  }
  if (before.pattern !== after.pattern)
    add(
      direction === 'input' && after.pattern !== undefined ? 'breaking' : 'review',
      `${direction} pattern changed; review accepted strings and provider examples.`,
    );
  if (stable(before.enum) !== stable(after.enum)) {
    const removed =
      before.enum?.filter((v) => !after.enum?.some((n) => stable(n) === stable(v))) ?? [];
    const narrowed = after.enum && (!before.enum || removed.length > 0);
    add(
      direction === 'input' && narrowed ? 'breaking' : 'additive',
      `${direction} enum changed; ${direction === 'input' ? 'replace removed input values with provider-supported values.' : 'retain unknown-value handling and review newly documented states; do not infer success.'}`,
    );
  }
  const oldProperties = before.properties ?? {};
  const newProperties = after.properties ?? {};
  for (const key of new Set([
    ...Object.keys(oldProperties),
    ...Object.keys(newProperties),
    ...(before.required ?? []),
    ...(after.required ?? []),
  ])) {
    const old = Object.hasOwn(oldProperties, key) ? oldProperties[key] : undefined;
    const next = Object.hasOwn(newProperties, key) ? newProperties[key] : undefined;
    const path = `${subject}.${key}`;
    const wasRequired = before.required?.includes(key) ?? false;
    const required = after.required?.includes(key) ?? false;
    if (wasRequired !== required)
      changes.push({
        severity: (direction === 'input' ? required : !required) ? 'breaking' : 'additive',
        subject: path,
        message: `${direction} field is now ${required ? 'required' : 'optional'}. ${direction === 'input' && required ? 'Supply it in existing calls.' : direction === 'response' && !required ? 'Handle absent values before accessing it.' : 'Existing consumers retain their supported states.'}`,
      });
    if (!old && !next) continue;
    if (!old || !next) {
      const breaking =
        !next || (direction === 'input' && (required || before.additionalProperties !== false));
      changes.push({
        severity: breaking ? 'breaking' : 'additive',
        subject: path,
        message: next
          ? `${required ? 'Required' : 'Optional'} ${direction} field added.${direction === 'input' && required ? ' Supply this field in every affected call.' : direction === 'input' && before.additionalProperties !== false ? ' This name previously accepted arbitrary additional values; update existing values to its declared type.' : ''}`
          : `${direction} field removed. ${direction === 'input' ? 'Stop sending this field; confirm the replacement operation or field with the provider.' : 'Remove reliance on this field or migrate to its documented replacement.'}`,
      });
      continue;
    }
    changes.push(...compareSchemas(old, next, path, direction));
  }
  if (before.items && after.items)
    changes.push(...compareSchemas(before.items, after.items, `${subject}[]`, direction));
  if (stable(before.additionalProperties) !== stable(after.additionalProperties)) {
    if (
      typeof before.additionalProperties === 'object' &&
      typeof after.additionalProperties === 'object'
    )
      changes.push(
        ...compareSchemas(
          before.additionalProperties,
          after.additionalProperties,
          `${subject}.*`,
          direction,
        ),
      );
    else
      add(
        direction === 'input' && after.additionalProperties === false ? 'breaking' : 'review',
        'Additional-property policy changed; check custom fields and dictionary value types.',
      );
  }
  if (stable(before.oneOf) !== stable(after.oneOf)) {
    const tag = before.discriminator?.propertyName;
    if (!tag || tag !== after.discriminator?.propertyName || !before.oneOf || !after.oneOf)
      add(
        'breaking',
        'Alternative response/input shape or discriminator changed; update variant dispatch.',
      );
    else {
      const branches = (s: Schema) =>
        new Map(
          s.oneOf!.flatMap((v) =>
            (v.properties?.[tag]?.enum ?? []).map((k) => [stable(k), v] as const),
          ),
        );
      const old = branches(before),
        next = branches(after);
      for (const [key, branch] of old) {
        const replacement = next.get(key);
        if (!replacement)
          add(
            'breaking',
            `Variant ${key.trim()} removed; migrate callers that send or depend on this variant.`,
          );
        else
          changes.push(
            ...compareSchemas(branch, replacement, `${subject}[${key.trim()}]`, direction),
          );
      }
      for (const key of next.keys())
        if (!old.has(key))
          add('additive', `Variant ${key.trim()} added; retain unknown-variant handling.`);
    }
  }
  if (before['x-sensitive'] !== after['x-sensitive'])
    add('review', 'Sensitive-field policy changed; review logging and redaction before release.');
  for (const keyword of ['allOf', 'anyOf', 'not'] as const)
    if (stable(before[keyword]) !== stable(after[keyword]))
      add(
        'review',
        `${keyword} constraints changed; compare accepted field combinations and response alternatives before choosing a release version.`,
      );
  for (const keyword of ['readOnly', 'writeOnly'] as const)
    if (before[keyword] !== after[keyword])
      add(
        'breaking',
        `${keyword} direction changed; update request construction, required fields and response access.`,
      );
  if (!changes.length)
    add('review', 'Schema declarations or annotations changed; review documentation and examples.');
  return changes;
}
