import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadContract, generate } from '../dist/index.js';
import { validateFixtures } from '../dist/fixtures.js';
import { compareSchemas } from '../dist/compatibility.js';
const dir = mkdtempSync(join(tmpdir(), 'sdk-constraints-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const properties = {
  conditional: {
    type: 'object',
    properties: {
      method: { type: 'string' },
      purpose: { type: 'string' },
      return_url: { type: 'string' },
    },
    allOf: [
      { if: { properties: { method: { const: 'ach' } } }, then: { required: ['purpose'] } },
      {
        if: { required: ['method'], properties: { method: { const: 'affirm' } } },
        then: { required: ['return_url'], properties: { return_url: { minLength: 5 } } },
      },
    ],
  },
  numericCondition: {
    type: 'object',
    properties: {
      amount: { type: 'number' },
      label: { type: 'string' },
      flag: { type: 'boolean' },
    },
    required: ['amount'],
    if: { properties: { amount: { minimum: 1 } } },
    then: { required: ['label'] },
    else: { required: ['flag'] },
  },
  ignoredThen: { type: 'object', then: { required: ['ignored'] }, else: { required: ['ignored'] } },
  options: { type: 'array', items: { type: 'string' }, contains: { const: 'card' } },
  matchedNumbers: {
    type: 'array',
    items: { type: 'number' },
    contains: { minimum: 1, multipleOf: 0.25 },
  },
  tag: { type: 'string', const: 'delivery' },
  literal: { const: { $ref: 'literal-data.json', values: [1, null, true] } },
  exactConstant: { type: 'number', const: 1 },
  fractionalConstant: { type: 'number', const: 0.25 },
  nullConstant: { const: null },
  conflictingConstant: { type: 'string', enum: ['other'], const: 'delivery' },
  unique: { type: 'array', items: {}, uniqueItems: true },
  uniqueNumbers: { type: 'array', items: { type: 'number' }, uniqueItems: true },
  duplicates: { type: 'array', items: {}, uniqueItems: false },
  percentage: { type: 'number', multipleOf: 0.0001 },
  quarters: { type: 'number', multipleOf: 0.25 },
  country: { type: 'string', minLength: 2, maxLength: 2, pattern: '^[A-Z]{2}$' },
  unicode: { type: 'string', minLength: 1, maxLength: 2 },
  text: { type: 'string', pattern: '^\\S+$' },
  line: { type: 'string', pattern: '^.$' },
  count: { type: 'integer', format: 'uint32', minimum: 1, maximum: 100 },
  unsigned: { type: 'integer', format: 'uint64' },
  signed: { type: 'integer', format: 'int64' },
  ratio: { type: 'number', minimum: 0.1, exclusiveMaximum: 1 },
  negative: { type: 'number', minimum: -0.2, maximum: -0.1 },
  positive: { type: 'number', exclusiveMinimum: 0 },
  items: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 2 },
  update: { type: 'object', minProperties: 1, maxProperties: 2, additionalProperties: true },
  empty: { type: 'object', maxProperties: 0 },
};
const doc = {
  openapi: '3.1.0',
  info: { title: 'Constraints', version: 'v1' },
  components: { schemas: { Value: { type: 'object', properties } } },
  paths: {
    '/values': {
      post: {
        operationId: 'saveValue',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Value' } } },
        },
        responses: {
          200: {
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Value' } } },
          },
        },
      },
    },
  },
};
const config = {
  validation: 'schema',
  version: '1.0.0',
  requests: { style: 'object' },
  npm: { name: '@example/constraints' },
  composer: { name: 'example/constraints', namespace: 'Example\\Constraints' },
};
function load(document = doc, settings = config) {
  writeFileSync(join(dir, 'api.json'), JSON.stringify(document));
  writeFileSync(join(dir, 'sdk.json'), JSON.stringify(settings));
  return loadContract(join(dir, 'api.json'), join(dir, 'sdk.json'));
}
const contract = load(),
  output = join(dir, 'output');
