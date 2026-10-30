import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { loadContract, generate } from '../dist/index.js';
import { diagnoseContract } from '../dist/generate.js';
import { replacePhpExampleAutoload } from './local-example.mjs';

const id = 'cus_01ARZ3NDEKTSV4RRFFQ69G5FAV';
function fixture(t, { empty = false, named = false, profile = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'sdk-runnable-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const body = { type: 'object', properties: { name: { type: 'string' } } };
  const example = named
    ? { examples: { first: { value: { name: 'Ada' } }, second: { value: { name: 'Grace' } } } }
    : { example: { name: 'Ada' } };
  const api = {
    openapi: '3.1.0',
    info: { title: 'Synthetic examples', version: '1' },
    servers: [{ url: 'https://example.invalid' }],
    paths: {
      '/customers/{customer_id}': {
        patch: {
          operationId: 'updateCustomer',
          parameters: [
            { in: 'path', name: 'customer_id', required: true, schema: { type: 'string' } },
          ],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: body, ...(empty ? {} : example) } },
          },
          responses: {
            200: {
              description: 'Updated',
              content: {
                'application/json': { schema: { type: 'object' }, example: { customer_id: id } },
              },
            },
          },
        },
      },
      '/customer-sessions/refresh': {
        post: {
          operationId: 'refreshCustomerSession',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { refresh_token: { type: 'string' } },
                  required: ['refresh_token'],
                },
                example: { refresh_token: 'synthetic-refresh' },
              },
            },
          },
          responses: { 204: { description: 'Refreshed' } },
        },
      },
    },
  };
  const config = {
    version: '1.0.0',
    npm: { name: '@example/runnable' },
    composer: { name: 'example/runnable', namespace: 'RunnableExample' },
    requests: { style: 'positional' },
    documentation: { exampleValues: { unused_id: 'other_01ARZ3NDEKTSV4RRFFQ69G5FAV' } },
    operations: {
      updateCustomer: {
        resource: 'customers',
        method: 'update',
        ...(profile ? { example: { customer_id: id, body: { name: 'Profile' } } } : {}),
      },
      refreshCustomerSession: {
        resource: 'customerSessions',
        method: 'refresh',
        response: { return: 'result' },
        idempotency: { header: 'Idempotency-Key', retention: '24h', scope: 'session' },
        exampleIdempotencyKey: {
          prefix: 'refresh-',
          variable: 'customerSessionId',
          example: 'cses_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        },
      },
    },
  };
  const paths = [join(directory, 'api.json'), join(directory, 'sdk.json')];
  writeFileSync(paths[0], JSON.stringify(api));
  writeFileSync(paths[1], JSON.stringify(config));
  const contract = loadContract(...paths);
  return { directory, paths, contract, output: join(directory, 'output') };
}

test('examples use media values, inferred ID prefixes, optional base URLs and stable refresh keys in both targets', async (t) => {
  const f = fixture(t);
  generate(f.contract, f.output);
  const read = (target, name, ext) =>
    readFileSync(join(f.output, target, 'examples', name + '.' + ext), 'utf8');
  const node = read('node', 'customers-update', 'mjs');
  const php = read('php', 'customers-update', 'php');
  assert.match(node, /process.env.FLINT_BASE_URL \|\| undefined/);
  assert.match(php, /getenv\('FLINT_BASE_URL'\) \?: null/);
  for (const text of [node, php]) {
    assert.ok(text.includes(id));
    assert.ok(text.includes('Ada'));
    assert.doesNotMatch(text, /Set FLINT_BASE_URL|API_BASE_URL|staging/);
  }
  const refresh = read('node', 'customerSessions-refresh', 'mjs');
  assert.match(refresh, /const customerSessionId = "cses_[0-9A-Z]{26}"/);
  assert.ok(refresh.includes('const idempotencyKey = `refresh-${customerSessionId}`;'));
  assert.match(
    read('php', 'customerSessions-refresh', 'php'),
    /\$idempotencyKey = 'refresh-' \. \$customerSessionId/,
  );
  const declarations = readFileSync(join(f.output, 'node/resources/customers.d.ts'), 'utf8');
  assert.ok(declarations.includes(id));
  for (const target of ['node', 'php'])
    for (const name of ['README.md', 'RUNTIME.md'])
      assert.doesNotMatch(
        readFileSync(join(f.output, target, name), 'utf8'),
        /API_BASE_URL|api\.staging\./,
      );

  const { Client } = await import(pathToFileURL(join(f.output, 'node/index.js')));
  const seen = [];
  class MockClient extends Client {
    constructor(options) {
      super({
        ...options,
        transport: async (url, request) => {
          seen.push({ url: url.href, body: JSON.parse(request.body) });
          return new Response('{}');
        },
      });
    }
  }
  const execute = new Function(
    'Client',
    'process',
    'console',
    `return (async () => {${node.replace(/^import .*;\n/, '')}})()`,
  );
  await execute(MockClient, { env: {} }, { log() {} });
  assert.deepEqual(seen, [
    { url: 'https://example.invalid/customers/' + id, body: { name: 'Ada' } },
  ]);
  // FLINT_BASE_URL belongs to examples; direct runtime clients retain the spec default.
  const script = join(f.directory, 'example.php');
  const capture = join(f.directory, 'request.json');
  const source = replacePhpExampleAutoload(
    php,
    `require ${JSON.stringify(join(f.output, 'php/src/Runtime.php'))}; require ${JSON.stringify(join(f.output, 'php/src/Client.php'))};`,
  ).replace(
    '  baseUrl: $baseUrl,',
    `  baseUrl: $baseUrl,\n  transport: function($request) { file_put_contents(${JSON.stringify(capture)}, json_encode($request)); return ['status'=>200,'headers'=>['content-type'=>'application/json'],'body'=>'{}']; },`,
  );
  writeFileSync(script, source);
  const result = spawnSync('php', [script], {
    encoding: 'utf8',
    env: { ...process.env, FLINT_BASE_URL: '' },
  });
  assert.equal(result.status, 0, result.stderr);
  const request = JSON.parse(readFileSync(capture));
  assert.equal(request.url, 'https://example.invalid/customers/' + id);
  assert.deepEqual(JSON.parse(request.body), { name: 'Ada' });
});

