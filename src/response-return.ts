import type { Operation, Schema } from './contract.js';
import { Diagnostic } from './diagnostic.js';
import { successStatus } from './runtime-plan.js';
import { objectConstraint } from './target-types.js';

export interface ResponseReturn {
  return?: 'result' | 'payload';
  payloadPath?: string | null;
}

export function validateResponseReturn(
  value: unknown,
  path: string,
): asserts value is ResponseReturn {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Diagnostic(path, 'expected an object');
  const v = value as Record<string, unknown>;
  for (const key of Object.keys(v))
    if (!['return', 'payloadPath'].includes(key))
      throw new Diagnostic(path + '/' + key, 'unsupported response setting');
  if (v.return !== undefined && v.return !== 'result' && v.return !== 'payload')
    throw new Diagnostic(path + '/return', 'expected result or payload');
  if (
    v.payloadPath !== undefined &&
    v.payloadPath !== null &&
    (typeof v.payloadPath !== 'string' ||
      !v.payloadPath ||
      v.payloadPath
        .split('.')
        .some((p) => !p || ['__proto__', 'constructor', 'prototype'].includes(p)))
  )
    throw new Diagnostic(path + '/payloadPath', 'expected a nonempty dot-separated property path');
}

/** Require a declared, present path in every alternative. Never infer envelopes by name. */
export function payloadSchemas(op: Operation, definitions: Record<string, Schema> = {}): Schema[] {
  const path = op.response?.payloadPath;
  if (!path) return [];
  const location = 'config/operations/' + op.id + '/response/payloadPath';
  const fail = (): never => {
    throw new Diagnostic(
      location,
      'payloadPath must address required, declared properties through non-null objects in every successful JSON response; override this operation with return: result for other response shapes',
    );
  };
  const expand = (s: Schema, seen = new Set<string>()): Schema => {
    const ref = s['x-sdk-ref'];
    if (!ref) return s;
    if (!definitions[ref] || seen.has(ref)) return fail();
    const { ['x-sdk-ref']: _, ...siblings } = s;
    return { allOf: [expand(definitions[ref]!, new Set(seen).add(ref)), siblings] };
  };
  const project = (s: Schema, parts: string[]): Schema[] => {
    if (!parts.length) return [s];
    const flatten = (value: Schema): Schema[] => {
      const v = expand(value);
      const { allOf, ...own } = v;
      return [own, ...(allOf ?? []).flatMap(flatten)];
    };
    const constraints = flatten(s);
    const union = constraints.findIndex((v) => v.oneOf || v.anyOf);
    if (union !== -1) {
      const branch = constraints[union]!;
      const { oneOf, anyOf, ...rest } = branch;
      return (oneOf ?? anyOf)!.flatMap((v) =>
        project(
          { allOf: [...constraints.slice(0, union), rest, v, ...constraints.slice(union + 1)] },
          parts,
        ),
      );
    }
    const key = parts[0]!;
    const children = constraints.flatMap((v) =>
      v.properties && Object.hasOwn(v.properties, key) ? [v.properties[key]!] : [],
    );
    if (
      objectConstraint({ allOf: constraints }) !== 'object' ||
      !constraints.some((v) => v.required?.includes(key)) ||
      !children.length ||
      children.some((v) => v.writeOnly)
    )
      return fail();
    return project(children.length === 1 ? children[0]! : { allOf: children }, parts.slice(1));
  };
  return Object.entries(op.responses)
    .filter(([status]) => successStatus(status) || status === 'default')
    .flatMap(([, r]) => {
      if (
        !r.schema ||
        r.bodyKind === 'binary' ||
        r.bodyKind === 'sse' ||
        r.classification === 'redirect'
      )
        return fail();
      return project(r.schema, path.split('.'));
    });
}

/** Future alternatives may expose values outside the known payload schemas. */
export function payloadHasAlternatives(
  op: Operation,
  definitions: Record<string, Schema> = {},
): boolean {
  const visit = (s: Schema, parts: string[], seen = new Set<string>()): boolean => {
    if (!parts.length) return false;
    if (s.oneOf || s.anyOf) return true;
    const ref = s['x-sdk-ref'];
    if (
      ref &&
      !seen.has(ref) &&
      definitions[ref] &&
      visit(definitions[ref]!, parts, new Set(seen).add(ref))
    )
      return true;
    return Boolean(
      s.allOf?.some((v) => visit(v, parts, seen)) ||
        (s.properties?.[parts[0]!] && visit(s.properties[parts[0]!]!, parts.slice(1), seen)),
    );
  };
  return Object.entries(op.responses).some(
    ([status, r]) =>
      (successStatus(status) || status === 'default') &&
      r.schema &&
      visit(r.schema, op.response?.payloadPath?.split('.') ?? []),
  );
}
