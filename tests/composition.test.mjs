import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { loadContract, generate } from '../dist/index.js';
import { validateFixtures } from '../dist/fixtures.js';
import { serialize, normalize, isKnownVariant, redact } from '../dist/runtime.js';

const root = mkdtempSync(join(tmpdir(), 'sdk-composition-'));
after(() => rmSync(root, { recursive: true, force: true }));
const config = {
  version: '1.0.0',
  npm: { name: '@example/composition' },
  composer: { name: 'example/composition', namespace: 'Example\\Composition' },
};
const choice = {
  type: 'object',
  properties: {
    order_id: { type: 'string' },
    payment_intent_id: { type: 'string' },
    amount: { type: 'integer', format: 'int64' },
  },
  anyOf: [{ required: ['order_id'] }, { required: ['payment_intent_id'] }],
};
const exclusive = {
  type: 'object',
  properties: { value: { type: 'string' }, values: { type: 'array', items: { type: 'string' } } },
  oneOf: [
    { required: ['value'], not: { required: ['values'] } },
    { required: ['values'], not: { required: ['value'] } },
  ],
};
const intersection = {
  allOf: [
    {
      type: 'object',
      properties: { amount: { type: 'integer', format: 'int64' } },
      required: ['amount'],
    },
    {
      type: 'object',
      properties: { currency: { type: 'string', enum: ['USD'] } },
      required: ['currency'],
    },
  ],
};
const directional = {
  type: 'object',
  required: ['id', 'password', 'name'],
  properties: {
    id: { type: 'string', readOnly: true },
    password: { type: 'string', writeOnly: true },
    name: { type: 'string' },
    description: { type: 'string', nullable: true },
  },
};
const union = {
  type: 'object',
  required: ['request_id'],
  properties: { request_id: { type: 'string' } },
  oneOf: [
    { type: 'object', properties: { order_id: { type: 'string' } }, required: ['order_id'] },
    { type: 'object', properties: { session_id: { type: 'string' } }, required: ['session_id'] },
  ],
};
const schemas = {
  Choice: choice,
  Exclusive: exclusive,
  Intersection: intersection,
  Directional: directional,
  DirectionalIntersection: {
    allOf: [
      { type: 'object', properties: directional.properties },
      { required: directional.required },
    ],
  },
  NullableWrapped: {
    nullable: true,
    readOnly: true,
    allOf: [{ $ref: '#/components/schemas/Intersection' }],
  },
  Union: union,
  Wrapped: {
    type: 'object',
    required: ['value'],
    properties: {
      serverValue: { $ref: '#/components/schemas/NullableWrapped' },
      value: { nullable: true, allOf: [{ $ref: '#/components/schemas/Intersection' }] },
    },
  },
};
const paths = {};
for (const name of Object.keys(schemas).filter((name) => name !== 'NullableWrapped')) {
  const content = { 'application/json': { schema: { $ref: '#/components/schemas/' + name } } };
  paths['/' + name.toLowerCase()] = {
    post: {
      operationId: 'send' + name,
      requestBody: { required: true, content },
      responses: { 200: { content } },
    },
  };
}
const definition = {
  openapi: '3.0.3',
  info: { title: 'Composition', version: 'v1' },
  paths,
  components: { schemas },
};
const definitionPath = join(root, 'openapi.json'),
  configPath = join(root, 'sdk.json'),
  output = join(root, 'out');
writeFileSync(definitionPath, JSON.stringify(definition));
writeFileSync(configPath, JSON.stringify(config));
const contract = loadContract(definitionPath, configPath);
generate(contract, output);

function accepted(name, operation, body, response = body, wire = JSON.stringify(body)) {
  return {
    name,
    operation,
    input: { body },
    expected: { method: 'POST', path: '/v1/' + operation.slice(4).toLowerCase(), body: wire },
    responses: [{ status: 200, body: JSON.stringify(response) }],
    data: response,
  };
}
function rejected(name, operation, body) {
  return {
    name,
    operation,
    input: { body },
    responses: [],
    error: { kind: 'validation' },
    attempts: 0,
  };
}

