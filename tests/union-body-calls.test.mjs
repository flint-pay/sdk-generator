import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { loadContract, generate, validateFixtures } from '../dist/index.js';
import { compileDocumentation, factVariantName } from '../dist/documentation-plan.js';

const variant = (field, tag, value) => ({
  type: 'object',
  additionalProperties: false,
  required: [field, value],
  properties: { [field]: { type: 'string', const: tag }, [value]: { type: 'string' } },
});
function fixture(t, edit = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sdk-union-calls-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const operation = (id, path, schema) => ({
    operationId: id,
    parameters: [
      { name: path, in: 'path', required: true, schema: { type: 'string' } },
      { name: 'X-Context', in: 'header', schema: { type: 'string' } },
      { name: 'expand', in: 'query', schema: { type: 'string' } },
    ],
    requestBody: { required: true, content: { 'application/json': { schema } } },
    responses: { 204: { description: 'Done' } },
  });
  const api = {
    openapi: '3.1.0',
    info: { title: 'Synthetic union calls', version: '1' },
    components: {
      schemas: {
        ConfirmToken: variant('credential_type', 'token', 'token'),
        ConfirmSaved: {
          ...variant('credential_type', 'saved', 'payment_method'),
          properties: {
            credential_type: { type: 'string', enum: ['saved'] },
            payment_method: { type: 'string' },
          },
        },
        PayToken: variant('action', 'pay', 'token'),
        PaySaved: variant('action', 'saved', 'payment_method'),
      },
    },
    paths: {
      '/v1/payment-intents/{payment_intent_id}/confirm': {
        post: operation('confirmPaymentIntent', 'payment_intent_id', {
          discriminator: {
            propertyName: 'credential_type',
            mapping: {
              token: '#/components/schemas/ConfirmToken',
              saved: '#/components/schemas/ConfirmSaved',
            },
          },
          oneOf: [
            { $ref: '#/components/schemas/ConfirmToken' },
            { $ref: '#/components/schemas/ConfirmSaved' },
          ],
        }),
      },
      '/v1/orders/{order_id}/pay': {
        post: operation('payOrder', 'order_id', {
          discriminator: { propertyName: 'action' },
          oneOf: [
            { $ref: '#/components/schemas/PayToken' },
            { $ref: '#/components/schemas/PaySaved' },
          ],
        }),
      },
    },
  };
  edit(api);
  const sdk = {
    operationNames: 'path',
    validation: 'schema',
    version: '1.0.0',
    npm: { name: '@example/union-calls' },
    composer: { name: 'example/union-calls', namespace: 'Example\\UnionCalls' },
  };
  const apiFile = join(dir, 'api.json'),
    sdkFile = join(dir, 'sdk.json');
  writeFileSync(apiFile, JSON.stringify(api));
  writeFileSync(sdkFile, JSON.stringify(sdk));
  const contract = loadContract(apiFile, sdkFile);
  const output = join(dir, 'out');
  generate(contract, output);
  return { dir, output, contract };
}

test('oneOf bodies use positional IDs and flat params in Node and PHP', async (t) => {
  const f = fixture(t);
  const scenarios = [
    {
      name: 'confirm token',
      operation: 'confirmPaymentIntent',
      input: {
        payment_intent_id: 'pi/1',
        expand: 'buyer',
        'X-Context': 'ctx',
        body: { credential_type: 'token', token: 'tok_synthetic' },
      },
      expected: {
        method: 'POST',
        path: '/v1/payment-intents/pi%2F1/confirm?expand=buyer',
        headers: { 'x-context': 'ctx' },
        body: '{"credential_type":"token","token":"tok_synthetic"}',
      },
    },
    {
      name: 'confirm saved',
      operation: 'confirmPaymentIntent',
      input: {
        payment_intent_id: 'pi2',
        body: { credential_type: 'saved', payment_method: 'pm_synthetic' },
      },
      expected: {
        method: 'POST',
        path: '/v1/payment-intents/pi2/confirm',
        body: '{"credential_type":"saved","payment_method":"pm_synthetic"}',
      },
    },
    {
      name: 'pay token',
      operation: 'payOrder',
      input: { order_id: 'ord1', body: { action: 'pay', token: 'tok_synthetic' } },
      expected: {
        method: 'POST',
        path: '/v1/orders/ord1/pay',
        body: '{"action":"pay","token":"tok_synthetic"}',
      },
    },
    {
      name: 'pay saved',
      operation: 'payOrder',
      input: { order_id: 'ord2', body: { action: 'saved', payment_method: 'pm_synthetic' } },
      expected: {
        method: 'POST',
        path: '/v1/orders/ord2/pay',
        body: '{"action":"saved","payment_method":"pm_synthetic"}',
      },
    },
  ].map((scenario) => ({
    ...scenario,
    baseUrl: 'https://example.invalid',
    responses: [{ status: 204, body: '' }],
    empty: true,
  }));
  const file = join(f.dir, 'cases.json');
  writeFileSync(file, JSON.stringify(scenarios));
  assert.deepEqual(await validateFixtures(f.output, file), [
    { target: 'node', scenarios: 4 },
    { target: 'php', scenarios: 4 },
  ]);
  const { Client } = await import(pathToFileURL(join(f.output, 'node/index.js')));
  let requests = 0;
  const client = new Client({
    baseUrl: 'https://example.invalid',
    transport: async () => {
      requests++;
      return new Response(null, { status: 204 });
    },
  });
  await assert.rejects(
    client.paymentIntents.confirm({
      payment_intent_id: 'pi',
      body: { credential_type: 'token', token: 'tok' },
    }),
    { name: 'InvalidInputError' },
  );
  await assert.rejects(
    client.paymentIntents.confirm('pi', { body: { credential_type: 'token', token: 'tok' } }),
    { name: 'InvalidInputError' },
  );
  await assert.rejects(client.orders.pay('ord', { action: 'pay' }), { name: 'InvalidInputError' });
  assert.equal(requests, 0);
  const php = readFileSync(join(f.output, 'php/src/classes/PaymentIntentsResource.php'), 'utf8');
  assert.match(
    php,
    /function confirm\(string\|Model \$payment_intent_id, array\|Model \$params, \?RequestOptions \$options = null\)/,
  );
});

