import type { CompiledSdkContract } from './target-plan.js';
import { assertCodecPlan } from './codec-plan.js';
import { assertRuntimePlan } from './runtime-plan.js';
import type { ValueGuarantee } from './value-guarantee.js';

export interface CompiledSnapshot {
  plan: CompiledSdkContract;
  runtimeIdentity: Partial<Record<'node' | 'php', string>>;
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(path + ': invalid compiled record');
  return value as Record<string, unknown>;
}

function assertGuarantee(value: unknown, depth = 0): asserts value is ValueGuarantee {
  if (depth > 256) throw new Error('Compiled guarantee exceeds nesting limit');
  const shape = object(value, 'guarantee');
  switch (shape.kind) {
    case 'unknown':
    case 'null':
    case 'string':
    case 'number':
    case 'boolean':
    case 'binary':
    case 'stream':
      return;
    case 'unresolved':
      if (typeof shape.reason === 'string') return;
      break;
    case 'array':
      assertGuarantee(shape.element, depth + 1);
      return;
    case 'object':
      if (!Array.isArray(shape.required) || !shape.required.every((key) => typeof key === 'string'))
        break;
      for (const field of Object.values(object(shape.fields, 'guarantee.fields')))
        assertGuarantee(field, depth + 1);
      assertGuarantee(shape.extra, depth + 1);
      return;
  }
  throw new Error('Unsupported or malformed compiled guarantee');
}

function strings(value: unknown, path: string): void {
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string'))
    throw new Error(path + ': expected strings');
}
function fields(value: Record<string, unknown>, keys: string[], type: string, path: string): void {
  for (const key of keys)
    if (typeof value[key] !== type) throw new Error(path + '.' + key + ': expected ' + type);
}
function assertPolicy(value: unknown, path: string, depth = 0): void {
  if (depth > 256) throw new Error(path + ': policy nesting limit');
  const policy = object(value, path);
  strings(policy.kinds, path + '.kinds');
  strings(policy.requiredKeys, path + '.requiredKeys');
  fields(policy, ['nullOnlyInput'], 'boolean', path);
  const wire = object(policy.wire, path + '.wire');
  fields(wire, ['exact'], 'boolean', path);
  fields(wire, ['label'], 'string', path);
  for (const key of ['reference', 'tag', 'literal'])
    if (policy[key] !== undefined) fields(policy, [key], 'string', path);
  if (wire.numberInput !== undefined && wire.numberInput !== 'explicit')
    throw new Error(path + ': invalid numeric input representation');
  if (wire.format !== undefined) fields(wire, ['format'], 'string', path + '.wire');
  for (const [name, child] of Object.entries(object(policy.fields, path + '.fields')))
    assertPolicy(child, path + '.' + name, depth + 1);
  if (policy.element !== undefined) assertPolicy(policy.element, path + '.element', depth + 1);
  if (policy.extra !== undefined && typeof policy.extra !== 'boolean')
    assertPolicy(policy.extra, path + '.extra', depth + 1);
  if (policy.members !== undefined && !Array.isArray(policy.members))
    throw new Error(path + ': invalid members');
  const checks = object(policy.checks, path + '.checks');
  for (const [key, check] of Object.entries(checks)) {
    if (key === 'uniqueItems') {
      if (typeof check !== 'boolean') throw new Error(path + ': invalid uniqueness constraint');
      continue;
    }
    if (key === 'multipleOf' && (typeof check !== 'number' || check <= 0))
      throw new Error(path + ': invalid positive divisor');
    if (
      ['minProperties', 'maxProperties'].includes(key) &&
      (typeof check !== 'number' || !Number.isSafeInteger(check) || check < 0)
    )
      throw new Error(path + ': invalid property bound');
    if (
      key === 'pattern'
        ? typeof check !== 'string'
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
          ].includes(key) ||
          typeof check !== 'number' ||
          !Number.isFinite(check)
    )
      throw new Error(path + ': invalid check ' + key);
  }
  const compositions = object(policy.compositions, path + '.compositions');
  if (policy.bindings !== undefined)
    for (const index of Object.values(object(policy.bindings, path + '.bindings')))
      if (
        typeof index !== 'number' ||
        !Number.isSafeInteger(index) ||
        index < 0 ||
        !Array.isArray(policy.variants) ||
        index >= policy.variants.length
      )
        throw new Error(path + ': invalid discriminator binding');
  for (const [key, children] of [
    ['variants', policy.variants],
    ['allOf', compositions.allOf],
    ['anyOf', compositions.anyOf],
  ] as const) {
    if (children === undefined) continue;
    if (!Array.isArray(children)) throw new Error(path + ': invalid ' + key);
    children.forEach((child, index) =>
      assertPolicy(child, path + '.' + key + '[' + index + ']', depth + 1),
    );
  }
  for (const key of ['if', 'then', 'else'])
    if (compositions[key] !== undefined)
      assertPolicy(compositions[key], path + '.' + key, depth + 1);
  if (compositions.contains !== undefined)
    assertPolicy(compositions.contains, path + '.contains', depth + 1);
  if (compositions.not !== undefined) assertPolicy(compositions.not, path + '.not', depth + 1);
  const annotations = object(policy.annotations, path + '.annotations');
  object(annotations.metadata, path + '.annotations.metadata');
  for (const key of ['readOnly', 'writeOnly'])
    if (annotations[key] !== undefined)
      fields(annotations, [key], 'boolean', path + '.annotations');
}

