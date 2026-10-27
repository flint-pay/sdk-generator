import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { loadContract } from '../dist/contract.js';

test('loading nested alternatives grows linearly in hashes and container visits', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sdk-load-scaling-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  // Isolate builtin instrumentation from other tests. Count work rather than
  // elapsed time: shared-host load must not affect this regression guard.
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadContract } from ${JSON.stringify(new URL('../dist/contract.js', import.meta.url).href)};
const directory = ${JSON.stringify(directory)};
const config = JSON.parse(readFileSync('examples/library.sdk.json', 'utf8'));
config.requests = { style: 'object' };
config.models = {};
config.operations = {};
delete config.webhook;
const configuration = join(directory, 'sdk.json');
const definition = join(directory, 'api.json');
writeFileSync(configuration, JSON.stringify(config));
let hashes = 0, visits = 0;
const createHash = crypto.createHash;
crypto.createHash = (...args) => { hashes++; return createHash(...args); };
syncBuiltinESMExports();
for (const method of ['entries', 'values']) {
  const original = Object[method];
  Object[method] = (...args) => { visits++; return original(...args); };
}
const counts = [];
for (const depth of [16, 32, 64]) {
  let schema = { type: 'integer', format: 'int64' };
  for (let i = 0; i < depth; i++)
    schema = { anyOf: [{ type: 'object', properties: { child: schema } }, { type: 'null' }] };
  writeFileSync(definition, JSON.stringify({
    openapi: '3.1.0', info: { title: 'Scaling', version: '1' },
    paths: { '/value': { post: {
      operationId: 'sendValue',
      requestBody: { content: { 'application/json': { schema } } },
      responses: { 204: { description: 'No content' } }
    } } }
  }));
  hashes = 0;
  visits = 0;
  const contract = loadContract(definition, configuration);
  counts.push({ depth, hashes, visits, operations: contract.operations.length });
}
console.log(JSON.stringify(counts));
`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  const counts = JSON.parse(result.stdout);
  for (const count of counts) assert.equal(count.operations, 1);
  for (let i = 1; i < counts.length; i++) {
    for (const metric of ['hashes', 'visits']) {
      assert.ok(counts[i - 1][metric] > 0);
      assert.ok(
        counts[i][metric] < counts[i - 1][metric] * 2.5,
        `${metric} should grow near 2x when depth doubles: ${JSON.stringify(counts)}`,
      );
    }
  }
});

test('representation summaries tolerate primitive leaves in legacy resolved references', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sdk-load-reference-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const definition = join(directory, 'api.json');
  const configuration = join(directory, 'sdk.json');
  writeFileSync(
    definition,
    JSON.stringify({
      openapi: '3.1.0',
      info: { title: 'References', version: '1' },
      paths: {
        '/value': { get: { operationId: 'getValue', responses: { 204: { description: 'OK' } } } },
      },
    }),
  );
  writeFileSync(
    configuration,
    JSON.stringify({
      version: '1.0.0',
      requests: { style: 'object' },
      npm: { name: '@example/references' },
      composer: { name: 'example/references', namespace: 'Example\\References' },
      webhook: {
        algorithm: 'hmac-sha256',
        header: 'x-signature',
        timestampHeader: 'x-timestamp',
        separator: '.',
        toleranceSeconds: 300,
        typeField: 'type',
        events: {
          event: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['event'] },
              nested: {
                anyOf: [
                  { 'x-sdk-ref': 'Placeholder', properties: { legacy: false } },
                  { type: 'string' },
                ],
              },
            },
          },
        },
      },
    }),
  );
  const contract = loadContract(definition, configuration);
  assert.equal(
    contract.config.webhook.events.event.properties.nested.anyOf[0]['x-sdk-ref'],
    'Placeholder',
  );
});
