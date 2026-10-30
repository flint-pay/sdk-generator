import { certifies, type TypeCertificate } from './type-certificate.js';
import type { RequestOptionValues } from './request-options.js';
import { DescriptorSource } from './descriptor-source.js';
import type { DefaultCredentials } from './contract.js';
import type { Transform } from 'node:stream';
import type { Schema } from './contract.js';
import {
  errorMapping,
  compileRuntimePlan,
  assertRuntimePlan,
  isBaseUrlSyntax,
  type RuntimeContract,
  type CompiledRuntimePlan,
} from './runtime-plan.js';
export type { RuntimeContract } from './runtime-plan.js';
export type { Operation, Schema } from './contract.js';
import { compileCodec, ANY_CODEC, exactValue, wireKind, type CodecPlan } from './codec-plan.js';
export { directionalSchema } from './codec-plan.js';

const inspectCustom = Symbol.for('nodejs.util.inspect.custom');

type InternalErrorKind =
  | 'transport'
  | 'timeout'
  | 'authentication'
  | 'validation'
  | 'rate_limit'
  | 'not_found'
  | 'server'
  | 'api'
  | 'conflict'
  | 'protocol'
  | 'cancelled'
  | 'deadline'
  | 'destination'
  | 'webhook';
export interface Metadata {
  status: number;
  headers: Record<string, string>;
  requestId?: string;
  idempotencyKey?: string;
  attempts: number;
  durationMs: number;
  url?: string;
  requestIds?: string[];
}
type AttemptObservation =
  | { state: 'not_sent' | 'no_answer' }
  | {
      state: 'answered';
      status: number;
      inProgress: boolean;
      uncertainWrite: boolean;
      retryAllowed: boolean;
    };
type ErrorCallContext = {
  observations: AttemptObservation[];
  replaySafe?: boolean;
  attempts: number;
  requestIds: string[];
  start: number;
  lastResponse?: Metadata;
  retryAfterMs?: number;
};
export interface Result<T> {
  data: T;
  meta: Metadata;
  raw: T extends Uint8Array ? Uint8Array : string;
}
function isErrorObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !(value instanceof ParsedNumber)
  );
}
const errorCauses = new WeakMap<SdkError, unknown>();
const publicErrorDetailsCertificate: TypeCertificate | undefined = undefined;

export interface SdkErrorInit {
  code?: string;
  param?: string;
  operation?: string;
  outcome?: 'unknown' | 'response' | 'not_sent';
  retryAllowed?: boolean;
  status?: number;
  requestId?: string;
  requestIds?: string[];
  idempotencyKey?: string;
  attempts?: number;
  durationMs?: number;
  retryAfterMs?: number;
  headers?: Record<string, string>;
  raw?: string;
  cause?: unknown;
}
export type ErrorRetry = 'same_request' | 'after_refresh' | 'none';
export interface ErrorRemediation {
  retry?: ErrorRetry;
  next_steps?: readonly string[];
  next_actions?: readonly unknown[];
  [key: string]: unknown;
}
export interface ApiErrorInit extends SdkErrorInit {
  details?: unknown;
  type?: string;
  errorSource?: string;
  docUrl?: string;
  requestLogUrl?: string;
  remediation?: ErrorRemediation;
  body?: unknown;
}
/** SDK failure with flattened call context. */
export class SdkError extends Error {
  code: string;
  param?: string;
  operation?: string;
  outcome: 'unknown' | 'response' | 'not_sent';
  retryAllowed: boolean;
  status?: number;
  requestId?: string;
  requestIds: string[];
  idempotencyKey?: string;
  attempts: number;
  durationMs?: number;
  retryAfterMs?: number;
  headers: Record<string, string>;
  raw?: string;
  constructor(message: string, init: SdkErrorInit = {}) {
    super(message);
    this.code = init.code ?? '';
    this.outcome = init.outcome ?? 'not_sent';
    this.retryAllowed = init.retryAllowed ?? false;
    this.requestIds = [...(init.requestIds ?? (init.requestId ? [init.requestId] : []))];
    this.attempts = init.attempts ?? 0;
    this.headers = init.headers ?? {};
    for (const key of [
      'param',
      'operation',
      'status',
      'requestId',
      'idempotencyKey',
      'durationMs',
      'retryAfterMs',
      'raw',
    ] as const)
      if (init[key] !== undefined)
        Object.defineProperty(this, key, {
          value: init[key],
          writable: true,
          configurable: true,
          enumerable: key !== 'raw',
        });
    if ('cause' in init) errorCauses.set(this, init.cause);
    Object.defineProperty(this, 'cause', {
      configurable: true,
      get: () => errorCauses.get(this),
      set: (value: unknown) => errorCauses.set(this, value),
    });
    Object.defineProperty(this, 'headers', { enumerable: false });
    Object.defineProperty(this, 'raw', { enumerable: false });
    this.name = errorNames.get(new.target) ?? new.target.name;
  }
  toJSON() {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      ...(this.param !== undefined ? { param: this.param } : {}),
      operation: this.operation ?? null,
      outcome: this.outcome,
      retryAllowed: this.retryAllowed,
      status: this.status ?? null,
      requestId: this.requestId ?? null,
      requestIds: this.requestIds,
      idempotencyKey: this.idempotencyKey ?? null,
      attempts: this.attempts,
      retryAfterMs: this.retryAfterMs ?? null,
      ...(this instanceof errors.ApiError
        ? {
            type: this.type ?? null,
            param: this.param ?? null,
            errorSource: this.errorSource ?? null,
            docUrl: this.docUrl ?? null,
            remediation: this.remediation ?? null,
            details: this.details,
          }
        : {}),
      cause:
        this.cause instanceof Error
          ? {
              name:
                this.cause instanceof TypeError
                  ? 'TypeError'
                  : this.cause instanceof SyntaxError
                    ? 'SyntaxError'
                    : 'Error',
              code: transportCode(this.cause) ?? null,
            }
          : null,
      stack: this.stack ?? null,
    };
  }
  [inspectCustom]() {
    return this.toJSON();
  }
}
const BaseSdkError = SdkError;
type BaseSdkError = SdkError;
export namespace errors {
  export const SdkError = BaseSdkError;
  export type SdkError = BaseSdkError;
  export class ApiError extends BaseSdkError {
    details: readonly unknown[];
    type?: string;
    errorSource?: string;
    docUrl?: string;
    requestLogUrl?: string;
    remediation?: ErrorRemediation;
    body?: unknown;
    constructor(message: string, init: ApiErrorInit = {}) {
      super(message, init);
      this.details =
        Array.isArray(init.details) &&
        (!publicErrorDetailsCertificate || certifies(init.details, publicErrorDetailsCertificate))
          ? init.details
          : [];
      for (const key of ['type', 'errorSource', 'docUrl', 'requestLogUrl', 'remediation'] as const)
        if (init[key] !== undefined)
          Object.defineProperty(this, key, { value: init[key], writable: true, enumerable: true });
      Object.defineProperty(this, 'body', { value: init.body, writable: true, enumerable: false });
    }
  }
  export class InvalidRequestError extends ApiError {}
  export class AuthenticationError extends ApiError {}
  export class PermissionError extends ApiError {}
  export class NotFoundError extends ApiError {}
  export class ConflictError extends ApiError {}
  export class RateLimitError extends ApiError {}
  export class ServerError extends ApiError {}
  export class ConnectionError extends BaseSdkError {}
  export class TimeoutError extends ConnectionError {}
  export class InvalidInputError extends BaseSdkError {}
  export class ConfigurationError extends BaseSdkError {
    workloadIdentity?: unknown;
  }
  export class CancelledError extends BaseSdkError {}
  export class UnexpectedResponseError extends BaseSdkError {
    event?: { id: string; position: number };
  }
  export class WebhookVerificationError extends BaseSdkError {}
  export class PaginationLimitError extends BaseSdkError {}
}
const errorNames = new Map<typeof SdkError, string>([
  [SdkError, 'SdkError'],
  ...Object.entries(errors).map(([name, value]): [typeof SdkError, string] => [value, name]),
]);
const errorKinds = new WeakMap<SdkError, InternalErrorKind>();
const internalKind = (error: SdkError) =>
  errorKinds.get(error) ?? (error instanceof errors.InvalidInputError ? 'validation' : undefined);
function apiErrorClass(status: number): typeof errors.ApiError {
  if (status === 400 || status === 422) return errors.InvalidRequestError;
  if (status === 401) return errors.AuthenticationError;
  if (status === 403) return errors.PermissionError;
  if (status === 404) return errors.NotFoundError;
  if (status === 409 || status === 412) return errors.ConflictError;
  if (status === 429) return errors.RateLimitError;
  if (status >= 500 && status < 600) return errors.ServerError;
  return errors.ApiError;
}
/** Internal migration adapter. Remove kind routing when the call sites migrate. */
export function createSdkError(
  kind: InternalErrorKind,
  message: string,
  outcome: SdkError['outcome'] = 'not_sent',
  retryAllowed = false,
  meta?: Metadata,
  code?: string,
  details?: unknown,
  options?: ErrorOptions,
  raw?: string,
): SdkError {
  const Class =
    meta &&
    meta.status >= 400 &&
    meta.status < 600 &&
    !['transport', 'timeout', 'deadline', 'cancelled'].includes(kind)
      ? apiErrorClass(meta.status)
      : kind === 'webhook'
        ? errors.WebhookVerificationError
        : kind === 'transport'
          ? errors.ConnectionError
          : kind === 'timeout' || kind === 'deadline'
            ? errors.TimeoutError
            : kind === 'cancelled'
              ? errors.CancelledError
              : kind === 'protocol' ||
                  kind === 'api' ||
                  (kind === 'destination' && meta !== undefined)
                ? errors.UnexpectedResponseError
                : kind === 'authentication' || kind === 'destination'
                  ? errors.ConfigurationError
                  : errors.InvalidInputError;
  const error = new Class(message, {
    ...meta,
    outcome,
    retryAllowed,
    ...(code !== undefined ? { code } : {}),
    ...(raw !== undefined ? { raw } : {}),
    ...options,
    ...(Class.prototype instanceof errors.ApiError || Class === errors.ApiError ? { details } : {}),
  });
  if (
    error instanceof errors.ConfigurationError &&
    details &&
    typeof details === 'object' &&
    'error_description' in details
  ) {
    const { error_description, ...identity } = details;
    error.workloadIdentity = { ...identity, errorDescription: error_description };
  }
  if (
    error instanceof errors.UnexpectedResponseError &&
    details &&
    typeof details === 'object' &&
    'eventId' in details &&
    typeof details.eventId === 'string' &&
    'position' in details &&
    typeof details.position === 'number'
  )
    error.event = { id: details.eventId, position: details.position };
  errorKinds.set(error, kind);
  if (typeof Error.captureStackTrace === 'function') Error.captureStackTrace(error, createSdkError);
  return error;
}
export interface DiagnosticEvent {
  operation: string;
  attempt: number;
  status?: number;
  requestId?: string;
  durationMs: number;
  errorKind?: InternalErrorKind;
}
/** Incoming Node/Express headers or Fetch Headers; only signing headers are inspected. */
export type WebhookHeaders =
  | Headers
  | Readonly<Record<string, string | readonly string[] | undefined>>;

const webhookError = (
  kind: 'validation' | 'authentication',
  code: string,
  message: string,
): never => {
  throw createSdkError('webhook', message, 'not_sent', false, undefined, 'webhook_' + code);
};

function webhookHeaderValues(headers: WebhookHeaders, name: string, optional = false): string[] {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers))
    return webhookError(
      'validation',
      'invalid_input',
      'Webhook headers must be Headers or a header record',
    );
  const values: string[] = [];
  const entries = headers instanceof Headers ? headers.entries() : Object.entries(headers);
  for (const [key, value] of entries) {
    if (key.toLowerCase() !== name.toLowerCase() || value === undefined) continue;
    const parts = Array.isArray(value) ? value : [value];
    if (!Array.from(parts).every((part): part is string => typeof part === 'string'))
      return webhookError(
        'validation',
        'invalid_input',
        'Webhook signing header values must be strings',
      );
    values.push(...parts);
  }
  if (!values.length || values.every((value) => !value.trim())) {
    if (optional) return [];
    return webhookError(
      'authentication',
      'missing_header',
      'Missing webhook signing header: ' + name,
    );
  }
  return values;
}

function webhookScalarHeader(headers: WebhookHeaders, name: string, timestamp = false): string {
  const values = webhookHeaderValues(headers, name);
  const value = values[0];
  if (values.length !== 1 || value === undefined || value.includes(','))
    return webhookError(
      'authentication',
      timestamp ? 'invalid_timestamp' : 'invalid_signature',
      'Webhook signing header must have exactly one value: ' + name,
    );
  return value.trim();
}

export interface CredentialProvider {
  getCredential(): Promise<{ value: string; expiresAt?: Date }>;
  invalidate?(): void;
}

export type WorkloadIdentitySource = 'auto' | 'none' | 'token' | 'token_file' | 'github_actions';
export interface WorkloadIdentityOptions {
  workloadIdentityId: string;
  source?: WorkloadIdentitySource;
  audience?: string;
  scope?: string;
}
type CredentialContext = {
  baseUrl: string;
  transport: typeof fetch;
  deadline: number;
  signal?: AbortSignal;
};
type CachedCredential = { value: string; expiresAt: Date; lifetime: number };
const identityTokens = new Map<string, CachedCredential>();
const identityFlights = new Map<string, Promise<CachedCredential>>();

/** Generated package wrappers supply provider configuration; no provider names live here. */
export function configuredDefaultCredentials(
  config: DefaultCredentials,
  baseUrl?: string,
): CredentialProvider {
  return new AmbientCredentialProvider(config, undefined, baseUrl);
}
export function configuredWorkloadIdentityCredentials(
  config: DefaultCredentials,
  options: WorkloadIdentityOptions,
  baseUrl?: string,
): CredentialProvider {
  return new AmbientCredentialProvider(config, options, baseUrl);
}

