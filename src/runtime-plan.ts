export const AUTH_SHORTCUT_RESERVED = new Set(
  'baseUrl token authMode credentials headers idempotencyKey ifMatch timeoutMs deadlineMs maxAttempts signal cancellation maxPages maxItems streamIdleTimeoutMs streamLifetimeMs allowedOrigins allowInsecureHttp transport diagnostics redactFields constructor prototype __proto__ withDeadline this'
    .toLowerCase()
    .split(' '),
);
import type {
  Operation,
  Schema,
  Auth,
  Webhook,
  Config,
  IncomingWebhook,
  AuthenticationMode,
  AuthShortcuts,
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
  userAgent?: string;
  validation?: Config['validation'];
  operations: Operation[];
  incoming?: IncomingWebhook[];
  definitions?: Record<string, Schema>;
  auth?: Auth;
  authentication?: Record<string, AuthenticationMode>;
  authShortcuts?: AuthShortcuts;
  apiVersion?: { header: string; value: string };
  webhook?: Webhook;
  money?: { currencies: Record<string, number> };
  errors?: Config['errors'];
}

export interface CompiledOperation
  extends Omit<Operation, 'parameters' | 'body' | 'responses' | 'streamEventSchemas'> {
  streamEventCodecs?: Record<string, CodecPlan>;
  parameters: (Omit<Operation['parameters'][number], 'schema'> & { codec: CodecPlan })[];
  body?: CodecPlan;
  responses: Record<
    string,
    Omit<Operation['responses'][string], 'schema'> & {
      codec?: CodecPlan;
      model?: string;
      variants?: Record<string, string>;
    }
  >;
}

export interface CompiledRuntimePlan
  extends Omit<RuntimeContract, 'operations' | 'definitions' | 'webhook' | 'incoming'> {
  format: typeof CODEC_FORMAT;
  semantics: string;
  operations: CompiledOperation[];
  incoming?: (Omit<IncomingWebhook, 'schema'> & { codec: CodecPlan })[];
  definitions?: Record<string, CodecPlan>;
  webhook?: Omit<Webhook, 'events'> & {
    events: Record<string, CodecPlan>;
    eventModels?: Record<string, string>;
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
      return {
        ...operation,
        ...(streamEventSchemas
          ? {
              streamEventCodecs: Object.fromEntries(
                Object.entries(streamEventSchemas).map(([name, schema]) => [name, root(schema)]),
              ),
            }
          : {}),
        parameters: parameters.map(({ schema, ...parameter }) => ({
          ...parameter,
          codec: root(schema),
        })),
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

export function assertRuntimePlan(value: unknown): asserts value is CompiledRuntimePlan {
  function record(value: unknown, path: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error(path + ': invalid compiled runtime record');
    return value as Record<string, unknown>;
  }
  const plan = record(value, 'runtime');
  if (plan.format !== CODEC_FORMAT || typeof plan.semantics !== 'string')
    throw new Error('Unsupported compiled runtime format');
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
  if (plan.authShortcuts !== undefined) {
    for (const [name, value] of Object.entries(record(plan.authShortcuts, 'authShortcuts'))) {
      const shortcut = record(value, 'auth shortcut');
      const modes = record(plan.authentication, 'authentication');
      const mode = typeof shortcut.mode === 'string' ? modes[shortcut.mode] : undefined;
      const schemes = mode && record(mode, 'authentication mode').schemes;
      if (
        !/^[a-z][a-zA-Z0-9]*$/.test(name) ||
        AUTH_SHORTCUT_RESERVED.has(name.toLowerCase()) ||
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
    for (const parameter of op.parameters) {
      const field = record(parameter, `${op.id}.parameter`);
      if (
        typeof field.name !== 'string' ||
        !['path', 'query', 'header'].includes(String(field.in)) ||
        field.schema !== undefined
      )
        throw new Error(`${op.id}: invalid compiled parameter`);
      assertCodecPlan(field.codec, `${op.id}.parameter.${field.name}`);
    }
    if (op.body !== undefined) assertCodecPlan(op.body, `${op.id}.body`);
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
    for (const [status, response] of Object.entries(record(op.responses, `${op.id}.responses`))) {
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
  if (plan.webhook !== undefined)
    for (const [name, codec] of Object.entries(
      record(record(plan.webhook, 'webhook').events, 'webhook.events'),
    ))
      assertCodecPlan(codec, 'webhook.events.' + name);
}
