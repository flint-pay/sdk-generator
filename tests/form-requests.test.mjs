import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadContract, generate, validateFixtures } from '../dist/index.js';
import { tokenApi, tokenSdk } from './helpers/form-token-api.mjs';

const dir = mkdtempSync(join(tmpdir(), 'sdk-form-'));
after(() => rmSync(dir, { recursive: true, force: true }));
function load(edit = () => {}, sdk = tokenSdk, name = 'api') {
  const api = tokenApi();
  edit(api);
  const apiFile = join(dir, name + '.json');
  const sdkFile = join(dir, name + '-sdk.json');
  writeFileSync(apiFile, JSON.stringify(api));
  writeFileSync(sdkFile, JSON.stringify(sdk));
  return loadContract(apiFile, sdkFile);
}
const output = join(dir, 'out');
before(() => generate(load(), output));

// Expected bodies are written by hand from the application/x-www-form-urlencoded
// rules shared with query parameters: fields in input order, RFC 3986 unreserved
// characters (A-Z a-z 0-9 - . _ ~) kept, every other UTF-8 byte percent-encoded,
// spaces as %20, booleans as true/false and numbers as their JSON text.
const form = { 'content-type': 'application/x-www-form-urlencoded' };
const issued = {
  access_token: 'synthetic-access',
  token_type: 'Bearer',
  expires_in: 3600,
  refresh_token: 'synthetic-refresh',
  scope: 'orders:read',
};
const grants = {
  authorization_code: {
    grant_type: 'authorization_code',
    code: 'code+/=synthetic',
    redirect_uri: 'https://app.example.invalid/callback?install=1&step=two',
    code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    client_id: 'client_synthetic',
    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    client_assertion: 'header.payload.signature',
  },
  refresh_token: {
    grant_type: 'refresh_token',
    refresh_token: 'rt synthetic~*',
    client_id: 'client_synthetic',
    client_secret: "placeholder!'()",
  },
  device_code: {
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    device_code: 'device_synthetic',
    client_id: 'cli',
  },
  token_exchange: {
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    subject_token: 'eyJ.synthetic.jwt',
    subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
    workload_identity_id: 'wid_synthetic',
    scope: 'orders:read refunds:write',
  },
};
const wire = {
  authorization_code:
    'grant_type=authorization_code&code=code%2B%2F%3Dsynthetic' +
    '&redirect_uri=https%3A%2F%2Fapp.example.invalid%2Fcallback%3Finstall%3D1%26step%3Dtwo' +
    '&code_verifier=dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk&client_id=client_synthetic' +
    '&client_assertion_type=urn%3Aietf%3Aparams%3Aoauth%3Aclient-assertion-type%3Ajwt-bearer' +
    '&client_assertion=header.payload.signature',
  refresh_token:
    'grant_type=refresh_token&refresh_token=rt%20synthetic~%2A&client_id=client_synthetic' +
    '&client_secret=placeholder%21%27%28%29',
  device_code:
    'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code' +
    '&device_code=device_synthetic&client_id=cli',
  token_exchange:
    'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange' +
    '&subject_token=eyJ.synthetic.jwt&subject_token_type=urn%3Aietf%3Aparams%3Aoauth%3Atoken-type%3Ajwt' +
    '&workload_identity_id=wid_synthetic&scope=orders%3Aread%20refunds%3Awrite',
};

test('form-only bodies select form encoding while declared JSON stays the implicit choice', () => {
  const media = Object.fromEntries(load().operations.map((op) => [op.id, op.mediaType]));
  assert.deepEqual(media, {
    createNote: 'application/json',
    createSession: 'application/x-www-form-urlencoded',
    exchangeToken: 'application/x-www-form-urlencoded',
  });
  const patch = load((api) => {
    const content = api.paths['/v1/notes'].post.requestBody.content;
    content['application/merge-patch+json'] = content['application/json'];
    delete content['application/json'];
  });
  assert.equal(
    patch.operations.find((op) => op.id === 'createNote').mediaType,
    'application/merge-patch+json',
  );
  assert.throws(
    () =>
      load((api) => {
        api.paths['/v1/notes'].post.requestBody.content = {
          'multipart/form-data': { schema: { $ref: '#/components/schemas/Note' } },
        };
      }),
    /requestBody declares no supported media type; supported types are application\/json, application\/merge-patch\+json, application\/x-www-form-urlencoded/,
  );
});

