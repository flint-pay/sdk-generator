import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadContract, generate, Diagnostic, validateFixtures } from '../dist/index.js';
const dir = mkdtempSync(join(tmpdir(), 'sdk-import-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const config = {
  responses: { return: 'result' },
  version: '1.0.0',
  requests: { style: 'object' },
  npm: { name: '@example/import' },
  composer: { name: 'example/import', namespace: 'Example\\Import' },
};
const doc = {
  openapi: '3.1.0',
  info: { title: 'Import', version: 'v1' },
  components: {
    schemas: {
      Entry: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  },
  paths: {
    '/values': {
      post: {
        operationId: 'save',
        requestBody: {
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Entry' } } },
        },
        responses: { 204: { description: 'empty' } },
      },
    },
  },
};
const load = (d = doc, c = config) => {
  writeFileSync(join(dir, 'api.json'), JSON.stringify(d));
  writeFileSync(join(dir, 'sdk.json'), JSON.stringify(c));
  return loadContract(join(dir, 'api.json'), join(dir, 'sdk.json'));
};
test('malformed operations and customization objects report their source locations', () => {
  const changes = [
    (d) => (d.paths['/values'].post = null),
    (d) => (d.paths['/values'].post.parameters = [null]),
    (d) => (d.paths['/values'].post.requestBody = null),
    (d) => (d.paths['/values'].post.requestBody.content = null),
    (d) => (d.paths['/values'].post.requestBody.content['application/json'] = null),
    (d) => (d.paths['/values'].post.responses[204] = null),
    (d) => (d.paths['/values'].post.responses[204].content = null),
    (d) => (d.paths['/values'].post.responses[204].content = { 'application/json': null }),
  ];
  for (const change of changes) {
    const d = structuredClone(doc);
    change(d);
    assert.throws(
      () => load(d),
      (e) => e instanceof Diagnostic && e.message.includes('/paths//values/post'),
    );
  }
  for (const c of [
    { ...config, auth: null },
    { ...config, operations: { save: null } },
    { ...config, models: { Entry: null } },
  ])
    assert.throws(
      () => load(doc, c),
      (e) => e instanceof Diagnostic && e.message.includes('config/'),
    );
});
test('external path items retain root model dependencies and exclude unselected private schemas', async () => {
  const d = structuredClone(doc),
    item = structuredClone(d.paths['/values']);
  item.post.requestBody.content['application/json'].schema.$ref =
    './api.json#/components/schemas/Entry';
  item.get = {
    operationId: 'privateRead',
    responses: { 200: { content: { 'application/json': { schema: { $ref: '#/broken' } } } } },
  };
  writeFileSync(join(dir, 'paths.json'), JSON.stringify({ item, broken: { $ref: '#/broken' } }));
  d.paths['/values'] = { $ref: './paths.json#/item' };
  const c = load(d, { ...config, include: ['save'], models: { Entry: 'RecordEntry' } });
  assert.deepEqual(Object.keys(c.models), ['RecordEntry']);
  assert.ok(c.sources['paths.json']);
  const out = join(dir, 'output');
  generate(c, out);
  const { Client, makeRecordEntry } = await import(pathToFileURL(join(out, 'node/index.js')).href);
  let body;
  const client = new Client({
    baseUrl: 'https://example.invalid',
    transport: async (url, init) => {
      assert.equal(url.pathname, '/values');
      body = init.body;
      return new Response(null, { status: 204 });
    },
  });
  await client.api.save({ body: makeRecordEntry({ id: 'entry' }) });
  assert.equal(body, '{"id":"entry"}');
});
test('path item reference cycles are diagnosed before schema resolution', () => {
  const d = structuredClone(doc);
  d.paths['/values'] = { $ref: '#/paths/~1values' };
  assert.throws(() => load(d), /paths.*cyclic path item reference/);
});

test('generated JavaScript retains prototype-named JSON fields and their validation', async () => {
  const d = structuredClone(doc);
  d.components.schemas.Entry = JSON.parse(
    '{"type":"object","required":["__proto__"],"additionalProperties":false,"properties":{"__proto__":{"type":"integer","format":"int32"}}}',
  );
  const out = join(dir, 'prototype-field');
  generate(load(d), out);
  const path = join(dir, 'prototype-cases.json');
  writeFileSync(
    path,
    JSON.stringify([
      {
        name: 'own prototype field',
        operation: 'save',
        input: { body: JSON.parse('{"__proto__":1}') },
        expected: { method: 'POST', path: '/v1/values', body: '{"__proto__":1}' },
        responses: [{ status: 204 }],
        empty: true,
      },
      {
        name: 'prototype field retains its type',
        operation: 'save',
        input: { body: JSON.parse('{"__proto__":"invalid"}') },
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
});

test('coercion hook method names require an explicit safe customization', () => {
  for (const id of ['toString', 'toJSON', 'valueOf']) {
    const d = structuredClone(doc);
    d.paths['/values'].post.operationId = id;
    assert.throws(() => load(d, { ...config, operations: {} }), /method.*reserved/);
    const c = load(d, { ...config, operations: { [id]: { method: 'save' } } });
    assert.equal(c.operations[0].method, 'save');
  }
});

test('inherited properties do not supply optional parameters or request bodies', async () => {
  const d = structuredClone(doc);
  d.paths['/values'].post.parameters = [
    { name: 'reference', in: 'query', schema: { type: 'string' } },
  ];
  const out = join(dir, 'inherited');
  generate(load(d), out);
  const { Client } = await import(pathToFileURL(join(out, 'node/index.js')).href);
  let calls = 0;
  const client = new Client({
    baseUrl: 'https://example.invalid',
    transport: async (url, init) => {
      calls++;
      assert.equal(url.search, '');
      assert.equal(init.body, undefined);
      return new Response(null, { status: 204 });
    },
  });
  await client.api.save(Object.create({ reference: 'not-supplied', body: { id: 'not-supplied' } }));
  assert.equal(calls, 1);
  for (const input of [null, [], false])
    await assert.rejects(
      client.api.save(input),
      (e) => e.kind === 'validation' && e.outcome === 'not_sent',
    );
  assert.equal(calls, 1);
});

test('reference-looking example data stays literal while named schema fields still resolve', () => {
  const d = structuredClone(doc);
  const entry = d.components.schemas.Entry;
  entry.example = { id: 'sample', $ref: 'https://example.invalid/literal', 'x-sdk-ref': 'data' };
  entry.default = { $ref: './missing.json' };
  entry.properties.$ref = { type: 'string' };
  entry.properties.example = { $ref: '#/components/schemas/Label' };
  d.components.schemas.Label = { type: 'string' };
  const c = load(d);
  assert.deepEqual(c.models.Entry.example, entry.example);
  assert.deepEqual(c.models.Entry.default, entry.default);
  assert.equal(c.models.Entry.properties.example['x-sdk-ref'], 'Label');
  assert.equal(c.definitions[c.models.Entry.properties.$ref['x-sdk-ref']].type, 'string');
  assert.ok(c.models.Label);
});

test('source definitions cannot inject internal resolved-schema extensions', () => {
  for (const key of ['x-sdk-ref', 'x-sdk-definitions', 'x-sdk-validation', 'x-sdk-pattern-php']) {
    const d = structuredClone(doc);
    d.components.schemas.Entry[key] = 'injected';
    assert.throws(() => load(d), /x-sdk-.*reserved/);
  }
});

test('optional Object member names permit omitted and explicit wire values in TypeScript', async () => {
  const d = structuredClone(doc);
  d.components.schemas.Entry.properties.toString = { type: 'string' };
  d.components.schemas.Entry.properties.constructor = { type: 'string' };
  d.components.schemas.Entry.properties.valueOf = { type: 'string', readOnly: true };
  d.paths['/values'].post.parameters = [
    { name: 'toString', in: 'query', schema: { type: 'string' } },
  ];
  const out = join(dir, 'optional-object-members');
  generate(load(d), out);
  const consumer = join(out, 'node/consumer.mts');
  writeFileSync(
    consumer,
    `import { Client, makeEntry } from './index.js'; const client = new Client({baseUrl:'https://example.invalid'}); client.api.save({body:makeEntry({id:'x'})}); client.api.save({toString:'query',body:makeEntry({id:'x',toString:'value',constructor:'name'})});\n// @ts-expect-error numeric values are not declared strings\nclient.api.save({toString:123});`,
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
      consumer,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const { Client, makeEntry } = await import(pathToFileURL(join(out, 'node/index.js')).href);
  let calls = 0;
  const client = new Client({
    baseUrl: 'https://example.invalid',
    transport: async (url, init) => {
      calls++;
      assert.equal(url.search, '');
      assert.equal(init.body, '{"id":"x"}');
      return new Response(null, { status: 204 });
    },
  });
  await client.api.save({ body: makeEntry({ id: 'x' }) });
  await assert.rejects(
    client.api.save({ toString: () => 'own function' }),
    (e) => e.kind === 'validation',
  );
  assert.equal(calls, 1);
});
