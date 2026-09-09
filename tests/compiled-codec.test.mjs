import test from 'node:test';
import assert from 'node:assert/strict';
import { compileCodec } from '../dist/codec-plan.js';
import { executeCodec, normalize, serialize } from '../dist/runtime.js';

test('compiled codecs retain exact numeric wire/value distinctions and request ranges', () => {
  const schema = { type: 'integer', format: 'int64' };
  const plan = compileCodec(schema);
  assert.equal(plan.value.kind, 'exact-integer');
  assert.equal(serialize('9007199254740993', schema), '9007199254740993');
  assert.equal(executeCodec('9007199254740993', plan, { mode: 'response' }), '9007199254740993');
  assert.throws(
    () => executeCodec('9223372036854775808', plan, { mode: 'request' }),
    /integer format range/,
  );
  assert.equal(
    executeCodec('9223372036854775808', plan, { mode: 'response' }),
    '9223372036854775808',
  );
});

test('compiled mixed objects enforce required-only keys and nested additional-value guarantees', () => {
  const schema = {
    type: 'object',
    properties: { label: { type: 'string' } },
    required: ['entry'],
    additionalProperties: {
      type: 'object',
      required: ['id'],
      additionalProperties: { type: 'string' },
    },
  };
  const plan = compileCodec(schema);
  for (const evaluate of [
    (value) => executeCodec(value, plan, { mode: 'response' }),
    (value) => normalize(value, schema, 'response', true),
  ]) {
    assert.equal(evaluate({ entry: { id: 'abc' } }).entry.id, 'abc');
    assert.throws(() => evaluate({ entry: {} }), /entry.id: required field is missing/);
    assert.throws(() => evaluate({}), /entry: required field is missing/);
    assert.throws(() => evaluate({ label: 4, entry: { id: 'abc' } }), /label: expected a string/);
  }
});

test('direction compilation retains enclosing composition omissions and independent child contexts', () => {
  const schema = {
    type: 'object',
    allOf: [
      {
        properties: {
          id: { type: 'string', readOnly: true },
          password: { type: 'string', writeOnly: true },
        },
      },
      { required: ['id', 'password'] },
    ],
  };
  const snapshot = structuredClone(schema);
  const plan = compileCodec(schema);
  assert.equal(executeCodec({ password: 's' }, plan, { mode: 'request' }).password, 's');
  assert.equal(executeCodec({ id: 'x' }, plan, { mode: 'response' }).id, 'x');
  assert.throws(
    () => executeCodec({ id: 'x', password: 's' }, plan, { mode: 'request' }),
    /readOnly/,
  );
  assert.throws(() => executeCodec({}, plan, { mode: 'response' }), /id: required/);
  assert.deepEqual(schema, snapshot);
  assert.deepEqual(compileCodec(schema), plan);
});

test('unknown codec instruction is rejected rather than treated as dynamic', () => {
  assert.throws(
    () =>
      executeCodec('x', { ...compileCodec({}), value: { kind: 'future' } }, { mode: 'response' }),
    /Unknown codec instruction/,
  );
});

