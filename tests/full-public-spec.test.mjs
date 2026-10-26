import { responseExamples } from './helpers/flint-response-examples.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadContract, generate, validateFixtures } from '../dist/index.js';
import { createHash } from 'node:crypto';
import { publicInventory } from './helpers/public-inventory.mjs';

const root = new URL('./providers/flint/', import.meta.url);
const read = (name) => JSON.parse(readFileSync(new URL(name, root), 'utf8'));
const source = read('full-openapi.json');

test('full public export retains pinned source bytes and deterministic exhaustive inventory', () => {
  const provenance = read('provenance.json').fullSpec;
  assert.equal(
    createHash('sha256')
      .update(readFileSync(new URL('full-openapi.json', root)))
      .digest('hex'),
    provenance.sourceSha256,
  );
  assert.equal(source['x-flint-api-version'], provenance.apiVersion);
  const inventory = publicInventory(source);
  assert.deepEqual(inventory, read('full-inventory.json'));
  assert.equal(inventory.operations.length, 612);
  assert.equal(new Set(inventory.operations.map(({ id }) => id)).size, 612);
  assert.equal(inventory.incoming.length, 245);
  assert.equal(inventory.mappings.length, 76);
  assert.deepEqual(
    Object.fromEntries(
      [
        'multipleOf',
        'uniqueItems',
        'if',
        'then',
        'else',
        'contains',
        'minProperties',
        'maxProperties',
      ].map((key) => [key, inventory.keywords[key].length]),
    ),
    {
      multipleOf: 42,
      uniqueItems: 77,
      if: 273,
      then: 273,
      else: 224,
      contains: 8,
      minProperties: 27,
      maxProperties: 14,
    },
  );
  assert.equal(inventory.keywords.minContains, undefined);
  assert.equal(inventory.keywords.maxContains, undefined);
  assert.deepEqual(
    inventory.operations
      .filter((op) => Object.values(op.responses).flat().includes('application/pdf'))
      .map((op) => op.id)
      .sort(),
    ['getCreditNotePDF', 'getInvoicePDF', 'getMeCreditNotePDF', 'getMeInvoicePDF'],
  );
  assert.deepEqual(
    inventory.operations
      .filter((op) => Object.values(op.responses).flat().includes('text/event-stream'))
      .map((op) => op.id),
    ['streamWebhookEvents'],
  );
  const outgoing = new Set(inventory.operations.map((op) => op.id));
  assert.ok(inventory.incoming.every((op) => !outgoing.has(op.id)));
});

test('full profile authentication selections retain complete published alternatives', () => {
  const hidden = new Set([
    'authorizeCLIDevice',
    'listCLIContexts',
    'reauthorizeCLIDevice',
    'revokeOAuthToken',
    'exchangeOAuthToken',
  ]);
  const operations = Object.values(source.paths).flatMap((item) =>
    Object.values(item).filter(
      (operation) => operation.operationId && !hidden.has(operation.operationId),
    ),
  );
  for (const profileName of read('full-sdk.json').profiles) {
    const profile = read(profileName);
    const [[, mode]] = Object.entries(profile.auth.modes);
    const allowed = operations.filter((operation) =>
      (operation.security ?? source.security ?? []).some(
        (alternative) =>
          JSON.stringify(Object.keys(alternative).sort()) ===
          JSON.stringify(mode.schemes.slice().sort()),
      ),
    );
    assert.deepEqual(
      mode.operations.slice().sort(),
      allowed.map((operation) => operation.operationId).sort(),
      profileName,
    );
    const anonymous = operations.filter((operation) => {
      const alternatives = operation.security ?? source.security ?? [];
      return (
        alternatives.length === 0 ||
        alternatives.some((alternative) => Object.keys(alternative).length === 0)
      );
    });
    assert.deepEqual(
      profile.include.slice().sort(),
      [...new Set([...allowed, ...anonymous].map((operation) => operation.operationId))].sort(),
      profileName,
    );
    assert.equal(profile.overrides, undefined, profileName);
  }
  assert.equal(read('full-common-sdk.json').overrides, undefined);
});

test('the single upstream response-example defect is pinned to source evidence', () => {
  const [defect, ...others] = read('response-example-failures.json');
  assert.deepEqual(others, []);
  assert.deepEqual(
    [defect.operation, defect.status, defect.media, defect.exampleName],
    ['createOrderPaymentIntent', '201', 'application/json', 'example'],
  );
  assert.equal(defect.error, 'response.data.supported_actions: required field is missing');
  assert.equal(defect.revision, read('provenance.json').revision);
  assert.equal(
    defect.source,
    `https://github.com/flint-pay/flint/blob/${defect.revision}/server/monolith/internal/publicapi/models.go#L2467-L2490`,
  );
  const operation = source.paths['/v1/orders/{order_id}/payment-intents'].post;
  assert.equal(operation.operationId, defect.operation);
  const response = operation.responses[defect.status].content[defect.media];
  assert.equal(response.schema.$ref, '#/components/schemas/PaymentIntentWithCollectionResponse');
  assert.equal(Object.hasOwn(response.example.data, 'supported_actions'), false);
  assert.ok(source.components.schemas.PaymentIntent.required.includes('supported_actions'));
  assert.equal(
    source.components.schemas.PaymentIntentWithCollection.allOf[0].$ref,
    '#/components/schemas/PaymentIntent',
  );
});

