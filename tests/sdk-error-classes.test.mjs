import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { inspect } from 'node:util';
import { createHmac } from 'node:crypto';
import { build } from 'esbuild';
import { generate, loadContract, preview } from '../dist/index.js';
import { compileSdkContract } from '../dist/target-plan.js';
import { compareCompiledContracts } from '../dist/compiled-compatibility.js';
import { storeCompiledSnapshot, restoreCompiledSnapshot } from '../dist/compiled-record.js';
import { reservePublicSymbols } from '../dist/public-symbols.js';

const root = mkdtempSync(join(tmpdir(), 'sdk-error-classes-'));
after(() => rmSync(root, { recursive: true, force: true }));
let sequence = 0;
const classes = {
  transport: 'ConnectionError',
  authentication: 'AuthenticationError',
  validation: 'ValidationError',
  rate_limit: 'RateLimitError',
  not_found: 'NotFoundError',
  conflict: 'ConflictError',
  server: 'ServerError',
  api: 'ApiError',
  protocol: 'ProtocolError',
  cancelled: 'CancelledError',
  deadline: 'DeadlineError',
  destination: 'DestinationError',
};
const statuses = [
  [401, 'authentication'],
  [403, 'authentication'],
  [404, 'not_found'],
  [409, 'conflict'],
  [412, 'conflict'],
  [400, 'validation'],
  [422, 'validation'],
  [429, 'rate_limit'],
  [500, 'server'],
  [503, 'server'],
  [599, 'server'],
  [418, 'api'],
  [408, 'api'],
];
function fixture(schemas = {}, webhook = false) {
  const dir = join(root, String(sequence++));
  mkdirSync(dir);
  const response = {
    type: 'object',
    properties: {
      id: { type: 'string' },
      ...Object.fromEntries(
        Object.keys(schemas).map((name) => [name, { $ref: '#/components/schemas/' + name }]),
      ),
    },
    required: ['id'],
  };
  writeFileSync(
    join(dir, 'api.json'),
    JSON.stringify({
      openapi: '3.1.0',
      info: { title: 'Error classes', version: '1' },
      components: { schemas },
      paths: {
        '/values/{id}': {
          get: {
            operationId: 'retrieve',
            parameters: [
              { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
              { name: 'label', in: 'query', schema: { type: 'string' } },
            ],
            responses: {
              200: { description: 'OK', content: { 'application/json': { schema: response } } },
            },
          },
        },
      },
    }),
  );
  writeFileSync(
    join(dir, 'sdk.json'),
    JSON.stringify({
      version: '1.0.0',
      npm: { name: '@example/error-classes' },
      composer: { name: 'example/error-classes', namespace: 'Example\\ErrorClasses' },
      requests: { style: 'positional' },
      responses: { return: 'result' },
      operations: { retrieve: { resource: 'values', method: 'retrieve' } },
      ...(webhook
        ? {
            webhook: {
              algorithm: 'hmac-sha256',
              header: 'X-Signature',
              timestampHeader: 'X-Timestamp',
              separator: '.',
              toleranceSeconds: 300,
              typeField: 'type',
              events: {
                'value.updated': {
                  type: 'object',
                  properties: { id: { type: 'string' } },
                  required: ['id'],
                },
              },
            },
          }
        : {}),
    }),
  );
  const contract = loadContract(join(dir, 'api.json'), join(dir, 'sdk.json'));
  const output = join(dir, 'output');
  generate(contract, output);
  return { dir, contract, output };
}
function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  assert.equal(
    result.status,
    0,
    command + ' ' + args.join(' ') + '\n' + result.stdout + result.stderr,
  );
  return result.stdout;
}
function php(f, code) {
  return run('php', [
    '-r',
    String.raw`require $argv[1].'/src/Client.php'; ` + code,
    join(f.output, 'php'),
  ]);
}

