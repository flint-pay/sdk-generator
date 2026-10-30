import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadContract, generate, render } from '../dist/index.js';
import { localExampleSource } from './local-example.mjs';
const exec = promisify(execFile);
const root = mkdtempSync(join(tmpdir(), 'sdk-readme-regressions-'));
after(() => rmSync(root, { recursive: true, force: true }));
function fixture(name, paths, operations, apiExtra = {}, configExtra = {}) {
  const dir = join(root, name);
  mkdirSync(dir);
  const api = join(dir, 'api.json'),
    config = join(dir, 'sdk.json');
  writeFileSync(
    api,
    JSON.stringify({
      openapi: '3.1.0',
      info: { title: 'Examples', version: '1' },
      paths,
      ...apiExtra,
    }),
  );
  writeFileSync(
    config,
    JSON.stringify({
      responses: { return: 'result' },
      version: '1.0.0',
      requests: { style: 'object' },
      npm: { name: '@example/readme' },
      composer: { name: 'example/readme', namespace: 'Example\\Readme' },
      operations,
      ...configExtra,
      documentation: { examples: Object.keys(operations) },
    }),
  );
  const output = join(dir, 'out');
  generate(loadContract(api, config), output);
  mkdirSync(join(output, 'php/vendor'));
  writeFileSync(
    join(output, 'php/vendor/autoload.php'),
    "<?php require_once __DIR__ . '/../src/Runtime.php'; require_once __DIR__ . '/../src/Client.php';",
  );
  return output;
}
async function runReadme(output, target, env) {
  const readme = readFileSync(join(output, target, 'README.md'), 'utf8');
  const source = [...readme.matchAll(/```(?:typescript|php)\n([\s\S]*?)```/g)]
    .map((m) => m[1])
    .join('\n');
  if (target === 'node') {
    const ts = join(output, target, 'readme.ts');
    writeFileSync(ts, source);
    await exec(process.execPath, [
      resolve('node_modules/typescript/bin/tsc'),
      '--noEmit',
      '--strict',
      '--target',
      'es2022',
      '--module',
      'nodenext',
      '--typeRoots',
      resolve('node_modules/@types'),
      ts,
    ]);
  }
  const file = join(output, target, target === 'node' ? 'readme.mjs' : 'readme.php');
  writeFileSync(file, localExampleSource(source, target));
  return await exec(target === 'node' ? process.execPath : 'php', [file], {
    env: { ...process.env, ...env },
    timeout: 15000,
  });
}
async function withServer(
  work,
  reply = (_req, res) => {
    res.writeHead(204);
    res.end();
  },
) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ path: req.url, headers: req.headers, body });
    reply(req, res);
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  try {
    await work(`http://127.0.0.1:${server.address().port}`, requests);
  } finally {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
}
const responses = { 204: { description: 'OK' } };
test('README quickstarts and recipes preserve source-looking literals, including control characters', async () => {
  const text =
    'new ExactNumber( instanceof EventStream of result.data) new Client({ new ClientOptions( { maxAttempts: 1 }\n$input = "literal";\r\nawait client.close();\n';
  const expected = { text, nested: { 'line\nkey': text } };
  const schema = {
    type: 'object',
    additionalProperties: true,
    required: ['text', 'nested'],
    properties: {
      text: { type: 'string' },
      nested: { type: 'object', additionalProperties: { type: 'string' } },
    },
  };
  const paths = Object.fromEntries(
    ['start', 'next', 'last'].map((id) => [
      '/' + id,
      {
        post: {
          operationId: id,
          requestBody: { required: true, content: { 'application/json': { schema } } },
          responses,
        },
      },
    ]),
  );
  const operations = Object.fromEntries(
    ['start', 'next', 'last'].map((id) => [id, { example: { body: expected } }]),
  );
  const output = fixture('literal-data', paths, operations);
  await withServer(async (baseUrl, requests) => {
    for (const target of ['node', 'php']) {
      const before = requests.length;
      await runReadme(output, target, { FLINT_BASE_URL: baseUrl });
      assert.deepEqual(
        requests.slice(before).map((r) => r.path),
        ['/start', '/next', '/last'],
      );
      for (const request of requests.slice(before))
        assert.deepEqual(JSON.parse(request.body), expected);
    }
  });
});
test('README generated keys replace required and optional header samples without conflicting options', async () => {
  const scenarios = [
    ['required', 'Idempotency-Key', true, true],
    ['optional', 'x-action-key', false, true],
    ['headerOnly', 'Idempotency-Key', true, false],
  ];
  const paths = Object.fromEntries(
    scenarios.map(([id, name, required]) => [
      '/' + id,
      {
        post: {
          operationId: id,
          parameters: [{ name, in: 'header', required, schema: { type: 'string' } }],
          responses,
        },
      },
    ]),
  );
  const operations = Object.fromEntries(
    scenarios.map(([id, header, , policy]) => [
      id,
      {
        resource: 'actions',
        method: id,
        example: { [header]: 'sample-key' },
        ...(policy ? { idempotency: { header, retention: '24 hours', scope: 'per action' } } : {}),
      },
    ]),
  );
  const output = fixture('saved-keys', paths, operations);
  await withServer(async (baseUrl, requests) => {
    for (const target of ['node', 'php']) {
      const before = requests.length;
      await runReadme(output, target, { FLINT_BASE_URL: baseUrl });
      const calls = requests.slice(before);
      assert.deepEqual(
        calls.map((r) => r.path),
        ['/required', '/optional', '/headerOnly'],
      );
      const keys = calls.map((r, index) => r.headers[scenarios[index][1].toLowerCase()]);
      for (const key of keys) assert.match(key, /^[a-f0-9-]{32,36}$/);
      assert.equal(new Set(keys).size, 3);
    }
  });
});

