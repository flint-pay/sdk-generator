import test from 'node:test';
import assert from 'node:assert/strict';
import { webhookNames } from '../dist/webhook-names.js';

const envelope = (audience) => ({
  type: 'object',
  properties: { type: { type: 'string' }, audience: { type: 'string', const: audience } },
  required: ['type', 'audience'],
});
const incoming = (schema) => ({
  post: { requestBody: { content: { 'application/json': { schema } } }, responses: {} },
});
const ref = (name) => ({ $ref: '#/components/schemas/' + name });

test('audience titles come from referenced components as well as sibling overrides', () => {
  const document = {
    components: {
      schemas: {
        BalanceMerchant: { ...envelope('merchant'), title: 'Merchant' },
        BalancePartner: { ...envelope('partner'), title: 'Installed merchants' },
        OrderMerchant: { ...envelope('merchant'), title: 'Component title' },
        OrderPartner: envelope('partner'),
      },
    },
    webhooks: {
      'balance.updated': incoming({ oneOf: [ref('BalanceMerchant'), ref('BalancePartner')] }),
      'order.paid': incoming({
        oneOf: [
          { ...ref('OrderMerchant'), title: 'Merchant' },
          { ...ref('OrderPartner'), title: 'Installed merchants' },
        ],
      }),
    },
  };
  const { models } = webhookNames(document, []);
  assert.equal(models.BalanceMerchant, 'BalanceUpdatedMerchantEvent');
  assert.equal(models.BalancePartner, 'BalanceUpdatedInstalledMerchantsEvent');
  assert.equal(models.OrderMerchant, 'OrderPaidMerchantEvent');
  assert.equal(models.OrderPartner, 'OrderPaidInstalledMerchantsEvent');
});

test('distinct audiences without any title still fail', () => {
  const document = {
    components: { schemas: { A: envelope('merchant'), B: envelope('partner') } },
    webhooks: { 'balance.updated': incoming({ oneOf: [ref('A'), ref('B')] }) },
  };
  assert.throws(
    () => webhookNames(document, []),
    /distinct webhook audiences require variant titles/,
  );
});