test('minified generated SDK bundles preserve built-in error names', async () => {
  const f = fixture();
  const bundle = join(f.dir, 'bundle.mjs');
  await build({
    entryPoints: [join(f.output, 'node/index.js')],
    outfile: bundle,
    bundle: true,
    minify: true,
    platform: 'node',
    format: 'esm',
  });
  const { Client, SdkError, errors } = await import(pathToFileURL(bundle));
  assert.deepEqual(
    [
      new SdkError('api', 'synthetic').name,
      ...Object.entries(classes).map(([kind, name]) => new errors[name](kind, 'synthetic').name),
    ],
    ['SdkError', ...Object.values(classes)],
  );
  class ConsumerError extends errors.AuthenticationError {}
  assert.equal(new ConsumerError('authentication', 'synthetic').name, 'ConsumerError');
  const client = new Client({
    baseUrl: 'https://example.invalid',
    maxAttempts: 1,
    transport: async () => new Response('{"message":"synthetic"}', { status: 401 }),
  });
  await assert.rejects(client.values.retrieve('value_fixture'), (error) => {
    assert.ok(error instanceof errors.AuthenticationError && error instanceof SdkError);
    assert.equal(error.name, 'AuthenticationError');
    assert.match(inspect(error), /AuthenticationError/);
    return true;
  });
});

