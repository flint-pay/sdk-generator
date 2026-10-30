import { isReservedTypeName } from './naming.js';
import { locateDiagnostic } from './input-diagnostics.js';
import { requestOption } from './request-options.js';
import { validateRequestStyle, validatePositional, type RequestStyle } from './request-style.js';
import { validateResponseReturn, payloadSchemas, type ResponseReturn } from './response-return.js';
import {
  operationNames,
  pathOperationNames,
  avoidPathHelperCollisions,
  operationVerbOccurs,
  operationNamingReason,
  modelNames,
  isPublicName,
  webhookEventTypeName,
} from './naming.js';
import { shareContractSchemas } from './schema-sharing.js';
import { schemaUsageFingerprint } from './schema-usage.js';
import { schemaAnnotations, isSchemaAnnotation } from './schema-annotations.js';
import {
  EXAMPLE_PROTECTION_MARKER,
  sourceExampleProtection,
  saveExampleProtection,
  type ExampleSource,
} from './example-protection.js';
import { parameterExampleEligible } from './parameter-example-policy.js';
import { SourceJson } from './source-json.js';
import { openApiObject, assertOpenApiVersion, readInput } from './openapi-input.js';
import {
  Diagnostic,
  DiagnosticGroup,
  DiagnosticCollector,
  suggestion,
  pointerSegment,
} from './diagnostic.js';
import { valueInstruction, exactValue, discriminatorBindings } from './codec-plan.js';
import { stable } from './canonical.js';
import {
  successStatus,
  isAuthShortcutName,
  isDefaultBaseUrl,
  webhookJwtIssue,
  assertDefaultCredentials,
} from './runtime-plan.js';
import { visitIntersectedProperties } from './schema-intersections.js';
import { resolve, dirname, relative as relativePath } from 'node:path';
import { createHash } from 'node:crypto';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Schema = {
  'x-sdk-ref'?: string;
  /** Source component name for Node declarations; codecs retain their shared reference. */
  'x-sdk-type-name'?: string;
  'x-sdk-definitions'?: Record<string, Schema>;
  type?: string | string[];
  properties?: Record<string, Schema>;
  propertyNames?: Schema;
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
  'x-flint-request-option'?: string;
  description?: string;
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
  maxDelayMs?: number;
}
export interface OperationDefaults {
  timeoutMs?: number;
  deadlineMs?: number;
}
export interface Capability {
  defaults?: OperationDefaults;
  request?: RequestStyle;
  response?: ResponseReturn;
  stream?: { events?: Record<string, string>; idleTimeoutMs?: number; maxEventBytes?: number };
  requestMediaType?: string;
  namingReason?: string;
  resource?: string;
  method?: string;
  audiences?: string[];
  hidden?: boolean;
  aliases?: string[];
  retry?: Retry;
  idempotency?: {
    header: string;
    retention: string;
    scope: string;
    auto?: boolean;
    autoKeyPrefix?: string;
  };
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
const capabilityFields = {
  idempotency: ['header', 'retention', 'scope', 'auto', 'autoKeyPrefix'],
  retry: ['maxAttempts', 'statuses', 'errors', 'transport', 'baseDelayMs', 'maxDelayMs'],
  pagination: ['kind', 'items', 'next', 'parameter'],
};
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
export interface DefaultCredentials {
  mode: string;
  scheme: string;
  environment: { apiKey: string; token: string };
  workloadIdentity: { tokenPath: string; credentialParameter: string; envPrefix: string };
}
export type AuthShortcuts = Record<string, { mode: string; scheme: string }>;
export interface AuthenticationMode {
  schemes: (Auth & { name: string })[];
  operations?: string[];
}
export interface WebhookJwt {
  header: string;
  scheme: 'Bearer';
  algorithm: 'ES256';
  typ: string;
  issuer: string;
  jwksPath: string;
  bodyHashClaim: string;
  bodyHashEncoding: 'base64url';
  lifetimeSeconds: number;
  leewaySeconds: number;
}
export interface WebhookHmac {
  algorithm: 'hmac-sha256';
  format?: 'hex' | 'standard-webhooks' | 'timestamped-hex';
  idHeader?: string;
  header: string;
  timestampHeader?: string;
  separator: string;
  toleranceSeconds: number;
}
export type WebhookSigning =
  | (WebhookHmac & { jwt?: WebhookJwt })
  | ({ jwt: WebhookJwt } & { [K in keyof WebhookHmac]?: never });
export type Webhook = WebhookSigning & {
  events: Record<string, Schema>;
  typeField: string;
};
type DefaultCapability = 'idempotency' | 'retry' | 'pagination';
export type CapabilityOverride = Omit<Capability, DefaultCapability | 'request'> & {
  request?: { style?: 'positional' };
} & {
  [K in DefaultCapability]?:
    | { [P in keyof NonNullable<Capability[K]>]?: NonNullable<Capability[K]>[P] | null }
    | false;
};
export interface Config {
  operationNames?: 'tags' | 'path';
  $schema?: string;
  defaults?: { [K in DefaultCapability]?: Partial<NonNullable<Capability[K]>> };
  requests?: RequestStyle;
  responses?: ResponseReturn;
  profiles?: string[];
  /** @deprecated Exact-number/string alternatives are supported automatically. */
  numericUnions?: 'explicit';
  /** @deprecated Named schema sharing is automatic. */
  schemaSharing?: 'named';
  validation?: 'encoding' | 'schema';
  auth?:
    | { scheme: string }
    | {
        modes: Record<string, { schemes: string[]; operations?: string[] }>;
        shortcuts?: AuthShortcuts;
        defaultCredentials?: DefaultCredentials;
      };
  targets?: ('node' | 'php')[];
  version: string;
  npm: {
    name: string;
    registry?: string;
    access?: 'public' | 'restricted';
    homepage?: string;
    repository?: { type: 'git'; url: string; directory?: string };
  };
  composer: { name: string; namespace: string };
  operations?: Record<string, CapabilityOverride>;
  models?: Record<string, string>;
  phpFieldClasses?: Record<string, Record<string, string>>;
  include?: string[];
  audiences?: string[];
  overrides?: Record<string, Json | Schema>;
  webhook?: Webhook;
  money?: { currencies: Record<string, number> };
  apiVersion?: { value: string; header: string };
  license?: string;
  errors?: {
    codePath?: string;
    inProgressCodes?: string[];
    retry?: { path: string; retryValues: string[] };
    messagePath?: string;
    detailsPath?: string;
    requestIdHeader?: string;
  };
  documentation?: {
    overview?: string;
    guides?: Record<string, string>;
    examples?: string[];
    /** Auth shortcut shown in README and operation examples where the operation permits it. */
    authShortcut?: string;
    /** Noun phrase naming the described API in generated prose. Defaults to "the API". */
    apiName?: string;
    /**
     * Absolute HTTPS URL template for each operation's `@see` link. Placeholders: `{operationId}`,
     * `{tag}` (the operation's first OpenAPI tag) and `{tagSlug}` (that tag looked up in `tagSlugs`).
     */
    operationUrl?: string;
    /** OpenAPI tag to documentation slug. Required for `{tagSlug}`; every included tag must be mapped. */
    tagSlugs?: Record<string, string>;
  };
  release?: { baseUrl?: string; policy?: 'review' | 'semver' };
}
export interface Contract {
  /** Private compatibility proof captured before reference/composition inlining. */
  schemaUsage?: { fingerprint: string; responseOnlyModels: string[] };
  /** Private publication provenance; excluded from compiled compatibility facts and effective output. */
  exampleProtection?: { locations: string[]; schemas: string[] };
  defaultBaseUrl?: string;
  /** Absolute documentation URL per operation ID, from `documentation.operationUrl`. */
  referenceUrls?: Record<string, string>;
  title: string;
  apiVersion: string;
  operations: Operation[];
  incoming?: IncomingWebhook[];
  models: Record<string, Schema>;
  definitions?: Record<string, Schema>;
  modelDependencies?: Record<string, string[]>;
  auth?: Auth;
  authentication?: Record<string, AuthenticationMode>;
  authShortcuts?: AuthShortcuts;
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
function modelName(
  value: unknown,
  path: string,
  targets: Config['targets'],
): asserts value is string {
  name(value, path);
  if ((!targets || targets.includes('node')) && isReservedTypeName(value))
    fail(path, 'model name is a TypeScript reserved word; customize it with config.models');
}
function name(value: unknown, path: string, method = false): asserts value is string {
  if (!isPublicName(value, method))
    fail(
      path,
      'choose an identifier that is not a JavaScript/PHP reserved word or SDK runtime member',
    );
}
function keys(object: object, allowed: string[], path: string, hint = '') {
  if (!object || typeof object !== 'object' || Array.isArray(object))
    fail(path, 'expected an object');
  const findings = Object.keys(object)
    .filter((k) => !allowed.includes(k))
    .map(
      (k, index) =>
        new Diagnostic(
          `${path}/${pointerSegment(k)}`,
          `unsupported setting.${suggestion(k, allowed)}${index === 0 ? ` Valid settings: ${allowed.filter((key) => !['numericUnions', 'schemaSharing'].includes(key)).join(', ')}${hint}` : ''}`,
        ),
    );
  if (findings.length === 1) throw findings[0];
  if (findings.length) throw new DiagnosticGroup(findings);
}
function publicationUrl(value: unknown, path: string, repository = false): void {
  const message = repository
    ? 'expected an HTTPS or git+HTTPS repository URL without embedded credentials'
    : 'expected an HTTPS homepage URL without embedded credentials';
  if (
    typeof value !== 'string' ||
    /[\s\\\u0000-\u001f\u007f]/.test(value) ||
    !(repository ? /^(?:git\+)?https:\/\/[^/?#]/i : /^https:\/\/[^/?#]/i).test(value)
  )
    return fail(path, message);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail(path, message);
  }
  if (!url.hostname || url.username || url.password) fail(path, message);
}
/** Fill `documentation.operationUrl`; an operation whose tag has no slug fails the load. */
function referenceUrl(
  template: string,
  id: string,
  tags: unknown,
  slugs: Record<string, string> | undefined,
  path: string,
): string {
  const tag = Array.isArray(tags)
    ? tags.find((t): t is string => typeof t === 'string')
    : undefined;
  return template.replace(/\{(operationId|tag|tagSlug)\}/g, (_, name: string) => {
    if (name === 'operationId') return encodeURIComponent(id);
    if (tag === undefined)
      return fail(path + '/tags', `operation ${id} has no tag for documentation.operationUrl`);
    if (name === 'tag') return encodeURIComponent(tag);
    const slug = own(slugs, tag);
    if (slug === undefined)
      return fail(
        path + '/tags',
        `tag ${JSON.stringify(tag)} has no entry in config/documentation/tagSlugs`,
      );
    return slug;
  });
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
  // A scalar and an array of the same scalar have one unambiguous form encoding.
  const alternatives = s.anyOf ?? s.oneOf;
  if (!item && alternatives?.length === 2 && s.type === undefined && !s.allOf && !s.not) {
    const kinds = alternatives.map((branch) => parameterType(branch, p));
    const arrayIndex = kinds.indexOf('array');
    const scalarIndex = 1 - arrayIndex;
    const array = alternatives[arrayIndex];
    const scalar = kinds[scalarIndex];
    if (
      array?.items &&
      scalar &&
      ['string', 'integer', 'boolean'].includes(scalar) &&
      parameterType(array.items, p + '/items', true) === scalar
    )
      return 'scalar_or_array';
    fail(p, 'parameter alternatives require a scalar and an array of the same scalar');
  }
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
/** A narrow generation-time safeguard, not a general regex complexity proof. */
function rejectNestedRepetition(source: string, path: string): void {
  const groups = [{ atoms: 0, alternative: false, repeated: false }];
  const atom = (repeated = false) => {
    const group = groups[groups.length - 1]!;
    group.atoms++;
    group.repeated = repeated;
  };
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    if (ch === '\\') {
      i++;
      if (source[i] === 'u') i += 4;
      else if (source[i] === 'x') i += 2;
      atom();
    } else if (ch === '[') {
      while (++i < source.length) {
        if (source[i] === '\\') i++;
        else if (source[i] === ']') break;
      }
      atom();
    } else if (ch === '(') {
      groups.push({ atoms: 0, alternative: false, repeated: false });
      if (source.slice(i + 1, i + 3) === '?:') i += 2;
    } else if (ch === ')') {
      const group = groups.pop()!;
      atom(group.atoms === 1 && !group.alternative && group.repeated);
    } else if (ch === '|') {
      groups[groups.length - 1]!.alternative = true;
    } else if (ch === '*' || ch === '+' || ch === '?' || ch === '{') {
      const bound = ch === '{' ? source.slice(i).match(/^\{\d+(,\d*)?\}/) : undefined;
      const unbounded = ch === '*' || ch === '+' || bound?.[1] === ',';
      const group = groups[groups.length - 1]!;
      if (unbounded && group.repeated)
        fail(path, 'nested unbounded repetition is unsupported; simplify the pattern');
      if (unbounded) group.repeated = true;
      if (bound) i += bound[0].length - 1;
    } else {
      atom();
    }
  }
}

// A deliberately portable ECMAScript subset; translate differences in PCRE rather
// than silently applying a different pattern in the PHP target.
function portablePattern(source: string, p: string): string {
  try {
    new RegExp(source, 'u');
  } catch {
    fail(p, 'invalid Unicode regular expression');
  }
  rejectNestedRepetition(source, p);
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
  if (!legacy && Array.isArray(s.type)) {
    const types = s.type;
    if (
      !types.length ||
      new Set(types).size !== types.length ||
      types.some(
        (type) =>
          !['object', 'array', 'string', 'integer', 'number', 'boolean', 'null'].includes(type),
      )
    )
      fail(p + '/type', 'expected supported unique JSON types');
    if (types.length === 1) {
      if (types[0] === 'null') s.type = 'null';
    } else if (types.length !== 2 || !types.includes('null')) {
      delete s.type;
      const alternatives = {
        anyOf: types.map((type) => ({ type, ...(s.format ? { format: s.format } : {}) })),
      };
      delete s.format;
      if (s.anyOf) s.allOf = [...(s.allOf ?? []), alternatives];
      else s.anyOf = alternatives.anyOf;
    }
  }
  if (s.propertyNames !== undefined) {
    const names = s.propertyNames;
    const remedy =
      'propertyNames supports only string type, minLength, maxLength, pattern, enum and const; express key constraints with these keywords';
    if (!names || typeof names !== 'object' || Array.isArray(names))
      fail(p + '/propertyNames', remedy);
    for (const key of Object.keys(names))
      if (
        ![
          'type',
          'minLength',
          'maxLength',
          'pattern',
          'enum',
          'const',
          'x-sdk-pattern-php',
          // Raw reserved extensions are rejected before dereferencing/protection.
          EXAMPLE_PROTECTION_MARKER,
        ].includes(key)
      )
        fail(p + '/propertyNames/' + pointerSegment(key), remedy);
    if (names.type !== undefined && names.type !== 'string')
      fail(p + '/propertyNames/type', remedy);
    if (
      names.enum !== undefined &&
      (!Array.isArray(names.enum) || names.enum.some((key) => typeof key !== 'string'))
    )
      fail(p + '/propertyNames/enum', remedy);
    if (Object.hasOwn(names, 'const') && typeof names.const !== 'string')
      fail(p + '/propertyNames/const', remedy);
    schema(names, p + '/propertyNames', legacy, explicitNumbers);
  }
  if (s.dependentRequired !== undefined) {
    const dependencies = s.dependentRequired;
    if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies))
      fail(p + '/dependentRequired', 'expected a property dependency map');
    if (s.allOf !== undefined && (!Array.isArray(s.allOf) || !s.allOf.length))
      fail(p + '/allOf', 'expected a nonempty schema array');
    const branches: Schema[] = [];
    for (const [key, required] of Object.entries(dependencies as Record<string, unknown>)) {
      if (
        !Array.isArray(required) ||
        required.some((value) => typeof value !== 'string') ||
        new Set(required).size !== required.length
      )
        fail(p + '/dependentRequired/' + pointerSegment(key), 'expected unique property names');
      if ((required as string[]).length > 0)
        branches.push({
          if: { type: 'object', required: [key] },
          then: { required: required as string[] },
        });
    }
    if (branches.length) s.allOf = [...(s.allOf ?? []), ...branches];
    delete s.dependentRequired;
  }

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
    'propertyNames',
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
    ...schemaAnnotations,
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
          literal(child, location + '/' + pointerSegment(key), depth + 1);
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
          p + '/discriminator/mapping/' + pointerSegment(tag),
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
      'ipv4',
      'ipv6',
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
    schema(child, p + '/properties/' + pointerSegment(key), legacy, explicitNumbers);
  if (s.additionalProperties && typeof s.additionalProperties === 'object')
    schema(s.additionalProperties, p + '/additionalProperties', legacy, explicitNumbers);
  checkRepresentations(s, p, explicitNumbers);
  // Annotation-only wrappers are equivalent to their branch; semantic siblings stay composed.
  if (
    s.allOf?.length === 1 &&
    !s.allOf[0]!['x-sdk-ref'] &&
    Object.keys(s).every(
      (key) => key === 'allOf' || schemaAnnotations.includes(key) || key.startsWith('x-'),
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
    if (type === 'number')
      return exactValue(valueInstruction(type, shape.format)) ? 'exact-number' : 'native-number';
    if (type === 'integer')
      return exactValue(valueInstruction('integer', shape.format))
        ? 'exact-number'
        : 'native-number';
    return type === 'string' ? 'string' : undefined;
  };
  const shapes = conjuncts(s);
  const kinds = new Set(shapes.map(scalar).filter(Boolean));
  if (kinds.has('exact-number') && kinds.has('native-number'))
    fail(
      p,
      'intersected numeric schemas use different SDK representations; use a consistent numeric format with the intersected bounds in a provider override',
    );
  if (kinds.has('string') && (kinds.has('exact-number') || kinds.has('native-number')))
    fail(p, 'intersected string and numeric schemas cannot describe the same non-null JSON value');
  // Constraint-only conjuncts must see the JSON numeric kind, even when callers
  // express that number as an exact SDK string. Inherit only an established kind.
  const numeric = shapes.find((shape) =>
    ['exact-number', 'native-number'].includes(scalar(shape) ?? ''),
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
    if (inheritedKinds.has('exact-number') && inheritedKinds.has('native-number'))
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
      exactValue(valueInstruction(type, shape.format))
        ? shape['x-sdk-number-input'] === 'explicit'
          ? 'wrapped-number'
          : 'string'
        : type === 'integer'
          ? 'number'
          : type,
    );
  };
  const disjointAtRoot = (left: Schema[], right: Schema[], relation: Relation): boolean => {
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
    return false;
  };
  const disjoint = (left: Schema[], right: Schema[], relation: Relation): boolean => {
    if (disjointAtRoot(left, right, relation)) return true;
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
  // Each child has already passed schema validation. Keep fingerprints local:
  // representation inference below mutates owned nodes and invalidates the cache.
  let fingerprints = new WeakMap<object, string>();
  const fingerprint = (shape: object): string => {
    let identity = fingerprints.get(shape);
    if (identity === undefined) {
      const child = (value: unknown): unknown =>
        value !== null && typeof value === 'object' ? { subtree: fingerprint(value) } : value;
      // Hash child identities once instead of retaining/serializing each complete
      // subtree in every comparison key. Tags distinguish arrays from objects.
      identity = hash(
        JSON.stringify(
          Array.isArray(shape)
            ? ['array', shape.map(child)]
            : [
                'object',
                Object.entries(shape)
                  .filter(([, value]) => value !== undefined)
                  .sort(([a], [b]) => a.localeCompare(b, 'en'))
                  .map(([key, value]) => [key, child(value)]),
              ],
        ),
      );
      fingerprints.set(shape, identity);
    }
    return identity;
  };
  const compared = new Set<string>();
  let representationVersion = 0;
  // Overlap checks can only reject (or annotate) pairs involving an exact
  // number. Ignore annotation payloads and unrelated schema constraints when
  // proving that a subtree cannot contain such a representation conflict.
  const representationKinds = new WeakMap<Schema, number>();
  const exact = 1,
    native = 2,
    string = 4;
  const kindsIn = (shape: Schema): number => {
    // Legacy configured reference metadata can bypass child schema validation.
    if (!shape || typeof shape !== 'object') return 0;
    const previous = representationKinds.get(shape);
    if (previous !== undefined) return previous;
    const kind = scalar(shape);
    let kinds =
      kind === 'exact-number'
        ? exact
        : kind === 'native-number'
          ? native
          : kind === 'string'
            ? string
            : 0;
    for (const child of [
      ...Object.values(shape.properties ?? {}),
      ...(shape.allOf ?? []),
      ...(shape.oneOf ?? []),
      ...(shape.anyOf ?? []),
      ...(shape.items ? [shape.items] : []),
      ...(typeof shape.additionalProperties === 'object' ? [shape.additionalProperties] : []),
    ])
      kinds |= kindsIn(child);
    // Comparisons only turn exact numbers into wrapped numbers, so a cached
    // summary remains a conservative overestimate after that annotation.
    representationKinds.set(shape, kinds);
    return kinds;
  };
  const checkOverlap = (
    left: Schema[],
    right: Schema[],
    path: string,
    relation: Relation = 'alternatives',
  ): void => {
    if (!left.length || !right.length) return;
    if (disjointAtRoot(left, right, relation)) return;
    const a = left.reduce((kinds, shape) => kinds | kindsIn(shape), 0);
    const b = right.reduce((kinds, shape) => kinds | kindsIn(shape), 0);
    const other = relation === 'intersection' ? native : string;
    if (!((a & exact && b & other) || (b & exact && a & other))) return;
    // Cache only a completed comparison of this relation. Individually valid
    // alternatives can still have incompatible cross-branch intersections.
    const key = JSON.stringify([relation, left.map(fingerprint), right.map(fingerprint)]);
    if (compared.has(key)) return;
    const version = representationVersion;
    compareOverlap(left, right, path, relation);
    if (version === representationVersion) compared.add(key);
  };
  const compareOverlap = (
    left: Schema[],
    right: Schema[],
    path: string,
    relation: Relation,
  ): void => {
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
        (a.has('exact-number') && b.has('native-number')) ||
        (b.has('exact-number') && a.has('native-number'))
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
          fingerprints = new WeakMap();
          compared.clear();
          representationVersion++;
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
      checkOverlap(
        children(left),
        children(right),
        path + '/properties/' + pointerSegment(key),
        relation,
      );
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
        checkRepresentations(
          { allOf: children },
          p + '/properties/' + pointerSegment(name),
          explicitNumbers,
        );
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
/** Clone owned JSON containers while reusing immutable primitive values.
 * structuredClone copies string storage too, multiplying large enum annotations
 * each time a resolved response schema is instantiated. */
function cloneJson(
  value: unknown,
  referenceNames?: WeakMap<object, string>,
  typeNames?: WeakMap<object, string>,
): unknown {
  if (value === null || typeof value !== 'object') return value;
  const copy = Array.isArray(value)
    ? value.map((child) => cloneJson(child, referenceNames, typeNames))
    : Object.fromEntries(
        Object.entries(value).map(([key, child]) => [
          key,
          cloneJson(child, referenceNames, typeNames),
        ]),
      );
  const name = referenceNames?.get(value);
  if (name) referenceNames?.set(copy, name);
  const typeName = typeNames?.get(value);
  if (typeName) typeNames?.set(copy, typeName);
  return copy;
}

export function loadContract(
  definitionPath: string,
  configPath: string,
  options: { collectDiagnostics?: boolean; onWarning?: (warning: Diagnostic) => void } = {},
): Contract {
  const documents = new Map<string, unknown>();
  const locate = (finding: Diagnostic): Diagnostic => {
    if (finding.source) return finding;
    const config = finding.location === 'config' || finding.location.startsWith('config/');
    if (
      !config &&
      finding.location !== '' &&
      finding.location !== '/' &&
      !/^\/(?:paths|components|openapi|servers|webhooks|info|security)(?:\/|$)/.test(
        finding.location,
      )
    )
      return finding;
    return locateDiagnostic(
      finding,
      [...documents]
        .filter(([file]) =>
          config ? file !== resolve(definitionPath) : file === resolve(definitionPath),
        )
        .map(([file, value]) => ({
          source: relativePath(process.cwd(), file).replaceAll('\\', '/'),
          value,
        })),
      config ? 'config' : '',
    );
  };
  try {
    return loadContractInput(
      definitionPath,
      configPath,
      {
        ...options,
        onWarning: (warning) => options.onWarning?.(locate(warning)),
      },
      documents,
    );
  } catch (error) {
    if (error instanceof DiagnosticGroup) throw new DiagnosticGroup(error.findings.map(locate));
    if (error instanceof Diagnostic) throw locate(error);
    throw error;
  }
}

function loadContractInput(
  definitionPath: string,
  configPath: string,
  options: { collectDiagnostics?: boolean; onWarning?: (warning: Diagnostic) => void },
  documents: Map<string, unknown>,
): Contract {
  const diagnostics = new DiagnosticCollector(options.collectDiagnostics ?? false);
  const sources: Record<string, string> = {};
  const sourceJson = new SourceJson();
  const rootDir = dirname(resolve(definitionPath));
  const references: { path: string; model: string }[] = [];
  const resolved = new Map<string, { value: any; models: string[] }>();
  const cycles = new Map<string, string>();
  let exampleProtection: ReturnType<typeof sourceExampleProtection> | undefined;
  const exampleDocumentIds = new Map([[resolve(definitionPath), '']]);
  const sourceDocument = (file: string): string => {
    const previous = exampleDocumentIds.get(file);
    if (previous !== undefined) return previous;
    const identity = 'local:' + hash(relativePath(rootDir, file));
    exampleDocumentIds.set(file, identity);
    return identity;
  };
  const protectExamples = <T>(value: T, file: string, sourcePath: string, context: Context): T => {
    if (
      context === 'schema' &&
      value &&
      typeof value === 'object' &&
      exampleProtection?.protects(sourceDocument(file), sourcePath)
    )
      Reflect.set(value, EXAMPLE_PROTECTION_MARKER, true);
    return value;
  };
  // Keep use-site identity outside the expanded schema until validation finishes.
  const referenceNames = new WeakMap<object, string>();
  const typeNames = new WeakMap<object, string>();
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
          'propertyNames',
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
      const { content, value } = readInput(file, sourceJson);
      documents.set(file, value);
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
    sourcePath = path,
  ): any {
    if (context === 'literal') return cloneJson(value);
    if (Array.isArray(value))
      return value.map((v, i) =>
        deref(v, file, `${path}/${i}`, stack, context, `${sourcePath}/${i}`),
      );
    if (!value || typeof value !== 'object') return value;
    if (context === 'schema' && !(raw.openapi.startsWith('3.0.') && '$ref' in value))
      for (const key of [
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
        'const',
        'enum',
      ])
        if (Object.hasOwn(value, key))
          sourceJson.assertMember(value, key, path + '/' + pointerSegment(key));
    const map = context.startsWith('map:');
    if (!map && Object.keys(value).some((key) => key.startsWith('x-sdk-')))
      fail(path, 'x-sdk-* extensions are reserved for resolved generator metadata');
    if (!map && '$ref' in value) {
      const applySiblings = (result: any): any => {
        if (context === 'schema' && target === resolve(definitionPath) && modelMatch)
          typeNames.set(
            result,
            publicModel(modelMatch[1]!.replace(/~1/g, '/').replace(/~0/g, '~')),
          );
        if (raw.openapi.startsWith('3.0.'))
          return protectExamples(result, file, sourcePath, context);
        const { $ref, ...siblings } = value;
        if (context === 'schema') {
          if (!Object.keys(siblings).length)
            return protectExamples(result, file, sourcePath, context);
          record(result, path);
          const local = deref(siblings, file, path, stack, context, sourcePath);
          if (local.allOf !== undefined && (!Array.isArray(local.allOf) || !local.allOf.length))
            fail(path + '/allOf', 'expected a nonempty schema array');
          for (const key of ['readOnly', 'writeOnly', 'deprecated', 'x-sensitive'])
            if (local[key] !== undefined && typeof local[key] !== 'boolean')
              fail(path + '/' + pointerSegment(key), 'expected a boolean');
          if (Object.keys(local).every(isSchemaAnnotation)) {
            const combined = { ...result, ...local };
            for (const key of ['readOnly', 'writeOnly', 'x-sensitive'])
              if (result[key] === true || local[key] === true) combined[key] = true;
            if (combined.readOnly && combined.writeOnly)
              fail(path, 'a field cannot be both readOnly and writeOnly');
            if (target === resolve(definitionPath) && modelMatch)
              referenceNames.set(
                combined,
                publicModel(modelMatch[1]!.replace(/~1/g, '/').replace(/~0/g, '~')),
              );
            const typeName = typeNames.get(result);
            if (typeName) typeNames.set(combined, typeName);
            return protectExamples(combined, file, sourcePath, context);
          }
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
          return protectExamples(combined, file, sourcePath, context);
        }
        for (const key of ['summary', 'description']) {
          if (!Object.hasOwn(siblings, key)) continue;
          if (typeof siblings[key] !== 'string')
            fail(path + '/' + pointerSegment(key), 'expected a string');
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
          ? publicModel(original)
          : 'ReferencedModel' + hash(relativePath(rootDir, target) + '#' + fragment).slice(0, 12);
        if (cycles.has(mapped) && cycles.get(mapped) !== key)
          fail(path, 'recursive model name collision');
        cycles.set(mapped, key);
        return applySiblings({ 'x-sdk-ref': mapped });
      }
      const cached = resolved.get(cacheKey);
      if (cached) {
        for (const model of cached.models) references.push({ path, model });
        return applySiblings(cloneJson(cached.value, referenceNames, typeNames));
      }
      const before = references.length;
      const result = deref(
        pointer(load(target), fragment, path),
        target,
        path,
        [...stack, { key: cacheKey, path }],
        context,
        fragment,
      );
      resolved.set(cacheKey, {
        value: result,
        models: [...new Set(references.slice(before).map((ref) => ref.model))],
      });
      return applySiblings(cloneJson(result, referenceNames, typeNames));
    }
    const result = Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        deref(
          v,
          file,
          `${path}/${pointerSegment(k)}`,
          stack,
          childContext(context, k),
          `${sourcePath}/${pointerSegment(k)}`,
        ),
      ]),
    );
    if (context === 'schema' && value.discriminator?.mapping !== undefined) {
      const mapping = value.discriminator.mapping;
      record(mapping, path + '/discriminator/mapping');
      if (!Array.isArray(result.oneOf))
        fail(path + '/discriminator', 'mapping requires oneOf branches');
      const bindings: Record<string, number> = Object.create(null);
      for (const [tag, target] of Object.entries(mapping)) {
        const location = path + '/discriminator/mapping/' + pointerSegment(tag);
        if (typeof target !== 'string') fail(location, 'expected a local schema reference');
        const ref = Object.hasOwn(load(file).components?.schemas ?? {}, target)
          ? '#/components/schemas/' + pointerSegment(target)
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
    return protectExamples(result, file, sourcePath, context);
  }
  const raw = load(resolve(definitionPath));
  openApiObject(raw);
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
        Object.defineProperty(result, key, {
          value: mergeProfiles(
            Object.hasOwn(result, key) ? result[key] : undefined,
            value,
            path + '/' + pointerSegment(key),
          ),
          writable: true,
          enumerable: true,
          configurable: true,
        });
      return result;
    }
    return fail(path, 'conflicting SDK profile settings');
  };
  const loadProfile = (file: string, stack = new Set<string>()): unknown => {
    if (stack.has(file)) fail('config/profiles', 'profile reference cycle');
    const source = load(file);
    sourceJson.assertExact(source, 'config');
    const input = structuredClone(source);
    record(input, 'config');
    const { profiles, $schema, ...settings } = input;
    if ($schema !== undefined && typeof $schema !== 'string')
      fail('config/$schema', 'expected a JSON Schema URI string');
    const local = stack.size === 0 && $schema !== undefined ? { ...settings, $schema } : settings;
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
  let inferredModels = new Map<string, string>();
  const publicModel = (original: string) => inferredModels.get(original) ?? original;

  // Skip checks that depend on an invalid container, while validating unrelated settings.
  const invalidConfig = new Set<string>();
  const checkConfig = (dependencies: string[], validate: () => void): void => {
    if (dependencies.every((key) => !invalidConfig.has(key))) diagnostics.check(validate);
  };
  for (const key of ['targets', 'include', 'audiences'] as const)
    if (
      config[key] !== undefined &&
      !diagnostics.check(() => strings(config[key], 'config/' + key))
    )
      invalidConfig.add(key);
  for (const key of [
    'requests',
    'responses',
    'auth',
    'npm',
    'composer',
    'errors',
    'webhook',
    'money',
    'operations',
    'models',
    'phpFieldClasses',
    'overrides',
    'documentation',
    'release',
    'defaults',
  ] as const)
    if (config[key] !== undefined && !diagnostics.check(() => record(config[key], 'config/' + key)))
      invalidConfig.add(key);
  const targets = invalidConfig.has('targets') ? [] : (config.targets ?? ['node', 'php']);
  if (!invalidConfig.has('targets') && !targets.includes('php') && config.composer === undefined)
    config.composer = { name: 'unused/sdk', namespace: 'UnusedSdk' };
  if (!invalidConfig.has('targets') && !targets.includes('node') && config.npm === undefined)
    config.npm = { name: 'unused-sdk' };
  diagnostics.check(() => {
    keys(
      config,
      [
        'operationNames',
        'requests',
        'responses',
        'targets',
        'validation',
        '$schema',
        'defaults',
        'profiles',
        'numericUnions',
        'schemaSharing',
        'auth',
        'version',
        'npm',
        'composer',
        'operations',
        'models',
        'phpFieldClasses',
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
      Object.hasOwn(config, 'openapi') || Object.hasOwn(config, 'paths')
        ? ' SDK_JSON looks like an OpenAPI document; check whether the API_JSON and SDK_JSON arguments are swapped.'
        : '',
    );
  });
  diagnostics.check(() => {
    if (config.$schema !== undefined && typeof config.$schema !== 'string')
      fail('config/$schema', 'expected a JSON Schema URI string');
  });
  checkConfig(['defaults'], () => {
    if (config.defaults) {
      keys(config.defaults, ['idempotency', 'retry', 'pagination'], 'config/defaults');
      for (const key of ['idempotency', 'retry', 'pagination'] as const)
        if (config.defaults[key] !== undefined)
          keys(config.defaults[key]!, capabilityFields[key], 'config/defaults/' + key);
    }
  });
  diagnostics.check(() => {
    if (config.schemaSharing !== undefined && config.schemaSharing !== 'named')
      fail('config/schemaSharing', 'expected named');
  });
  diagnostics.check(() => {
    if (config.numericUnions !== undefined && config.numericUnions !== 'explicit')
      fail('config/numericUnions', 'expected explicit');
  });
  for (const key of ['schemaSharing', 'numericUnions'] as const)
    if (config[key] !== undefined)
      options.onWarning?.(
        new Diagnostic(
          'config/' + key,
          'deprecated; this behavior is automatic and the setting can be omitted',
        ),
      );
  config.schemaSharing ??= 'named';
  config.numericUnions ??= 'explicit';
  diagnostics.check(() => {
    if (config.validation !== undefined && !['encoding', 'schema'].includes(config.validation))
      fail('config/validation', 'expected encoding or schema');
  });
  diagnostics.check(() => {
    if (config.operationNames !== undefined && !['tags', 'path'].includes(config.operationNames))
      fail('config/operationNames', 'expected tags or path');
  });
  checkConfig(['requests'], () => {
    if (config.requests !== undefined) validateRequestStyle(config.requests, 'config/requests');
  });
  checkConfig(['responses'], () => {
    if (config.responses !== undefined) {
      validateResponseReturn(config.responses, 'config/responses');
      if (config.responses.payloadPath && config.responses.return === 'result')
        fail('config/responses/payloadPath', 'payloadPath requires return: payload');
    }
  });
  checkConfig(['operations'], () => {
    for (const [id, capability] of Object.entries(config.operations ?? {}))
      diagnostics.check(() => record(capability, 'config/operations/' + pointerSegment(id)));
  });
  checkConfig(['models', 'targets'], () => {
    for (const [original, mapped] of Object.entries(config.models ?? {}))
      diagnostics.check(() =>
        modelName(mapped, 'config/models/' + pointerSegment(original), config.targets),
      );
  });
  checkConfig(['phpFieldClasses', 'targets'], () => {
    if (config.phpFieldClasses === undefined) return;
    diagnostics.check(() => {
      if (!targets.includes('php')) fail('config/phpFieldClasses', 'requires the php target');
    });
    for (const [owner, fields] of Object.entries(config.phpFieldClasses)) {
      const path = 'config/phpFieldClasses/' + pointerSegment(owner);
      if (!diagnostics.check(() => record(fields, path))) continue;
      for (const [field, value] of Object.entries(fields))
        diagnostics.check(() => modelName(value, path + '/' + pointerSegment(field), ['php']));
    }
  });
  checkConfig(['release'], () => {
    if (config.release !== undefined) {
      diagnostics.check(() => keys(config.release!, ['baseUrl', 'policy'], 'config/release'));
      diagnostics.check(() => {
        if (
          config.release!.policy !== undefined &&
          !['review', 'semver'].includes(config.release!.policy)
        )
          fail('config/release/policy', 'expected review or semver');
      });
      diagnostics.check(() => {
        if (config.release!.baseUrl !== undefined) {
          let url: URL;
          try {
            url = new URL(config.release!.baseUrl);
          } catch {
            return fail('config/release/baseUrl', 'expected an absolute publication URL');
          }
          if (
            (url.protocol !== 'https:' &&
              !(
                url.protocol === 'http:' &&
                ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
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
      });
    }
  });
  checkConfig(['errors'], () => {
    if (config.errors !== undefined) {
      diagnostics.check(() =>
        keys(
          config.errors!,
          ['codePath', 'messagePath', 'detailsPath', 'requestIdHeader', 'retry', 'inProgressCodes'],
          'config/errors',
        ),
      );
      diagnostics.check(() => {
        for (const key of ['codePath', 'messagePath', 'detailsPath'] as const)
          diagnostics.check(() => {
            if (
              config.errors![key] !== undefined &&
              (typeof config.errors![key] !== 'string' ||
                !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(config.errors![key]!))
            )
              fail(`config/errors/${key}`, 'expected a dot-separated field path');
          });
      });
      diagnostics.check(() => {
        const codes = config.errors!.inProgressCodes;
        if (
          codes !== undefined &&
          (!Array.isArray(codes) || codes.some((code) => typeof code !== 'string' || !code.trim()))
        )
          fail('config/errors/inProgressCodes', 'expected nonempty string codes');
        const retry = config.errors!.retry;
        if (retry !== undefined) {
          keys(retry, ['path', 'retryValues'], 'config/errors/retry');
          if (!config.errors!.codePath) fail('config/errors/retry', 'requires errors.codePath');
          if (
            typeof retry.path !== 'string' ||
            !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(retry.path)
          )
            fail('config/errors/retry/path', 'expected a dot-separated field path');
          if (
            !Array.isArray(retry.retryValues) ||
            !retry.retryValues.length ||
            retry.retryValues.some((value) => typeof value !== 'string' || !value.trim())
          )
            fail('config/errors/retry/retryValues', 'expected nonempty string values');
        }
      });
      diagnostics.check(() => {
        if (config.errors!.requestIdHeader !== undefined)
          header(config.errors!.requestIdHeader, 'config/errors/requestIdHeader');
      });
    }
  });
  checkConfig(['documentation'], () => {
    if (config.documentation !== undefined) {
      diagnostics.check(() =>
        keys(
          config.documentation!,
          ['overview', 'guides', 'examples', 'authShortcut', 'apiName', 'operationUrl', 'tagSlugs'],
          'config/documentation',
        ),
      );
      diagnostics.check(() => {
        const { apiName, operationUrl, tagSlugs } = config.documentation!;
        if (
          apiName !== undefined &&
          (typeof apiName !== 'string' || !apiName.trim() || /[\r\n]/.test(apiName))
        )
          fail('config/documentation/apiName', 'expected a nonempty one-line name such as "Flint"');
        if (operationUrl !== undefined) {
          const placeholders = [...String(operationUrl).matchAll(/\{([^}]*)\}/g)].map((m) => m[1]);
          const unknown = placeholders.find((p) => !['operationId', 'tag', 'tagSlug'].includes(p!));
          if (unknown !== undefined)
            fail(
              'config/documentation/operationUrl',
              `unknown placeholder {${unknown}}; use {operationId}, {tag} or {tagSlug}`,
            );
          publicationUrl(
            String(operationUrl).replace(/\{[^}]*\}/g, 'x'),
            'config/documentation/operationUrl',
          );
          if (placeholders.includes('tagSlug') && tagSlugs === undefined)
            fail(
              'config/documentation/tagSlugs',
              'operationUrl uses {tagSlug}; map every tag to a slug',
            );
        }
        if (tagSlugs !== undefined) {
          record(tagSlugs, 'config/documentation/tagSlugs');
          for (const [tag, slug] of Object.entries(tagSlugs))
            if (!tag || typeof slug !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(slug))
              fail(
                `config/documentation/tagSlugs/${pointerSegment(tag)}`,
                'expected a URL path slug such as "payment-links"',
              );
        }
      });
      diagnostics.check(() => {
        const name = config.documentation!.authShortcut;
        if (name === undefined) return;
        const auth: unknown = config.auth;
        const shortcuts =
          auth && typeof auth === 'object' && 'shortcuts' in auth ? auth.shortcuts : undefined;
        if (
          typeof name !== 'string' ||
          !shortcuts ||
          typeof shortcuts !== 'object' ||
          !Object.hasOwn(shortcuts, name)
        )
          fail('config/documentation/authShortcut', 'name a shortcut declared in auth.shortcuts');
      });
      diagnostics.check(() => {
        if (
          config.documentation!.examples !== undefined &&
          (!Array.isArray(config.documentation!.examples) ||
            config.documentation!.examples.some((id) => typeof id !== 'string' || !id.trim()) ||
            new Set(config.documentation!.examples).size !== config.documentation!.examples.length)
        )
          fail('config/documentation/examples', 'expected unique operation IDs');
      });
      diagnostics.check(() => {
        if (
          config.documentation!.overview !== undefined &&
          typeof config.documentation!.overview !== 'string'
        )
          fail('config/documentation/overview', 'expected Markdown text');
      });
      diagnostics.check(() => {
        if (config.documentation!.guides !== undefined) {
          if (
            !config.documentation!.guides ||
            typeof config.documentation!.guides !== 'object' ||
            Array.isArray(config.documentation!.guides)
          )
            fail('config/documentation/guides', 'expected a guide-name to Markdown map');
          for (const [name, content] of Object.entries(config.documentation!.guides))
            if (!/^[a-z0-9][a-z0-9-]*$/.test(name) || typeof content !== 'string')
              fail(
                `config/documentation/guides/${pointerSegment(name)}`,
                'use a lowercase guide slug and Markdown text',
              );
        }
      });
    }
  });
  checkConfig(['npm'], () => {
    if (config.npm !== undefined)
      diagnostics.check(() => {
        keys(config.npm, ['name', 'registry', 'access', 'homepage', 'repository'], 'config/npm');
      });
  });
  checkConfig(['npm'], () => {
    if (config.npm?.homepage !== undefined)
      publicationUrl(config.npm.homepage, 'config/npm/homepage');
  });
  checkConfig(['npm'], () => {
    const repository = config.npm?.repository;
    if (repository === undefined) return;
    keys(repository, ['type', 'url', 'directory'], 'config/npm/repository');
    diagnostics.check(() => {
      if (repository.type !== 'git') fail('config/npm/repository/type', 'expected git');
    });
    diagnostics.check(() => publicationUrl(repository.url, 'config/npm/repository/url', true));
    diagnostics.check(() => {
      const directory = repository.directory;
      if (
        directory !== undefined &&
        (typeof directory !== 'string' ||
          /[\\:\u0000-\u001f\u007f]/.test(directory) ||
          directory.split('/').some((part) => !part || part === '.' || part === '..'))
      )
        fail(
          'config/npm/repository/directory',
          'expected a relative repository path with forward slashes and no traversal',
        );
    });
  });
  checkConfig(['npm'], () => {
    if (config.npm !== undefined)
      diagnostics.check(() => {
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
      });
  });
  checkConfig(['npm'], () => {
    if (config.npm !== undefined)
      diagnostics.check(() => {
        if (
          config.npm.access !== undefined &&
          !['public', 'restricted'].includes(config.npm.access)
        )
          fail('config/npm/access', 'expected public or restricted');
      });
  });
  checkConfig(['npm'], () => {
    if (config.npm !== undefined)
      diagnostics.check(() => {
        if (
          config.npm.access === 'restricted' &&
          (typeof config.npm.name !== 'string' || !config.npm.name.startsWith('@'))
        )
          fail('config/npm/access', 'restricted npm packages require a scoped package name');
      });
  });
  checkConfig(['composer'], () => {
    if (config.composer !== undefined)
      diagnostics.check(() => {
        keys(config.composer, ['name', 'namespace'], 'config/composer');
      });
  });
  diagnostics.check(() => assertOpenApiVersion(raw.openapi));
  diagnostics.check(() => {
    if (
      !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?$/.test(
        config.version ?? '',
      )
    )
      fail('config/version', 'expected a semantic package version');
  });
  checkConfig(['npm'], () => {
    if (config.npm !== undefined)
      diagnostics.check(() => {
        if (!/^(@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(config.npm?.name ?? ''))
          fail('config/npm/name', 'expected an npm package name');
        if (config.npm.name.length > 214)
          fail(
            'config/npm/name',
            'npm package names must be at most 214 characters, including scope',
          );
      });
  });
  checkConfig(['composer'], () => {
    if (config.composer !== undefined)
      diagnostics.check(() => {
        if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(config.composer?.name ?? ''))
          fail('config/composer/name', 'expected vendor/package');
      });
  });
  checkConfig(['composer'], () => {
    if (config.composer !== undefined)
      diagnostics.check(() => {
        if (!/^[A-Z][A-Za-z0-9]*(?:\\[A-Z][A-Za-z0-9]*)*$/.test(config.composer?.namespace ?? ''))
          fail('config/composer/namespace', 'expected a PHP namespace such as Acme\\Sdk');
      });
  });
  checkConfig(['targets'], () => {
    if (
      targets.includes('php') &&
      !diagnostics.findings.some((d) => d.location === 'config/version') &&
      typeof config.version === 'string' &&
      config.version.includes('-') &&
      !/^\d+\.\d+\.\d+-(?:alpha|beta|rc)(?:\.\d+)?$/.test(config.version)
    )
      fail(
        'config/version',
        'PHP-compatible prereleases use alpha, beta or rc, optionally followed by a numeric identifier (for example 1.2.0-beta.1)',
      );
  });
  checkConfig(['targets'], () => {
    if (
      !targets.length ||
      new Set(targets).size !== targets.length ||
      targets.some((t) => !['node', 'php'].includes(t))
    )
      fail('config/targets', 'select node and/or php, each once');
  });
  for (const [key, target, alternative] of [
    ['composer', 'php', 'node'],
    ['npm', 'node', 'php'],
  ] as const) {
    if (config[key] === undefined && targets.includes(target))
      diagnostics.check(() =>
        fail(
          'config/' + key,
          `required for the ${target} target${config.targets === undefined ? ' (targets defaults to ["node", "php"])' : ''}; provide ${key} settings or set targets to ["${alternative}"] for a ${alternative}-only SDK`,
        ),
      );
  }
  for (const [p, replacement] of Object.entries(
    invalidConfig.has('overrides') ? {} : (config.overrides ?? {}),
  )) {
    diagnostics.check(() => {
      const parts = p.split('/');
      const key = parts.pop()!;
      const parent = pointer(raw, parts.join('/'), `config/overrides/${pointerSegment(p)}`);
      if (!parent || typeof parent !== 'object')
        fail('config/overrides/' + pointerSegment(p), 'override parent must be an object or array');
      const decoded = key.replace(/~1/g, '/').replace(/~0/g, '~');
      if (!Object.hasOwn(parent, decoded))
        fail(
          'config/overrides/' + pointerSegment(p),
          'override pointer does not exist; overrides replace existing values only',
        );
      parent[decoded] = replacement;
      sourceJson.forget(parent, decoded);
    });
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
  type PathField = { value: any; file: string; sourcePath: string };
  function pathFields(
    item: any,
    file: string,
    path: string,
    seen = new Set<string>(),
    sourcePath = path,
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
      fields = pathFields(pointer(load(target), fragment, path), target, path, seen, fragment);
    }
    for (const [key, value] of Object.entries(item)) {
      if (key === '$ref') continue;
      if (key.startsWith('x-sdk-'))
        fail(path, 'x-sdk-* extensions are reserved for resolved generator metadata');
      if (Object.hasOwn(fields, key))
        fail(path + '/' + pointerSegment(key), 'conflicting path item $ref field ' + key);
      Object.defineProperty(fields, key, {
        value: { value, file, sourcePath: sourcePath + '/' + pointerSegment(key) },
        enumerable: true,
        configurable: true,
      });
    }
    return fields;
  }
  // Path-item references contribute operation IDs just like inline path items.
  const declaredIds = new Set<string>();
  let completeInventory =
    !invalidConfig.has('overrides') &&
    !diagnostics.findings.some((d) => d.location.startsWith('config/overrides'));
  for (const [path, item] of Object.entries(raw.paths ?? {})) {
    const valid = diagnostics.check(() => {
      for (const [verb, field] of Object.entries(
        pathFields(item, resolve(definitionPath), '/paths/' + pointerSegment(path)),
      ))
        if (
          ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(verb) &&
          typeof field.value?.operationId === 'string'
        )
          declaredIds.add(field.value.operationId);
    });
    completeInventory &&= valid;
  }
  if (completeInventory) {
    for (const id of Object.keys(invalidConfig.has('operations') ? {} : (config.operations ?? {})))
      if (!declaredIds.has(id))
        diagnostics.check(() =>
          fail(
            'config/operations/' + pointerSegment(id),
            `operation ID "${id}" is not in the contract.${suggestion(id, [...declaredIds])}`,
          ),
        );
    for (const [index, id] of (invalidConfig.has('include')
      ? []
      : (config.include ?? [])
    ).entries())
      if (!declaredIds.has(id))
        diagnostics.check(() =>
          fail(
            'config/include/' + index,
            `operation ID "${id}" is not in the contract.${suggestion(id, [...declaredIds])}`,
          ),
        );
  }
  diagnostics.finish();
  inferredModels = modelNames(Object.keys(raw.components?.schemas ?? {}), config.models);
  const includedOperation = (op: unknown): boolean => {
    const id: unknown = op && typeof op === 'object' ? Reflect.get(op, 'operationId') : undefined;
    const capability = typeof id === 'string' ? own(config.operations, id) : undefined;
    return (
      !capability?.hidden &&
      (!config.include || (typeof id === 'string' && config.include.includes(id))) &&
      (!config.audiences ||
        Boolean(capability?.audiences?.some((a) => config.audiences!.includes(a))))
    );
  };
  const ancestorProtection = new Map<string, boolean>();
  const protectedSourceAncestor = (file: string, path: string): boolean => {
    const key = sourceDocument(file) + '#' + path;
    const previous = ancestorProtection.get(key);
    if (previous !== undefined) return previous;
    const flagged = (value: unknown): boolean =>
      Boolean(
        value &&
          typeof value === 'object' &&
          (Reflect.get(value, 'x-sensitive') === true ||
            Reflect.get(value, 'writeOnly') === true ||
            Reflect.get(value, 'format') === 'password'),
      );
    let value: unknown = load(file);
    let protectedAncestor = flagged(value);
    for (const part of path.split('/').slice(1, -1)) {
      value =
        value && typeof value === 'object'
          ? Reflect.get(value, part.replace(/~1/g, '/').replace(/~0/g, '~'))
          : undefined;
      protectedAncestor ||= flagged(value);
    }
    ancestorProtection.set(key, protectedAncestor);
    return protectedAncestor;
  };
  const exampleRoots: ExampleSource[] = [];
  const addExampleRoot = (field: PathField, context: Context): void => {
    exampleRoots.push({
      document: sourceDocument(field.file),
      pointer: field.sourcePath,
      value: field.value,
      protectedAncestor: protectedSourceAncestor(field.file, field.sourcePath),
      context,
    });
  };
  for (const [path, item] of Object.entries(raw.paths ?? {})) {
    const fields = pathFields(item, resolve(definitionPath), '/paths/' + pointerSegment(path));
    let selected = false;
    for (const [verb, field] of Object.entries(fields)) {
      // Malformed operations are reported by validation below; protection skips them.
      if (
        !['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(verb) ||
        !field.value ||
        typeof field.value !== 'object' ||
        !includedOperation(field.value)
      )
        continue;
      selected = true;
      addExampleRoot(field, 'operation');
      const operationId: unknown = field.value.operationId;
      if (typeof operationId !== 'string') continue;
      for (const [event, ref] of Object.entries(
        own(config.operations, operationId)?.stream?.events ?? {},
      ))
        exampleRoots.push({
          // Configured references resolve from the API root. Their synthetic
          // locations still identify the operation and its vendored source.
          document: '',
          pointer:
            '/config/operations/' +
            pointerSegment(operationId) +
            '/sources/' +
            pointerSegment(sourceDocument(field.file)) +
            field.sourcePath +
            '/stream/events/' +
            pointerSegment(event),
          value: { $ref: ref },
          context: 'schema',
        });
    }
    if (selected && fields.parameters) addExampleRoot(fields.parameters, 'parameter');
  }
  for (const [name, item] of Object.entries(raw.webhooks ?? {}))
    for (const [method, field] of Object.entries(
      pathFields(item, resolve(definitionPath), '/webhooks/' + pointerSegment(name)),
    ))
      if (['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(method))
        addExampleRoot(field, 'operation');
  for (const [event, value] of Object.entries(config.webhook?.events ?? {}))
    exampleRoots.push({
      document: 'config',
      pointer: '/webhook/events/' + pointerSegment(event),
      value,
      context: 'schema',
    });
  const exampleDocuments = new Map([
    [sourceDocument(resolve(definitionPath)), resolve(definitionPath)],
  ]);
  exampleDocuments.set('config', resolve(configPath));
  // Path-item roots can originate in other vendored documents.
  for (const file of documents.keys()) exampleDocuments.set(sourceDocument(file), file);
  exampleProtection = sourceExampleProtection(
    exampleRoots,
    (context, key) => {
      if (context === 'map:composition') return 'schema';
      if (context === 'schema' && ['patternProperties', 'dependentSchemas'].includes(key))
        return key === 'dependentSchemas' ? 'map:composition' : 'map:schema';
      if (context === 'schema' && key === 'prefixItems') return 'schema';
      return childContext(context, key);
    },
    (source, ref) => {
      if (/^\w+:/.test(ref) || ref.startsWith('//'))
        fail(
          source.pointer,
          'remote references must be vendored locally for reproducible generation',
        );
      const file =
        exampleDocuments.get(source.document) ??
        fail(source.pointer, 'unresolved example source document');
      const [relative, fragment = ''] = ref.split('#');
      const target = resolve(dirname(file), relative || file);
      const document = sourceDocument(target);
      exampleDocuments.set(document, target);
      return {
        document,
        pointer: fragment,
        value: pointer(load(target), fragment, source.pointer),
        protectedAncestor: protectedSourceAncestor(target, fragment),
        context: source.context,
      };
    },
    raw.openapi.startsWith('3.0.'),
    isSchemaAnnotation,
  );
  // Configured event schemas are already inline rather than dereferenced. Mark
  // their source locations before validation can normalize annotation wrappers.
  const markConfiguredExamples = (
    value: unknown,
    sourcePath: string,
    context: Context,
    propertyNames = false,
  ): void => {
    if (context === 'literal' || !value || typeof value !== 'object') return;
    // Resolved event configs already support reference metadata; guard new key
    // schemas before adding their trusted publication markers.
    if (propertyNames && Object.keys(value).some((key) => key.startsWith('x-sdk-')))
      fail(
        'config' + sourcePath,
        'x-sdk-* extensions are reserved for resolved generator metadata',
      );
    if (context === 'schema' && exampleProtection?.protects('config', sourcePath))
      Reflect.set(value, EXAMPLE_PROTECTION_MARKER, true);
    for (const [key, child] of Object.entries(value))
      if (key !== EXAMPLE_PROTECTION_MARKER)
        markConfiguredExamples(
          child,
          sourcePath + '/' + pointerSegment(key),
          Array.isArray(value) ? context : childContext(context, key),
          context === 'schema' && key === 'propertyNames',
        );
  };
  for (const [event, value] of Object.entries(config.webhook?.events ?? {}))
    markConfiguredExamples(value, '/webhook/events/' + pointerSegment(event), 'schema');
  const streamSchemas = new Map<string, Record<string, Schema>>();
  const selectedPaths = Object.fromEntries(
    Object.entries(raw.paths ?? {}).map(([path, item]) => {
      const fields = pathFields(item, resolve(definitionPath), '/paths/' + pointerSegment(path));
      let selectedAny = false;
      const entries = Object.entries(fields)
        .filter(([key]) => key !== 'parameters')
        .map(([verb, field]) => {
          const { value: op, file } = field;
          const p = '/paths/' + pointerSegment(path) + '/' + pointerSegment(verb);
          if (!['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(verb))
            return [verb, deref(op, file, p, [], childContext('pathItem', verb))];
          record(op, p);
          const c = own(config.operations, op.operationId);
          const included = includedOperation(op);
          if (!included) return [verb, { operationId: op.operationId }];
          selectedAny = true;
          collect(op, file, 'operation');
          if (c?.stream?.events) {
            record(
              c.stream.events,
              'config/operations/' + pointerSegment(op.operationId) + '/stream/events',
            );
            const events: Record<string, Schema> = Object.create(null);
            for (const [event, ref] of Object.entries(c.stream.events)) {
              if (typeof ref !== 'string')
                fail(
                  'config/operations/' +
                    pointerSegment(op.operationId) +
                    '/stream/events/' +
                    pointerSegment(event),
                  'expected a local schema reference',
                );
              collect({ $ref: ref }, resolve(definitionPath), 'schema');
              events[event] = deref(
                { $ref: ref },
                resolve(definitionPath),
                p + '/stream/events/' + pointerSegment(event),
                [],
                'schema',
              );
            }
            streamSchemas.set(op.operationId, events);
          }
          return [verb, deref(op, file, p, [], 'operation', field.sourcePath)];
        });
      const parameters = own(fields, 'parameters');
      if (selectedAny && parameters) {
        collect(parameters.value, parameters.file, 'parameter');
        entries.push([
          'parameters',
          deref(
            parameters.value,
            parameters.file,
            '/paths/' + pointerSegment(path) + '/parameters',
            [],
            'parameter',
            parameters.sourcePath,
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
      const base = '/webhooks/' + pointerSegment(key);
      const fields = pathFields(item, resolve(definitionPath), base);
      for (const [method, field] of Object.entries(fields)) {
        if (
          ['parameters', 'summary', 'description', 'servers'].includes(method) ||
          method.startsWith('x-')
        )
          continue;
        if (!['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(method))
          fail(base + '/' + pointerSegment(method), 'unsupported incoming method');
        collect(field.value, field.file, 'operation');
        const location = base + '/' + pointerSegment(method);
        const op = deref(field.value, field.file, location, [], 'operation', field.sourcePath);
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
                .map((ref) => publicModel(ref.model)),
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
  let defaultBaseUrl: string | undefined;
  if (doc.servers !== undefined) {
    if (!Array.isArray(doc.servers)) fail('/servers', 'expected an array of servers');
    for (const [index, server] of doc.servers.entries()) {
      const path = `/servers/${index}`;
      record(server, path);
      if (!isDefaultBaseUrl(server.url))
        fail(
          path + '/url',
          'expected an absolute HTTP/HTTPS URL without credentials, query, fragment or template variables',
        );
      if (index === 0) defaultBaseUrl = server.url;
    }
  }
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
      fail(`/${forbidden}`, 'declare supported webhooks in the SDK configuration');
  const models: Record<string, Schema> = {};
  for (const [original, value] of Object.entries(doc.components?.schemas ?? {}) as [
    string,
    Schema,
  ][]) {
    try {
      const mapped = publicModel(original);
      modelName(mapped, `models/${pointerSegment(original)}`, config.targets);
      if (Object.keys(models).some((k) => k.toLowerCase() === mapped.toLowerCase()))
        fail(`models/${pointerSegment(original)}`, 'model name collision');
      schema(
        value,
        `/components/schemas/${pointerSegment(original)}`,
        raw.openapi.startsWith('3.0.'),
        config.numericUnions === 'explicit',
      );
      models[mapped] = value;
    } catch (error) {
      diagnostics.capture(error);
    }
  }
  for (const k of Object.keys(config.models ?? {}))
    if (!Object.hasOwn(raw.components?.schemas ?? {}, k))
      diagnostics.check(() =>
        fail(`config/models/${pointerSegment(k)}`, 'stale model customization'),
      );
  diagnostics.finish();
  const definitions: Record<string, Schema> = {};
  for (const [mapped, key] of cycles) {
    modelName(mapped, 'definitions/' + pointerSegment(mapped), config.targets);
    if (
      !key.startsWith(resolve(definitionPath) + '#/components/schemas/') &&
      Object.hasOwn(models, mapped)
    )
      fail(
        'definitions/' + pointerSegment(mapped),
        'generated external model name collides with an existing model',
      );
    const value = models[mapped] ?? resolved.get('schema:' + key)?.value;
    if (!value) fail('definitions/' + pointerSegment(mapped), 'unresolved recursive model');
    schema(
      value,
      'definitions/' + pointerSegment(mapped),
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
  const apiKeyNames = new Set<string>();
  for (const declaration of Object.values(schemes)) {
    if (!declaration || typeof declaration !== 'object') continue;
    const name: unknown = Reflect.get(declaration, 'name');
    if (Reflect.get(declaration, 'type') === 'apiKey' && typeof name === 'string')
      apiKeyNames.add(name.toLowerCase());
  }
  const compileScheme = (key: string, path = 'config/auth/scheme'): Auth & { name: string } => {
    if (!Object.hasOwn(schemes, key))
      fail(
        path,
        `select an existing security scheme.${suggestion(key, Object.keys(schemes))} Candidates: ${Object.keys(schemes).join(', ') || '(none)'}`,
      );
    const declaration = schemes[key];
    if (declaration.type === 'http' && declaration.scheme === 'bearer')
      return { name: key, type: 'bearer', header: 'Authorization' };
    if (declaration.type === 'apiKey' && declaration.in === 'header') {
      header(declaration.name, '/components/securitySchemes/' + pointerSegment(key) + '/name');
      return { name: key, type: 'apiKey', header: declaration.name };
    }
    return fail(
      '/components/securitySchemes/' + pointerSegment(key),
      `unsupported security scheme; supported authentication is HTTP bearer or a header API key. OAuth2 and HTTP basic declarations are unsupported. Select a supported scheme in config/auth, or exclude operations requiring this scheme with include or hidden; do not relabel credentials unless the provider supports that wire contract.`,
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
    keys(namedAuth, ['modes', 'shortcuts', 'defaultCredentials'], 'config/auth');
    record(namedAuth.modes, 'config/auth/modes');
    if (!Object.keys(namedAuth.modes).length)
      fail('config/auth/modes', 'declare at least one authentication mode');
    authentication = Object.create(null);
    for (const [mode, settings] of Object.entries(namedAuth.modes)) {
      name(mode, 'config/auth/modes/' + pointerSegment(mode));
      keys(settings, ['schemes', 'operations'], 'config/auth/modes/' + pointerSegment(mode));
      strings(settings.schemes, 'config/auth/modes/' + pointerSegment(mode) + '/schemes');
      if (!settings.schemes.length)
        fail('config/auth/modes/' + pointerSegment(mode), 'a mode requires a complete scheme set');
      if (settings.operations !== undefined)
        strings(settings.operations, 'config/auth/modes/' + pointerSegment(mode) + '/operations');
      const compiled = settings.schemes.map((key, index) =>
        compileScheme(key, 'config/auth/modes/' + pointerSegment(mode) + '/schemes/' + index),
      );
      if (new Set(compiled.map((scheme) => scheme.header.toLowerCase())).size !== compiled.length)
        fail(
          'config/auth/modes/' + pointerSegment(mode),
          'combined schemes have conflicting header destinations',
        );
      authentication![mode] = {
        schemes: compiled,
        ...(settings.operations ? { operations: settings.operations } : {}),
      };
    }
    if (namedAuth.shortcuts !== undefined) {
      record(namedAuth.shortcuts, 'config/auth/shortcuts');
      for (const [key, shortcut] of Object.entries(namedAuth.shortcuts)) {
        const path = 'config/auth/shortcuts/' + pointerSegment(key);
        if (!isAuthShortcutName(key))
          fail(
            path,
            'shortcut name must be a portable option name that does not collide with existing options',
          );
        record(shortcut, path);
        keys(shortcut, ['mode', 'scheme'], path);
        const mode = authentication![shortcut.mode];
        if (
          typeof shortcut.mode !== 'string' ||
          typeof shortcut.scheme !== 'string' ||
          !mode ||
          mode.schemes.length !== 1 ||
          mode.schemes[0]!.name !== shortcut.scheme
        )
          fail(path, 'shortcut must target the sole scheme of a declared authentication mode');
      }
    }
    if (namedAuth.defaultCredentials !== undefined) {
      try {
        assertDefaultCredentials(namedAuth.defaultCredentials, authentication);
      } catch (error) {
        fail(
          'config/auth/defaultCredentials',
          error instanceof Error ? error.message : 'invalid declaration',
        );
      }
    }
  } else {
    if (config.auth) {
      keys(config.auth, ['scheme'], 'config/auth');
      if (typeof selectedScheme !== 'string' || !Object.hasOwn(schemes, selectedScheme))
        fail(
          'config/auth/scheme',
          `select an existing security scheme.${suggestion(String(selectedScheme), Object.keys(schemes))} Candidates: ${Object.keys(schemes).join(', ')}`,
        );
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
  const referenceUrls: Record<string, string> = {};
  const ids = new Set<string>();
  const publicNames = new Set<string>();
  const pathNames = avoidPathHelperCollisions(
    config.operationNames === 'path'
      ? Object.entries(doc.paths ?? {}).flatMap(([path, item]) =>
          Object.entries(item && typeof item === 'object' ? item : {}).flatMap(([verb, value]) => {
            if (
              !['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(verb) ||
              !value ||
              typeof value !== 'object'
            )
              return [];
            const id = Reflect.get(value, 'operationId');
            if (typeof id !== 'string' || !id) return [];
            const c = own(config.operations, id) ?? {};
            if (
              c.hidden ||
              (config.include && !config.include.includes(id)) ||
              (config.audiences &&
                (!Array.isArray(c.audiences) ||
                  !c.audiences.some((a) => config.audiences?.includes(a))))
            )
              return [];
            if (
              (c.resource !== undefined && typeof c.resource !== 'string') ||
              (c.method !== undefined && typeof c.method !== 'string')
            )
              return [];
            const inferred = pathOperationNames(id, path);
            return [
              {
                id,
                resource: c.resource ?? inferred.resource,
                method: c.method ?? inferred.method,
                explicit: c.method !== undefined,
                pagination:
                  c.pagination === false ? false : !!(c.pagination ?? config.defaults?.pagination),
              },
            ];
          }),
        )
      : [],
  );
  for (const [path, item] of Object.entries(doc.paths ?? {}) as [string, any][]) {
    if (
      !diagnostics.check(() => {
        if (!path.startsWith('/') || path.startsWith('//') || /[\\\s?#]/.test(path))
          fail(
            `/paths/${pointerSegment(path)}`,
            'expected an absolute API path without query or fragment',
          );
      })
    )
      continue;
    for (const [verb, op] of Object.entries(item) as [string, any][]) {
      if (['parameters', 'summary', 'description'].includes(verb)) continue;
      try {
        if (!['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(verb))
          fail(
            `/paths/${pointerSegment(path)}/${pointerSegment(verb)}`,
            'unsupported path construct',
          );
        const p = `/paths/${pointerSegment(path)}/${pointerSegment(verb)}`;
        record(op, p);
        const id = op.operationId;
        if (typeof id !== 'string' || !id) {
          if (config.include) continue;
          fail(
            p,
            'operationId must be a nonempty string; add an operationId to the source or select named operations with include (hidden and audiences settings require an operationId)',
          );
        }
        if (ids.has(id)) fail(p, 'operationId must be unique');
        ids.add(id);
        const cp = `config/operations/${pointerSegment(id)}`;
        const local = own(config.operations, id) ?? {};
        const {
          idempotency: _idempotency,
          retry: _retry,
          pagination: _pagination,
          ...metadata
        } = local;
        const c: Capability = { ...metadata };
        const capabilityPath = (key: 'idempotency' | 'retry' | 'pagination', field?: string) =>
          Object.hasOwn(local, key) && (!field || (local[key] && Object.hasOwn(local[key], field)))
            ? cp + '/' + key
            : 'config/defaults/' + key;
        for (const key of ['idempotency', 'retry', 'pagination'] as const) {
          const configured: unknown = local[key];
          const fallback = config.defaults?.[key];
          if (configured === false) delete c[key];
          else if (configured !== undefined || fallback !== undefined) {
            if (configured !== undefined) {
              record(configured, cp + '/' + key);
              keys(configured, capabilityFields[key], cp + '/' + key);
            }
            if (fallback !== undefined) record(fallback, 'config/defaults/' + key);
            // Defaults are shallow field defaults; arrays and per-operation fields replace them.
            const merged = { ...fallback, ...configured };
            for (const field of Object.keys(merged))
              if (Reflect.get(merged, field) === null) Reflect.deleteProperty(merged, field);
            Object.assign(c, { [key]: merged });
          }
        }
        keys(
          c,
          [
            'defaults',
            'request',
            'response',
            'resource',
            'method',
            'namingReason',
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
          `config/operations/${pointerSegment(id)}`,
        );
        if (c.defaults !== undefined) {
          keys(c.defaults, ['timeoutMs', 'deadlineMs'], cp + '/defaults');
          if (!Object.keys(c.defaults).length)
            fail(cp + '/defaults', 'requires timeoutMs or deadlineMs');
          for (const [name, value] of Object.entries(c.defaults))
            if (!Number.isSafeInteger(value) || value <= 0)
              fail(cp + '/defaults/' + name, 'expected a positive safe integer');
        }
        if (c.request !== undefined)
          validateRequestStyle(c.request, `config/operations/${pointerSegment(id)}/request`);
        if (c.request?.style === 'object')
          fail(
            cp + '/request/style',
            'per-operation object requests are no longer supported; use positional path IDs and flat params',
          );
        const requestStyle =
          c.request?.style ??
          (invalidConfig.has('requests') ? undefined : config.requests?.style) ??
          'positional';
        if (c.response !== undefined)
          validateResponseReturn(c.response, `config/operations/${pointerSegment(id)}/response`);
        const responseReturn: ResponseReturn = {
          return: 'payload',
          ...(invalidConfig.has('responses') ? {} : config.responses),
          ...c.response,
        };
        const payloadReturn = responseReturn.return === 'payload';
        if (!payloadReturn && c.response?.payloadPath != null)
          fail(
            `config/operations/${pointerSegment(id)}/response`,
            'payloadPath requires return: payload',
          );
        for (const key of ['aliases', 'audiences'] as const)
          if (c[key] !== undefined)
            strings(c[key], `config/operations/${pointerSegment(id)}/${key}`);
        if (c.hidden !== undefined && typeof c.hidden !== 'boolean')
          fail(cp + '/hidden', 'hidden must be boolean');
        if (c.requestMediaType !== undefined && typeof c.requestMediaType !== 'string')
          fail(
            `config/operations/${pointerSegment(id)}/requestMediaType`,
            'expected a media type string',
          );
        if (c.requestMediaType !== undefined && op.requestBody === undefined)
          fail(
            `config/operations/${pointerSegment(id)}/requestMediaType`,
            'operation has no request body',
          );
        if (c.stream) {
          keys(
            c.stream,
            ['events', 'idleTimeoutMs', 'maxEventBytes'],
            `config/operations/${pointerSegment(id)}/stream`,
          );
          for (const key of ['idleTimeoutMs', 'maxEventBytes'] as const)
            if (
              c.stream[key] !== undefined &&
              (!Number.isSafeInteger(c.stream[key]) || c.stream[key]! <= 0)
            )
              fail(
                `config/operations/${pointerSegment(id)}/stream/${key}`,
                'expected a positive safe integer',
              );
        }
        if (
          c.deprecated !== undefined &&
          (typeof c.deprecated !== 'string' || !c.deprecated.trim())
        )
          fail(cp + '/deprecated', 'deprecated must be a nonempty migration message');
        if (op.deprecated !== undefined && typeof op.deprecated !== 'boolean')
          fail(p, 'OpenAPI deprecated must be boolean');
        if (
          c.hidden ||
          (config.include && !config.include.includes(id)) ||
          (config.audiences && !c.audiences?.some((a) => config.audiences!.includes(a)))
        )
          continue;
        if (
          c.namingReason !== undefined &&
          (typeof c.namingReason !== 'string' || !c.namingReason.trim())
        )
          fail(cp + '/namingReason', 'namingReason must be a nonempty explanation');
        const inferred =
          config.operationNames === 'path'
            ? pathOperationNames(id, path)
            : operationNames(id, op.tags);
        const resource = c.resource ?? inferred.resource;
        const method = c.method ?? pathNames.get(id)?.method ?? inferred.method;
        if (config.operationNames === 'path' && !c.namingReason) {
          if (c.resource !== undefined || c.method !== undefined)
            fail(cp + '/namingReason', 'explicit path-based operation names require namingReason');
          if (!operationVerbOccurs(method, id))
            fail(cp + '/method', 'method verb must occur in operationId or have a namingReason');
        }
        name(resource, c.resource !== undefined ? cp + '/resource' : p + '/operationId');
        try {
          name(method, c.method !== undefined ? cp + '/method' : p + '/operationId', true);
        } catch (error) {
          if (error instanceof Diagnostic && c.method === undefined)
            fail(
              p + '/operationId',
              error.detail +
                `; configure ${cp}/resource and ${cp}/method to choose portable public names`,
            );
          throw error;
        }
        if (
          config.operationNames !== 'path' &&
          inferred.resource === 'api' &&
          c.method === undefined
        )
          options.onWarning?.(
            new Diagnostic(
              p + '/operationId',
              `inferred ${resource}.${method}: ${operationNamingReason(id, op.tags)}; configure ${cp}/resource and ${cp}/method to choose the public name`,
            ),
          );
        const spelling = resourceSpellings.get(resource.toLowerCase());
        if (spelling && spelling !== resource)
          fail(p, 'resource names collide case-insensitively in PHP');
        resourceSpellings.set(resource.toLowerCase(), resource);
        const allNames = [
          method,
          ...(c.aliases ?? []),
          ...(payloadReturn ? [method, ...(c.aliases ?? [])].map((n) => n + 'WithResponse') : []),
          ...(c.pagination ? [method + 'Pages', method + 'Items'] : []),
          ...(c.polling ? [method + 'Wait'] : []),
          ...(payloadReturn && c.pagination ? [method + 'PagesWithResponse'] : []),
          ...(payloadReturn && c.polling ? [method + 'WaitWithResponse'] : []),
        ];
        for (const n of allNames) {
          name(n, cp + (n === method ? '/method' : '/aliases'), true);
          const key = `${resource}.${n}`.toLowerCase();
          if (publicNames.has(key))
            fail(
              p,
              `public method collision: ${key}; configure ${cp}/resource, ${cp}/method or ${cp}/aliases to use distinct names`,
            );
          publicNames.add(key);
        }
        for (const forbidden of ['callbacks', 'servers'])
          if (op[forbidden] !== undefined)
            fail(`${p}/${forbidden}`, 'unsupported operation construct');
        if (item.servers !== undefined)
          fail(
            `/paths/${pointerSegment(path)}/servers`,
            'path-level servers are unsupported; declare a top-level server or pass baseUrl',
          );
        const params = new Map<string, Parameter>();
        for (const list of [item.parameters, op.parameters])
          if (list !== undefined && !Array.isArray(list)) fail(p, 'parameters must be an array');
        const declaredParameters: { param: Parameter; location: string }[] = [
          ...(item.parameters ?? []).map((param: Parameter, index: number) => ({
            param,
            location: `/paths/${pointerSegment(path)}/parameters/${index}`,
          })),
          ...(op.parameters ?? []).map((param: Parameter, index: number) => ({
            param,
            location: `${p}/parameters/${index}`,
          })),
        ];
        for (const { param, location } of declaredParameters) {
          record(param, p + '/parameters');
          if (typeof param.name !== 'string' || !param.name)
            fail(p, 'parameters require nonempty names');
          for (const key of ['required', 'explode'] as const)
            if (param[key] !== undefined && typeof param[key] !== 'boolean')
              fail(p, `parameter ${key} must be boolean`);
          if (!['path', 'query', 'header'].includes(param.in))
            fail(p, 'supported parameter locations: path, query, header');
          if (param['x-flint-request-option'] !== undefined) {
            requestOption(
              param['x-flint-request-option'],
              p + '/parameters/' + pointerSegment(param.name),
            );
            if (param.in !== 'header' || param.required)
              fail(p, 'x-flint-request-option requires an optional header parameter');
          }
          if (param.in === 'header') header(param.name, p);
          if (param.in === 'path' && !param.required)
            fail(p, `path parameter ${param.name} must be required`);
          if (['body', '__proto__', 'constructor', 'prototype'].includes(param.name))
            fail(p, `parameter name ${param.name} conflicts with SDK input`);
          schema(
            param.schema,
            location + '/schema',
            raw.openapi.startsWith('3.0.'),
            config.numericUnions === 'explicit',
          );
          parameterType(param.schema, location + '/schema');
          // Reject unsafe parameter metadata before it can enter descriptors or
          // examples. Include every declared API-key name, even unselected schemes
          // and schemes in locations unsupported by authentication compilation.
          if (!parameterExampleEligible(param, definitions, apiKeyNames)) {
            Reflect.deleteProperty(param, 'example');
            Reflect.deleteProperty(param, 'examples');
          }
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
            `selected authentication scheme ${selectedScheme ?? '(none)'} is not a complete supported alternative for this operation. Configure config/auth with a complete declared scheme set. Bearer/API-key requirements must use empty scope arrays; OAuth scopes are unsupported. Available schemes: ${Object.keys(schemes).join(', ') || '(none)'}`,
          );
        let body: Schema | undefined;
        let mediaType: string | undefined;
        if (op.requestBody !== undefined) {
          if (
            ['get', 'head'].includes(verb) &&
            (config.targets ?? ['node', 'php']).includes('node')
          )
            fail(
              p + '/requestBody',
              'GET/HEAD request bodies are unsupported by the Node transport',
            );
          record(op.requestBody, p + '/requestBody');
          if (op.requestBody.required !== undefined && typeof op.requestBody.required !== 'boolean')
            fail(p, 'requestBody.required must be boolean');
          record(op.requestBody.content, p + '/requestBody/content');
          const supported = ['application/json', 'application/merge-patch+json'];
          if (!Object.keys(op.requestBody.content).some((media) => supported.includes(media)))
            fail(
              p + '/requestBody/content',
              `requestBody declares no supported media type; supported types are ${supported.join(' and ')}; exclude this operation with include or operations.${id}.hidden`,
            );
          if (
            c.requestMediaType !== undefined &&
            !Object.hasOwn(op.requestBody.content, c.requestMediaType)
          )
            fail(
              `config/operations/${pointerSegment(id)}/requestMediaType`,
              'selected media type is not declared',
            );
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
              `unsupported request media type ${media}; select application/json or application/merge-patch+json using operations.${id}.requestMediaType, or exclude this operation with include or hidden`,
            );
          schema(
            content.schema,
            `${p}/requestBody/content/${pointerSegment(media)}/schema`,
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
          record(response, p + '/responses/' + pointerSegment(status));
          if (response.content !== undefined)
            record(response.content, p + '/responses/' + pointerSegment(status) + '/content');
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
              record(location, p + '/responses/' + pointerSegment(status) + '/headers/Location');
              r.locationRequired = location.required === true;
            }
          }
          if (contents.length) {
            const [media, value] = contents[0]! as [string, any];
            record(
              value,
              p + '/responses/' + pointerSegment(status) + '/content/' + pointerSegment(media),
            );
            if (['application/pdf', 'text/event-stream'].includes(media) && successStatus(status)) {
              r.bodyKind = media === 'application/pdf' ? 'binary' : 'sse';
            } else {
              if (media !== 'application/json')
                fail(
                  p + '/responses/' + pointerSegment(status) + '/content/' + pointerSegment(media),
                  `unsupported response media type ${media}; declare application/json, a successful application/pdf or text/event-stream response, or exclude this operation with include or operations.${id}.hidden`,
                );
              schema(
                value.schema,
                `${p}/responses/${pointerSegment(status)}/content/${pointerSegment(media)}/schema`,
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
            `${p}/stream/events/${pointerSegment(event)}`,
            false,
            config.numericUnions === 'explicit',
          );
        if (c.stream && !Object.values(responses).some((response) => response.bodyKind === 'sse'))
          fail(`config/operations/${pointerSegment(id)}/stream`, 'operation has no SSE response');
        if (!Object.keys(responses).some((k) => successStatus(k) && k !== '304'))
          fail(
            p + '/responses',
            'declare at least one explicit numeric 2xx success response; default is supported only alongside an explicit success response. Correct the specification or exclude this operation with include or hidden',
          );
        if (c.idempotency) {
          keys(
            c.idempotency,
            ['header', 'retention', 'scope', 'auto', 'autoKeyPrefix'],
            capabilityPath('idempotency'),
          );
          header(c.idempotency.header, capabilityPath('idempotency', 'header') + '/header');
          const candidates = parameters
            .filter((parameter) => parameter.in === 'header')
            .map((parameter) => parameter.name);
          if (
            !candidates.some(
              (candidate) => candidate.toLowerCase() === c.idempotency!.header.toLowerCase(),
            )
          )
            options.onWarning?.(
              new Diagnostic(
                capabilityPath('idempotency', 'header') + '/header',
                `header is not declared by this operation.${suggestion(c.idempotency.header, candidates)} Declared request headers: ${candidates.join(', ') || '(none)'}. Check the spelling or add the provider's header declaration to the specification.`,
              ),
            );
          if (
            typeof c.idempotency.retention !== 'string' ||
            !c.idempotency.retention.trim() ||
            typeof c.idempotency.scope !== 'string' ||
            !c.idempotency.scope.trim()
          )
            fail(
              capabilityPath('idempotency'),
              'idempotency requires server retention and scope descriptions',
            );
          if (c.idempotency.auto !== undefined && typeof c.idempotency.auto !== 'boolean')
            fail(capabilityPath('idempotency'), 'idempotency auto must be boolean');
          if (
            c.idempotency.autoKeyPrefix !== undefined &&
            (typeof c.idempotency.autoKeyPrefix !== 'string' ||
              /[^\x20-\x7e]/.test(c.idempotency.autoKeyPrefix) ||
              /^[ ]/.test(c.idempotency.autoKeyPrefix))
          )
            fail(
              capabilityPath('idempotency'),
              'idempotency autoKeyPrefix plus UUID must be a valid HTTP header value',
            );
        }
        if (c.retry) {
          keys(
            c.retry,
            ['maxAttempts', 'statuses', 'errors', 'transport', 'baseDelayMs', 'maxDelayMs'],
            capabilityPath('retry'),
          );
          if (
            !Number.isInteger(c.retry.maxAttempts) ||
            c.retry.maxAttempts < 1 ||
            c.retry.maxAttempts > 10 ||
            !Number.isFinite(c.retry.baseDelayMs) ||
            c.retry.baseDelayMs < 0 ||
            (c.retry.maxDelayMs !== undefined &&
              (!Number.isFinite(c.retry.maxDelayMs) || c.retry.maxDelayMs < 0)) ||
            !Array.isArray(c.retry.statuses) ||
            c.retry.statuses.some(
              (s) => !Number.isInteger(s) || s < 400 || s > 599 || [409, 412].includes(s),
            ) ||
            typeof c.retry.transport !== 'boolean'
          )
            fail(
              capabilityPath('retry'),
              'retry requires 1–10 attempts, nonnegative delay, explicit statuses (excluding conflicts), and transport boolean',
            );
          if (
            c.retry.maxAttempts > 1 &&
            !['get', 'head', 'options'].includes(verb) &&
            !c.idempotency
          )
            fail(
              capabilityPath('retry'),
              'mutation retries require a declared idempotency contract',
            );
          if (c.retry.errors !== undefined) {
            if (!Array.isArray(c.retry.errors))
              fail(capabilityPath('retry'), 'retry.errors must be an array');
            for (const rule of c.retry.errors) {
              keys(rule, ['status', 'codes'], capabilityPath('retry'));
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
                  capabilityPath('retry'),
                  'retry.errors requires an HTTP error status other than 412 and explicit nonempty codes',
                );
              if (rule.status === 409 && (!c.idempotency || c.conditional))
                fail(
                  capabilityPath('retry'),
                  'retrying a specific 409 code requires idempotency and cannot retry conditional updates',
                );
            }
          }
        }
        if (c.pagination) {
          const pg = c.pagination;
          const queryParameters = parameters
            .filter((parameter) => parameter.in === 'query')
            .map((parameter) => parameter.name);
          if (pg.kind !== 'link' && !queryParameters.includes(pg.parameter ?? ''))
            fail(
              capabilityPath('pagination', 'parameter') + '/parameter',
              `select a declared query parameter.${suggestion(pg.parameter ?? '', queryParameters)} Candidates: ${queryParameters.join(', ') || '(none)'}`,
            );
          keys(pg, ['kind', 'items', 'next', 'parameter'], capabilityPath('pagination'));
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
              capabilityPath('pagination'),
              'pagination requires item/continuation fields and a declared query parameter (except links)',
            );
          if (verb !== 'get') fail(capabilityPath('pagination'), 'pagination helpers require GET');
          const parameter = parameters.find((v) => v.in === 'query' && v.name === pg.parameter);
          const nextType = pg.kind === 'offset' ? 'integer' : 'string';
          if (pg.kind !== 'link' && parameter && parameterType(parameter.schema, p) !== nextType)
            fail(
              capabilityPath('pagination'),
              `${pg.kind} pagination requires a scalar ${nextType} query parameter`,
            );
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
                capabilityPath('pagination'),
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
                capabilityPath('pagination'),
                'offset pagination returns exact integer strings but its query parameter requires a native integer; use compatible integer formats or omit the pagination helper',
              );
          }
        }
        if (c.polling) {
          keys(c.polling, ['state', 'success', 'failure', 'intervalMs'], cp + '/polling');
          strings(c.polling.success, cp + '/polling/success');
          strings(c.polling.failure, cp + '/polling/failure');
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
            fail(
              cp + '/polling',
              'polling requires GET, distinct terminal states, and positive intervalMs',
            );
          for (const [, response] of Object.entries(responses).filter(([status]) =>
            /^2\d\d$/.test(status),
          )) {
            const states = schemaField(response.schema, c.polling.state);
            if (!states || !hasType(states, 'string'))
              fail(cp + '/polling', 'polling state must address a declared string response field');
          }
        }
        if (c.conditional) {
          keys(c.conditional, ['header'], cp + '/conditional');
          header(c.conditional.header, cp + '/conditional' + '/header');
          const candidates = parameters
            .filter((parameter) => parameter.in === 'header')
            .map((parameter) => parameter.name);
          if (
            !candidates.some(
              (candidate) => candidate.toLowerCase() === c.conditional!.header.toLowerCase(),
            )
          )
            options.onWarning?.(
              new Diagnostic(
                cp + '/conditional' + '/header',
                `header is not declared by this operation.${suggestion(c.conditional.header, candidates)} Declared request headers: ${candidates.join(', ') || '(none)'}. Check the spelling or add the provider's header declaration to the specification.`,
              ),
            );
        }
        const operation: Operation = {
          ...c,
          ...(requestStyle === 'positional' ? { request: { style: 'positional' as const } } : {}),
          ...(payloadReturn ? { response: responseReturn } : {}),
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
        };
        if (!payloadReturn) delete operation.response;
        if (payloadReturn && responseReturn.payloadPath) payloadSchemas(operation);
        if (requestStyle !== 'positional') delete operation.request;
        validatePositional(operation, definitions);
        const urlTemplate = config.documentation?.operationUrl;
        if (typeof urlTemplate === 'string')
          referenceUrls[id] = referenceUrl(
            urlTemplate,
            id,
            op.tags,
            config.documentation!.tagSlugs,
            p,
          );
        operations.push(operation);
      } catch (error) {
        diagnostics.capture(error);
      }
    }
  }
  diagnostics.finish();
  operations.sort((a, b) => a.id.localeCompare(b.id, 'en'));
  for (const id of [...Object.keys(config.operations ?? {}), ...(config.include ?? [])])
    if (!ids.has(id))
      fail(
        `config/operations/${pointerSegment(id)}`,
        `operation ID "${id}" is not in the contract.${suggestion(id, [...ids])}`,
      );
  if (!operations.length) fail('/paths', 'selection contains no operations');
  for (const [mode, settings] of Object.entries(authentication ?? {}))
    for (const id of settings.operations ?? [])
      if (!ids.has(id))
        fail(
          'config/auth/modes/' + pointerSegment(mode) + '/operations',
          'unknown operation binding ' + id + '.' + suggestion(id, [...ids]),
        );
  if (config.webhook) {
    const w = config.webhook;
    keys(
      w,
      [
        'jwt',
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
    if (typeof w.typeField !== 'string' || !w.typeField)
      fail('config/webhook/typeField', 'declare a nonempty typeField');
    if (w.jwt !== undefined) {
      const j = w.jwt;
      keys(
        j,
        [
          'header',
          'scheme',
          'algorithm',
          'typ',
          'issuer',
          'jwksPath',
          'bodyHashClaim',
          'bodyHashEncoding',
          'lifetimeSeconds',
          'leewaySeconds',
        ],
        'config/webhook/jwt',
      );
      const issue = webhookJwtIssue(j);
      if (issue) fail('config/webhook/jwt' + (issue.field ? '/' + issue.field : ''), issue.message);
    }
    const hmacFields = [
      'algorithm',
      'format',
      'idHeader',
      'header',
      'timestampHeader',
      'separator',
      'toleranceSeconds',
    ] as const;
    if (!w.jwt || hmacFields.some((name) => w[name] !== undefined)) {
      if (w.algorithm !== 'hmac-sha256')
        fail(
          'config/webhook/algorithm',
          'unsupported signing algorithm ' + String(w.algorithm) + '; expected hmac-sha256',
        );
      if (
        typeof w.toleranceSeconds !== 'number' ||
        !Number.isFinite(w.toleranceSeconds) ||
        w.toleranceSeconds < 0 ||
        typeof w.separator !== 'string'
      )
        fail('config/webhook', 'declare a literal separator and nonnegative toleranceSeconds');
      header(w.header, 'config/webhook/header');
      if (w.format !== 'timestamped-hex')
        header(w.timestampHeader, 'config/webhook/timestampHeader');
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
    }
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
    const eventNames = new Map<string, string>();
    for (const [k, v] of Object.entries(w.events)) {
      const path = `config/webhook/events/${pointerSegment(k)}`;
      if (!/[A-Za-z0-9]/.test(k))
        fail(path, 'webhook event name must contain ASCII letters or digits');
      const name = webhookEventTypeName(k);
      const previous = eventNames.get(name.toLowerCase());
      if (previous !== undefined)
        fail(path, `webhook event type name \`${name}\` is shared by \`${previous}\` and \`${k}\``);
      eventNames.set(name.toLowerCase(), k);
      schema(v, path, false, config.numericUnions === 'explicit');
    }
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
  const warnHeader = (
    value: string | undefined,
    path: string,
    candidates: string[],
    direction: string,
  ) => {
    if (
      value !== undefined &&
      !candidates.some((candidate) => candidate.toLowerCase() === value.toLowerCase())
    )
      options.onWarning?.(
        new Diagnostic(
          path,
          `header is not declared in the selected ${direction} contract.${suggestion(value, candidates)} Declared headers: ${[...new Set(candidates)].sort().join(', ') || '(none)'}. Check the spelling or add the provider's header declaration to the specification.`,
        ),
      );
  };
  const requestHeaders = operations.flatMap((op) =>
    op.parameters
      .filter((parameter) => parameter.in === 'header')
      .map((parameter) => parameter.name),
  );
  const responseHeaders = Object.values(doc.paths).flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    return Object.values(item).flatMap((op) => {
      if (
        !op ||
        typeof op !== 'object' ||
        !('responses' in op) ||
        !op.responses ||
        typeof op.responses !== 'object'
      )
        return [];
      return Object.values(op.responses).flatMap((response) =>
        response &&
        typeof response === 'object' &&
        'headers' in response &&
        response.headers &&
        typeof response.headers === 'object'
          ? Object.keys(response.headers)
          : [],
      );
    });
  });
  const incomingHeaders = Object.values(doc.webhooks ?? {}).flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const lists: unknown[] = ['parameters' in item ? item.parameters : undefined];
    for (const verb of ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']) {
      const operation: unknown = Reflect.get(item, verb);
      if (operation && typeof operation === 'object' && 'parameters' in operation)
        lists.push(operation.parameters);
    }
    return lists.flatMap((list) =>
      Array.isArray(list)
        ? list.flatMap((parameter: unknown) =>
            parameter &&
            typeof parameter === 'object' &&
            'in' in parameter &&
            parameter.in === 'header' &&
            'name' in parameter &&
            typeof parameter.name === 'string'
              ? [parameter.name]
              : [],
          )
        : [],
    );
  });
  for (const field of ['header', 'timestampHeader', 'idHeader'] as const)
    warnHeader(
      config.webhook?.[field],
      'config/webhook/' + field,
      incomingHeaders,
      'incoming webhook',
    );
  warnHeader(config.apiVersion?.header, 'config/apiVersion/header', requestHeaders, 'request');
  warnHeader(
    config.errors?.requestIdHeader,
    'config/errors/requestIdHeader',
    responseHeaders,
    'response',
  );
  // Index operation reference prefixes once. Large exports can contain millions
  // of reference occurrences; rescanning them for every operation is quadratic.
  type ReferencePrefix = { children: Map<string, ReferencePrefix>; models?: Set<string> };
  const referenceRoot: ReferencePrefix = { children: new Map() };
  const dependencyPrefixes = new Map<string, Set<string>>();
  for (const op of operations) {
    for (const prefix of [
      `/paths/${pointerSegment(op.path)}/${op.verb.toLowerCase()}/`,
      `/paths/${pointerSegment(op.path)}/parameters/`,
    ]) {
      if (dependencyPrefixes.has(prefix)) continue;
      let node = referenceRoot;
      for (const char of prefix) {
        let child = node.children.get(char);
        if (!child) {
          child = { children: new Map() };
          node.children.set(char, child);
        }
        node = child;
      }
      node.models = new Set();
      dependencyPrefixes.set(prefix, node.models);
    }
  }
  // Source paths survive dereferencing and validation's composition inlining.
  // Only explicit response uses count as proof; ambiguous and incoming uses
  // keep full input rules. Cached references include their transitive models.
  const responseModels = new Set<string>();
  const inputModels = new Set<string>();
  for (const ref of references) {
    const name = publicModel(ref.model);
    const use = /^\/paths\/[^/]+\/([^/]+)(?:\/(.*))?$/.exec(ref.path);
    if (use) {
      const response =
        use[1] !== 'parameters' &&
        (use[2]?.startsWith('responses/') || use[2]?.startsWith('stream/events/'));
      (response ? responseModels : inputModels).add(name);
    }
    if (ref.path.startsWith('/webhooks/')) inputModels.add(name);
    let node: ReferencePrefix | undefined = referenceRoot;
    for (const char of ref.path) {
      node = node.children.get(char);
      if (!node) break;
      node.models?.add(name);
    }
  }
  const contract: Contract = {
    ...(defaultBaseUrl !== undefined ? { defaultBaseUrl } : {}),
    ...(Object.keys(referenceUrls).length ? { referenceUrls } : {}),
    title: String(doc.info?.title ?? 'API'),
    apiVersion: config.apiVersion?.value ?? String(doc.info?.version ?? ''),
    operations,
    ...(incoming.length ? { incoming } : {}),
    models,
    ...(cycles.size ? { definitions } : {}),
    modelDependencies: Object.fromEntries(
      operations.map((op) => {
        const operationPath = `/paths/${pointerSegment(op.path)}/${op.verb.toLowerCase()}/`;
        const sharedParameters = `/paths/${pointerSegment(op.path)}/parameters/`;
        return [
          op.id,
          [
            ...new Set([
              ...dependencyPrefixes.get(operationPath)!,
              ...dependencyPrefixes.get(sharedParameters)!,
            ]),
          ].sort(),
        ];
      }),
    ),
    ...(authentication ? { authentication } : {}),
    ...(namedAuth?.shortcuts ? { authShortcuts: namedAuth.shortcuts } : {}),
    config,
    sources,
    hash: '',
  };
  if (auth) contract.auth = auth;
  // Resolution is finished. Do not retain expanded cached copies while the
  // owned contract is compacted and compiled.
  resolved.clear();
  // Operations now own the schemas they consume. Drop the temporary OpenAPI
  // paths before compaction replaces those schemas, so expanded response copies
  // are collectible instead of remaining rooted through doc.paths/selectedPaths.
  for (const path of Object.keys(selectedPaths)) delete selectedPaths[path];
  streamSchemas.clear();
  const responseOnly =
    config.schemaSharing === 'named'
      ? shareContractSchemas(
          contract,
          referenceNames,
          typeNames,
          new Set([...responseModels].filter((name) => !inputModels.has(name))),
        )
      : [];
  saveExampleProtection(contract, exampleProtection.locations);
  contract.hash = hash(stable(contract));
  // Compatibility proof is private metadata, not part of the emitted contract hash.
  contract.schemaUsage = {
    fingerprint: schemaUsageFingerprint(contract),
    responseOnlyModels: responseOnly,
  };
  return contract;
}