class AmbientCredentialProvider implements CredentialProvider {
  #lastCredential: object | undefined;
  #invalidations = new WeakMap<object, () => void>();
  constructor(
    private readonly config: DefaultCredentials,
    private readonly identity?: WorkloadIdentityOptions,
    private readonly baseUrl?: string,
  ) {}
  toJSON() {
    return { credentials: '[REDACTED]' };
  }
  [inspectCustom]() {
    return { credentials: '[REDACTED]' };
  }
  canInvalidate(credential = this.#lastCredential) {
    return credential !== undefined && this.#invalidations.has(credential);
  }
  invalidate(credential = this.#lastCredential) {
    if (credential) this.#invalidations.get(credential)?.();
  }
  async getCredential(context?: CredentialContext): Promise<{ value: string; expiresAt?: Date }> {
    const env = this.config.environment;
    const prefix = this.config.workloadIdentity.envPrefix;
    const read = (suffix: string) => process.env[prefix + '_' + suffix] || undefined;
    const id = this.identity?.workloadIdentityId ?? read('WORKLOAD_IDENTITY_ID');
    let source: string = this.identity?.source ?? read('OIDC_SOURCE') ?? 'auto';
    let claims: Record<string, unknown> = {};
    let subject = '';
    const responseTokens = new Set<string>();
    const clean = (value: unknown): string => {
      let text = typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
      for (const token of [
        subject,
        ...responseTokens,
        process.env[env.apiKey],
        process.env[env.token],
        process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
      ])
        if (token)
          for (const encoded of [token, encodeURIComponent(token)])
            text = text.split(encoded).join('[REDACTED]');
      return text
        .replace(/eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED]')
        .slice(0, 2048);
    };
    const fail = (reason: string, description = ''): never => {
      const details = {
        reason,
        source: clean(source),
        workloadIdentityId: clean(id ?? ''),
        iss: clean(claims.iss),
        sub: clean(claims.sub),
        aud: clean(claims.aud),
        error_description: clean(description),
      };
      throw createSdkError(
        'authentication',
        clean(JSON.stringify(details)),
        'not_sent',
        false,
        undefined,
        reason,
        details,
      );
    };
    if (!this.identity) {
      const apiKey = process.env[env.apiKey],
        token = process.env[env.token];
      if (apiKey && token)
        fail('ambiguous_credentials', `Set only one of ${env.apiKey} and ${env.token}`);
      if (apiKey || token) {
        this.#lastCredential = undefined;
        return { value: apiKey || token || '' };
      }
      if (!id)
        fail(
          'no_credentials',
          `Set ${env.apiKey}, ${env.token}, or ${prefix}_WORKLOAD_IDENTITY_ID with ${prefix}_OIDC_TOKEN, ${prefix}_OIDC_TOKEN_FILE, or GitHub Actions permissions: id-token: write`,
        );
    }
    if (typeof id !== 'string' || !id || /[\r\n]/.test(id))
      fail('source_unavailable', 'A workload identity ID is required');
    const base = context?.baseUrl ?? this.baseUrl;
    if (!base) fail('source_unavailable', 'Pass this provider to a client with a base URL');
    const url = new URL(base ?? fail('source_unavailable'));
    if (
      url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    )
      fail('exchange_unavailable', 'Token exchange requires HTTPS or loopback');
    const audience = this.identity?.audience ?? read('OIDC_AUDIENCE') ?? url.origin;
    const scope = this.identity?.scope ?? read('OIDC_SCOPE');
    const file = read('OIDC_TOKEN_FILE');
    if (source === 'auto')
      source = read('OIDC_TOKEN')
        ? 'token'
        : file
          ? 'token_file'
          : process.env.GITHUB_ACTIONS === 'true'
            ? 'github_actions'
            : 'none';
    if (!['token', 'token_file', 'github_actions'].includes(source))
      fail('source_unavailable', 'Supported sources: token, token_file, github_actions');
    const githubUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
    const githubToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    if (source === 'github_actions' && (!githubUrl || !githubToken))
      fail('source_unavailable', 'GitHub Actions requires permissions: id-token: write');
    const sourceKey =
      source === 'token'
        ? process
            .getBuiltinModule('crypto')
            .createHash('sha256')
            .update(read('OIDC_TOKEN') ?? '')
            .digest('hex')
        : source === 'github_actions'
          ? process
              .getBuiltinModule('crypto')
              .createHash('sha256')
              .update(JSON.stringify([githubUrl, githubToken]))
              .digest('hex')
          : file;
    const key = JSON.stringify([
      url.origin,
      this.config.workloadIdentity.tokenPath,
      this.config.workloadIdentity.credentialParameter,
      prefix,
      id,
      audience,
      scope ?? '',
      source,
      sourceKey,
    ]);
    // Each resolution retains its own partition and rejected-token comparison.
    const credential = (entry: CachedCredential) => {
      const result = { value: entry.value, expiresAt: entry.expiresAt };
      this.#invalidations.set(result, () => {
        if (identityTokens.get(key)?.value === entry.value) identityTokens.delete(key);
      });
      this.#lastCredential = result;
      return result;
    };
    const cached = identityTokens.get(key);
    const remaining = cached ? cached.expiresAt.getTime() - Date.now() : 0;
    if (cached && remaining > 30000 && remaining >= Math.max(60000, cached.lifetime * 0.2)) {
      return credential(cached);
    }
    const existing = identityFlights.get(key);
    if (existing) {
      const value = await existing;
      return credential(value);
    }
    const exchange = async (): Promise<CachedCredential> => {
      const deadline = context?.deadline ?? performance.now() + 30000;
      if (source === 'github_actions') {
        let endpoint: URL;
        try {
          endpoint = new URL(githubUrl ?? '');
          if (
            endpoint.username ||
            endpoint.password ||
            endpoint.hash ||
            (endpoint.protocol !== 'https:' &&
              !(
                endpoint.protocol === 'http:' &&
                ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
              ))
          )
            throw new Error();
          endpoint.searchParams.set('audience', audience);
        } catch {
          return fail(
            'source_unavailable',
            'GitHub Actions identity endpoint requires HTTPS or loopback',
          );
        }
        const controller = new AbortController();
        const abort = () => controller.abort();
        context?.signal?.addEventListener('abort', abort, { once: true });
        if (context?.signal?.aborted || deadline <= performance.now()) controller.abort();
        const timer = schedule(abort, Math.max(0, deadline - performance.now()));
        try {
          const response = await abortable(
            (context?.transport ?? fetch)(endpoint, {
              method: 'GET',
              headers: { authorization: 'Bearer ' + githubToken, accept: 'application/json' },
              redirect: 'manual',
              signal: controller.signal,
            }),
            controller.signal,
          );
          if (response.status !== 200)
            return fail(
              'subject_token_request_failed',
              'GitHub Actions identity request failed; check permissions: id-token: write',
            );
          const payload: unknown = JSON.parse(await abortable(response.text(), controller.signal));
          if (
            !payload ||
            typeof payload !== 'object' ||
            !('value' in payload) ||
            typeof payload.value !== 'string'
          )
            return fail('subject_token_request_failed', 'Invalid GitHub Actions identity response');
          subject = payload.value;
        } catch {
          return fail(
            'subject_token_request_failed',
            'GitHub Actions identity request failed; check permissions: id-token: write',
          );
        } finally {
          timer.cancel();
          context?.signal?.removeEventListener('abort', abort);
        }
      } else
        try {
          subject =
            source === 'token'
              ? (read('OIDC_TOKEN') ?? '')
              : file
                ? (await process.getBuiltinModule('fs/promises').readFile(file, 'utf8')).trim()
                : '';
        } catch {
          fail('subject_token_request_failed', 'Cannot read the configured token file');
        }
      if (!subject) fail('source_unavailable', 'The selected token source is empty');
      try {
        const parts = subject.split('.');
        if (
          parts.length !== 3 ||
          parts[1] === undefined ||
          !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))
        )
          throw new Error();
        const payload: unknown = JSON.parse(
          Buffer.from(parts[1] ?? '', 'base64url').toString('utf8'),
        );
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error();
        // The parsed payload has passed the non-array object guard.
        claims = payload as Record<string, unknown>;
      } catch {
        fail('audience_mismatch', 'Subject token must be a JWT with aud and exp');
      }
      if (
        !(
          claims.aud === audience ||
          (Array.isArray(claims.aud) && claims.aud.includes(audience))
        ) ||
        typeof claims.exp !== 'number' ||
        !Number.isFinite(claims.exp) ||
        claims.exp * 1000 <= Date.now()
      )
        fail('audience_mismatch', 'Subject token audience differs or expiry has passed');
      const form = new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token: subject,
        subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
        requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        [this.config.workloadIdentity.credentialParameter]: id ?? fail('source_unavailable'),
        ...(scope === undefined ? {} : { scope }),
      });
      for (let attempt = 0; attempt < 3; attempt++) {
        const remaining = deadline - performance.now();
        if (remaining <= 0) fail('exchange_unavailable', 'Exchange deadline exceeded');
        const controller = new AbortController();
        const abort = () => controller.abort();
        context?.signal?.addEventListener('abort', abort, { once: true });
        if (context?.signal?.aborted) controller.abort();
        const timer = schedule(abort, remaining);
        let response: Response, body: unknown;
        try {
          response = await abortable(
            (context?.transport ?? fetch)(
              new URL(this.config.workloadIdentity.tokenPath, url.origin),
              {
                method: 'POST',
                headers: {
                  'content-type': 'application/x-www-form-urlencoded',
                  accept: 'application/json',
                },
                body: form.toString(),
                redirect: 'manual',
                signal: controller.signal,
              },
            ),
            controller.signal,
          );
          const raw = await abortable(response.text(), controller.signal);
          try {
            body = JSON.parse(raw);
          } catch {
            body = undefined;
          }
        } catch {
          return fail('exchange_unavailable', 'Token exchange transport failed');
        } finally {
          timer.cancel();
          context?.signal?.removeEventListener('abort', abort);
        }
        const data =
          body && typeof body === 'object' && !Array.isArray(body)
            ? (body as Record<string, unknown>)
            : {};
        for (const [name, value] of Object.entries(data))
          if ((name === 'token' || name.endsWith('_token')) && typeof value === 'string' && value)
            responseTokens.add(value);
        const description =
          typeof data.error_description === 'string' ? data.error_description : '';
        if (response.status === 429 || response.status >= 500) {
          const instruction = response.headers.get('retry-after');
          const wait = instruction
            ? /^\d+(\.\d+)?$/.test(instruction)
              ? Number(instruction) * 1000
              : Date.parse(instruction) - Date.now()
            : 100 * 2 ** attempt;
          const pause = Number.isFinite(wait) ? Math.max(0, wait) : 100 * 2 ** attempt;
          if (attempt === 2 || performance.now() + pause >= deadline)
            fail('exchange_unavailable', description);
          await delay(pause, context?.signal);
          continue;
        }
        if (response.status !== 200) fail('exchange_rejected', description);
        if (
          typeof data.access_token !== 'string' ||
          !data.access_token ||
          /[\r\n]/.test(data.access_token) ||
          data.token_type !== 'Bearer' ||
          data.issued_token_type !== 'urn:ietf:params:oauth:token-type:access_token' ||
          typeof data.expires_in !== 'number' ||
          !Number.isFinite(data.expires_in) ||
          data.expires_in <= 30 ||
          (data.scope !== undefined && typeof data.scope !== 'string')
        )
          fail('exchange_rejected', 'Invalid token exchange response');
        // Subject expiry is an upper bound even if the server or local clock disagrees.
        const lifetime = Math.min(
          Number(data.expires_in) * 1000,
          Number(claims.exp) * 1000 - Date.now(),
        );
        if (lifetime <= 30000)
          fail('exchange_rejected', 'Exchanged token has at most 30 seconds remaining');
        const token = {
          value: String(data.access_token),
          expiresAt: new Date(Date.now() + lifetime),
          lifetime,
        };
        identityTokens.set(key, token);
        return token;
      }
      return fail('exchange_unavailable');
    };
    const flight = exchange()
      .catch((error) => {
        if (
          cached &&
          cached.expiresAt.getTime() - Date.now() > 30000 &&
          error instanceof SdkError &&
          error.code === 'exchange_unavailable'
        )
          return cached;
        throw error;
      })
      .finally(() => {
        if (identityFlights.get(key) === flight) identityFlights.delete(key);
      });
    identityFlights.set(key, flight);
    const value = await flight;
    return credential(value);
  }
}

async function resolveCredential(
  input: unknown,
  message: string,
  rejectNewlines = true,
  context?: CredentialContext,
  providers?: Map<CredentialProvider, () => void>,
): Promise<string> {
  let value: unknown = input;
  if (typeof input === 'object' && input !== null && 'getCredential' in input) {
    try {
      const credential: unknown = await (input instanceof AmbientCredentialProvider
        ? input.getCredential(context)
        : (input as CredentialProvider).getCredential());
      if (input instanceof AmbientCredentialProvider) {
        if (
          typeof credential === 'object' &&
          credential !== null &&
          input.canInvalidate(credential)
        )
          providers?.set(input, () => input.invalidate(credential));
      } else {
        const provider = input as CredentialProvider;
        if (typeof provider.invalidate === 'function')
          providers?.set(provider, () => provider.invalidate?.());
      }
      value =
        typeof credential === 'object' && credential !== null && 'value' in credential
          ? credential.value
          : undefined;
    } catch (error) {
      if (input instanceof AmbientCredentialProvider && error instanceof SdkError) throw error;
      // Provider exceptions may contain credentials, including in their causes.
      throw createSdkError('authentication', 'Credential provider failed');
    }
  }
  if (typeof value !== 'string' || !value || (rejectNewlines && /[\r\n]/.test(value)))
    throw createSdkError('authentication', message);
  return value;
}

/** Validate explicit sources without resolving providers or reading the environment. */
function credentialOptionsPassed(
  options: ClientOptions | RequestOptions,
  shortcuts: readonly string[],
  client: boolean,
): boolean {
  const values = options as unknown as Record<string, unknown>;
  const validate = (value: unknown, param: string) => {
    if (
      value === undefined ||
      value === null ||
      (typeof value === 'string' && /^[\s\u0085]*$/u.test(value))
    ) {
      const state = value === undefined ? 'undefined' : value === null ? 'null' : 'empty or blank';
      const kind = param === 'apiKey' ? 'API key' : 'credential';
      throw new errors.ConfigurationError(
        `${param} was passed but is ${state}. Pass a nonempty ${kind}; default credentials are used only when no credential option is passed.`,
        { code: 'credential_missing', param },
      );
    }
  };
  let passed = false;
  for (const key of new Set(['token', ...shortcuts])) {
    if (!Object.hasOwn(options, key)) continue;
    passed = true;
    validate(values[key], key);
  }
  if (Object.hasOwn(options, 'credentials')) {
    passed = true;
    validate(values.credentials, 'credentials');
    for (const [key, value] of Object.entries(values.credentials as object)) {
      const param = `credentials.${key}`;
      validate(value, param);
      if (client && typeof value === 'object' && value !== null)
        for (const [scheme, source] of Object.entries(value))
          validate(source, `${param}.${scheme}`);
    }
  }
  return passed;
}