generate(contract, output);
async function fixtures(name, cases) {
  const path = join(dir, name + '.json');
  writeFileSync(path, JSON.stringify(cases));
  assert.deepEqual(
    (await validateFixtures(output, path)).map((r) => r.scenarios),
    [cases.length, cases.length],
  );
}
const success = (name, body, wire, responseBody = wire, data = body) => ({
  name,
  operation: 'saveValue',
  input: { body },
  expected: { method: 'POST', path: '/v1/values', body: wire },
  responses: [{ status: 200, body: responseBody }],
  data,
});
test('both public clients enforce exact numeric, Unicode and array constraints before dispatch', async () => {
  const invalid = [
    { conditional: { method: 'ach' } },
    { conditional: {} },
    { conditional: { method: 'affirm' } },
    { conditional: { method: 'affirm', return_url: 'x' } },
    { numericCondition: { amount: '1.0000000000000000000001', flag: true } },
    { numericCondition: { amount: '0.9999999999999999999999', label: 'wrong' } },
    { options: [] },
    { options: ['cash'] },
    { options: ['card', false] },
    { matchedNumbers: ['0.25', '1.1'] },
    { tag: 'other' },
    { literal: { $ref: 'literal-data.json', values: [1, true, null] } },
    { exactConstant: '1.1' },
    { fractionalConstant: '0.250000000000000000001' },
    { nullConstant: false },
    { conflictingConstant: 'delivery' },
    { conflictingConstant: 'other' },
    { unique: ['id', 'id'] },
    {
      unique: [
        { a: 1, b: [true] },
        { b: [true], a: 1 },
      ],
    },
    { uniqueNumbers: ['1.0', '1e0'] },
    { uniqueNumbers: ['1e1000000000000000000001', '10e1000000000000000000000'] },
    { percentage: '0.12345' },
    { percentage: '-0.12345' },
    { quarters: '0.1' },
    { update: {} },
    { update: { a: 1, b: null, c: false } },
    { empty: { a: null } },
    { empty: [1] },
    { country: 'USA' },
    { country: 'us' },
    { country: 'US\n' },
    { unicode: '' },
    { unicode: '😀ab' },
    { text: 'a\u00a0b' },
    { text: '\ufeff' },
    { line: '\r' },
    { line: '\u2028' },
    { count: 0 },
    { count: 101 },
    { count: 4294967296 },
    { unsigned: '-1' },
    { unsigned: '18446744073709551616' },
    { signed: '9223372036854775808' },
    { signed: '-9223372036854775809' },
    { ratio: '0.099999999999999999999999' },
    { ratio: '1.0000000000000000000000001' },
    { ratio: '1e999999999999999999999999' },
    { ratio: '1e-999999999999999999999999' },
    { negative: '-0.2000000000000000000001' },
    { negative: '-0.0999999999999999999999' },
    { positive: '-0e9999999999999999999999' },
    { items: [] },
    { items: ['a', 'b', 'c'] },
  ];
  await fixtures(
    'invalid',
    invalid.map((body, i) => ({
      name: 'invalid ' + i,
      operation: 'saveValue',
      input: { body },
      responses: [],
      error: { kind: 'validation' },
      attempts: 0,
    })),
  );
  await fixtures('valid', [
    success(
      'ACH conditional dependent field',
      { conditional: { method: 'ach', purpose: 'purchase' } },
      '{"conditional":{"method":"ach","purpose":"purchase"}}',
    ),
    success(
      'Affirm conditional dependent field',
      { conditional: { method: 'affirm', return_url: 'https://example.invalid' } },
      '{"conditional":{"method":"affirm","return_url":"https://example.invalid"}}',
    ),
    success(
      'unrelated method and ignored then else',
      { conditional: { method: 'card' }, ignoredThen: {} },
      '{"conditional":{"method":"card"},"ignoredThen":{}}',
    ),
    success(
      'exact numeric condition true',
      { numericCondition: { amount: '1e0', label: 'yes' } },
      '{"numericCondition":{"amount":1e0,"label":"yes"}}',
    ),
    success(
      'exact numeric condition false',
      { numericCondition: { amount: '0.9999999999999999999999', flag: false } },
      '{"numericCondition":{"amount":0.9999999999999999999999,"flag":false}}',
    ),
    success(
      'contains allows one or multiple matches and enforces items',
      { options: ['card', 'card', 'cash'], matchedNumbers: ['0.25', '1.5'] },
      '{"options":["card","card","cash"],"matchedNumbers":[0.25,1.5]}',
    ),
    success(
      'literal JSON values preserve data references',
      {
        tag: 'delivery',
        literal: { values: [1, null, true], $ref: 'literal-data.json' },
        exactConstant: '1e0',
        nullConstant: null,
      },
      '{"tag":"delivery","literal":{"values":[1,null,true],"$ref":"literal-data.json"},"exactConstant":1e0,"nullConstant":null}',
    ),
    success(
      'fractional constant numeric equivalence',
      { fractionalConstant: '25e-2' },
      '{"fractionalConstant":25e-2}',
    ),
    success(
      'unique JSON kinds and array order',
      { unique: ['1', 1, [1, 2], [2, 1], {}, []], duplicates: [false, false] },
      '{"unique":["1",1,[1,2],[2,1],{},[]],"duplicates":[false,false]}',
    ),
    ...['0', '0.0001', '0.1234', '-0.1234', '1234e-4', '0.123400', '9007199254740993.1234'].map(
      (percentage) =>
        success(
          'exact multiple ' + percentage,
          { percentage },
          '{"percentage":' + percentage + '}',
        ),
    ),
    success(
      'nonunit divisor',
      { quarters: '9007199254740993.25' },
      '{"quarters":9007199254740993.25}',
    ),
    success(
      'object property bounds count explicit nulls and additional keys',
      { update: { a: null, b: false }, empty: {} },
      '{"update":{"a":null,"b":false},"empty":{}}',
    ),
    success(
      'Unicode scalars',
      { country: 'US', unicode: '😀é', text: 'abc', line: '😀', items: ['a', 'b'] },
      '{"country":"US","unicode":"😀é","text":"abc","line":"😀","items":["a","b"]}',
    ),
    success(
      'uint64 and int64 boundaries',
      { unsigned: '18446744073709551615', signed: '-9223372036854775808', count: 100 },
      '{"unsigned":18446744073709551615,"signed":-9223372036854775808,"count":100}',
    ),
    success(
      'decimal edges',
      {
        ratio: '0.10000000000000000000001',
        negative: '-0.2',
        positive: '1e-999999999999999999999',
      },
      '{"ratio":0.10000000000000000000001,"negative":-0.2,"positive":1e-999999999999999999999}',
    ),
    success(
      'alternate decimal representation',
      { ratio: '10e-2', negative: '-100e-3' },
      '{"ratio":10e-2,"negative":-100e-3}',
    ),
  ]);
});
test('response validation retains future values beyond business constraints', async () => {
  await fixtures('future', [
    success('future constraints', {}, '{}', '{"country":"FUTURE","count":200,"items":[]}', {
      country: 'FUTURE',
      count: 200,
      items: [],
    }),
  ]);
});
test('OpenAPI 3.0 exclusive booleans normalize to numeric bounds', () => {
  const d = structuredClone(doc);
  d.openapi = '3.0.3';
  d.components.schemas.Value.properties = {
    value: {
      type: 'number',
      minimum: 0.1,
      exclusiveMinimum: true,
      maximum: 1,
      exclusiveMaximum: false,
    },
  };
  const s = load(d).models.Value.properties.value;
  assert.equal(s.exclusiveMinimum, 0.1);
  assert.equal(s.minimum, undefined);
  assert.equal(s.maximum, 1);
  assert.equal(s.exclusiveMaximum, undefined);
});
test('unsupported and malformed constraints have source diagnostics', () => {
  for (const shape of [
    { type: 'array', items: {}, uniqueItems: 1 },
    { type: 'object', minProperties: -1 },
    { type: 'object', maxProperties: 0.5 },
    { type: 'object', minProperties: 2, maxProperties: 1 },
    { type: 'string', minLength: -1 },
    { type: 'string', minLength: 3, maxLength: 2 },
    { type: 'number', minimum: '1' },
    { type: 'number', minimum: 9007199254740992 },
    { type: 'string', pattern: '(?<=a)b' },
    { type: 'string', pattern: '[a' },
    { type: 'number', multipleOf: 0 },
    { type: 'number', multipleOf: -0.1 },
    { type: 'number', multipleOf: '0.1' },
  ]) {
    const d = structuredClone(doc);
    d.components.schemas.Value.properties.value = shape;
    assert.throws(() => load(d), /components\/schemas\/Value\/properties\/value/);
  }
});
test('compatibility identifies narrower caller constraints as breaking', () => {
  for (const [before, after] of [
    [{ minProperties: 0 }, { minProperties: 1 }],
    [{ maxProperties: 2 }, { maxProperties: 1 }],
    [{ minimum: 0 }, { minimum: 1 }],
    [{ maxLength: 4 }, { maxLength: 3 }],
    [{}, { pattern: '^[A-Z]$' }],
    [{}, { minItems: 1 }],
  ]) {
    assert.ok(
      compareSchemas(before, after, 'value', 'input').some((c) => c.severity === 'breaking'),
    );
    assert.ok(
      !compareSchemas(after, before, 'value', 'input').some((c) => c.severity === 'breaking'),
    );
  }
});

