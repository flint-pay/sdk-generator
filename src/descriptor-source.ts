import { stable } from './canonical.js';
import {
  assertRuntimePlan,
  type CompiledOperation,
  type CompiledRuntimePlan,
} from './runtime-plan.js';
import { assertCodecPlan, type CodecPlan } from './codec-plan.js';
import { codecReferences } from './package-plan.js';

const ownedCodecs = new WeakSet<object>();

type Loader = () => CompiledRuntimePlan;
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function checkReferences(value: unknown, definitions: Readonly<Record<string, CodecPlan>>): void {
  for (const name of codecReferences(value))
    if (!Object.hasOwn(definitions, name)) throw new Error('Missing compiled codec ' + name);
}
/** Owns its data; callers cannot change a descriptor after validation. */
export class DescriptorSource {
  readonly settings: CompiledRuntimePlan;
  readonly #operations = new Map<string, CompiledOperation>();
  readonly #loaded = new Set<Loader>();
  #definitions: Readonly<Record<string, CodecPlan>> = Object.freeze({});
  #webhook: CompiledRuntimePlan['webhook'];
  constructor(
    settings: CompiledRuntimePlan,
    private readonly routes: Readonly<Record<string, Loader>> = {},
    private readonly loadWebhook?: Loader,
  ) {
    const owned = structuredClone(settings);
    assertRuntimePlan(owned);
    this.settings = freeze(owned);
    this.routes = Object.freeze({ ...routes });
    for (const operation of owned.operations) {
      if (this.#operations.has(operation.id))
        throw new Error('Duplicate compiled operation ' + operation.id);
      this.#operations.set(operation.id, operation);
    }
    this.#definitions = Object.freeze({ ...owned.definitions });
    this.#webhook = owned.webhook;
    checkReferences(owned, this.#definitions);
    Object.freeze(this);
  }
  #load(load: Loader): void {
    if (this.#loaded.has(load)) return;
    // Loader results may come from callers of the compatibility factory.
    const loaded = load();
    const plan = structuredClone({ ...loaded, definitions: {} });
    assertRuntimePlan(plan);
    const definitions = Object.fromEntries(
      Object.entries(loaded.definitions ?? {}).map(([name, codec]) => [name, ownCodec(codec)]),
    );
    plan.definitions = definitions;
    checkReferences(plan, definitions);
    for (const [name, codec] of Object.entries(definitions)) {
      const previous = Object.hasOwn(this.#definitions, name) ? this.#definitions[name] : undefined;
      if (previous && previous !== codec && stable(previous) !== stable(codec))
        throw new Error('Conflicting compiled codec ' + name);
    }
    const operationIds = new Set<string>();
    for (const op of plan.operations) {
      if (operationIds.has(op.id)) throw new Error('Duplicate compiled operation ' + op.id);
      if (!Object.hasOwn(this.routes, op.id) || this.routes[op.id] !== load)
        throw new Error('Unexpected compiled operation ' + op.id);
      operationIds.add(op.id);
      const previous = this.#operations.get(op.id);
      if (previous && stable(previous) !== stable(op))
        throw new Error('Conflicting compiled operation ' + op.id);
    }
    freeze(plan);
    for (const op of plan.operations) this.#operations.set(op.id, op);
    this.#definitions = Object.freeze({ ...this.#definitions, ...definitions });
    if (plan.webhook) this.#webhook = plan.webhook;
    this.#loaded.add(load);
  }
  operation(id: string): CompiledOperation | undefined {
    const loader = Object.hasOwn(this.routes, id) ? this.routes[id] : undefined;
    if (loader) this.#load(loader);
    return this.#operations.get(id);
  }
  definitions(): Readonly<Record<string, CodecPlan>> {
    return this.#definitions;
  }
  webhook(): CompiledRuntimePlan['webhook'] {
    if (this.loadWebhook) this.#load(this.loadWebhook);
    return this.#webhook;
  }
}
/** JSON is private until parsed and validated; no caller-owned identity cache. */
export function lazyCodec(text: string): () => CodecPlan {
  let value: CodecPlan | undefined;
  return () => {
    if (!value) {
      const parsed: unknown = JSON.parse(text);
      assertCodecPlan(parsed);
      value = freeze(parsed);
      ownedCodecs.add(value);
    }
    return value;
  };
}
export function preparedCodec(codec: CodecPlan, definitions: Record<string, CodecPlan>): CodecPlan {
  const owned = ownCodec(codec);
  const copies = Object.fromEntries(
    Object.entries(definitions).map(([name, value]) => [name, ownCodec(value)]),
  );
  checkReferences({ codec: owned, definitions: copies }, copies);
  return freeze({ ...owned, definitions: copies });
}

function ownCodec(codec: CodecPlan): CodecPlan {
  if (ownedCodecs.has(codec)) return codec;
  const owned = structuredClone(codec);
  assertCodecPlan(owned);
  freeze(owned);
  ownedCodecs.add(owned);
  return owned;
}