/** Preserve own credential keys, including non-enumerable ones, across option copies. */
function copyCredentialOptions<T extends ClientOptions | RequestOptions>(
  options: T,
  shortcuts: readonly string[],
  client: boolean,
): T {
  credentialOptionsPassed(options, shortcuts, client);
  const copy = { ...options };
  for (const key of new Set(['token', 'authMode', 'credentials', ...shortcuts])) {
    if (Object.hasOwn(options, key))
      Object.defineProperty(copy, key, {
        value: Reflect.get(options, key),
        enumerable: true,
        writable: true,
        configurable: true,
      });
  }
  return copy;
}

/** Per-call overrides; pass as the final method argument. See RUNTIME.md#requestoptions. */
export interface RequestOptions extends RequestOptionValues {
  streamIdleTimeoutMs?: number;
  streamLifetimeMs?: number;
  authMode?: string;
  credentials?: Record<string, string | CredentialProvider>;
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
/** Client environment, credentials and transport defaults. See RUNTIME.md#clientoptions. */
export interface ClientOptions {
  ambientCredentials?: boolean;
  baseUrl?: string;
  token?: string | CredentialProvider;
  authMode?: string;
  credentials?: Record<string, Record<string, string | CredentialProvider>>;
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
function schedule(callback: () => void, duration: number, unref = false): ScheduledTimer {
  const deadline = performance.now() + duration;
  let timer: ReturnType<typeof setTimeout>;
  const tick = () => {
    const remaining = deadline - performance.now();
    if (remaining <= 0) callback();
    else {
      timer = setTimeout(tick, Math.min(2147483647, Math.ceil(remaining)));
      if (unref) timer.unref();
    }
  };
  timer = setTimeout(tick, Math.min(2147483647, Math.max(0, Math.ceil(duration))));
  if (unref) timer.unref();
  return { cancel: () => clearTimeout(timer) };
}

function inspectedMetadata(meta: Metadata) {
  return {
    status: meta.status,
    requestId: meta.requestId,
    idempotencyKey: meta.idempotencyKey,
    attempts: meta.attempts,
    durationMs: meta.durationMs,
  };
}

const streamConnections = new WeakMap<Response, () => void>();

/** Leave an unconsumed default SSE socket unreferenced; iteration retains it. */
async function streamFetch(
  url: URL,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal: AbortSignal;
    redirect: 'manual';
  },
): Promise<Response> {
  const { Readable, pipeline } = process.getBuiltinModule('stream');
  const { createGunzip, createInflate, createBrotliDecompress } = process.getBuiltinModule('zlib');
  const transport =
    url.protocol === 'https:'
      ? process.getBuiltinModule('https')
      : process.getBuiltinModule('http');
  return new Promise((resolve, reject) => {
    const request = transport.request(
      url,
      { method: init.method, headers: init.headers, signal: init.signal },
      (incoming) => {
        incoming.socket.unref();
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers))
          for (const entry of Array.isArray(value) ? value : value === undefined ? [] : [value])
            headers.append(name, entry);
        const status = incoming.statusCode;
        if (status === undefined || status < 200 || status > 599) {
          incoming.destroy();
          reject(new Error('Invalid HTTP response status'));
          return;
        }
        // Match fetch decompression while retaining direct ownership of the SSE socket.
        const decoders: Transform[] = [];
        for (const encoding of (headers.get('content-encoding') ?? '').split(',').reverse()) {
          switch (encoding.trim().toLowerCase()) {
            case '':
            case 'identity':
              break;
            case 'gzip':
            case 'x-gzip':
              decoders.push(createGunzip());
              break;
            case 'deflate':
              decoders.push(createInflate());
              break;
            case 'br':
              decoders.push(createBrotliDecompress());
              break;
            default:
              incoming.destroy();
              reject(new Error('Unsupported response content encoding'));
              return;
          }
        }
        const body = decoders.at(-1) ?? incoming;
        if (decoders.length) pipeline([incoming, ...decoders], () => {});
        const response = new Response(
          [204, 205, 304].includes(status)
            ? null
            : (Readable.toWeb(body, {
                strategy: { highWaterMark: 1, size: (chunk: Uint8Array) => chunk.byteLength },
              }) as ReadableStream<Uint8Array>),
          { status, headers },
        );
        streamConnections.set(response, () => incoming.socket?.ref());
        resolve(response);
      },
    );
    request.on('error', reject);
    request.end(init.body);
  });
}

