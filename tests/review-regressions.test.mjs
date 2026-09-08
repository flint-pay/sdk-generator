import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { createHmac } from 'node:crypto';
import { loadContract, generate as generateSdk, validateFixtures } from '../dist/index.js';

const root = mkdtempSync(join(tmpdir(), 'sdk-review-regressions-'));
after(() => rmSync(root, { recursive: true, force: true }));
const cli = resolve('dist/cli.js');
const compiler = resolve('node_modules/typescript/bin/tsc');
const api = JSON.parse(readFileSync('examples/library.openapi.json'));
const config = JSON.parse(readFileSync('examples/library.sdk.json'));
const run = (command, args) => spawnSync(command, args, { encoding: 'utf8', timeout: 120000 });
const invoke = (...args) => run(process.execPath, [cli, ...args]);
const ok = (result) => {
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result;
};
const compile = (file) =>
  run(process.execPath, [
    compiler,
    '--noEmit',
    '--strict',
    '--target',
    'ES2022',
    '--module',
    'NodeNext',
    '--moduleResolution',
    'NodeNext',
    file,
  ]);
function inputs(label, doc, profile) {
  const dir = join(root, label);
  mkdirSync(dir);
  const definition = join(dir, 'api.json'),
    configuration = join(dir, 'sdk.json');
  writeFileSync(definition, JSON.stringify(doc));
  writeFileSync(configuration, JSON.stringify(profile));
  return { dir, definition, configuration, output: join(dir, 'sdk') };
}
function generate(i) {
  ok(invoke('generate', i.definition, i.configuration, i.output));
}

test('aliased renames report removed public types and prevent incompatible patch releases', () => {
  const profile = structuredClone(config);
  profile.release = { policy: 'semver' };
  const i = inputs('alias', api, profile);
  generate(i);
  const tsFile = join(i.dir, 'consumer.mts');
  writeFileSync(
    tsFile,
    "import { Client, type BooksRetrieveInput } from './sdk/node/index.js';\nconst input: BooksRetrieveInput = {id:'123'};\nnew Client({baseUrl:'https://example.invalid'}).books.retrieve(input);\n",
  );
  const phpFile = join(i.dir, 'consumer.php');
  writeFileSync(
    phpFile,
    `<?php
require $argv[1].'/php/src/Runtime.php'; require $argv[1].'/php/src/Client.php';
$client = new Example\\Library\\Client(new Example\\Library\\ClientOptions(baseUrl:'https://example.invalid', transport:fn($r)=>['status'=>200,'headers'=>[],'body'=>'{"title":"Book"}']));
echo $client->books->retrieve(new Example\\Library\\BooksRetrieveInput(['id'=>'123']))->data->getTitle();
`,
  );
  ok(compile(tsFile));
  assert.equal(ok(run('php', [phpFile, i.output])).stdout, 'Book');
  profile.version = '1.0.1';
  profile.operations.findBook = { resource: 'books', method: 'fetch', aliases: ['retrieve'] };
  writeFileSync(i.configuration, JSON.stringify(profile));
  generate(i);
  const ts = compile(tsFile),
    php = run('php', [phpFile, i.output]);
  assert.notEqual(ts.status, 0);
  assert.match(ts.stdout, /BooksRetrieveInput/);
  assert.notEqual(php.status, 0);
  assert.match(php.stderr, /BooksRetrieveInput.*not found/);
  const record = JSON.parse(readFileSync(join(i.output, '.sdk-generator.json')));
  assert.ok(
    record.compatibility.some(
      (c) => c.severity === 'breaking' && c.message.includes('input/response types'),
    ),
  );
  const release = invoke('release', i.output, join(i.dir, 'release'));
  assert.notEqual(release.status, 0);
  assert.match(release.stderr, /breaking changes require a new major/);
  // The old method itself remains callable with the new input class.
  writeFileSync(
    phpFile,
    readFileSync(phpFile, 'utf8').replaceAll('BooksRetrieveInput', 'BooksFetchInput'),
  );
  assert.equal(ok(run('php', [phpFile, i.output])).stdout, 'Book');
});

