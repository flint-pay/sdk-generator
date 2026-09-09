import { Diagnostic } from './diagnostic.js';
import type { Contract, Operation, Schema } from './contract.js';
import { stable } from './canonical.js';
import {
  typescriptType,
  optionalPropertyType,
  phpType,
  phpShape,
  phpDocType,
  objectConstraint,
} from './target-types.js';
import {
  compileCodec,
  directionalSchema,
  exactValue,
  valueInstruction,
  type CodecPlan,
} from './codec-plan.js';
import { compileRuntimePlan, type CompiledRuntimePlan } from './runtime-plan.js';
import { compileResponsePlan, type ResponsePlan } from './response-plan.js';
import { compileSchemaPolicy, type SchemaPolicy } from './schema-policy.js';
const pascal = (s: string) => s[0]!.toUpperCase() + s.slice(1);

export function inputSchema(op: Operation): Schema {
  const properties: Record<string, Schema> = Object.fromEntries(
    op.parameters.map((p) => [p.name, p.schema]),
  );
  const required = op.parameters.filter((p) => p.required).map((p) => p.name);
  if (op.body) {
    properties.body = op.body;
    if (op.bodyRequired) required.push('body');
  }
  return { type: 'object', properties, required, additionalProperties: false };
}
export function namedType(s: Schema, models: Record<string, Schema>, response = false): string {
  const match = Object.entries(models).find(([, value]) => stable(value) === stable(s));
  return match ? match[0] + (response ? '' : 'Input') : typescriptType(s, response);
}
export function operationInputType(op: Operation, models: Record<string, Schema>): string {
  const schema = inputSchema(op);
  return `{ ${Object.entries(schema.properties!)
    .map(
      ([key, value]) =>
        `${JSON.stringify(key)}${schema.required!.includes(key) ? '' : '?'}: ${schema.required!.includes(key) ? `InputValue<${namedType(value, models)}>` : optionalPropertyType(key, `InputValue<${namedType(value, models)}>`)};`,
    )
    .join(' ')} }`;
}
export function resultType(op: Operation, models: Record<string, Schema> = {}): string {
  return [
    ...new Set(
      Object.entries(op.responses)
        .filter(([k]) => /^2\d\d$/.test(k) || k === '304' || k === 'default')
        .map(([, v]) => (v.schema ? namedType(v.schema, models, true) : 'undefined')),
    ),
  ].join(' | ');
}
export function itemSchemas(op: Operation): Schema[] {
  const descend = (s: Schema, parts: string[]): Schema[] => {
    const child = s.properties?.[parts[0]!];
    const own = !parts.length
      ? s.items
        ? [s.items]
        : []
      : child
        ? descend(child, parts.slice(1))
        : [];
    return [
      ...own,
      ...[...(s.oneOf ?? []), ...(s.anyOf ?? []), ...(s.allOf ?? [])].flatMap((branch) =>
        descend(branch, parts),
      ),
    ];
  };
  return Object.entries(op.responses)
    .filter(([status]) => /^2\d\d$/.test(status) || status === 'default')
    .flatMap(([, r]) => (r.schema ? descend(r.schema, op.pagination!.items.split('.')) : []));
}
export function runtimeContract(c: Contract) {
  return {
    operations: c.operations,
    validation: c.config.validation ?? 'encoding',
    ...(c.definitions ? { definitions: c.definitions } : {}),
    ...(c.auth ? { auth: c.auth } : {}),
    ...(c.config.apiVersion ? { apiVersion: c.config.apiVersion } : {}),
    ...(c.config.webhook ? { webhook: c.config.webhook } : {}),
    ...(c.config.money ? { money: c.config.money } : {}),
    ...(c.config.errors ? { errors: c.config.errors } : {}),
  };
}
export function modelsUsed(c: Contract) {
  if (c.modelDependencies) {
    const names = new Set([
      ...c.operations.flatMap((op) => c.modelDependencies![op.id] ?? []),
      ...Object.keys(c.definitions ?? {}),
    ]);
    return Object.fromEntries(Object.entries(c.models).filter(([name]) => names.has(name)));
  }
  // Compatibility with generation records predating reference dependency tracking.
  const used = new Set<string>();
  function visit(value: unknown) {
    if (value && typeof value === 'object') {
      used.add(stable(value));
      for (const v of Object.values(value)) visit(v);
    }
  }
  visit(c.operations);
  visit(c.config.webhook);
  return Object.fromEntries(Object.entries(c.models).filter(([, s]) => used.has(stable(s))));
}

export interface PhpModelPlan {
  name: string;
  response: boolean;
  constructorType: string;
  constructorDoc: string;
  defaultObject: boolean;
  getters: { field: string; method: string; type: string; doc: string }[];
  codec: CodecPlan;
  sharedCodec?: string;
}

