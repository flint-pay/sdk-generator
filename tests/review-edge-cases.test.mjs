import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadContract, generate } from '../dist/index.js';

const root = mkdtempSync(join(tmpdir(), 'sdk-review-edge-cases-'));
after(() => rmSync(root, { recursive: true, force: true }));
const cases = JSON.parse(
  readFileSync(new URL('./fixtures/review-edge-cases.json', import.meta.url)),
);
function fixture(name, paths, config = {}) {
  const dir = join(root, name);
  mkdirSync(dir);
  const api = join(dir, 'api.json'),
    profile = join(dir, 'sdk.json');
  writeFileSync(
    api,
    JSON.stringify({ openapi: '3.1.0', info: { title: 'Edge cases', version: '1' }, paths }),
  );
  writeFileSync(
    profile,
    JSON.stringify({
      version: '1.0.0',
      npm: { name: 'edge-sdk' },
      composer: { name: 'edge/sdk', namespace: 'EdgeSdk' },
      ...config,
    }),
  );
  return { dir, api, profile, output: join(dir, 'sdk') };
}
function build(f) {
  generate(loadContract(f.api, f.profile), f.output);
}
const sdk = (f) => import(pathToFileURL(join(f.output, 'node/index.js')).href);
function php(f, program, input) {
  const p = spawnSync(
    'php',
    [
      '-r',
      String.raw`require $argv[1].'/php/src/Runtime.php';require $argv[1].'/php/src/Client.php';` +
        program,
      f.output,
    ],
    { input: JSON.stringify(input), encoding: 'utf8' },
  );
  assert.equal(p.status, 0, p.stderr + p.stdout);
  return JSON.parse(p.stdout);
}
function paginated(name, kind, query, continuation, config = {}) {
  const schema = {
    type: 'object',
    required: ['items', 'next'],
    properties: { items: { type: 'array', items: { type: 'string' } }, next: continuation },
  };
  const operation = {
    operationId: 'fetchValues',
    parameters: [{ name: 'cursor', in: 'query', schema: query }],
    responses: { 200: { description: 'Page', content: { 'application/json': { schema } } } },
  };
  return fixture(
    name,
    { '/values': { get: operation } },
    {
      ...config,
      operations: {
        fetchValues: { pagination: { kind, parameter: 'cursor', items: 'items', next: 'next' } },
      },
    },
  );
}

test('pagination diagnoses incompatible continuation representations and query types before generation', () => {
  for (const targets of [['node'], ['php'], ['node', 'php']]) {
    for (const format of ['int64', 'uint64']) {
      const f = paginated(
        `reject-${targets.join('-')}-${format}`,
        'offset',
        { type: 'integer' },
        { type: ['integer', 'null'], format },
        { targets },
      );
      assert.throws(
        () => loadContract(f.api, f.profile),
        /\/paths\/\/values\/get: offset pagination returns exact integer strings/,
      );
    }
  }
  for (const [kind, query, continuation] of [
    ['cursor', { type: 'integer' }, { type: 'string' }],
    ['cursor', { type: 'array', items: { type: 'string' } }, { type: 'string' }],
    ['offset', { type: 'string' }, { type: 'integer' }],
    ['offset', { type: 'array', items: { type: 'integer' } }, { type: 'integer' }],
  ]) {
    const f = paginated(`reject-${kind}-${query.type}`, kind, query, continuation);
    assert.throws(
      () => loadContract(f.api, f.profile),
      /pagination requires a scalar .* query parameter/,
    );
  }
});

test('compatible cursor and integer formats retrieve both pages through both generated clients', async () => {
  for (const [label, kind, query, next, token] of [
    ['cursor', 'cursor', { type: 'string' }, { type: ['string', 'null'] }, 'page/2'],
    ['native', 'offset', { type: 'integer' }, { type: ['integer', 'null'] }, 2],
    [
      'exact',
      'offset',
      { type: 'integer', format: 'int64' },
      { type: ['integer', 'null'], format: 'int64' },
      2,
    ],
    [
      'native-to-exact',
      'offset',
      { type: 'integer', format: 'int64' },
      { type: ['integer', 'null'] },
      2,
    ],
    [
      'unsigned',
      'offset',
      { type: 'integer', format: 'uint64' },
      { type: ['integer', 'null'], format: 'uint64' },
      2,
    ],
  ]) {
    const f = paginated(label, kind, query, next);
    build(f);
    const { Client } = await sdk(f);
    const urls = [],
      items = [];
    const client = new Client({
      baseUrl: 'https://example.invalid',
      transport: async (url) => {
        urls.push(String(url));
        return new Response(
          JSON.stringify({
            items: [urls.length === 1 ? 'first' : 'second'],
            next: urls.length === 1 ? token : null,
          }),
        );
      },
    });
    for await (const item of client.api.fetchValuesItems()) items.push(item);
    const expected = {
      items: ['first', 'second'],
      urls: [
        'https://example.invalid/values',
        'https://example.invalid/values?cursor=' + (kind === 'cursor' ? 'page%2F2' : '2'),
      ],
    };
    assert.deepEqual({ items, urls }, expected);
    const result = php(
      f,
      String.raw`$token=json_decode(stream_get_contents(STDIN));$urls=[];$c=new EdgeSdk\Client(new EdgeSdk\ClientOptions('https://example.invalid',transport:function($r)use(&$urls,$token){$urls[]=$r['url'];return ['status'=>200,'headers'=>[],'body'=>json_encode(['items'=>[count($urls)===1?'first':'second'],'next'=>count($urls)===1?$token:null])];}));$items=iterator_to_array($c->api->fetchValuesItems(new EdgeSdk\ApiFetchValuesInput()),false);echo json_encode(['items'=>$items,'urls'=>$urls]);`,
      token,
    );
    assert.deepEqual(result, expected);
  }
});