test('form schemas outside flat non-null scalar objects are diagnosed', () => {
  const session = (api) => api.components.schemas.SessionRequest;
  const media = (path) =>
    `/paths/${path.replaceAll('/', '~1')}/post/requestBody/content/application~1x-www-form-urlencoded`;
  const sessions = media('/v1/sessions');
  const field =
    'form-encoded request fields require a non-null boolean, string, integer or number schema';
  const object = 'form-encoded request bodies require a non-null object schema';
  for (const [edit, location, message] of [
    [(api) => (session(api).properties.meta = { type: 'object' }), '/schema/properties/meta'],
    [
      (api) => (session(api).properties.tags = { type: 'array', items: { type: 'string' } }),
      '/schema/properties/tags',
    ],
    [
      (api) => (session(api).properties.note = { type: ['string', 'null'] }),
      '/schema/properties/note',
    ],
    [(api) => (session(api).properties.any = {}), '/schema/properties/any'],
    [(api) => (session(api).properties.fixed = { const: { a: 1 } }), '/schema/properties/fixed'],
    [
      (api) =>
        (api.components.schemas.TokenRequestDeviceCode.properties.extra = { type: 'object' }),
      media('/v1/oauth/token') + '/schema/oneOf/2/properties/extra',
    ],
    [
      (api) => (session(api).additionalProperties = { type: 'object' }),
      '/schema/additionalProperties',
      'form-encoded additional properties require a non-null scalar schema',
    ],
    [
      (api) =>
        (api.components.schemas.SessionRequest = { type: 'array', items: { type: 'string' } }),
      '/schema',
      object,
    ],
    [(api) => (session(api).type = ['object', 'null']), '/schema', object],
    [
      (api) =>
        (api.paths['/v1/sessions'].post.requestBody.content[
          'application/x-www-form-urlencoded'
        ].encoding = { label: { contentType: 'text/plain' } }),
      '/encoding',
      'form-encoded request encoding declarations are unsupported; fields use the default form style',
    ],
  ]) {
    const path = location.startsWith('/paths/') ? location : sessions + location;
    assert.throws(
      () => load(edit),
      (error) => {
        assert.ok(error.message.includes(message ?? field), error.message);
        // Nested findings name the exact field below the media schema.
        assert.ok(
          error.message.startsWith(path + ':') || error.message.includes(`correct ${path}.`),
          `${path}: ${error.message}`,
        );
        return true;
      },
    );
  }
  // Typeless declarations qualify when their const or enum values are scalars.
  assert.ok(
    load((api) => {
      session(api).properties.flag = { const: true };
      session(api).properties.level = { enum: [1, 2] };
    }),
  );
  // Selecting JSON keeps form-only constraints out of a JSON body.
  assert.ok(
    load((api) => (session(api).properties.meta = { type: 'object' }), {
      ...tokenSdk,
      operations: { createSession: { requestMediaType: 'application/json' } },
    }),
  );
});

test('four token grants send independently expected form bodies in Node and PHP', async () => {
  const cases = [
    ...Object.entries(grants).map(([name, body]) => ({
      name: `${name} grant`,
      operation: 'exchangeToken',
      input: { body },
      expected: { method: 'POST', path: '/v1/oauth/token', headers: form, body: wire[name] },
      responses: [
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(
            name === 'token_exchange' ? { ...issued, refresh_token: undefined } : issued,
          ),
        },
      ],
      data:
        name === 'token_exchange'
          ? Object.fromEntries(Object.entries(issued).filter(([key]) => key !== 'refresh_token'))
          : issued,
    })),
    {
      name: 'typed scalars and UTF-8 text',
      operation: 'createSession',
      input: {
        body: { label: 'café ☕', remember: true, ttl_seconds: 900, weight: 1.5, tier: 'plus' },
      },
      expected: {
        method: 'POST',
        path: '/v1/sessions',
        headers: form,
        body: 'label=caf%C3%A9%20%E2%98%95&remember=true&ttl_seconds=900&weight=1.5&tier=plus',
      },
      responses: [{ status: 204, body: '' }],
      empty: true,
    },
    {
      name: 'JSON control operation',
      operation: 'createNote',
      input: { body: { title: 'Plan', pinned: true } },
      expected: {
        method: 'POST',
        path: '/v1/notes',
        headers: { 'content-type': 'application/json' },
        body: '{"title":"Plan","pinned":true}',
      },
      responses: [{ status: 204, body: '' }],
      empty: true,
    },
    {
      name: 'rejected grant',
      operation: 'exchangeToken',
      input: { body: grants.device_code },
      expected: { method: 'POST', path: '/v1/oauth/token', headers: form, body: wire.device_code },
      responses: [
        {
          status: 400,
          headers: { 'content-type': 'application/json' },
          body: '{"error":"invalid_grant","error_description":"The grant is invalid."}',
        },
      ],
      error: { status: 400 },
      attempts: 1,
    },
    {
      name: 'authorization code without its verifier',
      operation: 'exchangeToken',
      input: { body: { ...grants.authorization_code, code_verifier: undefined } },
      responses: [],
      error: { name: 'InvalidInputError' },
      attempts: 0,
    },
    {
      name: 'refresh grant without its token',
      operation: 'exchangeToken',
      input: { body: { grant_type: 'refresh_token', client_id: 'client_synthetic' } },
      responses: [],
      error: { name: 'InvalidInputError' },
      attempts: 0,
    },
    {
      name: 'client assertion without its type',
      operation: 'exchangeToken',
      input: { body: { ...grants.authorization_code, client_assertion_type: undefined } },
      responses: [],
      error: { name: 'InvalidInputError' },
      attempts: 0,
    },
    {
      name: 'undeclared nested value in an open form object',
      operation: 'createSession',
      input: { body: { label: 'x', extra: { nested: true } } },
      responses: [],
      error: { name: 'InvalidInputError' },
      attempts: 0,
    },
  ].map((scenario) => ({
    ...scenario,
    baseUrl: 'https://api.example.invalid',
    input: { body: JSON.parse(JSON.stringify(scenario.input.body)) },
  }));
  const file = join(dir, 'cases.json');
  writeFileSync(file, JSON.stringify(cases));
  assert.deepEqual(await validateFixtures(output, file), [
    { target: 'node', scenarios: cases.length },
    { target: 'php', scenarios: cases.length },
  ]);
});

