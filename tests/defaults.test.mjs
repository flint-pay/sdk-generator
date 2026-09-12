import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { loadContract, generate, preview } from '../dist/index.js';
import { compileSdkContract } from '../dist/target-plan.js';
import { operationNames, modelNames } from '../dist/naming.js';
const root = mkdtempSync(join(tmpdir(), 'sdk-defaults-'));
after(() => rmSync(root, { recursive: true, force: true }));
let index = 0;
function fixture(extra = {}) {
  const dir = join(root, String(index++));
  mkdirSync(dir);
  const schema = { type: 'object', required: ['data'], properties: { data: { type: 'string' } } };
  const api = {
    openapi: '3.1.0',
    info: { title: 'Defaults', version: '1' },
    paths: {
      '/payment-intents': {
        post: {
          operationId: 'createPaymentIntent',
          tags: ['payment_intents'],
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/PaymentInput' } },
            },
          },
          responses: { 200: { description: 'OK', content: { 'application/json': { schema } } } },
        },
      },
    },
    components: {
      schemas: {
        PaymentInput: {
          type: 'object',
          properties: {
            child: { $ref: '#/components/schemas/PaymentInput' },
            amount: { oneOf: [{ type: 'string' }, { type: 'number' }] },
          },
        },
      },
    },
  };
  const config = {
    version: '1.0.0',
    npm: { name: '@example/defaults' },
    composer: { name: 'example/defaults', namespace: 'Example\\Defaults' },
    ...extra,
  };
  const definition = join(dir, 'api.json'),
    configuration = join(dir, 'sdk.json');
  writeFileSync(definition, JSON.stringify(api));
  writeFileSync(configuration, JSON.stringify(config));
  const warnings = [];
  const contract = loadContract(definition, configuration, {
    onWarning: (warning) => warnings.push(warning),
  });
  return { dir, definition, configuration, contract, warnings };
}

test('resource tags and operation words infer names conservatively', () => {
  for (const tag of ['payment_intents', 'Payment Intents', 'paymentIntents'])
    assert.deepEqual(operationNames('createPaymentIntent', [tag]), {
      resource: 'paymentIntents',
      method: 'create',
    });
  assert.deepEqual(operationNames('getInvoicePDF', ['invoices']), {
    resource: 'invoices',
    method: 'getPdf',
  });
  assert.deepEqual(operationNames('createAPIKey', ['api_keys']), {
    resource: 'apiKeys',
    method: 'create',
  });
  assert.deepEqual(operationNames('fetchValue', ['analytics']), {
    resource: 'api',
    method: 'fetchValue',
  });
  assert.deepEqual(operationNames('getOrderPayment', ['orders', 'payments']), {
    resource: 'api',
    method: 'getOrderPayment',
  });
  assert.deepEqual(operationNames('fetchValue', undefined), {
    resource: 'api',
    method: 'fetchValue',
  });
});

test('model suffix rules reserve explicit names and resolve inferred collisions deterministically', () => {
  const originals = ['Payment', 'PaymentInput', 'PaymentRequest', 'PaymentRequestModel'];
  const names = modelNames(originals);
  assert.equal(names.get('PaymentInput'), 'PaymentRequestModel2');
  assert.deepEqual([...names].sort(), [...modelNames(originals.reverse())].sort());
  assert.equal(
    modelNames(['PaymentInput'], { PaymentInput: 'CustomInput' }).get('PaymentInput'),
    'CustomInput',
  );
});

test('automatic defaults generate recursive models, exact unions, direct bodies and WithResponse', async () => {
  const f = fixture(),
    output = join(f.dir, 'out');
  assert.deepEqual(f.warnings, []);
  assert.ok(f.contract.models.PaymentRequest);
  assert.equal(f.contract.models.PaymentInput, undefined);
  assert.ok(f.contract.definitions.PaymentRequest);
  assert.deepEqual(f.contract.modelDependencies.createPaymentIntent, ['PaymentRequest']);
  generate(f.contract, output);
  const { Client, ExactNumber } = await import(join(output, 'node/index.js'));
  const bodies = [];
  const client = new Client({
    baseUrl: 'https://example.invalid',
    transport: async (_, request) => {
      bodies.push(request.body);
      return new Response('{"data":"kept-envelope"}', {
        status: 200,
        headers: { 'x-request-id': 'req_1' },
      });
    },
  });
  assert.equal(
    (await client.paymentIntents.create({ amount: new ExactNumber('1.2500') })).data,
    'kept-envelope',
  );
  assert.equal(bodies[0], '{"amount":1.2500}');
  const response = await client.paymentIntents.createWithResponse({ child: { amount: '1.2500' } });
  assert.equal(response.body.data, 'kept-envelope');
  assert.equal(response.meta.requestId, 'req_1');
  assert.equal(
    execFileSync(
      'php',
      [
        '-r',
        `
require $argv[1].'/php/src/Runtime.php';
require $argv[1].'/php/src/Client.php';
$client = new Example\\Defaults\\Client(new Example\\Defaults\\ClientOptions(baseUrl: 'https://example.invalid', transport: function($request) {
  if ($request['body'] !== '{"amount":1.2500}') throw new Exception('numeric wire value changed');
  return ['status'=>200, 'headers'=>[], 'body'=>'{"data":"kept-envelope"}'];
}));
$input = new Example\\Defaults\\PaymentRequestInput(['amount'=>new Example\\Defaults\\ExactNumber('1.2500')]);
echo $client->paymentIntents->create($input)->data;
`,
        output,
      ],
      { encoding: 'utf8' },
    ),
    'kept-envelope',
  );
  assert.deepEqual(preview(f.contract, output).changes, []);
});

