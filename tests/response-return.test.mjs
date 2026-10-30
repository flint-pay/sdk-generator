import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspect } from 'node:util';
import { execFileSync } from 'node:child_process';
import {
  setCompatibilityBaseline,
  loadContract,
  generate,
  preview,
  validateFixtures,
} from '../dist/index.js';
import { compileSdkContract } from '../dist/target-plan.js';
import { compareCompiledContracts } from '../dist/compiled-compatibility.js';
import { checkVersionPolicy } from '../dist/version.js';

const root = mkdtempSync(join(tmpdir(), 'sdk-response-return-'));
after(() => rmSync(root, { recursive: true, force: true }));
const item = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string' }, amount: { type: 'integer', format: 'int64' } },
};
const envelope = {
  type: 'object',
  required: ['data'],
  properties: { data: item, next: { type: ['string', 'null'] } },
};
let count = 0;
function fixture({
  responses,
  operations = {},
  schema = envelope,
  extraResponses = {},
  sharing,
  parameters,
  components,
  configExtra = {},
  media = 'application/json',
} = {}) {
  const dir = join(root, String(count++));
  mkdirSync(dir);
  const api = {
    openapi: '3.1.0',
    info: { title: 'Response returns', version: '1' },
    ...(components ? { components } : {}),
    paths: {
      '/item': {
        get: {
          operationId: 'getItem',
          ...(parameters ? { parameters } : {}),
          responses: {
            200: { description: 'OK', content: { [media]: { schema } } },
            ...extraResponses,
          },
        },
      },
    },
  };
  const config = {
    version: '1.0.0',
    requests: { style: 'object' },
    npm: { name: '@example/response-return' },
    composer: { name: 'example/response-return', namespace: 'Example\\ResponseReturn' },
    ...(responses ? { responses } : {}),
    operations,
    ...(sharing ? { schemaSharing: 'named' } : {}),
    ...configExtra,
  };
  writeFileSync(join(dir, 'api.json'), JSON.stringify(api));
  writeFileSync(join(dir, 'sdk.json'), JSON.stringify(config));
  const contract = loadContract(join(dir, 'api.json'), join(dir, 'sdk.json'));
  const output = join(dir, 'output');
  generate(contract, output);
  return { dir, output, contract, read: (p) => readFileSync(join(output, p), 'utf8') };
}
async function client(
  f,
  body = '{"data":{"id":"p_1","amount":9007199254740993},"next":null}',
  status = 200,
) {
  const sdk = await import(pathToFileURL(join(f.output, 'node/index.js')));
  return new sdk.Client({
    baseUrl: 'https://example.invalid',
    transport: async () =>
      new Response(status === 204 ? null : body, {
        status,
        headers: {
          'content-type': 'application/json',
          'x-request-id': 'req_00VZKVWV7E7ECWMRV2HQKH1E8M',
        },
      }),
  });
}
function php(
  f,
  program,
  body = '{"data":{"id":"p_1","amount":9007199254740993},"next":null}',
  redactFields = [],
) {
  return execFileSync(
    'php',
    [
      '-r',
      `require $argv[1].'/src/Runtime.php';require $argv[1].'/src/Client.php';
use Example\\ResponseReturn\\{Client,ClientOptions};
$c=new Client(new ClientOptions('https://example.invalid',redactFields:json_decode($argv[3],true,flags:JSON_THROW_ON_ERROR),transport:fn($r)=>['status'=>200,'headers'=>['content-type'=>'application/json','x-request-id'=>'req_00VZKVWV7E7ECWMRV2HQKH1E8M'],'body'=>$argv[2]]));
${program}`,
      join(f.output, 'php'),
      body,
      JSON.stringify(redactFields),
    ],
    { encoding: 'utf8' },
  );
}
function typecheck(f, source) {
  const file = join(f.output, 'node/consumer.ts');
  writeFileSync(file, source);
  try {
    execFileSync(
      process.execPath,
      [
        resolve('node_modules/typescript/bin/tsc'),
        '--noEmit',
        '--strict',
        '--module',
        'nodenext',
        '--target',
        'es2022',
        '--typeRoots',
        resolve('node_modules/@types'),
        file,
      ],
      { stdio: 'pipe' },
    );
  } catch (error) {
    throw new Error(error.stdout.toString());
  }
}

