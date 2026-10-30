import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generate, loadContract } from '../dist/index.js';
import { packageDocuments } from './helpers/package-docs.mjs';

const root = mkdtempSync(join(tmpdir(), 'sdk-docs-text-'));
after(() => rmSync(root, { recursive: true, force: true }));

const jwt = {
  header: 'authorization',
  scheme: 'Bearer',
  algorithm: 'ES256',
  typ: 'fixture-webhook+jwt',
  issuer: 'baseUrl',
  jwksPath: '/.well-known/jwks.json',
  bodyHashClaim: 'body_sha256',
  bodyHashEncoding: 'base64url',
  lifetimeSeconds: 300,
  leewaySeconds: 60,
};
const hmac = {
  algorithm: 'hmac-sha256',
  header: 'X-Signature',
  timestampHeader: 'X-Timestamp',
  separator: '.',
  toleranceSeconds: 300,
};
const events = {
  'widget.updated': {
    type: 'object',
    properties: { type: { type: 'string', const: 'widget.updated' }, id: { type: 'string' } },
    required: ['type', 'id'],
  },
};
const idempotency = { header: 'Idempotency-Key', retention: '24 hours', scope: 'account' };
const widgetBody = {
  required: true,
  content: {
    'application/json': {
      schema: { type: 'object', properties: { name: { type: 'string' } } },
    },
  },
};
const api = {
  openapi: '3.1.0',
  info: { title: 'Widget fixture', version: '1' },
  servers: [{ url: 'https://api.fixture.test' }],
  paths: {
    '/v1/widgets': {
      get: {
        operationId: 'listWidgets',
        tags: ['widgets'],
        description:
          'List widgets. Create one with POST /v1/widgets, or `PATCH /v1/widgets/{widget_id}` to edit. GET /v1/unknown stays as written.',
        responses: { 200: { description: 'Done' } },
      },
      post: {
        operationId: 'createWidget',
        tags: ['widgets'],
        description: 'Create a widget.',
        requestBody: widgetBody,
        responses: { 201: { description: 'Done' } },
      },
    },
    '/v1/widgets/{widget_id}': {
      patch: {
        operationId: 'updateWidget',
        tags: ['widgets'],
        parameters: [{ in: 'path', name: 'widget_id', required: true, schema: { type: 'string' } }],
        requestBody: widgetBody,
        responses: { 200: { description: 'Done' } },
      },
    },
  },
};
const base = {
  version: '1.0.0',
  responses: { return: 'result' },
  npm: { name: '@example/widgets' },
  composer: { name: 'example/widgets', namespace: 'Example\\Widgets' },
  operations: {
    listWidgets: { resource: 'widgets', method: 'list' },
    createWidget: {
      resource: 'widgets',
      method: 'create',
      retry: { maxAttempts: 4, statuses: [503], transport: true, baseDelayMs: 10 },
      idempotency: { ...idempotency, auto: true, autoKeyPrefix: 'fx_' },
    },
    updateWidget: {
      resource: 'widgets',
      method: 'update',
      example: { widget_id: 'widget_fixture', body: { name: 'Updated widget' } },
    },
  },
};
const apiFile = join(root, 'api.json');
writeFileSync(apiFile, JSON.stringify(api));
let count = 0;
function build(config) {
  const profile = join(root, `profile-${++count}.json`);
  writeFileSync(profile, JSON.stringify({ ...base, ...config }));
  const out = join(root, `out-${count}`);
  generate(loadContract(apiFile, profile), out);
  return out;
}
const read = (out, ...path) => readFileSync(join(out, ...path), 'utf8');
const section = (text, heading) => {
  const start = text.indexOf(heading);
  assert.notEqual(start, -1, `missing ${heading}`);
  const rest = text.slice(start + heading.length);
  return rest.slice(0, rest.search(/\n##? /) === -1 ? undefined : rest.search(/\n##? /));
};

test('webhook framework snippets call the async verifier when a JWT is configured', () => {
  const out = build({ webhook: { ...hmac, jwt, typeField: 'type', events } });
  for (const target of ['node', 'php']) {
    const runtime = read(out, target, 'RUNTIME.md');
    const verifier = target === 'node' ? 'verifyWebhookAsync' : 'verifyWebhookDelivery';
    const headings = target === 'node' ? ['### Fetch', '### Express'] : ['### PSR-7'];
    for (const heading of headings) assert.match(section(runtime, heading), new RegExp(verifier));
    if (target === 'php')
      assert.match(runtime, /For a native PHP handler[^`]*```php[^`]*verifyWebhookDelivery/);
    assert.doesNotMatch(runtime, /client\.verifyWebhook\(|->verifyWebhook\(/);
    assert.doesNotMatch(runtime, /whep_example|api\.example\.com/);
    assert.match(runtime, /whep_[0-9A-HJKMNP-TV-Z]{26}/);
    assert.match(
      runtime,
      /baseUrl: 'https:\/\/api\.fixture\.test'|'base_url' => 'https:\/\/api\.fixture\.test'/,
    );
    assert.match(
      section(runtime, '### HMAC verification and secret rotation'),
      /Endpoints whose `signing_methods` include `hmac` also send `X-Signature`, `X-Timestamp`\. Pass `secrets`/,
    );
    assert.doesNotMatch(runtime, /### Rotation and narrowing/);
  }
  assert.match(
    read(out, 'node', 'RUNTIME.md'),
    /await client\.verifyWebhookAsync\(rawBody, headers, \{ endpointIds, secrets: \[currentSecret, previousSecret\] \}\)/,
  );
});

test('HMAC-only webhook guides keep the synchronous verifier', () => {
  const out = build({ webhook: { ...hmac, typeField: 'type', events } });
  const runtime = read(out, 'node', 'RUNTIME.md');
  assert.match(section(runtime, '### Fetch'), /client\.verifyWebhook\(rawBody/);
  assert.match(runtime, /### Rotation and narrowing/);
  assert.doesNotMatch(runtime, /HMAC verification and secret rotation/);
});

test('the retry paragraph is derived from the compiled policies', () => {
  const out = build({});
  for (const target of ['node', 'php']) {
    const text = section(read(out, target, 'RUNTIME.md'), '## Retries and idempotency');
    assert.match(
      text,
      /^\n\nReads \(GET, HEAD and OPTIONS\) allow up to 3 total attempts for transport failures and HTTP 408, 429, 500, 502, 503 and 504\. 1 write operation creates `Idempotency-Key` automatically when you supply none, beginning with .*fx_.* and allows up to 4 total attempts for transport failures and HTTP 503\. 1 write operation declares no idempotency key and always sends once\. maxAttempts caps total attempts including the first\. HTTP 412 never retries\./,
    );
    assert.doesNotMatch(text, /Mutations with optional idempotency keys/);
  }
  // Changing the configuration changes the sentence.
  const changed = build({
    operations: {
      ...base.operations,
      createWidget: { resource: 'widgets', method: 'create', idempotency },
    },
  });
  const text = section(read(changed, 'node', 'RUNTIME.md'), '## Retries and idempotency');
  assert.match(
    text,
    /1 write operation accepts `idempotencyKey` and sends once until you supply a key; with a key, it allows one attempt\./,
  );
  assert.doesNotMatch(text, /automatically|fx_/);
});

test('generated package docs name the API, name retention classes and avoid dashes', () => {
  const dash = /[–—]/;
  for (const apiName of [undefined, 'Widgets']) {
    const out = build({
      webhook: { ...hmac, jwt, typeField: 'type', events },
      ...(apiName ? { documentation: { apiName } } : {}),
    });
    const documents = packageDocuments(out);
    assert.ok(documents.length >= 8);
    for (const path of documents) {
      const text = readFileSync(path, 'utf8');
      // Credential providers and the public SDK code keep their names.
      // Other prose must name the API instead of calling it a provider.
      const prose = text
        .replace(/credential ?providers?/gi, '')
        .replace(/\bcredential_provider_failed\b/g, '');
      assert.doesNotMatch(prose, /provider/i, path);
      assert.doesNotMatch(text, /policy [0-9]/i, path);
      assert.doesNotMatch(text, dash, path);
    }
    const runtime = read(out, 'node', 'RUNTIME.md');
    assert.match(runtime, new RegExp(`supplied by ${apiName ?? 'the API'}\\.`));
    assert.match(runtime, new RegExp(`so ${apiName ?? 'the API'} retries`));
    assert.match(runtime, new RegExp(`Reconcile the action with ${apiName ?? 'the API'} using`));
    assert.match(
      read(out, 'node', 'REFERENCE.md') + read(out, 'node', 'reference', 'widgets.md'),
      /Idempotent: key automatic, \[24 hours retention\]\((?:\.\.\/)?RUNTIME\.md#idempotency\)/,
    );
    assert.match(
      runtime,
      /\| Retention class \| Header \| Retention \| Scope \|\n\| --- \| --- \| --- \| --- \|\n\| 24 hours retention \|/,
    );
  }
});

test('configuration rejects an empty API name and unknown placeholders', () => {
  for (const documentation of [
    { apiName: ' ' },
    { operationUrl: 'https://docs.example.test/{unknown}' },
    { operationUrl: 'http://docs.example.test/{operationId}' },
    { operationUrl: 'https://docs.example.test/{tagSlug}' },
  ])
    assert.throws(() => build({ documentation }), /documentation/);
});

const documentation = {
  operationUrl: 'https://docs.example.test/api/{tagSlug}#{operationId}',
  tagSlugs: { widgets: 'widget-objects' },
};

test('method docs put the route in the summary and link an absolute documentation URL', () => {
  const out = build({ documentation });
  const declarations = read(out, 'node', 'resources', 'widgets.d.ts');
  const docFor = (method) => {
    const index = declarations.indexOf(`    ${method}(`);
    const start = declarations.lastIndexOf('/**', index);
    return declarations.slice(start, index);
  };
  const list = docFor('list');
  const summary = list.split('@see')[0].replace(/\n\s*\*\s?/g, ' ');
  assert.match(summary, /`GET \/v1\/widgets`/);
  assert.match(list, /@see https:\/\/docs\.example\.test\/api\/widget-objects#listWidgets\n/);
  assert.equal(list.match(/@throws \{SdkError\}/g).length, 1);
  assert.doesNotMatch(list, /@see reference\//);
  // Exact mentions of included operations become SDK methods; other text is unchanged.
  assert.match(
    summary,
    /Create one with `client\.widgets\.create`, or `client\.widgets\.update` to edit\./,
  );
  assert.match(summary, /GET \/v1\/unknown stays as written\./);
  assert.match(
    docFor('update'),
    /@see https:\/\/docs\.example\.test\/api\/widget-objects#updateWidget\n/,
  );
  // Base method docs retain the link after response companions are removed.
  assert.match(
    docFor('create'),
    /@see https:\/\/docs\.example\.test\/api\/widget-objects#createWidget\n/,
  );
  assert.doesNotMatch(declarations, /\b(?:create|list|update)WithResponse\(/);
});

test('without a URL template, @see keeps the package reference', () => {
  const declarations = read(build({}), 'node', 'resources', 'widgets.d.ts');
  assert.match(declarations, /@see reference\/widgets\.md#widgetslist/);
});

test('an operation whose tag has no documentation slug fails the load', () => {
  assert.throws(
    () => build({ documentation: { ...documentation, tagSlugs: { other: 'other' } } }),
    /tag "widgets" has no entry in config\/documentation\/tagSlugs/,
  );
  const untagged = join(root, 'untagged.json');
  const spec = structuredClone(api);
  delete spec.paths['/v1/widgets'].get.tags;
  writeFileSync(untagged, JSON.stringify(spec));
  const profile = join(root, 'profile-untagged.json');
  writeFileSync(profile, JSON.stringify({ ...base, documentation }));
  assert.throws(() => loadContract(untagged, profile), /operation listWidgets has no tag/);
});
