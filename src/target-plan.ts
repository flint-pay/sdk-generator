import { codecSharing } from './codec-sharing.js';
import { Diagnostic } from './diagnostic.js';
import { valueScopes } from './schema-intersections.js';
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
  discriminatorBindings,
  directionalSchema,
  exactValue,
  valueInstruction,
  type CodecPlan,
} from './codec-plan.js';
import { compileRuntimePlan, successStatus, type CompiledRuntimePlan } from './runtime-plan.js';
import { compileResponsePlan, type ResponsePlan } from './response-plan.js';
import { compileSchemaPolicy, type SchemaPolicy } from './schema-policy.js';
export { successStatus };
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
const modelIndexes = new WeakMap<Record<string, Schema>, Map<string, string>>();
export function namedType(s: Schema, models: Record<string, Schema>, response = false): string {
  const identity = stable(s);
  const indexed = modelIndexes.get(models);
  const name = indexed?.get(identity);
  const match = indexed
    ? name
      ? [name]
      : undefined
    : Object.entries(models).find(([, value]) => stable(value) === identity);
  return match
    ? match[0] + (response ? '' : 'Input')
    : typescriptType(s, response, undefined, false, undefined, undefined, models);
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
        .filter(([k]) => successStatus(k) || k === 'default')
        .map(([, v]) =>
          v.bodyKind === 'sse'
            ? 'EventStream'
            : v.bodyKind === 'binary'
              ? 'Uint8Array'
              : v.classification === 'redirect'
                ? '{ location?: string }'
                : v.schema
                  ? namedType(v.schema, models, true)
                  : 'undefined',
        ),
    ),
  ].join(' | ');
}
export function itemSchemas(op: Operation): Schema[] {
  const intersect = (left: Schema[], right: Schema[]): Schema[] =>
    left.flatMap((a) =>
      right.map((b) => {
        if (!Object.keys(a).length) return b;
        if (!Object.keys(b).length) return a;
        return { allOf: [a, b] };
      }),
    );
  const descend = (s: Schema, parts: string[]): Schema[] | undefined => {
    const child = s.properties?.[parts[0]!];
    const own = !parts.length
      ? s.items
        ? [s.items]
        : undefined
      : child
        ? descend(child, parts.slice(1))
        : undefined;
    const constraints = own ? [own] : [];
    for (const branch of s.allOf ?? []) {
      const projected = descend(branch, parts);
      if (projected) constraints.push(projected);
    }
    for (const branches of [s.oneOf, s.anyOf]) {
      if (!branches) continue;
      const alternatives = branches.map((branch) => descend(branch, parts));
      if (alternatives.some((projection) => projection !== undefined))
        constraints.push(alternatives.flatMap((projection) => projection ?? [{}]));
    }
    // Each alternative retains all constraints on the same element. A missing
    // declaration is neutral in a conjunction, but unconstrained in a union.
    return constraints.length ? constraints.reduce(intersect, [{}]) : undefined;
  };
  return Object.entries(op.responses)
    .filter(([status]) => successStatus(status) || status === 'default')
    .flatMap(([, r]) =>
      r.schema ? (descend(r.schema, op.pagination!.items.split('.')) ?? []) : [],
    );
}
export function runtimeContract(c: Contract) {
  return {
    operations: c.operations,
    ...(c.incoming ? { incoming: c.incoming } : {}),
    validation: c.config.validation ?? 'encoding',
    ...(c.definitions ? { definitions: c.definitions } : {}),
    ...(c.auth ? { auth: c.auth } : {}),
    ...(c.authentication ? { authentication: c.authentication } : {}),
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
      ...(c.incoming ?? []).flatMap((item) => [item.model, ...item.dependencies]),
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
  visit(c.incoming);
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
  declaration: Schema = schema,
): PhpModelPlan {
  const codec = compileCodec(schema);
  const sharedCodec = shared.get(stable(codec));
  return {
    name,
    response,
    constructorType: phpType(declaration),
    constructorDoc:
      declaration.type === 'object'
        ? phpShape(declaration, response)
        : phpDocType(declaration, response),
    defaultObject: declaration.type === 'object',
    getters: Object.entries(declaration.properties ?? {})
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

// An allOf conjunct applies to the same instance. Expose its union for helper
// discovery without moving any other keyword out of its original scope. Never
// look through properties, items, alternatives or negations to find a union.
function exposeResponseUnion(schema: Schema): Schema {
  const find = (s: Schema, tagged: boolean): Schema | undefined =>
    s.oneOf && (!tagged || s.discriminator)
      ? s
      : (s.allOf ?? []).map((child) => find(child, tagged)).find((child) => child !== undefined);
  const union = find(schema, true) ?? find(schema, false);
  if (!union) return schema;
  if (union === schema) return schema;
  const remove = (s: Schema): Schema => {
    if (s === union) {
      const { oneOf, discriminator, ...rest } = s;
      return rest;
    }
    return { ...s, ...(s.allOf ? { allOf: s.allOf.map(remove) } : {}) };
  };
  const { oneOf, discriminator, ...rest } = remove(schema);
  return {
    ...rest,
    ...(oneOf
      ? { allOf: [...(rest.allOf ?? []), { oneOf, ...(discriminator ? { discriminator } : {}) }] }
      : {}),
    oneOf: union.oneOf!,
    ...(union.discriminator ? { discriminator: union.discriminator } : {}),
  };
}

function responseVariant(schema: Schema, branch: Schema): Schema {
  const { oneOf, discriminator, ...siblings } = schema;
  const annotations = [
    'title',
    'description',
    'default',
    'example',
    'examples',
    'deprecated',
    'readOnly',
    'writeOnly',
  ];
  if (Object.keys(siblings).every((key) => annotations.includes(key) || key.startsWith('x-')))
    return branch;
  // Tagged branches are declared objects. Keep that fact at the constructor
  // boundary so PHP model arrays are converted to objects before validation.
  return { type: 'object', allOf: [branch, siblings] };
}

// The codec keeps every conjunct independently. This view only supplies PHP
// constructor/getter declarations, including fields declared by outer siblings.
function variantDeclaration(schema: Schema): Schema {
  const conjuncts = (s: Schema): Schema[] => [s, ...(s.allOf ?? []).flatMap(conjuncts)];
  const shapes = conjuncts(schema);
  const fields = new Map<string, Schema[]>();
  for (const shape of shapes)
    for (const [key, child] of Object.entries(shape.properties ?? {}))
      fields.set(key, [...(fields.get(key) ?? []), child]);
  return {
    type: 'object',
    required: [...new Set(shapes.flatMap((shape) => shape.required ?? []))],
    properties: Object.fromEntries(
      [...fields].map(([key, children]) => [
        key,
        children.length === 1
          ? children[0]!
          : {
              allOf: children,
              ...(children.some((child) => child.readOnly) ? { readOnly: true } : {}),
              ...(children.some((child) => child.writeOnly) ? { writeOnly: true } : {}),
            },
      ]),
    ),
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
  const exposedUnions = new Set<Schema>();
  for (const op of c.operations)
    for (const response of Object.values(op.responses)) {
      if (!response.schema) continue;
      const exposed = exposeResponseUnion(response.schema);
      if (exposed !== response.schema) {
        response.schema = exposed;
        exposedUnions.add(exposed);
      }
    }
  const models = modelsUsed(c);
  const index = new Map<string, string>();
  for (const [name, schema] of Object.entries(models)) {
    const key = stable(schema);
    if (!index.has(key)) index.set(key, name);
  }
  modelIndexes.set(models, index);
  const runtime = compileRuntimePlan(runtimeContract(c));
  const phpRuntime = structuredClone(runtime);
  const responseModels: PhpModelPlan[] = [];
  const shared = runtime.definitions ?? {};
  const sharedNames = new Map(Object.entries(shared).map(([name, codec]) => [stable(codec), name]));
  for (const op of c.operations) {
    const compiled = phpRuntime.operations.find((value) => value.id === op.id);
    if (!compiled) throw new Error('Missing compiled operation ' + op.id);
    for (const [status, response] of Object.entries(op.responses)) {
      if (!(successStatus(status) || status === 'default')) continue;
      const result = compiled.responses[status];
      if (!result) throw new Error('Missing compiled response ' + status);
      const prefix = pascal(op.resource) + pascal(op.method) + 'Response' + pascal(status);
      if (
        response.schema?.oneOf &&
        response.schema.discriminator &&
        (response.schema.type !== 'object' || exposedUnions.has(response.schema))
      ) {
        result.variants = {};
        for (const [index, branch] of response.schema.oneOf.entries()) {
          const name = prefix + 'Variant' + index;
          const variant = responseVariant(response.schema, branch);
          responseModels.push(
            compilePhpModel(
              name,
              variant,
              true,
              sharedNames,
              variant === branch ? branch : variantDeclaration(variant),
            ),
          );
          for (const [tag, target] of Object.entries(discriminatorBindings(response.schema) ?? {}))
            if (target === index) result.variants[tag] = name;
        }
      } else if (response.schema?.type === 'object') {
        result.model = prefix;
        responseModels.push(compilePhpModel(prefix, response.schema, true, sharedNames));
      }
    }
  }
  const eventModels: Record<string, string> = {};
  for (const [index, [event, schema]] of Object.entries(c.config.webhook?.events ?? {}).entries()) {
    if (objectConstraint(schema) === 'object') {
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
            input: typescriptType(s, false, undefined, false, undefined, undefined, models),
            output: typescriptType(s, true, undefined, false, undefined, undefined, models),
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
              ([status, r]) => (successStatus(status) || status === 'default') && r.schema?.oneOf,
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
                      type: known
                        .map((s) =>
                          typescriptType(
                            s,
                            true,
                            undefined,
                            true,
                            s.oneOf?.every((branch) => objectConstraint(branch) === 'object')
                              ? 'object'
                              : undefined,
                          ),
                        )
                        .join(' | '),
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
              .filter(([status]) => successStatus(status) || status === 'default')
              .map(([status, response]) => {
                const binding = phpRuntime.operations.find((value) => value.id === op.id)
                  ?.responses[status];
                return (
                  (response.bodyKind === 'sse'
                    ? 'EventStream'
                    : response.bodyKind === 'binary'
                      ? 'string'
                      : response.classification === 'redirect'
                        ? '\\stdClass'
                        : undefined) ??
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
          nodeInput: typescriptType(
            inputSchema(op),
            false,
            undefined,
            false,
            undefined,
            undefined,
            models,
          ),
          nodeOutput: resultType(op),
          phpInput: phpDocType(inputSchema(op)),
          phpOutput: Object.entries(op.responses)
            .filter(([status]) => successStatus(status) || status === 'default')
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
  if (c.config.schemaSharing === 'named') {
    const sharing = codecSharing(plan.runtime.definitions ?? {});
    sharing.runtime(plan.runtime);
    sharing.runtime(plan.php.runtime);
    for (const model of Object.values(plan.node.models)) model.codec = sharing.compact(model.codec);
    for (const operation of Object.values(plan.node.operations))
      if (operation.known) operation.known.codecs = operation.known.codecs.map(sharing.compact);
    for (const model of plan.php.models) model.codec = sharing.compact(model.codec);
  }
  return { source: c, plan };
}

/** Normalize shared named shapes without mutating the caller contract. */
export function prepareTargetContract(c: Contract): Contract {
  c = JSON.parse(stable(c)) as Contract;
  // Share named nested shapes in recursive graphs. Expanding a provider's graph
  // into every operation, factory and declaration otherwise grows exponentially.
  if (c.definitions && c.config.schemaSharing !== 'named') {
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
      if (s.contains) out.contains = compact(s.contains);
      for (const key of ['if', 'then', 'else'] as const) if (s[key]) out[key] = compact(s[key]);
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
    for (const item of c.incoming ?? []) item.schema = compact(item.schema);
    if (c.config.webhook)
      for (const [name, s] of Object.entries(c.config.webhook.events))
        c.config.webhook.events[name] = compact(s);
  }
  return c;
}

/** An exact numeric SDK input in a sample, materialized by the target emitter. */
export class ExactNumberSample {
  constructor(readonly token: string) {}
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
  if (Object.hasOwn(s, 'const')) {
    const literal = (value: import('./contract.js').Json, declarations: Schema[]): unknown => {
      const shapes = declarations.flatMap((shape) => valueScopes(shape, definitions));
      if (Array.isArray(value))
        return value.map((child) =>
          literal(
            child,
            shapes.flatMap((shape) => (shape.items ? [shape.items] : [])),
          ),
        );
      if (value && typeof value === 'object')
        return Object.fromEntries(
          Object.entries(value).map(([key, child]) => [
            key,
            literal(
              child,
              shapes.flatMap((shape) => {
                const field = Object.hasOwn(shape.properties ?? {}, key)
                  ? shape.properties?.[key]
                  : undefined;
                return field
                  ? [field]
                  : typeof shape.additionalProperties === 'object'
                    ? [shape.additionalProperties]
                    : [];
              }),
            ),
          ]),
        );
      if (typeof value === 'number') {
        const numeric = shapes.find((shape) =>
          (Array.isArray(shape.type) ? shape.type : [shape.type]).some((type) =>
            exactValue(valueInstruction(type, shape.format)),
          ),
        );
        if (numeric)
          return numeric['x-sdk-number-input'] === 'explicit'
            ? new ExactNumberSample(String(value))
            : String(value);
      }
      return value;
    };
    return literal(s.const!, [s]);
  }
  if (s.oneOf || s.anyOf || s.allOf) {
    const { oneOf, anyOf, allOf, not, discriminator, ...base } = s;
    const collect = (shape: Schema): Record<string, Schema> =>
      Object.assign({}, ...(shape.allOf ?? []).map(collect), shape.properties ?? {});
    const properties = { ...inherited, ...collect(s) };
    const typed = [base, ...(allOf ?? [])].find((shape) => shape.type !== undefined);
    const item = [base, ...(allOf ?? [])].find((shape) => shape.items !== undefined)?.items;
    let result = sample(base, properties, definitions, stack);
    for (const branch of [...(allOf ?? []), ...(oneOf ?? anyOf ?? []).slice(0, 1)]) {
      const next = sample(
        { ...(typed ? { type: typed.type } : {}), ...(item ? { items: item } : {}), ...branch },
        properties,
        definitions,
        stack,
      );
      result =
        result &&
        next &&
        typeof result === 'object' &&
        typeof next === 'object' &&
        !(result instanceof ExactNumberSample) &&
        !(next instanceof ExactNumberSample) &&
        !Array.isArray(result) &&
        !Array.isArray(next)
          ? { ...result, ...next }
          : next;
    }
    return result;
  }
  const t = Array.isArray(s.type) ? s.type.find((t) => t !== 'null') : s.type;
  if (s.enum?.length)
    return s.enum[0] !== null && exactValue(valueInstruction(t, s.format))
      ? s['x-sdk-number-input'] === 'explicit'
        ? new ExactNumberSample(String(s.enum[0]))
        : String(s.enum[0])
      : s.enum[0];
  if (t === 'object' || s.required || s.properties) {
    const fields = Object.entries({
      ...Object.fromEntries((s.required ?? []).map((key) => [key, {} as Schema])),
      ...inherited,
      ...s.properties,
    }).filter(([, child]) => !child.readOnly);
    const selected = fields.filter(([key]) => s.required?.includes(key));
    for (const field of fields)
      if (selected.length < (s.minProperties ?? 0) && !selected.includes(field))
        selected.push(field);
    const result = Object.fromEntries(
      selected.map(([key, child]) => [key, sample(child, {}, definitions, stack)]),
    );
    if (Object.keys(result).length < (s.minProperties ?? 0) && s.additionalProperties !== false) {
      for (let i = Object.keys(result).length; i < (s.minProperties ?? 0); i++)
        result['example' + i] = sample(
          typeof s.additionalProperties === 'object' ? s.additionalProperties : {},
          {},
          definitions,
          stack,
        );
    }
    return result;
  }
  if (t === 'array')
    return Array.from({ length: Math.max(s.minItems ?? 0, s.contains ? 1 : 0) }, (_, index) =>
      sample(
        index === 0 && s.contains ? { allOf: [s.items ?? {}, s.contains] } : (s.items ?? {}),
        {},
        definitions,
        stack,
      ),
    );
  if (t === 'boolean') return true;
  if (t === 'integer' || t === 'number') {
    const fallback = t === 'integer' ? (exactValue(valueInstruction(t, s.format)) ? 100 : 1) : 1;
    const step = s.multipleOf ?? (t === 'integer' ? 1 : 0.01);
    let value =
      s.minimum ?? (s.exclusiveMinimum !== undefined ? s.exclusiveMinimum + step : fallback);
    if (s.multipleOf) value = Math.ceil(value / s.multipleOf) * s.multipleOf;
    if (s.maximum !== undefined) value = Math.min(value, s.maximum);
    if (s.exclusiveMaximum !== undefined && value >= s.exclusiveMaximum)
      value = s.exclusiveMaximum - step;
    if (!exactValue(valueInstruction(t, s.format))) return value;
    const token =
      t === 'number' && value === 1 && s.multipleOf === undefined ? '1.00' : String(value);
    return s['x-sdk-number-input'] === 'explicit' ? new ExactNumberSample(token) : token;
  }
  if (t === 'string') {
    const formatted =
      s.format === 'date'
        ? '2026-01-01'
        : s.format === 'date-time'
          ? '2026-01-01T00:00:00Z'
          : s.format === 'email'
            ? 'example@example.invalid'
            : 'example';
    return formatted.padEnd(s.minLength ?? 0, 'x').slice(0, s.maxLength);
  }
  if (t === 'null') return null;
  return 'example';
}
