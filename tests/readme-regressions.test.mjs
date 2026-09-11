import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadContract, generate } from '../dist/index.js';
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
      version: '1.0.0',
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
      await runReadme(output, target, { API_BASE_URL: baseUrl });
      assert.deepEqual(
        requests.slice(before).map((r) => r.path),
        ['/start', '/next', '/last'],
      );
      for (const request of requests.slice(before))
        assert.deepEqual(JSON.parse(request.body), expected);
    }
  });
});
test('README saved keys replace required and optional header samples without conflicting options', async () => {
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
      await runReadme(output, target, {
        API_BASE_URL: baseUrl,
        API_IDEMPOTENCY_KEY: 'saved-required-key',
        API_ACTIONS_OPTIONAL_IDEMPOTENCY_KEY: 'saved-optional-key',
        API_ACTIONS_HEADERONLY_IDEMPOTENCY_KEY: 'saved-header-only-key',
      });
      assert.deepEqual(
        requests
          .slice(before)
          .map((r, index) => [r.path, r.headers[scenarios[index][1].toLowerCase()]]),
        [
          ['/required', 'saved-required-key'],
          ['/optional', 'saved-optional-key'],
          ['/headerOnly', 'saved-header-only-key'],
        ],
      );
    }
  });
});

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
              schema: { anyOf: [{ type: 'number', minimum: 0.25 }, { type: 'string' }] },
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
          API_BASE_URL: baseUrl,
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
