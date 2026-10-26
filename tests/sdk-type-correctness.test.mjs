import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import ts from 'typescript';
import { loadContract, generate, preview } from '../dist/index.js';
import { compileSdkContract, compilePhpModel, inputSchema } from '../dist/target-plan.js';
import { assertRuntimePlan, compileRuntimePlan } from '../dist/runtime-plan.js';
import { compileSchemaPolicy } from '../dist/schema-policy.js';
import { typescriptType } from '../dist/target-types.js';
import { storeCompiledSnapshot, restoreCompiledSnapshot } from '../dist/compiled-record.js';
import {
  splitNodeDeclarations,
  compactNodeDeclarations,
  formatNodeDeclaration,
} from '../dist/package-render.js';
import { compareCompiledContracts } from '../dist/compiled-compatibility.js';

function fixture(t, api, config = {}) {
  mkdirSync('.generated', { recursive: true });
  const dir = mkdtempSync(resolve('.generated/sdk-types-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, 'api.json');
  const profile = join(dir, 'sdk.json');
  writeFileSync(
    source,
    JSON.stringify({ openapi: '3.1.0', info: { title: 'Synthetic types', version: '1' }, ...api }),
  );
  writeFileSync(
    profile,
    JSON.stringify({
      version: '1.0.0',
      requests: { style: 'object' },
      npm: { name: '@example/type-correctness' },
      composer: { name: 'example/type-correctness', namespace: 'Example\\Types' },
      validation: 'schema',
      ...config,
    }),
  );
  const contract = loadContract(source, profile);
  const output = join(dir, 'out');
  generate(contract, output);
  return { dir, contract, output };
}
const jsonResponse = (schema) => ({
  200: { description: 'OK', content: { 'application/json': { schema } } },
});
const ref = (name) => ({ $ref: '#/components/schemas/' + name });
function run(command, args) {
  return spawnSync(command, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
}
function ok(command, args) {
  const r = run(command, args);
  assert.equal(r.error, undefined, r.error?.message);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return r.stdout;
}
function typecheck(path, options = []) {
  ok(process.execPath, [
    'node_modules/typescript/bin/tsc',
    '--strict',
    '--noEmit',
    '--module',
    'NodeNext',
    '--moduleResolution',
    'NodeNext',
    '--target',
    'ES2022',
    '--typeRoots',
    resolve('node_modules/@types'),
    ...options,
    path,
  ]);
}
function phpstan(dir, output, source, succeeds = true) {
  const file = join(dir, 'consumer.php');
  const config = join(dir, 'phpstan.neon');
  writeFileSync(file, '<?php\n' + source);
  writeFileSync(
    config,
    `parameters:\n    level: max\n    phpVersion: 80200\n    tmpDir: ${JSON.stringify(join(dir, 'phpstan-cache'))}\n    scanDirectories:\n        - ${JSON.stringify(join(output, 'php/src'))}\n`,
  );
  const r = run('php', [
    resolve('.generated/phpstan-vendor/bin/phpstan'),
    'analyse',
    '--debug',
    '--no-progress',
    '--error-format=raw',
    '-c',
    config,
    file,
  ]);
  if (succeeds) assert.equal(r.status, 0, r.stdout + r.stderr);
  else assert.notEqual(r.status, 0, 'PHPStan accepted an incorrect consumer');
  return r.stdout + r.stderr;
}

test('identical response shapes share a canonical name while PHP identities remain stable', async (t) => {
  const result = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] };
  const response = (name) => ({
    type: 'object',
    properties: { data: ref(name) },
    required: ['data'],
  });
  const f = fixture(
    t,
    {
      components: {
        schemas: {
          AlphaResult: result,
          BetaResult: result,
          AlphaResponse: response('AlphaResult'),
          BetaResponse: response('BetaResult'),
        },
      },
      paths: {
        '/alpha': {
          post: { operationId: 'createAlpha', responses: jsonResponse(ref('AlphaResponse')) },
        },
        '/beta': {
          post: { operationId: 'createBeta', responses: jsonResponse(ref('BetaResponse')) },
        },
        '/direct': {
          get: { operationId: 'getAlpha', responses: jsonResponse(ref('AlphaResult')) },
        },
      },
    },
    {
      responses: { payloadPath: 'data' },
      operations: {
        createAlpha: { resource: 'alpha', method: 'create' },
        createBeta: { resource: 'beta', method: 'create' },
        getAlpha: { resource: 'alpha', method: 'get', response: { payloadPath: null } },
      },
    },
  );
  const before = structuredClone(f.contract);
  const a = compileSdkContract(f.contract);
  assert.deepEqual(a, compileSdkContract(f.contract));
  assert.deepEqual(f.contract, before);
  assert.equal(a.plan.node.operations.createAlpha.output, 'BetaResponse');
  assert.equal(a.plan.node.operations.createBeta.output, 'BetaResponse');
  assert.equal(a.plan.node.operations.getAlpha.output, 'BetaResult');
  // Codec identity remains shared, independently of the public Node name.
  assert.equal(
    a.plan.runtime.operations[0].responses['200'].codec.fields.data.reference,
    'BetaResult',
  );
  assert.equal(
    a.plan.runtime.operations[1].responses['200'].codec.fields.data.reference,
    'BetaResult',
  );
  assert.equal(a.plan.node.models.AlphaResult.outputAlias, 'BetaResult');
  assert.equal(a.plan.responseReturns.createAlpha.nodeDocumentation, 'BetaResult');
  assert.equal(a.plan.responseReturns.createBeta.nodeDocumentation, 'BetaResult');
  assert.equal(a.plan.documentation.getAlpha.nodeOutput, 'BetaResult');
  assert.doesNotMatch(
    readFileSync(join(f.output, 'node/REFERENCE.md'), 'utf8'),
    /(?:Returned payload|Response):[^\n]*AlphaResult/,
  );
  assert.match(
    readFileSync(join(f.output, 'node/declarations/BetaResult.d.ts'), 'utf8'),
    /export type BetaResult = \{\s*"id": string;\s*\};/,
  );
  const consumer = join(f.output, 'node/consumer.ts');
  const constrained = typescriptType(
    { 'x-sdk-ref': 'SharedNullable', 'x-sdk-type-name': 'OwnedNullable' },
    true,
    undefined,
    false,
    'object',
  );
  writeFileSync(
    consumer,
    `import {Client, type BetaResult, type BetaResponse} from './index.js';
const c = new Client({baseUrl:'https://example.invalid'});
const alpha = c.alpha.create();
const beta = c.beta.create();
const direct = c.alpha.get();
const existingAlpha: Promise<BetaResult> = alpha;
const existingBeta: Promise<BetaResult> = beta;
const response: Promise<BetaResponse> = c.alpha.createWithResponse().then(r => r.body);
import {Client as ScopedClient, type BetaResult as ScopedResult, type BetaResult as PreviousScopedResult} from './resources/alpha.js';
const scoped: Promise<ScopedResult> = new ScopedClient({baseUrl:'https://example.invalid'}).alpha.create();
const previousScoped: Promise<PreviousScopedResult> = scoped;
type OwnedNullable = BetaResult | null;
type SharedNullable = BetaResult | null;
type Constrained = ${constrained};
const nullableControl: OwnedNullable = null;
const constrainedValue: Constrained = {id:'synthetic'};
// @ts-expect-error an enclosing object constraint still excludes null
const constrainedNull: Constrained = null;
`,
  );
  typecheck(consumer);
  const program = ts.createProgram([consumer], {
    strict: true,
    module: ts.ModuleKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
  });
  const checker = program.getTypeChecker();
  const names = new Map();
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const type = checker.getAwaitedType(checker.getTypeAtLocation(node.initializer));
      names.set(node.name.text, type && checker.typeToString(type));
    }
    ts.forEachChild(node, visit);
  }
  visit(program.getSourceFile(consumer));
  assert.equal(names.get('alpha'), 'BetaResult');
  assert.equal(names.get('beta'), 'BetaResult');
  assert.equal(names.get('direct'), 'BetaResult');
  assert.equal(names.get('scoped'), 'BetaResult');
  const sdk = await import(pathToFileURL(join(f.output, 'node/index.js')));
  const c = new sdk.Client({
    baseUrl: 'https://example.invalid',
    transport: async () => new Response('{"data":{"id":"synthetic"}}'),
  });
  assert.deepEqual({ ...(await c.alpha.create()) }, { id: 'synthetic' });
  assert.deepEqual({ ...(await c.beta.create()) }, { id: 'synthetic' });
  ok('php', [
    '-r',
    String.raw`
require $argv[1].'/src/Runtime.php'; require $argv[1].'/src/Client.php';
$c=new Example\Types\Client(new Example\Types\ClientOptions(baseUrl:'https://example.invalid',transport:fn($r)=>['status'=>200,'headers'=>[],'body'=>'{"data":{"id":"synthetic"}}']));
foreach ([$c->alpha->create(), $c->beta->create()] as $value) {
 if (!$value instanceof Example\Types\BetaResult || $value->getId()!=='synthetic') throw new Exception('Shared PHP identity changed');
}
`,
    join(f.output, 'php'),
  ]);
  assert.equal(preview(f.contract, f.output).changes.length, 0);
  assert.deepEqual(preview(f.contract, f.output).compatibility, []);
  // Rendering an interface leaves the saved public contract unchanged. A saved
  // canonical payload name still receives the existing breaking classification.
  const recordPath = join(f.output, '.sdk-generator.json');
  const record = JSON.parse(readFileSync(recordPath, 'utf8'));
  // Simulate a record written before draft/release baseline tracking.
  delete record.baseline;
  const snapshot = restoreCompiledSnapshot(record.compiled);
  const previous = structuredClone(snapshot.plan);
  previous.node.operations.createAlpha.output = 'AlphaResponse';
  previous.responseReturns.createAlpha.node = 'AlphaResult';
  record.compiled = storeCompiledSnapshot({ ...snapshot, plan: previous });
  writeFileSync(recordPath, JSON.stringify(record));
  assert.ok(
    preview(f.contract, f.output).compatibility.some(
      (finding) =>
        finding.severity === 'breaking' && finding.subject === 'createAlpha.responseReturn',
    ),
  );
});

