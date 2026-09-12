import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadContract, generate, Diagnostic } from '../dist/index.js';

const root = mkdtempSync(join(tmpdir(), 'sdk-audit-fixes-'));
after(() => rmSync(root, { recursive: true, force: true }));
const profile = {
  version: '1.0.0',
  npm: { name: 'audit-sdk' },
  composer: { name: 'audit/sdk', namespace: 'AuditSdk' },
};
function inputs(schema, config = {}, edit = () => {}) {
  const dir = mkdtempSync(join(root, 'case-'));
  const doc = {
    openapi: '3.1.0',
    info: { title: 'Audit', version: '1' },
    components: { schemas: { Payload: schema } },
    paths: {
      '/save': {
        post: {
          operationId: 'save',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Payload' } } },
          },
          responses: { 204: { description: 'empty' } },
        },
      },
    },
  };
  edit(doc);
  const api = join(dir, 'api.json'),
    sdk = join(dir, 'sdk.json'),
    out = join(dir, 'out');
  writeFileSync(api, JSON.stringify(doc));
  writeFileSync(sdk, JSON.stringify({ ...profile, ...config }));
  return { dir, api, sdk, out, doc };
}
function run(command, args, timeout = 15000) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout });
  assert.equal(result.status, 0, String(result.error ?? '') + result.stderr + result.stdout);
  return result.stdout;
}
const choice = { anyOf: [{ type: 'number' }, { type: 'string' }] };
const payload = {
  type: 'object',
  properties: {
    amount: choice,
    nested: { type: 'object', properties: { values: { type: 'array', items: choice } } },
  },
};

test('positional model arguments preserve exact JSON kinds across methods and target runtimes', async () => {
  for (const style of ['positional', 'object']) {
    const i = inputs(payload, {
      ...(style === 'object' ? { requests: { style } } : {}),
      operations: { save: { aliases: ['persist'] } },
    });
    generate(loadContract(i.api, i.sdk), i.out);
    const sdk = await import(join(i.out, 'node/index.js'));
    const wire = [];
    const c = new sdk.Client({
      baseUrl: 'https://example.invalid',
      transport: async (_url, request) => {
        wire.push(request.body);
        return new Response(null, { status: 204 });
      },
    });
    const raw = {
      amount: new sdk.ExactNumber('1.2500'),
      nested: {
        values: ['1.2500', new sdk.ExactNumber('9007199254740993'), new sdk.ExactNumber('1e-20')],
      },
    };
    const model = sdk.makePayload(raw);
    for (const method of ['save', 'persist', 'saveWithResponse'])
      for (const value of [raw, model])
        await c.api[method](style === 'object' ? { body: value } : value);
    const expected = '{"amount":1.2500,"nested":{"values":["1.2500",9007199254740993,1e-20]}}';
    assert.deepEqual(wire, Array(6).fill(expected));
    const { modelInputValue } = await import(join(i.out, 'node/runtime.js'));
    const extracted = modelInputValue(model);
    extracted.nested.values.push('edited');
    assert.throws(() => {
      extracted.amount.value = '7';
    }, TypeError);
    await c.api.save(style === 'object' ? { body: model } : model);
    assert.equal(wire.at(-1), expected);
    assert.equal(model.toJSON().amount, '1.2500');
    writeFileSync(
      join(i.out, 'node/consumer.ts'),
      `import {Client, makePayload, ExactNumber} from './index.js';
const c = new Client({baseUrl:'https://example.invalid'});
const model = makePayload({amount:new ExactNumber('1.2500')});
c.api.save(${style === 'object' ? '{body:model}' : 'model'});
`,
    );
    run(process.execPath, [
      'node_modules/typescript/bin/tsc',
      '--strict',
      '--noEmit',
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      join(i.out, 'node/consumer.ts'),
    ]);
    writeFileSync(
      join(i.dir, 'check.php'),
      `<?php
require $argv[1].'/php/src/Runtime.php'; require $argv[1].'/php/src/Client.php';
$c=new AuditSdk\\Client(new AuditSdk\\ClientOptions(baseUrl:'https://example.invalid',transport:function($r){echo $r['body'];return ['status'=>204,'headers'=>[],'body'=>''];}));
$model=new AuditSdk\\PayloadInput(['amount'=>new AuditSdk\\ExactNumber('1.2500'),'nested'=>['values'=>['1.2500',new AuditSdk\\ExactNumber('9007199254740993'),new AuditSdk\\ExactNumber('1e-20')]]]);
$c->api->save(${style === 'object' ? "['body'=>$model]" : '$model'});
`,
    );
    assert.equal(run('php', [join(i.dir, 'check.php'), i.out]), expected);
  }
});

function literal(i, value) {
  writeFileSync(i.api, JSON.stringify(i.doc).replaceAll('"PRECISE"', value));
}
const precisionError = (error) =>
  error instanceof Diagnostic && /loses precision/.test(error.message);

test('consumed numeric constraints reject source rounding with their constraint location', () => {
  for (const keyword of [
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'multipleOf',
    'const',
    'enum',
  ]) {
    for (const value of ['0.10000000000000001', '1e-400', '9007199254740993']) {
      const i = inputs(
        { type: 'number', [keyword]: keyword === 'enum' ? ['PRECISE'] : 'PRECISE' },
        { requests: { style: 'object' } },
      );
      literal(i, value);
      assert.throws(
        () => loadContract(i.api, i.sdk),
        (error) =>
          precisionError(error) &&
          error.location.endsWith('/' + keyword + (keyword === 'enum' ? '/0' : '')),
      );
    }
  }
  for (const [type, keywords] of [
    ['string', ['minLength', 'maxLength']],
    ['array', ['minItems', 'maxItems']],
    ['object', ['minProperties', 'maxProperties']],
  ]) {
    for (const keyword of keywords) {
      const i = inputs({ type, [keyword]: 'PRECISE' }, { requests: { style: 'object' } });
      literal(i, '1.00000000000000001');
      assert.throws(
        () => loadContract(i.api, i.sdk),
        (error) => precisionError(error) && error.location.endsWith('/' + keyword),
      );
    }
  }
  const i = inputs({ const: { 'a/b~c': ['PRECISE'] } });
  literal(i, '0.10000000000000001');
  assert.throws(
    () => loadContract(i.api, i.sdk),
    (error) => precisionError(error) && error.location.endsWith('/const/a~1b~0c/0'),
  );
});