export function compilePhpModel(
  name: string,
  schema: Schema,
  response: boolean,
  shared: ReadonlyMap<string, string>,
): PhpModelPlan {
  const codec = compileCodec(schema);
  const sharedCodec = shared.get(stable(codec));
  return {
    name,
    response,
    constructorType: phpType(schema),
    constructorDoc:
      schema.type === 'object' ? phpShape(schema, response) : phpDocType(schema, response),
    defaultObject: schema.type === 'object',
    getters: Object.entries(schema.properties ?? {})
      .filter(([, child]) => (response ? !child.writeOnly : !child.readOnly))
      .map(([field, child]) => ({
        field,
        method: /^[A-Za-z][A-Za-z0-9_]*$/.test(field) ? 'get' + pascal(field) : '',
        type: phpType(child),
        doc: phpDocType(child, response),
      })),
    codec,
    ...(sharedCodec ? { sharedCodec } : {}),
  };
}

export interface CompiledSdkContract {
  format: 1;
  semantics: string;
  targets: ('node' | 'php')[];
  runtime: CompiledRuntimePlan;
  node: {
    models: Record<
      string,
      {
        input: string;
        output: string;
        objectFactory: boolean;
        codec: CodecPlan;
        sharedCodec?: string;
      }
    >;
    operations: Record<
      string,
      {
        input: string;
        output: string;
        inputRequired: boolean;
        items: string;
        known?: { type: string; codecs: CodecPlan[] };
      }
    >;
    eventType: string;
  };
  php: {
    runtime: CompiledRuntimePlan;
    models: PhpModelPlan[];
    operations: Record<string, { output: string; items: string }>;
    eventModels: Record<string, string>;
  };
  documentation: Record<
    string,
    {
      nodeInput: string;
      nodeOutput: string;
      phpInput: string;
      phpOutput: string;
      reserveKnown: boolean;
    }
  >;
  responses: Record<string, Record<string, { body?: ResponsePlan }>>;
  policy: {
    models: Record<string, { input: SchemaPolicy; response: SchemaPolicy }>;
    definitions: Record<string, { input: SchemaPolicy; response: SchemaPolicy }>;
    operations: Record<string, { input: SchemaPolicy; responses: Record<string, SchemaPolicy> }>;
  };
}