test('shared object declarations retain owning names and documentation; nonextendable shapes remain valid aliases', (t) => {
  const dir = mkdtempSync(resolve('.generated/shared-declarations-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const object = '{ id: string; status: "ready" | "done"; [key: string]: unknown; }';
  const intersection = '({ id?: unknown }) & ({ id: string; status: string })';
  const union = '{ kind: "a"; value: string } | { kind: "b"; value: number }';
  const conflict = '({ kind: "a" }) & ({ kind: "b" })';
  const files = new Map();
  const names = ['Object', 'Intersection', 'Union', 'Conflict', 'Nullable', 'Array'];
  const source = [
    'export interface ClientOptions {}',
    ...[object, intersection, union, conflict, object + ' | null', '(' + object + ')[]'].flatMap(
      (shape, index) => [
        `export type Shared${names[index]} = ${shape};`,
        `/** Owning ${names[index]} documentation. */\nexport type Owned${names[index]} = ${shape};`,
      ],
    ),
    'export declare class Client { constructor(options: ClientOptions); readonly api: { object(): Promise<OwnedObject>; intersection(): Promise<OwnedIntersection>; union(): Promise<OwnedUnion>; }; }',
  ].join('\n');
  const roots = splitNodeDeclarations(
    source,
    ['api'],
    (name, text) => files.set(name, text),
    new Set(names.map((name) => 'Owned' + name)),
  );
  assert.match(
    files.get('declarations/OwnedObject.d.ts'),
    /export interface OwnedObject extends SharedObject \{\}/,
  );
  assert.match(
    files.get('declarations/OwnedIntersection.d.ts'),
    /export interface OwnedIntersection extends SharedIntersection \{\}/,
  );
  for (const name of ['Union', 'Conflict', 'Nullable', 'Array'])
    assert.match(
      files.get(`declarations/Owned${name}.d.ts`),
      new RegExp(`export type Owned${name} = Shared${name};`),
    );
  for (const name of names)
    assert.ok(
      files.get(`declarations/Owned${name}.d.ts`).includes(`Owning ${name} documentation.`),
    );
  // A shared declaration must enter the subpath closure even without equivalent codecs.
  assert.ok(roots.get('api').has('SharedObject'));
  assert.ok(roots.get('api').has('SharedIntersection'));
  files.set(
    'resources/api.d.ts',
    files.get('resources/api.d.ts') +
      [...roots.get('api')]
        .filter((name) => name !== 'Client')
        .map((name) => `\nexport type { ${name} } from '../declarations/${name}.js';`)
        .join(''),
  );
  for (const [name, text] of files) {
    const path = join(dir, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, text);
  }
  const consumer = join(dir, 'consumer.ts');
  writeFileSync(
    consumer,
    `import {Client, type SharedObject, type OwnedObject, type SharedIntersection, type OwnedIntersection, type OwnedUnion, type OwnedNullable, type OwnedArray, type OwnedConflict} from './index.js';
import type {SharedObject as ScopedSharedObject} from './resources/api.js';
const c = new Client({});
const object = c.api.object();
const intersection = c.api.intersection();
declare const shared: SharedObject;
declare const owned: OwnedObject;
const fromShared: OwnedObject = shared;
const fromOwned: SharedObject = owned;
const scoped: ScopedSharedObject = owned;
declare const sharedIntersection: SharedIntersection;
const fromSharedIntersection: OwnedIntersection = sharedIntersection;
const nullable: OwnedNullable = null;
const array: OwnedArray = [owned];
const unionA: OwnedUnion = {kind:'a',value:'synthetic'};
const unionB: OwnedUnion = {kind:'b',value:1};
// @ts-expect-error required fields remain required
const missingId: OwnedObject = {status:'ready'};
// @ts-expect-error discriminated unions retain their branches
const wrongUnion: OwnedUnion = {kind:'a',value:1};
// @ts-expect-error conflicting discriminants remain uninhabitable
const impossible: OwnedConflict = {kind:'a'};
`,
  );
  typecheck(consumer);
  const program = ts.createProgram([consumer], {
    strict: true,
    module: ts.ModuleKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
  });
  const checker = program.getTypeChecker();
  const inferred = new Map();
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer)
      inferred.set(
        node.name.text,
        checker.typeToString(checker.getTypeAtLocation(node.initializer)),
      );
    ts.forEachChild(node, visit);
  }
  visit(program.getSourceFile(consumer));
  assert.equal(inferred.get('object'), 'Promise<OwnedObject>');
  assert.equal(inferred.get('intersection'), 'Promise<OwnedIntersection>');
});

test('API and signed webhooks share exact numeric types and decoding; plain integer schemas remain distinct', async (t) => {
  const numbers = {
    signed: { type: 'integer', format: 'int64' },
    unsigned: { type: 'integer', format: 'uint64' },
    ordinary: { type: 'integer' },
  };
  const reading = { type: 'object', properties: numbers, required: Object.keys(numbers) };
  const envelope = (name, data) => ({
    type: 'object',
    properties: { event_type: { type: 'string', const: name }, data },
    required: ['event_type', 'data'],
  });
  const f = fixture(
    t,
    {
      components: { schemas: { Reading: reading } },
      paths: {
        '/readings': { get: { operationId: 'read', responses: jsonResponse(ref('Reading')) } },
      },
      webhooks: {
        reading: {
          post: {
            requestBody: {
              content: {
                'application/json': { schema: envelope('reading.updated', ref('Reading')) },
              },
            },
            responses: { 204: { description: 'OK' } },
          },
        },
      },
    },
    {
      webhook: {
        algorithm: 'hmac-sha256',
        header: 'Webhook-Signature',
        timestampHeader: 'Webhook-Timestamp',
        separator: '.',
        toleranceSeconds: 300,
        typeField: 'event_type',
        events: {
          'plain.updated': envelope('plain.updated', {
            type: 'object',
            properties: { signed: { type: 'integer' } },
            required: ['signed'],
          }),
        },
      },
    },
  );
  const sdk = await import(pathToFileURL(join(f.output, 'node/index.js')));
  let body;
  const client = new sdk.Client({
    baseUrl: 'https://example.invalid',
    transport: async () => new Response(body),
  });
  const now = 1700000000;
  const secret = 'synthetic-signing-secret';
  function verify(raw) {
    const signature = createHmac('sha256', secret)
      .update(now + '.' + raw)
      .digest('hex');
    return client.verifyWebhook(
      Buffer.from(raw),
      { 'Webhook-Timestamp': String(now), 'Webhook-Signature': signature },
      secret,
      now,
    );
  }
  const cases = [
    {
      raw: '{"signed":5000,"unsigned":5000,"ordinary":5000}',
      expected: { signed: '5000', unsigned: '5000', ordinary: 5000 },
    },
    {
      raw: '{"signed":9007199254740993,"unsigned":18446744073709551615,"ordinary":9007199254740991}',
      expected: {
        signed: '9007199254740993',
        unsigned: '18446744073709551615',
        ordinary: 9007199254740991,
      },
    },
  ];
  for (const c of cases) {
    body = c.raw;
    assert.deepEqual({ ...(await client.api.read()) }, c.expected);
    const webhook = verify('{"event_type":"reading.updated","data":' + body + '}');
    assert.equal(webhook.known, true);
    assert.deepEqual({ ...webhook.event.data }, c.expected);
  }
  const plain = verify('{"event_type":"plain.updated","data":{"signed":5000}}');
  assert.equal(plain.known, true);
  assert.equal(plain.event.data.signed, 5000);
  assert.throws(() => verify('{"event_type":"plain.updated","data":{"signed":9007199254740993}}'), {
    kind: 'protocol',
  });
  for (const raw of [
    '{"signed":1.5,"unsigned":2,"ordinary":1}',
    '{"signed":1,"unsigned":2,"ordinary":9007199254740993}',
  ]) {
    body = raw;
    await assert.rejects(client.api.read(), { kind: 'protocol' });
    assert.throws(() => verify('{"event_type":"reading.updated","data":' + raw + '}'), {
      kind: 'protocol',
    });
  }
  const consumer = join(f.output, 'node/consumer.ts');
  writeFileSync(
    consumer,
    `import {Client} from './index.js';
const c=new Client({baseUrl:'https://example.invalid'});
async function response(){const value=await c.api.read(); const signed:string=value.signed; const unsigned:string=value.unsigned; const ordinary:number=value.ordinary;}
const w=c.verifyWebhook(new Uint8Array(),{},'synthetic');
if(w.known && w.event.event_type==='reading.updated'){ const signed:string=w.event.data.signed; const unsigned:string=w.event.data.unsigned; const ordinary:number=w.event.data.ordinary;
// @ts-expect-error exact webhook integers are strings
const wrong:number=w.event.data.signed;
}
if(w.known && w.event.event_type==='plain.updated'){const ordinary:number=w.event.data.signed;}
`,
  );
  typecheck(consumer);
  writeFileSync(join(f.dir, 'cases.json'), JSON.stringify(cases));
  ok('php', [
    '-r',
    String.raw`
require $argv[1].'/src/Runtime.php'; require $argv[1].'/src/Client.php';
$now=1700000000; $secret='synthetic-signing-secret'; $body='';
$c=new Example\Types\Client(new Example\Types\ClientOptions(baseUrl:'https://example.invalid',transport:function($r)use(&$body){return ['status'=>200,'headers'=>[],'body'=>$body];}));
$verify=function($raw)use($c,$now,$secret){return $c->verifyWebhook($raw,['Webhook-Timestamp'=>(string)$now,'Webhook-Signature'=>hash_hmac('sha256',$now.'.'.$raw,$secret)],$secret,$now);};
foreach(json_decode(file_get_contents($argv[2]),true) as $case){
 $body=$case['raw']; $response=$c->api->read(); $webhook=$verify('{"event_type":"reading.updated","data":'.$body.'}');
 if(!$webhook['known'])throw new Exception('Unknown webhook');
 foreach([$response,$webhook['event']->getData()] as $value){
  if($value->getSigned()!==$case['expected']['signed'] || $value->getUnsigned()!==$case['expected']['unsigned'] || $value->getOrdinary()!==$case['expected']['ordinary'])throw new Exception('Numeric representations differ');
 }
}
if($verify('{"event_type":"plain.updated","data":{"signed":5000}}')['event']->getData()->getSigned()!==5000)throw new Exception('Plain integer changed');
foreach(['{"signed":1.5,"unsigned":2,"ordinary":1}','{"signed":1,"unsigned":2,"ordinary":9007199254740993}'] as $raw){
 $body=$raw;
 foreach([fn()=>$c->api->read(),fn()=>$verify('{"event_type":"reading.updated","data":'.$raw.'}')] as $call){try{$call();throw new Exception('Expected protocol error');}catch(Example\Types\SdkError $e){if($e->kind!=='protocol')throw $e;}}
}
try{$verify('{"event_type":"plain.updated","data":{"signed":9007199254740993}}');throw new Exception('Unsafe plain integer');}catch(Example\Types\SdkError $e){if($e->kind!=='protocol')throw $e;}
`,
    join(f.output, 'php'),
    join(f.dir, 'cases.json'),
  ]);
  phpstan(
    f.dir,
    f.output,
    String.raw`
use Example\Types\{Client,ClientOptions,WebhookEventReadingUpdated,WebhookEventPlainUpdated};
/** @param string $value */ function exact($value): void {}
/** @param int $value */ function ordinary($value): void {}
$c=new Client(new ClientOptions(baseUrl:'https://example.invalid'));
$r=$c->api->read(); exact($r->getSigned()); exact($r->getUnsigned()); ordinary($r->getOrdinary());
$w=$c->verifyWebhook('{}',[],'synthetic');
if($w['known'] && $w['event'] instanceof WebhookEventReadingUpdated){exact($w['event']->getData()->getSigned());exact($w['event']->getData()->getUnsigned());ordinary($w['event']->getData()->getOrdinary());}
if($w['known'] && $w['event'] instanceof WebhookEventPlainUpdated){ordinary($w['event']->getData()->getSigned());}
`,
  );
  assert.match(
    phpstan(
      f.dir,
      f.output,
      String.raw`
use Example\Types\WebhookEventReadingUpdated;
/** @param int $value */ function ordinary($value): void {}
/** @param WebhookEventReadingUpdated $event */ function check($event): void {ordinary($event->getData()->getSigned());}
`,
      false,
    ),
    /expects int, string given/,
  );
  ok('php', ['-l', join(f.output, 'php/src/Runtime.php')]);
  ok('php', ['-l', join(f.output, 'php/src/Client.php')]);
});

