import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadContract, generate } from '../dist/index.js';
import {
  relocateDocument,
  modelDocuments,
  internDocumentationTables,
} from '../dist/package-documentation.js';
import { assertPackageLinks, packageDocuments } from './helpers/package-docs.mjs';
import { responseReference } from '../dist/sdk-documentation.js';
import {
  assertDocumentedModelExports,
  assertDocumentedPhpExports,
} from './helpers/docs-exports.mjs';

test('resource docs separate inputs from linked output fields, errors and shared behavior', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sdk-package-docs-'));
  try {
    const input = {
      type: 'object',
      required: ['mode'],
      properties: {
        mode: { type: 'string', enum: ['fast', 'safe'], description: 'Execution mode.' },
      },
    };
    const output = {
      type: 'object',
      required: ['id'],
      description: 'The created record.',
      properties: {
        id: { type: 'string', description: 'Record identifier.' },
        related: { $ref: '#/components/schemas/Related' },
        state: { type: 'string', enum: ['ready', 'waiting'], description: 'Current state.' },
        domain: { type: 'string', pattern: '^[A-Za-z](?:[A-Za-z0-9-]{0,3}[A-Za-z0-9])?$' },
      },
    };
    writeFileSync(
      join(directory, 'api.json'),
      JSON.stringify({
        openapi: '3.1.0',
        info: { title: 'Records', version: '1' },
        components: {
          schemas: {
            Entry: output,
            Related: {
              oneOf: [
                {
                  type: 'object',
                  properties: { state: { const: 'ready' }, id: { type: 'string' } },
                  required: ['state'],
                },
                {
                  type: 'object',
                  properties: { state: { const: 'waiting' }, reason: { type: 'string' } },
                  required: ['state'],
                },
              ],
            },
            Location: { type: 'object', properties: { city: { type: 'string' } } },
          },
        },
        paths: {
          '/location': {
            get: {
              operationId: 'getLocation',
              tags: ['records'],
              responses: {
                200: {
                  description: 'Location',
                  content: {
                    'application/json': { schema: { $ref: '#/components/schemas/Location' } },
                  },
                },
              },
            },
          },
          '/redirect': {
            get: {
              operationId: 'redirectRecord',
              tags: ['records'],
              responses: { 302: { description: 'Redirect' } },
            },
          },
          '/records': {
            post: {
              operationId: 'createRecord',
              tags: ['records'],
              requestBody: { required: true, content: { 'application/json': { schema: input } } },
              responses: {
                201: {
                  description: 'Created',
                  content: {
                    'application/json': { schema: { $ref: '#/components/schemas/Entry' } },
                  },
                },
                400: { description: 'Invalid input' },
                409: { description: 'Conflict' },
                429: { description: 'Slow down' },
              },
            },
          },
        },
      }),
    );
    writeFileSync(
      join(directory, 'sdk.json'),
      JSON.stringify({
        version: '1.0.0',
        requests: { style: 'object' },
        responses: { return: 'payload' },
        operations: { redirectRecord: { response: { return: 'result' } } },
        npm: { name: '@example/records' },
        composer: { name: 'example/records', namespace: 'Example\\Records' },
      }),
    );
    const destination = join(directory, 'out');
    generate(loadContract(join(directory, 'api.json'), join(directory, 'sdk.json')), destination);
    for (const target of ['node', 'php']) {
      const root = join(destination, target);
      assertPackageLinks(root);
      const index = readFileSync(join(root, 'REFERENCE.md'), 'utf8');
      assert.match(index, /\[create\]\(reference\/records.md#recordscreate\)/);
      assert.doesNotMatch(index, /Request fields|Attempt limit/);
      const operation = readFileSync(join(root, 'reference/records.md'), 'utf8');
      const [request, response] = operation.split('#### Response');
      assert.match(request, /Signature:/);
      assert.match(request, /Execution mode/);
      assert.match(request, /Values: `"fast"`, `"safe"`/);
      assert.doesNotMatch(operation, /\[location\]\(/);
      assert.match(response, /Returned payload: \[[^\]]+\]\(\.\.\/MODELS.md#[^)]+\)/);
      assert.doesNotMatch(response, /\| `id` \| Required \| string \| Record identifier/);
      assert.match(
        packageDocuments(root)
          .filter((path) => /MODELS\.md|\/models\//.test(path))
          .map((path) => readFileSync(path, 'utf8'))
          .join('\n'),
        /\| `id` \| Required \| string \| Record identifier/,
      );
      assert.doesNotMatch(response, /Execution mode/);
      assert.match(response, /400 \| InvalidRequestError/);
      assert.match(response, /409 \| ConflictError/);
      assert.match(response, /429 \| RateLimitError/);
      const runtime = readFileSync(join(root, 'RUNTIME.md'), 'utf8');
      assert.doesNotMatch(
        runtime,
        target === 'node' ? /PHP|cURL|RequestOptions instance/ : /Node|TypeScript|AbortSignal/,
      );
      assert.doesNotMatch(runtime, /payment|migration|Generation rejects/i);
      assert.match(runtime, /## Error reference/);
      for (const name of [
        'SdkError',
        'ConnectionError',
        'TimeoutError',
        'AuthenticationError',
        'InvalidRequestError',
        'PermissionError',
        'InvalidInputError',
        'PaginationLimitError',
        'WebhookVerificationError',
        'RateLimitError',
        'NotFoundError',
        'ConflictError',
        'ServerError',
        'ApiError',
        'UnexpectedResponseError',
        'CancelledError',
        'ConfigurationError',
      ])
        assert.ok(runtime.includes(name), name);
      for (const field of [
        'idempotencyKey',
        'retryAfterMs',
        'outcome',
        'details',
        'requestId',
        'transport',
        'diagnostics',
        'authMode',
        'credentials',
        'streamIdleTimeoutMs',
        'streamLifetimeMs',
      ])
        assert.ok(runtime.includes(field), field);
      const example = readFileSync(
        join(root, `examples/records-create.${target === 'node' ? 'mjs' : 'php'}`),
        'utf8',
      );
      assert.match(example, /FLINT_BASE_URL/);
      assert.match(example, /allowInsecureHttp:/);
      assert.ok(readFileSync(join(root, 'llms.txt'), 'utf8').includes('REFERENCE.md'));
      if (target === 'php') {
        assertDocumentedPhpExports(root);
        const modelFile = readdirSync(join(root, 'src/classes'))
          .filter((file) => file.endsWith('.php'))
          .map((file) => join(root, 'src/classes', file))
          .find((file) => readFileSync(file, 'utf8').includes('Current state. Value enum:'));
        assert.ok(modelFile);
        assert.match(
          readFileSync(modelFile, 'utf8'),
          /Current state\. Value enum: "ready", "waiting"\./,
        );
        const modelNames = new Set(
          readdirSync(join(root, 'src/classes')).map((path) => path.replace(/\.php$/, '')),
        );
        const models = readFileSync(join(root, 'MODELS.md'), 'utf8');
        for (const match of models.matchAll(/^## (\w+)$/gm))
          if (match[1] !== 'Index') assert.ok(modelNames.has(match[1]), match[1]);
      }
    }
    assertDocumentedModelExports(join(destination, 'node'));
    const declarations = packageDocuments(join(destination, 'node'));
    assert.ok(declarations.length > 4);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('large model references split deterministically and relocate links, keeping descriptions and variant labels', () => {
  const source =
    '# Models\n\n[API](REFERENCE.md)\n\n' +
    Array.from(
      { length: 80 },
      (_, index) =>
        `## Model${index}\n\n${'Declared model description. '.repeat(100)}\n\n[Other](MODELS.md#model0)\n\n`,
    ).join('');
  const first = modelDocuments(source);
  assert.deepEqual(modelDocuments(source), first);
  assert.equal(first.files.size, 81);
  assert.ok(first.files.get('MODELS.md').length < 10_000);
  assert.match(first.files.get('models/Model1.md'), /\[Other\]\(\.\.\/models\/Model0.md#model0\)/);
  assert.ok(first.files.get('models/Model1.md').includes('Declared model description.'));
});

test('link validation rejects missing files, missing anchors and paths outside a package', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdk-doc-links-'));
  try {
    for (const [link, reason] of [
      ['missing.md', /missing link/],
      ['README.md#absent', /missing anchor/],
      ['../outside.md', /escapes package/],
    ]) {
      writeFileSync(join(root, 'README.md'), `# Readme\n\n[Broken](${link})\n`);
      assert.throws(() => assertPackageLinks(root), reason);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('moving documentation changes links while preserving code literals and example values', () => {
  const original =
    '[Model](MODELS.md#entity) and `[literal](MODELS.md#entity)`\n\n```js\nconst value = "[literal](MODELS.md#entity)";\n```\n';
  const moved = relocateDocument(original, new Map([['entity', 'models/Entity.md#entity']]), true);
  assert.ok(moved.startsWith('[Model](../models/Entity.md#entity)'));
  assert.ok(moved.includes('`[literal](MODELS.md#entity)`'));
  assert.ok(moved.includes('const value = "[literal](MODELS.md#entity)";'));
  assert.equal(
    relocateDocument('[site guide](/docs/guide) and `[literal](/docs/guide)`', new Map(), true),
    'site guide and `[literal](/docs/guide)`',
  );
});

test('shared root definitions keep operation links direct and preserve each model condition', () => {
  const table =
    '| Field | Presence | Type | Description |\n| --- | --- | --- | --- |\n| `value` | Conditional | string | ' +
    'Synthetic field description. '.repeat(10) +
    ' |\n\n';
  const files = new Map([
    [
      'node/models/First.md',
      '## First\n\n' + table + '### First variant 1\n\n- Required: `value`.\n',
    ],
    [
      'node/models/Second.md',
      '## Second\n\n' + table + '### Second variant 1\n\n- Optional: `value`.\n',
    ],
    [
      'node/reference/records.md',
      '### records.get\n\nReturns [Second](../models/Second.md#second).\n',
    ],
  ]);
  internDocumentationTables(files, 'node');
  assert.match(files.get('node/models/Second.md'), /shared fields.*First.md#first/);
  assert.match(files.get('node/models/Second.md'), /Optional: `value`/);
  assert.match(
    files.get('node/reference/records.md'),
    /\[Second\]\(\.\.\/models\/First.md#first\).*\[declared conditions\]\(\.\.\/models\/Second.md#second\)/,
  );
});

test('response alternatives show top-level output fields and enum values without input-only fields', () => {
  const source = responseReference(
    {
      oneOf: [
        {
          type: 'object',
          required: ['state'],
          properties: {
            state: { const: 'ready', type: 'string' },
            secret: { type: 'string', writeOnly: true },
          },
        },
        {
          type: 'object',
          properties: { reason: { type: 'string', enum: ['waiting', 'blocked'] } },
        },
      ],
    },
    {},
    'values.get response',
  );
  assert.match(source, /Response variant 1/);
  assert.match(source, /\| `state` \| Required/);
  assert.match(source, /Response variant 2/);
  assert.match(source, /Values: `"waiting"`, `"blocked"`/);
  assert.doesNotMatch(source, /`secret`/);
});

test('inline body variants retain their descriptions while sharing identical field tables', async () => {
  const { bodyReference } = await import('../dist/sdk-documentation.js');
  const document = bodyReference(
    {
      resource: 'records',
      method: 'update',
      body: {
        type: 'object',
        properties: { type: { type: 'string' }, mode: { type: 'string', enum: ['fast', 'safe'] } },
        discriminator: { propertyName: 'type' },
        anyOf: [
          {
            properties: { type: { const: 'record' } },
            required: ['type', 'mode'],
            description: 'First declared alternative.',
          },
          {
            properties: { type: { const: 'record' } },
            required: ['type', 'mode'],
            description: 'Second declared alternative.',
          },
        ],
      },
    },
    {},
  );
  assert.equal(document.split('| Field | Presence | Type | Description |').length - 1, 2);
  assert.match(document, /Second declared alternative\./);
  assert.match(
    document,
    /Fields: \[records.update with `type: "record"`\]\(#recordsupdate-with-type-record\)/,
  );
  assert.match(document, /\| `mode` \| Required \| string \| Values: `"fast"`, `"safe"`/);
});

test('shared variant tables link to the correct occurrence of a duplicate heading', async () => {
  const { bodyReference } = await import('../dist/sdk-documentation.js');
  const document = bodyReference(
    {
      resource: 'records',
      method: 'update',
      body: {
        type: 'object',
        properties: { type: { type: 'string' }, x: { type: 'string' }, y: { type: 'string' } },
        allOf: [
          {
            discriminator: { propertyName: 'type' },
            anyOf: [
              { properties: { type: { const: 'x' } }, required: ['x'] },
              { properties: { type: { const: 'y' } }, required: ['y'] },
            ],
          },
          {
            discriminator: { propertyName: 'type' },
            anyOf: [
              { properties: { type: { const: 'x' } }, required: ['x'] },
              { properties: { type: { const: 'y' } }, required: ['x', 'y'] },
            ],
          },
          {
            discriminator: { propertyName: 'type' },
            anyOf: [
              { properties: { type: { const: 'x' } }, required: ['x'] },
              { properties: { type: { const: 'y' } }, required: ['x', 'y'] },
            ],
          },
        ],
      },
    },
    {},
  );
  assert.equal(document.split('| Field | Presence | Type | Description |').length - 1, 4);
  const headings = document.split('#### records.update with `type: "y"`');
  assert.equal(headings.length, 4);
  assert.match(headings[1], /\| `x` \| Optional/);
  assert.match(headings[2], /\| `x` \| Required/);
  assert.match(headings[2], /\| `y` \| Required/);
  assert.doesNotMatch(headings[3], /\| Field \|/);
  assert.match(
    headings[3],
    /Fields: \[records.update with `type: "y"`\]\(#recordsupdate-with-type-y-1\)/,
  );
});