test('result modes expose ResponseInfo and remove response companions', async () => {
  for (const options of [
    { responses: { return: 'result' } },
    {
      responses: { return: 'payload', payloadPath: 'data' },
      operations: { getItem: { response: { return: 'result' } } },
    },
  ]) {
    const f = fixture(options),
      c = await client(f),
      result = await c.api.getItem();
    assert.equal(result.data.data.id, 'p_1');
    assert.equal(result.lastResponse.status, 200);
    assert.equal(result.lastResponse.body, result.data);
    assert.match(result.raw, /9007199254740993/);
    assert.equal('meta' in result, false);
    assert.equal(c.api.getItemWithResponse, undefined);
    assert.equal(
      php(
        f,
        "$r=$c->api->getItem();if($r->lastResponse()->body!==$r->data||$r->lastResponse()->status!==200||property_exists($r,'meta'))throw new Exception('metadata');echo $r->data->data->id;",
      ),
      'p_1',
    );
    for (const file of ['node/index.d.ts', 'php/src/Client.php'])
      assert.doesNotMatch(f.read(file), /SdkResponse|getItemWithResponse/);
  }
});

for (const sharing of [false, true])
  test(`payload lastResponse retains the declared component (sharing=${sharing})`, async () => {
    const f = fixture({
      responses: { return: 'payload', payloadPath: 'data' },
      sharing,
      operations: { getItem: { aliases: ['retrieve'] } },
      schema: { $ref: '#/components/schemas/GetCustomerResponse' },
      components: {
        schemas: {
          Customer: {
            ...item,
            properties: { ...item.properties, child: { $ref: '#/components/schemas/Customer' } },
          },
          GetCustomerResponse: {
            type: 'object',
            required: ['data', 'request_id', 'meta'],
            properties: {
              data: { $ref: '#/components/schemas/Customer' },
              request_id: { type: 'string' },
              meta: {
                type: 'object',
                required: ['idempotency_replayed'],
                properties: { idempotency_replayed: { type: 'boolean' } },
              },
            },
          },
        },
      },
    });
    const raw =
      '{"data":{"id":"p_1","amount":9007199254740993,"child":{"id":"child"}},"request_id":"body-id","meta":{"idempotency_replayed":true}}';
    const c = await client(f, raw),
      payload = await c.api.getItem(),
      info = payload.lastResponse;
    const value = { id: 'p_1', amount: '9007199254740993', child: { id: 'child' } };
    assert.equal(info.status, 200);
    assert.equal(info.requestId, 'req_00VZKVWV7E7ECWMRV2HQKH1E8M');
    assert.deepEqual(info.requestIds, [info.requestId]);
    assert.equal(info.attempts, 1);
    assert.equal(info.idempotencyKey, undefined);
    assert.ok(info.durationMs >= 0);
    assert.equal(info.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(JSON.stringify(info.body.data)), value);
    assert.equal(info.body.meta.idempotency_replayed, true);
    assert.equal(info.body.request_id, 'body-id');
    assert.deepEqual(Object.getOwnPropertyDescriptor(payload, 'lastResponse'), {
      value: info,
      enumerable: false,
      writable: false,
      configurable: false,
    });
    const reference = Object.assign(Object.create(Object.getPrototypeOf(payload)), {
      ...value,
      child: Object.assign(Object.create(Object.getPrototypeOf(payload.child)), value.child),
    });
    assert.deepEqual(payload, reference);
    assert.deepEqual({ ...payload }, { ...reference });
    assert.deepEqual(structuredClone(payload), value);
    assert.deepEqual(Object.keys(payload).sort(), Object.keys(value).sort());
    assert.equal(JSON.stringify(payload), JSON.stringify(value));
    assert.doesNotMatch(inspect(payload), /lastResponse|requestIds|body-id/);
    assert.equal('lastResponse' in payload.child, false);
    assert.equal((await c.api.retrieve()).lastResponse.body.request_id, 'body-id');
    assert.equal(c.api.getItemWithResponse, undefined);
    assert.equal(c.api.retrieveWithResponse, undefined);
    assert.equal(
      php(
        f,
        String.raw`$p=$c->api->getItem();$r=$p->lastResponse();
if($r->status!==200||$r->requestId!=='req_00VZKVWV7E7ECWMRV2HQKH1E8M'||$r->requestIds!==[$r->requestId]||$r->attempts!==1||$r->durationMs<0||$r->body->meta->idempotency_replayed!==true)throw new Exception('response info');
if($p->child->lastResponse()!==null)throw new Exception('nested metadata');
$made=new Example\ResponseReturn\Customer(['id'=>'made']);if($made->lastResponse()!==null)throw new Exception('user model metadata');
if(method_exists($c->api,'getItemWithResponse')||method_exists($c->api,'retrieveWithResponse')||class_exists('Example\\ResponseReturn\\SdkResponse'))throw new Exception('removed companion');
echo $p->id;`,
        raw,
      ),
      'p_1',
    );
    typecheck(
      f,
      `import {Client, type Customer, type GetCustomerResponse, type ResponseInfo, type WithResponseInfo} from './index.js';
const c=new Client({baseUrl:'https://example.invalid'});const pending:Promise<WithResponseInfo<Customer,GetCustomerResponse>>=c.api.getItem();
const p=await pending;const model:Customer=p;const full:GetCustomerResponse=p.lastResponse.body;const info:ResponseInfo<GetCustomerResponse>=p.lastResponse;
const replayed:boolean=full.meta.idempotency_replayed;
// @ts-expect-error request metadata is readonly
p.lastResponse=info;
// @ts-expect-error no SDK envelope on a payload
p.data;
// @ts-expect-error companions are removed
c.api.getItemWithResponse();
// @ts-expect-error SdkResponse is removed
import type {SdkResponse} from './index.js';`,
    );
  });