test('OpenAPI 3.0 composition uses the same public-client wire scenarios in both targets', async () => {
  const cases = [
    accepted('null through reference wrapper', 'sendWrapped', { value: null }),
    accepted(
      'directional required fields across intersection branches',
      'sendDirectionalIntersection',
      { name: 'Ada', password: 'private' },
      { id: 'u1', name: 'Ada' },
    ),
    accepted(
      'value through reference wrapper',
      'sendWrapped',
      { value: { amount: '10', currency: 'USD' } },
      { value: { amount: '10', currency: 'USD' } },
      '{"value":{"amount":10,"currency":"USD"}}',
    ),
    rejected('wrapper preserves required branch fields', 'sendWrapped', {
      value: { amount: '10' },
    }),
    rejected('neither identity', 'sendChoice', {}),
    accepted('order identity', 'sendChoice', { order_id: 'o' }),
    accepted('payment identity', 'sendChoice', { payment_intent_id: 'p' }),
    accepted('both identities', 'sendChoice', { order_id: 'o', payment_intent_id: 'p' }),
    rejected('neither exclusive field', 'sendExclusive', {}),
    accepted('single exclusive field', 'sendExclusive', { value: 'a' }),
    accepted('multiple exclusive field', 'sendExclusive', { values: ['a', 'b'] }),
    rejected('both exclusive fields', 'sendExclusive', { value: 'a', values: ['b'] }),
    accepted(
      'intersection preserves exact amount',
      'sendIntersection',
      { amount: '9007199254740993', currency: 'USD' },
      { amount: '9007199254740993', currency: 'USD' },
      '{"amount":9007199254740993,"currency":"USD"}',
    ),
    rejected('intersection missing currency', 'sendIntersection', { amount: '1' }),
    rejected('intersection bad currency', 'sendIntersection', { amount: '1', currency: 'EUR' }),
    accepted(
      'directional required fields',
      'sendDirectional',
      { name: 'Ada', password: 'private', description: null },
      { id: 'u1', name: 'Ada', description: null },
    ),
    rejected('readonly field rejected', 'sendDirectional', {
      id: 'u1',
      name: 'Ada',
      password: 'private',
    }),
    rejected('writeonly still required on input', 'sendDirectional', { name: 'Ada' }),
    accepted('untagged response order', 'sendUnion', { request_id: 'r', order_id: 'o' }),
    rejected('untagged overlap', 'sendUnion', { request_id: 'r', order_id: 'o', session_id: 's' }),
    accepted(
      'future untagged response',
      'sendUnion',
      { request_id: 'r', order_id: 'o' },
      { request_id: 'r', future_id: 'x' },
    ),
  ];
  const file = join(root, 'cases.json');
  writeFileSync(file, JSON.stringify(cases));
  assert.deepEqual(
    (await validateFixtures(output, file)).map((r) => r.scenarios),
    [cases.length, cases.length],
  );
});

test('nullable wrappers preserve composition and annotation semantics', () => {
  const schema = contract.models.NullableWrapped;
  assert.equal(schema.readOnly, true);
  assert.equal(normalize(null, schema, 'response', true), null);
  assert.deepEqual(JSON.parse(serialize({ amount: '10', currency: 'USD' }, schema)), {
    amount: 10,
    currency: 'USD',
  });
  assert.throws(() => serialize({ amount: '10' }, schema), /alternative/);
  assert.equal(JSON.stringify(schema).includes('nullable'), false);
});

test('union guards enforce siblings and exact alternatives, with conservative redaction', async () => {
  const { isApiSendUnionResponseKnown: known } = await import(
    pathToFileURL(join(output, 'node/index.js')).href
  );
  assert.equal(known({ request_id: 'r', order_id: 'o' }), true);
  assert.equal(known({ order_id: 'o' }), false);
  assert.equal(known({ request_id: 'r', order_id: 'o', session_id: 's' }), false);
  assert.equal(known({ request_id: 'r', future_id: 'x' }), false);
  assert.equal(isKnownVariant('a', { anyOf: [{ type: 'string' }, { type: 'integer' }] }), true);
  const schema = {
    allOf: [
      { properties: { credential: { type: 'string', writeOnly: true } } },
      { properties: { amount: { type: 'integer', format: 'int64' } } },
    ],
  };
  assert.deepEqual(redact({ credential: 'sensitive', amount: '1' }, schema), {
    credential: '[REDACTED]',
    amount: '1',
  });
});