for (const target of ['node', 'php']) {
  test(`${target} positional examples retain generated optional headers without an input sample`, async () => {
    const output = fixture(
      'optional-header-' + target,
      {
        '/actions': {
          post: {
            operationId: 'createAction',
            parameters: [{ name: 'Idempotency-Key', in: 'header', schema: { type: 'string' } }],
            responses,
          },
        },
      },
      { createAction: { resource: 'actions', method: 'create', example: {} } },
      {},
      { requests: { style: 'positional' } },
    );
    await withServer(async (baseUrl, requests) => {
      await runReadme(output, target, { FLINT_BASE_URL: baseUrl });
      assert.equal(requests.length, 1);
      assert.equal(requests[0].path, '/actions');
      assert.equal(requests[0].body, '');
      assert.match(requests[0].headers['idempotency-key'], /^[a-f0-9-]{32,36}$/);
    });
  });
}

test('later README recipes retain exact-number and streaming symbols across authentication setups', async () => {
  const paths = {
    '/read': { get: { operationId: 'read', security: [], responses } },
    '/exact': {
      post: {
        operationId: 'exact',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                anyOf: [{ type: 'number', format: 'decimal', minimum: 0.25 }, { type: 'string' }],
              },
            },
          },
        },
        responses,
      },
    },
    '/events': {
      get: {
        operationId: 'events',
        security: [{ Bearer: [] }],
        responses: {
          200: {
            description: 'Events',
            content: { 'text/event-stream': { schema: { type: 'string' } } },
          },
        },
      },
    },
  };
  const output = fixture(
    'recipe-symbols',
    paths,
    { read: {}, exact: {}, events: {} },
    { components: { securitySchemes: { Bearer: { type: 'http', scheme: 'bearer' } } } },
    { auth: { scheme: 'Bearer' }, numericUnions: 'explicit' },
  );
  await withServer(
    async (baseUrl, requests) => {
      for (const target of ['node', 'php']) {
        const before = requests.length;
        const execution = await runReadme(output, target, {
          FLINT_BASE_URL: baseUrl,
          API_TOKEN: 'recipe-token',
        });
        assert.match(execution.stdout, /message/);
        const calls = requests.slice(before);
        assert.deepEqual(
          calls.map((r) => r.path),
          ['/read', '/exact', '/events'],
        );
        assert.equal(calls[1].body, '0.25');
        assert.equal(calls[1].headers.authorization, undefined);
        assert.equal(calls[2].headers.authorization, 'Bearer recipe-token');
      }
    },
    (req, res) => {
      if (req.url === '/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('data: ready\n\n');
      } else {
        res.writeHead(204);
        res.end();
      }
    },
  );
});

