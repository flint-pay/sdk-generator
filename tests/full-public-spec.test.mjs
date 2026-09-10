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
  assert.equal(inventory.operations.length, 497);
  assert.equal(new Set(inventory.operations.map(({ id }) => id)).size, 497);
  assert.equal(inventory.incoming.length, 189);
  assert.equal(inventory.mappings.length, 6);
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
      multipleOf: 17,
      uniqueItems: 25,
      if: 11,
      then: 11,
      else: 1,
      contains: 11,
      minProperties: 4,
      maxProperties: 1,
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

test('inventory never treats literal data as subschemas', () => {
  const result = publicInventory({
    components: { schemas: { Literal: { const: { $ref: 'data', contains: { type: 'string' } } } } },
  });
  assert.deepEqual(result.keywords, { const: ['/components/schemas/Literal/const'] });
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
        version: '1.0.0',
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
        delivery_configuration_status: 'configured',
        images: [],
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
      request_id: 'req_fixture',
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