test('compiled and dynamic codecs in both languages obey independent serialization fixtures', async () => {
  const { readFileSync, mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const { assertCodecPlan } = await import('../dist/codec-plan.js');
  const fixtures = JSON.parse(
    readFileSync(new URL('./fixtures/serialization-cases.json', import.meta.url)),
  );
  const cases = [
    ...fixtures,
    {
      name: 'recursive graph',
      schema: {
        'x-sdk-ref': 'List',
        'x-sdk-definitions': {
          List: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'integer', format: 'int64' }, next: { 'x-sdk-ref': 'List' } },
          },
        },
      },
      value: { id: '9007199254740993', next: { id: '2' } },
      wire: '{"id":9007199254740993,"next":{"id":2}}',
    },
    {
      name: 'recursive invalid child',
      schema: {
        'x-sdk-ref': 'List',
        'x-sdk-definitions': {
          List: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string' }, next: { 'x-sdk-ref': 'List' } },
          },
        },
      },
      value: { id: 'a', next: {} },
      error: true,
    },
    {
      name: 'composition direction',
      schema: {
        type: 'object',
        allOf: [{ properties: { id: { type: 'string', readOnly: true } } }, { required: ['id'] }],
      },
      value: {},
      wire: '{}',
    },
  ];
  const dir = mkdtempSync(join(tmpdir(), 'sdk-codec-adapters-'));
  try {
    for (const filename of ['Runtime.php', 'SchemaAdapter.php'])
      writeFileSync(
        join(dir, filename),
        readFileSync(new URL('../templates/' + filename, import.meta.url)),
      );
    const compiled = cases.map((c) => ({ ...c, plan: compileCodec(c.schema) }));
    for (const c of compiled) {
      assertCodecPlan(c.plan, c.name);
      if (c.error) {
        assert.throws(() => normalize(c.value, c.schema), undefined, c.name);
        assert.throws(() => executeCodec(c.value, c.plan, { mode: 'request' }), undefined, c.name);
      } else {
        assert.equal(serialize(c.value, c.schema), c.wire, c.name);
        assert.deepEqual(
          executeCodec(c.value, c.plan, { mode: 'request' }),
          normalize(c.value, c.schema),
          c.name,
        );
      }
    }
    const program = String.raw`
      require $argv[1].'/Runtime.php';
      $cases=json_decode(stream_get_contents(STDIN),false,512,JSON_THROW_ON_ERROR);
      foreach($cases as $case){
        $schema=json_decode(json_encode($case->schema),true,512,JSON_THROW_ON_ERROR);
        $plan=json_decode(json_encode($case->plan),true,512,JSON_THROW_ON_ERROR);
        \SdkNamespace\Codec::assertPlan($plan,$case->name);
        foreach([false,true] as $compiled){
          try{$value=$compiled?\SdkNamespace\Codec::execute($case->value,$plan):\SdkNamespace\Codec::normalize($case->value,$schema);$wire=\SdkNamespace\Codec::encode($value);}
          catch(\SdkNamespace\SdkError $e){if($case->error??false)continue;throw $e;}
          if(($case->error??false)||$wire!==$case->wire)throw new \Exception($case->name.': '.$wire);
        }
      }
      $plan['value']=['kind'=>'future'];
      try{\SdkNamespace\Codec::assertPlan($plan);exit(4);}catch(\InvalidArgumentException $e){}
      try{\SdkNamespace\Codec::execute('x',$plan);exit(5);}catch(\InvalidArgumentException $e){}
      echo 'ok';
    `;
    const result = spawnSync('php', ['-r', program, dir], {
      input: JSON.stringify(compiled),
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.equal(result.stdout, 'ok');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('public dynamic helpers retain caller-owned schema mutation behavior without a global cache', async () => {
  const { Model, Runtime } = await import('../dist/runtime.js');
  const { inspect } = await import('node:util');
  const schema = { type: 'object', properties: { value: { type: 'string' } } };
  const model = new Model({ value: 'private-value' }, schema);
  schema.properties.value['x-sensitive'] = true;
  assert.ok(!inspect(model).includes('private-value'));
  schema.properties.value.type = 'integer';
  assert.throws(() => serialize({ value: 'x' }, schema), /integer/);
  assert.equal(serialize({ value: 2 }, schema), '{"value":2}');
  const contract = {
    operations: [
      {
        id: 'read',
        verb: 'GET',
        path: '/value',
        parameters: [],
        responses: { 200: { schema: { type: 'string' } } },
      },
    ],
  };
  let body = '"old"';
  const runtime = new Runtime(contract, {
    baseUrl: 'https://example.invalid',
    transport: async () => new Response(body),
  });
  assert.equal((await runtime.request('read')).data, 'old');
  contract.operations[0].responses[200].schema.type = 'integer';
  body = '2';
  assert.equal((await runtime.request('read')).data, 2);
});

test('null-only type arrays retain the existing target-specific helper behavior', async () => {
  const { spawnSync } = await import('node:child_process');
  for (const schema of [{ type: ['null'] }, { type: [] }]) {
    assert.equal(serialize('value', schema), '"value"');
    assert.equal(executeCodec('value', compileCodec(schema), { mode: 'response' }), 'value');
    const program = String.raw`require 'templates/Runtime.php';$input=json_decode(stream_get_contents(STDIN),true);foreach([false,true] as $compiled){try{$compiled?\SdkNamespace\Codec::execute('value',$input['plan']):\SdkNamespace\Codec::normalize('value',$input['schema']);exit(2);}catch(\SdkNamespace\SdkError $e){}}echo 'ok';`;
    const result = spawnSync('php', ['-r', program], {
      input: JSON.stringify({ schema, plan: compileCodec(schema) }),
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'ok');
  }
  assert.equal(serialize(null, { type: ['null'] }), 'null');
  assert.throws(() => serialize('value', { type: 'null' }), /null/);
});
