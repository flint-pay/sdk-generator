import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadContract, render, compare } from '../dist/index.js';

const optional = { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } } };
const choices = [{ required: ['a'] }, { required: ['b'] }];
const requiredChoice = { anyOf: choices };
const tagged = {
  type: 'object',
  properties: { kind: { type: 'string' }, a: { type: 'string' }, b: { type: 'string' } },
  oneOf: [
    { required: ['a'], properties: { kind: { const: 'a' } } },
    { required: ['b'], properties: { kind: { const: 'b' } } },
  ],
};
const forms = [
  [
    { ...optional, anyOf: choices },
    { ...optional, allOf: [{ not: { allOf: choices.map((not) => ({ not })) } }] },
  ],
  [
    { ...tagged, allOf: [{ not: { required: ['a', 'b'] } }] },
    { ...tagged, not: { required: ['a', 'b'] } },
  ],
  [
    {
      ...tagged,
      anyOf: choices,
      oneOf: tagged.oneOf.map((s) => ({ ...s, allOf: [requiredChoice] })),
    },
    { ...tagged, oneOf: tagged.oneOf.map((s) => ({ ...s, allOf: [requiredChoice] })) },
  ],
];
for (const [index, [before, after]] of forms.entries())
  test(`equivalent composition form ${index} has identical package bytes and compatibility`, (t) => {
    const root = mkdtempSync(join(tmpdir(), 'sdk-composition-forms-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const path = join(root, 'api.json'),
      settings = join(root, 'sdk.json');
    writeFileSync(
      settings,
      JSON.stringify({
        version: '1.0.0',
        npm: { name: '@example/normalized' },
        composer: { name: 'example/normalized', namespace: 'Example\\Normalized' },
      }),
    );
    const load = (schema) => {
      writeFileSync(
        path,
        JSON.stringify({
          openapi: '3.1.0',
          info: { title: 'Normalized', version: '1' },
          components: { schemas: { Value: schema } },
          paths: {
            '/value': {
              get: {
                operationId: 'getValue',
                responses: {
                  200: {
                    description: 'OK',
                    content: {
                      'application/json': { schema: { $ref: '#/components/schemas/Value' } },
                    },
                  },
                },
              },
            },
          },
        }),
      );
      return loadContract(path, settings);
    };
    const a = load(before),
      b = load(after);
    assert.deepEqual([...render(a)], [...render(b)]);
    assert.deepEqual(compare(a, b), []);
    if (index === 1) {
      const annotated = load({
        ...before,
        title: 'Owner',
        allOf: [{ ...before.allOf[0], title: 'Overlay' }],
      });
      assert.equal(annotated.models.Value.title, 'Owner');
      assert.equal(annotated.models.Value.allOf[0].title, 'Overlay');
    }
  });

test('foreign naming hints do not change documentation or webhook capabilities', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sdk-foreign-names-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'api.json'),
    settings = join(root, 'sdk.json');
  const value = { type: 'object', properties: { return: { type: 'string' } } };
  const event = {
    type: 'object',
    required: ['event_type'],
    properties: { event_type: { type: 'string', enum: ['value.updated'] }, data: value },
  };
  const config = {
    version: '1.0.0',
    npm: { name: '@example/foreign-names' },
    composer: { name: 'example/foreign-names', namespace: 'Example\\ForeignNames' },
    webhook: {
      algorithm: 'hmac-sha256',
      header: 'X-Signature',
      timestampHeader: 'X-Time',
      separator: '.',
      toleranceSeconds: 300,
      typeField: 'event_type',
      events: { 'value.updated': event },
    },
  };
  const api = {
    openapi: '3.1.0',
    info: { title: 'Foreign names', version: '1' },
    components: {
      schemas: { A: { ...value, description: 'First' }, B: { ...value, description: 'Second' } },
    },
    paths: {
      '/a': {
        get: {
          operationId: 'getA',
          responses: {
            200: {
              description: 'OK',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/A' } } },
            },
          },
        },
      },
      '/b': {
        get: {
          operationId: 'getB',
          responses: {
            200: {
              description: 'OK',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/B' } } },
            },
          },
        },
      },
    },
  };
  const load = () => {
    writeFileSync(path, JSON.stringify(api));
    writeFileSync(settings, JSON.stringify(config));
    return loadContract(path, settings);
  };
  const a = load();
  api.components.schemas.A['x-go-type-name'] = 'ResponseA';
  api.components.schemas.B['x-go-type-name'] = 'ResponseB';
  event['x-go-type-name'] = 'Event';
  event.properties.data.properties.return['x-go-name'] = 'ReturnValue';
  const b = load();
  assert.deepEqual([...render(a)], [...render(b)]);
  assert.ok(!compare(a, b).some((f) => f.severity === 'breaking'));
  config.webhook.header = 'X-Other-Signature';
  assert.ok(compare(b, load()).some((f) => f.severity === 'breaking' && f.subject === 'webhook'));
  api.components.schemas.A.properties.literal = {
    const: { 'x-go-name': 'literal', 'x-go-type-name': 'literal' },
  };
  assert.deepEqual(load().models.A.properties.literal.const, {
    'x-go-name': 'literal',
    'x-go-type-name': 'literal',
  });
});
