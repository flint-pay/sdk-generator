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
import { comparePolicies } from './compatibility.js';
import { artifactHashes, prepareSite, verifyRelease } from './distribution.js';
import { checkVersionPolicy } from './version.js';
import { serialize } from './runtime.js';
import {
  inputSchema,
  sample,
  compileSdkContract,
  type CompiledSdkContract,
  type PhpModelPlan,
} from './target-plan.js';
import { addedResultFits } from './response-compatibility.js';
import { compareCompiledContracts } from './compiled-compatibility.js';
import {
  restoreCompiledSnapshot,
  storeCompiledSnapshot,
  type CompiledSnapshot,
} from './compiled-record.js';
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
  compiled?: CompiledSnapshot;
  compiledComparisonBase?: CompiledSnapshot;
}
function compiledBase(before: RecordFile, next: Contract): CompiledSnapshot | undefined {
  const retainsBase =
    before.interface.config.version === next.config.version ||
    before.previousVersion === before.interface.config.version;
  return retainsBase && before.comparisonBase ? before.compiledComparisonBase : before.compiled;
}
function runtimeIdentity(
  files: Map<string, string>,
  targets: ('node' | 'php')[],
): CompiledSnapshot['runtimeIdentity'] {
  return Object.fromEntries(
    targets.map((target) => [
      target,
      hash(
        stable(
          [...files].filter(([name]) =>
            target === 'node'
              ? /^node\/(runtime|codec-plan|runtime-plan)\.js$/.test(name)
              : /^php\/src\/(Runtime|SchemaAdapter)\.php$/.test(name),
          ),
        ),
      ),
    ]),
  );
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
function phpModel(
  plan: PhpModelPlan,
  recursive: boolean,
  validation: Config['validation'],
): string {
  const expression = plan.sharedCodec
    ? `SchemaRegistry::codecs()[${php(plan.sharedCodec)}]`
    : `json_decode(${php(JSON.stringify(plan.codec))}, true, 512, JSON_THROW_ON_ERROR)`;
  let code = `/** Presence-aware ${plan.response ? 'response' : 'input'}; omitted fields throw when accessed. */\nfinal class ${plan.name} extends Model {\n    /** @param ${comment(plan.constructorDoc)} $values */\n    public function __construct(${plan.constructorType} $values${plan.defaultObject ? ' = []' : ''}, array $redactFields = []) { parent::__construct($values, [], ${plan.response ? 'true' : 'false'}, $redactFields, ['constraints' => ${validation === 'schema' ? 'true' : 'false'}] + ${expression}${recursive ? " + ['definitions' => SchemaRegistry::codecs()]" : ''}); }\n`;
  const accessors = new Set<string>();
  for (const getter of plan.getters) {
    if (accessors.has(getter.field.toLowerCase()))
      throw new Diagnostic(
        plan.name,
        `PHP field accessor collision for ${getter.field}; correct the model naming before generation`,
      );
    accessors.add(getter.field.toLowerCase());
    if (getter.method)
      code += `    /** @return ${comment(getter.doc)} */\n    public function ${getter.method}(): ${getter.type} { return $this->get(${php(getter.field)}); }\n`;
  }
  return code + '}\n';
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
  return renderCompiled(compileSdkContract(c));
}
function renderCompiled(compilation: ReturnType<typeof compileSdkContract>): Map<string, string> {
  const c = compilation.source;
  const targetPlan = compilation.plan;
  const files = new Map<string, string>();
  const targets = c.config.targets ?? ['node', 'php'];
  const groups = [...new Set(c.operations.map((o) => o.resource))].sort();
  const models = targetPlan.node.models;
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
            'Exclude',
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
    if (targetPlan.documentation[op.id]!.reserveKnown)
      reserve(pascal(op.resource) + pascal(op.method) + 'ResponseKnown');
  }
  const compiledRuntime = targetPlan.runtime;
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
    for (const name of [
      'codec-plan.js',
      'codec-plan.d.ts',
      'runtime-plan.js',
      'runtime-plan.d.ts',
      'canonical.js',
      'canonical.d.ts',
      'diagnostic.js',
      'diagnostic.d.ts',
    ])
      put(name, readFileSync(join(here, name), 'utf8'));
    put('contract.d.ts', readFileSync(join(here, 'contract.d.ts'), 'utf8'));
    let code = `import { runtimeFromPlan, modelFromCodec, isKnownCodec } from './runtime.js';\nexport { SdkError, Model, serialize, parseExact, redact } from './runtime.js';\nconst contract = ${js({ ...compiledRuntime, userAgent: `${c.config.npm.name.replace(/^@/, '').replaceAll('/', '-')}/${c.config.version} (Node.js)` })};\nexport class Client {\n  #runtime;\n  constructor(options) {\n    this.#runtime = runtimeFromPlan(contract, options);\n`;
    let declarations = `import type { ClientOptions, RequestOptions, Result, InputValue } from './runtime.js';\nimport { Model } from './runtime.js';\nexport { SdkError, Model, serialize, parseExact, redact } from './runtime.js';\nexport type { ClientOptions, RequestOptions, Result, Metadata, ErrorKind, DiagnosticEvent, InputValue } from './runtime.js';\n`;
    for (const [name, model] of Object.entries(models)) {
      declarations += `export type ${name} = ${model.output};\nexport type ${name}Input = ${model.input};\n`;
      // Preserve the validated object branch when a model also permits
      // nonobjects, so its factory can nest inside an object-constrained field.
      if (model.objectFactory) {
        const object = `Exclude<${name}Input & object, readonly unknown[]>`;
        declarations += `export declare function make${name}(value: InputValue<${object}>): Model<${object}>;\n`;
      }
      declarations += `export declare function make${name}(value: InputValue<${name}Input>): Model<${name}Input>;\n`;
    }
    for (const op of c.operations)
      declarations += `export type ${pascal(op.resource)}${pascal(op.method)}Input = ${targetPlan.node.operations[op.id]!.input};\nexport type ${pascal(op.resource)}${pascal(op.method)}Response = ${targetPlan.node.operations[op.id]!.output};\n`;
    declarations += 'export declare class Client {\n  constructor(options: ClientOptions);\n';
    for (const group of groups) {
      code += `    this.${group} = Object.freeze({\n`;
      declarations += `  readonly ${group}: {\n`;
      for (const op of c.operations.filter((o) => o.resource === group)) {
        const prefix = pascal(op.resource) + pascal(op.method);
        const required = targetPlan.node.operations[op.id]!.inputRequired;
        for (const method of [op.method, ...(op.aliases ?? [])]) {
          code += `      ${method}: (input = {}, options) => this.#runtime.request(${js(op.id)}, input, options),\n`;
          declarations += `    ${methodDoc(op, method, definitions)}    ${method}(input${required ? '' : '?'}: ${prefix}Input, options?: RequestOptions): Promise<Result<${prefix}Response>>;\n`;
        }
        if (op.pagination)
          for (const [suffix, runtime, returnType] of [
            ['Pages', 'pages', `Result<${prefix}Response>`],
            ['Items', 'items', targetPlan.node.operations[op.id]!.items],
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
        targetPlan.node.eventType
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
      const known = targetPlan.node.operations[op.id]!.known;
      if (!known) continue;
      const prefix = pascal(op.resource) + pascal(op.method) + 'Response';
      declarations += `export type ${prefix}Known = ${known.type};\nexport declare function is${prefix}Known(value: ${prefix}): value is ${prefix}Known;\n`;
      code += `export function is${prefix}Known(value) { return ${js(known.codecs)}.some(codec => isKnownCodec(value, {...codec, ...(contract.definitions ? {definitions: contract.definitions} : {})})); }\n`;
    }
    for (const [name, model] of Object.entries(targetPlan.node.models)) {
      const expression = model.sharedCodec
        ? `contract.definitions[${js(model.sharedCodec)}]`
        : js(model.codec);
      code += `export function make${name}(value) { return modelFromCodec(value, {...${expression}, constraints: ${js(c.config.validation === 'schema')}, ...(contract.definitions ? {definitions: contract.definitions} : {})}); }\n`;
    }
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
      ...targetPlan.php.runtime,
      userAgent: `${c.config.composer.name.replaceAll('/', '-')}/${c.config.version} (PHP)`,
    };
    for (const model of targetPlan.php.models.filter((model) => model.response))
      reserve(model.name);
    const eventModels = targetPlan.php.eventModels;
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
      'src/SchemaAdapter.php',
      readFileSync(join(here, '../templates/SchemaAdapter.php'), 'utf8').replaceAll(
        'SdkNamespace',
        ns,
      ),
    );
    put(
      'src/Runtime.php',
      readFileSync(join(here, '../templates/Runtime.php'), 'utf8').replaceAll('SdkNamespace', ns),
    );
    let code = `<?php\ndeclare(strict_types=1);\nnamespace ${ns};\n\nfinal class Client {\n    private Runtime $runtime;\n`;
    for (const group of groups) code += `    public readonly ${pascal(group)}Resource $${group};\n`;
    code += `    public function __construct(ClientOptions $options) {\n        $this->runtime = new Runtime(json_decode(file_get_contents(__DIR__ . '/contract.json'), true, 512, JSON_THROW_ON_ERROR), $options, true);\n`;
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
        const responseType = targetPlan.php.operations[op.id]!.output;
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
                : targetPlan.php.operations[op.id]!.items
            }> */\n    public function ${op.method}${suffix}(${inputName} $input, ?RequestOptions $options = null): \\Generator { return $this->runtime->${runtime}(${php(op.id)}, $input->toArray(), $options); }\n`;
        if (op.polling)
          code += `    public function ${op.method}Wait(${inputName} $input, ?RequestOptions $options = null): Result { return $this->runtime->wait(${php(op.id)}, $input->toArray(), $options); }\n`;
      }
      code += '}\n';
    }
    if (c.definitions) {
      put('src/schema-definitions.json', stable(c.definitions));
      code +=
        "final class SchemaRegistry { private static ?array $values = null; private static ?array $compiled = null; public static function definitions(): array { return self::$values ??= json_decode(file_get_contents(__DIR__ . '/schema-definitions.json'), true, 512, JSON_THROW_ON_ERROR); } public static function codecs(): array { return self::$compiled ??= json_decode(file_get_contents(__DIR__ . '/contract.json'), true, 512, JSON_THROW_ON_ERROR)['definitions']; } }\n";
    }
    for (const model of targetPlan.php.models)
      code += phpModel(model, Boolean(c.definitions), c.config.validation);
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
      `# ${c.title} SDK (${target})\n\nPackage ${c.config.version}; generated for API ${c.apiVersion}.\n\n${target === 'node' ? `Requires Node.js 22+; TypeScript 5.9+. ESM JavaScript and declarations ship together.\n\nInstall: \`npm install ${c.config.npm.name}\`` : `Requires PHP 8.2+, ext-json and ext-curl; framework independent.\n\nInstall: \`composer require ${c.config.composer.name}\``}\n\nStart with [the quickstart](examples/${first.resource}-${first.method}.${target === 'node' ? 'mjs' : 'php'}). Set API_BASE_URL explicitly and API_TOKEN if authentication is declared. Examples target a placeholder sandbox and make one attempt. Provider example values must match your sandbox. Run examples from the generated package: for Node use node examples/NAME.mjs; for PHP run composer install in the generated php/ directory, then php examples/NAME.php. When copying a PHP example into an application, point its require statement at that application\'s vendor/autoload.php.\n\n## Client and request options\n\nConstruct a client with baseUrl and, for authenticated operations, token. The SDK does not discover credentials or read environment variables; the operation example scripts read API_BASE_URL and API_TOKEN explicitly. Pass per-request options as the second method argument: a plain object in Node, or RequestOptions in PHP. Defaults are timeoutMs: 10000 per attempt and deadlineMs: 30000 for the overall duration (not an absolute timestamp). Request values override client defaults. maxAttempts defaults to the operation\'s declared limit, or one when no retries are declared; overrides cannot exceed that limit. Request headers carry tenant context without shared mutable state.\n\nResults expose data, meta and explicit raw response text. Node metadata uses properties; PHP metadata uses array keys. SdkError exposes kind, outcome, retryAllowed and optional metadata; provider codes use code in Node and errorCode in PHP. outcome is not_sent, response or unknown. Reconcile an unknown mutation outcome with the provider and the original persisted idempotency key before resubmitting.\n\n## Behavior and ownership\n\nOptional properties distinguish omission from null. PHP inputs use presence-aware typed input objects constructed from arrays: omit a key to omit it; include a key with null to clear only where permitted. PHP models expose presence through has()/get(); typed getters unwrap nested models and getters for omitted optional fields throw. In object/array alternatives, PHP lists (including []) represent JSON arrays; use (object) [] for an empty JSON object. Numeric enum inputs use exact strings for number/int64/uint64 schemas; membership compares exact values, so equivalent decimal/exponent spellings are accepted. Numeric anyOf branches merge equivalent values exactly and preserve the request token; oneOf still requires exactly one matching branch. Numeric conversions supported only by branches that stop matching fail validation before dispatch. Mutually dependent numeric alternatives use joint matching, limited to 256 combinations per value path; exceeding this limit fails validation. Large integers (int64) and decimals use exact strings, including numeric JSON wire values. Integer responses accept integral decimal/exponent notation without rounding. Sparse Node input arrays fail before dispatch. Timestamps remain strings. Unknown response fields, enum members, and tagged variants are retained. PHP response class names include status codes and, for tagged alternatives, branch positions. Adding a status can introduce a new return class even with an identical JSON shape; consult migration notes before upgrading class-based dispatch. Portable digit/word pattern escapes retain their ASCII ECMAScript meaning in both targets, including inside character classes. Full request encoding checks run locally; server business effects require provider tests.\n\nRetries count total attempts, include jitter and Retry-After, and never exceed the declared policy. Persist an idempotency key across process restarts and submissions within the server's documented retention/scope. Automatic keys cover one SDK call only. Explicit keys from operation inputs, request headers or idempotencyKey are preserved; conflicting values fail before dispatch. A timeout after dispatch can leave the remote outcome unknown; inspect SdkError.outcome. Disable nested transport/application retries to avoid multiplied attempts. 409/412 are distinct conflicts and never automatically overwritten.\n\nTimeout is per attempt, including body consumption. Deadline covers attempts and waits; pagination and polling share an overall deadline. Cancellation stops local work, not the remote operation. Node uses AbortSignal. PHP uses a Cancellation token checked during cURL progress and between waits; synchronous calls need an external signal handler to cancel while blocked. Pagination is lazy, supports maxPages/maxItems, and does not guarantee a stable snapshot or durable continuation. Generation rejects incompatible continuation/query representations, including an int64/uint64 continuation with an ordinary integer query parameter. Configured money helpers reject whitespace, including trailing newlines, and excess precision when converting exact major-unit strings to minor units.\n\nExplicit allowedOrigins govern all destinations, including pagination. HTTPS is required unless allowInsecureHttp is set for local tests. Redirects are rejected. Authentication is attached only after destination validation. API version headers are pinned when configured; changing them does not update generated types.\n\nClients perform no network I/O at import/construction. Node clients reuse the runtime's fetch connection pool; injected transports remain caller-owned and must honor AbortSignal and disable redirects/retries. PHP owns a reusable cURL handle, released by close()/destruction; a client supports sequential calls within one PHP execution context. Do not concurrently share a PHP client across threads/fibers. Node requests keep headers/context local and support concurrent calls. No SDK telemetry is sent. Requests identify the selected package name/version and runtime through an overridable User-Agent header.\n\nDiagnostics run once per attempted HTTP request, including transport failures, with operation, request ID, status, timing, attempt count and error kind only; hook failures are ignored. Bodies and credentials are excluded. Raw response text/headers and structured error details are privileged explicit access. Model debug printing redacts declared sensitive fields and additional field names supplied in ClientOptions.redactFields; printing arbitrary raw values is application responsibility. Injected transports are privileged and see credentials/bodies.\n\n## Schema helpers\n\n${target === 'node' ? 'The package exports serialize(value, schema), new Model(value, schema), and redact(value, schema) for application-supplied schemas.' : 'The base Model constructor, Codec::normalize and Codec::redact accept application-supplied schemas. Codec::encode writes normalized values as JSON.'} These helpers use the package's local value execution rules and require no generator installation or schema registry service. Generated methods and factories use the codecs included in the package. For a null-only schema, use {"type":"null"}. The legacy form {"type":["null"]} also permits non-null values in Node; PHP rejects them.\n\n## Package upgrades\n\nReview provider release notes before upgrading. Compatibility checks account for public declarations, required response values and PHP class identities. Complex schema changes can still require manual review.\n\n## Webhooks and recovery\n\n${c.config.webhook ? 'Verification uses the configured HMAC-SHA256 signature format, signed headers and original body bytes, with timestamp tolerance and overlapping secrets. Preserve raw request bytes; never verify reserialized JSON. Verification is not durable deduplication. In one database transaction, insert a unique provider event ID and durable work record before acknowledging. Workers should fetch authoritative current state for out-of-order events; commit business side effects idempotently. Unknown event types must not be treated as known success.' : 'This provider has not declared webhook verification.'}\n\nCustom helpers belong in custom/; they survive regeneration. Multi-call helpers are not atomic and must expose partial completion. See [reference](REFERENCE.md).\n`,
    );
    files.set(
      `${target}/REFERENCE.md`,
      `# ${c.title} API reference\n\nPackage ${c.config.version}; API ${c.apiVersion}.\n\n` +
        c.operations
          .map(
            (op) =>
              `## ${op.resource}.${op.method}\n\n${op.description}\n\n\`${op.verb} ${op.path}\`\n\nInput: \`${target === 'php' ? targetPlan.documentation[op.id]!.phpInput : targetPlan.documentation[op.id]!.nodeInput}\`\n\nResponse: \`${
                target === 'php'
                  ? targetPlan.documentation[op.id]!.phpOutput
                  : targetPlan.documentation[op.id]!.nodeOutput
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
const resultStatus = (status: string) =>
  /^2\d\d$/.test(status) || status === '304' || status === 'default';

export function compare(before: Contract, after: Contract): Compatibility[] {
  return compareWithCompiled(
    before,
    after,
    compileSdkContract(before).plan,
    compileSdkContract(after).plan,
  );
}
function compareWithCompiled(
  before: Contract,
  after: Contract,
  previousPlan?: CompiledSdkContract,
  nextPlan?: CompiledSdkContract,
): Compatibility[] {
  const oldPlan = previousPlan ?? compileSdkContract(before).plan;
  const newPlan = nextPlan ?? compileSdkContract(after).plan;
  const changes: Compatibility[] = [];
  const compareNode = oldPlan.targets.includes('node') && newPlan.targets.includes('node');
  const comparePhp =
    (before.config.targets ?? ['node', 'php']).includes('php') &&
    (after.config.targets ?? ['node', 'php']).includes('php');
  const add = (severity: Compatibility['severity'], subject: string, message: string) =>
    changes.push({ severity, subject, message });
  const oldModels = oldPlan.policy.models,
    newModels = newPlan.policy.models;
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
          ...comparePolicies(
            previous[direction],
            next[direction],
            `models.${name}.${direction}`,
            direction,
          ),
        );
  }
  for (const [name, definition] of Object.entries(oldPlan.policy.definitions)) {
    const next = newPlan.policy.definitions[name];
    if (!next)
      add(
        'review',
        name,
        'Recursive model definition removed or inlined; review nested value handling.',
      );
    else
      for (const direction of ['input', 'response'] as const)
        changes.push(
          ...comparePolicies(
            definition[direction],
            next[direction],
            `definitions.${name}`,
            direction,
          ),
        );
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
      ...comparePolicies(
        oldPlan.policy.operations[old.id]!.input,
        newPlan.policy.operations[old.id]!.input,
        `${old.id}.input`,
        'input',
      ),
    );
    for (const status of new Set([
      ...Object.keys(old.responses),
      ...Object.keys(current.responses),
    ])) {
      const before = old.responses[status],
        after = current.responses[status];
      if (!before || !after) {
        const shape =
          after && resultStatus(status)
            ? addedResultFits(
                Object.entries(oldPlan.responses[old.id] ?? {})
                  .filter(([key]) => resultStatus(key))
                  .map(([, value]) => value.body),
                newPlan.responses[old.id]?.[status]?.body,
                `${old.id}.response.${status}`,
                compareNode,
              )
            : undefined;
        const widened = shape?.result === 'incompatible';
        const binding = newPlan.php.runtime.operations.find((op) => op.id === old.id)?.responses[
          status
        ];
        const newPhpClass =
          after &&
          comparePhp &&
          resultStatus(status) &&
          (binding?.model || binding?.variants) &&
          !oldPlan.php.operations[old.id]?.output
            .split('|')
            .some((type) => type === 'mixed' || type === 'object');
        add(
          !after || widened || newPhpClass ? 'breaking' : 'review',
          `${old.id}.response.${status}`,
          after
            ? newPhpClass
              ? 'Response status added with new PHP response classes outside the previous return type; update class-based consumers before upgrading.'
              : widened
                ? 'Response status added with an incompatible result shape or body presence; update result handling before upgrading.'
                : 'Response status added; handle this outcome explicitly.'
            : 'Response status removed; migrate handling of this outcome.',
        );
      } else {
        if (resultStatus(status) && status !== '304' && comparePhp) {
          const previousVariants = new Map(
            Object.entries(
              oldPlan.php.runtime.operations.find((op) => op.id === old.id)?.responses[status]
                ?.variants ?? {},
            ),
          );
          const nextVariants = new Map(
            Object.entries(
              newPlan.php.runtime.operations.find((op) => op.id === old.id)?.responses[status]
                ?.variants ?? {},
            ),
          );
          for (const [tag, index] of previousVariants) {
            if (nextVariants.get(tag) !== index) {
              add(
                'breaking',
                `${old.id}.response.${status}`,
                'PHP response variant classes were reassigned by branch reordering or insertion; preserve existing branch positions or update consumers in a major release.',
              );
              break;
            }
          }
        }
        const previousBody = oldPlan.policy.operations[old.id]!.responses[status];
        const nextBody = newPlan.policy.operations[old.id]!.responses[status];
        if (previousBody && nextBody)
          changes.push(
            ...comparePolicies(previousBody, nextBody, `${old.id}.response.${status}`, 'response'),
          );
        else if (Boolean(previousBody) !== Boolean(nextBody))
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
  if (previousPlan && nextPlan) changes.push(...compareCompiledContracts(previousPlan, nextPlan));
  return [...new Map(changes.map((finding) => [stable(finding), finding])).values()];
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
  const compilation = compileSdkContract(contract);
  const files = renderCompiled(compilation);
  const compiled: CompiledSnapshot = {
    plan: compilation.plan,
    runtimeIdentity: runtimeIdentity(files, compilation.plan.targets),
  };
  const recordPath = join(output, recordName);
  const before: RecordFile | undefined = existsSync(recordPath)
    ? JSON.parse(readFileSync(recordPath, 'utf8'))
    : undefined;
  if (before && (![1, 2].includes(before.recordVersion ?? 1) || !before.files || !before.interface))
    throw new Diagnostic(
      recordPath,
      'unsupported generation record; use the recorded generator version',
    );
  try {
    if (before?.compiled) before.compiled = restoreCompiledSnapshot(before.compiled);
    if (before?.compiledComparisonBase)
      before.compiledComparisonBase = restoreCompiledSnapshot(before.compiledComparisonBase);
    if (before?.recordVersion === 2 && !before.compiled)
      throw new Error('Missing compiled contract in generation record');
  } catch (error) {
    throw new Diagnostic(recordPath, error instanceof Error ? error.message : String(error));
  }
  const previousCompiled = before ? compiledBase(before, contract) : undefined;
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
    compiled,
    changes,
    compatibility: before
      ? [
          ...compareWithCompiled(
            comparisonBase(before, contract),
            contract,
            previousCompiled?.plan,
            compiled.plan,
          ),
          ...(!previousCompiled
            ? [
                {
                  severity: 'review' as const,
                  subject: 'compiled contract',
                  message:
                    'The previous generation predates compiled contract records; historical runtime guarantees require review. Existing source-level checks still apply.',
                },
              ]
            : []),
          ...(previousCompiled &&
          (previousCompiled.plan.semantics !== compiled.plan.semantics ||
            compiled.plan.targets.some(
              (target) =>
                previousCompiled.plan.targets.includes(target) &&
                previousCompiled.runtimeIdentity[target] !== compiled.runtimeIdentity[target],
            ))
            ? [
                {
                  severity: 'review' as const,
                  subject: 'runtime',
                  message:
                    'Compiled runtime implementation or semantic identity changed; equal value plans do not prove unchanged runtime behavior.',
                },
              ]
            : []),
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
      recordVersion: 2,
      generator: version,
      contractHash: contract.hash,
      sources: contract.sources,
      files: Object.fromEntries([...current.files].map(([p, v]) => [p, hash(v)])),
      interface: contract,
      compiled: current.compiled,
      compatibility: current.compatibility,
      ...(current.before &&
      (current.before.comparisonBase ||
        current.changes.length ||
        current.compatibility.length ||
        current.before.interface.config.version !== contract.config.version)
        ? {
            comparisonBase: comparisonBase(current.before, contract),
            ...(compiledBase(current.before, contract)
              ? { compiledComparisonBase: compiledBase(current.before, contract)! }
              : {}),
            previousVersion: comparisonBase(current.before, contract).config.version,
          }
        : {}),
    };
    writeFileSync(
      join(stage, recordName),
      stable({
        ...record,
        compiled: storeCompiledSnapshot(current.compiled),
        ...(record.compiledComparisonBase
          ? { compiledComparisonBase: storeCompiledSnapshot(record.compiledComparisonBase) }
          : {}),
      }),
      { mode: 0o600 },
    );
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
  const integrity = preview(record.interface, output);
  if (integrity.changes.length)
    throw new Diagnostic(output, 'regenerate before preparing a release');
  // Analyzer upgrades can find breaks without changing emitted files. Retain
  // recorded findings as well, so release preparation cannot erase prior review.
  const compatibility = [
    ...new Map(
      [...(record.compatibility ?? []), ...integrity.compatibility].map((finding) => [
        stable(finding),
        finding,
      ]),
    ).values(),
  ];
  if (record.interface.config.release?.policy === 'semver')
    checkVersionPolicy(record.previousVersion, record.interface.config.version, compatibility);
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
