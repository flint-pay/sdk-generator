import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadContract, generate, validateFixtures } from '../dist/index.js';

const settings = {
  version: '1.0.0',
  requests: { style: 'object' },
  npm: { name: '@example/resolution' },
  composer: { name: 'example/resolution', namespace: 'Example\\Resolution' },
  validation: 'schema',
};
const ref = (name) => ({ $ref: '#/components/schemas/' + name });
function fixture(t, schemas, paths, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sdk-resolution-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const api = join(dir, 'api.json');
  const config = join(dir, 'sdk.json');
  writeFileSync(
    api,
    JSON.stringify({
      openapi: '3.1.0',
      info: { title: 'Resolution', version: 'v1' },
      paths,
      components: { schemas },
    }),
  );
  writeFileSync(config, JSON.stringify({ ...settings, ...extra }));
  return { dir, api, config };
}

test('repeated response references load within a small heap without expanding nested copies', (t) => {
  const codes = Array.from({ length: 4000 }, (_, index) => 'SYNTHETIC_CODE_' + index);
  const schemas = {
    Codes: { type: 'string', enum: codes },
    ErrorObject: {
      type: 'object',
      properties: { code: ref('Codes'), previous_code: ref('Codes'), next_code: ref('Codes') },
    },
    ErrorEnvelope: { type: 'object', properties: { error: ref('ErrorObject') } },
  };
  const paths = Object.fromEntries(
    Array.from({ length: 200 }, (_, index) => [
      '/resources/' + index,
      {
        get: {
          operationId: 'getResource' + index,
          responses: {
            204: { description: 'OK' },
            ...Object.fromEntries(
              [400, 401, 404, 500].map((status) => [
                status,
                {
                  description: 'Error',
                  content: { 'application/json': { schema: ref('ErrorEnvelope') } },
                },
              ]),
            ),
          },
        },
      },
    ]),
  );
  const f = fixture(t, schemas, paths);
  const script = join(f.dir, 'load.mjs');
  writeFileSync(
    script,
    `import {loadContract} from ${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)};
const contract=loadContract(${JSON.stringify(f.api)},${JSON.stringify(f.config)});
console.log(JSON.stringify({operations:contract.operations.length,code:contract.models.Codes.enum[3999],error:contract.operations[0].responses['400'].schema.properties.error['x-sdk-ref']}));`,
  );
  const result = spawnSync(process.execPath, ['--max-old-space-size=128', script], {
    encoding: 'utf8',
    timeout: 60000,
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    operations: 200,
    code: 'SYNTHETIC_CODE_3999',
    error: 'ErrorObject',
  });
});

