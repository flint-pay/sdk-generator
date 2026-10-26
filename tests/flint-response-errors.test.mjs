import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadContract, generate } from '../dist/index.js';
import { checkErrorResponseExamples } from './helpers/flint-response-errors.mjs';

test('error-example audit exercises real clients and detects lost details in both runtimes', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sdk-error-example-audit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const statuses = [400, 401, 403, 404, 409, 410, 412, 413, 415, 422, 429, 500, 502, 503, 504];
  const examples = statuses.map((status, index) => ({
    operation: 'getItem',
    status: String(status),
    media: 'application/json',
    exampleName: 'example',
    location: `synthetic/${status}`,
    json: JSON.stringify({
      error: {
        code: 'TEST_' + status,
        message: 'Synthetic error',
        details: [{ reason: 'invalid', quantity: 3, measure: 1.25, fields: { name: 'required' } }],
        ...(index % 2 ? { request_id: 'req_synthetic' } : {}),
      },
    }),
  }));
  const schema = {
    type: 'object',
    required: ['error'],
    properties: {
      error: {
        type: 'object',
        required: ['code', 'message', 'details'],
        properties: {
          code: { type: 'string' },
          message: { type: 'string' },
          request_id: { type: 'string' },
          details: {
            type: 'array',
            items: {
              type: 'object',
              required: ['reason', 'fields'],
              properties: {
                reason: { type: 'string', enum: ['invalid'] },
                quantity: { type: 'integer', format: 'int64' },
                measure: { type: 'number' },
                fields: { type: 'object', additionalProperties: { type: 'string' } },
              },
            },
          },
        },
      },
    },
  };
  const api = join(dir, 'api.json');
  const config = join(dir, 'sdk.json');
  writeFileSync(
    api,
    JSON.stringify({
      openapi: '3.1.0',
      info: { title: 'Synthetic error audit control', version: '1' },
      servers: [{ url: 'https://api.example.invalid' }],
      paths: {
        '/items/{id}': {
          get: {
            operationId: 'getItem',
            parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
            responses: {
              200: {
                description: 'OK',
                content: { 'application/json': { schema: { type: 'string' } } },
              },
              ...Object.fromEntries(
                statuses.map((status) => [
                  status,
                  { description: 'Synthetic error', content: { 'application/json': { schema } } },
                ]),
              ),
            },
          },
        },
      },
    }),
  );
  writeFileSync(
    config,
    JSON.stringify({
      version: '1.0.0',
      requests: { style: 'object' },
      npm: { name: '@example/error-audit-control' },
      composer: { name: 'example/error-audit-control', namespace: 'Example\\FlintFull' },
      operations: { getItem: { resource: 'entries', method: 'get' } },
      errors: { codePath: 'error.code', messagePath: 'error.message', detailsPath: 'error' },
    }),
  );
  const output = join(dir, 'output');
  generate(loadContract(api, config), output);
  const { default: load } = await import(
    pathToFileURL(join(output, 'node/descriptors/resources/entries.js')).href
  );
  const plan = load();
  const routes = new Map(plan.operations.map((operation) => [operation.id, { operation, plan }]));
  assert.equal(
    await checkErrorResponseExamples(
      output,
      examples,
      routes,
      join(dir, 'error-examples.json'),
      JSON.parse(readFileSync(api)),
    ),
    statuses.length,
  );
});
