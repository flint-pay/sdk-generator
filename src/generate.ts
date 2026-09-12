import { positional, pathParameters, hasParams, requestArguments } from './request-style.js';
import { payloadSchemas } from './response-return.js';
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
import { serialize, executeCodec, ExactNumber } from './runtime.js';
import {
  modelReference,
  fieldTable,
  authenticationGuide,
  operationGuidance,
} from './sdk-documentation.js';
import { schemaComment } from './schema-documentation.js';
import {
  inputSchema,
  successStatus,
  sample,
  ExactNumberSample,
  compileSdkContract,
  type CompiledSdkContract,
  type PhpModelPlan,
} from './target-plan.js';
import { addedResultFits, addsPhpResultClass } from './response-compatibility.js';
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
              ? /^node\/(runtime|codec-plan|runtime-plan|response|request)\.js$/.test(name)
              : /^php\/src\/(Runtime|SchemaAdapter|SdkResponse)\.php$/.test(name),
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
function hasExactNumber(value: unknown): boolean {
  return (
    value instanceof ExactNumber ||
    Boolean(value && typeof value === 'object' && Object.values(value).some(hasExactNumber))
  );
}
function phpExampleString(value: string): string {
  // Keep control characters escaped so later code indentation cannot change literal data.
  return /[\u0000-\u001f\u007f]/.test(value)
    ? `json_decode(${php(JSON.stringify(value))}, flags: JSON_THROW_ON_ERROR)`
    : php(value);
}
/** Examples are SDK inputs, so exact numeric wrappers must survive source emission. */
function phpExampleSource(
  value: unknown,
  depth = 0,
  inputArray = false,
  syntax: ExampleSyntax = {},
): string {
  if (value instanceof ExactNumber)
    return `new ${syntax.exactNumber ?? 'ExactNumber'}(${php(value.value)})`;
  if (value === null || typeof value !== 'object')
    return typeof value === 'string' ? phpExampleString(value) : JSON.stringify(value);
  const list = Array.isArray(value);
  const entries = exampleEntries(value, depth === 0 ? syntax.fields : undefined);
  const prefix = list || inputArray ? '[' : '(object) [';
  if (!entries.length) return prefix + ']';
  return (
    prefix +
    '\n' +
    entries
      .map(
        ([key, child]) =>
          '  '.repeat(depth + 1) +
          (list ? '' : phpExampleString(key) + ' => ') +
          (depth === 0 && syntax.fields?.has(key)
            ? syntax.fields.get(key)!
            : phpExampleSource(child, depth + 1, false, syntax)) +
          ',',
      )
      .join('\n') +
    '\n' +
    '  '.repeat(depth) +
    ']'
  );
}
function exampleSource(
  value: unknown,
  target: 'node' | 'php',
  space = 2,
  syntax: ExampleSyntax = {},
): string {
  if (target === 'php') return phpExampleSource(value, 0, false, syntax);
  const emit = (child: unknown, depth: number): string => {
    if (child instanceof ExactNumber)
      return `new ${syntax.exactNumber ?? 'ExactNumber'}(${js(child.value)})`;
    if (child === null || typeof child !== 'object') return js(child)!;
    const array = Array.isArray(child);
    const entries = exampleEntries(child, depth === 0 ? syntax.fields : undefined).map(
      ([key, item]) =>
        (array
          ? ''
          : (key === '__proto__'
              ? `[${js(key)}]`
              : /^[A-Za-z_$][\w$]*$/.test(key)
                ? key
                : js(key)) + ': ') +
        (depth === 0 && syntax.fields?.has(key) ? syntax.fields.get(key)! : emit(item, depth + 1)),
    );
    const [open, close] = array ? ['[', ']'] : ['{', '}'];
    if (!entries.length) return open + close;
    if (
      !space ||
      (array && entries.every((entry) => !entry.includes('\n')) && entries.join(', ').length < 60)
    )
      return open + entries.join(', ') + close;
    return (
      open +
      '\n' +
      entries.map((entry) => ' '.repeat((depth + 1) * space) + entry + ',').join('\n') +
      '\n' +
      ' '.repeat(depth * space) +
      close
    );
  };
  return emit(value, 0);
}

/** Only display non-sensitive identity/status fields guaranteed by every success response. */
function exampleResult(
  op: Operation,
  definitions: Record<string, Schema>,
  target: 'node' | 'php',
  result = 'result',
): string {
  const paths = (schema: Schema, prefix: string[] = [], seen = new Set<string>()): string[][] => {
    if (prefix.length > 4 || schema['x-sensitive']) return [];
    const ref = schema['x-sdk-ref'] as string | undefined;
    if (ref)
      return seen.has(ref) || !definitions[ref]
        ? []
        : paths(definitions[ref]!, prefix, new Set([...seen, ref]));
    if (schema.type !== 'object') return [];
    return Object.entries(schema.properties ?? {}).flatMap(([key, child]) => {
      if (!schema.required?.includes(key) || child['x-sensitive'] || child.writeOnly) return [];
      const path = [...prefix, key];
      return child.type === 'string' && /^(?:id|status|[a-z_]+_id)$/.test(key)
        ? [path]
        : paths(child, path, seen);
    });
  };
  const responses = Object.entries(op.responses).filter(
    ([status]) => successStatus(status) || status === 'default',
  );
  const alternatives = op.response?.payloadPath
    ? payloadSchemas(op, definitions).map((s) => paths(s))
    : responses.map(([, response]) => (response.schema ? paths(response.schema) : []));
  const common = (alternatives[0] ?? [])
    .filter((path) =>
      alternatives.every((paths) =>
        paths.some((other) => JSON.stringify(other) === JSON.stringify(path)),
      ),
    )
    .slice(0, 2);
  return common
    .map((path) =>
      target === 'node'
        ? `console.log(${result}${op.response?.return === 'payload' ? '' : '.data'}${path.map((key) => (/^[A-Za-z_$][\w$]*$/.test(key) ? '.' + key : `[${js(key)}]`)).join('')});\n`
        : `echo $${result}${op.response?.return === 'payload' ? '' : '->data'}${path.map((key) => (/^[A-Za-z_][\w]*$/.test(key) ? '->' + key : '->{' + phpExampleString(key) + '}')).join('')} . PHP_EOL;\n`,
    )
    .join('');
}

const pascal = (s: string) => s[0]!.toUpperCase() + s.slice(1);
const comment = (s: string) => s.replaceAll('*/', '* /').replaceAll('\r', '');
function publicArguments(
  op: Operation,
  input: unknown,
  target: 'node' | 'php',
  syntax: ExampleSyntax = {},
  multiline = false,
): string {
  return requestArguments(op, input)
    .map((value) =>
      value === undefined
        ? target === 'node'
          ? 'undefined'
          : 'null'
        : target === 'node'
          ? exampleSource(value, 'node', multiline ? 2 : 0, syntax)
          : phpExampleSource(value, 0, true, syntax),
    )
    .map((source) => (multiline ? source.replace(/^/gm, '  ') : source))
    .join(multiline ? ',\n' : ', ');
}

