import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { loadContract, render } from '../dist/index.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'sdk-reference-titles-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const envelope = (title, source) => ({
    title,
    type: 'object',
    required: ['type', 'event_source', 'data'],
    properties: {
      type: { type: 'string', const: 'catalog.updated' },
      event_source: { type: 'string', const: source },
      data: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    },
  });
  const variants = [
    { $ref: '#/components/schemas/MerchantEnvelope' },
    { $ref: '#/components/schemas/PartnerEnvelope' },
  ];
  const api = {
    openapi: '3.1.0',
    info: { title: 'Reference title fixture', version: '1' },
    paths: {
      '/items': {
        get: {
          operationId: 'listItems',
          responses: {
            200: {
              description: 'OK',
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { id: { type: 'string' } } },
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        MerchantEnvelope: envelope('Merchant', 'merchant'),
        PartnerEnvelope: envelope('Installed merchants', 'installed_merchants'),
      },
    },
    webhooks: {
      'catalog.updated': {
        post: {
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  oneOf: variants,
                  discriminator: {
                    propertyName: 'event_source',
                    mapping: { merchant: variants[0].$ref, installed_merchants: variants[1].$ref },
                  },
                },
              },
            },
          },
          responses: { 204: { description: 'Accepted' } },
        },
      },
    },
  };
  const config = {
    version: '1.0.0',
    requests: { style: 'object' },
    npm: { name: '@example/reference-titles' },
    composer: { name: 'example/reference-titles', namespace: 'Example\\ReferenceTitles' },
    webhook: {
      algorithm: 'hmac-sha256',
      header: 'X-Signature',
      timestampHeader: 'X-Time',
      separator: '.',
      toleranceSeconds: 300,
      typeField: 'type',
      events: {},
    },
  };
  const path = join(dir, 'api.json'),
    settings = join(dir, 'sdk.json');
  writeFileSync(settings, JSON.stringify(config));
  return {
    api,
    variants,
    load() {
      writeFileSync(path, JSON.stringify(api));
      return loadContract(path, settings);
    },
  };
}

test('titled reference targets and identical sibling titles produce byte-identical packages', (t) => {
  const f = fixture(t),
    c = f.load(),
    before = render(c);
  assert.ok(c.models.CatalogUpdatedMerchantEvent);
  assert.ok(c.models.CatalogUpdatedInstalledMerchantsEvent);
  for (const branch of f.variants)
    branch.title = f.api.components.schemas[branch.$ref.split('/').at(-1)].title;
  assert.deepEqual([...render(f.load())], [...before]);
});

test('explicit sibling titles take precedence over component titles', (t) => {
  const f = fixture(t);
  f.api.components.schemas.MerchantEnvelope.title = 'Shared';
  f.api.components.schemas.PartnerEnvelope.title = 'Shared';
  f.variants[0].title = 'Merchant override';
  f.variants[1].title = 'Partner override';
  const c = f.load();
  assert.ok(c.models.CatalogUpdatedMerchantOverrideEvent);
  assert.ok(c.models.CatalogUpdatedPartnerOverrideEvent);
  assert.ok(render(c).get('node/index.d.ts').includes('CatalogUpdatedMerchantOverrideEvent'));
  f.variants[1].title = f.variants[0].title;
  assert.throws(() => f.load(), /distinct webhook audiences require variant titles/);
});

for (const titles of [
  [undefined, undefined],
  ['Merchant', undefined],
  ['Shared', 'Shared'],
  ['Installed merchants', 'installed_merchants'],
  [' ', 'Installed merchants'],
])
  test(`missing or colliding resolved audience titles fail: ${JSON.stringify(titles)}`, (t) => {
    const f = fixture(t);
    for (const [i, title] of titles.entries()) {
      const name = f.variants[i].$ref.split('/').at(-1);
      if (title === undefined) delete f.api.components.schemas[name].title;
      else f.api.components.schemas[name].title = title;
    }
    assert.throws(() => f.load(), /distinct webhook audiences require variant titles/);
  });

test('titles are inherited through schema reference chains', (t) => {
  const f = fixture(t);
  for (const name of ['MerchantEnvelope', 'PartnerEnvelope']) {
    f.api.components.schemas[name + 'Body'] = f.api.components.schemas[name];
    f.api.components.schemas[name] = { $ref: '#/components/schemas/' + name + 'Body' };
  }
  const c = f.load();
  assert.ok(c.models.CatalogUpdatedMerchantEvent);
  assert.ok(c.models.CatalogUpdatedInstalledMerchantsEvent);
  assert.ok(render(c).get('php/MODELS.md').includes('CatalogUpdatedMerchantEvent'));
});
