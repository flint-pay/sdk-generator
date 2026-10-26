import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  loadContract,
  generate,
  validateFixtures,
  preview,
  setCompatibilityBaseline,
} from '../dist/index.js';
import { compareSchemas } from '../dist/compatibility.js';
import { compileCodec, assertCodecPlan } from '../dist/codec-plan.js';

const dir = mkdtempSync(join(tmpdir(), 'sdk-schema-keys-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const config = {
  version: '1.0.0',
  validation: 'schema',
  requests: { style: 'object' },
  npm: { name: '@example/schema-keys' },
  composer: { name: 'example/schema-keys', namespace: 'Example\\SchemaKeys' },
};
const schemas = {
  names: {
    type: 'object',
    additionalProperties: { type: 'string' },
    propertyNames: { minLength: 2, maxLength: 3, pattern: '^[a-zé]+$' },
  },
  enums: { type: 'object', propertyNames: { enum: ['alpha', 'beta'] } },
  literal: { type: 'object', propertyNames: { const: 'only' } },
  fields: {
    type: 'object',
    properties: { known: { type: 'string' } },
    propertyNames: { maxLength: 4 },
  },
  variants: {
    type: ['object', 'array', 'string', 'null'],
    minLength: 2,
    properties: { count: { type: 'integer' } },
    additionalProperties: { type: 'string' },
    items: { type: 'integer' },
  },
  exactVariants: { type: ['object', 'integer', 'null'], format: 'int64' },
  intersection: { type: ['array', 'string'], anyOf: [{ type: 'string', minLength: 2 }] },
  nullOnly: { type: ['null'] },
};
function document(shapeMap = schemas, version = '3.1.0') {
  return {
    openapi: version,
    info: { title: 'Schema keys', version: 'v1' },
    paths: Object.fromEntries(
      Object.entries(shapeMap).map(([name, schema]) => [
        '/' + name,
        {
          post: {
            operationId: name,
            requestBody: { required: true, content: { 'application/json': { schema } } },
            responses: { 200: { description: 'ok', content: { 'application/json': { schema } } } },
          },
        },
      ]),
    ),
  };
}
function load(source, name = 'api') {
  const path = join(dir, name + '.json');
  writeFileSync(path, JSON.stringify(source));
  writeFileSync(join(dir, 'sdk.json'), JSON.stringify(config));
  return loadContract(path, join(dir, 'sdk.json'));
}
const output = join(dir, 'output');
before(() => generate(load(document()), output));

const valid = [
  ['names', { ab: 'x', éé: 'unicode' }],
  ['names', {}],
  ['enums', { alpha: 1, beta: false }],
  ['literal', { only: true }],
  ['fields', { okay: 'x' }],
  ['variants', { count: 2, label: 'two' }],
  ['variants', [1, 2]],
  ['variants', 'text'],
  ['variants', null],
  ['exactVariants', null],
  ['intersection', 'text'],
  ['nullOnly', null],
];
const invalid = [
  ['names', { a: 'short' }],
  ['names', { abcd: 'long' }],
  ['names', { AB: 'pattern' }],
  ['names', { é: 'one Unicode code point' }],
  ['enums', { future: 1 }],
  ['literal', { other: true }],
  ['fields', { known: 'too long even though declared' }],
  ['variants', true],
  ['variants', [false]],
  ['variants', { count: 'two' }],
  ['variants', 'x'],
  ['intersection', []],
  ['nullOnly', 'non-null'],
];

test('generated Node/PHP clients enforce key constraints and mixed-type unions on both sides of HTTP', async () => {
  const cases = valid.map(([operation, value], index) => ({
    name: 'valid ' + index,
    operation,
    baseUrl: 'https://example.invalid',
    input: { body: value },
    expected: { method: 'POST', path: '/' + operation, body: JSON.stringify(value) },
    responses: [{ status: 200, body: JSON.stringify(value) }],
    data: value,
  }));
  for (const [index, [operation, value]] of invalid.entries()) {
    cases.push({
      name: 'invalid request ' + index,
      operation,
      baseUrl: 'https://example.invalid',
      input: { body: value },
      responses: [],
      attempts: 0,
      error: { kind: 'validation' },
    });
    const control = valid.find(([name]) => name === operation)[1];
    // Existing anyOf response unions retain future variants. propertyNames is a strict
    // object-shape constraint, including enum/const and named properties.
    if (operation === 'variants' || operation === 'intersection') continue;
    cases.push({
      name: 'invalid response ' + index,
      operation,
      baseUrl: 'https://example.invalid',
      input: { body: control },
      expected: { method: 'POST', path: '/' + operation, body: JSON.stringify(control) },
      responses: [{ status: 200, body: JSON.stringify(value) }],
      error: { kind: 'protocol' },
    });
  }
  const file = join(dir, 'cases.json');
  writeFileSync(file, JSON.stringify(cases));
  assert.deepEqual(await validateFixtures(output, file), [
    { target: 'node', scenarios: cases.length },
    { target: 'php', scenarios: cases.length },
  ]);
});

test('type-array normalization retains exact formats in typed branches', async () => {
  const file = join(dir, 'exact-cases.json');
  writeFileSync(
    file,
    JSON.stringify([
      {
        name: 'exact typed branch',
        operation: 'exactVariants',
        baseUrl: 'https://example.invalid',
        input: { body: '9007199254740993' },
        expected: { method: 'POST', path: '/exactVariants', body: '9007199254740993' },
        responses: [{ status: 200, body: '9007199254740993' }],
        data: '9007199254740993',
      },
    ]),
  );
  assert.deepEqual(await validateFixtures(output, file), [
    { target: 'node', scenarios: 1 },
    { target: 'php', scenarios: 1 },
  ]);
});

test('unsupported propertyNames shapes fail with a specific remedy', () => {
  for (const propertyNames of [
    false,
    { type: 'integer' },
    { format: 'date' },
    { anyOf: [{}] },
    { enum: [1] },
    { const: 1 },
    { properties: {} },
  ]) {
    assert.throws(
      () => load(document({ invalid: { type: 'object', propertyNames } })),
      /propertyNames.*supports only string type.*express key constraints/,
    );
  }
  const plan = compileCodec(schemas.names);
  assertCodecPlan(plan);
  assert.throws(() => assertCodecPlan({ ...plan, propertyNames: {} }), /invalid compiled codec/);
});

test('key constraint compatibility follows input and response directions', () => {
  const map = (propertyNames) => ({ type: 'object', ...(propertyNames ? { propertyNames } : {}) });
  for (const [before, after] of [
    [{}, { minLength: 2 }],
    [{ maxLength: 10 }, { maxLength: 5 }],
    [{}, { pattern: '^[a-z]+$' }],
    [{}, { enum: ['only'] }],
    [{ enum: ['one', 'two'] }, { enum: ['one'] }],
    [{}, { const: 'only' }],
  ]) {
    assert.ok(
      compareSchemas(map(before), map(after), 'map', 'input').some(
        (c) => c.severity === 'breaking',
      ),
    );
    assert.ok(
      compareSchemas(map(before), map(after), 'map', 'response').every(
        (c) => c.severity !== 'breaking',
      ),
    );
    assert.ok(
      compareSchemas(map(after), map(before), 'map', 'input').every(
        (c) => c.severity !== 'breaking',
      ),
    );
  }
});

test('type arrays reject empty, duplicate and unsupported kinds and preserve OpenAPI 3.0 diagnostics', () => {
  for (const type of [[], ['string', 'string'], ['object', 'unknown']])
    assert.throws(() => load(document({ invalid: { type } })), /supported unique JSON types/);
  assert.throws(
    () => load(document({ invalid: { type: ['string', 'object'] } }, '3.0.3')),
    /use anyOf for non-null type alternatives/,
  );
});

test('identical nested alternatives avoid repeated representation comparisons without hiding ambiguity', () => {
  let nested = { type: 'object', properties: { amount: { type: 'integer', format: 'int64' } } };
  for (let i = 0; i < 5; i++)
    nested = {
      type: 'object',
      properties: {
        child: {
          anyOf: [
            structuredClone(nested),
            { ...structuredClone(nested), description: 'same shape' },
          ],
        },
      },
    };
  const source = document({ repeated: { anyOf: [nested, structuredClone(nested)] } });
  writeFileSync(join(dir, 'repeated.json'), JSON.stringify(source));
  const script = `import {loadContract} from ${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)};
const start=performance.now();loadContract(${JSON.stringify(join(dir, 'repeated.json'))},${JSON.stringify(join(dir, 'sdk.json'))});console.log(performance.now()-start);`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  console.log('Repeated-subtree loading: ' + result.stdout.trim() + ' ms');
  // The differing exact/native intersection must still fail, even when adjacent
  // branches are identical. Automatic string/exact inputs must still be marked.
  assert.throws(
    () =>
      load(
        document({
          bad: {
            allOf: [
              nested,
              structuredClone(nested),
              {
                type: 'object',
                properties: {
                  child: { allOf: [{ type: 'integer' }, { type: 'integer', format: 'int64' }] },
                },
              },
            ],
          },
        }),
      ),
    /intersected numeric schemas use different SDK representations/,
  );
  const c = load(
    document({ ambiguous: { anyOf: [{ type: 'string' }, { type: 'integer', format: 'int64' }] } }),
  );
  assert.equal(c.operations[0].body.anyOf[1]['x-sdk-number-input'], 'explicit');
});

test('saved compiled compatibility retains key constraints across regeneration', () => {
  const prior = join(dir, 'compatibility-output');
  const original = document({ names: { type: 'object', propertyNames: { maxLength: 10 } } });
  generate(load(original, 'compatibility-before'), prior);
  setCompatibilityBaseline(prior, 'released');
  const changed = structuredClone(original);
  changed.paths['/names'].post.requestBody.content[
    'application/json'
  ].schema.propertyNames.maxLength = 5;
  const result = preview(load(changed, 'compatibility-after'), prior);
  assert.ok(
    result.compatibility.some((c) => c.severity === 'breaking' && c.subject.includes('{key}')),
  );
  const responseOnly = JSON.parse(JSON.stringify(original));
  responseOnly.paths['/names'].post.responses['200'].content[
    'application/json'
  ].schema.propertyNames.maxLength = 5;
  assert.ok(
    preview(load(responseOnly, 'compatibility-response'), prior).compatibility.every(
      (c) => c.severity !== 'breaking',
    ),
  );
});
