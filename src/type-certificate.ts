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

/**
 * Structural unions need more than ordinary assignability: an extra known key
 * can select a different member with an `in` guard. Certify that selection too.
 * Unknown index signatures deliberately keep such accesses unknown in TS.
 */
export function certifies(value: unknown, certificate: TypeCertificate): boolean {
  const resolve = (node: PublicType): PublicType => {
    const seen = new Set<string>();
    while (node.kind === 'reference') {
      if (seen.has(node.name)) throw new Error('Unproductive public type reference');
      seen.add(node.name);
      const target = certificate.definitions[node.name];
      if (!target) throw new Error('Missing public type ' + node.name);
      node = target;
    }
    return node;
  };
  const keys = (node: PublicType, seen = new Set<string>()): Set<string> => {
    if (node.kind === 'reference') {
      if (seen.has(node.name)) return new Set();
      return keys(resolve(node), new Set([...seen, node.name]));
    }
    if (node.kind === 'record') return new Set(Object.keys(node.fields));
    if (node.kind === 'nonarray') return keys(node.value, seen);
    return node.kind === 'intersection' || node.kind === 'union'
      ? new Set(node.members.flatMap((child) => [...keys(child, seen)]))
      : new Set();
  };
  const fieldTypes = (node: PublicType, key: string, seen = new Set<string>()): PublicType[] => {
    if (node.kind === 'reference') {
      if (seen.has(node.name)) return [];
      return fieldTypes(resolve(node), key, new Set([...seen, node.name]));
    }
    if (node.kind === 'record') {
      const field = Object.hasOwn(node.fields, key) ? node.fields[key] : undefined;
      return field ? [field.type] : node.extra ? [node.extra] : [];
    }
    if (node.kind === 'nonarray') return fieldTypes(node.value, key, seen);
    return node.kind === 'union' || node.kind === 'intersection'
      ? node.members.flatMap((child) => fieldTypes(child, key, seen))
      : [];
  };
  const elements = (node: PublicType, seen = new Set<string>()): PublicType[] => {
    if (node.kind === 'reference') {
      if (seen.has(node.name)) return [];
      return elements(resolve(node), new Set([...seen, node.name]));
    }
    if (node.kind === 'array') return [node.element];
    return node.kind === 'union' || node.kind === 'intersection'
      ? node.members.flatMap((child) => elements(child, seen))
      : [];
  };
  const opaque = (node: PublicType): boolean => {
    node = resolve(node);
    return (
      node.kind === 'unknown' ||
      (node.kind === 'record' &&
        !Object.keys(node.fields).length &&
        node.extra?.kind === 'unknown') ||
      (node.kind === 'intersection' && node.members.every(opaque)) ||
      (node.kind === 'union' && node.members.some(opaque))
    );
  };
  const check = (v: unknown, declaration: PublicType, depth: number): boolean => {
    if (depth > 256) return false;
    const node = resolve(declaration);
    switch (node.kind) {
      case 'unknown':
        return true;
      case 'never':
        return false;
      case 'null':
        return v === null;
      case 'undefined':
        return v === undefined;
      case 'string':
      case 'boolean':
      case 'function':
        return typeof v === node.kind;
      case 'number':
        return typeof v === 'number' && Number.isFinite(v);
      case 'integer-string':
        return typeof v === 'string' && /^[+-]?\d+$/.test(v) && v.trim() === v;
      case 'binary':
        return v instanceof Uint8Array;
      case 'stream':
        return (
          v !== null &&
          typeof v === 'object' &&
          'close' in v &&
          typeof v.close === 'function' &&
          Symbol.asyncIterator in v &&
          typeof v[Symbol.asyncIterator] === 'function'
        );
      case 'object':
        return v !== null && (typeof v === 'object' || typeof v === 'function');
      case 'nonnull':
        return v !== null && v !== undefined;
      case 'literal':
        return v === node.value;
      case 'reference':
        throw new Error('Unresolved public type');
      case 'nonarray':
        return !Array.isArray(v) && check(v, node.value, depth + 1);
      case 'array':
        return Array.isArray(v) && v.every((child) => check(child, node.element, depth + 1));
      case 'intersection':
        return node.members.every((child) => check(v, child, depth + 1));
      case 'union': {
        const allKeys = new Set(node.members.flatMap((member) => [...keys(member)]));
        const keepsUnknown = node.members.some(opaque);
        if (Array.isArray(v) && !keepsUnknown) {
          const children = node.members.flatMap((member) => elements(member));
          if (
            children.length &&
            !v.every((child) => check(child, { kind: 'union', members: children }, depth + 1))
          )
            return false;
        }
        if (!keepsUnknown && v && typeof v === 'object' && !Array.isArray(v))
          for (const key of allKeys) {
            if (!Object.hasOwn(v, key)) continue;
            const children = node.members.flatMap((member) => fieldTypes(member, key));
            if (
              children.length &&
              !check(
                (v as Record<string, unknown>)[key],
                { kind: 'union', members: children },
                depth + 1,
              )
            )
              return false;
          }
        return node.members.some((member) => {
          if (!check(v, member, depth + 1)) return false;
          if (keepsUnknown || !v || typeof v !== 'object') return true;
          const own = keys(member);
          return [...allKeys].every((key) => !Object.hasOwn(v, key) || own.has(key));
        });
      }
      case 'record': {
        if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
        const object = v as Record<string, unknown>;
        for (const [key, field] of Object.entries(node.fields)) {
          if (!Object.hasOwn(object, key)) {
            if (!field.optional) return false;
          } else if (!check(object[key], field.type, depth + 1)) return false;
        }
        if (node.extra)
          for (const [key, child] of Object.entries(object))
            if (!Object.hasOwn(node.fields, key) && !check(child, node.extra, depth + 1))
              return false;
        return true;
      }
    }
  };
  return check(value, certificate.type, 0);
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