/** A single-consumer stream. Breaking iteration releases the response connection. */
export class EventStream implements AsyncIterable<ServerSentEvent> {
  private closed = false;
  private started = false;
  private failure: SdkError | undefined;
  private lifetime: ScheduledTimer | undefined;
  private unconsumed: ScheduledTimer | undefined;
  private readonly abort = () => {
    this.failure = createSdkError('cancelled', 'Stream cancelled', 'response', false, this.meta);
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
      retainConnection?: () => void;
    },
    private readonly decodeEvent: (event: string, data: string) => unknown = (_event, data) => data,
    private readonly released: () => void = () => {},
  ) {
    this.unconsumed = schedule(
      () => {
        this.failure = createSdkError(
          'deadline',
          'Unconsumed stream idle timeout exceeded',
          'response',
          false,
          this.meta,
        );
        void this.close();
      },
      settings.idleTimeoutMs,
      true,
    );
    settings.signal?.addEventListener('abort', this.abort, { once: true });
    if (settings.signal?.aborted) this.abort();
    if (settings.lifetimeMs)
      this.lifetime = schedule(
        () => {
          this.failure = createSdkError(
            'deadline',
            'Stream lifetime exceeded',
            'response',
            false,
            this.meta,
          );
          void this.close();
        },
        settings.lifetimeMs,
        true,
      );
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.lifetime?.cancel();
    this.unconsumed?.cancel();
    this.settings.signal?.removeEventListener('abort', this.abort);
    this.released();
    await this.reader.cancel().catch(() => {});
  }
  [inspectCustom]() {
    return { meta: inspectedMetadata(this.meta), closed: this.closed };
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<ServerSentEvent> {
    if (this.started) throw createSdkError('validation', 'A stream can only be consumed once');
    this.started = true;
    this.unconsumed?.cancel();
    this.settings.retainConnection?.();
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    let firstCharacter = true;
    let line = '',
      data = '',
      event = '',
      id = '',
      skipLF = false,
      bytes = 0;
    let retry: number | undefined;
    let position = 0;
    const consumeLine = (): ServerSentEvent | undefined => {
      if (line === '') {
        let decoded: unknown;
        if (data !== '') {
          position++;
          try {
            decoded = this.decodeEvent(event || 'message', data.slice(0, -1));
          } catch (cause) {
            throw createSdkError(
              'protocol',
              `Invalid SSE event payload at event ${position}; inspect details.eventId and details.position`,
              'response',
              false,
              this.meta,
              'sse_invalid_event',
              { eventId: id, position },
              { cause },
            );
          }
        }
        const frame =
          data === ''
            ? undefined
            : {
                event: event || 'message',
                id,
                rawData: data.slice(0, -1),
                data: decoded,
                ...(retry !== undefined ? { retry } : {}),
              };
        if (frame)
          Object.defineProperty(frame, inspectCustom, {
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
                  createSdkError(
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
                throw createSdkError(
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
              throw createSdkError(
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
              throw createSdkError(
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
      if (cause instanceof SdkError && internalKind(cause) !== 'validation') throw cause;
      throw createSdkError(
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
const validationFailures = new WeakMap<Error, string>();
const bad = (path: string, reason: string, code?: string): never => {
  const message = `${path}: ${reason}`;
  const error = createSdkError('validation', message, 'not_sent', false, undefined, code);
  validationFailures.set(error, message);
  throw error;
};
// Unlike $, the lookahead requires the true end, including after line terminators.
const exactInteger = /^-?(?:0|[1-9]\d*)(?![\s\S])/;
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
  if (value instanceof CompiledModel) return encode(value.toJSON(), depth + 1);
  if (value instanceof RawNumber) return value.value;
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) bad('value', 'expected a finite number');
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
    if (typeof other === 'number' && Number.isFinite(other) && other === Number(token.value))
      return other;
    const text =
      other instanceof ParsedNumber || other instanceof RawNumber ? other.value : String(other);
    if (!exactDecimal.test(text) || compareDecimal(token.value, text) !== 0)
      bad(path, 'alternatives have incompatible numeric representations');
    return other instanceof RawNumber ? new RawNumber(token.value) : other;
  }
  if (left instanceof RawNumber || right instanceof RawNumber) {
    const token = left instanceof RawNumber ? left : right;
    const other = left instanceof RawNumber ? right : left;
    if (
      source instanceof ParsedNumber &&
      token.value === source.value &&
      typeof other === 'number' &&
      Number.isFinite(other) &&
      other === Number(source.value)
    )
      return token;
    const text = other instanceof RawNumber ? other.value : String(other);
    if (!exactDecimal.test(text) || compareDecimal(token.value, text) !== 0)
      bad(path, 'alternatives have incompatible numeric representations');
    return token;
  }
  // A matching exact branch retains precision when another branch projects
  // this same JSON token to a native number. Independent constraints ran first.
  if (source instanceof ParsedNumber) {
    const exact = typeof left === 'string' ? left : typeof right === 'string' ? right : undefined;
    const native = typeof left === 'number' ? left : typeof right === 'number' ? right : undefined;
    if (
      exact !== undefined &&
      native !== undefined &&
      Number.isFinite(native) &&
      exactDecimal.test(exact) &&
      compareDecimal(source.value, exact) === 0 &&
      native === Number(source.value)
    )
      return exact;
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
  nullableAlternative: 0 | 1 | undefined,
  context: CodecContext,
  matches: (branch: CodecPlan, allowUnknownFields: boolean) => boolean | string,
): { selected: readonly CodecPlan[]; tolerateUnknownFields: boolean } {
  const response = (context.direction ?? context.mode) === 'response';
  const matching = context.mode === 'match';
  const path = context.path ?? 'input';
  let tolerateUnknownFields = context.allowUnknownResponseFields ?? false;
  let selected: readonly CodecPlan[];
  const failures = new Map<CodecPlan, string>();
  const match = (branch: CodecPlan, allowUnknownFields: boolean): boolean => {
    const result = matches(branch, allowUnknownFields);
    if (typeof result === 'string') failures.set(branch, result);
    return result === true;
  };
  if (nullableAlternative !== undefined && response && !matching) {
    const branch = branches[value === null ? 1 - nullableAlternative : nullableAlternative];
    if (!branch) throw new Error('Invalid nullable alternative policy');
    return { selected: [branch], tolerateUnknownFields: true };
  }
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
        : branches.filter((branch) => match(branch, false));
    // Prefer closed oneOf matches before tolerating new response fields. anyOf
    // retains every compatible branch's declared numeric representations.
    if ((!oneOf || !selected.length) && response && (!matching || tolerateUnknownFields)) {
      const compatible = branches.filter((branch) => match(branch, true));
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
        ? 'value must match exactly one alternative' +
            ': ' +
            branches
              .slice(0, 8)
              .map(
                (branch, index) =>
                  `alternative ${index + 1}: ${selected.includes(branch) ? 'matched' : (failures.get(branch) ?? 'discriminator did not match').slice(0, 180)}`,
              )
              .join('; ') +
            (branches.length > 8 ? '; additional alternatives omitted' : '')
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
    if (!(error instanceof SdkError) || internalKind(error) !== 'validation') throw error;
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
    if (typeof child === 'bigint') return true;
    if (typeof child === 'string') return exactDecimal.test(child);
    if (child instanceof ParsedNumber || child instanceof RawNumber) return false;
    if (child instanceof CompiledModel) child = modelInputs.get(child) ?? child.toJSON();
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
        if (error instanceof SdkError && internalKind(error) === 'validation') return false;
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
          scope.codec.nullableAlternative,
          context,
          (branch, allowUnknownResponseFields) => {
            try {
              executeNode(candidate, branch, { ...branchContext, allowUnknownResponseFields });
              return true;
            } catch (error) {
              if (error instanceof SdkError && internalKind(error) === 'validation')
                return error.message;
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
      if (error instanceof SdkError && internalKind(error) === 'validation') return undefined;
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
  if (left instanceof Date && typeof right === 'string') return right;
  if (left === right || left instanceof ParsedNumber) return left;
  if (right instanceof ParsedNumber) return right;
  if (left instanceof CompiledModel) left = left.toJSON();
  if (right instanceof CompiledModel) right = right.toJSON();
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
  if (source instanceof CompiledModel) source = source.toJSON();
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
          codec.nullableAlternative,
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
              if (error instanceof SdkError && internalKind(error) === 'validation')
                return error.message;
              throw error;
            }
          },
        ).selected;
      }),
    ];
  });
  if (value instanceof ParsedNumber) {
    if (
      !shapes.some(
        ({ codec }) =>
          exactValue(codec.value) ||
          (codec.value.kind === 'native-number' && typeof source === 'number'),
      )
    )
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
  if (value instanceof CompiledModel) value = modelInputs.get(value) ?? value.toJSON();
  const shapes = codecShapes(scopes, path, depth);
  if (
    typeof value === 'bigint' &&
    (context.direction ?? context.mode) !== 'response' &&
    shapes.some(({ codec }) => codec.value.kind === 'exact-integer')
  )
    value = new ParsedNumber(value.toString());
  if (
    value instanceof Date &&
    (context.direction ?? context.mode) !== 'response' &&
    shapes.some(({ codec }) => codec.value.kind === 'date-time')
  ) {
    if (!Number.isFinite(value.getTime())) bad(path, 'expected a valid Date');
    value = value.toISOString();
  }
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
  } else if (
    value &&
    typeof value === 'object' &&
    !(value instanceof ParsedNumber) &&
    !(value instanceof Date)
  ) {
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
          codec.nullableAlternative,
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
              if (error instanceof SdkError && internalKind(error) === 'validation')
                return error.message;
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
        if (!(error instanceof SdkError) || internalKind(error) !== 'validation') throw error;
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
  if (value instanceof CompiledModel) value = modelInputs.get(value) ?? value.toJSON();
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
    const matches = (branch: CodecPlan, allowUnknownFields: boolean): boolean | string => {
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
        if (error instanceof SdkError && internalKind(error) === 'validation') return error.message;
        throw error;
      }
    };
    if (not && matches(not, false) === true) bad(path, 'value matches a forbidden combination');
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
        s.nullableAlternative,
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
      Object.defineProperty(object, inspectCustom, {
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
  if (
    !response &&
    type === 'integer' &&
    value instanceof ExactNumber &&
    !exactInteger.test(value.value)
  )
    return bad(path, 'expected an integer string');
  const numberToken = value instanceof ParsedNumber ? value.value : undefined;
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
    } else if (type === 'number') value = exactValue(s.value) ? value.value : Number(value.value);
    else return bad(path, `expected ${type}; received a JSON number`);
  }
  const exactEnum = exactValue(s.value) || s.value.kind === 'native-number';
  if (
    (!response || matching) &&
    s.members &&
    !(exactEnum
      ? (typeof value === 'string' || typeof value === 'number') &&
        exactDecimal.test(String(value)) &&
        s.members.some(
          (member) =>
            typeof member === 'number' &&
            compareDecimal(numberToken ?? String(value), String(member)) === 0,
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
        return bad(
          path,
          type === 'integer' ? 'expected an integer string' : 'expected an exact numeric string',
        );
      if (!response || matching)
        numericConstraints(token, s, path, validateConstraints || matching);
      return response ? token : new RawNumber(token);
    }
    if (s.value.kind === 'native-number') {
      if (typeof value !== 'number' || !Number.isFinite(value))
        return bad(path, 'expected a finite number');
      if (!response || matching)
        numericConstraints(numberToken ?? String(value), s, path, validateConstraints || matching);
      return value;
    }
    if (typeof value !== 'number' || !Number.isSafeInteger(value))
      return bad(path, 'expected a safe integer in ±(2^53 − 1)', 'invalid_value');
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
      if (s.propertyNames)
        executeNode(k, s.propertyNames, {
          mode: 'match',
          direction: 'response',
          path: `${path}[${JSON.stringify(k)}]`,
          definitions,
          depth: depth + 1,
          validateConstraints: true,
        });
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
      Object.defineProperty(out, inspectCustom, {
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
            if (error instanceof SdkError && internalKind(error) === 'validation') return false;
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
export function isKnownCodec(
  value: unknown,
  codec: CodecPlan,
  certificate?: TypeCertificate,
): boolean {
  if (certificate && !certifies(value, certificate)) return false;
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
    if (error instanceof SdkError && internalKind(error) === 'validation') return false;
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
  if (schema?.sensitive) return '[REDACTED]';
  if (schema?.reference) {
    const target = definitions[schema.reference];
    return target
      ? redactCodec(value, target, fields, definitions, depth + 1)
      : '[Unresolved model]';
  }
  const shapes = (s?: CodecPlan): CodecPlan[] =>
    s?.reference
      ? [s, ...shapes(definitions[s.reference])]
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
  if (value instanceof ParsedNumber) return value;
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
export type InputValue<T> = [T] extends [undefined]
  ? T
  :
      | T
      | Model<T>
      | (T extends Date
          ? never
          : T extends readonly (infer Item)[]
            ? InputValue<Item>[]
            : T extends object
              ? { [Key in keyof T]: InputValue<T[Key]> }
              : never);
const modelInputs = new WeakMap<object, unknown>();
class CompiledModel<T = unknown> {
  private readonly value: T;
  private readonly codec: CodecPlan;
  constructor(
    value: InputValue<T>,
    codec: CodecPlan,
    private readonly dynamicCodec?: () => CodecPlan,
  ) {
    this.codec = codec;
    const unwrap = (v: any, depth = 0): any => {
      if (depth > 256)
        bad('value', 'value exceeds the supported nesting depth or contains a cycle');
      if (v instanceof CompiledModel) return unwrap(v.toJSON(), depth + 1);
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
  [inspectCustom]() {
    return redactCodec(this.value, this.dynamicCodec ? this.dynamicCodec() : this.codec);
  }
}
/** Public schema adapter; compiled factories use the same model executor. */
export class Model<T = unknown> extends CompiledModel<T> {
  constructor(value: InputValue<T>, schema: Schema);
  constructor(value: InputValue<T>, schema: Schema, compiled?: CodecPlan) {
    super(
      value,
      compiled ?? compileCodec(schema),
      compiled ? undefined : () => compileCodec(schema),
    );
  }
  static [Symbol.hasInstance](value: unknown): boolean {
    return this === Model
      ? value instanceof CompiledModel
      : Function.prototype[Symbol.hasInstance].call(this, value);
  }
}
export function isModel(value: unknown): value is Model {
  return value instanceof CompiledModel;
}
/** Internal input copy for argument adapters; not exported by the SDK entrypoint. */
export function modelInputValue(model: Model): unknown {
  // Positional arguments must retain numeric kinds while separating body and
  // parameter fields. The public toJSON representation deliberately uses strings.
  const copy = (value: unknown): unknown => {
    if (value instanceof ParsedNumber) return new ExactNumber(value.value);
    if (Array.isArray(value)) return value.map(copy);
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, copy(child)]));
    return value;
  };
  return copy(modelInputs.get(model) ?? model.toJSON());
}
/** Internal factory; does not expand the public Model class method surface. */
export function modelFromCodec<T>(value: InputValue<T>, codec: CodecPlan): Model<T> {
  return new CompiledModel(value, codec);
}
const field = (value: any, path: string): any =>
  path
    .split('.')
    .reduce(
      (v, key) =>
        v !== null &&
        typeof v === 'object' &&
        !(v instanceof ParsedNumber) &&
        (!Array.isArray(v) || /^(?:0|[1-9]\d*)$/.test(key)) &&
        Object.hasOwn(v, key)
          ? v[key]
          : undefined,
      value,
    );
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
function settleCallError(error: SdkError, context: ErrorCallContext): void {
  const last = context.observations.at(-1);
  if (error instanceof errors.ApiError && last?.state === 'answered') {
    error.outcome = last.inProgress || last.uncertainWrite ? 'unknown' : 'response';
    error.retryAllowed =
      Boolean(context.replaySafe) &&
      error.status !== 401 &&
      error.status !== 412 &&
      (error.outcome === 'unknown' || last.retryAllowed);
  } else if (
    error instanceof errors.ConnectionError ||
    error instanceof errors.CancelledError ||
    (last && last.state !== 'answered')
  ) {
    error.outcome = context.observations.some(
      (attempt) =>
        attempt.state === 'no_answer' ||
        (attempt.state === 'answered' &&
          ((attempt.status >= 500 && attempt.status < 600) || attempt.inProgress)),
    )
      ? 'unknown'
      : 'not_sent';
    error.retryAllowed =
      (error instanceof errors.ConnectionError || error instanceof errors.CancelledError) &&
      Boolean(context.replaySafe) &&
      error.status !== 401 &&
      error.status !== 412;
  }
}
function stopped(signal?: AbortSignal, outcome: 'unknown' | 'not_sent' = 'unknown') {
  if (signal?.aborted)
    throw createSdkError(
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
      reject(createSdkError('cancelled', 'Local waiting cancelled', 'unknown'));
    };
    signal?.addEventListener('abort', cancel, { once: true });
  });
}
const safeTransportCodes = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EADDRNOTAVAIL',
  'ABORT_ERR',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
]);
function transportCode(cause: unknown): string | undefined {
  const seen = new Set<unknown>();
  while (cause instanceof Error && !seen.has(cause)) {
    seen.add(cause);
    if ('code' in cause && typeof cause.code === 'string' && safeTransportCodes.has(cause.code))
      return cause.code;
    cause = cause.cause;
  }
  return undefined;
}

function parseRetryAfter(instruction: string): number | undefined {
  const value = instruction.replace(/^[ \t]+|[ \t]+$/g, '');
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    const ms = Number(value) * 1000;
    return Number.isFinite(ms) ? ms : undefined;
  }
  if (
    !/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [1-9]\d{3} \d{2}:\d{2}:\d{2} GMT$/.test(
      value,
    )
  )
    return undefined;
  const date = Date.parse(value);
  return Number.isFinite(date) && new Date(date).toUTCString() === value
    ? Math.max(0, date - Date.now())
    : undefined;
}

function clientBaseUrl(baseUrl: unknown): URL {
  if (baseUrl === undefined)
    return bad('baseUrl', 'required: pass baseUrl because this SDK has no default server');
  if (!isBaseUrlSyntax(baseUrl))
    return bad(
      'baseUrl',
      'expected an absolute URL without credentials, whitespace, backslash, query or fragment',
    );
  try {
    return new URL(baseUrl.endsWith('/') ? baseUrl : baseUrl + '/');
  } catch {
    return bad('baseUrl', 'expected a valid absolute URL');
  }
}

function destinationUrl(value: string, base?: string | URL): URL {
  if (/[\\\x00-\x20]/.test(value)) throw createSdkError('destination', 'Invalid destination URL');
  try {
    return new URL(value, base);
  } catch {
    throw createSdkError('destination', 'Invalid destination URL');
  }
}

export type WebhookVerification =
  | { known: true; event: unknown }
  | { known: false; event: unknown; reason: 'unknown_event' | 'unmatched_envelope' };

export interface WebhookVerificationOptions {
  endpointIds?: string | string[];
  secrets?: string | string[];
  jwks?: { keys: object[] };
  baseUrl?: string;
  fetch?: typeof fetch;
  nowSeconds?: number;
}

// JWKS members keep their raw JSON text; only the key selected by kid is fully validated.
type WebhookJwk = { kid: string; members: Map<string, string> };
type WebhookKeySet = { keys: WebhookJwk[]; fetchedAt: number; expiresAt: number };
const webhookKeySets = new Map<string, WebhookKeySet>();
const webhookKeyFlights = new Map<string, Promise<WebhookKeySet>>();
const webhookKeyAttempts = new Map<string, number>();
// After a failed refresh while serving stale keys, wait before blocking requests again.
const webhookKeyRetryAfter = new Map<string, number>();
const webhookRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const webhookKeysUnavailable = (): never => {
  throw createSdkError(
    'webhook',
    'Webhook JWKS unavailable; respond with 5xx so delivery can retry',
    'not_sent',
    false,
    undefined,
    'webhook_jwks_unavailable',
  );
};

function webhookBase64url(value: unknown): Buffer | undefined {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.toString('base64url') === value ? bytes : undefined;
}

/** Index just past the JSON string literal starting at `start` in already-valid JSON. */
function webhookJsonStringEnd(text: string, start: number): number {
  let index = start + 1;
  while (text[index] !== '"') index += text[index] === '\\' ? 2 : 1;
  return index + 1;
}

/** Raw text of each direct member or element of the outer container of already-valid JSON. */
function webhookJsonItems(text: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '"') index = webhookJsonStringEnd(text, index) - 1;
    else if (char === '{' || char === '[') {
      if (depth++ === 0) start = index + 1;
    } else if ((char === ',' && depth === 1) || ((char === '}' || char === ']') && --depth === 0)) {
      const item = text.slice(start, index).trim();
      if (item) items.push(item);
      start = index + 1;
    }
  }
  return items;
}

/** One JSON object with unique direct member names, mapped to raw member text. */
function webhookJsonObject(text: string): Map<string, string> | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!webhookRecord(value)) return undefined;
  const members = new Map<string, string>();
  for (const item of webhookJsonItems(text)) {
    const end = webhookJsonStringEnd(item, 0);
    const name: unknown = JSON.parse(item.slice(0, end));
    if (typeof name !== 'string' || members.has(name)) return undefined;
    members.set(name, item.slice(item.indexOf(':', end) + 1).trim());
  }
  return members;
}

const webhookJsonString = (members: Map<string, string>, name: string): string | undefined => {
  const raw = members.get(name);
  const value: unknown = raw?.startsWith('"') ? JSON.parse(raw) : undefined;
  return typeof value === 'string' ? value : undefined;
};

const webhookJsonInteger = (members: Map<string, string>, name: string): number | undefined => {
  const raw = members.get(name);
  if (raw === undefined || !/^-?(?:0|[1-9][0-9]*)$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
};

/** Validate a JWKS document's shape: unique members, a keys array, and a string kid per key. */
function webhookJwks(text: string): WebhookJwk[] {
  const raw = webhookJsonObject(text)?.get('keys');
  if (!raw?.startsWith('[')) throw new Error('Invalid JWKS');
  return webhookJsonItems(raw).map((item) => {
    const members = webhookJsonObject(item);
    const kid = members && webhookJsonString(members, 'kid');
    if (!members || kid === undefined) throw new Error('Invalid JWK');
    return { kid, members };
  });
}

/**
 * Select the key for kid; other keys, including unsupported key types, are ignored. A duplicate
 * kid makes the trusted set ambiguous; a unique but unusable key fails only the token naming it.
 */
async function webhookSelectKey(
  keys: WebhookJwk[],
  kid: string,
): Promise<CryptoKey | 'unknown' | 'duplicate' | 'unusable'> {
  const matches = keys.filter((key) => key.kid === kid);
  const key = matches[0]?.members;
  if (!key) return 'unknown';
  if (matches.length !== 1) return 'duplicate';
  const x = webhookJsonString(key, 'x');
  const y = webhookJsonString(key, 'y');
  if (
    x === undefined ||
    y === undefined ||
    webhookJsonString(key, 'kty') !== 'EC' ||
    webhookJsonString(key, 'crv') !== 'P-256' ||
    webhookBase64url(x)?.length !== 32 ||
    webhookBase64url(y)?.length !== 32 ||
    (key.has('alg') && webhookJsonString(key, 'alg') !== 'ES256') ||
    (key.has('use') && webhookJsonString(key, 'use') !== 'sig')
  )
    return 'unusable';
  try {
    return await crypto.subtle.importKey(
      'jwk',
      { kty: 'EC', crv: 'P-256', x, y },
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
  } catch {
    return 'unusable';
  }
}

async function webhookFetchKeys(url: string, transport: typeof fetch): Promise<WebhookKeySet> {
  const active = webhookKeyFlights.get(url);
  if (active) return active;
  const flight = (async () => {
    // Publish the flight before invoking a caller-owned transport, which can reenter.
    await Promise.resolve();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('JWKS timeout'));
      }, 5000);
    });
    const work = (async () => {
      const response = await transport(url, {
        signal: controller.signal,
        redirect: 'error',
        credentials: 'omit',
        headers: { accept: 'application/json' },
      });
      if (response.status !== 200 || !response.body) throw new Error('JWKS HTTP failure');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          length += chunk.value.byteLength;
          if (length > 256 * 1024) throw new Error('JWKS response too large');
          chunks.push(chunk.value);
        }
      } finally {
        void reader.cancel().catch(() => {});
      }
      const keys = webhookJwks(
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks)),
      );
      const match = /(?:^|,)\s*max-age\s*=\s*"?(\d+)"?(?=\s*(?:,|$))/i.exec(
        response.headers.get('cache-control') ?? '',
      );
      const ttl = match ? Math.min(86400, Math.max(300, Number(match[1]))) : 900;
      const fetchedAt = Date.now() / 1000;
      return { keys, fetchedAt, expiresAt: fetchedAt + ttl };
    })();
    try {
      const entry = await Promise.race([work, timeout]);
      webhookKeySets.set(url, entry);
      webhookKeyRetryAfter.delete(url);
      return entry;
    } catch {
      const previous = webhookKeySets.get(url);
      const now = Date.now() / 1000;
      if (!previous || now - previous.fetchedAt > 86400) return webhookKeysUnavailable();
      webhookKeyRetryAfter.set(url, now + 60);
      return previous;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
    }
  })();
  webhookKeyFlights.set(url, flight);
  webhookKeyAttempts.set(url, Date.now() / 1000);
  try {
    return await flight;
  } finally {
    webhookKeyFlights.delete(url);
  }
}