test('Node token params narrow by grant type and require each grant field', () => {
  const consumer = join(output, 'node/consumer.ts');
  writeFileSync(
    consumer,
    `import { Client } from './index.js';
import type { TokenResponse } from './index.js';
const client = new Client({ baseUrl: 'https://api.example.invalid' });
const responses: Promise<{ data: TokenResponse }>[] = [
  client.oauth.exchangeToken(${JSON.stringify(grants.authorization_code)}),
  client.oauth.exchangeToken(${JSON.stringify(grants.refresh_token)}),
  client.oauth.exchangeToken(${JSON.stringify(grants.device_code)}),
  client.oauth.exchangeToken(${JSON.stringify(grants.token_exchange)}),
];
void responses;
const read = (params: Parameters<typeof client.oauth.exchangeToken>[0]) => {
  if (params.grant_type === 'authorization_code') {
    const verifier: string = params.code_verifier;
    void verifier;
  }
};
void read;
// @ts-expect-error The authorization code grant requires code_verifier.
client.oauth.exchangeToken({ grant_type: 'authorization_code', code: 'c', redirect_uri: 'https://app.example.invalid' });
// @ts-expect-error The refresh grant requires refresh_token.
client.oauth.exchangeToken({ grant_type: 'refresh_token' });
// @ts-expect-error Token exchange requires its subject token type.
client.oauth.exchangeToken({ grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange', subject_token: 's', workload_identity_id: 'w' });
// @ts-expect-error Unknown grant types are rejected.
client.oauth.exchangeToken({ grant_type: 'password', username: 'u' });
client.sessions.create({ label: 'x', remember: false, ttl_seconds: 60, tier: 'basic' });
// @ts-expect-error Form fields keep their declared scalar types.
client.sessions.create({ label: 'x', remember: 'yes' });
`,
  );
  try {
    execFileSync(
      process.execPath,
      [
        resolve('node_modules/typescript/bin/tsc'),
        '--strict',
        '--noEmit',
        '--module',
        'NodeNext',
        '--target',
        'ES2022',
        '--typeRoots',
        resolve('node_modules/@types'),
        consumer,
      ],
      { stdio: 'pipe' },
    );
  } catch (error) {
    throw new Error(error.stdout?.toString() ?? error.message);
  } finally {
    rmSync(consumer);
  }
});

test('PHP params models construct each grant and send its form body', () => {
  const script = join(dir, 'grants.php');
  writeFileSync(
    script,
    `<?php
declare(strict_types=1);
namespace Example\\TokenForms;
require $argv[1] . '/src/Runtime.php';
require $argv[1] . '/src/Client.php';
$sent = [];
$client = new Client(new ClientOptions(
    baseUrl: 'https://api.example.invalid',
    transport: function (array $request) use (&$sent): array {
        $sent[] = [$request['headers']['content-type'], $request['body']];
        return ['status' => 200, 'headers' => ['content-type' => 'application/json'], 'body' => ${JSON.stringify(
          JSON.stringify(issued),
        )}];
    },
));
$grants = json_decode($argv[2], true, 512, JSON_THROW_ON_ERROR);
$tokens = [];
foreach ($grants as $values) {
    $params = new OauthExchangeTokenParams($values);
    $tokens[] = $client->oauth->exchangeToken($params)->data->getAccessToken();
}
$rejected = 0;
foreach ([['grant_type' => 'refresh_token'], ['grant_type' => 'password']] as $values) {
    try {
        $client->oauth->exchangeToken(new OauthExchangeTokenParams($values));
    } catch (Errors\\InvalidInputError) {
        $rejected++;
    }
}
echo json_encode(['sent' => $sent, 'tokens' => $tokens, 'rejected' => $rejected]);
`,
  );
  const result = JSON.parse(
    execFileSync('php', [script, join(output, 'php'), JSON.stringify(Object.values(grants))], {
      encoding: 'utf8',
    }),
  );
  assert.deepEqual(result, {
    sent: Object.values(wire).map((body) => ['application/x-www-form-urlencoded', body]),
    tokens: Object.values(grants).map(() => 'synthetic-access'),
    rejected: 2,
  });
});
