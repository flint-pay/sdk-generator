import { assertTypeCertificate, type TypeCertificate } from './type-certificate.js';
import { stable } from './canonical.js';
import { requestOption, REQUEST_OPTIONS } from './request-options.js';
import { assertPhpRepresentation, type PhpRepresentation } from './php-value-plan.js';
export const AUTH_SHORTCUT_RESERVED = new Set([
  ...'ambientCredentials credentialCache baseUrl token authMode credentials headers idempotencyKey ifMatch timeoutMs deadlineMs maxAttempts signal cancellation maxPages maxItems streamIdleTimeoutMs streamLifetimeMs allowedOrigins allowInsecureHttp transport diagnostics redactFields constructor prototype __proto__ withDeadline this'
    .toLowerCase()
    .split(' '),
  ...Object.values(REQUEST_OPTIONS).flatMap((option) => [
    option.node.toLowerCase(),
    option.php.toLowerCase(),
  ]),
]);
/** token reuses the legacy client field, but may explicitly select a composed mode. */
export function isAuthShortcutName(name: string): boolean {
  return (
    /^[a-z][a-zA-Z0-9]*$/.test(name) &&
    (name === 'token' || !AUTH_SHORTCUT_RESERVED.has(name.toLowerCase()))
  );
}

/** Reject malformed authorities before URL parsers can repair them. */
export function isBaseUrlSyntax(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[a-z][a-z0-9+.-]*:\/\/[^/@]+(?:\/|$)/i.test(value) &&
    !/[\\\s\x00-\x1f\x7f{}?#]/.test(value)
  );
}

