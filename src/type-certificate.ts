/** Executable subset of the finalized public TypeScript declaration plan. */
export type PublicType =
  | {
      kind:
        | 'unknown'
        | 'never'
        | 'null'
        | 'undefined'
        | 'string'
        | 'number'
        | 'boolean'
        | 'object'
        | 'nonnull'
        | 'integer-string'
        | 'function'
        | 'binary'
        | 'stream';
    }
  | { kind: 'literal'; value: string | number | boolean }
  | { kind: 'reference'; name: string }
  | { kind: 'array'; element: PublicType }
  | { kind: 'union' | 'intersection'; members: PublicType[] }
  | { kind: 'nonarray'; value: PublicType }
  | {
      kind: 'record';
      fields: Record<string, { type: PublicType; optional: boolean }>;
      extra?: PublicType;
    };
export interface TypeCertificate {
  type: PublicType;
  definitions: Record<string, PublicType>;
}

export function assertTypeCertificate(value: unknown): asserts value is TypeCertificate {
  const record = (v: unknown): Record<string, unknown> => {
    if (!v || typeof v !== 'object' || Array.isArray(v))
      throw new Error('Invalid type certificate');
    return v as Record<string, unknown>;
  };
  const root = record(value);
  const definitions = record(root.definitions);
  const check = (v: unknown, depth = 0): void => {
    if (depth > 256) throw new Error('Type certificate nesting limit');
    const node = record(v);
    switch (node.kind) {
      case 'unknown':
      case 'never':
      case 'null':
      case 'undefined':
      case 'string':
      case 'number':
      case 'boolean':
      case 'object':
      case 'nonnull':
      case 'integer-string':
      case 'function':
      case 'binary':
      case 'stream':
        return;
      case 'literal':
        if (['string', 'number', 'boolean'].includes(typeof node.value)) return;
        break;
      case 'reference':
        if (typeof node.name === 'string' && Object.hasOwn(definitions, node.name)) return;
        break;
      case 'array':
        check(node.element, depth + 1);
        return;
      case 'nonarray':
        check(node.value, depth + 1);
        return;
      case 'union':
      case 'intersection':
        if (!Array.isArray(node.members) || !node.members.length) break;
        node.members.forEach((child) => check(child, depth + 1));
        return;
      case 'record':
        for (const field of Object.values(record(node.fields))) {
          const entry = record(field);
          if (typeof entry.optional !== 'boolean')
            throw new Error('Invalid certificate optional field');
          check(entry.type, depth + 1);
        }
        if (node.extra !== undefined) check(node.extra, depth + 1);
        return;
    }
    throw new Error('Invalid type certificate node');
  };
  check(root.type);
  for (const node of Object.values(definitions)) check(node);
}

type CheckContext = {
  objects: WeakMap<object, Map<PreparedType, boolean | 'checking'>>;
  primitives: Map<unknown, Map<PreparedType, boolean | 'checking'>>;
};
type Check = (value: unknown, context: CheckContext, depth: number) => boolean;
interface PreparedType {
  check: Check;
  quick: (value: unknown) => boolean;
}
const preparedCertificates = new WeakMap<TypeCertificate, (value: unknown) => boolean>();

