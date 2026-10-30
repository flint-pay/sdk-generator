import type { Contract, Operation, Schema } from './contract.js';
import { stable } from './canonical.js';
import { successStatus } from './runtime-plan.js';

const pascal = (value: string) => value[0]!.toUpperCase() + value.slice(1);
const success = (status: string) => successStatus(status) || status === 'default';

/** Source component identities survive structural codec sharing. */
export function responseComponent(
  schema: Schema | undefined,
  models: readonly string[],
): string | undefined {
  const name = schema?.['x-sdk-type-name'];
  return name && models.includes(name) ? name : undefined;
}

export function operationResponseName(op: Operation, status: string): string {
  const schemas = new Set(
    Object.entries(op.responses)
      .filter(([key, response]) => success(key) && response.schema)
      .map(([, response]) => stable(response.schema)),
  );
  return (
    pascal(op.resource) + pascal(op.method) + 'Response' + (schemas.size > 1 ? pascal(status) : '')
  );
}

/** Declared components own their names; inline operation classes get deterministic fallbacks. */
export function responseTypeNames(
  c: Contract,
  models: readonly string[],
): {
  names: Map<string, string>;
  aliases: Map<string, string>;
  renames: { operation: string; status: string; from: string; to: string }[];
} {
  const occupied = new Set(
    models.flatMap((name) => [name, name + 'Input']).map((name) => name.toLowerCase()),
  );
  const names = new Map<string, string>();
  const aliases = new Map<string, string>();
  const renames: { operation: string; status: string; from: string; to: string }[] = [];
  const allocated = new Map<string, string>();
  // Reserve the ordinary operation names before choosing any fallbacks.
  for (const op of c.operations) {
    occupied.add((pascal(op.resource) + pascal(op.method) + 'Response').toLowerCase());
    for (const [status, response] of Object.entries(op.responses))
      if (success(status) && !responseComponent(response.schema, models))
        occupied.add(operationResponseName(op, status).toLowerCase());
  }
  const allocate = (base: string): string => {
    const previous = allocated.get(base);
    if (previous) return previous;
    let name = base;
    if (
      models.some((model) =>
        [model, model + 'Input'].some((value) => value.toLowerCase() === base.toLowerCase()),
      )
    ) {
      const suffix = base.replace(/Response$/, '') + 'OperationResponse';
      name = suffix;
      let index = 2;
      while (occupied.has(name.toLowerCase())) name = suffix + index++;
      occupied.add(name.toLowerCase());
    }
    allocated.set(base, name);
    return name;
  };
  for (const op of [...c.operations].sort((a, b) => a.id.localeCompare(b.id))) {
    const alias = pascal(op.resource) + pascal(op.method) + 'Response';
    aliases.set(op.id, allocate(alias));
    for (const [status, response] of Object.entries(op.responses).sort()) {
      if (!success(status)) continue;
      const component = responseComponent(response.schema, models);
      const base = operationResponseName(op, status);
      const name = component ?? allocate(base);
      names.set(op.id + '/' + status, name);
      if (!component && name !== base)
        renames.push({ operation: op.id, status, from: base, to: name });
    }
  }
  return { names, aliases, renames };
}