export function assertCompiledSnapshot(value: unknown): asserts value is CompiledSnapshot {
  const snapshot = object(value, 'snapshot');
  const plan = object(snapshot.plan, 'snapshot.plan');
  if (plan.format !== 1)
    throw new Error(
      'Unsupported compiled contract format; use a generator that understands this record',
    );
  if (
    typeof plan.semantics !== 'string' ||
    !Array.isArray(plan.targets) ||
    !plan.targets.every((target) => target === 'node' || target === 'php')
  )
    throw new Error('Invalid compiled contract identity');
  assertRuntimePlan(plan.runtime);
  const php = object(plan.php, 'php');
  assertRuntimePlan(php.runtime);
  const node = object(plan.node, 'node');
  for (const target of [node, php]) object(target.operations, 'target.operations');
  fields(node, ['eventType'], 'string', 'node');
  for (const [name, value] of Object.entries(object(node.models, 'node.models'))) {
    const model = object(value, 'node.models.' + name);
    fields(model, ['input', 'output'], 'string', name);
    fields(model, ['objectFactory'], 'boolean', name);
    assertCodecPlan(model.codec, 'node.models.' + name);
    if (model.sharedCodec !== undefined) fields(model, ['sharedCodec'], 'string', name);
  }
  for (const [name, value] of Object.entries(object(node.operations, 'node.operations'))) {
    const op = object(value, name);
    fields(op, ['input', 'output', 'items'], 'string', name);
    fields(op, ['inputRequired'], 'boolean', name);
    if (op.known !== undefined) {
      const known = object(op.known, name + '.known');
      fields(known, ['type'], 'string', name);
      if (!Array.isArray(known.codecs)) throw new Error(name + ': invalid known codecs');
      known.codecs.forEach((codec, index) => assertCodecPlan(codec, name + '.known.' + index));
    }
  }
  if (!Array.isArray(php.models)) throw new Error('Invalid PHP model plans');
  for (const value of php.models) {
    const model = object(value, 'php.model');
    fields(model, ['name', 'constructorType', 'constructorDoc'], 'string', 'php.model');
    fields(model, ['response', 'defaultObject'], 'boolean', 'php.model');
    assertCodecPlan(model.codec, 'php.model.' + model.name);
    if (model.sharedCodec !== undefined) fields(model, ['sharedCodec'], 'string', 'php.model');
    if (!Array.isArray(model.getters)) throw new Error('Invalid PHP getters');
    for (const getter of model.getters)
      fields(object(getter, 'getter'), ['field', 'method', 'type', 'doc'], 'string', 'getter');
  }
  for (const [name, value] of Object.entries(object(php.operations, 'php.operations')))
    fields(object(value, name), ['output', 'items'], 'string', name);
  for (const value of Object.values(object(php.eventModels, 'php.eventModels')))
    if (typeof value !== 'string') throw new Error('Invalid event model');
  for (const [name, value] of Object.entries(object(plan.documentation, 'documentation'))) {
    const doc = object(value, name);
    fields(doc, ['nodeInput', 'nodeOutput', 'phpInput', 'phpOutput'], 'string', name);
    fields(doc, ['reserveKnown'], 'boolean', name);
  }
  const policy = object(plan.policy, 'policy');
  for (const key of ['models', 'definitions'])
    for (const [name, value] of Object.entries(object(policy[key], 'policy.' + key))) {
      const pair = object(value, name);
      assertPolicy(pair.input, name + '.input');
      assertPolicy(pair.response, name + '.response');
    }
  for (const [name, value] of Object.entries(object(policy.operations, 'policy.operations'))) {
    const op = object(value, name);
    assertPolicy(op.input, name + '.input');
    for (const [status, response] of Object.entries(object(op.responses, name + '.responses')))
      assertPolicy(response, name + '.response.' + status);
  }
  for (const operation of Object.values(object(plan.responses, 'responses'))) {
    for (const response of Object.values(object(operation, 'operation.responses'))) {
      const result = object(response, 'response');
      if (result.body !== undefined) {
        const body = object(result.body, 'response.body');
        assertGuarantee(body.publicType);
        assertGuarantee(body.runtime);
        if (body.phpRuntime !== undefined) assertGuarantee(body.phpRuntime);
      }
    }
  }
  const nodeOperations = object(node.operations, 'node.operations');
  const phpOperations = object(php.operations, 'php.operations');
  const policies = object(policy.operations, 'policy.operations');
  const responses = object(plan.responses, 'responses');
  for (const op of plan.runtime.operations) {
    for (const [name, table] of [
      ['node.operations', nodeOperations],
      ['php.operations', phpOperations],
      ['policy.operations', policies],
      ['responses', responses],
    ] as const)
      if (!Object.hasOwn(table, op.id))
        throw new Error(name + '.' + op.id + ': missing compiled operation');
  }
  for (const name of Object.keys(object(node.models, 'node.models')))
    if (!Object.hasOwn(object(policy.models, 'policy.models'), name))
      throw new Error('policy.models.' + name + ': missing compiled model');
  const identities = object(snapshot.runtimeIdentity, 'runtimeIdentity');
  for (const target of plan.targets)
    if (typeof identities[target] !== 'string')
      throw new Error('runtimeIdentity.' + target + ': missing compiled identity');
  for (const [target, identity] of Object.entries(
    object(snapshot.runtimeIdentity, 'runtimeIdentity'),
  ))
    if (
      !['node', 'php'].includes(target) ||
      typeof identity !== 'string' ||
      !/^[a-f0-9]{64}$/.test(identity)
    )
      throw new Error('Invalid compiled runtime identity');
}

