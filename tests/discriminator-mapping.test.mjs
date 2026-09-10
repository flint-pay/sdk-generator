import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadContract, generate, validateFixtures } from '../dist/index.js';
import { compileCodec } from '../dist/codec-plan.js';
const dir = mkdtempSync(join(tmpdir(), 'sdk-mapping-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const a = {
  allOf: [
    {
      type: 'object',
      properties: { kind: { type: 'string', enum: ['a', 'alias'] } },
      required: ['kind'],
    },
    { properties: { amount: { type: 'integer', format: 'int64' } }, required: ['amount'] },
  ],
};
const b = {
  type: 'object',
  properties: { kind: { type: 'string', const: 'b' }, name: { type: 'string' } },
  required: ['kind', 'name'],
};
function load(
  mapping = {
    a: '#/components/schemas/A',
    alias: '#/components/schemas/A',
    b: '#/components/schemas/B',
  },
  branches = { A: a, B: b },
) {
  const shape = {
    discriminator: { propertyName: 'kind', mapping },
    oneOf: [{ $ref: '#/components/schemas/A' }, { $ref: '#/components/schemas/B' }],
  };
  const content = { 'application/json': { schema: shape } };
  writeFileSync(
    join(dir, 'api.json'),
    JSON.stringify({
      openapi: '3.1.0',
      info: { title: 'Mapping', version: 'v1' },
      components: { schemas: branches },
      paths: {
        '/choice': {
          post: {
            operationId: 'choose',
            requestBody: { required: true, content },
            responses: { 200: { content } },
          },
        },
      },
    }),
  );
  writeFileSync(
    join(dir, 'sdk.json'),
    JSON.stringify({
      version: '1.0.0',
      npm: { name: '@example/mapping' },
      composer: { name: 'example/mapping', namespace: 'Example\\Mapping' },
    }),
  );
  return loadContract(join(dir, 'api.json'), join(dir, 'sdk.json'));
}
test('mappings retain aliases and inherited constraints through both compiled public clients', async () => {
  const contract = load();
  const codec = compileCodec(contract.operations[0].body);
  assert.deepEqual(
    codec.exactlyOne.map((branch) => branch.tagValues),
    [['a', 'alias'], ['b']],
  );
  const out = join(dir, 'out');
  generate(contract, out);
  const valid = (body, wire = JSON.stringify(body)) => ({
    name: 'valid ' + body.kind,
    operation: 'choose',
    input: { body },
    expected: { method: 'POST', path: '/v1/choice', body: wire },
    responses: [{ status: 200, body: wire }],
    data: body,
  });
  const invalid = (body) => ({
    name: 'invalid ' + JSON.stringify(body),
    operation: 'choose',
    input: { body },
    responses: [],
    attempts: 0,
    error: { kind: 'validation' },
  });
  const cases = [
    valid({ kind: 'a', amount: '9007199254740993' }, '{"kind":"a","amount":9007199254740993}'),
    valid({ kind: 'alias', amount: '1' }, '{"kind":"alias","amount":1}'),
    valid({ kind: 'b', name: 'B' }),
    invalid({ kind: 'a' }),
    invalid({ kind: 'b', amount: '1' }),
    invalid({ kind: 'future' }),
  ];
  writeFileSync(join(dir, 'cases.json'), JSON.stringify(cases));
  assert.deepEqual(
    (await validateFixtures(out, join(dir, 'cases.json'))).map((result) => result.scenarios),
    [6, 6],
  );
});
test('mapping diagnostics preserve source pointers and cannot override literal constraints', () => {
  assert.throws(
    () => load({ a: '#/components/schemas/Absent' }),
    /discriminator\/mapping\/a.*unresolved/,
  );
  assert.throws(() => load({ a: '#/components/schemas/B' }), /mapping\/a.*conflicts/);
  assert.throws(() => load({ a: 1 }), /mapping\/a.*reference/);
});
test('mapping hints do not manufacture required fields or resolve ambiguous oneOf schemas', () => {
  const untagged = { type: 'object', properties: { kind: { type: 'string' } } };
  const contract = load(
    { a: '#/components/schemas/A', b: '#/components/schemas/B' },
    {
      A: untagged,
      B: structuredClone(untagged),
    },
  );
  const codec = compileCodec(contract.operations[0].body);
  assert.equal(codec.tag, undefined);
  assert.deepEqual(
    codec.exactlyOne.map((branch) => branch.requiredInput),
    [[], []],
  );
});