test('first named media example is used and a profile example wins', (t) => {
  for (const profile of [false, true]) {
    const f = fixture(t, { named: true, profile });
    generate(f.contract, f.output);
    const source = readFileSync(join(f.output, 'node/examples/customers-update.mjs'), 'utf8');
    assert.ok(source.includes(profile ? 'Profile' : 'Ada'));
    assert.doesNotMatch(source, /Grace/);
  }
});

test('empty PATCH examples fail diagnose as an error', (t) => {
  const f = fixture(t, { empty: true });
  assert.throws(() => diagnoseContract(f.contract), /PATCH examples must include/);
  const result = spawnSync(
    process.execPath,
    [resolve('dist/cli.js'), 'diagnose', ...f.paths, '--json'],
    { encoding: 'utf8' },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /PATCH examples must include/);
});

test('profile exampleValues resolves ambiguous prefixes', (t) => {
  const f = fixture(t);
  const api = JSON.parse(readFileSync(f.paths[0]));
  api.paths['/customers/{customer_id}'].patch.responses[200].content['application/json'].examples =
    {
      other: { value: { customer_id: 'alternate_01ARZ3NDEKTSV4RRFFQ69G5FAV' } },
    };
  const config = JSON.parse(readFileSync(f.paths[1]));
  config.documentation.exampleValues.customer_id = id;
  writeFileSync(f.paths[0], JSON.stringify(api));
  writeFileSync(f.paths[1], JSON.stringify(config));
  generate(loadContract(...f.paths), f.output);
  assert.ok(
    readFileSync(join(f.output, 'node/examples/customers-update.mjs'), 'utf8').includes(id),
  );
});

test('media JSON numbers are projected to exact SDK inputs without rounding', (t) => {
  const f = fixture(t);
  const api = JSON.parse(readFileSync(f.paths[0]));
  const media = api.paths['/customers/{customer_id}'].patch.requestBody.content['application/json'];
  media.schema.properties.amount_money = {
    type: 'object',
    properties: { amount: { type: 'integer', format: 'int64' }, currency: { type: 'string' } },
    required: ['amount', 'currency'],
  };
  media.example.amount_money = { amount: 2500, currency: 'USD' };
  writeFileSync(f.paths[0], JSON.stringify(api));
  generate(loadContract(...f.paths), f.output);
  assert.match(
    readFileSync(join(f.output, 'node/examples/customers-update.mjs'), 'utf8'),
    /amount: "2500"/,
  );
  assert.match(
    readFileSync(join(f.output, 'php/examples/customers-update.php'), 'utf8'),
    /'amount' => '2500'/,
  );
});

test('example annotations preserve named request and path component exports', (t) => {
  const f = fixture(t);
  const api = JSON.parse(readFileSync(f.paths[0]));
  const op = api.paths['/customers/{customer_id}'].patch;
  const media = op.requestBody.content['application/json'];
  api.components = {
    schemas: { UpdateCustomerRequest: media.schema, CustomerId: { type: 'string' } },
  };
  media.schema = { $ref: '#/components/schemas/UpdateCustomerRequest' };
  op.parameters[0].schema = { $ref: '#/components/schemas/CustomerId' };
  writeFileSync(f.paths[0], JSON.stringify(api));
  generate(loadContract(...f.paths), f.output);
  const root = readFileSync(join(f.output, 'node/index.d.ts'), 'utf8');
  assert.match(root, /UpdateCustomerRequestInput/);
  assert.match(root, /CustomerIdInput/);
});
