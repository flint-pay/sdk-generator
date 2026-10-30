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
  {
    name: 'non-enumerable client key overrides environment',
    nonEnumerable: 'client',
    header: 'Bearer synthetic-tenant',
  },
  {
    name: 'non-enumerable empty request key on idempotent call',
    nonEnumerable: 'request',
    method: 'create',
    level: 'request',
    key: 'apiKey',
    value: 'undefined',
    param: 'apiKey',
  },
  {
    name: 'non-enumerable empty request key while polling',
    nonEnumerable: 'request',
    method: 'pollWait',
    level: 'request',
    key: 'apiKey',
    value: 'undefined',
    param: 'apiKey',
  },
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
          '/create': {
            post: {
              operationId: 'create',
              security: [{ Bearer: [] }],
              parameters: [
                {
                  name: 'Idempotency-Key',
                  in: 'header',
                  required: true,
                  schema: { type: 'string' },
                },
              ],
              responses: { 204: { description: 'Done' } },
            },
          },
          '/poll': {
            get: {
              operationId: 'poll',
              security: [{ Bearer: [] }],
              responses: {
                200: {
                  description: 'Status',
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        required: ['state'],
                        properties: { state: { type: 'string' } },
                      },
                    },
                  },
                },
              },
            },
          },
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
        operations: {
          read: { resource: 'api', method: 'read' },
          create: {
            resource: 'api',
            method: 'create',
            idempotency: {
              header: 'Idempotency-Key',
              retention: '24 hours (fixture only)',
              scope: 'tenant (fixture only)',
              auto: true,
            },
          },
          poll: {
            resource: 'api',
            method: 'poll',
            polling: { state: 'state', success: ['done'], failure: ['failed'], intervalMs: 1 },
          },
        },
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
      if (c.nonEnumerable === 'client')
        Object.defineProperty(options, 'apiKey', { value: 'synthetic-tenant' });
      let phase = 'construction',
        error;
      try {
        const client = new sdk.Client(options);
        phase = 'request';
        const request =
          c.level === 'request'
            ? supplied(c)
            : c.override === 'shortcut'
              ? { checkoutToken: 'synthetic-tenant' }
              : c.override
                ? { credentials: c.override === 'map' ? { Bearer: 'synthetic-tenant' } : {} }
                : {};
        if (c.nonEnumerable === 'request')
          Object.defineProperty(request, 'apiKey', { value: undefined, enumerable: false });
        await client.api[c.method ?? 'read']({}, request);
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
          assert.equal(error.param, undefined, c.name);
          assert.doesNotMatch(error.message, /synthetic-platform|synthetic-client|FLINT_API_KEY/);
        } else assert.equal(error.code, 'credential_missing', c.name);
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