for (const style of ['object', 'positional']) {
  test(`${style}: credentials and version pins replace duplicate inputs, preserving other headers and compatibility evidence`, async (t) => {
    const header = (name, required = false, schema = { type: 'string' }) => ({
      in: 'header',
      name,
      required,
      schema,
    });
    const f = fixture(
      t,
      {
        components: {
          securitySchemes: {
            SessionID: { type: 'apiKey', in: 'header', name: 'X-Session-ID' },
            SessionSecret: { type: 'apiKey', in: 'header', name: 'X-Session-Secret' },
          },
        },
        paths: {
          '/commands/{id}': {
            post: {
              operationId: 'send',
              security: [{ SessionID: [], SessionSecret: [] }],
              parameters: [
                { in: 'path', name: 'id', required: true, schema: { type: 'string' } },
                header('x-session-id', true, { type: 'string', minLength: 3 }),
                header('X-Session-Secret', true, { type: 'string', minLength: 3 }),
                header('X-Api-Version', true, { type: 'string', enum: ['v1'] }),
                header('Idempotency-Key'),
                header('X-Request-Id'),
                header('X-Tenant', true),
              ],
              responses: { 204: { description: 'OK' } },
            },
          },
        },
      },
      {
        requests: { style },
        auth: { modes: { session: { schemes: ['SessionID', 'SessionSecret'] } } },
        apiVersion: { header: 'x-api-version', value: 'v1' },
        errors: { requestIdHeader: 'X-Request-Id' },
        operations: {
          send: {
            example: {
              id: 'command',
              'X-Tenant': 'tenant',
              'x-session-id': 'example-session',
              'X-Session-Secret': 'example-secret',
              'X-Api-Version': 'v1',
            },
            idempotency: {
              header: 'Idempotency-Key',
              retention: '24h',
              scope: 'command',
              auto: false,
            },
          },
        },
      },
    );
    const compilation = compileSdkContract(f.contract);
    const op = f.contract.operations[0];
    const input = inputSchema(op, f.contract.config.apiVersion, f.contract);
    for (const name of ['x-session-id', 'X-Session-Secret', 'X-Api-Version'])
      assert.equal(Object.hasOwn(input.properties, name), false, name);
    assert.deepEqual(input.required, ['id', 'X-Tenant']);
    for (const name of ['Idempotency-Key', 'X-Request-Id', 'X-Tenant'])
      assert.ok(Object.hasOwn(input.properties, name), name);
    for (const target of ['node', 'php']) {
      const docs = readFileSync(join(f.output, target, 'REFERENCE.md'), 'utf8');
      for (const name of ['x-session-id', 'X-Session-Secret', 'X-Api-Version'])
        assert.ok(!docs.includes('`' + name + '`'), name);
      assert.match(docs, /`X-Request-Id`/);
      const example = readFileSync(
        join(f.output, target, 'examples/api-send.' + (target === 'node' ? 'mjs' : 'php')),
        'utf8',
      );
      assert.doesNotMatch(example, /example-session|example-secret/);
    }
    const sdk = await import(pathToFileURL(join(f.output, 'node/index.js')));
    const seen = [];
    const c = new sdk.Client({
      baseUrl: 'https://example.invalid',
      authMode: 'session',
      credentials: { session: { SessionID: 'session-id', SessionSecret: 'session-secret' } },
      transport: async (_url, r) => {
        seen.push(r.headers);
        return new Response(null, {
          status: 204,
          headers: { 'X-Request-Id': 'req_007ARQX9HRSSV4DWBYC52DZKJ6' },
        });
      },
    });
    const args =
      style === 'object'
        ? [
            {
              id: 'command',
              'X-Tenant': 'tenant',
              'X-Request-Id': 'caller-id',
              'Idempotency-Key': 'saved-key',
            },
          ]
        : [
            'command',
            { 'X-Tenant': 'tenant', 'X-Request-Id': 'caller-id', 'Idempotency-Key': 'saved-key' },
          ];
    const response = await c.api.sendWithResponse(...args, {
      headers: { 'X-API-VERSION': 'ignored' },
    });
    assert.equal(response.meta.requestId, 'req_007ARQX9HRSSV4DWBYC52DZKJ6');
    for (const [name, value] of Object.entries({
      'x-session-id': 'session-id',
      'x-session-secret': 'session-secret',
      'x-api-version': 'v1',
      'idempotency-key': 'saved-key',
      'x-request-id': 'caller-id',
      'x-tenant': 'tenant',
    }))
      assert.equal(seen[0][name], value);
    await assert.rejects(
      c.api.send(...args, { credentials: { SessionID: 'x', SessionSecret: 'session-secret' } }),
      { kind: 'validation' },
    );
    await assert.rejects(c.api.send(...args, { headers: { 'X-Session-ID': 'conflict' } }), {
      kind: 'authentication',
    });
    await assert.rejects(c.api.send(...args, { idempotencyKey: 'conflict' }), {
      kind: 'validation',
    });
    assert.equal(seen.length, 1);
    const consumer = join(f.output, 'node/consumer.ts');
    writeFileSync(
      consumer,
      `import {Client, type ApiSendInput} from './index.js';
const c=new Client({baseUrl:'https://example.invalid',authMode:'session',credentials:{session:{SessionID:'id',SessionSecret:'secret'}}});
const input:ApiSendInput={id:'command','X-Tenant':'tenant','X-Request-Id':'caller','Idempotency-Key':'saved'};
c.api.send(${style === 'object' ? 'input' : "'command',{'X-Tenant':'tenant'}"});
// @ts-expect-error credential header is supplied by authentication
const duplicateAuth:ApiSendInput={id:'command','X-Tenant':'tenant','x-session-id':'id'};
// @ts-expect-error the configured pin supplies the version
const duplicatePin:ApiSendInput={id:'command','X-Tenant':'tenant','X-Api-Version':'v1'};
// @ts-expect-error an ordinary required header stays required
c.api.send(${style === 'object' ? "{id:'command'}" : "'command',{}"});
`,
    );
    typecheck(consumer);
    const phpArgs =
      style === 'object'
        ? "['id'=>'command','X-Tenant'=>'tenant','X-Request-Id'=>'caller-id','Idempotency-Key'=>'saved-key']"
        : "'command',['X-Tenant'=>'tenant','X-Request-Id'=>'caller-id','Idempotency-Key'=>'saved-key']";
    ok('php', [
      '-r',
      String.raw`
require $argv[1].'/src/Runtime.php';require $argv[1].'/src/Client.php';
$inputClass=new ReflectionClass(Example\Types\ApiSendInput::class);
foreach(['getXSessionId','getXSessionSecret','getXApiVersion'] as $method)if($inputClass->hasMethod($method))throw new Exception('Duplicate header getter');
foreach(['getIdempotencyKey','getXRequestId','getXTenant'] as $method)if(!$inputClass->hasMethod($method))throw new Exception('Ordinary header getter removed');
$seen=[];
$c=new Example\Types\Client(new Example\Types\ClientOptions(baseUrl:'https://example.invalid',authMode:'session',credentials:['session'=>['SessionID'=>'session-id','SessionSecret'=>'session-secret']],transport:function($r)use(&$seen){$seen[]=$r['headers'];return ['status'=>204,'headers'=>['x-request-id'=>'req_007ARQX9HRSSV4DWBYC52DZKJ6'],'body'=>''];}));
` +
        `$response=$c->api->sendWithResponse(${phpArgs},new Example\\Types\\RequestOptions(headers:['X-API-VERSION'=>'ignored']));\n` +
        String.raw`
if($response->meta['requestId']!=='req_007ARQX9HRSSV4DWBYC52DZKJ6')throw new Exception('Request ID metadata');
foreach(['x-session-id'=>'session-id','x-session-secret'=>'session-secret','x-api-version'=>'v1','idempotency-key'=>'saved-key','x-request-id'=>'caller-id','x-tenant'=>'tenant'] as $name=>$value)if($seen[0][$name]!==$value)throw new Exception('Header '.$name);
` +
        `foreach([new Example\\Types\\RequestOptions(credentials:['SessionID'=>'x','SessionSecret'=>'session-secret']),new Example\\Types\\RequestOptions(headers:['X-Session-ID'=>'conflict']),new Example\\Types\\RequestOptions(idempotencyKey:'conflict')] as $options){try{$c->api->send(${phpArgs},$options);throw new Exception('Expected failure');}catch(Example\\Types\\SdkError $e){}}\n` +
        String.raw`
if(count($seen)!==1)throw new Exception('Invalid headers dispatched');
`,
      join(f.output, 'php'),
    ]);
    // Restore the previous compiler's input decisions, leaving the source API unchanged.
    const recordPath = join(f.output, '.sdk-generator.json');
    const record = JSON.parse(readFileSync(recordPath));
    // Simulate a record written before draft/release baseline tracking.
    delete record.baseline;
    const snapshot = restoreCompiledSnapshot(record.compiled);
    const previous = structuredClone(snapshot.plan);
    const oldInput = {
      ...input,
      properties: {
        ...input.properties,
        ...Object.fromEntries(
          op.parameters
            .filter((p) => ['x-session-id', 'X-Session-Secret', 'X-Api-Version'].includes(p.name))
            .map((p) => [p.name, p.schema]),
        ),
      },
    };
    previous.policy.operations.send.input = compileSchemaPolicy(oldInput, 'input');
    const oldModel = compilePhpModel('ApiSendInput', oldInput, false, new Map());
    previous.php.models.find((model) => model.name === 'ApiSendInput').getters = oldModel.getters;
    record.compiled = storeCompiledSnapshot({ ...snapshot, plan: previous });
    writeFileSync(recordPath, JSON.stringify(record));
    const findings = preview(f.contract, f.output).compatibility;
    for (const name of ['x-session-id', 'X-Session-Secret', 'X-Api-Version'])
      assert.ok(
        findings.some((f) => f.severity === 'breaking' && f.subject.endsWith('.input.' + name)),
        JSON.stringify(findings),
      );
    for (const getter of oldModel.getters.filter((getter) =>
      ['x-session-id', 'X-Session-Secret', 'X-Api-Version'].includes(getter.field),
    ))
      assert.ok(
        findings.some(
          (finding) =>
            finding.severity === 'breaking' &&
            finding.subject === 'models.ApiSendInput.' + getter.method,
        ),
        getter.method,
      );
    // The serialized descriptor boundary rejects unknown sources in both targets.
    for (const source of ['unknown', null]) {
      const malformed = structuredClone(compilation.plan.runtime);
      malformed.operations[0].parameters[1].source = source;
      assert.throws(() => assertRuntimePlan(malformed), /invalid compiled parameter/);
      writeFileSync(join(f.dir, 'malformed.json'), JSON.stringify(malformed));
      ok('php', [
        '-r',
        String.raw`
require $argv[1].'/src/Runtime.php';
try{Example\Types\Runtime::assertCompiledPlan(json_decode(file_get_contents($argv[2]),true));throw new Exception('Expected rejection');}catch(InvalidArgumentException $e){if(!str_contains($e->getMessage(),'parameter source'))throw $e;}
`,
        join(f.output, 'php'),
        join(f.dir, 'malformed.json'),
      ]);
    }
  });
}