/** Compile language interfaces and response class routing before any source rendering. */
export function compileSdkContract(source: Contract): {
  source: Contract;
  plan: CompiledSdkContract;
} {
  const c = prepareTargetContract(source);
  const models = modelsUsed(c);
  const runtime = compileRuntimePlan(runtimeContract(c));
  const phpRuntime = structuredClone(runtime);
  const responseModels: PhpModelPlan[] = [];
  const shared = runtime.definitions ?? {};
  const sharedNames = new Map(Object.entries(shared).map(([name, codec]) => [stable(codec), name]));
  for (const op of c.operations) {
    const compiled = phpRuntime.operations.find((value) => value.id === op.id);
    if (!compiled) throw new Error('Missing compiled operation ' + op.id);
    for (const [status, response] of Object.entries(op.responses)) {
      if (!(/^2\d\d$/.test(status) || status === 'default')) continue;
      const result = compiled.responses[status];
      if (!result) throw new Error('Missing compiled response ' + status);
      const prefix = pascal(op.resource) + pascal(op.method) + 'Response' + pascal(status);
      if (response.schema?.type === 'object') {
        result.model = prefix;
        responseModels.push(compilePhpModel(prefix, response.schema, true, sharedNames));
      } else if (response.schema?.oneOf && response.schema.discriminator) {
        result.variants = {};
        for (const [index, branch] of response.schema.oneOf.entries()) {
          const name = prefix + 'Variant' + index;
          responseModels.push(compilePhpModel(name, branch, true, sharedNames));
          for (const tag of branch.properties?.[response.schema.discriminator.propertyName]?.enum ??
            [])
            result.variants[String(tag)] = name;
        }
      }
    }
  }
  const eventModels: Record<string, string> = {};
  for (const [index, [event, schema]] of Object.entries(c.config.webhook?.events ?? {}).entries()) {
    if (schema.type === 'object') {
      const name = 'WebhookEvent' + index;
      eventModels[event] = name;
      responseModels.push(compilePhpModel(name, schema, true, sharedNames));
    }
  }
  if (phpRuntime.webhook) phpRuntime.webhook.eventModels = eventModels;
  const plan: CompiledSdkContract = {
    format: 1,
    semantics: runtime.semantics,
    targets: [...(c.config.targets ?? ['node', 'php'])],
    runtime,
    node: {
      models: Object.fromEntries(
        Object.entries(models).map(([name, s]) => [
          name,
          {
            input: typescriptType(s),
            output: typescriptType(s, true),
            codec: compileCodec(s),
            ...(Object.hasOwn(shared, name) ? { sharedCodec: name } : {}),
            objectFactory:
              objectConstraint(s) !== 'object' &&
              (s.type === undefined || (Array.isArray(s.type) && s.type.includes('object'))),
          },
        ]),
      ),
      operations: Object.fromEntries(
        c.operations.map((op) => {
          const known = Object.entries(op.responses)
            .filter(
              ([status, r]) => (/^2\d\d$/.test(status) || status === 'default') && r.schema?.oneOf,
            )
            .flatMap(([, r]) => (r.schema ? [r.schema] : []));
          return [
            op.id,
            {
              input: operationInputType(op, models),
              output: resultType(op, models),
              inputRequired: Boolean(inputSchema(op).required?.length),
              items: op.pagination
                ? [...new Set(itemSchemas(op).map((s) => namedType(s, models, true)))].join(
                    ' | ',
                  ) || 'never'
                : 'never',
              ...(known.length
                ? {
                    known: {
                      type: known.map((s) => typescriptType(s, true, undefined, true)).join(' | '),
                      codecs: known.map(compileCodec),
                    },
                  }
                : {}),
            },
          ];
        }),
      ),
      eventType:
        Object.values(c.config.webhook?.events ?? {})
          .map((s) => typescriptType(s, true))
          .join(' | ') || 'never',
    },
    php: {
      runtime: phpRuntime,
      models: [
        ...Object.entries(models).map(([name, s]) =>
          compilePhpModel(name + 'Input', s, false, sharedNames),
        ),
        ...c.operations.map((op) =>
          compilePhpModel(
            pascal(op.resource) + pascal(op.method) + 'Input',
            inputSchema(op),
            false,
            sharedNames,
          ),
        ),
        ...responseModels,
      ],
      operations: Object.fromEntries(
        c.operations.map((op) => [
          op.id,
          {
            output: Object.entries(op.responses)
              .filter(
                ([status]) => /^2\d\d$/.test(status) || status === '304' || status === 'default',
              )
              .map(([status, response]) => {
                const binding = phpRuntime.operations.find((value) => value.id === op.id)
                  ?.responses[status];
                return (
                  binding?.model ??
                  (binding?.variants
                    ? [...new Set(Object.values(binding.variants)), '\\stdClass'].join('|')
                    : response.schema
                      ? phpType(response.schema)
                      : 'null')
                );
              })
              .join('|'),
            items: op.pagination
              ? itemSchemas(op)
                  .map((s) => phpDocType(s, true))
                  .join('|') || 'mixed'
              : 'mixed',
          },
        ]),
      ),
      eventModels,
    },
    documentation: Object.fromEntries(
      c.operations.map((op) => [
        op.id,
        {
          nodeInput: typescriptType(inputSchema(op)),
          nodeOutput: resultType(op),
          phpInput: phpDocType(inputSchema(op)),
          phpOutput: Object.entries(op.responses)
            .filter(([status]) => /^2\d\d$/.test(status) || status === 'default')
            .map(([, response]) => (response.schema ? phpDocType(response.schema, true) : 'null'))
            .join('|'),
          reserveKnown: Object.values(op.responses).some((response) =>
            Boolean(response.schema?.oneOf),
          ),
        },
      ]),
    ),
    responses: Object.fromEntries(
      source.operations.map((op) => [
        op.id,
        Object.fromEntries(
          Object.entries(op.responses).map(([status, response]) => [
            status,
            response.schema ? { body: compileResponsePlan(response.schema) } : {},
          ]),
        ),
      ]),
    ),
    policy: {
      models: Object.fromEntries(
        Object.entries(modelsUsed(source)).map(([name, s]) => [
          name,
          {
            input: compileSchemaPolicy(directionalSchema(s, false), 'input'),
            response: compileSchemaPolicy(directionalSchema(s, true), 'response'),
          },
        ]),
      ),
      definitions: Object.fromEntries(
        Object.entries(source.definitions ?? {}).map(([name, s]) => [
          name,
          { input: compileSchemaPolicy(s, 'input'), response: compileSchemaPolicy(s, 'response') },
        ]),
      ),
      operations: Object.fromEntries(
        source.operations.map((op) => [
          op.id,
          {
            input: compileSchemaPolicy(inputSchema(op), 'input'),
            responses: Object.fromEntries(
              Object.entries(op.responses).flatMap(([status, response]) =>
                response.schema ? [[status, compileSchemaPolicy(response.schema, 'response')]] : [],
              ),
            ),
          },
        ]),
      ),
    },
  };
  return { source: c, plan };
}