test('response info falls back to the decoded body request ID when the header is absent', async () => {
  const f = fixture({
    responses: { return: 'payload', payloadPath: 'data' },
    operations: { getItem: { resource: 'customers', method: 'get' } },
    schema: {
      ...envelope,
      required: ['data', 'request_id'],
      properties: { ...envelope.properties, request_id: { type: 'string' } },
    },
  });
  const { Client } = await import(pathToFileURL(join(f.output, 'node/index.js')));
  const c = new Client({
    baseUrl: 'https://example.invalid',
    transport: async () => Response.json({ data: { id: 'p_1' }, request_id: 'req_body_fallback' }),
  });
  const value = await c.customers.get();
  assert.equal(value.lastResponse.status, 200);
  assert.equal(value.lastResponse.headers['content-type'], 'application/json');
  assert.equal(JSON.stringify(value), '{"id":"p_1"}');
  assert.equal(value.lastResponse.requestId, 'req_body_fallback');
  assert.deepEqual(value.lastResponse.requestIds, ['req_body_fallback']);
  const program = String.raw`require $argv[1].'/src/Runtime.php';require $argv[1].'/src/Client.php';
$c=new Example\ResponseReturn\Client(new Example\ResponseReturn\ClientOptions(baseUrl:'https://example.invalid',transport:fn($r)=>['status'=>200,'headers'=>['content-type'=>'application/json'],'body'=>'{"data":{"id":"p_1"},"request_id":"req_body_fallback"}']));
$r=$c->customers->get()->lastResponse();echo json_encode([$r->requestId,$r->requestIds]);`;
  assert.deepEqual(
    JSON.parse(execFileSync('php', ['-r', program, join(f.output, 'php')], { encoding: 'utf8' })),
    ['req_body_fallback', ['req_body_fallback']],
  );
});