async function webhookJwtKey(
  url: string,
  kid: string,
  options: WebhookVerificationOptions,
): Promise<CryptoKey> {
  let key: Awaited<ReturnType<typeof webhookSelectKey>>;
  if (options.jwks !== undefined) {
    const invalidJwks = (): never =>
      webhookError(
        'validation',
        'invalid_input',
        'Webhook jwks must be a JWKS object with a string kid on every key and unique key IDs',
      );
    let keys: WebhookJwk[];
    try {
      keys = webhookJwks(JSON.stringify(options.jwks));
    } catch {
      return invalidJwks();
    }
    key = await webhookSelectKey(keys, kid);
    if (key === 'duplicate') return invalidJwks();
  } else {
    const transport = options.fetch ?? fetch;
    let entry = webhookKeySets.get(url);
    const active = webhookKeyFlights.get(url);
    const now = Date.now() / 1000;
    if (active) entry = await active;
    else if (
      !entry ||
      (entry.expiresAt <= now &&
        (now >= (webhookKeyRetryAfter.get(url) ?? 0) || now - entry.fetchedAt > 86400))
    )
      entry = await webhookFetchKeys(url, transport);
    if (
      !entry.keys.some((key) => key.kid === kid) &&
      Date.now() / 1000 - (webhookKeyAttempts.get(url) ?? -Infinity) >= 60
    )
      entry = await webhookFetchKeys(url, transport);
    key = await webhookSelectKey(entry.keys, kid);
    // Like a malformed trusted set, a duplicate kid is a provider fault and retryable.
    if (key === 'duplicate') return webhookKeysUnavailable();
  }
  // A token naming an unusable key is invalid, never an outage, so forged tokens cannot cause 5xx.
  if (key === 'unusable')
    return webhookError('authentication', 'invalid_token', 'Invalid webhook JWT');
  return key === 'unknown'
    ? webhookError('authentication', 'unknown_key', 'Webhook signing key is unknown')
    : key;
}

/** JWT takes precedence whenever the caller supplies endpoint IDs and a bearer token. */
export async function verifyWebhookAsyncFromPlan(
  source: DescriptorSource | CompiledRuntimePlan,
  rawBody: Uint8Array | ArrayBuffer,
  headers: WebhookHeaders,
  options: WebhookVerificationOptions,
  redactFields: string[] = [],
): Promise<WebhookVerification & { signingMethod: 'jwt' | 'hmac' }> {
  const w = source instanceof DescriptorSource ? source.webhook() : source.webhook;
  if (!w) return bad('webhook', 'capability is not declared');
  if (
    !webhookRecord(options) ||
    Object.keys(options).some(
      (key) => !['endpointIds', 'secrets', 'jwks', 'baseUrl', 'fetch', 'nowSeconds'].includes(key),
    )
  )
    return webhookError('validation', 'invalid_input', 'Supply webhook verification options');
  const strings = (value: unknown): string[] => {
    const values: unknown[] =
      typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
    if (
      !values.length ||
      !values.every((item): item is string => typeof item === 'string' && item.length > 0)
    )
      return webhookError(
        'validation',
        'invalid_input',
        'Supply a nonempty string or array of nonempty strings',
      );
    return values;
  };
  const endpointIds = options.endpointIds === undefined ? undefined : strings(options.endpointIds);
  const secrets = options.secrets === undefined ? undefined : strings(options.secrets);
  if (!endpointIds && options.secrets === undefined)
    return webhookError('validation', 'invalid_input', 'Supply endpointIds or secrets');
  if (options.fetch !== undefined && typeof options.fetch !== 'function')
    return webhookError('validation', 'invalid_input', 'Webhook fetch must be a function');
  const now = options.nowSeconds === undefined ? Date.now() / 1000 : options.nowSeconds;
  if (typeof now !== 'number' || !Number.isFinite(now) || Math.abs(now) >= 100_000_000_000)
    return webhookError(
      'validation',
      'invalid_input',
      'Webhook nowSeconds must be finite Unix seconds, not milliseconds',
    );
  if (rawBody instanceof ArrayBuffer) rawBody = new Uint8Array(rawBody);
  if (!(rawBody instanceof Uint8Array))
    return webhookError(
      'validation',
      'invalid_input',
      'Webhook body must be original Buffer, Uint8Array or ArrayBuffer bytes',
    );
  // Own the bytes across asynchronous key fetching and signature verification.
  const body = Buffer.from(rawBody);
  const authorization = webhookHeaderValues(headers, w.jwt?.header ?? 'authorization', true);
  const bearer = authorization.some((value) =>
    /(?:^|,)[ \t]*Bearer(?:[ \t]|$)/i.test(value.trim()),
  );
  if (!bearer || !endpointIds) {
    if (
      options.secrets !== undefined &&
      w.algorithm === 'hmac-sha256' &&
      w.header &&
      webhookHeaderValues(headers, w.header, true).length &&
      (w.format === 'timestamped-hex' ||
        (w.timestampHeader && webhookHeaderValues(headers, w.timestampHeader, true).length)) &&
      (w.format !== 'standard-webhooks' ||
        (w.idHeader && webhookHeaderValues(headers, w.idHeader, true).length))
    )
      return {
        ...verifyWebhookFromPlan(source, body, headers, secrets ?? [], now, redactFields),
        signingMethod: 'hmac',
      };
    return webhookError('authentication', 'missing_header', 'Missing webhook signing headers');
  }
  const j = w.jwt;
  if (!j)
    return webhookError('validation', 'invalid_input', 'JWT webhook verification is not declared');
  let issuer: string;
  if (j.issuer === 'baseUrl') {
    if (!isBaseUrlSyntax(options.baseUrl) || !/^https?:/i.test(options.baseUrl))
      return webhookError(
        'validation',
        'invalid_input',
        'Supply a trusted API baseUrl for JWT verification',
      );
    try {
      issuer = new URL(options.baseUrl).origin;
    } catch {
      return webhookError('validation', 'invalid_input', 'Supply a trusted API baseUrl');
    }
  } else issuer = j.issuer;
  const invalid = (): never =>
    webhookError('authentication', 'invalid_token', 'Invalid webhook JWT');
  if (authorization.length !== 1) return invalid();
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(
    authorization[0]?.trim() ?? '',
  );
  if (!match || !match[1] || match[1].length > 16384) return invalid();
  const [encodedHeader, encodedClaims, encodedSignature] = match[1].split('.');
  let jose: Map<string, string> | undefined;
  let claims: Map<string, string> | undefined;
  try {
    const headerBytes = webhookBase64url(encodedHeader);
    const claimBytes = webhookBase64url(encodedClaims);
    if (!headerBytes || !claimBytes) return invalid();
    // Keep a BOM so JSON parsing rejects it, as Go's encoding/json does.
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    jose = webhookJsonObject(decoder.decode(headerBytes));
    claims = webhookJsonObject(decoder.decode(claimBytes));
  } catch {
    return invalid();
  }
  const signature = webhookBase64url(encodedSignature);
  const kid = jose && webhookJsonString(jose, 'kid');
  // Header members are exactly alg, kid and typ; claims are typed as in Flint's reference verifier.
  const jti = claims && webhookJsonString(claims, 'jti');
  const aud = claims && webhookJsonString(claims, 'aud');
  const iat = claims && webhookJsonInteger(claims, 'iat');
  const exp = claims && webhookJsonInteger(claims, 'exp');
  const bodyHash = claims && webhookJsonString(claims, j.bodyHashClaim);
  if (
    !jose ||
    jose.size !== 3 ||
    webhookJsonString(jose, 'alg') !== 'ES256' ||
    webhookJsonString(jose, 'typ') !== j.typ ||
    !kid ||
    !signature ||
    signature.length !== 64 ||
    !claims ||
    webhookJsonString(claims, 'iss') !== issuer ||
    aud === undefined ||
    iat === undefined ||
    exp === undefined ||
    !jti?.trim() ||
    bodyHash === undefined ||
    claims.has('sub')
  )
    return invalid();
  const key = await webhookJwtKey(issuer.replace(/\/$/, '') + j.jwksPath, kid, options);
  try {
    if (
      !(await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        key,
        Uint8Array.from(signature),
        new TextEncoder().encode(encodedHeader + '.' + encodedClaims),
      ))
    )
      return invalid();
  } catch {
    return invalid();
  }
  if (!endpointIds.includes(aud))
    return webhookError(
      'authentication',
      'invalid_audience',
      'Webhook JWT audience does not match this endpoint',
    );
  if (
    iat <= 0 ||
    exp <= iat ||
    exp - iat > Math.min(300, j.lifetimeSeconds) ||
    iat > now + j.leewaySeconds ||
    now >= exp + j.leewaySeconds
  )
    return webhookError(
      'authentication',
      'token_expired',
      'Webhook JWT timestamps are outside the permitted lifetime or leeway',
    );
  const actualHash = webhookBase64url(bodyHash);
  const { createHash, timingSafeEqual } = process.getBuiltinModule('crypto');
  const expectedHash = createHash('sha256').update(body).digest();
  if (
    !actualHash ||
    actualHash.length !== expectedHash.length ||
    !timingSafeEqual(expectedHash, actualHash)
  )
    return webhookError(
      'authentication',
      'body_mismatch',
      'Webhook JWT does not match the original body bytes',
    );
  return { ...decodeWebhookFromPlan(source, body, redactFields), signingMethod: 'jwt' };
}

/** Verify compiled webhook descriptors without constructing an HTTP runtime. */
export function verifyWebhookFromPlan(
  source: DescriptorSource | CompiledRuntimePlan,
  rawBody: Uint8Array | ArrayBuffer,
  headers: WebhookHeaders,
  secrets: string | readonly string[],
  nowSeconds = Date.now() / 1000,
  redactFields: string[] = [],
): WebhookVerification {
  const w = source instanceof DescriptorSource ? source.webhook() : source.webhook;
  if (!w || w.algorithm !== 'hmac-sha256' || !w.header || w.toleranceSeconds === undefined)
    return bad('webhook', 'HMAC capability is not declared');
  if (rawBody instanceof ArrayBuffer) rawBody = new Uint8Array(rawBody);
  if (!(rawBody instanceof Uint8Array))
    return webhookError(
      'validation',
      'invalid_input',
      'Webhook body must be original Buffer, Uint8Array or ArrayBuffer bytes; capture it before JSON parsing',
    );
  if (typeof nowSeconds !== 'number' || !Number.isFinite(nowSeconds))
    return webhookError(
      'validation',
      'invalid_input',
      'Webhook nowSeconds must be a finite Unix timestamp in seconds',
    );
  if (Math.abs(nowSeconds) >= 100_000_000_000)
    return webhookError(
      'validation',
      'invalid_input',
      'Webhook nowSeconds appears to be milliseconds; divide by 1000 to pass Unix seconds',
    );
  const supplied: unknown[] =
    typeof secrets === 'string' ? [secrets] : Array.isArray(secrets) ? Array.from(secrets) : [];
  if (!supplied.length || !supplied.every((secret): secret is string => typeof secret === 'string'))
    return webhookError(
      'validation',
      'invalid_secret',
      'Webhook secrets must be a nonempty string or array of strings',
    );
  const format = w.format ?? 'hex';
  const keys: (string | Buffer)[] = [];
  for (const secret of supplied) {
    if (!secret) continue;
    if (format !== 'standard-webhooks') keys.push(secret);
    else if (/^whsec_[A-Za-z0-9+/]{43}=$/.test(secret)) {
      const key = Buffer.from(secret.slice(6), 'base64');
      if (key.length === 32 && key.toString('base64') === secret.slice(6)) keys.push(key);
    }
  }
  if (!keys.length)
    return webhookError(
      'validation',
      'invalid_secret',
      format === 'standard-webhooks'
        ? 'Webhook secret must be whsec_ followed by canonical base64 encoding of 32 bytes'
        : 'Provide at least one nonempty webhook signing secret',
    );
  const signatures = webhookHeaderValues(headers, w.header);
  let timestamp = '';
  let candidates: string[] = [];
  let prefix = '';
  if (format === 'timestamped-hex') {
    const parts = signatures.flatMap((signature) =>
      signature.split(',').map((part) => part.trim()),
    );
    const timestamps = parts.filter((part) => part.startsWith('t='));
    const signedTimestamp = timestamps[0];
    if (timestamps.length !== 1 || signedTimestamp === undefined)
      return webhookError(
        'authentication',
        'invalid_timestamp',
        'Webhook signature must contain exactly one t= timestamp',
      );
    timestamp = signedTimestamp.slice(2);
    candidates = parts.filter((part) => part.startsWith('v1=')).map((part) => part.slice(3));
  } else {
    if (!w.timestampHeader) return bad('webhook', 'timestamp header is not declared');
    timestamp = webhookScalarHeader(headers, w.timestampHeader, true);
    if (format === 'standard-webhooks') {
      if (!w.idHeader) return bad('webhook', 'ID header is not declared');
      prefix = webhookScalarHeader(headers, w.idHeader) + '.';
      // Fetch combines repeated header lines with commas. The comma inside v1,<digest>
      // belongs to the signature token; commas between versioned tokens delimit values.
      candidates = signatures
        .flatMap((signature) => signature.trim().split(/(?:\s+|,\s*(?=v\d+,))/))
        .filter((part) => part.startsWith('v1,'))
        .map((part) => part.slice(3));
    } else
      candidates = signatures.flatMap((signature) =>
        signature.split(',').map((part) => part.trim()),
      );
  }
  if (!/^\d+$/.test(timestamp) || !Number.isSafeInteger(Number(timestamp)))
    return webhookError(
      'authentication',
      'invalid_timestamp',
      'Webhook timestamp must be an integer Unix timestamp in seconds',
    );
  if (Math.abs(nowSeconds - Number(timestamp)) > w.toleranceSeconds)
    return webhookError(
      'authentication',
      'timestamp_out_of_tolerance',
      'Webhook timestamp is outside the allowed tolerance; check the server clock and delivery age',
    );
  const signed = Buffer.concat([
    Buffer.from(prefix + timestamp + w.separator),
    Buffer.from(rawBody),
  ]);
  const digests = candidates
    .filter((candidate) =>
      format === 'standard-webhooks'
        ? /^[A-Za-z0-9+/]{43}=$/.test(candidate) &&
          Buffer.from(candidate, 'base64').toString('base64') === candidate
        : /^[a-fA-F0-9]{64}$/.test(candidate),
    )
    .map((candidate) => Buffer.from(candidate, format === 'standard-webhooks' ? 'base64' : 'hex'));
  let valid = false;
  const { createHmac, timingSafeEqual } = process.getBuiltinModule('crypto');
  for (const key of keys) {
    const expected = createHmac('sha256', key).update(signed).digest();
    for (const actual of digests) valid = timingSafeEqual(expected, actual) || valid;
  }
  if (!valid)
    return webhookError(
      'authentication',
      'invalid_signature',
      'Invalid webhook signature; check the signing secret and preserve the original request body bytes without reserializing JSON',
    );
  return decodeWebhookFromPlan(source, rawBody, redactFields);
}

