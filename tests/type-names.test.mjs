import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { loadContract, generate } from '../dist/index.js';
import { modelNames } from '../dist/naming.js';
import { typescriptType } from '../dist/target-types.js';
function fixture(t, collisions = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sdk-type-names-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ref = (name) => ({ $ref: '#/components/schemas/' + name });
  const resource = {
    type: 'object',
    required: ['id', 'name'],
    additionalProperties: false,
    properties: { id: { type: 'string' }, name: { type: 'string', minLength: 1, maxLength: 255 } },
  };
  const envelope = (event, model, source, constant = false) => ({
    type: 'object',
    required: ['event_type', 'data', ...(source ? ['audience'] : [])],
    properties: {
      event_type: constant
        ? { const: event, type: 'string' }
        : { type: 'string', enum: [event], 'x-flint-enum-kind': 'extensible' },
      ...(source ? { audience: { type: 'string', const: source } } : {}),
      data: {
        type: 'object',
        required: ['object'],
        properties: {
          object: ref(model),
          ...(['customer.updated', 'payment_intent.succeeded'].includes(event)
            ? {
                previous_attributes: {
                  allOf: [ref('WebhookPreviousAttributes')],
                  ...(event === 'customer.updated' ? { 'x-flint-partial-of': 'Customer' } : {}),
                },
              }
            : {}),
        },
      },
    },
  });
  const incoming = (schema) => ({
    post: {
      operationId: 'receive',
      requestBody: { required: true, content: { 'application/json': { schema } } },
      responses: { 200: { description: 'Done' } },
    },
  });
  const schemas = {
    Order: resource,
    Customer: resource,
    PaymentIntent: resource,
    WebhookPreviousAttributes: { type: 'object', additionalProperties: true },
    ArbitraryPaidMerchant: envelope('order.paid', 'Order', 'merchant'),
    ArbitraryPaidPartner: envelope('order.paid', 'Order', 'installed_merchants'),
    ArbitraryCustomer: envelope('customer.updated', 'Customer', undefined, true),
    ArbitraryPayment: envelope('payment_intent.succeeded', 'PaymentIntent'),
    CheckoutBuyerFieldsRequestInput: {
      type: 'object',
      properties: {
        field: { type: 'string', description: 'A buyer field.', minLength: 1, maxLength: 255 },
      },
    },
    CustomerUpdateRequestInput: { type: 'object', properties: { name: { type: 'string' } } },
    PaymentIntentConfirmRequestInput: { type: 'object', properties: { token: { type: 'string' } } },
    ...collisions,
  };
  schemas.EventTag = {
    type: 'string',
    enum: ['payment_intent.succeeded'],
    'x-flint-enum-kind': 'extensible',
  };
  schemas.ArbitraryPayment.properties.event_type = {
    ...ref('EventTag'),
    description: 'The discriminator tag.',
  };
  const op = (id, model) => ({
    operationId: id,
    requestBody: { required: true, content: { 'application/json': { schema: ref(model) } } },
    responses: {
      201: { description: 'Done', content: { 'application/json': { schema: ref('Order') } } },
    },
  });
  const api = {
    openapi: '3.1.0',
    info: { title: 'Synthetic names', version: '1' },
    components: { schemas },
    paths: {
      '/v1/orders': { post: op('createOrder', 'CheckoutBuyerFieldsRequestInput') },
      '/v1/customers': { post: op('createCustomer', 'CustomerUpdateRequestInput') },
      '/v1/payment-intents': {
        post: op('createPaymentIntent', 'PaymentIntentConfirmRequestInput'),
      },
    },
    webhooks: {
      'order.paid': incoming({
        oneOf: [
          { ...ref('ArbitraryPaidMerchant'), title: 'Merchant' },
          { ...ref('ArbitraryPaidPartner'), title: 'Installed merchants' },
        ],
      }),
      'customer.updated': incoming(ref('ArbitraryCustomer')),
      'payment_intent.succeeded': incoming(ref('ArbitraryPayment')),
    },
  };
  const config = {
    version: '1.0.0',
    operationNames: 'path',
    npm: { name: '@example/type-names' },
    composer: { name: 'example/type-names', namespace: 'TypeNames' },
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
  const definition = join(dir, 'api.json'),
    settings = join(dir, 'sdk.json'),
    output = join(dir, 'out');
  writeFileSync(definition, JSON.stringify(api));
  writeFileSync(settings, JSON.stringify(config));
  const contract = loadContract(definition, settings);
  generate(contract, output);
  const declarations = readdirSync(join(output, 'node/declarations'))
    .filter((n) => n.endsWith('.d.ts'))
    .map((n) => readFileSync(join(output, 'node/declarations', n), 'utf8'))
    .join('\n');
  return { dir, output, contract, declarations };
}

test('events and audience models use event names; request names and PHP responses avoid redundant suffixes', async (t) => {
  const f = fixture(t);
  for (const name of [
    'OrderPaidEvent',
    'OrderPaidMerchantEvent',
    'OrderPaidInstalledMerchantsEvent',
    'CustomerUpdatedEvent',
    'PaymentIntentSucceededEvent',
    'CheckoutBuyerFieldsRequestInput',
    'CustomerUpdateRequestInput',
    'PaymentIntentConfirmRequestInput',
  ])
    assert.match(f.declarations, new RegExp('type ' + name + '\\b'));
  assert.doesNotMatch(f.declarations, /IncomingWebhook|RequestRequest|Shape \$/);
  assert.match(f.declarations, /Partial<Customer>/);
  assert.equal(
    typescriptType(
      f.contract.models.PaymentIntentSucceededEvent.properties.event_type,
      true,
      undefined,
      false,
      undefined,
      undefined,
      f.contract.definitions ?? f.contract.models,
    ),
    '"payment_intent.succeeded"',
  );
  assert.match(f.declarations, /Partial<PaymentIntent>/);
  const classes = readdirSync(join(f.output, 'php/src/classes'));
  for (const name of ['Order', 'OrderPaidMerchantEvent', 'CustomerUpdatedEvent'])
    assert.ok(classes.includes(name + '.php'), name);
  assert.ok(!classes.some((n) => /Response201/.test(n)));
  const consumer = join(f.output, 'node/consumer.ts');
  writeFileSync(
    consumer,
    `import {Client,type KnownWebhookEvent,type CustomerUpdatedEvent,type OrderPaidMerchantEvent,type OrderPaidInstalledMerchantsEvent,type CheckoutBuyerFieldsRequestInput,type CustomerUpdateRequestInput,type PaymentIntentConfirmRequestInput} from './index.js';
declare const event:KnownWebhookEvent;
if(event.event_type==='customer.updated') {const selected:CustomerUpdatedEvent=event;const oldName:string|undefined=event.data.previous_attributes?.name;
// @ts-expect-error Previous fields retain resource field types.
const wrong:number=event.data.previous_attributes?.name;
}
if(event.event_type==='order.paid') {const selected:OrderPaidMerchantEvent|OrderPaidInstalledMerchantsEvent=event;const id:string=event.data.object.id;}
const a:CheckoutBuyerFieldsRequestInput={field:'name'};const b:CustomerUpdateRequestInput={name:'name'};const c:PaymentIntentConfirmRequestInput={token:'synthetic'};
declare const client:Client; const verified=client.verifyWebhook(new Uint8Array(),{},'synthetic');if(verified.known&&verified.event.event_type==='customer.updated'){const narrowed:CustomerUpdatedEvent=verified.event;}
`,
  );
  try {
    execFileSync(
      process.execPath,
      [
        resolve('node_modules/typescript/bin/tsc'),
        '--strict',
        '--noEmit',
        '--module',
        'NodeNext',
        '--target',
        'ES2022',
        '--typeRoots',
        resolve('node_modules/@types'),
        consumer,
      ],
      { stdio: 'pipe' },
    );
  } catch (e) {
    throw Error(e.stdout?.toString() ?? e.message);
  }
  const { Client } = await import(pathToFileURL(join(f.output, 'node/index.js')));
  const client = new Client({ baseUrl: 'https://example.invalid' }),
    timestamp = String(Math.floor(Date.now() / 1000));
  const raw = JSON.stringify({
    event_type: 'customer.updated',
    data: { object: { id: 'cus_test', name: 'New' }, previous_attributes: { name: 'Old' } },
  });
  const headers = {
    'X-Timestamp': timestamp,
    'X-Signature': createHmac('sha256', 'synthetic')
      .update(timestamp + '.' + raw)
      .digest('hex'),
  };
  const verified = client.verifyWebhook(Buffer.from(raw), headers, 'synthetic');
  assert.equal(verified.known, true);
  assert.equal(verified.event.data.previous_attributes.name, 'Old');
  const php = execFileSync(
    'php',
    [
      '-r',
      String.raw`require $argv[1].'/src/Client.php'; $c=new TypeNames\Client(new TypeNames\ClientOptions('https://example.invalid',transport:fn($r)=>['status'=>201,'headers'=>[],'body'=>'{"id":"ord_test","name":"Order"}'])); echo get_class($c->orders->create(['field'=>'name']));`,
      join(f.output, 'php'),
    ],
    { encoding: 'utf8' },
  );
  assert.equal(php, 'TypeNames\\Order');
});

test('event/model collisions use WebhookEvent fallback and double collisions fail', (t) => {
  const schema = { type: 'object', properties: { other: { type: 'string' } } };
  const f = fixture(t, { OrderPaidEvent: schema });
  assert.match(f.declarations, /type OrderPaidWebhookEvent\b/);
  assert.throws(
    () => fixture(t, { OrderPaidEvent: schema, OrderPaidWebhookEvent: schema }),
    /collides/,
  );
});

test('request suffix guard keeps Request and appends it once otherwise', () => {
  const names = modelNames([
    'CheckoutBuyerFieldsRequestInput',
    'CustomerUpdateRequestInput',
    'PaymentIntentConfirmRequestInput',
    'AddressInput',
  ]);
  assert.equal(names.get('CheckoutBuyerFieldsRequestInput'), 'CheckoutBuyerFieldsRequest');
  assert.equal(names.get('CustomerUpdateRequestInput'), 'CustomerUpdateRequest');
  assert.equal(names.get('PaymentIntentConfirmRequestInput'), 'PaymentIntentConfirmRequest');
  assert.equal(names.get('AddressInput'), 'AddressRequest');
});