test('inventory never treats literal data as subschemas', () => {
  const result = publicInventory({
    components: {
      schemas: {
        Literal: { const: { $ref: 'data', contains: { type: 'string' } } },
      },
    },
  });
  assert.deepEqual(result.keywords, {
    const: ['/components/schemas/Literal/const'],
  });
});

test('response-example inventory follows schema references and includes hidden JSON responses', () => {
  const document = {
    components: {
      schemas: {
        Shared: {
          type: 'object',
          example: { $ref: 'literal data', properties: { example: 'literal' } },
          properties: { value: { type: 'string', examples: ['nested'] } },
        },
      },
    },
    paths: {
      '/resource': {
        get: {
          operationId: 'getResource',
          responses: {
            200: {
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Shared' },
                  examples: { named: { value: { value: 'route' } } },
                },
              },
            },
            400: {
              content: {
                'application/json': { schema: { type: 'string', example: 'not success' } },
              },
            },
          },
        },
      },
      '/hidden': {
        post: {
          operationId: 'exchangeOAuthToken',
          responses: {
            200: {
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Shared' },
                  example: { value: 'hidden' },
                },
              },
            },
          },
        },
      },
    },
  };
  const inventory = responseExamples(document);
  assert.deepEqual(
    inventory.routes.map(({ operation, status, media, exampleName }) => [
      operation,
      status,
      media,
      exampleName,
    ]),
    [['getResource', '200', 'application/json', 'examples/named']],
  );
  assert.equal(
    inventory.schemas.length,
    3,
    'two shared schema annotations plus hidden JSON example',
  );
  assert.deepEqual(
    inventory.schemas.map(({ json }) => JSON.parse(json)),
    [{ $ref: 'literal data', properties: { example: 'literal' } }, 'nested', { value: 'hidden' }],
  );
  assert.equal(inventory.schemas[2].operation, 'exchangeOAuthToken');
  assert.deepEqual(inventory.omitted, []);
});

test('getBundle retains its original referenced graph and decodes inherited discriminator branches in both targets', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sdk-bundle-'));
  try {
    // Diagnostic isolation only: the full export above remains unchanged.
    // Ingestion previously demanded direct object/tag declarations. Nested branches
    // inherit their object type and required literal tag through referenced allOf.
    // The failure did not depend on webhook ingestion or mappings.
    const { webhooks, ...document } = source;
    writeFileSync(join(dir, 'api.json'), JSON.stringify(document));
    writeFileSync(
      join(dir, 'sdk.json'),
      JSON.stringify({
        responses: { return: 'result' },
        version: '1.0.0',
        requests: { style: 'object' },
        npm: { name: '@example/bundle' },
        composer: { name: 'example/bundle', namespace: 'Example\\BundleSdk' },
        auth: { scheme: 'BearerAuth' },
        models: { Money: 'MoneyValue' },
        include: ['getBundle'],
        validation: 'schema',
      }),
    );
    const contract = loadContract(join(dir, 'api.json'), join(dir, 'sdk.json'));
    assert.equal(contract.operations.length, 1);
    const data = {
      data: {
        available_for_sale: true,
        bundle_id: 'bun_fixture',
        component_count: 1,
        delivery_configuration_status: 'configured',
        images: [],
        categories: [],
        components: [],
        metadata: {},
        modifier_set_id: null,
        name: 'Bundle',
        status: 'active',
        unit_price_money: { amount: '9007199254740993', currency: 'USD' },
        version: '1',
        modifier_set: {
          modifier_set_id: 'ms_fixture',
          name: 'Extras',
          status: 'active',
          version: '1',
          modifier_groups: [
            {
              modifier_set_group_id: 'msg_fixture',
              position: 0,
              source: 'existing',
              modifier_group_id: 'mg_fixture',
              modifier_group_name: 'Extras',
            },
          ],
        },
      },
      request_id: 'req_00P5GR7C25QNQYKSNCJF346W0E',
    };
    const wire = JSON.stringify(data)
      .replace('"9007199254740993"', '9007199254740993')
      .replaceAll('"version":"1"', '"version":1');
    const output = join(dir, 'out');
    generate(contract, output);
    writeFileSync(
      join(dir, 'cases.json'),
      JSON.stringify([
        {
          name: 'original bundle',
          baseUrl: 'https://api.example.invalid',
          operation: 'getBundle',
          input: { bundle_id: 'bun_fixture' },
          expected: { method: 'GET', path: '/v1/bundles/bun_fixture' },
          responses: [{ status: 200, body: wire }],
          data,
        },
      ]),
    );
    assert.deepEqual(
      (await validateFixtures(output, join(dir, 'cases.json'))).map((result) => result.scenarios),
      [1, 1],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
