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
    { type: 'string', minLength: -1 },
    { type: 'string', minLength: 3, maxLength: 2 },
    { type: 'number', minimum: '1' },
    { type: 'number', minimum: 9007199254740992 },
    { type: 'string', pattern: '(?<=a)b' },
    { type: 'string', pattern: '[a' },
    { type: 'number', multipleOf: 0.1 },
  ]) {
    const d = structuredClone(doc);
    d.components.schemas.Value.properties.value = shape;
    assert.throws(() => load(d), /components\/schemas\/Value\/properties\/value/);
  }
});
test('compatibility identifies narrower caller constraints as breaking', () => {
  for (const [before, after] of [
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
  const body = { country: 'future', count: 0, ratio: '0.01', items: [] };
  const path = join(dir, 'encoding.json');
  writeFileSync(
    path,
    JSON.stringify([
      success(
        'business constraints left to server',
        body,
        '{"country":"future","count":0,"ratio":0.01,"items":[]}',
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
