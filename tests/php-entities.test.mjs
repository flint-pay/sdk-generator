import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { loadContract, generate, preview } from '../dist/index.js';
import { compileSdkContract } from '../dist/target-plan.js';
import { phpRepresentations } from '../dist/php-representation.js';
import { phpDocType } from '../dist/target-types.js';
import { compareCompiledContracts } from '../dist/compiled-compatibility.js';

const root = mkdtempSync(join(tmpdir(), 'sdk-php-entities-'));
after(() => rmSync(root, { recursive: true, force: true }));
let sequence = 0;
const ref = (name) => ({ $ref: '#/components/schemas/' + name });
const entity = {
  type: 'object',
  required: ['id', 'request_id', 'metadata', 'children', 'related'],
  properties: {
    id: { type: 'string' },
    request_id: { type: 'string' },
    metadata: { type: 'object', additionalProperties: { type: 'string' } },
    children: { type: 'array', items: ref('Payment') },
    related: { type: 'object', additionalProperties: ref('Payment') },
    amount: { type: 'integer', format: 'int64' },
    note: { type: ['string', 'null'] },
    secret: { type: 'string', 'x-sensitive': true },
  },
};
function fixture(
  schema = {
    allOf: [{ type: 'object', properties: { data: ref('Payment') } }, { required: ['data'] }],
  },
  events = {},
  paymentSchema = entity,
) {
  const dir = join(root, String(sequence++));
  mkdirSync(dir);
  const api = {
    openapi: '3.1.0',
    info: { title: 'Entities', version: '1' },
    components: { schemas: { Payment: paymentSchema } },
    paths: {
      '/payments': {
        get: {
          operationId: 'getPayments',
          responses: { 200: { description: 'OK', content: { 'application/json': { schema } } } },
        },
      },
    },
  };
  const config = {
    version: '1.0.0',
    npm: { name: '@example/entities' },
    composer: { name: 'example/entities', namespace: 'Example\\Entities' },
    responses: { return: 'result' },
    operations: { getPayments: { resource: 'payments', method: 'retrieve' } },
    ...(Object.keys(events).length
      ? {
          webhook: {
            algorithm: 'hmac-sha256',
            format: 'timestamped-hex',
            header: 'X-Signature',
            separator: '.',
            toleranceSeconds: 300,
            typeField: 'type',
            events,
          },
        }
      : {}),
  };
  writeFileSync(join(dir, 'api.json'), JSON.stringify(api));
  writeFileSync(join(dir, 'sdk.json'), JSON.stringify(config));
  const contract = loadContract(join(dir, 'api.json'), join(dir, 'sdk.json'));
  const output = join(dir, 'output');
  generate(contract, output);
  return { dir, contract, output };
}
const child = { id: 'child', request_id: 'req_child', metadata: {}, children: [], related: {} };
const body = {
  data: {
    id: 'pay_1',
    request_id: 'req_1',
    metadata: { 0: 'zero', label: 'demo' },
    children: [child],
    related: { first: child },
    amount: '9007199254740993',
    note: null,
    secret: 'synthetic-secret',
    future: { flag: true },
  },
};