test('generated declarations enforce field choices and request/response direction', () => {
  const file = join(output, 'node/consumer.ts');
  writeFileSync(
    file,
    `import {Client, type ExclusiveInput, type DirectionalInput, type Directional, isApiSendUnionResponseKnown} from './index.js';
const a: ExclusiveInput={value:'a'}; const b: ExclusiveInput={values:['b']};
// @ts-expect-error neither field
const c: ExclusiveInput={};
// @ts-expect-error both fields
const d: ExclusiveInput={value:'a',values:['b']};
const input: DirectionalInput={name:'Ada',password:'private'};
// @ts-expect-error cannot submit a readOnly field
const readonlyInput: DirectionalInput={id:'u1',name:'Ada',password:'private'};
const result: Directional={id:'u1',name:'Ada'};
// @ts-expect-error response still requires id
const missing: Directional={name:'Ada'};
const client=new Client({baseUrl:'https://example.invalid'});
const response=await client.api.sendUnion({body:{request_id:'r',order_id:'o'}});
if(isApiSendUnionResponseKnown(response.data)) {const id:string=response.data.request_id;}
`,
  );
  const result = spawnSync(
    process.execPath,
    [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '--strict',
      '--skipLibCheck',
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      file,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('generated quickstart inputs satisfy composed request schemas', async () => {
  const { Client } = await import(pathToFileURL(join(output, 'node/index.js')).href);
  for (const file of readdirSync(join(output, 'node/examples')).filter((file) =>
    file.endsWith('.mjs'),
  )) {
    const source = readFileSync(join(output, 'node/examples', file), 'utf8');
    const match = source.match(
      /const result = await client\.api\.([^(]+)\(([\s\S]*), \{ maxAttempts: 1 \}\);/,
    );
    assert.ok(match, file);
    let dispatched = false;
    const client = new Client({
      baseUrl: 'https://example.invalid',
      transport: async () => {
        dispatched = true;
        throw new Error('request reached transport');
      },
    });
    await assert.rejects(
      client.api[match[1]](JSON.parse(match[2]), { maxAttempts: 1 }),
      (e) => e.kind === 'transport',
      file,
    );
    assert.ok(dispatched, file);
  }
});

test('invalid provider examples fail during generation with the customization path', () => {
  const configured = { ...config, operations: { sendExclusive: { example: { body: {} } } } };
  const file = join(root, 'bad-example.json');
  writeFileSync(file, JSON.stringify(configured));
  assert.throws(
    () => generate(loadContract(definitionPath, file), join(root, 'bad-example-output')),
    /config\/operations\/sendExclusive\/example.*exactly one/,
  );
  configured.operations.sendExclusive.example.body = { value: 'example' };
  writeFileSync(file, JSON.stringify(configured));
  assert.doesNotThrow(() =>
    generate(loadContract(definitionPath, file), join(root, 'valid-example-output')),
  );
});

test('unrepresentable numeric compositions fail with source diagnostics rather than unusable types', () => {
  const integer = { type: 'integer', format: 'int32' },
    exact = { type: 'integer', format: 'int64' };
  for (const shape of [
    { allOf: [integer, exact] },
    {
      allOf: [
        { type: 'object', properties: { amount: integer } },
        { type: 'object', properties: { amount: exact } },
      ],
    },
    { oneOf: [exact, { type: 'string' }] },
    { anyOf: [{ type: 'number' }, { type: 'string' }] },
  ]) {
    const doc = structuredClone(definition);
    doc.components.schemas.Choice = shape;
    const path = join(root, 'numeric-composition.json');
    writeFileSync(path, JSON.stringify(doc));
    assert.throws(
      () => loadContract(path, configPath),
      /components\/schemas\/Choice.*(?:SDK representations|ambiguous SDK string inputs)/,
    );
  }
});

test('untagged safe-integer and string alternatives remain distinct on the wire', async () => {
  const doc = structuredClone(definition);
  doc.components.schemas.Choice = {
    oneOf: [{ type: 'integer', format: 'int32' }, { type: 'string' }],
  };
  const path = join(root, 'scalar-union.json'),
    out = join(root, 'scalar-union');
  writeFileSync(path, JSON.stringify(doc));
  generate(loadContract(path, configPath), out);
  const fixtures = join(root, 'scalar-union-cases.json');
  writeFileSync(
    fixtures,
    JSON.stringify([
      accepted('integer alternative', 'sendChoice', 123),
      accepted('string alternative', 'sendChoice', '123'),
    ]),
  );
  assert.deepEqual(
    (await validateFixtures(out, fixtures)).map((r) => r.scenarios),
    [2, 2],
  );
});

test('exact numbers retain constraint-only conjuncts and numeric field choices', async () => {
  const doc = structuredClone(definition);
  doc.components.schemas.Choice = {
    allOf: [
      { type: 'integer', format: 'int64' },
      { minimum: 10, maximum: 20 },
      { not: { minimum: 15, maximum: 17 } },
    ],
  };
  const path = join(root, 'numeric-bounds.json'),
    out = join(root, 'numeric-bounds');
  const settings = join(root, 'numeric-bounds-sdk.json');
  writeFileSync(path, JSON.stringify(doc));
  writeFileSync(
    settings,
    JSON.stringify({
      ...config,
      validation: 'schema',
      operations: { sendChoice: { example: { body: '10' } } },
    }),
  );
  generate(loadContract(path, settings), out);
  const fixtures = join(root, 'numeric-bounds-cases.json');
  writeFileSync(
    fixtures,
    JSON.stringify([
      accepted('lower boundary', 'sendChoice', '10', '10', '10'),
      accepted('upper boundary', 'sendChoice', '20', '20', '20'),
      rejected('below lower bound', 'sendChoice', '9'),
      rejected('above upper bound', 'sendChoice', '21'),
      rejected('forbidden numeric interval', 'sendChoice', '16'),
    ]),
  );
  assert.deepEqual(
    (await validateFixtures(out, fixtures)).map((r) => r.scenarios),
    [5, 5],
  );
});