/** Static server defaults must be usable without an input-document origin or variables. */
export function isDefaultBaseUrl(value: unknown): value is string {
  if (!isBaseUrlSyntax(value) || !/^https?:/i.test(value)) return false;
  try {
    const url = new URL(value);
    return Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}
/** One owner for configuration diagnostics and restored Node descriptor validation. */
export function webhookJwtIssue(value: unknown): { field: string; message: string } | undefined {
  const issue = (field: string, message: string) => ({ field, message });
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return issue('', 'expected a JWT signing object');
  const j: Record<string, unknown> = Object.fromEntries(Object.entries(value));
  const fields = [
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
  ];
  for (const key of Object.keys(j))
    if (!fields.includes(key)) return issue(key, 'unknown JWT setting');
  if (typeof j.header !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(j.header))
    return issue('header', 'expected an HTTP header name');
  if (j.algorithm !== 'ES256')
    return issue(
      'algorithm',
      'unsupported JWT algorithm ' + String(j.algorithm) + '; expected ES256',
    );
  if (j.scheme !== 'Bearer') return issue('scheme', 'expected Bearer');
  for (const name of ['typ', 'bodyHashClaim'])
    if (typeof j[name] !== 'string' || !j[name] || /[\s\x00-\x1f\x7f]/.test(j[name]))
      return issue(name, 'expected a nonempty token');
  if (j.issuer !== 'baseUrl' && (!isDefaultBaseUrl(j.issuer) || !/^https:/i.test(j.issuer)))
    return issue(
      'issuer',
      'expected baseUrl or a literal HTTPS URL without credentials, query or fragment',
    );
  if (
    typeof j.jwksPath !== 'string' ||
    !/^\/(?!\/)[A-Za-z0-9/._~-]+$/.test(j.jwksPath) ||
    j.jwksPath.split('/').some((part) => part === '.' || part === '..')
  )
    return issue('jwksPath', 'expected an absolute path on the trusted issuer');
  if (j.bodyHashEncoding !== 'base64url') return issue('bodyHashEncoding', 'expected base64url');
  if (
    typeof j.lifetimeSeconds !== 'number' ||
    !Number.isInteger(j.lifetimeSeconds) ||
    j.lifetimeSeconds < 1 ||
    j.lifetimeSeconds > 3600
  )
    return issue('lifetimeSeconds', 'expected an integer from 1 to 3600');
  if (
    typeof j.leewaySeconds !== 'number' ||
    !Number.isInteger(j.leewaySeconds) ||
    j.leewaySeconds < 0 ||
    j.leewaySeconds > 60
  )
    return issue('leewaySeconds', 'expected an integer from 0 to 60');
  return undefined;
}

import type {
  Operation,
  Retry,
  Schema,
  Auth,
  Webhook,
  WebhookSigning,
  Config,
  IncomingWebhook,
  AuthenticationMode,
  AuthShortcuts,
  DefaultCredentials,
  Parameter,
} from './contract.js';
import {
  compileCodec,
  assertCodecPlan,
  CODEC_FORMAT,
  CODEC_SEMANTICS,
  type CodecPlan,
} from './codec-plan.js';

/** Declared success statuses; default remains a runtime fallback, never an implicit redirect. */
export function successStatus(status: string): boolean {
  return /^2\d\d$/.test(status) || ['302', '307', '304'].includes(status);
}

export interface RuntimeContract {
  defaultBaseUrl?: string;
  userAgent?: string;
  validation?: Config['validation'];
  operations: Operation[];
  incoming?: IncomingWebhook[];
  definitions?: Record<string, Schema>;
  auth?: Auth;
  authentication?: Record<string, AuthenticationMode>;
  authShortcuts?: AuthShortcuts;
  defaultCredentials?: DefaultCredentials;
  apiVersion?: { header: string; value: string };
  webhook?: Webhook;
  money?: { currencies: Record<string, number> };
  errors?: Config['errors'];
}

/** Headers supplied by the client have no independent operation input value. */
export function parameterSource(
  op: Operation,
  parameter: Pick<Parameter, 'in' | 'name' | 'x-flint-request-option'>,
  settings: Pick<RuntimeContract, 'auth' | 'authentication' | 'apiVersion'>,
): 'input' | 'authentication' | 'api-version' | 'request-option' | 'idempotency' {
  if (parameter['x-flint-request-option'] !== undefined) return 'request-option';
  if (parameter.in !== 'header') return 'input';
  const name = parameter.name.toLowerCase();
  if (settings.apiVersion?.header.toLowerCase() === name) return 'api-version';
  if (op.idempotency?.header.toLowerCase() === name) return 'idempotency';
  if (
    op.authModes?.some((mode) =>
      settings.authentication?.[mode]?.schemes.some(
        (scheme) => scheme.header.toLowerCase() === name,
      ),
    ) ||
    (settings.auth?.header.toLowerCase() === name &&
      (op.authenticated || op.optionalAuthentication))
  )
    return 'authentication';
  return 'input';
}

/** Shared defaults also rendered into the PHP dynamic-contract adapter. */
export const RETRY_DEFAULTS = {
  safeMethods: ['GET', 'HEAD', 'OPTIONS'],
  read: {
    maxAttempts: 3,
    statuses: [408, 429, 500, 502, 503, 504],
    transport: true,
    baseDelayMs: 100,
  },
  mutation: { maxAttempts: 1, statuses: [], transport: false, baseDelayMs: 100 },
};
export const RETRY_SEMANTICS = 'budgets-2';

/** Required option typing follows the declared header, independently of retry policy. */
export function requiresIdempotencyKey(op: Pick<Operation, 'idempotency' | 'parameters'>): boolean {
  return Boolean(
    op.idempotency &&
      !op.idempotency.auto &&
      op.parameters.some(
        (parameter) =>
          parameter.in === 'header' &&
          parameter.required &&
          parameter.name.toLowerCase() === op.idempotency?.header.toLowerCase(),
      ),
  );
}

export function compileRetry(op: Pick<Operation, 'verb' | 'retry'>): {
  retry: Retry;
  replay: 'safe' | 'idempotency';
} {
  const safe = RETRY_DEFAULTS.safeMethods.includes(op.verb);
  const policy: Retry = op.retry ?? (safe ? RETRY_DEFAULTS.read : RETRY_DEFAULTS.mutation);
  return {
    replay: safe ? 'safe' : 'idempotency',
    retry: {
      ...policy,
      statuses: [...policy.statuses],
      ...(policy.errors
        ? { errors: policy.errors.map((rule) => ({ ...rule, codes: [...rule.codes] })) }
        : {}),
    },
  };
}

export interface CompiledOperation
  extends Omit<Operation, 'parameters' | 'body' | 'responses' | 'streamEventSchemas' | 'retry'> {
  retry: Retry;
  replay: 'safe' | 'idempotency';
  streamEventCodecs?: Record<string, CodecPlan>;
  /** Node payload unions must decode to one of their declared projected shapes. */
  payloadCodecs?: CodecPlan[];
  outputCertificate?: TypeCertificate;
  payloadCertificate?: TypeCertificate;
  itemCertificate?: TypeCertificate;
  parameters: (Omit<Operation['parameters'][number], 'schema'> & {
    codec: CodecPlan;
    /** Absent in historical descriptors and for ordinary input parameters. */
    source?: 'authentication' | 'request-option';
    requestOption?: { node: string; php: string };
  })[];
  body?: CodecPlan;
  /** Sole JSON 2xx declaration eligible for an otherwise undeclared success. */
  successJsonFallback?: string;
  responses: Record<
    string,
    Omit<Operation['responses'][string], 'schema'> & {
      codec?: CodecPlan;
      phpRepresentation?: PhpRepresentation;
      model?: string;
      variants?: Record<string, string>;
    }
  >;
}

export interface CompiledRuntimePlan
  extends Omit<RuntimeContract, 'operations' | 'definitions' | 'webhook' | 'incoming'> {
  errorDetailsCertificate?: TypeCertificate;
  format: typeof CODEC_FORMAT;
  semantics: string;
  retrySemantics?: typeof RETRY_SEMANTICS | 'budgets-1';
  operations: CompiledOperation[];
  incoming?: (Omit<IncomingWebhook, 'schema'> & { codec: CodecPlan })[];
  definitions?: Record<string, CodecPlan>;
  webhook?: WebhookSigning & {
    typeField: string;
    certificate?: TypeCertificate;
    events: Record<string, CodecPlan>;
    eventModels?: Record<string, string>;
  };
}

/** The registry supplies both executors with the same mandatory codec. */
export function compileRequestOption(value: unknown, path: string) {
  const option = requestOption(value, path);
  return {
    node: option.node,
    php: option.php,
    codec: option.codec,
  };
}

/** Provider policy is resolved here; transports receive only explicit operation descriptors. */
export function compileRuntimePlan(contract: RuntimeContract): CompiledRuntimePlan {
  const root = (schema: Schema): CodecPlan => ({
    ...compileCodec(schema),
    constraints: contract.validation !== 'encoding',
  });
  const { operations, definitions, webhook, incoming, ...settings } = contract;
  return {
    ...settings,
    format: CODEC_FORMAT,
    semantics: CODEC_SEMANTICS,
    retrySemantics: RETRY_SEMANTICS,
    ...(incoming
      ? {
          incoming: incoming.map(({ schema, ...declaration }) => ({
            ...declaration,
            codec: root(schema),
          })),
        }
      : {}),
    operations: operations.map((op) => {
      const { parameters, body, responses, streamEventSchemas, ...operation } = op;
      const jsonSuccesses = Object.entries(responses).filter(
        ([status, response]) =>
          status.length === 3 &&
          /^2\d\d$/.test(status) &&
          (response.bodyKind ?? (response.schema ? 'json' : 'empty')) === 'json',
      );
      const successJsonFallback = jsonSuccesses.length === 1 ? jsonSuccesses[0]?.[0] : undefined;
      return {
        ...operation,
        ...compileRetry(op),
        ...(successJsonFallback === undefined ? {} : { successJsonFallback }),
        ...(streamEventSchemas
          ? {
              streamEventCodecs: Object.fromEntries(
                Object.entries(streamEventSchemas).map(([name, schema]) => [name, root(schema)]),
              ),
            }
          : {}),
        parameters: parameters.map(({ schema, ...parameter }) => {
          const extension = parameter['x-flint-request-option'];
          if (extension !== undefined) {
            const option = compileRequestOption(extension, op.id + '.parameters.' + parameter.name);
            if (parameter.in !== 'header' || parameter.required)
              throw new Error(
                op.id + ': x-flint-request-option requires an optional header parameter',
              );
            return {
              ...parameter,
              source: 'request-option' as const,
              requestOption: { node: option.node, php: option.php },
              // Request-option validity is mandatory even with validation: encoding.
              codec: option.codec,
            };
          }
          return {
            ...parameter,
            codec: root(schema),
            ...(parameterSource(op, parameter, contract) === 'authentication'
              ? { source: 'authentication' as const }
              : {}),
          };
        }),
        ...(body ? { body: root(body) } : {}),
        responses: Object.fromEntries(
          Object.entries(responses).map(([status, { schema, ...response }]) => [
            status,
            {
              ...response,
              bodyKind: response.bodyKind ?? (schema ? 'json' : 'empty'),
              classification:
                response.classification ??
                (successStatus(status)
                  ? ['302', '307'].includes(status)
                    ? 'redirect'
                    : 'success'
                  : 'error'),
              ...(schema ? { codec: root(schema) } : {}),
            },
          ]),
        ),
      };
    }),
    ...(definitions
      ? {
          definitions: Object.fromEntries(
            Object.entries(definitions).map(([name, schema]) => [name, compileCodec(schema)]),
          ),
        }
      : {}),
    ...(webhook
      ? {
          webhook: {
            ...webhook,
            events: Object.fromEntries(
              Object.entries(webhook.events).map(([name, schema]) => [name, root(schema)]),
            ),
          },
        }
      : {}),
  };
}

/** Owns discovery declaration validation for configuration and serialized runtime plans. */
export function assertDefaultCredentials(
  value: unknown,
  authentication: unknown,
): asserts value is DefaultCredentials {
  const record = (value: unknown, path: string): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error(path + ': expected an object');
    return value as Record<string, unknown>;
  };
  const keys = (value: Record<string, unknown>, allowed: string[]) => {
    if (Object.keys(value).some((key) => !allowed.includes(key)))
      throw new Error('unknown defaultCredentials field');
  };
  const d = record(value, 'defaultCredentials');
  keys(d, ['mode', 'scheme', 'environment', 'workloadIdentity']);
  const modes = record(authentication, 'authentication');
  const mode =
    typeof d.mode === 'string' && Object.hasOwn(modes, d.mode)
      ? record(modes[d.mode], 'mode')
      : undefined;
  const schemes = mode?.schemes;
  if (
    typeof d.scheme !== 'string' ||
    !Array.isArray(schemes) ||
    schemes.length !== 1 ||
    record(schemes[0], 'scheme').name !== d.scheme ||
    record(schemes[0], 'scheme').type !== 'bearer'
  )
    throw new Error('default credentials must target the sole bearer scheme of a declared mode');
  const environment = record(d.environment, 'environment');
  const identity = record(d.workloadIdentity, 'workloadIdentity');
  keys(environment, ['apiKey', 'token']);
  keys(identity, ['tokenPath', 'credentialParameter', 'envPrefix']);
  for (const entry of [environment.apiKey, environment.token, identity.envPrefix])
    if (typeof entry !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(entry))
      throw new Error('declare environment names and prefix');
  if (environment.apiKey === environment.token)
    throw new Error('API key and token variables must differ');
  if (
    typeof identity.tokenPath !== 'string' ||
    !/^\/(?!\/)[A-Za-z0-9/_-]+$/.test(identity.tokenPath)
  )
    throw new Error('declare an absolute token path without an origin, query or fragment');
  if (
    typeof identity.credentialParameter !== 'string' ||
    !/^[a-z][a-z0-9_]*$/.test(identity.credentialParameter) ||
    [
      'grant_type',
      'subject_token',
      'subject_token_type',
      'requested_token_type',
      'scope',
      'client_id',
      'client_secret',
      'audience',
      'resource',
      'actor_token',
    ].includes(identity.credentialParameter)
  )
    throw new Error('declare a distinct credential form parameter');
}