function callPlan(op: Operation, plan: CompiledSdkContract, optionsType: string) {
  const prefix = pascal(op.resource) + pascal(op.method);
  const required = Boolean(inputSchema(op).required?.length);
  if (!positional(op))
    return {
      nodeArgs: 'input = {}, options',
      nodeSignature: `input${required ? '' : '?'}: ${prefix}Input, options?: ${optionsType}`,
      nodeInput: 'input',
      phpSignature: `${prefix}Input|array $input${required ? '' : ' = []'}, ?RequestOptions $options = null`,
      phpPrelude: '',
      phpDoc: `@param ${prefix}Input|array $input`,
    };
  return plan.requestCalls![op.id]!;
}

function methodDoc(
  op: Operation,
  method: string,
  definitions: Record<string, Schema> = {},
): string {
  const deprecated =
    method !== op.method
      ? `Use ${op.resource}.${op.method}; HTTP behavior is unchanged.`
      : op.deprecated;
  const key = exampleKey(op, 'node', 'idempotencyKey', true, definitions);
  return `/**\n * ${comment(op.description).replaceAll('\n', '\n * ')}\n * ${op.verb} ${comment(op.path)}\n${deprecated ? ` * @deprecated ${comment(deprecated).replaceAll('\n', '\n * ')}\n` : ''}${key.requiresSuppliedKey ? ' * Set API_IDEMPOTENCY_KEY to a key matching the declared header schema before running this example.\n' : ''} * @example client.${op.resource}.${method}(${comment(publicArguments(op, exampleInput(op, definitions), 'node', { fields: key.fields }))}${!positional(op) || pathParameters(op).length || hasParams(op) ? ', ' : ''}{ ${key.requestOption ? key.requestOption + ', ' : ''}maxAttempts: 1 })\n */\n`;
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
      code += `    /** @return ${comment(getter.doc)}\n     * @throws SdkError When ${comment(getter.field)} is omitted; use has${getter.method.slice(3)}() or valueOrDefault().\n     */\n    public function ${getter.method}(): ${getter.type} { return $this->get(${php(getter.field)}); }\n    public function has${getter.method.slice(3)}(): bool { return $this->has(${php(getter.field)}); }\n`;
  }
  return code + '}\n';
}
const checkedExamples = new WeakMap<Operation, unknown>();
function materializeSample(value: unknown): unknown {
  if (value instanceof ExactNumberSample) return new ExactNumber(value.token);
  if (Array.isArray(value)) return value.map(materializeSample);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, materializeSample(child)]),
    );
  return value;
}
function exampleInput(op: Operation, definitions: Record<string, Schema> = {}): unknown {
  if (checkedExamples.has(op)) return checkedExamples.get(op);
  try {
    const input = op.example ?? materializeSample(sample(inputSchema(op), {}, definitions));
    serialize(input, { ...inputSchema(op), 'x-sdk-definitions': definitions });
    return input;
  } catch (error) {
    throw new Diagnostic(
      `config/operations/${op.id}/example`,
      `provide an input example that satisfies this operation: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
interface ExampleSyntax {
  exactNumber?: string;
  fields?: ReadonlyMap<string, string>;
}
function exampleEntries(value: object, fields?: ReadonlyMap<string, string>): [string, unknown][] {
  const entries = Object.entries(value);
  for (const key of fields?.keys() ?? [])
    if (!Object.hasOwn(value, key)) entries.push([key, undefined]);
  return entries;
}
/** Only synthesize random keys when every generated value satisfies the schema. */
function acceptsGeneratedKey(
  schema: Schema,
  length: number,
  definitions: Record<string, Schema>,
  seen = new Set<string>(),
): boolean {
  const annotations = new Set([
    'title',
    'description',
    'example',
    'examples',
    'deprecated',
    'readOnly',
    'writeOnly',
    'default',
    'x-sensitive',
  ]);
  const supported = new Set(['type', 'minLength', 'maxLength', 'allOf', 'anyOf', 'x-sdk-ref']);
  if (Object.keys(schema).some((key) => !annotations.has(key) && !supported.has(key))) return false;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (schema.type !== undefined && !types.includes('string')) return false;
  if ((schema.minLength ?? 0) > length || (schema.maxLength ?? Infinity) < length) return false;
  const ref = schema['x-sdk-ref'];
  if (ref) {
    if (seen.has(ref) || !definitions[ref]) return false;
    if (!acceptsGeneratedKey(definitions[ref]!, length, definitions, new Set(seen).add(ref)))
      return false;
  }
  if (
    schema.allOf &&
    !schema.allOf.every((branch) => acceptsGeneratedKey(branch, length, definitions, seen))
  )
    return false;
  if (
    schema.anyOf &&
    !schema.anyOf.some((branch) => acceptsGeneratedKey(branch, length, definitions, seen))
  )
    return false;
  return true;
}
function exampleKey(
  op: Operation,
  target: 'node' | 'php',
  key = 'idempotencyKey',
  inline = false,
  definitions: Record<string, Schema> = {},
) {
  const fields = new Map<string, string>();
  let requestOption = '',
    keySetup = '';
  const headerName = op.idempotency?.header ?? 'Idempotency-Key';
  const parameters = op.parameters.filter(
    (p) => p.in === 'header' && p.name.toLowerCase() === headerName.toLowerCase(),
  );
  const requiresSuppliedKey = parameters.some(
    (p) => !acceptsGeneratedKey(p.schema, target === 'node' ? 36 : 32, definitions),
  );
  if (op.idempotency || parameters.length) {
    const create = requiresSuppliedKey
      ? target === 'node'
        ? "(process.env.API_IDEMPOTENCY_KEY ?? '')"
        : "(getenv('API_IDEMPOTENCY_KEY') === false ? '' : getenv('API_IDEMPOTENCY_KEY'))"
      : target === 'node'
        ? 'crypto.randomUUID()'
        : 'bin2hex(random_bytes(16))';
    const expression = inline ? create : target === 'node' ? key : '$' + key;
    if (!inline) {
      keySetup =
        '// Reuse this key when retrying the same action.\n' +
        (target === 'node' ? `const ${key} = ${create};\n` : `$${key} = ${create};\n`);
      if (requiresSuppliedKey)
        keySetup +=
          target === 'node'
            ? `if (!${key}) throw new Error('Set API_IDEMPOTENCY_KEY to a new key matching the header schema, or reuse the key saved with this action');\n`
            : `if ($${key} === '') throw new \\RuntimeException('Set API_IDEMPOTENCY_KEY to a new key matching the header schema, or reuse the key saved with this action');\n`;
      keySetup += '\n';
    }
    if (parameters.length) for (const p of parameters) fields.set(p.name, expression);
    else requestOption = `idempotencyKey: ${expression}`;
  }
  return { fields, requestOption, keySetup, requiresSuppliedKey };
}
interface ExampleParts {
  symbols: string[];
  setup: string;
  call: string;
  close: string;
}
function exampleParts(
  c: Contract,
  op: Operation,
  target: 'node' | 'php',
  options: {
    client?: string;
    result?: string;
    qualifiedPhp?: boolean;
    fields?: ReadonlyMap<string, string>;
    requestOption?: string;
  } = {},
): ExampleParts {
  const client = options.client ?? 'client';
  const result = options.result ?? 'result';
  const input = exampleInput(op, c.definitions ?? {});
  const mode = op.authModes?.[0];
  const authentication = mode ? c.authentication?.[mode] : undefined;
  const shortcut = Object.entries(c.authShortcuts ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .find(([, value]) => value.mode === mode)?.[0];
  const shortcutEnv = shortcut?.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase();
  const hasStream = Object.values(op.responses).some((response) => response.bodyKind === 'sse');
  const qualify = (symbol: string) =>
    options.qualifiedPhp ? `\\${c.config.composer.namespace}\\${symbol}` : symbol;
  const key = options.fields
    ? { fields: options.fields, requestOption: options.requestOption, keySetup: '' }
    : exampleKey(op, target, 'idempotencyKey', false, c.definitions ?? {});
  const syntax: ExampleSyntax = {
    exactNumber: target === 'php' ? qualify('ExactNumber') : 'ExactNumber',
    fields: key.fields,
  };
  const symbols = [
    'Client',
    ...(target === 'php' ? ['ClientOptions', 'RequestOptions'] : []),
    ...(hasExactNumber(input) ? ['ExactNumber'] : []),
    ...(hasStream ? ['EventStream'] : []),
  ];
  const requestOptions = (key.requestOption ? key.requestOption + ', ' : '') + 'maxAttempts: 1';
  if (target === 'node') {
    const authOptions = shortcut
      ? `${shortcut}: process.env.${shortcutEnv} ?? ''`
      : mode && authentication
        ? `authMode: ${js(mode)},\n  credentials: {\n    [${js(mode)}]: {\n${authentication.schemes.map((scheme) => `      [${js(scheme.name)}]: process.env.${('API_' + mode + '_' + scheme.name).replace(/[^A-Za-z0-9_]/g, '_').toUpperCase()} ?? '',`).join('\n')}\n    },\n  }`
        : op.authenticated
          ? `token: process.env.API_TOKEN ?? ''`
          : '';
    return {
      symbols,
      setup: `const ${client} = new Client({\n  baseUrl: process.env.API_BASE_URL ?? 'https://sandbox.example.invalid',\n${authOptions ? '  ' + authOptions + ',\n' : ''}});\n`,
      call:
        key.keySetup +
        `const ${result} = await ${client}.${op.resource}.${op.method}(\n${publicArguments(op, input, 'node', syntax, true)}${requestArguments(op, input).length ? ',\n' : ''}  { ${requestOptions} },\n);\n${exampleResult(op, c.definitions ?? {}, 'node', result)}${op.response?.return === 'payload' ? '' : `console.log(${result}.meta.requestId);\n`}` +
        (hasStream
          ? `if (${result}${op.response?.return === 'payload' ? '' : '.data'} instanceof EventStream) {\n  for await (const event of ${result}${op.response?.return === 'payload' ? '' : '.data'}) { console.log(event.event, event.id, event.data); break; }\n}\n`
          : ''),
      close: hasStream ? `await ${client}.close();\n` : '',
    };
  }
  const authOptions = shortcut
    ? `${shortcut}: getenv('${shortcutEnv}') ?: ''`
    : mode && authentication
      ? `authMode: ${php(mode)},\n  credentials: [\n    ${php(mode)} => [\n${authentication.schemes.map((scheme) => `      ${php(scheme.name)} => getenv(${php(('API_' + mode + '_' + scheme.name).replace(/[^A-Za-z0-9_]/g, '_').toUpperCase())}) ?: '',`).join('\n')}\n    ],\n  ]`
      : op.authenticated
        ? "token: getenv('API_TOKEN') ?: ''"
        : '';
  return {
    symbols,
    setup: `$${client} = new Client(new ClientOptions(\n  baseUrl: getenv('API_BASE_URL') ?: 'https://sandbox.example.invalid',\n${authOptions ? '  ' + authOptions + ',\n' : ''}));\n`,
    call:
      key.keySetup +
      `${positional(op) ? '' : `$input = ${phpExampleSource(input, 0, true, syntax)};\n`}$${result} = $${client}->${op.resource}->${op.method}(${positional(op) ? publicArguments(op, input, 'php', syntax) : '$input'}${requestArguments(op, input).length ? ', ' : ''}new RequestOptions(${requestOptions}));\n${exampleResult(op, c.definitions ?? {}, 'php', result)}${op.response?.return === 'payload' ? '' : `echo ($${result}->meta['requestId'] ?? '') . PHP_EOL;\n`}` +
      (hasStream
        ? `if ($${result}${op.response?.return === 'payload' ? '' : '->data'} instanceof ${qualify('EventStream')}) {\n  foreach ($${result}${op.response?.return === 'payload' ? '' : '->data'} as $event) { echo $event->event; break; }\n  $${result}${op.response?.return === 'payload' ? '' : '->data'}->close();\n}\n`
        : ''),
    close: `$${client}->close();\n`,
  };
}
function exampleImports(
  c: Contract,
  target: 'node' | 'php',
  symbols: string[],
  standalone: boolean,
): string {
  return target === 'node'
    ? `import { ${[...new Set(symbols)].join(', ')} } from ${php(c.config.npm.name)};\n`
    : `<?php\ndeclare(strict_types=1);\nrequire __DIR__ . ${php(standalone ? '/../vendor/autoload.php' : '/vendor/autoload.php')};\nuse ${c.config.composer.namespace}\\{${[...new Set(symbols)].join(', ')}};\n`;
}

/** Keep the landing page useful without embedding hundreds of operation scripts. */
function readmeExamples(c: Contract, target: 'node' | 'php'): string {
  const candidates = [...c.operations].sort(
    (a, b) => Number(Boolean(b.example)) - Number(Boolean(a.example)),
  );
  const selected: Operation[] = [];
  const add = (op: Operation | undefined) => {
    if (op && selected.length < 3 && !selected.includes(op)) selected.push(op);
  };
  for (const id of c.config.documentation?.examples ?? [])
    add(c.operations.find((op) => op.id === id));
  add(
    candidates.find((op) => op.verb === 'POST' && op.method === 'create') ??
      candidates.find((op) => op.verb === 'POST'),
  );
  add(candidates.find((op) => op.verb === 'GET'));
  add(candidates.find((op) => !selected.some((other) => other.resource === op.resource)));
  for (const op of candidates) {
    if (selected.length >= 3) break;
    add(op);
  }
  const extension = target === 'node' ? 'mjs' : 'php';
  return (
    'Replace sample IDs with values from your account. Each new action gets a unique idempotency key. Save it with the action if retries need to survive a process restart.\n\n' +
    selected
      .map((op, index) => {
        const path = `examples/${op.resource}-${op.method}.${extension}`;
        const modeChanged =
          op.authModes?.[0] !== selected[0]?.authModes?.[0] ||
          op.authenticated !== selected[0]?.authenticated;
        const client =
          index > 0 && modeChanged ? op.resource + pascal(op.method) + 'Client' : 'client';
        const result =
          target === 'node' && index > 0 ? op.resource + pascal(op.method) + 'Result' : 'result';
        const key =
          index === 0 ? 'idempotencyKey' : op.resource + pascal(op.method) + 'IdempotencyKey';
        const { fields, requestOption, keySetup } = exampleKey(
          op,
          target,
          key,
          false,
          c.definitions ?? {},
        );
        const parts = exampleParts(c, op, target, {
          client,
          result,
          fields,
          requestOption,
          qualifiedPhp: index > 0,
        });
        let call = keySetup + parts.call;
        if (index === 0) {
          const symbols =
            target === 'node'
              ? selected.flatMap((operation) => exampleParts(c, operation, target).symbols)
              : parts.symbols;
          const setup = exampleImports(c, target, ['SdkError', ...symbols], false) + parts.setup;
          const catchBody =
            target === 'node'
              ? `} catch (error) {\n  if (!(error instanceof SdkError)) throw error;\n  console.error(error.kind, error.code, error.meta?.requestId);\n  if (error.outcome === 'unknown') {\n    // Reconcile with the API before resubmitting this action.\n    console.error('The request may have succeeded; check its current state.');\n  }\n  throw error;\n}\n`
              : `} catch (SdkError $error) {\n  error_log($error->kind . ': ' . ($error->errorCode ?? '') . ' request=' . ($error->meta['requestId'] ?? 'unknown'));\n  if ($error->outcome === 'unknown') {\n    // Reconcile with the API before resubmitting this action.\n    error_log('The request may have succeeded; check its current state.');\n  }\n  throw $error;\n}\n`;
          call =
            setup +
            '\n' +
            keySetup +
            'try {\n' +
            parts.call
              .trimEnd()
              .split('\n')
              .map((line) => '  ' + line)
              .join('\n') +
            '\n' +
            catchBody;
        } else if (modeChanged) {
          call = parts.setup + '\n' + call;
        }
        return `${index === 1 ? '## More examples\n\nReuse the client above. Each recipe represents a separate business action.\n\n' : ''}### ${op.resource}.${op.method}\n\n${op.description}\n\n\`\`\`${target === 'node' ? 'typescript' : 'php'}\n${call}\`\`\`\n\n[Run the standalone example](${path})\n`;
      })
      .join('\n') +
    `\n${target === 'php' || c.operations.some((op) => Object.values(op.responses).some((r) => r.bodyKind === 'sse')) ? `Close the client when finished with ${target === 'node' ? '\`await client.close()\`' : '\`$client->close()\`'}. ` : ''}For retry and error details, see the [runtime guide](RUNTIME.md).\n\n`
  );
}

