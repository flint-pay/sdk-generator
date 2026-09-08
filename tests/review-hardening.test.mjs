import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { loadContract, generate, render } from '../dist/generate.js';

const root = mkdtempSync(join(tmpdir(), 'sdk-hardening-'));
after(() => rmSync(root, { recursive: true, force: true }));
const profile = {
  version: '1.0.0',
  npm: { name: 'hardening-sdk' },
  composer: { name: 'hardening/sdk', namespace: 'HardeningSdk' },
};
const response = (schema) => ({
  200: { description: 'Value', content: { 'application/json': { schema } } },
});
function inputs(label, operation, config = profile, components) {
  const dir = join(root, label);
  mkdirSync(dir);
  const definition = join(dir, 'api.json'),
    configuration = join(dir, 'sdk.json');
  writeFileSync(
    definition,
    JSON.stringify({
      openapi: '3.1.1',
      info: { title: 'Hardening', version: '1' },
      paths: { '/values': operation },
      ...(components ? { components } : {}),
    }),
  );
  writeFileSync(configuration, JSON.stringify(config));
  return { dir, definition, configuration, output: join(dir, 'sdk') };
}
function build(i) {
  generate(loadContract(i.definition, i.configuration), i.output);
}
const clientClass = async (i) =>
  (await import(pathToFileURL(join(i.output, 'node/index.js')).href)).Client;
function phpAsync(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn('php', [file, ...args]);
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (data) => (stdout += data));
    child.stderr.on('data', (data) => (stderr += data));
    child.on('error', reject);
    child.on('close', (status) => {
      if (status !== 0) reject(new Error(stderr + stdout));
      else resolve(JSON.parse(stdout));
    });
  });
}
const phpImports = `<?php
require $argv[1].'/php/src/Runtime.php'; require $argv[1].'/php/src/Client.php';
use HardeningSdk\\{Client,ClientOptions,RequestOptions,SdkError};
`;

