import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { loadContract, generate, validateFixtures } from '../dist/index.js';
import { serialize } from '../dist/runtime.js';
import { compileCodec, CODEC_SEMANTICS } from '../dist/codec-plan.js';
import { inputSchema } from '../dist/target-plan.js';
import { phpNative } from '../dist/php-types.js';
import { typescriptType } from '../dist/target-types.js';

function fixture(
  t,
  integers = { mode: 'number', exactComponents: ['Money', 'AlternateMoney', 'Cash'] },
) {
  const dir = mkdtempSync(join(tmpdir(), 'sdk-integers-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ref = (name) => ({ $ref: '#/components/schemas/' + name });
  const money = {
    type: 'object',
    required: ['amount'],
    additionalProperties: false,
    properties: {
      amount: { type: 'integer', format: 'int64' },
      exponent: { type: 'integer', format: 'int32' },
      quantity: ref('Quantity'),
    },
  };
  const subscription = {
    type: 'object',
    additionalProperties: false,
    required: ['version', 'total_money'],
    properties: {
      version: { type: 'integer', format: 'uint64', minimum: 1 },
      signed: { type: 'integer', format: 'int64' },
      inline_money: {
        type: ['object', 'null'],
        properties: {
          amount: { type: 'integer', format: 'int64', minimum: 1 },
          currency: { type: 'string', enum: ['USD'] },
        },
      },
      bounded: { allOf: [{ type: 'integer', format: 'int64' }, { minimum: 0 }, { enum: [1, 2] }] },
      total_money: ref('MoneyAlias'),
    },
  };
  const api = {
    openapi: '3.1.0',
    info: { title: 'Synthetic integers', version: '1' },
    components: {
      schemas: {
        Cash: {
          type: 'object',
          required: ['amount', 'currency'],
          properties: {
            amount: { type: 'integer', format: 'int64' },
            currency: { type: 'string' },
          },
        },
        Money: money,
        MoneyAlias: ref('Money'),
        AlternateMoney: { allOf: [money] },
        Quantity: { type: 'integer', format: 'int64' },
        Subscription: subscription,
      },
    },
    paths: {
      '/v1/subscriptions': {
        post: {
          operationId: 'createSubscription',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['expected_version', 'total_money'],
                  properties: {
                    expected_version: { type: 'integer', format: 'uint64', minimum: 1 },
                    total_money: ref('MoneyAlias'),
                    other_money: ref('AlternateMoney'),
                    quantity: ref('Quantity'),
                  },
                },
              },
            },
          },
          responses: {
            200: {
              description: 'Done',
              content: { 'application/json': { schema: ref('Subscription') } },
            },
          },
        },
      },
    },
  };
  const config = {
    version: '1.0.0',
    operationNames: 'path',
    models: { Money: 'MoneyValue' },
    schemaSharing: 'named',
    validation: 'schema',
    npm: { name: '@example/integers' },
    composer: { name: 'example/integers', namespace: 'IntegerTest' },
    ...(integers === undefined ? {} : { integers }),
  };
  const definition = join(dir, 'api.json'),
    settings = join(dir, 'sdk.json'),
    output = join(dir, 'out');
  writeFileSync(definition, JSON.stringify(api));
  writeFileSync(settings, JSON.stringify(config));
  const contract = loadContract(definition, settings);
  generate(contract, output);
  return { dir, output, contract, definition, settings, config };
}

