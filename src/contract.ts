import { shareContractSchemas } from './schema-sharing.js';
import { Diagnostic } from './diagnostic.js';
import { valueInstruction, exactValue, discriminatorBindings } from './codec-plan.js';
import { stable } from './canonical.js';
import { successStatus } from './runtime-plan.js';
import { visitIntersectedProperties } from './schema-intersections.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname, relative as relativePath } from 'node:path';
import { createHash } from 'node:crypto';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Schema = {
  'x-sdk-ref'?: string;
  'x-sdk-definitions'?: Record<string, Schema>;
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  enum?: Json[];
  const?: Json;
  oneOf?: Schema[];
  anyOf?: Schema[];
  allOf?: Schema[];
  not?: Schema;
  contains?: Schema;
  if?: Schema;
  then?: Schema;
  else?: Schema;
  readOnly?: boolean;
  writeOnly?: boolean;
  discriminator?: { propertyName: string; mapping?: Record<string, string> };
  'x-sdk-discriminator-mapping'?: Record<string, number>;
  additionalProperties?: boolean | Schema;
  format?: string;
  minimum?: number;
  maximum?: number;
  multipleOf?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  minProperties?: number;
  maxProperties?: number;
  uniqueItems?: boolean;
  pattern?: string;
  'x-sdk-pattern-php'?: string;
  description?: string;
  'x-sensitive'?: boolean;
  [key: string]: unknown;
};
export interface Parameter {
  name: string;
  in: 'path' | 'query' | 'header';
  required?: boolean;
  schema: Schema;
  style?: string;
  explode?: boolean;
}
export interface Retry {
  maxAttempts: number;
  statuses: number[];
  /** Retry only these provider error codes at a given status. */
  errors?: { status: number; codes: string[] }[];
  transport: boolean;
  baseDelayMs: number;
}
export interface Capability {
  stream?: { events?: Record<string, string>; idleTimeoutMs?: number; maxEventBytes?: number };
  requestMediaType?: string;
  resource?: string;
  method?: string;
  audiences?: string[];
  hidden?: boolean;
  aliases?: string[];
  retry?: Retry;
  idempotency?: { header: string; retention: string; scope: string; auto?: boolean };
  pagination?: {
    kind: 'cursor' | 'offset' | 'link';
    items: string;
    next: string;
    parameter?: string;
  };
  polling?: { state: string; success: string[]; failure: string[]; intervalMs: number };
  conditional?: { header: string };
  example?: Record<string, unknown>;
  deprecated?: string;
}
export interface Operation extends Capability {
  streamEventSchemas?: Record<string, Schema>;
  id: string;
  resource: string;
  method: string;
  verb: string;
  path: string;
  parameters: Parameter[];
  body?: Schema;
  bodyRequired: boolean;
  mediaType?: string;
  responses: Record<
    string,
    {
      schema?: Schema;
      mediaType?: string;
      bodyKind?: 'empty' | 'json' | 'binary' | 'sse';
      classification?: 'success' | 'error' | 'redirect';
      locationRequired?: boolean;
    }
  >;
  authenticated: boolean;
  authModes?: string[];
  optionalAuthentication?: boolean;
  description: string;
}
export interface Auth {
  type: 'bearer' | 'apiKey';
  header: string;
}
export interface AuthenticationMode {
  schemes: (Auth & { name: string })[];
  operations?: string[];
}
export interface Webhook {
  algorithm: 'hmac-sha256';
  format?: 'hex' | 'standard-webhooks' | 'timestamped-hex';
  idHeader?: string;
  header: string;
  timestampHeader?: string;
  separator: string;
  toleranceSeconds: number;
  events: Record<string, Schema>;
  typeField: string;
}
export interface Config {
  profiles?: string[];
  numericUnions?: 'explicit';
  schemaSharing?: 'named';
  validation?: 'encoding' | 'schema';
  auth?:
    | { scheme: string }
    | { modes: Record<string, { schemes: string[]; operations?: string[] }> };
  targets?: ('node' | 'php')[];
  version: string;
  npm: { name: string; registry?: string; access?: 'public' | 'restricted' };
  composer: { name: string; namespace: string };
  operations?: Record<string, Capability>;
  models?: Record<string, string>;
  include?: string[];
  audiences?: string[];
  overrides?: Record<string, Json | Schema>;
  webhook?: Webhook;
  money?: { currencies: Record<string, number> };
  apiVersion?: { value: string; header: string };
  license?: string;
  errors?: { codePath?: string; detailsPath?: string; requestIdHeader?: string };
  documentation?: { overview?: string; guides?: Record<string, string> };
  release?: { baseUrl?: string; policy?: 'review' | 'semver' };
}
export interface Contract {
  title: string;
  apiVersion: string;
  operations: Operation[];
  incoming?: IncomingWebhook[];
  models: Record<string, Schema>;
  definitions?: Record<string, Schema>;
  modelDependencies?: Record<string, string[]>;
  auth?: Auth;
  authentication?: Record<string, AuthenticationMode>;
  config: Config;
  sources: Record<string, string>;
  hash: string;
}
export interface IncomingWebhook {
  name: string;
  method: string;
  pointer: string;
  model: string;
  schema: Schema;
  dependencies: string[];
}
export { Diagnostic } from './diagnostic.js';
export { stable } from './canonical.js';
export const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const fail = (p: string, m: string): never => {
  throw new Diagnostic(p, m);
};
const identifier = /^[A-Za-z][A-Za-z0-9_]*$/;
const reserved = new Set(
  'class function public private protected static new default delete constructor prototype then tostring valueof tojson catch finally call request close pages items wait verifywebhook money client runtime model result sdkerror codec rawnumber cancellation clientoptions requestoptions namespace use match enum readonly trait interface extends implements clone throw return const var let await yield list echo print empty isset unset true false null string int bool float mixed void never object array iterable self parent static abstract final break case continue declare die do else elseif enddeclare endfor endforeach endif endswitch endwhile eval exit for foreach global goto if include include_once instanceof insteadof require require_once switch try while xor and or switch'.split(
    ' ',
  ),
);
// TypeScript keywords are case-sensitive and may still be valid property names.
const reservedTypeNames = new Set(
  'debugger export import in super this typeof with package arguments keyof infer unique'.split(
    ' ',
  ),
);
function modelName(
  value: unknown,
  path: string,
  targets: Config['targets'],
): asserts value is string {
  name(value, path);
  if ((!targets || targets.includes('node')) && reservedTypeNames.has(value))
    fail(path, 'model name is a TypeScript reserved word; customize it with config.models');
}
function name(value: unknown, path: string, method = false): asserts value is string {
  if (
    typeof value !== 'string' ||
    !identifier.test(value) ||
    (reserved.has(value.toLowerCase()) && !(method && value.toLowerCase() === 'list'))
  )
    fail(
      path,
      'choose an identifier that is not a JavaScript/PHP reserved word or SDK runtime member',
    );
}
function keys(object: object, allowed: string[], path: string) {
  if (!object || typeof object !== 'object' || Array.isArray(object))
    fail(path, 'expected an object');
  for (const k of Object.keys(object))
    if (!allowed.includes(k))
      fail(`${path}/${k}`, 'unsupported setting; consult docs/configuration.md');
}
function record(value: unknown, path: string): asserts value is Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'expected an object');
}
function own<T>(map: Record<string, T> | undefined, key: string): T | undefined {
  return map && Object.hasOwn(map, key) ? map[key] : undefined;
}
function strings(value: unknown, path: string): void {
  if (
    !Array.isArray(value) ||
    value.some((v) => typeof v !== 'string') ||
    new Set(value).size !== value.length
  )
    fail(path, 'expected an array of unique strings');
}
function header(value: unknown, path: string) {
  if (typeof value !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value))
    fail(path, 'expected an HTTP header name');
}
// Project a configured field path without flattening alternatives into
// conjunctions. An absent field contributes no type evidence in its alternative.
function schemaField(s: Schema | undefined, path: string): Schema | undefined {
  if (!s) return undefined;
  const [first, ...rest] = path.split('.');
  if (first === undefined) return undefined;
  const project = (shape: Schema): Schema | undefined => {
    const parts: Schema[] = [];
    const child = own(shape.properties, first);
    if (child) parts.push(child);
    for (const branch of shape.allOf ?? []) {
      const field = project(branch);
      if (field) parts.push(field);
    }
    for (const branches of [shape.oneOf, shape.anyOf]) {
      if (!branches) continue;
      const fields = branches.map(project);
      if (fields.some((field) => field !== undefined))
        parts.push({ anyOf: fields.map((field) => field ?? {}) });
    }
    return parts.length ? { allOf: parts } : undefined;
  };
  const field = project(s);
  return rest.length ? schemaField(field, rest.join('.')) : field;
}
function hasType(s: Schema, type: string): boolean {
  const possible = (shape: Schema): Set<string> => {
    const declared =
      shape.type === undefined
        ? ['null', 'boolean', 'object', 'array', 'string', 'integer', 'number']
        : Array.isArray(shape.type)
          ? shape.type
          : [shape.type];
    let kinds = new Set(declared);
    if (kinds.has('number')) kinds.add('integer');
    const intersect = (other: Set<string>): void => {
      kinds = new Set([...kinds].filter((kind) => other.has(kind)));
    };
    for (const branch of shape.allOf ?? []) intersect(possible(branch));
    for (const branches of [shape.oneOf, shape.anyOf])
      if (branches) intersect(new Set(branches.flatMap((branch) => [...possible(branch)])));
    return kinds;
  };
  const kinds = possible(s);
  return kinds.has(type) && [...kinds].every((kind) => kind === type || kind === 'null');
}
// Parameter serialization requires one explicit wire shape; conjuncts may add
// constraints without repeating it. Alternatives remain outside this subset.
function parameterType(s: Schema, p: string, item = false): string {
  const shapes = (value: Schema): Schema[] => [value, ...(value.allOf ?? []).flatMap(shapes)];
  const parts = shapes(s);
  const declared = parts.flatMap((part) =>
    part.type === undefined ? [] : [Array.isArray(part.type) ? part.type : [part.type]],
  );
  const types = declared.reduce(
    (accepted, kinds) =>
      accepted.filter(
        (kind) => kinds.includes(kind) || (kind === 'integer' && kinds.includes('number')),
      ),
    ['null', 'boolean', 'object', 'array', 'string', 'integer', 'number'],
  );
  const allowed = item
    ? ['string', 'integer', 'boolean']
    : ['string', 'integer', 'number', 'boolean', 'array'];
  // A number declaration also permits integer instances, using one numeric encoding.
  if (types.includes('number')) types.splice(types.indexOf('integer'), 1);
  if (
    !declared.length ||
    types.length !== 1 ||
    !allowed.includes(String(types[0])) ||
    parts.some((part) => part.oneOf || part.anyOf || part.not || part['x-sdk-ref'])
  )
    fail(p, 'parameters require an explicit non-null scalar type or scalar array');
  const type = String(types[0]);
  if (type === 'array') {
    const items = parts.flatMap((part) => (part.items ? [part.items] : []));
    if (!items.length) fail(p, 'parameter arrays require scalar items');
    parameterType({ allOf: items }, p + '/items', true);
  }
  return type;
}
// A deliberately portable ECMAScript subset; translate differences in PCRE rather
// than silently applying a different pattern in the PHP target.
function portablePattern(source: string, p: string): string {
  try {
    new RegExp(source, 'u');
  } catch {
    fail(p, 'invalid Unicode regular expression');
  }
  const space =
    '\\x09-\\x0d\\x20\\x{00a0}\\x{1680}\\x{2000}-\\x{200a}\\x{2028}\\x{2029}\\x{202f}\\x{205f}\\x{3000}\\x{feff}';
  // PHP's /u enables Unicode properties for these escapes; ECMAScript /u
  // retains ASCII digit/word classes. Explicit ranges also work inside [].
  const classes: Record<string, string> = {
    d: '0-9',
    D: '\\x00-\\x2f\\x3a-\\x{10ffff}',
    w: 'A-Za-z0-9_',
    W: '\\x00-\\x2f\\x3a-\\x40\\x5b-\\x5e\\x60\\x7b-\\x{10ffff}',
  };
  let result = '',
    inClass = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    if (ch === '\\') {
      const next = source[++i]!;
      if (classes[next]) result += inClass ? classes[next] : '[' + classes[next] + ']';
      else if (next === 's') result += inClass ? space : '[' + space + ']';
      else if (next === 'S' && !inClass) result += '[^' + space + ']';
      else if (next === 'v') result += '\\x0b';
      else if (next === 'u') {
        const hex = source.slice(i + 1, i + 5);
        if (!/^[0-9a-f]{4}$/i.test(hex) || /^[dD][89a-fA-F]/.test(hex))
          fail(p, 'use literal Unicode characters instead of surrogate or braced escapes');
        result += '\\x{' + hex + '}';
        i += 4;
      } else if ('nrtfv\\.^$|?*+()[]{}-/'.includes(next)) result += '\\' + next;
      else if (next === 'x' && /^[0-9a-f]{2}$/i.test(source.slice(i + 1, i + 3))) {
        result += '\\x' + source.slice(i + 1, i + 3);
        i += 2;
      } else fail(p, 'unsupported pattern escape; use portable character classes');
    } else if (ch === '[' && !inClass) {
      if (source[i + 1] === ']' || (source[i + 1] === '^' && source[i + 2] === ']'))
        fail(p, 'empty character classes are unsupported; use an explicit character range');
      inClass = true;
      result += ch;
    } else if (ch === ']' && inClass) {
      inClass = false;
      result += ch;
    } else if (!inClass && ch === '(' && source[i + 1] === '?' && source[i + 2] !== ':')
      fail(
        p,
        'lookarounds and special groups are unsupported; use ordinary or noncapturing groups',
      );
    else if (!inClass && ch === '.') result += '[^\\n\\r\\x{2028}\\x{2029}]';
    else if (!inClass && ch === '^') result += '\\A';
    else if (!inClass && ch === '$') result += '\\z';
    else result += ch;
  }
  return '~' + result.replaceAll('~', '\\~') + '~u';
}
function schema(s: Schema, p: string, legacy = false, explicitNumbers = false): void {
  if (!s || typeof s !== 'object' || Array.isArray(s)) fail(p, 'expected a schema object');
  if (s['x-sdk-ref']) return;
  if (s.nullable !== undefined) {
    if (!legacy || typeof s.nullable !== 'boolean')
      fail(p + '/nullable', 'nullable is an OpenAPI 3.0 boolean; use a null type in 3.1');
    const nullable = s.nullable;
    delete s.nullable;
    if (nullable) {
      if (typeof s.type === 'string') s.type = [s.type, 'null'];
      else {
        const original = { ...s };
        for (const key of Object.keys(s)) delete s[key];
        Object.assign(
          s,
          Object.fromEntries(
            Object.entries(original).filter(([key]) =>
              [
                'description',
                'title',
                'readOnly',
                'writeOnly',
                'deprecated',
                'x-sensitive',
              ].includes(key),
            ),
          ),
          { anyOf: [original, { type: 'null' }] },
        );
      }
    }
  }
  const annotations = [
    'description',
    'title',
    'default',
    'example',
    'examples',
    'deprecated',
    'readOnly',
    'writeOnly',
    'x-sensitive',
  ];
  const supported = [
    'type',
    'properties',
    'required',
    'items',
    'enum',
    'const',
    'oneOf',
    'anyOf',
    'allOf',
    'not',
    'contains',
    'if',
    'then',
    'else',
    'discriminator',
    'additionalProperties',
    'format',
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
    'pattern',
    'uniqueItems',
    ...annotations,
  ];
  keys(
    Object.fromEntries(Object.entries(s).filter(([key]) => !key.startsWith('x-'))),
    supported,
    p,
  );
  for (const keyword of ['exclusiveMinimum', 'exclusiveMaximum'] as const) {
    const value = s[keyword] as unknown;
    if (legacy && typeof value === 'boolean') {
      const bound = keyword === 'exclusiveMinimum' ? 'minimum' : 'maximum';
      delete s[keyword];
      if (value) {
        if (s[bound] === undefined) fail(p + '/' + keyword, 'requires ' + bound);
        s[keyword] = s[bound]!;
        delete s[bound];
      }
    }
  }
  for (const keyword of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'] as const)
    if (
      s[keyword] !== undefined &&
      (typeof s[keyword] !== 'number' ||
        !Number.isFinite(s[keyword]) ||
        (Number.isInteger(s[keyword]) && !Number.isSafeInteger(s[keyword])))
    )
      fail(
        p + '/' + keyword,
        'expected a finite numeric bound; integer literals must be safe integers',
      );
  if (
    s.multipleOf !== undefined &&
    (typeof s.multipleOf !== 'number' ||
      !Number.isFinite(s.multipleOf) ||
      s.multipleOf <= 0 ||
      (Number.isInteger(s.multipleOf) && !Number.isSafeInteger(s.multipleOf)))
  )
    fail(p + '/multipleOf', 'expected a positive finite divisor with a safe integer literal');
  for (const keyword of [
    'minLength',
    'maxLength',
    'minItems',
    'maxItems',
    'minProperties',
    'maxProperties',
  ] as const)
    if (s[keyword] !== undefined && (!Number.isSafeInteger(s[keyword]) || s[keyword]! < 0))
      fail(p + '/' + keyword, 'expected a nonnegative safe integer');
  for (const [min, max] of [
    ['minLength', 'maxLength'],
    ['minItems', 'maxItems'],
    ['minProperties', 'maxProperties'],
    ['minimum', 'maximum'],
  ] as const)
    if (s[min] !== undefined && s[max] !== undefined && s[min]! > s[max]!)
      fail(p, min + ' exceeds ' + max);
  if (s.pattern !== undefined) {
    if (typeof s.pattern !== 'string') fail(p + '/pattern', 'expected a string');
    s['x-sdk-pattern-php'] = portablePattern(s.pattern, p + '/pattern');
  }
  for (const key of ['readOnly', 'writeOnly', 'deprecated', 'x-sensitive', 'uniqueItems'])
    if (s[key] !== undefined && typeof s[key] !== 'boolean')
      fail(p + '/' + key, 'expected a boolean');
  if (s.readOnly && s.writeOnly) fail(p, 'a field cannot be both readOnly and writeOnly');
  if (s.required !== undefined) strings(s.required, p + '/required');
  if (
    s.properties !== undefined &&
    (!s.properties || typeof s.properties !== 'object' || Array.isArray(s.properties))
  )
    fail(p + '/properties', 'expected a property map');
  if (
    s.additionalProperties !== undefined &&
    typeof s.additionalProperties !== 'boolean' &&
    (!s.additionalProperties ||
      typeof s.additionalProperties !== 'object' ||
      Array.isArray(s.additionalProperties))
  )
    fail(p + '/additionalProperties', 'expected a boolean or schema');
  if (Object.hasOwn(s, 'const')) {
    const literal = (value: unknown, location: string, depth = 0): void => {
      if (depth > 256) fail(location, 'constant exceeds the supported nesting depth');
      if (
        typeof value === 'number' &&
        (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))
      )
        fail(
          location,
          'numeric constant literals must be finite; integer literals must be safe integers',
        );
      if (value && typeof value === 'object')
        for (const [key, child] of Object.entries(value))
          literal(child, location + '/' + key, depth + 1);
    };
    literal(s.const, p + '/const');
  }
  if (
    Object.hasOwn(s, 'const') &&
    (s.const === null || typeof s.const !== 'object') &&
    (typeof s.const !== 'number' || Number.isSafeInteger(s.const)) &&
    s.enum === undefined
  )
    s.enum = [s.const!];
  if (
    s.enum !== undefined &&
    (!Array.isArray(s.enum) ||
      !s.enum.length ||
      s.enum.some((v) => typeof v === 'object' && v !== null))
  )
    fail(p, 'enum requires nonempty scalar values');
  for (const keyword of ['oneOf', 'anyOf', 'allOf'] as const) {
    const branches = s[keyword];
    if (branches !== undefined) {
      if (!Array.isArray(branches) || !branches.length)
        fail(p + '/' + keyword, 'expected a nonempty schema array');
      branches.forEach((branch, i) =>
        schema(branch, p + '/' + keyword + '/' + i, legacy, explicitNumbers),
      );
    }
  }
  if (s.not !== undefined) schema(s.not, p + '/not', legacy, explicitNumbers);
  if (s.contains !== undefined) schema(s.contains, p + '/contains', legacy, explicitNumbers);
  for (const keyword of ['if', 'then', 'else'] as const)
    if (s[keyword] !== undefined) schema(s[keyword], p + '/' + keyword, legacy, explicitNumbers);
  if (s.discriminator !== undefined) {
    keys(s.discriminator, ['propertyName', 'mapping'], p + '/discriminator');
    if (
      typeof s.discriminator.propertyName !== 'string' ||
      !s.discriminator.propertyName ||
      !s.oneOf
    )
      fail(p, 'discriminator requires propertyName and oneOf alternatives');
    const bindings = discriminatorBindings(s);
    for (const [tag, index] of Object.entries(s['x-sdk-discriminator-mapping'] ?? {}))
      if (bindings && bindings[tag] !== index)
        fail(
          p + '/discriminator/mapping/' + tag,
          'mapping conflicts with branch literal constraints',
        );
  }

  const types = s.type === undefined ? [] : Array.isArray(s.type) ? s.type : [s.type];
  if (
    s.type !== undefined &&
    (!types.length ||
      new Set(types).size !== types.length ||
      types.some(
        (t) => !['object', 'array', 'string', 'integer', 'number', 'boolean', 'null'].includes(t),
      ))
  )
    fail(p + '/type', 'expected supported unique JSON types');
  if (types.length > 1 && (types.length !== 2 || !types.includes('null')))
    fail(p, 'use anyOf for non-null type alternatives');
  if (s.enum?.some((v) => typeof v === 'number' && !Number.isSafeInteger(v)))
    fail(p + '/enum', 'numeric enum literals must be safe integers');
  if (
    s.enum?.some(
      (v) =>
        types.length &&
        !types.includes(
          v === null
            ? 'null'
            : typeof v === 'number'
              ? types.includes('integer')
                ? 'integer'
                : 'number'
              : typeof v,
        ),
    )
  )
    fail(p + '/enum', 'enum members must match the declared type');
  if (
    s.format &&
    ![
      'int32',
      'int64',
      'uint32',
      'uint64',
      'float',
      'double',
      'decimal',
      'date-time',
      'date',
      'uuid',
      'email',
      'uri',
      'password',
      'hostname',
    ].includes(s.format)
  )
    fail(p + '/format', 'unsupported format ' + s.format);
  if (types.includes('array') && !s.items) {
    // Absent items imposes no element constraint. Sibling item constraints
    // retain their scope; the neutral local shape supplies target array types.
    s.items = {};
  }
  if (s.items) schema(s.items, p + '/items', legacy, explicitNumbers);
  for (const [key, child] of Object.entries(s.properties ?? {}))
    schema(child, p + '/properties/' + key, legacy, explicitNumbers);
  if (s.additionalProperties && typeof s.additionalProperties === 'object')
    schema(s.additionalProperties, p + '/additionalProperties', legacy, explicitNumbers);
  checkRepresentations(s, p, explicitNumbers);
  // Annotation-only wrappers are equivalent to their branch; semantic siblings stay composed.
  if (
    s.allOf?.length === 1 &&
    !s.allOf[0]!['x-sdk-ref'] &&
    Object.keys(s).every(
      (key) => key === 'allOf' || annotations.includes(key) || key.startsWith('x-'),
    )
  ) {
    const branch = s.allOf[0]!;
    delete s.allOf;
    Object.assign(s, branch, { ...s });
  }
}
function checkRepresentations(s: Schema, p: string, explicitNumbers = false): void {
  const conjuncts = (shape: Schema): Schema[] => [shape, ...(shape.allOf ?? []).flatMap(conjuncts)];
  const scalar = (shape: Schema): string | undefined => {
    const type = Array.isArray(shape.type) ? shape.type.find((t) => t !== 'null') : shape.type;
    if (shape['x-sdk-number-input'] === 'explicit') return 'wrapped-number';
    if (type === 'number') return 'exact-number';
    if (type === 'integer')
      return exactValue(valueInstruction('integer', shape.format))
        ? 'exact-number'
        : 'safe-integer';
    return type === 'string' ? 'string' : undefined;
  };
  const shapes = conjuncts(s);
  const kinds = new Set(shapes.map(scalar).filter(Boolean));
  if (kinds.has('exact-number') && kinds.has('safe-integer'))
    fail(
      p,
      'intersected numeric schemas use different SDK representations; use a consistent numeric format with the intersected bounds in a provider override',
    );
  if (kinds.has('string') && (kinds.has('exact-number') || kinds.has('safe-integer')))
    fail(p, 'intersected string and numeric schemas cannot describe the same non-null JSON value');
  // Constraint-only conjuncts must see the JSON numeric kind, even when callers
  // express that number as an exact SDK string. Inherit only an established kind.
  const numeric = shapes.find((shape) =>
    ['exact-number', 'safe-integer'].includes(scalar(shape) ?? ''),
  );
  if (numeric) {
    const inherit = (shape: Schema): void => {
      if (shape['x-sdk-ref']) return;
      if (shape.type === undefined) {
        shape.type = structuredClone(numeric.type!);
        if (numeric.format !== undefined && shape.format === undefined)
          shape.format = numeric.format;
      }
      for (const branch of [
        ...(shape.allOf ?? []),
        ...(shape.anyOf ?? []),
        ...(shape.oneOf ?? []),
        ...(shape.not ? [shape.not] : []),
      ])
        inherit(branch);
    };
    inherit(s);
    const inheritedKinds = new Set(shapes.map(scalar));
    if (inheritedKinds.has('exact-number') && inheritedKinds.has('safe-integer'))
      fail(
        p,
        'intersected numeric schemas use different SDK representations; use a consistent numeric format with the intersected bounds in a provider override',
      );
  }
  // Compare the caller representations at corresponding paths, not just at the
  // roots of alternatives. Exact JSON numbers and JSON strings both use SDK strings.
  type Relation = 'alternatives' | 'intersection';
  const representationTypes = (shape: Schema, relation: Relation): string[] | undefined => {
    if (shape.type === undefined) return undefined;
    const types = Array.isArray(shape.type) ? shape.type : [shape.type];
    // Intersections compare JSON kinds: native and exact SDK numbers overlap
    // on the wire even though their TypeScript input types are disjoint.
    if (relation === 'intersection')
      return types.includes('number') ? [...types, 'integer'] : types;
    return types.map((type) =>
      type === 'number' || (type === 'integer' && scalar(shape) === 'exact-number')
        ? shape['x-sdk-number-input'] === 'explicit'
          ? 'wrapped-number'
          : 'string'
        : type,
    );
  };
  const disjoint = (left: Schema[], right: Schema[], relation: Relation): boolean => {
    for (const a of left)
      for (const b of right) {
        const at = representationTypes(a, relation),
          bt = representationTypes(b, relation);
        if (at && bt && !at.some((type) => bt.includes(type))) return true;
        // Non-numeric enums can distinguish tagged object alternatives without
        // confusing numeric enums with their exact string representations.
        if (
          a.enum &&
          b.enum &&
          [...a.enum, ...b.enum].every((v) => typeof v !== 'number') &&
          !a.enum.some((v) => b.enum!.includes(v))
        )
          return true;
      }
    const required = new Set([...left, ...right].flatMap((shape) => shape.required ?? []));
    for (const key of required) {
      const children = (shapes: Schema[]) =>
        shapes.flatMap((shape) =>
          Object.hasOwn(shape.properties ?? {}, key) ? conjuncts(shape.properties![key]!) : [],
        );
      const a = children(left),
        b = children(right);
      if ([...a, ...b].some((child) => child.readOnly)) continue;
      if (
        [...left, ...right].some(
          (shape) =>
            shape.additionalProperties === false && !Object.hasOwn(shape.properties ?? {}, key),
        )
      )
        return true;
      if (disjoint(a, b, relation)) return true;
    }
    return false;
  };
  const checkOverlap = (
    left: Schema[],
    right: Schema[],
    path: string,
    relation: Relation = 'alternatives',
  ): void => {
    if (!left.length || !right.length) return;
    const originals = new Map<Schema, Schema>();
    const shallow = (shape: Schema): Schema => {
      const { allOf, ...copy } = shape;
      originals.set(copy, shape);
      return copy;
    };
    left = left.flatMap(conjuncts).map(shallow);
    right = right.flatMap(conjuncts).map(shallow);
    if (disjoint(left, right, relation)) return;
    // Keep branch constraints together so disjoint tags are not lost while
    // looking through nested alternatives and intersections.
    for (const [side, other, reversed] of [
      [left, right, false],
      [right, left, true],
    ] as const) {
      for (const [i, shape] of side.entries()) {
        const keyword = shape.oneOf ? 'oneOf' : shape.anyOf ? 'anyOf' : undefined;
        if (!keyword) continue;
        const base = { ...shape };
        delete base[keyword];
        for (const branch of shape[keyword]!) {
          const selected = [...side.slice(0, i), base, branch, ...side.slice(i + 1)];
          checkOverlap(reversed ? other : selected, reversed ? selected : other, path, relation);
        }
        return;
      }
    }
    const a = new Set(left.map(scalar)),
      b = new Set(right.map(scalar));
    if (relation === 'intersection') {
      if (
        (a.has('exact-number') && b.has('safe-integer')) ||
        (b.has('exact-number') && a.has('safe-integer'))
      )
        fail(
          path,
          'intersected numeric schemas use different SDK representations; use a consistent numeric format with the intersected bounds in a provider override',
        );
    } else if (
      (a.has('string') && b.has('exact-number')) ||
      (b.has('string') && a.has('exact-number'))
    ) {
      if (!explicitNumbers)
        fail(
          path,
          'string and exact-number alternatives have ambiguous SDK string inputs; provide an unambiguous provider representation before generating this operation',
        );
      for (const shape of [...left, ...right]) {
        if (scalar(shape) === 'exact-number') {
          shape['x-sdk-number-input'] = 'explicit';
          const original = originals.get(shape);
          if (original) original['x-sdk-number-input'] = 'explicit';
        }
      }
    }
    const keys = new Set(
      [...left, ...right].flatMap((shape) => Object.keys(shape.properties ?? {})),
    );
    for (const key of keys) {
      const children = (shapes: Schema[]) =>
        shapes.flatMap((shape) => {
          const child = own(shape.properties, key);
          return child
            ? [child]
            : typeof shape.additionalProperties === 'object'
              ? [shape.additionalProperties]
              : [];
        });
      checkOverlap(children(left), children(right), path + '/properties/' + key, relation);
    }
    checkItems(left, right, path, relation);
  };
  const checkItems = (left: Schema[], right: Schema[], path: string, relation: Relation): void => {
    const a = left.flatMap((shape) => (shape.items ? [shape.items] : []));
    const b = right.flatMap((shape) => (shape.items ? [shape.items] : []));
    if (a.length && b.length) checkOverlap(a, b, path + '/items', relation);
    const additional = (shapes: Schema[]) =>
      shapes.flatMap((shape) =>
        typeof shape.additionalProperties === 'object' ? [shape.additionalProperties] : [],
      );
    const x = additional(left),
      y = additional(right);
    if (x.length && y.length) checkOverlap(x, y, path + '/additionalProperties', relation);
  };
  for (const keyword of ['oneOf', 'anyOf'] as const) {
    const alternatives = s[keyword];
    if (!alternatives) continue;
    for (let i = 0; i < alternatives.length; i++)
      for (let j = i + 1; j < alternatives.length; j++)
        checkOverlap([alternatives[i]!], [alternatives[j]!], p + '/' + keyword);
  }
  if (s.allOf) {
    // Each flattened conjunct keeps its own alternatives. Compare overlapping
    // branches across conjuncts without intersecting alternatives of one union.
    const peers = shapes.map(({ allOf, ...shape }) => shape);
    for (const [index, left] of peers.entries())
      for (const right of peers.slice(index + 1))
        checkOverlap([left], [right], p + '/allOf', 'intersection');
    visitIntersectedProperties(shapes, (children, name) => {
      if (children.length > 1)
        checkRepresentations({ allOf: children }, p + '/properties/' + name, explicitNumbers);
    });
    // These conjuncts describe the same elements/values, just as matching
    // properties describe the same field. Constraint-only schemas must see the
    // numeric JSON kind rather than the caller's exact-number string.
    const items = shapes.flatMap((shape) => (shape.items ? [shape.items] : []));
    if (items.length > 1) checkRepresentations({ allOf: items }, p + '/items', explicitNumbers);
    const additional = shapes.flatMap((shape) =>
      typeof shape.additionalProperties === 'object' ? [shape.additionalProperties] : [],
    );
    if (additional.length > 1)
      checkRepresentations({ allOf: additional }, p + '/additionalProperties', explicitNumbers);
  }
}
function pointer(root: unknown, pointer: string, p: string): any {
  if (pointer === '') return root;
  if (!pointer.startsWith('/')) fail(p, 'reference fragment must be a JSON Pointer');
  let current: any = root;
  for (const part of pointer.slice(1).split('/')) {
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
    current = current != null && Object.hasOwn(current, key) ? current[key] : undefined;
    if (current === undefined) fail(p, `unresolved reference #${pointer}`);
  }
  return current;
}
export function loadContract(definitionPath: string, configPath: string): Contract {
  const sources: Record<string, string> = {};
  const documents = new Map<string, unknown>();
  const rootDir = dirname(resolve(definitionPath));
  const references: { path: string; model: string }[] = [];
  const resolved = new Map<string, { value: any; models: string[] }>();
  const cycles = new Map<string, string>();
  // Context follows the use site, including when the target is an external fragment.
  // Map keys and annotation values are data, never OpenAPI keywords.
  type Context = string;
  const childContext = (context: Context, key: string): Context => {
    if (context.startsWith('map:')) return context.slice(4);
    if (context === 'schema') {
      if (key === 'properties') return 'map:schema';
      if (
        [
          'items',
          'additionalProperties',
          'allOf',
          'anyOf',
          'oneOf',
          'not',
          'contains',
          'if',
          'then',
          'else',
        ].includes(key)
      )
        return 'schema';
      return 'literal';
    }
    if (context === 'root')
      return key === 'components' ? 'components' : key === 'paths' ? 'map:pathItem' : 'literal';
    if (context === 'components') {
      const kinds: Record<string, string> = {
        schemas: 'schema',
        parameters: 'parameter',
        responses: 'response',
        requestBodies: 'requestBody',
        headers: 'header',
        securitySchemes: 'securityScheme',
        examples: 'example',
        links: 'link',
        pathItems: 'pathItem',
      };
      return own(kinds, key) ? 'map:' + kinds[key] : 'literal';
    }
    if (
      context === 'pathItem' &&
      ['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace'].includes(key)
    )
      return 'operation';
    if (['operation', 'pathItem'].includes(context) && key === 'parameters') return 'parameter';
    if (context === 'operation' && key === 'requestBody') return 'requestBody';
    if (context === 'operation' && key === 'responses') return 'map:response';
    if (['parameter', 'header', 'media'].includes(context) && key === 'schema') return 'schema';
    if (['parameter', 'header', 'requestBody', 'response'].includes(context) && key === 'content')
      return 'map:media';
    if (context === 'response' && key === 'headers') return 'map:header';
    if (context === 'response' && key === 'links') return 'map:link';
    return 'literal';
  };
  function load(file: string): any {
    file = resolve(file);
    if (!documents.has(file)) {
      let content: string;
      try {
        content = readFileSync(file, 'utf8');
      } catch {
        return fail(file, 'cannot read input');
      }
      try {
        documents.set(file, JSON.parse(content));
      } catch {
        return fail(file, 'expected valid JSON; YAML is not supported');
      }
      sources[
        file.startsWith(rootDir + '/')
          ? file.slice(rootDir.length + 1)
          : hash(relativePath(rootDir, file))
      ] = hash(content);
    }
    return documents.get(file);
  }
  function deref(
    value: any,
    file: string,
    path: string,
    stack: { key: string; path: string }[] = [],
    context: Context = 'root',
  ): any {
    if (context === 'literal') return structuredClone(value);
    if (Array.isArray(value))
      return value.map((v, i) => deref(v, file, `${path}/${i}`, stack, context));
    if (!value || typeof value !== 'object') return value;
    const map = context.startsWith('map:');
    if (!map && Object.keys(value).some((key) => key.startsWith('x-sdk-')))
      fail(path, 'x-sdk-* extensions are reserved for resolved generator metadata');
    if (!map && '$ref' in value) {
      const applySiblings = (result: any): any => {
        if (raw.openapi.startsWith('3.0.')) return result;
        const { $ref, ...siblings } = value;
        if (context === 'schema') {
          if (!Object.keys(siblings).length) return result;
          record(result, path);
          const local = deref(siblings, file, path, stack, context);
          if (local.allOf !== undefined && (!Array.isArray(local.allOf) || !local.allOf.length))
            fail(path + '/allOf', 'expected a nonempty schema array');
          for (const key of ['readOnly', 'writeOnly', 'x-sensitive'])
            if (local[key] !== undefined && typeof local[key] !== 'boolean')
              fail(path + '/' + key, 'expected a boolean');
          // Preserve keyword scope (especially additionalProperties and alternatives).
          // The referenced target remains a separate conjunct, even at recursive edges.
          const metadata = Object.fromEntries(
            Object.entries(result).filter(
              ([key]) =>
                [
                  'title',
                  'description',
                  'default',
                  'example',
                  'examples',
                  'deprecated',
                  'readOnly',
                  'writeOnly',
                ].includes(key) ||
                (key.startsWith('x-') && !key.startsWith('x-sdk-')),
            ),
          );
          const combined = { ...metadata, ...local, allOf: [result, ...(local.allOf ?? [])] };
          for (const key of ['readOnly', 'writeOnly', 'x-sensitive'])
            if (result[key] === true || local[key] === true) combined[key] = true;
          return combined;
        }
        for (const key of ['summary', 'description']) {
          if (!Object.hasOwn(siblings, key)) continue;
          if (typeof siblings[key] !== 'string') fail(path + '/' + key, 'expected a string');
          const supported =
            key === 'summary'
              ? ['example']
              : [
                  'parameter',
                  'header',
                  'response',
                  'requestBody',
                  'securityScheme',
                  'example',
                  'link',
                ];
          if (supported.includes(context)) result[key] = siblings[key];
        }
        return result;
      };
      const ref = value.$ref;
      if (typeof ref !== 'string' || /^\w+:/.test(ref) || ref.startsWith('//'))
        fail(path, 'remote references must be vendored locally for reproducible generation');
      const [relative, fragment = ''] = ref.split('#');
      const target = resolve(dirname(file), relative || file);
      const modelMatch = /^\/components\/schemas\/([^/]+)$/.exec(fragment);
      if (context === 'schema' && target === resolve(definitionPath) && modelMatch)
        references.push({ path, model: modelMatch[1]!.replace(/~1/g, '/').replace(/~0/g, '~') });
      const key = target + '#' + fragment;
      const cacheKey = context + ':' + key;
      const ancestor = stack.find((entry) => entry.key === cacheKey);
      if (ancestor) {
        if (
          context !== 'schema' ||
          !/\/(?:properties|items|additionalProperties)\//.test(
            path.slice(ancestor.path.length) + '/',
          )
        )
          fail(
            path,
            `recursive reference ${ref} must descend through an object field or array item`,
          );
        const original =
          target === resolve(definitionPath) && modelMatch
            ? modelMatch[1]!.replace(/~1/g, '/').replace(/~0/g, '~')
            : undefined;
        const mapped = original
          ? (own(config.models, original) ?? original)
          : 'ReferencedModel' + hash(relativePath(rootDir, target) + '#' + fragment).slice(0, 12);
        if (cycles.has(mapped) && cycles.get(mapped) !== key)
          fail(path, 'recursive model name collision');
        cycles.set(mapped, key);
        return applySiblings({ 'x-sdk-ref': mapped });
      }
      const cached = resolved.get(cacheKey);
      if (cached) {
        for (const model of cached.models) references.push({ path, model });
        return applySiblings(structuredClone(cached.value));
      }
      const before = references.length;
      const result = deref(
        pointer(load(target), fragment, path),
        target,
        path,
        [...stack, { key: cacheKey, path }],
        context,
      );
      resolved.set(cacheKey, {
        value: result,
        models: [...new Set(references.slice(before).map((ref) => ref.model))],
      });
      return applySiblings(structuredClone(result));
    }
    const result = Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        deref(v, file, `${path}/${k}`, stack, childContext(context, k)),
      ]),
    );
    if (context === 'schema' && value.discriminator?.mapping !== undefined) {
      const mapping = value.discriminator.mapping;
      record(mapping, path + '/discriminator/mapping');
      if (!Array.isArray(result.oneOf))
        fail(path + '/discriminator', 'mapping requires oneOf branches');
      const bindings: Record<string, number> = Object.create(null);
      for (const [tag, target] of Object.entries(mapping)) {
        const location = path + '/discriminator/mapping/' + tag;
        if (typeof target !== 'string') fail(location, 'expected a local schema reference');
        const ref = Object.hasOwn(load(file).components?.schemas ?? {}, target)
          ? '#/components/schemas/' + target.replaceAll('~', '~0').replaceAll('/', '~1')
          : target;
        const resolvedTarget = deref({ $ref: ref }, file, location, stack, 'schema');
        const referenceKeys = (
          shape: Schema,
          source: string,
          seen = new Set<string>(),
          includeConjuncts = true,
        ): Set<string> => {
          const keys = new Set<string>();
          if (typeof shape.$ref === 'string') {
            const [relative, fragment = ''] = shape.$ref.split('#');
            const targetFile = resolve(dirname(source), relative || source);
            const key = targetFile + '#' + fragment;
            keys.add(key);
            if (!seen.has(key))
              for (const child of referenceKeys(
                pointer(load(targetFile), fragment, location),
                targetFile,
                new Set([...seen, key]),
                includeConjuncts,
              ))
                keys.add(child);
          }
          for (const branch of includeConjuncts ? (shape.allOf ?? []) : [])
            for (const key of referenceKeys(branch, source, seen)) keys.add(key);
          return keys;
        };
        // Target aliases identify the same schema; an inherited allOf base does
        // not. Sibling variants may legitimately reference that same base.
        const targetKeys = referenceKeys({ $ref: ref }, file, new Set(), false);
        const branchKeys = (value.oneOf as Schema[]).map((branch) => referenceKeys(branch, file));
        // Prefer the named target before following its aliases. A referenced
        // schema can also add sibling assertions to a shared base reference.
        const declared =
          [...targetKeys]
            .map((key) => branchKeys.flatMap((keys, index) => (keys.has(key) ? [index] : [])))
            .find((indices) => indices.length) ?? [];
        const matches = (branch: Schema): boolean =>
          stable(branch) === stable(resolvedTarget) || Boolean(branch.allOf?.some(matches));
        const indices = declared.length
          ? declared
          : (result.oneOf as Schema[]).flatMap((branch, index) => (matches(branch) ? [index] : []));
        if (indices.length !== 1)
          fail(location, 'mapping target must identify exactly one declared branch');
        bindings[tag] = indices[0]!;
      }
      result['x-sdk-discriminator-mapping'] = bindings;
    }
    return result;
  }
  const raw = load(resolve(definitionPath));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    fail('/', 'expected an OpenAPI object');
  const mergeProfiles = (left: unknown, right: unknown, path: string): unknown => {
    if (left === undefined) return structuredClone(right);
    if (stable(left) === stable(right)) return structuredClone(left);
    if (
      Array.isArray(left) &&
      Array.isArray(right) &&
      (['config/include', 'config/targets'].includes(path) ||
        /^config\/auth\/modes\/[^/]+\/operations$/.test(path))
    )
      return [...new Set([...left, ...right])].sort();
    if (
      left &&
      right &&
      typeof left === 'object' &&
      typeof right === 'object' &&
      !Array.isArray(left) &&
      !Array.isArray(right)
    ) {
      const result: Record<string, unknown> = { ...left };
      for (const [key, value] of Object.entries(right))
        result[key] = mergeProfiles(result[key], value, path + '/' + key);
      return result;
    }
    return fail(path, 'conflicting SDK profile settings');
  };
  const loadProfile = (file: string, stack = new Set<string>()): unknown => {
    if (stack.has(file)) fail('config/profiles', 'profile reference cycle');
    const input = structuredClone(load(file));
    record(input, 'config');
    const { profiles, ...local } = input;
    let combined: unknown = {};
    if (profiles !== undefined) {
      strings(profiles, 'config/profiles');
      let unbounded = false;
      for (const profile of profiles) {
        const loaded = loadProfile(resolve(dirname(file), profile), new Set([...stack, file]));
        if (loaded && typeof loaded === 'object' && !Object.hasOwn(loaded, 'include'))
          unbounded = true;
        combined = mergeProfiles(combined, loaded, 'config');
      }
      if (unbounded && combined && typeof combined === 'object')
        Reflect.deleteProperty(combined, 'include');
    }
    return mergeProfiles(combined, local, 'config');
  };
  const config = loadProfile(resolve(configPath)) as Config;
  keys(
    config,
    [
      'targets',
      'validation',
      'numericUnions',
      'schemaSharing',
      'auth',
      'version',
      'npm',
      'composer',
      'operations',
      'models',
      'include',
      'audiences',
      'overrides',
      'webhook',
      'money',
      'apiVersion',
      'license',
      'errors',
      'documentation',
      'release',
    ],
    'config',
  );
  if (config.schemaSharing !== undefined && config.schemaSharing !== 'named')
    fail('config/schemaSharing', 'expected named');
  if (config.numericUnions !== undefined && config.numericUnions !== 'explicit')
    fail('config/numericUnions', 'expected explicit');
  if (config.validation !== undefined && !['encoding', 'schema'].includes(config.validation))
    fail('config/validation', 'expected encoding or schema');
  if (config.targets !== undefined) strings(config.targets, 'config/targets');
  if (config.targets?.length && !config.targets.includes('php') && config.composer === undefined)
    config.composer = { name: 'unused/sdk', namespace: 'UnusedSdk' };
  if (config.targets?.length && !config.targets.includes('node') && config.npm === undefined)
    config.npm = { name: 'unused-sdk' };
  for (const key of [
    'auth',
    'npm',
    'composer',
    'errors',
    'webhook',
    'money',
    'operations',
    'models',
    'overrides',
    'documentation',
    'release',
  ] as const)
    if (config[key] !== undefined) record(config[key], 'config/' + key);
  for (const [id, capability] of Object.entries(config.operations ?? {}))
    record(capability, 'config/operations/' + id);
  for (const [original, mapped] of Object.entries(config.models ?? {}))
    modelName(mapped, 'config/models/' + original, config.targets);
  if (config.release !== undefined) {
    keys(config.release, ['baseUrl', 'policy'], 'config/release');
    if (
      config.release.policy !== undefined &&
      !['review', 'semver'].includes(config.release.policy)
    )
      fail('config/release/policy', 'expected review or semver');
    if (config.release.baseUrl !== undefined) {
      let url: URL;
      try {
        url = new URL(config.release.baseUrl);
      } catch {
        return fail('config/release/baseUrl', 'expected an absolute publication URL');
      }
      if (
        (url.protocol !== 'https:' &&
          !(
            url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
          )) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        fail(
          'config/release/baseUrl',
          'use HTTPS without credentials/query/fragment (HTTP allowed only for loopback tests)',
        );
    }
  }
  if (config.errors !== undefined) {
    keys(config.errors, ['codePath', 'detailsPath', 'requestIdHeader'], 'config/errors');
    for (const key of ['codePath', 'detailsPath'] as const)
      if (
        config.errors[key] !== undefined &&
        (typeof config.errors[key] !== 'string' ||
          !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(config.errors[key]!))
      )
        fail(`config/errors/${key}`, 'expected a dot-separated field path');
    if (config.errors.requestIdHeader !== undefined)
      header(config.errors.requestIdHeader, 'config/errors/requestIdHeader');
  }
  if (config.documentation !== undefined) {
    keys(config.documentation, ['overview', 'guides'], 'config/documentation');
    if (
      config.documentation.overview !== undefined &&
      typeof config.documentation.overview !== 'string'
    )
      fail('config/documentation/overview', 'expected Markdown text');
    if (config.documentation.guides !== undefined) {
      if (
        !config.documentation.guides ||
        typeof config.documentation.guides !== 'object' ||
        Array.isArray(config.documentation.guides)
      )
        fail('config/documentation/guides', 'expected a guide-name to Markdown map');
      for (const [name, content] of Object.entries(config.documentation.guides))
        if (!/^[a-z0-9][a-z0-9-]*$/.test(name) || typeof content !== 'string')
          fail(
            `config/documentation/guides/${name}`,
            'use a lowercase guide slug and Markdown text',
          );
    }
  }
  keys(config.npm, ['name', 'registry', 'access'], 'config/npm');
  if (config.npm.registry) {
    let registry: URL;
    try {
      registry = new URL(config.npm.registry);
    } catch {
      return fail('config/npm/registry', 'expected an HTTPS registry URL');
    }
    if (
      registry.protocol !== 'https:' ||
      registry.username ||
      registry.password ||
      registry.search ||
      registry.hash
    )
      fail(
        'config/npm/registry',
        'expected an HTTPS registry URL without embedded credentials, query or fragment',
      );
  }
  if (config.npm.access !== undefined && !['public', 'restricted'].includes(config.npm.access))
    fail('config/npm/access', 'expected public or restricted');
  if (config.npm.access === 'restricted' && !config.npm.name?.startsWith('@'))
    fail('config/npm/access', 'restricted npm packages require a scoped package name');
  keys(config.composer, ['name', 'namespace'], 'config/composer');
  for (const key of ['targets', 'include', 'audiences'] as const)
    if (config[key] !== undefined) strings(config[key], `config/${key}`);
  for (const key of ['operations', 'models', 'overrides'] as const)
    if (
      config[key] !== undefined &&
      (!config[key] || typeof config[key] !== 'object' || Array.isArray(config[key]))
    )
      fail(`config/${key}`, 'expected an object map');
  if (!/^3\.[01]\.\d+$/.test(raw.openapi ?? ''))
    fail('/openapi', 'supported input is OpenAPI 3.0 or 3.1 JSON');
  if (
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?$/.test(
      config.version ?? '',
    )
  )
    fail('config/version', 'expected a semantic package version');
  if (!/^(@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(config.npm?.name ?? ''))
    fail('config/npm/name', 'expected an npm package name');
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(config.composer?.name ?? ''))
    fail('config/composer/name', 'expected vendor/package');
  if (!/^[A-Z][A-Za-z0-9]*(?:\\[A-Z][A-Za-z0-9]*)*$/.test(config.composer?.namespace ?? ''))
    fail('config/composer/namespace', 'expected a PHP namespace such as Acme\\Sdk');
  const targets = config.targets ?? ['node', 'php'];
  if (
    targets.includes('php') &&
    config.version.includes('-') &&
    !/^\d+\.\d+\.\d+-(?:alpha|beta|rc)(?:\.\d+)?$/.test(config.version)
  )
    fail(
      'config/version',
      'PHP-compatible prereleases use alpha, beta or rc, optionally followed by a numeric identifier (for example 1.2.0-beta.1)',
    );
  if (
    !targets.length ||
    new Set(targets).size !== targets.length ||
    targets.some((t) => !['node', 'php'].includes(t))
  )
    fail('config/targets', 'select node and/or php, each once');
  for (const [p, replacement] of Object.entries(config.overrides ?? {})) {
    const parts = p.split('/');
    const key = parts.pop()!;
    const parent = pointer(raw, parts.join('/'), `config/overrides/${p}`);
    if (!parent || typeof parent !== 'object')
      fail('config/overrides/' + p, 'override parent must be an object or array');
    const decoded = key.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!Object.hasOwn(parent, decoded)) fail(p, 'stale override target');
    parent[decoded] = replacement;
  }
  const reachable = new Set<string>();
  const visited = new Set<string>();
  const collect = (value: any, file: string, context: Context): void => {
    if (context === 'literal' || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const child of value) collect(child, file, context);
      return;
    }
    if (!context.startsWith('map:') && '$ref' in value) {
      const ref = value.$ref;
      if (typeof ref !== 'string' || /^\w+:/.test(ref) || ref.startsWith('//'))
        fail(String(ref), 'remote references must be vendored locally for reproducible generation');
      const [relative, fragment = ''] = ref.split('#');
      const target = resolve(dirname(file), relative || file);
      const key = context + ':' + target + '#' + fragment;
      const match = /^\/components\/schemas\/([^/]+)$/.exec(fragment);
      if (context === 'schema' && target === resolve(definitionPath) && match)
        reachable.add(match[1]!.replace(/~1/g, '/').replace(/~0/g, '~'));
      if (!visited.has(key)) {
        visited.add(key);
        collect(pointer(load(target), fragment, ref), target, context);
      }
      // Ignored Reference Object siblings must not load files or select models.
      if (context !== 'schema' || raw.openapi.startsWith('3.0.')) return;
    }
    for (const [key, child] of Object.entries(value))
      if (key !== '$ref' || context.startsWith('map:'))
        collect(child, file, childContext(context, key));
  };
  type PathField = { value: any; file: string };
  function pathFields(
    item: any,
    file: string,
    path: string,
    seen = new Set<string>(),
  ): Record<string, PathField> {
    record(item, path);
    let fields: Record<string, PathField> = {};
    if ('$ref' in item) {
      const ref = item.$ref;
      if (typeof ref !== 'string' || /^\w+:/.test(ref) || ref.startsWith('//'))
        fail(path, 'remote references must be vendored locally for reproducible generation');
      const [relative, fragment = ''] = ref.split('#');
      const target = resolve(dirname(file), relative || file);
      const key = target + '#' + fragment;
      if (seen.has(key)) fail(path, 'cyclic path item reference');
      seen.add(key);
      fields = pathFields(pointer(load(target), fragment, path), target, path, seen);
    }
    for (const [key, value] of Object.entries(item)) {
      if (key === '$ref') continue;
      if (key.startsWith('x-sdk-'))
        fail(path, 'x-sdk-* extensions are reserved for resolved generator metadata');
      if (Object.hasOwn(fields, key))
        fail(path + '/' + key, 'conflicting path item $ref field ' + key);
      Object.defineProperty(fields, key, {
        value: { value, file },
        enumerable: true,
        configurable: true,
      });
    }
    return fields;
  }
  const streamSchemas = new Map<string, Record<string, Schema>>();
  const selectedPaths = Object.fromEntries(
    Object.entries(raw.paths ?? {}).map(([path, item]) => {
      const fields = pathFields(item, resolve(definitionPath), '/paths/' + path);
      let selectedAny = false;
      const entries = Object.entries(fields)
        .filter(([key]) => key !== 'parameters')
        .map(([verb, field]) => {
          const { value: op, file } = field;
          const p = '/paths/' + path + '/' + verb;
          if (!['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(verb))
            return [verb, deref(op, file, p, [], childContext('pathItem', verb))];
          record(op, p);
          const c = own(config.operations, op.operationId);
          const included =
            !c?.hidden &&
            (!config.include || config.include.includes(op.operationId)) &&
            (!config.audiences || c?.audiences?.some((a) => config.audiences!.includes(a)));
          if (!included) return [verb, { operationId: op.operationId }];
          selectedAny = true;
          collect(op, file, 'operation');
          if (c?.stream?.events) {
            record(c.stream.events, 'config/operations/' + op.operationId + '/stream/events');
            const events: Record<string, Schema> = Object.create(null);
            for (const [event, ref] of Object.entries(c.stream.events)) {
              if (typeof ref !== 'string')
                fail(
                  'config/operations/' + op.operationId + '/stream/events/' + event,
                  'expected a local schema reference',
                );
              collect({ $ref: ref }, resolve(definitionPath), 'schema');
              events[event] = deref(
                { $ref: ref },
                resolve(definitionPath),
                p + '/stream/events/' + event,
                [],
                'schema',
              );
            }
            streamSchemas.set(op.operationId, events);
          }
          return [verb, deref(op, file, p, [], 'operation')];
        });
      const parameters = own(fields, 'parameters');
      if (selectedAny && parameters) {
        collect(parameters.value, parameters.file, 'parameter');
        entries.push([
          'parameters',
          deref(
            parameters.value,
            parameters.file,
            '/paths/' + path + '/parameters',
            [],
            'parameter',
          ),
        ]);
      }
      return [path, Object.fromEntries(entries)];
    }),
  );
  const incoming: IncomingWebhook[] = [];
  if (raw.webhooks !== undefined) {
    if (raw.openapi.startsWith('3.0.')) fail('/webhooks', 'webhooks require OpenAPI 3.1');
    record(raw.webhooks, '/webhooks');
    for (const [key, item] of Object.entries(raw.webhooks).sort()) {
      const base = '/webhooks/' + key.replaceAll('~', '~0').replaceAll('/', '~1');
      const fields = pathFields(item, resolve(definitionPath), base);
      for (const [method, field] of Object.entries(fields)) {
        if (
          ['parameters', 'summary', 'description', 'servers'].includes(method) ||
          method.startsWith('x-')
        )
          continue;
        if (!['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(method))
          fail(base + '/' + method, 'unsupported incoming method');
        collect(field.value, field.file, 'operation');
        const location = base + '/' + method;
        const op = deref(field.value, field.file, location, [], 'operation');
        record(op, location);
        record(op.requestBody, location + '/requestBody');
        record(op.requestBody.content, location + '/requestBody/content');
        const content = op.requestBody.content['application/json'];
        record(content, location + '/requestBody/content/application~1json');
        schema(
          content.schema,
          location + '/requestBody/content/application~1json/schema',
          false,
          config.numericUnions === 'explicit',
        );
        const model = 'IncomingWebhook' + hash(key + '/' + method).slice(0, 12) + 'Payload';
        incoming.push({
          name: key,
          method: method.toUpperCase(),
          pointer: location,
          model,
          schema: content.schema,
          dependencies: [
            ...new Set(
              references
                .filter((ref) => ref.path.startsWith(location + '/'))
                .map((ref) => own(config.models, ref.model) ?? ref.model),
            ),
          ].sort(),
        });
      }
    }
  }
  const selected = {
    ...raw,
    paths: {},
    components: {
      securitySchemes: raw.components?.securitySchemes,
      schemas: Object.fromEntries(
        Object.entries(raw.components?.schemas ?? {}).filter(([key]) => reachable.has(key)),
      ),
    },
  };
  const doc = deref(selected, resolve(definitionPath), '');
  // Path items have already been resolved relative to their own source files.
  doc.paths = selectedPaths;
  // Direction and redaction are use-site facts, even when their declaration is
  // behind a conjunction or a recursive edge. Follow only same-instance edges.
  function effectiveFlag(value: Schema, key: string, seen = new Set<Schema>()): boolean {
    if (!value || typeof value !== 'object' || seen.has(value)) return false;
    seen.add(value);
    if (value[key] === true) return true;
    const reference = value['x-sdk-ref'];
    const target = reference ? resolved.get('schema:' + cycles.get(reference))?.value : undefined;
    return (
      Boolean(target && effectiveFlag(target, key, seen)) ||
      (Array.isArray(value.allOf) ? value.allOf : []).some((branch) =>
        effectiveFlag(branch, key, seen),
      )
    );
  }
  function annotate(value: any, context: Context): void {
    if (context === 'literal' || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach((child) => annotate(child, context));
      return;
    }
    for (const [key, child] of Object.entries(value)) annotate(child, childContext(context, key));
    if (context === 'schema')
      for (const key of ['readOnly', 'writeOnly', 'x-sensitive'])
        if ((value[key] === undefined || value[key] === false) && effectiveFlag(value, key))
          value[key] = true;
  }
  annotate(doc, 'root');
  for (const item of incoming) annotate(item.schema, 'schema');
  for (const events of streamSchemas.values())
    for (const schema of Object.values(events)) annotate(schema, 'schema');
  for (const [key, entry] of resolved)
    if (key.startsWith('schema:')) annotate(entry.value, 'schema');
  for (const forbidden of ['callbacks'])
    if (doc[forbidden])
      fail(`/${forbidden}`, 'declare supported HMAC webhooks in the SDK configuration');
  const models: Record<string, Schema> = {};
  for (const [original, value] of Object.entries(doc.components?.schemas ?? {}) as [
    string,
    Schema,
  ][]) {
    const mapped = own(config.models, original) ?? original;
    modelName(mapped, `models/${original}`, config.targets);
    if (Object.keys(models).some((k) => k.toLowerCase() === mapped.toLowerCase()))
      fail(`models/${original}`, 'model name collision');
    schema(
      value,
      `/components/schemas/${original}`,
      raw.openapi.startsWith('3.0.'),
      config.numericUnions === 'explicit',
    );
    models[mapped] = value;
  }
  for (const k of Object.keys(config.models ?? {}))
    if (!Object.hasOwn(raw.components?.schemas ?? {}, k))
      fail(`config/models/${k}`, 'stale model customization');
  const definitions: Record<string, Schema> = {};
  for (const [mapped, key] of cycles) {
    modelName(mapped, 'definitions/' + mapped, config.targets);
    if (
      !key.startsWith(resolve(definitionPath) + '#/components/schemas/') &&
      Object.hasOwn(models, mapped)
    )
      fail(
        'definitions/' + mapped,
        'generated external model name collides with an existing model',
      );
    const value = models[mapped] ?? resolved.get('schema:' + key)?.value;
    if (!value) fail('definitions/' + mapped, 'unresolved recursive model');
    schema(
      value,
      'definitions/' + mapped,
      raw.openapi.startsWith('3.0.'),
      config.numericUnions === 'explicit',
    );
    definitions[mapped] = value;
    models[mapped] ??= value;
  }
  for (const declaration of incoming) {
    if (Object.hasOwn(models, declaration.model))
      fail(declaration.pointer, 'incoming model name collision');
    models[declaration.model] = declaration.schema;
  }
  let auth: Auth | undefined;
  let authentication: Record<string, AuthenticationMode> | undefined;
  const schemes = doc.components?.securitySchemes ?? {};
  const compileScheme = (key: string): Auth & { name: string } => {
    if (!Object.hasOwn(schemes, key)) fail('config/auth', 'select an existing security scheme');
    const declaration = schemes[key];
    if (declaration.type === 'http' && declaration.scheme === 'bearer')
      return { name: key, type: 'bearer', header: 'Authorization' };
    if (declaration.type === 'apiKey' && declaration.in === 'header') {
      header(declaration.name, 'securitySchemes/' + key + '/name');
      return { name: key, type: 'apiKey', header: declaration.name };
    }
    return fail(
      'securitySchemes/' + key,
      'supported authentication: bearer or header API key; refresh/OAuth must be supplied by an explicit caller-owned transport',
    );
  };
  const namedAuth = config.auth && 'modes' in config.auth ? config.auth : undefined;
  const selectedScheme =
    config.auth && 'scheme' in config.auth
      ? config.auth.scheme
      : namedAuth
        ? undefined
        : Object.keys(schemes)[0];
  if (namedAuth) {
    keys(namedAuth, ['modes'], 'config/auth');
    record(namedAuth.modes, 'config/auth/modes');
    if (!Object.keys(namedAuth.modes).length)
      fail('config/auth/modes', 'declare at least one authentication mode');
    authentication = Object.create(null);
    for (const [mode, settings] of Object.entries(namedAuth.modes)) {
      name(mode, 'config/auth/modes/' + mode);
      keys(settings, ['schemes', 'operations'], 'config/auth/modes/' + mode);
      strings(settings.schemes, 'config/auth/modes/' + mode + '/schemes');
      if (!settings.schemes.length)
        fail('config/auth/modes/' + mode, 'a mode requires a complete scheme set');
      if (settings.operations !== undefined)
        strings(settings.operations, 'config/auth/modes/' + mode + '/operations');
      const compiled = settings.schemes.map(compileScheme);
      if (new Set(compiled.map((scheme) => scheme.header.toLowerCase())).size !== compiled.length)
        fail('config/auth/modes/' + mode, 'combined schemes have conflicting header destinations');
      authentication![mode] = {
        schemes: compiled,
        ...(settings.operations ? { operations: settings.operations } : {}),
      };
    }
  } else {
    if (config.auth) {
      keys(config.auth, ['scheme'], 'config/auth');
      if (typeof selectedScheme !== 'string' || !Object.hasOwn(schemes, selectedScheme))
        fail('config/auth/scheme', 'select an existing security scheme');
    }
    if (Object.keys(schemes).length > 1 && !config.auth)
      fail(
        '/components/securitySchemes',
        'multiple authentication schemes require config.auth.scheme to select a declared alternative',
      );
    if (selectedScheme) {
      const { name, ...compiled } = compileScheme(selectedScheme);
      auth = compiled;
    }
  }
  const resourceSpellings = new Map<string, string>();
  const operations: Operation[] = [];
  const ids = new Set<string>();
  const publicNames = new Set<string>();
  for (const [path, item] of Object.entries(doc.paths ?? {}) as [string, any][]) {
    if (!path.startsWith('/') || path.startsWith('//') || /[\\\s?#]/.test(path))
      fail(`/paths/${path}`, 'expected an absolute API path without query or fragment');
    for (const [verb, op] of Object.entries(item) as [string, any][]) {
      if (['parameters', 'summary', 'description'].includes(verb)) continue;
      if (!['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(verb))
        fail(`/paths/${path}/${verb}`, 'unsupported path construct');
      const p = `/paths/${path}/${verb}`;
      record(op, p);
      const id = op.operationId;
      if (typeof id !== 'string' || !id || ids.has(id))
        fail(p, 'operationId must be present and unique');
      ids.add(id);
      const c: Capability = own(config.operations, id) ?? {};
      keys(
        c,
        [
          'resource',
          'method',
          'audiences',
          'hidden',
          'aliases',
          'retry',
          'idempotency',
          'pagination',
          'polling',
          'conditional',
          'example',
          'deprecated',
          'requestMediaType',
          'stream',
        ],
        `config/operations/${id}`,
      );
      for (const key of ['aliases', 'audiences'] as const)
        if (c[key] !== undefined) strings(c[key], `config/operations/${id}/${key}`);
      if (c.hidden !== undefined && typeof c.hidden !== 'boolean')
        fail(p, 'hidden must be boolean');
      if (c.requestMediaType !== undefined && typeof c.requestMediaType !== 'string')
        fail(`config/operations/${id}/requestMediaType`, 'expected a media type string');
      if (c.requestMediaType !== undefined && op.requestBody === undefined)
        fail(`config/operations/${id}/requestMediaType`, 'operation has no request body');
      if (c.stream) {
        keys(
          c.stream,
          ['events', 'idleTimeoutMs', 'maxEventBytes'],
          `config/operations/${id}/stream`,
        );
        for (const key of ['idleTimeoutMs', 'maxEventBytes'] as const)
          if (
            c.stream[key] !== undefined &&
            (!Number.isSafeInteger(c.stream[key]) || c.stream[key]! <= 0)
          )
            fail(`config/operations/${id}/stream/${key}`, 'expected a positive safe integer');
      }
      if (c.deprecated !== undefined && (typeof c.deprecated !== 'string' || !c.deprecated.trim()))
        fail(p, 'deprecated must be a nonempty migration message');
      if (op.deprecated !== undefined && typeof op.deprecated !== 'boolean')
        fail(p, 'OpenAPI deprecated must be boolean');
      if (
        c.hidden ||
        (config.include && !config.include.includes(id)) ||
        (config.audiences && !c.audiences?.some((a) => config.audiences!.includes(a)))
      )
        continue;
      const resource = c.resource ?? 'api';
      const method = c.method ?? id;
      name(resource, `${p}/resource`);
      name(method, `${p}/method`, true);
      const spelling = resourceSpellings.get(resource.toLowerCase());
      if (spelling && spelling !== resource)
        fail(p, 'resource names collide case-insensitively in PHP');
      resourceSpellings.set(resource.toLowerCase(), resource);
      const allNames = [
        method,
        ...(c.aliases ?? []),
        ...(c.pagination ? [method + 'Pages', method + 'Items'] : []),
        ...(c.polling ? [method + 'Wait'] : []),
      ];
      for (const n of allNames) {
        name(n, `${p}/method`, true);
        const key = `${resource}.${n}`.toLowerCase();
        if (publicNames.has(key)) fail(p, `public method collision: ${key}`);
        publicNames.add(key);
      }
      for (const forbidden of ['callbacks', 'servers'])
        if (op[forbidden]) fail(`${p}/${forbidden}`, 'unsupported operation construct');
      const params = new Map<string, Parameter>();
      for (const list of [item.parameters, op.parameters])
        if (list !== undefined && !Array.isArray(list)) fail(p, 'parameters must be an array');
      for (const param of [...(item.parameters ?? []), ...(op.parameters ?? [])] as Parameter[]) {
        record(param, p + '/parameters');
        if (typeof param.name !== 'string' || !param.name)
          fail(p, 'parameters require nonempty names');
        for (const key of ['required', 'explode'] as const)
          if (param[key] !== undefined && typeof param[key] !== 'boolean')
            fail(p, `parameter ${key} must be boolean`);
        if (!['path', 'query', 'header'].includes(param.in))
          fail(p, 'supported parameter locations: path, query, header');
        if (param.in === 'header') header(param.name, p);
        if (param.in === 'path' && !param.required)
          fail(p, `path parameter ${param.name} must be required`);
        if (['body', '__proto__', 'constructor', 'prototype'].includes(param.name))
          fail(p, `parameter name ${param.name} conflicts with SDK input`);
        schema(
          param.schema,
          `${p}/parameters/${param.name}`,
          raw.openapi.startsWith('3.0.'),
          config.numericUnions === 'explicit',
        );
        parameterType(param.schema, `${p}/parameters/${param.name}`);
        const style = param.style ?? (param.in === 'query' ? 'form' : 'simple');
        if (style !== (param.in === 'query' ? 'form' : 'simple'))
          fail(p, `unsupported parameter style ${style}`);
        if ((param as any).allowReserved || (param as any).content)
          fail(p, 'allowReserved/content parameters are unsupported');
        params.set(`${param.in}:${param.name}`, param);
      }
      const parameters = [...params.values()];
      if (new Set(parameters.map((v) => v.name)).size !== parameters.length)
        fail(p, 'parameter names must be unique across locations');
      for (const match of path.matchAll(/\{([^}]+)\}/g))
        if (!parameters.some((v) => v.in === 'path' && v.name === match[1]))
          fail(p, `missing path parameter ${match[1]}`);
      for (const param of parameters)
        if (param.in === 'path' && !path.includes(`{${param.name}}`))
          fail(p, `path parameter ${param.name} has no placeholder`);
      const security = op.security ?? doc.security ?? [];
      if (
        !Array.isArray(security) ||
        security.some(
          (s: any) =>
            !s ||
            typeof s !== 'object' ||
            Array.isArray(s) ||
            Object.entries(s).some(
              ([k, v]) =>
                !Object.hasOwn(schemes, k) ||
                !Array.isArray(v) ||
                v.some((scope) => typeof scope !== 'string'),
            ),
        )
      )
        fail(p, 'security must contain declared authentication requirements or []');
      const anonymous =
        !security.length ||
        security.some((requirement: object) => !Object.keys(requirement).length);
      const authModes = authentication
        ? Object.entries(authentication)
            .filter(
              ([, mode]) =>
                (!mode.operations || mode.operations.includes(id)) &&
                security.some(
                  (requirement: Record<string, string[]>) =>
                    Object.keys(requirement).length === mode.schemes.length &&
                    mode.schemes.every(
                      (scheme) =>
                        Object.hasOwn(requirement, scheme.name) &&
                        requirement[scheme.name]?.length === 0,
                    ),
                ),
            )
            .map(([name]) => name)
        : undefined;
      const selectedAuthentication = authModes
        ? authModes.length > 0
        : security.some(
            (requirement: Record<string, string[]>) =>
              Object.keys(requirement).length === 1 &&
              Object.hasOwn(requirement, selectedScheme!) &&
              requirement[selectedScheme!]!.length === 0,
          );
      if (!anonymous && !selectedAuthentication)
        fail(
          p,
          `selected authentication scheme ${selectedScheme ?? '(none)'} is not a supported standalone alternative for this operation`,
        );
      let body: Schema | undefined;
      let mediaType: string | undefined;
      if (op.requestBody !== undefined) {
        if (['get', 'head'].includes(verb) && (config.targets ?? ['node', 'php']).includes('node'))
          fail(p + '/requestBody', 'GET/HEAD request bodies are unsupported by the Node transport');
        record(op.requestBody, p + '/requestBody');
        if (op.requestBody.required !== undefined && typeof op.requestBody.required !== 'boolean')
          fail(p, 'requestBody.required must be boolean');
        record(op.requestBody.content, p + '/requestBody/content');
        const supported = ['application/json', 'application/merge-patch+json'];
        if (
          c.requestMediaType !== undefined &&
          !Object.hasOwn(op.requestBody.content, c.requestMediaType)
        )
          fail(`config/operations/${id}/requestMediaType`, 'selected media type is not declared');
        const contents = Object.entries(op.requestBody.content).filter(([media]) =>
          c.requestMediaType === undefined
            ? supported.includes(media)
            : media === c.requestMediaType,
        );
        if (contents.length !== 1)
          fail(
            p,
            'requestBody must select one supported media type; configure operations.' +
              id +
              '.requestMediaType',
          );
        const [media, content] = contents[0]! as [string, any];
        record(content, p + '/requestBody/content/' + media);
        if (!['application/json', 'application/merge-patch+json'].includes(media))
          fail(
            p,
            `unsupported request media type ${media}; file transfer is not in the initial reference contracts`,
          );
        schema(
          content.schema,
          `${p}/requestBody`,
          raw.openapi.startsWith('3.0.'),
          config.numericUnions === 'explicit',
        );
        body = content.schema;
        mediaType = media;
      }
      const responses: Operation['responses'] = {};
      record(op.responses, p + '/responses');
      for (const [status, response] of Object.entries(op.responses) as [string, any][]) {
        if (!/^[1-5]\d\d$/.test(status) && status !== 'default')
          fail(p, 'responses require explicit HTTP status codes or default');
        record(response, p + '/responses/' + status);
        if (response.content !== undefined)
          record(response.content, p + '/responses/' + status + '/content');
        const contents = Object.entries(response.content ?? {});
        if (contents.length > 1) fail(p, 'each response must select one media type');
        const r: Operation['responses'][string] = {
          bodyKind: 'empty',
          classification: ['302', '307'].includes(status)
            ? 'redirect'
            : successStatus(status)
              ? 'success'
              : 'error',
        };
        if (r.classification === 'redirect') {
          const location = Object.entries(response.headers ?? {}).find(
            ([name]) => name.toLowerCase() === 'location',
          )?.[1];
          if (location !== undefined) {
            record(location, p + '/responses/' + status + '/headers/Location');
            r.locationRequired = location.required === true;
          }
        }
        if (contents.length) {
          const [media, value] = contents[0]! as [string, any];
          record(value, p + '/responses/' + status + '/content/' + media);
          if (['application/pdf', 'text/event-stream'].includes(media) && successStatus(status)) {
            r.bodyKind = media === 'application/pdf' ? 'binary' : 'sse';
          } else {
            if (media !== 'application/json') fail(p, `unsupported response media type ${media}`);
            schema(
              value.schema,
              `${p}/responses/${status}`,
              raw.openapi.startsWith('3.0.'),
              config.numericUnions === 'explicit',
            );
            r.schema = value.schema;
            r.bodyKind = 'json';
          }
          r.mediaType = media;
        }
        responses[status] = r;
      }
      for (const [event, eventSchema] of Object.entries(streamSchemas.get(id) ?? {}))
        schema(
          eventSchema,
          `${p}/stream/events/${event}`,
          false,
          config.numericUnions === 'explicit',
        );
      if (c.stream && !Object.values(responses).some((response) => response.bodyKind === 'sse'))
        fail(`config/operations/${id}/stream`, 'operation has no SSE response');
      if (!Object.keys(responses).some((k) => successStatus(k) && k !== '304'))
        fail(p, 'declare at least one explicit success response');
      if (c.idempotency) {
        keys(c.idempotency, ['header', 'retention', 'scope', 'auto'], p);
        header(c.idempotency.header, p);
        if (
          typeof c.idempotency.retention !== 'string' ||
          !c.idempotency.retention.trim() ||
          typeof c.idempotency.scope !== 'string' ||
          !c.idempotency.scope.trim()
        )
          fail(p, 'idempotency requires server retention and scope descriptions');
        if (c.idempotency.auto !== undefined && typeof c.idempotency.auto !== 'boolean')
          fail(p, 'idempotency auto must be boolean');
      }
      if (c.retry) {
        keys(c.retry, ['maxAttempts', 'statuses', 'errors', 'transport', 'baseDelayMs'], p);
        if (
          !Number.isInteger(c.retry.maxAttempts) ||
          c.retry.maxAttempts < 1 ||
          c.retry.maxAttempts > 10 ||
          !Number.isFinite(c.retry.baseDelayMs) ||
          c.retry.baseDelayMs < 0 ||
          !Array.isArray(c.retry.statuses) ||
          c.retry.statuses.some(
            (s) => !Number.isInteger(s) || s < 400 || s > 599 || [409, 412].includes(s),
          ) ||
          typeof c.retry.transport !== 'boolean'
        )
          fail(
            p,
            'retry requires 1–10 attempts, nonnegative delay, explicit statuses (excluding conflicts), and transport boolean',
          );
        if (c.retry.maxAttempts > 1 && !['get', 'head', 'options'].includes(verb) && !c.idempotency)
          fail(p, 'mutation retries require a declared idempotency contract');
        if (c.retry.errors !== undefined) {
          if (!Array.isArray(c.retry.errors)) fail(p, 'retry.errors must be an array');
          for (const rule of c.retry.errors) {
            keys(rule, ['status', 'codes'], p);
            if (
              !Number.isInteger(rule.status) ||
              rule.status < 400 ||
              rule.status > 599 ||
              rule.status === 412 ||
              !Array.isArray(rule.codes) ||
              !rule.codes.length ||
              rule.codes.some((code) => typeof code !== 'string' || !code.trim())
            )
              fail(
                p,
                'retry.errors requires an HTTP error status other than 412 and explicit nonempty codes',
              );
            if (rule.status === 409 && (!c.idempotency || c.conditional))
              fail(
                p,
                'retrying a specific 409 code requires idempotency and cannot retry conditional updates',
              );
          }
        }
      }
      if (c.pagination) {
        const pg = c.pagination;
        keys(pg, ['kind', 'items', 'next', 'parameter'], p);
        if (
          !['cursor', 'offset', 'link'].includes(pg.kind) ||
          typeof pg.items !== 'string' ||
          !pg.items ||
          typeof pg.next !== 'string' ||
          !pg.next ||
          (pg.kind !== 'link' &&
            !parameters.some((v) => v.in === 'query' && v.name === pg.parameter))
        )
          fail(
            p,
            'pagination requires item/continuation fields and a declared query parameter (except links)',
          );
        if (verb !== 'get') fail(p, 'pagination helpers require GET');
        const parameter = parameters.find((v) => v.in === 'query' && v.name === pg.parameter);
        const nextType = pg.kind === 'offset' ? 'integer' : 'string';
        if (pg.kind !== 'link' && parameter && parameterType(parameter.schema, p) !== nextType)
          fail(p, `${pg.kind} pagination requires a scalar ${nextType} query parameter`);
        // Follow same-instance conjuncts and alternatives, just as field/type
        // projection does; formats may be supplied by referenced siblings.
        const exactInteger = (shape: Schema): boolean =>
          exactValue(valueInstruction('integer', shape.format)) ||
          [...(shape.allOf ?? []), ...(shape.oneOf ?? []), ...(shape.anyOf ?? [])].some(
            exactInteger,
          );
        for (const [, response] of Object.entries(responses).filter(([status]) =>
          /^2\d\d$/.test(status),
        )) {
          const items = schemaField(response.schema, pg.items);
          const next = schemaField(response.schema, pg.next);
          if (!items || !hasType(items, 'array') || !next || !hasType(next, nextType))
            fail(
              p,
              `pagination items/next must address declared array and ${nextType} response fields`,
            );
          if (
            pg.kind === 'offset' &&
            parameter &&
            next &&
            !exactInteger(parameter.schema) &&
            exactInteger(next)
          )
            fail(
              p,
              'offset pagination returns exact integer strings but its query parameter requires a native integer; use compatible integer formats or omit the pagination helper',
            );
        }
      }
      if (c.polling) {
        keys(c.polling, ['state', 'success', 'failure', 'intervalMs'], p);
        strings(c.polling.success, `${p}/polling/success`);
        strings(c.polling.failure, `${p}/polling/failure`);
        if (
          verb !== 'get' ||
          typeof c.polling.state !== 'string' ||
          !c.polling.state ||
          !c.polling.success?.length ||
          !Array.isArray(c.polling.failure) ||
          !Number.isFinite(c.polling.intervalMs) ||
          c.polling.intervalMs < 1 ||
          c.polling.success.some((s) => c.polling!.failure.includes(s))
        )
          fail(p, 'polling requires GET, distinct terminal states, and positive intervalMs');
        for (const [, response] of Object.entries(responses).filter(([status]) =>
          /^2\d\d$/.test(status),
        )) {
          const states = schemaField(response.schema, c.polling.state);
          if (!states || !hasType(states, 'string'))
            fail(p, 'polling state must address a declared string response field');
        }
      }
      if (c.conditional) {
        keys(c.conditional, ['header'], p);
        header(c.conditional.header, p);
      }
      operations.push({
        ...c,
        id,
        resource,
        method,
        verb: verb.toUpperCase(),
        path,
        parameters,
        ...(body ? { body } : {}),
        ...(mediaType ? { mediaType } : {}),
        bodyRequired: op.requestBody?.required ?? false,
        responses,
        ...(streamSchemas.has(id) ? { streamEventSchemas: streamSchemas.get(id)! } : {}),
        authenticated: !anonymous,
        ...(authModes ? { authModes } : {}),
        ...(anonymous && selectedAuthentication ? { optionalAuthentication: true } : {}),
        description: op.description ?? op.summary ?? '',
        ...(c.deprecated
          ? { deprecated: c.deprecated }
          : op.deprecated
            ? { deprecated: 'Deprecated by the API provider; consult its migration guide.' }
            : {}),
      });
    }
  }
  operations.sort((a, b) => a.id.localeCompare(b.id, 'en'));
  for (const id of [...Object.keys(config.operations ?? {}), ...(config.include ?? [])])
    if (!ids.has(id)) fail(`config/operations/${id}`, 'stale operation customization or selection');
  if (!operations.length) fail('/paths', 'selection contains no operations');
  for (const [mode, settings] of Object.entries(authentication ?? {}))
    for (const id of settings.operations ?? [])
      if (!ids.has(id))
        fail('config/auth/modes/' + mode + '/operations', 'unknown operation binding ' + id);
  if (config.webhook) {
    const w = config.webhook;
    keys(
      w,
      [
        'algorithm',
        'format',
        'idHeader',
        'header',
        'timestampHeader',
        'separator',
        'toleranceSeconds',
        'events',
        'typeField',
      ],
      'config/webhook',
    );
    if (
      w.algorithm !== 'hmac-sha256' ||
      !Number.isFinite(w.toleranceSeconds) ||
      w.toleranceSeconds < 0 ||
      typeof w.separator !== 'string' ||
      typeof w.typeField !== 'string' ||
      !w.typeField
    )
      fail(
        'config/webhook',
        'declare hmac-sha256, a literal separator, typeField, and nonnegative toleranceSeconds',
      );
    header(w.header, 'config/webhook/header');
    if (w.format !== 'timestamped-hex') header(w.timestampHeader, 'config/webhook/timestampHeader');
    else if (w.timestampHeader !== undefined)
      fail(
        'config/webhook/timestampHeader',
        'timestamped-hex embeds the timestamp in the signature header',
      );
    if (
      w.format !== undefined &&
      !['hex', 'standard-webhooks', 'timestamped-hex'].includes(w.format)
    )
      fail('config/webhook/format', 'expected hex, standard-webhooks, or timestamped-hex');
    if (w.format === 'standard-webhooks') header(w.idHeader, 'config/webhook/idHeader');
    else if (w.idHeader !== undefined)
      fail('config/webhook/idHeader', 'only standard-webhooks uses an event ID header');
    if (w.format && w.format !== 'hex' && w.separator !== '.')
      fail('config/webhook/separator', 'this signature format requires a dot separator');
    if (!w.events || typeof w.events !== 'object' || Array.isArray(w.events))
      fail('config/webhook/events', 'expected an event schema map');
    const eventTypes = (
      value: Schema,
      field = false,
      seen = new Set<string>(),
    ): string[] | undefined => {
      const constraints: string[][] = [];
      const ref = value['x-sdk-ref'];
      if (ref && !seen.has(ref) && definitions[ref]) {
        const tags = eventTypes(definitions[ref], field, new Set([...seen, ref]));
        if (tags) constraints.push(tags);
      }
      const property = value.properties?.[w.typeField];
      if (field) {
        if (typeof value.const === 'string') constraints.push([value.const]);
        if (value.enum)
          constraints.push(value.enum.filter((tag): tag is string => typeof tag === 'string'));
      } else if (property) {
        const tags = eventTypes(property, true, seen);
        if (tags) constraints.push(tags);
      }
      for (const branch of value.allOf ?? []) {
        const tags = eventTypes(branch, field, seen);
        if (tags) constraints.push(tags);
      }
      for (const alternatives of [value.oneOf, value.anyOf])
        if (alternatives) {
          const tags = alternatives.map((branch) => eventTypes(branch, field, seen));
          if (tags.every((value): value is string[] => value !== undefined))
            constraints.push([...new Set(tags.flat())]);
        }
      return constraints.length
        ? constraints.reduce((left, right) => left.filter((tag) => right.includes(tag)))
        : undefined;
    };
    for (const declaration of incoming)
      for (const type of new Set(eventTypes(declaration.schema) ?? [])) {
        if (Object.hasOwn(w.events, type) && stable(w.events[type]) !== stable(declaration.schema))
          fail(declaration.pointer, 'incoming event conflicts with configured binding for ' + type);
        w.events[type] = declaration.schema;
      }
    for (const [k, v] of Object.entries(w.events))
      schema(v, `config/webhook/events/${k}`, false, config.numericUnions === 'explicit');
  }
  if (config.money) {
    keys(config.money, ['currencies'], 'config/money');
    if (
      !config.money.currencies ||
      typeof config.money.currencies !== 'object' ||
      Array.isArray(config.money.currencies)
    )
      fail('config/money/currencies', 'expected a currency precision map');
    for (const [code, digits] of Object.entries(config.money.currencies))
      if (!/^[A-Z]{3}$/.test(code) || !Number.isInteger(digits) || digits < 0 || digits > 12)
        fail('config/money', 'currencies map ISO-style codes to 0–12 minor-unit digits');
  }
  if (config.apiVersion) {
    keys(config.apiVersion, ['value', 'header'], 'config/apiVersion');
    header(config.apiVersion.header, 'config/apiVersion/header');
    if (
      typeof config.apiVersion.value !== 'string' ||
      !config.apiVersion.value ||
      /[\r\n]/.test(config.apiVersion.value)
    )
      fail('config/apiVersion/value', 'expected a nonempty safe header value');
  }
  const contract: Contract = {
    title: String(doc.info?.title ?? 'API'),
    apiVersion: config.apiVersion?.value ?? String(doc.info?.version ?? ''),
    operations,
    ...(incoming.length ? { incoming } : {}),
    models,
    ...(cycles.size ? { definitions } : {}),
    modelDependencies: Object.fromEntries(
      operations.map((op) => {
        const operationPath = `/paths/${op.path}/${op.verb.toLowerCase()}/`;
        const sharedParameters = `/paths/${op.path}/parameters/`;
        return [
          op.id,
          [
            ...new Set(
              references
                .filter(
                  (ref) =>
                    ref.path.startsWith(operationPath) || ref.path.startsWith(sharedParameters),
                )
                .map((ref) => own(config.models, ref.model) ?? ref.model),
            ),
          ].sort(),
        ];
      }),
    ),
    ...(authentication ? { authentication } : {}),
    config,
    sources,
    hash: '',
  };
  if (auth) contract.auth = auth;
  // Resolution is finished. Do not retain expanded cached copies while the
  // owned contract is compacted and compiled.
  resolved.clear();
  if (config.schemaSharing === 'named') shareContractSchemas(contract);
  contract.hash = hash(stable(contract));
  return contract;
}