test('generated params narrow on discriminator values and reject object-call wrappers', (t) => {
  const f = fixture(t);
  const consumer = join(f.output, 'node/consumer.ts');
  writeFileSync(
    consumer,
    `import { Client } from './index.js';
const client = new Client({ baseUrl: 'https://example.invalid' });
const confirm = (params: Parameters<typeof client.paymentIntents.confirm>[1]) => {
  if (params.credential_type === 'token') {
    const token: string = params.token;
    // @ts-expect-error Other variant fields do not exist here.
    params.payment_method;
  } else {
    const method: string = params.payment_method;
    // @ts-expect-error Other variant fields do not exist here.
    params.token;
  }
};
client.paymentIntents.confirm('pi', { credential_type: 'token', token: 'tok', expand: 'buyer', 'X-Context': 'ctx' });
client.orders.pay('ord', { action: 'pay', token: 'tok' }, { maxAttempts: 1 });
// @ts-expect-error Positional path IDs are required.
client.orders.pay({ order_id: 'ord', body: { action: 'pay', token: 'tok' } });
// @ts-expect-error Params have no body wrapper.
client.orders.pay('ord', { body: { action: 'pay', token: 'tok' } });
// @ts-expect-error Discriminated branch requires token.
client.paymentIntents.confirm('pi', { credential_type: 'token', payment_method: 'pm' });
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
});

test('reference headings identify discriminator values and link named variants', (t) => {
  const f = fixture(t);
  for (const target of ['node', 'php']) {
    const confirm = readFileSync(join(f.output, target, 'reference/paymentIntents.md'), 'utf8');
    const pay = readFileSync(join(f.output, target, 'reference/orders.md'), 'utf8');
    assert.match(confirm, /#### paymentIntents\.confirm with `credential_type: "token"`/);
    assert.match(confirm, /#### paymentIntents\.confirm with `credential_type: "saved"`/);
    assert.match(confirm, /Body model:.*ConfirmToken/);
    assert.match(pay, /#### orders\.pay with `action: "pay"`/);
    assert.doesNotMatch(confirm + pay, /body (oneOf|anyOf) variant|with `[^\n]+` fields/);
  }
});

test('variant names prefer mappings, const/enum tags, models and titles before ordinals', () => {
  for (const [schema, expected] of [
    [
      {
        discriminator: { propertyName: 'kind' },
        'x-sdk-discriminator-mapping': { mapped: 0 },
        oneOf: [variant('kind', 'literal', 'value')],
      },
      'with kind: "mapped"',
    ],
    [
      { discriminator: { propertyName: 'kind' }, oneOf: [variant('kind', 'literal', 'value')] },
      'with kind: "literal"',
    ],
    [{ oneOf: [{ title: 'Named alternative', type: 'object' }] }, 'Named alternative'],
    [{ oneOf: [{ type: 'object' }] }, 'variant 1'],
  ]) {
    const facts = compileDocumentation(schema);
    assert.equal(factVariantName(facts.root, facts.root.one[0], 0, facts.definitions), expected);
  }
});

test('object-only anyOf bodies encode flat params in both targets', async (t) => {
  const f = fixture(t, (api) => {
    const schema =
      api.paths['/v1/orders/{order_id}/pay'].post.requestBody.content['application/json'].schema;
    schema.anyOf = schema.oneOf;
    delete schema.oneOf;
    delete schema.discriminator;
  });
  const file = join(f.dir, 'any-of.json');
  writeFileSync(
    file,
    JSON.stringify([
      {
        name: 'anyOf pay',
        operation: 'payOrder',
        baseUrl: 'https://example.invalid',
        input: { order_id: 'ord', body: { action: 'pay', token: 'synthetic' } },
        expected: {
          method: 'POST',
          path: '/v1/orders/ord/pay',
          body: '{"action":"pay","token":"synthetic"}',
        },
        responses: [{ status: 204, body: '' }],
        empty: true,
      },
    ]),
  );
  assert.deepEqual(await validateFixtures(f.output, file), [
    { target: 'node', scenarios: 1 },
    { target: 'php', scenarios: 1 },
  ]);
});
