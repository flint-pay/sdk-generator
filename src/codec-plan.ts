import type { Json, Schema } from './contract.js';

/** Data-only execution contract. This module is also bundled for dynamic schema APIs. */
export type ValueInstruction =
  | { kind: 'dynamic' }
  | { kind: 'null' }
  // Existing Node/PHP behavior differs for null-only (or empty) type arrays.
  | { kind: 'null-array' }
  | { kind: 'boolean' }
  | { kind: 'string' }
  | { kind: 'safe-integer' }
  | { kind: 'exact-integer' }
  | { kind: 'decimal' }
  | { kind: 'object' }
  | { kind: 'array' }
  // Public schema helpers historically accept unknown textual type annotations.
  | { kind: 'opaque'; label: string };

export interface CodecPlan {
  readonly value: ValueInstruction;
  readonly nullable: boolean;
  /** Unmatched alternatives require objects only for the legacy literal type: 'object' form. */
  readonly objectOnlyAlternative?: boolean;
  readonly modelObjectInput: boolean;
  readonly requiredInput: readonly string[];
  readonly requiredOutput: readonly string[];
  readonly rejectInput: boolean;
  readonly hiddenOutput: boolean;
  readonly sensitive: boolean;
  readonly fields?: Readonly<Record<string, CodecPlan>>;
  readonly element?: CodecPlan;
  readonly extra?: boolean | CodecPlan;
  readonly members?: readonly Json[];
  /** JSON text preserves object/list identity through associative PHP plan loading. */
  readonly literal?: string;
  readonly range?: readonly [string, string];
  readonly checks: Readonly<
    Pick<
      Schema,
      | 'minimum'
      | 'maximum'
      | 'exclusiveMinimum'
      | 'exclusiveMaximum'
      | 'multipleOf'
      | 'minLength'
      | 'maxLength'
      | 'minItems'
      | 'maxItems'
      | 'minProperties'
      | 'maxProperties'
      | 'uniqueItems'
      | 'pattern'
    >
  >;
  readonly numberInput?: 'explicit';
  readonly phpPattern?: string;
  readonly constraints?: boolean;
  readonly every?: readonly CodecPlan[];
  readonly some?: readonly CodecPlan[];
  readonly exactlyOne?: readonly CodecPlan[];
  readonly exclude?: CodecPlan;
  readonly includes?: CodecPlan;
  readonly when?: {
    readonly test: CodecPlan;
    readonly then?: CodecPlan;
    readonly else?: CodecPlan;
  };
  readonly tag?: string;
  readonly tagValues?: readonly string[];
  readonly reference?: string;
  readonly definitions?: Readonly<Record<string, CodecPlan>>;
}

export const CODEC_FORMAT = 1;
// Numeric constraints share the JSON value interpretation across compositions.
export const CODEC_SEMANTICS = '3';

export function valueInstruction(type: string | undefined, format?: string): ValueInstruction {
  switch (type) {
    case undefined:
      return { kind: 'dynamic' };
    case 'null':
    case 'boolean':
    case 'string':
    case 'object':
    case 'array':
      return { kind: type };
    case 'integer':
      return { kind: format === 'int64' || format === 'uint64' ? 'exact-integer' : 'safe-integer' };
    case 'number':
      return { kind: 'decimal' };
    default:
      return { kind: 'opaque', label: type };
  }
}

export function wireKind(value: ValueInstruction): string | undefined {
  switch (value.kind) {
    case 'dynamic':
    case 'null-array':
      return undefined;
    case 'null':
    case 'boolean':
    case 'string':
    case 'object':
    case 'array':
      return value.kind;
    case 'safe-integer':
    case 'exact-integer':
      return 'integer';
    case 'decimal':
      return 'number';
    case 'opaque':
      return value.label;
    default:
      return invalidInstruction(value);
  }
}

function invalidInstruction(value: never): never {
  throw new Error('Unknown codec instruction: ' + JSON.stringify(value));
}

export function exactValue(value: ValueInstruction): boolean {
  return value.kind === 'exact-integer' || value.kind === 'decimal';
}

const ranges: Readonly<Record<string, readonly [string, string]>> = {
  int32: ['-2147483648', '2147483647'],
  uint32: ['0', '4294967295'],
  int64: ['-9223372036854775808', '9223372036854775807'],
  uint64: ['0', '18446744073709551615'],
};

