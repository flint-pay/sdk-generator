import type { Schema, Json } from './contract.js';
import { valueInstruction, exactValue } from './codec-plan.js';

/** Resolved facts for the established input/wire/annotation release policy. */
export interface SchemaPolicy {
  kinds: string[];
  wire: { format?: string; exact: boolean; label: string };
  nullOnlyInput: boolean;
  reference?: string;
  requiredKeys: string[];
  fields: Record<string, SchemaPolicy>;
  element?: SchemaPolicy;
  extra?: boolean | SchemaPolicy;
  members?: Json[];
  checks: Pick<
    Schema,
    | 'minimum'
    | 'maximum'
    | 'exclusiveMinimum'
    | 'exclusiveMaximum'
    | 'minLength'
    | 'maxLength'
    | 'minItems'
    | 'maxItems'
    | 'pattern'
  >;
  variants?: SchemaPolicy[];
  tag?: string;
  compositions: { allOf?: SchemaPolicy[]; anyOf?: SchemaPolicy[]; not?: SchemaPolicy };
  annotations: {
    readOnly?: boolean;
    writeOnly?: boolean;
    sensitive?: unknown;
    metadata: Record<string, unknown>;
  };
}

function acceptedKinds(schema: Schema, direction: 'input' | 'response'): string[] {
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
  return types(schema);
}

export function compileSchemaPolicy(
  schema: Schema,
  direction: 'input' | 'response',
  depth = 0,
): SchemaPolicy {
  if (depth > 256) throw new Error('Schema policy exceeds nesting limit');
  const compile = (s: Schema) => compileSchemaPolicy(s, direction, depth + 1);
  const kinds = Array.isArray(schema.type) ? schema.type : [schema.type];
  const keys = [
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'minLength',
    'maxLength',
    'minItems',
    'maxItems',
    'pattern',
  ] as const;
  const known = new Set<string>([
    ...keys,
    'type',
    'format',
    'required',
    'properties',
    'items',
    'additionalProperties',
    'enum',
    'oneOf',
    'allOf',
    'anyOf',
    'not',
    'discriminator',
    'readOnly',
    'writeOnly',
    'x-sensitive',
    'x-sdk-ref',
  ]);
  return {
    kinds: acceptedKinds(schema, direction),
    wire: {
      ...(schema.format !== undefined ? { format: schema.format } : {}),
      exact: kinds.some((kind) => exactValue(valueInstruction(kind, schema.format))),
      label: String(schema.format ?? schema.type ?? 'unconstrained'),
    },
    nullOnlyInput: direction === 'input' && Boolean(schema.enum?.every((v) => v === null)),
    ...(schema['x-sdk-ref'] ? { reference: schema['x-sdk-ref'] } : {}),
    requiredKeys: [...(schema.required ?? [])],
    fields: Object.fromEntries(
      Object.entries(schema.properties ?? {}).map(([name, child]) => [name, compile(child)]),
    ),
    ...(schema.items ? { element: compile(schema.items) } : {}),
    ...(schema.additionalProperties !== undefined
      ? {
          extra:
            typeof schema.additionalProperties === 'object'
              ? compile(schema.additionalProperties)
              : schema.additionalProperties,
        }
      : {}),
    ...(schema.enum ? { members: [...schema.enum] } : {}),
    checks: Object.fromEntries(
      keys.filter((key) => schema[key] !== undefined).map((key) => [key, schema[key]]),
    ),
    ...(schema.oneOf ? { variants: schema.oneOf.map(compile) } : {}),
    ...(schema.discriminator ? { tag: schema.discriminator.propertyName } : {}),
    compositions: {
      ...(schema.allOf ? { allOf: schema.allOf.map(compile) } : {}),
      ...(schema.anyOf ? { anyOf: schema.anyOf.map(compile) } : {}),
      ...(schema.not ? { not: compile(schema.not) } : {}),
    },
    annotations: {
      ...(schema.readOnly !== undefined ? { readOnly: schema.readOnly } : {}),
      ...(schema.writeOnly !== undefined ? { writeOnly: schema.writeOnly } : {}),
      ...(schema['x-sensitive'] !== undefined ? { sensitive: schema['x-sensitive'] } : {}),
      metadata: Object.fromEntries(Object.entries(schema).filter(([key]) => !known.has(key))),
    },
  };
}

export const UNCONSTRAINED_POLICY = compileSchemaPolicy({}, 'input');
