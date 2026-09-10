import { stable } from './canonical.js';
import { ANY_CODEC, type CodecPlan } from './codec-plan.js';
import type { CompiledRuntimePlan } from './runtime-plan.js';

/** Intern complete instructions after routing and declaration decisions have been made. */
export function codecSharing(original: Record<string, CodecPlan>) {
  const definitions: Record<string, CodecPlan> = {};
  const names = new Map(Object.entries(original).map(([name, codec]) => [stable(codec), name]));
  const signatures = new WeakMap<object, string>();
  let sequence = 0;
  const signature = (codec: CodecPlan): string => {
    let result = signatures.get(codec);
    if (result === undefined) {
      result = stable(codec);
      signatures.set(codec, result);
    }
    return result;
  };
  const compact = (codec: CodecPlan, root = false): CodecPlan => {
    if (codec.reference) return codec;
    const key = signature(codec);
    if (!root && key.length >= 768) {
      let name = names.get(key);
      if (!name) {
        do {
          name = 'SharedCodec' + sequence++;
        } while (Object.hasOwn(original, name));
        names.set(key, name);
      }
      if (!Object.hasOwn(definitions, name)) definitions[name] = compact(codec, true);
      return {
        ...ANY_CODEC,
        reference: name,
        modelObjectInput: codec.modelObjectInput,
        ...(codec.objectOnlyAlternative ? { objectOnlyAlternative: true } : {}),
        rejectInput: codec.rejectInput,
        hiddenOutput: codec.hiddenOutput,
        sensitive: codec.sensitive,
        ...(codec.tagValues ? { tagValues: codec.tagValues } : {}),
        ...(codec.constraints !== undefined ? { constraints: codec.constraints } : {}),
      };
    }
    return {
      ...codec,
      ...(codec.fields
        ? {
            fields: Object.fromEntries(
              Object.entries(codec.fields).map(([key, value]) => [key, compact(value)]),
            ),
          }
        : {}),
      ...(codec.element ? { element: compact(codec.element) } : {}),
      ...(codec.extra && typeof codec.extra === 'object' ? { extra: compact(codec.extra) } : {}),
      ...(codec.every ? { every: codec.every.map((value) => compact(value)) } : {}),
      ...(codec.some ? { some: codec.some.map((value) => compact(value)) } : {}),
      ...(codec.exactlyOne ? { exactlyOne: codec.exactlyOne.map((value) => compact(value)) } : {}),
      ...(codec.exclude ? { exclude: compact(codec.exclude) } : {}),
      ...(codec.includes ? { includes: compact(codec.includes) } : {}),
      ...(codec.when
        ? {
            when: {
              test: compact(codec.when.test),
              ...(codec.when.then ? { then: compact(codec.when.then) } : {}),
              ...(codec.when.else ? { else: compact(codec.when.else) } : {}),
            },
          }
        : {}),
    };
  };
  for (const [name, codec] of Object.entries(original)) definitions[name] = compact(codec, true);
  const runtime = (plan: CompiledRuntimePlan): void => {
    plan.definitions = definitions;
    for (const operation of plan.operations) {
      for (const parameter of operation.parameters) parameter.codec = compact(parameter.codec);
      if (operation.body) operation.body = compact(operation.body);
      for (const response of Object.values(operation.responses))
        if (response.codec) response.codec = compact(response.codec);
      if (operation.streamEventCodecs)
        operation.streamEventCodecs = Object.fromEntries(
          Object.entries(operation.streamEventCodecs).map(([name, codec]) => [
            name,
            compact(codec),
          ]),
        );
    }
    for (const incoming of plan.incoming ?? []) incoming.codec = compact(incoming.codec);
    if (plan.webhook)
      plan.webhook.events = Object.fromEntries(
        Object.entries(plan.webhook.events).map(([name, codec]) => [name, compact(codec)]),
      );
  };
  return { compact: (codec: CodecPlan) => compact(codec), runtime };
}
