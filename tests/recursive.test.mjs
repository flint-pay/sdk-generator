import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { inspect } from 'node:util';
import { loadContract, generate } from '../dist/index.js';
import { validateFixtures } from '../dist/fixtures.js';
const dir = mkdtempSync(join(tmpdir(), 'sdk-recursive-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const tree = {
  type: 'object',
  required: ['id', 'amount'],
  properties: {
    id: { type: 'string' },
    amount: { type: 'integer', format: 'int64' },
    privateValue: { type: 'string', 'x-sensitive': true },
    children: { type: 'array', items: { $ref: '#/components/schemas/Tree' } },
  },
};
const content = (name) => ({
  'application/json': { schema: { $ref: '#/components/schemas/' + name } },
});
const document = {
  openapi: '3.1.0',
  info: { title: 'Trees', version: 'v1' },
  components: { schemas: { Tree: tree, Unrelated: { $ref: '#/components/schemas/Unrelated' } } },
  paths: {},
};
document.paths['/trees'] = {
  post: {
    operationId: 'saveTree',
    requestBody: { required: true, content: content('Tree') },
    responses: { 200: { content: content('Tree') } },
  },
};
document.paths['/private'] = {
  post: {
    operationId: 'privateOperation',
    requestBody: { content: content('Unrelated') },
    responses: { 204: { description: 'empty' } },
  },
};
const config = {
  version: '1.0.0',
  include: ['saveTree'],
  models: { Tree: 'Branch' },
  npm: { name: '@example/trees' },
  composer: { name: 'example/trees', namespace: 'Example\\Trees' },
};
const api = join(dir, 'api.json'),
  settings = join(dir, 'sdk.json'),
  output = join(dir, 'sdk');
writeFileSync(api, JSON.stringify(document));
writeFileSync(settings, JSON.stringify(config));
const contract = loadContract(api, settings);
generate(contract, output);
const data = {
  id: 'a',
  amount: '9007199254740993',
  children: [
    {
      id: 'b',
      amount: '9007199254740994',
      privateValue: 'nested-sensitive-value',
      children: [{ id: 'c', amount: '10', privateValue: 'nested-sensitive-value', children: [] }],
    },
  ],
};

test('selected recursive models preserve aliases, exact numbers and wire behavior in both targets', async () => {
  assert.ok(contract.definitions.Branch);
  assert.equal(contract.models.Unrelated, undefined);
  const cases = [
    {
      name: 'nested tree',
      operation: 'saveTree',
      input: { body: data },
      expected: {
        method: 'POST',
        path: '/v1/trees',
        body: '{"id":"a","amount":9007199254740993,"children":[{"id":"b","amount":9007199254740994,"privateValue":"nested-sensitive-value","children":[{"id":"c","amount":10,"privateValue":"nested-sensitive-value","children":[]}]}]}',
      },
      responses: [
        {
          status: 200,
          body: '{"id":"a","amount":9007199254740993,"children":[{"id":"b","amount":9007199254740994,"privateValue":"nested-sensitive-value","children":[{"id":"c","amount":10,"privateValue":"nested-sensitive-value","children":[]}]}]}',
        },
      ],
      data,
    },
    {
      name: 'missing recursive field',
      operation: 'saveTree',
      input: { body: { id: 'a', amount: '1', children: [{ id: 'b' }] } },
      responses: [],
      error: { kind: 'validation' },
      attempts: 0,
    },
  ];
  const path = join(dir, 'cases.json');
  writeFileSync(path, JSON.stringify(cases));
  assert.deepEqual(
    (await validateFixtures(output, path)).map((r) => r.scenarios),
    [2, 2],
  );
  assert.equal(readFileSync(join(output, 'node/index.js'), 'utf8').includes('Unrelated'), false);
});

test('recursive factories and response inspection do not expose nested sensitive values', async () => {
  const { Client, makeBranch } = await import(pathToFileURL(join(output, 'node/index.js')).href);
  const model = makeBranch(data);
  assert.equal(inspect(model, { depth: 20 }).includes('nested-sensitive-value'), false);
  const client = new Client({
    baseUrl: 'https://example.invalid',
    transport: async () => new Response(JSON.stringify(data)),
  });
  const response = await client.api.saveTree({ body: model });
  assert.equal(inspect(response, { depth: 20 }).includes('nested-sensitive-value'), false);
  const code = `require $argv[1].'/src/Runtime.php';require $argv[1].'/src/Client.php';$data=json_decode($argv[2],true);$model=new Example\\Trees\\BranchInput($data);var_dump($model);$client=new Example\\Trees\\Client(new Example\\Trees\\ClientOptions('https://example.invalid',transport:fn($r)=>['status'=>200,'headers'=>[],'body'=>$argv[2]]));$result=$client->api->saveTree(new Example\\Trees\\ApiSaveTreeInput(['body'=>$model]));var_dump($result->data);`;
  const php = spawnSync('php', ['-r', code, join(output, 'php'), JSON.stringify(data)], {
    encoding: 'utf8',
  });
  assert.equal(php.status, 0, php.stderr);
  assert.equal(php.stdout.includes('nested-sensitive-value'), false);
});

test('recursive TypeScript inputs retain named child types', () => {
  const file = join(output, 'node/consumer.ts');
  writeFileSync(
    file,
    `import{Client,makeBranch,type BranchInput}from'./index.js';const branch:BranchInput={id:'a',amount:'1',children:[{id:'b',amount:'2'}]};
// @ts-expect-error every nested node needs its amount
const invalid:BranchInput={id:'a',amount:'1',children:[{id:'b'}]};
const c=new Client({baseUrl:'https://example.invalid'});await c.api.saveTree({body:makeBranch(branch)});`,
  );
  const result = spawnSync(
    process.execPath,
    [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '--strict',
      '--skipLibCheck',
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      file,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('nonproductive recursive definitions are diagnosed when selected', () => {
  const path = join(dir, 'all.json');
  writeFileSync(path, JSON.stringify({ ...config, include: ['privateOperation'] }));
  assert.throws(() => loadContract(api, path), /must descend/);
});

test('external recursive files retain stable model names and source hashes', async () => {
  const external = {
    ...tree,
    properties: { ...tree.properties, children: { type: 'array', items: { $ref: 'node.json' } } },
  };
  const definition = structuredClone(document);
  delete definition.paths['/private'];
  delete definition.components;
  definition.paths['/trees'].post.requestBody.content['application/json'].schema = {
    $ref: './node.json',
  };
  definition.paths['/trees'].post.responses[200].content['application/json'].schema = {
    $ref: './node.json',
  };
  const externalApi = join(dir, 'external.json'),
    node = join(dir, 'node.json'),
    externalConfig = join(dir, 'external-sdk.json');
  writeFileSync(node, JSON.stringify(external));
  writeFileSync(externalApi, JSON.stringify(definition));
  writeFileSync(externalConfig, JSON.stringify({ ...config, models: {} }));
  const c = loadContract(externalApi, externalConfig);
  assert.ok(c.sources['node.json']);
  assert.equal(Object.keys(c.definitions).length, 1);
  const relocated = join(dir, 'relocated');
  mkdirSync(relocated);
  for (const name of ['external.json', 'node.json', 'external-sdk.json'])
    writeFileSync(join(relocated, name), readFileSync(join(dir, name)));
  const copy = loadContract(join(relocated, 'external.json'), join(relocated, 'external-sdk.json'));
  assert.deepEqual(copy.sources, c.sources);
  assert.deepEqual(copy.definitions, c.definitions);
  const path = join(dir, 'external-output');
  generate(c, path);
  const { Client } = await import(pathToFileURL(join(path, 'node/index.js')).href);
  const client = new Client({
    baseUrl: 'https://example.invalid',
    transport: async () => new Response(JSON.stringify(data)),
  });
  assert.equal(
    (await client.api.saveTree({ body: data })).data.children[0].children[0].amount,
    '10',
  );
});

test('cyclic caller values fail before dispatch through the generated clients', async () => {
  const { Client } = await import(pathToFileURL(join(output, 'node/index.js')).href);
  let calls = 0;
  const client = new Client({
    baseUrl: 'https://example.invalid',
    transport: async () => {
      calls++;
      throw new Error('unexpected request');
    },
  });
  const body = { id: 'cycle', amount: '1' };
  body.children = [body];
  await assert.rejects(
    client.api.saveTree({ body }),
    (e) => e.kind === 'validation' && e.message.includes('nesting'),
  );
  assert.equal(calls, 0);
  const php = `require $argv[1].'/src/Runtime.php';require $argv[1].'/src/Client.php';$body=(object)['id'=>'cycle','amount'=>'1'];$body->children=[$body];try{new Example\\Trees\\ApiSaveTreeInput(['body'=>$body]);exit(1);}catch(Example\\Trees\\SdkError $e){echo $e->kind;}`;
  const result = spawnSync('php', ['-r', php, join(output, 'php')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'validation');
});