test('nested response entities, dictionaries, presence and raw serialization agree', () => {
  const f = fixture();
  const code = String.raw`require $argv[1].'/src/Client.php';
$c = new Example\Entities\Client(new Example\Entities\ClientOptions('https://example.invalid', transport: fn($r) => ['status'=>200,'headers'=>[],'body'=>$argv[2]]));
$r=$c->payments->retrieve(); $p=$r->data->getData();
if (!$p instanceof Example\Entities\Payment || !$p->getChildren()[0] instanceof Example\Entities\Payment || !$p->getRelated()['first'] instanceof Example\Entities\Payment) throw new Exception('entities: '.get_debug_type($p).','.get_debug_type($p->getChildren()[0]).','.get_debug_type($p->getRelated()['first']));
if ($p->getRequestId() !== 'req_1' || $p->getMetadata()[0] !== 'zero' || $p->getAmount() !== '9007199254740993') throw new Exception('values');
if ($p->get('children')[0]->getId() !== 'child' || $p->children[0]->getId() !== 'child') throw new Exception('consistent access');
if (!$p->hasNote() || $p->getNote() !== null || $p->getChildren()[0]->hasNote()) throw new Exception('presence');
try { $p->getChildren()[0]->getNote(); throw new Exception('missing accepted'); } catch (Example\Entities\SdkError $e) {}
if (!$p->toArray()['related'] instanceof stdClass || !$p->getChildren()[0]->jsonSerialize()->metadata instanceof stdClass) throw new Exception('raw objects');
if ($p->getChildren()[0]->getMetadata() !== []) throw new Exception('empty map');
ob_start(); var_dump($p); $debug=ob_get_clean(); if (str_contains($debug,'synthetic-secret')) throw new Exception('redaction');
echo json_encode($r->data);`;
  const result = execFileSync(
    'php',
    [
      '-r',
      code,
      join(f.output, 'php'),
      JSON.stringify(body).replace('"9007199254740993"', '9007199254740993'),
    ],
    {
      encoding: 'utf8',
    },
  );
  assert.deepEqual(JSON.parse(result), body);
  assert.equal(preview(f.contract, f.output).changes.length, 0);
});

test('PHP declarations merge intersections and preserve dictionary values', () => {
  assert.equal(phpDocType({ allOf: [{ type: 'string' }, { minLength: 1 }] }), 'string');
  assert.equal(phpDocType({ allOf: [{ type: 'integer' }, { type: 'number' }] }), 'int');
  assert.equal(phpDocType({ allOf: [{ type: 'integer' }, { type: 'number' }] }, true), 'float');
  assert.equal(
    phpDocType({ type: 'object', additionalProperties: { type: 'string' } }),
    'array<array-key, string>|\\stdClass',
  );
  assert.equal(phpDocType({ type: 'object', additionalProperties: false }), 'array{}|object');
  assert.match(
    phpDocType({
      allOf: [{ type: 'object', properties: { id: { type: 'string' } } }, { required: ['id'] }],
    }),
    /'id': string/,
  );
});

test('nullable recursive components retain their configured entity identity', () => {
  const f = fixture(
    undefined,
    {},
    {
      type: ['object', 'null'],
      required: ['id', 'child'],
      properties: { id: { type: 'string' }, child: ref('Payment') },
    },
  );
  const code = String.raw`require $argv[1].'/src/Client.php';
$c = new Example\Entities\Client(new Example\Entities\ClientOptions('https://example.invalid', transport: fn($r) => ['status'=>200,'headers'=>[],'body'=>$argv[2]]));
$result=$c->payments->retrieve()->data;
$payment=$result->getData();
if ($payment !== null && (!$payment instanceof Example\Entities\Payment || !$payment->getChild() instanceof Example\Entities\Payment || $payment->getChild()->getChild() !== null)) throw new Exception('nullable entity identity');
echo json_encode($result);`;
  for (const body of [
    { data: { id: 'parent', child: { id: 'child', child: null } } },
    { data: null },
  ])
    assert.deepEqual(
      JSON.parse(
        execFileSync('php', ['-r', code, join(f.output, 'php'), JSON.stringify(body)], {
          encoding: 'utf8',
        }),
      ),
      body,
    );
  const consumer = join(f.dir, 'nullable.php');
  writeFileSync(
    consumer,
    String.raw`<?php
use Example\Entities\Client;
use Example\Entities\Payment;
use Example\Entities\PaymentInput;
function input(): PaymentInput {
    return new PaymentInput(['id' => 'parent', 'child' => null]);
}
function consume(Client $client): ?Payment {
    $payment = $client->payments->retrieve()->data->getData();
    return $payment?->getChild();
}
`,
  );
  const analysis = phpstan(consumer, f.dir);
  assert.equal(analysis.status, 0, analysis.stdout + analysis.stderr);
});

