import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadContract, generate, render, compare, prepareRelease } from '../dist/index.js';
import { normalize, executeCodec } from '../dist/runtime.js';
import { compileCodec } from '../dist/codec-plan.js';
import { compileResponsePlan } from '../dist/response-plan.js';

const root = mkdtempSync(join(tmpdir(), 'sdk-compiled-regressions-'));
after(() => rmSync(root, { recursive: true, force: true }));
const response = (schema) => ({
  description: 'Value',
  content: { 'application/json': { schema } },
});
function fixture(name, responses, { schemas, ...config } = {}) {
  const dir = join(root, name);
  mkdirSync(dir);
  const source = join(dir, 'api.json');
  const profile = join(dir, 'sdk.json');
  writeFileSync(
    source,
    JSON.stringify({
      openapi: '3.1.0',
      info: { title: 'Compiled regression', version: '1' },
      paths: { '/value': { get: { operationId: 'readValue', responses } } },
      ...(schemas ? { components: { schemas } } : {}),
    }),
  );
  writeFileSync(
    profile,
    JSON.stringify({
      responses: { return: 'result' },
      version: '1.0.0',
      requests: { style: 'object' },
      npm: { name: '@example/compiled-regression' },
      composer: { name: 'example/compiled-regression', namespace: 'Example\\Regression' },
      release: { policy: 'semver' },
      ...config,
    }),
  );
  return { dir, output: join(dir, 'sdk'), contract: loadContract(source, profile) };
}
function php(output, program, input) {
  const result = spawnSync(
    'php',
    [
      '-r',
      String.raw`
    require $argv[1].'/src/Runtime.php';
    require $argv[1].'/src/Client.php';
  ` + program,
      join(output, 'php'),
    ],
    { input: JSON.stringify(input), encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr + result.stdout);
  return JSON.parse(result.stdout);
}

test('generated error details redact shared definitions for explicit and default PHP responses', async () => {
  const ref = { $ref: '#/components/schemas/Detail' };
  const detail = {
    type: 'object',
    properties: {
      privateValue: { type: 'string', 'x-sensitive': true },
      hiddenValue: { type: 'string', writeOnly: true },
      child: ref,
    },
  };
  const payload = {
    privateValue: 'top-value',
    hiddenValue: 'top-hidden',
    child: { privateValue: 'nested-value', hiddenValue: 'nested-hidden' },
  };
  const expected = {
    privateValue: '[REDACTED]',
    hiddenValue: '[REDACTED]',
    child: { privateValue: '[REDACTED]', hiddenValue: '[REDACTED]' },
  };
  for (const status of ['400', 'default'])
    for (const detailsPath of [false, true]) {
      const f = fixture(
        `redaction-${status}-${detailsPath}`,
        {
          200: { description: 'Empty' },
          [status]: response(detailsPath ? { type: 'object', properties: { payload: ref } } : ref),
        },
        {
          schemas: { Detail: detail },
          ...(detailsPath ? { errors: { detailsPath: 'payload' } } : {}),
        },
      );
      generate(f.contract, f.output);
      const body = JSON.stringify(detailsPath ? { payload } : payload);
      const { Client } = await import(pathToFileURL(join(f.output, 'node/index.js')));
      const client = new Client({
        baseUrl: 'https://example.invalid',
        transport: async () => new Response(body, { status: 400 }),
      });
      await assert.rejects(client.api.readValue(), (error) => {
        assert.deepEqual(error.details, expected);
        assert.equal(error.raw, body);
        return error.kind === 'validation';
      });
      const result = php(
        f.output,
        String.raw`
      $body=json_decode(stream_get_contents(STDIN));
      $client=new Example\Regression\Client(new Example\Regression\ClientOptions(
        'https://example.invalid', transport:fn($r)=>['status'=>400,'headers'=>[],'body'=>$body]
      ));
      try{$client->api->readValue();exit(2);}
      catch(Example\Regression\SdkError $e){echo json_encode(['kind'=>$e->kind,'details'=>$e->details,'raw'=>$e->raw]);}
    `,
        body,
      );
      assert.equal(result.kind, 'validation');
      assert.deepEqual(result.details, expected);
      assert.equal(result.raw, body);
    }
});

test('generated clients and schema adapters retain unknown alternatives for object type arrays', async () => {
  for (const keyword of ['oneOf', 'anyOf'])
    for (const [type, acceptsUnknown] of [
      ['object', false],
      [['object'], true],
      [['object', 'null'], true],
    ]) {
      const schema = {
        [keyword]: [{ type, required: ['id'], properties: { id: { type: 'string' } } }],
      };
      const f = fixture(`${keyword}-${JSON.stringify(type)}`, { 200: response(schema) });
      generate(f.contract, f.output);
      const { Client } = await import(pathToFileURL(join(f.output, 'node/index.js')));
      const cases = [
        { value: { id: 'known' }, accepted: true },
        { value: 'future', accepted: acceptsUnknown },
        { value: ['future'], accepted: acceptsUnknown },
        { value: null, accepted: acceptsUnknown },
      ];
      for (const { value, accepted } of cases) {
        const client = new Client({
          baseUrl: 'https://example.invalid',
          transport: async () => new Response(JSON.stringify(value)),
        });
        const evaluate = [
          () => normalize(value, schema, 'response', true),
          () => executeCodec(value, compileCodec(schema), { mode: 'response' }),
        ];
        if (accepted) {
          assert.deepEqual(JSON.parse(JSON.stringify((await client.api.readValue()).data)), value);
          for (const call of evaluate) assert.deepEqual(JSON.parse(JSON.stringify(call())), value);
        } else {
          await assert.rejects(client.api.readValue(), (error) => error.kind === 'protocol');
          for (const call of evaluate)
            assert.throws(call, /expected an object response alternative/);
        }
      }
      const result = php(
        f.output,
        String.raw`
      $input=json_decode(stream_get_contents(STDIN));
      $schema=json_decode(json_encode($input->schema),true);
      $results=[];
      foreach($input->cases as $case){
        $client=new Example\Regression\Client(new Example\Regression\ClientOptions(
          'https://example.invalid',transport:fn($r)=>['status'=>200,'headers'=>[],'body'=>json_encode($case->value)]
        ));
        foreach([false,true] as $dynamic){
          try{$data=$dynamic?Example\Regression\Codec::plainNumbers(Example\Regression\Codec::normalize($case->value,$schema,response:true)):$client->api->readValue()->data;$results[]=['data'=>$data];}
          catch(Example\Regression\SdkError $e){$results[]=['kind'=>$e->kind];}
        }
      }
      echo json_encode($results);
    `,
        { schema, cases },
      );
      assert.deepEqual(
        result,
        cases.flatMap(({ value, accepted }) =>
          accepted
            ? [{ data: value }, { data: value }]
            : [{ kind: 'protocol' }, { kind: 'validation' }],
        ),
      );
    }
});

test('equivalent array type syntax preserves nested guarantees and permits patch releases', async () => {
  const array = { type: 'array', items: { type: 'string' } };
  const singleton = { ...array, type: ['array'] };
  for (const wrap of [
    (s) => s,
    (s) => ({ type: 'array', items: s }),
    (s) => ({ type: 'object', properties: { value: s }, required: ['value'] }),
    (s) => ({ type: 'object', additionalProperties: s }),
  ])
    assert.deepEqual(compileResponsePlan(wrap(singleton)), compileResponsePlan(wrap(array)));
  const f = fixture('array-release', { 200: response(array) }, { targets: ['node'] });
  const next = structuredClone(f.contract);
  next.config.version = '1.0.1';
  next.operations[0].responses['200'].schema = singleton;
  assert.equal(render(f.contract).get('node/index.d.ts'), render(next).get('node/index.d.ts'));
  assert.ok(!compare(f.contract, next).some((finding) => finding.severity === 'breaking'));
  const added = structuredClone(f.contract);
  added.operations[0].responses['201'] = { schema: singleton, mediaType: 'application/json' };
  assert.ok(!compare(f.contract, added).some((finding) => finding.severity === 'breaking'));
  generate(f.contract, f.output);
  generate(next, f.output);
  const { Client } = await import(pathToFileURL(join(f.output, 'node/index.js')));
  const client = new Client({
    baseUrl: 'https://example.invalid',
    transport: async () => new Response('["value"]'),
  });
  assert.deepEqual((await client.api.readValue()).data, ['value']);
  assert.doesNotThrow(() => prepareRelease(f.output, join(f.dir, 'release')));
});
