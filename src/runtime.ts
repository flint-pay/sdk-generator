import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { inspect } from 'node:util';
import type { Schema } from './contract.js';
import {
  compileRuntimePlan,
  assertRuntimePlan,
  type RuntimeContract,
  type CompiledRuntimePlan,
} from './runtime-plan.js';
export type { RuntimeContract } from './runtime-plan.js';
export type { Operation, Schema } from './contract.js';
import { compileCodec, ANY_CODEC, exactValue, wireKind, type CodecPlan } from './codec-plan.js';
export { directionalSchema } from './codec-plan.js';

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
  raw: T extends Uint8Array ? Uint8Array : string;
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
  streamIdleTimeoutMs?: number;
  streamLifetimeMs?: number;
  authMode?: string;
  credentials?: Record<string, string>;
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
  authMode?: string;
  credentials?: Record<string, Record<string, string>>;
  allowedOrigins?: string[];
  allowInsecureHttp?: boolean;
  timeoutMs?: number;
  deadlineMs?: number;
  maxAttempts?: number;
  transport?: typeof fetch;
  diagnostics?: (event: DiagnosticEvent) => void;
  redactFields?: string[];
}
export interface ServerSentEvent {
  event: string;
  id: string;
  data: unknown;
  rawData: string;
  retry?: number;
}

type ScheduledTimer = { cancel(): void };

// Node truncates delays above 2^31-1 to one millisecond. Keep the actual
// monotonic deadline and schedule bounded chunks, including for retry waits.
function schedule(callback: () => void, duration: number): ScheduledTimer {
  const deadline = performance.now() + duration;
  let timer: ReturnType<typeof setTimeout>;
  const tick = () => {
    const remaining = deadline - performance.now();
    if (remaining <= 0) callback();
    else timer = setTimeout(tick, Math.min(2147483647, Math.ceil(remaining)));
  };
  timer = setTimeout(tick, Math.min(2147483647, Math.max(0, Math.ceil(duration))));
  return { cancel: () => clearTimeout(timer) };
}

function inspectedMetadata(meta: Metadata) {
  return {
    status: meta.status,
    requestId: meta.requestId,
    attempts: meta.attempts,
    durationMs: meta.durationMs,
  };
}

