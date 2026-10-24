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
import { splitNodeDeclarations } from '../dist/package-render.js';

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
function typecheck(path) {
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

test('structurally shared results retain source component names, exported shapes and PHP identities', async (t) => {
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
  assert.equal(a.plan.node.operations.createAlpha.output, 'AlphaResponse');
  assert.equal(a.plan.node.operations.createBeta.output, 'BetaResponse');
  assert.equal(a.plan.node.operations.getAlpha.output, 'AlphaResult');
  // Codec identity remains shared, independently of the public Node name.
  assert.equal(
    a.plan.runtime.operations[0].responses['200'].codec.fields.data.reference,
    'BetaResult',
  );
  assert.equal(
    a.plan.runtime.operations[1].responses['200'].codec.fields.data.reference,
    'BetaResult',
  );
  assert.match(
    readFileSync(join(f.output, 'node/declarations/AlphaResult.d.ts'), 'utf8'),
    /export type AlphaResult = \{ "id": string; \};/,
  );
  assert.match(
    readFileSync(join(f.output, 'node/declarations/BetaResult.d.ts'), 'utf8'),
    /export interface BetaResult extends AlphaResult \{\}/,
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
    `import {Client, type AlphaResult, type BetaResult, type AlphaResponse} from './index.js';
const c = new Client({baseUrl:'https://example.invalid'});
const alpha = c.alpha.create();
const beta = c.beta.create();
const direct = c.alpha.get();
const existingAlpha: Promise<AlphaResult> = alpha;
const existingBeta: Promise<BetaResult> = beta;
const response: Promise<AlphaResponse> = c.alpha.createWithResponse().then(r => r.body);
import {Client as ScopedClient, type AlphaResult as ScopedResult, type BetaResult as PreviousScopedResult} from './resources/alpha.js';
const scoped: Promise<ScopedResult> = new ScopedClient({baseUrl:'https://example.invalid'}).alpha.create();
const previousScoped: Promise<PreviousScopedResult> = scoped;
type OwnedNullable = AlphaResult | null;
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
  assert.equal(names.get('alpha'), 'AlphaResult');
  assert.equal(names.get('beta'), 'BetaResult');
  assert.equal(names.get('direct'), 'AlphaResult');
  assert.equal(names.get('scoped'), 'AlphaResult');
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
  const snapshot = restoreCompiledSnapshot(record.compiled);
  const previous = structuredClone(snapshot.plan);
  previous.node.operations.createAlpha.output = previous.node.operations.createBeta.output;
  previous.responseReturns.createAlpha.node = previous.responseReturns.createBeta.node;
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
        return new Response(null, { status: 204, headers: { 'X-Request-Id': 'req_007ARQX9HRSSV4DWBYC52DZKJ6' } });
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