function decodeWebhookFromPlan(
  source: DescriptorSource | CompiledRuntimePlan,
  rawBody: Uint8Array,
  redactFields: string[],
): WebhookVerification {
  const decode = (value: unknown, codec: CodecPlan, context: CodecContext): unknown =>
    executeCodec(value, codec, {
      ...context,
      definitions:
        source instanceof DescriptorSource ? source.definitions() : (source.definitions ?? {}),
    });
  const w = source instanceof DescriptorSource ? source.webhook() : source.webhook;
  if (!w) return bad('webhook', 'capability is not declared');
  let event: unknown;
  try {
    event = parseJson(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.from(rawBody)),
      true,
    );
  } catch (cause) {
    throw createSdkError(
      'webhook',
      'Invalid webhook JSON',
      'response',
      false,
      undefined,
      'webhook_invalid_json',
      undefined,
      { cause },
    );
  }
  const eventType = field(event, w.typeField);
  const schema =
    typeof eventType === 'string' && Object.hasOwn(w.events, eventType)
      ? w.events[eventType]
      : undefined;
  // Decode first: malformed declared payloads remain protocol errors. Matching is
  // a separate predicate over the original exact JSON values, not decoded strings.
  let decoded = event;
  if (schema) {
    try {
      decoded = decode(event, schema, {
        mode: 'response',
        path: 'event',
        redactFields: redactFields,
      });
    } catch (cause) {
      if (!(cause instanceof SdkError) || internalKind(cause) !== 'validation') throw cause;
      throw createSdkError(
        'webhook',
        'Invalid webhook payload' +
          (validationFailures.has(cause) ? ': ' + validationFailures.get(cause) : ''),
        'response',
        false,
        undefined,
        undefined,
        undefined,
        { cause },
      );
    }
  }
  let known = false;
  if (schema) {
    try {
      decode(event, schema, {
        mode: 'match',
        direction: 'response',
        path: 'event',
        allowUnknownResponseFields: true,
      });
      known = !w.certificate || certifies(plainNumbers(structuredClone(decoded)), w.certificate);
    } catch (error) {
      if (!(error instanceof SdkError) || internalKind(error) !== 'validation') throw error;
    }
  }
  return known
    ? { event: plainNumbers(decoded), known: true }
    : {
        event: plainNumbers(decoded),
        known: false,
        reason: schema ? 'unmatched_envelope' : 'unknown_event',
      };
}

