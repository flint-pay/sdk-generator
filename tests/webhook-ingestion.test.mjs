import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createHmac } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { loadContract, generate } from '../dist/index.js';
const dir = mkdtempSync(join(tmpdir(), 'sdk-incoming-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const event = {
  type: 'object',
  properties: {
    event_type: { type: 'string', const: 'balance.changed' },
    amount: { type: 'integer', format: 'int64' },
  },
  required: ['event_type', 'amount'],
};
const doc = {
  openapi: '3.1.0',
  info: { title: 'Incoming', version: 'v1' },
  components: { schemas: { Event: event } },
  paths: {
    '/health': { get: { operationId: 'health', responses: { 204: { description: 'OK' } } } },
  },
  webhooks: {
    'delivery-name': {
      post: {
        operationId: 'notAnOutboundMethod',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Event' } } },
        },
        responses: { '2XX': { description: 'Acknowledged' } },
      },
    },
  },
};
const config = {
  version: '1.0.0',
  requests: { style: 'object' },
  npm: { name: '@example/incoming' },
  composer: { name: 'example/incoming', namespace: 'Example\\Incoming' },
  webhook: {
    algorithm: 'hmac-sha256',
    header: 'X-Signature',
    timestampHeader: 'X-Timestamp',
    separator: '.',
    toleranceSeconds: 300,
    typeField: 'event_type',
    events: {},
  },
};
function load(settings = config) {
  writeFileSync(join(dir, 'api.json'), JSON.stringify(doc));
  writeFileSync(join(dir, 'sdk.json'), JSON.stringify(settings));
  return loadContract(join(dir, 'api.json'), join(dir, 'sdk.json'));
}
test('incoming contracts remain separate and reach both signed verifier APIs with exact payloads', async () => {
  const contract = load();
  assert.deepEqual(
    contract.operations.map((op) => op.id),
    ['health'],
  );
  assert.equal(contract.incoming[0].name, 'delivery-name');
  assert.deepEqual(Object.keys(contract.config.webhook.events), ['balance.changed']);
  const out = join(dir, 'out');
  generate(contract, out);
  const plan = JSON.parse(readFileSync(join(out, 'php/src/contract.json'), 'utf8'));
  assert.equal(plan.incoming.length, 1);
  assert.equal(plan.incoming[0].schema, undefined);
  assert.ok(plan.incoming[0].codec);
  const { Client } = await import(pathToFileURL(join(out, 'node/index.js')).href);
  const client = new Client({ baseUrl: 'https://example.invalid' });
  assert.equal(client.api.notAnOutboundMethod, undefined);
  const raw = '{"event_type":"balance.changed","amount":9007199254740993}';
  const timestamp = '1700000000',
    secret = 'synthetic-signing-secret';
  const headers = {
    'X-Timestamp': timestamp,
    'X-Signature': createHmac('sha256', secret)
      .update(timestamp + '.' + raw)
      .digest('hex'),
  };
  const expected = {
    known: true,
    event: { event_type: 'balance.changed', amount: '9007199254740993' },
  };
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(client.verifyWebhook(Buffer.from(raw), headers, [secret], Number(timestamp))),
    ),
    expected,
  );
  assert.throws(() =>
    client.verifyWebhook(Buffer.from(raw + ' '), headers, [secret], Number(timestamp)),
  );
  writeFileSync(join(dir, 'case.json'), JSON.stringify({ raw, headers }));
  writeFileSync(
    join(dir, 'verify.php'),
    `<?php
require $argv[1].'/php/src/Runtime.php'; require $argv[1].'/php/src/Client.php';
$client=new Example\\Incoming\\Client(new Example\\Incoming\\ClientOptions(baseUrl:'https://example.invalid'));
$case=json_decode(file_get_contents($argv[2]),true);
echo json_encode($client->verifyWebhook($case['raw'],$case['headers'],['synthetic-signing-secret'],1700000000));
`,
  );
  const result = spawnSync('php', [join(dir, 'verify.php'), out, join(dir, 'case.json')], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), expected);
});
test('conflicting explicit event bindings produce a declaration diagnostic', () => {
  assert.throws(
    () =>
      load({
        ...config,
        webhook: { ...config.webhook, events: { 'balance.changed': { type: 'string' } } },
      }),
    /webhooks\/delivery-name\/post.*conflicts/,
  );
});