test('README client reuse follows the selected shortcut rather than the first permitted mode', async () => {
  const output = fixture(
    'shortcut-selection',
    {
      '/merchant': {
        get: {
          operationId: 'merchant',
          security: [{ CommonID: [], CommonSecret: [] }, { Merchant: [] }],
          responses,
        },
      },
      '/customer': {
        get: {
          operationId: 'customer',
          security: [{ CommonID: [], CommonSecret: [] }, { Customer: [] }],
          responses,
        },
      },
    },
    { merchant: {}, customer: {} },
    {
      components: {
        securitySchemes: {
          CommonID: { type: 'apiKey', in: 'header', name: 'X-Common-ID' },
          CommonSecret: { type: 'apiKey', in: 'header', name: 'X-Common-Secret' },
          Merchant: { type: 'http', scheme: 'bearer' },
          Customer: { type: 'http', scheme: 'bearer' },
        },
      },
    },
    {
      auth: {
        modes: {
          common: { schemes: ['CommonID', 'CommonSecret'] },
          merchant: { schemes: ['Merchant'] },
          customer: { schemes: ['Customer'] },
        },
        shortcuts: {
          token: { mode: 'merchant', scheme: 'Merchant' },
          customerToken: { mode: 'customer', scheme: 'Customer' },
        },
      },
    },
  );
  await withServer(async (baseUrl, requests) => {
    for (const target of ['node', 'php']) {
      const before = requests.length;
      await runReadme(output, target, {
        FLINT_BASE_URL: baseUrl,
        API_TOKEN: 'merchant-value',
        CUSTOMER_TOKEN: 'customer-value',
      });
      assert.deepEqual(
        requests
          .slice(before)
          .map((r) => [
            r.path,
            r.headers.authorization,
            r.headers['x-common-id'],
            r.headers['x-common-secret'],
          ]),
        [
          ['/merchant', 'Bearer merchant-value', undefined, undefined],
          ['/customer', 'Bearer customer-value', undefined, undefined],
        ],
      );
    }
  });
});

test('package READMEs lead with install and print capability notes only when declared', () => {
  const sections = (readme) => [...readme.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  const library = render(
    loadContract('examples/library.openapi.json', 'examples/library.sdk.json'),
  );
  const paymentContract = loadContract(
    'tests/fixtures/payment-api.json',
    'tests/fixtures/payment-sdk.json',
  );
  const payments = render(paymentContract);
  const retried = structuredClone(paymentContract);
  const policy = retried.operations.find((op) => op.retry).retry;
  for (const op of retried.operations) op.retry ??= policy;
  const allRetried = render(retried);
  for (const target of ['node', 'php']) {
    const readme = library.get(`${target}/README.md`);
    assert.ok(readme.startsWith('# Library SDK\n\n'), readme.slice(0, 80));
    assert.deepEqual(sections(readme), [
      'Install',
      'Quickstart',
      'Errors and retries',
      'Documentation',
    ]);
    assert.match(readme, /## Install\n\n```sh\n(?:npm install|composer require) /);
    // Every operation uses the default payload mode and none declares idempotency.
    assert.doesNotMatch(readme, /idempotency key|result-mode|Calls return a Result/);
    assert.doesNotMatch(readme, /\n\n\n/);
    assert.equal(readme.includes('close()'), target === 'php');
    assert.match(readme, /Package 1\.0\.0, generated for API 1\./);
    const paymentReadme = payments.get(`${target}/README.md`);
    assert.deepEqual(sections(paymentReadme), [
      'Install',
      'Quickstart',
      'More examples',
      'Errors and retries',
      'Pagination',
      'Webhooks',
      'Documentation',
    ]);
    assert.match(paymentReadme, /Calls return a Result/);
    assert.ok(
      paymentReadme.includes(
        target === 'node'
          ? '`client.verifyWebhook(rawBody, headers, secrets)`'
          : '`$client->verifyWebhook($rawBody, $headers, $secrets)`',
      ),
    );
    assert.match(paymentReadme, /Set `API_TOKEN`, then replace/);
    assert.match(readme, /Without a declared retry policy, GET, HEAD and OPTIONS/);
    assert.match(paymentReadme, /Operations with a declared retry policy follow it.*otherwise GET/);
    assert.match(
      allRetried.get(`${target}/README.md`),
      /Each operation retries according to its declared policy/,
    );
    assert.doesNotMatch(allRetried.get(`${target}/README.md`), /three attempts/);
    assert.doesNotMatch(paymentReadme, /\n\n\n/);
    assert.equal(paymentReadme.includes('close()'), target === 'php');
    const runtime = payments.get(`${target}/RUNTIME.md`);
    assert.ok(runtime.startsWith('# Example Payments (not a Flint contract) runtime guide\n'));
    assert.match(
      runtime,
      target === 'node'
        ? /## Pagination and polling\n\n```typescript\nfor await \(const item of client\.payments\.linksItems\(/
        : /## Pagination and polling\n\n```php\nforeach \(\$client->payments->linksItems\(/,
    );
    assert.ok(
      runtime.indexOf('## Retries and idempotency') <
        runtime.indexOf('## Input and response values'),
    );
  }
});
