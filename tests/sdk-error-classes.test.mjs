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
const classes = [
  'ApiError',
  'InvalidRequestError',
  'AuthenticationError',
  'PermissionError',
  'NotFoundError',
  'ConflictError',
  'RateLimitError',
  'ServerError',
  'ConnectionError',
  'TimeoutError',
  'InvalidInputError',
  'ConfigurationError',
  'CancelledError',
  'UnexpectedResponseError',
  'WebhookVerificationError',
  'PaginationLimitError',
];
const statuses = [
  [400, 'InvalidRequestError'],
  [401, 'AuthenticationError'],
  [403, 'PermissionError'],
  [404, 'NotFoundError'],
  [405, 'ApiError'],
  [409, 'ConflictError'],
  [410, 'ApiError'],
  [412, 'ConflictError'],
  [413, 'ApiError'],
  [415, 'ApiError'],
  [418, 'ApiError'],
  [422, 'InvalidRequestError'],
  [429, 'RateLimitError'],
  [500, 'ServerError'],
  [502, 'ServerError'],
  [503, 'ServerError'],
  [504, 'ServerError'],
  [599, 'ServerError'],
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
      errors: { objectPath: '' },
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
function php(f, code, argument = '') {
  return run('php', [
    '-r',
    String.raw`require $argv[1].'/src/Client.php'; ` + code,
    join(f.output, 'php'),
    argument,
  ]);
}

test('status alone selects API classes with flattened context in both targets', async () => {
  const f = fixture();
  const { Client, SdkError, errors } = await import(pathToFileURL(join(f.output, 'node/index.js')));
  assert.equal(errors.SdkError, SdkError);
  for (const [status, name] of statuses) {
    for (const code of ['RESOURCE_NOT_FOUND', 'future_code']) {
      const c = new Client({
        baseUrl: 'https://example.invalid',
        maxAttempts: 1,
        transport: async () =>
          new Response(JSON.stringify({ message: 'synthetic failure', code }), {
            status,
            headers: { 'x-request-id': 'req_fixture' },
          }),
      });
      await assert.rejects(c.values.retrieve('value_fixture'), (e) => {
        assert.ok(
          e instanceof errors[name] && e instanceof errors.ApiError && e instanceof SdkError,
        );
        assert.equal(e.name, name);
        assert.equal(e.status, status);
        assert.equal(e.code, code);
        assert.equal(e.message, 'synthetic failure');
        assert.equal(e.requestId, 'req_fixture');
        assert.deepEqual(e.requestIds, ['req_fixture']);
        assert.equal(e.attempts, 1);
        assert.equal(e.operation, 'values.retrieve');
        assert.equal(e.outcome, 'response');
        assert.equal('kind' in e, false);
        assert.equal('meta' in e, false);
        assert.match(e.stack.split('\n')[1], /at CompiledRuntime\.executeRequest/);
        return true;
      });
    }
  }
  const rows = JSON.parse(
    php(
      f,
      String.raw`
use Example\ErrorClasses\{Client,ClientOptions,SdkError};
$rows=[];
foreach(json_decode($argv[2],true) as [$status,$name]) {
 foreach(['RESOURCE_NOT_FOUND','future_code'] as $code) {
  $c=new Client(new ClientOptions('https://example.invalid',maxAttempts:1,transport:fn($r)=>['status'=>$status,'headers'=>['x-request-id'=>'req_fixture'],'body'=>json_encode(['message'=>'synthetic failure','code'=>$code])]));
  try {$c->values->retrieve('value_fixture');throw new Exception('accepted');}
  catch(SdkError $e){
   if(!$e instanceof Example\ErrorClasses\Errors\ApiError || $e->code!==$e->getCode() || property_exists($e,'kind') || property_exists($e,'meta'))throw new Exception('surface');
   $rows[]=[substr(strrchr(get_class($e),chr(92)),1),$e->status,$e->code,$e->getMessage(),$e->requestId,$e->requestIds,$e->attempts,$e->operation,$e->outcome];
  }
 }
}
echo json_encode($rows);`,
      JSON.stringify(statuses),
    ),
  );
  assert.deepEqual(
    rows,
    statuses.flatMap(([status, name]) =>
      ['RESOURCE_NOT_FOUND', 'future_code'].map((code) => [
        name,
        status,
        code,
        'synthetic failure',
        'req_fixture',
        ['req_fixture'],
        1,
        'values.retrieve',
        'response',
      ]),
    ),
  );
});

test('request IDs accumulate over retries in both targets', async () => {
  const f = fixture();
  const { Client } = await import(pathToFileURL(join(f.output, 'node/index.js')));
  let calls = 0;
  const c = new Client({
    baseUrl: 'https://example.invalid',
    transport: async () =>
      new Response('{}', {
        status: ++calls === 1 ? 503 : 404,
        headers: { 'x-request-id': 'req_' + calls },
      }),
  });
  await assert.rejects(c.values.retrieve('value_fixture'), (e) => {
    assert.deepEqual(e.requestIds, ['req_1', 'req_2']);
    assert.equal(e.attempts, 2);
    assert.equal(e.requestId, 'req_2');
    return true;
  });
  assert.deepEqual(
    JSON.parse(
      php(
        f,
        String.raw`
use Example\ErrorClasses\{Client,ClientOptions,SdkError};
$calls=0;$c=new Client(new ClientOptions('https://example.invalid',transport:function($r)use(&$calls){$calls++;return ['status'=>$calls===1?503:404,'headers'=>['x-request-id'=>'req_'.$calls],'body'=>'{}'];}));
try{$c->values->retrieve('value_fixture');throw new Exception('accepted');}catch(SdkError $e){echo json_encode([$e->requestIds,$e->attempts,$e->requestId]);}`,
      ),
    ),
    [['req_1', 'req_2'], 2, 'req_2'],
  );
});

test('a connection failure retains the last response context without becoming an API error', async () => {
  const f = fixture();
  const { Client, errors } = await import(pathToFileURL(join(f.output, 'node/index.js')));
  let calls = 0;
  const c = new Client({
    baseUrl: 'https://example.invalid',
    maxAttempts: 2,
    transport: async () => {
      if (++calls === 2) throw new Error('synthetic reset');
      return new Response('{}', {
        status: 503,
        headers: { 'x-request-id': 'req_first', 'retry-after': '0' },
      });
    },
  });
  await assert.rejects(c.values.retrieve('value_fixture'), (e) => {
    assert.ok(e instanceof errors.ConnectionError);
    assert.equal(e instanceof errors.ApiError, false);
    assert.deepEqual(
      [e.status, e.requestId, e.requestIds, e.attempts, e.retryAfterMs, e.headers['x-request-id']],
      [503, 'req_first', ['req_first'], 2, 0, 'req_first'],
    );
    return true;
  });
  assert.deepEqual(
    JSON.parse(
      php(
        f,
        String.raw`
use Example\ErrorClasses\{Client,ClientOptions,SdkError};
$calls=0;$c=new Client(new ClientOptions('https://example.invalid',maxAttempts:2,transport:function($r)use(&$calls){if(++$calls===2)throw new Exception('synthetic reset');return ['status'=>503,'headers'=>['x-request-id'=>'req_first','retry-after'=>'0'],'body'=>'{}'];}));
try{$c->values->retrieve('value_fixture');throw new Exception('accepted');}catch(SdkError $e){echo json_encode([$e instanceof Example\ErrorClasses\Errors\ConnectionError,$e instanceof Example\ErrorClasses\Errors\ApiError,$e->status,$e->requestId,$e->requestIds,$e->attempts,$e->retryAfterMs,$e->headers['x-request-id']]);}`,
      ),
    ),
    [true, false, 503, 'req_first', ['req_first'], 2, 0, 'req_first'],
  );
});

test('init constructors, parents, minified identities and inspection agree', async () => {
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
  const { SdkError, errors } = await import(pathToFileURL(bundle));
  const init = {
    code: 'fixture_code',
    operation: 'values.retrieve',
    outcome: 'unknown',
    retryAllowed: true,
    status: 404,
    requestId: 'req_fixture',
    requestIds: ['req_first', 'req_fixture'],
    idempotencyKey: 'key_fixture',
    attempts: 2,
    retryAfterMs: 100,
    durationMs: 4,
    headers: { 'set-cookie': 'private-cookie' },
    raw: 'private-raw',
  };
  let keys;
  for (const name of classes) {
    const e = new errors[name]('synthetic', init);
    assert.equal(e.name, name);
    assert.ok(e instanceof SdkError);
    assert.equal(e.code, 'fixture_code');
    assert.equal(e.attempts, 2);
    assert.equal(e.raw, 'private-raw');
    assert.equal(Object.prototype.propertyIsEnumerable.call(e, 'headers'), false);
    for (const text of [JSON.stringify(e), inspect(e)])
      assert.doesNotMatch(text, /private-cookie|private-raw/);
    assert.equal('kind' in e, false);
    assert.equal('meta' in e, false);
    if (!(e instanceof errors.ApiError)) assert.equal('details' in e, false);
    if (name === 'PermissionError') assert.ok(e instanceof errors.ApiError);
    if (name === 'TimeoutError') assert.ok(e instanceof errors.ConnectionError);
    if (name === 'SdkError') assert.fail();
    if (name === 'NotFoundError') keys = Object.keys(JSON.parse(JSON.stringify(e))).sort();
  }
  for (const old of ['ValidationError', 'ProtocolError', 'DeadlineError', 'DestinationError'])
    assert.equal(old in errors, false);
  class ConsumerError extends errors.ApiError {}
  assert.equal(new ConsumerError('synthetic').name, 'ConsumerError');
  const result = JSON.parse(
    php(
      f,
      String.raw`
use Example\ErrorClasses\{SdkError};
$rows=[];
foreach(json_decode($argv[2],true) as $name){
 $class='Example'.chr(92).'ErrorClasses'.chr(92).'Errors'.chr(92).$name;
 $e=new $class('synthetic',code:'fixture_code',operation:'values.retrieve',outcome:'unknown',retryAllowed:true,status:404,requestId:'req_fixture',requestIds:['req_first','req_fixture'],idempotencyKey:'key_fixture',attempts:2,retryAfterMs:100,headers:['set-cookie'=>'private-cookie'],raw:'private-raw');
 if(!$e instanceof SdkError || $e->code!==$e->getCode() || $e->getMessage()!=='synthetic')throw new Exception('constructor');
 if($name==='PermissionError' && !$e instanceof Example\ErrorClasses\Errors\ApiError)throw new Exception('api parent');
 if($name==='TimeoutError' && !$e instanceof Example\ErrorClasses\Errors\ConnectionError)throw new Exception('transport parent');
 ob_start();var_dump($e);$debug=ob_get_clean();
 if(str_contains(json_encode($e).$debug.(string)$e,'private-'))throw new Exception('private state leaked');
 if($name==='NotFoundError'){$keys=array_keys($e->jsonSerialize());sort($keys);}
 $rows[]=$e->code;
}
echo json_encode([$rows,$keys]);`,
      JSON.stringify(classes),
    ),
  );
  assert.deepEqual(result, [classes.map(() => 'fixture_code'), keys]);
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
    assert.equal(sdk['make' + name], undefined, 'response-only models have no input factory');
    assert.ok(existsSync(join(f.output, 'node/declarations', name + '.d.ts')));
    assert.ok(existsSync(join(f.output, 'php/src/classes', name + '.php')));
  }
  assert.equal(subpath.errors, sdk.errors);
  assert.equal(sdk.errors.SdkError, sdk.SdkError);
  assert.ok(!existsSync(join(f.output, 'node/declarations/errors.d.ts')));
  assert.ok(!existsSync(join(f.output, 'node/errors.js')));
  assert.match(readFileSync(join(f.output, 'node/runtime.d.ts'), 'utf8'), /namespace errors/);
  await assert.rejects(client.values.retrieve('value_fixture', []), sdk.errors.InvalidInputError);
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
foreach(['InvalidInputError'=>'validation','ConfigurationError'=>'authentication'] as $name=>$kind) {
  $class='Example\\ErrorClasses\\Errors\\'.$name;
  $error=SdkError::create($kind,'synthetic failure');
  if(!$error instanceof $class || !$error instanceof SdkError)throw new Exception('error collision');
}
try{$client->values->retrieve('value_fixture',['unexpected'=>true]);throw new Exception('accepted');}
catch(Example\ErrorClasses\Errors\InvalidInputError $e){if(!$e instanceof SdkError)throw $e;}
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
catch(Example\ErrorClasses\Errors\WebhookVerificationError $error){if(!$error instanceof SdkError || $error->code!=='webhook_invalid_input')throw $error;}
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
  const { Client, makeWebhooks, verifyWebhook } = await import(
    pathToFileURL(join(f.output, 'node/index.js'))
  );
  assert.ok(existsSync(join(f.output, 'node/declarations/Webhooks.d.ts')));
  assert.equal(makeWebhooks, undefined, 'response-only models have no input factory');
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

test('historical compiled records report the new error surface as breaking', () => {
  const f = fixture({}, true);
  const next = compileSdkContract(f.contract).plan;
  const previous = structuredClone(next);
  for (const target of ['node', 'php']) {
    delete previous[target].errorSurfaceVersion;
    previous[target].errorClasses = true;
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
      ['node.errorSurfaceVersion', 'breaking'],
      ['node.webhookReasons', 'additive'],
      ['node.standaloneWebhook', 'additive'],
      ['php.errorSurfaceVersion', 'breaking'],
      ['php.webhookReasons', 'additive'],
      ['php.standaloneWebhook', 'additive'],
    ],
  );
  for (const version of [0, 1.5, '2']) {
    const invalid = structuredClone(next);
    invalid.node.errorSurfaceVersion = version;
    assert.throws(
      () =>
        restoreCompiledSnapshot({
          plan: invalid,
          runtimeIdentity: { node: '0'.repeat(64), php: '0'.repeat(64) },
        }),
      /error surface version/,
    );
  }
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
