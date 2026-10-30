import { eventTypeName } from './webhook-names.js';
import {
  compileDocumentation,
  documentationPositions,
  factEnums,
  factShape,
  factParts,
  documentationDescriptions,
} from './documentation-plan.js';
import { factSourceDocumentation, factCollectionNotes } from './documentation-format.js';
import {
  schemaNotes,
  modelDocumentationNames,
  schemaLiteral,
  schemaEnumValues,
  type SchemaEnumValues,
} from './schema-documentation.js';
import { publicTypePlanner, publicTypeDeclarations } from './public-type-plan.js';
import type { TypeCertificate } from './type-certificate.js';
import { REQUEST_OPTIONS } from './request-options.js';
import { responseOnlyModels } from './schema-usage.js';
import {
  omitProtectedExamples,
  markProtectedDocumentation,
  hasProtectedDocumentation,
} from './example-protection.js';
import { reservePublicSymbols } from './public-symbols.js';
import { responseComponent, responseTypeNames } from './response-type-names.js';
import { pascalWords, isReservedTypeName } from './naming.js';
import {
  phpRepresentations,
  phpRepresentationType,
  type PhpRepresentation,
} from './php-representation.js';
import { phpDeclaration, phpUnion } from './php-types.js';
import { positional, pathParameters, hasParams } from './request-style.js';
import { payloadSchemas, payloadHasAlternatives } from './response-return.js';
import { schemaComment } from './schema-documentation.js';
import { codecSharing } from './codec-sharing.js';
import { Diagnostic } from './diagnostic.js';
import { valueScopes } from './schema-intersections.js';
import { parameterExampleEligible } from './parameter-example-policy.js';
import type { Contract, Operation, Parameter, Schema } from './contract.js';
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
import {
  errorMapping,
  compileRuntimePlan,
  compileRequestOption,
  requiresIdempotencyKey,
  parameterSource,
  successStatus,
  type CompiledRuntimePlan,
} from './runtime-plan.js';
import { compileResultPlan, type ResponsePlan } from './response-plan.js';
import { compileSchemaPolicy, type SchemaPolicy } from './schema-policy.js';
export {
  successStatus,
  RETRY_DEFAULTS,
  VALIDATION_MESSAGES,
  ERROR_FIELDS,
  AUTH_SHORTCUT_RESERVED,
} from './runtime-plan.js';
const pascal = (s: string) => s[0]!.toUpperCase() + s.slice(1);

export function inputSchema(
  op: Operation,
  apiVersion?: Contract['config']['apiVersion'],
  authentication?: Pick<Contract, 'auth' | 'authentication'>,
): Schema {
  const settings = {
    ...(authentication?.auth ? { auth: authentication.auth } : {}),
    ...(authentication?.authentication ? { authentication: authentication.authentication } : {}),
    ...(apiVersion ? { apiVersion } : {}),
  };
  const parameters = op.parameters.filter((p) => parameterSource(op, p, settings) === 'input');
  const properties: Record<string, Schema> = Object.fromEntries(
    parameters.map((p) => [
      p.name,
      {
        ...p.schema,
        ...(p.schema.description === undefined && p.description
          ? { description: p.description }
          : {}),
      },
    ]),
  );
  // Managed headers may be supplied outside the operation input. The runtime
  // validates their effective values and requiredness before dispatch.
  const required = parameters
    .filter(
      (p) =>
        p.required &&
        !(
          p.in === 'header' &&
          [op.idempotency?.header, op.conditional?.header].some(
            (header) => header?.toLowerCase() === p.name.toLowerCase(),
          )
        ),
    )
    .map((p) => p.name);
  if (op.body) {
    properties.body = op.body;
    if (op.bodyRequired) required.push('body');
  }
  return { type: 'object', properties, required, additionalProperties: false };
}
/** Flat public params; canonical operation inputs retain path IDs and the body slot. */
function paramsSchema(op: Operation, c: Contract): Schema {
  const input = inputSchema(op, c.config.apiVersion, c);
  const fields = Object.fromEntries(
    op.parameters
      .filter((p) => p.in !== 'path' && Object.hasOwn(input.properties ?? {}, p.name))
      .map((p) => [p.name, input.properties?.[p.name] ?? {}]),
  );
  const required = (input.required ?? []).filter((name) => Object.hasOwn(fields, name));
  const expand = (schema: Schema, seen = new Set<string>()): Schema => {
    const ref = schema['x-sdk-ref'];
    if (ref && c.definitions?.[ref] && !seen.has(ref))
      return expand(c.definitions[ref], new Set([...seen, ref]));
    const { ['x-sdk-type-name']: _type, ['x-sdk-ref']: _ref, ...value } = schema;
    return {
      ...value,
      ...(schema.type === 'object' || schema.properties || schema.additionalProperties !== undefined
        ? { properties: { ...schema.properties, ...fields } }
        : {}),
      ...(schema.allOf ? { allOf: schema.allOf.map((s) => expand(s, seen)) } : {}),
      ...(schema.oneOf ? { oneOf: schema.oneOf.map((s) => expand(s, seen)) } : {}),
      ...(schema.anyOf ? { anyOf: schema.anyOf.map((s) => expand(s, seen)) } : {}),
    };
  };
  return op.body
    ? { allOf: [expand(op.body), { type: 'object', properties: fields, required }] }
    : { type: 'object', properties: fields, required, additionalProperties: false };
}

