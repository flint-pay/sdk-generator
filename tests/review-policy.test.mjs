import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { loadContract, generate, compare, prepareRelease } from '../dist/generate.js';
import { compareSchemas } from '../dist/compatibility.js';
import { validateFixtures } from '../dist/fixtures.js';

const root = mkdtempSync(join(tmpdir(), 'sdk-review-policy-'));
after(() => rmSync(root, { recursive: true, force: true }));
const profile = {
  version: '1.0.0',
  npm: { name: 'policy-sdk' },
  composer: { name: 'policy/sdk', namespace: 'PolicySdk' },
  release: { policy: 'semver' },
};
const json = (schema) => ({ description: 'OK', content: { 'application/json': { schema } } });
function fixture(label, operation, config = {}) {
  const dir = join(root, label);
  mkdirSync(dir);
  const f = {
    dir,
    out: join(dir, 'sdk'),
    cfg: { ...structuredClone(profile), ...config },
    doc: {
      openapi: '3.1.1',
      info: { title: 'Policy', version: '1' },
      paths: { '/values': operation },
    },
  };
  return f;
}
function load(f) {
  writeFileSync(join(f.dir, 'api.json'), JSON.stringify(f.doc));
  writeFileSync(join(f.dir, 'config.json'), JSON.stringify(f.cfg));
  return loadContract(join(f.dir, 'api.json'), join(f.dir, 'config.json'));
}
function emit(f) {
  return generate(load(f), f.out);
}
function php(f, code) {
  const r = spawnSync(
    'php',
    [
      '-r',
      `require $argv[1].'/php/src/Runtime.php';require $argv[1].'/php/src/Client.php';${code}`,
      f.out,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return JSON.parse(r.stdout);
}
function compileConsumer(f, source) {
  const file = join(f.dir, 'consumer.mts');
  writeFileSync(file, source);
  return spawnSync(
    process.execPath,
    [
      resolve('node_modules/typescript/bin/tsc'),
      '--strict',
      '--noEmit',
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--typeRoots',
      resolve('node_modules/@types'),
      file,
    ],
    { encoding: 'utf8' },
  );
}
const post = (schema) => ({
  post: {
    operationId: 'save',
    requestBody: { required: true, content: { 'application/json': { schema } } },
    responses: { 204: { description: 'Empty' } },
  },
});

test('portable digit and word classes match ECMAScript in both generated clients', async () => {
  const cases = [
    ['^\\w+$', ['abc_019'], ['é', '١', '😀', '-']],
    ['^\\W+$', ['é', '١', '😀', '-'], ['abc_019']],
    ['^\\d+$', ['019'], ['١', '１', 'é']],
    ['^\\D+$', ['١', '１', 'é', '😀'], ['019']],
    ['^[\\w-]+$', ['abc-_19'], ['é', '١']],
    ['^[\\W_]+$', ['é_😀'], ['a', '9']],
    ['^[^\\W_]+$', ['abc19'], ['_', 'é', '١']],
    ['^[\\dA-F]+$', ['A19F'], ['١', '１', 'G']],
    ['^[\\D_]+$', ['é_😀'], ['0']],
    ['^[^\\D]+$', ['19'], ['١', 'a']],
    ['^[\\w\\W]$', ['é', 'a', '😀', '\n', '\u0000'], ['aa']],
  ];
  const properties = Object.fromEntries(
    cases.map(([pattern], i) => ['p' + i, { type: 'string', pattern }]),
  );
  const f = fixture('patterns', post({ type: 'object', properties }), { validation: 'schema' });
  emit(f);
  const scenarios = cases.flatMap(([, valid, invalid], i) => [
    ...valid.map((value, j) => ({
      name: `valid ${i}-${j}`,
      operation: 'save',
      input: { body: { ['p' + i]: value } },
      expected: { method: 'POST', path: '/v1/values', body: JSON.stringify({ ['p' + i]: value }) },
      responses: [{ status: 204 }],
      empty: true,
    })),
    ...invalid.map((value, j) => ({
      name: `invalid ${i}-${j}`,
      operation: 'save',
      input: { body: { ['p' + i]: value } },
      responses: [],
      error: { kind: 'validation' },
      attempts: 0,
    })),
  ]);
  const path = join(f.dir, 'http.json');
  writeFileSync(path, JSON.stringify(scenarios));
  assert.deepEqual(
    (await validateFixtures(f.out, path)).map((r) => r.scenarios),
    [scenarios.length, scenarios.length],
  );
});

test('untyped HTTP parameters fail diagnosis while explicit scalar parameters retain parity', async () => {
  for (const location of ['query', 'header', 'path']) {
    for (const [index, schema] of [
      {},
      { enum: ['a'] },
      { properties: { x: { type: 'string' } } },
    ].entries()) {
      const f = fixture(`untyped-${location}-${index}`, {
        get: {
          operationId: 'read',
          parameters: [{ in: location, name: 'value', required: true, schema }],
          responses: { 204: { description: 'Empty' } },
        },
      });
      if (location === 'path')
        ((f.doc.paths['/values/{value}'] = f.doc.paths['/values']), delete f.doc.paths['/values']);
      assert.throws(() => load(f), /parameters\/value.*explicit non-null scalar/);
    }
  }
  const f = fixture('typed-parameters', {
    get: {
      operationId: 'read',
      parameters: [{ in: 'query', name: 'value', schema: { type: 'string' } }],
      responses: { 204: { description: 'Empty' } },
    },
  });
  emit(f);
  const path = join(f.dir, 'http.json');
  writeFileSync(
    path,
    JSON.stringify([
      {
        name: 'string',
        operation: 'read',
        input: { value: 'abc' },
        expected: { method: 'GET', path: '/v1/values?value=abc' },
        responses: [{ status: 204 }],
        empty: true,
      },
      {
        name: 'null',
        operation: 'read',
        input: { value: null },
        responses: [],
        error: { kind: 'validation' },
        attempts: 0,
      },
      {
        name: 'object',
        operation: 'read',
        input: { value: {} },
        responses: [],
        error: { kind: 'validation' },
        attempts: 0,
      },
    ]),
  );
  await validateFixtures(f.out, path);
});

test('dictionary policy comparisons classify narrowing, widening and equivalent declarations', () => {
  for (const initial of [undefined, true, {}]) {
    const before = {
      type: 'object',
      ...(initial === undefined ? {} : { additionalProperties: initial }),
    };
    const after = { type: 'object', additionalProperties: { type: 'string' } };
    assert(compareSchemas(before, after, 'body', 'input').some((f) => f.severity === 'breaking'));
    assert(!compareSchemas(after, before, 'body', 'input').some((f) => f.severity === 'breaking'));
    assert(
      compareSchemas(after, before, 'body', 'response').some((f) => f.severity === 'breaking'),
    );
    assert(
      !compareSchemas(before, after, 'body', 'response').some((f) => f.severity === 'breaking'),
    );
    const equivalent = { type: 'object', additionalProperties: {} };
    assert(
      !compareSchemas(before, equivalent, 'body', 'input').some((f) => f.severity === 'breaking'),
    );
    const numeric = { type: 'object', additionalProperties: { type: 'integer', format: 'int64' } };
    assert(compareSchemas(before, numeric, 'body', 'input').some((f) => f.severity === 'breaking'));
    assert(compareSchemas(numeric, before, 'body', 'input').some((f) => f.severity === 'breaking'));
  }
  assert(
    compareSchemas(
      { type: 'object', additionalProperties: true },
      { type: 'object', additionalProperties: false },
      'body',
      'input',
    ).some((f) => f.severity === 'breaking'),
  );
});

test('dictionary narrowing rejects formerly accepted values and blocks a patch release', async () => {
  const f = fixture('dictionary-release', post({ type: 'object' }));
  emit(f);
  const before = await import(pathToFileURL(join(f.out, 'node/index.js')).href + '?before');
  let sent = 0;
  const options = {
    baseUrl: 'https://example.invalid',
    transport: async () => {
      sent++;
      return new Response(null, { status: 204 });
    },
  };
  await new before.Client(options).api.save({ body: { flag: true } });
  const phpCall = String.raw`$sent=0;$c=new PolicySdk\Client(new PolicySdk\ClientOptions('https://example.invalid',transport:function($r)use(&$sent){$sent++;return ['status'=>204,'headers'=>[],'body'=>''];}));try{$c->api->save(new PolicySdk\ApiSaveInput(['body'=>['flag'=>true]]));echo json_encode(['sent'=>$sent]);}catch(PolicySdk\SdkError $e){echo json_encode(['sent'=>$sent,'kind'=>$e->kind]);}`;
  assert.deepEqual(php(f, phpCall), { sent: 1 });
  f.doc.paths['/values'].post.requestBody.content['application/json'].schema.additionalProperties =
    { type: 'string' };
  f.cfg.version = '1.0.1';
  assert(emit(f).compatibility.some((c) => c.severity === 'breaking'));
  const after = await import(pathToFileURL(join(f.out, 'node/index.js')).href + '?after');
  await assert.rejects(new after.Client(options).api.save({ body: { flag: true } }), {
    kind: 'validation',
  });
  assert.equal(sent, 1);
  assert.deepEqual(php(f, phpCall), { sent: 0, kind: 'validation' });
  assert.throws(() => prepareRelease(f.out, join(f.dir, 'patch')), /major/);
  f.cfg.version = '2.0.0';
  emit(f);
  assert.equal(prepareRelease(f.out, join(f.dir, 'major')).version, '2.0.0');
});

test('dictionary policies only compare object values shared by both versions', () => {
  for (const type of ['string', 'null', 'integer', 'number', 'boolean', 'array']) {
    for (const policy of [false, { type: 'string' }, { type: 'integer', format: 'int64' }]) {
      const before = { type, ...(type === 'array' ? { items: { type: 'string' } } : {}) };
      const after = { ...before, additionalProperties: policy };
      for (const direction of ['input', 'response']) {
        assert(
          !compareSchemas(before, after, 'body', direction).some((c) => c.severity === 'breaking'),
        );
        assert(
          !compareSchemas(after, before, 'body', direction).some((c) => c.severity === 'breaking'),
        );
      }
    }
  }
  const nullOnly = { type: ['object', 'null'], enum: [null] };
  const dictionary = { ...nullOnly, additionalProperties: { type: 'integer', format: 'int64' } };
  assert(
    !compareSchemas(nullOnly, dictionary, 'body', 'input').some((c) => c.severity === 'breaking'),
  );
  assert(
    !compareSchemas(dictionary, nullOnly, 'body', 'input').some((c) => c.severity === 'breaking'),
  );
  // Response enums are open, so objects and their exact-value rules still matter.
  assert(
    compareSchemas(nullOnly, dictionary, 'body', 'response').some((c) => c.severity === 'breaking'),
  );
  const objectsAdded = { type: ['object', 'null'], additionalProperties: { type: 'string' } };
  assert(
    !compareSchemas({ type: 'null' }, objectsAdded, 'body', 'input').some(
      (c) => c.severity === 'breaking',
    ),
  );
  assert(
    compareSchemas({ type: 'null' }, objectsAdded, 'body', 'response').some(
      (c) => c.severity === 'breaking',
    ),
  );
  assert(
    compareSchemas(objectsAdded, { type: 'null' }, 'body', 'input').some(
      (c) => c.severity === 'breaking',
    ),
  );
  assert(
    !compareSchemas(objectsAdded, { type: 'null' }, 'body', 'response').some(
      (c) => c.severity === 'breaking',
    ),
  );
});

test('irrelevant dictionary policies preserve Node/PHP requests and allow patch releases', async () => {
  for (const validation of ['encoding', 'schema']) {
    for (const [label, schema, value] of [
      ['string', { type: 'string' }, 'abc'],
      ['null', { type: ['object', 'null'], enum: [null] }, null],
    ]) {
      const f = fixture(`irrelevant-dictionary-${validation}-${label}`, post(schema), {
        validation,
      });
      emit(f);
      const declarations = readFileSync(join(f.out, 'node/index.d.ts'), 'utf8');
      const call = String.raw`$body=null;$c=new PolicySdk\Client(new PolicySdk\ClientOptions('https://example.invalid',transport:function($r)use(&$body){$body=$r['body'];return ['status'=>204,'headers'=>[],'body'=>''];}));$c->api->save(new PolicySdk\ApiSaveInput(['body'=>${value === null ? 'null' : "'abc'"}]));echo json_encode($body);`;
      for (const stage of ['before', 'after']) {
        if (stage === 'after') {
          schema.additionalProperties = { type: 'string' };
          f.cfg.version = '1.0.1';
          assert(!emit(f).compatibility.some((c) => c.severity === 'breaking'));
          assert.equal(readFileSync(join(f.out, 'node/index.d.ts'), 'utf8'), declarations);
        }
        const { Client } = await import(
          pathToFileURL(join(f.out, 'node/index.js')).href + '?' + stage
        );
        let body;
        const c = new Client({
          baseUrl: 'https://example.invalid',
          transport: async (_, init) => {
            body = init.body;
            return new Response(null, { status: 204 });
          },
        });
        await c.api.save({ body: value });
        assert.equal(body, JSON.stringify(value));
        assert.equal(php(f, call), body);
        await assert.rejects(c.api.save({ body: {} }), { kind: 'validation' });
      }
      assert.equal(prepareRelease(f.out, join(f.dir, 'patch')).version, '1.0.1');
    }
  }
});

test('added responses compare decoded formats while existing wire changes remain breaking', async () => {
  const variants = [
    ['uuid', { type: 'string', format: 'uuid' }, '"123e4567-e89b-12d3-a456-426614174000"'],
    ['number', { type: 'number' }, '12.5'],
    ['int64', { type: 'integer', format: 'int64' }, '9007199254740993'],
  ];
  const wraps = [
    (s) => s,
    (s) => ({ type: 'object', properties: { value: s }, required: ['value'] }),
    (s) => ({ type: 'array', items: s }),
    (s) => ({ type: 'object', additionalProperties: s }),
  ];
  for (const [label, schema, body] of variants) {
    const f = fixture(`response-format-${label}`, {
      get: { operationId: 'read', responses: { 200: json({ type: 'string' }) } },
    });
    emit(f);
    cpSync(join(f.out, 'node'), join(f.dir, 'before-node'), { recursive: true });
    const baseline = load(f);
    for (const wrap of wraps) {
      const before = structuredClone(baseline);
      before.config.targets = ['node'];
      before.operations[0].responses[200].schema = wrap({ type: 'string' });
      const after = structuredClone(before);
      after.operations[0].responses[201] = { schema: wrap(schema), mediaType: 'application/json' };
      assert(!compare(before, after).some((c) => c.severity === 'breaking'));
      after.operations[0].responses[201].schema = wrap({ type: 'integer', format: 'int32' });
      assert(compare(before, after).some((c) => c.severity === 'breaking'));
    }
    const changed = structuredClone(baseline);
    changed.operations[0].responses[200].schema = schema;
    assert(compare(baseline, changed).some((c) => c.severity === 'breaking'));
    assert(
      compareSchemas({ type: 'string' }, schema, 'input', 'input').some(
        (c) => c.severity === 'breaking',
      ),
    );
    f.doc.paths['/values'].get.responses[201] = json(schema);
    f.cfg.version = '1.0.1';
    const findings = emit(f).compatibility;
    assert(findings.some((c) => c.severity === 'review'));
    assert(!findings.some((c) => c.severity === 'breaking'));
    const { Client } = await import(pathToFileURL(join(f.out, 'node/index.js')).href);
    const data = (
      await new Client({
        baseUrl: 'https://example.invalid',
        transport: async () => new Response(body, { status: 201 }),
      }).api.read()
    ).data;
    assert.equal(typeof data, 'string');
    const phpBody = body.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
    const call = String.raw`function consume(string $value){return $value;}$c=new PolicySdk\Client(new PolicySdk\ClientOptions('https://example.invalid',transport:fn($r)=>['status'=>201,'headers'=>[],'body'=>'${phpBody}']));echo json_encode(consume($c->api->read()->data));`;
    assert.equal(php(f, call), data);
    const consumer = join(f.dir, 'consumer.mts');
    writeFileSync(
      consumer,
      `import type {Client as Before} from './before-node/index.js';
import type {Client as After} from './sdk/node/index.js';
type Old = Awaited<ReturnType<Before['api']['read']>>['data'];
type New = Awaited<ReturnType<After['api']['read']>>['data'];
declare const before: Old; declare const after: New;
const a: Old = after; const b: New = before;`,
    );
    const tsc = spawnSync(
      process.execPath,
      [
        resolve('node_modules/typescript/bin/tsc'),
        '--strict',
        '--noEmit',
        '--target',
        'ES2022',
        '--module',
        'NodeNext',
        '--typeRoots',
        resolve('node_modules/@types'),
        consumer,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(tsc.status, 0, tsc.stdout + tsc.stderr);
    assert.equal(prepareRelease(f.out, join(f.dir, 'patch')).version, '1.0.1');
  }
});

test('added response objects with unknown extra fields break typed dictionary consumers', async () => {
  const schema = { type: 'object', additionalProperties: { type: 'string' } };
  const f = fixture(
    'response-dictionary-unknown',
    {
      get: { operationId: 'read', responses: { 200: json(schema) } },
    },
    { targets: ['node'] },
  );
  emit(f);
  const baseline = load(f);
  const consumer = `import {Client} from './sdk/node/index.js';
const c=new Client({baseUrl:'https://example.invalid'});
Object.values((await c.api.read()).data).map(value=>value.toUpperCase());`;
  const original = compileConsumer(f, consumer);
  assert.equal(original.status, 0, original.stdout + original.stderr);
  for (const policy of [false, true]) {
    const next = structuredClone(baseline);
    next.operations[0].responses[201] = {
      schema: { type: 'object', additionalProperties: policy },
      mediaType: 'application/json',
    };
    assert(compare(baseline, next).some((c) => c.severity === 'breaking'));
  }
  f.doc.paths['/values'].get.responses[201] = json({ type: 'object', additionalProperties: false });
  f.cfg.version = '1.0.1';
  assert(emit(f).compatibility.some((c) => c.severity === 'breaking'));
  const changed = compileConsumer(f, consumer);
  assert.notEqual(changed.status, 0);
  assert.match(changed.stdout, /unknown/);
  const { Client } = await import(pathToFileURL(join(f.out, 'node/index.js')).href);
  const client = new Client({
    baseUrl: 'https://example.invalid',
    transport: async () => new Response('{"flag":123}', { status: 201 }),
  });
  const values = Object.values((await client.api.read()).data);
  assert.deepEqual(values, [123]);
  assert.throws(() => values.map((value) => value.toUpperCase()), TypeError);
  assert.throws(() => prepareRelease(f.out, join(f.dir, 'patch')), /major/);
  f.cfg.version = '2.0.0';
  emit(f);
  assert.equal(prepareRelease(f.out, join(f.dir, 'major')).version, '2.0.0');
});

test('required dictionary keys do not hide added response TypeScript breaks', async () => {
  const schema = { type: 'object', required: ['id'], properties: { id: { type: 'string' } } };
  const f = fixture(
    'response-dictionary-required',
    { get: { operationId: 'read', responses: { 200: json(schema) } } },
    { targets: ['node'] },
  );
  emit(f);
  const baseline = load(f);
  const consumer = `import {Client} from './sdk/node/index.js';
const consume=(data:{id:string})=>data.id.toUpperCase();
const c=new Client({baseUrl:'https://example.invalid'});
consume((await c.api.read()).data);`;
  const original = compileConsumer(f, consumer);
  assert.equal(original.status, 0, original.stdout + original.stderr);

  const dictionary = { type: 'object', required: ['id'], additionalProperties: { type: 'string' } };
  f.doc.paths['/values'].get.responses[201] = json(dictionary);
  f.cfg.version = '1.0.1';
  const changes = emit(f).compatibility;
  const changed = compileConsumer(f, consumer);
  assert.notEqual(changed.status, 0);
  assert.match(changed.stdout, /Property 'id' is missing/);
  assert(changes.some((c) => c.severity === 'breaking' && c.subject === 'read.response.201'));

  const { Client } = await import(pathToFileURL(join(f.out, 'node/index.js')).href);
  const client = (body) =>
    new Client({
      baseUrl: 'https://example.invalid',
      transport: async () => new Response(body, { status: 201 }),
    });
  assert.equal((await client('{"id":"abc"}').api.read()).data.id, 'abc');
  await assert.rejects(
    client('{}').api.read(),
    (error) => error.kind === 'protocol' && /required/.test(error.cause?.message),
  );
  assert.throws(() => prepareRelease(f.out, join(f.dir, 'patch')), /major/);
  f.cfg.version = '2.0.0';
  emit(f);
  assert.equal(prepareRelease(f.out, join(f.dir, 'major')).version, '2.0.0');

  // Declaring the required property preserves the consumer's public field guarantee.
  f.doc.paths['/values'].get.responses[201].content['application/json'].schema.properties =
    schema.properties;
  assert(!compare(baseline, load(f)).some((c) => c.severity === 'breaking'));
  emit(f);
  const explicit = compileConsumer(f, consumer);
  assert.equal(explicit.status, 0, explicit.stdout + explicit.stderr);
});

test('added dictionaries cannot drop runtime-required keys in a patch release', async () => {
  const dictionary = { type: 'object', additionalProperties: { type: 'string' } };
  const required = { ...dictionary, required: ['id'] };
  const f = fixture(
    'response-dictionary-runtime-required',
    { get: { operationId: 'read', responses: { 200: json(required) } } },
    { targets: ['node'] },
  );
  emit(f);
  const baseline = load(f);
  cpSync(join(f.out, 'node'), join(f.dir, 'before-node'), { recursive: true });
  const consumer = `import {Client} from './sdk/node/index.js';
const c=new Client({baseUrl:'https://example.invalid'});
(await c.api.read()).data.id.toUpperCase();`;
  const original = compileConsumer(f, consumer);
  assert.equal(original.status, 0, original.stdout + original.stderr);
  const options = (status, body) => ({
    baseUrl: 'https://example.invalid',
    transport: async () => new Response(body, { status }),
  });
  const consume = (data) => data.id.toUpperCase();
  const { Client: Before } = await import(pathToFileURL(join(f.dir, 'before-node/index.js')).href);
  assert.equal(consume((await new Before(options(200, '{"id":"abc"}')).api.read()).data), 'ABC');
  await assert.rejects(
    new Before(options(200, '{}')).api.read(),
    (error) => error.kind === 'protocol' && /required/.test(error.cause?.message),
  );

  // A different schema that retains the runtime guarantee remains compatible.
  f.doc.paths['/values'].get.responses[201] = json({ ...required, description: 'Created' });
  f.cfg.version = '1.0.1';
  assert(!emit(f).compatibility.some((c) => c.severity === 'breaking'));
  assert.equal(prepareRelease(f.out, join(f.dir, 'compatible-patch')).version, '1.0.1');

  f.doc.paths['/values'].get.responses[201] = json(dictionary);
  const changes = emit(f).compatibility;
  const changed = compileConsumer(f, consumer);
  assert.equal(changed.status, 0, changed.stdout + changed.stderr);
  const { Client: After } = await import(pathToFileURL(join(f.out, 'node/index.js')).href);
  const data = (await new After(options(201, '{}')).api.read()).data;
  assert.throws(() => consume(data), TypeError);
  assert(changes.some((c) => c.severity === 'breaking' && c.subject === 'read.response.201'));
  assert.throws(() => prepareRelease(f.out, join(f.dir, 'breaking-patch')), /major/);
  f.cfg.version = '2.0.0';
  emit(f);
  assert.equal(prepareRelease(f.out, join(f.dir, 'major')).version, '2.0.0');

  const existing = structuredClone(baseline);
  existing.operations[0].responses[200].schema = dictionary;
  assert(compare(baseline, existing).some((c) => c.severity === 'breaking'));
});

test('added response direction annotations preserve compatible output and permit patches', async () => {
  const object = { type: 'object', required: ['id'], properties: { id: { type: 'string' } } };
  const readOnly = { ...object, properties: { id: { type: 'string', readOnly: true } } };
  const writeOnly = {
    ...object,
    required: ['id', 'secret'],
    properties: {
      ...object.properties,
      secret: { type: 'string', writeOnly: true },
    },
  };
  for (const [label, oldSchema, newSchema] of [
    ['readonly-added', object, readOnly],
    ['readonly-removed', readOnly, object],
    ['writeonly-removed', writeOnly, object],
  ]) {
    const f = fixture(
      `response-direction-${label}`,
      {
        get: { operationId: 'read', responses: { 200: json(oldSchema) } },
      },
      { targets: ['node'] },
    );
    emit(f);
    cpSync(join(f.out, 'node'), join(f.dir, 'before-node'), { recursive: true });
    f.doc.paths['/values'].get.responses[201] = json(newSchema);
    f.cfg.version = '1.0.1';
    assert(!emit(f).compatibility.some((c) => c.severity === 'breaking'));
    for (const path of ['before-node/index.js', 'sdk/node/index.js']) {
      const { Client } = await import(pathToFileURL(join(f.dir, path)).href);
      const client = new Client({
        baseUrl: 'https://example.invalid',
        transport: async () =>
          new Response('{"id":"abc"}', { status: path.startsWith('before') ? 200 : 201 }),
      });
      assert.equal((await client.api.read()).data.id.toUpperCase(), 'ABC');
    }
    const result = compileConsumer(
      f,
      `import type {Client as Before} from './before-node/index.js';
import type {Client as After} from './sdk/node/index.js';
type Old=Awaited<ReturnType<Before['api']['read']>>['data'];
type New=Awaited<ReturnType<After['api']['read']>>['data'];
declare const old:Old; declare const next:New;
const a:Old=next; const b:New=old;`,
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(prepareRelease(f.out, join(f.dir, 'patch')).version, '1.0.1');
  }
});

test('simple response inclusion respects optional fields, dictionary types and output guarantees', () => {
  const string = { type: 'string' };
  const dictionary = { type: 'object', additionalProperties: string };
  const optional = { type: 'object', properties: { id: string } };
  const required = { ...optional, required: ['id'] };
  const hidden = {
    type: 'object',
    required: ['secret'],
    properties: {
      secret: { type: 'string', writeOnly: true },
    },
    additionalProperties: string,
  };
  const f = fixture(
    'simple-response-inclusion',
    {
      get: { operationId: 'read', responses: { 200: json(required) } },
    },
    { targets: ['node'] },
  );
  const baseline = load(f);
  const cases = [
    [optional, dictionary, false],
    [required, dictionary, true],
    [required, { ...dictionary, required: ['id'] }, true],
    [{ ...dictionary, required: ['id'] }, dictionary, true],
    [dictionary, { ...dictionary, required: ['id'] }, false],
    [{ ...dictionary, required: ['id'] }, { ...dictionary, required: ['id', 'other'] }, false],
    [{ ...dictionary, required: ['id'] }, { ...dictionary, required: ['other'] }, true],
    [
      { ...dictionary, required: ['id'] },
      { ...dictionary, required: ['id'], description: 'Same guarantee' },
      false,
    ],
    [dictionary, { ...required, additionalProperties: string }, true],
    [hidden, dictionary, false],
    [dictionary, hidden, true],
    [required, optional, true],
    [required, { ...required, properties: { id: { type: 'string', writeOnly: true } } }, true],
    [optional, { ...optional, properties: { id: { type: 'integer' } } }, true],
    [{ type: 'string', properties: { unused: string } }, string, false],
  ];
  for (const wrap of [
    (s) => s,
    (items) => ({ type: 'array', items }),
    (value) => ({ type: 'object', required: ['value'], properties: { value } }),
    (additionalProperties) => ({ type: 'object', additionalProperties }),
  ]) {
    for (const [beforeSchema, nextSchema, breaking] of cases) {
      const before = structuredClone(baseline);
      before.operations[0].responses[200].schema = wrap(beforeSchema);
      const next = structuredClone(before);
      next.operations[0].responses[201] = {
        schema: wrap(nextSchema),
        mediaType: 'application/json',
      };
      assert.equal(
        compare(before, next).some((c) => c.severity === 'breaking'),
        breaking,
        JSON.stringify([beforeSchema, nextSchema]),
      );
    }
  }
});

test('added success results distinguish incompatible bodies from matching shapes and error statuses', () => {
  const schema = { type: 'object', required: ['id'], properties: { id: { type: 'string' } } };
  const f = fixture(
    'added-status',
    { get: { operationId: 'read', responses: { 200: json(schema) } } },
    { targets: ['node'] },
  );
  const baseline = load(f);
  for (const [status, response, breaking] of [
    ['202', {}, true],
    ['201', { schema: structuredClone(schema), mediaType: 'application/json' }, false],
    ['400', {}, false],
    ['304', {}, true],
    ['default', {}, true],
    ['201', { schema: { type: 'string' }, mediaType: 'application/json' }, true],
    [
      '201',
      {
        schema: { type: 'object', properties: { id: { type: 'string' } } },
        mediaType: 'application/json',
      },
      true,
    ],
  ]) {
    const next = structuredClone(baseline);
    next.operations[0].responses[status] = response;
    assert.equal(
      compare(baseline, next).some((c) => c.severity === 'breaking'),
      breaking,
      status + JSON.stringify(response),
    );
  }
  const alreadyEmpty = structuredClone(baseline);
  alreadyEmpty.operations[0].responses['204'] = {};
  const next = structuredClone(alreadyEmpty);
  next.operations[0].responses['202'] = {};
  assert(!compare(alreadyEmpty, next).some((c) => c.severity === 'breaking'));
  const emptyOnly = structuredClone(baseline);
  emptyOnly.operations[0].responses = { 204: {} };
  const withBody = structuredClone(emptyOnly);
  withBody.operations[0].responses['200'] = { schema, mediaType: 'application/json' };
  assert(compare(emptyOnly, withBody).some((c) => c.severity === 'breaking'));
  const union = structuredClone(baseline);
  union.operations[0].responses['201'] = {
    schema: { type: 'string' },
    mediaType: 'application/json',
  };
  const sameUnionMember = structuredClone(union);
  sameUnionMember.operations[0].responses['202'] = structuredClone(
    union.operations[0].responses['201'],
  );
  assert(!compare(union, sameUnionMember).some((c) => c.severity === 'breaking'));
  // Do not compare a union to each member independently: narrowing an added
  // result to a value already allowed by the union does not widen the result.
  const nullable = structuredClone(baseline);
  nullable.operations[0].responses[200].schema.type = ['object', 'null'];
  const nullResult = structuredClone(nullable);
  nullResult.operations[0].responses['201'] = {
    schema: { type: 'null' },
    mediaType: 'application/json',
  };
  assert(!compare(nullable, nullResult).some((c) => c.severity === 'breaking'));
  const typeless = structuredClone(baseline);
  delete typeless.operations[0].responses[200].schema.type;
  const stringResult = structuredClone(typeless);
  stringResult.operations[0].responses['201'] = {
    schema: { type: 'string' },
    mediaType: 'application/json',
  };
  assert(!compare(typeless, stringResult).some((c) => c.severity === 'breaking'));
});

test('new PHP status classes break typed consumers even when JSON schemas match', () => {
  const object = { type: 'object', required: ['id'], properties: { id: { type: 'string' } } };
  const tagged = {
    oneOf: [
      {
        ...object,
        required: ['id', 'kind'],
        properties: {
          ...object.properties,
          kind: { type: 'string', enum: ['known'] },
        },
      },
    ],
    discriminator: { propertyName: 'kind' },
  };
  for (const [label, schema, suffix] of [
    ['object', object, ''],
    ['tagged', tagged, 'Variant0'],
  ]) {
    const f = fixture(
      `php-status-${label}`,
      {
        get: { operationId: 'read', responses: { 200: json(schema) } },
      },
      { targets: ['php'] },
    );
    emit(f);
    const baseline = load(f);
    const call = (status) =>
      String.raw`function consume(PolicySdk\ApiReadResponse200${suffix} $data){return $data->id;}$c=new PolicySdk\Client(new PolicySdk\ClientOptions('https://example.invalid',transport:fn($r)=>['status'=>${status},'headers'=>[],'body'=>'{"id":"abc","kind":"known"}']));try{echo json_encode(['id'=>consume($c->api->read()->data)]);}catch(\TypeError $e){echo json_encode(['error'=>$e->getMessage()]);}`;
    assert.deepEqual(php(f, call(200)), { id: 'abc' });
    for (const targets of [['php'], ['node', 'php'], ['node']]) {
      for (const status of ['201', 'default']) {
        const before = structuredClone(baseline);
        before.config.targets = targets;
        const next = structuredClone(before);
        next.operations[0].responses[status] = structuredClone(before.operations[0].responses[200]);
        const findings = compare(before, next);
        assert.equal(
          findings.some((c) => c.severity === 'breaking'),
          targets.includes('php'),
        );
      }
    }
    // Mixed/object alternatives already admit arbitrary PHP model instances.
    for (const broad of [{}, { type: ['object', 'null'] }]) {
      const before = structuredClone(baseline);
      before.operations[0].responses[202] = { schema: broad, mediaType: 'application/json' };
      const next = structuredClone(before);
      next.operations[0].responses[201] = structuredClone(before.operations[0].responses[200]);
      assert(!compare(before, next).some((c) => c.severity === 'breaking'));
    }
    // Error statuses emit no public result class.
    const error = structuredClone(baseline);
    error.operations[0].responses[400] = structuredClone(baseline.operations[0].responses[200]);
    assert(!compare(baseline, error).some((c) => c.severity === 'breaking'));
    f.doc.paths['/values'].get.responses[201] = json(schema);
    f.cfg.version = '1.0.1';
    assert(
      emit(f).compatibility.some(
        (c) => c.severity === 'breaking' && /PHP response classes/.test(c.message),
      ),
    );
    assert.deepEqual(php(f, call(200)), { id: 'abc' });
    assert.match(php(f, call(201)).error, /ApiReadResponse200.*ApiReadResponse201/);
    assert.throws(() => prepareRelease(f.out, join(f.dir, 'patch')), /major/);
    f.cfg.version = '2.0.0';
    emit(f);
    assert.equal(prepareRelease(f.out, join(f.dir, 'major')).version, '2.0.0');
  }
});

test('nested typeless response narrowing remains review and permits a compatible patch', async () => {
  const loose = { required: ['id'], properties: { id: { type: 'string' } } };
  const wrappers = [
    [
      'property',
      (value) => ({ type: 'object', required: ['value'], properties: { value } }),
      { value: 'abc' },
    ],
    ['items', (items) => ({ type: 'array', items }), ['abc']],
    [
      'dictionary',
      (additionalProperties) => ({ type: 'object', additionalProperties }),
      { value: 'abc' },
    ],
  ];
  for (const [label, wrap, data] of wrappers) {
    const f = fixture(
      `typeless-status-${label}`,
      {
        get: { operationId: 'read', responses: { 200: json(wrap(loose)) } },
      },
      { targets: ['node'] },
    );
    emit(f);
    cpSync(join(f.out, 'node'), join(f.dir, 'before-node'), { recursive: true });
    const before = await import(pathToFileURL(join(f.dir, 'before-node/index.js')).href);
    assert.equal(
      JSON.stringify(
        (
          await new before.Client({
            baseUrl: 'https://example.invalid',
            transport: async () => new Response(JSON.stringify(data)),
          }).api.read()
        ).data,
      ),
      JSON.stringify(data),
    );
    f.doc.paths['/values'].get.responses[201] = json(wrap({ type: 'string' }));
    f.cfg.version = '1.0.1';
    const findings = emit(f).compatibility;
    assert(findings.some((c) => c.severity === 'review'));
    assert(!findings.some((c) => c.severity === 'breaking'));
    const after = await import(pathToFileURL(join(f.out, 'node/index.js')).href);
    assert.equal(
      JSON.stringify(
        (
          await new after.Client({
            baseUrl: 'https://example.invalid',
            transport: async () => new Response(JSON.stringify(data), { status: 201 }),
          }).api.read()
        ).data,
      ),
      JSON.stringify(data),
    );
    const consumer = join(f.dir, 'consumer.mts');
    writeFileSync(
      consumer,
      `import type {Client as Before} from './before-node/index.js';
import type {Client as After} from './sdk/node/index.js';
type OldData = Awaited<ReturnType<Before['api']['read']>>['data'];
type NewData = Awaited<ReturnType<After['api']['read']>>['data'];
declare const result: NewData;
const compatible: OldData = result;`,
    );
    const compile = () =>
      spawnSync(
        process.execPath,
        [
          resolve('node_modules/typescript/bin/tsc'),
          '--strict',
          '--noEmit',
          '--target',
          'ES2022',
          '--module',
          'NodeNext',
          '--typeRoots',
          resolve('node_modules/@types'),
          consumer,
        ],
        { encoding: 'utf8' },
      );
    const compatible = compile();
    assert.equal(compatible.status, 0, compatible.stdout + compatible.stderr);
    assert.equal(prepareRelease(f.out, join(f.dir, 'patch')).version, '1.0.1');
    // The assignability check must also reject a genuinely incompatible result.
    f.doc.paths['/values'].get.responses[201] = json({ type: 'boolean' });
    emit(f);
    assert.notEqual(compile().status, 0);
  }
});

test('adding an empty success result breaks an existing consumer and blocks patch preparation', () => {
  const f = fixture('empty-success-release', {
    get: {
      operationId: 'read',
      responses: {
        200: json({ type: 'object', required: ['id'], properties: { id: { type: 'string' } } }),
      },
    },
  });
  emit(f);
  const consumer = join(f.dir, 'consumer.mts');
  writeFileSync(
    consumer,
    `import {Client} from './sdk/node/index.js';const c=new Client({baseUrl:'https://example.invalid'});(await c.api.read()).data.id;`,
  );
  const compile = () =>
    spawnSync(
      process.execPath,
      [
        resolve('node_modules/typescript/bin/tsc'),
        '--strict',
        '--noEmit',
        '--target',
        'ES2022',
        '--module',
        'NodeNext',
        '--typeRoots',
        resolve('node_modules/@types'),
        consumer,
      ],
      { encoding: 'utf8' },
    );
  assert.equal(compile().status, 0);
  f.doc.paths['/values'].get.responses['202'] = { description: 'Empty' };
  f.cfg.version = '1.0.1';
  emit(f);
  const failure = compile();
  assert.notEqual(failure.status, 0);
  assert.match(failure.stdout, /possibly 'undefined'/);
  assert.throws(() => prepareRelease(f.out, join(f.dir, 'patch')), /major/);
  f.cfg.version = '2.0.0';
  emit(f);
  assert.equal(prepareRelease(f.out, join(f.dir, 'major')).version, '2.0.0');
});

test('PHP variant reassignment is breaking but appending variants and Node-only reordering are compatible', () => {
  const paid = {
    type: 'object',
    required: ['kind', 'amount'],
    properties: {
      kind: { type: 'string', enum: ['paid', 'settled'] },
      amount: { type: 'integer' },
    },
  };
  const failed = {
    type: 'object',
    required: ['kind', 'reason'],
    properties: { kind: { type: 'string', enum: ['failed'] }, reason: { type: 'string' } },
  };
  const pending = {
    type: 'object',
    required: ['kind'],
    properties: { kind: { type: 'string', enum: ['pending'] } },
  };
  const f = fixture('variant-release', {
    get: {
      operationId: 'read',
      responses: { 200: json({ oneOf: [paid, failed], discriminator: { propertyName: 'kind' } }) },
    },
  });
  emit(f);
  const baseline = load(f);
  const call = String.raw`$c=new PolicySdk\Client(new PolicySdk\ClientOptions('https://example.invalid',transport:fn($r)=>['status'=>200,'headers'=>[],'body'=>'{"kind":"paid","amount":100}']));$data=$c->api->read()->data;echo json_encode(['class'=>get_class($data),'oldClass'=>$data instanceof PolicySdk\ApiReadResponse200Variant0]);`;
  assert.equal(php(f, call).oldClass, true);
  f.doc.paths['/values'].get.responses[200].content['application/json'].schema.oneOf.reverse();
  f.cfg.version = '1.0.1';
  const findings = emit(f).compatibility;
  assert(findings.some((c) => c.severity === 'breaking' && /variant classes/.test(c.message)));
  assert.equal(php(f, call).oldClass, false);
  assert.throws(() => prepareRelease(f.out, join(f.dir, 'patch')), /major/);
  const nodeBefore = structuredClone(baseline);
  nodeBefore.config.targets = ['node'];
  const nodeAfter = structuredClone(nodeBefore);
  nodeAfter.operations[0].responses[200].schema.oneOf.reverse();
  assert(!compare(nodeBefore, nodeAfter).some((c) => c.severity === 'breaking'));
  const appended = structuredClone(baseline);
  appended.operations[0].responses[200].schema.oneOf.push(pending);
  assert(!compare(baseline, appended).some((c) => c.severity === 'breaking'));
  const inserted = structuredClone(baseline);
  inserted.operations[0].responses[200].schema.oneOf.unshift(pending);
  assert(
    compare(baseline, inserted).some(
      (c) => c.severity === 'breaking' && /variant classes/.test(c.message),
    ),
  );
  f.cfg.version = '2.0.0';
  emit(f);
  assert.equal(prepareRelease(f.out, join(f.dir, 'major')).version, '2.0.0');
});