test('diagnosis rejects SDK export collisions and accepts configured model names', () => {
  const doc = structuredClone(api);
  const response = doc.paths['/books/{id}'].get.responses['200'].content['application/json'];
  doc.components = { schemas: { Metadata: response.schema } };
  response.schema = { $ref: '#/components/schemas/Metadata' };
  const i = inputs('metadata', doc, config);
  for (const name of [
    'Metadata',
    'ErrorKind',
    'DiagnosticEvent',
    'serialize',
    'parseExact',
    'redact',
  ]) {
    doc.components.schemas = {
      [name]: doc.components.schemas[Object.keys(doc.components.schemas)[0]],
    };
    response.schema = { $ref: '#/components/schemas/' + name };
    writeFileSync(i.definition, JSON.stringify(doc));
    const diagnosis = invoke('diagnose', i.definition, i.configuration);
    assert.notEqual(diagnosis.status, 0);
    assert.match(diagnosis.stderr, /generated type collision/);
  }
  doc.components.schemas = { Metadata: doc.components.schemas.redact };
  response.schema = { $ref: '#/components/schemas/Metadata' };
  writeFileSync(i.definition, JSON.stringify(doc));
  const profile = { ...config, models: { Metadata: 'BookMetadata' } };
  writeFileSync(i.configuration, JSON.stringify(profile));
  generate(i);
  ok(invoke('validate', i.output));
});

