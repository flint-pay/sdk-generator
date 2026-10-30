import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { inspect } from 'node:util';
import { loadContract, generate } from '../dist/index.js';

const root = mkdtempSync(join(tmpdir(), 'sdk-credential-providers-'));
after(() => rmSync(root, { recursive: true, force: true }));
const cases = JSON.parse(readFileSync('tests/fixtures/credential-providers.json', 'utf8'));
const retry = { maxAttempts: 3, statuses: [401, 503], transport: true, baseDelayMs: 0 };
const idempotency = {
  header: 'Idempotency-Key',
  retention: '24 hours (synthetic)',
  scope: 'operation',
};
const doc = {
  openapi: '3.1.0',
  info: { title: 'Credentials', version: '1' },
  components: { securitySchemes: { Bearer: { type: 'http', scheme: 'bearer' } } },
  paths: Object.fromEntries(
    ['read', 'keyed', 'auto', 'unsafe', 'anonymous'].map((id) => [
      '/' + id,
      {
        [id === 'read' || id === 'anonymous' ? 'get' : 'post']: {
          operationId: id,
          security: id === 'anonymous' ? [] : [{ Bearer: [] }],
          responses: { 204: { description: 'Done' } },
        },
      },
    ]),
  ),
};
const config = {
  version: '1.0.0',
  requests: { style: 'object' },
  responses: { return: 'result' },
  npm: { name: '@example/credentials' },
  composer: { name: 'example/credentials', namespace: 'Example\\Credentials' },
  operations: Object.fromEntries(
    ['read', 'keyed', 'auto', 'unsafe', 'anonymous'].map((id) => [
      id,
      {
        resource: 'api',
        method: id,
        ...(id === 'unsafe' ? {} : { retry }),
        ...(['keyed', 'auto'].includes(id)
          ? { idempotency: { ...idempotency, auto: id === 'auto' } }
          : {}),
      },
    ]),
  ),
};
const outputs = {};
before(() => {
  for (const mode of ['legacy', 'named']) {
    writeFileSync(join(root, 'api.json'), JSON.stringify(doc));
    writeFileSync(
      join(root, 'sdk.json'),
      JSON.stringify({
        ...config,
        auth:
          mode === 'legacy'
            ? { scheme: 'Bearer' }
            : {
                modes: { service: { schemes: ['Bearer'] } },
                shortcuts: { apiKey: { mode: 'service', scheme: 'Bearer' } },
              },
      }),
    );
    outputs[mode] = join(root, mode);
    generate(loadContract(join(root, 'api.json'), join(root, 'sdk.json')), outputs[mode]);
  }
});
const surfaces = ['token', 'clientShortcut', 'requestShortcut', 'clientMap', 'requestMap'];