/** Pure direction derivation, shared with public-type compilation. */
export function directionalSchema(schema: Schema, response: boolean): Schema {
  const omitted = new Set<string>();
  const collect = (s: Schema) => {
    for (const [key, child] of Object.entries(s.properties ?? {}))
      if (response ? child.writeOnly : child.readOnly) omitted.add(key);
    for (const branch of s.allOf ?? []) collect(branch);
  };
  collect(schema);
  if (!omitted.size) return schema;
  const project = (s: Schema): Schema => ({
    ...s,
    ...(s.required ? { required: s.required.filter((key) => !omitted.has(key)) } : {}),
    ...(s.allOf ? { allOf: s.allOf.map(project) } : {}),
    ...(s.anyOf ? { anyOf: s.anyOf.map(project) } : {}),
    ...(s.oneOf ? { oneOf: s.oneOf.map(project) } : {}),
  });
  return project(schema);
}

/** Compile both direction policies without discarding facts hidden by a public type. */
export function compileCodec(schema: Schema): CodecPlan {
  return compileNode(schema, schema, 0);
}

/** Proven tag routing only. A discriminator hint never creates schema constraints. */
export function discriminatorBindings(schema: Schema): Record<string, number> | undefined {
  const property = schema.discriminator?.propertyName;
  if (!property || !schema.oneOf) return undefined;
  const conjuncts = (s: Schema): Schema[] => [s, ...(s.allOf ?? []).flatMap(conjuncts)];
  const { oneOf, ...siblings } = schema;
  const result: Record<string, number> = Object.create(null);
  for (const [index, branch] of oneOf.entries()) {
    const parts = [...conjuncts(siblings), ...conjuncts(branch)];
    if (
      !parts.some((s) => s.type === 'object') ||
      !parts.some((s) => s.required?.includes(property))
    )
      return undefined;
    const fields = parts.flatMap((s) =>
      s.properties?.[property] ? conjuncts(s.properties[property]) : [],
    );
    const sets = fields.flatMap((s) =>
      Object.hasOwn(s, 'const') ? [[s.const]] : s.enum ? [s.enum] : [],
    );
    if (!sets.length) return undefined;
    const tags = sets[0]?.filter((value) => sets.every((values) => values.includes(value)));
    if (!tags?.length || tags.some((value) => typeof value !== 'string')) return undefined;
    for (const tag of tags) {
      if (typeof tag !== 'string' || Object.hasOwn(result, tag)) return undefined;
      result[tag] = index;
    }
  }
  return result;
}

