import { before } from 'node:test';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { inspect } from 'node:util';
import { loadContract, generate } from '../dist/index.js';

const root = mkdtempSync(join(tmpdir(), 'sdk-default-credentials-'));
after(() => rmSync(root, { recursive: true, force: true }));
const cases = JSON.parse(readFileSync('tests/fixtures/default-credentials.json', 'utf8'));
const defaults = {
  mode: 'service',
  scheme: 'Bearer',
  environment: { apiKey: 'EXAMPLE_API_KEY', token: 'EXAMPLE_ACCESS_TOKEN' },
  workloadIdentity: {
    tokenPath: '/v1/oauth/token',
    credentialParameter: 'workload_identity_id',
    envPrefix: 'EXAMPLE',
  },
};
const doc = {
  openapi: '3.1.0',
  info: { title: 'Discovery', version: '1' },
  servers: [{ url: 'https://example.invalid' }],
  components: {
    securitySchemes: {
      Bearer: { type: 'http', scheme: 'bearer' },
      Partner: { type: 'apiKey', in: 'header', name: 'x-partner-key' },
    },
  },
  paths: Object.fromEntries(
    ['read', 'anonymous', 'partner'].map((id) => [
      '/' + id,
      {
        get: {
          operationId: id,
          security:
            id === 'anonymous' ? [] : id === 'partner' ? [{ Partner: [] }] : [{ Bearer: [] }],
          responses: { 204: { description: 'Done' } },
        },
      },
    ]),
  ),
};
const config = {
  version: '1.0.0',
  npm: { name: '@example/discovery' },
  composer: { name: 'example/discovery', namespace: 'Example\\Discovery' },
  requests: { style: 'object' },
  responses: { return: 'result' },
  auth: {
    modes: { service: { schemes: ['Bearer'] }, partner: { schemes: ['Partner'] } },
    shortcuts: { apiKey: { mode: 'service', scheme: 'Bearer' } },
    defaultCredentials: defaults,
  },
  operations: {
    read: { resource: 'api', method: 'read' },
    anonymous: { resource: 'api', method: 'anonymous' },
    partner: { resource: 'api', method: 'partner' },
  },
};
writeFileSync(join(root, 'api.json'), JSON.stringify(doc));
writeFileSync(join(root, 'sdk.json'), JSON.stringify(config));
const output = join(root, 'generated');
let sdk;
before(async () => {
  generate(loadContract(join(root, 'api.json'), join(root, 'sdk.json')), output);
  sdk = await import(pathToFileURL(join(output, 'node/index.js')).href);
});
const jwt = (claims, now) =>
  [
    Buffer.from('{}').toString('base64url'),
    Buffer.from(
      JSON.stringify({
        iss: 'synthetic-issuer',
        sub: 'synthetic-subject',
        aud: 'https://example.invalid',
        exp: now / 1000 + (claims.expOffset ?? 3600),
        ...claims,
      }),
    ).toString('base64url'),
    'synthetic-signature',
  ].join('.');
const envKeys = [
  'API_KEY',
  'ACCESS_TOKEN',
  'WORKLOAD_IDENTITY_ID',
  'OIDC_SOURCE',
  'OIDC_TOKEN',
  'OIDC_TOKEN_FILE',
  'OIDC_AUDIENCE',
  'OIDC_SCOPE',
];
function clearEnv() {
  for (const key of envKeys) delete process.env['EXAMPLE_' + key];
  for (const key of [
    'GITHUB_ACTIONS',
    'ACTIONS_ID_TOKEN_REQUEST_URL',
    'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
  ])
    delete process.env[key];
}