test('singleton numeric enum types accept exact strings and generate type-correct examples', async () => {
  const paths = {},
    operations = [];
  for (const entry of cases.numericEnums)
    for (const singleton of [false, true]) {
      const id = 'send' + entry.name + (singleton ? 'Array' : 'Scalar');
      operations.push({ ...entry, id });
      paths['/' + id] = {
        post: {
          operationId: id,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  ...entry.schema,
                  type: singleton ? [entry.schema.type] : entry.schema.type,
                },
              },
            },
          },
          responses: { 204: { description: 'Empty' } },
        },
      };
    }
  const f = fixture('enums', paths);
  build(f);
  const { Client } = await sdk(f);
  const bodies = [];
  const c = new Client({
    baseUrl: 'https://example.invalid',
    transport: async (url, request) => {
      bodies.push(request.body);
      return new Response(null, { status: 204 });
    },
  });
  for (const entry of operations) {
    for (const body of entry.valid) await c.api[entry.id]({ body });
    for (const body of entry.invalid)
      await assert.rejects(c.api[entry.id]({ body }), (e) => e.kind === 'validation');
  }
  const expected = operations.flatMap((entry) => entry.valid);
  assert.deepEqual(bodies, expected);
  assert.deepEqual(
    php(
      f,
      String.raw`$cases=json_decode(stream_get_contents(STDIN),true);$bodies=[];$errors=[];$c=new EdgeSdk\Client(new EdgeSdk\ClientOptions('https://example.invalid',transport:function($r)use(&$bodies){$bodies[]=$r['body'];return ['status'=>204,'headers'=>[],'body'=>''];}));foreach($cases as $case){$id=$case['id'];$class='EdgeSdk\\Api'.ucfirst($id).'Input';foreach($case['valid']as $body)$c->api->{$id}(new $class(['body'=>$body]));foreach($case['invalid']as $body){try{$c->api->{$id}(new $class(['body'=>$body]));$errors[]='sent';}catch(EdgeSdk\SdkError $e){$errors[]=$e->kind;}}}echo json_encode(['bodies'=>$bodies,'errors'=>$errors]);`,
      operations,
    ),
    {
      bodies: expected,
      errors: operations.flatMap((entry) => entry.invalid.map(() => 'validation')),
    },
  );
  const consumer = join(f.dir, 'consumer.mts');
  writeFileSync(
    consumer,
    "import {Client} from './sdk/node/index.js';const c=new Client({baseUrl:'https://example.invalid'});\n" +
      operations
        .flatMap((entry) =>
          entry.valid.map((body) => `c.api.${entry.id}({body:${JSON.stringify(body)}});`),
        )
        .join('\n'),
  );
  const compiled = spawnSync(
    process.execPath,
    [
      resolve('node_modules/typescript/bin/tsc'),
      '--strict',
      '--noEmit',
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--typeRoots',
      resolve('node_modules/@types'),
      consumer,
      ...operations.map((entry) => join(f.output, 'node/examples', `api-${entry.id}.ts`)),
    ],
    { encoding: 'utf8', timeout: 120000 },
  );
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
});

test('money conversion rejects trailing newlines and retains exact amounts in both clients', async () => {
  const f = fixture(
    'money',
    {
      '/value': { get: { operationId: 'readValue', responses: { 204: { description: 'Empty' } } } },
    },
    { money: { currencies: { USD: 2 } } },
  );
  build(f);
  const { Client } = await sdk(f);
  const c = new Client({ baseUrl: 'https://example.invalid' });
  for (const { input, amount } of cases.money.valid)
    assert.deepEqual(c.money('USD', input), { currency: 'USD', amount });
  for (const input of cases.money.invalid)
    assert.throws(
      () => c.money('USD', input),
      (e) => e.kind === 'validation',
    );
  const p = php(
    f,
    String.raw`$cases=json_decode(stream_get_contents(STDIN),true);$c=new EdgeSdk\Client(new EdgeSdk\ClientOptions('https://example.invalid'));$valid=[];$invalid=[];foreach($cases['valid']as $case)$valid[]=$c->money('USD',$case['input']);foreach($cases['invalid']as $value){try{$c->money('USD',$value);$invalid[]='accepted';}catch(EdgeSdk\SdkError $e){$invalid[]=$e->kind;}}echo json_encode(['valid'=>$valid,'invalid'=>$invalid]);`,
    cases.money,
  );
  assert.deepEqual(p, {
    valid: cases.money.valid.map(({ amount }) => ({ currency: 'USD', amount })),
    invalid: cases.money.invalid.map(() => 'validation'),
  });
});
