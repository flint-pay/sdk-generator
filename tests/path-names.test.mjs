import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadContract } from '../dist/index.js';
import {
  pathOperationNames,
  avoidPathHelperCollisions,
  operationVerbOccurs,
  isPublicName,
} from '../dist/naming.js';

const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
test('path rules preserve acronyms, shared prefixes and absent nouns', () => {
  for (const [id, path, expected] of [
    ['createSandboxAPIKey', '/v1/sandboxes/{id}/api-keys', 'sandboxes.createAPIKey'],
    ['getOpenAPISpec', '/v1/openapi.json', 'openapi.getSpec'],
    ['getInvoicePDF', '/v1/invoices/{id}/pdf', 'invoices.getPDF'],
    ['listTaxRegistrations', '/v1/tax-connection/registrations', 'taxConnection.listRegistrations'],
    [
      'createWebhookTestEvent',
      '/v1/webhook-endpoints/{id}/test',
      'webhookEndpoints.createTestEvent',
    ],
    ['authorizePartnerInstall', '/v1/oauth/authorize', 'oauth.authorizePartnerInstall'],
    ['createShipment', '/v1/fulfillments/{id}/shipments', 'fulfillments.createShipment'],
    ['getAnalyticsOverview', '/v1/analytics/overview', 'analytics.getOverview'],
    ['deleteMePaymentMethod', '/v1/me/payment-methods/{id}', 'me.deletePaymentMethod'],
  ]) {
    const actual = pathOperationNames(id, path);
    assert.equal(`${actual.resource}.${actual.method}`, expected);
  }
  assert.equal(operationVerbOccurs('create', 'revokeDependency'), false);
  assert.equal(operationVerbOccurs('removeMembership', 'removeOrganizationMembership'), true);
});

test('pagination collision fallback is automatic and independent of traversal order', () => {
  const entries = [
    {
      id: 'listPackageItems',
      resource: 'packages',
      method: 'listItems',
      pagination: true,
      explicit: false,
    },
    { id: 'listPackages', resource: 'packages', method: 'list', pagination: true, explicit: false },
    {
      id: 'listPackagePages',
      resource: 'packages',
      method: 'listPages',
      pagination: false,
      explicit: false,
    },
  ];
  for (const order of [entries, entries.toReversed()]) {
    const names = avoidPathHelperCollisions(order);
    assert.equal(names.get('listPackageItems').method, 'listPackageItems');
    assert.equal(names.get('listPackagePages').method, 'listPackagePages');
    assert.equal(names.get('listPackages').method, 'list');
  }
  assert.equal(
    avoidPathHelperCollisions(entries.map((e) => ({ ...e, explicit: true }))).get(
      'listPackageItems',
    ).method,
    'listItems',
  );
});

test('portable method allowances do not relax namespace or new restrictions', () => {
  for (const method of ['void', 'close', 'delete']) assert.equal(isPublicName(method, true), true);
  for (const name of ['void', 'close', 'delete', 'new', 'then', 'constructor'])
    assert.equal(isPublicName(name), false);
  assert.equal(isPublicName('new', true), false);
});

test('pinned Flint names match the approved path-name list', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sdk-path-names-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const base = 'tests/providers/flint/';
  const config = read(base + 'full-common-sdk.json');
  // Approved TSV proposed names, plus reference derive.py results for the older
  // pinned source: 36 old IDs and seven routes relocated since this fixture.
  const expected = { ...read(base + 'path-names.json'), ...read(base + 'path-names-legacy.json') };
  config.operationNames = 'path';
  config.auth = { modes: {}, shortcuts: {} };
  for (const profile of read(base + 'full-sdk.json').profiles) {
    const auth = read(base + profile).auth;
    Object.assign(config.auth.modes, auth.modes);
    Object.assign(config.auth.shortcuts, auth.shortcuts);
  }
  const reasons = {
    refreshMerchantAccountSession: 'Registered handoff subject is merchant-account-sessions.',
    listMerchantPartnerAppInstalls: 'Drop the registered Merchant qualifier.',
    revokeMerchantPartnerAppInstall: 'Drop the registered Merchant qualifier.',
    revokeDeliveryDependency:
      'Collection creation follows the path pending the operation-ID correction.',
    rotateDeliveryRateCallbackSigningKey:
      'Follow the rotate-secret path pending the operation-ID correction.',
  };
  for (const [id, operation] of Object.entries(config.operations)) {
    delete operation.resource;
    delete operation.method;
    delete operation.aliases;
    if (reasons[id]) {
      [operation.resource, operation.method] = expected[id].split('.');
      operation.namingReason = reasons[id];
    }
  }
  const file = join(dir, 'sdk.json');
  writeFileSync(file, JSON.stringify(config));
  const contract = loadContract(resolve(base + 'full-openapi.json'), file);
  for (const operation of contract.operations)
    assert.equal(`${operation.resource}.${operation.method}`, expected[operation.id], operation.id);
  // Every expected name present in the pinned source must be exposed unless hidden.
  const source = read(base + 'full-openapi.json');
  const ids = Object.values(source.paths)
    .flatMap((item) => Object.values(item).map((op) => op.operationId))
    .filter(Boolean);
  assert.deepEqual(
    contract.operations.map((op) => op.id).sort(),
    ids.filter((id) => expected[id]).sort(),
  );
});