async function withServer(callback) {
  const received = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push({ method: req.method, path: req.url, body: Buffer.concat(chunks).toString() });
    if (req.method === 'POST') {
      res.writeHead(204);
      res.end();
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(decodeURIComponent(req.url.split('/').at(-1)));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await callback(`http://127.0.0.1:${server.address().port}`, received);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
function phpAsync(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn('php', [file, ...args]);
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (x) => (stdout += x));
    child.stderr.on('data', (x) => (stderr += x));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('native Node and PHP clients decode integral decimal/exponent responses without accepting strings or fractions', async () => {
  const doc = structuredClone(api);
  doc.paths['/books/{id}'].get.responses['200'].content['application/json'].schema = {
    type: 'integer',
  };
  const i = inputs('integer', doc, config);
  generate(i);
  const { Client } = await import(pathToFileURL(join(i.output, 'node/index.js')).href);
  const phpFile = join(i.dir, 'consumer.php');
  writeFileSync(
    phpFile,
    `<?php
require $argv[1].'/php/src/Runtime.php';require $argv[1].'/php/src/Client.php';
$client=new Example\\Library\\Client(new Example\\Library\\ClientOptions(baseUrl:$argv[2],allowInsecureHttp:true));
$out=[];foreach(json_decode(file_get_contents($argv[3]),true) as $token){try{$out[$token]=['data'=>$client->books->retrieve(new Example\\Library\\BooksRetrieveInput(['id'=>$token]))->data];}catch(Example\\Library\\SdkError $e){$out[$token]=['kind'=>$e->kind];}} echo json_encode($out);
`,
  );
  await withServer(async (baseUrl, received) => {
    const client = new Client({ baseUrl, allowInsecureHttp: true });
    const node = {};
    const expected = {
      1: { data: 1 },
      1000: { data: 1000 },
      '1.0': { data: 1 },
      '1e3': { data: 1000 },
      '1200e-2': { data: 12 },
      '-12.00': { data: -12 },
      '9007199254740991.0': { data: 9007199254740991 },
      1.5: { kind: 'protocol' },
      '1.0000000000000001': { kind: 'protocol' },
      '9007199254740992.0': { kind: 'protocol' },
      '1e9999999999': { kind: 'protocol' },
      '1e-9999999999': { kind: 'protocol' },
      '"1.0"': { kind: 'protocol' },
    };
    const tokens = Object.keys(expected),
      tokensFile = join(i.dir, 'tokens.json');
    writeFileSync(tokensFile, JSON.stringify(tokens));
    for (const id of tokens) {
      try {
        node[id] = { data: (await client.books.retrieve({ id })).data };
      } catch (e) {
        node[id] = { kind: e.kind };
      }
    }
    const php = JSON.parse(ok(await phpAsync(phpFile, [i.output, baseUrl, tokensFile])).stdout);
    assert.deepEqual(node, expected);
    assert.deepEqual(php, expected);
    assert.equal(received.length, tokens.length * 2);
  });
});

test('sparse arrays fail through the public Node client before HTTP dispatch', async () => {
  const doc = {
    openapi: '3.1.1',
    info: { title: 'Batch', version: '1' },
    paths: {
      '/batch': {
        post: {
          operationId: 'submitBatch',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { type: 'array', items: { type: 'string' }, minItems: 1 },
              },
            },
          },
          responses: { 204: { description: 'No content' } },
        },
      },
    },
  };
  const profile = {
    ...config,
    validation: 'schema',
    operations: {
      submitBatch: { resource: 'batches', method: 'submit', example: { body: ['item'] } },
    },
  };
  const i = inputs('sparse', doc, profile);
  generate(i);
  const { Client } = await import(pathToFileURL(join(i.output, 'node/index.js')).href);
  await withServer(async (baseUrl, received) => {
    const client = new Client({ baseUrl, allowInsecureHttp: true });
    await client.batches.submit({ body: ['item'] });
    await assert.rejects(client.batches.submit({ body: [] }), (e) => e.kind === 'validation');
    await assert.rejects(
      client.batches.submit({ body: [undefined] }),
      (e) => e.kind === 'validation',
    );
    assert.equal(received.length, 1);
    await assert.rejects(
      client.batches.submit({ body: new Array(1) }),
      (e) => e.kind === 'validation',
    );
    const sparse = new Array(2);
    sparse[1] = 'item';
    await assert.rejects(client.batches.submit({ body: sparse }), (e) => e.kind === 'validation');
    const inherited = Object.create(Array.prototype);
    inherited[0] = 'inherited';
    const hiddenHole = new Array(1);
    Object.setPrototypeOf(hiddenHole, inherited);
    await assert.rejects(
      client.batches.submit({ body: hiddenHole }),
      (e) => e.kind === 'validation',
    );
    assert.deepEqual(
      received.map((r) => r.body),
      ['["item"]'],
    );
    const { serialize } = await import(pathToFileURL(join(i.output, 'node/index.js')).href);
    assert.throws(
      () => serialize({ extra: sparse }, { type: 'object' }),
      (e) => e.kind === 'validation',
    );
  });
});

