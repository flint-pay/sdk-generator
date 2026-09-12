import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { loadContract, generate, validateFixtures } from '../dist/index.js';
import { compileSdkContract } from '../dist/target-plan.js';
import { compareCompiledContracts } from '../dist/compiled-compatibility.js';

const root = mkdtempSync(join(tmpdir(), 'request-style-'));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const string = { type: 'string' };
const body = {
  type: 'object',
  additionalProperties: false,
  properties: { metadata: { type: 'object', additionalProperties: string } },
};
const response = { type: 'object', required: ['id'], properties: { id: string } };
const path = (name) => ({ name, in: 'path', required: true, schema: string });
const query = { name: 'limit', in: 'query', schema: { type: 'integer' } };
function fixture({ style = null, bodySchema = body, config = {}, apiEdit = () => {} } = {}) {
  const dir = join(root, String(n++));
  mkdirSync(dir);
  const operation = (id, extra = {}) => ({
    operationId: id,
    responses: {
      200: { description: 'OK', content: { 'application/json': { schema: response } } },
    },
    ...extra,
  });
  const api = {
    openapi: '3.1.0',
    info: { title: 'Request styles', version: '1' },
    paths: {
      '/orders/{order_id}': {
        get: operation('getOrder', { parameters: [path('order_id')] }),
        patch: operation('updateOrder', {
          parameters: [
            path('order_id'),
            query,
            { name: 'X-Context', in: 'header', schema: string },
          ],
          requestBody: { required: true, content: { 'application/json': { schema: bodySchema } } },
        }),
      },
      '/customers': {
        get: operation('listCustomers', {
          parameters: [query, { name: 'toString', in: 'query', schema: string }],
        }),
        post: operation('createCustomer', {
          requestBody: { required: true, content: { 'application/json': { schema: bodySchema } } },
        }),
      },
      '/parents/{parent_id}/children/{child_id}': {
        get: operation('getChild', { parameters: [path('child_id'), path('parent_id')] }),
      },
      '/optional': {
        post: operation('optional', {
          requestBody: { content: { 'application/json': { schema: bodySchema } } },
        }),
      },
      '/ping': { get: operation('ping') },
    },
  };
  apiEdit(api);
  writeFileSync(join(dir, 'api.json'), JSON.stringify(api));
  writeFileSync(
    join(dir, 'sdk.json'),
    JSON.stringify({
      responses: { return: 'result' },
      version: '1.0.0',
      npm: { name: '@example/requests' },
      composer: { name: 'example/requests', namespace: 'Example\\Requests' },
      ...(style ? { requests: { style } } : {}),
      operations: { updateOrder: { aliases: ['update'], response: { return: 'payload' } } },
      ...config,
    }),
  );
  const contract = loadContract(join(dir, 'api.json'), join(dir, 'sdk.json'));
  const output = join(dir, 'out');
  generate(contract, output);
  return { contract, output, dir, read: (p) => readFileSync(join(output, p), 'utf8') };
}
async function client(f) {
  const { Client } = await import(pathToFileURL(join(f.output, 'node/index.js')));
  const requests = [];
  return {
    requests,
    c: new Client({
      baseUrl: 'https://example.invalid',
      transport: async (url, init) => {
        requests.push({ path: url.pathname + url.search, body: init.body, headers: init.headers });
        return new Response('{"id":"ok"}', { headers: { 'content-type': 'application/json' } });
      },
    }),
  };
}
function php(f, source) {
  return execFileSync(
    'php',
    [
      '-r',
      `require $argv[1].'/src/Runtime.php'; require $argv[1].'/src/Client.php'; use Example\\Requests\\{Client,ClientOptions,RequestOptions}; $requests=[]; $c=new Client(new ClientOptions('https://example.invalid', transport: function($r) use (&$requests) { $requests[]=$r; return ['status'=>200,'headers'=>['content-type'=>'application/json'],'body'=>'{"id":"ok"}']; })); ${source}`,
      join(f.output, 'php'),
    ],
    { encoding: 'utf8' },
  );
}
test('positional Node calls preserve URL, JSON body, headers, options, aliases and WithResponse', async () => {
  const f = fixture();
  const { c, requests } = await client(f);
  await c.api.getOrder('ord/1', { headers: { 'x-test': 'yes' } });
  assert.equal(requests.at(-1).path, '/orders/ord%2F1');
  assert.equal(requests.at(-1).headers['x-test'], 'yes');
  assert.equal(
    (await c.api.update('ord1', { metadata: { source: 'store' }, limit: 5, 'X-Context': 'ctx' }))
      .id,
    'ok',
  );
  assert.equal(requests.at(-1).body, '{"metadata":{"source":"store"}}');
  assert.equal(requests.at(-1).path, '/orders/ord1?limit=5');
  assert.equal(requests.at(-1).headers['x-context'], 'ctx');
  assert.equal((await c.api.updateOrderWithResponse('ord1', {})).body.id, 'ok');
  await c.api.getChild('parent', 'child');
  assert.equal(requests.at(-1).path, '/parents/parent/children/child');
  await c.api.listCustomers({ limit: 100 });
  assert.equal(requests.at(-1).path, '/customers?limit=100');
  await c.api.createCustomer({ metadata: { source: 'store' } });
  assert.equal(requests.at(-1).body, '{"metadata":{"source":"store"}}');
  await c.api.optional();
  assert.equal(requests.at(-1).body, undefined);
  await c.api.optional({});
  assert.equal(requests.at(-1).body, '{}');
  await c.api.ping({ headers: { 'x-test': 'ping' } });
  assert.equal(requests.at(-1).headers['x-test'], 'ping');
  const count = requests.length;
  await assert.rejects(c.api.createCustomer(), { kind: 'validation' });
  await assert.rejects(c.api.updateOrder('ord1', []), { kind: 'validation' });
  await assert.rejects(c.api.updateOrder('ord1', { unexpected: true }), { kind: 'validation' });
  await assert.rejects(c.api.getOrder({ order_id: 'old' }), { kind: 'validation' });
  assert.equal(requests.length, count);
});
test('PHP positional methods dispatch the same wire request', () => {
  const f = fixture();
  const result = php(
    f,
    `$c->api->getOrder('ord/1', new RequestOptions(headers:['x-test'=>'yes'])); $c->api->update('ord1', ['metadata'=>['source'=>'store'],'limit'=>5,'X-Context'=>'ctx']); $c->api->getChild('parent','child'); $c->api->optional(); $c->api->optional([]); $r=$c->api->updateOrderWithResponse('ord1', []); if($r->body->id!=='ok') throw new Exception('response'); echo json_encode($requests);`,
  );
  const requests = JSON.parse(result);
  assert.match(requests[0].url, /orders\/ord%2F1$/);
  assert.match(requests[1].url, /orders\/ord1\?limit=5$/);
  assert.equal(requests[1].body, '{"metadata":{"source":"store"}}');
  assert.equal(requests[1].headers['x-context'], 'ctx');
  assert.match(requests[2].url, /parents\/parent\/children\/child$/);
  assert.equal(requests[3].body, null);
  assert.equal(requests[4].body, '{}');
});
test('TypeScript declarations and generated examples use the selected call style', () => {
  const f = fixture();
  const source = `import {Client} from './index.js'; const c=new Client({baseUrl:'https://example.invalid'});
await c.api.getOrder('id', {headers:{'x-test':'ok'}});
await c.api.updateOrder('id', {metadata:{source:'store'},limit:5});
await c.api.getChild('parent','child'); await c.api.optional(); await c.api.listCustomers({limit:100}); await c.api.listCustomers({}); await c.api.listCustomers({toString:'text'}); await c.api.ping({maxAttempts:1});
// @ts-expect-error Path object is no longer accepted
await c.api.getOrder({order_id:'id'});
// @ts-expect-error Body wrapper is no longer accepted
await c.api.updateOrder('id', {body:{metadata:{source:'store'}}});
// @ts-expect-error Missing required path
await c.api.getOrder();
// @ts-expect-error Params are required for a required body
await c.api.updateOrder('id');`;
  const file = join(f.output, 'node/check.ts');
  writeFileSync(file, source);
  try {
    execFileSync(
      process.execPath,
      [
        resolve('node_modules/typescript/bin/tsc'),
        '--strict',
        '--noEmit',
        '--module',
        'nodenext',
        '--target',
        'es2022',
        '--typeRoots',
        resolve('node_modules/@types'),
        file,
        ...Object.keys(f.contract.operations).map((_, i) =>
          join(f.output, 'node/examples/api-' + f.contract.operations[i].method + '.ts'),
        ),
      ],
      { stdio: 'pipe' },
    );
  } catch (e) {
    throw new Error(e.stdout.toString());
  }
  for (const op of f.contract.operations)
    execFileSync('php', ['-l', join(f.output, 'php/examples/api-' + op.method + '.php')]);
});
test('explicit object style and operation overrides retain the old signature; migration is breaking', async () => {
  const old = fixture({ style: 'object' });
  const next = fixture();
  const { c } = await client(old);
  assert.equal((await c.api.getOrder({ order_id: 'id' })).data.id, 'ok');
  assert.equal(php(old, "echo $c->api->getOrder(['order_id'=>'id'])->data->id;"), 'ok');
  const overridden = fixture({
    config: { operations: { getOrder: { request: { style: 'object' } } } },
  });
  assert.equal((await (await client(overridden)).c.api.getOrder({ order_id: 'id' })).data.id, 'ok');
  const changes = compareCompiledContracts(
    compileSdkContract(old.contract).plan,
    compileSdkContract(next.contract).plan,
  );
  assert.ok(changes.some((c) => c.severity === 'breaking' && /request argument/.test(c.message)));
});
test('invalid styles and ambiguous flat bodies fail with actionable diagnostics', () => {
  assert.throws(() => fixture({ style: 'stripe' }), /expected object or positional/);
  assert.throws(() => fixture({ config: { requests: { wat: true } } }), /config\/requests\/wat/);
  assert.throws(
    () => fixture({ bodySchema: { type: 'array', items: string } }),
    /non-null object body/,
  );
  assert.throws(
    () => fixture({ bodySchema: { ...body, properties: { limit: string } } }),
    /conflicts with parameter limit/,
  );
  assert.throws(
    () => fixture({ bodySchema: { ...body, additionalProperties: string } }),
    /typed dictionary body/,
  );
});
test('canonical HTTP fixtures exercise positional Node and PHP entrypoints', async () => {
  const f = fixture();
  const file = join(f.dir, 'cases.json');
  writeFileSync(
    file,
    JSON.stringify([
      {
        name: 'flat update',
        operation: 'updateOrder',
        input: { order_id: 'ord1', body: { metadata: { source: 'store' } }, limit: 5 },
        expected: {
          method: 'PATCH',
          path: '/v1/orders/ord1?limit=5',
          body: '{"metadata":{"source":"store"}}',
        },
        responses: [
          { status: 200, headers: { 'content-type': 'application/json' }, body: '{"id":"ok"}' },
        ],
        data: { id: 'ok' },
      },
    ]),
  );
  assert.equal((await validateFixtures(f.output, file)).length, 2);
});