test('Node error factory reports its caller as the origin', async () => {
  const f = fixture();
  const { createSdkError } = await import(pathToFileURL(join(f.output, 'node/runtime.js')));
  function throwingSite() {
    throw createSdkError('authentication', 'synthetic');
  }
  assert.throws(throwingSite, (error) => {
    assert.match(error.stack.split('\n')[1], /at throwingSite \(/);
    assert.doesNotMatch(error.stack, /at createSdkError/);
    return true;
  });
});

test('PHP error factory reports its caller file and line as the origin', () => {
  const f = fixture();
  const caller = join(f.dir, 'caller.php');
  writeFileSync(
    caller,
    String.raw`<?php
require $argv[1].'/src/Client.php';
use Example\ErrorClasses\SdkError;
function throwingSite(): void {
    $expectedLine = __LINE__ + 2;
    try {
        throw SdkError::create('authentication', 'synthetic');
    } catch (SdkError $error) {
        echo json_encode([$error->getFile(), $error->getLine(), __FILE__, $expectedLine]);
    }
}
throwingSite();
`,
  );
  const [file, line, expectedFile, expectedLine] = JSON.parse(
    run('php', [caller, join(f.output, 'php')]),
  );
  assert.equal(file, expectedFile);
  assert.equal(line, expectedLine);
});

test('HTTP errors use the independently expected class and preserve SdkError fields in both targets', async () => {
  const f = fixture();
  const { Client, SdkError, errors } = await import(pathToFileURL(join(f.output, 'node/index.js')));
  assert.equal(errors.SdkError, SdkError);
  const subpath = await import(pathToFileURL(join(f.output, 'node/resources/values.js')));
  assert.equal(subpath.errors, errors);
  assert.equal(subpath.SdkError, SdkError);
  for (const [status, kind] of statuses) {
    const client = new Client({
      baseUrl: 'https://example.invalid',
      maxAttempts: 1,
      transport: async () =>
        new Response('{"message":"synthetic failure"}', {
          status,
          headers: { 'x-request-id': 'req_00P5GR7C25QNQYKSNCJF346W0E' },
        }),
    });
    await assert.rejects(client.values.retrieve('value_fixture'), (error) => {
      assert.ok(error instanceof SdkError);
      assert.ok(error instanceof errors[classes[kind]]);
      assert.equal(error.name, classes[kind]);
      assert.equal(error.kind, kind);
      assert.equal(error.status, status);
      assert.equal(error.message, 'synthetic failure');
      assert.equal(error.meta.requestId, 'req_00P5GR7C25QNQYKSNCJF346W0E');
      assert.equal(error.outcome, 'response');
      assert.match(error.stack.split('\n')[1], /at CompiledRuntime\.executeRequest \(/);
      assert.doesNotMatch(error.stack, /at createSdkError/);
      assert.match(inspect(error), new RegExp(classes[kind]));
      return true;
    });
  }
  const rows = JSON.parse(
    php(
      f,
      String.raw`
use Example\ErrorClasses\{Client,ClientOptions,SdkError};
$rows=[];
foreach([401,403,404,409,412,400,422,429,500,503,599,418,408] as $status) {
  $client=new Client(new ClientOptions('https://example.invalid',maxAttempts:1,transport:fn($r)=>['status'=>$status,'headers'=>['x-request-id'=>'req_00P5GR7C25QNQYKSNCJF346W0E'],'body'=>'{"message":"synthetic failure"}']));
  try {$client->values->retrieve('value_fixture'); throw new Exception('accepted');}
  catch(SdkError $e) {
    $source=file($e->getFile());
    if(basename($e->getFile())!=='Runtime.php' || !str_contains($source[$e->getLine()-1],'SdkError::create('))throw new Exception('factory obscured throwing site');
    $rows[]=[get_class($e),$e instanceof SdkError,$e->kind,$e->status,$e->getMessage(),$e->meta['requestId'],$e->outcome];
  }
}
echo json_encode($rows);`,
    ),
  );
  assert.deepEqual(
    rows,
    statuses.map(([status, kind]) => [
      'Example\\ErrorClasses\\Errors\\' + classes[kind],
      true,
      kind,
      status,
      'synthetic failure',
      'req_00P5GR7C25QNQYKSNCJF346W0E',
      'response',
    ]),
  );
});

test('local validation, cancellation, deadlines, transport, protocol and destination failures use classes', async () => {
  const f = fixture();
  const { Client, SdkError, errors } = await import(pathToFileURL(join(f.output, 'node/index.js')));
  const base = {
    baseUrl: 'https://example.invalid',
    maxAttempts: 1,
    transport: async () => new Response('{"id":"value_fixture"}', { status: 200 }),
  };
  const witnesses = [
    ['validation', () => new Client(base).values.retrieve('value_fixture', [])],
    [
      'cancelled',
      () =>
        new Client(base).values.retrieve('value_fixture', undefined, {
          signal: AbortSignal.abort(),
        }),
    ],
    [
      'protocol',
      () =>
        new Client({
          ...base,
          transport: async () => new Response('{', { status: 200 }),
        }).values.retrieve('value_fixture'),
    ],
    [
      'transport',
      () =>
        new Client({
          ...base,
          transport: async () => {
            throw new Error('synthetic connection failure');
          },
        }).values.retrieve('value_fixture'),
    ],
    [
      'deadline',
      () =>
        new Client({
          ...base,
          deadlineMs: 10,
          transport: async (url, options) => {
            await new Promise((resolve, reject) =>
              options.signal.addEventListener('abort', () => reject(new Error('synthetic abort')), {
                once: true,
              }),
            );
          },
        }).values.retrieve('value_fixture'),
    ],
  ];
  for (const [kind, call] of witnesses)
    await assert.rejects(
      async () => await call(),
      (e) => e instanceof SdkError && e instanceof errors[classes[kind]] && e.kind === kind,
      kind,
    );
  assert.throws(
    () => new Client({ ...base, baseUrl: 'http://example.invalid' }),
    (e) => e instanceof errors.DestinationError && e instanceof SdkError,
  );
  const rows = JSON.parse(
    php(
      f,
      String.raw`
use Example\ErrorClasses\{Client,ClientOptions,RequestOptions,Cancellation,SdkError};
$rows=[];$cancel=new Cancellation();$cancel->cancel();
foreach(['validation','cancelled','protocol','transport','deadline','destination'] as $kind) {
  try {
    $transport=static function($r)use($kind){if($kind==='transport')throw new Exception('synthetic connection failure');if($kind==='deadline'){usleep(25000);throw new Exception('synthetic timeout');}return ['status'=>200,'headers'=>[],'body'=>$kind==='protocol'?'{':'{"id":"value_fixture"}'];};
    $c=new Client(new ClientOptions($kind==='destination'?'http://example.invalid':'https://example.invalid',maxAttempts:1,deadlineMs:$kind==='deadline'?10:30000,transport:$transport));
    $c->values->retrieve('value_fixture',$kind==='validation'?['unexpected'=>true]:null,new RequestOptions(cancellation:$kind==='cancelled'?$cancel:null));
    throw new Exception('accepted '.$kind);
  }catch(SdkError $e){$rows[]=[$e->kind,get_class($e),$e instanceof SdkError];}
}
echo json_encode($rows);`,
    ),
  );
  assert.deepEqual(
    rows,
    ['validation', 'cancelled', 'protocol', 'transport', 'deadline', 'destination'].map((kind) => [
      kind,
      'Example\\ErrorClasses\\Errors\\' + classes[kind],
      true,
    ]),
  );
});

test('strict consumers use namespace types, class narrowing, and independent generated models', async () => {
  const f = fixture(
    {
      ValidationError: { type: 'object', properties: { message: { type: 'string' } } },
      ApiError: { type: 'object', properties: { code: { type: 'string' } } },
      Errors: { type: 'object', properties: { count: { type: 'integer' } } },
    },
    true,
  );
  const source = join(f.output, 'node/consumer.ts');
  writeFileSync(
    source,
    `import {errors,SdkError,verifyWebhook} from './index.js';
import type {ValidationError,ApiError,Errors as ErrorModel} from './index.js';
import {errors as resourceErrors} from './resources/values.js';
let caught:unknown;
if(caught instanceof errors.NotFoundError){const narrowed:errors.NotFoundError=caught;const parent:SdkError=narrowed;const status:number|undefined=parent.status;}
const alias:typeof SdkError=errors.SdkError;
const base:errors.SdkError=new SdkError('api','synthetic');
const local:errors.NotFoundError=new resourceErrors.NotFoundError('not_found','synthetic');
const model:ValidationError={message:'synthetic'};const api:ApiError={code:'synthetic'};const rootModel:ErrorModel={count:1};
const verified=verifyWebhook(new Uint8Array(),new Headers(),'synthetic',1700000000);
if(!verified.known){const reason:'unknown_event'|'unmatched_envelope'=verified.reason;}
`,
  );
  run(process.execPath, [
    resolve('node_modules/typescript/bin/tsc'),
    '--noEmit',
    '--strict',
    '--target',
    'es2022',
    '--module',
    'nodenext',
    '--typeRoots',
    resolve('node_modules/@types'),
    source,
  ]);
  for (const [kind, name] of Object.entries(classes)) {
    const { errors, SdkError } = await import(pathToFileURL(join(f.output, 'node/index.js')));
    const cause = new Error('synthetic cause');
    const meta = { status: 404, headers: {}, attempts: 1, durationMs: 1 };
    const e = new errors[name](
      kind,
      'synthetic',
      'unknown',
      true,
      meta,
      'fixture_code',
      { field: 'synthetic' },
      { cause },
      'fixture raw',
    );
    assert.ok(e instanceof SdkError);
    assert.equal(e.cause, cause);
    assert.equal(e.raw, 'fixture raw');
    assert.equal(e.code, 'fixture_code');
    assert.equal(e.retryAllowed, true);
    assert.equal(e.details.field, 'synthetic');
  }
  const constructorRows = JSON.parse(
    php(
      f,
      `$classes = [${Object.entries(classes)
        .map(([kind, name]) => "'" + kind + "'=>'" + name + "'")
        .join(',')}];` +
        String.raw`
$rows=[];
foreach($classes as $kind=>$name) {
  $class='Example\\ErrorClasses\\Errors\\'.$name;$cause=new Exception('synthetic cause');
  $e=new $class($kind,'synthetic','unknown',true,['status'=>404],'fixture_code',['field'=>'synthetic'],$cause,'fixture raw');
  $rows[]=[$e instanceof Example\ErrorClasses\SdkError,$e->kind,$e->outcome,$e->retryAllowed,$e->status,$e->errorCode,$e->details['field'],$e->getPrevious()===$cause,$e->raw];
}
$rootModel=new Example\ErrorClasses\Errors(['count'=>1]);
if($rootModel instanceof Example\ErrorClasses\SdkError)throw new Exception('model collided');
echo json_encode($rows);`,
    ),
  );
  assert.deepEqual(
    constructorRows,
    Object.keys(classes).map((kind) => [
      true,
      kind,
      'unknown',
      true,
      404,
      'fixture_code',
      'synthetic',
      true,
      'fixture raw',
    ]),
  );
  const consumer = join(f.dir, 'consumer.php');
  writeFileSync(
    consumer,
    String.raw`<?php
use Example\ErrorClasses\SdkError;
use Example\ErrorClasses\Client;
use Example\ErrorClasses\Webhooks;
use Example\ErrorClasses\Errors\NotFoundError;
use Example\ErrorClasses\Errors\AuthenticationError;
use Example\ErrorClasses\ValidationError;
use Example\ErrorClasses\ApiError;
use Example\ErrorClasses\Errors as ErrorModel;
function eventReason(Client $client, string $body, string $secret): ?string {
    $verified = $client->verifyWebhook($body, [], ['current' => $secret], 1700000000);
    return $verified['known'] ? null : $verified['reason'];
}
/** @param array<string, string|list<string>> $headers */
function standaloneReason(string $body, array $headers, string $secret): ?string {
    $verified = Webhooks::verify($body, $headers, $secret, 1700000000);
    return $verified['known'] ? null : $verified['reason'];
}
function consume(SdkError $error, ValidationError $model, ApiError $api, ErrorModel $errors): ?int {
    if ($error instanceof NotFoundError) return $error->status;
    if ($error instanceof AuthenticationError) return $error->status;
    return null;
}
`,
  );
  const config = join(f.dir, 'phpstan.neon');
  writeFileSync(
    config,
    `parameters:\n    level: max\n    phpVersion: 80200\n    tmpDir: ${JSON.stringify(join(f.dir, 'cache'))}\n    scanDirectories:\n        - ${JSON.stringify(join(f.output, 'php/src'))}\n`,
  );
  run('php', [
    resolve('.generated/phpstan-vendor/bin/phpstan'),
    'analyse',
    '--debug',
    '--no-progress',
    '--error-format=raw',
    '-c',
    config,
    consumer,
  ]);
});

test('ValidationError, ApiError and Errors models coexist with error namespaces in both targets', async () => {
  const f = fixture({
    ValidationError: { type: 'object', properties: { message: { type: 'string' } } },
    ApiError: { type: 'object', properties: { code: { type: 'string' } } },
    Errors: { type: 'object', properties: { count: { type: 'integer' } } },
  });
  const sdk = await import(pathToFileURL(join(f.output, 'node/index.js')));
  const subpath = await import(pathToFileURL(join(f.output, 'node/resources/values.js')));
  const expected = {
    id: 'value_fixture',
    ValidationError: { message: 'synthetic model' },
    ApiError: { code: 'synthetic_code' },
    Errors: { count: 2 },
  };
  const client = new sdk.Client({
    baseUrl: 'https://example.invalid',
    transport: async () => new Response(JSON.stringify(expected)),
  });
  assert.deepEqual(
    JSON.parse(JSON.stringify((await client.values.retrieve('value_fixture')).data)),
    expected,
  );
  for (const [name, value] of Object.entries(expected).slice(1)) {
    const model = sdk['make' + name](value);
    assert.ok(model instanceof sdk.Model);
    assert.ok(!(model instanceof sdk.SdkError));
    assert.deepEqual(JSON.parse(JSON.stringify(model)), value);
    assert.ok(existsSync(join(f.output, 'node/declarations', name + '.d.ts')));
    assert.ok(existsSync(join(f.output, 'php/src/classes', name + '.php')));
  }
  assert.equal(subpath.errors, sdk.errors);
  assert.equal(sdk.errors.SdkError, sdk.SdkError);
  assert.ok(!existsSync(join(f.output, 'node/declarations/errors.d.ts')));
  assert.ok(!existsSync(join(f.output, 'node/errors.js')));
  assert.match(readFileSync(join(f.output, 'node/runtime.d.ts'), 'utf8'), /namespace errors/);
  await assert.rejects(client.values.retrieve('value_fixture', []), sdk.errors.ValidationError);
  const reserve = reservePublicSymbols(f.contract, [], new Set());
  reserve('Errors', 'models.Errors');
  assert.throws(() => reserve('errors', 'models.errors'), /runtime\.errors/);
  assert.equal('verifyWebhook' in sdk, false);
  assert.ok(!existsSync(join(f.output, 'php/src/classes/Webhooks.php')));
  assert.equal(
    php(
      f,
      String.raw`
use Example\ErrorClasses\{Client,ClientOptions,Model,SdkError,ValidationError,ApiError,Errors};
foreach([new ValidationError(['message'=>'synthetic model']),new ApiError(['code'=>'synthetic_code']),new Errors(['count'=>2])] as $model) {
  if(!$model instanceof Model || $model instanceof SdkError)throw new Exception('model collision');
}
$body='{"id":"value_fixture","ValidationError":{"message":"synthetic model"},"ApiError":{"code":"synthetic_code"},"Errors":{"count":2}}';
$client=new Client(new ClientOptions('https://example.invalid',transport:fn($r)=>['status'=>200,'headers'=>[],'body'=>$body]));
$result=$client->values->retrieve('value_fixture')->data;
if(!$result->getValidationError() instanceof ValidationError || !$result->getApiError() instanceof ApiError || !$result->getErrors() instanceof Errors)throw new Exception('response model renamed');
foreach(['ValidationError'=>'validation','ApiError'=>'api'] as $name=>$kind) {
  $class='Example\\ErrorClasses\\Errors\\'.$name;
  $error=SdkError::create($kind,'synthetic failure');
  if(!$error instanceof $class || !$error instanceof SdkError)throw new Exception('error collision');
}
try{$client->values->retrieve('value_fixture',['unexpected'=>true]);throw new Exception('accepted');}
catch(Example\ErrorClasses\Errors\ValidationError $e){if(!$e instanceof SdkError)throw $e;}
echo 'ok';`,
    ),
    'ok',
  );
});

test('PHP standalone verification needs no client options, keeps guarded arguments and client redaction', () => {
  const f = fixture({}, true);
  const script = String.raw`
require $argv[1].'/src/Client.php';
use Example\ErrorClasses\{Client,ClientOptions,Webhooks,SdkError};
$method=new ReflectionMethod(Webhooks::class,'verify');
if(!$method->isStatic() || (string)$method->getReturnType()!=='array' || $method->getNumberOfParameters()!==4)throw new Exception('standalone signature');
foreach($method->getParameters() as $parameter){if((string)$parameter->getType()!=='mixed')throw new Exception('unguarded argument');}
if($method->getParameters()[3]->getDefaultValue()!==null)throw new Exception('time default');
$now=time();$body='{"type":"value.updated","id":"value_fixture","privateNote":"synthetic-note"}';
$secret='synthetic-webhook-secret';$headers=['X-Timestamp'=>[(string)$now],'X-Signature'=>[hash_hmac('sha256',$now.'.'.$body,$secret)]];
$standalone=Webhooks::verify($body,$headers,[$secret]);
if(!$standalone['known'] || isset($standalone['reason']) || $standalone['event']->getId()!=='value_fixture')throw new Exception('standalone result');
$explicitNull=Webhooks::verify($body,$headers,$secret,null);
if(json_encode($explicitNull)!==json_encode($standalone))throw new Exception('null default');
// A non-integer override must reach the SDK guard even in a weak PHP caller.
try{Webhooks::verify($body,$headers,$secret,(float)$now);throw new Exception('accepted invalid time');}
catch(Example\ErrorClasses\Errors\ValidationError $error){if(!$error instanceof SdkError || $error->errorCode!=='webhook_invalid_input')throw $error;}
$client=new Client(new ClientOptions('https://example.invalid',redactFields:['privateNote']));
$verified=$client->verifyWebhook($body,$headers,[$secret]);
if(json_encode($verified)!==json_encode($standalone))throw new Exception('client parity');
if(str_contains(print_r($verified['event'],true),'synthetic-note'))throw new Exception('client redaction lost');
echo 'ok';`;
  for (const strict of [false, true])
    assert.equal(
      run('php', [
        '-r',
        (strict ? 'declare(strict_types=1);' : '') + script,
        join(f.output, 'php'),
      ]),
      'ok',
    );
});

test('Webhooks model keeps its name and client verification when the PHP standalone class is omitted', async () => {
  const f = fixture({ Webhooks: { type: 'object', properties: { id: { type: 'string' } } } }, true);
  const plan = compileSdkContract(f.contract).plan;
  assert.equal(plan.node.standaloneWebhook, true);
  assert.equal(plan.php.standaloneWebhook, undefined);
  const { Client, makeWebhooks, Model, verifyWebhook } = await import(
    pathToFileURL(join(f.output, 'node/index.js'))
  );
  assert.ok(existsSync(join(f.output, 'node/declarations/Webhooks.d.ts')));
  const model = makeWebhooks({ id: 'model_fixture' });
  assert.ok(model instanceof Model);
  assert.deepEqual(JSON.parse(JSON.stringify(model)), { id: 'model_fixture' });
  const now = 1700000000;
  const secret = 'synthetic-webhook-secret';
  const body = '{"type":"value.updated","id":"value_fixture"}';
  const headers = {
    'X-Timestamp': String(now),
    'X-Signature': createHmac('sha256', secret)
      .update(now + '.' + body)
      .digest('hex'),
  };
  const client = new Client({
    baseUrl: 'https://example.invalid',
    transport: async () => new Response('{"id":"value_fixture","Webhooks":{"id":"model_fixture"}}'),
  });
  assert.equal((await client.values.retrieve('value_fixture')).data.Webhooks.id, 'model_fixture');
  assert.equal(verifyWebhook(Buffer.from(body), headers, secret, now).known, true);
  assert.deepEqual(
    client.verifyWebhook(Buffer.from(body), headers, secret, now),
    verifyWebhook(Buffer.from(body), headers, secret, now),
  );
  const phpModel = readFileSync(join(f.output, 'php/src/classes/Webhooks.php'), 'utf8');
  assert.match(phpModel, /class Webhooks extends Model/);
  assert.doesNotMatch(phpModel, /static function verify\(/);
  for (const file of ['README.md', 'RUNTIME.md']) {
    const doc = readFileSync(join(f.output, 'php', file), 'utf8');
    assert.doesNotMatch(doc, /Webhooks::verify/);
    assert.match(doc, /Webhooks.*model/);
  }
  assert.equal(
    php(
      f,
      String.raw`
use Example\ErrorClasses\{Client,ClientOptions,Webhooks,Model};
$model=new Webhooks(['id'=>'model_fixture']);
if(!$model instanceof Model || $model->getId()!=='model_fixture' || method_exists(Webhooks::class,'verify'))throw new Exception('model renamed or standalone emitted');
$client=new Client(new ClientOptions('https://example.invalid',transport:fn($r)=>['status'=>200,'headers'=>[],'body'=>'{"id":"value_fixture","Webhooks":{"id":"model_fixture"}}']));
if(!$client->values->retrieve('value_fixture')->data->getWebhooks() instanceof Webhooks)throw new Exception('response model renamed');
$now=1700000000;$body='{"type":"value.updated","id":"value_fixture"}';$secret='synthetic-webhook-secret';
$headers=['X-Timestamp'=>(string)$now,'X-Signature'=>hash_hmac('sha256',$now.'.'.$body,$secret)];
$verified=$client->verifyWebhook($body,$headers,$secret,$now);
if(!$verified['known'] || $verified['event']->getId()!=='value_fixture')throw new Exception('client verification failed');
echo 'ok';`,
    ),
    'ok',
  );
});

test('Webhooks collision policy respects PHP case-insensitivity and selected targets', () => {
  const f = fixture({ WebHooks: { type: 'object', properties: { id: { type: 'string' } } } }, true);
  for (const targets of [['node'], ['php'], ['node', 'php']]) {
    const contract = structuredClone(f.contract);
    contract.config.targets = targets;
    const plan = compileSdkContract(contract).plan;
    assert.equal(plan.node.standaloneWebhook, true);
    assert.equal(plan.php.standaloneWebhook, undefined);
    const output = join(f.dir, targets.join('-'));
    generate(contract, output);
    if (targets.includes('node')) {
      assert.ok(existsSync(join(output, 'node/declarations/WebHooks.d.ts')));
      assert.match(
        readFileSync(join(output, 'node/index.js'), 'utf8'),
        /export function verifyWebhook/,
      );
    }
    if (targets.includes('php')) {
      assert.ok(existsSync(join(output, 'php/src/classes/WebHooks.php')));
      assert.ok(!existsSync(join(output, 'php/src/classes/Webhooks.php')));
      assert.equal(
        php(
          { output },
          String.raw`
$model=new Example\ErrorClasses\WebHooks(['id'=>'model_fixture']);
if($model->getId()!=='model_fixture' || method_exists($model,'verify'))throw new Exception('case-insensitive collision');
echo 'ok';`,
        ),
        'ok',
      );
    }
  }
});

test('historical compiled records classify error classes, reasons and both standalone verifiers as additive', () => {
  const f = fixture({}, true);
  const next = compileSdkContract(f.contract).plan;
  const previous = structuredClone(next);
  for (const target of ['node', 'php']) {
    delete previous[target].errorClasses;
    delete previous[target].webhookReasons;
    delete previous[target].standaloneWebhook;
  }
  previous.node.eventDeclarations = previous.node.eventDeclarations.replace(
    '; reason: "unknown_event" | "unmatched_envelope"',
    '',
  );
  const saved = storeCompiledSnapshot({
    plan: previous,
    runtimeIdentity: { node: '0'.repeat(64), php: '0'.repeat(64) },
  });
  const restored = restoreCompiledSnapshot(saved).plan;
  const findings = compareCompiledContracts(restored, next);
  assert.deepEqual(
    findings.map((f) => [f.subject, f.severity]),
    [
      ['node.errorClasses', 'additive'],
      ['node.webhookReasons', 'additive'],
      ['node.standaloneWebhook', 'additive'],
      ['php.errorClasses', 'additive'],
      ['php.webhookReasons', 'additive'],
      ['php.standaloneWebhook', 'additive'],
    ],
  );
  const malformed = structuredClone(next);
  malformed.node.errorClasses = false;
  assert.throws(
    () =>
      restoreCompiledSnapshot({
        plan: malformed,
        runtimeIdentity: { node: '0'.repeat(64), php: '0'.repeat(64) },
      }),
    /Invalid compiled runtime API flag/,
  );
  // Use the record path owned by generation rather than constructing a new format.
  const records = preview(f.contract, f.output);
  assert.equal(
    records.compatibility.some((f) => f.severity === 'breaking'),
    false,
  );
});
