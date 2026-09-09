import type { Operation, Schema, Auth, Webhook, Config } from './contract.js';
import {
  compileCodec,
  assertCodecPlan,
  CODEC_FORMAT,
  CODEC_SEMANTICS,
  type CodecPlan,
} from './codec-plan.js';

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

export interface CompiledOperation extends Omit<Operation, 'parameters' | 'body' | 'responses'> {
  parameters: (Omit<Operation['parameters'][number], 'schema'> & { codec: CodecPlan })[];
  body?: CodecPlan;
  responses: Record<
    string,
    { codec?: CodecPlan; mediaType?: string; model?: string; variants?: Record<string, string> }
  >;
}

export interface CompiledRuntimePlan
  extends Omit<RuntimeContract, 'operations' | 'definitions' | 'webhook'> {
  format: typeof CODEC_FORMAT;
  semantics: string;
  operations: CompiledOperation[];
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
  const { operations, definitions, webhook, ...settings } = contract;
  return {
    ...settings,
    format: CODEC_FORMAT,
    semantics: CODEC_SEMANTICS,
    operations: operations.map((op) => {
      const { parameters, body, responses, ...operation } = op;
      return {
        ...operation,
        parameters: parameters.map(({ schema, ...parameter }) => ({
          ...parameter,
          codec: root(schema),
        })),
        ...(body ? { body: root(body) } : {}),
        responses: Object.fromEntries(
          Object.entries(responses).map(([status, { schema, ...response }]) => [
            status,
            { ...response, ...(schema ? { codec: root(schema) } : {}) },
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
  for (const [index, value] of plan.operations.entries()) {
    const op = record(value, `operations[${index}]`);
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
    for (const [status, response] of Object.entries(record(op.responses, `${op.id}.responses`))) {
      const result = record(response, `${op.id}.responses.${status}`);
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
