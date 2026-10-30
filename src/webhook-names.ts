import type { Contract } from './contract.js';
import { Diagnostic } from './diagnostic.js';
import { webhookEventTypeName } from './naming.js';
import { isSchemaAnnotation } from './schema-annotations.js';
import { stable } from './canonical.js';

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Event-map keys own names; component names only locate the declared audience schema. */
export function webhookNames(
  document: unknown,
  configured: readonly string[],
  overrides: Record<string, string> = {},
) {
  const doc = record(document),
    schemas = record(record(doc.components).schemas);
  const resolve = (value: unknown, seen = new Set<string>()): Record<string, unknown> => {
    const schema = record(value),
      ref = schema.$ref;
    if (typeof ref !== 'string' || !ref.startsWith('#/') || seen.has(ref)) return schema;
    return {
      ...resolve(
        ref
          .slice(2)
          .split('/')
          .reduce<unknown>(
            (value, part) => record(value)[part.replace(/~1/g, '/').replace(/~0/g, '~')],
            doc,
          ),
        new Set([...seen, ref]),
      ),
      ...Object.fromEntries(Object.entries(schema).filter(([key]) => key !== '$ref')),
    };
  };
  const branches = new Map<string, { original: string; audience: string; schema: unknown }[]>();
  for (const [event, item] of Object.entries(record(doc.webhooks))) {
    const operation = Object.values(resolve(item)).find((value) => record(value).requestBody);
    const body = resolve(record(operation).requestBody);
    const rawSchema = record(record(body.content)['application/json']).schema;
    const schema = resolve(rawSchema);
    const variants = schema.oneOf ?? schema.anyOf ?? [rawSchema];
    const entries = (Array.isArray(variants) ? variants : []).flatMap((variant) => {
      const ref = record(variant).$ref;
      if (typeof ref !== 'string' || !ref.startsWith('#/components/schemas/')) return [];
      return [
        {
          original: ref.slice(21).replace(/~1/g, '/').replace(/~0/g, '~'),
          audience: String(record(variant).title ?? ''),
          schema: resolve(variant),
        },
      ];
    });
    branches.set(event, entries);
  }
  const componentNames = new Set(
    [...branches.values()].flatMap((items) => items.map((item) => item.original)),
  );
  const occupied = new Set(
    Object.keys(schemas)
      .filter((name) => !componentNames.has(name))
      .map((name) => (Object.hasOwn(overrides, name) ? overrides[name]! : name).toLowerCase())
      .concat(Object.values(overrides).map((name) => name.toLowerCase())),
  );
  const choose = (event: string): string => {
    const name = webhookEventTypeName(event, occupied);
    if (occupied.has(name.toLowerCase()))
      throw new Diagnostic(
        '/webhooks/' + event,
        `webhook event type name ${name} collides with a model`,
      );
    occupied.add(name.toLowerCase());
    return name;
  };
  const names: Record<string, string> = {},
    models: Record<string, string> = {};
  const shape = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(shape)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value)
              .filter(([key]) => !isSchemaAnnotation(key))
              .map(([key, child]) => [key, shape(child)]),
          )
        : value;
  for (const event of [...new Set([...branches.keys(), ...configured])].sort()) {
    const name = choose(event);
    names[event] = name;
    const entries = branches.get(event) ?? [];
    const different = new Set(entries.map((entry) => stable(shape(entry.schema)))).size > 1;
    for (const entry of entries) {
      if (different && !entry.audience)
        throw new Diagnostic(
          '/webhooks/' + event,
          'distinct webhook audiences require variant titles',
        );
      const variant = different ? choose(event + '_' + entry.audience) : name;
      models[entry.original] = variant;
    }
  }
  return { names, models };
}

export function eventTypeName(
  contract: Pick<Contract, 'models' | 'webhookTypeNames'>,
  event: string,
): string {
  return (
    contract.webhookTypeNames?.[event] ??
    webhookEventTypeName(
      event,
      new Set(Object.keys(contract.models).map((name) => name.toLowerCase())),
    )
  );
}
