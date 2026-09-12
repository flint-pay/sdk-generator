import type { Operation, Schema } from './contract.js';
import { Diagnostic } from './diagnostic.js';
import { objectConstraint } from './target-types.js';
import { valueScopes } from './schema-intersections.js';

export interface RequestStyle {
  style?: 'object' | 'positional';
}

export function validateRequestStyle(value: unknown, path: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Diagnostic(path, 'expected a request style object');
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record))
    if (key !== 'style') throw new Diagnostic(path + '/' + key, 'unknown configuration key');
  if (record.style !== undefined && !['object', 'positional'].includes(record.style as string))
    throw new Diagnostic(path + '/style', 'expected object or positional');
}

export function pathParameters(op: Operation) {
  return [...new Set([...op.path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!))].map(
    (name) => op.parameters.find((p) => p.in === 'path' && p.name === name)!,
  );
}
export const positional = (op: Operation) => op.request?.style === 'positional';
export const hasParams = (op: Operation) =>
  Boolean(op.body || op.parameters.some((p) => p.in !== 'path'));

export function validatePositional(op: Operation, definitions: Record<string, Schema>): void {
  if (!positional(op) || !op.body) return;
  const body = op.body['x-sdk-ref'] ? definitions[op.body['x-sdk-ref']]! : op.body;
  const scopes = valueScopes(body, definitions);
  const fail = (message: string): never => {
    throw new Diagnostic(
      'config/operations/' + op.id + '/request',
      message + '; use request.style: object for this operation',
    );
  };
  if (!body || objectConstraint(body) !== 'object')
    fail('positional requests require a non-null object body');
  for (const parameter of op.parameters.filter((p) => p.in !== 'path')) {
    if (scopes.some((s) => Object.hasOwn(s.properties ?? {}, parameter.name)))
      fail('body field conflicts with parameter ' + parameter.name);
    // A typed dictionary intersected with params would incorrectly constrain query/header values.
    if (scopes.some((s) => typeof s.additionalProperties === 'object'))
      fail('flattening a typed dictionary body with query/header parameters is unsupported');
  }
}

/** Fixture and example inputs retain the canonical wire-oriented input shape. */
export function requestArguments(op: Operation, value: unknown): unknown[] {
  const input = value as Record<string, unknown>;
  if (!positional(op)) return [input];
  const values = pathParameters(op).map((p) => input[p.name]);
  if (hasParams(op)) {
    const params: Record<string, unknown> = { ...((input.body as object) ?? {}) };
    for (const p of op.parameters.filter((p) => p.in !== 'path'))
      if (Object.hasOwn(input, p.name)) params[p.name] = input[p.name];
    // Preserve absent optional bodies, distinct from an explicitly supplied empty body.
    values.push(
      !op.bodyRequired && op.body && !Object.hasOwn(input, 'body') && !Object.keys(params).length
        ? undefined
        : params,
    );
  }
  return values;
}