test('native counters and exact money preserve values and error classes in Node and PHP', async (t) => {
  const f = fixture(t);
  const input = {
    expected_version: 3,
    total_money: { amount: '9007199254740993', exponent: '2', quantity: '9007199254740993' },
  };
  const good =
    '{"version":10,"total_money":{"amount":9007199254740993,"exponent":2,"quantity":9007199254740993}}';
  const expected = {
    method: 'POST',
    path: '/v1/subscriptions',
    body: '{"expected_version":3,"total_money":{"amount":9007199254740993,"exponent":2,"quantity":9007199254740993}}',
  };
  const cases = [
    {
      name: 'numeric counter and exact money',
      input,
      expected,
      responses: [{ status: 200, body: good }],
      data: {
        version: 10,
        total_money: { amount: '9007199254740993', exponent: '2', quantity: '9007199254740993' },
      },
    },
    ...[9007199254740992, '3'].map((value, i) => ({
      name: 'bad request ' + i,
      input: { ...input, expected_version: value },
      responses: [],
      attempts: 0,
      error: { name: 'InvalidInputError', code: 'invalid_value', outcome: 'not_sent' },
    })),
    ...['9007199254740992', '-9007199254740992', '9007199254740991.1'].map((token, i) => ({
      name: 'bad response ' + i,
      input,
      expected,
      responses: [{ status: 200, body: '{"version":' + token + ',"total_money":{"amount":1}}' }],
      error: { name: 'UnexpectedResponseError' },
      attempts: 1,
    })),
    {
      name: 'safe boundary',
      input: { expected_version: 9007199254740991, total_money: { amount: '1' } },
      expected: {
        ...expected,
        body: '{"expected_version":9007199254740991,"total_money":{"amount":1}}',
      },
      responses: [
        {
          status: 200,
          body: '{"version":9007199254740991,"signed":-9007199254740991,"total_money":{"amount":1}}',
        },
      ],
      data: { version: 9007199254740991, signed: -9007199254740991, total_money: { amount: '1' } },
    },
  ].map((c) => ({
    ...c,
    input: { body: c.input },
    operation: 'createSubscription',
    baseUrl: 'https://example.invalid',
  }));
  const file = join(f.dir, 'cases.json');
  writeFileSync(file, JSON.stringify(cases));
  assert.deepEqual(await validateFixtures(f.output, file), [
    { target: 'node', scenarios: 7 },
    { target: 'php', scenarios: 7 },
  ]);
  const { Client } = await import(pathToFileURL(join(f.output, 'node/index.js')));
  const client = new Client({
    baseUrl: 'https://example.invalid',
    transport: async () => new Response(good, { status: 200 }),
  });
  const result = await client.subscriptions.create(input);
  assert.equal(result.version, 10);
  assert.equal(result.version >= 9, true);
  assert.equal(result.total_money.amount, '9007199254740993');
  const php = execFileSync(
    'php',
    [
      '-r',
      String.raw`
require $argv[1].'/src/Client.php';
$c=new IntegerTest\Client(new IntegerTest\ClientOptions('https://example.invalid',transport:fn($r)=>['status'=>200,'headers'=>[],'body'=>'{"version":10,"total_money":{"amount":9007199254740993,"exponent":2,"quantity":9007199254740993}}']));
$r=$c->subscriptions->create(['expected_version'=>3,'total_money'=>['amount'=>'9007199254740993']]);
echo json_encode([gettype($r->getVersion()),$r->getVersion()>=9,$r->getTotalMoney()->getAmount()]);
`,
      join(f.output, 'php'),
    ],
    { encoding: 'utf8' },
  );
  assert.deepEqual(JSON.parse(php), ['integer', true, '9007199254740993']);
});