test('payload return diagnostics require objects without a lastResponse field', () => {
  for (const schema of [
    { type: 'string' },
    { type: 'null' },
    { type: ['object', 'null'] },
    { type: 'array', items: item },
    { type: 'object', properties: { lastResponse: { type: 'string' } } },
  ])
    assert.throws(
      () => fixture({ responses: { return: 'payload' }, schema }),
      /lastResponse|object|result/,
    );
  assert.throws(
    () =>
      fixture({
        responses: { return: 'payload' },
        extraResponses: { 204: { description: 'empty' } },
      }),
    /object|result/,
  );
});

test('pages and waits carry their final response while items carry none', async () => {
  const schema = {
    type: 'object',
    required: ['data', 'next', 'state'],
    properties: {
      data: {
        type: 'object',
        required: ['items'],
        properties: { items: { type: 'array', items: item } },
      },
      next: { type: ['string', 'null'] },
      state: { type: 'string' },
    },
  };
  const f = fixture({
    responses: { return: 'payload', payloadPath: 'data' },
    schema,
    parameters: [{ in: 'query', name: 'cursor', schema: { type: 'string' } }],
    operations: {
      getItem: {
        pagination: { kind: 'cursor', items: 'data.items', next: 'next', parameter: 'cursor' },
        polling: { state: 'state', success: ['done'], failure: ['failed'], intervalMs: 1 },
      },
    },
  });
  const { Client } = await import(pathToFileURL(join(f.output, 'node/index.js')));
  let calls = 0;
  const c = new Client({
    baseUrl: 'https://example.invalid',
    transport: async (url) => {
      calls++;
      const second = url.searchParams.has('cursor');
      return Response.json(
        {
          data: { items: [{ id: second ? 'p_2' : 'p_1' }] },
          next: second ? null : 'two',
          state: 'done',
        },
        { headers: { 'x-request-id': `request-${calls}` } },
      );
    },
  });
  const iterator = c.api.getItemPages();
  assert.equal(calls, 0);
  const pages = [];
  for await (const page of iterator) pages.push(page);
  assert.equal(pages[0].lastResponse.requestId, 'request-1');
  assert.equal(pages[1].lastResponse.requestId, 'request-2');
  assert.equal(pages[0].lastResponse.body.next, 'two');
  assert.equal(pages[1].lastResponse.body.next, null);
  const items = [];
  for await (const value of c.api.getItemItems()) {
    assert.equal('lastResponse' in value, false);
    items.push(value.id);
  }
  assert.deepEqual(items, ['p_1', 'p_2']);
  const waited = await c.api.getItemWait();
  assert.equal(waited.lastResponse.body.state, 'done');
  for (const name of ['getItemWithResponse', 'getItemPagesWithResponse', 'getItemWaitWithResponse'])
    assert.equal(c.api[name], undefined);
  assert.equal(
    php(
      f,
      String.raw`foreach($c->api->getItemPages() as $p){if($p->lastResponse()->body->state!=='done'||$p->items[0]->lastResponse()!==null)throw new Exception('page metadata');}
foreach($c->api->getItemItems() as $v)if($v->lastResponse()!==null)throw new Exception('item metadata');
$p=$c->api->getItemWait();if($p->lastResponse()->body->state!=='done')throw new Exception('poll metadata');
foreach(['getItemWithResponse','getItemPagesWithResponse','getItemWaitWithResponse'] as $name)if(method_exists($c->api,$name))throw new Exception('companion');echo 'ok';`,
      '{"data":{"items":[{"id":"p_1"}]},"next":null,"state":"done"}',
    ),
    'ok',
  );
});

