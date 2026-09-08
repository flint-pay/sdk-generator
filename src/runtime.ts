import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { inspect } from 'node:util';
import type { Operation, Schema, Auth, Webhook, Config } from './contract.js';
export type { Operation, Schema } from './contract.js';

export type ErrorKind =
  | 'transport'
  | 'authentication'
  | 'validation'
  | 'rate_limit'
  | 'api'
  | 'conflict'
  | 'protocol'
  | 'cancelled'
  | 'deadline'
  | 'destination';
export interface Metadata {
  status: number;
  headers: Record<string, string>;
  requestId?: string;
  attempts: number;
  durationMs: number;
  url?: string;
}
export interface Result<T> {
  data: T;
  meta: Metadata;
  raw: string;
}
export class SdkError extends Error {
  constructor(
    public kind: ErrorKind,
    message: string,
    public outcome: 'unknown' | 'response' | 'not_sent' = 'not_sent',
    public retryAllowed = false,
    public meta?: Metadata,
    public code?: string,
    public details?: unknown,
    options?: ErrorOptions,
    public raw?: string,
  ) {
    super(message, options);
    this.name = 'SdkError';
  }
  [inspect.custom]() {
    return {
      name: this.name,
      kind: this.kind,
      message: this.message,
      outcome: this.outcome,
      retryAllowed: this.retryAllowed,
      requestId: this.meta?.requestId,
      status: this.meta?.status,
    };
  }
}
export interface DiagnosticEvent {
  operation: string;
  attempt: number;
  status?: number;
  requestId?: string;
  durationMs: number;
  errorKind?: ErrorKind;
}
export interface RequestOptions {
  headers?: Record<string, string>;
  idempotencyKey?: string;
  ifMatch?: string;
  timeoutMs?: number;
  deadlineMs?: number;
  maxAttempts?: number;
  signal?: AbortSignal;
  maxPages?: number;
  maxItems?: number;
}
export interface ClientOptions {
  baseUrl: string;
  token?: string;
  allowedOrigins?: string[];
  allowInsecureHttp?: boolean;
  timeoutMs?: number;
  deadlineMs?: number;
  maxAttempts?: number;
  transport?: typeof fetch;
  diagnostics?: (event: DiagnosticEvent) => void;
  redactFields?: string[];
}
export interface RuntimeContract {
  userAgent?: string;
  validation?: Config['validation'];
  operations: Operation[];
  definitions?: Record<string, Schema>;
  auth?: Auth;
  apiVersion?: { header: string; value: string };
  webhook?: Webhook;
  money?: { currencies: Record<string, number> };
  errors?: Config['errors'];
}
const bad = (path: string, reason: string): never => {
  throw new SdkError('validation', `${path}: ${reason}`);
};
const exactInteger = /^-?(?:0|[1-9]\d*)$/;
const exactDecimal = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
class RawNumber {
  constructor(readonly value: string) {}
}
class ParsedNumber {
  constructor(readonly value: string) {}
}
/** Parse JSON without rounding integers or decimal tokens. Unknown numeric tokens remain exact strings. */
export function parseExact(text: string): unknown {
  return parseJson(text);
}
function parseJson(text: string, preserveNumbers = false): unknown {
  let encoded = '';
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < text.length; ) {
    const c = text[i]!;
    if (quoted) {
      encoded += c;
      i++;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') {
      quoted = true;
      encoded += c;
      i++;
      continue;
    }
    if (c === '-' || /[0-9]/.test(c)) {
      const match = text.slice(i).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
      if (!match) throw new SyntaxError('Invalid JSON number');
      const token = match[0];
      const n = Number(token);
      encoded +=
        exactInteger.test(token) && Number.isSafeInteger(n) ? token : JSON.stringify(token);
      i += token.length;
      continue;
    }
    encoded += c;
    i++;
  }
  // Validate original grammar as well: quoting tokens must not repair malformed JSON.
  const original = JSON.parse(text);
  const parsed = JSON.parse(encoded, (key, value) => {
    if (
      /[\uD800-\uDFFF]/u.test(key) ||
      (typeof value === 'string' && /[\uD800-\uDFFF]/u.test(value))
    )
      throw new SyntaxError('JSON strings must contain well-formed Unicode');
    return value;
  });
  // The original tree supplies only token kinds, never rounded numeric values.
  const mark = (value: any, source: any): any => {
    if (typeof source === 'number' && typeof value === 'string') return new ParsedNumber(value);
    if (value && typeof value === 'object')
      for (const key of Object.keys(value)) value[key] = mark(value[key], source[key]);
    return value;
  };
  return preserveNumbers ? mark(parsed, original) : parsed;
}
function plainNumbers(value: any): any {
  if (value instanceof ParsedNumber) return value.value;
  if (value && typeof value === 'object')
    for (const key of Object.keys(value)) value[key] = plainNumbers(value[key]);
  return value;
}
/** Expand integral decimal/exponent tokens exactly, with bounded exponent expansion. */
function integerToken(token: string, path: string): string {
  if (exactInteger.test(token)) return token;
  const [coefficient, exponent = '0'] = token.toLowerCase().split('e');
  const fraction = coefficient!.split('.')[1]?.length ?? 0;
  let digits = coefficient!.replace(/^-/, '').replace('.', '').replace(/^0+/, '');
  if (!digits) return '0';
  const shift = Number(exponent) - fraction;
  if (shift < 0) {
    if (-shift >= digits.length || /[1-9]/.test(digits.slice(shift)))
      return bad(path, 'expected an integral JSON number');
    digits = digits.slice(0, shift);
  } else {
    if (shift > 10000) return bad(path, 'integer exponent expansion exceeds 10000 digits');
    digits += '0'.repeat(shift);
  }
  return (token.startsWith('-') ? '-' : '') + digits;
}
function denseArray(value: unknown[], path: string): void {
  for (let i = 0; i < value.length; i++)
    if (!Object.hasOwn(value, i)) bad(`${path}[${i}]`, 'sparse arrays are unsupported');
}
function encode(value: unknown, depth = 0): string {
  if (depth > 256) bad('value', 'value exceeds the supported nesting depth or contains a cycle');
  if (value instanceof Model) return encode(value.toJSON(), depth + 1);
  if (value instanceof RawNumber) return value.value;
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value))
      bad('value', 'use a decimal or integer string for exact numbers');
    return String(value);
  }
  if (Array.isArray(value)) {
    denseArray(value, 'value');
    return '[' + value.map((v) => encode(v, depth + 1)).join(',') + ']';
  }
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => JSON.stringify(k) + ':' + encode(v, depth + 1))
        .join(',') +
      '}'
    );
  return bad('value', 'unsupported JSON value');
}
/** Merge independently validated representations without discarding typed numeric tokens. */
function combine(left: any, right: any, path: string): any {
  if (left instanceof ParsedNumber || right instanceof ParsedNumber) {
    const token = left instanceof ParsedNumber ? left : right;
    const other = left instanceof ParsedNumber ? right : left;
    const text = other instanceof ParsedNumber ? other.value : String(other);
    if (!exactDecimal.test(text) || compareDecimal(token.value, text) !== 0)
      bad(path, 'alternatives have incompatible numeric representations');
    return other;
  }
  if (left instanceof RawNumber || right instanceof RawNumber) {
    const token = left instanceof RawNumber ? left : right;
    const other = left instanceof RawNumber ? right : left;
    if (String(other instanceof RawNumber ? other.value : other) !== token.value)
      bad(path, 'alternatives have incompatible numeric representations');
    return token;
  }
  if (Array.isArray(left) && Array.isArray(right))
    return left.map((v, i) => combine(v, right[i], `${path}[${i}]`));
  if (left && right && typeof left === 'object' && typeof right === 'object')
    return Object.fromEntries(
      [...new Set([...Object.keys(left), ...Object.keys(right)])].map((key) => [
        key,
        Object.hasOwn(left, key) && Object.hasOwn(right, key)
          ? combine(left[key], right[key], `${path}.${key}`)
          : Object.hasOwn(left, key)
            ? left[key]
            : right[key],
      ]),
    );
  if (left === right) return right;
  if (typeof left === 'number' && typeof right === 'string' && String(left) === right) return right;
  if (typeof right === 'number' && typeof left === 'string' && String(right) === left) return left;
  return bad(path, 'alternatives have incompatible representations');
}
/** Requiredness on composed object schemas follows request/response field direction. */
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
// Compare finite decimal tokens without floating-point conversion or expanding
// exponents. Bounds originate in the contract; even enormous caller exponents
// can be ordered against them with bounded memory.
function compareDecimal(left: string, right: string): number {
  const parts = (value: string) => {
    const [coefficient, exponent = '0'] = value.toLowerCase().split('e');
    const negative = coefficient!.startsWith('-');
    const unsigned = coefficient!.replace(/^-/, '');
    const fraction = unsigned.split('.')[1]?.length ?? 0;
    const digits = unsigned.replace('.', '').replace(/^0+/, '');
    const power = Math.max(-1e9, Math.min(1e9, Number(exponent))) - fraction + digits.length;
    return { sign: digits ? (negative ? -1 : 1) : 0, digits, power };
  };
  const a = parts(left),
    b = parts(right);
  if (a.sign !== b.sign) return Math.sign(a.sign - b.sign);
  if (!a.sign) return 0;
  if (a.power !== b.power) return a.sign * Math.sign(a.power - b.power);
  const size = Math.max(a.digits.length, b.digits.length);
  const x = a.digits.padEnd(size, '0'),
    y = b.digits.padEnd(size, '0');
  return a.sign * (x < y ? -1 : x > y ? 1 : 0);
}
function numericConstraints(token: string, s: Schema, path: string, full = true) {
  const ranges: Record<string, [string, string]> = {
    int32: ['-2147483648', '2147483647'],
    uint32: ['0', '4294967295'],
    int64: ['-9223372036854775808', '9223372036854775807'],
    uint64: ['0', '18446744073709551615'],
  };
  const range = ranges[s.format ?? ''];
  if (range && (compareDecimal(token, range[0]) < 0 || compareDecimal(token, range[1]) > 0))
    bad(path, 'value is outside the declared integer format range');
  if (!full) return;
  for (const keyword of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'] as const) {
    if (s[keyword] === undefined) continue;
    const order = compareDecimal(token, String(s[keyword]));
    if (
      (keyword === 'minimum' && order < 0) ||
      (keyword === 'maximum' && order > 0) ||
      (keyword === 'exclusiveMinimum' && order <= 0) ||
      (keyword === 'exclusiveMaximum' && order >= 0)
    )
      bad(path, 'value violates ' + keyword);
  }
}
export function normalize(
  value: unknown,
  s: Schema,
  path = 'input',
  response = false,
  redactFields: string[] = [],
  matching = false,
  definitions: Record<string, Schema> = {},
  depth = 0,
  validateConstraints = true,
): any {
  if (depth > 256) bad(path, 'value exceeds the supported nesting depth (256) or contains a cycle');
  validateConstraints =
    s['x-sdk-validation'] === undefined ? validateConstraints : s['x-sdk-validation'] === 'schema';
  definitions = s['x-sdk-definitions'] ?? definitions;
  if (s['x-sdk-ref']) {
    const target = Object.hasOwn(definitions, s['x-sdk-ref'])
      ? definitions[s['x-sdk-ref']]
      : undefined;
    if (!target) return bad(path, 'unresolved recursive model ' + s['x-sdk-ref']);
    return normalize(
      value,
      target,
      path,
      response,
      redactFields,
      matching,
      definitions,
      depth + 1,
      validateConstraints,
    );
  }
  if (value instanceof Model) value = value.toJSON();
  s = directionalSchema(s, response);
  if (s.allOf || s.anyOf || s.oneOf || s.not) {
    const { allOf, anyOf, oneOf, not, discriminator, ...base } = s;
    let result = normalize(
      value,
      base,
      path,
      response,
      redactFields,
      matching,
      definitions,
      depth + 1,
      validateConstraints,
    );
    const matches = (branch: Schema): boolean => {
      try {
        normalize(
          value,
          branch,
          path,
          response,
          redactFields,
          true,
          definitions,
          depth + 1,
          validateConstraints,
        );
        return true;
      } catch (error) {
        if (error instanceof SdkError && error.kind === 'validation') return false;
        throw error;
      }
    };
    if (not && matches(not)) bad(path, 'value matches a forbidden combination');
    for (const branch of allOf ?? [])
      result = combine(
        result,
        normalize(
          value,
          branch,
          path,
          response,
          redactFields,
          matching,
          definitions,
          depth + 1,
          validateConstraints,
        ),
        path,
      );
    for (const [keyword, branches] of [
      ['oneOf', oneOf],
      ['anyOf', anyOf],
    ] as const) {
      if (!branches) continue;
      let selected: Schema[];
      if (keyword === 'oneOf' && discriminator) {
        const tag = discriminator.propertyName;
        if (
          !value ||
          typeof value !== 'object' ||
          Array.isArray(value) ||
          !Object.hasOwn(value, tag) ||
          typeof (value as any)[tag] !== 'string'
        )
          bad(path, 'expected a string discriminator');
        selected = branches.filter((branch) =>
          branch.properties?.[tag]?.enum?.includes((value as any)[tag]),
        );
      } else selected = branches.filter(matches);
      if (selected.length === 0 && response && !matching) {
        if (
          branches.every((branch) => branch.type === 'object') &&
          (!value || typeof value !== 'object' || Array.isArray(value))
        )
          bad(path, 'expected an object response alternative');
        continue;
      }
      if (!selected.length || (keyword === 'oneOf' && selected.length !== 1))
        bad(
          path,
          keyword === 'oneOf'
            ? 'value must match exactly one alternative'
            : 'value must match at least one alternative',
        );
      for (const branch of selected)
        result = combine(
          result,
          normalize(
            value,
            branch,
            path,
            response,
            redactFields,
            matching,
            definitions,
            depth + 1,
            validateConstraints,
          ),
          path,
        );
    }
    if (
      response &&
      result &&
      typeof result === 'object' &&
      !Array.isArray(result) &&
      !(result instanceof ParsedNumber)
    ) {
      const object = Object.assign(Object.create(null), result);
      Object.defineProperty(object, inspect.custom, {
        value: () => redact(object, s, redactFields, definitions),
      });
      return object;
    }
    return result;
  }
  if (value === null) {
    if ((!response || matching) && s.enum && !s.enum.includes(null))
      bad(path, 'null is outside the declared enum');
    if (
      s.type === undefined ||
      s.type === 'null' ||
      (Array.isArray(s.type) && s.type.includes('null'))
    )
      return null;
    return bad(path, 'null is not permitted');
  }
  const type = Array.isArray(s.type) ? s.type.find((v) => v !== 'null') : s.type;
  if (value instanceof ParsedNumber) {
    if (type === undefined) {
      const token = value.value;
      if (
        matching &&
        s.enum &&
        !s.enum.some((v) => typeof v === 'number' && compareDecimal(token, String(v)) === 0)
      )
        bad(path, 'value is outside the declared enum');
      if (matching) numericConstraints(value.value, s, path);
      return value;
    }
    if (type === 'integer') {
      const token = integerToken(value.value, path);
      value = ['int64', 'uint64'].includes(s.format ?? '') ? token : Number(token);
    } else if (type === 'number') value = value.value;
    else return bad(path, `expected ${type}; received a JSON number`);
  }
  const exactEnum =
    type === 'number' || (type === 'integer' && ['int64', 'uint64'].includes(s.format ?? ''));
  if (
    (!response || matching) &&
    s.enum &&
    !(exactEnum
      ? (typeof value === 'string' || typeof value === 'number') &&
        exactDecimal.test(String(value)) &&
        s.enum.some(
          (member) =>
            typeof member === 'number' && compareDecimal(String(value), String(member)) === 0,
        )
      : s.enum.includes(value as any))
  )
    bad(path, 'value is outside the declared enum');
  if (type === 'integer' || type === 'number') {
    const exact = type === 'number' || ['int64', 'uint64'].includes(s.format ?? '');
    if (exact) {
      const token =
        typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
      if (
        typeof token !== 'string' ||
        !(type === 'integer' ? exactInteger : exactDecimal).test(token)
      )
        return bad(path, 'expected an exact numeric string');
      if (!response || matching)
        numericConstraints(token, s, path, validateConstraints || matching);
      return response ? token : new RawNumber(token);
    }
    if (typeof value !== 'number' || !Number.isSafeInteger(value))
      return bad(path, 'expected a safe integer; declare int64 for larger values');
    if (!response || matching)
      numericConstraints(String(value), s, path, validateConstraints || matching);
    return value;
  }
  if (type === 'null') return bad(path, 'expected null');
  if (
    type === 'object' ||
    (type === undefined && value && typeof value === 'object' && !Array.isArray(value))
  ) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return bad(path, 'expected an object');
    const entries = value as Record<string, unknown>;
    for (const k of s.required ?? [])
      if (response ? !s.properties?.[k]?.writeOnly : !s.properties?.[k]?.readOnly)
        if (!Object.hasOwn(entries, k) || entries[k] === undefined)
          bad(`${path}.${k}`, 'required field is missing');
    const out: Record<string, unknown> = Object.create(null);
    for (const [k, v] of Object.entries(entries)) {
      if (v === undefined && !response) continue;
      const child = Object.hasOwn(s.properties ?? {}, k) ? s.properties![k] : undefined;
      if (!response && child?.readOnly) bad(`${path}.${k}`, 'readOnly fields cannot be sent');
      if (child)
        out[k] = normalize(
          v,
          child,
          `${path}.${k}`,
          response,
          redactFields,
          matching,
          definitions,
          depth + 1,
          validateConstraints,
        );
      else if (!response && s.additionalProperties === false)
        bad(`${path}.${k}`, 'unknown request field');
      else if (typeof s.additionalProperties === 'object')
        out[k] = normalize(
          v,
          s.additionalProperties,
          `${path}.${k}`,
          response,
          redactFields,
          matching,
          definitions,
          depth + 1,
          validateConstraints,
        );
      else out[k] = v;
    }
    if (response)
      Object.defineProperty(out, inspect.custom, {
        value: () => redact(out, s, redactFields, definitions),
        enumerable: false,
      });
    return out;
  }
  if (type === 'array' || (type === undefined && Array.isArray(value))) {
    if (!Array.isArray(value)) return bad(path, 'expected an array');
    denseArray(value, path);
    if ((!response || matching) && (validateConstraints || matching)) {
      if (s.minItems !== undefined && value.length < s.minItems)
        bad(path, 'array violates minItems');
      if (s.maxItems !== undefined && value.length > s.maxItems)
        bad(path, 'array violates maxItems');
    }
    return value.map((v, i) =>
      normalize(
        v,
        s.items ?? {},
        `${path}[${i}]`,
        response,
        redactFields,
        matching,
        definitions,
        depth + 1,
        validateConstraints,
      ),
    );
  }
  if (type === 'string' && typeof value !== 'string') return bad(path, 'expected a string');
  if (typeof value === 'string' && (!response || matching)) {
    if (/[\uD800-\uDFFF]/u.test(value)) bad(path, 'expected well-formed Unicode');
    if (validateConstraints || matching) {
      const length = [...value].length;
      if (s.minLength !== undefined && length < s.minLength) bad(path, 'string violates minLength');
      if (s.maxLength !== undefined && length > s.maxLength) bad(path, 'string violates maxLength');
      if (s.pattern !== undefined && !new RegExp(s.pattern, 'u').test(value))
        bad(path, 'string violates pattern');
    }
  }
  if (type === undefined && typeof value === 'number' && (!response || matching))
    numericConstraints(String(value), s, path, validateConstraints || matching);
  if (type === 'boolean' && typeof value !== 'boolean') return bad(path, 'expected a boolean');
  return value;
}
export function serialize(value: unknown, schema: Schema): string {
  return encode(normalize(value, schema));
}
export function isKnownVariant(value: unknown, schema: Schema): boolean {
  if (!schema.oneOf && !schema.anyOf) return false;
  const tag = schema.discriminator?.propertyName;
  if (
    tag &&
    (!value ||
      typeof value !== 'object' ||
      !Object.hasOwn(value, tag) ||
      !schema.oneOf!.some((branch) =>
        branch.properties?.[tag]?.enum?.includes((value as any)[tag]),
      ))
  )
    return false;
  try {
    normalize(value, schema, 'response', true, [], true);
    return true;
  } catch {
    return false;
  }
}
export function redact(
  value: unknown,
  schema?: Schema,
  fields: string[] = [],
  definitions: Record<string, Schema> = {},
  depth = 0,
): unknown {
  if (depth > 256) return '[Nesting limit]';
  definitions = schema?.['x-sdk-definitions'] ?? definitions;
  if (schema?.['x-sdk-ref']) {
    const target = definitions[schema['x-sdk-ref']];
    return target ? redact(value, target, fields, definitions, depth + 1) : '[Unresolved model]';
  }
  const shapes = (s?: Schema): Schema[] =>
    s?.['x-sdk-ref']
      ? shapes(definitions[s['x-sdk-ref']])
      : s
        ? [s, ...[...(s.allOf ?? []), ...(s.anyOf ?? []), ...(s.oneOf ?? [])].flatMap(shapes)]
        : [];
  const schemas = shapes(schema);
  if (schemas.some((s) => s['x-sensitive'] || s.writeOnly)) return '[REDACTED]';
  if (Array.isArray(value))
    return value.map((v) =>
      redact(
        v,
        { allOf: schemas.flatMap((s) => (s.items ? [s.items] : [])) },
        fields,
        definitions,
        depth + 1,
      ),
    );
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        fields.includes(k) || /authorization|token|secret|password|api.?key/i.test(k)
          ? '[REDACTED]'
          : redact(
              v,
              {
                allOf: schemas.flatMap((s) =>
                  Object.hasOwn(s.properties ?? {}, k)
                    ? [s.properties![k]!]
                    : typeof s.additionalProperties === 'object'
                      ? [s.additionalProperties]
                      : [],
                ),
              },
              fields,
              definitions,
              depth + 1,
            ),
      ]),
    );
  return value;
}
/** Plain inputs and validated model factories may be composed at any depth. */
export type InputValue<T> =
  | T
  | Model<T>
  | (T extends readonly (infer Item)[]
      ? InputValue<Item>[]
      : T extends object
        ? { [Key in keyof T]: InputValue<T[Key]> }
        : never);
