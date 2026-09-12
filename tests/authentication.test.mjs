import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadContract, generate } from '../dist/index.js';
import { validateFixtures } from '../dist/fixtures.js';
const dir = mkdtempSync(join(tmpdir(), 'sdk-auth-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const doc = {
  openapi: '3.1.0',
  info: { title: 'Authentication', version: 'v1' },
  components: {
    securitySchemes: {
      BearerAuth: { type: 'http', scheme: 'bearer' },
      ApiKeyHeader: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
      SecretHeader: { type: 'apiKey', in: 'header', name: 'X-Secret' },
    },
  },
  paths: {
    '/value': {
      get: {
        operationId: 'getValue',
        security: [{ ApiKeyHeader: [] }, { BearerAuth: [] }],
        responses: { 204: { description: 'empty' } },
      },
    },
  },
};
const config = {
  version: '1.0.0',
  auth: { scheme: 'BearerAuth' },
  requests: { style: 'object' },
  npm: { name: '@example/auth' },
  composer: { name: 'example/auth', namespace: 'Example\\Auth' },
};
function load(d = doc, c = config) {
  const api = join(dir, 'api.json'),
    sdk = join(dir, 'sdk.json');
  writeFileSync(api, JSON.stringify(d));
  writeFileSync(sdk, JSON.stringify(c));
  return loadContract(api, sdk);
}

test('explicit bearer and API-key alternatives generate matching authentication in both targets', async () => {
  for (const [scheme, header, value] of [
    ['BearerAuth', 'authorization', 'Bearer test-token'],
    ['ApiKeyHeader', 'x-api-key', 'test-token'],
  ]) {
    const c = load(doc, { ...config, auth: { scheme } }),
      output = join(dir, scheme);
    generate(c, output);
    const path = join(dir, scheme + '.json');
    writeFileSync(
      path,
      JSON.stringify([
        {
          name: scheme,
          operation: 'getValue',
          input: {},
          expected: { method: 'GET', path: '/v1/value', headers: { [header]: value } },
          responses: [{ status: 204 }],
          empty: true,
        },
      ]),
    );
    assert.deepEqual(
      (await validateFixtures(output, path)).map((r) => r.scenarios),
      [1, 1],
    );
  }
});

test('authentication selection cannot weaken required combinations or invent an alternative', () => {
  assert.throws(() => load(doc, { ...config, auth: undefined }), /config.auth.scheme/);
  assert.throws(
    () => load(doc, { ...config, auth: { scheme: 'unknown' } }),
    /existing security scheme/,
  );
  assert.throws(
    () => load(doc, { ...config, auth: { scheme: 'SecretHeader' } }),
    /standalone alternative/,
  );
  const d = structuredClone(doc);
  d.paths['/value'].get.security = [{ BearerAuth: [], SecretHeader: [] }];
  assert.throws(() => load(d), /standalone alternative/);
});

test('optional authentication follows caller credentials without requiring them', async () => {
  const d = structuredClone(doc);
  d.paths['/value'].get.security = [{}, { BearerAuth: [] }];
  const output = join(dir, 'optional');
  generate(load(d), output);
  const { Client } = await import(pathToFileURL(join(output, 'node/index.js')).href);
  for (const token of [undefined, 'caller-token']) {
    let headers;
    const c = new Client({
      baseUrl: 'https://example.invalid',
      token,
      transport: async (_url, init) => {
        headers = init.headers;
        return new Response(null, { status: 204 });
      },
    });
    await c.api.getValue();
    assert.equal(headers.authorization, token ? 'Bearer ' + token : undefined);
  }
  const php = `require $argv[1].'/src/Runtime.php';require $argv[1].'/src/Client.php';$headers=[];foreach([null,'caller-token'] as $token){$c=new Example\\Auth\\Client(new Example\\Auth\\ClientOptions('https://example.invalid',token:$token,transport:function($r)use(&$headers){$headers[]=$r['headers']['authorization']??null;return ['status'=>204,'headers'=>[],'body'=>''];}));$c->api->getValue();}echo json_encode($headers);`;
  const result = spawnSync('php', ['-r', php, join(output, 'php')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [null, 'Bearer caller-token']);
});