test('result-mode binary and event streams expose lastResponse', async () => {
  for (const [media, schema, body] of [
    ['application/pdf', { type: 'string', format: 'binary' }, new Uint8Array([0, 1, 255])],
    ['text/event-stream', {}, 'data: synthetic\n\n'],
  ]) {
    const f = fixture({ responses: { return: 'result' }, schema, media });
    const { Client } = await import(pathToFileURL(join(f.output, 'node/index.js')));
    const c = new Client({
      baseUrl: 'https://example.invalid',
      transport: async () => new Response(body, { headers: { 'content-type': media } }),
    });
    const result = await c.api.getItem();
    assert.equal(result.lastResponse.status, 200);
    assert.equal('meta' in result, false);
    if (media === 'application/pdf') {
      assert.deepEqual(result.data, body);
      assert.deepEqual(result.raw, body);
    } else {
      assert.equal(result.data.lastResponse.status, 200);
      assert.equal('meta' in result.data, false);
      await result.data.close();
    }
    const program = String.raw`require $argv[1].'/src/Runtime.php';require $argv[1].'/src/Client.php';
$media=$argv[2];$c=new Example\ResponseReturn\Client(new Example\ResponseReturn\ClientOptions(baseUrl:'https://example.invalid',transport:function($r)use($media){
if($media==='application/pdf')return ['status'=>200,'headers'=>['content-type'=>$media],'body'=>hex2bin('0001ff')];
return ['status'=>200,'headers'=>['content-type'=>$media],'stream'=>new class implements Example\ResponseReturn\ByteStream {public function read():?string{return null;}public function close():void{}}];}));
$r=$c->api->getItem();if($r->lastResponse()->status!==200||property_exists($r,'meta'))throw new Exception('result metadata');
if($media==='application/pdf'){if(bin2hex($r->data)!=='0001ff'||$r->raw!==$r->data)throw new Exception('binary');}
else{if($r->data->lastResponse()->status!==200||property_exists($r->data,'meta'))throw new Exception('stream metadata');$r->data->close();}echo 'ok';`;
    assert.equal(
      execFileSync('php', ['-r', program, join(f.output, 'php'), media], { encoding: 'utf8' }),
      'ok',
    );
  }
});

test('User-Agent identifies the SDK runtime and validates client appInfo', async () => {
  const f = fixture({
    responses: { return: 'payload', payloadPath: 'data' },
    configExtra: {
      version: '8.0.0',
      npm: { name: 'flintpay-node' },
      composer: { name: 'flintpay/flint', namespace: 'Example\\ResponseReturn' },
    },
  });
  const { Client } = await import(pathToFileURL(join(f.output, 'node/index.js')));
  const suffix = ' storefront/1.2.3 (+https://example.invalid/plugin)';
  for (const appInfo of [
    undefined,
    { name: 'storefront' },
    { name: 'storefront', version: '1.2.3', url: 'https://example.invalid/plugin' },
  ]) {
    let agent;
    const c = new Client({
      baseUrl: 'https://example.invalid',
      ...(appInfo ? { appInfo } : {}),
      transport: async (_url, init) => {
        agent = init.headers['user-agent'];
        return Response.json({ data: { id: 'p_1' } });
      },
    });
    await c.api.getItem();
    assert.equal(
      agent,
      `flintpay-node/8.0.0 (Node.js ${process.versions.node}; ${process.platform} ${process.arch})${appInfo ? (appInfo.version ? suffix : ' storefront') : ''}`,
    );
  }
  for (const appInfo of [
    null,
    {},
    { name: 'bad name', version: '1' },
    { name: 'x', version: '' },
    { name: 'x'.repeat(65), version: '1' },
    { name: 'x', version: '1', url: 'http://example.invalid' },
    { name: 'x', version: '1', url: 'https:example.invalid' },
    { name: 'x', version: '1', url: 'https://example.invalid/' + 'a'.repeat(256) },
    { name: 'x', version: '1', extra: true },
  ])
    assert.throws(() => new Client({ baseUrl: 'https://example.invalid', appInfo }), {
      name: 'ConfigurationError',
      code: 'invalid_option',
    });
  const program = String.raw`require $argv[1].'/src/Runtime.php';require $argv[1].'/src/Client.php';
foreach([null,['name'=>'storefront'],['name'=>'storefront','version'=>'1.2.3','url'=>'https://example.invalid/plugin']] as $app){$agent=null;$c=new Example\ResponseReturn\Client(new Example\ResponseReturn\ClientOptions(...($app===null?[]:['appInfo'=>$app]),baseUrl:'https://example.invalid',transport:function($r)use(&$agent){$agent=$r['headers']['user-agent'];return ['status'=>200,'headers'=>[],'body'=>'{"data":{"id":"p_1"}}'];}));$c->api->getItem();$expected='flintpay-flint/8.0.0 (PHP '.PHP_VERSION.'; '.PHP_OS_FAMILY.')'.($app?(isset($app['version'])?' storefront/1.2.3 (+https://example.invalid/plugin)':' storefront'):'');if($agent!==$expected)throw new Exception($agent);}
foreach([null,[],['name'=>'bad name','version'=>'1'],['name'=>'x','version'=>''],['name'=>str_repeat('x',65),'version'=>'1'],['name'=>'x','version'=>'1','url'=>'http://example.invalid'],['name'=>'x','version'=>'1','url'=>'https:example.invalid'],['name'=>'x','version'=>'1','extra'=>true]] as $app){try{new Example\ResponseReturn\Client(new Example\ResponseReturn\ClientOptions(baseUrl:'https://example.invalid',appInfo:$app));throw new Exception('accepted invalid appInfo');}catch(Example\ResponseReturn\Errors\ConfigurationError $e){if($e->code!=='invalid_option')throw $e;}}echo 'ok';`;
  assert.equal(
    execFileSync('php', ['-r', program, join(f.output, 'php')], { encoding: 'utf8' }),
    'ok',
  );
});