export function assertRuntimePlan(
  value: unknown,
  historical = false,
): asserts value is CompiledRuntimePlan {
  function record(value: unknown, path: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error(path + ': invalid compiled runtime record');
    return value as Record<string, unknown>;
  }
  const plan = record(value, 'runtime');
  if (plan.errorDetailsCertificate !== undefined)
    assertTypeCertificate(plan.errorDetailsCertificate);
  if (plan.defaultBaseUrl !== undefined && !isDefaultBaseUrl(plan.defaultBaseUrl))
    throw new Error('Invalid defaultBaseUrl in compiled runtime');
  if (plan.format !== CODEC_FORMAT || typeof plan.semantics !== 'string')
    throw new Error('Unsupported compiled runtime format');
  const legacyRetry = historical && plan.retrySemantics === undefined;
  if (
    !legacyRetry &&
    !(historical && plan.retrySemantics === 'budgets-1') &&
    plan.retrySemantics !== RETRY_SEMANTICS
  )
    throw new Error('Unsupported compiled retry semantics');
  if (plan.errors !== undefined) {
    const errors = record(plan.errors, 'errors');
    if (
      errors.inProgressCodes !== undefined &&
      (!Array.isArray(errors.inProgressCodes) ||
        errors.inProgressCodes.some((code) => typeof code !== 'string' || !code.trim()))
    )
      throw new Error('Invalid compiled in-progress codes');
    if (errors.retry !== undefined) {
      const retry = record(errors.retry, 'errors.retry');
      if (
        typeof errors.codePath !== 'string' ||
        !errors.codePath ||
        typeof retry.path !== 'string' ||
        !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(retry.path) ||
        !Array.isArray(retry.retryValues) ||
        !retry.retryValues.length ||
        retry.retryValues.some((value) => typeof value !== 'string' || !value.trim())
      )
        throw new Error('Invalid compiled error retry signal');
    }
  }
  if (!Array.isArray(plan.operations)) throw new Error('Missing compiled operations');
  if (plan.authentication !== undefined)
    for (const [name, value] of Object.entries(record(plan.authentication, 'authentication'))) {
      const mode = record(value, 'authentication.' + name);
      if (!Array.isArray(mode.schemes) || !mode.schemes.length)
        throw new Error('Invalid authentication mode');
      const destinations = new Set<string>();
      for (const item of mode.schemes) {
        const scheme = record(item, 'authentication scheme');
        if (
          typeof scheme.name !== 'string' ||
          typeof scheme.header !== 'string' ||
          !['bearer', 'apiKey'].includes(String(scheme.type)) ||
          !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(scheme.header)
        )
          throw new Error('Invalid authentication scheme');
        if (destinations.has(scheme.header.toLowerCase()))
          throw new Error('Conflicting authentication destinations');
        destinations.add(scheme.header.toLowerCase());
      }
    }
  if (plan.defaultCredentials !== undefined)
    assertDefaultCredentials(plan.defaultCredentials, plan.authentication);
  if (plan.authShortcuts !== undefined) {
    for (const [name, value] of Object.entries(record(plan.authShortcuts, 'authShortcuts'))) {
      const shortcut = record(value, 'auth shortcut');
      const modes = record(plan.authentication, 'authentication');
      const mode = typeof shortcut.mode === 'string' ? modes[shortcut.mode] : undefined;
      const schemes = mode && record(mode, 'authentication mode').schemes;
      if (
        !isAuthShortcutName(name) ||
        typeof shortcut.scheme !== 'string' ||
        !Array.isArray(schemes) ||
        schemes.length !== 1 ||
        record(schemes[0], 'authentication scheme').name !== shortcut.scheme
      )
        throw new Error('Invalid authentication shortcut');
    }
  }
  if (plan.incoming !== undefined) {
    if (!Array.isArray(plan.incoming)) throw new Error('Invalid incoming contracts');
    for (const declaration of plan.incoming) {
      const entry = record(declaration, 'incoming');
      for (const key of ['name', 'method', 'pointer', 'model'])
        if (typeof entry[key] !== 'string') throw new Error('Invalid incoming ' + key);
      if (entry.schema !== undefined) throw new Error('Raw schema in incoming contract');
      assertCodecPlan(entry.codec, 'incoming.' + entry.name);
    }
  }
  for (const [index, value] of plan.operations.entries()) {
    const op = record(value, `operations[${index}]`);
    if (
      op.authModes !== undefined &&
      (!Array.isArray(op.authModes) ||
        !op.authModes.every(
          (name) =>
            typeof name === 'string' &&
            plan.authentication &&
            Object.hasOwn(plan.authentication, name),
        ))
    )
      throw new Error('Invalid operation authentication modes');
    if (
      typeof op.id !== 'string' ||
      typeof op.path !== 'string' ||
      typeof op.verb !== 'string' ||
      !Array.isArray(op.parameters)
    )
      throw new Error('Invalid compiled operation');
    if (op.defaults !== undefined) {
      const defaults = record(op.defaults, `${op.id}.defaults`);
      if (
        !Object.keys(defaults).length ||
        Object.entries(defaults).some(
          ([name, value]) =>
            !['timeoutMs', 'deadlineMs'].includes(name) ||
            !Number.isSafeInteger(value) ||
            Number(value) <= 0,
        )
      )
        throw new Error('Invalid compiled operation defaults');
    }
    if (!legacyRetry || op.retry !== undefined) {
      const retry = record(op.retry, `${op.id}.retry`);
      if (
        (!legacyRetry && op.replay !== 'safe' && op.replay !== 'idempotency') ||
        !Number.isInteger(retry.maxAttempts) ||
        Number(retry.maxAttempts) < 1 ||
        Number(retry.maxAttempts) > 10 ||
        !Array.isArray(retry.statuses) ||
        retry.statuses.some(
          (status) =>
            !Number.isInteger(status) ||
            status < 400 ||
            status > 599 ||
            [409, 412].includes(status),
        ) ||
        typeof retry.transport !== 'boolean' ||
        typeof retry.baseDelayMs !== 'number' ||
        !Number.isFinite(retry.baseDelayMs) ||
        retry.baseDelayMs < 0 ||
        (retry.maxDelayMs !== undefined &&
          (typeof retry.maxDelayMs !== 'number' ||
            !Number.isFinite(retry.maxDelayMs) ||
            retry.maxDelayMs < 0)) ||
        (op.replay === 'idempotency' && Number(retry.maxAttempts) > 1 && !op.idempotency)
      )
        throw new Error(`${op.id}: invalid compiled retry policy`);
      if (retry.errors !== undefined) {
        if (!Array.isArray(retry.errors)) throw new Error('Invalid compiled retry errors');
        for (const item of retry.errors) {
          const rule = record(item, 'retry.errors');
          if (
            !Number.isInteger(rule.status) ||
            Number(rule.status) < 400 ||
            Number(rule.status) > 599 ||
            rule.status === 412 ||
            !Array.isArray(rule.codes) ||
            !rule.codes.length ||
            rule.codes.some((code) => typeof code !== 'string' || !code.trim()) ||
            (rule.status === 409 && (!op.idempotency || op.conditional))
          )
            throw new Error('Invalid compiled retry errors');
        }
      }
    }
    if (op.idempotency !== undefined) {
      const idempotency = record(op.idempotency, `${op.id}.idempotency`);
      if (
        idempotency.autoKeyPrefix !== undefined &&
        (typeof idempotency.autoKeyPrefix !== 'string' ||
          /[^\x20-\x7e]/.test(idempotency.autoKeyPrefix) ||
          /^[ ]/.test(idempotency.autoKeyPrefix))
      )
        throw new Error('Invalid compiled automatic key prefix');
    }
    for (const parameter of op.parameters) {
      const field = record(parameter, `${op.id}.parameter`);
      if (
        typeof field.name !== 'string' ||
        !['path', 'query', 'header'].includes(String(field.in)) ||
        field.schema !== undefined ||
        (field.source !== undefined &&
          (!['authentication', 'request-option'].includes(String(field.source)) ||
            field.in !== 'header'))
      )
        throw new Error(`${op.id}: invalid compiled parameter`);
      if (field.source === 'request-option') {
        const option = compileRequestOption(
          field['x-flint-request-option'],
          String(op.id) + '.parameter.' + String(field.name),
        );
        const names = record(field.requestOption, 'requestOption');
        if (
          names.node !== option.node ||
          names.php !== option.php ||
          field.required ||
          stable(field.codec) !== stable(option.codec)
        )
          throw new Error('Invalid compiled request option');
      } else if (
        field.requestOption !== undefined ||
        (!historical && field['x-flint-request-option'] !== undefined)
      )
        throw new Error('Missing compiled request-option source');
      assertCodecPlan(field.codec, `${op.id}.parameter.${field.name}`);
    }
    if (op.body !== undefined) assertCodecPlan(op.body, `${op.id}.body`);
    for (const key of ['outputCertificate', 'payloadCertificate', 'itemCertificate'])
      if (op[key] !== undefined) assertTypeCertificate(op[key]);
    if (op.payloadCodecs !== undefined) {
      if (!Array.isArray(op.payloadCodecs) || !op.payloadCodecs.length)
        throw new Error(`${op.id}: invalid payload codecs`);
      op.payloadCodecs.forEach((codec, index) =>
        assertCodecPlan(codec, `${op.id}.payloadCodecs.${index}`),
      );
    }
    if (op.streamEventSchemas !== undefined)
      throw new Error('Raw stream schemas in compiled operation');
    if (op.streamEventCodecs !== undefined)
      for (const [event, codec] of Object.entries(
        record(op.streamEventCodecs, `${op.id}.streamEventCodecs`),
      ))
        assertCodecPlan(codec, `${op.id}.streamEventCodecs.${event}`);
    if (op.stream !== undefined) {
      const stream = record(op.stream, `${op.id}.stream`);
      for (const key of ['idleTimeoutMs', 'maxEventBytes'])
        if (
          stream[key] !== undefined &&
          (!Number.isSafeInteger(stream[key]) || Number(stream[key]) <= 0)
        )
          throw new Error('Invalid stream limits');
    }
    const responses = record(op.responses, `${op.id}.responses`);
    if (op.successJsonFallback !== undefined) {
      const candidates = Object.entries(responses).filter(
        ([status, response]) =>
          status.length === 3 &&
          /^2\d\d$/.test(status) &&
          record(response, 'response').bodyKind === 'json',
      );
      if (candidates.length !== 1 || candidates[0]?.[0] !== op.successJsonFallback)
        throw new Error('Invalid JSON success fallback');
    }
    for (const [status, response] of Object.entries(responses)) {
      const result = record(response, `${op.id}.responses.${status}`);

      if (
        result.bodyKind !== undefined &&
        !['empty', 'json', 'binary', 'sse'].includes(String(result.bodyKind))
      )
        throw new Error('Unsupported response body kind');
      if (
        result.classification !== undefined &&
        !['success', 'error', 'redirect'].includes(String(result.classification))
      )
        throw new Error('Unsupported response classification');
      if (result.classification === 'redirect' && !['302', '307'].includes(status))
        throw new Error('Invalid redirect status');
      if (result.locationRequired !== undefined && typeof result.locationRequired !== 'boolean')
        throw new Error('Invalid Location requirement');
      if (result.bodyKind === 'json' && result.codec === undefined)
        throw new Error('Missing JSON response codec');
      if (
        result.bodyKind === 'sse' &&
        (result.codec !== undefined || result.mediaType !== 'text/event-stream')
      )
        throw new Error('Invalid SSE response descriptor');
      if (
        result.bodyKind === 'binary' &&
        (result.codec !== undefined || result.mediaType !== 'application/pdf')
      )
        throw new Error('Invalid binary response descriptor');
      if (result.codec !== undefined) assertCodecPlan(result.codec, `${op.id}.responses.${status}`);
      if (result.schema !== undefined) throw new Error('Raw schema in compiled response');
      if (result.phpRepresentation !== undefined) assertPhpRepresentation(result.phpRepresentation);
      for (const key of ['model', 'mediaType'])
        if (result[key] !== undefined && typeof result[key] !== 'string')
          throw new Error(`${op.id}.responses.${status}: invalid ${key}`);
      if (result.variants !== undefined)
        for (const binding of Object.values(
          record(result.variants, `${op.id}.responses.${status}.variants`),
        ))
          if (typeof binding !== 'string')
            throw new Error(`${op.id}.responses.${status}: invalid variant binding`);
    }
  }
  if (plan.definitions !== undefined)
    for (const [name, codec] of Object.entries(record(plan.definitions, 'definitions')))
      assertCodecPlan(codec, 'definitions.' + name);
  if (plan.webhook !== undefined) {
    const jwt = record(plan.webhook, 'webhook').jwt;
    const issue = jwt === undefined ? undefined : webhookJwtIssue(jwt);
    if (issue) throw new Error('webhook.jwt.' + issue.field + ': ' + issue.message);
  }
  if (plan.webhook !== undefined && record(plan.webhook, 'webhook').certificate !== undefined)
    assertTypeCertificate(record(plan.webhook, 'webhook').certificate);
  if (plan.webhook !== undefined)
    for (const [name, codec] of Object.entries(
      record(record(plan.webhook, 'webhook').events, 'webhook.events'),
    ))
      assertCodecPlan(codec, 'webhook.events.' + name);
}