export function namedType(
  s: Schema,
  models: Record<string, Schema>,
  response = false,
  documentation = false,
): string {
  if (!s['x-sdk-query-array-items'] && s['x-sdk-type-name'])
    return s['x-sdk-type-name'] + (response ? '' : 'Input');
  return typescriptType(s, response, undefined, false, undefined, undefined, models, documentation);
}
export function operationInputType(
  op: Operation,
  models: Record<string, Schema>,
  documentation = false,
  apiVersion?: Contract['config']['apiVersion'],
  authentication?: Pick<Contract, 'auth' | 'authentication'>,
): string {
  const schema = inputSchema(op, apiVersion, authentication);
  return `{ ${Object.entries(schema.properties!)
    .map(
      ([key, value]) =>
        `${documentation ? schemaComment(value, models) : ''}${JSON.stringify(key)}${schema.required!.includes(key) ? '' : '?'}: ${schema.required!.includes(key) ? `InputValue<${namedType(value, models, false, documentation)}>` : optionalPropertyType(key, `InputValue<${namedType(value, models, false, documentation)}>`)};`,
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
export function itemSchemas(op: Operation, definitions: Record<string, Schema> = {}): Schema[] {
  const intersect = (left: Schema[], right: Schema[]): Schema[] =>
    left.flatMap((a) =>
      right.map((b) => {
        if (!Object.keys(a).length) return b;
        if (!Object.keys(b).length) return a;
        return { allOf: [a, b] };
      }),
    );
  const descend = (s: Schema, parts: string[], seen = new Set<string>()): Schema[] | undefined => {
    const reference = s['x-sdk-ref'];
    const registry = s['x-sdk-definitions'] ?? definitions;
    const edge = reference + ':' + parts.join('.');
    if (reference && Object.hasOwn(registry, reference) && !seen.has(edge)) {
      const { 'x-sdk-ref': _reference, ...siblings } = s;
      return descend({ allOf: [registry[reference]!, siblings] }, parts, new Set([...seen, edge]));
    }
    const child = s.properties?.[parts[0]!];
    const own = !parts.length
      ? s.items
        ? [s.items]
        : undefined
      : child
        ? descend(child, parts.slice(1), seen)
        : undefined;
    const constraints = own ? [own] : [];
    for (const branch of s.allOf ?? []) {
      const projected = descend(branch, parts, seen);
      if (projected) constraints.push(projected);
    }
    for (const branches of [s.oneOf, s.anyOf]) {
      if (!branches) continue;
      const alternatives = branches.map((branch) => descend(branch, parts, seen));
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
    ...(c.defaultBaseUrl !== undefined ? { defaultBaseUrl: c.defaultBaseUrl } : {}),
    operations: c.operations,
    ...(c.incoming ? { incoming: c.incoming } : {}),
    validation: c.config.validation ?? 'encoding',
    ...(c.definitions ? { definitions: c.definitions } : {}),
    ...(c.auth ? { auth: c.auth } : {}),
    ...(c.authentication ? { authentication: c.authentication } : {}),
    ...(c.config.auth && 'defaultCredentials' in c.config.auth && c.config.auth.defaultCredentials
      ? { defaultCredentials: c.config.auth.defaultCredentials }
      : {}),
    ...(c.authShortcuts ? { authShortcuts: c.authShortcuts } : {}),
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
  documentation?: Record<
    string,
    { description: string; markdown?: string; enums?: SchemaEnumValues[]; required: boolean }
  >;
  description?: string;
  /** Source alternatives retained for documentation, before getter projection. */
  documentationSchema?: Schema;
  codec: CodecPlan;
  sharedCodec?: string;
  representation?: PhpRepresentation;
}

function nullablePhpAccessor(type: string): string {
  if (
    type === 'mixed' ||
    type === 'null' ||
    type.startsWith('?') ||
    type.split('|').includes('null')
  )
    return type;
  return type.includes('|') ? type + '|null' : '?' + type;
}

const exampleDocumentationViews = new WeakMap<Schema, Schema>();
const responseDocumentationViews = new WeakMap<Schema, Schema>();
const documentationDefinitionViews = new WeakMap<
  object,
  Map<boolean, Readonly<Record<string, Schema>>>
>();

export function compilePhpModel(
  name: string,
  schema: Schema,
  response: boolean,
  shared: ReadonlyMap<string, string>,
  declaration: Schema = schema,
  definitions: Readonly<Record<string, Schema>> = {},
  includeExamples = true,
  bindings?: PhpRepresentation,
  documentationDefinitions: Readonly<Record<string, Schema>> = definitions,
): PhpModelPlan {
  const views = includeExamples ? exampleDocumentationViews : responseDocumentationViews;
  const documentationView = (s: Schema): Schema => {
    const cached = views.get(s);
    if (cached) return cached;
    const {
      ['x-sdk-definitions']: _definitions,
      example,
      examples,
      default: defaultValue,
      ...view
    } = s;
    const result = {
      ...view,
      ...(!hasProtectedDocumentation(s) && Object.hasOwn(s, 'default')
        ? { default: defaultValue }
        : {}),
      ...(includeExamples
        ? { ...(example !== undefined ? { example } : {}), ...(examples ? { examples } : {}) }
        : {}),
      ...(s.properties
        ? {
            properties: Object.fromEntries(
              Object.entries(s.properties).map(([field, child]) => [
                field,
                documentationView(child),
              ]),
            ),
          }
        : {}),
      ...(s.items ? { items: documentationView(s.items) } : {}),
      ...(typeof s.additionalProperties === 'object'
        ? { additionalProperties: documentationView(s.additionalProperties) }
        : {}),
      ...Object.fromEntries(
        (['allOf', 'oneOf', 'anyOf'] as const).flatMap((keyword) =>
          s[keyword] ? [[keyword, s[keyword]!.map(documentationView)]] : [],
        ),
      ),
      ...Object.fromEntries(
        (['not', 'contains', 'if', 'then', 'else', 'propertyNames'] as const).flatMap((keyword) =>
          s[keyword] ? [[keyword, documentationView(s[keyword])]] : [],
        ),
      ),
    };
    views.set(s, result);
    return result;
  };
  let definitionViews = documentationDefinitionViews.get(documentationDefinitions);
  if (!definitionViews)
    documentationDefinitionViews.set(documentationDefinitions, (definitionViews = new Map()));
  let definitionView = definitionViews.get(includeExamples);
  if (!definitionView) {
    definitionView = Object.fromEntries(
      Object.entries(documentationDefinitions).map(([name, value]) => [
        name,
        documentationView(value),
      ]),
    );
    definitionViews.set(includeExamples, definitionView);
  }
  documentationDefinitions = definitionView;
  const boundNames: Record<string, string> = {};
  let bindingChangesStructure = false;
  // Bind model links to the same target representation that emits getter types.
  const bind = (s: Schema, value?: PhpRepresentation): Schema => {
    if (!value) return s;
    if (value.kind === 'nullable') {
      // Entity identity belongs to the concrete value, never its nullable
      // wrapper. Keep null at the same depth for fields, items and map values.
      const branches = s.oneOf ?? s.anyOf;
      if (branches) {
        const keyword = s.oneOf ? 'oneOf' : 'anyOf';
        const { ['x-sdk-type-name']: _wrapperName, ...wrapper } = s;
        return {
          ...wrapper,
          [keyword]: branches.map((child) =>
            child.type === 'null' ? child : bind(child, value.value),
          ),
        };
      }
      const types = Array.isArray(s.type) ? s.type : [s.type];
      if (types.includes('null')) return bind(s, value.value);
      // A composition/reference can carry the nullable value without a local
      // union node. Its entity identity still describes only the concrete
      // representation. Retain the compiler's null alternative outside it.
      bindingChangesStructure = true;
      return { anyOf: [bind(s, value.value), { type: 'null' }] };
    }
    if (value.kind === 'entity') boundNames[value.name] = value.name;
    return {
      ...s,
      ...(value?.kind === 'entity' ? { 'x-sdk-type-name': value.name } : {}),
      ...(s.properties
        ? {
            properties: Object.fromEntries(
              Object.entries(s.properties).map(([field, child]) => [
                field,
                bind(child, value?.kind === 'record' ? value.fields[field] : undefined),
              ]),
            ),
          }
        : {}),
      ...(s.items
        ? { items: bind(s.items, value?.kind === 'list' ? value.value : undefined) }
        : {}),
      ...(typeof s.additionalProperties === 'object'
        ? {
            additionalProperties: bind(
              s.additionalProperties,
              value?.kind === 'map' ? value.value : undefined,
            ),
          }
        : {}),
      ...Object.fromEntries(
        (['allOf', 'oneOf', 'anyOf'] as const).flatMap((key) =>
          s[key] ? [[key, s[key].map((child) => bind(child, value))]] : [],
        ),
      ),
    };
  };
  let documentationSchema = bind(documentationView(declaration), bindings);
  const codec = compileCodec(schema);
  // Reuse instructions only while binding preserves the paired schema layout.
  const documentationCodec =
    declaration === schema && !bindingChangesStructure ? codec : compileCodec(documentationSchema);
  let documentationFacts = compileDocumentation(
    documentationSchema,
    documentationDefinitions,
    response,
    documentationCodec,
  );
  const existingDescriptions = new Set(
    factParts(documentationFacts.root, documentationFacts.definitions).flatMap((part) =>
      part.description ? [part.description] : [],
    ),
  );
  const inheritedDescriptions =
    schema === declaration
      ? []
      : documentationDescriptions(schema, documentationDefinitions, codec).filter(
          (description) => !existingDescriptions.has(description),
        );
  if (inheritedDescriptions.length) {
    documentationSchema = {
      ...documentationSchema,
      description: [documentationSchema.description, ...inheritedDescriptions]
        .filter(Boolean)
        .join('\n\n'),
    };
    documentationFacts = compileDocumentation(
      documentationSchema,
      documentationDefinitions,
      response,
      documentationCodec,
    );
  }
  declaration = {
    ...phpDeclaration(declaration, schema['x-sdk-definitions'] ?? definitions),
    'x-sdk-definitions': definitions,
  };
  const documentedFields = factShape(
    documentationFacts.root,
    documentationFacts.definitions,
  ).fields;
  // Getter bindings overlay one shared inventory, without copying it per field.
  Object.setPrototypeOf(boundNames, modelDocumentationNames(documentationDefinitions, response));
  const sharedCodec = shared.get(stable(codec));
  return {
    name,
    response,
    documentationSchema,
    ...(declaration.description ? { description: declaration.description } : {}),
    constructorType: phpType(declaration, response),
    constructorDoc:
      declaration.type === 'object'
        ? phpShape(declaration, response)
        : phpDocType(declaration, response),
    defaultObject: declaration.type === 'object',
    documentation: Object.fromEntries(
      Object.entries(declaration.properties ?? {}).map(([field, originalChild]) => {
        const fact =
          documentedFields[field] ??
          compileDocumentation(documentationView(originalChild), documentationDefinitions, response)
            .root;
        return [
          field,
          {
            required: declaration.required?.includes(field) ?? false,
            enums: factEnums(fact, documentationFacts.definitions),
            markdown: factCollectionNotes(fact, {
              literal: schemaLiteral,
            }),
            description: factSourceDocumentation(
              fact,
              documentationFacts.definitions,
              documentationPositions(fact, documentationFacts.definitions),
              boundNames,
              'see',
            ),
          },
        ];
      }),
    ),
    getters: Object.entries(declaration.properties ?? {})
      .filter(([, child]) => (response ? !child.writeOnly : !child.readOnly))
      .map(([field, child]) => {
        const optional = !declaration.required?.includes(field);
        const type = phpType(child, response);
        const doc = phpDocType(child, response, definitions);
        return {
          field,
          method: pascalWords(field) ? 'get' + pascalWords(field) : '',
          type: response && optional ? nullablePhpAccessor(type) : type,
          doc: response && optional ? nullablePhpAccessor(doc) : doc,
        };
      }),
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

export interface NodeAuthenticationPlan {
  declarations: string;
  modes: Record<string, string[]>;
}
function compileAuthentication(c: Contract): NodeAuthenticationPlan | undefined {
  if (!c.authentication) return undefined;
  const modes = Object.fromEntries(
    Object.entries(c.authentication)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, mode]) => [name, mode.schemes.map((s) => s.name).sort()]),
  );
  const requestShortcuts = Object.entries(c.authShortcuts ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([name, shortcut]) =>
        `${JSON.stringify(name)}?: ${JSON.stringify(shortcut.mode)} extends M ? (string | CredentialProvider) : never;`,
    )
    .join(' ');
  const declarations = `export interface Credentials {\n${Object.entries(modes)
    .map(
      ([mode, schemes]) =>
        `  ${JSON.stringify(mode)}: { ${schemes.map((name) => `${JSON.stringify(name)}: string | CredentialProvider;`).join(' ')} };`,
    )
    .join(
      '\n',
    )}\n}\nexport type AuthMode = keyof Credentials;\n/** Per-call authentication and request overrides. See RUNTIME.md#requestoptions. */\nexport type RequestOptions<M extends AuthMode = AuthMode> = Omit<RuntimeRequestOptions, 'authMode' | 'credentials'> & ${requestShortcuts ? '{ ' + requestShortcuts + ' } & ' : ''}({ authMode?: undefined; credentials?: Credentials[M] } | { [K in M]: { authMode: K; credentials?: Credentials[K] } }[M]);\n`;
  return { declarations, modes };
}

function operationOptions(
  op: Operation,
  authentication: NodeAuthenticationPlan | undefined,
): string {
  const base = authentication
    ? `RequestOptions<${
        op.authModes
          ?.slice()
          .sort()
          .map((mode) => JSON.stringify(mode))
          .join(' | ') || 'never'
      }>`
    : 'RequestOptions';
  return requiresIdempotencyKey(op)
    ? `_SdkRequiredIdempotency<${base}>`
    : op.idempotency
      ? base
      : `_SdkWithoutIdempotency<${base}>`;
}

function compileClientOptions(c: Contract): string {
  const baseUrl = `baseUrl${c.defaultBaseUrl !== undefined ? '?' : ''}: string | undefined;`;
  if (!c.authentication)
    return `/** Client configuration. See RUNTIME.md#clientoptions. */\nexport type ClientOptions = Omit<RuntimeClientOptions, 'baseUrl'> & { ${baseUrl} };\n`;
  const shortcuts = Object.keys(c.authShortcuts ?? {})
    .sort()
    .map((name) => `${JSON.stringify(name)}?: string | CredentialProvider;`)
    .join(' ');
  return `/** Client configuration. See RUNTIME.md#clientoptions. */\nexport type ClientOptions = Omit<RuntimeClientOptions, 'baseUrl' | 'token' | 'authMode' | 'credentials'> & { ${baseUrl} ${shortcuts} authMode?: AuthMode; credentials?: Partial<Credentials> };\n`;
}

const js = (v: unknown) => JSON.stringify(v, null, 2)?.replaceAll('"__proto__":', '["__proto__"]:');
const php = (s: string) => "'" + s.replaceAll('\\', '\\\\').replaceAll("'", "\\'") + "'";
function compileRequestCall(op: Operation, c: Contract, optionsType: string) {
  const paths = pathParameters(op);
  const input = inputSchema(op, c.config.apiVersion, c);
  const fields = op.parameters.filter(
    (p) => p.in !== 'path' && Object.hasOwn(input.properties ?? {}, p.name),
  );
  const requiredFields = new Set(input.required);
  const paramsRequired = op.bodyRequired || fields.some((p) => requiredFields.has(p.name));
  const type = (schema: Schema, documentation = false) =>
    typescriptType(schema, false, undefined, false, undefined, undefined, c.models, documentation);
  // A whole-union InputValue adds Model<Union> and wraps literal tags, preventing
  // callers from narrowing params on the discriminator. Keep union params explicit.
  const unionBody =
    op.body &&
    valueScopes(op.body, c.definitions).some((shape) => shape.oneOf?.length || shape.anyOf?.length);
  // An omitted optional body may accompany query/header params. Exclude declared
  // body fields in that branch so a partially supplied body still needs its required fields.
  const bodyType = op.body
    ? (unionBody ? type(op.body, true) : `InputValue<${type(op.body, true)}>`) +
      (!op.bodyRequired && fields.length
        ? ` | { ${[...new Set(valueScopes(op.body, c.definitions).flatMap((s) => Object.keys(s.properties ?? {})))].map((name) => `${JSON.stringify(name)}?: never`).join('; ')} }`
        : '')
    : undefined;
  const paramsName = pascal(op.resource) + pascal(op.method) + 'Params';
  const paramsType =
    [
      ...(bodyType ? [`(${bodyType})`] : []),
      ...(fields.length
        ? [
            `{ ${fields.map((p) => `${schemaComment(input.properties?.[p.name] ?? p.schema, c.definitions ?? c.models)}${JSON.stringify(p.name)}${requiredFields.has(p.name) ? '' : '?'}: ${requiredFields.has(p.name) ? `InputValue<${type(p.schema)}>` : optionalPropertyType(p.name, `InputValue<${type(p.schema)}>`)}`).join('; ')} }`,
          ]
        : []),
    ].join(' & ') || '{}';
  const reserved = new Set(
    '_sdkRequestInput _sdkPayload _sdkResponse params options input rest arguments eval await yield break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof let new null return super switch this throw true try typeof var void while with implements interface package private protected public static'.split(
      ' ',
    ),
  );
  // Positional identifiers are shared by both targets. PHP superglobals cannot
  // be parameter variables, even though their wire names are valid.
  for (const name of [
    'GLOBALS',
    '_SERVER',
    '_GET',
    '_POST',
    '_FILES',
    '_COOKIE',
    '_SESSION',
    '_REQUEST',
    '_ENV',
  ])
    reserved.add(name);
  const names = paths.map((p, i) => {
    let name =
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(p.name) && !reserved.has(p.name) ? p.name : `path${i}`;
    while (reserved.has(name)) name += '_';
    reserved.add(name);
    return name;
  });
  const nodeArgs = [...names, ...(hasParams(op) ? ['params'] : []), 'options'].join(', ');
  const keyRequired = requiresIdempotencyKey(op);
  const nodeSignature = [
    ...paths.map((p, i) => `${names[i]}: InputValue<${type(p.schema)}>`),
    ...(hasParams(op)
      ? [
          `params${paramsRequired || keyRequired ? '' : '?'}: ${paramsName}${!paramsRequired && keyRequired ? ' | undefined' : ''}`,
        ]
      : []),
    `options${keyRequired ? '' : '?'}: ${optionsType}`,
  ].join(', ');
  const managed = op.parameters
    .filter(
      (p) =>
        p.in === 'header' &&
        parameterSource(op, p, {
          ...(c.auth ? { auth: c.auth } : {}),
          ...(c.authentication ? { authentication: c.authentication } : {}),
          ...(c.config.apiVersion ? { apiVersion: c.config.apiVersion } : {}),
        }) !== 'input',
    )
    .map((p) => p.name);
  const nodeInput = `_sdkRequestInput(${js(paths.map((p) => p.name))}, [${names.join(', ')}], ${js(fields.map((p) => p.name))}, ${Boolean(op.body)}, ${op.bodyRequired}, ${hasParams(op) ? 'params' : 'undefined'}, ${js(managed)})`;
  const phpSignature = [
    ...names.map(
      (name, i) =>
        `${phpType(paths[i]!.schema) === 'mixed' ? 'mixed' : phpType(paths[i]!.schema) + '|Model'} $${name}`,
    ),
    ...(hasParams(op)
      ? [
          `${paramsRequired ? 'array|Model' : 'array|Model|null'} $params${paramsRequired ? '' : ' = null'}`,
        ]
      : []),
    '?RequestOptions $options = null',
  ].join(', ');
  let phpPrelude =
    paths
      .map(
        (p, i) =>
          `if ($${names[i]} instanceof Model && (is_array($${names[i]}->jsonSerialize()) || is_object($${names[i]}->jsonSerialize()))) throw SdkError::create('validation', ${php('Path parameter ' + p.name + ' requires a scalar value or a scalar model; entity models are not identifiers')}, errorCode: 'INVALID_REQUEST', details: [['code' => 'INVALID_VALUE', 'param' => ${php(p.name)}]]); `,
      )
      .join('') +
    `$input = [${paths.map((p, i) => `${php(p.name)} => $${names[i]}`).join(', ')}]; `;
  if (hasParams(op)) {
    phpPrelude +=
      "$params = $params instanceof Model ? $params->toInputArray() : $params; $rest = $params ?? []; if ($rest && array_is_list($rest)) throw SdkError::create('validation', 'body must be an object', 'not_sent', errorCode: 'INVALID_REQUEST', details: [['code' => 'INVALID_VALUE', 'param' => 'body']]); ";
    if (managed.length)
      phpPrelude += `foreach (array_keys($rest) as $name) { foreach (${'[' + managed.map(php).join(', ') + ']'} as $header) { if (strtolower((string)$name) === strtolower($header)) throw SdkError::create('validation', $header . " can't be sent: supply this header through request options", errorCode: 'INVALID_REQUEST', details: [['code' => 'NOT_ALLOWED', 'param' => $header]]); } } `;
    for (const p of fields)
      phpPrelude += `if (array_key_exists(${php(p.name)}, $rest)) { $input[${php(p.name)}] = $rest[${php(p.name)}]; unset($rest[${php(p.name)}]); } `;
    if (op.body)
      phpPrelude += `if (${op.bodyRequired ? 'true' : '$params !== null && (!$params || $rest)'}) $input['body'] = (object) $rest; `;
    else
      phpPrelude +=
        "foreach ($rest as $name => $value) { if (array_key_exists($name, $input)) throw SdkError::create('validation', $name . \" can't be sent: path values belong in positional arguments\", 'not_sent', errorCode: 'INVALID_REQUEST', details: [['code' => 'NOT_ALLOWED', 'param' => $name]]); $input[$name] = $value; } ";
  }
  return {
    paramsName,
    paramsType,
    nodePathDocs: paths.map((p, i) => ({
      name: names[i] ?? p.name,
      description: p.description ?? p.schema.description ?? '',
    })),
    nodeArgs,
    nodeSignature,
    nodeInput,
    phpSignature,
    phpPrelude,
    phpDoc:
      paths
        .map(
          (p, i) =>
            `@param ${phpType(p.schema)}|Model $${names[i]} ${String(
              p.description ?? p.schema.description ?? '',
            )
              .replaceAll('*/', '* /')
              .replace(/[\r\n]+/g, ' ')}`,
        )
        .join('\n     * ') +
      (paths.length ? '\n     * ' : '') +
      (hasParams(op)
        ? `@param ${paramsName}|array<array-key, mixed>|Model${paramsRequired ? '' : '|null'} $params Flat body fields and query/header parameters; path arguments follow URL order.`
        : 'Path arguments follow URL order; request options come last.'),
  };
}

export interface CompiledSdkContract {
  requestCalls?: Record<
    string,
    ReturnType<typeof compileRequestCall> & { paths: string[]; params: boolean }
  >;
  responseReturns?: Record<
    string,
    {
      path: string[];
      node: string;
      nodeDocumentation: string;
      php: string;
      phpNative: string;
      /** Absent in saved plans whose Pages/Wait helpers returned Results. */
      helperReturn?: 'payload';
      validate?: true;
    }
  >;
  format: 1;
  semantics: string;
  targets: ('node' | 'php')[];
  runtime: CompiledRuntimePlan;
  requestOptionPlans?: Record<string, ReturnType<typeof compileRequestOption>>;
  node: {
    /** Absent in historical records predating these additive runtime APIs. */
    errorClasses?: true;
    errorSurfaceVersion?: number;
    webhookReasons?: true;
    standaloneWebhook?: true;
    authentication?: NodeAuthenticationPlan;
    clientOptions?: { declaration: string; optional: boolean };
    responseReturnDeclarations?: string;
    errorTypes?: {
      code: string;
      details: string;
      type?: string;
      errorSource?: string;
      remediation?: string;
    };
    models: Record<
      string,
      {
        input: string;
        output: string;
        documentedInput?: string;
        documentedOutput?: string;
        objectFactory: boolean;
        /** Absent in historical plans, which emitted factories for every model. */
        inputReachable?: boolean;
        /** Identical public response declarations share one canonical symbol. */
        outputAlias?: string;
        codec: CodecPlan;
        sharedCodec?: string;
      }
    >;
    operations: Record<
      string,
      {
        input: string;
        output: string;
        documentedInput?: string;
        documentedOutput?: string;
        inputRequired: boolean;
        responseType?: string;
        requestOptions?: string;
        idempotencyKey?: boolean;
        idempotencyKeyRequired?: boolean;
        authModes?: string[];
        items: string;
        known?: { type: string; codecs: CodecPlan[]; certificate?: TypeCertificate };
      }
    >;
    eventType: string;
    eventDeclarations?: string;
    /** Absent in records predating named webhook event exports. */
    eventTypes?: Record<string, string>;
  };
  php: {
    errorClasses?: true;
    errorSurfaceVersion?: number;
    webhookReasons?: true;
    standaloneWebhook?: true;
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
    responseOnlyModels?: string[];
    models: Record<string, { input: SchemaPolicy; response: SchemaPolicy }>;
    definitions: Record<string, { input: SchemaPolicy; response: SchemaPolicy }>;
    operations: Record<string, { input: SchemaPolicy; responses: Record<string, SchemaPolicy> }>;
  };
}

/** Shared boundary codec for PHP payload objects that have no generated entity. */
export const RESPONSE_OBJECT_CODEC = compileCodec({ type: 'object', additionalProperties: true });
/** Close alternatives only at the envelope value. Nested payloads keep response
 * tolerance and references. Only unchanged allOf conjuncts use public models. */
function webhookDeclarations(
  c: Contract,
  models: Record<string, Schema>,
): {
  eventType: string;
  eventDeclarations?: string;
  eventTypes?: Record<string, string>;
} {
  const webhook = c.config.webhook;
  if (!webhook) return { eventType: 'never' };
  const names = new Set(Object.keys(models));
  const modelNames = new Map(
    Object.entries(models).map(([name, schema]) => [stable(schema), name]),
  );
  const render = (
    schema: Schema,
    known: boolean,
    objectContext = objectConstraint(schema),
  ): string => typescriptType(schema, true, undefined, known, objectContext, undefined, models);
  const unchangedModels = new Map<string, boolean>();
  const unchanged = (name: string, seen: ReadonlySet<string> = new Set()): boolean => {
    if (seen.has(name)) return true;
    const cached = unchangedModels.get(name);
    if (cached !== undefined) return cached;
    const schema = models[name];
    const preserves = (value: Schema): boolean =>
      (value['x-sdk-ref']
        ? unchanged(value['x-sdk-ref'], new Set([...seen, name]))
        : render(value, true) === render(value, false)) &&
      [value.allOf, value.oneOf, value.anyOf].every((branches) =>
        (branches ?? []).every(preserves),
      );
    const same = schema !== undefined && preserves(schema);
    if (!seen.size) unchangedModels.set(name, same);
    return same;
  };
  const aliases = new Map<string, string>();
  const pending: { name: string; schema: Schema }[] = [];
  let sequence = 0;
  const alias = (schema: Schema): string => {
    const key = stable(schema);
    const found = aliases.get(key);
    if (found) return found;
    let name: string;
    do {
      name = '_SdkWebhookEnvelope' + sequence++;
    } while (names.has(name));
    names.add(name);
    aliases.set(key, name);
    pending.push({ name, schema });
    return name;
  };
  const close = (schema: Schema, conjunct = false): Schema => {
    // Keep event roots and alternatives structural: referring to a complete
    // payload model makes TypeScript flatten its event-name enum into hovers.
    const model =
      schema['x-sdk-ref'] ?? schema['x-sdk-type-name'] ?? modelNames.get(stable(schema));
    // Retain contextual type facts for the structural parent. Rendering the
    // conjunct itself stops at the reference, including inside alternatives.
    if (conjunct && model) {
      if (unchanged(model)) return { ...schema, 'x-sdk-ref': model };
      const target = models[model];
      if (!target) throw new Error('Missing webhook declaration reference ' + model);
      return { 'x-sdk-ref': alias(target) };
    }
    const ref = schema['x-sdk-ref'];
    if (ref) {
      const target = models[ref];
      if (!target) throw new Error('Missing webhook declaration reference ' + ref);
      return { ...schema, 'x-sdk-ref': alias(target) };
    }
    const result = { ...schema };
    for (const keyword of ['allOf', 'oneOf', 'anyOf'] as const)
      if (schema[keyword])
        result[keyword] = schema[keyword].map((branch) => close(branch, keyword === 'allOf'));
    return result;
  };
  const declarations: string[] = [];
  const eventTypes = Object.fromEntries(
    // Use the canonical event-name order from prepareTargetContract, as PHP does.
    // Source insertion order changes when generation records are saved with stable().
    Object.keys(webhook.events).map((event) => {
      const schema = webhook.events[event];
      if (!schema) throw new Error('Missing webhook declaration ' + event);
      const name = eventTypeName(c, event);
      const tag = webhook.typeField
        .split('.')
        .reduceRight(
          (value, field) => `{ ${JSON.stringify(field)}: ${value} }`,
          JSON.stringify(event),
        );
      // Runtime lookup proves the event-name literal independently of schema tolerance.
      // Named conjuncts hide their type keyword. Preserve the original envelope's
      // object context so typeless siblings do not introduce scalar alternatives.
      declarations.push(
        `export type ${name} = (${render(close(schema), true, objectConstraint(schema))} & ${tag});\n`,
      );
      return [event, name];
    }),
  );
  // Array iteration includes reference aliases appended while closing each declaration.
  for (const entry of pending) {
    declarations.push(
      `type ${entry.name} = ${render(close(entry.schema), true, objectConstraint(entry.schema))};\n`,
    );
  }
  declarations.push(
    `export type KnownWebhookEvent = ${Object.values(eventTypes).join(' | ') || 'never'};\n`,
    'export type VerifiedWebhook = { known: true; event: KnownWebhookEvent } | { known: false; event: unknown; reason: "unknown_event" | "unmatched_envelope" };\n',
  );
  return { eventType: 'KnownWebhookEvent', eventDeclarations: declarations.join(''), eventTypes };
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
  const { names: responseNames, aliases: responseAliases } = responseTypeNames(
    c,
    Object.keys(models),
  );
  const inputModels = new Set<string>();
  const visitInput = (schema: Schema): void => {
    const name = schema['x-sdk-type-name'] ?? schema['x-sdk-ref'];
    if (name && models[name] && !inputModels.has(name)) {
      inputModels.add(name);
      visitInput(models[name]!);
    }
    for (const child of [
      ...Object.values(schema.properties ?? {}).filter((field) => !field.readOnly),
      ...(schema.items ? [schema.items] : []),
      ...(typeof schema.additionalProperties === 'object' ? [schema.additionalProperties] : []),
      ...(schema.allOf ?? []),
      ...(schema.oneOf ?? []),
      ...(schema.anyOf ?? []),
      ...(schema.not ? [schema.not] : []),
      ...(schema.contains ? [schema.contains] : []),
      ...[schema.if, schema.then, schema.else].filter(
        (value): value is Schema => value !== undefined,
      ),
    ])
      visitInput(child);
  };
  for (const op of c.operations) visitInput(inputSchema(op, c.config.apiVersion, c));
  for (const name of Object.keys(models))
    if ((!c.config.targets || c.config.targets.includes('node')) && isReservedTypeName(name))
      throw new Diagnostic(
        'config/models/' + name,
        'model name is a TypeScript reserved word; customize it with config.models',
      );
  reservePublicSymbols(
    c,
    Object.keys(models),
    new Set(
      c.operations
        .filter((op) => Object.values(op.responses).some((response) => response.schema?.oneOf))
        .map((op) => op.id),
    ),
  );
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
      const prefix = responseNames.get(op.id + '/' + status);
      if (!prefix) throw new Error('Missing response type name for ' + op.id + '/' + status);
      if (
        response.schema?.oneOf &&
        response.schema.discriminator &&
        (response.schema.type !== 'object' || exposedUnions.has(response.schema)) &&
        !responseComponent(response.schema, Object.keys(models))
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
  for (const [event, schema] of Object.entries(c.config.webhook?.events ?? {})) {
    if (objectConstraint(schema) === 'object') {
      const name = eventTypeName(c, event);
      eventModels[event] = name;
      responseModels.push(compilePhpModel(name, schema, true, sharedNames));
    }
  }
  if (phpRuntime.webhook) phpRuntime.webhook.eventModels = eventModels;
  const authentication = compileAuthentication(c);
  const plan: CompiledSdkContract = {
    ...(c.operations.some(positional)
      ? {
          requestCalls: Object.fromEntries(
            c.operations.filter(positional).map((op) => [
              op.id,
              {
                ...compileRequestCall(op, c, operationOptions(op, authentication)),
                paths: pathParameters(op).map((p) => p.name),
                params: hasParams(op),
              },
            ]),
          ),
        }
      : {}),
    format: 1,
    semantics:
      runtime.semantics +
      '/results-1' +
      ((c.config.targets ?? ['node', 'php']).includes('php') ? '/php-entities-1' : ''),
    targets: [...(c.config.targets ?? ['node', 'php'])],
    runtime,
    requestOptionPlans: Object.fromEntries(
      Object.keys(REQUEST_OPTIONS).map((name) => [
        name,
        compileRequestOption(name, 'request options'),
      ]),
    ),
    node: {
      errorSurfaceVersion: 6,
      ...(c.config.webhook ? { webhookReasons: true, standaloneWebhook: true } : {}),
      clientOptions: {
        declaration: compileClientOptions(c),
        optional: c.defaultBaseUrl !== undefined,
      },
      ...(authentication ? { authentication } : {}),
      models: Object.fromEntries(
        Object.entries(models).map(([name, s]) => [
          name,
          {
            inputReachable: inputModels.has(name),
            input: typescriptType(s, false, undefined, false, undefined, undefined, models),
            documentedInput: typescriptType(
              s,
              false,
              undefined,
              false,
              undefined,
              undefined,
              models,
              true,
            ),
            documentedOutput: typescriptType(
              s,
              true,
              undefined,
              false,
              undefined,
              undefined,
              models,
              true,
            ),
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
              input: operationInputType(op, models, false, c.config.apiVersion, c),
              documentedInput: operationInputType(op, models, true, c.config.apiVersion, c),
              output: resultType(op, models),
              inputRequired: Boolean(inputSchema(op, c.config.apiVersion, c).required?.length),
              requestOptions: operationOptions(op, authentication),
              idempotencyKey: Boolean(op.idempotency),
              idempotencyKeyRequired: requiresIdempotencyKey(op),
              ...(authentication ? { authModes: op.authModes?.slice().sort() ?? [] } : {}),
              items: op.pagination
                ? [
                    ...new Set(
                      itemSchemas(op, c.definitions).map((s) => namedType(s, models, true)),
                    ),
                  ].join(' | ') || 'never'
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
      ...webhookDeclarations(c, models),
    },
    php: {
      errorSurfaceVersion: 6,
      ...(c.config.webhook ? { webhookReasons: true } : {}),
      // PHP class names are case-insensitive. Preserve a public Webhooks model
      // instead of emitting the optional standalone verifier over its class file.
      ...(c.config.webhook && !Object.keys(models).some((name) => name.toLowerCase() === 'webhooks')
        ? { standaloneWebhook: true }
        : {}),
      runtime: phpRuntime,
      models: [
        ...Object.entries(models).map(([name, s]) =>
          compilePhpModel(name + 'Input', s, false, sharedNames, s, c.definitions),
        ),
        ...c.operations.map((op) =>
          compilePhpModel(
            pascal(op.resource) + pascal(op.method) + 'Input',
            inputSchema(op, c.config.apiVersion, c),
            false,
            sharedNames,
          ),
        ),
        ...c.operations
          .filter((op) => positional(op) && hasParams(op))
          .map((op) =>
            compilePhpModel(
              pascal(op.resource) + pascal(op.method) + 'Params',
              paramsSchema(op, c),
              false,
              sharedNames,
              undefined,
              c.definitions,
            ),
          ),
        ...new Map(responseModels.map((model) => [model.name, model])).values(),
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
                      ? phpType(response.schema, true)
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
            inputSchema(op, c.config.apiVersion, c),
            false,
            undefined,
            false,
            undefined,
            undefined,
            models,
          ),
          nodeOutput: resultType(op),
          phpInput: phpDocType(
            inputSchema(op, c.config.apiVersion, c),
            false,
            c.definitions,
          ).replace(/\|object$/, ''),
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
          Object.entries(op.responses).map(([status, response]) => {
            const body = compileResultPlan(status, response);
            return [status, body ? { body } : {}];
          }),
        ),
      ]),
    ),
    policy: {
      responseOnlyModels: responseOnlyModels(source),
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
            input: compileSchemaPolicy(inputSchema(op, source.config.apiVersion, source), 'input'),
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
  const outputAliases = new Map<string, string>();
  const partialResources = new Set<string>();
  const findPartials = (schema: Schema): void => {
    if (typeof schema['x-flint-partial-of'] === 'string')
      partialResources.add(schema['x-flint-partial-of']);
    Object.values(schema.properties ?? {}).forEach(findPartials);
    for (const branches of [schema.allOf, schema.oneOf, schema.anyOf])
      branches?.forEach(findPartials);
    if (schema.items) findPartials(schema.items);
  };
  Object.values(models).forEach(findPartials);
  // Consume comments before literals: prose punctuation must not hide type references.
  const replaceOutputNames = (type: string): string =>
    type.replace(
      /\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[A-Za-z_$][\w$]*/g,
      (token) =>
        token.startsWith('/*')
          ? token.replace(
              /\{@(link|see) (\w+)\}/g,
              (_, tag: string, name: string) => `{@${tag} ${outputAliases.get(name) ?? name}}`,
            )
          : (outputAliases.get(token) ?? token),
    );
  // Repeating after each grouping also collapses envelopes whose children became aliases.
  for (;;) {
    const shapes = new Map<string, string>();
    let changed = false;
    for (const name of Object.keys(plan.node.models).sort(
      (a, b) => a.length - b.length || a.localeCompare(b, 'en'),
    )) {
      if (outputAliases.has(name) || partialResources.has(name)) continue;
      const model = plan.node.models[name]!;
      const shape = replaceOutputNames(model.output);
      const existing = shapes.get(shape);
      if (existing) {
        outputAliases.set(name, existing);
        changed = true;
      } else shapes.set(shape, name);
    }
    if (!changed) break;
    for (const [name, target] of outputAliases)
      outputAliases.set(name, outputAliases.get(target) ?? target);
  }
  for (const [name, model] of Object.entries(plan.node.models)) {
    const alias = outputAliases.get(name);
    if (alias) model.outputAlias = alias;
    model.output = replaceOutputNames(model.output);
    if (model.documentedOutput) model.documentedOutput = replaceOutputNames(model.documentedOutput);
  }
  for (const [id, operation] of Object.entries(plan.node.operations)) {
    operation.output = replaceOutputNames(operation.output);
    const source = c.operations.find((op) => op.id === id)!;
    // Response metadata keeps the declared component name even when codecs and payloads share a shape.
    const declaredResponse = resultType(source, models);
    const alias = responseAliases.get(id);
    if (!alias) throw new Error('Missing response alias for ' + id);
    operation.responseType = Object.hasOwn(plan.node.models, declaredResponse)
      ? declaredResponse
      : Object.hasOwn(plan.node.models, operation.output)
        ? operation.output
        : alias;
    operation.items = replaceOutputNames(operation.items);
    if (operation.known) operation.known.type = replaceOutputNames(operation.known.type);
  }
  {
    const project = (schema: Schema, path: string[]): Schema[] => {
      if (!path.length) return [schema];
      return valueScopes(schema, c.definitions).flatMap((shape) => {
        const child =
          shape.properties?.[path[0]!] ??
          (/^(?:0|[1-9][0-9]*)$/.test(path[0]!) ? shape.items : undefined);
        return child ? project(child, path.slice(1)) : [];
      });
    };
    const errors = c.operations.flatMap((op) =>
      Object.entries(op.responses).flatMap(([status, response]) =>
        (Number(status) >= 400 || status === 'default') && response.schema ? [response.schema] : [],
      ),
    );
    const mapping = errorMapping(c.config.errors);
    const shapes = (path: string) =>
      errors.flatMap((schema) =>
        project(schema, [mapping.objectPath, path].filter(Boolean).join('.').split('.')),
      );
    for (const [key, path] of Object.entries(c.config.errors?.fields ?? {}))
      if (!shapes(path).length)
        throw new Diagnostic(
          `config/errors/fields/${key}`,
          'configured field is absent from every declared error response schema',
        );
    const type = (path: string, fallback: string): string =>
      [
        ...new Set(
          shapes(path).map((schema) => replaceOutputNames(namedType(schema, models, true))),
        ),
      ].join(' | ') || fallback;
    const open = (path: string, known: string[] = []) =>
      [
        ...new Set([
          ...known,
          ...shapes(path)
            .flatMap((schema) => valueScopes(schema, c.definitions))
            .flatMap(
              (schema) => schema.enum ?? (typeof schema.const === 'string' ? [schema.const] : []),
            )
            .filter((value): value is string => typeof value === 'string'),
        ]),
      ]
        .map((value) => JSON.stringify(value))
        .concat('(string & {})')
        .join(' | ');
    plan.node.errorTypes = {
      code: open(mapping.fields.code),
      type: open(mapping.fields.type),
      errorSource: open(mapping.fields.errorSource, [
        'caller',
        'merchant',
        'merchant_endpoint',
        'flint',
      ]),
      details:
        [
          ...new Set(
            shapes(mapping.fields.details)
              .flatMap((schema) => valueScopes(schema, c.definitions))
              .filter(
                (schema) =>
                  schema.type === 'array' ||
                  (Array.isArray(schema.type) && schema.type.includes('array')),
              )
              .map((schema) =>
                replaceOutputNames(
                  namedType(
                    { type: 'array', ...(schema.items ? { items: schema.items } : {}) },
                    models,
                    true,
                  ).replace(/^Array</, 'ReadonlyArray<'),
                ),
              ),
          ),
        ].join(' | ') || 'readonly Record<string, unknown>[]',
      remediation: type(mapping.fields.remediation, 'ErrorRemediation'),
    };
  }

  if (plan.node.eventDeclarations)
    plan.node.eventDeclarations = replaceOutputNames(plan.node.eventDeclarations);
  const responseReturns = Object.fromEntries(
    c.operations
      .filter((op) => op.response?.return === 'payload')
      .map((op) => {
        const projected = payloadSchemas(op, c.definitions);
        const uncertain = payloadHasAlternatives(op, c.definitions);
        if (uncertain && projected.length) {
          const runtimeOperation = plan.runtime.operations.find(
            (operation) => operation.id === op.id,
          )!;
          runtimeOperation.payloadCodecs = projected.map(compileCodec);
        }
        const nativeTypes = [...new Set(projected.flatMap((s) => phpType(s, true).split('|')))];
        return [
          op.id,
          {
            path: op.response?.payloadPath?.split('.') ?? [],
            ...(uncertain && projected.length ? { validate: true as const } : {}),
            ...(op.pagination || op.polling ? { helperReturn: 'payload' as const } : {}),
            node: projected.length
              ? replaceOutputNames(
                  [...new Set(projected.map((s) => namedType(s, models, true)))].join(' | '),
                )
              : plan.node.operations[op.id]!.output,
            nodeDocumentation: replaceOutputNames(
              projected.length
                ? projected.map((s) => typescriptType(s, true)).join(' | ')
                : plan.documentation[op.id]!.nodeOutput,
            ),
            php: uncertain
              ? 'mixed'
              : projected.length
                ? projected.map((s) => phpDocType(s, true)).join('|')
                : plan.php.operations[op.id]!.output,
            phpNative: uncertain
              ? 'mixed'
              : projected.length
                ? nativeTypes.includes('mixed')
                  ? 'mixed'
                  : nativeTypes.join('|')
                : 'mixed',
          },
        ];
      }),
  );
  if (Object.keys(responseReturns).length) {
    plan.responseReturns = responseReturns;
    plan.node.responseReturnDeclarations = '';
  }
  for (const name of Object.values(plan.node.eventTypes ?? {}))
    if (plan.node.models[name]) plan.node.models[name]!.outputAlias = name;
  if (plan.targets.includes('node')) {
    // The finalized declaration expressions are the sole source of certification.
    // Parse their TypeScript syntax rather than interpreting source schemas again.
    const certificate = publicTypePlanner({
      ...Object.fromEntries(
        Object.entries(plan.node.models).map(([name, model]) => [
          name,
          model.outputAlias ?? model.output,
        ]),
      ),
      ...publicTypeDeclarations(plan.node.eventDeclarations ?? ''),
    });
    if (plan.node.errorTypes) {
      const typed = plan.node.errorTypes.details !== 'unknown';
      if (typed) plan.runtime.errorDetailsCertificate = certificate(plan.node.errorTypes.details);
    }
    for (const operation of plan.runtime.operations) {
      const node = plan.node.operations[operation.id]!;
      plan.documentation[operation.id]!.nodeOutput = replaceOutputNames(
        plan.documentation[operation.id]!.nodeOutput,
      );
      operation.outputCertificate = certificate(node.output);
      if (operation.pagination) operation.itemCertificate = certificate(node.items);
      const payload = responseReturns[operation.id];
      if (payload) operation.payloadCertificate = certificate(payload.node);
      if (node.known) node.known.certificate = certificate(node.known.type);
    }
    if (plan.runtime.webhook && plan.node.eventDeclarations)
      plan.runtime.webhook.certificate = certificate('KnownWebhookEvent');
  }
  if (plan.targets.includes('php')) {
    // Examples/defaults historically participate in PHP entity identity and
    // pins. Publication must remove values without changing those decisions.
    const semantic = targetContract(source, 'semantic');
    for (const op of semantic.operations)
      for (const response of Object.values(op.responses))
        if (response.schema) response.schema = exposeResponseUnion(response.schema);
    const representations = phpRepresentations(
      modelsUsed(semantic),
      semantic.definitions ?? {},
      semantic.config.phpFieldClasses,
    );
    const project = (value: PhpRepresentation, path: string[]): PhpRepresentation => {
      if (!path.length) return value;
      if (value.kind === 'entity') {
        const entity = representations.entities.get(value.name);
        const child = entity?.representation.fields[path[0]!];
        if (child) return project(child, path.slice(1));
      }
      return { kind: 'value', type: 'mixed' };
    };
    for (const op of semantic.operations) {
      const compiled = plan.php.runtime.operations.find((entry) => entry.id === op.id);
      if (!compiled) throw new Error('Missing PHP operation');
      for (const [status, response] of Object.entries(op.responses)) {
        const result = compiled.responses[status];
        if (!result || !response.schema || !(successStatus(status) || status === 'default'))
          continue;
        const prefix = responseNames.get(op.id + '/' + status);
        if (!prefix) throw new Error('Missing response type name for ' + op.id + '/' + status);
        const shape = phpDeclaration(response.schema, semantic.definitions);
        if (
          result.model &&
          (Object.keys(shape.properties ?? {}).length || shape.additionalProperties === false)
        )
          result.phpRepresentation = representations.model(
            result.model,
            response.schema,
            responseComponent(response.schema, Object.keys(models))
              ? 'models.' + result.model
              : result.model,
          );
        else if (result.variants && response.schema.oneOf && response.schema.discriminator) {
          const variants: Record<string, PhpRepresentation> = {};
          for (const [tag, index] of Object.entries(discriminatorBindings(response.schema) ?? {})) {
            const branch = response.schema.oneOf[index];
            const name = result.variants[tag];
            if (branch && name)
              variants[tag] = representations.model(name, responseVariant(response.schema, branch));
          }
          result.phpRepresentation = {
            kind: 'tagged',
            field: response.schema.discriminator.propertyName,
            variants,
          };
        } else result.phpRepresentation = representations.compile(response.schema, prefix);
        // Keep legacy class-identity facts aligned with the public representation.
        if (result.phpRepresentation.kind === 'entity')
          result.model = result.phpRepresentation.name;
        else delete result.model;
      }
      const outputs = Object.entries(compiled.responses)
        .filter(([status]) => successStatus(status) || status === 'default')
        .map(([, result]) =>
          result.phpRepresentation
            ? phpRepresentationType(result.phpRepresentation)
            : result.bodyKind === 'sse'
              ? 'EventStream'
              : result.bodyKind === 'binary'
                ? 'string'
                : result.classification === 'redirect'
                  ? '\\stdClass'
                  : 'null',
        );
      plan.php.operations[op.id]!.output = outputs.includes('mixed')
        ? 'mixed'
        : [...new Set(outputs)].join('|');
      if (op.pagination) {
        const items = Object.entries(compiled.responses)
          .filter(([status]) => successStatus(status) || status === 'default')
          .map(([, result]) =>
            project(
              result.phpRepresentation ?? { kind: 'value', type: 'mixed' },
              op.pagination!.items.split('.'),
            ),
          )
          .map((value) =>
            phpRepresentationType(
              value.kind === 'list' ? value.value : { kind: 'value', type: 'mixed' },
            ),
          );
        plan.php.operations[op.id]!.items = items.includes('mixed')
          ? 'mixed'
          : [...new Set(items)].join('|');
      }
      const returns = plan.responseReturns?.[op.id];
      if (returns && !payloadHasAlternatives(op, c.definitions)) {
        const values = Object.entries(compiled.responses)
          .filter(([status]) => successStatus(status) || status === 'default')
          .map(([, result]) =>
            project(result.phpRepresentation ?? { kind: 'value', type: 'mixed' }, returns.path),
          );
        const join = (native: boolean) => {
          const payloadType = (value: PhpRepresentation): string =>
            value.kind === 'entity'
              ? value.name
              : value.kind === 'tagged'
                ? [...new Set([...Object.values(value.variants).map(payloadType), 'Model'])].join(
                    '|',
                  )
                : 'Model';
          const types = [...new Set(values.map(payloadType))];
          return native ? phpUnion(types) : types.includes('mixed') ? 'mixed' : types.join('|');
        };
        returns.php = join(false);
        returns.phpNative = join(true);
      }
    }
    for (const [event, name] of Object.entries(eventModels)) {
      const schema = semantic.config.webhook?.events[event];
      if (schema)
        representations.model(
          name,
          schema,
          Object.hasOwn(semantic.models, name) ? 'models.' + name : undefined,
        );
    }
    for (const name of c.webhookAudienceModels ?? [])
      if (semantic.models[name])
        representations.model(name, semantic.models[name], 'models.' + name);
    representations.checkFieldClasses();
    for (const entity of representations.entities.values()) {
      const model = compilePhpModel(
        entity.name,
        entity.schema,
        true,
        sharedNames,
        entity.declaration,
        {},
        false,
        entity.representation,
        semantic.definitions,
      );
      model.representation = entity.representation;
      const required = new Set(
        phpDeclaration(entity.declaration, entity.schema['x-sdk-definitions']).required,
      );
      for (const getter of model.getters) {
        const value = entity.representation.fields[getter.field];
        if (value) {
          const type = phpRepresentationType(value, true);
          const doc = phpRepresentationType(value);
          getter.type = !required.has(getter.field) ? nullablePhpAccessor(type) : type;
          getter.doc = !required.has(getter.field) ? nullablePhpAccessor(doc) : doc;
        }
      }
      const existing = plan.php.models.findIndex((value) => value.name === model.name);
      if (existing >= 0) {
        if (!plan.php.models[existing]!.response)
          throw new Diagnostic(model.name, 'PHP entity collides with an input class');
        plan.php.models[existing] = model;
      } else plan.php.models.push(model);
    }
    for (const model of plan.php.models) {
      const methods = new Map(
        [
          '__construct',
          '__get',
          '__isset',
          '__debugInfo',
          'get',
          'has',
          'valueOrDefault',
          'toArray',
          'toInputArray',
          'toInputValue',
          'jsonSerialize',
          'hydrate',
          'assertRepresentation',
          'copyValue',
        ].map((name) => [name.toLowerCase(), 'Model::' + name]),
      );
      for (const getter of model.getters) {
        if (!getter.method)
          throw new Diagnostic(
            model.name + '.' + getter.field,
            'PHP field has no usable accessor name',
          );
        const path = model.name + '.' + getter.field;
        for (const method of [getter.method, 'has' + getter.method.slice(3)]) {
          const previous = methods.get(method.toLowerCase());
          if (previous !== undefined)
            throw new Diagnostic(
              path,
              `PHP field accessor collision between ${previous} and ${path}`,
            );
          methods.set(method.toLowerCase(), path);
        }
      }
    }
  }
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
  return targetContract(c, 'publication');
}
function targetContract(c: Contract, purpose: 'semantic' | 'publication'): Contract {
  c = JSON.parse(stable(c)) as Contract;
  if (purpose === 'publication') omitProtectedExamples(c);
  else markProtectedDocumentation(c);
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

export type SampleValidator = (value: unknown, codec: CodecPlan) => boolean;
type SampleCodecCompiler = (schema: Schema) => CodecPlan;

/** Reuse sample codecs only while the caller owns a stable generation schema graph. */
export function sampleCodecCompiler(definitions: Record<string, Schema>): SampleCodecCompiler {
  const codecs = new WeakMap<Schema, CodecPlan>();
  let compiledDefinitions: CodecPlan['definitions'];
  return (schema) => {
    const cached = codecs.get(schema);
    if (cached) return cached;
    // Compile definitions at the same depth as an attached schema registry, once.
    const { 'x-sdk-definitions': ignored, ...shape } = schema;
    const compiled = compileCodec(shape);
    compiledDefinitions ??= compileCodec({ 'x-sdk-definitions': definitions }).definitions;
    const codec = {
      ...compiled,
      ...(compiledDefinitions ? { definitions: compiledDefinitions } : {}),
    };
    codecs.set(schema, codec);
    return codec;
  };
}

/** Formats ignored by wire codecs still need valid documentation sample values. */
function validSampleFormat(
  value: unknown,
  schema: Schema,
  definitions: Record<string, Schema>,
): boolean {
  const scopes = valueScopes(schema, definitions);
  if (Array.isArray(value))
    return value.every((child) =>
      validSampleFormat(
        child,
        { allOf: scopes.flatMap((shape) => (shape.items ? [shape.items] : [])) },
        definitions,
      ),
    );
  if (typeof value !== 'string') return true;
  const date = (text: string) =>
    /^\d{4}-\d{2}-\d{2}$/.test(text) &&
    Number.isFinite(Date.parse(text)) &&
    new Date(text).toISOString().slice(0, 10) === text;
  const ipv4 = (text: string) =>
    text.split('.').length === 4 &&
    text.split('.').every((part) => /^(?:0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255);
  const ipv6 = (text: string) => {
    if (
      !/^[\da-f:.]+$/i.test(text) ||
      text.split('::').length > 2 ||
      (text.startsWith(':') && !text.startsWith('::')) ||
      (text.endsWith(':') && !text.endsWith('::')) ||
      text.includes(':::')
    )
      return false;
    const parts = text.split(':');
    const tail = parts.at(-1) ?? '';
    const units = parts.filter(Boolean).length + (tail.includes('.') ? 1 : 0);
    return (
      (text.includes('::') ? units < 8 : units === 8) &&
      parts.every((part, index) =>
        !part
          ? text.includes('::')
          : part.includes('.')
            ? index === parts.length - 1 && ipv4(part)
            : /^[\da-f]{1,4}$/i.test(part),
      )
    );
  };
  return scopes.every((shape) => {
    switch (shape.format) {
      case 'uuid':
        return /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value);
      case 'date':
        return date(value);
      case 'date-time': {
        const match =
          /^(\d{4}-\d{2}-\d{2})[tT](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[zZ]|[+-]\d{2}:\d{2})$/.exec(
            value,
          );
        const datePart = match?.[1];
        return Boolean(
          match &&
            datePart !== undefined &&
            date(datePart) &&
            Number(match[2]) < 24 &&
            Number(match[3]) < 60 &&
            Number(match[4]) < 60 &&
            Number.isFinite(Date.parse(value)),
        );
      }
      case 'email':
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
      case 'uri': {
        if (!/^[a-z][a-z\d+.-]*:[^\s]+$/i.test(value) || /%(?![\da-f]{2})/i.test(value))
          return false;
        try {
          new URL(value);
          return true;
        } catch (error) {
          if (!(error instanceof TypeError)) throw error;
          return false;
        }
      }
      case 'hostname':
        return (
          value.length <= 253 &&
          value
            .replace(/\.$/, '')
            .split('.')
            .every((part) => /^(?:[a-z\d]|[a-z\d][a-z\d-]{0,61}[a-z\d])$/i.test(part))
        );
      case 'ipv4':
        return ipv4(value);
      case 'ipv6':
        return ipv6(value);
      default:
        return true;
    }
  });
}
function validSample(
  value: unknown,
  schema: Schema,
  definitions: Record<string, Schema>,
  accepts: SampleValidator,
  compile: SampleCodecCompiler,
): boolean {
  return validSampleFormat(value, schema, definitions) && accepts(value, compile(schema));
}

/** Parameter metadata is already literal source data; do not annotate the schema or contract. */
export function parameterExample(
  parameter: Parameter,
  definitions: Record<string, Schema>,
  accepts: SampleValidator,
  compile: SampleCodecCompiler = sampleCodecCompiler(definitions),
): { value: unknown } | undefined {
  if (!parameterExampleEligible(parameter, definitions)) return undefined;
  const examples: unknown = Reflect.get(parameter, 'examples');
  const first =
    examples && typeof examples === 'object' && !Array.isArray(examples)
      ? Object.values(examples)[0]
      : undefined;
  const value: unknown = Object.hasOwn(parameter, 'example')
    ? Reflect.get(parameter, 'example')
    : first && typeof first === 'object' && Object.hasOwn(first, 'value')
      ? Reflect.get(first, 'value')
      : undefined;
  if (value === undefined) return undefined;
  // SourceJson's provenance is deliberately not serialized. Never stringify a parsed
  // exact numeric literal: it may already be rounded. Numeric strings retain their token;
  // parsed numeric literals for exact schemas use the placeholder.
  const unproven = (value: unknown, schema: Schema): boolean => {
    const scopes = valueScopes(schema, definitions);
    if (Array.isArray(value))
      return value.some((child) =>
        unproven(child, { allOf: scopes.flatMap((shape) => (shape.items ? [shape.items] : [])) }),
      );
    if (typeof value !== 'number') return false;
    return scopes.some((shape) =>
      (Array.isArray(shape.type) ? shape.type : [shape.type]).some((type) =>
        exactValue(valueInstruction(type, shape.format, shape['x-sdk-integer-mode'])),
      ),
    );
  };
  if (unproven(value, parameter.schema)) return undefined;
  if (validSample(value, parameter.schema, definitions, accepts, compile)) return { value };
  const projected = sampleMetadata(value, parameter.schema, definitions);
  return validSample(projected, parameter.schema, definitions, accepts, compile)
    ? { value: projected }
    : undefined;
}
function sampleMetadata(
  value: unknown,
  schema: Schema,
  definitions: Record<string, Schema>,
): unknown {
  const scopes = valueScopes(schema, definitions);
  if (Array.isArray(value))
    return value.map((child) =>
      sampleMetadata(
        child,
        { allOf: scopes.flatMap((shape) => (shape.items ? [shape.items] : [])) },
        definitions,
      ),
    );
  if (value && typeof value === 'object' && !Array.isArray(value))
    return Object.fromEntries(
      Object.entries(value).map(([name, child]) => [
        name,
        sampleMetadata(
          child,
          {
            allOf: scopes.flatMap((shape) =>
              shape.properties?.[name] ? [shape.properties[name]!] : [],
            ),
          },
          definitions,
        ),
      ]),
    );
  const exact = scopes.find((shape) =>
    (Array.isArray(shape.type) ? shape.type : [shape.type]).some((type) =>
      exactValue(valueInstruction(type, shape.format, shape['x-sdk-integer-mode'])),
    ),
  );
  if (
    exact &&
    (typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value)))
  )
    return exact['x-sdk-number-input'] === 'explicit'
      ? new ExactNumberSample(String(value))
      : String(value);
  return value;
}

/** Select format placeholders only when the complete input remains valid. */
export function sampleWithFormats(
  schema: Schema,
  definitions: Record<string, Schema>,
  accepts: SampleValidator,
  compile: SampleCodecCompiler = sampleCodecCompiler(definitions),
): unknown {
  const input = sample(schema, {}, definitions, [], undefined, accepts, compile);
  // Local choices can conflict with enclosing composition or cross-field
  // constraints. Preserve main's sample exactly before generation validates it.
  return accepts(input, compile(schema)) ? input : sample(schema, {}, definitions);
}

export function sample(
  s: Schema,
  inherited: Record<string, Schema> = {},
  definitions: Record<string, Schema> = {},
  stack: string[] = [],
  // Observe existing metadata selection without changing its precedence or validation.
  onMetadata?: () => void,
  accepts?: SampleValidator,
  compile: SampleCodecCompiler = sampleCodecCompiler(definitions),
): unknown {
  // A use-site example takes precedence over the referenced model's sample.
  if (s.example !== undefined) {
    onMetadata?.();
    return sampleMetadata(s.example, s, definitions);
  }
  if (s['x-sdk-ref']) {
    const name = s['x-sdk-ref'];
    const target = definitions[name];
    if (!target || stack.includes(name))
      throw new Diagnostic('example', 'provide a finite example for recursive model ' + name);
    if (Array.isArray(target.type) && target.type.includes('null')) return null;
    return sample(target, inherited, definitions, [...stack, name], onMetadata, accepts, compile);
  }
  s = directionalSchema(s, false);
  if (Object.hasOwn(s, 'const')) {
    onMetadata?.();
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
            exactValue(valueInstruction(type, shape.format, shape['x-sdk-integer-mode'])),
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
    let result = sample(base, properties, definitions, stack, onMetadata, accepts, compile);
    for (const branch of [...(allOf ?? []), ...(oneOf ?? anyOf ?? []).slice(0, 1)]) {
      const next = sample(
        { ...(typed ? { type: typed.type } : {}), ...(item ? { items: item } : {}), ...branch },
        properties,
        definitions,
        stack,
        onMetadata,
        accepts,
        compile,
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
  if (s.enum?.length) {
    onMetadata?.();
    return s.enum[0] !== null && exactValue(valueInstruction(t, s.format, s['x-sdk-integer-mode']))
      ? s['x-sdk-number-input'] === 'explicit'
        ? new ExactNumberSample(String(s.enum[0]))
        : String(s.enum[0])
      : s.enum[0];
  }
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
      selected.map(([key, child]) => [
        key,
        sample(child, {}, definitions, stack, onMetadata, accepts, compile),
      ]),
    );
    if (Object.keys(result).length < (s.minProperties ?? 0) && s.additionalProperties !== false) {
      for (let i = Object.keys(result).length; i < (s.minProperties ?? 0); i++)
        result['example' + i] = sample(
          typeof s.additionalProperties === 'object' ? s.additionalProperties : {},
          {},
          definitions,
          stack,
          onMetadata,
          accepts,
          compile,
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
        onMetadata,
        accepts,
        compile,
      ),
    );
  if (t === 'boolean') return true;
  if (t === 'integer' || t === 'number') {
    const fallback =
      t === 'integer'
        ? exactValue(valueInstruction(t, s.format, s['x-sdk-integer-mode']))
          ? 100
          : 1
        : 1;
    const step = s.multipleOf ?? (t === 'integer' ? 1 : 0.01);
    let value =
      s.minimum ?? (s.exclusiveMinimum !== undefined ? s.exclusiveMinimum + step : fallback);
    if (s.multipleOf) value = Math.ceil(value / s.multipleOf) * s.multipleOf;
    if (s.maximum !== undefined) value = Math.min(value, s.maximum);
    if (s.exclusiveMaximum !== undefined && value >= s.exclusiveMaximum)
      value = s.exclusiveMaximum - step;
    if (!exactValue(valueInstruction(t, s.format, s['x-sdk-integer-mode']))) return value;
    const token =
      t === 'number' && value === 1 && s.multipleOf === undefined ? '1.00' : String(value);
    return s['x-sdk-number-input'] === 'explicit' ? new ExactNumberSample(token) : token;
  }
  if (t === 'string') {
    // Preserve main's sample exactly when a new format candidate cannot satisfy
    // all constraints. Padding/truncating a format value can invalidate it too.
    const fallback =
      s.format === 'date'
        ? '2026-01-01'
        : s.format === 'date-time'
          ? '2026-01-01T00:00:00Z'
          : s.format === 'email'
            ? 'example@example.invalid'
            : 'example';
    const formatted = (
      {
        uuid: '00000000-0000-4000-8000-000000000001',
        date: '2026-01-01',
        'date-time': '2026-01-01T00:00:00Z',
        email: 'example@example.invalid',
        uri: 'https://example.invalid/',
        hostname: 'example.invalid',
        ipv4: '192.0.2.1',
        ipv6: '2001:db8::1',
      } as Record<string, string>
    )[s.format ?? ''];
    if (
      formatted !== undefined &&
      accepts &&
      validSample(formatted, s, definitions, accepts, compile)
    )
      return formatted;
    return fallback.padEnd(s.minLength ?? 0, 'x').slice(0, s.maxLength);
  }
  if (t === 'null') return null;
  return 'example';
}