test('native clients reject transport-normalized idempotency keys through every input and retain valid retry keys', async () => {
  const i = inputs(
    'keys',
    {
      post: {
        operationId: 'saveValue',
        parameters: [{ in: 'header', name: 'Idempotency-Key', schema: { type: 'string' } }],
        responses: { 204: { description: 'Empty' } },
      },
    },
    {
      ...profile,
      operations: {
        saveValue: {
          idempotency: {
            header: 'Idempotency-Key',
            retention: '24 hours',
            scope: 'operation',
            auto: true,
          },
          retry: { maxAttempts: 2, statuses: [503], transport: false, baseDelayMs: 0 },
        },
      },
    },
  );
  build(i);
  const Client = await clientClass(i);
  const keys = ['', ' ', '\t', ' \t ', ' key', 'key ', '\tkey', 'key\t'];
  const valid = ['0', 'stable-key', 'internal space'];
  const received = [];
  const server = createServer((req, res) => {
    received.push({ method: req.method, key: req.headers['idempotency-key'] });
    req.resume();
    res.writeHead(received.length % 2 ? 503 : 204);
    res.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const client = new Client({ baseUrl, allowInsecureHttp: true });
    for (const key of keys)
      for (const source of ['option', 'header', 'input']) {
        const input = source === 'input' ? { 'Idempotency-Key': key } : {};
        const options =
          source === 'option'
            ? { idempotencyKey: key }
            : source === 'header'
              ? { headers: { 'iDeMpOtEnCy-KeY': key } }
              : {};
        await assert.rejects(
          client.api.saveValue(input, options),
          (e) => e.kind === 'validation' && e.outcome === 'not_sent',
        );
      }
    assert.equal(received.length, 0);
    for (const key of valid) await client.api.saveValue({}, { idempotencyKey: key });
    await client.api.saveValue();
    const nodeCount = received.length;
    const file = join(i.dir, 'keys.php'),
      cases = join(i.dir, 'keys.json');
    writeFileSync(cases, JSON.stringify({ keys, valid }));
    writeFileSync(
      file,
      phpImports +
        `
$c=new Client(new ClientOptions(baseUrl:$argv[2],allowInsecureHttp:true));
$cases=json_decode(file_get_contents($argv[3]),true);$errors=[];
foreach($cases['keys'] as $key) foreach(['option','header','input'] as $source){
  $input=new HardeningSdk\\ApiSaveValueInput($source==='input'?['Idempotency-Key'=>$key]:[]);
  $options=new RequestOptions(idempotencyKey:$source==='option'?$key:null,headers:$source==='header'?['iDeMpOtEnCy-KeY'=>$key]:[]);
  try{$c->api->saveValue($input,$options);$errors[]='sent';}catch(SdkError $e){$errors[]=[$e->kind,$e->outcome];}
}
foreach($cases['valid'] as $key)$c->api->saveValue(new HardeningSdk\\ApiSaveValueInput(),new RequestOptions(idempotencyKey:$key));
$c->api->saveValue();echo json_encode($errors);
`,
    );
    assert.deepEqual(
      await phpAsync(file, [i.output, baseUrl, cases]),
      keys.flatMap(() => Array.from({ length: 3 }, () => ['validation', 'not_sent'])),
    );
    assert.equal(nodeCount, (valid.length + 1) * 2);
    assert.equal(received.length, nodeCount * 2);
    for (const requests of [received.slice(0, nodeCount), received.slice(nodeCount)]) {
      assert.deepEqual(
        requests.slice(0, valid.length * 2).map((r) => r.key),
        valid.flatMap((key) => [key, key]),
      );
      assert.ok(requests.at(-1).key);
      assert.equal(requests.at(-1).key, requests.at(-2).key);
      assert.ok(requests.every((r) => r.method === 'POST'));
    }
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('both clients stop resumed cursor and offset self-loops before yielding duplicate items', async () => {
  for (const [kind, schema, initial, next] of [
    ['cursor', { type: 'string' }, 'fixed', 'fixed'],
    ['offset', { type: 'integer' }, 0, 0],
    ['offset', { type: 'integer', format: 'int64' }, 5, 5],
  ]) {
    const i = inputs(
      `pages-${kind}-${initial}`,
      {
        get: {
          operationId: 'fetchValues',
          parameters: [{ in: 'query', name: 'cursor', schema }],
          responses: response({
            type: 'object',
            required: ['items'],
            properties: {
              items: { type: 'array', items: { type: 'string' } },
              next: { ...schema, type: [schema.type, 'null'] },
            },
          }),
        },
      },
      {
        ...profile,
        operations: {
          fetchValues: { pagination: { kind, parameter: 'cursor', items: 'items', next: 'next' } },
        },
      },
    );
    build(i);
    const Client = await clientClass(i);
    let calls = 0;
    const client = new Client({
      baseUrl: 'https://example.invalid',
      transport: async () => {
        calls++;
        return new Response(JSON.stringify({ items: ['one'], next }));
      },
    });
    const yielded = [];
    await assert.rejects(
      async () => {
        for await (const item of client.api.fetchValuesItems({ cursor: initial }))
          yielded.push(item);
      },
      (e) => e.kind === 'protocol' && /non-advancing/.test(e.message),
    );
    assert.equal(calls, 1);
    assert.deepEqual(yielded, ['one']);
    const { Model } = await import(pathToFileURL(join(i.output, 'node/index.js')).href);
    calls = 0;
    await assert.rejects(
      async () => {
        for await (const _ of client.api.fetchValuesItems({ cursor: new Model(initial, schema) })) {
          // Model-wrapped cursors must be compared using the value sent on the wire.
        }
      },
      (e) => e.kind === 'protocol',
    );
    assert.equal(calls, 1);
    const file = join(i.dir, 'pages.php');
    writeFileSync(
      file,
      phpImports +
        `
$calls=0;$items=[];$kind=null;
$c=new Client(new ClientOptions(baseUrl:'https://example.invalid',transport:function($r)use(&$calls){$calls++;return ['status'=>200,'headers'=>[],'body'=>json_encode(['items'=>['one'],'next'=>json_decode($GLOBALS['argv'][3])])];}));
try{foreach($c->api->fetchValuesItems(new HardeningSdk\\ApiFetchValuesInput(['cursor'=>json_decode($argv[2])])) as $item)$items[]=$item;}catch(SdkError $e){$kind=$e->kind;}
echo json_encode(['calls'=>$calls,'items'=>$items,'kind'=>$kind]);
`,
    );
    assert.deepEqual(
      await phpAsync(file, [i.output, JSON.stringify(initial), JSON.stringify(next)]),
      { calls: 1, items: ['one'], kind: 'protocol' },
    );
    // Advancing continuations and termination still work after resumption.
    let advanceCalls = 0;
    const advancing = new Client({
      baseUrl: 'https://example.invalid',
      transport: async () =>
        new Response(
          JSON.stringify({
            items: [String(++advanceCalls)],
            next: advanceCalls === 1 ? (kind === 'cursor' ? 'advanced' : 10) : null,
          }),
        ),
    });
    const all = [];
    for await (const item of advancing.api.fetchValuesItems({ cursor: initial })) all.push(item);
    assert.deepEqual(all, ['1', '2']);
  }
});

test('diagnosis rejects ambiguous numeric/string alternatives inside objects, arrays, dictionaries and compositions', () => {
  const object = (value) => ({ type: 'object', required: ['value'], properties: { value } });
  const cases = [
    [object({ type: 'string' }), object({ type: 'number' })],
    [
      object({ type: 'object', properties: { amount: { type: 'string' } } }),
      object({ type: 'object', properties: { amount: { type: 'integer', format: 'int64' } } }),
    ],
    [
      { type: 'array', items: { type: 'string' } },
      { type: 'array', items: { type: 'number' } },
    ],
    [
      { type: 'object', additionalProperties: { type: 'string' } },
      { type: 'object', additionalProperties: { type: 'number' } },
    ],
    [{ allOf: [object({ type: 'string' }), { required: ['value'] }] }, object({ type: 'number' })],
    [
      { anyOf: [object({ type: 'string' }), object({ type: 'boolean' })] },
      object({ type: 'number' }),
    ],
  ];
  for (const keyword of ['oneOf', 'anyOf'])
    for (const [index, branches] of cases.entries()) {
      const i = inputs(`ambiguous-${keyword}-${index}`, {
        get: { operationId: 'fetchValue', responses: response({ [keyword]: branches }) },
      });
      assert.throws(
        () => loadContract(i.definition, i.configuration),
        /alternatives have ambiguous SDK string inputs/,
      );
    }
});

test('distinct required tags preserve unambiguous exact-number and string inputs in both clients', async () => {
  const branches = ['string', 'number'].map((type) => ({
    type: 'object',
    required: ['kind', 'value'],
    properties: {
      kind: { type: 'string', enum: [type] },
      value: { type },
    },
  }));
  const i = inputs('tagged', {
    post: {
      operationId: 'saveValue',
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { oneOf: branches } } },
      },
      responses: { 204: { description: 'Empty' } },
    },
  });
  build(i);
  const Client = await clientClass(i),
    bodies = [];
  const client = new Client({
    baseUrl: 'https://example.invalid',
    transport: async (_, init) => {
      bodies.push(init.body);
      return new Response(null, { status: 204 });
    },
  });
  for (const kind of ['string', 'number'])
    await client.api.saveValue({ body: { kind, value: '1.23' } });
  const expected = ['{"kind":"string","value":"1.23"}', '{"kind":"number","value":1.23}'];
  assert.deepEqual(bodies, expected);
  const file = join(i.dir, 'tagged.php');
  writeFileSync(
    file,
    phpImports +
      `
$bodies=[];$c=new Client(new ClientOptions(baseUrl:'https://example.invalid',transport:function($r)use(&$bodies){$bodies[]=$r['body'];return ['status'=>204,'headers'=>[],'body'=>''];}));
foreach(['string','number'] as $kind)$c->api->saveValue(new HardeningSdk\\ApiSaveValueInput(['body'=>['kind'=>$kind,'value'=>'1.23']]));echo json_encode($bodies);
`,
  );
  assert.deepEqual(await phpAsync(file, [i.output]), expected);
  // Explicit discriminators and allOf-wrapped tags retain the same separation.
  for (const schema of [
    { oneOf: branches, discriminator: { propertyName: 'kind' } },
    { anyOf: branches.map((branch) => ({ allOf: [branch, { type: 'object' }] })) },
  ]) {
    const j = inputs(`tagged-extra-${schema.oneOf ? 'one' : 'any'}`, {
      get: { operationId: 'fetchValue', responses: response(schema) },
    });
    render(loadContract(j.definition, j.configuration));
  }
});

test('diagnosis rejects reserved model names and accepts model-renaming recovery', () => {
  for (const name of ['export', 'import', 'this', 'typeof', 'package']) {
    const i = inputs(
      `reserved-${name}`,
      {
        get: {
          operationId: 'export',
          responses: response({ $ref: '#/components/schemas/' + name }),
        },
      },
      profile,
      { schemas: { [name]: { type: 'object' } } },
    );
    const result = spawnSync(
      process.execPath,
      [resolve('dist/cli.js'), 'diagnose', i.definition, i.configuration],
      { encoding: 'utf8' },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /reserved word/);
    const mapped = name[0].toUpperCase() + name.slice(1);
    writeFileSync(i.configuration, JSON.stringify({ ...profile, models: { [name]: mapped } }));
    build(i);
    const consumer = join(i.dir, 'consumer.mts');
    writeFileSync(
      consumer,
      `import { Client, type ${mapped}, make${mapped} } from './sdk/node/index.js'; const value: ${mapped} = {}; make${mapped}(value); new Client({baseUrl:'https://example.invalid'}).api.export();\n`,
    );
    const compiled = spawnSync(
      process.execPath,
      [
        resolve('node_modules/typescript/bin/tsc'),
        '--noEmit',
        '--strict',
        '--module',
        'NodeNext',
        '--target',
        'ES2022',
        consumer,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
    // PHP has no TypeScript type aliases; these component names remain usable.
    writeFileSync(i.configuration, JSON.stringify({ ...profile, targets: ['php'] }));
    build(i);
    const php = spawnSync('php', ['-l', join(i.output, 'php/src/Client.php')], {
      encoding: 'utf8',
    });
    assert.equal(php.status, 0, php.stdout + php.stderr);
  }
});