test('single-scheme credentials omit only authenticated header inputs and preserve dynamic adapters', async (t) => {
  const key = {
    in: 'header',
    name: 'x-key',
    required: true,
    schema: { type: 'string', minLength: 3 },
  };
  const f = fixture(
    t,
    {
      components: { securitySchemes: { Key: { type: 'apiKey', in: 'header', name: 'X-Key' } } },
      paths: {
        '/protected': {
          get: {
            operationId: 'readProtected',
            security: [{ Key: [] }],
            parameters: [
              key,
              { in: 'query', name: 'X-Key', schema: { type: 'string' } },
              { in: 'header', name: 'X-Version', schema: { type: 'string' } },
            ],
            responses: { 204: { description: 'OK' } },
          },
        },
        '/anonymous': {
          get: {
            operationId: 'readAnonymous',
            security: [],
            parameters: [key],
            responses: { 204: { description: 'OK' } },
          },
        },
      },
    },
    { auth: { scheme: 'Key' } },
  );
  const protectedOp = f.contract.operations.find((op) => op.id === 'readProtected');
  const anonymous = f.contract.operations.find((op) => op.id === 'readAnonymous');
  assert.equal(
    Object.hasOwn(inputSchema(protectedOp, undefined, f.contract).properties, 'x-key'),
    false,
  );
  assert.deepEqual(Object.keys(inputSchema(protectedOp, undefined, f.contract).properties), [
    'X-Key',
    'X-Version',
  ]);
  assert.deepEqual(inputSchema(anonymous, undefined, f.contract).required, ['x-key']);
  const raw = { operations: f.contract.operations, auth: f.contract.auth, validation: 'schema' };
  const copy = structuredClone(raw);
  const plan = compileRuntimePlan(raw);
  assert.deepEqual(compileRuntimePlan(raw), plan);
  assert.deepEqual(raw, copy);
  assert.equal(
    plan.operations.find((op) => op.id === 'readProtected').parameters[0].source,
    'authentication',
  );
  assert.equal(
    plan.operations.find((op) => op.id === 'readAnonymous').parameters[0].source,
    undefined,
  );
  const sdk = await import(pathToFileURL(join(f.output, 'node/index.js')));
  const seen = [];
  const c = new sdk.Client({
    baseUrl: 'https://example.invalid',
    token: 'client-key',
    transport: async (url, r) => {
      seen.push({ url, headers: r.headers });
      return new Response(null, { status: 204 });
    },
  });
  await c.api.readProtected({ 'X-Key': 'query-value', 'X-Version': 'manual' });
  await c.api.readAnonymous({ 'x-key': 'ordinary-value' });
  assert.equal(seen[0].url.searchParams.get('X-Key'), 'query-value');
  assert.equal(seen[0].headers['x-key'], 'client-key');
  assert.equal(seen[0].headers['x-version'], 'manual');
  assert.equal(seen[1].headers['x-key'], 'ordinary-value');
  await assert.rejects(c.api.readProtected({ 'x-key': 'stale-value' }), { kind: 'validation' });
  writeFileSync(join(f.dir, 'raw.json'), JSON.stringify(raw));
  ok('php', [
    '-r',
    String.raw`
require $argv[1].'/src/Runtime.php';require $argv[1].'/src/Client.php';
$seen=[];$options=new Example\Types\ClientOptions(baseUrl:'https://example.invalid',token:'client-key',transport:function($r)use(&$seen){$seen[]=$r;return ['status'=>204,'headers'=>[],'body'=>''];});
$c=new Example\Types\Client($options);
$c->api->readProtected(['X-Key'=>'query-value','X-Version'=>'manual']);
$c->api->readAnonymous(['x-key'=>'ordinary-value']);
$r=new Example\Types\Runtime(json_decode(file_get_contents($argv[2]),true),$options);
$r->request('readProtected',['X-Version'=>'manual']);
if($seen[0]['headers']['x-key']!=='client-key'||$seen[1]['headers']['x-key']!=='ordinary-value'||$seen[2]['headers']['x-key']!=='client-key')throw new Exception('Credential routing');
try{$c->api->readProtected(['x-key'=>'stale-value']);throw new Exception('Expected stale input rejection');}catch(Example\Types\SdkError $e){if($e->kind!=='validation')throw $e;}
`,
    join(f.output, 'php'),
    join(f.dir, 'raw.json'),
  ]);
});

for (const named of [false, true]) {
  test(`${named ? 'named' : 'single-scheme'} credential headers validate scalar and array wire values in both targets`, async (t) => {
    const cases = [
      {
        id: 'integer',
        schema: { type: 'integer', minimum: 100, maximum: 200 },
        value: '123',
        invalid: ['99', '123.5', 'invalid'],
      },
      {
        id: 'boolean',
        schema: { type: 'boolean', enum: [true] },
        value: 'true',
        invalid: ['false', 'invalid'],
      },
      { id: 'string', schema: { type: 'string', minLength: 3 }, value: '123', invalid: ['12'] },
      {
        id: 'exact',
        schema: { type: 'integer', format: 'int64' },
        value: '9007199254740993',
        invalid: ['9223372036854775808'],
      },
      { id: 'number', schema: { type: 'number', minimum: 0 }, value: '1.25', invalid: ['-1'] },
      {
        id: 'integers',
        schema: { type: 'array', minItems: 2, items: { type: 'integer', maximum: 3 } },
        value: '1,2',
        invalid: ['1,4', '1'],
      },
      {
        id: 'booleans',
        schema: { type: 'array', items: { type: 'boolean' } },
        value: 'true,false',
        invalid: ['true,invalid'],
      },
      {
        id: 'strings',
        schema: { type: 'array', items: { type: 'string', minLength: 2 } },
        value: 'true,123',
        invalid: ['a,123'],
      },
      {
        id: 'alternative',
        schema: { anyOf: [{ type: 'integer' }, { type: 'array', items: { type: 'integer' } }] },
        value: '1,2',
        invalid: ['invalid'],
      },
    ];
    const f = fixture(
      t,
      {
        components: { securitySchemes: { Key: { type: 'apiKey', in: 'header', name: 'X-Key' } } },
        paths: Object.fromEntries(
          cases.map(({ id, schema }) => [
            '/' + id,
            {
              get: {
                operationId: 'read' + id[0].toUpperCase() + id.slice(1),
                security: [{ Key: [] }],
                parameters: [{ in: 'header', name: 'x-key', required: true, schema }],
                responses: { 204: { description: 'OK' } },
              },
            },
          ]),
        ),
      },
      { auth: named ? { modes: { key: { schemes: ['Key'] } } } : { scheme: 'Key' } },
    );
    const sdk = await import(pathToFileURL(join(f.output, 'node/index.js')));
    for (const scenario of cases) {
      const seen = [];
      const client = (value) =>
        new sdk.Client({
          baseUrl: 'https://example.invalid',
          ...(named ? { authMode: 'key', credentials: { key: { Key: value } } } : { token: value }),
          transport: async (_url, request) => {
            seen.push(request.headers['x-key']);
            return new Response(null, { status: 204 });
          },
        });
      await client(scenario.value).api[
        'read' + scenario.id[0].toUpperCase() + scenario.id.slice(1)
      ]();
      assert.deepEqual(seen, [scenario.value], scenario.id);
      for (const value of scenario.invalid)
        await assert.rejects(
          client(value).api['read' + scenario.id[0].toUpperCase() + scenario.id.slice(1)](),
          { kind: 'validation' },
          scenario.id,
        );
      assert.deepEqual(seen, [scenario.value], 'invalid credentials dispatched: ' + scenario.id);
    }
    writeFileSync(join(f.dir, 'cases.json'), JSON.stringify(cases));
    ok('php', [
      '-r',
      String.raw`
require $argv[1].'/src/Runtime.php';require $argv[1].'/src/Client.php';
$named=$argv[3]==='named';
foreach(json_decode(file_get_contents($argv[2]),true) as $case){
  $seen=[];
  $client=function($value)use($named,&$seen){return new Example\Types\Client(new Example\Types\ClientOptions(baseUrl:'https://example.invalid',token:$named?null:$value,authMode:$named?'key':null,credentials:$named?['key'=>['Key'=>$value]]:[],transport:function($r)use(&$seen){$seen[]=$r['headers']['x-key'];return ['status'=>204,'headers'=>[],'body'=>''];}));};
  $method='read'.ucfirst($case['id']);$client($case['value'])->api->$method();
  foreach($case['invalid'] as $value){try{$client($value)->api->$method();throw new Exception('Invalid credential accepted: '.$method);}catch(Example\Types\SdkError $e){if($e->kind!=='validation')throw $e;}}
  if($seen!==[$case['value']])throw new Exception('Credential wire value: '.$method);
}
`,
      join(f.output, 'php'),
      join(f.dir, 'cases.json'),
      named ? 'named' : 'single',
    ]);
  });
}

