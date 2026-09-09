import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { loadContract, generate } from '../dist/index.js';

const root = mkdtempSync(join(tmpdir(), 'sdk-runtime-cost-'));
after(() => rmSync(root, { recursive: true, force: true }));
function emit(schema, schemas = {}) {
  const dir = mkdtempSync(join(root, 'case-'));
  const content = { 'application/json': { schema } };
  writeFileSync(
    join(dir, 'api.json'),
    JSON.stringify({
      openapi: '3.1.1',
      info: { title: 'Review', version: '1' },
      paths: {
        '/value': {
          post: {
            operationId: 'sendValue',
            requestBody: { content },
            responses: { 200: { description: 'Value', content } },
          },
        },
      },
      components: { schemas },
    }),
  );
  writeFileSync(
    join(dir, 'sdk.json'),
    JSON.stringify({
      version: '1.0.0',
      validation: 'schema',
      npm: { name: 'review-sdk' },
      composer: { name: 'review/sdk', namespace: 'ReviewSdk' },
    }),
  );
  const out = join(dir, 'out');
  generate(loadContract(join(dir, 'api.json'), join(dir, 'sdk.json')), out);
  return { dir, out };
}
function run(command, args) {
  // A few dozen objects must finish promptly. The former repeated matching
  // takes exponential time at this depth, far beyond this generous process limit.
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 0, String(result.error ?? '') + result.stdout + result.stderr);
}

test('array item declarations survive separate conjuncts without narrowing nullable arrays or other instances', async () => {
  for (const nullable of [false, true]) {
    const { out } = emit(
      {
        $ref: '#/components/schemas/Values',
        type: nullable ? ['array', 'null'] : 'array',
      },
      { Values: { items: { type: 'string' } } },
    );
    const consumer = join(out, 'node/consumer.ts');
    writeFileSync(
      consumer,
      `import {Client, type ValuesInput} from './index.js';
const c = new Client({baseUrl:'https://example.invalid'});
c.api.sendValue({body:['abc']}).then(({data})=>{
  ${nullable ? 'if(data === null)return;' : ''}
  const item:string = data[0]!;
});
// @ts-expect-error items retain their string type
c.api.sendValue({body:[123]});
${nullable ? '' : '// @ts-expect-error a nonnullable array excludes null'}
c.api.sendValue({body:null});
const unrelated:ValuesInput = 123; // Items alone do not require an array.
`,
    );
    run(process.execPath, [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '--strict',
      '--skipLibCheck',
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      consumer,
    ]);
    const { Client } = await import(pathToFileURL(join(out, 'node/index.js')));
    let sent = 0;
    const c = new Client({
      baseUrl: 'https://example.invalid',
      transport: async (_url, request) => {
        sent++;
        return new Response(request.body);
      },
    });
    assert.deepEqual((await c.api.sendValue({ body: ['abc'] })).data, ['abc']);
    await assert.rejects(c.api.sendValue({ body: [123] }), { kind: 'validation' });
    assert.equal(sent, 1);
    if (nullable) assert.equal((await c.api.sendValue({ body: null })).data, null);
    else await assert.rejects(c.api.sendValue({ body: null }), { kind: 'validation' });
  }
});

