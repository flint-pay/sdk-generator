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
    properties: {
      id: { type: 'string' },
      name: { type: 'string', minLength: 1, maxLength: 255 },
      issued_at: { type: 'string', format: 'date-time' },
      amount: { type: 'integer', format: 'int64' },
      line_items: {
        type: 'array',
        items: {
          type: 'object',
          required: ['id', 'purchased_gift_cards', 'modifiers'],
          properties: {
            id: { type: 'string' },
            purchased_gift_cards: { type: 'array', items: { type: 'string' } },
            nullable_entries: {
              type: 'array',
              items: {
                type: ['object', 'null'],
                required: ['id'],
                properties: { id: { type: 'string' } },
              },
            },
            modifiers: {
              type: 'array',
              items: {
                type: 'object',
                required: ['name', 'amount'],
                properties: {
                  name: { type: 'string' },
                  amount: { type: 'integer', format: 'int64' },
                },
              },
            },
          },
        },
      },
      money: {
        type: 'object',
        required: ['amount', 'currency'],
        properties: {
          amount: { type: 'integer', format: 'int64' },
          currency: { type: 'string' },
        },
      },
    },
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
  assert.doesNotMatch(f.declarations, /Partial<Customer>/);
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
  assert.doesNotMatch(f.declarations, /Partial<PaymentIntent>/);
  const classes = readdirSync(join(f.output, 'php/src/classes'));
  for (const name of ['Order', 'OrderPaidMerchantEvent', 'CustomerUpdatedEvent'])
    assert.ok(classes.includes(name + '.php'), name);
  assert.ok(!classes.some((n) => /Response201/.test(n)));
  const consumer = join(f.output, 'node/consumer.ts');
  writeFileSync(
    consumer,
    `import {Client,type KnownWebhookEvent,type CustomerUpdatedEvent,type OrderPaidMerchantEvent,type OrderPaidInstalledMerchantsEvent,type CheckoutBuyerFieldsRequestInput,type CustomerUpdateRequestInput,type PaymentIntentConfirmRequestInput} from './index.js';
declare const event:KnownWebhookEvent;
if(event.event_type==='customer.updated') {const selected:CustomerUpdatedEvent=event;const oldName:string|null|undefined=event.data.previous_attributes?.name;
const oldAmount:string|null|undefined=event.data.previous_attributes?.amount;
const oldMoneyAmount:string|null|undefined=event.data.previous_attributes?.money?.amount;
const absent:NonNullable<CustomerUpdatedEvent['data']['previous_attributes']>={name:null,amount:null,money:null};
const partialNested:NonNullable<CustomerUpdatedEvent['data']['previous_attributes']>={money:{currency:'USD'},line_items:[{modifiers:[{amount:'456'}]}]};
// @ts-expect-error Exact numeric fields decode as strings, including previous values.
const rawAmount:number=event.data.previous_attributes?.money?.amount;
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

test('previous attributes normalize nested values and allow absent fields in both verifiers', async (t) => {
  const f = fixture(t);
  const { verifyWebhookAsync } = await import(pathToFileURL(join(f.output, 'node/index.js')));
  const now = 1_700_000_000;
  const previousCases = [
    undefined,
    {},
    { name: null, issued_at: null, amount: null, money: null },
    { name: 'Before', amount: 123, money: { amount: 456, currency: 'USD' } },
    { amount: 9007199254740993n, future_field: { enabled: true } },
    { money: { currency: 'USD' } },
    { money: { amount: null } },
    { line_items: [{ id: 'li_fixture', modifiers: [{ amount: 456 }] }, {}] },
    { line_items: [{ purchased_gift_cards: null, modifiers: [{ name: null }] }] },
    { line_items: [{ nullable_entries: [null, {}] }] },
  ];
  const cases = previousCases.map((previous) => {
    const raw = JSON.stringify(
      {
        event_type: 'customer.updated',
        data: {
          object: { id: 'cus_fixture', name: 'After' },
          ...(previous === undefined ? {} : { previous_attributes: previous }),
        },
      },
      (_, value) => (typeof value === 'bigint' ? 'EXACT_INTEGER' : value),
    ).replace('"EXACT_INTEGER"', '9007199254740993');
    return {
      raw,
      headers: {
        'X-Timestamp': String(now),
        'X-Signature': createHmac('sha256', 'synthetic')
          .update(now + '.' + raw)
          .digest('hex'),
      },
    };
  });
  const expected = [
    undefined,
    {},
    { name: null, issued_at: null, amount: null, money: null },
    { name: 'Before', amount: '123', money: { amount: '456', currency: 'USD' } },
    { amount: '9007199254740993', future_field: { enabled: true } },
    { money: { currency: 'USD' } },
    { money: { amount: null } },
    { line_items: [{ id: 'li_fixture', modifiers: [{ amount: '456' }] }, {}] },
    { line_items: [{ purchased_gift_cards: null, modifiers: [{ name: null }] }] },
    { line_items: [{ nullable_entries: [null, {}] }] },
  ];
  for (const [index, sample] of cases.entries()) {
    const result = await verifyWebhookAsync(Buffer.from(sample.raw), sample.headers, {
      secrets: 'synthetic',
      nowSeconds: now,
    });
    assert.equal(result.known, true, sample.raw);
    assert.deepEqual(
      result.event.data.previous_attributes === undefined
        ? undefined
        : JSON.parse(JSON.stringify(result.event.data.previous_attributes)),
      expected[index],
    );
    assert.equal(Object.hasOwn(result.event.data, 'previous_attributes'), index !== 0);
  }
  const php = String.raw`require $argv[1].'/src/Client.php';
$cases=json_decode($argv[2],true,512,JSON_THROW_ON_ERROR);$rows=[];
$c=new TypeNames\Client(new TypeNames\ClientOptions('https://example.invalid'));
foreach($cases as $case){
  $v=$c->verifyWebhookDelivery($case['raw'],$case['headers'],['secrets'=>'synthetic','now_seconds'=>1700000000]);
  if(!$v['known'])throw new RuntimeException('unmatched envelope');
  $rows[]=$v['event'];
}
echo json_encode($rows,JSON_THROW_ON_ERROR);`;
  const rows = JSON.parse(
    execFileSync('php', ['-r', php, join(f.output, 'php'), JSON.stringify(cases)], {
      encoding: 'utf8',
    }),
  );
  for (const [index, row] of rows.entries()) {
    assert.deepEqual(row.data.previous_attributes, expected[index]);
    assert.equal(Object.hasOwn(row.data, 'previous_attributes'), index !== 0);
  }
  // Partial fields still validate supplied scalar types.
  const invalid = cases[0].raw.replace(
    '"object":',
    '"previous_attributes":{"money":{"amount":false}},"object":',
  );
  const invalidHeaders = {
    'X-Timestamp': String(now),
    'X-Signature': createHmac('sha256', 'synthetic')
      .update(now + '.' + invalid)
      .digest('hex'),
  };
  await assert.rejects(
    verifyWebhookAsync(Buffer.from(invalid), invalidHeaders, {
      secrets: 'synthetic',
      nowSeconds: now,
    }),
    /money/,
  );
});

test('previous attributes share named and recursive array projections without changing current objects', async (t) => {
  const f = fixture(t, {
    Customer: {
      type: 'object',
      required: ['id', 'name'],
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        children: { type: 'array', items: { $ref: '#/components/schemas/Customer' } },
        line_items: { type: 'array', items: { $ref: '#/components/schemas/LineItem' } },
      },
    },
    LineItem: {
      type: 'object',
      required: ['id', 'amount', 'purchased_gift_cards'],
      properties: {
        id: { type: 'string' },
        amount: { type: 'integer', format: 'int64' },
        money: { $ref: '#/components/schemas/MoneyValue' },
        maybe_money: { anyOf: [{ $ref: '#/components/schemas/MoneyValue' }, { type: 'null' }] },
        money_history: {
          type: 'array',
          items: { oneOf: [{ $ref: '#/components/schemas/MoneyValue' }, { type: 'null' }] },
        },
        purchased_gift_cards: { type: 'array', items: { type: 'string' } },
      },
    },
    MoneyValue: {
      type: 'object',
      required: ['amount', 'currency'],
      properties: {
        amount: { type: 'integer', format: 'int64' },
        currency: { type: 'string' },
      },
    },
  });
  assert.ok(f.contract.models.LineItemPreviousAttributes);
  const consumer = join(f.output, 'node/nested-previous.ts');
  writeFileSync(
    consumer,
    `import type { CustomerUpdatedEvent } from './index.js';
declare const event: CustomerUpdatedEvent;
const line = event.data.previous_attributes?.line_items?.[0];
const amount: string | null | undefined = line?.money?.amount;
const nullableAmount: string | null | undefined = line?.maybe_money?.amount;
const arrayAmount: string | null | undefined = line?.money_history?.[0]?.amount;
// @ts-expect-error Prior exact amounts remain strings.
const invalid: number = line?.money?.amount;
`,
  );
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
  const hydrated = execFileSync(
    'php',
    [
      '-r',
      String.raw`require $argv[1].'/src/Client.php';
$p = new TypeNames\CustomerUpdatedEventDataPreviousAttributes(['line_items'=>[(object)['money'=>(object)['amount'=>'9007199254740993'], 'maybe_money'=>(object)['amount'=>'123'], 'money_history'=>[(object)['amount'=>'456'], null]]]]);
$m = $p->getLineItems()[0]->getMoney();
if (!$m instanceof TypeNames\MoneyValuePreviousAttributes || !$m->hasAmount() || $m->hasCurrency() || $m->getCurrency() !== null || $m->getAmount() !== '9007199254740993') throw new RuntimeException('untyped partial money');
$line = $p->getLineItems()[0];
if (!$line->getMaybeMoney() instanceof TypeNames\MoneyValuePreviousAttributes || $line->getMaybeMoney()->getAmount() !== '123' || !$line->getMoneyHistory()[0] instanceof TypeNames\MoneyValuePreviousAttributes || $line->getMoneyHistory()[0]->getAmount() !== '456' || $line->getMoneyHistory()[1] !== null) throw new RuntimeException('untyped already-nullable money');
$n = new TypeNames\LineItemPreviousAttributes(['money'=>null, 'maybe_money'=>null]);
if (!$n->hasMaybeMoney() || $n->getMaybeMoney() !== null) throw new RuntimeException('lost nullable field');
if (!$n->hasMoney() || $n->getMoney() !== null || (new TypeNames\LineItemPreviousAttributes([]))->hasMoney()) throw new RuntimeException('lost presence');
echo 'typed';`,
      join(f.output, 'php'),
    ],
    { encoding: 'utf8' },
  );
  assert.equal(hydrated, 'typed');
  const { verifyWebhookAsync } = await import(pathToFileURL(join(f.output, 'node/index.js')));
  const verify = async (object, previous) => {
    const raw = JSON.stringify({
      event_type: 'customer.updated',
      data: { object, previous_attributes: previous },
    });
    const headers = {
      'X-Timestamp': '1700000000',
      'X-Signature': createHmac('sha256', 'synthetic')
        .update('1700000000.' + raw)
        .digest('hex'),
    };
    return verifyWebhookAsync(Buffer.from(raw), headers, {
      secrets: 'synthetic',
      nowSeconds: 1700000000,
    });
  };
  const previous = {
    children: [{ children: [{ name: null }] }],
    line_items: [
      { amount: '456', maybe_money: { amount: '123' }, money_history: [{ currency: 'USD' }, null] },
    ],
  };
  const raw = JSON.stringify({
    event_type: 'customer.updated',
    data: { object: { id: 'cus_fixture', name: 'After' }, previous_attributes: previous },
  });
  const headers = {
    'X-Timestamp': '1700000000',
    'X-Signature': createHmac('sha256', 'synthetic')
      .update('1700000000.' + raw)
      .digest('hex'),
  };
  const php = String.raw`require $argv[1].'/src/Client.php';
$c=new TypeNames\Client(new TypeNames\ClientOptions('https://example.invalid'));
$v=$c->verifyWebhookDelivery($argv[2],json_decode($argv[3],true),['secrets'=>'synthetic','now_seconds'=>1700000000]);
if(!$v['known'])throw new RuntimeException('unmatched recursive envelope');
echo json_encode($v['event'],JSON_THROW_ON_ERROR);`;
  assert.deepEqual(
    JSON.parse(
      execFileSync('php', ['-r', php, join(f.output, 'php'), raw, JSON.stringify(headers)], {
        encoding: 'utf8',
      }),
    ).data.previous_attributes,
    previous,
  );
  const result = await verify({ id: 'cus_fixture', name: 'After' }, previous);
  assert.equal(result.known, true);
  assert.deepEqual(JSON.parse(JSON.stringify(result.event.data.previous_attributes)), previous);
  await assert.rejects(
    verify({ id: 'cus_fixture', name: 'After', children: [{}] }, previous),
    /name|id/,
  );
});

test('previous attributes preserve resource alternatives and conjunctive field rules', async (t) => {
  const f = fixture(t, {
    Customer: {
      allOf: [
        { anyOf: [{ required: ['a'] }, { required: ['b'] }] },
        {
          if: { properties: { status: { const: 'failed' } }, required: ['status'] },
          then: { required: ['failure_reason'] },
          else: { not: { required: ['failure_reason'] } },
        },
        {
          type: 'object',
          required: ['id', 'name'],
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            a: { type: 'string' },
            b: { type: 'string' },
            failure_reason: { type: 'string' },
            money: {
              type: 'object',
              required: ['amount'],
              properties: { amount: { type: 'integer', format: 'int64' } },
            },
          },
        },
        {
          oneOf: [
            {
              type: 'object',
              required: ['status'],
              properties: {
                status: { const: 'pending', type: 'string' },
                outcome: { type: 'string' },
              },
            },
            {
              type: 'object',
              required: ['status'],
              properties: {
                status: { const: 'succeeded', type: 'string' },
                outcome: { type: 'integer', format: 'int64' },
              },
            },
            {
              type: 'object',
              required: ['status'],
              properties: {
                status: { const: 'failed', type: 'string' },
                outcome: { type: 'boolean' },
              },
            },
          ],
        },
      ],
    },
  });
  const { verifyWebhookAsync } = await import(pathToFileURL(join(f.output, 'node/index.js')));
  const previous = [
    {},
    { status: null },
    { status: 'pending', outcome: 'waiting' },
    { status: 'succeeded', outcome: 123 },
    { status: 'failed', outcome: false },
    { money: { amount: 456 } },
    { status: null, failure_reason: null },
  ];
  const expected = previous.map((value, index) =>
    index === 3
      ? { status: 'succeeded', outcome: '123' }
      : index === 5
        ? { money: { amount: '456' } }
        : value,
  );
  const samples = previous.map((value) => {
    const raw = JSON.stringify({
      event_type: 'customer.updated',
      data: {
        object: {
          id: 'cus_fixture',
          name: 'After',
          a: 'current',
          status: 'succeeded',
          outcome: 789,
        },
        previous_attributes: value,
      },
    });
    return {
      raw,
      headers: {
        'X-Timestamp': '1700000000',
        'X-Signature': createHmac('sha256', 'synthetic')
          .update('1700000000.' + raw)
          .digest('hex'),
      },
    };
  });
  for (const [index, sample] of samples.entries()) {
    const result = await verifyWebhookAsync(Buffer.from(sample.raw), sample.headers, {
      secrets: 'synthetic',
      nowSeconds: 1700000000,
    });
    assert.equal(result.known, true, sample.raw);
    assert.deepEqual(
      JSON.parse(JSON.stringify(result.event.data.previous_attributes)),
      expected[index],
    );
  }
  const php = String.raw`require $argv[1].'/src/Client.php';
$c=new TypeNames\Client(new TypeNames\ClientOptions('https://example.invalid'));$rows=[];
foreach(json_decode($argv[2],true) as $case){
 $v=$c->verifyWebhookDelivery($case['raw'],$case['headers'],['secrets'=>'synthetic','now_seconds'=>1700000000]);
 if(!$v['known'])throw new RuntimeException('unmatched previous variant');$rows[]=$v['event'];
}echo json_encode($rows,JSON_THROW_ON_ERROR);`;
  const rows = JSON.parse(
    execFileSync('php', ['-r', php, join(f.output, 'php'), JSON.stringify(samples)], {
      encoding: 'utf8',
    }),
  );
  for (const [index, row] of rows.entries())
    assert.deepEqual(row.data.previous_attributes, expected[index]);
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
