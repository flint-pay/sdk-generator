import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { loadContract, generate, preview, validateFixtures } from '../dist/index.js';
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
            200: { description: 'OK', content: { 'application/json': { schema } } },
            ...extraResponses,
          },
        },
      },
    },
  };
  const config = {
    version: '1.0.0',
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
        headers: { 'content-type': 'application/json', 'x-request-id': 'req_1' },
      }),
  });
}
function php(f, program, body = '{"data":{"id":"p_1","amount":9007199254740993},"next":null}') {
  return execFileSync(
    'php',
    [
      '-r',
      `require $argv[1].'/src/Runtime.php';require $argv[1].'/src/Client.php';
use Example\\ResponseReturn\\{Client,ClientOptions};
$c=new Client(new ClientOptions('https://example.invalid',transport:fn($r)=>['status'=>200,'headers'=>['content-type'=>'application/json','x-request-id'=>'req_1'],'body'=>$argv[2]]));
${program}`,
      join(f.output, 'php'),
      body,
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

test('unchanged configs retain Result, and a per-operation opt-out overrides SDK defaults', async () => {
  for (const options of [
    {},
    {
      responses: { return: 'payload', payloadPath: 'data' },
      operations: { getItem: { response: { return: 'result' } } },
    },
  ]) {
    const f = fixture(options),
      c = await client(f);
    assert.equal((await c.api.getItem()).data.data.id, 'p_1');
    assert.equal(c.api.getItemWithResponse, undefined);
    assert.equal(php(f, 'echo $c->api->getItem()->data->data->id;'), 'p_1');
  }
});
for (const sharing of [false, true])
  test(`payload paths and WithResponse preserve exact values in both targets (sharing=${sharing})`, async () => {
    const f = fixture({
      responses: { return: 'payload' },
      operations: { getItem: { aliases: ['retrieve'], response: { payloadPath: 'data' } } },
      sharing,
    });
    const c = await client(f);
    assert.equal((await c.api.getItem()).id, 'p_1');
    assert.equal((await c.api.retrieve()).amount, '9007199254740993');
    const full = await c.api.getItemWithResponse();
    assert.equal(full.body.data.id, 'p_1');
    assert.equal(full.meta.status, 200);
    assert.match(full.raw, /9007199254740993/);
    assert.equal(full.data, undefined);
    assert.equal((await c.api.retrieveWithResponse()).body.data.id, 'p_1');
    assert.equal(
      php(
        f,
        "$p=$c->api->getItem();$r=$c->api->retrieveWithResponse();if($p->amount!=='9007199254740993'||$r->meta['status']!==200)throw new Exception('wrong value');echo $p->id.' '.$r->body->data->id;",
      ),
      'p_1 p_1',
    );
    typecheck(
      f,
      `import {Client} from './index.js';const c=new Client({baseUrl:'https://example.invalid'});const p=await c.api.getItem();const id:string=p.id;const amount:string|undefined=p.amount;const r=await c.api.getItemWithResponse();const other:string=r.body.data.id;
// @ts-expect-error No SDK envelope on a payload
const wrong:string=p.data;
// @ts-expect-error Metadata is only on WithResponse
const metadata:string=p.meta;`,
    );
    assert.doesNotMatch(f.read('node/examples/api-getItem.mjs'), /result\.data|result\.meta/);
    assert.match(f.read('node/examples/api-getItem.mjs'), /result.id/);
    assert.doesNotMatch(f.read('php/examples/api-getItem.php'), /result->data|result->meta/);
  });
test('whole-body payload returns support bare objects, scalars, null and empty responses', async () => {
  for (const [schema, body, expected] of [
    [item, '{"id":"bare"}', { id: 'bare' }],
    [{ type: 'string' }, '"value"', 'value'],
    [{ type: 'null' }, 'null', null],
  ]) {
    const f = fixture({ responses: { return: 'payload' }, schema });
    const c = await client(f, body);
    assert.equal(JSON.stringify(await c.api.getItem()), JSON.stringify(expected));
    assert.equal(php(f, 'echo json_encode($c->api->getItem());', body), body);
  }
  const f = fixture({
    responses: { return: 'payload' },
    extraResponses: { 204: { description: 'empty' } },
  });
  const c = await client(f, '', 204);
  assert.equal(await c.api.getItem(), undefined);
  assert.equal((await c.api.getItemWithResponse()).body, undefined);
});
test('payload path configuration rejects missing, optional, nullable and mixed success paths', () => {
  const bad = [
    { type: 'object', properties: { data: item } },
    { type: 'object', required: ['other'], properties: { other: item } },
    { type: ['object', 'null'], required: ['data'], properties: { data: item } },
    { oneOf: [envelope, item] },
  ];
  for (const schema of bad)
    assert.throws(
      () => fixture({ responses: { return: 'payload', payloadPath: 'data' }, schema }),
      /payloadPath/,
    );
  assert.throws(
    () =>
      fixture({
        responses: { return: 'payload', payloadPath: 'data' },
        extraResponses: { 204: { description: 'empty' } },
      }),
    /payloadPath/,
  );
  for (const responses of [
    { return: 'auto' },
    { return: 'payload', payloadPath: '' },
    { return: 'payload', payloadPath: 'data..id' },
    { return: 'payload', payloadPath: '__proto__' },
    { other: true },
  ])
    assert.throws(() => fixture({ responses }), /response/);
  assert.throws(
    () => fixture({ operations: { getItem: { response: { payloadPath: 'data' } } } }),
    /requires return/,
  );
  assert.throws(
    () =>
      fixture({
        responses: { return: 'payload' },
        operations: { getItem: { aliases: ['getItemWithResponse'] } },
      }),
    /collision/,
  );
});
test('nested and composed payload paths are validated and decoded', async () => {
  const schema = {
    allOf: [
      { type: 'object', required: ['wrapper'] },
      {
        properties: {
          wrapper: { anyOf: [envelope, { ...envelope, properties: { data: { type: 'null' } } }] },
        },
      },
    ],
  };
  const f = fixture({ responses: { return: 'payload', payloadPath: 'wrapper.data' }, schema });
  const c = await client(f, '{"wrapper":{"data":null}}');
  assert.equal(await c.api.getItem(), null);
  assert.equal(
    php(f, 'echo json_encode($c->api->getItem());', '{"wrapper":{"data":null}}'),
    'null',
  );
});
test('return mode and path migrations are breaking in preview and semver policy', () => {
  const legacy = fixture();
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
test('pagination and polling continue reading full response envelopes', async () => {
  const schema = {
    type: 'object',
    required: ['data', 'next', 'state'],
    properties: {
      data: { type: 'array', items: item },
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
        pagination: { kind: 'cursor', items: 'data', next: 'next', parameter: 'cursor' },
        polling: { state: 'state', success: ['done'], failure: ['failed'], intervalMs: 1 },
      },
    },
  });
  const sdk = await import(pathToFileURL(join(f.output, 'node/index.js')));
  let calls = 0;
  const c = new sdk.Client({
    baseUrl: 'https://example.invalid',
    transport: async (url) => {
      calls++;
      return new Response(
        JSON.stringify({
          data: [{ id: url.searchParams.has('cursor') ? 'p_2' : 'p_1' }],
          next: url.searchParams.has('cursor') ? null : 'two',
          state: 'done',
        }),
        { status: 200 },
      );
    },
  });
  const values = [];
  for await (const value of c.api.getItemItems()) values.push(value.id);
  assert.deepEqual(values, ['p_1', 'p_2']);
  assert.equal(calls, 2);
  const pages = [];
  for await (const page of c.api.getItemPages()) pages.push(page);
  assert.equal(pages[0].data.next, 'two');
  assert.equal(pages[1].meta.status, 200);
  assert.equal((await c.api.getItemWait({})).data.state, 'done');
  assert.equal((await c.api.getItem())[0].id, 'p_1');
  assert.equal(
    php(
      f,
      "$ids=[];foreach($c->api->getItemItems() as $v)$ids[]=$v->id;foreach($c->api->getItemPages() as $p){if($p->meta['status']!==200)throw new Exception('metadata');}if($c->api->getItemWait([])->data->state!=='done')throw new Exception('polling');echo implode(',', $ids);",
      '{"data":[{"id":"p_1"}],"next":null,"state":"done"}',
    ),
    'p_1',
  );
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
test('binary whole-body returns retain bytes and full-response metadata', async () => {
  const f = fixture({
    responses: { return: 'payload' },
    extraResponses: {
      206: {
        description: 'binary',
        content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } },
      },
    },
  });
  const sdk = await import(pathToFileURL(join(f.output, 'node/index.js')));
  const bytes = new Uint8Array([0, 1, 255]);
  const c = new sdk.Client({
    baseUrl: 'https://example.invalid',
    transport: async () =>
      new Response(bytes, { status: 206, headers: { 'content-type': 'application/pdf' } }),
  });
  assert.deepEqual(await c.api.getItem(), bytes);
  const full = await c.api.getItemWithResponse();
  assert.deepEqual(full.body, bytes);
  assert.equal(full.body, full.raw);
  assert.equal(full.meta.status, 206);
  const program = `require $argv[1].'/src/Runtime.php';require $argv[1].'/src/Client.php';$c=new Example\\ResponseReturn\\Client(new Example\\ResponseReturn\\ClientOptions('https://example.invalid',transport:fn($r)=>['status'=>206,'headers'=>['content-type'=>'application/pdf'],'body'=>hex2bin('0001ff')]));$r=$c->api->getItemWithResponse();if($r->body!==$r->raw||$r->meta['status']!==206)throw new Exception('full response');echo bin2hex($c->api->getItem());`;
  assert.equal(
    execFileSync('php', ['-r', program, join(f.output, 'php')], { encoding: 'utf8' }),
    '0001ff',
  );
});
test('payload-mode generated examples and README use the selected return shape', async () => {
  const f = fixture({ responses: { return: 'payload', payloadPath: 'data' } });
  for (const name of ['node/examples/api-getItem.mjs', 'node/README.md']) {
    let source = f.read(name);
    if (name.endsWith('.md')) source = source.match(/```typescript\n([\s\S]*?)```/)[1];
    source = source
      .replace(/from ['"](?:\.\.\/)?index\.js['"]/, "from './index.js'")
      .replace(
        'new Client({',
        `new Client({transport:async()=>new Response('{"data":{"id":"p_1"}}',{status:200}),`,
      );
    const file = join(f.output, 'node/run-example.mjs');
    writeFileSync(file, source);
    assert.match(execFileSync(process.execPath, [file], { encoding: 'utf8' }), /p_1/);
  }
  assert.match(f.read('php/REFERENCE.md'), /getItemWithResponse/);
  assert.doesNotMatch(f.read('node/README.md'), /result\.data\.data/);
});
