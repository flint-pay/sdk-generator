import {
  readFileSync,
  existsSync,
  lstatSync,
  readdirSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  rmSync,
  cpSync,
  openSync,
  closeSync,
} from 'node:fs';
import { dirname, resolve, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { compareSchemas } from './compatibility.js';
import { artifactHashes, prepareSite, verifyRelease } from './distribution.js';
import { checkVersionPolicy } from './version.js';
import { directionalSchema, serialize } from './runtime.js';
import {
  type Contract,
  type Config,
  type Schema,
  type Operation,
  Diagnostic,
  stable,
  hash,
  loadContract,
} from './contract.js';
export interface Change {
  path: string;
  kind: 'created' | 'modified' | 'removed';
  reason: string;
  diff?: string;
}
export interface Compatibility {
  severity: 'breaking' | 'additive' | 'review';
  subject: string;
  message: string;
}
interface RecordFile {
  recordVersion?: number;
  generator: string;
  contractHash: string;
  sources: Record<string, string>;
  files: Record<string, string>;
  interface: Contract;
  compatibility?: Compatibility[];
  previousVersion?: string;
  comparisonBase?: Contract;
}
const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const packageMetadata = JSON.parse(readFileSync(join(here, '../package.json'), 'utf8'));
const version = packageMetadata.version as string;
const recordName = '.sdk-generator.json';
function comparisonBase(before: RecordFile, next: Contract): Contract {
  return before.interface.config.version === next.config.version ||
    before.previousVersion === before.interface.config.version
    ? (before.comparisonBase ?? before.interface)
    : before.interface;
}
// Computed keys retain JSON's own-property semantics in JavaScript literals.
const js = (v: unknown, space = 2) =>
  JSON.stringify(v, null, space)?.replaceAll('"__proto__":', '["__proto__"]:');
const php = (s: string) => "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
const pascal = (s: string) => s[0]!.toUpperCase() + s.slice(1);
const comment = (s: string) => s.replaceAll('*/', '* /').replaceAll('\r', '');
function methodDoc(
  op: Operation,
  method: string,
  definitions: Record<string, Schema> = {},
): string {
  const deprecated =
    method !== op.method
      ? `Use ${op.resource}.${op.method}; HTTP behavior is unchanged.`
      : op.deprecated;
  return `/**\n * ${comment(op.description).replaceAll('\n', '\n * ')}\n * ${op.verb} ${comment(op.path)}\n${deprecated ? ` * @deprecated ${comment(deprecated).replaceAll('\n', '\n * ')}\n` : ''} * @example client.${op.resource}.${method}(${comment(js(exampleInput(op, definitions), 0)!)})\n */\n`;
}
function optionalPropertyType(key: string, value: string): string {
  // An omitted own property still exposes Object's inherited member in TypeScript.
  return [
    'constructor',
    'toString',
    'toLocaleString',
    'valueOf',
    'hasOwnProperty',
    'isPrototypeOf',
    'propertyIsEnumerable',
  ].includes(key)
    ? `(${value}) | Object[${JSON.stringify(key)}]`
    : value;
}
function type(s: Schema, response = false, discriminator?: string, known = false): string {
  if (s['x-sdk-ref']) return s['x-sdk-ref'] + (response ? '' : 'Input');
  s = directionalSchema(s, response);
  if (s.oneOf || s.anyOf || s.allOf || s.not) {
    const { oneOf, anyOf, allOf, not, discriminator: tag, ...base } = s;
    const parts = [type(base, response, discriminator)];
    for (const branch of allOf ?? []) parts.push(type(branch, response, discriminator));
    for (const branches of [oneOf, anyOf])
      if (branches) {
        const alternatives = branches.map((branch) => type(branch, response, tag?.propertyName));
        if (response && !known)
          alternatives.push(
            base.type === 'object' ||
              branches.every((v) => v.type === 'object' || v.required || v.properties)
              ? '{ [key: string]: unknown }'
              : 'unknown',
          );
        parts.push(alternatives.map((v) => '(' + v + ')').join(' | '));
      }
    if (not && !response) {
      const absent = (constraint: Schema): string => {
        // Negating a value constraint does not imply that the field must be absent.
        const keywords = Object.keys(constraint).filter(
          (key) =>
            ![
              'description',
              'title',
              'default',
              'example',
              'examples',
              'deprecated',
              'readOnly',
              'writeOnly',
            ].includes(key) && !key.startsWith('x-'),
        );
        if (keywords.length !== 1) return 'unknown';
        if (constraint.required?.length)
          return constraint.required
            .map(
              (key) =>
                '{ ' + JSON.stringify(key) + '?: ' + optionalPropertyType(key, 'never') + ' }',
            )
            .join(' | ');
        if (constraint.anyOf) return constraint.anyOf.map((v) => '(' + absent(v) + ')').join(' & ');
        return 'unknown';
      };
      parts.push(absent(not));
    }
    return (
      parts
        .filter((v) => v !== 'unknown')
        .map((v) => '(' + v + ')')
        .join(' & ') || 'unknown'
    );
  }
  const types = Array.isArray(s.type) ? s.type : [s.type];
  if (types.length > 1) return types.map((t) => type({ ...s, type: t! }, response)).join(' | ');
  // Equivalent numeric enum values have many valid spellings (1, 1.0, 1e0).
  // Their exact string representation is checked by the runtime, not a literal union.
  if (
    s.enum &&
    (s.type === 'number' || (s.type === 'integer' && ['int64', 'uint64'].includes(s.format ?? '')))
  )
    return 'string';
  if (s.enum && !response)
    return (
      s.enum
        .filter(
          (v) =>
            !types[0] ||
            (v === null
              ? types[0] === 'null'
              : typeof v === 'number'
                ? ['number', 'integer'].includes(types[0])
                : typeof v === types[0]),
        )
        .map((v) =>
          JSON.stringify(
            v !== null && (['int64', 'uint64'].includes(s.format ?? '') || s.type === 'number')
              ? String(v)
              : v,
          ),
        )
        .join(' | ') || 'never'
    );
  switch (types[0]) {
    case 'null':
      return 'null';
    case 'string':
      return s.enum
        ? s.enum.map((v) => JSON.stringify(v)).join(' | ') + ' | (string & {})'
        : 'string';
    case 'boolean':
      return 'boolean';
    case 'number':
      return 'string';
    case 'integer':
      return ['int64', 'uint64'].includes(s.format ?? '') ? 'string' : 'number';
    case 'array':
      return `Array<${type(s.items!, response)}>`;
    case undefined:
      if (!s.properties && !s.required?.length) return 'unknown';
    case 'object':
      if (!Object.keys(s.properties ?? {}).length && typeof s.additionalProperties === 'object')
        return `Record<string, ${type(s.additionalProperties, response)}>`;
      return (
        '{ ' +
        [...new Set([...Object.keys(s.properties ?? {}), ...(s.required ?? [])])]
          .map((key) => [key, s.properties?.[key] ?? {}] as [string, Schema])
          .filter(([, v]) => !response || !v.writeOnly)
          .map(([k, v]) =>
            !response && v.readOnly
              ? `${JSON.stringify(k)}?: ${optionalPropertyType(k, 'never')};`
              : `${JSON.stringify(k)}${s.required?.includes(k) ? '' : '?'}: ${s.required?.includes(k) ? type(v, response && k !== discriminator) : optionalPropertyType(k, type(v, response && k !== discriminator))};`,
          )
          .join(' ') +
        (response || s.additionalProperties !== false ? ` [key: string]: unknown;` : '') +
        ' }'
      );
    default:
      return 'unknown';
  }
}
function phpType(s: Schema): string {
  if (s.oneOf || s.anyOf || s.allOf || s.type === undefined) return 'mixed';
  const types = Array.isArray(s.type) ? s.type : [s.type];
  return [
    ...new Set(
      types.map((t) =>
        t === 'null'
          ? 'null'
          : t === 'integer'
            ? ['int64', 'uint64'].includes(s.format ?? '')
              ? 'string'
              : 'int'
            : t === 'number'
              ? 'string'
              : t === 'boolean'
                ? 'bool'
                : t === 'object'
                  ? 'array|object'
                  : t === 'array'
                    ? 'array'
                    : 'string',
      ),
    ),
  ].join('|');
}
function phpShape(s: Schema, response = false): string {
  if (s.type === 'object')
    return (
      'array{' +
      Object.entries(s.properties ?? {})
        .filter(([, v]) => (response ? !v.writeOnly : !v.readOnly))
        .map(([k, v]) => `${php(k)}${s.required?.includes(k) ? '' : '?'}: ${phpType(v)}`)
        .join(', ') +
      '}'
    );
  return 'array<string, mixed>';
}
function phpDocType(s: Schema, response = false): string {
  if (s.oneOf || s.anyOf)
    return (
      (s.oneOf ?? s.anyOf)!.map((v) => phpDocType(v, response)).join('|') +
      (response ? '|mixed' : '')
    );
  if (s.allOf) return s.allOf.map((v) => phpDocType(v, response)).join('&');
  if (s.type === 'array') return `list<${phpDocType(s.items!, response)}>`;
  if (s.type === 'object')
    return `${response ? 'object' : 'array'}{${Object.entries(s.properties ?? {})
      .filter(([, v]) => (response ? !v.writeOnly : !v.readOnly))
      .map(([k, v]) => `${php(k)}${s.required?.includes(k) ? '' : '?'}: ${phpDocType(v, response)}`)
      .join(', ')}}`;
  return phpType(s);
}
function phpModel(
  name: string,
  s: Schema,
  response = false,
  recursive = false,
  validation: Config['validation'] = 'encoding',
): string {
  s = { ...s, 'x-sdk-validation': validation };
  let code = `/** Presence-aware ${response ? 'response' : 'input'}; omitted fields throw when accessed. */\nfinal class ${name} extends Model {\n    /** @param ${comment(s.type === 'object' ? phpShape(s, response) : phpDocType(s, response))} $values */\n    public function __construct(${phpType(s)} $values${s.type === 'object' ? ' = []' : ''}, array $redactFields = []) { parent::__construct($values, json_decode(${php(JSON.stringify(s))}, true, 512, JSON_THROW_ON_ERROR)${recursive ? " + ['x-sdk-definitions' => SchemaRegistry::definitions()]" : ''}, ${response ? 'true' : 'false'}, $redactFields); }\n`;
  const accessors = new Set<string>();
  for (const [field, v] of Object.entries(s.properties ?? {})) {
    if (response ? v.writeOnly : v.readOnly) continue;
    if (accessors.has(field.toLowerCase()))
      throw new Diagnostic(
        name,
        `PHP field accessor collision for ${field}; correct the model naming before generation`,
      );
    accessors.add(field.toLowerCase());
    if (/^[A-Za-z][A-Za-z0-9_]*$/.test(field))
      code += `    /** @return ${comment(phpDocType(v, response))} */\n    public function get${pascal(field)}(): ${phpType(v)} { return $this->get(${php(field)}); }\n`;
  }
  return code + '}\n';
}
function inputSchema(op: Operation): Schema {
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
function namedType(s: Schema, models: Record<string, Schema>, response = false): string {
  const match = Object.entries(models).find(([, value]) => stable(value) === stable(s));
  return match ? match[0] + (response ? '' : 'Input') : type(s, response);
}
function operationInputType(op: Operation, models: Record<string, Schema>): string {
  const schema = inputSchema(op);
  return `{ ${Object.entries(schema.properties!)
    .map(
      ([key, value]) =>
        `${JSON.stringify(key)}${schema.required!.includes(key) ? '' : '?'}: ${schema.required!.includes(key) ? `InputValue<${namedType(value, models)}>` : optionalPropertyType(key, `InputValue<${namedType(value, models)}>`)};`,
    )
    .join(' ')} }`;
}
function resultType(op: Operation, models: Record<string, Schema> = {}): string {
  return [
    ...new Set(
      Object.entries(op.responses)
        .filter(([k]) => /^2\d\d$/.test(k) || k === '304' || k === 'default')
        .map(([, v]) => (v.schema ? namedType(v.schema, models, true) : 'undefined')),
    ),
  ].join(' | ');
}
function itemSchemas(op: Operation): Schema[] {
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
function runtimeContract(c: Contract) {
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
function modelsUsed(c: Contract) {
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
function sample(
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
      (['int64', 'uint64'].includes(s.format ?? '') || s.type === 'number')
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
  if (t === 'integer') return ['int64', 'uint64'].includes(s.format ?? '') ? '100' : 1;
  if (t === 'number') return '1.00';
  if (t === 'null') return null;
  return 'example';
}
function exampleInput(op: Operation, definitions: Record<string, Schema> = {}): unknown {
  try {
    const input = op.example ?? sample(inputSchema(op), {}, definitions);
    serialize(input, { ...inputSchema(op), 'x-sdk-definitions': definitions });
    return input;
  } catch (error) {
    throw new Diagnostic(
      `config/operations/${op.id}/example`,
      `provide an input example that satisfies this operation: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
export function render(c: Contract): Map<string, string> {
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
  const files = new Map<string, string>();
  const targets = c.config.targets ?? ['node', 'php'];
  const groups = [...new Set(c.operations.map((o) => o.resource))].sort();
  const models = modelsUsed(c);
  const symbols = new Set(
    [
      'Client',
      'Runtime',
      'Model',
      'Result',
      'SdkError',
      'Codec',
      'RawNumber',
      'ParsedNumber',
      'Cancellation',
      'ClientOptions',
      'RequestOptions',
      'InputValue',
      'Metadata',
      'ErrorKind',
      'DiagnosticEvent',
      'serialize',
      'parseExact',
      'redact',
      ...(targets.includes('node')
        ? [
            'Promise',
            'AsyncGenerator',
            'Record',
            'Object',
            'Array',
            'any',
            'unknown',
            'number',
            'boolean',
            'bigint',
            'symbol',
            'undefined',
            'intrinsic',
          ]
        : []),
    ].map((n) => n.toLowerCase()),
  );
  const reserve = (n: string) => {
    if (symbols.has(n.toLowerCase()))
      throw new Diagnostic(
        'public interface',
        `generated type collision: ${n}; customize resource/method/model names`,
      );
    symbols.add(n.toLowerCase());
  };
  for (const group of groups) reserve(pascal(group) + 'Resource');
  for (const name of Object.keys(models)) {
    reserve(name);
    reserve(name + 'Input');
  }
  for (const op of c.operations) {
    reserve(pascal(op.resource) + pascal(op.method) + 'Input');
    reserve(pascal(op.resource) + pascal(op.method) + 'Response');
    if (Object.values(op.responses).some((r) => r.schema?.oneOf))
      reserve(pascal(op.resource) + pascal(op.method) + 'ResponseKnown');
  }
  const contract = runtimeContract(c);
  const definitions = c.definitions ?? {};
  if (c.definitions) reserve('SchemaRegistry');
  const license = readFileSync(join(here, '../LICENSE'), 'utf8');
  if (targets.includes('node')) {
    const put = (p: string, value: string) => files.set('node/' + p, value);
    put(
      'package.json',
      stable({
        name: c.config.npm.name,
        version: c.config.version,
        description: `${c.title} server SDK`,
        type: 'module',
        main: './index.js',
        types: './index.d.ts',
        exports: {
          '.': { types: './index.d.ts', import: './index.js' },
          './custom/*': './custom/*',
        },
        engines: { node: '>=22' },
        dependencies: { '@types/node': packageMetadata.dependencies['@types/node'] },
        publishConfig: {
          registry: c.config.npm.registry ?? 'https://registry.npmjs.org',
          access: c.config.npm.access ?? 'public',
        },
        license: c.config.license ?? 'Apache-2.0',
        files: [
          '*.js',
          '*.d.ts',
          'README.md',
          'REFERENCE.md',
          'LICENSE',
          'examples/',
          'guides/',
          'custom/',
        ],
      }),
    );
    put(
      'runtime.js',
      readFileSync(join(here, 'runtime.js'), 'utf8').replace(
        /\n\/\/# sourceMappingURL=.*\n?$/,
        '\n',
      ),
    );
    put('runtime.d.ts', readFileSync(join(here, 'runtime.d.ts'), 'utf8'));
    put('contract.d.ts', readFileSync(join(here, 'contract.d.ts'), 'utf8'));
    let code = `import { Runtime, Model, isKnownVariant } from './runtime.js';\nexport { SdkError, Model, serialize, parseExact, redact } from './runtime.js';\nconst contract = ${js({ ...contract, userAgent: `${c.config.npm.name.replace(/^@/, '').replaceAll('/', '-')}/${c.config.version} (Node.js)` })};\nexport class Client {\n  #runtime;\n  constructor(options) {\n    this.#runtime = new Runtime(contract, options);\n`;
    let declarations = `import type { ClientOptions, RequestOptions, Result, InputValue } from './runtime.js';\nimport { Model } from './runtime.js';\nexport { SdkError, Model, serialize, parseExact, redact } from './runtime.js';\nexport type { ClientOptions, RequestOptions, Result, Metadata, ErrorKind, DiagnosticEvent, InputValue } from './runtime.js';\n`;
    for (const [name, s] of Object.entries(models))
      declarations += `export type ${name} = ${type(s, true)};\nexport type ${name}Input = ${type(s)};\nexport declare function make${name}(value: InputValue<${name}Input>): Model<${name}Input>;\n`;
    for (const op of c.operations)
      declarations += `export type ${pascal(op.resource)}${pascal(op.method)}Input = ${operationInputType(op, models)};\nexport type ${pascal(op.resource)}${pascal(op.method)}Response = ${resultType(op, models)};\n`;
    declarations += 'export declare class Client {\n  constructor(options: ClientOptions);\n';
    for (const group of groups) {
      code += `    this.${group} = Object.freeze({\n`;
      declarations += `  readonly ${group}: {\n`;
      for (const op of c.operations.filter((o) => o.resource === group)) {
        const prefix = pascal(op.resource) + pascal(op.method);
        const required = inputSchema(op).required!.length > 0;
        for (const method of [op.method, ...(op.aliases ?? [])]) {
          code += `      ${method}: (input = {}, options) => this.#runtime.request(${js(op.id)}, input, options),\n`;
          declarations += `    ${methodDoc(op, method, definitions)}    ${method}(input${required ? '' : '?'}: ${prefix}Input, options?: RequestOptions): Promise<Result<${prefix}Response>>;\n`;
        }
        if (op.pagination)
          for (const [suffix, runtime, returnType] of [
            ['Pages', 'pages', `Result<${prefix}Response>`],
            [
              'Items',
              'items',
              [...new Set(itemSchemas(op).map((s) => namedType(s, models, true)))].join(' | ') ||
                'never',
            ],
          ]) {
            code += `      ${op.method}${suffix}: (input = {}, options) => this.#runtime.${runtime}(${js(op.id)}, input, options),\n`;
            declarations += `    ${op.method}${suffix}(input${required ? '' : '?'}: ${prefix}Input, options?: RequestOptions): AsyncGenerator<${returnType}>;\n`;
          }
        if (op.polling) {
          code += `      ${op.method}Wait: (input = {}, options) => this.#runtime.wait(${js(op.id)}, input, options),\n`;
          declarations += `    ${op.method}Wait(input: ${prefix}Input, options?: RequestOptions): Promise<Result<${prefix}Response>>;\n`;
        }
      }
      code += '    });\n';
      declarations += '  };\n';
    }
    code += '  }\n';
    if (c.config.webhook) {
      code += '  verifyWebhook(...args) { return this.#runtime.verifyWebhook(...args); }\n';
      declarations += `  verifyWebhook(rawBody: Uint8Array, headers: Record<string, string>, secrets: string[], nowSeconds?: number): { event: ${
        Object.values(c.config.webhook.events)
          .map((s) => type(s, true))
          .join(' | ') || 'never'
      }; known: true } | { event: unknown; known: false };\n`;
    }
    if (c.config.money) {
      code += '  money(...args) { return this.#runtime.money(...args); }\n';
      declarations +=
        '  money(currency: string, major: string): { currency: string; amount: string };\n';
    }
    code += '}\n';
    declarations += '}\n';
    for (const op of c.operations) {
      const schemas = Object.entries(op.responses)
        .filter(
          ([status, r]) => (/^2\d\d$/.test(status) || status === 'default') && r.schema?.oneOf,
        )
        .map(([, r]) => r.schema!);
      if (!schemas.length) continue;
      const prefix = pascal(op.resource) + pascal(op.method) + 'Response';
      declarations += `export type ${prefix}Known = ${schemas.map((s) => type(s, true, undefined, true)).join(' | ')};\nexport declare function is${prefix}Known(value: ${prefix}): value is ${prefix}Known;\n`;
      code += `export function is${prefix}Known(value) { return ${js(schemas)}.some(schema => isKnownVariant(value, {...schema, ...(contract.definitions ? {'x-sdk-definitions': contract.definitions} : {})})); }\n`;
    }
    for (const [name, s] of Object.entries(models))
      code += `export function make${name}(value) { return new Model(value, {...${js(s)}, 'x-sdk-validation': ${js(c.config.validation ?? 'encoding')}, ...(contract.definitions ? {'x-sdk-definitions': contract.definitions} : {})}); }\n`;
    if (c.config.webhook)
      put(
        'examples/webhook-inbox.mjs',
        readFileSync(join(here, '../templates/webhook-inbox.mjs'), 'utf8'),
      );
    put('index.js', code);
    put('index.d.ts', declarations);
    put('LICENSE', license);
    for (const op of c.operations) {
      const input = exampleInput(op, definitions);
      const example = `import { Client } from '${c.config.npm.name}';\nconst client = new Client({ baseUrl: process.env.API_BASE_URL ?? 'https://sandbox.example.invalid', allowInsecureHttp: process.env.API_ALLOW_INSECURE_HTTP === '1', ...(process.env.API_TOKEN ? { token: process.env.API_TOKEN } : {}) });\nconst result = await client.${op.resource}.${op.method}(${js(input)}, { maxAttempts: 1 });\nconsole.log(result.meta.requestId);\n`;
      put(`examples/${op.resource}-${op.method}.mjs`, example);
      put(`examples/${op.resource}-${op.method}.ts`, example);
    }
  }
  if (targets.includes('php')) {
    const put = (p: string, value: string) => files.set('php/' + p, value);
    const ns = c.config.composer.namespace;
    const phpContract = {
      ...structuredClone(contract),
      userAgent: `${c.config.composer.name.replaceAll('/', '-')}/${c.config.version} (PHP)`,
    };
    const responseModels: Record<string, Schema> = {};
    for (const op of phpContract.operations)
      for (const [status, r] of Object.entries(op.responses))
        if ((/^2\d\d$/.test(status) || status === 'default') && r.schema?.type === 'object') {
          const model = pascal(op.resource) + pascal(op.method) + 'Response' + pascal(status);
          reserve(model);
          (r as typeof r & { model: string }).model = model;
          responseModels[model] = r.schema;
        } else if (
          (/^2\d\d$/.test(status) || status === 'default') &&
          r.schema?.oneOf &&
          r.schema.discriminator
        ) {
          const variants: Record<string, string> = {};
          for (const [i, branch] of r.schema.oneOf.entries()) {
            const model =
              pascal(op.resource) + pascal(op.method) + 'Response' + pascal(status) + 'Variant' + i;
            reserve(model);
            responseModels[model] = branch;
            for (const tag of branch.properties![r.schema.discriminator.propertyName]!.enum!)
              variants[String(tag)] = model;
          }
          (r as typeof r & { variants: Record<string, string> }).variants = variants;
        }
    const eventModels: Record<string, string> = {};
    if (phpContract.webhook) {
      for (const [i, [event, schema]] of Object.entries(phpContract.webhook.events).entries()) {
        const name = 'WebhookEvent' + i;
        reserve(name);
        if (schema.type === 'object') {
          responseModels[name] = schema;
          eventModels[event] = name;
        }
      }
      Object.assign(phpContract.webhook, { eventModels });
    }
    put(
      'composer.json',
      stable({
        name: c.config.composer.name,
        description: `${c.title} server SDK`,
        version: c.config.version,
        type: 'library',
        license: c.config.license ?? 'Apache-2.0',
        require: { php: '>=8.2', 'ext-json': '*', 'ext-curl': '*' },
        autoload: { files: ['src/Runtime.php', 'src/Client.php'], classmap: ['custom/'] },
        archive: { exclude: ['/vendor', '/composer.lock', '/.git', '/*.zip'] },
      }),
    );
    put('src/contract.json', stable(phpContract));
    put('custom/.gitkeep', '');
    put(
      'src/Runtime.php',
      readFileSync(join(here, '../templates/Runtime.php'), 'utf8').replaceAll('SdkNamespace', ns),
    );
    let code = `<?php\ndeclare(strict_types=1);\nnamespace ${ns};\n\nfinal class Client {\n    private Runtime $runtime;\n`;
    for (const group of groups) code += `    public readonly ${pascal(group)}Resource $${group};\n`;
    code += `    public function __construct(ClientOptions $options) {\n        $this->runtime = new Runtime(json_decode(file_get_contents(__DIR__ . '/contract.json'), true, 512, JSON_THROW_ON_ERROR), $options);\n`;
    for (const group of groups)
      code += `        $this->${group} = new ${pascal(group)}Resource($this->runtime);\n`;
    code += '    }\n    public function close(): void { $this->runtime->close(); }\n';
    if (c.config.webhook)
      code += `    /** @return array{known: bool, event: ${Object.values(eventModels).join('|') || 'mixed'}|\\stdClass} */\n    public function verifyWebhook(string $rawBody, array $headers, array $secrets, ?int $nowSeconds = null): array { return $this->runtime->verifyWebhook($rawBody, $headers, $secrets, $nowSeconds); }\n`;
    if (c.config.money)
      code +=
        '    public function money(string $currency, string $major): array { return $this->runtime->money($currency, $major); }\n';
    code += '}\n';
    for (const group of groups) {
      code += `final class ${pascal(group)}Resource {\n    public function __construct(private readonly Runtime $runtime) {}\n`;
      for (const op of c.operations.filter((o) => o.resource === group)) {
        const inputName = pascal(op.resource) + pascal(op.method) + 'Input';
        const responseType = Object.entries(
          phpContract.operations.find((o) => o.id === op.id)!.responses,
        )
          .filter(([k]) => /^2\d\d$/.test(k) || k === '304' || k === 'default')
          .map(([, r]) => {
            const typed = r as typeof r & { model?: string; variants?: Record<string, string> };
            return (
              typed.model ??
              (typed.variants
                ? [...new Set(Object.values(typed.variants)), '\\stdClass'].join('|')
                : r.schema
                  ? phpType(r.schema)
                  : 'null')
            );
          })
          .join('|');
        for (const method of [op.method, ...(op.aliases ?? [])])
          code += `    /** ${comment(op.description)}\n${method !== op.method || op.deprecated ? `     * @deprecated ${comment(method !== op.method ? 'Use ' + op.method + '.' : op.deprecated!)}\n` : ''}     * @return Result<${responseType}>\n     */\n    public function ${method}(${inputName} $input${inputSchema(op).required!.length ? '' : ' = new ' + inputName + '()'}, ?RequestOptions $options = null): Result { return $this->runtime->request(${php(op.id)}, $input->toArray(), $options); }\n`;
        if (op.pagination)
          for (const [suffix, runtime] of [
            ['Pages', 'pages'],
            ['Items', 'items'],
          ])
            code += `    /** @return \\Generator<int, ${
              suffix === 'Pages'
                ? `Result<${responseType}>`
                : itemSchemas(op)
                    .map((s) => phpDocType(s, true))
                    .join('|') || 'mixed'
            }> */\n    public function ${op.method}${suffix}(${inputName} $input, ?RequestOptions $options = null): \\Generator { return $this->runtime->${runtime}(${php(op.id)}, $input->toArray(), $options); }\n`;
        if (op.polling)
          code += `    public function ${op.method}Wait(${inputName} $input, ?RequestOptions $options = null): Result { return $this->runtime->wait(${php(op.id)}, $input->toArray(), $options); }\n`;
      }
      code += '}\n';
    }
    const phpModels = {
      ...Object.fromEntries(Object.entries(models).map(([n, s]) => [n + 'Input', s])),
      ...Object.fromEntries(
        c.operations.map((op) => [
          pascal(op.resource) + pascal(op.method) + 'Input',
          inputSchema(op),
        ]),
      ),
    };
    if (c.definitions)
      code +=
        "final class SchemaRegistry { private static ?array $values = null; public static function definitions(): array { return self::$values ??= json_decode(file_get_contents(__DIR__ . '/contract.json'), true, 512, JSON_THROW_ON_ERROR)['definitions']; } }\n";
    for (const [name, s] of Object.entries(phpModels))
      code += phpModel(name, s, false, Boolean(c.definitions), c.config.validation);
    for (const [name, s] of Object.entries(responseModels))
      code += phpModel(name, s, true, Boolean(c.definitions), c.config.validation);
    if (c.config.webhook)
      put(
        'examples/webhook-inbox.php',
        readFileSync(join(here, '../templates/webhook-inbox.php'), 'utf8').replaceAll(
          'SdkNamespace',
          ns,
        ),
      );
    put('src/Client.php', code);
    put('LICENSE', license);
    for (const op of c.operations)
      put(
        `examples/${op.resource}-${op.method}.php`,
        `<?php\ndeclare(strict_types=1);\nrequire __DIR__ . '/../vendor/autoload.php';\nuse ${ns}\\{Client, ClientOptions, RequestOptions, ${pascal(op.resource)}${pascal(op.method)}Input};\n$client = new Client(new ClientOptions(baseUrl: getenv('API_BASE_URL') ?: 'https://sandbox.example.invalid', token: getenv('API_TOKEN') ?: null, allowInsecureHttp: getenv('API_ALLOW_INSECURE_HTTP') === '1'));\n$input = new ${pascal(op.resource)}${pascal(op.method)}Input(json_decode(${php(JSON.stringify(exampleInput(op, definitions)))}, true, 512, JSON_THROW_ON_ERROR));\n$result = $client->${op.resource}->${op.method}($input, new RequestOptions(maxAttempts: 1));\necho $result->meta['requestId'] ?? '';\n$client->close();\n`,
      );
  }
  for (const target of targets) {
    const first = c.operations[0]!;
    files.set(
      `${target}/README.md`,
      `# ${c.title} SDK (${target})\n\nPackage ${c.config.version}; generated for API ${c.apiVersion}.\n\n${target === 'node' ? `Requires Node.js 22+; TypeScript 5.9+. ESM JavaScript and declarations ship together.\n\nInstall: \`npm install ${c.config.npm.name}\`` : `Requires PHP 8.2+, ext-json and ext-curl; framework independent.\n\nInstall: \`composer require ${c.config.composer.name}\``}\n\nStart with [the quickstart](examples/${first.resource}-${first.method}.${target === 'node' ? 'mjs' : 'php'}). Set API_BASE_URL explicitly and API_TOKEN if authentication is declared. Examples target a placeholder sandbox and make one attempt. Provider example values must match your sandbox. Run examples from the generated package: for Node use node examples/NAME.mjs; for PHP run composer install in the generated php/ directory, then php examples/NAME.php. When copying a PHP example into an application, point its require statement at that application\'s vendor/autoload.php.\n\n## Client and request options\n\nConstruct a client with baseUrl and, for authenticated operations, token. The SDK does not discover credentials or read environment variables; the operation example scripts read API_BASE_URL and API_TOKEN explicitly. Pass per-request options as the second method argument: a plain object in Node, or RequestOptions in PHP. Defaults are timeoutMs: 10000 per attempt and deadlineMs: 30000 for the overall duration (not an absolute timestamp). Request values override client defaults. maxAttempts defaults to the operation\'s declared limit, or one when no retries are declared; overrides cannot exceed that limit. Request headers carry tenant context without shared mutable state.\n\nResults expose data, meta and explicit raw response text. Node metadata uses properties; PHP metadata uses array keys. SdkError exposes kind, outcome, retryAllowed and optional metadata; provider codes use code in Node and errorCode in PHP. outcome is not_sent, response or unknown. Reconcile an unknown mutation outcome with the provider and the original persisted idempotency key before resubmitting.\n\n## Behavior and ownership\n\nOptional properties distinguish omission from null. PHP inputs use presence-aware typed input objects constructed from arrays: omit a key to omit it; include a key with null to clear only where permitted. PHP models expose presence through has()/get(); typed getters unwrap nested models and getters for omitted optional fields throw. In object/array alternatives, PHP lists (including []) represent JSON arrays; use (object) [] for an empty JSON object. Numeric enum membership compares exact values, so equivalent decimal/exponent spellings are accepted. Large integers (int64) and decimals use exact strings, including numeric JSON wire values. Integer responses accept integral decimal/exponent notation without rounding. Sparse Node input arrays fail before dispatch. Timestamps remain strings. Unknown response fields, enum members, and tagged variants are retained. Full request encoding checks run locally; server business effects require provider tests.\n\nRetries count total attempts, include jitter and Retry-After, and never exceed the declared policy. Persist an idempotency key across process restarts and submissions within the server's documented retention/scope. Automatic keys cover one SDK call only. Explicit keys from operation inputs, request headers or idempotencyKey are preserved; conflicting values fail before dispatch. A timeout after dispatch can leave the remote outcome unknown; inspect SdkError.outcome. Disable nested transport/application retries to avoid multiplied attempts. 409/412 are distinct conflicts and never automatically overwritten.\n\nTimeout is per attempt, including body consumption. Deadline covers attempts and waits; pagination and polling share an overall deadline. Cancellation stops local work, not the remote operation. Node uses AbortSignal. PHP uses a Cancellation token checked during cURL progress and between waits; synchronous calls need an external signal handler to cancel while blocked. Pagination is lazy, supports maxPages/maxItems, and does not guarantee a stable snapshot or durable continuation.\n\nExplicit allowedOrigins govern all destinations, including pagination. HTTPS is required unless allowInsecureHttp is set for local tests. Redirects are rejected. Authentication is attached only after destination validation. API version headers are pinned when configured; changing them does not update generated types.\n\nClients perform no network I/O at import/construction. Node clients reuse the runtime's fetch connection pool; injected transports remain caller-owned and must honor AbortSignal and disable redirects/retries. PHP owns a reusable cURL handle, released by close()/destruction; a client supports sequential calls within one PHP execution context. Do not concurrently share a PHP client across threads/fibers. Node requests keep headers/context local and support concurrent calls. No SDK telemetry is sent. Requests identify the selected package name/version and runtime through an overridable User-Agent header.\n\nDiagnostics run once per attempted HTTP request, including transport failures, with operation, request ID, status, timing, attempt count and error kind only; hook failures are ignored. Bodies and credentials are excluded. Raw response text/headers and structured error details are privileged explicit access. Model debug printing redacts declared sensitive fields and additional field names supplied in ClientOptions.redactFields; printing arbitrary raw values is application responsibility. Injected transports are privileged and see credentials/bodies.\n\n## Webhooks and recovery\n\n${c.config.webhook ? 'Verification uses the configured HMAC-SHA256 signature format, signed headers and original body bytes, with timestamp tolerance and overlapping secrets. Preserve raw request bytes; never verify reserialized JSON. Verification is not durable deduplication. In one database transaction, insert a unique provider event ID and durable work record before acknowledging. Workers should fetch authoritative current state for out-of-order events; commit business side effects idempotently. Unknown event types must not be treated as known success.' : 'This provider has not declared webhook verification.'}\n\nCustom helpers belong in custom/; they survive regeneration. Multi-call helpers are not atomic and must expose partial completion. See [reference](REFERENCE.md).\n`,
    );
    files.set(
      `${target}/REFERENCE.md`,
      `# ${c.title} API reference\n\nPackage ${c.config.version}; API ${c.apiVersion}.\n\n` +
        c.operations
          .map(
            (op) =>
              `## ${op.resource}.${op.method}\n\n${op.description}\n\n\`${op.verb} ${op.path}\`\n\nInput: \`${target === 'php' ? phpDocType(inputSchema(op)) : type(inputSchema(op))}\`\n\nResponse: \`${
                target === 'php'
                  ? Object.entries(op.responses)
                      .filter(([status]) => /^2\d\d$/.test(status) || status === 'default')
                      .map(([, r]) => (r.schema ? phpDocType(r.schema, true) : 'null'))
                      .join('|')
                  : resultType(op)
              }\`\n\n${op.idempotency ? `Idempotency header: ${op.idempotency.header}; retention: ${op.idempotency.retention}; scope: ${op.idempotency.scope}.\n\n` : ''}${op.aliases?.length ? `Deprecated aliases: ${op.aliases.join(', ')} (same wire operation).\n\n` : ''}[Example](examples/${op.resource}-${op.method}.${target === 'node' ? 'mjs' : 'php'})\n`,
          )
          .join('\n'),
    );
  }
  for (const target of targets) {
    const guides = Object.entries(c.config.documentation?.guides ?? {});
    if (c.config.documentation?.overview || guides.length)
      files.set(
        `${target}/README.md`,
        files.get(`${target}/README.md`) +
          '\n## Provider guidance\n\n' +
          (c.config.documentation?.overview ?? '') +
          '\n\n' +
          guides.map(([slug]) => `- [${slug}](guides/${slug}.md)`).join('\n') +
          '\n',
      );
    for (const [slug, text] of guides)
      files.set(
        `${target}/guides/${slug}.md`,
        `<!-- Package ${c.config.version}; API ${c.apiVersion} -->\n\n${text}\n`,
      );
  }
  return files;
}
export function compare(before: Contract, after: Contract): Compatibility[] {
  const changes: Compatibility[] = [];
  const add = (severity: Compatibility['severity'], subject: string, message: string) =>
    changes.push({ severity, subject, message });
  const oldModels = modelsUsed(before),
    newModels = modelsUsed(after);
  for (const name of Object.keys(oldModels))
    if (!Object.hasOwn(newModels, name))
      add('breaking', name, 'Exported model removed; update model imports and helper usage.');
  for (const name of Object.keys(newModels))
    if (!Object.hasOwn(oldModels, name)) add('additive', name, 'Exported model added.');
  for (const [name, previous] of Object.entries(oldModels)) {
    const next = newModels[name];
    if (next)
      for (const direction of ['input', 'response'] as const)
        changes.push(
          ...compareSchemas(
            directionalSchema(previous, direction === 'response'),
            directionalSchema(next, direction === 'response'),
            `models.${name}.${direction}`,
            direction,
          ),
        );
  }
  for (const [name, definition] of Object.entries(before.definitions ?? {})) {
    const next = after.definitions?.[name];
    if (!next)
      add(
        'review',
        name,
        'Recursive model definition removed or inlined; review nested value handling.',
      );
    else
      for (const direction of ['input', 'response'] as const)
        changes.push(...compareSchemas(definition, next, `definitions.${name}`, direction));
  }
  for (const old of before.operations) {
    const current = after.operations.find((o) => o.id === old.id);
    if (!current) {
      add('breaking', old.id, 'Operation removed from the public SDK');
      continue;
    }
    if (
      old.resource !== current.resource ||
      (old.method !== current.method && !current.aliases?.includes(old.method))
    )
      add('breaking', old.id, 'Public method renamed without a compatible alias');
    if (
      pascal(old.resource) + pascal(old.method) !==
        pascal(current.resource) + pascal(current.method) ||
      (old.method !== current.method && (old.pagination || old.polling))
    )
      add(
        'breaking',
        old.id,
        'Operation input/response types and capability helper names changed; a method alias does not preserve these exported interfaces.',
      );
    if (old.verb !== current.verb || old.path !== current.path)
      add(
        'breaking',
        old.id,
        'HTTP destination or method changed; server semantics require explicit review',
      );
    changes.push(
      ...compareSchemas(inputSchema(old), inputSchema(current), `${old.id}.input`, 'input'),
    );
    for (const status of new Set([
      ...Object.keys(old.responses),
      ...Object.keys(current.responses),
    ])) {
      const before = old.responses[status],
        after = current.responses[status];
      if (!before || !after) {
        add(
          after ? 'review' : 'breaking',
          `${old.id}.response.${status}`,
          after
            ? 'Response status added; handle this outcome explicitly.'
            : 'Response status removed; migrate handling of this outcome.',
        );
      } else {
        if (before.schema && after.schema)
          changes.push(
            ...compareSchemas(
              before.schema,
              after.schema,
              `${old.id}.response.${status}`,
              'response',
            ),
          );
        else if (Boolean(before.schema) !== Boolean(after.schema))
          add(
            'breaking',
            `${old.id}.response.${status}`,
            'Response body presence changed; update result handling.',
          );
        if (before.mediaType !== after.mediaType)
          add(
            'breaking',
            `${old.id}.response.${status}`,
            'Response media type changed; review decoding.',
          );
      }
    }
    for (const parameter of old.parameters) {
      const next = current.parameters.find((p) => p.name === parameter.name);
      if (
        next &&
        ['in', 'style', 'explode'].some(
          (k) =>
            stable(parameter[k as keyof typeof parameter]) !== stable(next[k as keyof typeof next]),
        )
      )
        add(
          'breaking',
          `${old.id}.input.${parameter.name}`,
          'Parameter location or encoding changed; verify wire behavior with provider fixtures.',
        );
    }
    if (old.mediaType !== current.mediaType)
      add('breaking', old.id, 'Request media type changed; review update/serialization semantics.');
    for (const key of [
      'retry',
      'idempotency',
      'pagination',
      'polling',
      'conditional',
      'authenticated',
      'optionalAuthentication',
    ] as const)
      if (stable(old[key]) !== stable(current[key]))
        add('breaking', old.id, `${key} behavior or defaults changed`);
    if (stable(old.example) !== stable(current.example)) add('review', old.id, 'Example changed');
    if (old.deprecated !== current.deprecated)
      add(
        'review',
        old.id,
        current.deprecated
          ? `Deprecation notice: ${current.deprecated}`
          : 'Deprecation notice removed; confirm lifecycle policy.',
      );
    for (const alias of old.aliases ?? [])
      if (alias !== current.method && !current.aliases?.includes(alias))
        add('breaking', old.id, `Alias ${alias} removed`);
  }
  for (const op of after.operations)
    if (!before.operations.some((o) => o.id === op.id)) add('additive', op.id, 'Operation added');
  for (const key of ['auth', 'apiVersion'] as const)
    if (stable(before[key]) !== stable(after[key]))
      add('breaking', key, 'Authentication or API version contract changed');
  for (const key of [
    'targets',
    'validation',
    'npm',
    'composer',
    'apiVersion',
    'webhook',
    'money',
    'models',
    'errors',
  ] as const)
    if (stable(before.config[key]) !== stable(after.config[key]))
      add(
        'breaking',
        key,
        'Package identity, generated types, target selection, or capability changed',
      );
  return changes;
}
function safeTree(path: string): void {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (stat.isSymbolicLink())
    throw new Diagnostic(path, 'symlinks are not allowed in generated output trees');
  if (stat.isDirectory()) for (const name of readdirSync(path)) safeTree(join(path, name));
}
function safeRelative(p: string): boolean {
  return (
    p !== '' &&
    !isAbsolute(p) &&
    !p.split(/[\\/]/).some((x) => x === '..' || x === '.') &&
    p !== recordName
  );
}
function unifiedDiff(path: string, before: string, after: string): string {
  const oldLines = before ? before.replace(/\n$/, '').split('\n') : [];
  const newLines = after ? after.replace(/\n$/, '').split('\n') : [];
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  )
    prefix++;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - suffix - 1] === newLines[newLines.length - suffix - 1]
  )
    suffix++;
  const start = Math.max(0, prefix - 3);
  const oldEnd = Math.min(oldLines.length, oldLines.length - suffix + 3);
  const newEnd = Math.min(newLines.length, newLines.length - suffix + 3);
  return [
    `--- ${before ? 'a/' + path : '/dev/null'}`,
    `+++ ${after ? 'b/' + path : '/dev/null'}`,
    `@@ -${oldLines.length ? start + 1 : 0},${oldEnd - start} +${newLines.length ? start + 1 : 0},${newEnd - start} @@`,
    ...oldLines.slice(start, prefix).map((v) => ' ' + v),
    ...oldLines.slice(prefix, oldLines.length - suffix).map((v) => '-' + v),
    ...newLines.slice(prefix, newLines.length - suffix).map((v) => '+' + v),
    ...newLines.slice(newLines.length - suffix, newEnd).map((v) => ' ' + v),
    '',
  ].join('\n');
}
export function preview(contract: Contract, output: string) {
  output = resolve(output);
  safeTree(output);
  const files = render(contract);
  const recordPath = join(output, recordName);
  const before: RecordFile | undefined = existsSync(recordPath)
    ? JSON.parse(readFileSync(recordPath, 'utf8'))
    : undefined;
  if (before && ((before.recordVersion ?? 1) !== 1 || !before.files || !before.interface))
    throw new Diagnostic(
      recordPath,
      'unsupported generation record; use the recorded generator version',
    );
  const changes: Change[] = [];
  for (const [path, previousHash] of Object.entries(before?.files ?? {})) {
    if (!safeRelative(path)) throw new Diagnostic(recordPath, 'invalid owned file path');
    const destination = join(output, path);
    if (existsSync(destination) && hash(readFileSync(destination, 'utf8')) !== previousHash)
      throw new Diagnostic(
        destination,
        'generated file was edited; move custom changes to custom/ before regeneration',
      );
    if (!files.has(path) && existsSync(destination))
      changes.push({
        path,
        kind: 'removed',
        reason: 'No longer generated by selected contract/targets',
      });
  }
  for (const [path, content] of files) {
    const destination = join(output, path);
    if (!existsSync(destination))
      changes.push({ path, kind: 'created', reason: 'Required by selected contract/target' });
    else if (!before?.files[path])
      throw new Diagnostic(destination, 'unowned file conflicts with generated output');
    else if (readFileSync(destination, 'utf8') !== content)
      changes.push({
        path,
        kind: 'modified',
        reason: 'Contract, public interface, example, package version, or runtime changed',
      });
  }
  return {
    files,
    before,
    changes,
    compatibility: before
      ? [
          ...compare(comparisonBase(before, contract), contract),
          ...(before.generator !== version
            ? [
                {
                  severity: 'review' as const,
                  subject: 'generator',
                  message: `Generator/runtime changed from ${before.generator} to ${version}; review generated behavior and supported runtimes`,
                },
              ]
            : []),
        ]
      : [],
  };
}
export function generate(contract: Contract, output: string, dryRun = false) {
  const plan = preview(contract, output);
  if (dryRun)
    return {
      changes: plan.changes.map((change) => ({
        ...change,
        diff: unifiedDiff(
          change.path,
          change.kind === 'created' ? '' : readFileSync(join(output, change.path), 'utf8'),
          plan.files.get(change.path) ?? '',
        ),
      })),
      compatibility: plan.compatibility,
    };
  output = resolve(output);
  if (output === dirname(output))
    throw new Diagnostic(output, 'cannot generate into filesystem root');
  mkdirSync(dirname(output), { recursive: true });
  const lock = output + '.sdk-generator.lock';
  let fd: number;
  try {
    fd = openSync(lock, 'wx');
  } catch {
    throw new Diagnostic(
      lock,
      'another generation is running; remove a stale lock only after checking the owning process',
    );
  }
  const stage = output + '.stage-' + randomUUID();
  const backup = output + '.backup-' + randomUUID();
  let moved = false;
  try {
    writeFileSync(fd, stable({ pid: process.pid, generator: version }));
    const current = preview(contract, output);
    if (existsSync(output)) cpSync(output, stage, { recursive: true });
    else mkdirSync(stage);
    for (const change of current.changes)
      if (change.kind === 'removed') rmSync(join(stage, change.path));
    for (const [p, content] of current.files) {
      mkdirSync(dirname(join(stage, p)), { recursive: true });
      writeFileSync(join(stage, p), content);
    }
    const record: RecordFile = {
      recordVersion: 1,
      generator: version,
      contractHash: contract.hash,
      sources: contract.sources,
      files: Object.fromEntries([...current.files].map(([p, v]) => [p, hash(v)])),
      interface: contract,
      compatibility: current.compatibility,
      ...(current.before &&
      (current.before.comparisonBase ||
        current.changes.length ||
        current.before.interface.config.version !== contract.config.version)
        ? {
            comparisonBase: comparisonBase(current.before, contract),
            previousVersion: comparisonBase(current.before, contract).config.version,
          }
        : {}),
    };
    writeFileSync(join(stage, recordName), stable(record), { mode: 0o600 });
    if (existsSync(output)) {
      renameSync(output, backup);
      moved = true;
    }
    renameSync(stage, output);
    if (moved) rmSync(backup, { recursive: true });
  } catch (error) {
    if (moved && !existsSync(output)) renameSync(backup, output);
    throw error;
  } finally {
    rmSync(stage, { recursive: true, force: true });
    closeSync(fd);
    rmSync(lock, { force: true });
  }
  return { changes: plan.changes, compatibility: plan.compatibility };
}
function selectedTargets(output: string): ('node' | 'php')[] {
  const recordPath = join(output, recordName);
  if (existsSync(recordPath)) {
    const record: RecordFile = JSON.parse(readFileSync(recordPath, 'utf8'));
    return record.interface.config.targets ?? ['node', 'php'];
  }
  // Validation also supports packages copied without the private generation record.
  return (['node', 'php'] as const).filter((target) =>
    existsSync(join(output, target, target === 'node' ? 'package.json' : 'composer.json')),
  );
}

export function validate(output: string): { command: string; output: string }[] {
  const results: { command: string; output: string }[] = [];
  function run(command: string, args: string[], cwd: string) {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 120000 });
    if (result.error || result.status !== 0)
      throw new Diagnostic(
        cwd,
        `${command} ${args.join(' ')} failed: ${result.error?.message ?? result.stderr + result.stdout}`,
      );
    results.push({ command: [command, ...args].join(' '), output: result.stdout.trim() });
  }
  output = resolve(output);
  const targets = selectedTargets(output);
  if (targets.includes('node')) {
    run('node', ['--check', 'index.js'], join(output, 'node'));
    run('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], join(output, 'node'));
    const examples = readdirSync(join(output, 'node/examples')).filter((f) => f.endsWith('.mjs'));
    for (const file of examples)
      run('node', ['--check', join('examples', file)], join(output, 'node'));
  }
  if (targets.includes('node')) {
    const cwd = join(output, 'node');
    const examples = readdirSync(join(cwd, 'examples'))
      .filter((p) => p.endsWith('.ts'))
      .map((p) => join('examples', p));
    run(
      process.execPath,
      [
        require.resolve('typescript/bin/tsc'),
        '--strict',
        '--noEmit',
        '--target',
        'ES2022',
        '--module',
        'NodeNext',
        '--moduleResolution',
        'NodeNext',
        '--types',
        'node',
        '--typeRoots',
        dirname(dirname(require.resolve('@types/node/package.json'))),
        ...examples,
      ],
      cwd,
    );
  }
  if (targets.includes('php')) {
    for (const sub of ['src', 'examples'])
      for (const file of readdirSync(join(output, 'php', sub)).filter((f) => f.endsWith('.php')))
        run('php', ['-l', join(sub, file)], join(output, 'php'));
    run('composer', ['validate', '--no-check-publish'], join(output, 'php'));
  }
  if (!results.length) throw new Diagnostic(output, 'no generated packages found');
  return results;
}
export function prepareRelease(output: string, destination: string, acknowledgeReview = false) {
  output = resolve(output);
  destination = resolve(destination);
  const record: RecordFile = JSON.parse(readFileSync(join(output, recordName), 'utf8'));
  if (record.interface.config.release?.policy === 'semver')
    checkVersionPolicy(
      record.previousVersion,
      record.interface.config.version,
      record.compatibility ?? [],
    );
  const integrity = preview(record.interface, output);
  if (integrity.changes.length)
    throw new Diagnostic(output, 'regenerate before preparing a release');
  validate(output);
  if (existsSync(destination))
    throw new Diagnostic(destination, 'release destination already exists; choose a new directory');
  if (destination.startsWith(output + '/'))
    throw new Diagnostic(destination, 'release destination must be outside generated output');
  const targets = record.interface.config.targets ?? ['node', 'php'];
  const commands: string[][] = [];
  mkdirSync(destination, { recursive: true });
  try {
    if (targets.includes('node')) {
      const nodeStage = join(destination, '.node-package');
      mkdirSync(nodeStage);
      for (const path of Object.keys(record.files).filter((p) => p.startsWith('node/'))) {
        const target = join(nodeStage, path.slice(5));
        mkdirSync(dirname(target), { recursive: true });
        cpSync(join(output, path), target);
      }
      if (existsSync(join(output, 'node/custom')))
        cpSync(join(output, 'node/custom'), join(nodeStage, 'custom'), { recursive: true });
      const r = spawnSync(
        'npm',
        ['pack', '--ignore-scripts', '--json', '--pack-destination', destination],
        { cwd: nodeStage, encoding: 'utf8' },
      );
      rmSync(nodeStage, { recursive: true, force: true });
      if (r.status !== 0) throw new Error(r.stderr);
      const name = JSON.parse(r.stdout)[0].filename;
      commands.push([
        'npm',
        'publish',
        join(destination, name),
        '--access',
        record.interface.config.npm.access ?? 'public',
        '--registry',
        record.interface.config.npm.registry ?? 'https://registry.npmjs.org',
        '--tag',
        record.interface.config.version.includes('-') ? 'next' : 'latest',
      ]);
    }
    if (targets.includes('php')) {
      const phpStage = join(destination, '.php-package');
      mkdirSync(phpStage);
      try {
        for (const path of Object.keys(record.files).filter((p) => p.startsWith('php/'))) {
          const target = join(phpStage, path.slice(4));
          mkdirSync(dirname(target), { recursive: true });
          cpSync(join(output, path), target);
        }
        if (existsSync(join(output, 'php/custom')))
          cpSync(join(output, 'php/custom'), join(phpStage, 'custom'), { recursive: true });
        const r = spawnSync(
          'composer',
          [
            'archive',
            '--format=zip',
            '--dir=' + destination,
            '--file=sdk-php-' + record.interface.config.version,
          ],
          { cwd: phpStage, encoding: 'utf8' },
        );
        if (r.status !== 0) throw new Error(r.stderr);
      } finally {
        rmSync(phpStage, { recursive: true, force: true });
      }
    }
    const checksums: Record<string, string> = {};
    const compatibility = record.compatibility ?? [];
    const plan = {
      compatibility,
      previousVersion: record.previousVersion ?? null,
      reviewRequired: compatibility.some((c) => c.severity !== 'additive'),
      version: record.interface.config.version,
      generator: version,
      contractHash: record.contractHash,
      checksums,
      packages: {
        npm: (record.interface.config.targets ?? ['node', 'php']).includes('node')
          ? record.interface.config.npm.name
          : null,
        composer: (record.interface.config.targets ?? ['node', 'php']).includes('php')
          ? record.interface.config.composer.name
          : null,
      },
      publication: commands,
      npm: {
        registry: record.interface.config.npm.registry ?? 'https://registry.npmjs.org',
        access: record.interface.config.npm.access ?? 'public',
      },
      composer:
        'Deploy the prepared site with publish-site, then configure a Composer repository pointing to its packages.json. VCS/Packagist distribution is also supported independently.',
      documentation:
        'The prepared site contains matching versioned documentation, examples, changelog, migrations and archives; deploy with publish-site.',
      approved: acknowledgeReview,
    };
    writeFileSync(
      join(destination, 'CHANGELOG.md'),
      `# ${plan.version}\n\nGenerated for API ${record.interface.apiVersion}. Contract hash: ${record.contractHash}.\n\n${compatibility.length ? compatibility.map((c) => `- ${c.severity}: ${c.subject}: ${c.message}`).join('\n') : 'Initial release or no recorded interface changes.'}\n\nLocal fixture checks do not establish provider acceptance or server correctness.\n`,
    );
    writeFileSync(
      join(destination, 'MIGRATION.md'),
      `# Migration to ${plan.version}\n\n${
        compatibility
          .filter((c) => c.severity !== 'additive')
          .map((c) => `- Review ${c.subject}: ${c.message}`)
          .join('\n') || 'No migration findings recorded.'
      }\n\n${record.interface.operations
        .filter((o) => o.aliases?.length)
        .map(
          (o) =>
            `Use ${o.resource}.${o.method} in place of ${o.aliases!.map((a) => o.resource + '.' + a).join(', ')}. These aliases retain the same HTTP operation.`,
        )
        .join(
          '\n\n',
        )}\n\nA retained method name does not certify compatible server behavior. Confirm required/null states, wire representations, retry policy, API version and supported runtimes before publishing.\n`,
    );
    const site = prepareSite(output, destination, record.interface, Object.keys(record.files));
    Object.assign(checksums, artifactHashes(destination));
    const fullPlan = { ...plan, site };
    writeFileSync(join(destination, 'release-plan.json'), stable(fullPlan));
    return fullPlan;
  } catch (e) {
    rmSync(destination, { recursive: true, force: true });
    throw e;
  }
}
export { loadContract };

/** Publishes only after an explicit version acknowledgement and archive integrity checks. */
export function publishRelease(
  directory: string,
  confirmedVersion: string,
  execute: (args: string[]) => { status: number | null; stdout?: string; stderr?: string } = (
    args,
  ) => spawnSync('npm', args, { encoding: 'utf8', timeout: 120000 }),
) {
  directory = resolve(directory);
  const plan = verifyRelease(directory, confirmedVersion);
  const entries = Object.entries(plan.checksums ?? {}) as [string, string][];
  const archives = entries
    .map(([name]) => name)
    .filter((name) => !name.includes('/') && name.endsWith('.tgz'));
  if (archives.length !== 1)
    throw new Diagnostic(
      directory,
      'npm publication requires exactly one npm archive; Composer publication uses the documented distribution repository',
    );
  const registry = new URL(plan.npm?.registry ?? 'https://registry.npmjs.org');
  if (
    registry.protocol !== 'https:' ||
    registry.username ||
    registry.password ||
    registry.search ||
    registry.hash ||
    !['public', 'restricted'].includes(plan.npm?.access ?? 'public')
  )
    throw new Diagnostic(directory, 'invalid publication destination');
  const archiveHash = plan.checksums[archives[0]!];
  const receiptPath = join(directory, 'publication.json');
  if (existsSync(receiptPath)) {
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    if (
      receipt.npmPublished &&
      receipt.version === confirmedVersion &&
      receipt.registry === registry.href &&
      receipt.archiveHash === archiveHash
    )
      return receipt;
    throw new Diagnostic(
      receiptPath,
      'publication receipt does not match this plan; check registry state before publishing',
    );
  }
  const result = execute([
    'publish',
    join(directory, archives[0]!),
    '--ignore-scripts',
    '--access',
    plan.npm?.access ?? 'public',
    '--registry',
    registry.href,
    '--tag',
    confirmedVersion.includes('-') ? 'next' : 'latest',
  ]);
  if (result.status !== 0)
    throw new Diagnostic(
      directory,
      `npm publication failed; check registry state before retrying: ${result.stderr ?? ''}`,
    );
  writeFileSync(
    join(directory, 'publication.json'),
    stable({
      version: confirmedVersion,
      npmPublished: true,
      registry: registry.href,
      archiveHash,
      composer: plan.composer,
    }),
  );
  return { version: confirmedVersion, npmPublished: true, composer: plan.composer };
}
