import { substituteTemplate } from './template.js';
import {
  withGenerationRecovery,
  GenerationRecoveryBusy,
  cleanupOwnedGeneration,
  isGenerationOwner,
  acquireGenerationLock,
  releaseGenerationLock,
} from './generation-cleanup.js';
import { removesPublishedExamples } from './example-protection.js';
import { reservePublicSymbols } from './public-symbols.js';
import {
  formatNodeDeclaration,
  nodeDescriptors,
  scopedNodeClients,
  splitNodeDeclarations,
  compactNodeDeclarations,
  splitPhpClasses,
} from './package-render.js';
import { packagePlan, codecClosure } from './package-plan.js';
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
  closeSync,
} from 'node:fs';
import { basename, dirname, resolve, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { comparePolicies, policyPair, dedupeCompatibility } from './compatibility.js';
import { artifactHashes, prepareSite, verifyRelease, npmPackResult } from './distribution.js';
import { checkVersionPolicy } from './version.js';
import { DiagnosticGroup, pointerSegment } from './diagnostic.js';
import { requireTool } from './tool-checks.js';
import { serialize, executeCodec, ExactNumber, SdkError } from './runtime.js';
import {
  modelReference,
  fieldTable,
  bodyReference,
  referenceType,
  authenticationGuide,
  operationGuidance,
} from './sdk-documentation.js';
import { schemaComment } from './schema-documentation.js';
import {
  inputSchema,
  successStatus,
  sample,
  sampleWithFormats,
  sampleCodecCompiler,
  parameterExample,
  ExactNumberSample,
  compileSdkContract,
  RETRY_DEFAULTS,
  AUTH_SHORTCUT_RESERVED,
  type SampleValidator,
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
type ReleaseBaseline =
  | { kind: 'draft' }
  | { kind: 'released'; interface: Contract; compiled?: CompiledSnapshot };
interface RecordFile {
  baseline?: ReleaseBaseline;
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
  if (before.baseline)
    return before.baseline.kind === 'released' ? before.baseline.compiled : undefined;
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
              ? /^node\/(runtime|codec-plan|runtime-plan|request-options|descriptor-source|package-plan|response|request)\.js$/.test(
                  name,
                )
              : /^php\/src\/(SchemaAdapter|classes\/(?:Runtime|Codec|Model|SdkError|Result|RequestOptions|ClientOptions|AmbientCredentialProvider|Credential|CredentialProvider|EventStream|ServerSentEvent|Cancellation|ByteStream|CurlByteStream|RawNumber|ParsedNumber|ExactNumber|SdkResponse|Errors\/\w+|Internal\/DescriptorSource))\.php$/.test(
                  name,
                ),
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
/** Private records need deterministic keys, without indentation expanding shared graphs. */
const compactRecord = (value: unknown): string =>
  JSON.stringify(value, (_key, child: unknown) =>
    child && typeof child === 'object' && !Array.isArray(child)
      ? Object.fromEntries(Object.entries(child).sort(([a], [b]) => a.localeCompare(b, 'en')))
      : child,
  ) + '\n';

const recordName = '.sdk-generator.json';
function comparisonBase(before: RecordFile, next: Contract): Contract {
  if (before.baseline?.kind === 'released') return before.baseline.interface;
  return before.interface.config.version === next.config.version ||
    before.previousVersion === before.interface.config.version
    ? (before.comparisonBase ?? before.interface)
    : before.interface;
}
// Computed keys retain JSON's own-property semantics in JavaScript literals.
const js = (v: unknown, space = 0) =>
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
  const entries = exampleEntries(
    value,
    depth === 0 ? syntax.fields : undefined,
    depth === 0 ? syntax.omitFields : undefined,
  );
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
    const entries = exampleEntries(
      child,
      depth === 0 ? syntax.fields : undefined,
      depth === 0 ? syntax.omitFields : undefined,
    ).map(
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

function downloadExampleKind(op: Operation): 'binary' | 'redirect' | undefined {
  const responses = Object.values(op.responses).filter(
    (response) => response.classification === 'success' || response.classification === 'redirect',
  );
  if (responses.length && responses.every((response) => response.bodyKind === 'binary'))
    return 'binary';
  if (responses.length && responses.every((response) => response.classification === 'redirect'))
    return 'redirect';
  return undefined;
}

function downloadExampleResult(op: Operation, target: 'node' | 'php', result: string): string {
  const kind = downloadExampleKind(op);
  const payload = op.response?.return === 'payload';
  const data =
    target === 'node'
      ? result + (payload ? (kind === 'redirect' ? '.body' : '') : '.data')
      : '$' + result + (payload ? (kind === 'redirect' ? '->body' : '') : '->data');
  if (kind === 'binary')
    return target === 'node'
      ? `// Choose a destination path; PDF bytes must not be decoded as text.\nconst ${result}Path = process.env.API_DOWNLOAD_PATH ?? "download.pdf";\nawait (await import("node:fs/promises")).writeFile(${result}Path, ${data});\nconsole.log("Saved", ${data}.byteLength, "bytes to", ${result}Path);\n`
      : `// Choose a destination path; PHP strings preserve every PDF byte.\n$${result}Path = getenv('API_DOWNLOAD_PATH') ?: 'download.pdf';\nif (file_put_contents($${result}Path, ${data}) === false) throw new \\RuntimeException('Could not save PDF');\necho 'Saved ' . strlen(${data}) . ' bytes to ' . $${result}Path . PHP_EOL;\n`;
  if (kind === 'redirect')
    return target === 'node'
      ? `// Location may be relative or use another origin. The SDK does not follow it.\n// Validate the destination before a separate download; do not forward API credentials.\nconsole.log(${result}.meta.status, ${data}.location ?? "No Location header");\n`
      : `// Location may be relative or use another origin. The SDK does not follow it.\n// Validate the destination before a separate download; do not forward API credentials.\necho $${result}->meta['status'] . ' ' . (${data}->location ?? 'No Location header') . PHP_EOL;\n`;
  return '';
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
  hasOptions = false,
): string {
  const omitFields = syntax.omitFields;
  const value =
    input && typeof input === 'object' && omitFields?.size
      ? Object.fromEntries(Object.entries(input).filter(([key]) => !omitFields.has(key)))
      : input;
  const args = requestArguments(op, value);
  const last = args.at(-1);
  // Preserve generated fields and explicit empty bodies; retain the params slot for options.
  if (
    !hasOptions &&
    !syntax.fields?.size &&
    positional(op) &&
    hasParams(op) &&
    (last === undefined ||
      (!op.body && last !== null && typeof last === 'object' && !Object.keys(last).length))
  )
    args.pop();
  return args
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
  const required = plan.node.operations[op.id]!.inputRequired;
  const keyRequired = plan.node.operations[op.id]!.idempotencyKeyRequired;
  if (!positional(op))
    return {
      nodeArgs: 'input = {}, options',
      nodeSignature: `input${required || keyRequired ? '' : '?'}: ${prefix}Input${!required && keyRequired ? ' | undefined' : ''}, options${keyRequired ? '' : '?'}: ${optionsType}`,
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
  const key = exampleKey(op, 'node', 'idempotencyKey', false, definitions);
  return `/**\n * ${comment(op.description).replaceAll('\n', '\n * ')}\n * ${op.verb} ${comment(op.path)}\n${deprecated ? ` * @deprecated ${comment(deprecated).replaceAll('\n', '\n * ')}\n` : ''}${key.requiresSuppliedKey ? ' * Set API_IDEMPOTENCY_KEY to a key matching the declared header schema before running this example.\n' : ''} * @example\n${
    key.keySetup
      ? comment(key.keySetup)
          .trimEnd()
          .split('\n')
          .map((line) => ' * ' + line + '\n')
          .join('')
      : ''
  } * client.${op.resource}.${method}(${comment(publicArguments(op, exampleInput(op, definitions), 'node', key, false, Boolean(key.requestOption)))}${key.requestOption ? `${!positional(op) || pathParameters(op).length || hasParams(op) ? ', ' : ''}{ ${key.requestOption} }` : ''})\n */\n`;
}
function phpModel(
  plan: PhpModelPlan,
  recursive: boolean,
  validation: Config['validation'],
): string {
  const expression = `SchemaRegistry::source()->model(${php(plan.name)})`;
  const properties = plan.getters
    .filter((getter) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(getter.field))
    .map((getter) => ` * @property-read ${comment(getter.doc)} $${getter.field}`)
    .join('\n');
  let code = `/**${properties ? '\n' + properties + '\n *' : ''} Presence-aware ${plan.response ? 'response' : 'input'}; ${plan.response ? 'omitted optional fields return null' : 'omitted fields throw when accessed'}. */\nfinal class ${plan.name} extends Model {\n    /** @param ${comment(plan.constructorDoc)} $values */\n    public function __construct(${plan.constructorType} $values${plan.defaultObject ? ' = []' : ''}, array $redactFields = []) { parent::__construct($values, [], ${plan.response ? 'true' : 'false'}, $redactFields, ['constraints' => ${validation === 'schema' ? 'true' : 'false'}] + ${expression}); }\n`;
  for (const getter of plan.getters) {
    if (getter.method)
      code += `    /** @return ${comment(getter.doc)}\n${plan.response ? '' : `     * @throws SdkError When ${comment(getter.field)} is omitted; use has${getter.method.slice(3)}() or valueOrDefault().\n`}     */\n    public function ${getter.method}(): ${getter.type} { return $this->get(${php(getter.field)}); }\n    public function has${getter.method.slice(3)}(): bool { return $this->has(${php(getter.field)}); }\n`;
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
function exampleSchema(
  op: Operation,
  apiVersion?: Contract['config']['apiVersion'],
  authentication?: Pick<Contract, 'auth' | 'authentication'>,
): Schema {
  const schema = inputSchema(op, apiVersion, authentication);
  // Examples have no separate ifMatch option, so retain a required precondition
  // in their canonical input even though public inputs can use request options.
  for (const p of op.parameters)
    if (
      p.required &&
      p.in === 'header' &&
      p.name.toLowerCase() === op.conditional?.header.toLowerCase() &&
      p.name.toLowerCase() !== apiVersion?.header.toLowerCase()
    )
      schema.required!.push(p.name);
  return schema;
}
function configuredExample(
  op: Operation,
  schema: Schema,
  definitions: Record<string, Schema>,
  compile = sampleCodecCompiler(definitions),
): unknown {
  if (op.example !== undefined) return op.example;
  const accepts: SampleValidator = (value, codec) => {
    try {
      executeCodec(materializeSample(value), codec, { mode: 'request', validateConstraints: true });
      return true;
    } catch (error) {
      if (!(error instanceof SdkError)) throw error;
      return false;
    }
  };
  const input = sampleWithFormats(schema, definitions, accepts, compile);
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    for (const parameter of op.parameters) {
      // Omitted optional fields stay omitted. Main's examples, enums and consts
      // retain precedence, even when their value happens to equal a placeholder.
      if (!Object.hasOwn(input, parameter.name)) continue;
      const child = schema.properties?.[parameter.name];
      if (!child) continue;
      let metadata = false;
      sample(child, {}, definitions, [], () => {
        metadata = true;
      });
      if (metadata) continue;
      const selected = parameterExample(parameter, definitions, accepts, compile);
      if (selected) Reflect.set(input, parameter.name, selected.value);
    }
  }
  return materializeSample(input);
}
function exampleInput(op: Operation, definitions: Record<string, Schema> = {}): unknown {
  if (checkedExamples.has(op)) return checkedExamples.get(op);
  try {
    const input = configuredExample(op, exampleSchema(op), definitions);
    serialize(input, { ...inputSchema(op), 'x-sdk-definitions': definitions });
    return input;
  } catch (error) {
    throw new Diagnostic(
      `config/operations/${pointerSegment(op.id)}/example`,
      `provide an input example that satisfies this operation: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
interface ExampleSyntax {
  exactNumber?: string;
  fields?: ReadonlyMap<string, string>;
  omitFields?: ReadonlySet<string>;
}
function exampleEntries(
  value: object,
  fields?: ReadonlyMap<string, string>,
  omitFields?: ReadonlySet<string>,
): [string, unknown][] {
  const entries = Object.entries(value).filter(([key]) => !omitFields?.has(key));
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
  const omitFields = new Set<string>();
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
        ? '(process.env.API_IDEMPOTENCY_KEY ?? "")'
        : "(getenv('API_IDEMPOTENCY_KEY') === false ? '' : getenv('API_IDEMPOTENCY_KEY'))"
      : target === 'node'
        ? 'crypto.randomUUID()'
        : 'bin2hex(random_bytes(16))';
    const expression = inline ? create : target === 'node' ? key : '$' + key;
    if (!inline) {
      keySetup =
        '// Persist this key with the action before sending; reuse it for every resubmission.\n' +
        (target === 'node' ? `const ${key} = ${create};\n` : `$${key} = ${create};\n`);
      if (requiresSuppliedKey)
        keySetup +=
          target === 'node'
            ? `if (!${key}) throw new Error("Set API_IDEMPOTENCY_KEY to a new key matching the header schema, or reuse the key saved with this action");\n`
            : `if ($${key} === '') throw new \\RuntimeException('Set API_IDEMPOTENCY_KEY to a new key matching the header schema, or reuse the key saved with this action');\n`;
      keySetup += '\n';
    }
    if (op.idempotency) {
      for (const p of parameters) omitFields.add(p.name);
      requestOption = `idempotencyKey: ${expression}`;
    } else for (const p of parameters) fields.set(p.name, expression);
  }
  return { fields, omitFields, requestOption, keySetup, requiresSuppliedKey };
}
interface ExampleParts {
  symbols: string[];
  setup: string;
  call: string;
  close: string;
}
/**
 * Choose the credential shown by examples: the configured documentation shortcut when the
 * operation permits its mode, then `token`, then other shortcuts by name, then the first mode.
 */
function exampleAuthentication(c: Contract, op: Operation) {
  const preferred = c.config.documentation?.authShortcut;
  const rank = (name: string) => (name === preferred ? 0 : name === 'token' ? 1 : 2);
  const shortcutEntry = Object.entries(c.authShortcuts ?? {})
    .sort(([a], [b]) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0))
    .find(([, value]) => op.authModes?.includes(value.mode));
  const shortcut = shortcutEntry?.[0];
  const mode = shortcutEntry?.[1].mode ?? op.authModes?.[0];
  return { mode, shortcut };
}

interface ExampleCredential {
  /** Client option, or the scheme key inside a mode's credential map. */
  key: string;
  env: string;
}
/** How an example authenticates: one client option, or a named mode's credential map. */
type ExampleCredentials = { required: boolean } & (
  | { kind: 'option'; value: ExampleCredential }
  | { kind: 'mode'; mode: string; values: ExampleCredential[] }
  | { kind: 'none' }
);
/** Credential environment variables read by an operation example. */
function exampleCredentials(c: Contract, op: Operation): ExampleCredentials {
  const { mode, shortcut } = exampleAuthentication(c, op);
  const authentication = mode ? c.authentication?.[mode] : undefined;
  const required = op.authenticated;
  if (shortcut)
    return {
      required,
      kind: 'option',
      value: {
        key: shortcut,
        env:
          shortcut === 'token'
            ? 'API_TOKEN'
            : shortcut.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase(),
      },
    };
  if (mode && authentication)
    return {
      required,
      kind: 'mode',
      mode,
      values: authentication.schemes.map((scheme) => ({
        key: scheme.name,
        env: ('API_' + mode + '_' + scheme.name).replace(/[^A-Za-z0-9_]/g, '_').toUpperCase(),
      })),
    };
  return op.authenticated
    ? { required, kind: 'option', value: { key: 'token', env: 'API_TOKEN' } }
    : { required, kind: 'none' };
}
const credentialValues = (credentials: ExampleCredentials): ExampleCredential[] =>
  credentials.kind === 'option'
    ? [credentials.value]
    : credentials.kind === 'mode'
      ? credentials.values
      : [];

/** Whether an operation's success responses can carry a decoded body worth printing. */
function hasResponseBody(op: Operation): boolean {
  const responses = Object.entries(op.responses);
  // A default response describes success only when no explicit success status is declared.
  const explicit = responses.some(([status]) => successStatus(status));
  return responses.some(
    ([status, response]) =>
      (successStatus(status) || (status === 'default' && !explicit)) &&
      response.schema !== undefined &&
      (response.bodyKind ?? 'json') !== 'empty',
  );
}

/**
 * Names a credential local must not take in Node or PHP examples: keywords, globals the
 * examples call, and the examples' own variables.
 */
const reservedExampleNames = new Set(
  (
    'abstract and arguments array as await baseUrl break callable case catch class clone const ' +
    'continue crypto debugger declare default delete die do echo else elseif empty enum eval exit ' +
    'export extends false final finally fn for foreach function global goto if implements import ' +
    'in include input instanceof insteadof interface isset let list match namespace new null or ' +
    'package print private protected public readonly require return static super switch this ' +
    'throw trait true try typeof unset use var void while with xor yield process console client ' +
    'result error event item page idempotencyKey undefined'
  ).split(' '),
);

function exampleParts(
  c: Contract,
  op: Operation,
  target: 'node' | 'php',
  options: {
    client?: string;
    result?: string;
    qualifiedPhp?: boolean;
    fields?: ReadonlyMap<string, string>;
    omitFields?: ReadonlySet<string>;
    requestOption?: string;
  } = {},
): ExampleParts {
  const client = options.client ?? 'client';
  const result = options.result ?? 'result';
  const input = exampleInput(op, c.definitions ?? {});
  const credentials = exampleCredentials(c, op);
  const hasStream = Object.values(op.responses).some((response) => response.bodyKind === 'sse');
  const withResponse = op.response?.return === 'payload' && downloadExampleKind(op) === 'redirect';
  const method = op.method + (withResponse ? 'WithResponse' : '');
  const qualify = (symbol: string) =>
    options.qualifiedPhp ? `\\${c.config.composer.namespace}\\${symbol}` : symbol;
  const key = options.fields
    ? {
        fields: options.fields,
        omitFields: options.omitFields,
        requestOption: options.requestOption,
        keySetup: '',
      }
    : exampleKey(op, target, 'idempotencyKey', false, c.definitions ?? {});
  const syntax: ExampleSyntax = {
    exactNumber: target === 'php' ? qualify('ExactNumber') : 'ExactNumber',
    fields: key.fields,
    ...(key.omitFields ? { omitFields: key.omitFields } : {}),
  };
  const symbols = [
    'Client',
    ...(target === 'php' ? ['ClientOptions', 'RequestOptions'] : []),
    ...(hasExactNumber(input) ? ['ExactNumber'] : []),
    ...(hasStream ? ['EventStream'] : []),
  ];
  const requestOptions = key.requestOption ?? '';
  // Local names: the primary client uses plain names; additional README clients prefix theirs.
  const local = (name: string) => {
    const base = name.replace(/[^A-Za-z0-9_]/g, '');
    const plain = /^[A-Za-z_]/.test(base) ? base[0]!.toLowerCase() + base.slice(1) : '_' + base;
    const safe = reservedExampleNames.has(plain) ? plain + 'Credential' : plain;
    return target === 'node' && client !== 'client' ? client + pascal(safe) : safe;
  };
  const baseUrl = target === 'node' && client !== 'client' ? client + 'BaseUrl' : 'baseUrl';
  // Required credentials stop with a clear message; optional ones are sent only when set.
  const credentialSetup = credentialValues(credentials)
    .map(({ key, env }) =>
      target === 'node'
        ? `const ${local(key)} = process.env.${env};\n` +
          (credentials.required
            ? `if (!${local(key)}) throw new Error(${js(`Set ${env}: this call requires a credential`)});\n`
            : '')
        : credentials.required
          ? `$${local(key)} = getenv(${php(env)});\nif ($${local(key)} === false || $${local(key)} === '') throw new \\RuntimeException(${php(`Set ${env}: this call requires a credential`)});\n`
          : `$${local(key)} = getenv(${php(env)}) ?: null;\n`,
    )
    .join('');
  const credentialValue = ({ key }: ExampleCredential) =>
    target === 'node' ? local(key) : '$' + local(key);
  const supplied = credentialValues(credentials)
    .map((value) =>
      target === 'node' ? credentialValue(value) : credentialValue(value) + ' !== null',
    )
    .join(' && ');
  const option = (name: string, value: string) =>
    target === 'node' ? (name === value ? name : `${name}: ${value}`) : `${name}: ${value}`;
  const authOptions =
    credentials.kind === 'mode'
      ? target === 'node'
        ? credentials.required
          ? `authMode: ${js(credentials.mode)},\n  credentials: {\n    [${js(credentials.mode)}]: {\n${credentials.values.map((value) => `      [${js(value.key)}]: ${credentialValue(value)},`).join('\n')}\n    },\n  }`
          : `...(${supplied}\n    ? {\n        authMode: ${js(credentials.mode)},\n        credentials: {\n          [${js(credentials.mode)}]: {\n${credentials.values.map((value) => `            [${js(value.key)}]: ${credentialValue(value)},`).join('\n')}\n          },\n        },\n      }\n    : {})`
        : credentials.required
          ? `authMode: ${php(credentials.mode)},\n  credentials: [\n    ${php(credentials.mode)} => [\n${credentials.values.map((value) => `      ${php(value.key)} => ${credentialValue(value)},`).join('\n')}\n    ],\n  ]`
          : `authMode: ${supplied} ? ${php(credentials.mode)} : null,\n  credentials: ${supplied} ? [\n    ${php(credentials.mode)} => [\n${credentials.values.map((value) => `      ${php(value.key)} => ${credentialValue(value)},`).join('\n')}\n    ],\n  ] : []`
      : credentials.kind === 'option'
        ? target === 'node' && !credentials.required
          ? `...(${supplied} ? { ${option(credentials.value.key, credentialValue(credentials.value))} } : {})`
          : option(credentials.value.key, credentialValue(credentials.value))
        : '';
  const printed =
    (downloadExampleResult(op, target, result) ||
      exampleResult(op, c.definitions ?? {}, target, result)) +
    (op.response?.return === 'payload' && !withResponse
      ? ''
      : target === 'node'
        ? `console.log(${result}.meta.requestId);\n`
        : `echo ($${result}->meta['requestId'] ?? '') . PHP_EOL;\n`);
  // Print a payload with no recognizable ID fields; skip the variable for empty responses.
  const unused = !printed && !hasStream;
  const output =
    printed ||
    (unused && hasResponseBody(op)
      ? target === 'node'
        ? `console.log(${result});\n`
        : `echo json_encode($${result}, JSON_THROW_ON_ERROR) . PHP_EOL;\n`
      : '');
  const assign =
    unused && !output ? '' : target === 'node' ? `const ${result} = ` : `$${result} = `;
  const nodeArgumentSource =
    target === 'node'
      ? publicArguments(op, input, 'node', syntax, true, Boolean(requestOptions)) +
        (requestOptions
          ? `${requestArguments(op, input).length ? ',\n' : ''}  { ${requestOptions} },\n`
          : '\n')
      : '';
  // Calls without arguments stay on one line.
  const nodeArguments = nodeArgumentSource.trim() ? '\n' + nodeArgumentSource : '';
  if (target === 'node') {
    return {
      symbols,
      setup: `const ${baseUrl} = process.env.API_BASE_URL${c.defaultBaseUrl !== undefined ? ` ?? ${js(c.defaultBaseUrl)}` : ''};\n${c.defaultBaseUrl === undefined ? `if (${baseUrl} === undefined) throw new Error("Set API_BASE_URL: this SDK has no default server");\n` : ''}${credentialSetup}const ${client} = new Client({\n  ${option('baseUrl', baseUrl)},\n${authOptions ? '  ' + authOptions + ',\n' : ''}});\n`,
      call:
        key.keySetup +
        `${assign}await ${client}.${op.resource}.${method}(${nodeArguments});\n${output}` +
        (hasStream
          ? `if (${result}${op.response?.return === 'payload' ? '' : '.data'} instanceof EventStream) {\n  for await (const event of ${result}${op.response?.return === 'payload' ? '' : '.data'}) { console.log(event.event, event.id, event.data); break; }\n}\n`
          : ''),
      close: hasStream ? `await ${client}.close();\n` : '',
    };
  }
  return {
    symbols,
    setup: `$baseUrl = getenv('API_BASE_URL');\n${c.defaultBaseUrl !== undefined ? `if ($baseUrl === false) $baseUrl = ${php(c.defaultBaseUrl)};\n` : "if ($baseUrl === false) throw new \\RuntimeException('Set API_BASE_URL: this SDK has no default server');\n"}${credentialSetup}$${client} = new Client(new ClientOptions(\n  baseUrl: $baseUrl,\n${authOptions ? '  ' + authOptions + ',\n' : ''}));\n`,
    call:
      key.keySetup +
      `${positional(op) ? '' : `$input = ${phpExampleSource(input, 0, true, syntax)};\n`}${assign}$${client}->${op.resource}->${method}(${positional(op) ? publicArguments(op, input, 'php', syntax, false, Boolean(requestOptions)) : '$input'}${requestOptions ? `${requestArguments(op, input).length ? ', ' : ''}new RequestOptions(${requestOptions})` : ''});\n${output}` +
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
    ? `import { ${[...new Set(symbols)].join(', ')} } from ${js(c.config.npm.name)};\n`
    : `<?php\ndeclare(strict_types=1);\n${standalone ? `$autoload = __DIR__;\nwhile (!is_file($autoload . '/vendor/autoload.php') && !is_file($autoload . '/autoload.php')) {\n    $parent = dirname($autoload);\n    if ($parent === $autoload) throw new \\RuntimeException('Run composer install in the application before running this example.');\n    $autoload = $parent;\n}\nrequire_once is_file($autoload . '/vendor/autoload.php') ? $autoload . '/vendor/autoload.php' : $autoload . '/autoload.php';` : "require __DIR__ . '/vendor/autoload.php';"}\nuse ${c.config.composer.namespace}\\{${[...new Set(symbols)].join(', ')}};\n`;
}

function downloadGuide(c: Contract, target: 'node' | 'php'): string {
  const operations = (['binary', 'redirect'] as const)
    .map((kind) => c.operations.find((op) => downloadExampleKind(op) === kind))
    .filter((op): op is Operation => op !== undefined);
  if (!operations.length) return '';
  return (
    '## PDF downloads and declared redirects\n\nPDF results are buffered bytes. Set API_DOWNLOAD_PATH to choose the file written by the PDF example. Redirect results expose HTTP metadata and the optional Location without following it. Each recipe makes one SDK call.\n\n' +
    operations
      .map((op) => {
        const parts = exampleParts(c, op, target);
        return `### ${op.resource}.${op.method}\n\n\`\`\`${target === 'node' ? 'typescript' : 'php'}\n${exampleImports(c, target, parts.symbols, false)}${parts.setup}${parts.call}${parts.close}\`\`\`\n\n`;
      })
      .join('')
  );
}

/** Select the README quickstart and up to two recipes, preferring configured examples. */
function readmeOperations(c: Contract): Operation[] {
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
  return selected;
}

/** Keep the landing page useful without embedding hundreds of operation scripts. */
function readmeExamples(
  c: Contract,
  target: 'node' | 'php',
  selected: readonly Operation[],
): { quickstart: string; recipes: string } {
  const extension = target === 'node' ? 'mjs' : 'php';
  const fence = target === 'node' ? 'typescript' : 'php';
  const first = selected[0];
  const firstMode = first ? exampleAuthentication(c, first).mode : undefined;
  const blocks = selected.map((op, index) => {
    const path = `examples/${op.resource}-${op.method}.${extension}`;
    const modeChanged =
      exampleAuthentication(c, op).mode !== firstMode || op.authenticated !== first?.authenticated;
    const client = index > 0 && modeChanged ? op.resource + pascal(op.method) + 'Client' : 'client';
    const result =
      target === 'node' && index > 0 ? op.resource + pascal(op.method) + 'Result' : 'result';
    const key = index === 0 ? 'idempotencyKey' : op.resource + pascal(op.method) + 'IdempotencyKey';
    const { fields, omitFields, requestOption, keySetup } = exampleKey(
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
      omitFields,
      requestOption,
      qualifiedPhp: index > 0,
    });
    let call = keySetup + parts.call;
    if (index === 0) {
      const symbols =
        target === 'node'
          ? selected.flatMap((operation) => exampleParts(c, operation, target).symbols)
          : parts.symbols;
      const setup = exampleImports(c, target, [...symbols, 'SdkError'], false) + parts.setup;
      const catchBody =
        target === 'node'
          ? `} catch (error) {\n  if (!(error instanceof SdkError)) throw error;\n  console.error(error.message, error.status, error.kind, error.code, error.meta?.requestId);\n  if (error.outcome === "unknown") {\n    // Reconcile with the API before resubmitting this action.\n    console.error("The request may have succeeded; check its current state.");\n  }\n  throw error;\n}\n`
          : `} catch (SdkError $error) {\n  error_log($error->getMessage() . ' status=' . ($error->status ?? 'none') . ' code=' . ($error->errorCode ?? '') . ' request=' . ($error->meta['requestId'] ?? 'unknown'));\n  if ($error->outcome === 'unknown') {\n    // Reconcile with the API before resubmitting this action.\n    error_log('The request may have succeeded; check its current state.');\n  }\n  throw $error;\n}\n`;
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
    const code = `\`\`\`${fence}\n${call}\`\`\`\n\n[Run the standalone example](${path})\n`;
    return index === 0
      ? code
      : `### ${op.resource}.${op.method}\n\n${op.description ? op.description + '\n\n' : ''}${code}`;
  });
  return {
    quickstart: blocks[0] ?? '',
    recipes: blocks.length > 1 ? '## More examples\n\n' + blocks.slice(1).join('\n') : '',
  };
}

const markdownList = (items: readonly string[]) =>
  items.length < 2
    ? items.join('')
    : items.slice(0, -1).join(', ') + (items.length > 2 ? ',' : '') + ' and ' + items.at(-1);

function errorClassExample(c: Contract, target: 'node' | 'php'): string {
  return target === 'node'
    ? `import { errors } from '${c.config.npm.name}';
async function handleSdkRequest(request) {
  try {
    return await request(); // Pass a function that calls a resource method.
  } catch (error) {
    if (error instanceof errors.NotFoundError) console.error(error.message);
    else throw error;
  }
}`
    : `use ${c.config.composer.namespace}\\Errors\\NotFoundError;
/** @param callable(): mixed $request */
function handleSdkRequest(callable $request): void {
    try {
        $request(); // Pass a closure that calls a resource method.
    } catch (NotFoundError $error) {
        error_log($error->getMessage());
    }
}`;
}

/** Render the package landing page: install, quickstart, then declared capabilities. */
function packageReadme(
  c: Contract,
  target: 'node' | 'php',
  returns: { payload: number; total: number },
  standaloneWebhook: boolean,
): string {
  const node = target === 'node';
  const selected = readmeOperations(c);
  const { quickstart, recipes } = readmeExamples(c, target, selected);
  const api = /\bAPI$/i.test(c.title) ? c.title : c.title + ' API';
  const description =
    c.config.documentation?.overview ??
    `${node ? 'TypeScript and JavaScript' : 'PHP'} client for the ${api}.`;
  const install = node
    ? `\`\`\`sh\nnpm install ${c.config.npm.name}\n\`\`\`\n\nRequires Node.js 22.3+, or Node.js 22.12+ to \`require()\` from CommonJS. TypeScript projects need TypeScript 5.9+ with NodeNext module resolution and \`npm install --save-dev @types/node@22\` (22.16.0+).`
    : `\`\`\`sh\ncomposer require ${c.config.composer.name}\n\`\`\`\n\nRequires PHP 8.2+ with ext-json and ext-curl. PHPDoc types target PHPStan 2.2+.`;
  const environment = [
    ...new Set(
      selected.flatMap((op) => credentialValues(exampleCredentials(c, op)).map((v) => v.env)),
    ),
  ].map((env) => '`' + env + '`');
  const errorSnippet = errorClassExample(c, target);
  const authLink = c.authentication ? ' ([authentication](RUNTIME.md#authentication))' : '';
  const setup =
    c.defaultBaseUrl === undefined
      ? `Set ${markdownList(['`API_BASE_URL`', ...environment])}${authLink}, then replace the sample values with your own.`
      : `${environment.length ? `Set ${markdownList(environment)}${authLink}, then replace` : 'Replace'} the sample values with your own. Set \`API_BASE_URL\` to use another environment.`;
  const resultData = node ? 'result.data' : '$result->data';
  const resultMeta = node ? 'result.meta' : '$result->meta';
  const returnMode =
    returns.payload === returns.total
      ? ''
      : returns.payload === 0
        ? `Calls return a Result: \`${resultData}\` is the response body and \`${resultMeta}\` is HTTP metadata.`
        : `Methods return the decoded body, except result-mode operations, which return \`${resultData}\` and \`${resultMeta}\`; the [API reference](REFERENCE.md) lists each operation's mode.`;
  const streaming = c.operations.some((op) =>
    Object.values(op.responses).some((response) => response.bodyKind === 'sse'),
  );
  const close = node
    ? streaming
      ? 'Call `await client.close()` when finished to release open streams.'
      : ''
    : 'Call `$client->close()` when finished to release the cURL handle.';
  const declaredRetries = c.operations.filter((op) => op.retry !== undefined).length;
  const defaultRetries =
    'GET, HEAD and OPTIONS calls make up to three attempts and other methods send once';
  const retries =
    declaredRetries === 0
      ? `Without a declared retry policy, ${defaultRetries}.`
      : declaredRetries === c.operations.length
        ? 'Each operation retries according to its declared policy; the [API reference](REFERENCE.md) lists its attempt limit.'
        : `Operations with a declared retry policy follow it, as listed in the [API reference](REFERENCE.md); otherwise ${defaultRetries}.`;
  const paginated = c.operations.find((op) => op.pagination);
  const pagination = paginated
    ? `## Pagination\n\nList operations such as \`${paginated.resource}.${paginated.method}\` also have \`${paginated.method}Items\` and \`${paginated.method}Pages\` methods that fetch pages lazily. See [pagination](RUNTIME.md#pagination-and-polling).\n\n`
    : '';
  const webhooks = c.config.webhook
    ? `## Webhooks\n\nVerify each delivery with \`${node ? 'client.verifyWebhook(rawBody, headers, secrets)' : '$client->verifyWebhook($rawBody, $headers, $secrets)'}\` on the original request bytes, never re-encoded JSON. ${standaloneWebhook ? `Standalone ${node ? '`verifyWebhook`' : '`Webhooks::verify`'} needs no client configuration.` : 'The Webhooks name belongs to an API model; use the client method for verification.'} See [verifyWebhook examples and errors](RUNTIME.md#webhooks-and-recovery).\n\n`
    : '';
  const guides = Object.keys(c.config.documentation?.guides ?? {}).map(
    (slug) => `- [${slug}](guides/${slug}.md)\n`,
  );
  return (
    `# ${c.title} SDK\n\n${description}\n\n## Install\n\n${install}\n\n## Quickstart\n\n${setup}\n\n${quickstart}\n` +
    (returnMode || close ? [returnMode, close].filter(Boolean).join(' ') + '\n\n' : '') +
    recipes +
    (recipes ? '\n' : '') +
    `## Errors and retries\n\nFailed calls throw \`SdkError\` with \`${node ? 'message' : 'getMessage()'}\`, \`kind\`, \`status\`, \`${node ? 'code' : 'errorCode'}\` and the request ID in \`meta\`. An \`outcome\` of \`unknown\` means the request may have succeeded, so check the current state before resubmitting. ${retries} See [errors](RUNTIME.md#responses-and-errors) and [retries](RUNTIME.md#retries-and-idempotency).\n\nCheck an error's class to handle a specific failure; every class extends \`SdkError\`:\n\n\`\`\`${node ? 'js' : 'php'}\n${errorSnippet}\n\`\`\`\n\n` +
    pagination +
    webhooks +
    `## Documentation\n\n- [API reference](REFERENCE.md): every operation, with examples\n- [Models](MODELS.md): fields and descriptions\n- [Runtime guide](RUNTIME.md): request options, errors, retries${c.config.webhook ? ', pagination and webhooks' : ' and pagination'}\n${guides.join('')}- \`examples/\`: a runnable script per operation. ${node ? 'Run `node examples/RESOURCE-METHOD.mjs`; examples are checked with TypeScript checkJs.' : 'Run `composer install`, then `php examples/RESOURCE-METHOD.php`.'}\n\nPackage ${c.config.version}, generated for API ${c.apiVersion}.\n`
  );
}

/** Render one call on an existing `client` with request options, plus any key setup it needs. */
function operationCall(c: Contract, op: Operation, target: 'node' | 'php') {
  const input = exampleInput(op, c.definitions ?? {});
  const key = exampleKey(op, target, 'idempotencyKey', false, c.definitions ?? {});
  const source = publicArguments(op, input, target, key, false, true);
  const call = (method: string, options: string) =>
    target === 'node'
      ? `client.${op.resource}.${method}(${source}${source ? ', ' : ''}{ ${[key.requestOption, options].filter(Boolean).join(', ')} })`
      : `$client->${op.resource}->${method}(${source}${source ? ', ' : ''}new RequestOptions(${[key.requestOption, options].filter(Boolean).join(', ')}))`;
  return { keySetup: key.keySetup, call };
}

function convenienceReference(c: Contract, op: Operation, target: 'node' | 'php'): string {
  const parts = exampleParts(c, op, target);
  const { keySetup, call } = operationCall(c, op, target);
  const setup = parts.setup + keySetup;
  const examples: string[] = [];
  const payload = op.response?.return === 'payload';
  const access = (variable: string, path: string[]) =>
    target === 'node'
      ? variable + path.map((key) => `[${js(key)}]`).join('')
      : '$' + variable + path.map((key) => '->{' + phpExampleString(key) + '}').join('');
  if (op.pagination) {
    for (const suffix of ['Items', 'Pages', ...(payload ? ['PagesWithResponse'] : [])]) {
      const value = suffix === 'Items' ? 'item' : 'page';
      const invocation = call(
        op.method + suffix,
        'maxPages: 10, maxItems: 1000, deadlineMs: 60000',
      );
      const originalPath = op.pagination.items.split('.');
      const payloadPath = op.response?.payloadPath?.split('.') ?? [];
      const relativePath = payloadPath.every((key, index) => originalPath[index] === key)
        ? originalPath.slice(payloadPath.length)
        : [];
      const pageValue = access(
        value,
        suffix === 'Items'
          ? []
          : suffix === 'PagesWithResponse'
            ? ['body', ...originalPath]
            : payload
              ? relativePath
              : ['data', ...originalPath],
      );
      const loop =
        target === 'node'
          ? `for await (const ${value} of ${invocation}) {\n  console.log(${pageValue});\n${suffix === 'PagesWithResponse' ? '  console.log(page.meta.requestId);\n' : ''}}\n`
          : `foreach (${invocation} as $${value}) {\n  // Process ${pageValue} before requesting the next page.\n${suffix === 'PagesWithResponse' ? "  echo $page->meta['requestId'] ?? '';\n" : ''}}\n`;
      examples.push(
        `#### ${op.resource}.${op.method}${suffix}\n\n${suffix === 'Items' ? 'Iterate individual values across pages.' : suffix === 'PagesWithResponse' ? 'Iterate complete page bodies with HTTP metadata and raw access.' : payload ? 'Iterate page payloads, using the same return shape as the base method.' : 'Iterate page Results, including HTTP metadata.'} Iteration is lazy; each page request has its own deadline, excluding time spent processing yielded values.\n\n\`\`\`${target === 'node' ? 'typescript' : 'php'}\n${exampleImports(c, target, parts.symbols, false)}${setup}${loop}${parts.close}\`\`\`\n\n`,
      );
    }
  }
  if (op.polling) {
    const invocation = call(op.method + 'Wait', 'deadlineMs: 60000');
    const output = payload ? exampleResult(op, c.definitions ?? {}, target) : '';
    examples.push(
      `#### ${op.resource}.${op.method}Wait\n\nWait for ${op.polling.state}: success ${op.polling.success.join(', ')}; failure ${op.polling.failure.join(', ')}. ${payload ? 'Returns the same payload as the base method. ' : ''}Unknown states keep waiting until the deadline. Cancellation stops waiting, not the remote job.\n\n\`\`\`${target === 'node' ? 'typescript' : 'php'}\n${exampleImports(c, target, parts.symbols, false)}${setup}${target === 'node' ? `const result = await ${invocation};\n${payload ? output || 'console.log(result);\n' : 'console.log(result.meta.requestId);\n'}` : `$result = ${invocation};\n${payload ? output || '// $result is the completed payload.\n' : "echo $result->meta['requestId'] ?? '';\n"}`}${parts.close}\`\`\`\n\n`,
    );
    if (payload) {
      const full = call(op.method + 'WaitWithResponse', 'deadlineMs: 60000');
      examples.push(
        `#### ${op.resource}.${op.method}WaitWithResponse\n\nWait using the same terminal states, then return the complete body, HTTP metadata and raw response.\n\n\`\`\`${target === 'node' ? 'typescript' : 'php'}\n${exampleImports(c, target, parts.symbols, false)}${setup}${target === 'node' ? `const response = await ${full};\nconsole.log(response.body, response.meta.requestId);\n` : `$response = ${full};\necho $response->meta['requestId'] ?? '';\n// $response->body is the complete decoded body.\n`}${parts.close}\`\`\`\n\n`,
      );
    }
  }
  return examples.join('');
}
function recoveryReference(c: Contract, target: 'node' | 'php'): string {
  const op = c.operations.find((op) => op.idempotency);
  if (!op) return '';
  const key = exampleKey(op, target, 'idempotencyKey', false, c.definitions ?? {});
  const parts = exampleParts(c, op, target, {
    fields: key.fields,
    omitFields: key.omitFields,
    requestOption: [key.requestOption, 'maxAttempts: 1'].filter(Boolean).join(', '),
  });
  const setup =
    target === 'node'
      ? `const idempotencyKey = process.env.API_IDEMPOTENCY_KEY;\nif (!idempotencyKey) throw new Error("Set API_IDEMPOTENCY_KEY to the key saved with this action");\n`
      : `$idempotencyKey = getenv('API_IDEMPOTENCY_KEY');\nif (!$idempotencyKey) throw new \\RuntimeException('Set API_IDEMPOTENCY_KEY to the key saved with this action');\n`;
  return `\n## Resume an action with its saved key\n\nUse this only after reconciling the previous outcome and confirming the provider permits resubmission. Read the key and the original input from your saved action; keep both unchanged. The environment variable below stands in for your application's durable action record. Do not generate a new key when retrying that action. This example makes one request attempt.\n\n\`\`\`${target === 'node' ? 'typescript' : 'php'}\n${exampleImports(c, target, parts.symbols, false)}${parts.setup}${setup}${parts.call}${parts.close}\`\`\`\n`;
}

export function render(c: Contract): Map<string, string> {
  return renderCompiled(compileSdkContract(c));
}
function checkCompilation(compilation: ReturnType<typeof compileSdkContract>): void {
  const c = compilation.source;
  if (c.exampleProtection === undefined)
    throw new Diagnostic(
      'exampleProtection',
      'reload the source inputs with loadContract before rendering or generating an SDK',
    );
  const targetPlan = compilation.plan;
  const compileSample = sampleCodecCompiler(c.definitions ?? {});
  for (const op of c.operations) {
    const model = targetPlan.php.models.find(
      (model) => model.name === pascal(op.resource) + pascal(op.method) + 'Input',
    );
    if (!model) throw new Error('Missing input codec for ' + op.id);
    try {
      const schema = exampleSchema(op, c.config.apiVersion, c);
      const configured = configuredExample(op, schema, c.definitions ?? {}, compileSample);
      const omitted = new Set(
        op.parameters
          .filter((p) => !Object.hasOwn(schema.properties ?? {}, p.name))
          .map((p) => p.name),
      );
      const input =
        configured && typeof configured === 'object' && !Array.isArray(configured)
          ? Object.fromEntries(Object.entries(configured).filter(([name]) => !omitted.has(name)))
          : configured;
      for (const key of schema.required ?? [])
        if (!input || typeof input !== 'object' || !Object.hasOwn(input, key))
          throw new Error(`required example input ${key} is missing`);
      executeCodec(input, model.codec, {
        mode: 'request',
        definitions: targetPlan.runtime.definitions ?? {},
      });
      checkedExamples.set(op, input);
    } catch (error) {
      throw new Diagnostic(
        `config/operations/${pointerSegment(op.id)}/example`,
        `provide an input example that satisfies this operation: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  reservePublicSymbols(
    c,
    Object.keys(targetPlan.node.models),
    new Set(
      c.operations.filter((op) => targetPlan.documentation[op.id]!.reserveKnown).map((op) => op.id),
    ),
  );
}

/** Diagnose compilation and runnable inputs without allocating rendered package files. */
export function diagnoseContract(contract: Contract): void {
  checkCompilation(compileSdkContract(contract));
}

function renderCompiled(compilation: ReturnType<typeof compileSdkContract>): Map<string, string> {
  checkCompilation(compilation);
  const c = compilation.source;
  const targetPlan = compilation.plan;
  const files = new Map<string, string>();
  const targets = c.config.targets ?? ['node', 'php'];
  const groups = [...new Set(c.operations.map((o) => o.resource))].sort();
  const models = targetPlan.node.models;
  const payloadReturns = targetPlan.responseReturns ?? {};
  const hasPayloadReturns = Object.keys(payloadReturns).length > 0;
  const reserve = reservePublicSymbols(
    c,
    Object.keys(models),
    new Set(
      c.operations.filter((op) => targetPlan.documentation[op.id]!.reserveKnown).map((op) => op.id),
    ),
  );
  const webhookTypes = new Set(Object.values(targetPlan.node.eventTypes ?? {}));
  const compiledRuntime = targetPlan.runtime;
  const definitions = c.definitions ?? {};
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
          homepage: c.config.npm.homepage,
          repository: c.config.npm.repository
            ? {
                type: c.config.npm.repository.type,
                url: c.config.npm.repository.url,
                directory: c.config.npm.repository.directory,
              }
            : undefined,
          type: 'module',
          sideEffects: ['./custom/**'],
          main: './index.js',
          types: './index.d.ts',
          exports: {
            '.': { types: './index.d.ts', import: './index.js', default: './index.js' },
            ...(c.config.webhook
              ? {
                  './webhooks': {
                    types: './webhooks.d.ts',
                    import: './webhooks.js',
                    default: './webhooks.js',
                  },
                }
              : {}),
            './custom/*': './custom/*',
            './resources/*': {
              types: './resources/*.d.ts',
              import: './resources/*.js',
              default: './resources/*.js',
            },
          },
          engines: { node: '>=22.3' },
          peerDependencies: { '@types/node': '>=22.16.0' },
          peerDependenciesMeta: { '@types/node': { optional: true } },
          publishConfig: {
            registry: c.config.npm.registry ?? 'https://registry.npmjs.org',
            access: c.config.npm.access ?? 'public',
          },
          license: c.config.license ?? 'Apache-2.0',
          files: [
            '*.js',
            '*.d.ts',
            'resources/',
            'descriptors/',
            'declarations/',
            'models/',
            'predicates/',
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
    let runtimeDeclarations = readFileSync(join(here, 'runtime.d.ts'), 'utf8');
    if (targetPlan.node.errorTypes) {
      const { code, details } = targetPlan.node.errorTypes;
      const qualify = (type: string) =>
        type.replace(
          /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[A-Za-z_$][\w$]*/g,
          (token) =>
            Object.hasOwn(models, token) ? `import('./declarations/${token}.js').${token}` : token,
        );
      // Specialize only the SDK error class; transport cause codes keep their own declaration.
      const start = runtimeDeclarations.indexOf('export declare class SdkError ');
      const end = runtimeDeclarations.indexOf('\ndeclare const BaseSdkError', start);
      runtimeDeclarations =
        runtimeDeclarations.slice(0, start) +
        runtimeDeclarations
          .slice(start, end)
          .replaceAll('code?: string', 'code?: SdkErrorCode')
          .replaceAll('details?: unknown', 'details?: SdkErrorDetails')
          .replaceAll('\n        code: string', '\n        code: SdkErrorCode')
          .replaceAll('        details: unknown', '        details: SdkErrorDetails | undefined') +
        runtimeDeclarations.slice(end) +
        `\nexport type SdkErrorCode = (${qualify(code)}) & string;\nexport type SdkErrorDetails = ${qualify(details)} | RuntimeErrorDetails;\n`;
    }
    put('runtime.d.ts', runtimeDeclarations);
    for (const name of [
      'descriptor-source.js',
      'descriptor-source.d.ts',
      'package-plan.js',
      'codec-plan.js',
      'codec-plan.d.ts',
      'php-value-plan.js',
      'php-value-plan.d.ts',
      'runtime-plan.js',
      'runtime-plan.d.ts',
      'request-options.js',
      'request-options.d.ts',
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
    const descriptorOutput = nodeDescriptors(
      {
        ...compiledRuntime,
        userAgent: `${c.config.npm.name.replace(/^@/, '').replaceAll('/', '-')}/${c.config.version} (Node.js)`,
      },
      put,
    );
    let code = `import { runtimeFromPlan, modelFromCodec, isKnownCodec${c.config.webhook ? ', verifyWebhookFromPlan' : ''} } from './runtime.js';\nexport { SdkError, errors, Model${extraValues}, serialize, parseExact, redact } from './runtime.js';\n${descriptorOutput.source(groups, './', true)}\nexport class Client {\n  #runtime;\n  constructor(options = {}) {\n    this.#runtime = runtimeFromPlan(_sdkDescriptors, options);\n`;
    const defaultCredentials = compiledRuntime.defaultCredentials;
    if (defaultCredentials) {
      code =
        `import { configuredDefaultCredentials, configuredWorkloadIdentityCredentials } from './runtime.js';\nexport function defaultCredentials() { return configuredDefaultCredentials(${js(defaultCredentials)}, ${js(c.defaultBaseUrl ?? null)} ?? undefined); }\nexport function workloadIdentityCredentials(options) { return configuredWorkloadIdentityCredentials(${js(defaultCredentials)}, options, ${js(c.defaultBaseUrl ?? null)} ?? undefined); }\n` +
        code;
    }
    if (c.operations.some(positional)) {
      put('request.js', readFileSync(join(here, '../templates/request.mjs'), 'utf8'));
      code = "import { requestInput as _sdkRequestInput } from './request.js';\n" + code;
    }
    let declarations = `import type { ${c.authentication ? 'ClientOptions as RuntimeClientOptions, RequestOptions as RuntimeRequestOptions' : 'ClientOptions as RuntimeClientOptions, RequestOptions'}, Result, InputValue, CredentialProvider${defaultCredentials ? ', WorkloadIdentityOptions' : ''}${c.config.webhook ? ', WebhookHeaders as _SdkWebhookHeaders' : ''} } from './runtime.js';\nimport { Model${extraValues} } from './runtime.js';\nexport { SdkError, errors, Model${extraValues}, serialize, parseExact, redact } from './runtime.js';\nexport type { ${c.authentication ? '' : 'RequestOptions, '}Result, Metadata, ErrorKind, DiagnosticEvent, InputValue, CredentialProvider${streamTypes ? ', ServerSentEvent' : ''} } from './runtime.js';\n`;
    if (targetPlan.node.errorTypes)
      declarations += "export type { SdkErrorCode, SdkErrorDetails } from './runtime.js';\n";
    if (defaultCredentials)
      declarations += `export type { WorkloadIdentityOptions, WorkloadIdentitySource } from './runtime.js';\nexport declare function defaultCredentials(): CredentialProvider;\nexport declare function workloadIdentityCredentials(options: WorkloadIdentityOptions): CredentialProvider;\n`;
    if (c.operations.some((op) => !op.idempotency))
      declarations +=
        "type _SdkWithoutIdempotency<T> = T extends unknown ? Omit<T, 'idempotencyKey'> & { idempotencyKey?: never } : never;\n";
    if (c.operations.some((op) => targetPlan.node.operations[op.id]?.idempotencyKeyRequired))
      declarations +=
        "type _SdkRequiredIdempotency<T> = T extends unknown ? Omit<T, 'idempotencyKey'> & { idempotencyKey: string } : never;\n";
    declarations += targetPlan.node.eventDeclarations ?? '';
    declarations += targetPlan.node.clientOptions?.declaration ?? '';
    if (targetPlan.node.authentication) declarations += targetPlan.node.authentication.declarations;
    if (hasPayloadReturns) {
      put('response.js', readFileSync(join(here, '../templates/response.mjs'), 'utf8'));
      code =
        "import { responsePayload as _sdkPayload, sdkResponse as _sdkResponse, payloadPages as _sdkPayloadPages, sdkResponsePages as _sdkResponsePages } from './response.js';\n" +
        code;
      declarations += targetPlan.node.responseReturnDeclarations!;
    }

    for (const [name, model] of Object.entries(models)) {
      if (!model.outputAlias)
        declarations += `${schemaComment(c.models[name]!)}export type ${name} = ${model.documentedOutput ?? model.output};\n`;
      if (model.inputReachable === false) continue;
      declarations += `${schemaComment(c.models[name]!)}export type ${name}Input = ${model.documentedInput ?? model.input};\n`;
      // Preserve the validated object branch when a model also permits
      // nonobjects, so its factory can nest inside an object-constrained field.
      if (model.objectFactory) {
        const object = `Exclude<${name}Input & object, readonly unknown[]>`;
        declarations += `export declare function make${name}(value: InputValue<${object}>): Model<${object}>;\n`;
      }
      declarations += `export declare function make${name}(value: InputValue<${name}Input>): Model<${name}Input>;\n`;
    }
    const responseType = (op: Operation): string =>
      targetPlan.node.operations[op.id]!.responseType!;
    for (const op of c.operations) {
      declarations += `export type ${pascal(op.resource)}${pascal(op.method)}Input = ${targetPlan.node.operations[op.id]!.documentedInput ?? targetPlan.node.operations[op.id]!.input};\n`;
      if (responseType(op) !== targetPlan.node.operations[op.id]!.output)
        declarations += `export type ${responseType(op)} = ${targetPlan.node.operations[op.id]!.output};\n`;
    }
    declarations += `export declare class Client {\n  constructor(options${targetPlan.node.clientOptions?.optional ? '?' : ''}: ClientOptions);\n`;
    for (const group of groups) {
      code += `    this.${group} = Object.freeze({\n`;
      declarations += `  readonly ${group}: {\n`;
      for (const op of c.operations.filter((o) => o.resource === group)) {
        const prefix = pascal(op.resource) + pascal(op.method);
        const required = targetPlan.node.operations[op.id]!.inputRequired;
        const requestOptionsType =
          targetPlan.node.operations[op.id]!.requestOptions ?? 'RequestOptions';
        const payload = payloadReturns[op.id];
        const decodePayload = payload?.validate
          ? `, (result, path) => this.#runtime.decodePayload(${js(op.id)}, result, path)`
          : '';
        const call = callPlan(op, targetPlan, requestOptionsType);
        for (const method of [op.method, ...(op.aliases ?? [])]) {
          const request = `this.#runtime.request(${js(op.id)}, ${call.nodeInput}, options)`;
          code += `      ${method}: ${positional(op) ? 'async ' : ''}(${call.nodeArgs}) => ${request}${payload ? `.then(result => _sdkPayload(result, ${js(payload.path)}${decodePayload}))` : ''},\n`;
          declarations += `    ${methodDoc(op, method, definitions)}    ${method}(${call.nodeSignature}): Promise<${payload ? payload.node : `Result<${responseType(op)}>`}>;\n`;
          if (payload) {
            code += `      ${method}WithResponse: ${positional(op) ? 'async ' : ''}(${call.nodeArgs}) => ${request}.then(_sdkResponse),\n`;
            declarations += `    /** Complete decoded body and HTTP metadata, without payload unwrapping. */\n    ${method}WithResponse(${call.nodeSignature}): Promise<SdkResponse<${responseType(op)}>>;\n`;
          }
        }
        if (op.pagination)
          for (const [suffix, runtime, returnType] of [
            [
              'Pages',
              'pages',
              payload?.helperReturn === 'payload' ? payload.node : `Result<${responseType(op)}>`,
            ],
            ['Items', 'items', targetPlan.node.operations[op.id]!.items],
          ]) {
            const request = `this.#runtime.${runtime}(${js(op.id)}, ${call.nodeInput}, options)`;
            code += `      ${op.method}${suffix}: (${call.nodeArgs}) => ${suffix === 'Pages' && payload?.helperReturn === 'payload' ? `_sdkPayloadPages(${request}, ${js(payload.path)}${decodePayload})` : request},\n`;
            declarations += `    ${op.method}${suffix}(${call.nodeSignature}): AsyncGenerator<${returnType}>;\n`;
            if (suffix === 'Pages' && payload?.helperReturn === 'payload') {
              code += `      ${op.method}PagesWithResponse: (${call.nodeArgs}) => _sdkResponsePages(${request}),\n`;
              declarations += `    ${op.method}PagesWithResponse(${call.nodeSignature}): AsyncGenerator<SdkResponse<${responseType(op)}>>;\n`;
            }
          }
        if (op.polling) {
          const request = `this.#runtime.wait(${js(op.id)}, ${call.nodeInput}, options)`;
          code += `      ${op.method}Wait: (${call.nodeArgs}) => ${request}${payload?.helperReturn === 'payload' ? `.then(result => _sdkPayload(result, ${js(payload.path)}${decodePayload}))` : ''},\n`;
          declarations += `    ${op.method}Wait(${payload?.helperReturn === 'payload' || positional(op) ? call.nodeSignature : `input: ${prefix}Input, options?: ${requestOptionsType}`}): Promise<${payload?.helperReturn === 'payload' ? payload.node : `Result<${responseType(op)}>`}>;\n`;
          if (payload?.helperReturn === 'payload') {
            code += `      ${op.method}WaitWithResponse: (${call.nodeArgs}) => ${request}.then(_sdkResponse),\n`;
            declarations += `    ${op.method}WaitWithResponse(${call.nodeSignature}): Promise<SdkResponse<${responseType(op)}>>;\n`;
          }
        }
      }
      code += '    });\n';
      declarations += '  };\n';
    }
    code +=
      "  }\n  [Symbol.for('nodejs.util.inspect.custom')]() { return { resources: Object.keys(this).length }; }\n";
    if (streamTypes) {
      code += '  close() { return this.#runtime.close(); }\n';
      declarations += '  close(): Promise<void>;\n';
    }
    if (c.config.webhook) {
      code += '  verifyWebhook(...args) { return this.#runtime.verifyWebhook(...args); }\n';
      declarations +=
        '  verifyWebhook(rawBody: Uint8Array | ArrayBuffer, headers: _SdkWebhookHeaders, secrets: string | readonly string[], nowSeconds?: number): VerifiedWebhook;\n';
    }
    if (c.config.money) {
      code += '  money(...args) { return this.#runtime.money(...args); }\n';
      declarations +=
        '  money(currency: string, major: string): { currency: string; amount: `${bigint}` };\n';
    }
    code += '}\n';
    declarations += '}\n';
    if (c.config.webhook) {
      code +=
        'export function verifyWebhook(rawBody, headers, secrets, nowSeconds) { return verifyWebhookFromPlan(_sdkDescriptors, rawBody, headers, secrets, nowSeconds); }\n';
      declarations +=
        'export declare function verifyWebhook(rawBody: Uint8Array | ArrayBuffer, headers: _SdkWebhookHeaders, secrets: string | readonly string[], nowSeconds?: number): VerifiedWebhook;\n';
    }
    for (const op of c.operations) {
      const known = targetPlan.node.operations[op.id]!.known;
      if (!known) continue;
      const prefix = pascal(op.resource) + pascal(op.method) + 'Response';
      declarations += `export type ${prefix}Known = ${known.type};\nexport declare function is${prefix}Known(value: ${responseType(op)}): value is ${prefix}Known;\n`;
      const knownCode = descriptorOutput.codec(prefix, { ...known.codecs[0]!, some: known.codecs });
      put(
        `predicates/${prefix}.js`,
        knownCode +
          `import { isKnownCodec } from '../runtime.js';\nexport function is${prefix}Known(value) { const prepared = codec(); return prepared.some.some(item => isKnownCodec(value, {...item, definitions: prepared.definitions})); }\n`,
      );
      code += `export function is${prefix}Known(value) { const prepared = _sdkModelCodec(${js(prefix)}); return prepared.some.some(codec => isKnownCodec(value, {...codec, definitions: prepared.definitions})); }\n`;
    }
    for (const [name, model] of Object.entries(targetPlan.node.models)) {
      if (model.inputReachable === false) continue;
      put(
        `models/${name}.js`,
        descriptorOutput.codec(name, model.codec, model.sharedCodec) +
          `import { modelFromCodec } from '../runtime.js';\nexport function make${name}(value) { return modelFromCodec(value, {...codec(), constraints: ${js(c.config.validation === 'schema')}}); }\n`,
      );
      code += `export function make${name}(value) { return modelFromCodec(value, {..._sdkModelCodec(${js(name)}), constraints: ${js(c.config.validation === 'schema')}}); }\n`;
    }
    if (c.config.webhook)
      put(
        'examples/webhook-inbox.mjs',
        readFileSync(join(here, '../templates/webhook-inbox.mjs'), 'utf8').replace(
          "'../runtime.js'",
          js(c.config.npm.name + '/webhooks'),
        ),
      );
    if (c.config.webhook) {
      put(
        'webhooks.js',
        `import { verifyWebhookFromPlan } from './runtime.js';\nexport { parseExact } from './runtime.js';\n${descriptorOutput.source([], './', true, false)}\nexport function verifyWebhook(rawBody, headers, secrets, nowSeconds) { return verifyWebhookFromPlan(_sdkDescriptors, rawBody, headers, secrets, nowSeconds); }\n`,
      );
      put(
        'webhooks.d.ts',
        `export { parseExact } from './runtime.js';\nexport { verifyWebhook } from './declarations/verifyWebhook.js';\n${['KnownWebhookEvent', 'VerifiedWebhook', ...webhookTypes].map((name) => `export type { ${name} } from './declarations/${name}.js';`).join('\n')}\n`,
      );
    }
    descriptorOutput.finish();
    put('index.js', code);
    const selectiveTypes = splitNodeDeclarations(
      declarations,
      groups,
      put,
      new Set(
        Object.entries(models)
          .filter(([, model]) => !model.outputAlias)
          .map(([name]) => name),
      ),
      new Map(
        Object.entries(models)
          .filter(([, model]) => !model.outputAlias)
          .map(([name, model]) => [name, model.codec]),
      ),
      new Set(c.config.webhook ? [...webhookTypes, 'KnownWebhookEvent', 'VerifiedWebhook'] : []),
    );
    const scopedClient = scopedNodeClients(code);
    for (const group of groups) {
      const header = code
        .slice(0, code.indexOf(descriptorOutput.source(groups, './', true)))
        .replaceAll("'./", "'../");
      const selected = selectiveTypes.get(group) ?? new Set<string>();
      const factories = Object.keys(models).filter(
        (name) =>
          (selected.has(name) || selected.has(name + 'Input')) &&
          models[name]!.inputReachable !== false,
      );
      const predicates = c.operations
        .filter((op) => op.resource === group && targetPlan.node.operations[op.id]!.known)
        .map((op) => pascal(op.resource) + pascal(op.method) + 'Response');
      put(
        `resources/${group}.js`,
        header +
          descriptorOutput.source([group], '../', false) +
          scopedClient(group) +
          factories
            .map((name) => `export { make${name} } from '../models/${name}.js';\n`)
            .join('') +
          predicates
            .map((name) => `export { is${name}Known } from '../predicates/${name}.js';\n`)
            .join(''),
      );
      const path = 'node/resources/' + group + '.d.ts';
      files.set(
        path,
        files.get(path)! +
          [...(selectiveTypes.get(group) ?? [])]
            .map((name) => `export type { ${name} } from '../declarations/${name}.js';\n`)
            .join('') +
          factories
            .map((name) => `export { make${name} } from '../declarations/make${name}.js';\n`)
            .join('') +
          predicates
            .map((name) => `export { is${name}Known } from '../declarations/is${name}Known.js';\n`)
            .join(''),
      );
    }
    compactNodeDeclarations(files, 'node/');
    put(
      'descriptors/modules.json',
      JSON.stringify(
        [...files.keys()]
          .filter((path) => /^node\/(?:resources|models|predicates)\/.*\.js$/.test(path))
          .map((path) => path.slice('node/'.length))
          .sort(),
      ),
    );
    put('LICENSE', license);
    for (const op of c.operations) {
      const parts = exampleParts(c, op, 'node');
      const example =
        exampleImports(c, 'node', parts.symbols, true) + parts.setup + parts.call + parts.close;
      put(`examples/${op.resource}-${op.method}.mjs`, example);
    }
  }
  if (targets.includes('php')) {
    const put = (p: string, value: string) => files.set('php/' + p, value);
    const ns = c.config.composer.namespace;
    const phpContract = {
      ...targetPlan.php.runtime,
      userAgent: `${c.config.composer.name.replaceAll('/', '-')}/${c.config.version} (PHP)`,
    };
    const eventModels = targetPlan.php.eventModels;
    const webhookDoc = (secretType: string) =>
      `    /** @param string $rawBody Original request bytes.\n     * @param array<string, string|list<string>> $headers Header map, including PSR-7 header arrays.\n     * @param ${secretType} $secrets\n     * @param int|null $nowSeconds\n     * @return array{known: true, event: ${Object.values(eventModels).join('|') || 'mixed'}|\\stdClass|array}|array{known: false, event: mixed, reason: 'unknown_event'|'unmatched_envelope'} */\n`;
    // Each PHP event class reuses its reserved Node identity once. Other
    // response classes with that name must still produce a collision.
    const reservedEventModels = new Set(Object.values(eventModels));
    for (const model of targetPlan.php.models.filter((model) => model.response))
      if (!Object.hasOwn(models, model.name) && !reservedEventModels.delete(model.name))
        reserve(model.name);
    put(
      'composer.json',
      stable({
        name: c.config.composer.name,
        description: `${c.title} server SDK`,
        version: c.config.version,
        type: 'library',
        license: c.config.license ?? 'Apache-2.0',
        require: { php: '>=8.2', 'ext-json': '*', 'ext-curl': '*' },
        autoload: {
          'psr-4': { [ns + '\\']: 'src/classes/' },
          classmap: ['src/SchemaAdapter.php', 'custom/'],
          ...(phpContract.defaultCredentials ? { files: ['src/credentials.php'] } : {}),
        },
        archive: { exclude: ['/vendor', '/composer.lock', '/.git', '/*.zip'] },
      }),
    );
    if (phpContract.defaultCredentials)
      put(
        'src/credentials.php',
        `<?php\ndeclare(strict_types=1);\nnamespace ${ns};\nfunction defaultCredentials(): CredentialProvider { return new AmbientCredentialProvider(${'json_decode(' + php(JSON.stringify(phpContract.defaultCredentials)) + ', true)'}, null, ${c.defaultBaseUrl === undefined ? 'null' : php(c.defaultBaseUrl)}); }\n/** @param array{workloadIdentityId: string, source?: 'auto'|'none'|'token'|'token_file', audience?: string, scope?: string} $options */\nfunction workloadIdentityCredentials(array $options): CredentialProvider { return new AmbientCredentialProvider(${'json_decode(' + php(JSON.stringify(phpContract.defaultCredentials)) + ', true)'}, $options, ${c.defaultBaseUrl === undefined ? 'null' : php(c.defaultBaseUrl)}); }\n`,
      );
    put('custom/.gitkeep', '');
    put(
      'src/SchemaAdapter.php',
      substituteTemplate(
        readFileSync(join(here, '../templates/SchemaAdapter.php'), 'utf8').replaceAll(
          'SdkNamespace',
          ns,
        ),
        'src/SchemaAdapter.php',
        [
          ["/* RETRY_DEFAULTS */ '{}'", php(JSON.stringify(RETRY_DEFAULTS))],
          [
            "/* REQUEST_OPTION_PLANS */ '{}'",
            php(JSON.stringify(targetPlan.requestOptionPlans ?? {})),
          ],
        ],
      ),
    );
    put(
      'src/Runtime.php',
      substituteTemplate(
        readFileSync(join(here, '../templates/Runtime.php'), 'utf8').replaceAll('SdkNamespace', ns),
        'src/Runtime.php',
        [
          [
            "/* REQUEST_OPTION_PLANS */ '{}'",
            php(JSON.stringify(targetPlan.requestOptionPlans ?? {})),
          ],
          [
            '/* REQUEST_OPTION_FORWARD */',
            Object.values(targetPlan.requestOptionPlans ?? {})
              .map((option) => `$this->${option.php},`)
              .join('\n            '),
          ],
          [
            '        public readonly bool $ambientCredentials = true,\n        public readonly ?object $credentialCache = null,\n',
            '',
          ],
          [
            '    ) {\n        /* AUTH_SHORTCUT_REQUEST_PARAMETERS */\n    }',
            Object.keys(c.authShortcuts ?? {})
              .sort()
              .map(
                (key) =>
                  `        public readonly string|CredentialProvider|\\Closure|null $${key} = null,\n`,
              )
              .join('') +
              Object.values(targetPlan.requestOptionPlans ?? {})
                .map((option) => `        public readonly ?string $${option.php} = null,\n`)
                .join('') +
              '    ) {}',
          ],
          [
            '    ) {\n        /* AUTH_SHORTCUT_CLIENT_PARAMETERS */\n    }',
            Object.keys(c.authShortcuts ?? {})
              .filter((key) => key !== 'token')
              .sort()
              .map(
                (key) =>
                  `        public readonly string|CredentialProvider|\\Closure|null $${key} = null,\n`,
              )
              .join('') +
              '        public readonly bool $ambientCredentials = true,\n        public readonly ?object $credentialCache = null,\n    ) {}',
          ],
          [
            '/* AUTH_SHORTCUT_RESERVED */ []',
            `[${[...AUTH_SHORTCUT_RESERVED].map(php).join(', ')}]`,
          ],
          [
            '/* AUTH_SHORTCUT_FORWARD */',
            Object.keys(c.authShortcuts ?? {})
              .sort()
              .map((key) => `$this->${key},`)
              .join('\n            '),
          ],
        ],
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
    const resourceProperties = groups
      .map((group) => ` * @property-read ${pascal(group)}Resource $${group}`)
      .join('\n');
    let code = `<?php\ndeclare(strict_types=1);\nnamespace ${ns};\n${hasPayloadReturns ? "require_once __DIR__ . '/SdkResponse.php';\n" : ''}\n/**\n${resourceProperties}\n */\nfinal class Client {\n    private Runtime $runtime;\n    private array $resourceCache = [];\n`;
    code += `    public function __construct(ClientOptions $options${c.defaultBaseUrl !== undefined ? ' = new ClientOptions()' : ''}) {\n        $this->runtime = new Runtime(SchemaRegistry::source(), $options, true);\n    }\n`;
    code += '    public function __get(string $name): mixed {\n        return match ($name) {\n';
    for (const group of groups)
      code += `            ${php(group)} => $this->resourceCache[${php(group)}] ??= new ${pascal(group)}Resource($this->runtime),\n`;
    code +=
      "            default => throw SdkError::create('validation', 'Unknown client property ' . $name),\n        };\n    }\n";
    code +=
      "    public function __set(string $name, mixed $value): void { throw SdkError::create('validation', 'Client resource properties are read-only'); }\n";
    code += `    public function __isset(string $name): bool { return in_array($name, [${groups.map(php).join(', ')}], true); }\n`;
    code += '    public function close(): void { $this->runtime->close(); }\n';
    if (c.config.webhook)
      // Runtime and Webhooks delegate to the same verifier; Runtime retains client redaction.
      code += `${webhookDoc('string|array<array-key, string>')}    public function verifyWebhook(mixed $rawBody, mixed $headers, mixed $secrets, mixed $nowSeconds = null): array { return $this->runtime->verifyWebhook($rawBody, $headers, $secrets, $nowSeconds); }\n`;
    if (c.config.money)
      code +=
        '    public function money(string $currency, string $major): array { return $this->runtime->money($currency, $major); }\n';
    code += '}\n';
    if (targetPlan.php.standaloneWebhook)
      code += `final class Webhooks {\n${webhookDoc('string|list<string>')}    public static function verify(mixed $rawBody, mixed $headers, mixed $secrets, mixed $nowSeconds = null): array { return Runtime::verifyWebhookFromPlan(SchemaRegistry::source(), $rawBody, $headers, $secrets, $nowSeconds); }\n}\n`;
    for (const group of groups) {
      code += `final class ${pascal(group)}Resource {\n    public function __construct(private readonly Runtime $runtime) {}\n`;
      for (const op of c.operations.filter((o) => o.resource === group)) {
        const inputName = pascal(op.resource) + pascal(op.method) + 'Input';
        const inputDefault = inputSchema(op, c.config.apiVersion, c).required!.length
          ? ''
          : ' = []';
        const normalizeInput = positional(op)
          ? `(new ${inputName}($input))->toInputArray()`
          : `$input instanceof ${inputName} ? $input->toInputArray() : (new ${inputName}($input))->toInputArray()`;
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
          ]) {
            const request = `$this->runtime->${runtime}(${php(op.id)}, ${normalizeInput}, $options)`;
            code += `    /** @return \\Generator<int, ${
              suffix === 'Pages'
                ? payload?.helperReturn === 'payload'
                  ? payload.php
                  : `Result<${responseType}>`
                : targetPlan.php.operations[op.id]!.items
            }> */\n    public function ${op.method}${suffix}(${call.phpSignature}): \\Generator { ${call.phpPrelude}return ${suffix === 'Pages' && payload?.helperReturn === 'payload' ? `SdkResponse::payloadPages(${request}, [${payload.path.map(php).join(', ')}])` : request}; }\n`;
            if (suffix === 'Pages' && payload?.helperReturn === 'payload')
              code += `    /** @return \\Generator<int, SdkResponse<${responseType}>> */\n    public function ${op.method}PagesWithResponse(${call.phpSignature}): \\Generator { ${call.phpPrelude}return SdkResponse::responsePages(${request}); }\n`;
          }
        if (op.polling) {
          const request = `$this->runtime->wait(${php(op.id)}, ${normalizeInput}, $options)`;
          code += `    /** @return ${payload?.helperReturn === 'payload' ? payload.php : `Result<${responseType}>`} */\n    public function ${op.method}Wait(${call.phpSignature}): ${payload?.helperReturn === 'payload' ? payload.phpNative : 'Result'} { ${call.phpPrelude}return ${payload?.helperReturn === 'payload' ? `SdkResponse::payload(${request}, [${payload.path.map(php).join(', ')}])` : request}; }\n`;
          if (payload?.helperReturn === 'payload')
            code += `    /** @return SdkResponse<${responseType}> */\n    public function ${op.method}WaitWithResponse(${call.phpSignature}): SdkResponse { ${call.phpPrelude}$result = ${request}; return new SdkResponse($result->data, $result->meta, $result->raw); }\n`;
        }
      }
      code += '}\n';
    }
    code += `final class SchemaRegistry {
      private static ?array $contract = null;
      private static ?Internal\\DescriptorSource $source = null;
      public static function source(): Internal\\DescriptorSource { return self::$source ??= new Internal\\DescriptorSource(dirname(__DIR__) . '/descriptors', ${phpContract.webhook ? 'true' : 'false'}); }
      public static function contract(): array { return self::$contract ??= self::source()->contract(); }
      public static function codecs(): array { return self::contract()['definitions'] ?? []; }
    }\n`;
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
    const phpPlan = packagePlan(phpContract);
    put('src/descriptors/settings.json', JSON.stringify(phpPlan.settings));
    put('src/descriptors/compatibility.json', JSON.stringify(phpPlan.compatibility));
    put(
      'src/descriptors/routes.json',
      JSON.stringify(Object.fromEntries(phpContract.operations.map((op) => [op.id, op.resource]))),
    );
    for (const [name, group] of Object.entries(phpPlan.resources))
      put(`src/descriptors/resources/${encodeURIComponent(name)}.json`, JSON.stringify(group));
    for (const [name, codec] of Object.entries(phpPlan.definitions))
      put(`src/descriptors/codecs/${hash(name)}.json`, JSON.stringify(codec));
    if (phpPlan.webhook) put('src/descriptors/webhook.json', JSON.stringify(phpPlan.webhook));
    put(
      'src/descriptors/models.json',
      JSON.stringify(targetPlan.php.models.map((model) => model.name)),
    );
    for (const model of targetPlan.php.models)
      put(
        `src/descriptors/models/${encodeURIComponent(model.name)}.json`,
        JSON.stringify({
          ...(model.sharedCodec ? { shared: model.sharedCodec } : { codec: model.codec }),
          ...(model.representation ? { phpRepresentation: model.representation } : {}),
          dependencies: [
            ...new Set([
              ...(model.sharedCodec
                ? [
                    model.sharedCodec,
                    ...codecClosure(phpPlan.definitions[model.sharedCodec], phpPlan.definitions),
                  ]
                : []),
              ...codecClosure(model.codec, phpPlan.definitions),
            ]),
          ].sort(),
        }),
      );
    const phpClasses = new Map([
      ...splitPhpClasses(files.get('php/src/Runtime.php')!),
      ...splitPhpClasses(code),
    ]);
    if (!phpContract.defaultCredentials) phpClasses.delete('AmbientCredentialProvider');
    if (hasPayloadReturns) {
      for (const [name, value] of splitPhpClasses(files.get('php/src/SdkResponse.php')!))
        phpClasses.set(name, value);
      files.delete('php/src/SdkResponse.php');
    }
    const classmap: Record<string, string> = {};
    for (const [name, value] of phpClasses) {
      put(
        `src/classes/${name}.php`,
        `<?php\ndeclare(strict_types=1);\nnamespace ${ns};\n${value}\n`,
      );
      classmap[ns + '\\' + name] = 'classes/' + name + '.php';
    }
    for (const name of [
      'ConnectionError',
      'TimeoutError',
      'AuthenticationError',
      'ValidationError',
      'RateLimitError',
      'NotFoundError',
      'ConflictError',
      'ServerError',
      'ApiError',
      'ProtocolError',
      'CancelledError',
      'DeadlineError',
      'DestinationError',
    ]) {
      put(
        `src/classes/Errors/${name}.php`,
        `<?php\ndeclare(strict_types=1);\nnamespace ${ns}\\Errors;\nfinal class ${name} extends \\${ns}\\SdkError {}\n`,
      );
      classmap[ns + '\\Errors\\' + name] = 'classes/Errors/' + name + '.php';
    }
    classmap[ns + '\\Internal\\SchemaAdapter'] = 'SchemaAdapter.php';
    classmap[ns + '\\Internal\\DescriptorSource'] = 'classes/Internal/DescriptorSource.php';
    put(
      'src/classes/Internal/DescriptorSource.php',
      readFileSync(join(here, '../templates/DescriptorSource.php'), 'utf8').replaceAll(
        'SdkNamespace',
        ns,
      ),
    );
    put(
      'src/autoload.php',
      `<?php\ndeclare(strict_types=1);\n// Compatibility for consumers that include the historical source entry points.\n$classes = ${
        '[' +
        Object.entries(classmap)
          .map(([name, path]) => php(name.toLowerCase()) + ' => ' + php(path))
          .join(',') +
        ']'
      };\nspl_autoload_register(static function (string $name) use ($classes): void { $path = $classes[strtolower($name)] ?? null; if ($path !== null) require_once __DIR__ . '/' . $path; });\n${phpContract.defaultCredentials ? "require_once __DIR__ . '/credentials.php';\n" : ''}`,
    );
    for (const name of ['Runtime', 'Client', ...(hasPayloadReturns ? ['SdkResponse'] : [])])
      put(
        `src/${name}.php`,
        `<?php\ndeclare(strict_types=1);\nnamespace ${ns};\nrequire_once __DIR__ . '/autoload.php';\n`,
      );
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
    files.set(
      `${target}/README.md`,
      packageReadme(
        c,
        target,
        { payload: Object.keys(payloadReturns).length, total: c.operations.length },
        targetPlan[target].standaloneWebhook === true,
      ),
    );
    files.set(
      `${target}/RUNTIME.md`,
      runtimeGuide(c, target, targetPlan[target].standaloneWebhook === true),
    );
    files.set(
      `${target}/RUNTIME.md`,
      files
        .get(`${target}/RUNTIME.md`)!
        .replace(
          '## Pagination and polling\n',
          () =>
            recoveryReference(c, target).replace(/^\n/, '').replace(/\n$/, '\n\n') +
            '## Pagination and polling\n',
        ),
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
      `# ${/\bAPI$/i.test(c.title.trim()) ? c.title + ' reference' : c.title + ' API reference'}\n\nPackage ${c.config.version}; API ${c.apiVersion}.\n\n[Models and field descriptions](MODELS.md) · [Runtime guide](RUNTIME.md)\n\nResult.data is the full decoded API response body; Result.meta contains HTTP metadata. Provider data envelopes remain inside Result.data. PHP accepts input arrays or generated input classes.\n\n${c.config.webhook ? webhookReference(target) : ''}## Resources\n\n${groups.map((group) => `- [${group}](#resource-${group.toLowerCase()})`).join('\n')}\n\n` +
        [...c.operations]
          .sort((a, b) => a.resource.localeCompare(b.resource) || a.method.localeCompare(b.method))
          .map(
            (op, index, operations) =>
              `${index === 0 || operations[index - 1]!.resource !== op.resource ? `## Resource: ${op.resource}\n\n` : ''}### ${op.resource}.${op.method}\n\n${op.description ? op.description + '\n\n' : ''}\`${op.verb} ${op.path}\`\n\n${
                positional(op)
                  ? `Call: \`${op.method}(${target === 'php' ? callPlan(op, targetPlan, 'RequestOptions').phpSignature : callPlan(op, targetPlan, 'RequestOptions').nodeSignature})\`\n\nPath arguments: ${
                      pathParameters(op)
                        .map((p, i) => `\`path${i}\` = \`${p.name}\``)
                        .join(', ') || 'none'
                    }. Params contain flat body fields and query/header fields.\n\n`
                  : ''
              }${referenceType(positional(op) ? 'Canonical input schema (for configuration examples and HTTP fixtures)' : 'Input', target === 'php' ? targetPlan.documentation[op.id]!.phpInput : targetPlan.documentation[op.id]!.nodeInput, target)}${referenceType(payloadReturns[op.id] ? 'Returned payload' : 'Response body (inside Result.data)', target === 'php' ? (payloadReturns[op.id]?.php ?? targetPlan.documentation[op.id]!.phpOutput) : (payloadReturns[op.id]?.nodeDocumentation ?? targetPlan.documentation[op.id]!.nodeOutput), target)}${fieldTable(inputSchema(op, c.config.apiVersion, c), c.definitions ?? c.models, `${op.resource}.${op.method} input`)}${bodyReference(op, c.definitions ?? c.models)}${operationGuidance(c, op)}${op.idempotency ? `Idempotency header: ${op.idempotency.header}; retention: ${op.idempotency.retention.replace(/[.!?]+$/, '')}; scope: ${op.idempotency.scope.replace(/[.!?]+$/, '')}.\n\n` : ''}${op.aliases?.length ? `Deprecated aliases: ${op.aliases.join(', ')} (same wire operation).\n\n` : ''}[Example](examples/${op.resource}-${op.method}.${target === 'node' ? 'mjs' : 'php'})\n\n${convenienceReference(c, op, target)}`,
          )
          .join('\n'),
    );
  }
  if (hasPayloadReturns)
    for (const target of targets) {
      const op = c.operations.find((op) => payloadReturns[op.id])!;
      const key = exampleKey(op, target, 'idempotencyKey', false, c.definitions ?? {});
      const source = publicArguments(
        op,
        exampleInput(op, c.definitions ?? {}),
        target,
        key,
        false,
        Boolean(key.requestOption),
      );
      const args =
        source +
        (key.requestOption
          ? `${source ? ', ' : ''}${target === 'node' ? `{ ${key.requestOption} }` : `new RequestOptions(${key.requestOption})`}`
          : '');
      const call =
        key.keySetup +
        (target === 'node'
          ? `const response = await client.${op.resource}.${op.method}WithResponse(${args});\nconsole.log(response.body, response.meta.requestId);`
          : `$response = $client->${op.resource}->${op.method}WithResponse(${args});\necho $response->meta['requestId'] ?? '';\n// $response->body is the complete decoded body.`);
      const guide = `### Response return modes\n\nPayload-mode methods return the decoded body, or their explicitly configured payload path, directly. Their WithResponse companions return SdkResponse with body, meta and raw, without unwrapping. Each invocation makes its own request; choose one form per action. Result-mode operations keep their existing data/meta/raw envelope. Pages and Wait follow the base method return mode: payload values in payload mode, full Results in result mode. Payload-mode PagesWithResponse and WaitWithResponse expose complete bodies, metadata and raw access. Items helpers yield individual items; pagination and polling paths still address the original body.\n\n\`\`\`${target === 'node' ? 'typescript' : 'php'}\n${call}\n\`\`\`\n\n`;
      files.set(
        `${target}/RUNTIME.md`,
        files
          .get(`${target}/RUNTIME.md`)!
          .replace('### Errors\n\n', () => guide + '### Errors\n\n'),
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
  const nodeDataIdentity = hash(
    stable([...files].filter(([path]) => path.startsWith('node/descriptors/'))),
  );
  for (const [path, content] of files)
    if (path.startsWith('node/') && path.endsWith('.js')) {
      files.set(
        path,
        content.replace(
          /(from\s*['"])(\.\.?\/[^'"]+\.js)(['"])/g,
          (match, before: string, specifier: string, after: string) =>
            (path.startsWith('node/descriptors/') && !specifier.includes('descriptor-source')) ||
            specifier.includes('/descriptors/')
              ? `${before}${specifier}?sdk=${nodeDataIdentity}${after}`
              : match,
        ),
      );
    }
  for (const [path, value] of files)
    if (path.startsWith('node/') && path.endsWith('.d.ts'))
      files.set(path, formatNodeDeclaration(value));
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
  if (removesPublishedExamples(before, after))
    changes.push({
      severity: 'review',
      subject: 'published schema examples',
      message:
        'Protected schema example/default annotations were removed from published documentation and package metadata; review sample inputs before release.',
    });
  const compareNode = oldPlan.targets.includes('node') && newPlan.targets.includes('node');
  const comparePhp =
    (before.config.targets ?? ['node', 'php']).includes('php') &&
    (after.config.targets ?? ['node', 'php']).includes('php');
  const add = (severity: Compatibility['severity'], subject: string, message: string) =>
    changes.push({ severity, subject, message });
  const oldModels = oldPlan.policy.models,
    newModels = newPlan.policy.models;
  const responseOnly = new Set(
    (oldPlan.policy.responseOnlyModels ?? []).filter((name) =>
      newPlan.policy.responseOnlyModels?.includes(name),
    ),
  );
  const shared = new Map<string, string>();
  for (const [name, previous] of Object.entries(oldModels)) {
    const next = newModels[name];
    if (next)
      for (const direction of ['input', 'response'] as const) {
        const key = policyPair(previous[direction], next[direction], direction);
        if (!shared.has(key)) shared.set(key, `models.${name}.${direction}`);
      }
  }
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
            {
              responseOnly: responseOnly.has(name),
              shared,
            },
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
            { responseOnly: responseOnly.has(name), shared },
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
        { shared },
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
            ...comparePolicies(previousBody, nextBody, `${old.id}.response.${status}`, 'response', {
              shared,
            }),
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
  if (before.defaultBaseUrl !== after.defaultBaseUrl)
    add(
      before.defaultBaseUrl === undefined ? 'additive' : 'breaking',
      'defaultBaseUrl',
      'Default API destination changed; review clients that omit baseUrl in both targets.',
    );
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
  if (previousPlan && nextPlan) {
    // Group declaration reviews without discarding saved historical uncertainty.
    const owners = new Map<string, string>();
    for (const [name, previous] of Object.entries(oldModels))
      if (newModels[name] && stable(previous) !== stable(newModels[name])) {
        owners.set(`models.${name}`, `models.${name}`);
        owners.set(`models.${name}Input`, `models.${name}`);
      }
    for (const [id, operation] of Object.entries(oldPlan.policy.operations)) {
      const roots = new Set<string>();
      for (const [status, previous] of Object.entries(operation.responses)) {
        const next = newPlan.policy.operations[id]?.responses[status];
        if (!next || stable(previous) === stable(next)) continue;
        const owner = shared.get(policyPair(previous, next, 'response'));
        if (!owner) continue;
        const root = owner.replace(/\.response$/, '');
        roots.add(root);
        const binding = oldPlan.php.runtime.operations.find((op) => op.id === id)?.responses[
          status
        ];
        if (binding?.model) owners.set(`models.${binding.model}`, root);
      }
      const [root] = roots;
      if (roots.size === 1 && root) owners.set(id, root);
    }
    changes.push(...compareCompiledContracts(previousPlan, nextPlan, owners));
  }
  return dedupeCompatibility(changes);
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
  return previewOutput(contract, output);
}
function previewOutput(
  contract: Contract,
  output: string,
  prepared?: { files: Map<string, string>; compiled: CompiledSnapshot },
) {
  output = resolve(output);
  safeTree(output);
  const recordPath = join(output, recordName);
  const before: RecordFile | undefined = existsSync(recordPath)
    ? readGenerationRecord(recordPath).record
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
    if (before?.baseline) {
      if (before.baseline.kind === 'released') {
        if (!before.baseline.interface?.config)
          throw new Error('Missing released baseline interface');
        if (before.baseline.compiled)
          before.baseline.compiled = restoreCompiledSnapshot(before.baseline.compiled);
      } else if (before.baseline.kind !== 'draft') throw new Error('Unsupported release baseline');
    }
    if (before?.recordVersion === 2 && !before.compiled)
      throw new Error('Missing compiled contract in generation record');
  } catch (error) {
    throw new Diagnostic(recordPath, error instanceof Error ? error.message : String(error));
  }
  if (before && contract.config.responses?.return === undefined) {
    const previous = new Map(before.interface.operations.map((op) => [op.id, op]));
    for (const op of contract.operations)
      if (
        previous.has(op.id) &&
        previous.get(op.id)!.response?.return !== 'payload' &&
        op.response?.return === 'payload' &&
        contract.config.operations?.[op.id]?.response?.return === undefined
      )
        throw new Diagnostic(
          'config/responses/return',
          'Existing SDK uses Result returns. Set responses.return: result to preserve them, or explicitly select payload to migrate.',
        );
  }
  if (!prepared) {
    const compilation = compileSdkContract(contract);
    const files = renderCompiled(compilation);
    prepared = {
      files,
      compiled: {
        plan: compilation.plan,
        runtimeIdentity: runtimeIdentity(files, compilation.plan.targets),
      },
    };
  }
  const { files, compiled } = prepared;
  const previousCompiled = before ? compiledBase(before, contract) : undefined;
  const changes: Change[] = [];
  const edited: Diagnostic[] = [];
  for (const [path, previousHash] of Object.entries(before?.files ?? {})) {
    if (!safeRelative(path)) throw new Diagnostic(recordPath, 'invalid owned file path');
    const destination = join(output, path);
    if (existsSync(destination) && hash(readFileSync(destination, 'utf8')) !== previousHash)
      edited.push(
        new Diagnostic(
          destination,
          'generated file was edited; move custom changes to custom/ before regeneration',
        ),
      );
    if (!files.has(path) && existsSync(destination))
      changes.push({
        path,
        kind: 'removed',
        reason: 'No longer generated by selected contract/targets',
      });
  }
  if (edited.length) throw new DiagnosticGroup(edited);
  for (const [path, content] of files) {
    const destination = join(output, path);
    if (!existsSync(destination))
      changes.push({ path, kind: 'created', reason: 'Required by selected contract/target' });
    else if (!before?.files[path]) {
      // A case-only rename aliases the owned file on case-insensitive filesystems.
      // A distinct directory entry (including a hardlink) is still unowned.
      if (readdirSync(dirname(destination)).includes(basename(destination)))
        throw new Diagnostic(
          destination,
          'unowned file conflicts with generated output; restore the private .sdk-generator.json record if it was lost, or generate into a fresh directory',
        );
      const actual = lstatSync(destination);
      const alias = Object.keys(before?.files ?? {}).find((previous) => {
        if (previous.toLowerCase() !== path.toLowerCase() || files.has(previous)) return false;
        const prior = lstatSync(join(output, previous));
        return prior.dev === actual.dev && prior.ino === actual.ino;
      });
      if (!alias)
        throw new Diagnostic(
          destination,
          'unowned file conflicts with generated output; restore the private .sdk-generator.json record if it was lost, or generate into a fresh directory',
        );
      changes.push({
        path,
        kind: 'created',
        reason: 'Generated file renamed with different casing',
      });
    } else if (readFileSync(destination, 'utf8') !== content)
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
    compatibility:
      before && before.baseline?.kind !== 'draft'
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
  if (!dryRun) return generationTransaction(contract, output).report;
  const plan = preview(contract, output);
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
}

// CLI-only metadata; keep the library's serializable report unchanged.
export function generateWithSummary(contract: Contract, output: string) {
  return generationTransaction(contract, output);
}

/** CLI input loading belongs inside the same lock as compilation and writing. */
export function generateFromInputs(
  load: () => Contract,
  output: string,
  onWarning?: (warning: { code: string; warning: string }) => void,
  token?: string,
) {
  return generationTransaction(load, output, onWarning, token);
}

export function modifiedFileDiffs(plan: ReturnType<typeof preview>, output: string): string[] {
  return plan.changes
    .filter((change) => change.kind === 'modified')
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((change) =>
      unifiedDiff(
        change.path,
        readFileSync(join(output, change.path), 'utf8'),
        plan.files.get(change.path) ?? '',
      ),
    );
}

function generationTransaction(
  input: Contract | (() => Contract),
  output: string,
  onWarning: (warning: { code: string; warning: string }) => void = (warning) =>
    console.error(JSON.stringify(warning)),
  token: string = randomUUID(),
) {
  output = resolve(output);
  if (output === dirname(output))
    throw new Diagnostic(output, 'cannot generate into filesystem root');
  mkdirSync(dirname(output), { recursive: true });
  const lock = output + '.sdk-generator.lock';
  const stage = output + '.stage-' + randomUUID();
  const backup = output + '.backup-' + randomUUID();
  const owner = { pid: process.pid, token };
  let fd: number;
  const openLock = () =>
    acquireGenerationLock(lock, { ...owner, generator: version, stage, backup });
  try {
    fd = openLock();
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST')
      throw error;
    try {
      fd = withGenerationRecovery(
        output,
        (cleanup) => {
          let owner: unknown;
          try {
            owner = JSON.parse(readFileSync(lock, 'utf8'));
          } catch {
            /* Unknown locks require manual inspection. */
          }
          if (!isGenerationOwner(owner))
            throw new Diagnostic(
              lock,
              'generation lock has no valid transaction owner/token; inspect it and remove it only after checking no generation is running',
            );
          let alive = true;
          try {
            process.kill(owner.pid, 0);
          } catch (probe) {
            if (probe && typeof probe === 'object' && 'code' in probe && probe.code === 'ESRCH')
              alive = false;
          }
          if (alive)
            throw new Diagnostic(
              lock,
              `another generation is running (pid ${owner.pid}); wait for that process to finish`,
            );
          cleanup(owner);
          onWarning({
            code: 'STALE_GENERATION_LOCK',
            warning: `Recovered stale generation lock for dead pid ${owner.pid}: ${relative(process.cwd(), lock)}`,
          });
          return openLock();
        },
        owner,
      );
    } catch (recoveryError) {
      if (recoveryError instanceof GenerationRecoveryBusy)
        throw new Diagnostic(
          lock,
          'another process is recovering the generation lock; retry after it finishes. If it crashed, inspect the sibling .recovery file and owning pid before removing it',
        );
      throw recoveryError;
    }
  }
  const cleanup = () => {
    try {
      cleanupOwnedGeneration(output, owner);
    } finally {
      closeSync(fd);
    }
  };
  try {
    const contract = typeof input === 'function' ? input() : input;
    const plan = preview(contract, output);
    return {
      report: writeGeneration(contract, output, plan, stage, backup),
      files: [...plan.files.keys()],
      firstGeneration: !plan.before,
    };
  } finally {
    cleanup();
  }
}

function writeGeneration(
  contract: Contract,
  output: string,
  plan: ReturnType<typeof preview>,
  stage: string,
  backup: string,
) {
  let moved = false;
  try {
    // This synchronous call owns the prepared output. Recheck all filesystem
    // state under the lock without recompiling and rendering the same package.
    const current = previewOutput(contract, output, plan);
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
      ...(!current.before
        ? { baseline: { kind: 'draft' as const } }
        : current.before.baseline
          ? { baseline: current.before.baseline }
          : {}),
      generator: version,
      contractHash: contract.hash,
      sources: contract.sources,
      files: Object.fromEntries([...current.files].map(([p, v]) => [p, hash(v)])),
      interface: contract,
      compiled: current.compiled,
      compatibility: current.compatibility,
      ...(current.before?.baseline?.kind === 'released'
        ? { previousVersion: current.before.baseline.interface.config.version }
        : {}),
      ...(current.before &&
      !current.before.baseline &&
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
      compactRecord({
        ...record,
        compiled: storeCompiledSnapshot(current.compiled),
        ...(record.baseline?.kind === 'released'
          ? {
              baseline: {
                ...record.baseline,
                ...(record.baseline.compiled
                  ? { compiled: storeCompiledSnapshot(record.baseline.compiled) }
                  : {}),
              },
            }
          : {}),
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
  }
  return { changes: plan.changes, compatibility: plan.compatibility };
}
function readGenerationRecord(path: string): { record: RecordFile; source: string } {
  try {
    const source = readFileSync(path, 'utf8');
    return { record: JSON.parse(source), source };
  } catch {
    throw new Diagnostic(
      path,
      'cannot read the private generation record; restore it from a backup, or regenerate from pinned inputs into a fresh directory',
    );
  }
}

function selectedTargets(output: string): ('node' | 'php')[] {
  const recordPath = join(output, recordName);
  if (existsSync(recordPath)) {
    const { record } = readGenerationRecord(recordPath);
    return record.interface.config.targets ?? ['node', 'php'];
  }
  // Validation also supports packages copied without the private generation record.
  return (['node', 'php'] as const).filter((target) =>
    existsSync(join(output, target, target === 'node' ? 'package.json' : 'composer.json')),
  );
}

export function validate(output: string): { command: string; output: string }[] {
  return validateWithProgress(output);
}

export interface ValidationCheck {
  target: 'node' | 'php';
  label: string;
  files?: number;
}

class ValidationFailure extends Diagnostic {
  constructor(cwd: string, label: string, displayCwd: string, toolOutput: string) {
    super(cwd, `${label} failed in ${displayCwd}:\n${toolOutput}`);
    // Keep the diagnostic's location and type, without repeating the cwd prefix.
    this.message = this.detail;
  }
}

// Not re-exported by the library entry point. The CLI observes completed groups,
// while library callers still receive the original per-tool results.
export function validateWithProgress(
  output: string,
  onCheck?: (check: ValidationCheck, passed: boolean) => void,
): { command: string; output: string }[] {
  const displayOutput = output;
  const results: { command: string; output: string }[] = [];
  let current: ValidationCheck;
  function check(metadata: ValidationCheck, execute: () => void) {
    current = metadata;
    try {
      execute();
    } catch (error) {
      onCheck?.(metadata, false);
      throw error;
    }
    onCheck?.(metadata, true);
  }
  function run(command: string, args: string[], cwd: string) {
    const result = spawnSync(command, args, {
      cwd,
      encoding: 'utf8',
      timeout: 120000,
      // Modular packages contain thousands of entries in npm's JSON file list.
      maxBuffer: 16 * 1024 * 1024,
    });
    if (result.error || result.status !== 0)
      throw new ValidationFailure(
        cwd,
        current.label,
        `${displayOutput.replace(/[\\/]$/, '')}/${current.target}`,
        (result.error?.message ?? result.stderr + result.stdout).trimEnd(),
      );
    results.push({ command: [command, ...args].join(' '), output: result.stdout.trim() });
  }
  output = resolve(output);
  const targets = selectedTargets(output);
  for (const target of targets)
    for (const tool of target === 'node' ? ['node', 'npm'] : ['php', 'composer'])
      requireTool(tool, target, output);
  if (targets.includes('node')) {
    // Parse modules without executing them or starting thousands of Node processes.
    check({ target: 'node', label: 'JavaScript syntax' }, () => {
      run(
        process.execPath,
        [
          '--experimental-vm-modules',
          '--input-type=module',
          '-e',
          `
        import { readdirSync, readFileSync, existsSync } from 'node:fs';
        import { dirname, join, resolve } from 'node:path';
        import { SourceTextModule } from 'node:vm';
        import { execFileSync } from 'node:child_process';
        const root = process.cwd(), types = new Map();
        function type(directory) {
          if (!types.has(directory)) {
            const metadata = join(directory, 'package.json');
            types.set(directory, existsSync(metadata) ? JSON.parse(readFileSync(metadata, 'utf8')).type : directory === root ? 'module' : type(dirname(directory)));
          }
          return types.get(directory);
        }
        for (const file of readdirSync('.', { recursive: true, encoding: 'utf8' })) {
          if (file.startsWith('node_modules/') || !/\\.(?:js|mjs|cjs)$/.test(file)) continue;
          const source = readFileSync(file, 'utf8');
          if (file.endsWith('.mjs') || (file.endsWith('.js') && type(dirname(resolve(file))) === 'module')) new SourceTextModule(source, { identifier: file });
          else execFileSync(process.execPath, ['--check', file], { encoding: 'utf8' });
        }
      `,
        ],
        join(output, 'node'),
      );
    });
    check({ target: 'node', label: 'npm package contents' }, () => {
      run('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], join(output, 'node'));
    });
    check({ target: 'node', label: 'module and descriptor loading' }, () => {
      run(
        'node',
        [
          '--input-type=module',
          '-e',
          `
      import { readdirSync, existsSync, readFileSync } from 'node:fs';
      const sdk = await import('./index.js');
      if (existsSync('./descriptor-source.js')) {
        const { DescriptorSource } = await import('./descriptor-source.js');
        const client = new sdk.Client({ baseUrl: 'https://example.invalid' });
        for (const resource of Object.keys(client)) await import('./resources/' + resource + '.js');
        if (existsSync('./descriptors/resources')) for (const file of readdirSync('./descriptors/resources')) new DescriptorSource((await import('./descriptors/resources/' + file)).default());
        if (typeof client.verifyWebhook === 'function') new DescriptorSource((await import('./descriptors/webhook.js')).default());
        for (const file of JSON.parse(readFileSync('./descriptors/modules.json', 'utf8'))) {
          const module = await import('./' + file);
          if (!file.startsWith('resources/')) module._validate();
        }
      }
    `,
        ],
        join(output, 'node'),
      );
    });
  }
  if (targets.includes('node')) {
    const cwd = join(output, 'node');
    const examples = readdirSync(join(cwd, 'examples'))
      .filter((p) => p.endsWith('.mjs') && p !== 'webhook-inbox.mjs')
      .map((p) => join('examples', p));
    check(
      { target: 'node', label: 'Type-checked JavaScript examples', files: examples.length },
      () => {
        run(
          process.execPath,
          [
            require.resolve('typescript/bin/tsc'),
            '--strict',
            '--allowJs',
            '--checkJs',
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
      },
    );
  }
  if (targets.includes('php')) {
    const files = ['src', 'examples'].flatMap((sub) =>
      readdirSync(join(output, 'php', sub), {
        recursive: true,
        encoding: 'utf8',
      })
        .filter((f) => f.endsWith('.php'))
        .map((file) => join(sub, file)),
    );
    check({ target: 'php', label: 'PHP syntax', files: files.length }, () => {
      for (const file of files) run('php', ['-l', file], join(output, 'php'));
    });
    check({ target: 'php', label: 'Composer metadata' }, () => {
      run('composer', ['validate', '--no-check-publish'], join(output, 'php'));
    });
    check({ target: 'php', label: 'descriptor validation' }, () => {
      const namespace = readFileSync(join(output, 'php/src/Client.php'), 'utf8').match(
        /^namespace ([A-Za-z][A-Za-z0-9\\]*);/m,
      )?.[1];
      if (!namespace) throw new Diagnostic(output, 'missing generated PHP namespace');
      run(
        'php',
        [
          '-d',
          'memory_limit=128M',
          '-r',
          `require 'src/Runtime.php'; require 'src/Client.php'; $registry = ${php(namespace + '\\SchemaRegistry')}; if (method_exists($registry, 'source')) $registry::source()->validateAll();`,
        ],
        join(output, 'php'),
      );
    });
  }
  if (!results.length) throw new Diagnostic(output, 'no generated packages found');
  return results;
}
export function prepareRelease(output: string, destination: string, acknowledgeReview = false) {
  output = resolve(output);
  destination = resolve(destination);
  const recordPath = join(output, recordName);
  if (!existsSync(recordPath))
    throw new Diagnostic(
      recordPath,
      'private generation record is missing; restore it from the original output backup, or regenerate from pinned API/config inputs into a fresh directory before release',
    );
  const { record, source: recordSource } = readGenerationRecord(recordPath);
  // Older normalized records cannot prove which source ancestors or reference
  // uses protected a value. Reload the original inputs before packaging them.
  if (record.interface.exampleProtection === undefined)
    throw new Diagnostic(
      output,
      'regenerate before preparing a release: reload the source inputs to compute schema example publication protection',
    );
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
        { cwd: nodeStage, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
      );
      rmSync(nodeStage, { recursive: true, force: true });
      if (r.error || r.status !== 0) throw new Error(r.error?.message ?? r.stderr);
      const name = npmPackResult(r.stdout).filename;
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
      ...(targets.includes('node')
        ? {
            npm: {
              registry: record.interface.config.npm.registry ?? 'https://registry.npmjs.org',
              access: record.interface.config.npm.access ?? 'public',
            },
          }
        : {}),
      ...(targets.includes('php')
        ? {
            composer:
              'Deploy the prepared site with publish-site, then configure a Composer repository pointing to its packages.json. VCS/Packagist distribution is also supported independently.',
          }
        : {}),
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
    updateCompatibilityBaseline(output, 'released', false, recordSource);
    return fullPlan;
  } catch (e) {
    rmSync(destination, { recursive: true, force: true });
    throw e;
  }
}
/** Explicitly adopt the generated interface as released, or discard an unpublished draft's history. */
export function setCompatibilityBaseline(output: string, mode: 'draft' | 'released'): void {
  updateCompatibilityBaseline(output, mode, true);
}
function updateCompatibilityBaseline(
  output: string,
  mode: 'draft' | 'released',
  clearFindings: boolean,
  expectedRecord?: string,
): void {
  if (mode !== 'draft' && mode !== 'released')
    throw new Diagnostic('baseline', 'expected draft or released');
  output = resolve(output);
  const lock = output + '.sdk-generator.lock';
  const owner = { pid: process.pid, token: randomUUID() };
  let fd: number;
  try {
    fd = acquireGenerationLock(lock, owner);
  } catch {
    throw new Diagnostic(lock, 'another generation is running; inspect the lock before retrying');
  }
  const temporary = join(output, recordName + '.tmp-' + randomUUID());
  try {
    safeTree(output);
    const path = join(output, recordName);
    const { record, source } = readGenerationRecord(path);
    if (expectedRecord !== undefined && source !== expectedRecord)
      throw new Diagnostic(
        output,
        'generation record changed during release preparation; retry from the current output',
      );
    // Validate ownership and saved snapshots before changing only baseline metadata.
    const integrity = expectedRecord === undefined ? preview(record.interface, output) : undefined;
    if (integrity?.changes.length)
      throw new Diagnostic(output, 'regenerate before setting a compatibility baseline');
    record.baseline =
      mode === 'draft'
        ? { kind: 'draft' }
        : {
            kind: 'released',
            interface: record.interface,
            ...(record.compiled ? { compiled: record.compiled } : {}),
          };
    if (clearFindings) {
      record.compatibility = [];
      delete record.previousVersion;
      delete record.comparisonBase;
      delete record.compiledComparisonBase;
    }
    writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
    try {
      releaseGenerationLock(lock, fd, owner);
    } finally {
      closeSync(fd);
    }
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

function webhookReference(target: 'node' | 'php'): string {
  return (
    '## verifyWebhook\n\nVerify original request bytes with signing headers and one secret or a rotation array. Returns { known, event }; only matched declared envelopes are known. When known is false, reason is unknown_event for undeclared names or unmatched_envelope for declared names with no matching payload. Known deliveries have no reason. ' +
    (target === 'node'
      ? 'The return type is `VerifiedWebhook`: checking `known` exposes `KnownWebhookEvent`, the union of the `WebhookEvent<EventName>` types exported by the root and `webhooks` subpath. Per-event types use the PHP event naming rule and match class names where PHP emits an event class; multi-variant events have Node types without corresponding PHP event classes. Unknown events remain `unknown`; check `reason` when `known` is false. '
      : '') +
    'See [signatures, framework examples, and errors](RUNTIME.md#webhooks-and-recovery).\n\n'
  );
}

function webhookGuide(c: Contract, target: 'node' | 'php', standaloneWebhook: boolean): string {
  const w = c.config.webhook;
  if (!w) return 'This provider has not declared webhook verification.';
  const headers = [w.header, w.timestampHeader, w.idHeader]
    .filter(Boolean)
    .map((name) => '`' + name + '`')
    .join(', ');
  const verifier =
    target === 'node'
      ? 'Import verifyWebhook from the webhooks subpath to verify without client options, a base URL, API credentials or operation descriptors. The package-root export remains available. Client.verifyWebhook delegates to the same verifier. '
      : standaloneWebhook
        ? `Use ${c.config.composer.namespace}\\Webhooks::verify($rawBody, $headers, $secrets, $nowSeconds = null) to verify without client options, a base URL or API credentials. Client::verifyWebhook delegates to the same verifier. The static method keeps mixed arguments so invalid inputs produce SDK error subclasses. `
        : 'The Webhooks name belongs to an API model; use Client::verifyWebhook for verification. Its mixed arguments keep invalid inputs within the SDK error guards. ';
  const requirements = `${verifier}Call verifyWebhook(rawBody, headers, secrets, nowSeconds?) with original request bytes and ${headers}. This package uses ${w.format ?? 'hex'} HMAC-SHA256 signing and a ${w.toleranceSeconds}-second timestamp tolerance. ${w.format === 'standard-webhooks' ? 'Secrets must use the whsec_ prefix and canonical base64 encoding of exactly 32 key bytes.' : 'Use the signing secret supplied by the provider.'} Pass one secret string or an array of active secrets during rotation. nowSeconds is an optional Unix time override in seconds for deterministic tests; normally omit it. Millisecond-scale values raise an input error explaining the conversion. ${target === 'node' ? 'Node accepts original Buffer, Uint8Array or ArrayBuffer bytes. ' : 'PHP emits event classes for supported single object envelopes. Multi-variant or ambiguous event schemas verify and validate normally but return stdClass values (with arrays for JSON lists), even when known is true. Check the event name and payload fields before using these values; known does not guarantee a generated PHP class. '}\n\n`;
  const examples =
    target === 'node'
      ? `### Fetch\n\nThe request body must not have been consumed. Pass the SDK client and your configured signing secret to this helper:\n\n\`\`\`js
export async function verifyWebhookRequest(client, request, secrets) {
  const rawBody = new Uint8Array(await request.arrayBuffer());
  return client.verifyWebhook(rawBody, request.headers, secrets);
}
\`\`\`\n\n### Express\n\nRegister this route before app.use(express.json()). req.headers is accepted directly. Supply client and webhookSecret from your application configuration:\n\n\`\`\`js
app.post("/webhooks", express.raw({ type: "application/json" }), (req, res, next) => {
  try {
    const verified = client.verifyWebhook(req.body, req.headers, webhookSecret);
    // Persist verified.event and verified.known in your durable inbox before acknowledging.
    // Leave unknown events pending for review.
    receiveVerified(verified, req, res, next);
  } catch (error) {
    next(error);
  }
});
app.use(express.json());
\`\`\`\n\n### Rotation and narrowing\n\n\`\`\`ts
import type { VerifiedWebhook, KnownWebhookEvent } from '${c.config.npm.name}';

function handleKnown(event: KnownWebhookEvent): void {
  // Switch on the configured event-type field to handle each declared event.
}

const verified: VerifiedWebhook = client.verifyWebhook(rawBody, headers, [currentSecret, previousSecret]);
if (verified.known) {
  const event = verified.event; // KnownWebhookEvent
  handleKnown(event);
} else {
  const event = verified.event; // unknown: validate before accessing fields.
}
\`\`\`\n\nNode exports these types only from the package root, together with one WebhookEvent<EventName> type per declared event. Event names use the same PascalCase rule as PHP classes, for example payment_intent.succeeded becomes WebhookEventPaymentIntentSucceeded. For an envelope with a data field, use indexed access such as WebhookEventPaymentIntentSucceeded['data'] for its payload. A top-level typeField supports exhaustive switch narrowing with a never default. Dotted typeField paths require the named type or Extract<KnownWebhookEvent, { meta: { name: 'payment.updated' } }> (adapt that path and literal to your configuration). When no events are declared, KnownWebhookEvent is never.\n\n`
      : `### PSR-7\n\nLoad Composer's vendor/autoload.php in your application. Pass an unmodified request body and getHeaders() arrays directly:\n\n\`\`\`php
use ${c.config.composer.namespace}\\Client;

function verifyWebhookRequest(Client $client, object $request, string|array $secrets): array
{
    return $client->verifyWebhook((string) $request->getBody(), $request->getHeaders(), $secrets);
}
\`\`\`\n\nFor a native PHP handler, read php://input before parsing JSON:\n\n\`\`\`php
$rawBody = file_get_contents('php://input');
$verified = $client->verifyWebhook($rawBody, getallheaders(), $webhookSecret);
// For rotation, pass [$currentSecret, $previousSecret] instead.
if ($verified['known']) {
    $event = $verified['event'];
    // Persist and process the matched event idempotently.
} else {
    // Persist for review; do not assume a declared model or payload shape.
}
\`\`\`\n\n`;
  const errors =
    target === 'node'
      ? `\`\`\`js
try {
  const verified = client.verifyWebhook(rawBody, headers, webhookSecret);
} catch (error) {
  if (!(error instanceof SdkError)) throw error;
  // Record only error.kind and error.code; avoid logging request bodies or secrets.
  // webhook_timestamp_out_of_tolerance: check the clock and delivery age.
  // webhook_invalid_signature: check the secret and original request bytes.
  throw error; // Let your HTTP adapter choose the failure response.
}
\`\`\``
      : `\`\`\`php
try {
    $verified = $client->verifyWebhook($rawBody, $headers, $webhookSecret);
} catch (\\${c.config.composer.namespace}\\SdkError $error) {
    // Record only $error->kind and $error->errorCode; omit bodies and secrets.
    // webhook_timestamp_out_of_tolerance: check the clock and delivery age.
    // webhook_invalid_signature: check the secret and original request bytes.
    throw $error;
}
\`\`\``;
  return (
    requirements +
    examples +
    `### Failures and recovery\n\n${target === 'node' ? 'Import SdkError from this package. ' : ''}SdkError uses ${target === 'node' ? 'code' : 'errorCode'} for these stable reasons:\n\n| Kind | Code | Action |\n| --- | --- | --- |\n| validation | webhook_invalid_input | Supply original bytes and supported header/time values. |\n| validation | webhook_invalid_secret | Supply at least one correctly formatted nonempty secret. |\n| authentication | webhook_missing_header | Forward all configured signing headers. |\n| authentication | webhook_invalid_timestamp | Supply one integer timestamp in seconds. |\n| authentication | webhook_timestamp_out_of_tolerance | Check the clock and delivery age. |\n| authentication | webhook_invalid_signature | Check the secret and original bytes. |\n| protocol | webhook_invalid_json | The authenticated body is not valid UTF-8 JSON. |\n\n` +
    errors +
    '\n\nNever verify JSON.stringify(parsedBody) or json_encode(parsedBody): verification authenticates the original bytes, including whitespace and numeric spelling. A mismatch cannot distinguish a wrong secret from altered bytes. Repeated signature values are supported; timestamp and ID headers must each contain a single value.\n\nknown is true only for a registered event name whose payload matches a declared envelope. Authenticated unknown names return known: false with reason: unknown_event; declared names with unmatched envelopes use reason: unmatched_envelope. Known deliveries have no reason; nested response types retain their documented uncertainty. Malformed declared payloads produce a protocol error.\n\nVerification does not deduplicate deliveries. The optional examples/webhook-inbox files demonstrate durable inbox/outbox processing: commit the event ID and work record before acknowledging, reconcile out-of-order deliveries, and apply side effects idempotently. Unknown names and unmatched envelopes remain pending for review.'
  );
}

const bullets = (items: readonly string[]) => items.map((item) => '- ' + item + '\n').join('');

/** Runtime guide: common tasks first, each with a short snippet where one applies. */
function runtimeGuide(c: Contract, target: 'node' | 'php', standaloneWebhook: boolean): string {
  const node = target === 'node';
  const fence = node ? 'typescript' : 'php';
  const snippet = (
    op: Operation,
    method: string,
    options: string,
    body: (call: string) => string,
  ) => {
    const { keySetup, call } = operationCall(c, op, target);
    return `\`\`\`${fence}\n${keySetup}${body(call(method, options))}\`\`\`\n\n`;
  };
  const sample = c.operations.find((op) => op.verb === 'GET') ?? c.operations[0];
  const requestOptions = sample
    ? snippet(
        sample,
        sample.method,
        'timeoutMs: 5000, deadlineMs: 15000, maxAttempts: 1',
        (call) => (node ? `const result = await ${call};\n` : `$result = ${call};\n`),
      )
    : '';
  const paginated = c.operations.find((op) => op.pagination);
  const pagination = paginated
    ? snippet(paginated, paginated.method + 'Items', 'maxItems: 100', (call) =>
        node
          ? `for await (const item of ${call}) {\n  console.log(item);\n}\n`
          : `foreach (${call} as $item) {\n  // Process $item before the next page is requested.\n}\n`,
      )
    : '';
  return (
    `# ${c.title} runtime guide\n\nPackage ${c.config.version}; API ${c.apiVersion}.\n\n[Back to the quickstart](README.md) · [API reference](REFERENCE.md)\n\n` +
    `## Client and request options\n\n${c.defaultBaseUrl !== undefined ? `The default baseUrl is \`${c.defaultBaseUrl}\`; pass baseUrl to select another environment.` : 'Pass baseUrl: this SDK has no default server.'} Pass per-request options as the last method argument: a plain object in Node, or RequestOptions in PHP.\n\n${requestOptions}${c.operations.some((op) => op.parameters.some((p) => p['x-flint-request-option'] === 'client_request_id')) ? `Pass ${node ? 'clientRequestId' : 'client_request_id'} for caller correlation on operations declaring that option. The value must contain 1 to 128 visible ASCII characters (0x21 to 0x7E), without spaces. Invalid values and conflicting request headers raise a validation error before sending, even with schema validation disabled. Unset values send no header. Keep secrets and personal data out of correlation values. The response request ID in meta.requestId is the server ID, independent of this value.\n\n` : ''}` +
    bullets([
      ...(node
        ? [
            'Unknown client option keys fail validation; use maxAttempts for the total attempt budget, including the first attempt.',
          ]
        : []),
      'Defaults are timeoutMs: 10000 per attempt and deadlineMs: 30000 for the overall duration (not an absolute timestamp). Request values override client defaults.',
      'maxAttempts is a positive safe integer budget, capped at the operation limit. Request budgets override client budgets. Set maxAttempts: 1 to opt out of ordinary retries; provider invalidation can still add one HTTP 401 retry.',
      'Without an explicit policy, GET/HEAD/OPTIONS allow three total attempts; other methods allow one. Mutations without an optional key send once.',
      'Request headers carry tenant context without shared mutable state.',
      'Legacy authenticated clients accept token. Composed clients accept configured shortcuts or authMode and credentials keyed by mode and scheme; requests can select a mode with request-local credentials. A combined scheme set must be complete.',
      'Credentials accept strings or providers. Node CredentialProvider.getCredential() returns a Promise of { value: string, expiresAt?: Date }; optional invalidate() clears application caches. PHP CredentialProvider.getCredential(): Credential returns new Credential(value, expiresAt), with optional DateTimeInterface expiry; a Closure may return a string or Credential. Providers resolve on every request attempt. The application owns caching and expiry handling.',
      'A replay-safe request receiving HTTP 401 invalidates providers with invalidate() and retries once, adding at most one attempt to the ordinary budget (even with maxAttempts: 1) and preserving its idempotency key. String credentials and PHP closures never trigger this retry; repeated 401s fail immediately. Provider exceptions become authentication errors without retaining potentially sensitive causes.',
      ...(c.config.auth && 'defaultCredentials' in c.config.auth && c.config.auth.defaultCredentials
        ? [
            'This SDK discovers credentials lazily: explicit credentials, then the configured API key or access token environment variable (both set is ambiguous_credentials), then workload identity when its ID environment variable is set. Set ambientCredentials: false to disable discovery. defaultCredentials() and workloadIdentityCredentials(options) return credential providers in Node and PHP (namespace functions). Federation supports token and token_file sources, refreshes cached tokens ahead of expiry, and re-exchanges once on replay-safe HTTP 401. PHP credentialCache accepts an optional PSR-16 cache; protect it as a credential store.',
          ]
        : [
            'The SDK does not discover credentials or read environment variables; the operation example scripts read API_BASE_URL and their named credential variables explicitly.',
          ]),
    ]) +
    `\n## Authentication\n\n${authenticationGuide(c)}` +
    `## Responses and errors\n\n` +
    bullets([
      'Methods return the decoded body directly by default. A configured payloadPath explicitly selects a nested payload. WithResponse companions expose the full body, meta and raw response.',
      'Operations configured with return: result instead return Result, whose data is the complete decoded HTTP response body and meta is HTTP metadata. A provider may also wrap its payload in a data field, making result.data.data the provider payload. For example, create may wrap a payment_intent while get returns that entity directly. The operation examples show the exact access path. The SDK preserves these shapes; do not assume all operations share an envelope.',
      'Results expose data, meta and explicit raw response access. JSON raw values are text; PDF data/raw are Uint8Array in Node and binary-safe strings in PHP. SSE data is a closeable iterable carrying event names, IDs, decoded data and rawData. Node metadata uses properties; PHP metadata uses array keys.',
    ]) +
    `\n### Errors\n\n` +
    `${target === 'node' ? 'Import { SdkError, errors } from the package root or a resource subpath. The errors namespace provides both values and TypeScript types; errors.SdkError is the root SdkError class.' : 'Import SdkError from the package namespace and individual subclasses from its Errors sub-namespace.'} SdkError and kind remain the authoritative API.\n\n` +
    `\`\`\`${target === 'node' ? 'js' : 'php'}\n${errorClassExample(c, target)}\n\`\`\`\n\n` +
    bullets([
      'SdkError exposes the server message (message in Node, getMessage() in PHP), status, kind, outcome, retryAllowed and optional metadata; provider codes use code in Node and errorCode in PHP. Every error after key resolution exposes idempotencyKey, including not_sent failures; results expose meta.idempotencyKey. retryAfterMs records a valid server Retry-After in milliseconds.',
      ...(node
        ? []
        : [
            'PHP exposes SdkError::KIND_VALIDATION and the other KIND_* constants, plus OUTCOME_NOT_SENT, OUTCOME_RESPONSE and OUTCOME_UNKNOWN. getCode() is the HTTP status when available, otherwise 0; provider codes remain in errorCode. getMessage() appends HTTP status, provider code and requestId when available. Local validation, server validation and decode failures retain their existing ValidationError/ProtocolError classes and outcome metadata.',
          ]),
      'outcome is not_sent, response or unknown. Reconcile an unknown mutation outcome with the provider and the original persisted idempotency key before resubmitting.',
      'Per-attempt timeouts use kind timeout (TimeoutError); overall deadlines use deadline (DeadlineError) with retryAllowed false. Connection refusal and DNS lookup failures use transport (ConnectionError), outcome not_sent and machine-readable codes. Node details.transportCode and PHP details[curlCode]/details[curlError] identify the underlying transport failure without including request URLs.',
      'HTTP 404 uses kind not_found; HTTP 500–599 uses server. Status is undefined in Node or null in PHP when no response is available. Provider-specific details remain unknown in TypeScript.',
      'The configured errors.messagePath selects the message (default message); missing, blank or non-string values fall back to API returned HTTP followed by the status code. Error paths traverse JSON objects and array indices; scalar values have no child fields.',
      'Server messages and provider codes require original JSON strings; JSON numeric tokens never match string retry codes. Parsed details retain their usual exact numeric representation.',
    ]) +
    `\n### Undeclared and invalid responses\n\n${responseRecoveryGuide(target)}\n\n` +
    `## Retries and idempotency\n\n` +
    bullets([
      'Retries count total attempts and never exceed the effective policy. Backoff waits uniformly between half and all of baseDelayMs * 2^(attempt - 1), capped by optional maxDelayMs. Retry-After is a minimum wait. Both targets accept nonnegative decimal seconds (with optional surrounding spaces/tabs) or a canonical GMT HTTP date, for example Wed, 21 Oct 2015 07:28:00 GMT. Exponents, signed numbers, relative dates and malformed dates are ignored. If the next wait would exceed the deadline, the last error is returned unchanged; an attempt cut off by the overall deadline still uses kind deadline.',
      'Without a declared retry policy, GET/HEAD/OPTIONS retry transport failures and HTTP 408, 429, 500, 502, 503 and 504, with three total attempts and a 100 ms exponential jitter base. Explicit policies replace these defaults.',
      ...(c.config.errors?.retry
        ? [
            `The body retry signal at ${c.config.errors.retry.path} overrides status and code rules when it is a string: only ${c.config.errors.retry.retryValues.join(', ')} permits a retry. Without a string signal, configured statuses apply. HTTP 412 never retries.`,
          ]
        : []),
      'Mutation retries require both declared retry and idempotency support plus a valid key; without an optional key the call sends once. Required keys remain required.',
      'idempotencyKey is supported only on operations declaring that capability. A required header with auto disabled requires options.idempotencyKey in TypeScript; PHP rejects missing keys before dispatch. Save the key with the action before the first attempt and reuse it on retry.',
      "Persist an idempotency key across process restarts and submissions within the server's documented retention/scope. Automatic UUID v4 keys cover one SDK call only, include optional autoKeyPrefix, and must pass the declared header validation. Generation on required headers is enabled only by explicit auto configuration.",
      'Explicit keys from operation inputs, request headers or idempotencyKey are preserved; conflicting values fail before dispatch.',
      'A timeout after dispatch can leave the remote outcome unknown; inspect SdkError.outcome. Disable nested transport/application retries to avoid multiplied attempts. 409/412 are distinct conflicts and never automatically overwritten.',
    ]) +
    `\n## Pagination and polling\n\n${pagination}` +
    bullets([
      'Pagination is lazy, defaults to at most 1000 pages, and supports explicit maxPages/maxItems limits. The iterator ends when the page cap is reached. Repeated continuations (including longer cursor cycles) and two consecutive empty pages that still advertise continuations raise protocol errors. An isolated empty page or a terminal empty page is valid. Pagination does not guarantee a stable snapshot or durable continuation.',
      'Each pagination page gets a fresh deadline, including decoding; time spent processing yielded values does not consume it. Pagination has no overall iterator deadline; use cancellation or maxPages/maxItems to bound iteration.',
      'Polling shares an overall deadline.',
      'Generation rejects incompatible continuation/query representations, including an int64/uint64 continuation with an ordinary integer query parameter.',
    ]) +
    `\n## Timeouts, streaming and cancellation\n\n` +
    bullets([
      'Timeout is per attempt, including buffered body consumption. Deadline covers attempts and retry waits for each request.',
      'For SSE, timeout/deadline bound connection setup; streamIdleTimeoutMs controls idle reads and streamLifetimeMs optionally bounds stream lifetime.',
      ...(node
        ? [
            'An unconsumed default SSE connection and its timers do not keep Node alive. Start iteration within streamIdleTimeoutMs or the stream closes; iteration retains the connection until close. Injected transports own their socket lifecycle.',
          ]
        : []),
      'Malformed known SSE payloads fail with code sse_invalid_event and details containing eventId and the one-based event position; no payload bytes are included in the message.',
      'Close the returned stream (Result.data in result mode) or the client to release a stream; breaking iteration also closes it. Unknown event names retain raw strings. Reconnect and persist resume cursors explicitly; no yielded event is retried automatically.',
      'Cancellation stops local work, not the remote operation. Node uses AbortSignal. PHP uses a Cancellation token checked during cURL progress and between waits; synchronous calls need an external signal handler to cancel while blocked.',
    ]) +
    `\n## Webhooks and recovery\n\n${webhookGuide(c, target, standaloneWebhook)}\n\n` +
    downloadGuide(c, target) +
    `## Destinations and API versions\n\n` +
    bullets([
      'baseUrl must omit a path already present at the start of an operation path; duplicated paths are rejected before sending. For an operation at /v1/payments, use an origin baseUrl rather than appending /v1.',
      'Explicit allowedOrigins govern all destinations, including pagination. HTTP/HTTPS scheme and host capitalization are ignored, and default ports are normalized; other ports remain distinct origins. Supply explicit allowedOrigins as canonical origin strings with default ports omitted.',
      'HTTPS is required, including on anonymous APIs, unless allowInsecureHttp is set for deliberate local tests. HTTP rejection names that option; a rejected origin names allowedOrigins.',
      'Declared 302/307 responses return Location metadata without following redirects; undeclared redirects are rejected. Authentication is attached only after destination validation.',
      'API version headers are pinned when configured; changing them does not update generated types. Credential headers and configured API-version headers are omitted from method inputs; credentials and the version pin supply their values. Declared idempotency and conditional headers remain optional input fields as well as request options. errors.requestIdHeader selects response metadata and does not supply an outgoing request ID. Required conditional headers may be supplied through ifMatch or request headers without duplicating them in the input. Effective managed header values are validated before dispatch.',
    ]) +
    `\n## Client lifecycle and transports\n\n` +
    bullets([
      'Clients perform no network I/O at import/construction. No SDK telemetry is sent.',
      'Node clients use fetch for buffered operations and native HTTP/HTTPS for SSE connections; injected transports remain caller-owned and must honor AbortSignal and disable redirects/retries. Node requests keep headers/context local and support concurrent calls.',
      'PHP owns a reusable cURL handle, released by close()/destruction; a client supports sequential calls within one PHP execution context. Do not concurrently share a PHP client across threads/fibers.',
      ...(!node
        ? [
            'Model properties are read-only; assignment raises a validation error. Construct a new model with updated values. Request header names and values must be strings; invalid headers raise a validation error before sending.',
          ]
        : []),
      'Requests use the media type selected by the provider profile. Schema validation counts encoded object properties, including explicit nulls, after optional-field omission.',
      'Requests identify the selected package name/version and runtime through an overridable User-Agent header.',
    ]) +
    `\n## Diagnostics and sensitive data\n\n` +
    bullets([
      'Diagnostics run once per attempted HTTP request, including transport failures, with operation, request ID, status, timing, attempt count and error kind only; hook failures are ignored. Bodies and credentials are excluded.',
      'Error inspection includes the message, status, provider code, redacted details and stack frames; PHP debug traces omit arguments. Message extraction, provider codes and details honor schema and redactFields redaction.',
      'Error JSON serialization and native exception rendering omit raw bodies, response headers, URLs and unsanitized causes. Raw response text and headers require explicit access. Binary/stream result inspection omits raw headers and URLs; event inspection omits payloads.',
      'Model debug printing redacts declared sensitive fields and additional field names supplied in ClientOptions.redactFields; printing arbitrary raw values is application responsibility. Injected transports are privileged and see credentials/bodies.',
    ]) +
    `\n## Custom helpers\n\nCustom helpers belong in custom/; they survive regeneration. Multi-call helpers are not atomic and must expose partial completion. See [reference](REFERENCE.md).\n\n` +
    `## Package upgrades\n\nReview provider release notes before upgrading. Compatibility checks account for public declarations, required response values and PHP class identities. Complex schema changes can still require manual review.\n\n` +
    `## Input and response values\n\n### Numbers and dates\n\n` +
    bullets([
      'API responses and verified webhook payloads use the same numeric codecs. Their schemas determine representation independently: int64/uint64 fields decode to exact strings; plain integers decode to native safe integers and reject larger values. Plain number, float and double fields use finite native numbers (PHP int/float inputs and float outputs), with ordinary floating-point precision. Exact decimal fields require format: decimal; int64/uint64 also retain exact strings.',
      'Large integers (int64) and decimals use exact strings, including numeric JSON wire values. Ambiguous numeric inputs automatically use new ExactNumber("1.2500") and plain strings retain their JSON string meaning. Integer responses accept integral decimal/exponent notation without rounding.',
      'Exact numeric enum inputs use strings for decimal/int64/uint64 schemas; membership compares exact values, so equivalent decimal/exponent spellings are accepted.',
      'Numeric anyOf branches merge equivalent values exactly and preserve the request token; oneOf still requires exactly one matching branch. Numeric conversions supported only by branches that stop matching fail validation before dispatch.',
      'Mutually dependent numeric alternatives use joint matching, limited to 256 combinations per value path; exceeding this limit fails validation.',
      'Configured money helpers reject whitespace, including trailing newlines, and excess precision when converting exact major-unit strings to minor units.',
      'Date-time inputs accept strings or Date in Node and DateTimeInterface in PHP. Native dates serialize to UTC ISO 8601 with milliseconds without mutation; responses remain strings. Invalid Node dates are rejected. Timestamp responses remain strings.',
      'Sparse Node input arrays fail before dispatch.',
    ]) +
    `\n### Objects, optional fields and unknown values\n\n` +
    bullets([
      'Shaped TypeScript objects have no implicit index signature: misspelled input literals and response fields are errors. Explicitly open objects and dictionaries remain open; variables can still carry extra keys under structural typing.',
      'Runtime request rules are unchanged and unknown response fields are preserved, requiring explicit narrowing or a dictionary assertion to inspect them. Unknown object variants require a known-variant guard.',
      'Simple nullable wrappers preserve the known branch or null: TypeScript permits optional field access and PHP getters hydrate the existing named entity.',
      'Unknown response fields, enum members, and tagged variants are retained; malformed known values fail response decoding.',
      'Optional properties distinguish omission from null.',
      'Portable digit/word pattern escapes retain their ASCII ECMAScript meaning in both targets, including inside character classes. Full request encoding checks run locally; server business effects require provider tests.',
    ]) +
    (node
      ? ''
      : '\nPHP integer input strings, including ExactNumber tokens used for integer fields, must contain decimal integer digits with an optional minus sign. Decimal and exponent spellings such as 50.00 and 5e3 are rejected with an integer string validation error. Decimal fields retain exact fractional/exponent spellings; integer responses still decode integral JSON decimal/exponent tokens exactly.\n') +
    `\n### PHP inputs and models\n\n` +
    bullets([
      'PHP methods accept associative arrays or presence-aware typed input objects constructed from arrays: omit a key to omit it; include a key with null to clear only where permitted.',
      'PHP models expose presence through has() and generated hasField() methods. Use valueOrDefault("field", fallback) for optional values; explicit null stays null.',
      'Response getters return generated entities for declared nested objects, lists of entities, and typed PHP arrays for dictionaries. Generated getters, get(), and property access return the same public values. Omitted optional response fields return null; their accessor types are nullable. has() distinguishes omission from present-null. Missing required response fields fail during decode with a ProtocolError; unknown property names raise a validation error. Omitted input fields still throw on access.',
      'toArray() and jsonSerialize() retain raw normalized objects and lists, including empty JSON objects. In object/array alternatives, PHP lists (including []) represent JSON arrays; use (object) [] for an empty JSON object.',
      'PHP response wrapper class names include status codes and, for tagged alternatives, branch positions. Nested entities reuse configured component names; inline entities use their owning model and property path.',
      'Getters normalize wire names: request_id becomes getRequestId() and hasRequestId(). Webhook class names use event names, for example WebhookEventPaymentIntentSucceeded. This replaces underscore getters and numbered webhook classes without aliases; update class checks and dictionary access when upgrading.',
      'Adding a status can introduce a new return class even with an identical JSON shape; consult migration notes before upgrading class-based dispatch.',
    ]) +
    `\n### Model copies\n\n` +
    bullets([
      'Node Model.toJSON() returns a defensive copy of the public JSON representation, with exact numbers represented as strings. Rebuilding from that copy treats these as JSON strings in number/string alternatives.',
      'To edit a Node input, retain the original input values, including ExactNumber instances, and construct a new model from the updated input. If editing a toJSON() copy, explicitly restore ExactNumber at fields intended to be JSON numbers in ambiguous alternatives.',
      'PHP accessors memoize hydrated children: repeated reads of an entity return the same immutable instance, and lists/maps of entities use PHP copy-on-write arrays. Mutable untyped objects remain defensive copies. Use toInputArray()/toInputValue() to edit and rebuild inputs while preserving exact numeric kinds.',
    ]) +
    `\n## Schema helpers\n\n${node ? 'The package exports serialize(value, schema), new Model(value, schema), and redact(value, schema) for application-supplied schemas.' : 'The base Model constructor, Codec::normalize and Codec::redact accept application-supplied schemas. Codec::encode writes normalized values as JSON.'} These helpers use the package's local value execution rules and require no generator installation or schema registry service.\n\n` +
    bullets([
      'Generated clients defer descriptor loading until first use and reuse validated descriptors across clients. Generated methods and factories use the codecs included in the package.',
      'Node resource subpaths (resources/RESOURCE) export scoped clients with the same resource methods.',
      ...(node && c.config.webhook
        ? [
            'Import verifyWebhook and webhook event types from the webhooks subpath to avoid loading operation descriptors. The package root and Client.verifyWebhook remain available.',
          ]
        : []),
      'PHP client resource wrappers initialize on first access, retain their identity and remain read-only.',
      'PHP uses class-based Composer autoloading and individual class files; including vendor/autoload.php does not eagerly include SDK implementation files.',
      'For a null-only schema, use {"type":"null"}. The legacy form {"type":["null"]} also permits non-null values in Node; PHP rejects them.',
    ])
  );
}

function responseRecoveryGuide(target: 'node' | 'php'): string {
  const explanation =
    "Exact HTTP status declarations take precedence, followed by a declared `default`. If neither exists for an actual 2xx response, the SDK reuses the sole declared JSON 2xx response, including its codec and PHP model class. Metadata retains the actual status. Multiple JSON success declarations remain ambiguous, even when their schemas match; binary, streaming, empty and redirect responses are never inferred.\n\nRequired fields and value types remain enforced. Schema failures are non-retryable `protocol` errors with `outcome: response`; the top-level message includes codec diagnostics such as `response.payment.id: required field is missing`, and the original cause remains available. The server may already have created the payment. Buffered JSON response failures and payload-extraction errors retain `raw` for explicit recovery; raw bodies are omitted from ordinary error inspection and diagnostics.\n\nInside a catch block, a synthetic create response with a top-level string `id` can be recovered as below. Use the actual endpoint's ID path and reconcile its state before continuing. This parses an unvalidated body only to recover the ID; it does not restore the SDK's typed guarantees or justify resubmitting the mutation.";
  const example =
    target === 'node'
      ? 'if (error instanceof SdkError && error.kind === "protocol" &&\n    error.status >= 200 && error.status < 300 && error.raw) {\n  let body;\n  try { body = JSON.parse(error.raw); } catch { throw error; }\n  const paymentId = typeof body?.id === "string" ? body.id : undefined;\n  if (!paymentId) throw error;\n  // Reconcile this payment ID with the provider; do not submit another create.\n} else {\n  throw error;\n}'
      : "if ($error instanceof SdkError && $error->kind === 'protocol' &&\n    $error->status >= 200 && $error->status < 300 && $error->raw !== null) {\n    try {\n        $body = json_decode($error->raw, true, 512, JSON_THROW_ON_ERROR | JSON_BIGINT_AS_STRING);\n    } catch (\\JsonException) {\n        throw $error;\n    }\n    $paymentId = is_array($body) && is_string($body['id'] ?? null) ? $body['id'] : null;\n    if ($paymentId === null) throw $error;\n    // Reconcile this payment ID with the provider; do not submit another create.\n} else {\n    throw $error;\n}";
  return explanation + '\n\n```' + (target === 'node' ? 'js' : 'php') + '\n' + example + '\n```';
}