// Private snapshot storage shares equal JSON subtrees. References address data
// containers, never codec instructions, so decoding does not reinterpret policy.
type StoredValue = null | boolean | number | string | { ref: number };
type StoredNode =
  | { kind: 'object'; entries: [string, StoredValue][] }
  | { kind: 'array'; items: StoredValue[] };
export interface StoredCompiledSnapshot {
  encoding: 'shared-json-v1';
  root: StoredValue;
  nodes: StoredNode[];
}

export function storeCompiledSnapshot(snapshot: CompiledSnapshot): StoredCompiledSnapshot {
  const nodes: StoredNode[] = [];
  const interned = new Map<string, number>();
  const objects = new WeakMap<object, StoredValue>();
  function encode(value: unknown, depth = 0): StoredValue {
    if (depth > 1024) throw new Error('Compiled snapshot exceeds storage nesting limit');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (!value || typeof value !== 'object')
      throw new Error('Compiled snapshot contains a non-JSON value');
    const cached = objects.get(value);
    if (cached) return cached;
    const node: StoredNode = Array.isArray(value)
      ? { kind: 'array', items: value.map((child) => encode(child ?? null, depth + 1)) }
      : {
          kind: 'object',
          entries: Object.entries(value)
            .filter(([, child]) => child !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, child]) => [key, encode(child, depth + 1)]),
        };
    const key = JSON.stringify(node);
    let ref = interned.get(key);
    if (ref === undefined) {
      ref = nodes.length;
      nodes.push(node);
      interned.set(key, ref);
    }
    const result = { ref };
    objects.set(value, result);
    return result;
  }
  const root = encode(snapshot);
  return { encoding: 'shared-json-v1', root, nodes };
}

export function restoreCompiledSnapshot(value: unknown): CompiledSnapshot {
  const stored = object(value, 'compiled snapshot');
  if (stored.encoding === undefined) {
    assertCompiledSnapshot(value);
    return value;
  }
  if (stored.encoding !== 'shared-json-v1' || !Array.isArray(stored.nodes))
    throw new Error('Unsupported compiled snapshot storage encoding');
  const restored: unknown[] = [];
  const depths: number[] = [];
  function decode(value: unknown): { value: unknown; depth: number } {
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    )
      return { value, depth: 0 };
    const reference = object(value, 'compiled snapshot reference');
    const ref = reference.ref;
    if (
      typeof ref !== 'number' ||
      !Number.isSafeInteger(ref) ||
      ref < 0 ||
      ref >= restored.length ||
      Object.keys(reference).length !== 1
    )
      throw new Error('Invalid compiled snapshot reference');
    return { value: restored[ref], depth: depths[ref] ?? 0 };
  }
  for (const value of stored.nodes) {
    const node = object(value, 'compiled snapshot node');
    let output: unknown;
    let depth = 1;
    const child = (value: unknown): unknown => {
      const decoded = decode(value);
      depth = Math.max(depth, decoded.depth + 1);
      return decoded.value;
    };
    if (node.kind === 'array' && Array.isArray(node.items)) output = node.items.map(child);
    else if (node.kind === 'object' && Array.isArray(node.entries)) {
      const names = new Set<string>();
      output = Object.fromEntries(
        node.entries.map((entry: unknown) => {
          if (
            !Array.isArray(entry) ||
            entry.length !== 2 ||
            typeof entry[0] !== 'string' ||
            names.has(entry[0])
          )
            throw new Error('Invalid compiled snapshot object entry');
          names.add(entry[0]);
          return [entry[0], child(entry[1])];
        }),
      );
    } else throw new Error('Invalid compiled snapshot node');
    if (depth > 1024) throw new Error('Compiled snapshot exceeds storage nesting limit');
    restored.push(Object.freeze(output));
    depths.push(depth);
  }
  const snapshot = decode(stored.root).value;
  assertCompiledSnapshot(snapshot);
  return snapshot;
}
