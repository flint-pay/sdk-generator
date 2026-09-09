import type { Schema } from './contract.js';
import { compileCodec, ANY_CODEC, exactValue, wireKind, type CodecPlan } from './codec-plan.js';
import type { ValueGuarantee } from './value-guarantee.js';
import { objectDeclaration } from './target-types.js';

export interface ResponsePlan {
  publicType: ValueGuarantee;
  runtime: ValueGuarantee;
}

export function compileResponsePlan(schema: Schema): ResponsePlan {
  const codec = compileCodec(schema);
  return { publicType: publicGuarantee(schema, codec), runtime: runtimeGuarantee(codec) };
}

function publicGuarantee(schema: Schema, codec: CodecPlan): ValueGuarantee {
  const scalar = scalarGuarantee(codec);
  if (scalar) return scalar;
  if (codec.value.kind === 'array')
    return {
      kind: 'array',
      element: schema.items
        ? publicGuarantee(schema.items, codec.element ?? ANY_CODEC)
        : { kind: 'unknown' },
    };
  const declaration = objectDeclaration(schema, true);
  if (declaration.dictionary)
    return {
      kind: 'object',
      fields: {},
      required: [],
      extra: publicGuarantee(
        declaration.dictionary,
        typeof codec.extra === 'object' ? codec.extra : ANY_CODEC,
      ),
    };
  return {
    kind: 'object',
    fields: Object.fromEntries(
      declaration.fields.map(([name, child]) => [
        name,
        Object.hasOwn(schema.properties ?? {}, name)
          ? publicGuarantee(child, codec.fields?.[name] ?? ANY_CODEC)
          : { kind: 'unknown' },
      ]),
    ),
    required: declaration.required,
    extra: { kind: 'unknown' },
  };
}

function scalarGuarantee(codec: CodecPlan): ValueGuarantee | undefined {
  if (
    codec.reference ||
    codec.every ||
    codec.some ||
    codec.exactlyOne ||
    codec.exclude ||
    (codec.nullable && codec.value.kind !== 'null')
  )
    return {
      kind: 'unresolved',
      reason: 'Composition, reference, nullable union, or typeless schema.',
    };
  const kind = wireKind(codec.value);
  if (exactValue(codec.value)) return { kind: 'string' };
  switch (kind) {
    case 'string':
    case 'boolean':
    case 'null':
      return { kind };
    case 'integer':
      return { kind: 'number' };
    case 'array':
    case 'object':
      return undefined;
    default:
      return { kind: 'unresolved', reason: 'No single supported explicit type.' };
  }
}

export function runtimeGuarantee(codec: CodecPlan): ValueGuarantee {
  const scalar = scalarGuarantee(codec);
  if (scalar) return scalar;
  if (codec.value.kind === 'array')
    return {
      kind: 'array',
      element: codec.element ? runtimeGuarantee(codec.element) : { kind: 'unknown' },
    };
  return {
    kind: 'object',
    fields: Object.fromEntries(
      Object.entries(codec.fields ?? {}).map(([name, child]) => [
        name,
        child.hiddenOutput ? { kind: 'unknown' } : runtimeGuarantee(child),
      ]),
    ),
    required: codec.requiredOutput,
    extra: typeof codec.extra === 'object' ? runtimeGuarantee(codec.extra) : { kind: 'unknown' },
  };
}
