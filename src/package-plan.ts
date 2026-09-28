import type { CodecPlan } from './codec-plan.js';
import type { CompiledRuntimePlan } from './runtime-plan.js';

/** Runtime data dependencies, independent of either target's file layout. */
export function codecReferences(value: unknown): string[] {
  const names = new Set<string>();
  const visit = (v: unknown): void => {
    if (!v || typeof v !== 'object') return;
    if (
      'value' in v &&
      'nullable' in v &&
      typeof v.nullable === 'boolean' &&
      v.value &&
      typeof v.value === 'object' &&
      'kind' in v.value
    ) {
      if ('reference' in v && typeof v.reference === 'string') names.add(v.reference);
      // Literal/enum values and documentation are data, never codec edges.
      for (const [key, child] of Object.entries(v))
        if (
          [
            'fields',
            'element',
            'extra',
            'every',
            'some',
            'exactlyOne',
            'exclude',
            'includes',
            'when',
            'definitions',
          ].includes(key)
        )
          visit(child);
      return;
    }
    for (const child of Object.values(v)) visit(child);
  };
  visit(value);
  return [...names].sort();
}
export function codecClosure(
  value: unknown,
  definitions: Readonly<Record<string, CodecPlan>>,
): string[] {
  const seen = new Set<string>();
  const visit = (name: string): void => {
    if (seen.has(name)) return;
    const codec = Object.hasOwn(definitions, name) ? definitions[name] : undefined;
    if (!codec) throw new Error('Missing compiled codec ' + name);
    seen.add(name);
    for (const dependency of codecReferences(codec)) visit(dependency);
  };
  for (const name of codecReferences(value)) visit(name);
  return [...seen].sort();
}
export function packagePlan(runtime: CompiledRuntimePlan) {
  const { operations, definitions = {}, webhook, incoming: _incoming, ...settings } = runtime;
  const resources = Object.fromEntries(
    [...new Set(operations.map((op) => op.resource))].sort().map((name) => {
      const selected = operations
        .filter((op) => op.resource === name)
        .map(
          ({
            example: _example,
            aliases: _aliases,
            deprecated: _deprecated,
            description: _description,
            ...op
          }) => ({ ...op, description: '' }),
        );
      return [name, { operations: selected, dependencies: codecClosure(selected, definitions) }];
    }),
  );
  return {
    settings: { ...settings, operations: [] },
    compatibility: {
      definitions: Object.keys(definitions),
      includeDefinitions: runtime.definitions !== undefined,
      ...(runtime.incoming ? { incoming: runtime.incoming } : {}),
      operations: Object.fromEntries(
        operations.map((op) => [
          op.id,
          {
            description: op.description,
            ...(op.example === undefined ? {} : { example: op.example }),
            ...(op.aliases === undefined ? {} : { aliases: op.aliases }),
            ...(op.deprecated === undefined ? {} : { deprecated: op.deprecated }),
          },
        ]),
      ),
    },
    definitions,
    resources,
    ...(webhook ? { webhook: { webhook, dependencies: codecClosure(webhook, definitions) } } : {}),
  };
}