test('return mode and path migrations are breaking in preview and semver policy', () => {
  const legacy = fixture({ responses: { return: 'result' } });
  setCompatibilityBaseline(legacy.output, 'released');
  const opted = fixture({ responses: { return: 'payload', payloadPath: 'data' } });
  const before = compileSdkContract(legacy.contract).plan,
    after = compileSdkContract(opted.contract).plan;
  for (const [a, b] of [
    [before, after],
    [after, before],
  ]) {
    const findings = compareCompiledContracts(a, b);
    assert.ok(
      findings.some((f) => f.subject === 'getItem.responseReturn' && f.severity === 'breaking'),
    );
    assert.throws(() => checkVersionPolicy('1.0.0', '1.0.1', findings), /major/);
  }
  assert.ok(
    preview(opted.contract, legacy.output).compatibility.some(
      (f) => f.subject === 'getItem.responseReturn' && f.severity === 'breaking',
    ),
  );
  assert.deepEqual(compareCompiledContracts(after, structuredClone(after)), []);
});

test('an operation can clear an inherited payload path and return the whole body', async () => {
  const f = fixture({
    responses: { return: 'payload', payloadPath: 'data' },
    operations: { getItem: { response: { payloadPath: null } } },
  });
  const c = await client(f);
  assert.equal((await c.api.getItem()).data.id, 'p_1');
  assert.equal(php(f, 'echo $c->api->getItem()->data->id;'), 'p_1');
});