function convenienceReference(c: Contract, op: Operation, target: 'node' | 'php'): string {
  const parts = exampleParts(c, op, target);
  const input = exampleInput(op, c.definitions ?? {});
  const source = publicArguments(op, input, target);
  const call = (method: string, options: string) =>
    target === 'node'
      ? `client.${op.resource}.${method}(${source}${source ? ', ' : ''}{ ${options} })`
      : `$client->${op.resource}->${method}(${source}${source ? ', ' : ''}new RequestOptions(${options}))`;
  const examples: string[] = [];
  if (op.pagination) {
    for (const suffix of ['Items', 'Pages']) {
      const value = suffix === 'Items' ? 'item' : 'page';
      const invocation = call(
        op.method + suffix,
        'maxPages: 10, maxItems: 1000, deadlineMs: 60000',
      );
      const loop =
        target === 'node'
          ? `for await (const ${value} of ${invocation}) {\n  console.log(${value}${suffix === 'Pages' ? '.meta.requestId' : ''});\n}\n`
          : `foreach (${invocation} as $${value}) {\n  // Process this ${value} before requesting the next one.\n}\n`;
      examples.push(
        `#### ${op.resource}.${op.method}${suffix}\n\n${suffix === 'Items' ? 'Iterate individual values across pages.' : 'Iterate page Results, including HTTP metadata.'} Iteration is lazy; all pages share the deadline.\n\n\`\`\`${target === 'node' ? 'typescript' : 'php'}\n${exampleImports(c, target, parts.symbols, false)}${parts.setup}${loop}${parts.close}\`\`\`\n\n`,
      );
    }
  }
  if (op.polling) {
    const invocation = call(op.method + 'Wait', 'deadlineMs: 60000');
    examples.push(
      `#### ${op.resource}.${op.method}Wait\n\nWait for ${op.polling.state}: success ${op.polling.success.join(', ')}; failure ${op.polling.failure.join(', ')}. Unknown states keep waiting until the deadline. Cancellation stops waiting, not the remote job.\n\n\`\`\`${target === 'node' ? 'typescript' : 'php'}\n${exampleImports(c, target, parts.symbols, false)}${parts.setup}${target === 'node' ? `const result = await ${invocation};\nconsole.log(result.meta.requestId);\n` : `$result = ${invocation};\necho $result->meta['requestId'] ?? '';\n`}${parts.close}\`\`\`\n\n`,
    );
  }
  return examples.join('');
}
function recoveryReference(c: Contract, target: 'node' | 'php'): string {
  const op = c.operations.find((op) => op.idempotency);
  if (!op) return '';
  const key = exampleKey(op, target, 'idempotencyKey', false, c.definitions ?? {});
  const parts = exampleParts(c, op, target, {
    fields: key.fields,
    requestOption: key.requestOption,
  });
  const setup =
    target === 'node'
      ? `const idempotencyKey = process.env.API_IDEMPOTENCY_KEY;\nif (!idempotencyKey) throw new Error('Set API_IDEMPOTENCY_KEY to the key saved with this action');\n`
      : `$idempotencyKey = getenv('API_IDEMPOTENCY_KEY');\nif (!$idempotencyKey) throw new \\RuntimeException('Set API_IDEMPOTENCY_KEY to the key saved with this action');\n`;
  return `\n## Resume an action with its saved key\n\nUse this only after reconciling the previous outcome and confirming the provider permits resubmission. Read the key and the original input from your saved action; keep both unchanged. The environment variable below stands in for your application's durable action record. Do not generate a new key when retrying that action. This example makes one request attempt.\n\n\`\`\`${target === 'node' ? 'typescript' : 'php'}\n${exampleImports(c, target, parts.symbols, false)}${parts.setup}${setup}${parts.call}${parts.close}\`\`\`\n`;
}