test('deprecated aliases compile identically and explicit naming overrides win', () => {
  const defaults = fixture();
  const aliases = fixture({ schemaSharing: 'named', numericUnions: 'explicit' });
  assert.deepEqual(
    compileSdkContract(defaults.contract).plan,
    compileSdkContract(aliases.contract).plan,
  );
  assert.deepEqual(
    aliases.warnings.map((w) => w.location),
    ['config/schemaSharing', 'config/numericUnions'],
  );
  const diagnosis = spawnSync(
    process.execPath,
    ['dist/cli.js', 'diagnose', aliases.definition, aliases.configuration],
    { encoding: 'utf8' },
  );
  assert.equal(diagnosis.status, 0, diagnosis.stderr);
  assert.equal(JSON.parse(diagnosis.stdout).valid, true);
  assert.match(diagnosis.stderr, /config\/schemaSharing.*deprecated/);
  assert.match(diagnosis.stderr, /config\/numericUnions.*deprecated/);
  for (const override of [{ resource: 'billing' }, { method: 'submit' }]) {
    const operation = fixture({ operations: { createPaymentIntent: override } }).contract
      .operations[0];
    assert.equal(operation.resource, override.resource ?? 'paymentIntents');
    assert.equal(operation.method, override.method ?? 'create');
  }
  const explicit = fixture({
    models: { PaymentInput: 'Chosen' },
    operations: { createPaymentIntent: { resource: 'billing', method: 'submit' } },
  });
  assert.equal(explicit.contract.operations[0].resource, 'billing');
  assert.equal(explicit.contract.operations[0].method, 'submit');
  assert.ok(explicit.contract.models.Chosen);
  assert.deepEqual(explicit.contract.modelDependencies.createPaymentIntent, ['Chosen']);
});

test('regeneration requires an explicit return choice before migrating an existing Result SDK', () => {
  const f = fixture({ responses: { return: 'result' } }),
    output = join(f.dir, 'out');
  generate(f.contract, output);
  const config = JSON.parse(readFileSync(f.configuration));
  delete config.responses;
  writeFileSync(f.configuration, JSON.stringify(config));
  assert.throws(
    () => preview(loadContract(f.definition, f.configuration), output),
    /Existing SDK uses Result/,
  );
  config.responses = { return: 'payload' };
  writeFileSync(f.configuration, JSON.stringify(config));
  const plan = preview(loadContract(f.definition, f.configuration), output);
  assert.ok(
    plan.compatibility.some(
      (change) => change.kind === 'breaking' || change.severity === 'breaking',
    ),
  );
});

test('legacy switches still reject unsupported values with configuration locations', () => {
  for (const [key, value] of [
    ['schemaSharing', 'inline'],
    ['numericUnions', 'guess'],
  ])
    assert.throws(
      () => fixture({ [key]: value }),
      (error) => error.location === 'config/' + key,
    );
});

test('explicit payload paths work with the default return mode', async () => {
  for (const extra of [
    { responses: { payloadPath: 'data' } },
    { operations: { createPaymentIntent: { response: { payloadPath: 'data' } } } },
  ]) {
    const f = fixture(extra),
      output = join(f.dir, 'out');
    generate(f.contract, output);
    const { Client } = await import(join(output, 'node/index.js'));
    const client = new Client({
      baseUrl: 'https://example.invalid',
      transport: async () => new Response('{"data":"selected"}', { status: 200 }),
    });
    assert.equal(await client.paymentIntents.create({}), 'selected');
  }
});