test('deep untagged recursive alternatives finish in both clients and preserve mode-specific validation', () => {
  for (const keyword of ['oneOf', 'anyOf']) {
    const amount = { type: 'integer', format: 'int64', minimum: 5 };
    const tree = {
      [keyword]: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'amount'],
          properties: { kind: { type: 'string', enum: ['leaf'] }, amount },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'amount', 'child'],
          properties: {
            kind: { type: 'string', enum: ['node'] },
            amount,
            child: { $ref: '#/components/schemas/Tree' },
          },
        },
      ],
    };
    const { dir, out } = emit({ $ref: '#/components/schemas/Tree' }, { Tree: tree });
    let valid = { kind: 'leaf', amount: '5' };
    for (let i = 0; i < 32; i++) valid = { kind: 'node', amount: '5', child: valid };
    const invalid = structuredClone(valid);
    let leaf = invalid;
    while (leaf.child) leaf = leaf.child;
    leaf.amount = '1';
    const future = structuredClone(valid);
    future.extra = 'future field';
    const wire = (value) =>
      JSON.stringify(value, (key, child) => (key === 'amount' ? Number(child) : child));
    const cases = {
      valid,
      invalid,
      future,
      validWire: wire(valid),
      invalidWire: wire(invalid),
      futureWire: wire(future),
    };
    writeFileSync(join(dir, 'cases.json'), JSON.stringify(cases));
    const node = join(dir, 'consumer.mjs');
    writeFileSync(
      node,
      `import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Client} from ${JSON.stringify(pathToFileURL(join(out, 'node/index.js')).href)};
const cases=JSON.parse(readFileSync(process.argv[2],'utf8'));
let sent=0, response=cases.validWire;
const c=new Client({baseUrl:'https://example.invalid',transport:async(_url,r)=>{
  sent++; if(r.body!==undefined)assert.equal(r.body,cases.validWire);
  return new Response(response);
}});
const plain=v=>JSON.parse(JSON.stringify(v));
assert.deepEqual(plain((await c.api.sendValue({body:cases.valid})).data),cases.valid);
await assert.rejects(c.api.sendValue({body:cases.invalid}),{kind:'validation'});
await assert.rejects(c.api.sendValue({body:cases.future}),{kind:'validation'});
assert.equal(sent,1);
// An unmatched response retains its raw unknown numeric values. A uniquely
// matching response with future fields retains the declared exact strings.
response=cases.invalidWire;
assert.deepEqual(plain((await c.api.sendValue({})).data),JSON.parse(cases.invalidWire));
response=cases.futureWire;
assert.deepEqual(plain((await c.api.sendValue({})).data),cases.future);
`,
    );
    run(process.execPath, [node, join(dir, 'cases.json')]);
    const php = join(dir, 'consumer.php');
    writeFileSync(
      php,
      String.raw`<?php
require $argv[1].'/src/Runtime.php';require $argv[1].'/src/Client.php';
$cases=json_decode(file_get_contents($argv[2]),false,512,JSON_THROW_ON_ERROR);
$sent=0;$response=$cases->validWire;
$c=new ReviewSdk\Client(new ReviewSdk\ClientOptions('https://example.invalid',transport:function($r)use(&$sent,&$response,$cases){
  $sent++;if($r['body']!==null&&$r['body']!==$cases->validWire)throw new Exception('wrong wire');
  return ['status'=>200,'headers'=>[],'body'=>$response];
}));
function same($a,$b){if(json_encode($a)!==json_encode($b))throw new Exception('wrong data');}
same($c->api->sendValue(new ReviewSdk\ApiSendValueInput(['body'=>$cases->valid]))->data,$cases->valid);
foreach([$cases->invalid,$cases->future] as $bad){
  try{$c->api->sendValue(new ReviewSdk\ApiSendValueInput(['body'=>$bad]));throw new Exception('invalid accepted');}
  catch(ReviewSdk\SdkError $e){if($e->kind!=='validation')throw $e;}
}
if($sent!==1)throw new Exception('invalid input dispatched');
$response=$cases->invalidWire;same($c->api->sendValue(new ReviewSdk\ApiSendValueInput())->data,json_decode($cases->invalidWire));
$response=$cases->futureWire;same($c->api->sendValue(new ReviewSdk\ApiSendValueInput())->data,$cases->future);
`,
    );
    run('php', [php, join(out, 'php'), join(dir, 'cases.json')]);
  }
});

test('synchronous response decoding cannot report success after the overall deadline', () => {
  const { dir, out } = emit({ type: 'string' });
  // Simulate a slow synchronous codec, independently of processor speed and
  // schema complexity. The real public client must account for this elapsed time.
  const nodeRuntime = join(out, 'node/runtime.js');
  const original = readFileSync(nodeRuntime, 'utf8');
  const entry = 'export function executeCodec(value, s, context) {';
  assert.ok(original.includes(entry));
  writeFileSync(
    nodeRuntime,
    original.replace(
      entry,
      entry +
        `
if(context.mode==='response'){const until=performance.now()+40;while(performance.now()<until){}}
`,
    ),
  );
  const node = join(dir, 'deadline.mjs');
  writeFileSync(
    node,
    `import assert from 'node:assert/strict';
import {Client} from ${JSON.stringify(pathToFileURL(join(out, 'node/index.js')).href)};
const diagnostics=[];
const c=new Client({baseUrl:'https://example.invalid',diagnostics:e=>diagnostics.push(e),transport:async()=>new Response('"ok"',{headers:{'x-request-id':'slow'}})});
await assert.rejects(c.api.sendValue({}, {deadlineMs:20}),e=>e.kind==='deadline'&&e.outcome==='response'&&e.retryAllowed===false&&e.meta.requestId==='slow');
assert.equal(diagnostics.at(-1).errorKind,'deadline');
assert.equal((await c.api.sendValue({}, {deadlineMs:1000})).data,'ok');
`,
  );
  run(process.execPath, [node]);
  const phpRuntime = join(out, 'php/src/Runtime.php');
  const phpSource = readFileSync(phpRuntime, 'utf8');
  const slow = phpSource.replace(
    /(public static function execute\([^)]*\): mixed\s*\{)/,
    `$1
if (($context['mode'] ?? '') === 'response') { usleep(40000); }
`,
  );
  assert.notEqual(slow, phpSource);
  writeFileSync(phpRuntime, slow);
  const php = join(dir, 'deadline.php');
  writeFileSync(
    php,
    String.raw`<?php
require $argv[1].'/src/Runtime.php';require $argv[1].'/src/Client.php';
$events=[];
$c=new ReviewSdk\Client(new ReviewSdk\ClientOptions('https://example.invalid',diagnostics:function($e)use(&$events){$events[]=$e;},transport:fn($r)=>['status'=>200,'headers'=>['x-request-id'=>'slow'],'body'=>'"ok"']));
try{$c->api->sendValue(new ReviewSdk\ApiSendValueInput(),new ReviewSdk\RequestOptions(deadlineMs:20));throw new Exception('late success');}
catch(ReviewSdk\SdkError $e){if($e->kind!=='deadline'||$e->outcome!=='response'||$e->retryAllowed||$e->meta['requestId']!=='slow')throw $e;}
if(end($events)['errorKind']!=='deadline')throw new Exception('missing diagnostic');
if($c->api->sendValue(new ReviewSdk\ApiSendValueInput(),new ReviewSdk\RequestOptions(deadlineMs:1000))->data!=='ok')throw new Exception('control');
`,
  );
  run('php', [php, join(out, 'php')]);
});