/** Compile graph traversal and property unions once, independently of payloads. */
function prepareCertificate(certificate: TypeCertificate): (value: unknown) => boolean {
  const resolved = new Map<PublicType, PublicType>();
  const resolve = (node: PublicType): PublicType => {
    const previous = resolved.get(node);
    if (previous) return previous;
    const original = node;
    const seen = new Set<string>();
    while (node.kind === 'reference') {
      if (seen.has(node.name)) throw new Error('Unproductive public type reference');
      seen.add(node.name);
      const target = certificate.definitions[node.name];
      if (!target) throw new Error('Missing public type ' + node.name);
      node = target;
    }
    resolved.set(original, node);
    return node;
  };
  // These walks stop at fields/elements: recursive payload edges are compiled
  // separately. Results depend only on the complete root, never a partial DFS.
  const walk = (root: PublicType, visit: (node: PublicType) => void): void => {
    const pending = [root],
      seen = new Set<PublicType>();
    while (pending.length) {
      const next = pending.pop();
      if (!next) break;
      const node = resolve(next);
      if (seen.has(node)) continue;
      seen.add(node);
      visit(node);
      if (node.kind === 'union' || node.kind === 'intersection') pending.push(...node.members);
      else if (node.kind === 'nonarray') pending.push(node.value);
    }
  };
  const keys = (root: PublicType): Set<string> => {
    const result = new Set<string>();
    walk(root, (node) => {
      if (node.kind === 'record') Object.keys(node.fields).forEach((key) => result.add(key));
    });
    return result;
  };
  const fieldTypes = (root: PublicType, key: string): PublicType[] => {
    const result: PublicType[] = [];
    walk(root, (node) => {
      if (node.kind !== 'record') return;
      const field = Object.hasOwn(node.fields, key) ? node.fields[key] : undefined;
      if (field) result.push(field.type);
      else if (node.extra) result.push(node.extra);
    });
    return result;
  };
  const hasIndex = (root: PublicType): boolean => {
    let found = false;
    walk(root, (node) => {
      if (node.kind === 'record' && node.extra) found = true;
    });
    return found;
  };
  const opaque = (declaration: PublicType, seen = new Set<PublicType>()): boolean => {
    const node = resolve(declaration);
    if (seen.has(node)) return false;
    const next = new Set([...seen, node]);
    return (
      node.kind === 'unknown' ||
      (node.kind === 'record' &&
        !Object.keys(node.fields).length &&
        node.extra?.kind === 'unknown') ||
      (node.kind === 'intersection' && node.members.every((child) => opaque(child, next))) ||
      (node.kind === 'union' && node.members.some((child) => opaque(child, next)))
    );
  };
  const literalValues = (
    declaration: PublicType,
    seen = new Set<PublicType>(),
  ): unknown[] | undefined => {
    const node = resolve(declaration);
    if (seen.has(node)) return;
    if (node.kind === 'literal') return [node.value];
    if (node.kind === 'null') return [null];
    if (node.kind === 'undefined') return [undefined];
    if (node.kind !== 'union') return;
    const children = node.members.map((child) => literalValues(child, new Set([...seen, node])));
    return children.every((child) => child !== undefined) ? children.flat() : undefined;
  };
  // Conservative gates avoid descending into impossible members. Union gates
  // remain permissive; their own compiled members perform the selection.
  const quick = (root: PublicType): ((value: unknown) => boolean) => {
    const gates: ((value: unknown) => boolean)[] = [];
    const pending = [root],
      seen = new Set<PublicType>();
    while (pending.length) {
      const next = pending.pop();
      if (!next) break;
      const node = resolve(next);
      if (seen.has(node)) continue;
      seen.add(node);
      if (node.kind === 'intersection') pending.push(...node.members);
      else if (node.kind === 'nonarray') {
        gates.push((value) => !Array.isArray(value));
        pending.push(node.value);
      } else if (node.kind === 'record') {
        const required = Object.entries(node.fields)
          .filter(([, field]) => !field.optional)
          .map(([key]) => key);
        const tags = Object.entries(node.fields).flatMap(([key, field]) => {
          const values = literalValues(field.type);
          return values ? [{ key, values: new Set(values) }] : [];
        });
        gates.push((value) => {
          if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
          const object = value as Record<string, unknown>;
          return (
            required.every((key) => Object.hasOwn(object, key)) &&
            tags.every(({ key, values }) => !Object.hasOwn(object, key) || values.has(object[key]))
          );
        });
      } else if (node.kind === 'array') gates.push(Array.isArray);
      else if (node.kind === 'null') gates.push((value) => value === null);
      else if (node.kind === 'undefined') gates.push((value) => value === undefined);
      else if (node.kind === 'literal') gates.push((value) => value === node.value);
      else if (['string', 'number', 'boolean', 'function'].includes(node.kind))
        gates.push((value) => typeof value === node.kind);
    }
    return (value) => gates.every((gate) => gate(value));
  };

  const prepared = new Map<PublicType, PreparedType>();
  const ids = new Map<PublicType, number>();
  const unions = new Map<string, PublicType>();
  const unionKey = (members: PublicType[]): string =>
    members
      .map(resolve)
      .map((node) => {
        if (!ids.has(node)) ids.set(node, ids.size);
        const id = ids.get(node);
        if (id === undefined) throw new Error('Missing public type identity');
        return id;
      })
      .sort((a, b) => a - b)
      .filter((id, index, all) => index === 0 || id !== all[index - 1])
      .join(',');
  const union = (members: PublicType[]): PreparedType => {
    const distinct = [...new Set(members.map(resolve))];
    const first = distinct[0];
    if (distinct.length === 1 && first) return compile(first);
    const key = unionKey(distinct);
    let node = unions.get(key);
    if (!node) {
      node = { kind: 'union', members: distinct };
      unions.set(key, node);
    }
    return compile(node);
  };
  const compile = (declaration: PublicType): PreparedType => {
    const node = resolve(declaration);
    const previous = prepared.get(node);
    if (previous) return previous;
    const result: PreparedType = {
      check: () => {
        throw new Error('Unprepared public type');
      },
      quick: quick(node),
    };
    prepared.set(node, result);
    let check: Check;
    switch (node.kind) {
      case 'unknown':
        check = () => true;
        break;
      case 'never':
        check = () => false;
        break;
      case 'null':
        check = (value) => value === null;
        break;
      case 'undefined':
        check = (value) => value === undefined;
        break;
      case 'string':
      case 'boolean':
      case 'function':
        check = (value) => typeof value === node.kind;
        break;
      case 'number':
        check = (value) => typeof value === 'number' && Number.isFinite(value);
        break;
      case 'integer-string':
        check = (value) => typeof value === 'string' && /^-?(0|[1-9][0-9]*)(?![\s\S])/.test(value);
        break;
      case 'binary':
        check = (value) => value instanceof Uint8Array;
        break;
      case 'stream':
        check = (value) =>
          value !== null &&
          typeof value === 'object' &&
          'close' in value &&
          typeof value.close === 'function' &&
          Symbol.asyncIterator in value &&
          typeof value[Symbol.asyncIterator] === 'function';
        break;
      case 'object':
        check = (value) =>
          value !== null && (typeof value === 'object' || typeof value === 'function');
        break;
      case 'nonnull':
        check = (value) => value !== null && value !== undefined;
        break;
      case 'literal':
        check = (value) => value === node.value;
        break;
      case 'reference':
        throw new Error('Unresolved public type');
      case 'nonarray': {
        const child = compile(node.value);
        check = (value, context, depth) =>
          !Array.isArray(value) && child.check(value, context, depth);
        break;
      }
      case 'array': {
        const child = compile(node.element);
        check = (value, context, depth) =>
          Array.isArray(value) && value.every((item) => child.check(item, context, depth + 1));
        break;
      }
      case 'intersection': {
        const children = node.members.map(compile);
        check = (value, context, depth) =>
          children.every((child) => child.check(value, context, depth));
        break;
      }
      case 'union': {
        const key = unionKey(node.members);
        if (!unions.has(key)) unions.set(key, node);
        const allKeys = [...keys(node)];
        const indexed = hasIndex(node);
        const explicitKeys = new Set(allKeys);
        const keepsUnknown = node.members.some((member) => opaque(member));
        const properties = keepsUnknown
          ? []
          : allKeys.map((key) => ({
              key,
              type: union(node.members.flatMap((member) => fieldTypes(member, key))),
            }));
        const elements: PublicType[] = [];
        if (!keepsUnknown)
          walk(node, (child) => {
            if (child.kind === 'array') elements.push(child.element);
          });
        const items = elements.length ? union(elements) : undefined;
        const members = node.members.map((member) => ({
          type: compile(member),
          indexed: hasIndex(member),
          allowed: new Set(allKeys.filter((key) => fieldTypes(member, key).length > 0)),
        }));
        check = (value, context, depth) => {
          const candidates = members.filter((member) => member.type.quick(value));
          if (!candidates.length) return false;
          if (
            Array.isArray(value) &&
            items &&
            !value.every((child) => items.check(child, context, depth + 1))
          )
            return false;
          if (!keepsUnknown && value && typeof value === 'object' && !Array.isArray(value)) {
            const object = value as Record<string, unknown>;
            for (const { key, type } of properties)
              if (Object.hasOwn(object, key) && !type.check(object[key], context, depth + 1))
                return false;
          }
          return candidates.some(
            (member) =>
              (keepsUnknown ||
                !value ||
                typeof value !== 'object' ||
                allKeys.every((key) => !Object.hasOwn(value, key) || member.allowed.has(key))) &&
              // An arbitrary key can also narrow to a shaped index-signature
              // member. Require that member's entire shape, not just the key value.
              (keepsUnknown ||
                !indexed ||
                !value ||
                typeof value !== 'object' ||
                Array.isArray(value) ||
                Object.keys(value).every((key) => explicitKeys.has(key) || member.indexed)) &&
              member.type.check(value, context, depth),
          );
        };
        break;
      }
      case 'record': {
        const fields = Object.entries(node.fields).map(([key, field]) => ({
          key,
          optional: field.optional,
          type: compile(field.type),
        }));
        const extra = node.extra ? compile(node.extra) : undefined;
        check = (value, context, depth) => {
          if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
          const object = value as Record<string, unknown>;
          for (const { key, optional, type } of fields) {
            if (!Object.hasOwn(object, key)) {
              if (!optional) return false;
            } else if (!type.check(object[key], context, depth + 1)) return false;
          }
          if (extra)
            for (const [key, child] of Object.entries(object))
              if (!Object.hasOwn(node.fields, key) && !extra.check(child, context, depth + 1))
                return false;
          return true;
        };
        break;
      }
    }
    result.check = (value, context, depth) => {
      if (depth > 256) return false;
      // Both stores expose the same map; the object branch establishes the
      // WeakMap key invariant without asserting that an arbitrary value is an object.
      let memo: Map<PreparedType, boolean | 'checking'> | undefined;
      if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
        memo = context.objects.get(value);
        if (!memo) {
          memo = new Map();
          context.objects.set(value, memo);
        }
      } else {
        memo = context.primitives.get(value);
        if (!memo) {
          memo = new Map();
          context.primitives.set(value, memo);
        }
      }
      const previous = memo.get(result);
      if (previous !== undefined) return previous === true;
      memo.set(result, 'checking');
      const accepted = check(value, context, depth);
      memo.set(result, accepted);
      return accepted;
    };
    return result;
  };
  const root = compile(certificate.type);
  return (value) => root.check(value, { objects: new WeakMap(), primitives: new Map() }, 0);
}

/**
 * Structural unions certify every known key that could select another member.
 * Index signatures retain their declared uncertainty. A decode checks each
 * (value, type) pair once, even through recursive property unions.
 */
export function certifies(value: unknown, certificate: TypeCertificate): boolean {
  let check = preparedCertificates.get(certificate);
  if (!check) {
    check = prepareCertificate(certificate);
    preparedCertificates.set(certificate, check);
  }
  return check(value);
}
/** Reattach shared declaration data to newly parsed, resource-owned operations. */
export function withTypeDefinitions<
  T extends {
    outputCertificate?: TypeCertificate;
    payloadCertificate?: TypeCertificate;
    itemCertificate?: TypeCertificate;
  },
>(operations: T[], definitions: Record<string, PublicType>): T[] {
  for (const operation of operations)
    for (const key of ['outputCertificate', 'payloadCertificate', 'itemCertificate'] as const) {
      const certificate = operation[key];
      if (certificate) certificate.definitions = definitions;
    }
  return operations;
}