test('declarations use numbers and PHP ints; exact component refs, aliases and compositions stay strings', (t) => {
  const f = fixture(t);
  const registry = { ...f.contract.models, ...f.contract.definitions };
  assert.equal(typescriptType(f.contract.models.Subscription.properties.version, true), 'number');
  assert.equal(phpNative(f.contract.models.Subscription.properties.version, true), 'int');
  for (const name of ['MoneyValue', 'MoneyAlias', 'AlternateMoney']) {
    const schema = f.contract.models[name];
    const amount = schema.properties?.amount ?? schema.allOf?.[0]?.properties?.amount;
    assert.equal(compileCodec(amount).value.kind, 'exact-integer', name);
    assert.equal(typescriptType(amount, true), '`${bigint}`');
    assert.equal(phpNative(amount, true), 'string');
  }
  // Exact contextual references must not change their standalone counter model.
  assert.equal(compileCodec(f.contract.models.Quantity).value.kind, 'safe-integer');
  const php = readdirSync(join(f.output, 'php/src/classes'))
    .filter((f) => f.endsWith('.php'))
    .map((name) => readFileSync(join(f.output, 'php/src/classes', name), 'utf8'))
    .join('\n');
  assert.match(php, /function getVersion\(\): int/);
  assert.match(php, /function getAmount\(\): string/);
  const consumer = join(f.output, 'node/consumer.ts');
  writeFileSync(
    consumer,
    `import {type Subscription,type MoneyValue,type SubscriptionsCreateParams} from './index.js';
declare const s:Subscription; const version:number=s.version; const compare:boolean=s.version>=9;
declare const money:MoneyValue; const amount:\`\${bigint}\`=money.amount;
const q:\`\${bigint}\`|undefined=money.quantity;
const input:SubscriptionsCreateParams={expected_version:3,total_money:{amount:'9007199254740993'}};
// @ts-expect-error Counters no longer accept strings.
const bad:SubscriptionsCreateParams={expected_version:'3',total_money:{amount:'1'}};
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
  } catch (error) {
    throw new Error(error.stdout?.toString() ?? error.message);
  }
  for (const target of ['node', 'php']) {
    const docs = ['RUNTIME.md', 'MODELS.md']
      .map((name) => readFileSync(join(f.output, target, name), 'utf8'))
      .join('\n');
    assert.match(docs, /counters such as version/);
    assert.match(docs, /Money amounts stay exact strings/);
    assert.match(docs, target === 'node' ? /BigInt\(a.amount\) \+ BigInt\(b.amount\)/ : /bcadd\(/);
  }
  assert.equal(
    compileCodec(f.contract.models.Subscription.properties.inline_money).fields.amount.value.kind,
    'exact-integer',
  );
  assert.equal(CODEC_SEMANTICS, '5');
});

test('default exact behavior, shorthand opt-in and malformed policies are diagnosed', (t) => {
  const f = fixture(t, 'exact');
  assert.equal(
    compileCodec(f.contract.models.Subscription.properties.version).value.kind,
    'exact-integer',
  );
  const settings = { ...f.config };
  delete settings.integers;
  writeFileSync(f.settings, JSON.stringify(settings));
  assert.equal(
    compileCodec(loadContract(f.definition, f.settings).models.Subscription.properties.version)
      .value.kind,
    'exact-integer',
  );
  const native = fixture(t, 'number');
  assert.equal(compileCodec(native.contract.models.Quantity).value.kind, 'safe-integer');
  for (const integers of [
    'float',
    null,
    { mode: 'float' },
    { mode: 'number', unknown: true },
    { mode: 'number', exactComponents: ['Missing'] },
  ]) {
    writeFileSync(f.settings, JSON.stringify({ ...f.config, integers }));
    assert.throws(() => loadContract(f.definition, f.settings), /integers/);
  }
  // Repeated loads are deterministic and leave the source schema unchanged.
  writeFileSync(f.settings, JSON.stringify(f.config));
  assert.equal(loadContract(f.definition, f.settings).hash, f.contract.hash);
});

test('pinned Flint profile uses numeric Subscription.version and exact Money.amount', () => {
  const root = resolve('tests/providers/flint');
  const contract = loadContract(join(root, 'full-openapi.json'), join(root, 'full-sdk.json'));
  const registry = { ...contract.models, ...contract.definitions };
  for (const op of contract.operations) {
    if (op.example)
      assert.doesNotThrow(
        () => serialize(op.example, { ...inputSchema(op), 'x-sdk-definitions': registry }),
        op.id,
      );
  }
  const concrete = (schema) =>
    schema['x-sdk-ref'] ? concrete(registry[schema['x-sdk-ref']]) : schema;
  const subscription = concrete(contract.models.Subscription);
  const money = concrete(contract.models.MoneyValue);
  const signed = concrete(contract.models.SignedMoney);
  assert.equal(compileCodec(concrete(signed.properties.amount)).value.kind, 'exact-integer');
  const patch = concrete(contract.models.PaymentLimitSettingsPatch);
  const limits = concrete(patch.properties.max_amounts);
  const inline = concrete(limits.additionalProperties);
  assert.equal(compileCodec(concrete(inline.properties.amount)).value.kind, 'exact-integer');
  assert.equal(compileCodec(concrete(subscription.properties.version)).value.kind, 'safe-integer');
  assert.equal(compileCodec(concrete(money.properties.amount)).value.kind, 'exact-integer');
  assert.equal(typescriptType(concrete(subscription.properties.version), true), 'number');
  assert.equal(phpNative(concrete(subscription.properties.version), true), 'int');
  assert.equal(typescriptType(concrete(money.properties.amount), true), '`${bigint}`');
  assert.equal(phpNative(concrete(money.properties.amount), true), 'string');
});