class CompiledRuntime {
  private readonly streams = new Set<EventStream>();
  async close(): Promise<void> {
    await Promise.all([...this.streams].map((stream) => stream.close()));
  }
  private readonly options: ClientOptions;
  private readonly base: URL;
  private readonly allowed: Set<string>;
  private readonly compiledContract: CompiledRuntimePlan;
  private readonly descriptors: DescriptorSource | undefined;
  private operation(id: string) {
    return this.descriptors
      ? this.descriptors.operation(id)
      : this.contract.operations.find((op) => op.id === id);
  }
  private definitions() {
    return this.descriptors?.definitions() ?? this.contract.definitions ?? {};
  }
  private get contract(): CompiledRuntimePlan {
    // Public source-taking Runtime construction retains caller-owned schemas.
    // Generated clients always supply compiledContract and never enter this adapter.
    return this.dynamicPlan ? this.dynamicPlan() : this.compiledContract;
  }
  constructor(
    compiled: CompiledRuntimePlan | DescriptorSource,
    options: ClientOptions,
    private readonly dynamicPlan?: () => CompiledRuntimePlan,
  ) {
    this.descriptors = compiled instanceof DescriptorSource ? compiled : undefined;
    this.compiledContract = compiled instanceof DescriptorSource ? compiled.settings : compiled;
    if (!this.descriptors) assertRuntimePlan(this.compiledContract);
    if (!options || typeof options !== 'object' || Array.isArray(options))
      bad('options', 'expected a client options object');
    const allowedOptions = new Set([
      'ambientCredentials',
      'baseUrl',
      'token',
      'authMode',
      'credentials',
      'allowedOrigins',
      'allowInsecureHttp',
      'timeoutMs',
      'deadlineMs',
      'maxAttempts',
      'transport',
      'diagnostics',
      'redactFields',
      ...Object.keys(this.compiledContract.authShortcuts ?? {}),
    ]);
    for (const key of Object.keys(options))
      if (!allowedOptions.has(key))
        bad(
          `options.${key}`,
          `unknown client option${key === 'maxRetries' ? '; use maxAttempts (total attempts, including the first)' : '; see ClientOptions for supported keys'}`,
        );
    this.options = copyCredentialOptions(
      options,
      Object.keys(this.compiledContract.authShortcuts ?? {}),
      true,
    );
    this.base = clientBaseUrl(
      options.baseUrl === undefined ? this.compiledContract.defaultBaseUrl : options.baseUrl,
    );
    if (!this.base.hostname || this.base.username || this.base.password)
      bad('baseUrl', 'expected an absolute URL without embedded credentials');
    if (
      this.compiledContract.authentication &&
      options.token !== undefined &&
      !this.compiledContract.authShortcuts?.token
    )
      throw createSdkError(
        'authentication',
        `token is not configured for this SDK; use ${
          Object.keys(this.compiledContract.authShortcuts ?? {})
            .sort()
            .join(', ') || 'authMode and credentials'
        }`,
      );
    this.allowed = new Set(options.allowedOrigins ?? [this.base.origin]);
    this.checkUrl(this.base);
    positive(options.timeoutMs ?? 10000, 'timeoutMs');
    positive(options.deadlineMs ?? 30000, 'deadlineMs');
  }
  [inspectCustom]() {
    return { baseUrl: this.base.origin, credentials: '[REDACTED]' };
  }
  private decode(value: unknown, codec: CodecPlan, context: CodecContext): unknown {
    return executeCodec(value, codec, { ...context, definitions: this.definitions() });
  }
  private decodeProjection(value: unknown, codecs: readonly CodecPlan[], path: string): unknown {
    let failure: unknown;
    for (const codec of codecs) {
      try {
        const decoded = this.decode(value, codec, {
          mode: 'response',
          path,
          redactFields: this.options.redactFields ?? [],
        });
        return plainNumbers(decoded);
      } catch (cause) {
        if (!(cause instanceof SdkError && internalKind(cause) === 'validation')) throw cause;
        failure ??= cause;
      }
    }
    if (!failure) throw new Error('Missing compiled projection codecs');
    throw failure;
  }
  decodePayload(id: string, result: Result<unknown>, path: string[]): unknown {
    const codecs = this.operation(id)?.payloadCodecs;
    const certificate = this.operation(id)?.payloadCertificate;
    let value: unknown =
      codecs?.length && typeof result.raw === 'string' ? parseJson(result.raw, true) : result.data;
    for (const key of path) value = field(value, key);
    try {
      const decoded = codecs?.length
        ? this.decodeProjection(value, codecs, 'response.' + path.join('.'))
        : value;
      if (!certificate || !certifies(decoded, certificate))
        bad('response', 'payload does not fit its public type');
      return decoded;
    } catch (cause) {
      if (!(cause instanceof SdkError && internalKind(cause) === 'validation')) throw cause;
      throw createSdkError(
        'protocol',
        'Response payload does not match a declared alternative',
        'response',
        false,
        result.meta,
        undefined,
        undefined,
        { cause },
        typeof result.raw === 'string' ? result.raw : undefined,
      );
    }
  }
  private validateHeaderValue(value: string, codec: CodecPlan, path: string): void {
    // Simple headers carry scalars or comma-separated scalar arrays. Validate
    // their possible wire interpretations with the request codec, keeping the
    // original header spelling and exact numeric tokens intact.
    const parseScalar = (text: string): unknown =>
      text === 'true' || text === 'false'
        ? text === 'true'
        : exactDecimal.test(text)
          ? new ParsedNumber(text)
          : text;
    const parts = value.split(',');
    let failure: SdkError | undefined;
    for (const candidate of [value, parseScalar(value), parts, parts.map(parseScalar)]) {
      try {
        this.decode(candidate, codec, { mode: 'request', path });
        return;
      } catch (error) {
        if (!(error instanceof SdkError) || internalKind(error) !== 'validation') throw error;
        failure ??= error;
      }
    }
    if (failure) throw failure;
    throw new Error('Header validation did not evaluate a value');
  }
  private checkUrl(url: URL) {
    if (!url.hostname || url.username || url.password || url.hash)
      throw createSdkError(
        'destination',
        'Invalid destination: embedded credentials and fragments are not allowed',
      );
    if (!['https:', 'http:'].includes(url.protocol))
      throw createSdkError('destination', 'Unsupported destination protocol; use HTTPS');
    if (url.protocol === 'http:' && !this.options.allowInsecureHttp)
      throw createSdkError(
        'destination',
        'HTTP is disabled; set allowInsecureHttp: true for deliberate local testing',
      );
    if (!this.allowed.has(url.origin))
      throw createSdkError('destination', 'Destination origin is not in allowedOrigins');
  }
  async request<T = unknown>(
    id: string,
    input: Record<string, unknown> = {},
    options: RequestOptions = {},
    continuation?: string,
  ): Promise<Result<T>> {
    const op = this.operation(id);
    const header = op?.idempotency?.header.toLowerCase();
    const key = header
      ? (options?.idempotencyKey ??
        (op?.idempotency?.auto
          ? (op.idempotency.autoKeyPrefix ?? '') + process.getBuiltinModule('crypto').randomUUID()
          : undefined))
      : undefined;
    const context: ErrorCallContext = {
      attempts: 0,
      requestIds: [],
      observations: [],
      start: performance.now(),
    };
    try {
      return await this.executeRequest<T>(
        id,
        input,
        typeof key === 'string' && options && typeof options === 'object' && !Array.isArray(options)
          ? {
              ...copyCredentialOptions(
                options,
                Object.keys(this.contract.authShortcuts ?? {}),
                false,
              ),
              idempotencyKey: key,
            }
          : options,
        continuation,
        context,
      );
    } catch (error) {
      if (error instanceof SdkError) {
        error.attempts = context.attempts;
        error.requestIds = [...context.requestIds];
        error.durationMs = performance.now() - context.start;
        if (context.lastResponse) {
          error.status = context.lastResponse.status;
          error.headers = context.lastResponse.headers;
          if (context.lastResponse.requestId !== undefined)
            error.requestId = context.lastResponse.requestId;
          if (context.retryAfterMs !== undefined) error.retryAfterMs = context.retryAfterMs;
        }
        settleCallError(error, context);
        error.operation = op ? op.resource + '.' + op.method : id;
        if (typeof key === 'string') error.idempotencyKey = key;
      }
      throw error;
    }
  }
  private async executeRequest<T = unknown>(
    id: string,
    input: Record<string, unknown> = {},
    options: RequestOptions = {},
    continuation?: string,
    context: ErrorCallContext = {
      attempts: 0,
      requestIds: [],
      observations: [],
      start: performance.now(),
    },
  ): Promise<Result<T>> {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      bad('input', 'expected an object');
    if (!options || typeof options !== 'object' || Array.isArray(options))
      bad('options', 'expected an object');
    const requestCredentialsPassed = credentialOptionsPassed(
      options,
      Object.keys(this.contract.authShortcuts ?? {}),
      false,
    );
    const clientCredentialsPassed = credentialOptionsPassed(
      this.options,
      Object.keys(this.contract.authShortcuts ?? {}),
      true,
    );
    const { apiVersion } = this.contract;
    const op = this.operation(id);
    if (!op) return bad('operation', 'operation is not included in this SDK');
    const start = performance.now();
    const deadline =
      start +
      positive(
        options.deadlineMs ?? this.options.deadlineMs ?? op.defaults?.deadlineMs ?? 30000,
        'deadlineMs',
      );
    const timeout = positive(
      options.timeoutMs ?? this.options.timeoutMs ?? op.defaults?.timeoutMs ?? 10000,
      'timeoutMs',
    );
    if (options.streamIdleTimeoutMs !== undefined)
      positive(options.streamIdleTimeoutMs, 'streamIdleTimeoutMs');
    if (options.streamLifetimeMs !== undefined)
      positive(options.streamLifetimeMs, 'streamLifetimeMs');
    const policy = op.retry;
    const budget = options.maxAttempts ?? this.options.maxAttempts ?? policy.maxAttempts;
    if (!Number.isSafeInteger(budget) || budget < 1)
      bad('maxAttempts', 'must be a positive safe integer');
    let attempts = Math.min(budget, policy.maxAttempts);
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
      headers[name.toLowerCase()] = value;
    };
    const basePath = this.base.pathname.replace(/\/$/, '');
    if (!continuation && basePath && (op.path === basePath || op.path.startsWith(basePath + '/')))
      bad('baseUrl', 'already includes the operation base path; remove that path from baseUrl');
    let path = op.path;
    const query: string[] = [];
    for (const p of op.parameters) {
      if (p.source === 'authentication') {
        if (Object.hasOwn(input, p.name))
          bad(p.name, 'supply this header through authentication options');
        continue;
      }
      if (p.source === 'request-option') {
        if (Object.hasOwn(input, p.name)) bad(p.name, 'supply this header through request options');
        continue;
      }
      let value = Object.hasOwn(input, p.name) ? input[p.name] : undefined;
      if (p.in === 'header' && op.idempotency?.header.toLowerCase() === p.name.toLowerCase()) {
        if (Object.hasOwn(input, p.name))
          bad(p.name, 'supply this header through options.idempotencyKey');
        value = options.idempotencyKey;
      }
      if (
        p.in === 'header' &&
        apiVersion?.header.toLowerCase() === p.name.toLowerCase() &&
        Object.hasOwn(input, p.name)
      )
        bad(p.name, 'API version is managed by the SDK');
      if (
        p.in === 'header' &&
        [op.conditional?.header, apiVersion?.header].some(
          (header) => header?.toLowerCase() === p.name.toLowerCase(),
        )
      ) {
        // Match the final header precedence before validating the wire value.
        for (const [name, supplied] of Object.entries(options.headers ?? {}))
          if (name.toLowerCase() === p.name.toLowerCase()) value = supplied;
        if (apiVersion?.header.toLowerCase() === p.name.toLowerCase()) value = apiVersion.value;
        if (
          op.conditional?.header.toLowerCase() === p.name.toLowerCase() &&
          options.ifMatch !== undefined
        )
          value = options.ifMatch;
      }
      if (value === undefined) {
        if (p.required)
          bad(
            p.name,
            op.idempotency?.header.toLowerCase() === p.name.toLowerCase()
              ? `${op.resource}.${op.method} requires idempotencyKey; save and reuse the key on retry`
              : 'required parameter is missing',
          );
        continue;
      }
      if (p.scalarArray) {
        if (isModel(value)) value = modelInputValue(value);
        if (!Array.isArray(value)) value = [value];
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
      ? destinationUrl(continuation, this.base)
      : destinationUrl(
          this.base.href.replace(/\/$/, '') + path + (query.length ? '?' + query.join('&') : ''),
        );
    this.checkUrl(url);
    for (const [k, v] of Object.entries(options.headers ?? {})) {
      if (op.idempotency?.header.toLowerCase() === k.toLowerCase())
        bad(k, 'supply this header through options.idempotencyKey');
      setHeader(k, v);
    }
    for (const p of op.parameters) {
      if (p.source !== 'request-option' || !p.requestOption) continue;
      // The descriptor is validated against the option registry before execution.
      const value = (options as Record<string, unknown>)[p.requestOption.node];
      const supplied = headers[p.name.toLowerCase()];
      if (value !== undefined && supplied !== undefined && value !== supplied)
        bad(p.requestOption.node, 'conflicting request option and header values');
      const effective = value === undefined ? supplied : value;
      if (effective !== undefined) {
        const normalized = this.decode(effective, p.codec, {
          mode: 'request',
          path: p.requestOption.node,
        });
        setHeader(p.name, scalar(normalized));
      }
    }
    const suppliedHeaders = { ...headers };
    const ambient = this.contract.defaultCredentials;
    const ambientProvider =
      ambient &&
      this.options.ambientCredentials !== false &&
      !requestCredentialsPassed &&
      !clientCredentialsPassed
        ? configuredDefaultCredentials(ambient, this.base.href)
        : undefined;
    const credentialContext: CredentialContext = {
      baseUrl: this.base.href,
      transport: this.options.transport ?? fetch,
      deadline,
      ...(options.signal ? { signal: options.signal } : {}),
    };
    const providers = new Map<CredentialProvider, () => void>();
    const authenticate = async () => {
      providers.clear();
      if (this.contract.authentication) {
        const permitted = op.authModes ?? [];
        const shortcutAuth = (value: RequestOptions | ClientOptions) => {
          const supplied = Object.entries(this.contract.authShortcuts ?? {}).filter(([key]) =>
            Object.hasOwn(value, key),
          );
          if (
            supplied.length > 1 ||
            (supplied.length && (value.authMode !== undefined || value.credentials !== undefined))
          )
            throw createSdkError(
              'authentication',
              'Use one authentication shortcut or explicit authMode/credentials, not both',
            );
          const entry = supplied[0];
          return entry
            ? {
                mode: entry[1].mode,
                credentials: {
                  [entry[1].scheme]: (
                    value as unknown as Record<string, string | CredentialProvider>
                  )[entry[0]]!,
                },
              }
            : undefined;
        };
        const authHint = (modes: string[], scheme?: string) => {
          const shortcuts = Object.entries(this.contract.authShortcuts ?? {})
            .filter(
              ([, value]) =>
                modes.includes(value.mode) && (scheme === undefined || value.scheme === scheme),
            )
            .map(([key]) => key);
          return shortcuts.length
            ? `pass ${shortcuts.join(' or ')} in client options or request options`
            : scheme !== undefined
              ? `pass credentials.${modes[0]}.${scheme} in client options or credentials.${scheme} in request options, with authMode '${modes[0]}'`
              : `pass authMode (${modes.join(', ')}) and credentials in client options or request options`;
        };
        const clientShortcut = shortcutAuth(this.options);
        const requestShortcut = shortcutAuth(options);
        const defaultMode =
          this.options.authMode ??
          clientShortcut?.mode ??
          (ambientProvider && ambient && permitted.includes(ambient.mode)
            ? ambient.mode
            : undefined);
        let modeName =
          requestShortcut?.mode ?? options.authMode ?? (permitted.length ? defaultMode : undefined);
        if (modeName === undefined && op.authenticated && permitted.length === 1)
          modeName = permitted[0];
        if (modeName === undefined && op.authenticated)
          throw createSdkError(
            'authentication',
            `Authentication is required; ${authHint(permitted)}`,
          );
        const selected =
          modeName === undefined ? undefined : this.contract.authentication[modeName];
        if (modeName !== undefined && (!selected || !permitted.includes(modeName)))
          throw createSdkError(
            'authentication',
            `Authentication mode is not permitted; ${authHint(permitted)}`,
          );
        const expected: Record<string, string> = Object.create(null);
        if (selected && modeName !== undefined) {
          const credentials =
            requestShortcut?.credentials ??
            options.credentials ??
            (clientShortcut?.mode === modeName
              ? clientShortcut.credentials
              : this.options.credentials?.[modeName]);
          for (const scheme of selected.schemes) {
            const source =
              credentials?.[scheme.name] ??
              (credentials === undefined &&
              modeName === ambient?.mode &&
              scheme.name === ambient.scheme
                ? ambientProvider
                : undefined);
            const credential = await resolveCredential(
              source,
              `Missing or invalid credentials; ${authHint([modeName], scheme.name)}`,
              true,
              credentialContext,
              providers,
            );
            expected[scheme.header.toLowerCase()] =
              scheme.type === 'bearer' ? 'Bearer ' + credential : credential;
          }
        }
        for (const mode of Object.values(this.contract.authentication))
          for (const scheme of mode.schemes) {
            const name = scheme.header.toLowerCase();
            if (suppliedHeaders[name] !== undefined && suppliedHeaders[name] !== expected[name])
              throw createSdkError(
                'authentication',
                'Request headers conflict with the selected authentication mode',
              );
          }
        for (const [name, value] of Object.entries(expected)) setHeader(name, value);
      } else if (op.authenticated || (op.optionalAuthentication && this.options.token)) {
        if (!this.options.token || !this.contract.auth)
          throw createSdkError('authentication', 'Explicit API credentials are required');
        const credential = await resolveCredential(
          this.options.token,
          'Explicit API credentials are required',
          false, // Legacy header validation owns newline rejection for strings and providers.
          credentialContext,
          providers,
        );
        setHeader(
          this.contract.auth.header,
          this.contract.auth.type === 'bearer' ? `Bearer ${credential}` : credential,
        );
      }
      if (apiVersion) setHeader(apiVersion.header, apiVersion.value);
      for (const p of op.parameters) {
        if (p.source !== 'authentication') continue;
        const value = headers[p.name.toLowerCase()];
        if (value === undefined) {
          if (p.required)
            bad(
              p.name,
              op.idempotency?.header.toLowerCase() === p.name.toLowerCase()
                ? `${op.resource}.${op.method} requires idempotencyKey; save and reuse the key on retry`
                : 'required parameter is missing',
            );
        } else this.validateHeaderValue(value, p.codec, p.name);
      }
    };
    if (options.ifMatch !== undefined) {
      if (!op.conditional) bad('ifMatch', 'operation does not declare conditional requests');
      setHeader(op.conditional!.header, options.ifMatch);
    }
    const key = options.idempotencyKey;
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
      op.replay === 'safe' ||
      Boolean(op.idempotency && headers[op.idempotency.header.toLowerCase()]);
    context.replaySafe = ['GET', 'HEAD'].includes(op.verb) || Boolean(op.idempotency && key);
    if (!safe) attempts = 1;
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
    const transport =
      this.options.transport ??
      (Object.values(op.responses).some((r) => r.bodyKind === 'sse') ? streamFetch : fetch);
    const requestIds = context.requestIds;
    let credentialRetries = 0;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      stopped(options.signal, attempt === 1 ? 'not_sent' : 'unknown');
      const remaining = deadline - performance.now();
      if (remaining <= 0)
        throw createSdkError(
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
      let retryAfter: number | undefined;
      let error: SdkError | undefined;
      let diagnosticMeta: Metadata | undefined;
      let diagnosticError: InternalErrorKind | undefined;
      try {
        context.attempts = attempt;
        context.observations.push({ state: 'not_sent' });
        await abortable(authenticate(), controller.signal);
        stopped(options.signal);
        if (performance.now() >= deadline)
          throw createSdkError('deadline', 'Overall deadline exceeded');
        context.observations[attempt - 1] = { state: 'no_answer' };
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
          ...(key !== undefined ? { idempotencyKey: key } : {}),
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
        if (meta.requestId) requestIds.push(meta.requestId);
        meta.requestIds = [...requestIds];
        diagnosticMeta = meta;
        const instruction = response.headers.get('retry-after');
        if (instruction) retryAfter = parseRetryAfter(instruction);
        context.lastResponse = meta;
        delete context.retryAfterMs;
        if (retryAfter !== undefined) context.retryAfterMs = retryAfter;
        // Bodyless responses are already complete even if credential refresh stops here.
        if (op.verb === 'HEAD' || response.body === null)
          context.observations[attempt - 1] = {
            state: 'answered',
            status: response.status,
            inProgress: false,
            uncertainWrite: false,
            retryAllowed: false,
          };
        if (response.status === 401 && safe && credentialRetries === 0 && providers.size > 0) {
          diagnosticError = 'authentication';
          try {
            await response.body?.cancel();
          } catch {
            // Cleanup does not establish completion of an unread body.
          }
          try {
            for (const invalidate of providers.values()) invalidate();
          } catch {
            throw createSdkError(
              'authentication',
              'Credential provider invalidation failed',
              'response',
              false,
              meta,
            );
          }
          credentialRetries++;
          attempts++;
          continue;
        }
        const declaredResponse =
          op.responses[String(response.status)] ??
          op.responses.default ??
          (response.ok && op.successJsonFallback
            ? op.responses[op.successJsonFallback]
            : undefined);
        const sse = response.ok && declaredResponse?.bodyKind === 'sse';
        if (
          sse &&
          response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ===
            'text/event-stream' &&
          response.body
        ) {
          const idleTimeoutMs = options.streamIdleTimeoutMs ?? op.stream?.idleTimeoutMs ?? 30000;
          positive(idleTimeoutMs, 'streamIdleTimeoutMs');
          if (options.streamLifetimeMs !== undefined)
            positive(options.streamLifetimeMs, 'streamLifetimeMs');
          const retainConnection = streamConnections.get(response);
          const stream = new EventStream(
            response.body.getReader(),
            meta,
            {
              idleTimeoutMs,
              maxEventBytes: op.stream?.maxEventBytes ?? 1048576,
              ...(retainConnection ? { retainConnection } : {}),
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
          Object.defineProperty(result, inspectCustom, {
            value: () => ({ data: '[Event stream]', meta: inspectedMetadata(meta) }),
          });
          return result as Result<T>;
        }
        // Invalid stream handshakes also need a complete body before they settle the call.
        const bytes = await abortable(response.arrayBuffer(), controller.signal);
        context.observations[attempt - 1] = {
          state: 'answered',
          status: response.status,
          inProgress: false,
          uncertainWrite: false,
          retryAllowed: false,
        };
        if (sse)
          throw createSdkError(
            'protocol',
            'Expected an SSE response stream',
            'response',
            false,
            meta,
          );
        const redirect = op.responses[String(response.status)]?.classification === 'redirect';
        if (response.ok && declaredResponse?.bodyKind === 'binary') {
          const contentType = response.headers
            .get('content-type')
            ?.split(';')[0]
            ?.trim()
            .toLowerCase();
          if (contentType !== declaredResponse.mediaType)
            throw createSdkError(
              'protocol',
              'Unexpected binary response media type',
              'response',
              false,
              meta,
            );
          meta.durationMs = performance.now() - start;
          const data = new Uint8Array(bytes);
          const result = { data, meta, raw: data };
          Object.defineProperty(result, inspectCustom, {
            value: () => ({ data: '[Binary response]', meta: inspectedMetadata(meta) }),
          });
          return result as Result<T>;
        }
        let raw = Buffer.from(bytes).toString('utf8');
        meta.durationMs = performance.now() - start;
        let data: any;
        try {
          raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
          data = raw && !redirect ? parseJson(raw, true) : undefined;
        } catch (cause) {
          if (response.ok)
            throw createSdkError(
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
          throw createSdkError(
            'destination',
            'Redirects are not followed; explicitly configure an approved endpoint',
            'response',
            false,
            meta,
          );
        if (response.ok || response.status === 304 || redirect) {
          const declared = declaredResponse;
          if (!declared)
            throw createSdkError(
              'protocol',
              'Undeclared success status',
              'response',
              false,
              meta,
              undefined,
              undefined,
              undefined,
              raw,
            );
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
            if (op.outputCertificate && !certifies(data, op.outputCertificate))
              throw new Error('Response does not fit its public type');
          } catch (cause) {
            throw createSdkError(
              'protocol',
              'Response cannot be represented by the declared schema' +
                (cause instanceof Error && validationFailures.has(cause)
                  ? ': ' + validationFailures.get(cause)
                  : ''),
              'response',
              false,
              meta,
              undefined,
              undefined,
              { cause },
              raw,
            );
          }
          meta.durationMs = performance.now() - start;
          const result = { data: data as T, meta, raw };
          Object.defineProperty(result, inspectCustom, {
            value: () => ({
              data: redactCodec(
                data,
                declared.codec,
                this.options.redactFields,
                this.definitions(),
              ),
              meta: inspectedMetadata(meta),
            }),
          });
          return result as Result<T>;
        }
        const kind: InternalErrorKind = [401, 403].includes(response.status)
          ? 'authentication'
          : response.status === 429
            ? 'rate_limit'
            : [400, 422].includes(response.status)
              ? 'validation'
              : [409, 412].includes(response.status)
                ? 'conflict'
                : response.status === 404
                  ? 'not_found'
                  : response.status >= 500 && response.status < 600
                    ? 'server'
                    : 'api';
        const mapping = errorMapping(this.contract.errors);
        const object = (body: unknown) =>
          mapping.objectPath ? field(body, mapping.objectPath) : body;
        const envelope = object(data);
        const oauth = !isErrorObject(envelope) && typeof field(data, 'error') === 'string';
        const read = (body: unknown, key: keyof typeof mapping.fields): unknown =>
          oauth
            ? field(
                body,
                key === 'code' ? 'error' : key === 'message' ? 'error_description' : '__absent__',
              )
            : field(object(body), mapping.fields[key]);
        const code = read(data, 'code');
        const originalMessage = read(data, 'message');
        const errorResponse = op.responses[String(response.status)] ?? op.responses.default;
        const codec = errorResponse?.codec;
        const safeBody = redactCodec(data, codec, this.options.redactFields, this.definitions());
        let details: readonly unknown[] = [];
        try {
          const decodedBody = codec
            ? this.decode(safeBody, codec, { mode: 'response', path: 'error' })
            : safeBody;
          const detailsValue = plainNumbers(read(decodedBody, 'details'));
          if (
            Array.isArray(detailsValue) &&
            (!this.contract.errorDetailsCertificate ||
              certifies(detailsValue, this.contract.errorDetailsCertificate))
          )
            details = structuredClone(detailsValue);
        } catch (cause) {
          if (!(cause instanceof SdkError && internalKind(cause) === 'validation')) throw cause;
        }
        const redacted = plainNumbers(safeBody);
        const publicCode = read(redacted, 'code');
        const message = read(redacted, 'message');
        const envelopeId = read(redacted, 'requestId');
        if (!meta.requestId && typeof envelopeId === 'string') {
          meta.requestId = envelopeId;
          requestIds.push(envelopeId);
          meta.requestIds = [...requestIds];
        }
        const signal = this.contract.errors?.retry;
        const retryValue: unknown = signal ? field(envelope, signal.path) : undefined;
        const eligible =
          safe &&
          response.status !== 412 &&
          (signal
            ? typeof retryValue === 'string'
              ? signal.retryValues.includes(retryValue)
              : policy.statuses.includes(response.status)
            : policy.statuses.includes(response.status) ||
              (typeof code === 'string' &&
                (policy.errors ?? []).some(
                  (rule) => rule.status === response.status && rule.codes.includes(code),
                )));
        error = createSdkError(
          kind,
          typeof originalMessage === 'string' &&
            originalMessage.trim() &&
            typeof message === 'string'
            ? message
            : `API returned HTTP ${response.status}`,
          'response',
          response.status !== 401 && eligible,
          meta,
          typeof code === 'string' && code.trim() && typeof publicCode === 'string'
            ? publicCode
            : 'http_error',
          details,
          undefined,
          raw,
        );
        if (error instanceof errors.ApiError) {
          error.body = redacted;
          for (const key of ['type', 'param', 'errorSource', 'docUrl', 'requestLogUrl'] as const) {
            const value = read(redacted, key);
            if (typeof value === 'string') error[key] = value;
          }
          const remediation = read(redacted, 'remediation');
          if (isErrorObject(remediation)) {
            const mapped = { ...remediation };
            if (
              mapped.retry !== undefined &&
              (typeof mapped.retry !== 'string' ||
                !['same_request', 'after_refresh', 'none'].includes(mapped.retry))
            )
              delete mapped.retry;
            error.remediation = mapped;
          }
        }
        const reasons = field(envelope, mapping.fields.details);
        const inProgress =
          typeof code === 'string' && (this.contract.errors?.inProgressCodes ?? []).includes(code);
        const uncertainWrite =
          !['GET', 'HEAD'].includes(op.verb) &&
          ((response.status >= 500 && response.status < 600) ||
            code === 'IDEMPOTENCY_RECOVERY_REQUIRED' ||
            field(envelope, 'reason') === 'outcome_unknown' ||
            (Array.isArray(reasons) &&
              reasons.some((detail) => field(detail, 'reason') === 'outcome_unknown')));
        const hasEnvelope = isErrorObject(envelope);
        const retryAllowed = signal
          ? (typeof retryValue === 'string' && signal.retryValues.includes(retryValue)) ||
            (!hasEnvelope && policy.statuses.includes(response.status))
          : eligible;
        context.observations[attempt - 1] = {
          state: 'answered',
          status: response.status,
          inProgress,
          uncertainWrite,
          retryAllowed,
        };
        diagnosticError = kind;
        if (retryAfter !== undefined) error.retryAfterMs = retryAfter;
      } catch (cause) {
        if (cause instanceof SdkError) {
          diagnosticError = internalKind(cause);
          throw cause;
        }
        if (diagnosticMeta?.status === 401) {
          diagnosticError = 'authentication';
          throw createSdkError(
            'authentication',
            'API returned HTTP 401',
            'response',
            false,
            diagnosticMeta,
          );
        }
        if (options.signal?.aborted) diagnosticError = 'cancelled';
        stopped(options.signal);
        const code = transportCode(cause);
        const expired = performance.now() >= deadline;
        const timedOut =
          controller.signal.aborted ||
          [
            'ETIMEDOUT',
            'UND_ERR_CONNECT_TIMEOUT',
            'UND_ERR_HEADERS_TIMEOUT',
            'UND_ERR_BODY_TIMEOUT',
          ].includes(code ?? '');
        const notSent: boolean =
          context.observations[attempt - 1]?.state === 'not_sent' ||
          (diagnosticMeta === undefined &&
            ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(code ?? ''));
        if (notSent) context.observations[attempt - 1] = { state: 'not_sent' };
        diagnosticError = expired ? 'deadline' : timedOut ? 'timeout' : 'transport';
        error = createSdkError(
          diagnosticError,
          expired
            ? 'Overall request deadline exceeded; remote outcome is unknown'
            : timedOut
              ? 'Request attempt timed out; remote outcome is unknown'
              : notSent && code === 'ECONNREFUSED'
                ? 'Connection refused; request was not sent'
                : notSent && (code === 'ENOTFOUND' || code === 'EAI_AGAIN')
                  ? 'DNS lookup failed; request was not sent'
                  : 'Transport failed before a usable response; remote outcome is unknown',
          notSent ? 'not_sent' : 'unknown',
          !expired && safe && diagnosticMeta?.status !== 412 && policy.transport,
          diagnosticMeta,
          expired
            ? 'deadline_exceeded'
            : timedOut
              ? 'request_timeout'
              : (code ?? 'transport_failure'),
          { transportCode: code ?? null },
          { cause },
        );
        if (retryAfter !== undefined) error.retryAfterMs = retryAfter;
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
      const d = Math.min(
        policy.baseDelayMs * 2 ** (attempt - credentialRetries - 1),
        policy.maxDelayMs ?? Infinity,
      );
      const wait = Math.max(retryAfter ?? 0, d / 2 + (Math.random() * d) / 2);
      if (performance.now() + wait >= deadline) throw error;
      await delay(wait, options.signal);
    }
    throw new Error('Unreachable retry state');
  }
  async *pages<T = unknown>(
    id: string,
    input: Record<string, unknown> = {},
    options: RequestOptions = {},
  ): AsyncGenerator<Result<T>> {
    const op = this.operation(id);
    if (!op?.pagination) return bad('pagination', 'capability is not declared');
    const p = op.pagination;
    let next: unknown;
    const request = { ...input };
    const limit = options.maxPages ?? 1000;
    const seen = new Set<string>();
    let emptyPages = 0;
    if (!Number.isSafeInteger(limit) || limit < 1)
      bad('maxPages', 'must be a positive safe integer');
    for (let page = 0; page < limit; page++) {
      stopped(options.signal);
      // Each page owns its request deadline; time spent consuming yields is unbounded.
      const result = await this.request<T>(
        id,
        request,
        options,
        p.kind === 'link' && typeof next === 'string' ? next : undefined,
      );
      yield result;
      const sent = p.kind === 'link' ? (next ?? result.meta.url) : request[p.parameter!];
      const previous = sent instanceof CompiledModel ? sent.toJSON() : sent;
      next = field(result.data, p.next);
      if (next === undefined || next === null || next === '') return;
      const values = field(result.data, p.items);
      emptyPages = Array.isArray(values) && values.length === 0 ? emptyPages + 1 : 0;
      if (emptyPages >= 2)
        throw createSdkError(
          'protocol',
          'Pagination returned consecutive empty pages with continuations',
          'response',
          false,
          result.meta,
          'pagination_empty_pages',
        );
      if (p.kind === 'link' && typeof next !== 'string')
        throw createSdkError('protocol', 'Expected a pagination URL', 'response');
      if (p.kind === 'link')
        next = destinationUrl(next as string, result.meta.url ?? this.base).href;
      if (
        seen.has(String(next)) ||
        next === previous ||
        (p.kind === 'offset' && previous !== undefined && String(next) === String(previous)) ||
        (p.kind === 'link' && next === result.meta.url)
      )
        throw createSdkError(
          'protocol',
          'Pagination returned a repeated continuation (cursor cycle)',
          'response',
        );
      if (previous !== undefined) seen.add(String(previous));
      seen.add(String(next));
      if (p.kind !== 'link') request[p.parameter!] = next;
    }
  }
  async *items<T = unknown>(
    id: string,
    input: Record<string, unknown> = {},
    options: RequestOptions = {},
  ): AsyncGenerator<T> {
    const p = this.operation(id)?.pagination;
    if (!p) return bad('pagination', 'capability is not declared');
    const limit = options.maxItems ?? Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(limit) || limit < 1)
      bad('maxItems', 'must be a positive safe integer');
    let count = 0;
    for await (const page of this.pages(id, input, options)) {
      const values = field(page.data, p.items);
      if (!Array.isArray(values))
        throw createSdkError('protocol', 'Pagination items field is not an array', 'response');
      for (const value of values) {
        stopped(options.signal);
        const certificate = this.operation(id)?.itemCertificate;
        if (certificate && !certifies(value, certificate))
          throw createSdkError(
            'protocol',
            'Pagination item does not fit its public type',
            'response',
            false,
            page.meta,
            undefined,
            undefined,
            undefined,
            typeof page.raw === 'string' ? page.raw : undefined,
          );
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
    const op = this.operation(id);
    const p = op?.polling;
    if (!p) return bad('polling', 'capability is not declared');
    const deadline =
      performance.now() +
      positive(
        options.deadlineMs ?? this.options.deadlineMs ?? op?.defaults?.deadlineMs ?? 30000,
        'deadlineMs',
      );
    let interval = p.intervalMs;
    for (;;) {
      const remaining = deadline - performance.now();
      if (remaining <= 0)
        throw createSdkError(
          'deadline',
          'Polling deadline exceeded; remote operation may still be running',
          'unknown',
        );
      const result = await this.request<T>(id, input, {
        ...copyCredentialOptions(options, Object.keys(this.contract.authShortcuts ?? {}), false),
        deadlineMs: remaining,
      });
      const state = field(result.data, p.state);
      if (p.success.includes(state)) return result;
      if (p.failure.includes(state))
        throw createSdkError(
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
    rawBody: Uint8Array | ArrayBuffer,
    headers: WebhookHeaders,
    secrets: string | readonly string[],
    nowSeconds?: number,
  ): WebhookVerification {
    return verifyWebhookFromPlan(
      this.descriptors ?? this.contract,
      rawBody,
      headers,
      secrets,
      nowSeconds,
      this.options.redactFields ?? [],
    );
  }

  verifyWebhookAsync(
    rawBody: Uint8Array | ArrayBuffer,
    headers: WebhookHeaders,
    options: WebhookVerificationOptions,
  ): Promise<WebhookVerification & { signingMethod: 'jwt' | 'hmac' }> {
    return verifyWebhookAsyncFromPlan(
      this.descriptors ?? this.contract,
      rawBody,
      headers,
      { baseUrl: this.base.origin, fetch: this.options.transport ?? fetch, ...options },
      this.options.redactFields ?? [],
    );
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

/** Public dynamic-contract adapter; generated clients never retain this compiler path. */
export class Runtime extends CompiledRuntime {
  static [Symbol.hasInstance](value: unknown): boolean {
    return this === Runtime
      ? value instanceof CompiledRuntime
      : Function.prototype[Symbol.hasInstance].call(this, value);
  }

  constructor(contract: RuntimeContract, options: ClientOptions);
  constructor(
    contract: RuntimeContract,
    options: ClientOptions,
    compiled?: CompiledRuntimePlan | DescriptorSource,
  ) {
    super(
      compiled ?? compileRuntimePlan(contract),
      options,
      compiled ? undefined : () => compileRuntimePlan(contract),
    );
  }
}
/** Internal factory for generated clients; public Runtime construction remains schema-based. */
export function runtimeFromPlan(
  contract: CompiledRuntimePlan | DescriptorSource,
  options: ClientOptions,
): Runtime {
  return new CompiledRuntime(contract, options);
}