test('Flint default positional calls pass its source-informed HTTP fixtures in both targets', async () => {
  const dir = join(root, 'flint');
  mkdirSync(dir);
  const config = JSON.parse(readFileSync('tests/providers/flint/sdk.json'));
  delete config.requests;
  writeFileSync(join(dir, 'sdk.json'), JSON.stringify(config));
  const contract = loadContract('tests/providers/flint/openapi.json', join(dir, 'sdk.json'));
  const output = join(dir, 'out');
  generate(contract, output);
  assert.equal(
    contract.operations.every((op) => op.request?.style === 'positional'),
    true,
  );
  assert.equal((await validateFixtures(output, 'tests/providers/flint/http-cases.json')).length, 2);
});

test('pagination and polling share positional path IDs and flat query params', async () => {
  const f = fixture({
    apiEdit(api) {
      const op = api.paths['/orders/{order_id}'].get;
      op.parameters.push({ name: 'after', in: 'query', schema: string });
      op.responses[200].content['application/json'].schema = {
        type: 'object',
        required: ['data', 'next', 'state'],
        properties: {
          data: { type: 'array', items: response },
          next: { type: ['string', 'null'] },
          state: string,
        },
      };
    },
    config: {
      operations: {
        getOrder: {
          pagination: { kind: 'cursor', items: 'data', next: 'next', parameter: 'after' },
          polling: { state: 'state', success: ['done'], failure: ['failed'], intervalMs: 1 },
        },
      },
    },
  });
  const { Client } = await import(pathToFileURL(join(f.output, 'node/index.js')));
  const seen = [];
  const c = new Client({
    baseUrl: 'https://example.invalid',
    transport: async (url) => {
      seen.push(url.pathname + url.search);
      return new Response(
        JSON.stringify({
          data: [{ id: url.search ? 'second' : 'first' }],
          next: url.search ? null : 'token',
          state: 'done',
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    },
  });
  const ids = [];
  for await (const item of c.api.getOrderItems('ord1')) ids.push(item.id);
  assert.deepEqual(ids, ['first', 'second']);
  assert.deepEqual(seen, ['/orders/ord1', '/orders/ord1?after=token']);
  assert.equal((await c.api.getOrderWait('ord1')).data.state, 'done');
  const pageResult = execFileSync(
    'php',
    [
      '-r',
      `require $argv[1].'/src/Runtime.php'; require $argv[1].'/src/Client.php'; use Example\\Requests\\{Client,ClientOptions}; $seen=[]; $c=new Client(new ClientOptions('https://example.invalid',transport:function($r)use(&$seen){$seen[]=$r['url']; $next=str_contains($r['url'],'?')?null:'token'; return ['status'=>200,'headers'=>['content-type'=>'application/json'],'body'=>json_encode(['data'=>[['id'=>'ok']],'next'=>$next,'state'=>'done'])];})); $items=iterator_to_array($c->api->getOrderItems('ord1')); $wait=$c->api->getOrderWait('ord1'); if(count($items)!==2 || $wait->data->state!=='done')throw new Exception('helper result'); echo json_encode($seen);`,
      join(f.output, 'php'),
    ],
    { encoding: 'utf8' },
  );
  assert.deepEqual(JSON.parse(pageResult), [
    'https://example.invalid/orders/ord1',
    'https://example.invalid/orders/ord1?after=token',
    'https://example.invalid/orders/ord1',
  ]);
});

test('positional types allow option-supplied idempotency and query-only optional bodies', async () => {
  const f = fixture({
    bodySchema: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: { name: string, description: string },
    },
    apiEdit(api) {
      api.paths['/optional'].post.parameters = [query];
      api.paths['/customers'].post.parameters = [
        { name: 'Idempotency-Key', in: 'header', required: true, schema: string },
      ];
      api.paths['/ping'].get.parameters = [
        { name: 'Idempotency-Key', in: 'header', required: true, schema: string },
      ];
    },
    config: {
      operations: Object.fromEntries(
        ['createCustomer', 'ping'].map((id) => [
          id,
          {
            idempotency: { header: 'idempotency-key', retention: '24h', scope: 'command' },
          },
        ]),
      ),
    },
  });
  const { c, requests } = await client(f);
  await c.api.createCustomer({ name: 'a' }, { idempotencyKey: 'key' });
  assert.equal(requests.at(-1).headers['idempotency-key'], 'key');
  await c.api.ping(undefined, { idempotencyKey: 'key' });
  await assert.rejects(c.api.ping(), { kind: 'validation' });
  await c.api.optional({ limit: 2 });
  assert.equal(requests.at(-1).path, '/optional?limit=2');
  assert.equal(requests.at(-1).body, undefined);
  await c.api.optional({ limit: 2, name: 'a' });
  assert.equal(requests.at(-1).body, '{"name":"a"}');
  await assert.rejects(c.api.optional({ limit: 2, description: 'partial' }), {
    kind: 'validation',
  });
  const file = join(f.output, 'node/check.ts');
  writeFileSync(
    file,
    `import {Client} from './index.js'; const c=new Client({baseUrl:'https://example.invalid'});
await c.api.createCustomer({name:'a'}, {idempotencyKey:'key'});
await c.api.ping(undefined, {idempotencyKey:'key'});
await c.api.ping();
await c.api.optional({limit:2});
await c.api.optional({limit:2,name:'a'});
// @ts-expect-error A supplied body must include its required fields
await c.api.optional({limit:2,description:'partial'});
// @ts-expect-error Required bodies still require params
await c.api.createCustomer();
`,
  );
  execFileSync(
    process.execPath,
    [
      resolve('node_modules/typescript/bin/tsc'),
      '--strict',
      '--noEmit',
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
  const result = JSON.parse(
    php(
      f,
      `$c->api->createCustomer(['name'=>'a'], new RequestOptions(idempotencyKey:'key')); $c->api->ping(options: new RequestOptions(idempotencyKey:'key')); $c->api->optional(['limit'=>2]); echo json_encode($requests);`,
    ),
  );
  assert.equal(result[0].headers['idempotency-key'], 'key');
  assert.equal(result[1].headers['idempotency-key'], 'key');
  assert.equal(result[2].body, null);
});

test('path arguments cannot shadow generated request and response helpers', async () => {
  const f = fixture({
    apiEdit(api) {
      const op = api.paths['/orders/{order_id}'].get;
      delete api.paths['/orders/{order_id}'].get;
      op.parameters = ['_sdkRequestInput', '_sdkPayload', '_sdkResponse'].map(path);
      api.paths['/helpers/{_sdkRequestInput}/{_sdkPayload}/{_sdkResponse}'] = { get: op };
    },
    config: { operations: { getOrder: { response: { return: 'payload' } } } },
  });
  const { c, requests } = await client(f);
  assert.equal((await c.api.getOrder('one', 'two', 'three')).id, 'ok');
  assert.equal((await c.api.getOrderWithResponse('one', 'two', 'three')).body.id, 'ok');
  assert.equal(requests.at(-1).path, '/helpers/one/two/three');
  assert.equal(php(f, "echo $c->api->getOrder('one','two','three')->id;"), 'ok');
});