test('integer normalization preserves wide integers, decimals, alternatives and unknown numeric fields in both targets', async () => {
  const doc = structuredClone(api);
  const schema = {
    type: 'object',
    properties: {
      wide: { type: 'integer', format: 'int64' },
      unsigned: { type: 'integer', format: 'uint64' },
      decimal: { type: 'number' },
      choice: { oneOf: [{ type: 'integer' }, { type: 'string' }] },
      values: { type: 'array', items: { type: 'integer' } },
      nullable: { type: ['integer', 'null'] },
      all: { allOf: [{ type: 'integer' }, { minimum: 0 }] },
      enumChoice: { oneOf: [{ enum: [1] }, { enum: ['other'] }] },
    },
  };
  doc.paths['/books/{id}'].get.responses['200'].content['application/json'].schema = schema;
  const i = inputs('numeric-shapes', doc, config);
  generateSdk(loadContract(i.definition, i.configuration), i.output);
  const cases = [
    {
      raw: '{"wide":9.223372036854775807e18,"unsigned":18446744073709551615.0,"decimal":1.00,"choice":1.0,"values":[1.0,12e1],"nullable":null,"all":1e2,"enumChoice":1.0,"future":1.00,"nested":{"future":1e30}}',
      data: {
        wide: '9223372036854775807',
        unsigned: '18446744073709551615',
        decimal: '1.00',
        choice: 1,
        values: [1, 120],
        nullable: null,
        all: 100,
        enumChoice: '1.0',
        future: '1.00',
        nested: { future: '1e30' },
      },
    },
    {
      raw: '{"choice":"1.0","nullable":0.00,"decimal":1.0000000000000000001}',
      data: { choice: '1.0', nullable: 0, decimal: '1.0000000000000000001' },
    },
    { raw: '{"choice":1.5}', data: { choice: '1.5' } },
    { raw: '{"wide":12.5}', error: { kind: 'protocol' } },
  ].map((v, n) => ({
    name: 'numeric shape ' + n,
    operation: 'findBook',
    input: { id: '1' },
    expected: { method: 'GET', path: '/v1/books/1' },
    responses: [{ status: 200, body: v.raw }],
    ...(v.error ? { error: v.error } : { data: v.data }),
  }));
  const file = join(i.dir, 'cases.json');
  writeFileSync(file, JSON.stringify(cases));
  assert.deepEqual(
    (await validateFixtures(i.output, file)).map((r) => r.scenarios),
    [cases.length, cases.length],
  );
});

test('verified webhooks normalize declared integers and preserve unknown numeric tokens in both targets', async () => {
  const profile = structuredClone(config);
  profile.webhook = {
    algorithm: 'hmac-sha256',
    header: 'X-Signature',
    timestampHeader: 'X-Timestamp',
    separator: '.',
    toleranceSeconds: 300,
    typeField: 'type',
    events: {
      'count.updated': {
        type: 'object',
        properties: { type: { type: 'string' }, count: { type: 'integer' } },
      },
    },
  };
  const i = inputs('numeric-webhook', api, profile);
  generate(i);
  const { Client, parseExact } = await import(pathToFileURL(join(i.output, 'node/index.js')).href);
  const client = new Client({ baseUrl: 'https://example.invalid' });
  const timestamp = '1700000000',
    secret = 'test-signing-secret';
  const cases = [
    '{"type":"count.updated","count":1e3,"extra":1.00}',
    '{"type":"future","count":1e3,"extra":1.00}',
  ].map((raw) => ({
    raw,
    headers: {
      'X-Timestamp': timestamp,
      'X-Signature': createHmac('sha256', secret)
        .update(timestamp + '.' + raw)
        .digest('hex'),
    },
  }));
  const expected = [
    { known: true, event: { type: 'count.updated', count: 1000, extra: '1.00' } },
    { known: false, event: { type: 'future', count: '1e3', extra: '1.00' } },
  ];
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        cases.map((c) =>
          client.verifyWebhook(Buffer.from(c.raw), c.headers, [secret], Number(timestamp)),
        ),
      ),
    ),
    expected,
  );
  // The public exact parser retains its original representation independently of schemas.
  assert.deepEqual(parseExact('{"n":1.0,"s":"1.0"}'), { n: '1.0', s: '1.0' });
  const phpFile = join(i.dir, 'webhooks.php'),
    casesFile = join(i.dir, 'cases.json');
  writeFileSync(casesFile, JSON.stringify(cases));
  writeFileSync(
    phpFile,
    `<?php
require $argv[1].'/php/src/Runtime.php';require $argv[1].'/php/src/Client.php';
$client=new Example\\Library\\Client(new Example\\Library\\ClientOptions(baseUrl:'https://example.invalid'));
$out=[];foreach(json_decode(file_get_contents($argv[2]),true) as $c){$out[]=$client->verifyWebhook($c['raw'],$c['headers'],['test-signing-secret'],1700000000);}echo json_encode($out);
`,
  );
  assert.deepEqual(JSON.parse(ok(run('php', [phpFile, i.output, casesFile])).stdout), expected);
});