test('representation normalization stays local to composed reference uses in both targets', async (t) => {
  const schemas = {
    Bound: { minimum: 2 },
    Payload: { type: 'object', required: ['amount'], properties: { amount: ref('Bound') } },
    ExactPayload: {
      allOf: [ref('Payload'), { properties: { amount: { type: 'integer', format: 'int64' } } }],
    },
    StringPayload: { ...ref('Payload'), properties: { amount: { type: 'string' } } },
    ExactRoot: {
      type: 'object',
      required: ['payload'],
      properties: { payload: ref('Payload') },
      allOf: [
        {
          properties: {
            payload: {
              type: 'object',
              properties: { amount: { type: 'integer', format: 'int64' } },
            },
          },
        },
      ],
    },
    ExactArrayRoot: {
      type: 'array',
      items: ref('Payload'),
      allOf: [
        { items: { type: 'object', properties: { amount: { type: 'integer', format: 'int64' } } } },
      ],
    },
    ExactMapRoot: {
      type: 'object',
      additionalProperties: ref('Payload'),
      allOf: [
        {
          additionalProperties: {
            type: 'object',
            properties: { amount: { type: 'integer', format: 'int64' } },
          },
        },
      ],
    },
    ExactBaseRoot: {
      type: 'object',
      required: ['payload'],
      properties: {
        payload: { type: 'object', properties: { amount: { type: 'integer', format: 'int64' } } },
      },
    },
    ExactSiblingRoot: { ...ref('ExactBaseRoot'), properties: { payload: ref('Payload') } },
  };
  const paths = Object.fromEntries(
    ['Exact', 'String'].map((kind) => [
      '/' + kind.toLowerCase(),
      {
        post: {
          operationId: 'send' + kind,
          requestBody: {
            required: true,
            content: { 'application/json': { schema: ref(kind + 'Payload') } },
          },
          responses: { 204: { description: 'OK' } },
        },
      },
    ]),
  );
  paths['/nested'] = {
    post: {
      operationId: 'sendExactRoot',
      requestBody: {
        required: true,
        content: { 'application/json': { schema: ref('ExactRoot') } },
      },
      responses: { 204: { description: 'OK' } },
    },
  };
  paths['/untyped'] = {
    post: {
      operationId: 'sendPayload',
      requestBody: {
        required: true,
        content: { 'application/json': { schema: ref('Payload') } },
      },
      responses: { 204: { description: 'OK' } },
    },
  };
  for (const kind of ['Array', 'Map', 'Sibling'])
    paths['/nested-' + kind.toLowerCase()] = {
      post: {
        operationId: 'sendExact' + kind + 'Root',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: ref('Exact' + kind + 'Root') } },
        },
        responses: { 204: { description: 'OK' } },
      },
    };
  const f = fixture(t, schemas, paths, {
    operations: {
      sendExact: { example: { body: { amount: '2' } } },
      sendString: { example: { body: { amount: 'letters' } } },
      sendExactRoot: { example: { body: { payload: { amount: '2' } } } },
      sendPayload: { example: { body: { amount: 'letters' } } },
      sendExactArrayRoot: { example: { body: [{ amount: '2' }] } },
      sendExactMapRoot: { example: { body: { nested: { amount: '2' } } } },
      sendExactSiblingRoot: { example: { body: { payload: { amount: '2' } } } },
    },
  });
  const first = loadContract(f.api, f.config);
  assert.deepEqual(loadContract(f.api, f.config), first);
  const output = join(f.dir, 'output');
  generate(first, output);
  const cases = join(f.dir, 'http-cases.json');
  writeFileSync(
    cases,
    JSON.stringify([
      ...[
        ['Array', [{ amount: '2' }], '[{"amount":2}]'],
        ['Map', { nested: { amount: '2' } }, '{"nested":{"amount":2}}'],
        ['Sibling', { payload: { amount: '2' } }, '{"payload":{"amount":2}}'],
      ].map(([kind, body, wire]) => ({
        name: 'enclosing composition keeps ' + kind.toLowerCase() + ' normalization local',
        operation: 'sendExact' + kind + 'Root',
        input: { body },
        expected: { method: 'POST', path: '/v1/nested-' + kind.toLowerCase(), body: wire },
        responses: [{ status: 204 }],
        empty: true,
      })),
      {
        name: 'enclosing composition applies a numeric kind to the nested field',
        operation: 'sendExactRoot',
        input: { body: { payload: { amount: '2' } } },
        expected: { method: 'POST', path: '/v1/nested', body: '{"payload":{"amount":2}}' },
        responses: [{ status: 204 }],
        empty: true,
      },
      {
        name: 'enclosing composition leaves separate references unconstrained by numeric kind',
        operation: 'sendPayload',
        input: { body: { amount: 'letters' } },
        expected: { method: 'POST', path: '/v1/untyped', body: '{"amount":"letters"}' },
        responses: [{ status: 204 }],
        empty: true,
      },
      {
        name: 'exact field retains numeric constraint and exact wire representation',
        operation: 'sendExact',
        input: { body: { amount: '2' } },
        expected: { method: 'POST', path: '/v1/exact', body: '{"amount":2}' },
        responses: [{ status: 204 }],
        empty: true,
      },
      {
        name: 'numeric constraint rejects a value below the bound',
        operation: 'sendExact',
        input: { body: { amount: '1' } },
        error: { kind: 'validation' },
        responses: [],
        attempts: 0,
      },
      {
        name: 'another reference use retains its string representation',
        operation: 'sendString',
        input: { body: { amount: 'letters' } },
        expected: { method: 'POST', path: '/v1/string', body: '{"amount":"letters"}' },
        responses: [{ status: 204 }],
        empty: true,
      },
    ]),
  );
  const checks = await validateFixtures(output, cases);
  assert.deepEqual(checks, [
    { target: 'node', scenarios: 8 },
    { target: 'php', scenarios: 8 },
  ]);
});