test('shared default credential conformance in Node and PHP', async () => {
  const realNow = Date.now;
  try {
    for (const c of cases) {
      clearEnv();
      let now = 1900000000000;
      Date.now = () => now;
      const id = 'wid_synthetic_' + cases.indexOf(c);
      for (const [key, value] of Object.entries(c.environment ?? {}))
        process.env['EXAMPLE_' + key] = value;
      if (c.identity) process.env.EXAMPLE_WORKLOAD_IDENTITY_ID = id;
      const subject = c.rawToken ?? (c.token ? jwt(c.token, now) : '');
      if (subject) process.env.EXAMPLE_OIDC_TOKEN = subject;
      const file = join(root, id + '.jwt');
      if (Object.hasOwn(c, 'file') || c.fileToken || c.missingFile) {
        process.env.EXAMPLE_OIDC_TOKEN_FILE = file;
        if (!c.missingFile) writeFileSync(file, c.fileToken ? jwt(c.fileToken, now) : c.file);
      }
      let exchanges = 0,
        seen = [],
        sentSubjects = [],
        events = [];
      const options = {
        diagnostics: (event) => events.push(event),
        ...(c.disabled ? { ambientCredentials: false } : {}),
        transport: async (url, init) => {
          if (new URL(url).pathname === '/v1/oauth/token') {
            const status = c.exchanges?.[exchanges++];
            assert.notEqual(status, undefined, c.name + ' unexpected exchange');
            assert.equal(init.method, 'POST');
            assert.equal(init.redirect, 'manual');
            assert.equal(init.headers['content-type'], 'application/x-www-form-urlencoded');
            const expectedSubject =
              process.env.EXAMPLE_OIDC_SOURCE === 'token_file' || (!subject && !c.rawToken)
                ? readFileSync(file, 'utf8').trim()
                : subject;
            const expected = {
              grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
              subject_token: expectedSubject,
              subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
              requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
              workload_identity_id: id,
              ...(c.environment?.OIDC_SCOPE ? { scope: c.environment.OIDC_SCOPE } : {}),
            };
            assert.deepEqual(Object.fromEntries(new URLSearchParams(init.body)), expected, c.name);
            sentSubjects.push(expectedSubject);
            if (!status) throw new Error('synthetic-sensitive ' + expectedSubject);
            const body =
              c.response ??
              (status === 200
                ? {
                    access_token: 'synthetic-exchanged-' + exchanges,
                    issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
                    token_type: 'Bearer',
                    expires_in: c.lifetime ?? 3600,
                    scope: 'records.read',
                    workload_identity_id: id,
                    merchant_id: 'merchant_synthetic',
                    mode: 'test',
                    sandbox_id: 'sandbox_synthetic',
                  }
                : {
                    error: 'invalid_grant',
                    error_description: c.echoToken
                      ? 'Rejected ' + expectedSubject
                      : 'Synthetic server description',
                  });
            return new Response(JSON.stringify(body), {
              status,
              headers: { 'retry-after': c.retryAfter ?? '0' },
            });
          }
          seen.push(
            init.headers.authorization?.replace(/^Bearer /, '') ??
              init.headers['x-partner-key'] ??
              null,
          );
          return new Response(null, { status: c.apiStatuses?.[seen.length - 1] ?? 204 });
        },
      };
      if (c.explicit) options.apiKey = c.explicit;
      if (c.explicitMap || c.emptyMap)
        options.credentials = { service: c.emptyMap ? {} : { Bearer: c.explicitMap } };
      if (c.partnerCredential) options.credentials = { partner: { Partner: c.partnerCredential } };
      if (c.provider)
        options.apiKey =
          c.provider === 'identity'
            ? sdk.workloadIdentityCredentials({ workloadIdentityId: id, source: 'token' })
            : sdk.defaultCredentials();
      const client = new sdk.Client(options);
      assert.equal(exchanges, 0, 'construction must be lazy');
      let error;
      for (const advance of c.calls ?? [0]) {
        now += advance * 1000;
        if (advance && c.rotateFile) writeFileSync(file, jwt({ sub: 'rotated-subject' }, now));
        try {
          await client.api[c.method ?? (c.anonymous ? 'anonymous' : 'read')](
            {},
            c.requestCredential ? { credentials: { Bearer: c.requestCredential } } : {},
          );
        } catch (e) {
          error = e;
          break;
        }
      }
      assert.equal(error?.code, c.reason, c.name + ': ' + error?.message);
      assert.equal(
        error?.kind,
        c.reason || c.authenticationError ? 'authentication' : undefined,
        c.name,
      );
      assert.deepEqual(seen, c.headers ?? [], c.name);
      assert.equal(exchanges, c.exchanges?.length ?? 0, c.name);
      if (c.rotateFile) assert.notEqual(sentSubjects[0], sentSubjects[1]);
      if (c.echoToken) {
        assert.equal(error.details.iss, 'synthetic-issuer');
        assert.equal(error.details.sub, 'synthetic-subject');
        assert.match(error.details.error_description, /Rejected \[REDACTED\]/);
      }
      const debug =
        inspect([client, options.apiKey, error, events], { depth: 20 }) +
        JSON.stringify([options.apiKey, error, events]);
      for (const token of c.redactedTokens ?? []) {
        for (const value of [token, encodeURIComponent(token)]) {
          for (const surface of [
            error.message,
            JSON.stringify(error.details),
            inspect(error),
            debug,
          ])
            assert.ok(!surface.includes(value), c.name + ' response token leaked');
        }
        assert.ok(error.details.error_description.includes('[REDACTED]'));
      }
      if (subject) assert.ok(!debug.includes(subject), c.name + ' subject leaked');
      assert.doesNotMatch(debug, /synthetic-exchanged-|synthetic-api-key|synthetic-access-token/);
    }
  } finally {
    Date.now = realNow;
    clearEnv();
  }
  const result = spawnSync(
    'php',
    [
      '-d',
      'zend.exception_ignore_args=0',
      'tests/helpers/default-credentials.php',
      join(output, 'php'),
      resolve('tests/fixtures/default-credentials.json'),
      root,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout, 'ok');
});

test('100 concurrent requests across clients share one exchange', async () => {
  clearEnv();
  process.env.EXAMPLE_WORKLOAD_IDENTITY_ID = 'wid_synthetic_concurrent';
  process.env.EXAMPLE_OIDC_TOKEN = jwt({}, Date.now());
  let exchanges = 0,
    calls = 0;
  try {
    const transport = async (url) => {
      if (new URL(url).pathname.endsWith('/token')) {
        exchanges++;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return Response.json({
          access_token: 'synthetic-concurrent',
          token_type: 'Bearer',
          issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
          expires_in: 3600,
        });
      }
      calls++;
      return new Response(null, { status: 204 });
    };
    await Promise.all(Array.from({ length: 100 }, () => new sdk.Client({ transport }).api.read()));
    assert.equal(exchanges, 1);
    assert.equal(calls, 100);
  } finally {
    clearEnv();
  }
});

test('shared credential concurrency scenarios in Node', async () => {
  const scenarios = JSON.parse(
    readFileSync('tests/fixtures/default-credentials-concurrency.json', 'utf8'),
  );
  try {
    for (const c of scenarios) {
      clearEnv();
      process.env.EXAMPLE_OIDC_TOKEN = jwt(
        { aud: ['https://example.invalid', 'https://other.invalid'] },
        Date.now(),
      );
      const provider = sdk.workloadIdentityCredentials({
        workloadIdentityId: 'wid_concurrency_' + scenarios.indexOf(c),
      });
      let release, started;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      const dispatched = new Promise((resolve) => {
        started = resolve;
      });
      const exchanges = [],
        seen = [];
      const transport = async (url, init) => {
        const origin = new URL(url).origin;
        if (new URL(url).pathname.endsWith('/token')) {
          exchanges.push(origin);
          if (c.kind === 'waiter') {
            started();
            await gate;
          }
          return Response.json({
            access_token: 'synthetic-shared-' + exchanges.length,
            token_type: 'Bearer',
            issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
            expires_in: 3600,
          });
        }
        seen.push(init.headers.authorization.replace(/^Bearer /, ''));
        const call = seen.length;
        if (c.kind === 'invalidation' && call === 1) {
          started();
          await gate;
          return new Response(null, { status: 401 });
        }
        return new Response(null, {
          status: c.kind === 'invalidation' && call === 2 ? c.secondStatus : 204,
        });
      };
      const client = (baseUrl) => new sdk.Client({ apiKey: provider, baseUrl, transport });
      if (c.kind === 'invalidation') {
        const first = client(c.origins[0]).api.read();
        await dispatched;
        const second = client(c.origins[1]);
        await second.api.read();
        release();
        await first;
        await second.api.read();
        assert.deepEqual(exchanges, c.exchangeOrigins, c.name);
        assert.deepEqual(seen, c.headers, c.name);
      } else {
        const owner = client('https://example.invalid').api.read();
        await dispatched;
        const controller = new AbortController();
        const waiter = client('https://example.invalid')
          .api.read({}, { deadlineMs: c.deadlineMs, signal: controller.signal })
          .catch((error) => error);
        // Allow the waiter to join the owner's exchange, then wake it independently.
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (c.stop === 'cancelled') controller.abort();
        else await new Promise((resolve) => setTimeout(resolve, c.deadlineMs + 10));
        if (c.ownerFirst) {
          release();
          await owner;
        }
        const error = await waiter;
        assert.equal(error?.kind, c.stop, c.name);
        if (!c.ownerFirst) {
          assert.equal(seen.length, 0, c.name + ' owner must still be waiting');
          release();
          await owner;
        }
        await client('https://example.invalid').api.read();
        assert.equal(exchanges.length, 1, c.name);
        assert.deepEqual(seen, ['synthetic-shared-1', 'synthetic-shared-1'], c.name);
      }
    }
  } finally {
    clearEnv();
  }
});

test('incomplete declarations produce diagnostics', () => {
  for (const mutate of [
    (d) => delete d.mode,
    (d) => delete d.scheme,
    (d) => delete d.environment,
    (d) => delete d.environment.apiKey,
    (d) => delete d.environment.token,
    (d) => delete d.workloadIdentity,
    (d) => delete d.workloadIdentity.tokenPath,
    (d) => delete d.workloadIdentity.credentialParameter,
    (d) => delete d.workloadIdentity.envPrefix,
    (d) => (d.mode = 'missing'),
    (d) => (d.workloadIdentity.tokenPath = 'https://foreign.invalid/token'),
    (d) => (d.workloadIdentity.credentialParameter = 'subject_token'),
    (d) => (d.environment.token = d.environment.apiKey),
  ]) {
    const altered = structuredClone(config);
    mutate(altered.auth.defaultCredentials);
    writeFileSync(join(root, 'invalid.json'), JSON.stringify(altered));
    assert.throws(
      () => loadContract(join(root, 'api.json'), join(root, 'invalid.json')),
      /config\/auth\/defaultCredentials/,
    );
  }
});

test('default HTTP transports exchange form data and PHP shares a PSR-16 credential cache', async () => {
  const { createServer } = await import('node:http');
  const { spawn } = await import('node:child_process');
  const seen = [];
  let exchanges = 0,
    apiCalls = 0;
  let baseUrl;
  const server = createServer(async (req, res) => {
    if (req.url === '/v1/oauth/token') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const form = Object.fromEntries(new URLSearchParams(body));
      seen.push({ ...form, subject_token: '[REDACTED]' });
      assert.equal(form.subject_token, process.env.EXAMPLE_OIDC_TOKEN);
      assert.equal(form.workload_identity_id, 'wid_synthetic_http');
      exchanges++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          access_token: 'synthetic-http-' + exchanges,
          token_type: 'Bearer',
          issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
          expires_in: 3600,
        }),
      );
    } else {
      apiCalls++;
      assert.match(req.headers.authorization, /^Bearer synthetic-http-/);
      res.writeHead(apiCalls === 1 ? 401 : 204);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = 'http://127.0.0.1:' + server.address().port;
  clearEnv();
  process.env.EXAMPLE_WORKLOAD_IDENTITY_ID = 'wid_synthetic_http';
  process.env.EXAMPLE_OIDC_TOKEN = jwt({ aud: baseUrl }, Date.now());
  try {
    await new sdk.Client({ baseUrl, allowInsecureHttp: true }).api.read();
    assert.equal(exchanges, 2);
    assert.equal(apiCalls, 2);
    exchanges = 0;
    apiCalls = 0;
    const child = spawn('php', [
      'tests/helpers/default-credentials-http.php',
      join(output, 'php'),
      baseUrl,
      process.env.EXAMPLE_OIDC_TOKEN,
    ]);
    let text = '';
    child.stdout.on('data', (chunk) => (text += chunk));
    child.stderr.on('data', (chunk) => (text += chunk));
    const code = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
    assert.equal(code, 0, text);
    assert.equal(text, 'ok');
    assert.equal(exchanges, 2);
    assert.equal(apiCalls, 101);
    for (const form of seen) {
      assert.equal(form.grant_type, 'urn:ietf:params:oauth:grant-type:token-exchange');
      assert.equal(form.requested_token_type, 'urn:ietf:params:oauth:token-type:access_token');
      assert.equal(form.subject_token_type, 'urn:ietf:params:oauth:token-type:jwt');
    }
  } finally {
    clearEnv();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('cache separates origin, identity, audience, scope and source', async () => {
  const variants = JSON.parse(
    readFileSync('tests/fixtures/default-credentials-cache.json', 'utf8'),
  );
  clearEnv();
  const subject = jwt({ aud: ['https://example.invalid', 'custom-audience'] }, Date.now());
  process.env.EXAMPLE_OIDC_TOKEN = subject;
  const file = join(root, 'cache-partition.jwt');
  writeFileSync(file, subject);
  process.env.EXAMPLE_OIDC_TOKEN_FILE = file;
  let exchanges = 0;
  try {
    for (const v of variants) {
      Object.assign(process.env, {
        EXAMPLE_WORKLOAD_IDENTITY_ID: v.id,
        EXAMPLE_OIDC_AUDIENCE: v.audience,
        EXAMPLE_OIDC_SCOPE: v.scope,
        EXAMPLE_OIDC_SOURCE: v.source,
      });
      await new sdk.Client({
        baseUrl: v.baseUrl,
        transport: async (url, init) => {
          if (new URL(url).pathname === '/v1/oauth/token') {
            exchanges++;
            assert.equal(new URL(url).origin, new URL(v.baseUrl).origin);
            assert.equal(new URLSearchParams(init.body).get('scope'), v.scope);
            return Response.json({
              access_token: 'synthetic-partition-' + exchanges,
              token_type: 'Bearer',
              issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
              expires_in: 3600,
            });
          }
          return new Response(null, { status: 204 });
        },
      }).api.read();
      assert.equal(exchanges, v.exchanges, JSON.stringify(v));
    }
  } finally {
    clearEnv();
  }
});

test('discovery exports and ambient options compile and Composer loads namespace functions', () => {
  const consumer = join(output, 'node/discovery-consumer.mts');
  writeFileSync(
    consumer,
    `import { Client, defaultCredentials, workloadIdentityCredentials, type WorkloadIdentityOptions } from './index.js';
const options: WorkloadIdentityOptions = { workloadIdentityId: 'wid_example', source: 'token_file', audience: 'https://example.invalid', scope: 'read' };
new Client({ ambientCredentials: false, apiKey: workloadIdentityCredentials(options) });
new Client({ credentials: { service: { Bearer: defaultCredentials() } } });
// @ts-expect-error cloud sources are not implemented
workloadIdentityCredentials({ workloadIdentityId: 'wid_example', source: 'gcp' });
`,
  );
  let result = spawnSync(
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
      consumer,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  result = spawnSync(
    'composer',
    [
      'install',
      '--no-dev',
      '--no-interaction',
      '--no-progress',
      '--working-dir=' + join(output, 'php'),
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  result = spawnSync(
    'php',
    [
      '-r',
      `require $argv[1].'/vendor/autoload.php'; if (!function_exists('Example\\\\Discovery\\\\defaultCredentials') || class_exists('Example\\\\Discovery\\\\AmbientCredentialProvider', false)) exit(1); $p=Example\\Discovery\\workloadIdentityCredentials(['workloadIdentityId'=>'wid_example']); if (!$p instanceof Example\\Discovery\\CredentialProvider) exit(2); echo 'ok';`,
      join(output, 'php'),
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout, 'ok');
  const php = join(root, 'discovery-consumer.php');
  writeFileSync(
    php,
    `<?php
use Example\\Discovery\\{Client, ClientOptions};
use function Example\\Discovery\\{defaultCredentials, workloadIdentityCredentials};
new Client(new ClientOptions(ambientCredentials: false, apiKey: defaultCredentials()));
new Client(new ClientOptions(apiKey: workloadIdentityCredentials(['workloadIdentityId'=>'wid_example','source'=>'token_file'])));
`,
  );
  const neon = join(root, 'discovery-phpstan.neon');
  writeFileSync(
    neon,
    `parameters:\n    level: max\n    phpVersion: 80200\n    tmpDir: ${JSON.stringify(join(root, 'phpstan-cache'))}\n    scanDirectories:\n        - ${JSON.stringify(join(output, 'php/src'))}\n`,
  );
  result = spawnSync(
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
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('GitHub Actions source in Node and PHP: auto, single exchange, permission and audience failures', async () => {
  const { createServer } = await import('node:http');
  const { spawn } = await import('node:child_process');
  let baseUrl, scenario, requests, exchanges, calls;
  const secret = 'synthetic-github-request-secret';
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, baseUrl);
    if (url.pathname === '/github') {
      requests++;
      assert.equal(req.method, 'GET');
      assert.equal(req.headers.authorization, 'Bearer ' + secret);
      assert.equal(url.searchParams.get('audience'), baseUrl);
      assert.equal(url.searchParams.get('existing'), 'retained');
      if (scenario === 'denied') {
        res.writeHead(403);
        res.end(secret);
        return;
      }
      if (scenario === 'redirect') {
        res.writeHead(302, { location: '/leaked' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          value: jwt(
            {
              aud: scenario === 'wrong-audience' ? 'wrong' : baseUrl,
              expOffset: scenario === 'expired' ? -1 : 3600,
            },
            Date.now(),
          ),
        }),
      );
    } else if (url.pathname === '/v1/oauth/token') {
      exchanges++;
      let body = '';
      for await (const chunk of req) body += chunk;
      const form = new URLSearchParams(body);
      const claims = JSON.parse(Buffer.from(form.get('subject_token').split('.')[1], 'base64url'));
      assert.equal(claims.aud, baseUrl);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          access_token: 'synthetic-github-access',
          token_type: 'Bearer',
          issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
          expires_in: 3600,
        }),
      );
    } else {
      assert.equal(url.pathname, '/read', 'redirect must not be followed');
      calls++;
      assert.equal(req.headers.authorization, 'Bearer synthetic-github-access');
      res.writeHead(204);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = 'http://127.0.0.1:' + server.address().port;
  const helper = join(root, 'github.php');
  writeFileSync(
    helper,
    `<?php
require $argv[1] . '/src/autoload.php';
$client = new Example\\Discovery\\Client(new Example\\Discovery\\ClientOptions(baseUrl: $argv[2], allowInsecureHttp: true));
try { for ($i = 0; $i < 100; $i++) $client->api->read(); echo 'ok'; }
catch (Example\\Discovery\\SdkError $e) { if (str_contains($e->getMessage(), 'synthetic-github-request-secret')) exit(2); echo $e->errorCode; }
`,
  );
  try {
    for (const language of ['node', 'php'])
      for (const name of [
        'success',
        'explicit',
        'missing-permission',
        'denied',
        'wrong-audience',
        'expired',
        'redirect',
      ]) {
        clearEnv();
        scenario = name;
        requests = exchanges = calls = 0;
        process.env.EXAMPLE_WORKLOAD_IDENTITY_ID = 'wid_github_' + language + '_' + name;
        process.env.GITHUB_ACTIONS = 'true';
        process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = secret;
        if (name !== 'missing-permission')
          process.env.ACTIONS_ID_TOKEN_REQUEST_URL =
            (language === 'php' ? baseUrl.replace('127.0.0.1', 'localhost') : baseUrl) +
            '/github?existing=retained&audience=old';
        if (name === 'explicit') process.env.EXAMPLE_OIDC_SOURCE = 'github_actions';
        const expected =
          name === 'success' || name === 'explicit'
            ? 'ok'
            : name === 'missing-permission'
              ? 'source_unavailable'
              : name === 'wrong-audience' || name === 'expired'
                ? 'audience_mismatch'
                : 'subject_token_request_failed';
        if (language === 'node') {
          let result = 'ok';
          try {
            const client = new sdk.Client({ baseUrl, allowInsecureHttp: true });
            if (expected === 'ok')
              await Promise.all(Array.from({ length: 100 }, () => client.api.read()));
            else await client.api.read();
          } catch (e) {
            result = e.code;
            assert.ok(!e.message.includes(secret));
          }
          assert.equal(result, expected, name);
        } else {
          const child = spawn('php', [helper, join(output, 'php'), baseUrl], {
            env: { ...process.env, http_proxy: 'http://127.0.0.1:1', no_proxy: '127.0.0.1' },
          });
          let stdout = '',
            stderr = '';
          child.stdout.on('data', (chunk) => (stdout += chunk));
          child.stderr.on('data', (chunk) => (stderr += chunk));
          const code = await new Promise((resolve, reject) => {
            child.on('error', reject);
            child.on('close', resolve);
          });
          assert.equal(code, 0, stderr);
          assert.equal(stdout, expected, name);
        }
        assert.equal(requests, name === 'missing-permission' ? 0 : 1, name);
        assert.equal(exchanges, expected === 'ok' ? 1 : 0, name);
        assert.equal(calls, expected === 'ok' ? 100 : 0, name);
      }
  } finally {
    clearEnv();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