export class Model<T = unknown> {
  private readonly value: T;
  constructor(
    value: InputValue<T>,
    private readonly schema: Schema,
  ) {
    const unwrap = (v: any, depth = 0): any => {
      if (depth > 256)
        bad('value', 'value exceeds the supported nesting depth or contains a cycle');
      if (v instanceof Model) return unwrap(v.toJSON(), depth + 1);
      if (v instanceof RawNumber) return v.value;
      if (Array.isArray(v)) return v.map((child) => unwrap(child, depth + 1));
      if (v && typeof v === 'object')
        return Object.assign(
          Object.create(null),
          Object.fromEntries(
            Object.entries(v).map(([key, child]) => [key, unwrap(child, depth + 1)]),
          ),
        );
      return v;
    };
    this.value = unwrap(normalize(value, schema)) as T;
  }
  toJSON() {
    return this.value;
  }
  [inspect.custom]() {
    return redact(this.value, this.schema);
  }
}
const field = (value: any, path: string): any =>
  path
    .split('.')
    .reduce((v, key) => (v != null && Object.hasOwn(v, key) ? v[key] : undefined), value);
const encoded = (s: string): string =>
  encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
function scalar(v: unknown): string {
  return v instanceof RawNumber ? v.value : String(v);
}
function positive(v: number, label: string): number {
  if (!Number.isFinite(v) || v <= 0) bad(label, 'must be a positive finite number');
  return v;
}
function stopped(signal?: AbortSignal, outcome: 'unknown' | 'not_sent' = 'unknown') {
  if (signal?.aborted)
    throw new SdkError(
      'cancelled',
      'Local request cancelled; this does not cancel the remote operation',
      outcome,
    );
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(new Error('HTTP attempt aborted'));
    };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}