test('event names are meaningful and independent of order; collisions are diagnosed', () => {
  const event = { type: 'object', properties: { type: { type: 'string' }, data: entity } };
  // Use a nonrecursive payload here so configuration events are self-contained.
  delete event.properties.data;
  const first = fixture(undefined, { 'payment_intent.succeeded': event, 'payment.failed': event });
  const second = fixture(undefined, { 'payment.failed': event, 'payment_intent.succeeded': event });
  const a = compileSdkContract(first.contract).plan.php.eventModels;
  assert.deepEqual(a, compileSdkContract(second.contract).plan.php.eventModels);
  assert.equal(a['payment_intent.succeeded'], 'WebhookEventPaymentIntentSucceeded');
  assert.throws(
    () =>
      fixture({
        type: 'object',
        properties: { request_id: { type: 'string' }, requestId: { type: 'string' } },
      }),
    /request_id.*requestId|requestId.*request_id/,
  );
});

test('representation changes are breaking and historical compiled plans remain comparable', () => {
  const f = fixture();
  const current = compileSdkContract(f.contract).plan;
  const old = structuredClone(current);
  for (const model of old.php.models) delete model.representation;
  assert.ok(
    compareCompiledContracts(old, current).some(
      (finding) => finding.severity === 'breaking' && finding.message.includes('representation'),
    ),
  );
});

function phpstan(file, directory) {
  const config = join(directory, 'phpstan.neon');
  writeFileSync(
    config,
    `parameters:\n    level: max\n    phpVersion: 80200\n    tmpDir: ${JSON.stringify(join(directory, 'cache'))}\n    scanDirectories:\n        - ${JSON.stringify(join(directory, 'output/php/src'))}\n`,
  );
  return spawnSync(
    'php',
    [
      resolve('.generated/phpstan-vendor/bin/phpstan'),
      'analyse',
      '--no-progress',
      '--error-format=raw',
      '-c',
      config,
      file,
    ],
    { encoding: 'utf8' },
  );
}

test('PHPStan verifies nested public consumers and rejects invalid accesses', () => {
  const f = fixture();
  const positive = join(f.dir, 'positive.php');
  writeFileSync(
    positive,
    String.raw`<?php
use Example\Entities\Client;
function consume(Client $client): string {
    $payment = $client->payments->retrieve()->data->getData();
    $id = $payment->getChildren()[0]->getId();
    $request = $payment->getRequestId();
    $label = $payment->getMetadata()['label'];
    $related = $payment->getRelated()['first']->getId();
    return $payment->getId() . $id . $request . $label . $related;
}
`,
  );
  const valid = phpstan(positive, f.dir);
  assert.equal(valid.status, 0, valid.stdout + valid.stderr);
  const negative = join(f.dir, 'negative.php');
  writeFileSync(
    negative,
    String.raw`<?php
function invalid(Example\Entities\Client $client): string {
    return $client->payments->retrieve()->data->getData()->getMissing();
}
`,
  );
  const invalid = phpstan(negative, f.dir);
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stdout, /getMissing/);
});

test('PHPStan checks the repository README and emitted README examples', () => {
  const dir = join(root, 'readme');
  mkdirSync(dir);
  const output = join(dir, 'output');
  generate(
    loadContract(resolve('examples/library.openapi.json'), resolve('examples/library.sdk.json')),
    output,
  );
  for (const [name, path] of [
    ['repository', resolve('README.md')],
    ['generated', join(output, 'php/README.md')],
  ]) {
    const snippets = [...readFileSync(path, 'utf8').matchAll(/```php\n([\s\S]*?)```/g)].map(
      (match) => match[1],
    );
    assert.ok(snippets.length);
    const file = join(dir, name + '.php');
    writeFileSync(file, snippets.join('\n'));
    const checked = phpstan(file, dir);
    assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  }
});

test('PHPStan checks the generated payment README including convenience methods', () => {
  const dir = join(root, 'payment-readme');
  mkdirSync(dir);
  const output = join(dir, 'output');
  generate(
    loadContract(
      resolve('tests/fixtures/payment-api.json'),
      resolve('tests/fixtures/payment-sdk.json'),
    ),
    output,
  );
  const snippets = [
    ...readFileSync(join(output, 'php/README.md'), 'utf8').matchAll(/```php\n([\s\S]*?)```/g),
  ].map((match) => match[1]);
  const file = join(dir, 'readme.php');
  writeFileSync(file, snippets.join('\n'));
  const checked = phpstan(file, dir);
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
});