function compileNode(input: Schema, output: Schema, depth: number): CodecPlan {
  if (depth > 256) throw new Error('Schema exceeds the supported compilation depth (256)');
  const request = directionalSchema(input, false);
  const conjunctiveObject = (s: Schema): boolean =>
    s.type === 'object' || Boolean(s.allOf?.some(conjunctiveObject));
  const response = directionalSchema(output, true);
  const kinds = Array.isArray(input.type) ? input.type : [input.type];
  const kind = kinds.find((v) => v !== 'null') ?? (input.type === undefined ? undefined : 'null');
  const checks = Object.fromEntries(
    (
      [
        'minimum',
        'maximum',
        'exclusiveMinimum',
        'exclusiveMaximum',
        'multipleOf',
        'minLength',
        'maxLength',
        'minItems',
        'maxItems',
        'minProperties',
        'maxProperties',
        'uniqueItems',
        'pattern',
      ] as const
    )
      .filter((key) => input[key] !== undefined)
      .map((key) => [key, input[key]]),
  );
  const range = input.format ? ranges[input.format] : undefined;
  const bindings = discriminatorBindings(input);
  const branches = (a: readonly Schema[], b: readonly Schema[]) =>
    a.map((child, index) => compileNode(child, b[index] ?? child, depth + 1));
  return {
    ...(input['x-sdk-number-input'] === 'explicit' ? { numberInput: 'explicit' as const } : {}),
    value:
      Array.isArray(input.type) && !input.type.some((type) => type !== 'null')
        ? { kind: 'null-array' }
        : valueInstruction(kind, input.format),
    nullable: input.type === undefined || kinds.includes('null'),
    ...(input.type === 'object' ? { objectOnlyAlternative: true } : {}),
    modelObjectInput:
      conjunctiveObject(input) ||
      kinds.includes('object') ||
      (input.type === undefined &&
        (input.properties !== undefined || input.required !== undefined)),
    requiredInput: (request.required ?? []).filter((key) => !request.properties?.[key]?.readOnly),
    requiredOutput: (response.required ?? []).filter(
      (key) => !response.properties?.[key]?.writeOnly,
    ),
    rejectInput: Boolean(input.readOnly),
    hiddenOutput: Boolean(input.writeOnly),
    sensitive: Boolean(input['x-sensitive'] || input.writeOnly),
    checks,
    ...(range ? { range } : {}),
    ...(input.properties
      ? {
          fields: Object.fromEntries(
            Object.entries(input.properties).map(([name, child]) => [
              name,
              compileNode(child, child, depth + 1),
            ]),
          ),
        }
      : {}),
    ...(input.items ? { element: compileNode(input.items, input.items, depth + 1) } : {}),
    ...(input.additionalProperties !== undefined
      ? {
          extra:
            typeof input.additionalProperties === 'object'
              ? compileNode(input.additionalProperties, input.additionalProperties, depth + 1)
              : input.additionalProperties,
        }
      : {}),
    ...(input.enum ? { members: [...input.enum] } : {}),
    ...(input.contains ? { includes: compileNode(input.contains, input.contains, depth + 1) } : {}),
    ...(input.if
      ? {
          when: {
            test: compileNode(input.if, input.if, depth + 1),
            ...(input.then ? { then: compileNode(input.then, input.then, depth + 1) } : {}),
            ...(input.else ? { else: compileNode(input.else, input.else, depth + 1) } : {}),
          },
        }
      : {}),
    ...(Object.hasOwn(input, 'const') ? { literal: JSON.stringify(input.const) } : {}),
    ...(input.pattern !== undefined
      ? {
          phpPattern:
            input['x-sdk-pattern-php'] ?? '~' + input.pattern.replaceAll('~', '\\~') + '~uD',
        }
      : {}),
    ...(input['x-sdk-validation'] !== undefined
      ? { constraints: input['x-sdk-validation'] === 'schema' }
      : {}),
    ...(request.allOf ? { every: branches(request.allOf, response.allOf ?? request.allOf) } : {}),
    ...(request.anyOf ? { some: branches(request.anyOf, response.anyOf ?? request.anyOf) } : {}),
    ...(request.oneOf
      ? {
          exactlyOne: branches(request.oneOf, response.oneOf ?? request.oneOf).map(
            (branch, index) => ({
              ...branch,
              ...(bindings
                ? { tagValues: Object.keys(bindings).filter((tag) => bindings[tag] === index) }
                : {}),
            }),
          ),
        }
      : {}),
    ...(input.not ? { exclude: compileNode(input.not, input.not, depth + 1) } : {}),
    ...(input.discriminator && bindings ? { tag: input.discriminator.propertyName } : {}),
    ...(input['x-sdk-ref'] ? { reference: input['x-sdk-ref'] } : {}),
    ...(input['x-sdk-definitions']
      ? {
          definitions: Object.fromEntries(
            Object.entries(input['x-sdk-definitions']).map(([name, s]) => [
              name,
              compileNode(s, s, depth + 1),
            ]),
          ),
        }
      : {}),
  };
}

export const ANY_CODEC: CodecPlan = {
  value: { kind: 'dynamic' },
  nullable: true,
  modelObjectInput: false,
  requiredInput: [],
  requiredOutput: [],
  rejectInput: false,
  hiddenOutput: false,
  sensitive: false,
  checks: {},
};