test('schema business validation is explicit while default clients retain safe encoding checks', async () => {
  const c = load(doc, { ...config, validation: undefined });
  const out = join(dir, 'encoding');
  generate(c, out);
  const body = {
    country: 'future',
    count: 0,
    ratio: '0.01',
    items: [],
    percentage: '0.12345',
    uniqueNumbers: ['1', '1.0'],
    update: {},
    options: ['cash'],
  };
  const path = join(dir, 'encoding.json');
  writeFileSync(
    path,
    JSON.stringify([
      success(
        'business constraints left to server',
        body,
        '{"country":"future","count":0,"ratio":0.01,"items":[],"percentage":0.12345,"uniqueNumbers":[1,1.0],"update":{},"options":["cash"]}',
      ),
      {
        name: 'integer range remains required',
        operation: 'saveValue',
        input: { body: { unsigned: '-1' } },
        responses: [],
        error: { kind: 'validation' },
        attempts: 0,
      },
    ]),
  );
  assert.deepEqual(
    (await validateFixtures(out, path)).map((r) => r.scenarios),
    [2, 2],
  );
  assert.throws(() => load(doc, { ...config, validation: 'off' }), /config\/validation/);
});

test('JSON uniqueness has a bounded large-list cost in both runtime helpers', async () => {
  const { serialize } = await import('../dist/runtime.js');
  const { execFileSync } = await import('node:child_process');
  const values = Array.from({ length: 15000 }, (_, index) => ({
    id: 'item-' + index,
    active: index % 2 === 0,
  }));
  const schema = {
    type: 'array',
    uniqueItems: true,
    items: { type: 'object', properties: { id: { type: 'string' }, active: { type: 'boolean' } } },
  };
  const start = performance.now();
  assert.equal(serialize(values, schema), JSON.stringify(values));
  assert.throws(() => serialize([...values, { active: true, id: 'item-0' }], schema), {
    kind: 'validation',
  });
  assert.ok(performance.now() - start < 10000, 'Node uniqueness exceeded ten-second budget');
  writeFileSync(
    join(dir, 'uniqueness.php'),
    `<?php
require ${JSON.stringify(join(output, 'php/src/Runtime.php'))};
use Example\\Constraints\\{Codec,SdkError};
$schema=json_decode('${JSON.stringify(schema)}',true,512,JSON_THROW_ON_ERROR);
$values=[];for($i=0;$i<15000;$i++)$values[]=(object)['id'=>'item-'.$i,'active'=>$i%2===0];
$start=microtime(true);
if(Codec::encode(Codec::normalize($values,$schema))!==json_encode($values,JSON_THROW_ON_ERROR))throw new Exception('JSON changed');
$values[]=(object)['active'=>true,'id'=>'item-0'];
try{Codec::normalize($values,$schema);throw new Exception('duplicate accepted');}catch(SdkError $e){if($e->kind!=='validation')throw $e;}
if(microtime(true)-$start>10)throw new Exception('PHP uniqueness exceeded ten-second budget');
echo 'ok';
`,
  );
  assert.equal(execFileSync('php', [join(dir, 'uniqueness.php')], { encoding: 'utf8' }), 'ok');
});

test('compatibility retains new literal and applicator facts when inclusion needs review', () => {
  for (const [before, after, fact] of [
    [{ multipleOf: 0.01 }, { multipleOf: 0.1 }, 'multipleOf'],
    [{ const: { x: 1 } }, { const: { x: 2 } }, 'const'],
    [{ contains: { const: 'cash' } }, { contains: { const: 'card' } }, 'contains'],
    [
      { if: { required: ['x'] }, then: { required: ['a'] } },
      { if: { required: ['x'] }, then: { required: ['b'] } },
      'composition',
    ],
    [
      { if: { required: ['x'] }, else: {} },
      { if: { required: ['x'] }, else: { required: ['b'] } },
      'composition',
    ],
  ]) {
    for (const direction of ['input', 'output']) {
      const findings = compareSchemas(before, after, 'value', direction);
      assert.ok(
        findings.some((finding) => ['review', 'breaking'].includes(finding.severity)),
        `${direction} ${fact} disappeared`,
      );
    }
  }
  assert.ok(
    compareSchemas({}, { uniqueItems: true }, 'value', 'input').some(
      (finding) => finding.severity === 'breaking',
    ),
  );
});
