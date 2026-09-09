import type { Schema } from './contract.js';
import { stable } from './canonical.js';
import { compileSchemaPolicy, UNCONSTRAINED_POLICY, type SchemaPolicy } from './schema-policy.js';

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
  return comparePolicies(
    compileSchemaPolicy(before, direction),
    compileSchemaPolicy(after, direction),
    subject,
    direction,
  );
}

export function comparePolicies(
  before: SchemaPolicy,
  after: SchemaPolicy,
  subject: string,
  direction: 'input' | 'response',
): Compatibility[] {
  if (stable(before) === stable(after)) return [];
  const changes: Compatibility[] = [];
  const add = (severity: Compatibility['severity'], message: string) =>
    changes.push({ severity, subject, message });
  if (before.reference !== after.reference)
    add(
      'review',
      'Recursive model target changed; review nested input and response compatibility.',
    );
  const oldTypes = before.kinds;
  const newTypes = after.kinds;
  if (stable([...oldTypes].sort()) !== stable([...newTypes].sort())) {
    const removed = oldTypes.filter((t) => !newTypes.includes(t));
    const added = newTypes.filter((t) => !oldTypes.includes(t));
    const breaking = direction === 'input' ? removed.length > 0 : added.length > 0;
    add(
      breaking ? 'breaking' : 'additive',
      `${direction} types changed from ${oldTypes.join('|')} to ${newTypes.join('|')}. ${direction === 'input' ? 'Update supplied values to the accepted types; preserve explicit null only where allowed.' : 'Update result handling and null checks to cover the new response types.'}`,
    );
  }
  // JSON-kind widening can still change how existing SDK strings are encoded.
  // Track exact numeric encoding separately from accepted kinds and nullability.
  if (
    before.wire.format !== after.wire.format ||
    (!before.nullOnlyInput && before.wire.exact !== after.wire.exact)
  )
    add(
      'breaking',
      `Wire/value representation changed from ${before.wire.label} to ${after.wire.label}; update serialization and consumers before upgrading.`,
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
    const old = before.checks[keyword],
      next = after.checks[keyword];
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
  if (before.checks.pattern !== after.checks.pattern)
    add(
      direction === 'input' && after.checks.pattern !== undefined ? 'breaking' : 'review',
      `${direction} pattern changed; review accepted strings and provider examples.`,
    );
  if (stable(before.members) !== stable(after.members)) {
    const removed =
      before.members?.filter((v) => !after.members?.some((n) => stable(n) === stable(v))) ?? [];
    const narrowed = after.members && (!before.members || removed.length > 0);
    add(
      direction === 'input' && narrowed ? 'breaking' : 'additive',
      `${direction} enum changed; ${direction === 'input' ? 'replace removed input values with provider-supported values.' : 'retain unknown-value handling and review newly documented states; do not infer success.'}`,
    );
  }
  const oldProperties = before.fields ?? {};
  const newProperties = after.fields ?? {};
  for (const key of new Set([
    ...Object.keys(oldProperties),
    ...Object.keys(newProperties),
    ...(before.requiredKeys ?? []),
    ...(after.requiredKeys ?? []),
  ])) {
    const old = Object.hasOwn(oldProperties, key) ? oldProperties[key] : undefined;
    const next = Object.hasOwn(newProperties, key) ? newProperties[key] : undefined;
    const path = `${subject}.${key}`;
    const wasRequired = before.requiredKeys?.includes(key) ?? false;
    const required = after.requiredKeys?.includes(key) ?? false;
    if (wasRequired !== required)
      changes.push({
        severity: (direction === 'input' ? required : !required) ? 'breaking' : 'additive',
        subject: path,
        message: `${direction} field is now ${required ? 'required' : 'optional'}. ${direction === 'input' && required ? 'Supply it in existing calls.' : direction === 'response' && !required ? 'Handle absent values before accessing it.' : 'Existing consumers retain their supported states.'}`,
      });
    if (!old && !next) continue;
    if (!old || !next) {
      const breaking = !next || (direction === 'input' && (required || before.extra !== false));
      changes.push({
        severity: breaking ? 'breaking' : 'additive',
        subject: path,
        message: next
          ? `${required ? 'Required' : 'Optional'} ${direction} field added.${direction === 'input' && required ? ' Supply this field in every affected call.' : direction === 'input' && before.extra !== false ? ' This name previously accepted arbitrary additional values; update existing values to its declared type.' : ''}`
          : `${direction} field removed. ${direction === 'input' ? 'Stop sending this field; confirm the replacement operation or field with the provider.' : 'Remove reliance on this field or migrate to its documented replacement.'}`,
      });
      continue;
    }
    changes.push(...comparePolicies(old, next, path, direction));
  }
  if (before.element && after.element)
    changes.push(...comparePolicies(before.element, after.element, `${subject}[]`, direction));
  // Dictionary rules only affect values that can be objects in both versions.
  // Type changes already account for introducing or removing objects entirely.
  if (
    oldTypes.includes('object') &&
    newTypes.includes('object') &&
    stable(before.extra) !== stable(after.extra)
  ) {
    if (before.extra !== false && after.extra !== false)
      changes.push(
        ...comparePolicies(
          typeof before.extra === 'object' ? before.extra : UNCONSTRAINED_POLICY,
          typeof after.extra === 'object' ? after.extra : UNCONSTRAINED_POLICY,
          `${subject}.*`,
          direction,
        ),
      );
    else
      add(
        direction === 'input' && after.extra === false ? 'breaking' : 'review',
        'Additional-property policy changed; check custom fields and dictionary value types.',
      );
  }
  if (stable(before.variants) !== stable(after.variants)) {
    const tag = before.tag;
    if (!tag || tag !== after.tag || !before.variants || !after.variants)
      add(
        'breaking',
        'Alternative response/input shape or discriminator changed; update variant dispatch.',
      );
    else {
      const branches = (s: SchemaPolicy) =>
        new Map(
          s.variants!.flatMap((v) =>
            (v.fields?.[tag]?.members ?? []).map((k) => [stable(k), v] as const),
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
            ...comparePolicies(branch, replacement, `${subject}[${key.trim()}]`, direction),
          );
      }
      for (const key of next.keys())
        if (!old.has(key))
          add('additive', `Variant ${key.trim()} added; retain unknown-variant handling.`);
    }
  }
  if (before.annotations.sensitive !== after.annotations.sensitive)
    add('review', 'Sensitive-field policy changed; review logging and redaction before release.');
  for (const keyword of ['allOf', 'anyOf', 'not'] as const)
    if (stable(before.compositions[keyword]) !== stable(after.compositions[keyword]))
      add(
        'review',
        `${keyword} constraints changed; compare accepted field combinations and response alternatives before choosing a release version.`,
      );
  for (const keyword of ['readOnly', 'writeOnly'] as const)
    if (before.annotations[keyword] !== after.annotations[keyword])
      add(
        'breaking',
        `${keyword} direction changed; update request construction, required fields and response access.`,
      );
  if (!changes.length)
    add('review', 'Schema declarations or annotations changed; review documentation and examples.');
  return changes;
}