async function delay(ms: number, signal?: AbortSignal) {
  stopped(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', cancel);
      resolve();
    }, ms);
    const cancel = () => {
      clearTimeout(timer);
      reject(new SdkError('cancelled', 'Local waiting cancelled', 'unknown'));
    };
    signal?.addEventListener('abort', cancel, { once: true });
  });
}
export class Runtime {
  private readonly options: ClientOptions;
  private readonly base: URL;
  private readonly allowed: Set<string>;
  constructor(
    private readonly contract: RuntimeContract,
    options: ClientOptions,
  ) {
    const attach = (schema: Schema): Schema => ({
      ...schema,
      'x-sdk-validation': contract.validation ?? 'schema',
      ...(contract.definitions ? { 'x-sdk-definitions': contract.definitions } : {}),
    });
    this.contract = {
      ...contract,
      operations: contract.operations.map((op) => ({
        ...op,
        parameters: op.parameters.map((p) => ({ ...p, schema: attach(p.schema) })),
        ...(op.body ? { body: attach(op.body) } : {}),
        responses: Object.fromEntries(
          Object.entries(op.responses).map(([status, response]) => [
            status,
            { ...response, ...(response.schema ? { schema: attach(response.schema) } : {}) },
          ]),
        ),
      })),
      ...(contract.webhook
        ? {
            webhook: {
              ...contract.webhook,
              events: Object.fromEntries(
                Object.entries(contract.webhook.events).map(([name, schema]) => [
                  name,
                  attach(schema),
                ]),
              ),
            },
          }
        : {}),
    };
    this.options = { ...options };
    if (/[\\\r\n]/.test(options.baseUrl)) bad('baseUrl', 'invalid URL');
    this.base = new URL(options.baseUrl.endsWith('/') ? options.baseUrl : options.baseUrl + '/');
    if (this.base.search || this.base.hash)
      bad('baseUrl', 'base URL must not contain a query or fragment');
    this.allowed = new Set(options.allowedOrigins ?? [this.base.origin]);
    this.checkUrl(this.base);
    positive(options.timeoutMs ?? 10000, 'timeoutMs');
    positive(options.deadlineMs ?? 30000, 'deadlineMs');
  }
  [inspect.custom]() {
    return { baseUrl: this.base.origin, credentials: '[REDACTED]' };
  }
  private checkUrl(url: URL) {
    if (
      url.username ||
      url.password ||
      url.hash ||
      !['https:', ...(this.options.allowInsecureHttp ? ['http:'] : [])].includes(url.protocol) ||
      !this.allowed.has(url.origin)
    )
      throw new SdkError('destination', 'Destination is outside the explicit credential policy');
  }
  async request<T = unknown>(
    id: string,
    input: Record<string, unknown> = {},
    options: RequestOptions = {},
    continuation?: string,
  ): Promise<Result<T>> {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      bad('input', 'expected an object');
    if (!options || typeof options !== 'object' || Array.isArray(options))
      bad('options', 'expected an object');
    const op = this.contract.operations.find((v) => v.id === id);
    if (!op) return bad('operation', 'operation is not included in this SDK');
    const start = performance.now();
    const deadline =
      start + positive(options.deadlineMs ?? this.options.deadlineMs ?? 30000, 'deadlineMs');
    const timeout = positive(options.timeoutMs ?? this.options.timeoutMs ?? 10000, 'timeoutMs');
    const policy = op.retry ?? { maxAttempts: 1, statuses: [], transport: false, baseDelayMs: 100 };
    const attempts = options.maxAttempts ?? this.options.maxAttempts ?? policy.maxAttempts;
    if (!Number.isInteger(attempts) || attempts < 1 || attempts > policy.maxAttempts)
      bad('maxAttempts', 'must be within the provider-declared retry limit');
    const headers: Record<string, string> = Object.assign(Object.create(null), {
      accept: 'application/json',
      'user-agent': this.contract.userAgent ?? 'PublicSDK (Node.js)',
    });
    const setHeader = (name: string, value: string) => {
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\r\n]/.test(value))
        bad('headers', 'invalid HTTP header');
      const existing = headers[name.toLowerCase()];
      if (
        op.idempotency?.header.toLowerCase() === name.toLowerCase() &&
        existing !== undefined &&
        existing !== value
      )
        bad(
          'idempotencyKey',
          'conflicting keys were supplied through input headers or request options',
        );
      headers[name.toLowerCase()] = value;
    };
    let path = op.path;
    const query: string[] = [];
    for (const p of op.parameters) {
      const value = Object.hasOwn(input, p.name) ? input[p.name] : undefined;
      if (value === undefined) {
        if (p.required) bad(p.name, 'required parameter is missing');
        continue;
      }
      const normalized = normalize(value, p.schema, p.name);
      const values = Array.isArray(normalized) ? normalized.map(scalar) : [scalar(normalized)];
      if (p.in === 'path') {
        if (values.some((v) => v === '.' || v === '..'))
          bad(p.name, 'dot path segments are unsupported');
        path = path.replaceAll(`{${p.name}}`, values.map(encoded).join(','));
      }
      if (p.in === 'query') {
        if (Array.isArray(normalized) && p.explode !== false)
          for (const v of values) query.push(encoded(p.name) + '=' + encoded(v));
        else query.push(encoded(p.name) + '=' + values.map(encoded).join(','));
      }
      if (p.in === 'header') setHeader(p.name, values.join(','));
    }
    const url = continuation
      ? new URL(continuation, this.base)
      : new URL(
          this.base.href.replace(/\/$/, '') + path + (query.length ? '?' + query.join('&') : ''),
        );
    this.checkUrl(url);
    for (const [k, v] of Object.entries(options.headers ?? {})) setHeader(k, v);
    if (op.authenticated || (op.optionalAuthentication && this.options.token)) {
      if (!this.options.token || !this.contract.auth)
        throw new SdkError('authentication', 'Explicit API credentials are required');
      setHeader(
        this.contract.auth.header,
        this.contract.auth.type === 'bearer' ? `Bearer ${this.options.token}` : this.options.token,
      );
    }
    if (this.contract.apiVersion)
      setHeader(this.contract.apiVersion.header, this.contract.apiVersion.value);
    if (options.ifMatch !== undefined) {
      if (!op.conditional) bad('ifMatch', 'operation does not declare conditional requests');
      setHeader(op.conditional!.header, options.ifMatch);
    }
    const key =
      options.idempotencyKey ??
      (op.idempotency ? headers[op.idempotency.header.toLowerCase()] : undefined) ??
      (op.idempotency?.auto ? randomUUID() : undefined);
    if (key !== undefined) {
      if (!op.idempotency || !key)
        bad('idempotencyKey', 'a nonempty key and declared capability are required');
      setHeader(op.idempotency!.header, key);
    }
    const safe =
      ['GET', 'HEAD', 'OPTIONS'].includes(op.verb) ||
      Boolean(op.idempotency && headers[op.idempotency.header.toLowerCase()]);
    if (attempts > 1 && !safe)
      bad(
        'idempotencyKey',
        'persist and supply an idempotency key before enabling mutation retries',
      );
    let body: string | undefined;
    if (Object.hasOwn(input, 'body') && input.body !== undefined) {
      if (!op.body) bad('body', 'operation does not accept a body');
      if (['GET', 'HEAD'].includes(op.verb))
        bad('body', 'GET/HEAD request bodies are unsupported by the Node transport');
      body = serialize(input.body, op.body!);
      setHeader('content-type', op.mediaType!);
    } else if (op.bodyRequired) bad('body', 'required body is missing');
    for (const key of Object.keys(input))
      if (key !== 'body' && !op.parameters.some((p) => p.name === key))
        bad(key, 'unknown input parameter');
    const transport = this.options.transport ?? fetch;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      stopped(options.signal, attempt === 1 ? 'not_sent' : 'unknown');
      const remaining = deadline - performance.now();
      if (remaining <= 0)
        throw new SdkError(
          'deadline',
          'Overall deadline exceeded',
          attempt === 1 ? 'not_sent' : 'unknown',
        );
      const controller = new AbortController();
      const abort = () => controller.abort();
      options.signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, Math.min(timeout, remaining));
      let retryAfter = 0;
      let error: SdkError | undefined;
      let diagnosticMeta: Metadata | undefined;
      let diagnosticError: ErrorKind | undefined;
      try {
        const response = await abortable(
          transport(url, {
            method: op.verb,
            headers: { ...headers },
            ...(body === undefined ? {} : { body }),
            signal: controller.signal,
            redirect: 'manual',
          }),
          controller.signal,
        );
        const responseHeaders = Object.fromEntries(response.headers.entries());
        const meta: Metadata = {
          status: response.status,
          headers: responseHeaders,
          attempts: attempt,
          durationMs: performance.now() - start,
          url: url.href,
          ...(response.headers.get(this.contract.errors?.requestIdHeader ?? 'x-request-id')
            ? {
                requestId: response.headers.get(
                  this.contract.errors?.requestIdHeader ?? 'x-request-id',
                )!,
              }
            : {}),
        };
        diagnosticMeta = meta;
        const bytes = await abortable(response.arrayBuffer(), controller.signal);
        let raw = Buffer.from(bytes).toString('utf8');
        meta.durationMs = performance.now() - start;
        let data: any;
        try {
          raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
          data = raw ? parseJson(raw, response.ok || response.status === 304) : undefined;
        } catch (cause) {
          if (response.ok)
            throw new SdkError(
              'protocol',
              'Invalid JSON success response',
              'response',
              false,
              meta,
              undefined,
              undefined,
              { cause },
              raw,
            );
        }
        if (response.status >= 300 && response.status < 400 && response.status !== 304)
          throw new SdkError(
            'destination',
            'Redirects are not followed; explicitly configure an approved endpoint',
            'response',
            false,
            meta,
          );
        if (response.ok || response.status === 304) {
          const declared = op.responses[String(response.status)] ?? op.responses.default;
          if (!declared)
            throw new SdkError('protocol', 'Undeclared success status', 'response', false, meta);
          try {
            if (declared.schema) {
              if (data === undefined) throw new Error('Missing body');
              data = plainNumbers(
                normalize(data, declared.schema, 'response', true, this.options.redactFields),
              );
            } else if (raw) throw new Error('Unexpected body for an empty response');
          } catch (cause) {
            throw new SdkError(
              'protocol',
              'Response cannot be represented by the declared schema',
              'response',
              false,
              meta,
              undefined,
              undefined,
              { cause },
              raw,
            );
          }
          const result = { data: data as T, meta, raw };
          Object.defineProperty(result, inspect.custom, {
            value: () => ({
              data: redact(data, declared.schema, this.options.redactFields),
              meta: {
                status: meta.status,
                requestId: meta.requestId,
                attempts: meta.attempts,
                durationMs: meta.durationMs,
              },
            }),
          });
          return result;
        }
        const kind: ErrorKind = [401, 403].includes(response.status)
          ? 'authentication'
          : response.status === 429
            ? 'rate_limit'
            : [400, 422].includes(response.status)
              ? 'validation'
              : [409, 412].includes(response.status)
                ? 'conflict'
                : 'api';
        const code = field(data, this.contract.errors?.codePath ?? 'code');
        const eligible =
          safe &&
          (policy.statuses.includes(response.status) ||
            (typeof code === 'string' &&
              (policy.errors ?? []).some(
                (rule) => rule.status === response.status && rule.codes.includes(code),
              )));
        error = new SdkError(
          kind,
          `API returned HTTP ${response.status}`,
          'response',
          eligible,
          meta,
          typeof code === 'string' ? code : undefined,
          this.contract.errors?.detailsPath
            ? field(
                redact(
                  data,
                  (op.responses[String(response.status)] ?? op.responses.default)?.schema,
                  this.options.redactFields,
                ),
                this.contract.errors.detailsPath,
              )
            : redact(
                data,
                (op.responses[String(response.status)] ?? op.responses.default)?.schema,
                this.options.redactFields,
              ),
          undefined,
          raw,
        );
        diagnosticError = kind;
        const instruction = response.headers.get('retry-after');
        if (instruction) {
          const seconds = /^\d+(\.\d+)?$/.test(instruction)
            ? Number(instruction) * 1000
            : Date.parse(instruction) - Date.now();
          if (Number.isFinite(seconds)) retryAfter = Math.max(0, seconds);
        }
      } catch (cause) {
        if (cause instanceof SdkError) {
          diagnosticError = cause.kind;
          throw cause;
        }
        diagnosticError = options.signal?.aborted
          ? 'cancelled'
          : performance.now() >= deadline
            ? 'deadline'
            : 'transport';
        stopped(options.signal);
        error = new SdkError(
          performance.now() >= deadline ? 'deadline' : 'transport',
          'Request did not produce a usable response; remote outcome is unknown',
          'unknown',
          safe && policy.transport,
          diagnosticMeta,
          undefined,
          undefined,
          { cause },
        );
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        try {
          this.options.diagnostics?.({
            operation: id,
            attempt,
            durationMs: performance.now() - start,
            ...(diagnosticMeta
              ? {
                  status: diagnosticMeta.status,
                  ...(diagnosticMeta.requestId ? { requestId: diagnosticMeta.requestId } : {}),
                }
              : {}),
            ...(diagnosticError ? { errorKind: diagnosticError } : {}),
          });
        } catch {
          /* Diagnostics cannot change an operation's outcome. */
        }
      }
      if (!error?.retryAllowed || attempt >= attempts || performance.now() >= deadline) throw error;
      const wait = Math.max(retryAfter, Math.random() * policy.baseDelayMs * 2 ** (attempt - 1));
      if (performance.now() + wait >= deadline)
        throw new SdkError(
          'deadline',
          'Retry wait would exceed the overall deadline',
          error.outcome,
          error.retryAllowed,
          error.meta,
        );
      await delay(wait, options.signal);
    }
    throw new Error('Unreachable retry state');
  }
  async *pages<T = unknown>(
    id: string,
    input: Record<string, unknown> = {},
    options: RequestOptions = {},
  ): AsyncGenerator<Result<T>> {
    const op = this.contract.operations.find((v) => v.id === id);
    if (!op?.pagination) return bad('pagination', 'capability is not declared');
    const p = op.pagination;
    let next: unknown;
    let previous: unknown;
    const request = { ...input };
    const deadline =
      performance.now() +
      positive(options.deadlineMs ?? this.options.deadlineMs ?? 30000, 'deadlineMs');
    const limit = options.maxPages ?? Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(limit) || limit < 1)
      bad('maxPages', 'must be a positive safe integer');
    for (let page = 0; page < limit; page++) {
      stopped(options.signal);
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new SdkError('deadline', 'Pagination deadline exceeded', 'unknown');
      const result = await this.request<T>(
        id,
        request,
        { ...options, deadlineMs: remaining },
        p.kind === 'link' && typeof next === 'string' ? next : undefined,
      );
      yield result;
      previous = next;
      next = field(result.data, p.next);
      if (next === undefined || next === null || next === '') return;
      if (p.kind === 'link' && typeof next !== 'string')
        throw new SdkError('protocol', 'Expected a pagination URL', 'response');
      if (p.kind === 'link') next = new URL(next as string, result.meta.url ?? this.base).href;
      if (next === previous || (p.kind === 'link' && next === result.meta.url))
        throw new SdkError(
          'protocol',
          'Pagination returned a non-advancing continuation',
          'response',
        );
      if (p.kind !== 'link') request[p.parameter!] = next;
    }
  }
  async *items<T = unknown>(
    id: string,
    input: Record<string, unknown> = {},
    options: RequestOptions = {},
  ): AsyncGenerator<T> {
    const p = this.contract.operations.find((v) => v.id === id)?.pagination;
    if (!p) return bad('pagination', 'capability is not declared');
    const limit = options.maxItems ?? Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(limit) || limit < 1)
      bad('maxItems', 'must be a positive safe integer');
    let count = 0;
    for await (const page of this.pages(id, input, options)) {
      const values = field(page.data, p.items);
      if (!Array.isArray(values))
        throw new SdkError('protocol', 'Pagination items field is not an array', 'response');
      for (const value of values) {
        stopped(options.signal);
        yield value as T;
        if (++count >= limit) return;
      }
    }
  }
  async wait<T = unknown>(
    id: string,
    input: Record<string, unknown>,
    options: RequestOptions = {},
  ): Promise<Result<T>> {
    const p = this.contract.operations.find((v) => v.id === id)?.polling;
    if (!p) return bad('polling', 'capability is not declared');
    const deadline =
      performance.now() +
      positive(options.deadlineMs ?? this.options.deadlineMs ?? 30000, 'deadlineMs');
    let interval = p.intervalMs;
    for (;;) {
      const remaining = deadline - performance.now();
      if (remaining <= 0)
        throw new SdkError(
          'deadline',
          'Polling deadline exceeded; remote operation may still be running',
          'unknown',
        );
      const result = await this.request<T>(id, input, { ...options, deadlineMs: remaining });
      const state = field(result.data, p.state);
      if (p.success.includes(state)) return result;
      if (p.failure.includes(state))
        throw new SdkError(
          'api',
          'Operation reached a declared failure state',
          'response',
          false,
          result.meta,
        );
      await delay(Math.min(interval, Math.max(0, deadline - performance.now())), options.signal);
      interval = Math.min(interval * 1.5, 10000);
    }
  }
  verifyWebhook(
    rawBody: Uint8Array,
    headers: Record<string, string>,
    secrets: string[],
    nowSeconds = Date.now() / 1000,
  ): { event: unknown; known: boolean } {
    const w = this.contract.webhook;
    if (!w) return bad('webhook', 'capability is not declared');
    const normalized = Object.fromEntries(
      Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
    );
    let timestamp = normalized[w.timestampHeader?.toLowerCase() ?? ''] ?? '';
    const signature = normalized[w.header.toLowerCase()] ?? '';
    const format = w.format ?? 'hex';
    let candidates = [signature];
    let prefix = '';
    if (format === 'timestamped-hex') {
      const parts = signature.split(',').map((part) => part.trim());
      const timestamps = parts.filter((part) => part.startsWith('t='));
      timestamp = timestamps.length === 1 ? timestamps[0]!.slice(2) : '';
      candidates = parts.filter((part) => part.startsWith('v1=')).map((part) => part.slice(3));
    } else if (format === 'standard-webhooks') {
      const id = normalized[w.idHeader!.toLowerCase()]?.trim();
      if (!id) throw new SdkError('authentication', 'Invalid webhook signature or timestamp');
      prefix = id + '.';
      candidates = signature
        .trim()
        .split(/\s+/)
        .filter((part) => part.startsWith('v1,'))
        .map((part) => part.slice(3));
    }
    if (
      !/^\d+$/.test(timestamp) ||
      !Number.isSafeInteger(Number(timestamp)) ||
      !Number.isFinite(nowSeconds) ||
      Math.abs(nowSeconds - Number(timestamp)) > w.toleranceSeconds ||
      !secrets.length
    )
      throw new SdkError('authentication', 'Invalid webhook signature or timestamp');
    const signed = Buffer.concat([
      Buffer.from(prefix + timestamp + w.separator),
      Buffer.from(rawBody),
    ]);
    const signatures = candidates
      .filter((candidate) =>
        format === 'standard-webhooks'
          ? /^[A-Za-z0-9+/]{43}=$/.test(candidate) &&
            Buffer.from(candidate, 'base64').toString('base64') === candidate
          : /^[a-fA-F0-9]{64}$/.test(candidate),
      )
      .map((candidate) =>
        Buffer.from(candidate, format === 'standard-webhooks' ? 'base64' : 'hex'),
      );
    let valid = false;
    for (const secret of secrets) {
      if (!secret) continue;
      let key: string | Buffer = secret;
      if (format === 'standard-webhooks') {
        if (!/^whsec_[A-Za-z0-9+/]{43}=$/.test(secret)) continue;
        key = Buffer.from(secret.slice(6), 'base64');
        if (key.length !== 32 || key.toString('base64') !== secret.slice(6)) continue;
      }
      const expected = createHmac('sha256', key).update(signed).digest();
      for (const actual of signatures) valid = timingSafeEqual(expected, actual) || valid;
    }
    if (!valid) throw new SdkError('authentication', 'Invalid webhook signature or timestamp');
    let event: any;
    try {
      event = parseJson(
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.from(rawBody)),
        true,
      );
    } catch (cause) {
      throw new SdkError(
        'protocol',
        'Invalid webhook JSON',
        'response',
        false,
        undefined,
        undefined,
        undefined,
        { cause },
      );
    }
    const eventType = field(event, w.typeField);
    const schema =
      typeof eventType === 'string' && Object.hasOwn(w.events, eventType)
        ? w.events[eventType]
        : undefined;
    return {
      event: plainNumbers(
        schema ? normalize(event, schema, 'event', true, this.options.redactFields) : event,
      ),
      known: Boolean(schema),
    };
  }
  money(currency: string, major: string): { currency: string; amount: string } {
    const currencies = this.contract.money?.currencies;
    const digits =
      currencies && Object.hasOwn(currencies, currency) ? currencies[currency] : undefined;
    if (digits === undefined) return bad('currency', 'currency is not declared by this provider');
    if (!/^-?(0|[1-9]\d*)(\.\d+)?$/.test(major))
      return bad('amount', 'expected an exact decimal string');
    const negative = major.startsWith('-');
    const [whole, fraction = ''] = major.replace(/^-/, '').split('.');
    if (fraction.length > digits)
      return bad('amount', 'unsupported precision; rounding must be explicit in application code');
    const amount = BigInt(whole! + fraction.padEnd(digits, '0')) * (negative ? -1n : 1n);
    return { currency, amount: amount.toString() };
  }
}