/** Validate serialized instructions at an ingestion boundary, without executing values. */
export function assertCodecPlan(
  value: unknown,
  path = 'codec',
  depth = 0,
): asserts value is CodecPlan {
  function invalid(reason: string): never {
    throw new Error(`${path}: invalid compiled codec (${reason})`);
  }
  if (depth > 256) invalid('nesting limit');
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('expected an object');
  // Shape validation below establishes this local record view of external data.
  const node = value as Record<string, unknown>;
  if (node.numberInput !== undefined && node.numberInput !== 'explicit')
    invalid('number input representation');
  const instruction = node.value;
  if (!instruction || typeof instruction !== 'object' || Array.isArray(instruction))
    invalid('missing value instruction');
  const op = instruction as Record<string, unknown>;
  if (
    ![
      'dynamic',
      'null-array',
      'null',
      'boolean',
      'string',
      'object',
      'array',
      'safe-integer',
      'exact-integer',
      'decimal',
      'opaque',
    ].includes(String(op.kind))
  )
    invalid('unknown instruction');
  if (node.numberInput !== undefined && !['decimal', 'exact-integer'].includes(String(op.kind)))
    invalid('number input requires an exact numeric instruction');
  if (op.kind === 'opaque' && typeof op.label !== 'string') invalid('missing opaque label');
  for (const key of ['nullable', 'modelObjectInput', 'rejectInput', 'hiddenOutput', 'sensitive'])
    if (typeof node[key] !== 'boolean') invalid('missing boolean ' + key);
  for (const key of ['requiredInput', 'requiredOutput'])
    if (!Array.isArray(node[key]) || !node[key].every((item: unknown) => typeof item === 'string'))
      invalid('invalid required keys');
  if (
    node.tagValues !== undefined &&
    (!Array.isArray(node.tagValues) || !node.tagValues.every((value) => typeof value === 'string'))
  )
    invalid('invalid discriminator values');
  if (!node.checks || typeof node.checks !== 'object' || Array.isArray(node.checks))
    invalid('missing checks');
  for (const [key, item] of Object.entries(node.checks as Record<string, unknown>)) {
    if (key === 'uniqueItems') {
      if (typeof item !== 'boolean') invalid('invalid uniqueness constraint');
      continue;
    }
    if (key === 'multipleOf' && (typeof item !== 'number' || item <= 0))
      invalid('invalid positive divisor');
    if (
      ['minProperties', 'maxProperties'].includes(key) &&
      (typeof item !== 'number' || !Number.isSafeInteger(item) || item < 0)
    )
      invalid('invalid property bound');
    if (
      key === 'pattern'
        ? typeof item !== 'string'
        : ![
            'minimum',
            'maximum',
            'exclusiveMinimum',
            'exclusiveMaximum',
            'multipleOf',
            'minLength',
            'maxLength',
            'minItems',
            'maxItems',
            'minProperties',
            'maxProperties',
            'uniqueItems',
          ].includes(key) ||
          typeof item !== 'number' ||
          !Number.isFinite(item)
    )
      invalid('invalid constraint ' + key);
  }
  if (node.literal !== undefined) {
    if (typeof node.literal !== 'string') invalid('invalid literal');
    try {
      JSON.parse(String(node.literal));
    } catch {
      invalid('invalid literal JSON');
    }
  }
  for (const key of ['reference', 'tag', 'phpPattern'])
    if (node[key] !== undefined && typeof node[key] !== 'string') invalid('invalid ' + key);
  if (node.constraints !== undefined && typeof node.constraints !== 'boolean')
    invalid('invalid constraint policy');
  if (node.objectOnlyAlternative !== undefined && typeof node.objectOnlyAlternative !== 'boolean')
    invalid('invalid alternative policy');
  if (
    node.range !== undefined &&
    (!Array.isArray(node.range) ||
      node.range.length !== 2 ||
      !node.range.every((v: unknown) => typeof v === 'string' && /^-?\d+$/.test(v)))
  )
    invalid('invalid numeric range');
  if (node.members !== undefined && !Array.isArray(node.members)) invalid('invalid enum members');
  for (const key of ['fields', 'definitions']) {
    const children = node[key];
    if (children === undefined) continue;
    if (!children || typeof children !== 'object' || Array.isArray(children))
      invalid('invalid ' + key);
    for (const [name, child] of Object.entries(children))
      assertCodecPlan(child, path + '.' + key + '.' + name, depth + 1);
  }
  for (const key of ['every', 'some', 'exactlyOne']) {
    const children = node[key];
    if (children === undefined) continue;
    if (!Array.isArray(children)) invalid('invalid ' + key);
    for (const [index, child] of children.entries())
      assertCodecPlan(child, `${path}.${key}[${index}]`, depth + 1);
  }
  for (const key of ['element', 'exclude', 'includes'])
    if (node[key] !== undefined) assertCodecPlan(node[key], path + '.' + key, depth + 1);
  if (node.when !== undefined) {
    if (!node.when || typeof node.when !== 'object' || Array.isArray(node.when))
      invalid('invalid conditional');
    const condition = node.when as Record<string, unknown>;
    assertCodecPlan(condition.test, path + '.when.test', depth + 1);
    for (const key of ['then', 'else'])
      if (condition[key] !== undefined)
        assertCodecPlan(condition[key], path + '.when.' + key, depth + 1);
  }
  if (node.extra !== undefined && typeof node.extra !== 'boolean')
    assertCodecPlan(node.extra, path + '.extra', depth + 1);
}