test('representation descriptors reject malformed kinds and dangling entity links', () => {
  const f = fixture();
  const path = join(f.output, 'php/src/descriptors/models/PaymentsRetrieveResponse200.json');
  const descriptor = JSON.parse(readFileSync(path, 'utf8'));
  for (const invalid of [{ kind: 'future' }, { kind: 'entity', name: 'MissingEntity' }]) {
    descriptor.phpRepresentation.fields.data = invalid;
    writeFileSync(path, JSON.stringify(descriptor));
    const checked = spawnSync(
      'php',
      [
        '-r',
        String.raw`require $argv[1].'/src/Client.php';
try { Example\Entities\SchemaRegistry::source()->validateAll(); exit(2); }
catch (InvalidArgumentException $e) { echo $e->getMessage(); }`,
        join(f.output, 'php'),
      ],
      { encoding: 'utf8' },
    );
    assert.equal(checked.status, 0, checked.stderr);
    assert.match(checked.stdout, /Invalid PHP representation|Unknown PHP entity/);
  }
});

test('inline class name collisions identify both property paths', () => {
  const value = { type: 'object', properties: { id: { type: 'string' } } };
  assert.throws(
    () =>
      fixture({
        type: 'object',
        properties: {
          a_b: value,
          a: {
            type: 'object',
            properties: { b: { type: 'object', properties: { amount: { type: 'integer' } } } },
          },
        },
      }),
    /properties\.a\.properties\.b.*properties\.a_b|properties\.a_b.*properties\.a\.properties\.b/,
  );
});

test('new composed response classes are breaking even when their wire shapes match', () => {
  const f = fixture();
  const contract = structuredClone(f.contract);
  const response = contract.operations[0].responses['200'];
  response.schema = { allOf: [response.schema] };
  const before = compileSdkContract(contract).plan;
  contract.operations[0].responses['201'] = structuredClone(response);
  const after = compileSdkContract(contract).plan;
  assert.ok(
    compareCompiledContracts(before, after).some(
      (finding) => finding.severity === 'breaking' && finding.subject.includes('response.201'),
    ),
  );
});

test('merged properties preserve response writeOnly and input readOnly declarations', () => {
  const schema = {
    allOf: [
      {
        type: 'object',
        properties: {
          secret: { type: 'string', writeOnly: true },
          id: { type: 'string', readOnly: true },
        },
      },
      { properties: { secret: { minLength: 1 }, id: { minLength: 1 } } },
    ],
  };
  assert.doesNotMatch(phpDocType(schema, true), /secret/);
  assert.doesNotMatch(phpDocType(schema), /'id'/);
  const f = fixture(schema);
  const model = compileSdkContract(f.contract).plan.php.models.find(
    (model) => model.name === 'PaymentsRetrieveResponse200',
  );
  assert.ok(model.getters.some((getter) => getter.method === 'getId'));
  assert.ok(!model.getters.some((getter) => getter.method === 'getSecret'));
});

test('entity sharing never resolves reference-looking literal data', () => {
  const other = { type: 'object', properties: { value: { type: 'string' } } };
  const base = { type: 'object', properties: { id: { type: 'string' } } };
  const graph = phpRepresentations(
    { Named: { ...base, const: { 'x-sdk-ref': 'Other' } } },
    { Other: other },
  );
  assert.deepEqual(graph.compile({ ...base, const: other }, 'Inline'), {
    kind: 'entity',
    name: 'Inline',
  });
});