/** Normalize shared named shapes without mutating the caller contract. */
export function prepareTargetContract(c: Contract): Contract {
  c = JSON.parse(stable(c)) as Contract;
  // Share named nested shapes in recursive graphs. Expanding a provider's graph
  // into every operation, factory and declaration otherwise grows exponentially.
  if (c.definitions) {
    const selectedModels = modelsUsed(c);
    const names = new Map(
      Object.entries(selectedModels)
        .filter(([, s]) => s.type === 'object' || s.type === 'array')
        .map(([name, s]) => [stable(s), name]),
    );
    const compact = (s: Schema, nested = false): Schema => {
      const name = nested ? names.get(stable(s)) : undefined;
      if (name)
        return {
          'x-sdk-ref': name,
          ...(s.readOnly ? { readOnly: true } : {}),
          ...(s.writeOnly ? { writeOnly: true } : {}),
          ...(s['x-sensitive'] ? { 'x-sensitive': true } : {}),
        };
      const out = { ...s };
      if (s.properties)
        out.properties = Object.fromEntries(
          Object.entries(s.properties).map(([k, v]) => [k, compact(v, true)]),
        );
      if (s.items) out.items = compact(s.items, true);
      if (s.additionalProperties && typeof s.additionalProperties === 'object')
        out.additionalProperties = compact(s.additionalProperties, true);
      for (const keyword of ['allOf', 'anyOf', 'oneOf'] as const)
        if (s[keyword]) out[keyword] = s[keyword]!.map((v) => compact(v));
      if (s.not) out.not = compact(s.not);
      return out;
    };
    c.models = Object.fromEntries(
      Object.entries(selectedModels).map(([name, s]) => [name, compact(s)]),
    );
    c.definitions = c.models;
    for (const op of c.operations) {
      for (const p of op.parameters) p.schema = compact(p.schema);
      if (op.body) op.body = compact(op.body);
      for (const response of Object.values(op.responses))
        if (response.schema) response.schema = compact(response.schema);
    }
    if (c.config.webhook)
      for (const [name, s] of Object.entries(c.config.webhook.events))
        c.config.webhook.events[name] = compact(s);
  }
  return c;
}

export function sample(
  s: Schema,
  inherited: Record<string, Schema> = {},
  definitions: Record<string, Schema> = {},
  stack: string[] = [],
): unknown {
  if (s['x-sdk-ref']) {
    const name = s['x-sdk-ref'];
    const target = definitions[name];
    if (!target || stack.includes(name))
      throw new Diagnostic('example', 'provide a finite example for recursive model ' + name);
    if (Array.isArray(target.type) && target.type.includes('null')) return null;
    return sample(target, inherited, definitions, [...stack, name]);
  }
  s = directionalSchema(s, false);
  if (s.example !== undefined) return s.example;
  if (s.oneOf || s.anyOf || s.allOf) {
    const { oneOf, anyOf, allOf, not, discriminator, ...base } = s;
    const collect = (shape: Schema): Record<string, Schema> =>
      Object.assign({}, ...(shape.allOf ?? []).map(collect), shape.properties ?? {});
    const properties = { ...inherited, ...collect(s) };
    let result = sample(base, properties, definitions, stack);
    for (const branch of [...(allOf ?? []), ...(oneOf ?? anyOf ?? []).slice(0, 1)]) {
      const next = sample(branch, properties, definitions, stack);
      result =
        result &&
        next &&
        typeof result === 'object' &&
        typeof next === 'object' &&
        !Array.isArray(result) &&
        !Array.isArray(next)
          ? { ...result, ...next }
          : next;
    }
    return result;
  }
  if (s.enum?.length)
    return s.enum[0] !== null &&
      (exactValue(valueInstruction('integer', s.format)) || s.type === 'number')
      ? String(s.enum[0])
      : s.enum[0];
  const t = Array.isArray(s.type) ? s.type.find((t) => t !== 'null') : s.type;
  if (t === 'object' || s.required || s.properties)
    return Object.fromEntries(
      Object.entries({
        ...Object.fromEntries((s.required ?? []).map((key) => [key, {} as Schema])),
        ...inherited,
        ...s.properties,
      })
        .filter(([k, v]) => s.required?.includes(k) && !v.readOnly)
        .map(([k, v]) => [k, sample(v, {}, definitions, stack)]),
    );
  if (t === 'array') return [];
  if (t === 'boolean') return true;
  if (t === 'integer') return exactValue(valueInstruction('integer', s.format)) ? '100' : 1;
  if (t === 'number') return '1.00';
  if (t === 'null') return null;
  return 'example';
}
