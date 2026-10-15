import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadContract, render, generate, preview, prepareRelease } from '../dist/index.js';
import { compileSdkContract } from '../dist/target-plan.js';

const events = ['payment.updated', 'payment.deleted', 'payment.created'];
const orderedEvents = ['payment.created', 'payment.deleted', 'payment.updated'];
const eventNames = [
  'WebhookEventPaymentCreated',
  'WebhookEventPaymentDeleted',
  'WebhookEventPaymentUpdated',
];
const envelope = (event) => ({
  type: 'object',
  properties: {
    type: { type: 'string', const: event },
    data: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  required: ['type', 'data'],
});

function synthetic(root, incoming) {
  const api = join(root, 'api.json');
  const config = join(root, 'sdk.json');
  writeFileSync(
    api,
    JSON.stringify({
      openapi: '3.1.0',
      info: { title: 'Event order', version: '1' },
      paths: {
        '/value': {
          get: { operationId: 'readValue', responses: { 204: { description: 'Empty' } } },
        },
      },
      // Incoming declaration names sort differently from their event-name bindings.
      ...(incoming
        ? {
            webhooks: Object.fromEntries(
              events.map((event, index) => [
                'declaration' + index,
                {
                  post: {
                    requestBody: {
                      required: true,
                      content: { 'application/json': { schema: envelope(event) } },
                    },
                    responses: { 204: { description: 'Accepted' } },
                  },
                },
              ]),
            ),
          }
        : {}),
    }),
  );
  writeFileSync(
    config,
    JSON.stringify({
      version: '1.0.0',
      targets: ['node', 'php'],
      npm: { name: '@example/event-order' },
      composer: { name: 'example/event-order', namespace: 'Example\\EventOrder' },
      webhook: {
        algorithm: 'hmac-sha256',
        header: 'X-Signature',
        timestampHeader: 'X-Timestamp',
        separator: '.',
        toleranceSeconds: 300,
        typeField: 'type',
        events: incoming ? {} : Object.fromEntries(events.map((event) => [event, envelope(event)])),
      },
    }),
  );
  return loadContract(api, config);
}

for (const fixture of ['configured', 'incoming', 'payment', 'flint']) {
  test(`${fixture} webhook generation`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'sdk-event-order-'));
    try {
      const contract =
        fixture === 'configured' || fixture === 'incoming'
          ? synthetic(root, fixture === 'incoming')
          : loadContract(
              fixture === 'payment'
                ? 'tests/fixtures/payment-api.json'
                : 'tests/providers/flint/openapi.json',
              fixture === 'payment'
                ? 'tests/fixtures/payment-sdk.json'
                : 'tests/providers/flint/sdk.json',
            );
      if (fixture === 'configured' || fixture === 'incoming')
        assert.deepEqual(Object.keys(contract.config.webhook.events), events);
      const output = join(root, 'output');
      generate(contract, output);
      const savedRecord = JSON.parse(readFileSync(join(output, '.sdk-generator.json'), 'utf8'));
      const restored = JSON.parse(JSON.stringify(savedRecord.interface));
      await t.test('every Node and PHP file survives saved-interface JSON restoration', () => {
        const freshFiles = render(contract);
        const restoredFiles = render(restored);
        assert.deepEqual([...freshFiles.keys()].sort(), [...restoredFiles.keys()].sort());
        for (const [path, content] of freshFiles) {
          assert.equal(restoredFiles.get(path), content, `${fixture}: restored ${path}`);
          assert.equal(
            readFileSync(join(output, path), 'utf8'),
            content,
            `${fixture}: saved ${path}`,
          );
        }
        assert.ok([...freshFiles.keys()].some((path) => path.startsWith('node/')));
        assert.ok([...freshFiles.keys()].some((path) => path.startsWith('php/')));

        if (fixture === 'configured' || fixture === 'incoming') {
          const plan = compileSdkContract(contract).plan;
          assert.deepEqual(Object.keys(plan.node.eventTypes), orderedEvents);
          assert.deepEqual(Object.keys(plan.php.eventModels), orderedEvents);
          assert.deepEqual(
            plan.php.models
              .filter((model) => eventNames.includes(model.name))
              .map((model) => model.name),
            eventNames,
          );
          assert.match(
            freshFiles.get('node/declarations/KnownWebhookEvent.d.ts'),
            /KnownWebhookEvent = WebhookEventPaymentCreated \| WebhookEventPaymentDeleted \| WebhookEventPaymentUpdated;/,
          );
          const rootExports = freshFiles.get('node/index.d.ts');
          assert.ok(rootExports.indexOf(eventNames[0]) < rootExports.indexOf(eventNames[1]));
          assert.ok(rootExports.indexOf(eventNames[1]) < rootExports.indexOf(eventNames[2]));
        }
        assert.deepEqual(preview(restored, output).changes, []);
      });
      await t.test('a fresh generation prepares a release', () => {
        const release = prepareRelease(output, join(root, 'release'));
        assert.equal(release.version, contract.config.version);
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