test('verified webhooks hydrate nested entities and expose their types to PHPStan', () => {
  const f = fixture(undefined, {
    'payment_intent.succeeded': {
      type: 'object',
      required: ['type', 'data'],
      properties: {
        type: { type: 'string' },
        data: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      },
    },
  });
  const file = join(f.dir, 'webhook.php');
  writeFileSync(
    file,
    String.raw`<?php
use Example\Entities\Client;
use Example\Entities\WebhookEventPaymentIntentSucceeded;
function webhookId(Client $client, string $body, string $signature): string {
    $verified = $client->verifyWebhook($body, ['X-Signature' => $signature], 'synthetic', 1000);
    if (!$verified['known'] || !$verified['event'] instanceof WebhookEventPaymentIntentSucceeded) {
        throw new RuntimeException('Unexpected event');
    }
    return $verified['event']->getData()->getId();
}
`,
  );
  const checked = phpstan(file, f.dir);
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  const result = execFileSync(
    'php',
    [
      '-r',
      String.raw`
require $argv[1].'/php/src/Runtime.php';
require $argv[1].'/php/src/Client.php';
require $argv[2];
$body = '{"type":"payment_intent.succeeded","data":{"id":"pay_test"}}';
$signature = 't=1000,v1='.hash_hmac('sha256', '1000.'.$body, 'synthetic');
echo webhookId(new Example\Entities\Client(new Example\Entities\ClientOptions('https://example.invalid')), $body, $signature);
`,
      f.output,
      file,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result, 'pay_test');
});

test('numeric intersections keep getter, magic and dynamic access consistent', () => {
  const f = fixture({
    type: 'object',
    required: ['count'],
    properties: {
      count: { allOf: [{ type: 'integer' }, { type: 'number' }] },
    },
  });
  execFileSync('php', [
    '-r',
    String.raw`
require $argv[1].'/php/src/Runtime.php';
require $argv[1].'/php/src/Client.php';
$m = new Example\Entities\PaymentsRetrieveResponse200(['count' => 3]);
if ($m->getCount() !== 3.0 || $m->get('count') !== 3.0 || $m->count !== 3.0) throw new Exception('numeric representation');
`,
    f.output,
  ]);
});

test('reference-site annotations reuse the configured entity without erasing nested direction rules', () => {
  const f = fixture({
    type: 'object',
    properties: { data: { ...ref('Payment'), readOnly: true } },
  });
  const wrapper = compileSdkContract(f.contract).plan.php.models.find(
    (model) => model.name === 'PaymentsRetrieveResponse200',
  );
  assert.equal(wrapper.getters.find((getter) => getter.field === 'data').doc, 'Payment');
  const child = { type: 'object', properties: { id: { type: 'string' } } };
  const graph = phpRepresentations({ InvoicePaymentPolicy: child }, {});
  assert.deepEqual(
    graph.compile(
      { ...child, readOnly: true, description: 'Field description' },
      'InvoicePaymentPolicy',
      'Invoice.payment_policy',
    ),
    { kind: 'entity', name: 'InvoicePaymentPolicy' },
  );
  assert.deepEqual(graph.compile(child, 'Other'), { kind: 'entity', name: 'InvoicePaymentPolicy' });
  assert.deepEqual(
    graph.compile(
      { ...child, properties: { id: { type: 'string', writeOnly: true } } },
      'Different',
    ),
    { kind: 'entity', name: 'Different' },
  );
});

test('historical root dictionaries record the stdClass to array migration as breaking', () => {
  const f = fixture({ type: 'object', additionalProperties: { type: 'string' } });
  const current = compileSdkContract(f.contract).plan;
  const old = structuredClone(current);
  delete old.php.runtime.operations[0].responses['200'].phpRepresentation;
  old.php.operations.getPayments.output = '\\stdClass';
  assert(
    compareCompiledContracts(old, current).some(
      (finding) => finding.severity === 'breaking' && finding.message.includes('representation'),
    ),
  );
  const list = compileSdkContract(
    fixture({ type: 'array', items: { type: 'string' } }).contract,
  ).plan;
  const historicalList = structuredClone(list);
  delete historicalList.php.runtime.operations[0].responses['200'].phpRepresentation;
  assert(
    !compareCompiledContracts(historicalList, list).some(
      (finding) => finding.severity === 'breaking',
    ),
  );
});