/** A single-consumer stream. Breaking iteration releases the response connection. */
export class EventStream implements AsyncIterable<ServerSentEvent> {
  private closed = false;
  private started = false;
  private failure: SdkError | undefined;
  private lifetime: ScheduledTimer | undefined;
  private readonly abort = () => {
    this.failure = new SdkError('cancelled', 'Stream cancelled', 'response', false, this.meta);
    void this.close();
  };
  constructor(
    private readonly reader: ReadableStreamDefaultReader<Uint8Array>,
    readonly meta: Metadata,
    private readonly settings: {
      idleTimeoutMs: number;
      maxEventBytes: number;
      lifetimeMs?: number;
      signal?: AbortSignal;
    },
    private readonly decodeEvent: (event: string, data: string) => unknown = (_event, data) => data,
    private readonly released: () => void = () => {},
  ) {
    settings.signal?.addEventListener('abort', this.abort, { once: true });
    if (settings.signal?.aborted) this.abort();
    if (settings.lifetimeMs)
      this.lifetime = schedule(() => {
        this.failure = new SdkError(
          'deadline',
          'Stream lifetime exceeded',
          'response',
          false,
          this.meta,
        );
        void this.close();
      }, settings.lifetimeMs);
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.lifetime?.cancel();
    this.settings.signal?.removeEventListener('abort', this.abort);
    this.released();
    await this.reader.cancel().catch(() => {});
  }
  [inspect.custom]() {
    return { meta: inspectedMetadata(this.meta), closed: this.closed };
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<ServerSentEvent> {
    if (this.started) throw new SdkError('validation', 'A stream can only be consumed once');
    this.started = true;
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    let firstCharacter = true;
    let line = '',
      data = '',
      event = '',
      id = '',
      skipLF = false,
      bytes = 0;
    let retry: number | undefined;
    const consumeLine = (): ServerSentEvent | undefined => {
      if (line === '') {
        const frame =
          data === ''
            ? undefined
            : {
                event: event || 'message',
                id,
                rawData: data.slice(0, -1),
                data: this.decodeEvent(event || 'message', data.slice(0, -1)),
                ...(retry !== undefined ? { retry } : {}),
              };
        if (frame)
          Object.defineProperty(frame, inspect.custom, {
            value: () => ({ event: frame.event }),
          });
        data = '';
        event = '';
        bytes = 0;
        return frame;
      }
      if (!line.startsWith(':')) {
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'data') data += value + '\n';
        else if (field === 'event') event = value;
        else if (field === 'id' && !value.includes('\0')) id = value;
        else if (field === 'retry' && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)))
          retry = Number(value);
      }
      line = '';
      return undefined;
    };
    try {
      while (!this.closed) {
        let timer: ScheduledTimer | undefined;
        const next = await Promise.race([
          this.reader.read(),
          new Promise<never>((_resolve, reject) => {
            timer = schedule(
              () =>
                reject(
                  new SdkError(
                    'deadline',
                    'Stream idle timeout exceeded',
                    'response',
                    false,
                    this.meta,
                  ),
                ),
              this.settings.idleTimeoutMs,
            );
          }),
        ]).finally(() => timer?.cancel());
        if (this.failure) throw this.failure;
        if (next.done) {
          decoder.decode();
          break;
        }
        const text = decoder.decode(next.value, { stream: true });
        for (const character of text) {
          if (this.closed) break;
          if (firstCharacter) {
            firstCharacter = false;
            if (character === '\ufeff') {
              bytes = 3;
              if (bytes > this.settings.maxEventBytes)
                throw new SdkError(
                  'protocol',
                  'SSE event exceeds configured size limit',
                  'response',
                );
              continue;
            }
          }
          if (skipLF) {
            skipLF = false;
            if (character === '\n') continue;
          }
          if (character === '\r' || character === '\n') {
            if (++bytes > this.settings.maxEventBytes)
              throw new SdkError(
                'protocol',
                'SSE event exceeds configured size limit',
                'response',
                false,
                this.meta,
              );
            skipLF = character === '\r';
            const frame = consumeLine();
            if (frame) yield frame;
          } else {
            bytes += Buffer.byteLength(character);
            if (bytes > this.settings.maxEventBytes)
              throw new SdkError(
                'protocol',
                'SSE event exceeds configured size limit',
                'response',
                false,
                this.meta,
              );
            line += character;
          }
        }
      }
      if (this.failure) throw this.failure;
    } catch (cause) {
      if (cause instanceof SdkError && cause.kind !== 'validation') throw cause;
      throw new SdkError(
        'protocol',
        'Invalid or interrupted SSE stream',
        'response',
        false,
        this.meta,
        undefined,
        undefined,
        { cause },
      );
    } finally {
      await this.close();
    }
  }
}
const bad = (path: string, reason: string): never => {
  throw new SdkError('validation', `${path}: ${reason}`);
};
const exactInteger = /^-?(?:0|[1-9]\d*)$/;
const exactDecimal = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
class RawNumber {
  constructor(readonly value: string) {}
}
// JSON numeric meaning, established by the wire parser or a positive codec declaration.
class ParsedNumber {
  constructor(readonly value: string) {}
}
/** An explicit JSON number for inputs whose schema also permits JSON strings. */
export class ExactNumber extends ParsedNumber {
  constructor(value: string) {
    if (typeof value !== 'string' || !exactDecimal.test(value))
      bad('ExactNumber', 'expected a JSON number token');
    super(value);
    Object.freeze(this);
  }
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
function combine(left: any, right: any, path: string, source: unknown): any {
  if (left instanceof ParsedNumber || right instanceof ParsedNumber) {
    const token = left instanceof ParsedNumber ? left : right;
    const other = left instanceof ParsedNumber ? right : left;
    const text =
      other instanceof ParsedNumber || other instanceof RawNumber ? other.value : String(other);
    if (!exactDecimal.test(text) || compareDecimal(token.value, text) !== 0)
      bad(path, 'alternatives have incompatible numeric representations');
    return other instanceof RawNumber ? new RawNumber(token.value) : other;
  }
  if (left instanceof RawNumber || right instanceof RawNumber) {
    const token = left instanceof RawNumber ? left : right;
    const other = left instanceof RawNumber ? right : left;
    const text = other instanceof RawNumber ? other.value : String(other);
    if (!exactDecimal.test(text) || compareDecimal(token.value, text) !== 0)
      bad(path, 'alternatives have incompatible numeric representations');
    return token;
  }
  // Decoding can unwrap both numeric tokens into SDK strings before a later
  // branch is merged. The shared source view proves these are JSON numbers.
  if (
    source instanceof ParsedNumber &&
    typeof left === 'string' &&
    typeof right === 'string' &&
    left !== right
  ) {
    if (
      !exactDecimal.test(left) ||
      !exactDecimal.test(right) ||
      compareDecimal(source.value, left) !== 0 ||
      compareDecimal(source.value, right) !== 0
    )
      bad(path, 'alternatives have incompatible numeric representations');
    return source.value;
  }
  const childSource = (key: string): unknown =>
    source && typeof source === 'object' && Object.hasOwn(source, key)
      ? (source as Record<string, unknown>)[key]
      : undefined;
  if (Array.isArray(left) && Array.isArray(right))
    return left.map((v, i) => combine(v, right[i], `${path}[${i}]`, childSource(String(i))));
  if (left && right && typeof left === 'object' && typeof right === 'object')
    return Object.fromEntries(
      [...new Set([...Object.keys(left), ...Object.keys(right)])].map((key) => [
        key,
        Object.hasOwn(left, key) && Object.hasOwn(right, key)
          ? combine(left[key], right[key], `${path}.${key}`, childSource(key))
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
// Collision-free JSON value identity: numeric spellings and object key order
// are immaterial, while arrays and JSON strings retain their own identity.
function jsonIdentity(value: unknown, depth = 0): string {
  if (depth > 256) return bad('value', 'JSON equality exceeds nesting limit or contains a cycle');
  if (value instanceof ParsedNumber || value instanceof RawNumber || typeof value === 'number') {
    const text = typeof value === 'number' ? String(value) : value.value;
    const [coefficient = '', exponent = '0'] = text.toLowerCase().split('e');
    const fraction = coefficient.split('.')[1]?.length ?? 0;
    const digits = coefficient.replace(/[-.]/g, '').replace(/^0+/, '');
    const trimmed = digits.replace(/0+$/, '');
    if (!trimmed) return '["number","0"]';
    return JSON.stringify([
      'number',
      coefficient.startsWith('-') ? '-' + trimmed : trimmed,
      String(BigInt(exponent) - BigInt(fraction) + BigInt(digits.length - trimmed.length)),
    ]);
  }
  if (Array.isArray(value))
    return JSON.stringify(['array', value.map((child) => jsonIdentity(child, depth + 1))]);
  if (value && typeof value === 'object')
    return JSON.stringify([
      'object',
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, jsonIdentity(child, depth + 1)]),
    ]);
  return JSON.stringify([typeof value, value]);
}
function decimalMultiple(token: string, divisor: string, path: string): boolean {
  const parts = (text: string) => {
    const [coefficient = '', exponent = '0'] = text.toLowerCase().split('e');
    const fraction = coefficient.split('.')[1]?.length ?? 0;
    const digits = coefficient.replace(/[-.]/g, '').replace(/^0+/, '');
    const trimmed = digits.replace(/0+$/, '');
    return {
      digits: trimmed,
      power:
        Math.max(-1e9, Math.min(1e9, Number(exponent))) - fraction + digits.length - trimmed.length,
    };
  };
  const a = parts(token),
    b = parts(divisor);
  if (!a.digits) return true;
  const shift = a.power - b.power;
  if (shift < 0) return false;
  if (b.digits === '1') return true;
  if (shift > 10000) return bad(path, 'multipleOf exponent expansion exceeds 10000 digits');
  return BigInt(a.digits + '0'.repeat(shift)) % BigInt(b.digits) === 0n;
}
function numericConstraints(token: string, s: CodecPlan, path: string, full = true) {
  const range = s.range;
  if (range && (compareDecimal(token, range[0]) < 0 || compareDecimal(token, range[1]) > 0))
    bad(path, 'value is outside the declared integer format range');
  if (!full) return;
  if (
    s.checks.multipleOf !== undefined &&
    !decimalMultiple(token, String(s.checks.multipleOf), path)
  )
    bad(path, 'value violates multipleOf');
  for (const keyword of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'] as const) {
    if (s.checks[keyword] === undefined) continue;
    const order = compareDecimal(token, String(s.checks[keyword]));
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
  allowUnknownResponseFields = false,
): any {
  return executeCodec(value, compileCodec(schemaWithDefinitions(s, definitions)), {
    ...codecMode(response, matching),
    path,
    redactFields,
    depth,
    validateConstraints,
    allowUnknownResponseFields,
  });
}

function schemaWithDefinitions(schema: Schema, definitions: Record<string, Schema>): Schema {
  return Object.keys(definitions).length && !schema['x-sdk-definitions']
    ? { ...schema, 'x-sdk-definitions': definitions }
    : schema;
}

type CodecMode =
  | { mode: 'request' | 'response'; direction?: never }
  | { mode: 'match'; direction: 'request' | 'response' };
function codecMode(response: boolean, matching: boolean): CodecMode {
  return matching
    ? { mode: 'match', direction: response ? 'response' : 'request' }
    : { mode: response ? 'response' : 'request' };
}
export type CodecContext = CodecMode & {
  path?: string;
  redactFields?: string[];
  definitions?: Readonly<Record<string, CodecPlan>>;
  depth?: number;
  validateConstraints?: boolean;
  allowUnknownResponseFields?: boolean;
};

/** Keep branch selection identical during numeric interpretation and validation. */
function selectAlternatives(
  value: unknown,
  branches: readonly CodecPlan[],
  oneOf: boolean,
  tag: string | undefined,
  context: CodecContext,
  matches: (branch: CodecPlan, allowUnknownFields: boolean) => boolean,
): { selected: readonly CodecPlan[]; tolerateUnknownFields: boolean } {
  const response = (context.direction ?? context.mode) === 'response';
  const matching = context.mode === 'match';
  const path = context.path ?? 'input';
  let tolerateUnknownFields = context.allowUnknownResponseFields ?? false;
  let selected: readonly CodecPlan[];
  if (oneOf && tag) {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      !Object.hasOwn(value, tag) ||
      typeof (value as Record<string, unknown>)[tag] !== 'string'
    )
      bad(path, 'expected a string discriminator');
    selected = branches.filter((branch) =>
      (branch.tagValues ?? branch.fields?.[tag]?.members)?.some(
        (member) => member === (value as Record<string, unknown>)[tag],
      ),
    );
  } else {
    // anyOf response selection always uses the compatible set. Computing the
    // discarded closed set first doubles work at each recursive anyOf edge.
    selected =
      !oneOf && response && (!matching || tolerateUnknownFields)
        ? []
        : branches.filter((branch) => matches(branch, false));
    // Prefer closed oneOf matches before tolerating new response fields. anyOf
    // retains every compatible branch's declared numeric representations.
    if ((!oneOf || !selected.length) && response && (!matching || tolerateUnknownFields)) {
      const compatible = branches.filter((branch) => matches(branch, true));
      if (!oneOf || compatible.length === 1) {
        selected = compatible;
        tolerateUnknownFields = true;
      }
    }
  }
  if (!selected.length && response && !matching) {
    if (
      branches.every((branch) => branch.objectOnlyAlternative) &&
      (!value || typeof value !== 'object' || Array.isArray(value))
    )
      bad(path, 'expected an object response alternative');
  } else if (!selected.length || (oneOf && selected.length !== 1)) {
    bad(
      path,
      oneOf
        ? 'value must match exactly one alternative'
        : 'value must match at least one alternative',
    );
  }
  return { selected, tolerateUnknownFields };
}

type CodecScope = { codec: CodecPlan; definitions: Readonly<Record<string, CodecPlan>> };
function conditionalBranch(
  value: unknown,
  { codec, definitions }: CodecScope,
  context: CodecContext,
): CodecPlan | undefined {
  if (!codec.when) return undefined;
  let matched = true;
  try {
    executeNode(value, codec.when.test, {
      ...codecMode((context.direction ?? context.mode) === 'response', true),
      path: context.path ?? 'input',
      depth: (context.depth ?? 0) + 1,
      definitions,
      allowUnknownResponseFields: false,
    });
  } catch (error) {
    if (!(error instanceof SdkError) || error.kind !== 'validation') throw error;
    matched = false;
  }
  return matched ? codec.when.then : codec.when.else;
}
type UnionScope = CodecScope & { branches: readonly CodecPlan[] };
type NumericContext = CodecContext & {
  search: { remaining: Map<string, number>; exhausted: boolean };
};
const numericSearchLimit = 256;

/** Resolve circular dependencies only after ordinary union selection stalls.
 * A hypothesis contributes numeric meaning only if its branches are selected
 * by the original unions, including their oneOf and response-tolerance policies.
 */
function jointNumericView(
  value: unknown,
  unions: readonly UnionScope[],
  context: NumericContext,
): { value: unknown } | undefined {
  if (unions.length < 2) return undefined;
  const convertible = (child: unknown, depth = 0): boolean => {
    if (depth > 256)
      bad(context.path ?? 'input', 'value exceeds supported nesting depth or contains a cycle');
    if (typeof child === 'string') return exactDecimal.test(child);
    if (child instanceof ParsedNumber || child instanceof RawNumber) return false;
    if (child instanceof Model) child = modelInputs.get(child) ?? child.toJSON();
    return Boolean(
      child &&
        typeof child === 'object' &&
        Object.values(child).some((value) => convertible(value, depth + 1)),
    );
  };
  if (!convertible(value)) return undefined;
  const path = context.path ?? 'input';
  // An explicitly string-valued field cannot change under a numeric hypothesis.
  // Reuse full validation for these fields to prune incompatible literal tags.
  const choices = unions.map(({ codec, definitions, branches }) =>
    branches.filter((branch) => {
      if ((branches === codec.exactlyOne && codec.tag) || !value || typeof value !== 'object')
        return true;
      try {
        for (const [key, field] of Object.entries(branch.fields ?? {}))
          if (field.value.kind === 'string' && Object.hasOwn(value, key))
            executeNode((value as Record<string, unknown>)[key], field, {
              ...codecMode((context.direction ?? context.mode) === 'response', true),
              definitions: branch.definitions ?? codec.definitions ?? definitions,
              path: `${path}.${key}`,
              depth: (context.depth ?? 0) + 1,
            });
        return true;
      } catch (error) {
        if (error instanceof SdkError && error.kind === 'validation') return false;
        throw error;
      }
    }),
  );
  function* groups(
    branches: readonly CodecPlan[],
    multiple: boolean,
    start = 0,
    prefix: readonly CodecPlan[] = [],
  ): Generator<readonly CodecPlan[]> {
    for (let i = start; i < branches.length; i++) {
      const branch = branches[i];
      if (!branch) continue;
      const selected = [...prefix, branch];
      yield selected;
      if (multiple) yield* groups(branches, true, i + 1, selected);
    }
  }
  const chosen: { scope: UnionScope; branches: readonly CodecPlan[] }[] = [];
  const search = (index: number): { value: unknown } | undefined => {
    const scope = unions[index];
    if (scope) {
      for (const branches of groups(choices[index] ?? [], scope.branches === scope.codec.some)) {
        chosen.push({ scope, branches });
        const found = search(index + 1);
        chosen.pop();
        if (found) return found;
      }
      return undefined;
    }
    const remaining = context.search.remaining.get(path) ?? numericSearchLimit;
    context.search.remaining.set(path, remaining - 1);
    if (remaining <= 0) {
      context.search.exhausted = true;
      bad(path, 'numeric interpretation exceeds 256 alternative combinations');
    }
    try {
      const candidate = numericView(
        value,
        chosen.flatMap(({ scope, branches }) =>
          branches.map((codec) => ({ codec, definitions: scope.definitions })),
        ),
        { ...context, depth: (context.depth ?? 0) + 1 },
      );
      if (!numericViewChanged(value, candidate)) return undefined;
      for (const { scope, branches } of chosen) {
        const branchContext: CodecContext = {
          ...codecMode((context.direction ?? context.mode) === 'response', true),
          path: context.path ?? 'input',
          definitions: scope.definitions,
          depth: (context.depth ?? 0) + 1,
        };
        const { selected } = selectAlternatives(
          candidate,
          scope.branches,
          scope.branches === scope.codec.exactlyOne,
          scope.codec.tag,
          context,
          (branch, allowUnknownResponseFields) => {
            try {
              executeNode(candidate, branch, { ...branchContext, allowUnknownResponseFields });
              return true;
            } catch (error) {
              if (error instanceof SdkError && error.kind === 'validation') return false;
              throw error;
            }
          },
        );
        if (branches.some((branch) => !selected.includes(branch))) return undefined;
        // Untagged selection fully validates its branches. Tagged selection
        // deliberately leaves other constraints to the caller's validation mode.
      }
      return { value: candidate };
    } catch (error) {
      if (context.search.exhausted) throw error;
      if (error instanceof SdkError && error.kind === 'validation') return undefined;
      throw error;
    }
  };
  return search(0);
}

/** Interpretation only adds numeric meaning; unchanged subtrees need no traversal. */
function numericViewChanged(before: unknown, after: unknown, depth = 0): boolean {
  if (before === after || depth > 256) return false;
  if (after instanceof ParsedNumber) return !(before instanceof ParsedNumber);
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object') return false;
  return Object.entries(after).some(([key, child]) =>
    numericViewChanged((before as Record<string, unknown>)[key], child, depth + 1),
  );
}

/** Branch views differ only in established numeric meaning, never in JSON data. */
function mergeNumericViews(left: any, right: any, depth = 0): any {
  if (depth > 256)
    bad('value', 'value exceeds the supported nesting depth (256) or contains a cycle');
  if (left === right || left instanceof ParsedNumber) return left;
  if (right instanceof ParsedNumber) return right;
  if (left instanceof Model) left = left.toJSON();
  if (right instanceof Model) right = right.toJSON();
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return left;
  if (Array.isArray(left)) {
    const children = left.map((child, index) => mergeNumericViews(child, right[index], depth + 1));
    return children.every((child, index) => child === left[index]) ? left : children;
  }
  const entries = Object.entries(left).map(
    ([key, child]) => [key, mergeNumericViews(child, right[key], depth + 1)] as const,
  );
  if (entries.every(([key, child]) => child === left[key])) return left;
  return Object.fromEntries(entries);
}

/** Follow same-instance declarations with the registry of each reference. */
function codecShapes(
  scopes: readonly CodecScope[],
  path: string,
  depth: number,
  alternatives?: (scope: CodecScope) => readonly CodecPlan[],
): CodecScope[] {
  const shapes: CodecScope[] = [];
  const collect = ({ codec, definitions }: CodecScope, level: number): void => {
    if (level > 256)
      bad(path, 'value exceeds the supported nesting depth (256) or contains a cycle');
    definitions = codec.definitions ?? definitions;
    if (codec.reference) {
      const target = Object.hasOwn(definitions, codec.reference)
        ? definitions[codec.reference]
        : undefined;
      if (!target) bad(path, 'unresolved recursive model ' + codec.reference);
      collect({ codec: target!, definitions }, level + 1);
    } else {
      shapes.push({ codec, definitions });
      for (const child of [
        ...(codec.every ?? []),
        ...(alternatives?.({ codec, definitions }) ?? []),
      ])
        collect({ codec: child, definitions }, level + 1);
    }
  };
  scopes.forEach((scope) => collect(scope, depth));
  return shapes;
}

/** Every added number must still have a positive declaration in the final selection.
 * Interpretation can invalidate a previously matching branch through negation.
 * Validate provenance before any encoding, including fields accepted as unknown.
 */
function assertNumericSources(
  source: unknown,
  value: unknown,
  scopes: readonly CodecScope[],
  context: CodecContext,
): void {
  if (source instanceof Model) source = source.toJSON();
  if (!numericViewChanged(source, value)) return;
  const path = context.path ?? 'input';
  const depth = context.depth ?? 0;
  const shapes = codecShapes(scopes, path, depth, ({ codec, definitions }) => {
    const conditional = conditionalBranch(value, { codec, definitions }, context);
    return [
      ...(conditional ? [conditional] : []),
      ...[codec.exactlyOne, codec.some].flatMap((branches) => {
        if (!branches) return [];
        return selectAlternatives(
          value,
          branches,
          branches === codec.exactlyOne,
          codec.tag,
          context,
          (branch, allowUnknownResponseFields) => {
            try {
              executeNode(value, branch, {
                ...codecMode((context.direction ?? context.mode) === 'response', true),
                path,
                depth: depth + 1,
                definitions,
                allowUnknownResponseFields,
              });
              return true;
            } catch (error) {
              if (error instanceof SdkError && error.kind === 'validation') return false;
              throw error;
            }
          },
        ).selected;
      }),
    ];
  });
  if (value instanceof ParsedNumber) {
    if (!shapes.some(({ codec }) => exactValue(codec.value)))
      bad(path, 'numeric interpretation depends on an unmatched alternative');
    return;
  }
  if (!value || typeof value !== 'object') return;
  const original = source && typeof source === 'object' ? (source as Record<string, unknown>) : {};
  for (const [key, child] of Object.entries(value)) {
    const children = shapes.flatMap(({ codec, definitions }) => {
      const field = Array.isArray(value)
        ? codec.element
        : Object.hasOwn(codec.fields ?? {}, key)
          ? codec.fields?.[key]
          : typeof codec.extra === 'object'
            ? codec.extra
            : undefined;
      return field ? [{ codec: field, definitions }] : [];
    });
    assertNumericSources(original[key], child, children, {
      ...context,
      path: Array.isArray(value) ? `${path}[${key}]` : `${path}.${key}`,
      depth: depth + 1,
    });
  }
}

/** Give every conjunct the same JSON numeric view of caller-owned SDK values.
 * Walk the finite value, resolving named shapes as needed; never expand a recursive
 * schema or infer a number from a string without a positive numeric declaration.
 * Alternative candidates establish their own view before full branch matching.
 */
function numericView(
  value: unknown,
  scopes: readonly CodecScope[],
  context: NumericContext,
  previous?: { value: unknown },
): unknown {
  if (!scopes.length) return value;
  // Revisit a matched branch only where another branch added numeric meaning.
  // The previous view was computed with these same scopes and direction policy.
  if (previous && !numericViewChanged(previous.value, value)) return value;
  const previousChild = (key: string): { value: unknown } | undefined =>
    previous && previous.value && typeof previous.value === 'object'
      ? { value: (previous.value as Record<string, unknown>)[key] }
      : undefined;
  const depth = context.depth ?? 0;
  const path = context.path ?? 'input';
  if (context.search.exhausted)
    bad(path, 'numeric interpretation exceeds 256 alternative combinations');
  if (depth > 256) bad(path, 'value exceeds the supported nesting depth (256) or contains a cycle');
  if (value instanceof Model) value = modelInputs.get(value) ?? value.toJSON();
  const shapes = codecShapes(scopes, path, depth);
  if (
    typeof value === 'string' &&
    shapes.some(
      ({ codec }) =>
        exactValue(codec.value) &&
        codec.numberInput !== 'explicit' &&
        (codec.value.kind === 'exact-integer' ? exactInteger : exactDecimal).test(value as string),
    )
  )
    value = new ParsedNumber(value);
  if (Array.isArray(value)) {
    const children = shapes.flatMap(({ codec, definitions }) =>
      codec.element ? [{ codec: codec.element, definitions }] : [],
    );
    if (children.length) {
      denseArray(value, path);
      value = value.map((child, i) =>
        numericView(
          child,
          children,
          { ...context, path: `${path}[${i}]`, depth: depth + 1 },
          previousChild(String(i)),
        ),
      );
    }
  } else if (value && typeof value === 'object' && !(value instanceof ParsedNumber)) {
    value = Object.fromEntries(
      Object.entries(value).map(([key, child]) => {
        // Request omission is decided before a property's union is matched.
        // Required fields are still checked by executeNode on the parent.
        if (child === undefined && (context.direction ?? context.mode) !== 'response')
          return [key, child];
        const children = shapes.flatMap(({ codec, definitions }) => {
          const field = Object.hasOwn(codec.fields ?? {}, key)
            ? codec.fields![key]
            : typeof codec.extra === 'object'
              ? codec.extra
              : undefined;
          return field ? [{ codec: field, definitions }] : [];
        });
        return [
          key,
          numericView(
            child,
            children,
            { ...context, path: `${path}.${key}`, depth: depth + 1 },
            previousChild(key),
          ),
        ];
      }),
    );
  }
  const unions = shapes.flatMap(({ codec, definitions }) =>
    [codec.exactlyOne, codec.some].flatMap((branches) =>
      branches ? [{ codec, definitions, branches }] : [],
    ),
  );
  let pending = unions;
  // A constraint-only union may need the numeric view supplied by another
  // conjunct. Retry it after successful selections, independent of allOf order.
  // Each productive pass removes a union. If no selection can progress, retain
  // the validation failure rather than returning a partially interpreted value.
  while (pending.length) {
    const before = value;
    const deferred: typeof pending = [];
    let failure: SdkError | undefined;
    for (const scope of pending) {
      const { codec, definitions, branches } = scope;
      try {
        const candidates = new Map<CodecPlan, unknown>();
        const { selected, tolerateUnknownFields } = selectAlternatives(
          value,
          branches,
          branches === codec.exactlyOne,
          codec.tag,
          context,
          (branch, allowUnknownFields) => {
            try {
              const branchContext: NumericContext = {
                ...codecMode((context.direction ?? context.mode) === 'response', true),
                search: context.search,
                path,
                definitions,
                depth: depth + 1,
                allowUnknownResponseFields: allowUnknownFields,
              };
              const candidate = numericView(value, [{ codec: branch, definitions }], branchContext);
              executeNode(candidate, branch, branchContext);
              candidates.set(branch, candidate);
              return true;
            } catch (error) {
              if (error instanceof SdkError && error.kind === 'validation') return false;
              throw error;
            }
          },
        );
        if (!selected.length) {
          deferred.push(scope);
          continue;
        }
        // Reuse every matched view. Rewalking all selected branches makes
        // overlapping recursive anyOf schemas exponential even without numbers.
        if (selected.every((branch) => candidates.has(branch))) {
          for (const branch of selected) value = mergeNumericViews(value, candidates.get(branch));
          let changed: boolean;
          do {
            const beforeRefinement = value;
            for (const branch of selected) {
              const candidate = candidates.get(branch);
              if (!numericViewChanged(candidate, value)) continue;
              const refined = numericView(
                value,
                [{ codec: branch, definitions }],
                {
                  ...codecMode((context.direction ?? context.mode) === 'response', true),
                  search: context.search,
                  path,
                  depth: depth + 1,
                  allowUnknownResponseFields: tolerateUnknownFields,
                },
                { value: candidate },
              );
              candidates.set(branch, refined);
              value = mergeNumericViews(value, refined);
            }
            changed = numericViewChanged(beforeRefinement, value);
          } while (changed);
        } else {
          value = numericView(
            value,
            selected.map((branch) => ({ codec: branch, definitions })),
            {
              ...context,
              depth: depth + 1,
              allowUnknownResponseFields: tolerateUnknownFields,
            },
          );
        }
      } catch (error) {
        if (!(error instanceof SdkError) || error.kind !== 'validation') throw error;
        failure ??= error;
        deferred.push(scope);
      }
    }
    // An earlier anyOf may gain compatible numeric branches after a later
    // conjunct supplies their required numeric context. Retry all unions only
    // when numeric meaning changed; single recursive unions keep their fast path.
    if (unions.length > 1 && numericViewChanged(before, value)) {
      pending = unions;
      continue;
    }
    if (deferred.length === pending.length) {
      const joint = jointNumericView(value, unions, context);
      if (joint) {
        value = joint.value;
        pending = unions;
        continue;
      }
      if (failure) throw failure;
      break;
    }
    pending = deferred;
  }
  if (context.search.exhausted)
    bad(path, 'numeric interpretation exceeds 256 alternative combinations');
  for (const scope of shapes) {
    const branch = conditionalBranch(value, scope, context);
    if (branch)
      value = numericView(value, [{ codec: branch, definitions: scope.definitions }], {
        ...context,
        depth: depth + 1,
      });
  }
  return value;
}

/** Internal descriptor entry point. Raw schemas are accepted only by the adapter above. */
export function executeCodec(value: unknown, s: CodecPlan, context: CodecContext): unknown {
  if (!['request', 'response', 'match'].includes(context.mode))
    throw new Error('Unknown codec execution mode');
  const scopes = [{ codec: s, definitions: context.definitions ?? {} }];
  const interpreted = numericView(value, scopes, {
    ...context,
    search: { remaining: new Map(), exhausted: false },
  });
  assertNumericSources(value, interpreted, scopes, context);
  return executeNode(interpreted, s, context);
}

function executeNode(value: unknown, s: CodecPlan, context: CodecContext): unknown {
  const {
    path = 'input',
    redactFields = [],
    depth = 0,
    allowUnknownResponseFields = false,
  } = context;
  const response = (context.direction ?? context.mode) === 'response';
  const matching = context.mode === 'match';
  let validateConstraints = s.constraints ?? context.validateConstraints ?? true;
  let definitions = s.definitions ?? context.definitions ?? {};
  if (
    (!response || matching) &&
    s.literal !== undefined &&
    jsonIdentity(value) !== jsonIdentity(parseJson(s.literal, true))
  )
    bad(path, 'value is outside the declared const');

  if (depth > 256) bad(path, 'value exceeds the supported nesting depth (256) or contains a cycle');
  if (s.reference) {
    const target = Object.hasOwn(definitions, s.reference) ? definitions[s.reference] : undefined;
    if (!target) return bad(path, 'unresolved recursive model ' + s.reference);
    return executeNode(value, target, {
      ...codecMode(response, matching),
      path: path,
      redactFields: redactFields,
      definitions: definitions,
      depth: depth + 1,
      validateConstraints: validateConstraints,
      allowUnknownResponseFields: allowUnknownResponseFields,
    });
  }
  if (value instanceof Model) value = modelInputs.get(value) ?? value.toJSON();
  wireKind(s.value); // Exhaustively reject unknown instruction kinds.
  if (s.every || s.some || s.exactlyOne || s.exclude || s.when) {
    const {
      every: allOf,
      some: anyOf,
      exactlyOne: oneOf,
      exclude: not,
      tag: discriminator,
      when,
      ...base
    } = s;
    let result = executeNode(value, base, {
      ...codecMode(response, matching),
      path: path,
      redactFields: redactFields,
      definitions: definitions,
      depth: depth + 1,
      validateConstraints: validateConstraints,
      allowUnknownResponseFields: allowUnknownResponseFields,
    });
    // Matching executes the complete branch. Reuse that result when this node
    // is itself matching; re-executing each selected recursive branch doubles
    // the work at every value depth. Ordinary decoding/encoding still runs in
    // its own mode, whose enum, bound and unknown-field policies differ.
    const matched = new Map<CodecPlan, Map<boolean, unknown>>();
    const matches = (branch: CodecPlan, allowUnknownFields: boolean): boolean => {
      try {
        const result = executeNode(value, branch, {
          ...codecMode(response, true),
          path: path,
          redactFields: redactFields,
          definitions: definitions,
          depth: depth + 1,
          validateConstraints: validateConstraints,
          allowUnknownResponseFields: allowUnknownFields,
        });
        const results = matched.get(branch) ?? new Map<boolean, unknown>();
        results.set(allowUnknownFields, result);
        matched.set(branch, results);
        return true;
      } catch (error) {
        if (error instanceof SdkError && error.kind === 'validation') return false;
        throw error;
      }
    };
    if (not && matches(not, false)) bad(path, 'value matches a forbidden combination');
    const conditional = conditionalBranch(value, { codec: s, definitions }, context);
    for (const branch of [...(allOf ?? []), ...(conditional ? [conditional] : [])])
      result = combine(
        result,
        executeNode(value, branch, {
          ...codecMode(response, matching),
          path: path,
          redactFields: redactFields,
          definitions: definitions,
          depth: depth + 1,
          validateConstraints: validateConstraints,
          allowUnknownResponseFields: allowUnknownResponseFields,
        }),
        path,
        value,
      );
    for (const [keyword, branches] of [
      ['oneOf', oneOf],
      ['anyOf', anyOf],
    ] as const) {
      if (!branches) continue;
      const { selected, tolerateUnknownFields } = selectAlternatives(
        value,
        branches,
        keyword === 'oneOf',
        discriminator,
        context,
        matches,
      );
      for (const branch of selected) {
        const results = matched.get(branch);
        result = combine(
          result,
          matching && results?.has(tolerateUnknownFields)
            ? results.get(tolerateUnknownFields)
            : executeNode(value, branch, {
                ...codecMode(response, matching),
                path: path,
                redactFields: redactFields,
                definitions: definitions,
                depth: depth + 1,
                validateConstraints: validateConstraints,
                allowUnknownResponseFields: tolerateUnknownFields,
              }),
          path,
          value,
        );
      }
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
        value: () => redactCodec(object, s, redactFields, definitions),
      });
      return object;
    }
    return result;
  }
  if (value === null) {
    if ((!response || matching) && s.members && !s.members.includes(null))
      bad(path, 'null is outside the declared enum');
    if (s.nullable) return null;
    return bad(path, 'null is not permitted');
  }
  const type = wireKind(s.value);
  // Positive declarations establish numeric meaning in numericView before
  // matching. A remaining string is JSON text, including inside a negation;
  // the numeric branch being tested must not reinterpret it as an SDK number.
  if (
    (matching || (!response && s.numberInput === 'explicit')) &&
    exactValue(s.value) &&
    typeof value === 'string'
  )
    return bad(path, `expected ${type}; received a JSON string`);
  if (value instanceof ParsedNumber) {
    if (type === undefined) {
      const token = value.value;
      if (
        (!response || matching) &&
        s.members &&
        !s.members.some((v) => typeof v === 'number' && compareDecimal(token, String(v)) === 0)
      )
        bad(path, 'value is outside the declared enum');
      if (!response || matching)
        numericConstraints(value.value, s, path, validateConstraints || matching);
      return response ? value : new RawNumber(value.value);
    }
    if (type === 'integer') {
      const token = integerToken(value.value, path);
      value = exactValue(s.value) ? token : Number(token);
    } else if (type === 'number') value = value.value;
    else return bad(path, `expected ${type}; received a JSON number`);
  }
  const exactEnum = exactValue(s.value);
  if (
    (!response || matching) &&
    s.members &&
    !(exactEnum
      ? (typeof value === 'string' || typeof value === 'number') &&
        exactDecimal.test(String(value)) &&
        s.members.some(
          (member) =>
            typeof member === 'number' && compareDecimal(String(value), String(member)) === 0,
        )
      : s.members.some((member) => member === value))
  )
    bad(path, 'value is outside the declared enum');
  if (type === 'integer' || type === 'number') {
    const exact = exactValue(s.value);
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
    for (const k of response ? s.requiredOutput : s.requiredInput)
      if (!Object.hasOwn(entries, k) || entries[k] === undefined)
        bad(`${path}.${k}`, 'required field is missing');
    const out: Record<string, unknown> = Object.create(null);
    for (const [k, v] of Object.entries(entries)) {
      if (v === undefined && !response) continue;
      const child = Object.hasOwn(s.fields ?? {}, k) ? s.fields![k] : undefined;
      if (!response && child?.rejectInput) bad(`${path}.${k}`, 'readOnly fields cannot be sent');
      if (child)
        out[k] = executeNode(v, child, {
          ...codecMode(response, matching),
          path: `${path}.${k}`,
          redactFields: redactFields,
          definitions: definitions,
          depth: depth + 1,
          validateConstraints: validateConstraints,
          allowUnknownResponseFields: allowUnknownResponseFields,
        });
      else if ((!response || (matching && !allowUnknownResponseFields)) && s.extra === false)
        bad(`${path}.${k}`, 'unknown request field');
      else if (typeof s.extra === 'object')
        out[k] = executeNode(v, s.extra, {
          ...codecMode(response, matching),
          path: `${path}.${k}`,
          redactFields: redactFields,
          definitions: definitions,
          depth: depth + 1,
          validateConstraints: validateConstraints,
          allowUnknownResponseFields: allowUnknownResponseFields,
        });
      else out[k] = v;
    }
    if ((!response || matching) && (validateConstraints || matching)) {
      const count = Object.keys(out).length;
      if (s.checks.minProperties !== undefined && count < s.checks.minProperties)
        bad(path, 'object violates minProperties');
      if (s.checks.maxProperties !== undefined && count > s.checks.maxProperties)
        bad(path, 'object violates maxProperties');
    }
    if (response)
      Object.defineProperty(out, inspect.custom, {
        value: () => redactCodec(out, s, redactFields, definitions),
        enumerable: false,
      });
    return out;
  }
  if (type === 'array' || (type === undefined && Array.isArray(value))) {
    if (!Array.isArray(value)) return bad(path, 'expected an array');
    denseArray(value, path);
    if ((!response || matching) && (validateConstraints || matching)) {
      if (s.checks.minItems !== undefined && value.length < s.checks.minItems)
        bad(path, 'array violates minItems');
      if (s.checks.maxItems !== undefined && value.length > s.checks.maxItems)
        bad(path, 'array violates maxItems');
      if (
        s.checks.uniqueItems &&
        new Set(value.map((child) => jsonIdentity(child, depth + 1))).size !== value.length
      )
        bad(path, 'array violates uniqueItems');
      if (
        s.includes &&
        !value.some((child, index) => {
          try {
            executeNode(child, s.includes!, {
              ...codecMode(response, true),
              path: `${path}[${index}]`,
              definitions,
              depth: depth + 1,
              allowUnknownResponseFields: false,
            });
            return true;
          } catch (error) {
            if (error instanceof SdkError && error.kind === 'validation') return false;
            throw error;
          }
        })
      )
        bad(path, 'array violates contains');
    }
    return value.map((v, i) =>
      executeNode(v, s.element ?? ANY_CODEC, {
        ...codecMode(response, matching),
        path: `${path}[${i}]`,
        redactFields: redactFields,
        definitions: definitions,
        depth: depth + 1,
        validateConstraints: validateConstraints,
        allowUnknownResponseFields: allowUnknownResponseFields,
      }),
    );
  }
  if (type === 'string' && typeof value !== 'string') return bad(path, 'expected a string');
  if (typeof value === 'string' && (!response || matching)) {
    if (/[\uD800-\uDFFF]/u.test(value)) bad(path, 'expected well-formed Unicode');
    if (validateConstraints || matching) {
      const length = [...value].length;
      if (s.checks.minLength !== undefined && length < s.checks.minLength)
        bad(path, 'string violates minLength');
      if (s.checks.maxLength !== undefined && length > s.checks.maxLength)
        bad(path, 'string violates maxLength');
      if (s.checks.pattern !== undefined && !new RegExp(s.checks.pattern, 'u').test(value))
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
  return isKnownCodec(value, compileCodec(schema));
}
export function isKnownCodec(value: unknown, codec: CodecPlan): boolean {
  try {
    let definitions = codec.definitions ?? {};
    for (let depth = 0; codec.reference; depth++) {
      if (depth > 256) bad('response', 'codec reference exceeds nesting limit');
      const target = Object.hasOwn(definitions, codec.reference)
        ? definitions[codec.reference]
        : undefined;
      if (!target) return false;
      codec = target;
      definitions = codec.definitions ?? definitions;
    }
    if (!codec.exactlyOne && !codec.some) return false;
    const tag = codec.tag;
    if (
      tag &&
      (!value ||
        typeof value !== 'object' ||
        !Object.hasOwn(value, tag) ||
        !codec.exactlyOne?.some((branch) =>
          (branch.tagValues ?? branch.fields?.[tag]?.members)?.some(
            (member) => member === (value as Record<string, unknown>)[tag],
          ),
        ))
    )
      return false;
    executeCodec(value, codec, {
      mode: 'match',
      direction: 'response',
      path: 'response',
      allowUnknownResponseFields: true,
      definitions,
    });
    return true;
  } catch (error) {
    if (error instanceof SdkError && error.kind === 'validation') return false;
    throw error;
  }
}
export function redact(
  value: unknown,
  schema?: Schema,
  fields: string[] = [],
  definitions: Record<string, Schema> = {},
  depth = 0,
): unknown {
  return redactCodec(
    value,
    schema ? compileCodec(schemaWithDefinitions(schema, definitions)) : undefined,
    fields,
    {},
    depth,
  );
}

export function redactCodec(
  value: unknown,
  schema?: CodecPlan,
  fields: string[] = [],
  definitions: Readonly<Record<string, CodecPlan>> = {},
  depth = 0,
): unknown {
  if (depth > 256) return '[Nesting limit]';
  definitions = schema?.definitions ?? definitions;
  if (schema?.reference) {
    const target = definitions[schema.reference];
    return target
      ? redactCodec(value, target, fields, definitions, depth + 1)
      : '[Unresolved model]';
  }
  const shapes = (s?: CodecPlan): CodecPlan[] =>
    s?.reference
      ? shapes(definitions[s.reference])
      : s
        ? [
            s,
            ...[
              ...(s.every ?? []),
              ...(s.some ?? []),
              ...(s.exactlyOne ?? []),
              ...(s.when?.then ? [s.when.then] : []),
              ...(s.when?.else ? [s.when.else] : []),
            ].flatMap(shapes),
          ]
        : [];
  const schemas = shapes(schema);
  if (schemas.some((s) => s.sensitive)) return '[REDACTED]';
  if (Array.isArray(value))
    return value.map((v) =>
      redactCodec(
        v,
        { ...ANY_CODEC, every: schemas.flatMap((s) => (s.element ? [s.element] : [])) },
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
          : redactCodec(
              v,
              {
                ...ANY_CODEC,
                every: schemas.flatMap((s) =>
                  Object.hasOwn(s.fields ?? {}, k)
                    ? [s.fields![k]!]
                    : typeof s.extra === 'object'
                      ? [s.extra]
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
const modelInputs = new WeakMap<object, unknown>();
export class Model<T = unknown> {
  private readonly value: T;
  private readonly codec: CodecPlan;
  private readonly dynamicSchema: Schema | undefined;
  constructor(value: InputValue<T>, schema: Schema);
  constructor(value: InputValue<T>, schema: Schema, compiled?: CodecPlan) {
    this.dynamicSchema = compiled ? undefined : schema;
    this.codec = compiled ?? compileCodec(schema);
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
    const normalized = executeCodec(value, this.codec, { mode: 'request' });
    modelInputs.set(this, parseJson(encode(normalized), true));
    this.value = unwrap(normalized) as T;
  }
  toJSON() {
    return structuredClone(this.value);
  }
  [inspect.custom]() {
    return redactCodec(
      this.value,
      this.dynamicSchema ? compileCodec(this.dynamicSchema) : this.codec,
    );
  }
}
/** Internal factory; does not expand the public Model class method surface. */
export function modelFromCodec<T>(value: InputValue<T>, codec: CodecPlan): Model<T> {
  // Reflect invokes the implementation-only third argument on the known Model constructor.
  return Reflect.construct(Model, [value, {}, codec]) as Model<T>;
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
    const timer = schedule(() => {
      signal?.removeEventListener('abort', cancel);
      resolve();
    }, ms);
    const cancel = () => {
      timer?.cancel();
      reject(new SdkError('cancelled', 'Local waiting cancelled', 'unknown'));
    };
    signal?.addEventListener('abort', cancel, { once: true });
  });
}
export class Runtime {
  private readonly streams = new Set<EventStream>();
  async close(): Promise<void> {
    await Promise.all([...this.streams].map((stream) => stream.close()));
  }
  private readonly options: ClientOptions;
  private readonly base: URL;
  private readonly allowed: Set<string>;
  private readonly compiledContract: CompiledRuntimePlan;
  private readonly dynamicContract: RuntimeContract | undefined;
  private get contract(): CompiledRuntimePlan {
    // Public source-taking Runtime construction retains caller-owned schemas.
    // Generated clients always supply compiledContract and never enter this adapter.
    return this.dynamicContract ? compileRuntimePlan(this.dynamicContract) : this.compiledContract;
  }
  constructor(contract: RuntimeContract, options: ClientOptions);
  constructor(contract: RuntimeContract, options: ClientOptions, compiled?: CompiledRuntimePlan) {
    this.dynamicContract = compiled ? undefined : contract;
    this.compiledContract = compiled ?? compileRuntimePlan(contract);
    assertRuntimePlan(this.compiledContract);
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
  private decode(value: unknown, codec: CodecPlan, context: CodecContext): unknown {
    return executeCodec(value, codec, { ...context, definitions: this.contract.definitions ?? {} });
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
    if (options.streamIdleTimeoutMs !== undefined)
      positive(options.streamIdleTimeoutMs, 'streamIdleTimeoutMs');
    if (options.streamLifetimeMs !== undefined)
      positive(options.streamLifetimeMs, 'streamLifetimeMs');
    const policy = op.retry ?? { maxAttempts: 1, statuses: [], transport: false, baseDelayMs: 100 };
    const attempts = options.maxAttempts ?? this.options.maxAttempts ?? policy.maxAttempts;
    if (!Number.isInteger(attempts) || attempts < 1 || attempts > policy.maxAttempts)
      bad('maxAttempts', 'must be within the provider-declared retry limit');
    const headers: Record<string, string> = Object.assign(Object.create(null), {
      accept:
        [
          ...new Set(
            Object.values(op.responses)
              .filter((response) => response.classification === 'success')
              .map((response) => response.mediaType)
              .filter(Boolean),
          ),
        ].join(', ') || 'application/json',
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
      const normalized = this.decode(value, p.codec, { mode: 'request', path: p.name });
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
    if (this.contract.authentication) {
      const permitted = op.authModes ?? [];
      let modeName = options.authMode ?? (permitted.length ? this.options.authMode : undefined);
      if (modeName === undefined && op.authenticated && permitted.length === 1)
        modeName = permitted[0];
      if (modeName === undefined && op.authenticated)
        throw new SdkError('authentication', 'Select an explicit authentication mode');
      const selected = modeName === undefined ? undefined : this.contract.authentication[modeName];
      if (modeName !== undefined && (!selected || !permitted.includes(modeName)))
        throw new SdkError(
          'authentication',
          'Authentication mode is not permitted for this operation',
        );
      const expected: Record<string, string> = Object.create(null);
      if (selected && modeName !== undefined) {
        const credentials = options.credentials ?? this.options.credentials?.[modeName];
        for (const scheme of selected.schemes) {
          const credential = credentials?.[scheme.name];
          if (typeof credential !== 'string' || !credential || /[\r\n]/.test(credential))
            throw new SdkError(
              'authentication',
              'A complete credential set is required for the selected mode',
            );
          expected[scheme.header.toLowerCase()] =
            scheme.type === 'bearer' ? 'Bearer ' + credential : credential;
        }
      }
      for (const mode of Object.values(this.contract.authentication))
        for (const scheme of mode.schemes) {
          const name = scheme.header.toLowerCase();
          if (headers[name] !== undefined && headers[name] !== expected[name])
            throw new SdkError(
              'authentication',
              'Request headers conflict with the selected authentication mode',
            );
        }
      for (const [name, value] of Object.entries(expected)) setHeader(name, value);
    } else if (op.authenticated || (op.optionalAuthentication && this.options.token)) {
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
      if (/^[ \t]|[ \t]$/.test(key))
        bad(
          'idempotencyKey',
          'leading or trailing HTTP whitespace would change the key on the wire',
        );
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
      body = encode(this.decode(input.body, op.body!, { mode: 'request' }));
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
      // Timers truncate fractional durations; rounding up prevents an overall
      // deadline from being reported as an earlier per-attempt transport error.
      const timer = schedule(abort, Math.ceil(Math.min(timeout, remaining)));
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
        const declaredResponse = op.responses[String(response.status)] ?? op.responses.default;
        if (response.ok && declaredResponse?.bodyKind === 'sse') {
          if (
            response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !==
              'text/event-stream' ||
            !response.body
          ) {
            await response.body?.cancel();
            throw new SdkError(
              'protocol',
              'Expected an SSE response stream',
              'response',
              false,
              meta,
            );
          }
          const idleTimeoutMs = options.streamIdleTimeoutMs ?? op.stream?.idleTimeoutMs ?? 30000;
          positive(idleTimeoutMs, 'streamIdleTimeoutMs');
          if (options.streamLifetimeMs !== undefined)
            positive(options.streamLifetimeMs, 'streamLifetimeMs');
          const stream = new EventStream(
            response.body.getReader(),
            meta,
            {
              idleTimeoutMs,
              maxEventBytes: op.stream?.maxEventBytes ?? 1048576,
              ...(options.streamLifetimeMs !== undefined
                ? { lifetimeMs: options.streamLifetimeMs }
                : {}),
              ...(options.signal ? { signal: options.signal } : {}),
            },
            (event, raw) => {
              const codec =
                op.streamEventCodecs && Object.hasOwn(op.streamEventCodecs, event)
                  ? op.streamEventCodecs[event]
                  : undefined;
              return codec
                ? plainNumbers(
                    this.decode(parseJson(raw, true), codec, {
                      mode: 'response',
                      path: 'event',
                      redactFields: this.options.redactFields ?? [],
                    }),
                  )
                : raw;
            },
            () => this.streams.delete(stream),
          );
          this.streams.add(stream);
          const result = { data: stream, meta, raw: '' };
          Object.defineProperty(result, inspect.custom, {
            value: () => ({ data: '[Event stream]', meta: inspectedMetadata(meta) }),
          });
          return result as Result<T>;
        }
        const bytes = await abortable(response.arrayBuffer(), controller.signal);
        const redirect = op.responses[String(response.status)]?.classification === 'redirect';
        if (response.ok && declaredResponse?.bodyKind === 'binary') {
          const contentType = response.headers
            .get('content-type')
            ?.split(';')[0]
            ?.trim()
            .toLowerCase();
          if (contentType !== declaredResponse.mediaType)
            throw new SdkError(
              'protocol',
              'Unexpected binary response media type',
              'response',
              false,
              meta,
            );
          meta.durationMs = performance.now() - start;
          if (performance.now() >= deadline)
            throw new SdkError(
              'deadline',
              'Response exceeded the overall deadline',
              'response',
              false,
              meta,
            );
          const data = new Uint8Array(bytes);
          const result = { data, meta, raw: data };
          Object.defineProperty(result, inspect.custom, {
            value: () => ({ data: '[Binary response]', meta: inspectedMetadata(meta) }),
          });
          return result as Result<T>;
        }
        let raw = Buffer.from(bytes).toString('utf8');
        meta.durationMs = performance.now() - start;
        let data: any;
        try {
          raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
          data =
            raw && !redirect ? parseJson(raw, response.ok || response.status === 304) : undefined;
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
        if (response.status >= 300 && response.status < 400 && response.status !== 304 && !redirect)
          throw new SdkError(
            'destination',
            'Redirects are not followed; explicitly configure an approved endpoint',
            'response',
            false,
            meta,
          );
        if (response.ok || response.status === 304 || redirect) {
          const declared = op.responses[String(response.status)] ?? op.responses.default;
          if (!declared)
            throw new SdkError('protocol', 'Undeclared success status', 'response', false, meta);
          try {
            if (redirect) {
              const location = response.headers.get('location');
              if (declared.locationRequired && !location)
                throw new Error('Missing Location header');
              if (location !== null && /[\u0000-\u001f\u007f]/.test(location))
                throw new Error('Invalid Location header');
              data = location === null ? {} : { location };
            } else if (declared.codec) {
              if (data === undefined) throw new Error('Missing body');
              data = plainNumbers(
                this.decode(data, declared.codec, {
                  mode: 'response',
                  path: 'response',
                  redactFields: this.options.redactFields ?? [],
                }),
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
          // Synchronous decoding cannot yield to the abort timer. Check the
          // overall duration again before reporting a successful response.
          meta.durationMs = performance.now() - start;
          if (performance.now() >= deadline)
            throw new SdkError(
              'deadline',
              'Response decoding exceeded the overall deadline',
              'response',
              false,
              meta,
            );
          const result = { data: data as T, meta, raw };
          Object.defineProperty(result, inspect.custom, {
            value: () => ({
              data: redactCodec(
                data,
                declared.codec,
                this.options.redactFields,
                this.contract.definitions,
              ),
              meta: inspectedMetadata(meta),
            }),
          });
          return result as Result<T>;
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
                redactCodec(
                  data,
                  (op.responses[String(response.status)] ?? op.responses.default)?.codec,
                  this.options.redactFields,
                  this.contract.definitions,
                ),
                this.contract.errors.detailsPath,
              )
            : redactCodec(
                data,
                (op.responses[String(response.status)] ?? op.responses.default)?.codec,
                this.options.redactFields,
                this.contract.definitions,
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
        timer?.cancel();
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
      const sent = p.kind === 'link' ? next : request[p.parameter!];
      const previous = sent instanceof Model ? sent.toJSON() : sent;
      next = field(result.data, p.next);
      if (next === undefined || next === null || next === '') return;
      if (p.kind === 'link' && typeof next !== 'string')
        throw new SdkError('protocol', 'Expected a pagination URL', 'response');
      if (p.kind === 'link') next = new URL(next as string, result.meta.url ?? this.base).href;
      if (
        next === previous ||
        (p.kind === 'offset' && previous !== undefined && String(next) === String(previous)) ||
        (p.kind === 'link' && next === result.meta.url)
      )
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
        schema
          ? this.decode(event, schema, {
              mode: 'response',
              path: 'event',
              redactFields: this.options.redactFields ?? [],
            })
          : event,
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

/** Internal factory for generated clients; public Runtime construction remains schema-based. */
export function runtimeFromPlan(contract: CompiledRuntimePlan, options: ClientOptions): Runtime {
  return Reflect.construct(Runtime, [{ operations: [] }, options, contract]) as Runtime;
}
