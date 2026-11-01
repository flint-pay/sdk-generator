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
const cases = ['default-credentials.json', 'default-credentials-sources.json'].flatMap((name) =>
  JSON.parse(readFileSync('tests/fixtures/' + name, 'utf8')),
);
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
test('generated runtime guides name the public credential conflict code in both targets', () => {
  for (const target of ['node', 'php']) {
    const guide = readFileSync(join(output, target, 'RUNTIME.md'), 'utf8');
    assert.match(guide, /setting both throws ConfigurationError with code credential_conflict/);
    assert.doesNotMatch(guide, /ambiguous_credentials/);
  }
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
  'AZURE_CLIENT_ID',
];
function clearEnv() {
  process.env.EXAMPLE_CLI_CREDENTIALS = '0';
  for (const key of envKeys) delete process.env['EXAMPLE_' + key];
  for (const key of [
    'GITLAB_CI',
    'KUBERNETES_SERVICE_HOST',
    'K_SERVICE',
    'FUNCTION_TARGET',
    'FUNCTION_NAME',
    'GCE_METADATA_HOST',
    'GCE_METADATA_IP',
    'IDENTITY_ENDPOINT',
    'IDENTITY_HEADER',
    'AZURE_RESOURCE_ID',
    'AWS_EXECUTION_ENV',
    'AWS_LAMBDA_FUNCTION_NAME',
    'ECS_CONTAINER_METADATA_URI',
    'ECS_CONTAINER_METADATA_URI_V4',
    'AWS_WEB_IDENTITY_TOKEN_FILE',
    'AZURE_FEDERATED_TOKEN_FILE',
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
      for (const [key, value] of Object.entries(c.platformEnvironment ?? {}))
        process.env[key] = value;
      if (c.identity) process.env.EXAMPLE_WORKLOAD_IDENTITY_ID = id;
      const subject = c.rawToken ?? (c.token ? jwt(c.token, now) : '');
      if (subject) process.env.EXAMPLE_OIDC_TOKEN = subject;
      const file = join(root, id + '.jwt');
      if (Object.hasOwn(c, 'file') || c.fileToken || c.missingFile) {
        process.env.EXAMPLE_OIDC_TOKEN_FILE = file;
        if (!c.missingFile) writeFileSync(file, c.fileToken ? jwt(c.fileToken, now) : c.file);
      }
      let metadataRequests = 0;
      let exchanges = 0,
        seen = [],
        sentSubjects = [],
        events = [];
      const options = {
        diagnostics: (event) => events.push(event),
        ...(c.disabled ? { ambientCredentials: false } : {}),
        transport: async (url, init) => {
          if (init.method === 'GET' && c.metadata && new URL(url).pathname !== '/read') {
            metadataRequests++;
            assert.equal(String(url), c.metadata.url, c.name);
            assert.deepEqual(init.headers, c.metadata.headers, c.name);
            assert.equal(init.redirect, 'manual');
            return new Response(
              c.metadata.rawBody ??
                (c.metadata.json
                  ? JSON.stringify({ access_token: jwt(c.metadata.token ?? {}, now) })
                  : jwt(c.metadata.token ?? {}, now)),
              { status: c.metadata.status ?? 200 },
            );
          }

          if (new URL(url).pathname === '/v1/oauth/token') {
            const status = c.exchanges?.[exchanges++];
            assert.notEqual(status, undefined, c.name + ' unexpected exchange');
            assert.equal(init.method, 'POST');
            assert.equal(init.redirect, 'manual');
            assert.equal(init.headers['content-type'], 'application/x-www-form-urlencoded');
            const expectedSubject = c.metadata
              ? jwt(c.metadata.token ?? {}, now)
              : process.env.EXAMPLE_OIDC_SOURCE === 'token_file' || (!subject && !c.rawToken)
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
            ? sdk.workloadIdentityCredentials({
                workloadIdentityId: id,
                source: c.providerSource ?? 'token',
              })
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
      assert.equal(error?.code, c.code ?? (error ? '' : undefined), c.name + ': ' + error?.message);
      if (c.reason) assert.equal(error.workloadIdentity.reason, c.reason, c.name);
      if (c.source) assert.equal(error.workloadIdentity.source, c.source, c.name);
      if (c.description)
        assert.ok(error.workloadIdentity.errorDescription.includes(c.description), c.name);
      assert.equal(metadataRequests, c.metadata ? 1 : 0, c.name);
      assert.equal(
        error?.name,
        error
          ? c.apiStatuses?.includes(401)
            ? 'AuthenticationError'
            : 'ConfigurationError'
          : undefined,
        c.name,
      );
      assert.deepEqual(seen, c.headers ?? [], c.name);
      assert.equal(exchanges, c.exchanges?.length ?? 0, c.name);
      if (c.rotateFile) assert.notEqual(sentSubjects[0], sentSubjects[1]);
      if (c.echoToken) {
        assert.equal(error.workloadIdentity.iss, 'synthetic-issuer');
        assert.equal(error.workloadIdentity.sub, 'synthetic-subject');
        assert.match(error.workloadIdentity.errorDescription, /Rejected \[REDACTED\]/);
      }
      const debug =
        inspect([client, options.apiKey, error, events], { depth: 20 }) +
        JSON.stringify([options.apiKey, error, events]);
      for (const token of c.redactedTokens ?? []) {
        for (const value of [token, encodeURIComponent(token)]) {
          for (const surface of [
            error.message,
            JSON.stringify(error.workloadIdentity),
            inspect(error),
            debug,
          ])
            assert.ok(!surface.includes(value), c.name + ' response token leaked');
        }
        assert.ok(error.workloadIdentity.errorDescription.includes('[REDACTED]'));
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
        if (c.stop === 'CancelledError') controller.abort();
        else await new Promise((resolve) => setTimeout(resolve, c.deadlineMs + 10));
        if (c.ownerFirst) {
          release();
          await owner;
        }
        const error = await waiter;
        assert.equal(error?.name, c.stop, c.name);
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
// @ts-expect-error unsupported source
workloadIdentityCredentials({ workloadIdentityId: 'wid_example', source: 'unsupported' });
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
catch (Example\\Discovery\\SdkError $e) { if (str_contains($e->getMessage(), 'synthetic-github-request-secret')) exit(2); if ($e->code !== 'workload_identity_failed') exit(3); echo $e->workloadIdentity['reason'] ?? ''; }
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
            assert.equal(e.code, 'workload_identity_failed', name);
            result = e.workloadIdentity.reason;
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

test('default credential and README templates have no staging host', () => {
  for (const path of [
    'src/generate.ts',
    'docs/configuration.md',
    'tests/providers/flint/full-common-sdk.json',
  ])
    assert.doesNotMatch(readFileSync(path, 'utf8'), /api\.staging\.withflintpay\.com/);
});

test('cloud metadata HTTP bypasses proxies, refuses redirects and has a short timeout', async () => {
  const { createServer } = await import('node:http');
  const { spawn } = await import('node:child_process');
  let scenario,
    baseUrl,
    metadata = 0,
    exchanges = 0;
  const server = createServer((req, res) => {
    if (req.url.startsWith('/computeMetadata/') || req.url.startsWith('/azure')) {
      metadata++;
      const url = new URL(req.url, baseUrl);
      assert.equal(
        url.searchParams.get(scenario.source === 'gcp' ? 'audience' : 'resource'),
        baseUrl,
      );
      assert.equal(
        req.headers[scenario.source === 'gcp' ? 'metadata-flavor' : 'x-identity-header'],
        scenario.source === 'gcp' ? 'Google' : 'synthetic-identity-header',
      );
      if (scenario.mode === 'timeout') return;
      if (scenario.mode === 'redirect') {
        res.writeHead(302, { location: baseUrl + '/read' });
        res.end();
        return;
      }
      const token = jwt({ aud: baseUrl }, Date.now());
      res.end(scenario.source === 'gcp' ? token : JSON.stringify({ access_token: token }));
    } else if (req.url === '/v1/oauth/token') {
      exchanges++;
      res.end(
        JSON.stringify({
          access_token: 'synthetic-cloud-access',
          token_type: 'Bearer',
          issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
          expires_in: 3600,
        }),
      );
    } else {
      res.writeHead(204);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = 'http://127.0.0.1:' + server.address().port;
  const php = join(root, 'cloud.php');
  writeFileSync(
    php,
    `<?php
require $argv[1] . '/src/autoload.php';
try {
  $client = new Example\\Discovery\\Client(new Example\\Discovery\\ClientOptions(baseUrl: $argv[2], allowInsecureHttp: true));
  for ($i = 0; $i < 100; $i++) $client->api->read();
  echo 'ok';
} catch (Example\\Discovery\\SdkError $e) { echo $e->workloadIdentity['reason']; }
`,
  );
  try {
    for (const language of ['node', 'php'])
      for (const source of ['gcp', 'azure'])
        for (const mode of ['success', 'redirect', 'timeout']) {
          clearEnv();
          scenario = { source, mode };
          metadata = exchanges = 0;
          const env = {
            ...process.env,
            EXAMPLE_WORKLOAD_IDENTITY_ID: 'wid_http_' + language + source + mode,
            EXAMPLE_OIDC_SOURCE: source,
            EXAMPLE_OIDC_AUDIENCE: baseUrl,
            GCE_METADATA_HOST: '127.0.0.1:' + server.address().port,
            IDENTITY_ENDPOINT: baseUrl + '/azure',
            IDENTITY_HEADER: 'synthetic-identity-header',
            http_proxy: 'http://127.0.0.1:1',
            HTTP_PROXY: 'http://127.0.0.1:1',
            no_proxy: '127.0.0.1',
            NO_PROXY: '127.0.0.1',
          };
          // The metadata host uses localhost, outside NO_PROXY. API exchange stays loopback.
          env.GCE_METADATA_HOST = 'localhost:' + server.address().port;
          env.IDENTITY_ENDPOINT = baseUrl.replace('127.0.0.1', 'localhost') + '/azure';
          const code = `const {Client} = await import(${JSON.stringify(pathToFileURL(join(output, 'node/index.js')).href)}); try { const client = new Client({baseUrl: ${JSON.stringify(baseUrl)}, allowInsecureHttp: true}); await Promise.all(Array.from({length:100}, () => client.api.read())); process.stdout.write('ok'); } catch (e) { process.stdout.write(e.workloadIdentity?.reason ?? e.message); }`;
          const child = spawn(
            language === 'php' ? 'php' : process.execPath,
            language === 'php'
              ? [php, join(output, 'php'), baseUrl]
              : ['--input-type=module', '-e', code],
            { env },
          );
          let stdout = '',
            stderr = '';
          child.stdout.on('data', (chunk) => (stdout += chunk));
          child.stderr.on('data', (chunk) => (stderr += chunk));
          const status = await new Promise((resolve, reject) => {
            child.on('error', reject);
            child.on('close', resolve);
          });
          assert.equal(status, 0, stderr);
          assert.equal(
            stdout,
            mode === 'success' ? 'ok' : 'subject_token_request_failed',
            language + source + mode,
          );
          assert.equal(metadata, 1);
          assert.equal(exchanges, mode === 'success' ? 1 : 0);
        }
  } finally {
    clearEnv();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('shared AWS and CLI-process source conformance in both runtimes', async () => {
  const { mkdirSync, chmodSync, existsSync } = await import('node:fs');
  const { spawn } = await import('node:child_process');
  const php = spawnSync('which', ['php'], { encoding: 'utf8' }).stdout.trim();
  const scenarios = JSON.parse(
    readFileSync('tests/fixtures/default-credentials-aws-cli.json', 'utf8'),
  );
  scenarios.sort(
    (a, b) =>
      Number(Boolean(b.source === 'aws' && b.missing)) -
      Number(Boolean(a.source === 'aws' && a.missing)),
  );
  const nodePackage = JSON.parse(readFileSync(join(output, 'node/package.json'), 'utf8'));
  assert.equal(nodePackage.peerDependenciesMeta['@aws-sdk/client-sts'].optional, true);
  assert.ok(
    JSON.parse(readFileSync(join(output, 'php/composer.json'), 'utf8')).suggest['aws/aws-sdk-php'],
  );
  const awsDir = join(output, 'node/node_modules/@aws-sdk/client-sts');
  const bin = join(root, 'bin'),
    emptyBin = join(root, 'empty-bin');
  mkdirSync(bin);
  mkdirSync(emptyBin);
  const cli = join(bin, 'flint');
  writeFileSync(
    cli,
    `#!${process.execPath}
import('node:fs').then(({appendFileSync}) => {
 if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['auth','token','--output','json'])) process.exit(42);
 appendFileSync(process.env.SYNTHETIC_CLI_LOG, 'cli\\n');
 const c = JSON.parse(process.env.SYNTHETIC_CASE);
 if (c.hang) { setInterval(()=>{},1000); return; }
 if (c.large) { process.stdout.write('x'.repeat(70000)); return; }
 if (c.error) { process.stderr.write(JSON.stringify({error:{code:c.error,message:process.env.SYNTHETIC_CLI_TOKEN}})); process.exitCode = 1; }
 else process.stdout.write(c.raw ?? JSON.stringify({access_token:process.env.SYNTHETIC_CLI_TOKEN,token_type:'Bearer',...(c.noExpiry ? {} : {expires_at:c.expires ?? process.env.SYNTHETIC_CLI_EXPIRY})}));
});
`,
  );
  chmodSync(cli, 0o755);
  const original = { ...process.env };
  try {
    for (const c of scenarios) {
      clearEnv();
      if (c.source === 'aws' && !c.missing && !existsSync(awsDir)) {
        mkdirSync(awsDir, { recursive: true });
        writeFileSync(
          join(awsDir, 'package.json'),
          JSON.stringify({ type: 'module', exports: './index.js' }),
        );
        writeFileSync(
          join(awsDir, 'index.js'),
          `import {appendFileSync} from 'node:fs';
export class GetWebIdentityTokenCommand { constructor(input) { this.input = input; } }
export class STSClient { constructor(config) { if (config.useGlobalEndpoint !== false) throw Error('STS must use regional endpoints'); this.config = config; } destroy() {} async send(command) {
 if (JSON.stringify(command.input) !== JSON.stringify({Audience:['https://example.invalid'],SigningAlgorithm:'ES384'})) throw Error('Invalid STS input');
 appendFileSync(process.env.SYNTHETIC_AWS_LOG, 'sts\\n');
 if (process.env.SYNTHETIC_AWS_FAILURE) throw Error(process.env.SYNTHETIC_AWS_TOKEN);
 return {WebIdentityToken:process.env.SYNTHETIC_AWS_TOKEN};
} }
`,
        );
      }
      const log = join(root, 'source-' + scenarios.indexOf(c) + '.log');
      writeFileSync(log, '');
      Object.assign(process.env, {
        FLINT_PROFILE: c.name,
        SYNTHETIC_CASE: JSON.stringify(c),
        SYNTHETIC_CLI_LOG: log,
        SYNTHETIC_AWS_LOG: log,
        SYNTHETIC_CLI_TOKEN: 'synthetic-cli-bearer',
        SYNTHETIC_CLI_EXPIRY: new Date(Date.now() + 3600000).toISOString(),
        SYNTHETIC_AWS_TOKEN: jwt(c.token ?? {}, Date.now()),
        SYNTHETIC_AWS_FAILURE: c.sdkFailure ? '1' : '',
        SYNTHETIC_AWS_AVAILABLE: c.source === 'aws' && !c.missing ? '1' : '0',
        AWS_REGION: 'us-east-2',
        AWS_ACCESS_KEY_ID: 'synthetic-aws-key',
        AWS_SECRET_ACCESS_KEY: 'synthetic-aws-secret',
      });
      Object.assign(process.env, c.platformEnvironment ?? {});
      if (c.source === 'aws' || c.identity)
        process.env.EXAMPLE_WORKLOAD_IDENTITY_ID = 'wid_aws_' + scenarios.indexOf(c);
      if (c.source === 'cli') {
        process.env.EXAMPLE_CLI_CREDENTIALS = c.disabled ? '0' : '1';
        process.env.PATH = c.missing ? emptyBin : bin + ':' + original.PATH;
      }
      let exchanges = 0,
        apiCalls = 0,
        result = 'ok';
      const options = {
        transport: async (url, init) => {
          if (String(url).endsWith('/v1/oauth/token')) {
            exchanges++;
            assert.equal(
              new URLSearchParams(init.body).get('subject_token'),
              process.env.SYNTHETIC_AWS_TOKEN,
            );
            return Response.json({
              access_token: 'synthetic-aws-access',
              token_type: 'Bearer',
              issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
              expires_in: 3600,
            });
          }
          apiCalls++;
          return new Response(null, { status: c.cliAPI401 && apiCalls === 1 ? 401 : 204 });
        },
        ...(c.explicit
          ? {
              apiKey: sdk.workloadIdentityCredentials({
                workloadIdentityId: process.env.EXAMPLE_WORKLOAD_IDENTITY_ID,
                source: 'aws',
              }),
            }
          : {}),
        ...(c.ambientDisabled ? { ambientCredentials: false } : {}),
      };
      try {
        const client = new sdk.Client(options);
        if (c.noExpiry) {
          await client.api.read();
          await client.api.read();
        } else await Promise.all(Array.from({ length: 100 }, () => client.api.read()));
      } catch (e) {
        result = e.workloadIdentity?.reason ?? e.code;
        assert.ok(!e.message.includes(process.env.SYNTHETIC_AWS_TOKEN));
        assert.ok(!e.message.includes(process.env.SYNTHETIC_CLI_TOKEN));
        if (c.error === 'API_KEY_NOT_EXPORTABLE') assert.match(e.message, /API_KEY_NOT_EXPORTABLE/);
        if (c.missing && c.source === 'aws') assert.match(e.message, /@aws-sdk\/client-sts/);
      }
      assert.equal(result, c.expect, c.name);
      const expectedCalls =
        c.exports ??
        (c.missing || c.noSource || c.disabled || c.ambientDisabled || c.identity
          ? 0
          : c.noExpiry
            ? 2
            : 1);
      assert.equal(
        readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).length,
        expectedCalls,
        c.name,
      );
      assert.equal(exchanges, c.source === 'aws' && c.expect === 'ok' ? 1 : 0, c.name);
      writeFileSync(log, '');
      const child = spawn(php, ['tests/helpers/workload-aws-cli.php', join(output, 'php')], {
        env: process.env,
      });
      let stdout = '',
        stderr = '';
      child.stdout.on('data', (chunk) => (stdout += chunk));
      child.stderr.on('data', (chunk) => (stderr += chunk));
      const status = await new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('close', resolve);
      });
      assert.equal(status, 0, stderr);
      assert.deepEqual(
        JSON.parse(stdout),
        { result: c.expect, exchanges: c.source === 'aws' && c.expect === 'ok' ? 1 : 0 },
        c.name,
      );
      assert.equal(
        readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).length,
        expectedCalls,
        c.name + ' PHP',
      );
      process.env.PATH = original.PATH;
    }
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    clearEnv();
  }
});

test('platform AWS default chains select credentials and protect ECS, IMDSv2 and STS requests', async () => {
  const { createServer } = await import('node:http');
  const { spawn } = await import('node:child_process');
  const live = join(root, 'aws-platform');
  generate(loadContract(join(root, 'api.json'), join(root, 'sdk.json')), live);
  let installed = spawnSync(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--no-package-lock',
      '@aws-sdk/client-sts@3.1161.0',
    ],
    { cwd: join(live, 'node'), encoding: 'utf8' },
  );
  assert.equal(installed.status, 0, installed.stderr);
  installed = spawnSync(
    'composer',
    ['require', 'aws/aws-sdk-php:^3.402.5', '--no-interaction', '--no-progress', '--no-scripts'],
    { cwd: join(live, 'php'), encoding: 'utf8' },
  );
  assert.equal(installed.status, 0, installed.stderr);
  let mode, baseUrl, metadata, sts, stolen, assumed;
  const tokenFile = join(root, 'pod-authorization.txt');
  writeFileSync(tokenFile, 'synthetic-pod-auth');
  const sharedConfig = join(root, 'aws-config');
  const sharedCredentials = join(root, 'aws-credentials');
  const server = createServer(async (req, res) => {
    if (req.url === '/credentials') {
      metadata++;
      assert.equal(
        req.headers.authorization,
        mode.startsWith('pod') ? 'synthetic-pod-auth' : 'synthetic-container-auth',
      );
      if (mode === 'relative-precedence')
        assert.equal(req.headers['x-synthetic-original-host'], '169.254.170.2');
      if (mode === 'pod-ipv6')
        assert.equal(req.headers['x-synthetic-original-host'], '[fd00:ec2::23]');
      if (mode === '307' || mode === '308') {
        res.writeHead(Number(mode), { location: baseUrl + '/stolen' });
        res.end();
        return;
      }
      res.end(
        JSON.stringify({
          AccessKeyId: 'synthetic-role-key',
          SecretAccessKey: 'synthetic-role-secret',
          Token: 'synthetic-role-session',
          Expiration: new Date(Date.now() + 3600000).toISOString(),
        }),
      );
    } else if (req.url.startsWith('/latest/')) {
      metadata++;
      if (req.url === '/latest/api/token') {
        assert.equal(req.method, 'PUT');
        res.end('synthetic-imds-session');
      } else {
        assert.equal(req.headers['x-aws-ec2-metadata-token'], 'synthetic-imds-session');
        if (mode === 'imds-redirect') {
          res.writeHead(308, { location: baseUrl + '/stolen' });
          res.end();
          return;
        }
        res.end(
          req.url.endsWith('/')
            ? 'synthetic-role'
            : JSON.stringify({
                AccessKeyId: 'synthetic-role-key',
                SecretAccessKey: 'synthetic-role-secret',
                Token: 'synthetic-role-session',
                Code: 'Success',
                Expiration: new Date(Date.now() + 3600000).toISOString(),
              }),
        );
      }
    } else if (req.url === '/sts' || req.url === '/sts/') {
      sts++;
      let body = '';
      for await (const chunk of req) body += chunk;
      const form = new URLSearchParams(body);
      if (form.get('Action') === 'AssumeRole') {
        assumed++;
        assert.match(req.headers.authorization, /Credential=synthetic-profile-key\//);
        res.setHeader('content-type', 'text/xml');
        res.end(
          `<AssumeRoleResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><AssumeRoleResult><Credentials><AccessKeyId>synthetic-assumed-key</AccessKeyId><SecretAccessKey>synthetic-assumed-secret</SecretAccessKey><SessionToken>synthetic-assumed-session</SessionToken><Expiration>${new Date(Date.now() + 3600000).toISOString()}</Expiration></Credentials><AssumedRoleUser><AssumedRoleId>synthetic:session</AssumedRoleId><Arn>arn:aws:sts::000000000000:assumed-role/synthetic/session</Arn></AssumedRoleUser></AssumeRoleResult></AssumeRoleResponse>`,
        );
        return;
      }
      assert.equal(form.get('Action'), 'GetWebIdentityToken');
      const signingKey =
        mode === 'profile'
          ? 'synthetic-profile-key'
          : mode === 'assume-role'
            ? 'synthetic-assumed-key'
            : 'synthetic-role-key';
      assert.ok(
        req.headers.authorization.includes('Credential=' + signingKey + '/'),
        req.headers.authorization,
      );
      assert.equal(form.get('Audience.member.1'), baseUrl);
      assert.equal(form.get('SigningAlgorithm'), 'ES384');
      assert.match(req.headers.authorization, /AWS4-HMAC-SHA256/);
      if (mode === 'sts-redirect') {
        res.writeHead(307, { location: baseUrl + '/stolen' });
        res.end();
        return;
      }
      res.setHeader('content-type', 'text/xml');
      res.end(
        `<GetWebIdentityTokenResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><GetWebIdentityTokenResult><WebIdentityToken>${jwt({ aud: baseUrl }, Date.now())}</WebIdentityToken></GetWebIdentityTokenResult></GetWebIdentityTokenResponse>`,
      );
    } else if (req.url === '/stolen') {
      stolen++;
      res.end('{}');
    } else if (req.url === '/v1/oauth/token')
      res.end(
        JSON.stringify({
          access_token: 'synthetic-cloud-access',
          token_type: 'Bearer',
          issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
          expires_in: 3600,
        }),
      );
    else {
      res.writeHead(204);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = 'http://127.0.0.1:' + server.address().port;
  // Inject loopback routing below the AWS providers for reserved link-local hosts.
  // Their endpoint validation, variable precedence and token-file handling stay real.
  const routing = join(root, 'aws-routing.cjs');
  writeFileSync(
    routing,
    `const http = require('node:http');
const request = http.request;
http.request = function(options, ...rest) {
  const host = options?.hostname ?? options?.host;
  if (['169.254.170.2', '[fd00:ec2::23]', 'fd00:ec2::23'].includes(host)) {
    options = {...options, host:'127.0.0.1', hostname:'127.0.0.1', port:process.env.SYNTHETIC_METADATA_PORT, headers:{...options.headers,'x-synthetic-original-host':host.includes('fd00')?'[fd00:ec2::23]':host}};
  }
  return request.call(this, options, ...rest);
};`,
  );
  const awsFunctions = join(live, 'php/vendor/aws/aws-sdk-php/src/functions.php');
  const originalHandler =
    'return new \\Aws\\Handler\\Guzzle\\GuzzleHandler(null, $transportSharing);';
  const functions = readFileSync(awsFunctions, 'utf8');
  assert.ok(functions.includes(originalHandler));
  writeFileSync(
    awsFunctions,
    functions.replace(
      originalHandler,
      `$handler = new \\Aws\\Handler\\Guzzle\\GuzzleHandler(null, $transportSharing);
    return static function ($request, $options) use ($handler) {
        $host = $request->getUri()->getHost();
        if (in_array($host, ['169.254.170.2', '[fd00:ec2::23]', 'fd00:ec2::23'], true)) {
            $request = $request->withHeader('x-synthetic-original-host', str_contains($host, 'fd00') ? '[fd00:ec2::23]' : $host)
                ->withUri($request->getUri()->withHost('127.0.0.1')->withPort((int) getenv('SYNTHETIC_METADATA_PORT')));
        }
        return $handler($request, $options);
    };`,
    ),
  );
  const php = join(root, 'aws-platform.php');
  writeFileSync(
    php,
    `<?php
require $argv[1] . '/vendor/autoload.php';
try { $client = new Example\\Discovery\\Client(new Example\\Discovery\\ClientOptions(baseUrl: $argv[2], allowInsecureHttp: true, apiKey: Example\\Discovery\\workloadIdentityCredentials(['workloadIdentityId' => 'wid_platform', 'source' => 'aws']))); $client->api->read(); echo 'ok'; } catch (Example\\Discovery\\SdkError $e) { echo $e->workloadIdentity['reason'] ?? $e->code; }
`,
  );
  try {
    for (const language of ['node', 'php'])
      for (const scenario of JSON.parse(
        readFileSync('tests/fixtures/default-credentials-aws-http.json', 'utf8'),
      )) {
        mode = scenario.name;
        metadata = sts = stolen = assumed = 0;
        writeFileSync(
          sharedConfig,
          scenario.profileWebIdentity
            ? '[profile selected]\nrole_arn=arn:aws:iam::000000000000:role/synthetic\nweb_identity_token_file=/synthetic/foreign-must-not-open\n'
            : '',
        );
        writeFileSync(
          sharedCredentials,
          scenario.profile
            ? '[selected]\naws_access_key_id=synthetic-profile-key\naws_secret_access_key=synthetic-profile-secret\n' +
                (scenario.assumeRole
                  ? '[assumed]\nrole_arn=arn:aws:iam::000000000000:role/synthetic\nsource_profile=selected\nregion=us-east-2\n'
                  : '')
            : '',
        );
        clearEnv();
        const env = {
          ...process.env,
          AWS_REGION: 'us-east-2',
          AWS_ENDPOINT_URL_STS: baseUrl.replace('127.0.0.1', 'localhost') + '/sts',
          AWS_CONTAINER_CREDENTIALS_FULL_URI:
            baseUrl.replace('127.0.0.1', 'localhost') + '/credentials',
          AWS_CONTAINER_AUTHORIZATION_TOKEN: 'synthetic-container-auth',
          AWS_EC2_METADATA_SERVICE_ENDPOINT: baseUrl.replace('127.0.0.1', 'localhost'),
          AWS_CONFIG_FILE: sharedConfig,
          AWS_SHARED_CREDENTIALS_FILE: sharedCredentials,
          SYNTHETIC_METADATA_PORT: String(server.address().port),
          AZURE_FEDERATED_TOKEN_FILE: '/synthetic/foreign-must-not-open',
          AWS_ROLE_ARN: 'arn:aws:iam::000000000000:role/synthetic',
          HTTP_PROXY: 'http://127.0.0.1:1',
          http_proxy: 'http://127.0.0.1:1',
          NO_PROXY: '127.0.0.1',
          no_proxy: '127.0.0.1',
          HTTPS_PROXY: 'http://127.0.0.1:1',
          https_proxy: 'http://127.0.0.1:1',
        };
        for (const key of [
          'AWS_ACCESS_KEY_ID',
          'AWS_SECRET_ACCESS_KEY',
          'AWS_SESSION_TOKEN',
          'AWS_EXECUTION_ENV',
          'AWS_LAMBDA_FUNCTION_NAME',
          'ECS_CONTAINER_METADATA_URI',
          'ECS_CONTAINER_METADATA_URI_V4',
          'AWS_EC2_METADATA_DISABLED',
          'AWS_PROFILE',
          'AWS_DEFAULT_PROFILE',
          'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
          'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
          'NODE_USE_ENV_PROXY',
          'NODE_OPTIONS',
        ])
          delete env[key];
        if (mode.startsWith('imds') || scenario.profile)
          delete env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
        if (scenario.profile) env.AWS_PROFILE = scenario.assumeRole ? 'assumed' : 'selected';
        if (scenario.profileWebIdentity) env.AWS_PROFILE = 'selected';
        if (scenario.inboundFile)
          env.AWS_WEB_IDENTITY_TOKEN_FILE = '/synthetic/foreign-must-not-open';
        if (mode.startsWith('pod')) env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE = tokenFile;
        if (mode === 'pod-ipv6')
          env.AWS_CONTAINER_CREDENTIALS_FULL_URI = 'http://[fd00:ec2::23]/credentials';
        if (mode === 'relative-precedence') {
          env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI = '/credentials';
          env.AWS_CONTAINER_CREDENTIALS_FULL_URI = baseUrl + '/wrong-full-uri';
        }
        // PHP's internal profile STS client does not inherit the protected handler.
        if (language === 'php' && scenario.assumeRole)
          env.NO_PROXY = env.no_proxy = '127.0.0.1,localhost';
        if (scenario.envProxy) env.NODE_USE_ENV_PROXY = '1';
        if (scenario.nodeOptionsProxy) env.NODE_OPTIONS = '--use-env-proxy';
        if (scenario.nodeOnly && language !== 'node') continue;
        if (scenario.proxyFlag && !process.allowedNodeEnvironmentFlags.has('--use-env-proxy'))
          continue;
        const code = `const {Client,workloadIdentityCredentials}=await import(${JSON.stringify(pathToFileURL(join(live, 'node/index.js')).href)});try {await new Client({baseUrl:${JSON.stringify(baseUrl)},allowInsecureHttp:true,apiKey:workloadIdentityCredentials({workloadIdentityId:'wid_platform',source:'aws'})}).api.read();process.stdout.write('ok');}catch(e){process.stdout.write(e.workloadIdentity?.reason??e.code);}`;
        const child = spawn(
          language === 'php' ? 'php' : process.execPath,
          language === 'php'
            ? [php, join(live, 'php'), baseUrl]
            : [
                '--require',
                routing,
                ...(scenario.proxyFlag ? ['--use-env-proxy'] : []),
                '--input-type=module',
                '-e',
                code,
              ],
          { env },
        );
        let stdout = '',
          stderr = '';
        child.stdout.on('data', (chunk) => (stdout += chunk));
        child.stderr.on('data', (chunk) => (stderr += chunk));
        const status = await new Promise((resolve, reject) => {
          child.on('error', reject);
          child.on('close', resolve);
        });
        assert.equal(status, 0, stderr);
        assert.equal(
          stdout,
          scenario.expected,
          language + mode + stderr + JSON.stringify({ metadata, sts, stolen }),
        );
        // Node tries its legacy ECS provider after a failed HTTP provider.
        assert.equal(
          metadata,
          language === 'node'
            ? (scenario.nodeMetadataRequests ?? scenario.metadataRequests)
            : scenario.metadataRequests,
          language + mode,
        );
        assert.equal(sts, scenario.stsRequests);
        assert.equal(assumed, scenario.assumeRole ? 1 : 0);
        assert.equal(stolen, 0);
      }
  } finally {
    clearEnv();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