test('named modes preserve header inputs outside the operation security requirements', async (t) => {
  const headers = [
    { in: 'header', name: 'x-checkout-id', required: true, schema: { type: 'string' } },
    { in: 'header', name: 'X-Checkout-Secret', schema: { type: 'string' } },
  ];
  const operation = (operationId, security) => ({
    get: { operationId, security, parameters: headers, responses: { 204: { description: 'OK' } } },
  });
  const f = fixture(
    t,
    {
      components: {
        securitySchemes: {
          Bearer: { type: 'http', scheme: 'bearer' },
          CheckoutID: { type: 'apiKey', in: 'header', name: 'X-Checkout-ID' },
          CheckoutSecret: { type: 'apiKey', in: 'header', name: 'X-Checkout-Secret' },
        },
      },
      paths: {
        '/anonymous': operation('anonymous', []),
        '/bearer': operation('bearer', [{ Bearer: [] }]),
        '/checkout': operation('checkout', [{ CheckoutID: [], CheckoutSecret: [] }]),
        '/optional': operation('optional', [{}, { CheckoutID: [], CheckoutSecret: [] }]),
      },
    },
    {
      auth: {
        modes: {
          bearer: { schemes: ['Bearer'] },
          checkout: { schemes: ['CheckoutID', 'CheckoutSecret'] },
        },
      },
    },
  );
  const raw = {
    operations: f.contract.operations,
    authentication: f.contract.authentication,
    validation: 'schema',
  };
  const plan = compileRuntimePlan(raw);
  for (const op of f.contract.operations) {
    const managed = ['checkout', 'optional'].includes(op.id);
    const input = inputSchema(op, undefined, f.contract);
    assert.deepEqual(
      Object.keys(input.properties),
      managed ? [] : ['x-checkout-id', 'X-Checkout-Secret'],
    );
    assert.deepEqual(input.required, managed ? [] : ['x-checkout-id']);
    for (const p of plan.operations.find((candidate) => candidate.id === op.id).parameters)
      assert.equal(p.source, managed ? 'authentication' : undefined, op.id);
  }
  const consumer = join(f.output, 'node/retained.ts');
  writeFileSync(
    consumer,
    `import {Client, type ApiAnonymousInput, type ApiBearerInput} from './index.js';
const c=new Client({baseUrl:'https://example.invalid'});
const anonymous:ApiAnonymousInput={'x-checkout-id':'id','X-Checkout-Secret':'secret'};
const bearer:ApiBearerInput={'x-checkout-id':'id'};
c.api.anonymous(anonymous);c.api.bearer(bearer);c.api.checkout();
// @ts-expect-error the anonymous operation retains the required header
c.api.anonymous({});
// @ts-expect-error the bearer-only operation retains the required header
c.api.bearer({});
`,
  );
  typecheck(consumer);
  const sdk = await import(pathToFileURL(join(f.output, 'node/index.js')));
  const seen = [];
  const c = new sdk.Client({
    baseUrl: 'https://example.invalid',
    authMode: 'bearer',
    credentials: {
      bearer: { Bearer: 'synthetic-token' },
      checkout: { CheckoutID: 'id', CheckoutSecret: 'secret' },
    },
    transport: async (_url, request) => {
      seen.push(request.headers);
      return new Response(null, { status: 204 });
    },
  });
  await c.api.checkout({}, { authMode: 'checkout' });
  assert.equal(seen[0]['x-checkout-id'], 'id');
  for (const method of ['anonymous', 'bearer']) {
    await assert.rejects(c.api[method]({}), { kind: 'validation' });
    // origin/main already rejects these conflicting headers; retaining declarations does not change that guard.
    await assert.rejects(c.api[method]({ 'x-checkout-id': 'id' }), { kind: 'authentication' });
  }
  assert.equal(seen.length, 1);
  writeFileSync(join(f.dir, 'raw.json'), JSON.stringify(raw));
  writeFileSync(join(f.dir, 'plan.json'), JSON.stringify(plan));
  ok('php', [
    '-r',
    String.raw`
require $argv[1].'/src/Runtime.php';require $argv[1].'/src/Client.php';
$raw=json_decode(file_get_contents($argv[2]),true);
$dynamic=Example\Types\Internal\SchemaAdapter::runtimePlan($raw);
$compiled=json_decode(file_get_contents($argv[3]),true);
foreach($dynamic['operations'] as $i=>$op)foreach($op['parameters'] as $j=>$p)if(($p['source']??null)!==($compiled['operations'][$i]['parameters'][$j]['source']??null))throw new Exception('Dynamic classification differs');
foreach([Example\Types\ApiAnonymousInput::class,Example\Types\ApiBearerInput::class] as $class){$r=new ReflectionClass($class);foreach(['getXCheckoutId','getXCheckoutSecret'] as $method)if(!$r->hasMethod($method))throw new Exception('Header getter removed');}
if((new ReflectionClass(Example\Types\ApiCheckoutInput::class))->hasMethod('getXCheckoutId'))throw new Exception('Credential getter retained');
$seen=[];$c=new Example\Types\Client(new Example\Types\ClientOptions(baseUrl:'https://example.invalid',authMode:'bearer',credentials:['bearer'=>['Bearer'=>'synthetic-token'],'checkout'=>['CheckoutID'=>'id','CheckoutSecret'=>'secret']],transport:function($r)use(&$seen){$seen[]=$r['headers'];return ['status'=>204,'headers'=>[],'body'=>''];}));
$c->api->checkout(options:new Example\Types\RequestOptions(authMode:'checkout'));
foreach(['anonymous','bearer'] as $method)foreach([[] ,['x-checkout-id'=>'id']] as $input){try{$c->api->$method($input);throw new Exception('Expected rejection');}catch(Example\Types\SdkError $e){if($e->kind!==($input?'authentication':'validation'))throw $e;}}
if(count($seen)!==1||$seen[0]['x-checkout-id']!=='id')throw new Exception('Credential dispatch');
`,
    join(f.output, 'php'),
    join(f.dir, 'raw.json'),
    join(f.dir, 'plan.json'),
  ]);
  // Model the origin/main declarations: every header was an operation input.
  const recordPath = join(f.output, '.sdk-generator.json');
  const record = JSON.parse(readFileSync(recordPath));
  // Simulate a record written before draft/release baseline tracking.
  delete record.baseline;
  const snapshot = restoreCompiledSnapshot(record.compiled);
  const previous = structuredClone(snapshot.plan);
  for (const op of f.contract.operations) {
    const oldInput = {
      type: 'object',
      properties: Object.fromEntries(headers.map((p) => [p.name, p.schema])),
      required: ['x-checkout-id'],
      additionalProperties: false,
    };
    previous.policy.operations[op.id].input = compileSchemaPolicy(oldInput, 'input');
    const name = 'Api' + op.id[0].toUpperCase() + op.id.slice(1) + 'Input';
    previous.php.models.find((model) => model.name === name).getters = compilePhpModel(
      name,
      oldInput,
      false,
      new Map(),
    ).getters;
  }
  record.compiled = storeCompiledSnapshot({ ...snapshot, plan: previous });
  writeFileSync(recordPath, JSON.stringify(record));
  const findings = preview(f.contract, f.output).compatibility;
  for (const id of ['anonymous', 'bearer'])
    assert.ok(
      !findings.some(
        (f) =>
          f.subject.startsWith(id + '.input') ||
          f.subject.startsWith('models.Api' + id[0].toUpperCase() + id.slice(1) + 'Input.'),
      ),
      JSON.stringify(findings),
    );
  for (const id of ['checkout', 'optional']) {
    for (const p of headers)
      assert.ok(
        findings.some((f) => f.severity === 'breaking' && f.subject === id + '.input.' + p.name),
        JSON.stringify(findings),
      );
    const name = 'Api' + id[0].toUpperCase() + id.slice(1) + 'Input';
    for (const getter of previous.php.models.find((model) => model.name === name).getters)
      assert.ok(
        findings.some(
          (f) => f.severity === 'breaking' && f.subject === 'models.' + name + '.' + getter.method,
        ),
        JSON.stringify(findings),
      );
  }
});

test('declared request-ID requiredness is preserved alongside required managed headers in both targets', async (t) => {
  const f = fixture(
    t,
    {
      paths: {
        '/send': {
          post: {
            operationId: 'send',
            parameters: ['X-Request-Id', 'Idempotency-Key', 'If-Match'].map((name) => ({
              in: 'header',
              name,
              required: true,
              schema: { type: 'string' },
            })),
            responses: { 204: { description: 'OK' } },
          },
        },
      },
    },
    {
      errors: { requestIdHeader: 'X-Request-Id' },
      operations: {
        send: {
          idempotency: {
            header: 'Idempotency-Key',
            retention: '24h',
            scope: 'command',
            auto: false,
          },
          conditional: { header: 'If-Match' },
        },
      },
    },
  );
  assert.deepEqual(inputSchema(f.contract.operations[0], undefined, f.contract).required, [
    'X-Request-Id',
  ]);
  const consumer = join(f.output, 'node/required.ts');
  writeFileSync(
    consumer,
    `import {Client, type ApiSendInput} from './index.js';
const c=new Client({baseUrl:'https://example.invalid'});
const input:ApiSendInput={'X-Request-Id':'caller'};
c.api.send(input,{idempotencyKey:'saved',ifMatch:'tag'});
// @ts-expect-error request-ID headers keep their declared requiredness
const missing:ApiSendInput={};
`,
  );
  typecheck(consumer);
  const sdk = await import(pathToFileURL(join(f.output, 'node/index.js')));
  const seen = [];
  const c = new sdk.Client({
    baseUrl: 'https://example.invalid',
    transport: async (_url, request) => {
      seen.push(request.headers);
      return new Response(null, { status: 204 });
    },
  });
  const options = { idempotencyKey: 'saved', ifMatch: 'tag' };
  await assert.rejects(c.api.send({}, options), { kind: 'validation' });
  await assert.rejects(c.api.send({ 'X-Request-Id': 'caller' }), { kind: 'validation' });
  await c.api.send({ 'X-Request-Id': 'caller' }, options);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]['x-request-id'], 'caller');
  assert.equal(seen[0]['idempotency-key'], 'saved');
  assert.equal(seen[0]['if-match'], 'tag');
  ok('php', [
    '-r',
    String.raw`
require $argv[1].'/src/Runtime.php';require $argv[1].'/src/Client.php';
$seen=[];$c=new Example\Types\Client(new Example\Types\ClientOptions(baseUrl:'https://example.invalid',transport:function($r)use(&$seen){$seen[]=$r['headers'];return ['status'=>204,'headers'=>[],'body'=>''];}));
$options=new Example\Types\RequestOptions(idempotencyKey:'saved',ifMatch:'tag');
foreach([[[],$options],[['X-Request-Id'=>'caller'],null]] as [$input,$o]){try{$c->api->send($input,$o);throw new Exception('Expected required header failure');}catch(Example\Types\SdkError $e){if($e->kind!=='validation')throw $e;}}
$c->api->send(['X-Request-Id'=>'caller'],$options);
if(count($seen)!==1||$seen[0]['x-request-id']!=='caller'||$seen[0]['idempotency-key']!=='saved'||$seen[0]['if-match']!=='tag')throw new Exception('Required header dispatch');
`,
    join(f.output, 'php'),
  ]);
});