test('source precision checks preserve equivalent spellings, selection, metadata and overrides', () => {
  for (const value of ['0.1000', '1e-1', '100000000000000000000e-21', '-0.000', '1e-300']) {
    const i = inputs({ type: 'number', minimum: 'PRECISE' }, { requests: { style: 'object' } });
    literal(i, value);
    assert.equal(loadContract(i.api, i.sdk).models.Payload.minimum, Number(value));
  }
  const i = inputs(
    { type: 'number', minimum: 'PRECISE', example: 'PRECISE' },
    {
      requests: { style: 'object' },
      overrides: { '/components/schemas/Payload/minimum': 0.1 },
    },
  );
  literal(i, '0.10000000000000001');
  assert.equal(loadContract(i.api, i.sdk).models.Payload.minimum, 0.1);
  const ignored = inputs({ type: 'object', example: { minimum: 'PRECISE' } }, {}, (doc) => {
    doc.components.schemas.Unused = { type: 'number', minimum: 'PRECISE' };
    doc.paths['/private'] = {
      post: {
        ...doc.paths['/save'].post,
        operationId: 'privateOp',
        requestBody: {
          content: { 'application/json': { schema: { type: 'number', minimum: 'PRECISE' } } },
        },
      },
    };
  });
  literal(ignored, '0.10000000000000001');
  writeFileSync(ignored.sdk, JSON.stringify({ ...profile, include: ['save'] }));
  assert.equal(loadContract(ignored.api, ignored.sdk).operations.length, 1);
});

test('external references and profile overrides retain source precision diagnostics', () => {
  const i = inputs({ $ref: './schema.json#/value' }, { requests: { style: 'object' } });
  writeFileSync(
    join(i.dir, 'schema.json'),
    '{"value":{"type":"number","multipleOf":0.10000000000000001}}',
  );
  assert.throws(
    () => loadContract(i.api, i.sdk),
    (error) =>
      precisionError(error) &&
      error.message.includes('schema.json') &&
      error.location.endsWith('/multipleOf'),
  );
  const j = inputs({ type: 'number', minimum: 0 }, { requests: { style: 'object' } });
  writeFileSync(
    join(j.dir, 'profile.json'),
    '{"overrides":{"/components/schemas/Payload/minimum":0.10000000000000001}}',
  );
  writeFileSync(
    j.sdk,
    JSON.stringify({ ...profile, requests: { style: 'object' }, profiles: ['./profile.json'] }),
  );
  assert.throws(
    () => loadContract(j.api, j.sdk),
    (error) =>
      precisionError(error) &&
      error.message.includes('profile.json') &&
      error.location.includes('config/overrides/'),
  );
  const legacy = inputs({ type: 'number' }, { requests: { style: 'object' } }, (doc) => {
    doc.openapi = '3.0.3';
    doc.paths['/save'].post.requestBody.content['application/json'].schema.minimum = 'PRECISE';
  });
  literal(legacy, '0.10000000000000001');
  assert.doesNotThrow(() => loadContract(legacy.api, legacy.sdk));
});

test('PHP parses large numeric response bodies with exact tokens and bounded cost', () => {
  const i = inputs({ type: 'object' }, {}, (doc) => {
    doc.paths['/numbers'] = {
      get: {
        operationId: 'numbers',
        responses: {
          200: {
            description: 'numbers',
            content: {
              'application/json': { schema: { type: 'array', items: { type: 'integer' } } },
            },
          },
        },
      },
    };
  });
  generate(loadContract(i.api, i.sdk), i.out);
  const file = join(i.dir, 'parser.php');
  writeFileSync(
    file,
    `<?php
require $argv[1].'/php/src/Runtime.php';require $argv[1].'/php/src/Client.php';
use AuditSdk\\{Codec,Client,ClientOptions,RequestOptions};
$wire='[1,-0,1.2500,1e-20,9007199254740993,"123e5",{"n":2}]';
$expected=[1,0,'1.2500','1e-20','9007199254740993','123e5',(object)['n'=>2]];
foreach([false,true] as $preserve)if(Codec::plainNumbers(Codec::parse($wire,$preserve))!=$expected)throw new Exception('changed tokens');
foreach(['[01]','[1e]','[1.]','[1,]','{"n":-}','NaN'] as $invalid){try{Codec::parse($invalid);throw new Exception('accepted malformed JSON');}catch(JsonException $e){}}
$wire='['.implode(',',array_fill(0,320000,'123456789')).']';
$c=new Client(new ClientOptions(baseUrl:'https://example.invalid',transport:fn($r)=>['status'=>200,'headers'=>[],'body'=>$wire]));
$values=$c->api->numbers(new RequestOptions(deadlineMs:10000));
if(count($values)!==320000||$values[0]!==123456789||$values[319999]!==123456789)throw new Exception('changed response');
echo 'ok';
`,
  );
  // The former tail-copy parser takes tens of seconds for this ~3 MB body.
  // A generous subprocess budget bounds regressions independently of SDK timers.
  assert.equal(run('php', [file, i.out], 15000), 'ok');
});
