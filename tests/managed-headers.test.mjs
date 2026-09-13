import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { loadContract, generate, preview } from '../dist/index.js';

for (const style of ['object', 'positional']) {
  test(`managed headers honor requiredness, precedence and retries in both ${style} clients`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'sdk-managed-headers-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const header = (name, schema) => ({ in: 'header', name, required: true, schema });
    const operation = (operationId, parameters) => ({
      operationId,
      parameters,
      responses: { 204: { description: 'OK' } },
    });
    const api = {
      openapi: '3.1.0',
      info: { title: 'Managed headers', version: '1' },
      paths: {
        '/value': {
          post: operation('sendValue', [
            header('If-Match', { type: 'string', enum: ['tag_old', 'tag_new'] }),
            header('X-Api-Version', { type: 'string', enum: ['v1', 'v2'] }),
            header('Idempotency-Key', { type: 'string', minLength: 3 }),
          ]),
        },
        '/strict': {
          post: operation('strictKey', [
            header('Idempotency-Key', { type: 'string', enum: ['key_saved'] }),
          ]),
        },
        '/plain': { post: operation('plain', [header('X-Tenant', { type: 'string' })]) },
        '/bad-version': {
          post: operation('badVersion', [
            header('X-Api-Version', { type: 'string', enum: ['v1'] }),
          ]),
        },
      },
    };
    const idempotency = {
      header: 'idempotency-key',
      retention: '24h',
      scope: 'command',
      auto: true,
    };
    const config = {
      version: '1.0.0',
      npm: { name: 'managed-header-sdk' },
      composer: { name: 'example/managed-headers', namespace: 'ManagedHeaders' },
      validation: 'schema',
      requests: { style },
      apiVersion: { header: 'x-api-version', value: 'v2' },
      operations: {
        sendValue: {
          conditional: { header: 'if-match' },
          idempotency,
          retry: { maxAttempts: 2, statuses: [503], transport: false, baseDelayMs: 0 },
        },
        strictKey: { idempotency },
      },
    };
    writeFileSync(join(dir, 'api.json'), JSON.stringify(api));
    writeFileSync(join(dir, 'sdk.json'), JSON.stringify(config));
    const contract = loadContract(join(dir, 'api.json'), join(dir, 'sdk.json'));
    const out = join(dir, 'out');
    generate(contract, out);
    assert.equal(preview(contract, out).changes.length, 0);
    const cases = [
      {
        name: 'automatic key and required precondition option',
        input: {},
        options: { ifMatch: 'tag_new' },
        tag: 'tag_new',
        auto: true,
      },
      {
        name: 'mixed-case request headers',
        input: {},
        options: {
          headers: {
            'IF-MATCH': 'tag_old',
            'IDEMPOTENCY-KEY': 'header_key',
            'X-API-VERSION': 'v1',
          },
        },
        tag: 'tag_old',
        key: 'header_key',
      },
      {
        name: 'options override inputs; version pin wins',
        input: { 'If-Match': 'tag_old', 'X-Api-Version': 'v1', 'Idempotency-Key': 'same_key' },
        options: { ifMatch: 'tag_new', idempotencyKey: 'same_key' },
        tag: 'tag_new',
        key: 'same_key',
      },
      {
        name: 'same automatic key across retries',
        input: {},
        options: { ifMatch: 'tag_new' },
        tag: 'tag_new',
        auto: true,
        retry: true,
      },
      { name: 'missing precondition', input: {}, options: {}, error: true },
      {
        name: 'invalid option precondition',
        input: {},
        options: { ifMatch: 'invalid' },
        error: true,
      },
      {
        name: 'invalid header precondition',
        input: {},
        options: { headers: { 'IF-MATCH': 'invalid' } },
        error: true,
      },
      {
        name: 'short explicit key',
        input: {},
        options: { ifMatch: 'tag_new', idempotencyKey: 'x' },
        error: true,
      },
      {
        name: 'empty explicit key is not replaced',
        input: {},
        options: { ifMatch: 'tag_new', idempotencyKey: '' },
        error: true,
      },
      {
        name: 'conflicting explicit keys',
        input: { 'Idempotency-Key': 'input_key' },
        options: { ifMatch: 'tag_new', idempotencyKey: 'other_key' },
        error: true,
      },
      {
        name: 'conflicting header keys',
        input: {},
        options: {
          ifMatch: 'tag_new',
          idempotencyKey: 'option_key',
          headers: { 'IDEMPOTENCY-KEY': 'other_key' },
        },
        error: true,
      },
      {
        name: 'automatic key must satisfy schema',
        operation: 'strictKey',
        input: {},
        options: {},
        error: true,
      },
      {
        name: 'schema-compatible explicit key',
        operation: 'strictKey',
        input: {},
        options: { idempotencyKey: 'key_saved' },
        key: 'key_saved',
      },
      {
        name: 'version pin must satisfy the schema even with a valid input',
        operation: 'badVersion',
        input: { 'X-Api-Version': 'v1' },
        options: {},
        error: true,
      },
      {
        name: 'ordinary required inputs stay required',
        operation: 'plain',
        input: {},
        options: {},
        error: true,
      },
      {
        name: 'ordinary input control',
        operation: 'plain',
        input: { 'X-Tenant': 'tenant' },
        options: {},
        tenant: 'tenant',
      },
    ];
    const { Client } = await import(pathToFileURL(join(out, 'node/index.js')));
    for (const scenario of cases) {
      const requests = [];
      const client = new Client({
        baseUrl: 'https://example.invalid',
        transport: async (_url, request) => {
          requests.push(request);
          return new Response(null, {
            status: scenario.retry && requests.length === 1 ? 503 : 204,
          });
        },
      });
      const call = () =>
        client.api[scenario.operation ?? 'sendValue'](scenario.input, scenario.options);
      if (scenario.error) {
        await assert.rejects(call(), { kind: 'validation' }, scenario.name);
        assert.equal(requests.length, 0, scenario.name);
      } else {
        await call();
        assert.equal(requests.length, scenario.retry ? 2 : 1, scenario.name);
        for (const request of requests) {
          assert.equal(request.headers['x-api-version'], 'v2', scenario.name);
          if (scenario.tag) assert.equal(request.headers['if-match'], scenario.tag, scenario.name);
          if (scenario.key)
            assert.equal(request.headers['idempotency-key'], scenario.key, scenario.name);
          if (scenario.tenant)
            assert.equal(request.headers['x-tenant'], scenario.tenant, scenario.name);
          if (scenario.auto) assert.match(request.headers['idempotency-key'], /^[a-f0-9-]{32,36}$/);
        }
        if (scenario.retry)
          assert.equal(
            requests[0].headers['idempotency-key'],
            requests[1].headers['idempotency-key'],
          );
      }
    }
    // Required managed headers must not force duplicate arguments in generated types.
    writeFileSync(
      join(out, 'node/check.ts'),
      `import {Client, type ApiSendValueInput} from './index.js';
const c = new Client({baseUrl:'https://example.invalid'});
const input: ApiSendValueInput = {};
c.api.sendValue({}, {ifMatch:'tag_new'});
c.api.sendValue(undefined, {ifMatch:'tag_new'});
// @ts-expect-error ordinary required inputs remain required
c.api.plain({});
`,
    );
    execFileSync(process.execPath, [
      'node_modules/typescript/bin/tsc',
      '--strict',
      '--noEmit',
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--typeRoots',
      resolve('node_modules/@types'),
      join(out, 'node/check.ts'),
    ]);
    writeFileSync(join(dir, 'cases.json'), JSON.stringify(cases));
    execFileSync('php', [
      '-r',
      String.raw`
require $argv[1].'/src/Runtime.php'; require $argv[1].'/src/Client.php';
$cases=json_decode(file_get_contents($argv[2]),true,512,JSON_THROW_ON_ERROR);
foreach($cases as $case){
 $requests=[];
 $c=new ManagedHeaders\Client(new ManagedHeaders\ClientOptions(baseUrl:'https://example.invalid',transport:function($r)use(&$requests,$case){
  $requests[]=$r;return ['status'=>!empty($case['retry'])&&count($requests)===1?503:204,'headers'=>[],'body'=>''];
 }));
 $error=null;
 try{$method=$case['operation']??'sendValue';$c->api->$method($case['input'],new ManagedHeaders\RequestOptions(...$case['options']));}
 catch(ManagedHeaders\SdkError $e){$error=$e;}
 if(!empty($case['error'])){
  if($error?->kind!=='validation'||count($requests)!==0)throw new Exception($case['name']);
 }else{
  if($error)throw $error;
  if(count($requests)!==(!empty($case['retry'])?2:1))throw new Exception($case['name']);
  foreach($requests as $request){
   $h=$request['headers'];
   if($h['x-api-version']!=='v2')throw new Exception('version pin');
   foreach(['tag'=>'if-match','key'=>'idempotency-key','tenant'=>'x-tenant'] as $field=>$header)
    if(isset($case[$field])&&($h[$header]??null)!==$case[$field])throw new Exception($case['name']);
   if(!empty($case['auto'])&&!preg_match('/^[a-f0-9-]{32,36}$/D',$h['idempotency-key']))throw new Exception('automatic key');
  }
  if(!empty($case['retry'])&&$requests[0]['headers']['idempotency-key']!==$requests[1]['headers']['idempotency-key'])throw new Exception('retry key changed');
 }
}
`,
      join(out, 'php'),
      join(dir, 'cases.json'),
    ]);
    // Synthesized examples retain required conditional values in their inputs.
    assert.match(readFileSync(join(out, 'node/examples/api-sendValue.mjs'), 'utf8'), /tag_old/);
    config.operations.sendValue.example = {};
    writeFileSync(join(dir, 'sdk.json'), JSON.stringify(config));
    assert.throws(
      () =>
        generate(
          loadContract(join(dir, 'api.json'), join(dir, 'sdk.json')),
          join(dir, 'invalid-example'),
        ),
      /required example input If-Match is missing/,
    );
  });
}