test('Node consumers get canonical payload names, closed inputs, integer strings and request-only factories', async (t) => {
  const thing = {
    type: 'object',
    properties: {
      id: { type: 'string' },
      amount: { type: 'integer', format: 'int64' },
      status: { type: 'string', enum: ['pending', 'succeeded'] },
    },
    required: ['id', 'amount', 'status'],
  };
  const input = {
    type: 'object',
    properties: {
      amount: { type: 'integer', format: 'int64' },
      status: { type: 'string', enum: ['pending', 'succeeded'] },
      child: ref('InputChild'),
      ambiguous: { oneOf: [{ type: 'integer', format: 'int64' }, { type: 'string' }] },
      fixed: { type: 'integer', format: 'int64', const: 7 },
      allowed: { type: 'integer', format: 'int64', enum: [7, 8] },
    },
    required: ['amount', 'status'],
  };
  const envelope = (name) => ({
    type: 'object',
    properties: { data: ref(name) },
    required: ['data'],
  });
  const error = { type: 'object', properties: { error: ref('ErrorObject') }, required: ['error'] };
  const f = fixture(
    t,
    {
      components: {
        schemas: {
          Thing: thing,
          GetThingResult: thing,
          NoInputs: { type: 'object', properties: {}, required: [], additionalProperties: false },
          ThingResponse: envelope('Thing'),
          GetThingResponse: envelope('GetThingResult'),
          DistinctThing: { ...thing, required: ['id'] },
          UpdateThingRequest: input,
          CancelUnrelatedRequest: input,
          InputChild: {
            type: 'object',
            properties: { enabled: { type: 'boolean' } },
            required: ['enabled'],
          },
          ErrorObject: {
            type: 'object',
            properties: {
              code: { type: 'string', enum: ['INVALID_AMOUNT', 'NOT_READY'] },
              message: { type: 'string' },
              field: { type: 'string' },
            },
            required: ['code', 'message'],
          },
          LookupRequest: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              expected_version: { type: 'integer', format: 'int64' },
            },
            oneOf: [
              { required: ['id'], not: { required: ['name'] } },
              { required: ['name'], not: { required: ['id'] } },
            ],
          },
        },
      },
      paths: {
        '/thing': {
          post: {
            operationId: 'updateThing',
            requestBody: {
              required: true,
              content: { 'application/json': { schema: ref('UpdateThingRequest') } },
            },
            responses: {
              ...jsonResponse(ref('GetThingResponse')),
              400: { description: 'Invalid', content: { 'application/json': { schema: error } } },
            },
          },
        },
        '/lookup': {
          post: {
            operationId: 'lookupThing',
            requestBody: {
              required: true,
              content: { 'application/json': { schema: ref('LookupRequest') } },
            },
            responses: jsonResponse(ref('GetThingResponse')),
          },
        },
        '/empty': {
          get: { operationId: 'readEmpty', responses: jsonResponse(envelope('NoInputs')) },
        },
        '/choice': {
          get: {
            operationId: 'chooseThing',
            responses: jsonResponse({ oneOf: [envelope('Thing'), envelope('DistinctThing')] }),
          },
        },
      },
    },
    {
      responses: { return: 'payload', payloadPath: 'data' },
      errors: { codePath: 'error.code', messagePath: 'error.message', detailsPath: 'error' },
      operations: {
        updateThing: { resource: 'things', method: 'update' },
        lookupThing: { resource: 'things', method: 'lookup' },
        chooseThing: { resource: 'things', method: 'choose' },
        readEmpty: { resource: 'things', method: 'readEmpty' },
      },
    },
  );
  const { plan } = compileSdkContract(f.contract);
  assert.equal(plan.responseReturns.updateThing.node, 'Thing');
  assert.equal(plan.node.models.GetThingResult.outputAlias, 'Thing');
  assert.equal(plan.node.models.DistinctThing.outputAlias, undefined);
  assert.equal(plan.node.models.Thing.inputReachable, false);
  assert.equal(plan.node.models.NoInputs.inputReachable, false);
  assert.equal(plan.node.models.InputChild.inputReachable, true);
  const historical = structuredClone(plan);
  delete historical.node.models.GetThingResult.outputAlias;
  delete historical.node.models.Thing.inputReachable;
  delete historical.node.operations.updateThing.responseType;
  const breaking = compareCompiledContracts(historical, plan).filter(
    (finding) => finding.severity === 'breaking',
  );
  for (const name of ['GetThingResult', 'Thing']) {
    assert.ok(
      breaking.some(
        (finding) => finding.subject === 'models.' + name && /removed/.test(finding.message),
      ),
    );
  }
  assert.ok(
    breaking.some(
      (finding) =>
        finding.subject === 'updateThing.responseType' &&
        /ThingsUpdateResponse was removed; use/.test(finding.message),
    ),
    JSON.stringify(breaking),
  );
  assert.ok(
    breaking.some((finding) => /GetThingResult was removed; use Thing/.test(finding.message)),
  );
  assert.match(plan.node.operations.updateThing.input, /UpdateThingRequestInput/);
  assert.doesNotMatch(plan.responseReturns.chooseThing.node, /unknown|_SdkPayloadAt/);
  assert.match(plan.responseReturns.chooseThing.node, /Thing.*DistinctThing/);
  for (const corrupt of [
    (runtime) => {
      runtime.errorDetailsCertificate = { type: { kind: 'invalid' }, definitions: {} };
    },
    (runtime) => {
      runtime.operations[0].payloadCodecs = [];
    },
    (runtime) => {
      runtime.operations[0].payloadCodecs = [{ value: { kind: 'invalid' } }];
    },
  ]) {
    const runtime = structuredClone(plan.runtime);
    corrupt(runtime);
    assert.throws(() => assertRuntimePlan(runtime));
  }
  const snapshot = structuredClone(
    restoreCompiledSnapshot(
      JSON.parse(readFileSync(join(f.output, '.sdk-generator.json'), 'utf8')).compiled,
    ),
  );
  snapshot.plan.responseReturns.chooseThing.validate = false;
  assert.throws(() => restoreCompiledSnapshot(snapshot), /payload validation/);
  const source = join(f.output, 'node/consumer.ts');
  writeFileSync(
    source,
    `import {Client, SdkError, errors, makeUpdateThingRequest, makeInputChild, type Thing, type DistinctThing, type InputValue} from './index.js';
const c = new Client({baseUrl:'https://example.invalid'});
const request = makeUpdateThingRequest({amount:9007199254740993n, status:'pending', child:makeInputChild({enabled:true})});
const value: Promise<Thing> = c.things.update({body:request});
c.things.update({body:{amount:'50',status:'succeeded',ambiguous:9007199254740993n,fixed:7n,allowed:8n}});
// @ts-expect-error decimal currency values are not integer minor units
c.things.update({body:{amount:'50.00',status:'pending'}});
// @ts-expect-error formatted currency is not an integer string
c.things.update({body:{amount:'$50',status:'pending'}});
// @ts-expect-error enum inputs are closed
c.things.update({body:{amount:'50',status:'succeded'}});
declare const response: Thing;
const futureComparison = response.status === 'succeded';
const amount: \`\${bigint}\` = response.amount;
// @ts-expect-error exact response strings do not have a fractional part
const fractional: Thing['amount'] = '50.00';
const choice: Promise<Thing | DistinctThing> = c.things.choose();
c.things.lookup({body:{id:'one',expected_version:2n}});
c.things.lookup({body:{name:'one'}});
// @ts-expect-error oneOf fields are mutually exclusive
c.things.lookup({body:{id:'one',name:'one'}});
// @ts-expect-error one alternative is required
c.things.lookup({body:{}});
// @ts-expect-error the declared version retains its integer type
c.things.lookup({body:{id:'one',expected_version:'2.5'}});
declare const error: SdkError;
const code: 'INVALID_AMOUNT' | 'NOT_READY' | (string & {}) | undefined = error.code;
if (error.details && 'field' in error.details) { const field: string | undefined = error.details.field; }
if (error instanceof errors.ValidationError && error.details && 'message' in error.details) { const message: string | undefined = error.details.message; }
// @ts-expect-error response-only factories are absent
import {makeThing} from './index.js';
// @ts-expect-error redundant result names are absent
import type {GetThingResult} from './index.js';
// @ts-expect-error redundant operation response aliases are absent
import type {ThingsUpdateResponse} from './index.js';
const omitted: InputValue<undefined> = undefined;
`,
  );
  typecheck(source);
  const { readdirSync } = await import('node:fs');
  for (const name of readdirSync(join(f.output, 'node/declarations'))) {
    const declaration = readFileSync(join(f.output, 'node/declarations', name), 'utf8');
    assert.doesNotMatch(declaration, /_SdkPayloadAt|InputValue<undefined>/);
    assert.ok(
      declaration.split('\n').every((line) => line.length < 500),
      name,
    );
  }
  const sdk = await import(pathToFileURL(join(f.output, 'node/index.js')));
  assert.equal(sdk.makeThing, undefined);
  const bodies = [];
  let failed = false;
  let malformed = false;
  let unknownPayload = false;
  const client = new sdk.Client({
    baseUrl: 'https://example.invalid',
    transport: async (_url, request) => {
      bodies.push(request.body);
      if (failed)
        return new Response(
          JSON.stringify({
            error: malformed
              ? { code: 'NOT_READY', message: 42 }
              : { code: 'INVALID_AMOUNT', message: 'Invalid amount', field: 'amount' },
          }),
          { status: 400 },
        );
      if (unknownPayload) return new Response('{"data":{"future":true}}');
      return new Response('{"data":{"id":"one","amount":9007199254740993,"status":"future"}}');
    },
  });
  assert.deepEqual(
    { ...(await client.things.update({ body: { amount: 9007199254740993n, status: 'pending' } })) },
    { id: 'one', amount: '9007199254740993', status: 'future' },
  );
  assert.equal(bodies[0], '{"amount":9007199254740993,"status":"pending"}');
  await client.things.update({
    body: { amount: 1n, status: 'pending', ambiguous: 9007199254740993n, fixed: 7n, allowed: 8n },
  });
  assert.equal(
    bodies[1],
    '{"amount":1,"status":"pending","ambiguous":9007199254740993,"fixed":7,"allowed":8}',
  );
  for (const amount of [
    '50.00',
    '5e3',
    '50\n',
    '50\r',
    '50\u2028',
    '01',
    '+50',
    ' 50',
    new sdk.ExactNumber('50.00'),
    new sdk.ExactNumber('5e3'),
  ])
    await assert.rejects(
      client.things.update({ body: { amount, status: 'pending' } }),
      /integer string/,
    );
  // Match the independently expected PHP integer spellings, including explicit wrappers.
  for (const amount of ['0', '-0', '50', '-50', new sdk.ExactNumber('50')]) {
    await client.things.update({ body: { amount, status: 'pending' } });
    assert.equal(
      bodies.at(-1),
      `{"amount":${amount instanceof sdk.ExactNumber ? amount.value : amount},"status":"pending"}`,
    );
  }
  await assert.rejects(
    client.things.lookup({ body: {} }),
    (e) =>
      /alternative 1:.*id.*required/.test(e.message) &&
      /alternative 2:.*name.*required/.test(e.message),
  );
  assert.deepEqual(
    { ...(await client.things.choose()) },
    { id: 'one', amount: '9007199254740993', status: 'future' },
  );
  await assert.rejects(
    client.things.update({ body: { amount: 1n, status: 'pending', fixed: 8n } }),
    { kind: 'validation' },
  );
  unknownPayload = true;
  await assert.rejects(
    client.things.choose(),
    (error) =>
      error.kind === 'protocol' && error.meta.status === 200 && error.raw.includes('future'),
  );
  assert.deepEqual(
    { ...(await client.things.chooseWithResponse()).body },
    { data: { future: true } },
  );
  unknownPayload = false;
  failed = true;
  await assert.rejects(
    client.things.update({ body: { amount: 1n, status: 'pending' } }),
    (e) => e instanceof sdk.SdkError && e.code === 'INVALID_AMOUNT' && e.details.field === 'amount',
  );
  malformed = true;
  await assert.rejects(
    client.things.update({ body: { amount: 1n, status: 'pending' } }),
    (e) => e.details === undefined && e.raw.includes('42'),
  );
});