test('overlapping recursive anyOf reuses branch views in requests and responses', () => {
  for (const numeric of [false, true]) {
    const tree = {
      anyOf: [
        {
          type: 'object',
          properties: {
            child: { $ref: '#/components/schemas/Tree' },
            ...(numeric
              ? {
                  amount: { type: 'number' },
                  detail: {
                    anyOf: [
                      {},
                      { type: 'object', properties: { a: { type: 'number' }, b: { enum: [5] } } },
                    ],
                  },
                }
              : {}),
          },
        },
        numeric
          ? {
              type: 'object',
              properties: {
                other: { type: 'number' },
                detail: { type: 'object', properties: { b: { type: 'number' } } },
              },
            }
          : {},
      ],
    };
    const { dir, out } = emit({ $ref: '#/components/schemas/Tree' }, { Tree: tree });
    const entry = () => (numeric ? { amount: '5', other: '6', detail: { a: '5', b: '5' } } : {});
    let body = entry();
    for (let i = 0; i < 32; i++) body = { ...entry(), child: body };
    const wire = JSON.stringify(body, (key, value) =>
      ['amount', 'other', 'a', 'b'].includes(key) ? Number(value) : value,
    );
    writeFileSync(join(dir, 'cases.json'), JSON.stringify({ body, wire }));
    const node = join(dir, 'overlap.mjs');
    writeFileSync(
      node,
      `import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Client} from ${JSON.stringify(pathToFileURL(join(out, 'node/index.js')).href)};
const {body,wire}=JSON.parse(readFileSync(process.argv[2],'utf8'));
let sent=0;
const c=new Client({baseUrl:'https://example.invalid',transport:async(_url,r)=>{
  sent++;if(r.body!==undefined)assert.equal(r.body,wire);
  return new Response(wire);
}});
assert.deepEqual(JSON.parse(JSON.stringify((await c.api.sendValue({body})).data)),body);
assert.deepEqual(JSON.parse(JSON.stringify((await c.api.sendValue({})).data)),body);
assert.equal(sent,2);
`,
    );
    run(process.execPath, [node, join(dir, 'cases.json')]);
    const php = join(dir, 'overlap.php');
    writeFileSync(
      php,
      String.raw`<?php
require $argv[1].'/src/Runtime.php';require $argv[1].'/src/Client.php';
$cases=json_decode(file_get_contents($argv[2]),false,512,JSON_THROW_ON_ERROR);$sent=0;
$c=new ReviewSdk\Client(new ReviewSdk\ClientOptions('https://example.invalid',transport:function($r)use($cases,&$sent){
  $sent++;if($r['body']!==null && $r['body']!==$cases->wire)throw new Exception('wrong wire');
  return ['status'=>200,'headers'=>[],'body'=>$cases->wire];
}));
foreach([new ReviewSdk\ApiSendValueInput(['body'=>$cases->body]),new ReviewSdk\ApiSendValueInput()] as $input){
  if(json_encode($c->api->sendValue($input)->data)!==json_encode($cases->body))throw new Exception('wrong response');
}
if($sent!==2)throw new Exception('wrong attempts');
`,
    );
    run('php', [php, join(out, 'php'), join(dir, 'cases.json')]);
  }
});