export function render(c: Contract): Map<string, string> {
  return renderCompiled(compileSdkContract(c));
}
function renderCompiled(compilation: ReturnType<typeof compileSdkContract>): Map<string, string> {
  const c = compilation.source;
  const targetPlan = compilation.plan;
  for (const op of c.operations) {
    const model = targetPlan.php.models.find(
      (model) => model.name === pascal(op.resource) + pascal(op.method) + 'Input',
    );
    if (!model) throw new Error('Missing input codec for ' + op.id);
    try {
      const input =
        op.example ?? materializeSample(sample(inputSchema(op), {}, c.definitions ?? {}));
      executeCodec(input, model.codec, {
        mode: 'request',
        definitions: targetPlan.runtime.definitions ?? {},
      });
      checkedExamples.set(op, input);
    } catch (error) {
      throw new Diagnostic(
        `config/operations/${op.id}/example`,
        `provide an input example that satisfies this operation: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const files = new Map<string, string>();
  const targets = c.config.targets ?? ['node', 'php'];
  const groups = [...new Set(c.operations.map((o) => o.resource))].sort();
  const models = targetPlan.node.models;
  const payloadReturns = targetPlan.responseReturns ?? {};
  const hasPayloadReturns = Object.keys(payloadReturns).length > 0;
  const symbols = new Set(
    [
      'Client',
      ...(hasPayloadReturns ? ['SdkResponse'] : []),
      'Runtime',
      'Model',
      'Result',
      'SdkError',
      'Codec',
      'RawNumber',
      'ExactNumber',
      'EventStream',
      'ServerSentEvent',
      'ByteStream',
      'CurlByteStream',
      'ParsedNumber',
      'Cancellation',
      'ClientOptions',
      'RequestOptions',
      'InputValue',
      ...(c.authentication
        ? ['Credentials', 'AuthMode', 'RuntimeClientOptions', 'RuntimeRequestOptions']
        : []),
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
            ...(c.authentication ? ['Omit', 'Partial'] : []),
            'Exclude',
            'Object',
            'Array',
            'Uint8Array',
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
      // Conditional export key order is semantic; canonical sorting would change resolution.
      JSON.stringify(
        {
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
            'MODELS.md',
            'RUNTIME.md',
            'LICENSE',
            'examples/',
            'guides/',
            'custom/',
          ],
        },
        null,
        2,
      ) + '\n',
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
    put('request-style.d.ts', readFileSync(join(here, 'request-style.d.ts'), 'utf8'));
    put('response-return.d.ts', readFileSync(join(here, 'response-return.d.ts'), 'utf8'));
    put('contract.d.ts', readFileSync(join(here, 'contract.d.ts'), 'utf8'));
    const streamTypes = c.operations.some((op) =>
      Object.values(op.responses).some((response) => response.bodyKind === 'sse'),
    );
    const numberTypes = c.config.numericUnions === 'explicit';
    const extraValues = `${streamTypes ? ', EventStream' : ''}${numberTypes ? ', ExactNumber' : ''}`;
    let code = `import { runtimeFromPlan, modelFromCodec, isKnownCodec } from './runtime.js';\nexport { SdkError, Model${extraValues}, serialize, parseExact, redact } from './runtime.js';\nconst contract = ${js({ ...compiledRuntime, userAgent: `${c.config.npm.name.replace(/^@/, '').replaceAll('/', '-')}/${c.config.version} (Node.js)` })};\nexport class Client {\n  #runtime;\n  constructor(options) {\n    this.#runtime = runtimeFromPlan(contract, options);\n`;
    if (c.operations.some(positional)) {
      put('request.js', readFileSync(join(here, '../templates/request.mjs'), 'utf8'));
      code = "import { requestInput as _sdkRequestInput } from './request.js';\n" + code;
    }
    let declarations = `import type { ${c.authentication ? 'ClientOptions as RuntimeClientOptions, RequestOptions as RuntimeRequestOptions' : 'ClientOptions, RequestOptions'}, Result, InputValue } from './runtime.js';\nimport { Model${extraValues} } from './runtime.js';\nexport { SdkError, Model${extraValues}, serialize, parseExact, redact } from './runtime.js';\nexport type { ${c.authentication ? '' : 'ClientOptions, RequestOptions, '}Result, Metadata, ErrorKind, DiagnosticEvent, InputValue${streamTypes ? ', ServerSentEvent' : ''} } from './runtime.js';\n`;
    if (targetPlan.node.authentication) declarations += targetPlan.node.authentication.declarations;
    if (hasPayloadReturns) {
      put('response.js', readFileSync(join(here, '../templates/response.mjs'), 'utf8'));
      code =
        "import { responsePayload as _sdkPayload, sdkResponse as _sdkResponse } from './response.js';\n" +
        code;
      declarations += targetPlan.node.responseReturnDeclarations!;
    }

    for (const [name, model] of Object.entries(models)) {
      declarations += `${schemaComment(c.models[name]!)}export type ${name} = ${model.documentedOutput ?? model.output};\n${schemaComment(c.models[name]!)}export type ${name}Input = ${model.documentedInput ?? model.input};\n`;
      // Preserve the validated object branch when a model also permits
      // nonobjects, so its factory can nest inside an object-constrained field.
      if (model.objectFactory) {
        const object = `Exclude<${name}Input & object, readonly unknown[]>`;
        declarations += `export declare function make${name}(value: InputValue<${object}>): Model<${object}>;\n`;
      }
      declarations += `export declare function make${name}(value: InputValue<${name}Input>): Model<${name}Input>;\n`;
    }
    for (const op of c.operations)
      declarations += `export type ${pascal(op.resource)}${pascal(op.method)}Input = ${targetPlan.node.operations[op.id]!.documentedInput ?? targetPlan.node.operations[op.id]!.input};\nexport type ${pascal(op.resource)}${pascal(op.method)}Response = ${targetPlan.node.operations[op.id]!.output};\n`;
    declarations += 'export declare class Client {\n  constructor(options: ClientOptions);\n';
    for (const group of groups) {
      code += `    this.${group} = Object.freeze({\n`;
      declarations += `  readonly ${group}: {\n`;
      for (const op of c.operations.filter((o) => o.resource === group)) {
        const prefix = pascal(op.resource) + pascal(op.method);
        const required = targetPlan.node.operations[op.id]!.inputRequired;
        const requestOptionsType =
          targetPlan.node.operations[op.id]!.requestOptions ?? 'RequestOptions';
        const payload = payloadReturns[op.id];
        const call = callPlan(op, targetPlan, requestOptionsType);
        for (const method of [op.method, ...(op.aliases ?? [])]) {
          const request = `this.#runtime.request(${js(op.id)}, ${call.nodeInput}, options)`;
          code += `      ${method}: ${positional(op) ? 'async ' : ''}(${call.nodeArgs}) => ${request}${payload ? `.then(result => _sdkPayload(result, ${js(payload.path)}))` : ''},\n`;
          declarations += `    ${methodDoc(op, method, definitions)}    ${method}(${call.nodeSignature}): Promise<${payload ? payload.node : `Result<${prefix}Response>`}>;\n`;
          if (payload) {
            code += `      ${method}WithResponse: ${positional(op) ? 'async ' : ''}(${call.nodeArgs}) => ${request}.then(_sdkResponse),\n`;
            declarations += `    /** Complete decoded body and HTTP metadata, without payload unwrapping. */\n    ${method}WithResponse(${call.nodeSignature}): Promise<SdkResponse<${prefix}Response>>;\n`;
          }
        }
        if (op.pagination)
          for (const [suffix, runtime, returnType] of [
            ['Pages', 'pages', `Result<${prefix}Response>`],
            ['Items', 'items', targetPlan.node.operations[op.id]!.items],
          ]) {
            code += `      ${op.method}${suffix}: (${call.nodeArgs}) => this.#runtime.${runtime}(${js(op.id)}, ${call.nodeInput}, options),\n`;
            declarations += `    ${op.method}${suffix}(${call.nodeSignature}): AsyncGenerator<${returnType}>;\n`;
          }
        if (op.polling) {
          code += `      ${op.method}Wait: (${call.nodeArgs}) => this.#runtime.wait(${js(op.id)}, ${call.nodeInput}, options),\n`;
          declarations += `    ${op.method}Wait(${positional(op) ? call.nodeSignature : `input: ${prefix}Input, options?: ${requestOptionsType}`}): Promise<Result<${prefix}Response>>;\n`;
        }
      }
      code += '    });\n';
      declarations += '  };\n';
    }
    code += '  }\n';
    if (streamTypes) {
      code += '  close() { return this.#runtime.close(); }\n';
      declarations += '  close(): Promise<void>;\n';
    }
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
      const parts = exampleParts(c, op, 'node');
      const example =
        exampleImports(c, 'node', parts.symbols, true) + parts.setup + parts.call + parts.close;
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
      readFileSync(join(here, '../templates/Runtime.php'), 'utf8')
        .replaceAll('SdkNamespace', ns)
        .replaceAll(
          '    ) {\n        /* AUTH_SHORTCUT_PARAMETERS */\n    }',
          Object.keys(c.authShortcuts ?? {})
            .sort()
            .map((key) => `        public readonly ?string $${key} = null,\n`)
            .join('') + '    ) {}',
        )
        .replaceAll(
          '/* AUTH_SHORTCUT_FORWARD */',
          Object.keys(c.authShortcuts ?? {})
            .sort()
            .map((key) => `$this->${key},`)
            .join('\n            '),
        ),
    );
    if (hasPayloadReturns)
      put(
        'src/SdkResponse.php',
        readFileSync(join(here, '../templates/SdkResponse.php'), 'utf8').replace(
          'namespace SdkNamespace;',
          `namespace ${ns};`,
        ),
      );
    let code = `<?php\ndeclare(strict_types=1);\nnamespace ${ns};\n${hasPayloadReturns ? "require_once __DIR__ . '/SdkResponse.php';\n" : ''}\nfinal class Client {\n    private Runtime $runtime;\n`;
    for (const group of groups) code += `    public readonly ${pascal(group)}Resource $${group};\n`;
    code += `    public function __construct(ClientOptions $options) {\n        $this->runtime = new Runtime(${c.config.schemaSharing === 'named' ? 'SchemaRegistry::contract()' : "json_decode(file_get_contents(__DIR__ . '/contract.json'), true, 512, JSON_THROW_ON_ERROR)"}, $options, true);\n`;
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
        const inputDefault = inputSchema(op).required!.length ? '' : ' = []';
        const normalizeInput = `$input instanceof ${inputName} ? $input->toInputArray() : (new ${inputName}($input))->toInputArray()`;
        const responseType = targetPlan.php.operations[op.id]!.output;
        const payload = payloadReturns[op.id];
        const call = callPlan(op, targetPlan, 'RequestOptions');
        for (const method of [op.method, ...(op.aliases ?? [])]) {
          const request = `$this->runtime->request(${php(op.id)}, ${normalizeInput}, $options)`;
          code += `    /** ${comment(op.description)}\n${method !== op.method || op.deprecated ? `     * @deprecated ${comment(method !== op.method ? 'Use ' + op.method + '.' : op.deprecated!)}\n` : ''}     * ${positional(op) ? call.phpDoc : `@param ${inputName}|${targetPlan.documentation[op.id]!.phpInput} $input`}\n     * @return ${payload ? payload.php : `Result<${responseType}>`}\n     */\n    public function ${method}(${call.phpSignature}): ${payload ? payload.phpNative : 'Result'} { ${call.phpPrelude}return ${payload ? `SdkResponse::payload(${request}, [${payload.path.map(php).join(', ')}])` : request}; }\n`;
          if (payload)
            code += `    /** @return SdkResponse<${responseType}> */\n    public function ${method}WithResponse(${call.phpSignature}): SdkResponse { ${call.phpPrelude}$result = ${request}; return new SdkResponse($result->data, $result->meta, $result->raw); }\n`;
        }
        if (op.pagination)
          for (const [suffix, runtime] of [
            ['Pages', 'pages'],
            ['Items', 'items'],
          ])
            code += `    /** @return \\Generator<int, ${
              suffix === 'Pages'
                ? `Result<${responseType}>`
                : targetPlan.php.operations[op.id]!.items
            }> */\n    public function ${op.method}${suffix}(${call.phpSignature}): \\Generator { ${call.phpPrelude}return $this->runtime->${runtime}(${php(op.id)}, ${normalizeInput}, $options); }\n`;
        if (op.polling)
          code += `    public function ${op.method}Wait(${call.phpSignature}): Result { ${call.phpPrelude}return $this->runtime->wait(${php(op.id)}, ${normalizeInput}, $options); }\n`;
      }
      code += '}\n';
    }
    if (c.definitions) {
      put('src/schema-definitions.json', stable(c.definitions));
      if (c.config.schemaSharing === 'named')
        code +=
          "final class SchemaRegistry { private static ?array $values = null; private static ?array $contract = null; public static function definitions(): array { return self::$values ??= json_decode(file_get_contents(__DIR__ . '/schema-definitions.json'), true, 512, JSON_THROW_ON_ERROR); } public static function contract(): array { return self::$contract ??= json_decode(file_get_contents(__DIR__ . '/contract.json'), true, 512, JSON_THROW_ON_ERROR); } public static function codecs(): array { return self::contract()['definitions']; } }\n";
      else
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
    for (const op of c.operations) {
      const parts = exampleParts(c, op, 'php');
      put(
        `examples/${op.resource}-${op.method}.php`,
        exampleImports(c, 'php', parts.symbols, true) + parts.setup + parts.call + parts.close,
      );
    }
  }
  for (const target of targets) {
    const guides = Object.entries(c.config.documentation?.guides ?? {});
    const guidance =
      (c.config.documentation?.overview ? c.config.documentation.overview + '\n\n' : '') +
      '[API reference and operation examples](REFERENCE.md) · [Models and field descriptions](MODELS.md)' +
      guides.map(([slug]) => ` · [${slug}](guides/${slug}.md)`).join('') +
      '\n\n';
    files.set(
      `${target}/README.md`,
      `# ${c.title} SDK (${target})\n\nPackage ${c.config.version}; generated for API ${c.apiVersion}.\n\n${guidance}## Installation\n\n${target === 'node' ? `Requires Node.js 22+; TypeScript 5.9+. ESM JavaScript and declarations ship together.\n\nInstall: \`npm install ${c.config.npm.name}\`` : `Requires PHP 8.2+, ext-json and ext-curl; framework independent.\n\nInstall: \`composer require ${c.config.composer.name}\``}\n\n## Quickstart\n\nSet \`API_BASE_URL\` to your API environment and replace the sample IDs below with values from your account. ${c.authentication ? 'Set the credential environment variables shown below; the [authentication guide](RUNTIME.md#authentication) lists every mode and required credential key.' : c.auth ? 'Set `API_TOKEN` to your API credential.' : ''} The example scripts read these variables explicitly.\n\n${target === 'node' ? 'Copy an example into an ESM application, or run a packaged script with `node examples/RESOURCE-METHOD.mjs`. TypeScript examples are included alongside the JavaScript files.' : 'Copy an example into your application with its `vendor/autoload.php` path, or run `composer install` in the generated package, then `php examples/RESOURCE-METHOD.php`.'} Examples use a placeholder base URL and one request attempt.\n\n${hasPayloadReturns ? 'Payload-mode calls return the decoded payload directly. Use the corresponding WithResponse method for the complete body and HTTP metadata. Operations configured for result mode retain Result.data and Result.meta. The API reference describes the return mode for each operation.' : "Each call returns a Result: \`data\` is the complete API response body and \`meta\` is HTTP metadata. If the provider also wraps its payload in \`data\`, access it through \`result.data.data\` (PHP: \`$result->data->data\`). The examples show each endpoint's exact response path."}\n\n${readmeExamples(c, target)}## More documentation\n\n- [API reference and all operation examples](REFERENCE.md)\n- [Runtime guide](RUNTIME.md): request options, errors, retries, pagination and webhooks.\n`,
    );
    files.set(
      `${target}/RUNTIME.md`,
      `# ${c.title} runtime guide (${target})\n\nPackage ${c.config.version}; API ${c.apiVersion}.\n\n[Back to the quickstart](README.md) · [API reference](REFERENCE.md)\n\n## Client and request options\n\nConstruct a client with baseUrl and, for legacy authenticated operations, token. Composed clients accept authMode and credentials keyed by mode and scheme; requests can select a mode with request-local credentials. A combined scheme set must be complete. The SDK does not discover credentials or read environment variables; the operation example scripts read API_BASE_URL and their named credential variables explicitly. Pass per-request options as the last method argument: a plain object in Node, or RequestOptions in PHP. Defaults are timeoutMs: 10000 per attempt and deadlineMs: 30000 for the overall duration (not an absolute timestamp). Request values override client defaults. maxAttempts defaults to the operation\'s declared limit, or one when no retries are declared; overrides cannot exceed that limit. Request headers carry tenant context without shared mutable state.\n\n## Authentication\n\n${authenticationGuide(c)}## Responses and errors\n\nThe SDK envelope is Result. Its data is the complete decoded HTTP response body; meta is HTTP metadata. A provider may also wrap its payload in a data field, making result.data.data the provider payload. For example, create may wrap a payment_intent while get returns that entity directly. The operation examples show the exact access path. The SDK preserves these shapes; do not assume all operations share an envelope.\n\nResults expose data, meta and explicit raw response access. JSON raw values are text; PDF data/raw are Uint8Array in Node and binary-safe strings in PHP. SSE data is a closeable iterable carrying event names, IDs, decoded data and rawData. Node metadata uses properties; PHP metadata uses array keys. SdkError exposes kind, outcome, retryAllowed and optional metadata; provider codes use code in Node and errorCode in PHP. outcome is not_sent, response or unknown. Reconcile an unknown mutation outcome with the provider and the original persisted idempotency key before resubmitting.\n\n## Input and response values\n\nOptional properties distinguish omission from null. PHP methods accept associative arrays or presence-aware typed input objects constructed from arrays: omit a key to omit it; include a key with null to clear only where permitted. PHP models expose presence through has()/get() and generated hasField() methods. Use valueOrDefault("field", fallback) for optional values; explicit null stays null. Typed getters unwrap nested values and throw with the field name when a field is omitted. In object/array alternatives, PHP lists (including []) represent JSON arrays; use (object) [] for an empty JSON object.\n\nNumeric enum inputs use exact strings for number/int64/uint64 schemas; membership compares exact values, so equivalent decimal/exponent spellings are accepted. Numeric anyOf branches merge equivalent values exactly and preserve the request token; oneOf still requires exactly one matching branch. Numeric conversions supported only by branches that stop matching fail validation before dispatch. Mutually dependent numeric alternatives use joint matching, limited to 256 combinations per value path; exceeding this limit fails validation.\n\nLarge integers (int64) and decimals use exact strings, including numeric JSON wire values. When the provider enables explicit numeric unions, ambiguous numeric inputs use new ExactNumber("1.2500") and plain strings retain their JSON string meaning. Integer responses accept integral decimal/exponent notation without rounding. Sparse Node input arrays fail before dispatch. Timestamps remain strings. Unknown response fields, enum members, and tagged variants are retained.\n\nPHP response class names include status codes and, for tagged alternatives, branch positions. Adding a status can introduce a new return class even with an identical JSON shape; consult migration notes before upgrading class-based dispatch.\n\nPortable digit/word pattern escapes retain their ASCII ECMAScript meaning in both targets, including inside character classes. Full request encoding checks run locally; server business effects require provider tests.\n\n## Retries and idempotency\n\nRetries count total attempts, include jitter and Retry-After, and never exceed the declared policy. Persist an idempotency key across process restarts and submissions within the server's documented retention/scope. Automatic keys cover one SDK call only. Explicit keys from operation inputs, request headers or idempotencyKey are preserved; conflicting values fail before dispatch. A timeout after dispatch can leave the remote outcome unknown; inspect SdkError.outcome. Disable nested transport/application retries to avoid multiplied attempts. 409/412 are distinct conflicts and never automatically overwritten.\n\n## Timeouts, streaming and cancellation\n\nTimeout is per attempt, including buffered body consumption. For SSE, timeout/deadline bound connection setup; streamIdleTimeoutMs controls idle reads and streamLifetimeMs optionally bounds stream lifetime. Close result.data or the client to release a stream; breaking iteration also closes it. Unknown event names retain raw strings. Reconnect and persist resume cursors explicitly; no yielded event is retried automatically.\n\nDeadline covers attempts and waits; pagination and polling share an overall deadline. Cancellation stops local work, not the remote operation. Node uses AbortSignal. PHP uses a Cancellation token checked during cURL progress and between waits; synchronous calls need an external signal handler to cancel while blocked.\n\n### Pagination and polling\n\nPagination is lazy, supports maxPages/maxItems, and does not guarantee a stable snapshot or durable continuation. Generation rejects incompatible continuation/query representations, including an int64/uint64 continuation with an ordinary integer query parameter. Configured money helpers reject whitespace, including trailing newlines, and excess precision when converting exact major-unit strings to minor units.\n\n## Destinations and API versions\n\nExplicit allowedOrigins govern all destinations, including pagination. HTTPS is required unless allowInsecureHttp is set for local tests. Declared 302/307 responses return Location metadata without following redirects; undeclared redirects are rejected. Authentication is attached only after destination validation. API version headers are pinned when configured; changing them does not update generated types.\n\n## Client lifecycle and transports\n\nClients perform no network I/O at import/construction. Node clients reuse the runtime's fetch connection pool; injected transports remain caller-owned and must honor AbortSignal and disable redirects/retries. PHP owns a reusable cURL handle, released by close()/destruction; a client supports sequential calls within one PHP execution context. Do not concurrently share a PHP client across threads/fibers. Node requests keep headers/context local and support concurrent calls. No SDK telemetry is sent. Requests use the media type selected by the provider profile. Schema validation counts encoded object properties, including explicit nulls, after optional-field omission. Requests identify the selected package name/version and runtime through an overridable User-Agent header.\n\n## Diagnostics and sensitive data\n\nDiagnostics run once per attempted HTTP request, including transport failures, with operation, request ID, status, timing, attempt count and error kind only; hook failures are ignored. Bodies and credentials are excluded. Raw response text/headers and structured error details are privileged explicit access. Binary/stream result inspection omits raw headers and URLs; event inspection omits payloads.\n\nNode Model.toJSON() and PHP model accessors return defensive copies. To change an input, edit the Node toJSON() or PHP toInputArray()/toInputValue() copy and construct a new model; the PHP input exports preserve exact numeric kinds. Model debug printing redacts declared sensitive fields and additional field names supplied in ClientOptions.redactFields; printing arbitrary raw values is application responsibility. Injected transports are privileged and see credentials/bodies.\n\n## Schema helpers\n\n${target === 'node' ? 'The package exports serialize(value, schema), new Model(value, schema), and redact(value, schema) for application-supplied schemas.' : 'The base Model constructor, Codec::normalize and Codec::redact accept application-supplied schemas. Codec::encode writes normalized values as JSON.'} These helpers use the package's local value execution rules and require no generator installation or schema registry service. Generated methods and factories use the codecs included in the package. For a null-only schema, use {"type":"null"}. The legacy form {"type":["null"]} also permits non-null values in Node; PHP rejects them.\n\n## Package upgrades\n\nReview provider release notes before upgrading. Compatibility checks account for public declarations, required response values and PHP class identities. Complex schema changes can still require manual review.\n\n## Webhooks and recovery\n\n${c.config.webhook ? 'Verification uses the configured HMAC-SHA256 signature format, signed headers and original body bytes, with timestamp tolerance and overlapping secrets. Preserve raw request bytes; never verify reserialized JSON. Verification is not durable deduplication. In one database transaction, insert a unique provider event ID and durable work record before acknowledging. Workers should fetch authoritative current state for out-of-order events; commit business side effects idempotently. Unknown event types must not be treated as known success.' : 'This provider has not declared webhook verification.'}\n\n## Custom helpers\n\nCustom helpers belong in custom/; they survive regeneration. Multi-call helpers are not atomic and must expose partial completion. See [reference](REFERENCE.md).\n`,
    );
    files.set(
      `${target}/RUNTIME.md`,
      files.get(`${target}/RUNTIME.md`)! + recoveryReference(c, target),
    );
    files.set(
      `${target}/MODELS.md`,
      modelReference({
        ...c,
        models: Object.fromEntries(Object.keys(models).map((name) => [name, c.models[name]!])),
      }),
    );
    files.set(
      `${target}/REFERENCE.md`,
      `# ${c.title} API reference\n\nPackage ${c.config.version}; API ${c.apiVersion}.\n\n[Models and field descriptions](MODELS.md) · [Runtime guide](RUNTIME.md)\n\nResult.data is the full decoded API response body; Result.meta contains HTTP metadata. Provider data envelopes remain inside Result.data. PHP accepts input arrays or generated input classes.\n\n## Resources\n\n${groups.map((group) => `- [${group}](#resource-${group.toLowerCase()})`).join('\n')}\n\n` +
        [...c.operations]
          .sort((a, b) => a.resource.localeCompare(b.resource) || a.method.localeCompare(b.method))
          .map(
            (op, index, operations) =>
              `${index === 0 || operations[index - 1]!.resource !== op.resource ? `## Resource: ${op.resource}\n\n` : ''}### ${op.resource}.${op.method}\n\n${op.description}\n\n\`${op.verb} ${op.path}\`\n\n${
                positional(op)
                  ? `Call: \`${op.method}(${target === 'php' ? callPlan(op, targetPlan, 'RequestOptions').phpSignature : callPlan(op, targetPlan, 'RequestOptions').nodeSignature})\`\n\nPath arguments: ${
                      pathParameters(op)
                        .map((p, i) => `\`path${i}\` = \`${p.name}\``)
                        .join(', ') || 'none'
                    }. Params contain flat body fields and query/header fields.\n\nCanonical input schema (for configuration examples and HTTP fixtures): `
                  : 'Input: '
              }\`${target === 'php' ? targetPlan.documentation[op.id]!.phpInput : targetPlan.documentation[op.id]!.nodeInput}\`\n\n${payloadReturns[op.id] ? 'Returned payload' : 'Response body (inside Result.data)'}: \`${
                target === 'php'
                  ? (payloadReturns[op.id]?.php ?? targetPlan.documentation[op.id]!.phpOutput)
                  : (payloadReturns[op.id]?.nodeDocumentation ??
                    targetPlan.documentation[op.id]!.nodeOutput)
              }\`\n\n${fieldTable(inputSchema(op), c.definitions ?? c.models)}${operationGuidance(c, op)}${op.idempotency ? `Idempotency header: ${op.idempotency.header}; retention: ${op.idempotency.retention}; scope: ${op.idempotency.scope}.\n\n` : ''}${op.aliases?.length ? `Deprecated aliases: ${op.aliases.join(', ')} (same wire operation).\n\n` : ''}[Example](examples/${op.resource}-${op.method}.${target === 'node' ? 'mjs' : 'php'})\n\n${convenienceReference(c, op, target)}`,
          )
          .join('\n'),
    );
  }
  if (hasPayloadReturns)
    for (const target of targets) {
      const op = c.operations.find((op) => payloadReturns[op.id])!;
      const call =
        target === 'node'
          ? `const response = await client.${op.resource}.${op.method}WithResponse(${publicArguments(op, exampleInput(op, c.definitions ?? {}), 'node')});\nconsole.log(response.body, response.meta.requestId);`
          : `$response = $client->${op.resource}->${op.method}WithResponse(${publicArguments(op, exampleInput(op, c.definitions ?? {}), 'php')});\necho $response->meta['requestId'] ?? '';\n// $response->body is the complete decoded body.`;
      const guide = `## Response return modes\n\nPayload-mode methods return the decoded body, or their explicitly configured payload path, directly. Their WithResponse companions return SdkResponse with body, meta and raw, without unwrapping. Each invocation makes its own request; choose one form per action. Result-mode operations keep their existing data/meta/raw envelope. Pages and Wait helpers always return full Results, and Items helpers yield individual items; pagination and polling paths still address the original body.\n\n\`\`\`${target === 'node' ? 'typescript' : 'php'}\n${call}\n\`\`\`\n\n`;
      files.set(
        `${target}/RUNTIME.md`,
        files
          .get(`${target}/RUNTIME.md`)!
          .replace(
            /The SDK envelope is Result[\s\S]*?The SDK preserves these shapes; do not assume all operations share an envelope\./,
            'Payload-mode methods return the decoded payload directly. Their WithResponse methods expose the full body, meta and raw. Result-mode operations retain the data/meta/raw envelope. See Response return modes below.',
          ) +
          '\n' +
          guide,
      );
      files.set(
        `${target}/REFERENCE.md`,
        files
          .get(`${target}/REFERENCE.md`)!
          .replace(
            'Result.data is the full decoded API response body; Result.meta contains HTTP metadata. Provider data envelopes remain inside Result.data.',
            'Return modes are documented per operation. Payload methods return values directly; WithResponse exposes the full body, metadata and raw response.',
          ),
      );
    }
  for (const target of targets) {
    const guides = Object.entries(c.config.documentation?.guides ?? {});
    for (const [slug, text] of guides)
      files.set(
        `${target}/guides/${slug}.md`,
        `<!-- Package ${c.config.version}; API ${c.apiVersion} -->\n\n${text}\n`,
      );
  }
  return files;
}
const resultStatus = (status: string) => successStatus(status) || status === 'default';

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
    if (
      positional(old) !== positional(current) ||
      (positional(old) &&
        stable(pathParameters(old).map((p) => p.name)) !==
          stable(pathParameters(current).map((p) => p.name)))
    )
      add(
        'breaking',
        old.id + '.request',
        'Public request argument style or positional path order changed; migrate callers before upgrading.',
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
                comparePhp,
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
          addsPhpResultClass(oldPlan.php.operations[old.id]?.output, binding);
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
        for (const key of ['bodyKind', 'classification', 'locationRequired'] as const)
          if (before[key] !== after[key])
            add(
              'review',
              `${old.id}.response.${status}`,
              `${key} response behavior changed; review result handling.`,
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
      'stream',
      'streamEventSchemas',
      'conditional',
      'authenticated',
      'authModes',
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
  for (const key of ['auth', 'authentication', 'authShortcuts', 'apiVersion'] as const)
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