test('HTTP fixture validation uses the complete body for payload-mode SDKs', async () => {
  const f = fixture({ responses: { return: 'payload', payloadPath: 'data' } });
  const file = join(f.dir, 'cases.json');
  writeFileSync(
    file,
    JSON.stringify([
      {
        name: 'payload response',
        operation: 'getItem',
        input: {},
        expected: { method: 'GET', path: '/v1/item' },
        responses: [
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: '{"data":{"id":"p_1"}}',
          },
        ],
        data: { data: { id: 'p_1' } },
        status: 200,
      },
    ]),
  );
  assert.deepEqual(await validateFixtures(f.output, file), [
    { target: 'node', scenarios: 1 },
    { target: 'php', scenarios: 1 },
  ]);
});
test('payload path changes are breaking even when they select the same type', () => {
  const schema = {
    type: 'object',
    required: ['data', 'other'],
    properties: { data: item, other: item },
  };
  const first = fixture({ responses: { return: 'payload', payloadPath: 'data' }, schema });
  const next = fixture({ responses: { return: 'payload', payloadPath: 'other' }, schema });
  assert.ok(
    compareCompiledContracts(
      compileSdkContract(first.contract).plan,
      compileSdkContract(next.contract).plan,
    ).some((f) => f.subject === 'getItem.responseReturn' && f.severity === 'breaking'),
  );
});

test('named and recursive response schemas support configured payload paths', async () => {
  const f = fixture({
    responses: { return: 'payload', payloadPath: 'data' },
    sharing: true,
    schema: { $ref: '#/components/schemas/Envelope' },
    components: {
      schemas: {
        Envelope: {
          type: 'object',
          required: ['data'],
          properties: { data: { $ref: '#/components/schemas/Item' } },
        },
        Item: {
          ...item,
          properties: { ...item.properties, child: { $ref: '#/components/schemas/Item' } },
        },
      },
    },
  });
  const c = await client(f);
  assert.equal((await c.api.getItem()).id, 'p_1');
  assert.equal(php(f, 'echo $c->api->getItem()->id;'), 'p_1');
  typecheck(
    f,
    `import {Client} from './index.js';const c=new Client({baseUrl:'https://example.invalid'});const p=await c.api.getItem();const id:string=p.id;const child:string|undefined=p.child?.id;`,
  );
});

test('map payloads and unknown tagged variants preserve JSON and carry response info', async () => {
  for (const [schema, body] of [
    [{ type: 'object', additionalProperties: { type: 'string' } }, { label: 'map-value' }],
    [
      {
        discriminator: { propertyName: 'kind' },
        oneOf: ['card', 'bank'].map((kind) => ({
          type: 'object',
          required: ['kind'],
          properties: { kind: { type: 'string', const: kind } },
        })),
      },
      { kind: 'future', retained: 'unknown-value' },
    ],
  ]) {
    const f = fixture({ responses: { return: 'payload' }, schema });
    const c = await client(f, JSON.stringify(body)),
      payload = await c.api.getItem();
    assert.equal(payload.lastResponse.status, 200);
    assert.equal(Object.getOwnPropertyDescriptor(payload, 'lastResponse').enumerable, false);
    assert.deepEqual(JSON.parse(JSON.stringify(payload)), body);
    assert.deepEqual(JSON.parse(JSON.stringify(payload.lastResponse.body)), body);
    assert.equal(
      php(
        f,
        "$p=$c->api->getItem();if(!$p instanceof Example\\ResponseReturn\\Model||$p->lastResponse()->status!==200)throw new Exception('payload metadata');echo json_encode($p);",
        JSON.stringify(body),
      ),
      JSON.stringify(body),
    );
  }
});

test('legacy SdkResponse declarations and response surface versions require a major upgrade', () => {
  const current = compileSdkContract(
    fixture({ responses: { return: 'payload', payloadPath: 'data' } }).contract,
  ).plan;
  const legacy = structuredClone(current);
  legacy.node.errorSurfaceVersion = 1;
  legacy.php.errorSurfaceVersion = 1;
  legacy.node.responseReturnDeclarations =
    'export interface SdkResponse<T> { body:T; meta:unknown; raw:string }';
  const findings = compareCompiledContracts(legacy, current);
  for (const subject of [
    'node.errorSurfaceVersion',
    'php.errorSurfaceVersion',
    'response return declarations',
  ])
    assert.ok(
      findings.some((finding) => finding.subject === subject && finding.severity === 'breaking'),
      JSON.stringify(findings),
    );
  assert.throws(() => checkVersionPolicy('7.0.0', '7.1.0', findings), /major/);
});

