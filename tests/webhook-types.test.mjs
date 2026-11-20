import { readReference } from './helpers/package-docs.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { OutputBaselines, runtimeEntries } from './helpers/output-baselines.mjs';
import ts from 'typescript';
import { loadContract, render, generate, preview } from '../dist/index.js';
import { compileSdkContract } from '../dist/target-plan.js';
import { compareCompiledContracts } from '../dist/compiled-compatibility.js';
import { restoreCompiledSnapshot, storeCompiledSnapshot } from '../dist/compiled-record.js';
import { measureWebhookTypes } from './helpers/webhook-types.mjs';

const dir = mkdtempSync(join(tmpdir(), 'sdk-webhook-types-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const payment = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] };
const envelope = {
  type: 'object',
  properties: { id: { type: 'string' }, type: { type: 'string' }, data: payment },
  required: ['id', 'type', 'data'],
};
let sequence = 0;
function fixture({
  events = { 'payment.updated': envelope },
  typeField = 'type',
  model = 'Payment',
  schemas = {},
  responseSchema,
  targets = ['node', 'php'],
} = {}) {
  const root = join(dir, String(sequence++));
  mkdirSync(root);
  const api = join(root, 'api.json');
  const config = join(root, 'sdk.json');
  writeFileSync(
    api,
    JSON.stringify({
      openapi: '3.1.0',
      info: { title: 'Webhook types', version: '1' },
      components: { schemas: { [model]: payment, ...schemas } },
      paths: {
        '/value': {
          get: {
            operationId: 'readValue',
            responses: {
              200: {
                description: 'Value',
                content: {
                  'application/json': {
                    schema: responseSchema ?? { $ref: '#/components/schemas/' + model },
                  },
                },
              },
            },
          },
        },
      },
    }),
  );
  writeFileSync(
    config,
    JSON.stringify({
      version: '1.0.0',
      targets,
      requests: { style: 'object' },
      responses: { return: 'result' },
      npm: { name: '@example/webhook-types' },
      composer: { name: 'example/webhook-types', namespace: 'Example\\WebhookTypes' },
      operations: { readValue: { resource: 'webhookEvent', method: 'retrieve' } },
      webhook: {
        algorithm: 'hmac-sha256',
        header: 'X-Signature',
        timestampHeader: 'X-Timestamp',
        separator: '.',
        toleranceSeconds: 300,
        typeField,
        events,
      },
    }),
  );
  return { root, api, config, output: join(root, 'output'), load: () => loadContract(api, config) };
}
function typecheck(f, source) {
  const file = join(f.output, 'node/consumer.ts');
  writeFileSync(file, source);
  const result = spawnSync(
    process.execPath,
    [
      resolve('node_modules/typescript/bin/tsc'),
      '--noEmit',
      '--strict',
      '--target',
      'es2022',
      '--module',
      'nodenext',
      '--typeRoots',
      resolve('node_modules/@types'),
      file,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
}
const equals = `type Equals<A, B> = [A] extends [B] ? [B] extends [A] ? true : false : false;
type Assert<T extends true> = T;`;

test('root names, independent result/envelope types, exhaustive narrowing and unknown events compile with pinned tsc', () => {
  const f = fixture({ events: { 'payment.updated': envelope, 'payment.deleted': envelope } });
  const c = f.load();
  generate(c, f.output);
  typecheck(
    f,
    `import {Client,verifyWebhook} from './index.js';
import type {Payment,VerifiedWebhook,KnownWebhookEvent,PaymentUpdatedEvent,PaymentDeletedEvent} from './index.js';
${equals}
// Exact alias identity as well as independent structural expectations.
type Identical<A,B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type ReturnAlias = Assert<Identical<ReturnType<Client['verifyWebhook']>,VerifiedWebhook>>;
type StandaloneAlias = Assert<Identical<ReturnType<typeof verifyWebhook>,VerifiedWebhook>>;
type ReturnShape = Assert<Equals<VerifiedWebhook,
 {known:true;event:{data:Payment;id:string;type:'payment.updated'}|{data:Payment;id:string;type:'payment.deleted'}}|{known:false;event:unknown;reason:'unknown_event'|'unmatched_envelope'}>>;
type EventShape = Assert<Equals<PaymentUpdatedEvent,{data:Payment;id:string;type:'payment.updated'}>>;
type Union = Assert<Equals<KnownWebhookEvent,PaymentUpdatedEvent|PaymentDeletedEvent>>;
type Payload = Assert<Equals<PaymentUpdatedEvent['data'],Payment>>;
declare const verified: VerifiedWebhook;
// @ts-expect-error Check known before field access.
verified.event.data;
if (verified.known) {
 // @ts-expect-error Known deliveries have no reason.
 verified.reason;
 const event = verified.event;
 switch(event.type) {
  case 'payment.updated': { const updated:PaymentUpdatedEvent=event; break; }
  case 'payment.deleted': { const deleted:PaymentDeletedEvent=event; break; }
  default: { const exhaustive:never=event; }
 }
 // @ts-expect-error Undeclared event literals are rejected.
 const undeclared:KnownWebhookEvent={id:'evt_fixture',type:'payment.created',data:{id:'p_fixture'}};
} else {
 const reason:'unknown_event'|'unmatched_envelope'=verified.reason;
 type Unknown = Assert<Equals<typeof verified.event,unknown>>;
 // @ts-expect-error Unknown authenticated events require validation.
 verified.event.id;
}
// @ts-expect-error Named event types are root-only, even for resource webhookEvent.
import type {PaymentUpdatedEvent as ResourceEvent} from './resources/webhookEvent.js';
// @ts-expect-error Root union is not a resource export.
import type {KnownWebhookEvent as ResourceUnion} from './resources/webhookEvent.js';
// @ts-expect-error Verifier result is not a resource export.
import type {VerifiedWebhook as ResourceVerified} from './resources/webhookEvent.js';
// @ts-expect-error Private helpers are not root exports.
import type {_SdkWebhookHeaders} from './index.js';
`,
  );
  const plan = compileSdkContract(c).plan;
  assert.deepEqual(Object.keys(plan.node.eventTypes), ['payment.deleted', 'payment.updated']);
  assert.match(
    plan.node.eventDeclarations,
    /KnownWebhookEvent = PaymentDeletedEvent \| PaymentUpdatedEvent;/,
  );
  assert.deepEqual(plan.node.eventTypes, plan.php.eventModels);
  const measured = measureWebhookTypes(
    join(f.output, 'node'),
    plan.node.eventTypes,
    plan.php.eventModels,
    'type',
  );
  assert.equal(measured.diagnostics, 0);
  const root = readFileSync(join(f.output, 'node/index.d.ts'), 'utf8');
  for (const name of [
    'VerifiedWebhook',
    'KnownWebhookEvent',
    ...Object.values(plan.node.eventTypes),
  ])
    assert.ok(root.includes('export type { ' + name + ' }'));
  const guide = readFileSync(join(f.output, 'node/RUNTIME.md'), 'utf8');
  assert.match(guide, /function handleKnown\(event: KnownWebhookEvent\)/);
  assert.match(guide, /const verified: VerifiedWebhook/);
  assert.match(guide, /Extract<KnownWebhookEvent/);
  assert.match(guide, /\['data'\]/);
  assert.match(readReference(join(f.output, 'node')), /return type is `VerifiedWebhook`/);
});

test('dotted event paths use named types and Extract, while oneOf envelopes remain closed unions', () => {
  const nested = {
    ...envelope,
    properties: {
      ...envelope.properties,
      type: undefined,
      meta: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    },
    required: ['id', 'data', 'meta'],
  };
  const f = fixture({
    typeField: 'meta.name',
    events: { 'payment.updated': nested, 'payment.deleted': nested },
  });
  generate(f.load(), f.output);
  typecheck(
    f,
    `import type {KnownWebhookEvent,PaymentUpdatedEvent} from './index.js';
${equals}
type Selected = Extract<KnownWebhookEvent,{meta:{name:'payment.updated'}}>;
type Named = Assert<Equals<Selected,PaymentUpdatedEvent>>;
declare const event:Selected;
const tag:'payment.updated'=event.meta.name;
const id:string=event.data.id;
`,
  );
  const variant = (audience) => ({
    ...envelope,
    properties: {
      ...envelope.properties,
      audience: { type: 'string', const: audience },
      [audience + 'Only']: { type: 'string' },
    },
    required: [...envelope.required, 'audience', audience + 'Only'],
  });
  const multi = fixture({
    events: {
      'payment.updated': { oneOf: [variant('merchant'), variant('partner')] },
      'payment.deleted': envelope,
    },
  });
  const c = multi.load();
  generate(c, multi.output);
  typecheck(
    multi,
    `import type {KnownWebhookEvent,PaymentUpdatedEvent,Payment} from './index.js';
${equals}
type Shape = Assert<Equals<PaymentUpdatedEvent,
 {id:string;type:'payment.updated';data:Payment;audience:string;merchantOnly:string}|{id:string;type:'payment.updated';data:Payment;audience:string;partnerOnly:string}>>;
declare const event:KnownWebhookEvent;
switch(event.type) {
 case 'payment.updated': { const multi:PaymentUpdatedEvent=event; break; }
 case 'payment.deleted': break;
 default: { const exhaustive:never=event; }
}
`,
  );
  assert.equal(compileSdkContract(c).plan.php.eventModels['payment.updated'], undefined);
});

test('PHP verifies both named event_source variants and exposes their types to consumers', () => {
  const variant = (title, eventSource, extra) => ({
    title,
    allOf: [
      { $ref: '#/components/schemas/OrderEnvelope' },
      {
        required: ['event_source', extra],
        properties: {
          event_source: { const: eventSource },
          [extra]: { type: 'string' },
        },
      },
    ],
  });
  const f = fixture({
    events: {},
    typeField: 'event_type',
    schemas: {
      OrderEnvelope: {
        type: 'object',
        properties: { event_type: { const: 'order.paid' } },
        required: ['event_type'],
      },
      MerchantOrder: {
        ...variant('Merchant', 'merchant', 'merchant_id'),
        if: {
          required: ['auxiliary'],
          properties: { auxiliary: { const: 5.25 } },
        },
        else: { required: ['other_field'] },
      },
      InstalledOrder: variant('Installed merchants', 'installed_merchants', 'partner_app_id'),
    },
  });
  const ref = (name) => '#/components/schemas/' + name;
  const api = JSON.parse(readFileSync(f.api));
  api.webhooks = {
    'order.paid': {
      post: {
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                discriminator: {
                  propertyName: 'event_source',
                  mapping: {
                    merchant: ref('MerchantOrder'),
                    installed_merchants: ref('InstalledOrder'),
                  },
                },
                oneOf: [{ $ref: ref('MerchantOrder') }, { $ref: ref('InstalledOrder') }],
              },
            },
          },
        },
      },
    },
  };
  writeFileSync(f.api, JSON.stringify(api));
  generate(f.load(), f.output);
  const secret = 'synthetic-secret';
  const timestamp = 1700000000;
  const sign = (event) => {
    const raw = JSON.stringify(event);
    const signature = createHmac('sha256', secret)
      .update(timestamp + '.' + raw)
      .digest('hex');
    return [raw, { 'X-Signature': signature, 'X-Timestamp': String(timestamp) }];
  };
  const events = [
    {
      event_type: 'order.paid',
      event_source: 'merchant',
      merchant_id: 'merchant_example',
      auxiliary: 5.25,
    },
    {
      event_type: 'order.paid',
      event_source: 'installed_merchants',
      partner_app_id: 'partner_example',
    },
    { event_type: 'order.unknown', event_source: 'merchant', merchant_id: 'merchant_example' },
  ];
  const phpRoot = join(f.output, 'php');
  const run = spawnSync(
    'php',
    [
      '-r',
      String.raw`require $argv[1].'/src/Client.php';
use Example\WebhookTypes\{Client, ClientOptions, Webhooks};
$client = new Client(new ClientOptions(baseUrl: 'https://example.invalid'));
$timestamp = (int) $argv[2];
$secret = $argv[3];
foreach (json_decode(stream_get_contents(STDIN), true, 512, JSON_THROW_ON_ERROR) as [$raw, $headers]) {
    $options = ['secrets' => $secret, 'now_seconds' => $timestamp];
    $verified = [
        Webhooks::verify($raw, $headers, $secret, $timestamp),
        $client->verifyWebhook($raw, $headers, $secret, $timestamp),
        Webhooks::verifyDelivery($raw, $headers, $options),
        $client->verifyWebhookDelivery($raw, $headers, $options),
    ];
    $result[] = array_map(fn($delivery) => [
        get_class($delivery['event']),
        $delivery['known'],
        $delivery['reason'] ?? null,
        $delivery['event'],
        $delivery['signing_method'] ?? null,
    ], $verified);
}
echo json_encode($result, JSON_THROW_ON_ERROR);`,
      phpRoot,
      String(timestamp),
      secret,
    ],
    { input: JSON.stringify(events.map(sign)), encoding: 'utf8' },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(
    JSON.parse(run.stdout),
    [
      ['Example\\WebhookTypes\\OrderPaidMerchantEvent', true, null],
      ['Example\\WebhookTypes\\OrderPaidInstalledMerchantsEvent', true, null],
      ['stdClass', false, 'unknown_event'],
    ].map(([name, known, reason], i) => {
      // Untyped fractions keep their exact JSON spelling as a string in PHP.
      const event = i === 0 ? { ...events[i], auxiliary: '5.25' } : events[i];
      return [null, null, 'hmac', 'hmac'].map((method) => [name, known, reason, event, method]);
    }),
  );

  const consumer = join(f.root, 'consumer.php');
  writeFileSync(
    consumer,
    String.raw`<?php
use Example\WebhookTypes\{Client, OrderPaidInstalledMerchantsEvent, OrderPaidMerchantEvent, Webhooks};

/** @param OrderPaidMerchantEvent|OrderPaidInstalledMerchantsEvent|stdClass|array<array-key, mixed> $event */
function accountId(OrderPaidMerchantEvent|OrderPaidInstalledMerchantsEvent|stdClass|array $event): ?string {
    return match (true) {
        $event instanceof OrderPaidMerchantEvent => $event->getMerchantId(),
        $event instanceof OrderPaidInstalledMerchantsEvent => $event->getPartnerAppId(),
        default => null,
    };
}
function consume(Client $client, string $raw, string $secret): void {
    foreach ([
        Webhooks::verify($raw, [], $secret),
        $client->verifyWebhook($raw, [], $secret),
        Webhooks::verifyDelivery($raw, [], ['secrets' => $secret]),
        $client->verifyWebhookDelivery($raw, [], ['secrets' => $secret]),
    ] as $result) {
        if ($result['known']) accountId($result['event']);
    }
}
`,
  );
  const analysis = spawnSync(
    'php',
    [
      resolve('.generated/phpstan-vendor/bin/phpstan'),
      'analyse',
      '--level=max',
      '--no-progress',
      '--error-format=raw',
      '--autoload-file=' + join(phpRoot, 'src/Client.php'),
      consumer,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(analysis.status, 0, analysis.stdout + analysis.stderr);

  const descriptor = join(phpRoot, 'src/descriptors/webhook.json');
  const original = readFileSync(descriptor, 'utf8');
  for (const [patch, message] of [
    [{ field: 'missing_tag' }, 'Invalid webhook discriminator for order.paid'],
    [
      { models: { unknown_tag: 'OrderPaidMerchantEvent' } },
      'Invalid webhook variant binding for order.paid',
    ],
    [{ models: { merchant: 'MissingEvent' } }, 'Invalid webhook variant binding for order.paid'],
  ]) {
    const group = JSON.parse(original);
    Object.assign(group.webhook.eventVariants['order.paid'], patch);
    writeFileSync(descriptor, JSON.stringify(group));
    const invalid = spawnSync(
      'php',
      [
        '-r',
        String.raw`require $argv[1].'/src/Client.php';
try {
    Example\WebhookTypes\SchemaRegistry::source()->webhook();
    exit(1);
} catch (InvalidArgumentException $error) {
    echo $error->getMessage();
}`,
        phpRoot,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(invalid.status, 0, invalid.stderr);
    assert.equal(invalid.stdout, message);
  }
  writeFileSync(descriptor, original);
});

test('configured webhooks without events export never and a named result', () => {
  const f = fixture({ events: {} });
  generate(f.load(), f.output);
  typecheck(
    f,
    `import {Client} from './index.js';
import type {KnownWebhookEvent,VerifiedWebhook} from './index.js';
${equals}
type Empty=Assert<Equals<KnownWebhookEvent,never>>;
type Return=Assert<Equals<ReturnType<Client['verifyWebhook']>,VerifiedWebhook>>;
`,
  );
});

test('webhook result names remain ordinary model exports when verification is not configured', () => {
  const f = fixture({ model: 'VerifiedWebhook' });
  const c = f.load();
  delete c.config.webhook;
  c.operations[0].resource = 'verifiedWebhook';
  generate(c, f.output);
  assert.match(
    readFileSync(join(f.output, 'node/index.d.ts'), 'utf8'),
    /export \{ VerifiedWebhook \}/,
  );
  typecheck(
    f,
    `import type {VerifiedWebhook} from './index.js';
import type {VerifiedWebhook as Scoped} from './resources/verifiedWebhook.js';
${equals}
type Preserved=Assert<Equals<VerifiedWebhook,Scoped>>;
`,
  );
});

for (const targets of [['node', 'php'], ['php']]) {
  for (const [kind, eventSchema] of [
    ['object', envelope],
    [
      'multi-variant',
      {
        oneOf: [
          envelope,
          {
            ...envelope,
            properties: { ...envelope.properties, audience: { type: 'string' } },
            required: [...envelope.required, 'audience'],
          },
        ],
      },
    ],
  ])
    test(`${targets.join('+')} generation rejects an inline response colliding with the ${kind} event type`, () => {
      const responseSchema = {
        type: 'object',
        required: ['event'],
        properties: {
          event: {
            type: 'object',
            required: ['responseId'],
            properties: { responseId: { type: 'string' } },
          },
        },
      };
      const f = fixture({
        targets,
        responseSchema,
        events: { 'webhook_event.retrieve.response': eventSchema },
      });
      assert.throws(() => generate(f.load(), f.output), /collid|collision/i);
      const control = fixture({
        targets,
        responseSchema,
        events: { 'another.response': eventSchema },
      });
      generate(control.load(), control.output);
      const models = JSON.parse(
        readFileSync(join(control.output, 'php/src/descriptors/models.json')),
      );
      assert.equal(models.filter((name) => name === 'WebhookEventRetrieveResponse').length, 1);
    });
}

for (const target of ['node', 'php']) {
  for (const [name, options, expected] of [
    [
      'duplicate',
      { events: { 'a.b': envelope, a_b: envelope } },
      /config\/webhook\/events\/a_b.*webhook event type name `ABEvent` is shared by `a.b` and `a_b`/s,
    ],
    [
      'multi-variant duplicate',
      { events: { 'a.b': { oneOf: [envelope, payment] }, a_b: envelope } },
      /webhook event type name `ABEvent` is shared/,
    ],
    [
      'escaped duplicate',
      { events: { a_b: envelope, 'a/b': envelope } },
      /config\/webhook\/events\/a~1b/,
    ],
    [
      'unusable',
      { events: { '***': envelope } },
      /config\/webhook\/events\/\*\*\*.*ASCII letters or digits/s,
    ],
    ['result collision', { model: 'VerifiedWebhook' }, /generated type collision: VerifiedWebhook/],
    [
      'union collision',
      { model: 'KnownWebhookEvent' },
      /generated type collision: KnownWebhookEvent/,
    ],
    [
      'event collision',
      { model: 'PaymentUpdatedEvent', schemas: { PaymentUpdatedWebhookEvent: payment } },
      /collides/,
    ],
  ])
    test(`${target}-only diagnosis rejects ${name}`, () => {
      const f = fixture({ ...options, targets: [target] });
      const result = spawnSync(process.execPath, ['dist/cli.js', 'diagnose', f.api, f.config], {
        encoding: 'utf8',
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr + result.stdout, expected);
    });
}

test('allOf uses unchanged named models but preserves closure for alternative models', () => {
  const f = fixture({ events: { 'payment.updated': { allOf: [envelope, payment] } } });
  const c = f.load();
  const files = render(c);
  assert.match(files.get('node/declarations/PaymentUpdatedEvent.d.ts'), /Payment/);
  generate(c, f.output);
  typecheck(
    f,
    `import type {PaymentUpdatedEvent,Payment} from './index.js';
${equals}
type Shape=Assert<Equals<PaymentUpdatedEvent,{id:string;type:'payment.updated';data:Payment}>>;
`,
  );
  // A same-value alternative must be closed even when it has a component identity.
  const closed = structuredClone(c);
  const alternatives = {
    oneOf: [
      envelope,
      { type: 'object', properties: { count: { type: 'number' } }, required: ['count'] },
    ],
  };
  closed.models.Alternative = alternatives;
  closed.definitions.Alternative = alternatives;
  closed.config.webhook.events['payment.updated'] = { allOf: [alternatives] };
  const plan = compileSdkContract(closed).plan;
  assert.doesNotMatch(plan.node.eventDeclarations, /\(Alternative\)/);
  assert.doesNotMatch(plan.node.eventDeclarations, /\| \(object\)/);
  closed.models.Conjunct = { allOf: [{ 'x-sdk-ref': 'Alternative' }] };
  closed.definitions.Conjunct = closed.models.Conjunct;
  closed.config.webhook.events['payment.updated'] = { allOf: [closed.models.Conjunct] };
  const referenced = compileSdkContract(closed).plan;
  assert.doesNotMatch(referenced.node.eventDeclarations, /\(Conjunct\)/);
  assert.doesNotMatch(referenced.node.eventDeclarations, /\| \(object\)/);
});

test('shared allOf envelopes keep many-name enums out of webhook-owned declarations', () => {
  const events = Array.from({ length: 20 }, (_, index) => 'payment.event' + index);
  const base = {
    ...envelope,
    properties: { ...envelope.properties, type: { type: 'string', enum: events } },
  };
  const f = fixture({
    model: 'Envelope',
    schemas: { Envelope: base, Payment: payment },
    events: Object.fromEntries(
      events.map((event) => [
        event,
        {
          allOf: [base, { properties: { channel: { type: 'string' } }, required: ['channel'] }],
        },
      ]),
    ),
  });
  const c = f.load();
  generate(c, f.output);
  const plan = compileSdkContract(c).plan;
  const measured = measureWebhookTypes(
    join(f.output, 'node'),
    plan.node.eventTypes,
    plan.php.eventModels,
    'type',
  );
  assert.equal(measured.events, 20);
  assert.equal(measured.diagnostics, 0);
});

test('source component hints keep referenced webhook envelopes shared', () => {
  const events = Array.from({ length: 20 }, (_, index) => 'payment.event' + index);
  const base = {
    ...envelope,
    properties: { ...envelope.properties, type: { type: 'string', enum: events } },
  };
  const f = fixture({
    model: 'Envelope',
    schemas: { Envelope: base, Payment: payment },
    events: {},
  });
  const api = JSON.parse(readFileSync(f.api));
  api.webhooks = Object.fromEntries(
    events.map((event, index) => [
      event,
      {
        post: {
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  allOf: [
                    index % 2 ? { $ref: '#/components/schemas/Envelope' } : base,
                    {
                      properties: { type: { const: event }, channel: { type: 'string' } },
                      required: ['type', 'channel'],
                    },
                  ],
                },
              },
            },
          },
        },
      },
    ]),
  );
  writeFileSync(f.api, JSON.stringify(api));
  const config = JSON.parse(readFileSync(f.config));
  config.schemaSharing = 'named';
  writeFileSync(f.config, JSON.stringify(config));
  const c = f.load();
  generate(c, f.output);
  const plan = compileSdkContract(c).plan;
  const measured = measureWebhookTypes(
    join(f.output, 'node'),
    plan.node.eventTypes,
    plan.php.eventModels,
    'type',
  );
  assert.equal(measured.events, 20);
  assert.equal(measured.diagnostics, 0);
});

test('shared conjuncts inside oneOf preserve typeless payload constraints', () => {
  const names = Array.from({ length: 20 }, (_, index) => 'payment.event' + index);
  const base = {
    type: 'object',
    properties: {
      id: { type: 'string' },
      type: { type: 'string', enum: names },
      data: { type: 'object', additionalProperties: true },
    },
    required: ['id', 'type', 'data'],
  };
  const variant = (field) => ({
    allOf: [
      base,
      {
        properties: {
          data: { type: 'object', properties: { [field]: { type: 'string' } }, required: [field] },
        },
        required: ['data'],
      },
    ],
  });
  const f = fixture({
    model: 'Envelope',
    schemas: { Envelope: base },
    events: Object.fromEntries(
      names.map((event) => [event, { oneOf: [variant('merchant'), variant('partner')] }]),
    ),
  });
  const c = f.load();
  generate(c, f.output);
  typecheck(
    f,
    `import type {PaymentEvent0Event} from './index.js';
${equals}
type Shape=Assert<Equals<PaymentEvent0Event,
 {id:string;type:'payment.event0';data:{merchant:string}}|{id:string;type:'payment.event0';data:{partner:string}}>>;
`,
  );
  const plan = compileSdkContract(c).plan;
  assert.doesNotMatch(
    plan.node.eventDeclarations,
    /null \| boolean \| number \| string \| unknown\[\]/,
  );
  assert.equal(
    measureWebhookTypes(join(f.output, 'node'), plan.node.eventTypes, plan.php.eventModels, 'type')
      .diagnostics,
    0,
  );
});

test('old compiled records review the declaration upgrade; recorded removal/rename is breaking', () => {
  const f = fixture();
  const c = f.load();
  const current = compileSdkContract(c).plan;
  const previous = structuredClone(current);
  delete previous.node.eventTypes;
  previous.node.eventType = '(_SdkWebhookEnvelope0 & { "type": "payment.updated" })';
  previous.node.eventDeclarations =
    'type _SdkWebhookEnvelope0 = {id:string;type:string;data:Payment};\n';
  const snapshot = (plan) => ({
    plan,
    runtimeIdentity: { node: '0'.repeat(64), php: '0'.repeat(64) },
  });
  const old = restoreCompiledSnapshot(storeCompiledSnapshot(snapshot(previous))).plan;
  const findings = compareCompiledContracts(old, current);
  assert.deepEqual(
    findings.map((f) => [f.severity, f.subject]),
    [
      ['review', 'webhook'],
      ['review', 'compiled codecs'],
    ],
  );
  assert.deepEqual(compareCompiledContracts(current, structuredClone(current)), []);
  for (const eventTypes of [{}, { 'payment.updated': 'PaymentChangedEvent' }]) {
    const next = structuredClone(current);
    next.node.eventTypes = eventTypes;
    assert.ok(
      compareCompiledContracts(current, next).some(
        (f) =>
          f.severity === 'breaking' &&
          f.subject === 'webhook.payment.updated' &&
          f.message === 'Exported webhook event type removed or renamed',
      ),
    );
  }
  for (const eventTypes of [null, [], { 'payment.updated': 42 }]) {
    const invalid = structuredClone(current);
    invalid.node.eventTypes = eventTypes;
    assert.throws(
      () => restoreCompiledSnapshot(storeCompiledSnapshot(snapshot(invalid))),
      /node.eventTypes/,
    );
  }
  generate(c, f.output);
  const recordPath = join(f.output, '.sdk-generator.json');
  const record = JSON.parse(readFileSync(recordPath));
  // Simulate a record written before draft/release baseline tracking.
  delete record.baseline;
  record.compiled = storeCompiledSnapshot({
    ...restoreCompiledSnapshot(record.compiled),
    plan: previous,
  });
  writeFileSync(recordPath, JSON.stringify(record));
  assert.deepEqual(
    preview(c, f.output).compatibility.map((f) => [f.severity, f.subject]),
    [
      ['review', 'webhook'],
      ['review', 'compiled codecs'],
    ],
  );
});

test('JavaScript, descriptors, complete PHP output and existing root exports retain reviewed bytes/names', () => {
  const baseline = JSON.parse(readFileSync('tests/fixtures/webhook-output-baseline.json'));
  const checked = new OutputBaselines();
  for (const fixture of baseline.fixtures) {
    const c = loadContract(fixture.api, fixture.config);
    const files = render(c);
    checked.check(
      fixture.name + '/nodeRuntime',
      runtimeEntries(files, 'node'),
      fixture.nodeRuntimeSha256,
    );
    checked.check(fixture.name + '/php', runtimeEntries(files, 'php'), fixture.phpSha256);
    checked.check(
      fixture.name + '/phpRuntime',
      runtimeEntries(files, 'php', true),
      fixture.phpRuntimeSha256,
    );
    const root = ts.createSourceFile(
      'index.d.ts',
      files.get('node/index.d.ts'),
      ts.ScriptTarget.Latest,
      true,
    );
    const exports = new Set(
      root.statements
        .filter(ts.isExportDeclaration)
        .filter((statement) => statement.exportClause && ts.isNamedExports(statement.exportClause))
        .flatMap((statement) =>
          statement.exportClause.elements.map((element) => element.name.text),
        ),
    );
    for (const name of fixture.rootExports) assert.ok(exports.has(name), fixture.name + ' ' + name);
    const plan = compileSdkContract(c).plan;
    for (const [event, name] of Object.entries(plan.php.eventModels))
      assert.equal(plan.node.eventTypes[event], name);
    for (const target of ['node', 'php']) {
      const selected = structuredClone(c);
      selected.config.targets = [target];
      const single = render(selected);
      checked.check(
        fixture.name + '/' + target + 'Only',
        runtimeEntries(single, target),
        fixture.singleTarget[target],
      );
      for (const [path, content] of files)
        if (
          path.startsWith(target + '/') &&
          (path.endsWith('.d.ts') || path === 'php/src/Client.php')
        )
          assert.equal(single.get(path), content, path);
    }
  }
  checked.finish();
});