for (const surface of surfaces)
  test('shared credential cases: ' + surface, async () => {
    const output = outputs[surface === 'token' ? 'legacy' : 'named'];
    const { Client } = await import(pathToFileURL(join(output, 'node/index.js')).href);
    for (const c of cases) {
      let calls = 0,
        invalidations = 0;
      const seen = [],
        events = [],
        keys = [];
      const provider = {
        async getCredential() {
          calls++;
          if (c.failure)
            throw new Error('test-token-private', { cause: new Error('test-token-private') });
          return {
            value: Object.hasOwn(c, 'value') ? c.value : 'test-token-' + calls,
            expiresAt: new Date('2100-01-01'),
          };
        },
        ...(c.invalidate === false
          ? {}
          : {
              invalidate() {
                invalidations++;
                if (c.invalidateFailure) throw new Error('test-token-private');
              },
            }),
      };
      const credential = c.kind === 'string' ? (c.value ?? 'test-token') : provider;
      const clientOptions = {
        baseUrl: 'https://example.invalid',
        diagnostics: (event) => events.push(event),
        transport: async (_url, init) => {
          seen.push(init.headers.authorization?.replace(/^Bearer /, '') ?? null);
          keys.push(init.headers['idempotency-key']);
          const status = c.statuses[seen.length - 1];
          assert.notEqual(status, undefined, c.name + ' unexpected attempt');
          if (status === 0) throw new Error('synthetic connection failure');
          const body = c.bodyFailures?.includes(seen.length - 1)
            ? new ReadableStream({
                start(controller) {
                  controller.error(new Error('synthetic body failure'));
                },
              })
            : null;
          return new Response(body, { status });
        },
      };
      const options = { ...(c.maxAttempts ? { maxAttempts: c.maxAttempts } : {}) };
      if (surface === 'token') clientOptions.token = credential;
      if (surface === 'clientShortcut') clientOptions.apiKey = credential;
      if (surface === 'requestShortcut') options.apiKey = credential;
      if (surface === 'clientMap')
        Object.assign(clientOptions, {
          authMode: 'service',
          credentials: { service: { Bearer: credential } },
        });
      if (surface === 'requestMap')
        Object.assign(options, { authMode: 'service', credentials: { Bearer: credential } });
      // Anonymous calls omit an explicit per-request selection.
      if (c.operation === 'anonymous') {
        delete options.apiKey;
        delete options.authMode;
        delete options.credentials;
      }
      let client, error;
      try {
        client = new Client(clientOptions);
      } catch (e) {
        error = e;
      }
      assert.equal(calls, 0, 'construction must not resolve credentials');
      for (let i = 0; i < (error ? 0 : (c.requests ?? 1)); i++) {
        try {
          const op = c.operation ?? 'keyed';
          const result = await client.api[op](
            {},
            { ...options, ...(op === 'keyed' ? { idempotencyKey: 'synthetic-key' } : {}) },
          );
          assert.equal(result.lastResponse.attempts, c.requests ? 1 : seen.length, c.name);
        } catch (e) {
          error = e;
          break;
        }
      }
      assert.equal(error?.name, c.error, c.name);
      if (c.code) assert.equal(error.code, c.code, c.name);
      if (c.bodyFailures && error) {
        assert.equal(error.status, 401, c.name);
        assert.equal(error.outcome, 'unknown', c.name);
      }
      if (c.message) assert.equal(error.message, c.message, c.name);
      if (c.error) assert.equal(error.retryAllowed, false, c.name);
      if (c.kind === 'string' && c.value === '') assert.equal(error.code, 'credential_missing');
      else if (Object.hasOwn(c, 'value'))
        assert.match(
          error.message,
          surface === 'token'
            ? /Explicit API credentials/
            : /Missing or invalid credentials; pass apiKey in client options or request options/,
        );
      assert.deepEqual(seen, c.headers, c.name);
      assert.equal(calls, c.calls, c.name);
      assert.equal(invalidations, c.invalidations, c.name);
      if ((c.operation ?? 'keyed') === 'keyed')
        for (const key of keys) assert.equal(key, 'synthetic-key');
      if (c.operation === 'auto') {
        assert.match(keys[0], /^[0-9a-f-]{36}$/);
        assert.equal(new Set(keys).size, 1);
      }
      assert.doesNotMatch(
        inspect([client, error, events], { depth: 20 }) + JSON.stringify([error, events]),
        /test-token/,
      );
    }
    // The PHP runner consumes the very same cases and asserts their independent expectations.
    const r = spawnSync(
      'php',
      [
        '-d',
        'zend.exception_ignore_args=0',
        'tests/helpers/credential-providers.php',
        join(output, 'php'),
        resolve('tests/fixtures/credential-providers.json'),
        surface,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.stdout, 'ok');
  });

test('default transports preserve the 401 refresh policy after truncated bodies', async () => {
  const { Client } = await import(pathToFileURL(join(outputs.named, 'node/index.js')).href);
  for (const c of cases.filter((c) => c.bodyFailures)) {
    let seen = [];
    const server = createServer((req, res) => {
      seen.push(req.headers.authorization?.replace(/^Bearer /, '') ?? null);
      assert.equal(req.headers['idempotency-key'], 'synthetic-key');
      const index = seen.length - 1;
      const status = c.statuses[index] ?? 500;
      if (c.bodyFailures.includes(index)) {
        res.writeHead(status, { 'content-length': '100', connection: 'close' });
        res.flushHeaders();
        res.end('truncated');
      } else {
        res.writeHead(status);
        res.end();
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    try {
      let calls = 0,
        invalidations = 0;
      const client = new Client({
        baseUrl,
        allowInsecureHttp: true,
        apiKey: {
          async getCredential() {
            return { value: 'test-token-' + ++calls };
          },
          invalidate() {
            invalidations++;
          },
        },
      });
      let error;
      try {
        const result = await client.api.keyed(
          {},
          {
            idempotencyKey: 'synthetic-key',
            ...(c.maxAttempts ? { maxAttempts: c.maxAttempts } : {}),
          },
        );
        assert.equal(result.lastResponse.attempts, c.headers.length, c.name);
      } catch (e) {
        error = e;
      }
      assert.equal(error?.name, c.error, c.name);
      if (error) {
        assert.equal(error.retryAllowed, false, c.name);
        assert.equal(error.status, 401, c.name);
        assert.equal(error.outcome, 'unknown', c.name);
      }
      assert.deepEqual(seen, c.headers, c.name);
      assert.equal(calls, c.calls, c.name);
      assert.equal(invalidations, c.invalidations, c.name);
      seen = [];
      const fixture = join(root, 'truncated-case.json');
      writeFileSync(fixture, JSON.stringify([c]));
      const child = spawn('php', [
        'tests/helpers/credential-providers.php',
        join(outputs.named, 'php'),
        fixture,
        'clientShortcut',
        baseUrl,
      ]);
      let output = '';
      child.stdout.on('data', (chunk) => {
        output += chunk;
      });
      child.stderr.on('data', (chunk) => {
        output += chunk;
      });
      const code = await new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('close', resolve);
      });
      assert.equal(code, 0, output);
      assert.equal(output, 'ok');
      assert.deepEqual(seen, c.headers, c.name);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }
});

test('generated credential provider types compile for Node and PHP consumers', () => {
  const file = join(outputs.named, 'node/consumer.mts');
  writeFileSync(
    file,
    `import { Client, type CredentialProvider } from './index.js';
import { type CredentialProvider as ScopedProvider } from './resources/api.js';
const provider: CredentialProvider = { async getCredential() { return { value: 'synthetic', expiresAt: new Date() }; }, invalidate() {} };
const scoped: ScopedProvider = provider;
const c = new Client({ baseUrl: 'https://example.invalid', apiKey: scoped });
c.api.read({}, { apiKey: provider });
c.api.read({}, { authMode: 'service', credentials: { Bearer: provider } });
new Client({ baseUrl: 'https://example.invalid', credentials: { service: { Bearer: provider } } });
// @ts-expect-error provider must return a string value
new Client({ baseUrl: 'https://example.invalid', apiKey: { async getCredential() { return { value: 42 }; } } });
`,
  );
  let r = spawnSync(
    process.execPath,
    [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '--strict',
      '--module',
      'NodeNext',
      '--target',
      'ES2022',
      '--typeRoots',
      resolve('node_modules/@types'),
      file,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const php = join(root, 'consumer.php');
  writeFileSync(
    php,
    `<?php
use Example\\Credentials\\{Client, ClientOptions, RequestOptions, CredentialProvider, Credential};
final class Provider implements CredentialProvider {
  public function getCredential(): Credential { return new Credential('synthetic', new DateTimeImmutable()); }
  public function invalidate(): void {}
}
$p = new Provider();
$c = new Client(new ClientOptions(baseUrl:'https://example.invalid', apiKey:$p));
$c->api->read(options:new RequestOptions(apiKey:$p));
$c->api->read(options:new RequestOptions(authMode:'service', credentials:['Bearer'=>$p]));
new ClientOptions(apiKey:fn():string=>'synthetic');
new ClientOptions(apiKey:fn():Credential=>new Credential('synthetic'));
`,
  );
  const neon = join(root, 'phpstan.neon');
  writeFileSync(
    neon,
    `parameters:\n    level: max\n    phpVersion: 80200\n    tmpDir: ${JSON.stringify(join(root, 'phpstan-cache'))}\n    scanDirectories:\n        - ${JSON.stringify(join(outputs.named, 'php/src'))}\n`,
  );
  r = spawnSync(
    'php',
    [
      resolve('.generated/phpstan-vendor/bin/phpstan'),
      'analyse',
      '--debug',
      '--no-progress',
      '--error-format=raw',
      '-c',
      neon,
      php,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