test('generic payload models retain configured and schema redaction during inspection', async () => {
  for (const [schema, body, fields, forbidden] of [
    [
      { type: 'object', additionalProperties: { type: 'string' } },
      { label: 'configured-private', token: 'default-private', visible: 'public' },
      ['label'],
      ['configured-private', 'default-private'],
    ],
    [
      { type: 'object', additionalProperties: { type: 'string', 'x-sensitive': true } },
      { arbitrary: 'schema-private' },
      [],
      ['schema-private'],
    ],
  ]) {
    const f = fixture({
      responses: { return: 'payload', payloadPath: 'data' },
      schema: { type: 'object', properties: { data: schema }, required: ['data'] },
    });
    const wire = JSON.stringify({ data: body });
    const { Client } = await import(pathToFileURL(join(f.output, 'node/index.js')));
    const c = new Client({
      baseUrl: 'https://example.invalid',
      redactFields: fields,
      transport: async () => new Response(wire),
    });
    const payload = await c.api.getItem();
    assert.deepEqual(JSON.parse(JSON.stringify(payload)), body);
    for (const value of forbidden) assert.ok(!inspect(payload).includes(value));
    const output = php(
      f,
      '$p=$c->api->getItem();ob_start();var_dump($p);$dump=ob_get_clean();echo json_encode([$p,$dump,$p->lastResponse()->status]);',
      wire,
      fields,
    );
    const [raw, dump, status] = JSON.parse(output);
    assert.deepEqual(raw, body);
    assert.equal(status, 200);
    for (const value of forbidden) assert.ok(!dump.includes(value), dump);
  }
});

test('appInfo URLs preserve Unicode characters through safe ASCII User-Agent encoding', async () => {
  const f = fixture({ responses: { return: 'payload', payloadPath: 'data' } });
  const { Client } = await import(pathToFileURL(join(f.output, 'node/index.js')));
  const urls = ['https://example.invalid/café', 'https://example.invalid/' + 'é'.repeat(230)];
  for (const url of urls) {
    let agent;
    const c = new Client({
      baseUrl: 'https://example.invalid',
      appInfo: { name: 'storefront', url },
      transport: async (_url, request) => {
        agent = request.headers['user-agent'];
        return Response.json({ data: { id: 'p_1' } });
      },
    });
    await c.api.getItem();
    assert.ok(
      agent.endsWith(' storefront (+' + url.replace(/[^\x00-\x7f]/gu, encodeURIComponent) + ')'),
    );
  }
  const program = String.raw`require $argv[1].'/src/Runtime.php';require $argv[1].'/src/Client.php';
foreach(json_decode($argv[2],true,flags:JSON_THROW_ON_ERROR) as $url){$agent=null;$c=new Example\ResponseReturn\Client(new Example\ResponseReturn\ClientOptions(baseUrl:'https://example.invalid',appInfo:['name'=>'storefront','url'=>$url],transport:function($r)use(&$agent){$agent=$r['headers']['user-agent'];return ['status'=>200,'headers'=>[],'body'=>'{"data":{"id":"p_1"}}'];}));$c->api->getItem();$encoded=preg_replace_callback('/[^\x00-\x7f]/u',fn($m)=>rawurlencode($m[0]),$url);if(!str_ends_with($agent,' storefront (+'.$encoded.')'))throw new Exception('Unicode UA');}
try {new Example\ResponseReturn\Client(new Example\ResponseReturn\ClientOptions(baseUrl:'https://example.invalid',appInfo:['name'=>'storefront','url'=>"https://example.invalid/\xff"]));throw new Exception('accepted invalid UTF-8');}catch(Example\ResponseReturn\Errors\ConfigurationError $e){if($e->code!=='invalid_option')throw $e;}echo 'ok';`;
  assert.equal(
    execFileSync('php', ['-r', program, join(f.output, 'php'), JSON.stringify(urls)], {
      encoding: 'utf8',
    }),
    'ok',
  );
});