test('compacted declarations retain inline error-detail references and readable imports', (t) => {
  const dir = mkdtempSync(resolve('.generated/compacted-types-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const files = new Map();
  const names = Array.from({ length: 130 }, (_, i) => 'SyntheticModel' + i);
  for (const name of names)
    files.set(`node/declarations/${name}.d.ts`, `export interface ${name} { field?: string }`);
  files.set(
    'node/runtime.d.ts',
    `export type SdkErrorDetails = import('./declarations/SyntheticModel0.js').SyntheticModel0;`,
  );
  files.set(
    'node/declarations/Client.d.ts',
    `export declare class Client { details: import('./SyntheticModel0.js').SyntheticModel0; }`,
  );
  files.set(
    'node/index.d.ts',
    names.map((name) => `export type { ${name} } from './declarations/${name}.js';`).join('\n') +
      `\nexport type { SdkErrorDetails } from './runtime.js';\nexport { Client } from './declarations/Client.js';`,
  );
  compactNodeDeclarations(files, 'node/');
  assert.match(files.get('node/runtime.d.ts'), /import\(["']\.\/declarations\/types-0\.js["']\)/);
  assert.match(files.get('node/declarations/Client.d.ts'), /import\(["']\.\/types-0\.js["']\)/);
  for (const [path, text] of files) {
    const formatted = formatNodeDeclaration(text);
    assert.ok(
      formatted.split('\n').every((line) => line.length < 500),
      path,
    );
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), formatted);
  }
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  typecheck(join(dir, 'node/index.d.ts'));
});

for (const nesting of ['direct', 'object', 'array', 'nullable']) {
  test(`projected ${nesting} errors and payloads certify the types used by consumers`, async (t) => {
    const object = (properties) => ({
      type: 'object',
      properties,
      required: Object.keys(properties),
    });
    const wrapSchema = (schema) =>
      nesting === 'array'
        ? { type: 'array', items: schema }
        : nesting === 'object'
          ? object({ content: schema })
          : nesting === 'nullable'
            ? { oneOf: [schema, { type: 'null' }] }
            : schema;
    const wrap = (value) =>
      nesting === 'array' ? [value] : nesting === 'object' ? { content: value } : value;
    const unwrap = (value) =>
      nesting === 'array' ? value[0] : nesting === 'object' ? value.content : value;
    const access = nesting === 'array' ? '[0]' : nesting === 'object' ? '.content' : '';
    const errorAccess =
      nesting === 'array'
        ? 'Array.isArray(error.details) && error.details[0]'
        : nesting === 'object'
          ? "error.details && 'content' in error.details && error.details.content"
          : 'error.details';
    const alternatives = (key) => ({
      oneOf: [object({ [key]: ref('FirstDetail') }), object({ [key]: ref('SecondDetail') })],
    });
    const f = fixture(
      t,
      {
        components: {
          schemas: {
            FirstDetail: wrapSchema(
              object({ kind: { type: 'string', enum: ['a'] }, foo: { type: 'string' } }),
            ),
            SecondDetail: wrapSchema(
              object({ kind: { type: 'string', enum: ['b'] }, bar: { type: 'number' } }),
            ),
          },
        },
        paths: {
          '/choice': {
            get: {
              operationId: 'choose',
              responses: {
                ...jsonResponse(alternatives('data')),
                400: {
                  description: 'Invalid',
                  content: { 'application/json': { schema: alternatives('error') } },
                },
              },
            },
          },
        },
      },
      {
        responses: { return: 'payload', payloadPath: 'data' },
        errors: { detailsPath: 'error' },
        operations: { choose: { resource: 'choices', method: 'get' } },
      },
    );
    const source = join(f.output, 'node/consumer.ts');
    writeFileSync(
      source,
      `import {SdkError, type Client} from './index.js';
export function inspectError(error: SdkError) {
  const details = ${errorAccess};
  if (details && 'foo' in details) return details.foo.toUpperCase();
  if (details && 'bar' in details) return details.bar.toFixed(1);
}
export function inspectPayload(value: Awaited<ReturnType<Client['choices']['get']>>) {
  if (!value) return;
  const data = value${access};
  if ('foo' in data) return data.foo.toUpperCase();
  return data.bar.toFixed(1);
}
`,
    );
    typecheck(source, ['--exactOptionalPropertyTypes']);
    writeFileSync(
      join(f.output, 'node/consumer.js'),
      ts.transpileModule(readFileSync(source, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      }).outputText,
    );
    const consumer = await import(pathToFileURL(join(f.output, 'node/consumer.js')));
    const sdk = await import(pathToFileURL(join(f.output, 'node/index.js')));
    let status = 400;
    let value;
    const client = new sdk.Client({
      baseUrl: 'https://example.invalid',
      transport: async () =>
        new Response(JSON.stringify({ [status === 400 ? 'error' : 'data']: value }), { status }),
    });
    for (const [body, expected] of [
      [{ kind: 'future', foo: 42 }, undefined],
      [{ kind: 'a', foo: 42 }, undefined],
      [{ kind: 'future', bar: 'invalid' }, undefined],
      [{ kind: 'future', foo: 42, bar: 1 }, undefined],
      [{ kind: 'future', foo: 'safe', bar: 'invalid' }, undefined],
      [{ kind: 'future' }, undefined],
      [{ kind: 'future', foo: 'safe' }, 'SAFE'],
      [{ kind: 'future', foo: 'safe', future: true }, 'SAFE'],
      [{ kind: 'future', bar: 42 }, '42.0'],
    ]) {
      value = wrap(body);
      await assert.rejects(client.choices.get(), (error) => {
        assert.ok(error instanceof sdk.SdkError);
        assert.equal(consumer.inspectError(error), expected);
        if (expected === undefined) {
          assert.equal(error.details, undefined);
          assert.deepEqual(JSON.parse(error.raw).error, value);
        } else assert.equal(unwrap(error.details).kind, 'future');
        return true;
      });
      status = 200;
      if (expected === undefined)
        await assert.rejects(client.choices.get(), (error) => {
          assert.equal(error.kind, 'protocol');
          assert.deepEqual(JSON.parse(error.raw).data, value);
          return true;
        });
      else assert.equal(consumer.inspectPayload(await client.choices.get()), expected);
      status = 400;
    }
    if (nesting === 'nullable') {
      // Null fits both envelope branches, so the oneOf envelope is ambiguous.
      value = null;
      await assert.rejects(client.choices.get(), (error) => {
        assert.equal(error.details, undefined);
        assert.equal(JSON.parse(error.raw).error, null);
        assert.equal(consumer.inspectError(error), undefined);
        return true;
      });
      status = 200;
      await assert.rejects(client.choices.get(), { kind: 'protocol' });
    }
    const { plan } = compileSdkContract(f.contract);
    assert.equal(plan.php.runtime.errorDetailsCertificate, undefined);
    for (const invalid of [[], [{}]]) {
      const runtime = structuredClone(plan.runtime);
      runtime.errorDetailsCertificate = invalid;
      assert.throws(() => assertRuntimePlan(runtime), /certificate/i);
    }
  });
}

test('nested future alternatives retain uncertainty through property guards on every response surface', async (t) => {
  const object = (properties) => ({
    type: 'object',
    properties,
    required: Object.keys(properties),
  });
  const content = {
    oneOf: [
      object({ kind: { type: 'string', enum: ['a'] }, foo: { type: 'string' } }),
      object({ kind: { type: 'string', enum: ['b'] }, bar: { type: 'number' } }),
    ],
  };
  for (const outer of [false, true]) {
    const payload = object({ content });
    const schema = outer
      ? {
          oneOf: [
            object({ data: payload }),
            object({ data: object({ other: { type: 'string' } }) }),
          ],
        }
      : object({ data: payload });
    const f = fixture(
      t,
      {
        paths: {
          '/nested': {
            get: {
              operationId: 'read',
              responses: {
                ...jsonResponse(schema),
                400: {
                  description: 'Invalid',
                  content: { 'application/json': { schema: object({ error: payload }) } },
                },
              },
            },
          },
        },
      },
      {
        responses: { return: 'payload', payloadPath: 'data' },
        errors: { detailsPath: 'error' },
        operations: { read: { resource: 'api', method: 'read' } },
      },
    );
    const source = join(f.output, 'node/nested.ts');
    writeFileSync(
      source,
      `import {SdkError, type Client} from './index.js';
export function error(e:SdkError) {
 if(e.details && 'content' in e.details && 'foo' in e.details.content) {
  // @ts-expect-error future nested alternatives keep foo unknown
  e.details.content.foo.toUpperCase();
 }
}
export function payload(v:Awaited<ReturnType<Client['api']['read']>>) {
 if('content' in v && 'foo' in v.content) {
  // @ts-expect-error future nested alternatives keep foo unknown
  v.content.foo.toUpperCase();
 }
}
export async function full(c:Client) {
 const v=(await c.api.readWithResponse()).body;
 if('data' in v && v.data && typeof v.data==='object' && 'content' in v.data && v.data.content && typeof v.data.content==='object' && 'foo' in v.data.content) {
  // @ts-expect-error full response alternatives also keep foo unknown
  v.data.content.foo.toUpperCase();
 }
}`,
    );
    typecheck(source, ['--exactOptionalPropertyTypes']);
    const { Client } = await import(pathToFileURL(join(f.output, 'node/index.js')));
    let status = 200;
    const value = { content: { kind: 'future', foo: 42 } };
    const client = new Client({
      baseUrl: 'https://example.invalid',
      transport: async () =>
        new Response(JSON.stringify({ [status === 200 ? 'data' : 'error']: value }), { status }),
    });
    assert.deepEqual(JSON.parse(JSON.stringify(await client.api.read())), value);
    status = 400;
    await assert.rejects(client.api.read(), (e) => {
      assert.deepEqual(e.details, value);
      assert.ok(e.raw.includes('42'));
      return true;
    });
  }
});

test('error certification includes other statuses, operations and built-in detail keys', async (t) => {
  const object = (properties) => ({
    type: 'object',
    properties,
    required: Object.keys(properties),
  });
  const response = (detail) => ({
    description: 'Invalid',
    content: { 'application/json': { schema: object({ error: detail }) } },
  });
  const f = fixture(
    t,
    {
      components: { schemas: { RuntimeErrorDetails: object({ foo: { type: 'string' } }) } },
      paths: {
        '/first': {
          get: {
            operationId: 'first',
            responses: {
              ...jsonResponse({ type: 'string' }),
              400: response(ref('RuntimeErrorDetails')),
              422: response(object({ bar: { type: 'number' } })),
            },
          },
        },
        '/second': {
          get: {
            operationId: 'second',
            responses: {
              ...jsonResponse({ type: 'string' }),
              400: response(object({ baz: { type: 'string' } })),
            },
          },
        },
      },
    },
    {
      errors: { detailsPath: 'error' },
      operations: {
        first: { resource: 'api', method: 'first' },
        second: { resource: 'api', method: 'second' },
      },
    },
  );
  const source = join(f.output, 'node/error-union.ts');
  writeFileSync(
    source,
    `import {SdkError} from './index.js';
export function inspect(e:SdkError) {
 const v=e.details;
 if(!v) return;
 if('foo' in v) v.foo.toUpperCase();
 if('bar' in v) v.bar.toFixed();
 if('baz' in v) v.baz.toUpperCase();
 if('transportCode' in v && v.transportCode!==null) v.transportCode.toUpperCase();
 if('eventId' in v) v.eventId.toUpperCase();
 if('position' in v) v.position.toFixed();
 if('reason' in v) v.reason.toUpperCase();
}`,
  );
  typecheck(source, ['--exactOptionalPropertyTypes']);
  writeFileSync(
    source.replace('.ts', '.js'),
    ts.transpileModule(readFileSync(source, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.ESNext },
    }).outputText,
  );
  const consumer = await import(pathToFileURL(source.replace('.ts', '.js')));
  const sdk = await import(pathToFileURL(join(f.output, 'node/index.js')));
  let detail;
  const client = new sdk.Client({
    baseUrl: 'https://example.invalid',
    transport: async () => new Response(JSON.stringify({ error: detail }), { status: 400 }),
  });
  for (const extra of [
    { bar: 'invalid' },
    { baz: 42 },
    { transportCode: 42 },
    { eventId: 42 },
    { position: 'invalid' },
    { reason: 42 },
    { reason: 'valid key, missing required runtime companions' },
  ]) {
    detail = { foo: 'safe', ...extra };
    await assert.rejects(client.api.first(), (e) => {
      assert.equal(e.details, undefined);
      assert.deepEqual(JSON.parse(e.raw).error, detail);
      assert.doesNotThrow(() => consumer.inspect(e));
      return true;
    });
  }
  detail = { foo: 'safe', future: true };
  await assert.rejects(client.api.first(), (e) => {
    assert.equal(e.details.foo, 'safe');
    assert.doesNotThrow(() => consumer.inspect(e));
    return true;
  });
  for (const detail of [
    { transportCode: 'ETIMEDOUT' },
    { eventId: 'evt_synthetic', position: 1 },
  ]) {
    const e = new sdk.SdkError(
      'transport',
      'Synthetic',
      'unknown',
      false,
      undefined,
      undefined,
      detail,
    );
    assert.deepEqual(e.details, detail);
    assert.doesNotThrow(() => consumer.inspect(e));
  }
  const { plan } = compileSdkContract(f.contract);
  for (const certificate of [
    plan.runtime.errorDetailsCertificate,
    plan.runtime.operations[0].outputCertificate,
  ]) {
    assert.ok(certificate);
    const runtime = structuredClone(plan.runtime);
    runtime.errorDetailsCertificate = { ...certificate, type: { kind: 'unsupported' } };
    assert.throws(() => assertRuntimePlan(runtime), /certificate/);
    runtime.errorDetailsCertificate = {
      ...certificate,
      type: { kind: 'reference', name: 'Missing' },
    };
    assert.throws(() => assertRuntimePlan(runtime), /certificate/);
  }
});

test('the public type certifier also protects pagination, known predicates and known webhook envelopes', async (t) => {
  const object = (properties) => ({
    type: 'object',
    properties,
    required: Object.keys(properties),
  });
  const a = object({ kind: { type: 'string', enum: ['a'] }, foo: { type: 'string' } });
  const b = object({ kind: { type: 'string', enum: ['b'] }, bar: { type: 'number' } });
  const envelope = (data) => object({ data, next: { type: ['string', 'null'] } });
  const schema = {
    oneOf: [envelope({ type: 'array', items: a }), envelope({ type: 'array', items: b })],
  };
  const event = {
    oneOf: [
      object({ type: { type: 'string', enum: ['updated'] }, data: a }),
      object({ type: { type: 'string', enum: ['updated'] }, data: b }),
    ],
  };
  const f = fixture(
    t,
    {
      paths: {
        '/page': {
          get: {
            operationId: 'read',
            parameters: [{ in: 'query', name: 'cursor', schema: { type: 'string' } }],
            responses: jsonResponse(schema),
          },
        },
      },
    },
    {
      responses: { return: 'payload', payloadPath: 'data' },
      operations: {
        read: {
          resource: 'api',
          method: 'read',
          pagination: { kind: 'cursor', items: 'data', next: 'next', parameter: 'cursor' },
        },
      },
      webhook: {
        algorithm: 'hmac-sha256',
        header: 'X-Signature',
        timestampHeader: 'X-Timestamp',
        separator: '.',
        toleranceSeconds: 300,
        typeField: 'type',
        events: { updated: event },
      },
    },
  );
  const source = join(f.output, 'node/surfaces.ts');
  writeFileSync(
    source,
    `import {isApiReadResponseKnown,type Client,type VerifiedWebhook} from './index.js';
type Item=ReturnType<Client['api']['readItems']> extends AsyncGenerator<infer I>?I:never;
export function item(v:Item){if('foo' in v)return v.foo.toUpperCase();return v.bar.toFixed();}
export function known(v:Awaited<ReturnType<Client['api']['readWithResponse']>>){if(isApiReadResponseKnown(v.body))for(const i of v.body.data)item(i);}
export function webhook(v:VerifiedWebhook){if(v.known){if('foo' in v.event.data)return v.event.data.foo.toUpperCase();return v.event.data.bar.toFixed();}}
`,
  );
  typecheck(source, ['--exactOptionalPropertyTypes']);
  writeFileSync(
    source.replace('.ts', '.js'),
    ts.transpileModule(readFileSync(source, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.ESNext },
    }).outputText,
  );
  const consumer = await import(pathToFileURL(source.replace('.ts', '.js')));
  const sdk = await import(pathToFileURL(join(f.output, 'node/index.js')));
  const scoped = await import(pathToFileURL(join(f.output, 'node/predicates/ApiReadResponse.js')));
  let value;
  const client = new sdk.Client({
    baseUrl: 'https://example.invalid',
    transport: async () => new Response(JSON.stringify({ data: [value], next: null })),
  });
  for (const body of [
    { kind: 'future', foo: 42 },
    { kind: 'a', foo: 'safe', bar: 'invalid' },
    { kind: 'a', foo: 'safe' },
  ]) {
    value = body;
    const valid = body.foo === 'safe' && !Object.hasOwn(body, 'bar');
    const full = await client.api.readWithResponse();
    assert.equal(sdk.isApiReadResponseKnown(full.body), valid);
    assert.equal(scoped.isApiReadResponseKnown(full.body), valid);
    assert.doesNotThrow(() => consumer.known(full));
    if (valid)
      assert.deepEqual(await Array.fromAsync(client.api.readItems(), consumer.item), ['SAFE']);
    else
      await assert.rejects(Array.fromAsync(client.api.readItems()), (e) => {
        assert.equal(e.kind, 'protocol');
        assert.deepEqual(JSON.parse(e.raw).data, [body]);
        return true;
      });
    const raw = Buffer.from(JSON.stringify({ type: 'updated', data: body }));
    const signature = createHmac('sha256', 'synthetic').update('1000.').update(raw).digest('hex');
    const verified = sdk.verifyWebhook(
      raw,
      { 'X-Signature': signature, 'X-Timestamp': '1000' },
      'synthetic',
      1000,
    );
    assert.equal(verified.known, valid);
    assert.doesNotThrow(() => consumer.webhook(verified));
    if (!valid) assert.equal(verified.reason, 'unmatched_envelope');
  }
});

for (const extra of [true, { type: 'string' }]) {
  test(`open union payloads and error details retain valid index-signature fields (${JSON.stringify(extra)})`, async (t) => {
    const object = (properties) => ({
      type: 'object',
      properties,
      required: Object.keys(properties),
    });
    const alternatives = (key) => ({
      oneOf: [object({ [key]: ref('OpenDetail') }), object({ [key]: ref('ClosedDetail') })],
    });
    const f = fixture(
      t,
      {
        components: {
          schemas: {
            OpenDetail: {
              ...object({ kind: { type: 'string', enum: ['a'] }, foo: { type: 'string' } }),
              additionalProperties: extra,
            },
            ClosedDetail: object({
              kind: { type: 'string', enum: ['b'] },
              bar: { type: 'number' },
            }),
          },
        },
        paths: {
          '/choice': {
            get: {
              operationId: 'choose',
              responses: {
                ...jsonResponse(alternatives('data')),
                400: {
                  description: 'Invalid',
                  content: { 'application/json': { schema: alternatives('error') } },
                },
              },
            },
          },
        },
      },
      {
        responses: { return: 'payload', payloadPath: 'data' },
        errors: { detailsPath: 'error' },
        operations: { choose: { resource: 'choices', method: 'get' } },
      },
    );
    const source = join(f.output, 'node/open.ts');
    writeFileSync(
      source,
      `import {SdkError,type Client} from './index.js';
export function inspect(v: Awaited<ReturnType<Client['choices']['get']>>) {
 if ('bar' in v) {
 // @ts-expect-error an open member admits bar without promising a number
 v.bar.toFixed();
 }
 if ('bar' in v && typeof v.bar === 'number') return v.bar.toFixed();
}
export function inspectFuture(v: Awaited<ReturnType<Client['choices']['get']>>) {
 if ('future' in v) return v.foo.toUpperCase();
}
export function inspectError(e:SdkError) {
 if(e.details && 'transportCode' in e.details) {
 // @ts-expect-error open API details retain unknown index-signature values
 e.details.transportCode.toUpperCase();
 }
}
`,
    );
    typecheck(source, ['--exactOptionalPropertyTypes']);
    const js = source.replace('.ts', '.js');
    writeFileSync(
      js,
      ts.transpileModule(readFileSync(source, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.ESNext },
      }).outputText,
    );
    const consumer = await import(pathToFileURL(js));
    const sdk = await import(pathToFileURL(join(f.output, 'node/index.js')));
    let status = 200,
      value;
    const client = new sdk.Client({
      baseUrl: 'https://example.invalid',
      transport: async () =>
        new Response(JSON.stringify({ [status === 200 ? 'data' : 'error']: value }), { status }),
    });
    for (const fields of [
      { bar: 'allowed-extra' },
      { future: 'allowed-extra' },
      { transportCode: 'allowed-extra' },
      ...(extra === true ? [{ bar: 42 }, { transportCode: 42 }] : []),
    ]) {
      value = { kind: 'a', foo: 'safe', ...fields };
      status = 200;
      const decoded = await client.choices.get();
      assert.deepEqual({ ...decoded }, value);
      assert.doesNotThrow(() => consumer.inspectFuture(decoded));
      status = 400;
      await assert.rejects(client.choices.get(), (error) => {
        assert.deepEqual({ ...error.details }, value);
        return true;
      });
    }
    // This known closed alternative also fits the open public member, including
    // the required field promised after an arbitrary-key guard.
    status = 200;
    value = { kind: 'b', bar: 42, foo: 'safe', future: true };
    const indexed = await client.choices.get();
    assert.equal(consumer.inspectFuture(indexed), 'SAFE');
    // A closed valid alternative remains accepted; a known malformed field must fail.
    status = 200;
    value = { kind: 'b', bar: 42 };
    assert.deepEqual({ ...(await client.choices.get()) }, value);
    for (const bad of [
      { kind: 'a', foo: 42 },
      { kind: 'b', bar: 'invalid' },
      { kind: 'b', bar: 42, future: true },
    ]) {
      value = bad;
      status = 200;
      await assert.rejects(client.choices.get(), { kind: 'protocol' });
      status = 400;
      await assert.rejects(client.choices.get(), (error) => {
        assert.equal(error.details, undefined);
        assert.deepEqual(JSON.parse(error.raw).error, value);
        return true;
      });
    }
  });
}

test('canonical integer strings uphold bigint template types in projected responses and future errors', async (t) => {
  const object = (properties) => ({
    type: 'object',
    properties,
    required: Object.keys(properties),
  });
  const alternatives = (key) => ({
    oneOf: [object({ [key]: ref('IntegerDetail') }), object({ [key]: ref('OtherDetail') })],
  });
  const f = fixture(
    t,
    {
      components: {
        schemas: {
          IntegerDetail: object({
            kind: { type: 'string', enum: ['a'] },
            amount: { type: 'integer', format: 'int64' },
          }),
          OtherDetail: object({ kind: { type: 'string', enum: ['b'] }, bar: { type: 'number' } }),
        },
      },
      paths: {
        '/choice': {
          get: {
            operationId: 'choose',
            responses: {
              ...jsonResponse(alternatives('data')),
              400: {
                description: 'Invalid',
                content: { 'application/json': { schema: alternatives('error') } },
              },
            },
          },
        },
      },
    },
    {
      responses: { return: 'payload', payloadPath: 'data' },
      errors: { detailsPath: 'error' },
      operations: { choose: { resource: 'choices', method: 'get' } },
    },
  );
  const source = join(f.output, 'node/integer.ts');
  writeFileSync(
    source,
    `import {SdkError,type Client} from './index.js';
export function inspect(e:SdkError): \`\${bigint}\`|undefined {
 if(e.details && 'amount' in e.details) return e.details.amount;
}
export function payload(v:Awaited<ReturnType<Client['choices']['get']>>): \`\${bigint}\`|undefined {
 if('amount' in v) return v.amount;
}
const canonical: \`\${bigint}\`[]=['0','-0','1','-1','9007199254740993'];
// @ts-expect-error noncanonical integer spelling
const plus: \`\${bigint}\`='+1';
// @ts-expect-error noncanonical integer spelling
const leading: \`\${bigint}\`='01';
// @ts-expect-error noncanonical integer spelling
const negative: \`\${bigint}\`='-01';
// @ts-expect-error trailing newline
const newline: \`\${bigint}\`='1\\n';
`,
  );
  typecheck(source, ['--exactOptionalPropertyTypes']);
  const sdk = await import(pathToFileURL(join(f.output, 'node/index.js')));
  let amount,
    status = 200,
    kind = 'future';
  const client = new sdk.Client({
    baseUrl: 'https://example.invalid',
    transport: async () =>
      new Response(JSON.stringify({ [status === 200 ? 'data' : 'error']: { kind, amount } }), {
        status,
      }),
  });
  for (const spelling of ['0', '-0', '1', '-1', '9007199254740993']) {
    amount = spelling;
    status = 200;
    assert.equal((await client.choices.get()).amount, spelling);
    status = 400;
    await assert.rejects(client.choices.get(), (e) => {
      assert.equal(e.details.amount, spelling);
      return true;
    });
  }
  for (const spelling of ['+1', '01', '-01', '1\n', '1.0', '$50']) {
    amount = spelling;
    status = 200;
    await assert.rejects(client.choices.get(), (e) => {
      assert.equal(e.kind, 'protocol');
      assert.equal(JSON.parse(e.raw).data.amount, spelling);
      return true;
    });
    status = 400;
    await assert.rejects(client.choices.get(), (e) => {
      assert.equal(e.details, undefined);
      assert.equal(JSON.parse(e.raw).error.amount, spelling);
      return true;
    });
  }
  // JSON number tokens still decode to canonical exact decimal strings.
  kind = 'a';
  amount = 42;
  status = 200;
  assert.equal((await client.choices.get()).amount, '42');
});
