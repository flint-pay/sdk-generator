import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { generate, loadContract } from '../dist/index.js';

const shortcuts = [
  'apiKey',
  'checkoutToken',
  'customerToken',
  'invoiceToken',
  'onboardingToken',
  'token',
];
const cases = [];
for (const level of ['client', 'request']) {
  for (const key of [
    ...shortcuts,
    'credentials',
    'credentials.service',
    'credentials.service.Bearer',
  ]) {
    if (level === 'request' && key === 'credentials.service') continue;
    const param = level === 'request' ? key.replace('service.', '') : key;
    for (const value of ['undefined', null, '', ' \t\n', '\u00a0\ufeff', '\u0085'])
      cases.push({ name: `${level} ${param} ${JSON.stringify(value)}`, level, key, value, param });
  }
}
cases.push(
  { name: 'omitted uses environment', header: 'Bearer synthetic-platform' },
  {
    name: 'omitted uses access token environment',
    accessToken: true,
    header: 'Bearer synthetic-access',
  },
  {
    name: 'later named arguments omit apiKey',
    disabled: false,
    header: 'Bearer synthetic-platform',
  },
  { name: 'disabled with omitted credentials', disabled: true, missing: true },
  {
    name: 'request shortcut replaces client',
    override: 'shortcut',
    header: 'Bearer synthetic-tenant',
  },
  { name: 'request map replaces client', override: 'map', header: 'Bearer synthetic-tenant' },
  { name: 'request map does not inherit missing entries', override: 'empty-map', missing: true },
  { name: 'client map suppresses ambient even for another mode', otherMode: true, missing: true },
);

function supplied(c) {
  const value = c.value === 'undefined' ? undefined : c.value;
  if (c.key === 'credentials.service.Bearer')
    return {
      credentials: c.level === 'client' ? { service: { Bearer: value } } : { Bearer: value },
    };
  if (c.key === 'credentials.service') return { credentials: { service: value } };
  return { [c.key]: value };
}

test('explicit credential presence fails closed in Node and PHP, including named PHP arguments', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sdk-credential-presence-'));
  const env = { ...process.env };
  try {
    writeFileSync(
      join(root, 'api.json'),
      JSON.stringify({
        openapi: '3.1.0',
        info: { title: 'Presence', version: '1' },
        servers: [{ url: 'https://example.invalid' }],
        components: { securitySchemes: { Bearer: { type: 'http', scheme: 'bearer' } } },
        paths: {
          '/read': {
            get: {
              operationId: 'read',
              security: [{ Bearer: [] }],
              responses: { 204: { description: 'Done' } },
            },
          },
        },
      }),
    );
    writeFileSync(
      join(root, 'sdk.json'),
      JSON.stringify({
        version: '1.0.0',
        npm: { name: '@example/presence' },
        composer: { name: 'example/presence', namespace: 'Example\\Presence' },
        requests: { style: 'object' },
        responses: { return: 'result' },
        auth: {
          modes: { service: { schemes: ['Bearer'] }, other: { schemes: ['Bearer'] } },
          shortcuts: Object.fromEntries(
            shortcuts.map((key) => [key, { mode: 'service', scheme: 'Bearer' }]),
          ),
          defaultCredentials: {
            mode: 'service',
            scheme: 'Bearer',
            environment: { apiKey: 'FLINT_API_KEY', token: 'FLINT_ACCESS_TOKEN' },
            workloadIdentity: {
              tokenPath: '/oauth/token',
              credentialParameter: 'workload_identity_id',
              envPrefix: 'FLINT',
            },
          },
        },
        operations: { read: { resource: 'api', method: 'read' } },
      }),
    );
    const output = join(root, 'sdk');
    generate(loadContract(join(root, 'api.json'), join(root, 'sdk.json')), output);
    const sdk = await import(pathToFileURL(join(output, 'node/index.js')).href);
    for (const c of cases) {
      delete process.env.FLINT_ACCESS_TOKEN;
      process.env.FLINT_API_KEY = 'synthetic-platform';
      if (c.accessToken) {
        delete process.env.FLINT_API_KEY;
        process.env.FLINT_ACCESS_TOKEN = 'synthetic-access';
      }
      const seen = [];
      const options = {
        transport: async (_url, init) => {
          seen.push(init.headers.authorization);
          return new Response(null, { status: 204 });
        },
        ...(Object.hasOwn(c, 'disabled') ? { ambientCredentials: !c.disabled } : {}),
        ...(c.level === 'request' || c.override ? { apiKey: 'synthetic-client' } : {}),
        ...(c.level === 'client' ? supplied(c) : {}),
        ...(c.otherMode ? { credentials: { other: { Bearer: 'synthetic-other' } } } : {}),
      };
      let phase = 'construction',
        error;
      try {
        const client = new sdk.Client(options);
        phase = 'request';
        await client.api.read(
          {},
          c.level === 'request'
            ? supplied(c)
            : c.override === 'shortcut'
              ? { checkoutToken: 'synthetic-tenant' }
              : c.override
                ? { credentials: c.override === 'map' ? { Bearer: 'synthetic-tenant' } : {} }
                : {},
        );
      } catch (e) {
        error = e;
      }
      assert.deepEqual(seen, c.header ? [c.header] : [], c.name);
      if (c.level || c.missing) {
        assert.ok(error instanceof sdk.errors.ConfigurationError, c.name);
        assert.equal(error.outcome, 'not_sent', c.name);
        if (c.level) {
          assert.equal(error.attempts, 0, c.name);
          assert.equal(phase, c.level === 'client' ? 'construction' : 'request', c.name);
          assert.equal(error.code, 'credential_missing', c.name);
          assert.equal(error.param, c.param, c.name);
          assert.doesNotMatch(error.message, /synthetic-platform|synthetic-client|FLINT_API_KEY/);
        } else assert.equal(error.code, '', c.name + ': existing missing-credential error');
      } else assert.equal(error, undefined, c.name);
    }
    writeFileSync(join(root, 'cases.json'), JSON.stringify(cases));
    const result = spawnSync(
      'php',
      [
        resolve('tests/helpers/credential-presence.php'),
        join(output, 'php'),
        join(root, 'cases.json'),
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stdout, 'ok');
  } finally {
    for (const key of ['FLINT_API_KEY', 'FLINT_ACCESS_TOKEN']) {
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }
    rmSync(root, { recursive: true, force: true });
  }
});
