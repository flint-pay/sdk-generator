import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { generate, loadContract } from '../dist/index.js';
import { compileCodec, assertCodecPlan } from '../dist/codec-plan.js';
import { compareCompiledContracts } from '../dist/compiled-compatibility.js';
import { compileSdkContract } from '../dist/target-plan.js';

const dir = mkdtempSync(join(tmpdir(), 'sdk-nullable-responses-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const detail = {
  type: 'object',
  required: ['level'],
  properties: {
    level: { type: 'string', enum: ['low'] },
    // Force normal codec sharing, including an interned concrete nullable branch.
    context: {
      type: 'object',
      properties: Object.fromEntries(
        Array.from({ length: 12 }, (_, i) => ['field_' + i, { type: 'string' }]),
      ),
    },
  },
  additionalProperties: false,
};
const nullable = (keyword, reversed = false) => ({
  [keyword]: reversed
    ? [{ type: 'null' }, { $ref: '#/components/schemas/Detail' }]
    : [{ $ref: '#/components/schemas/Detail' }, { type: 'null' }],
});
const api = {
  openapi: '3.1.0',
  info: { title: 'Nullable values', version: '1' },
  components: { schemas: { Detail: detail } },
  paths: {
    '/values': {
      get: {
        operationId: 'getValues',
        responses: {
          200: {
            description: 'values',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    risk: { ...nullable('anyOf'), readOnly: true },
                    reversed: nullable('oneOf', true),
                    inline: { anyOf: [detail, { type: 'null' }] },
                    choice: {
                      anyOf: [
                        detail,
                        {
                          type: 'object',
                          required: ['code'],
                          properties: { code: { type: 'string' } },
                        },
                      ],
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};
writeFileSync(join(dir, 'api.json'), JSON.stringify(api));
writeFileSync(
  join(dir, 'sdk.json'),
  JSON.stringify({
    version: '1.0.0',
    npm: { name: '@example/nullable' },
    composer: { name: 'example/nullable', namespace: 'Example\\Nullable' },
  }),
);
const contract = loadContract(join(dir, 'api.json'), join(dir, 'sdk.json'));
const out = join(dir, 'out');
generate(contract, out);
const sdk = await import(pathToFileURL(join(out, 'node/index.js')).href);
const valid = {
  risk: { level: 'future', additional: true },
  reversed: { level: 'low' },
  inline: { level: 'low' },
  choice: { future: true },
};
const cases = [valid, { risk: null, reversed: null, inline: null }, {}];
const malformed = [{ risk: {} }, { risk: { level: 1 } }, { risk: [] }, { risk: true }];
function php(source) {
  const result = spawnSync(
    'php',
    [
      '-r',
      String.raw`require $argv[1].'/src/Runtime.php';require $argv[1].'/src/Client.php';` + source,
      join(out, 'php'),
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout;
}

test('nullable generated response fields keep shaped TypeScript types and PHP class names', () => {
  const consumer = join(out, 'node/consumer.ts');
  writeFileSync(
    consumer,
    `import {Client, type Detail} from './index.js';
const result = await new Client({baseUrl:'https://example.invalid'}).api.getValues();
const level: string | undefined = result.risk?.level;
const reversed: string | undefined = result.reversed?.level;
const inline: string | undefined = result.inline?.level;
const named: Detail | null | undefined = result.risk;
// @ts-expect-error known nullable objects still catch typos
result.risk?.leevl;
// @ts-expect-error true polymorphic alternatives still require narrowing
result.choice?.level;
`,
  );
  const checked = spawnSync(
    process.execPath,
    [
      resolve('node_modules/typescript/bin/tsc'),
      '--strict',
      '--noEmit',
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--typeRoots',
      resolve('node_modules/@types'),
      consumer,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  assert.equal(
    php(String.raw`
$r=new ReflectionMethod(Example\Nullable\ApiGetValuesResponse200::class,'getRisk');
$type=$r->getReturnType();echo $type->getName().($type->allowsNull()?'|null':'');
`),
    'Example\\Nullable\\Detail|null',
  );
});

test('PHPStan verifies nullable entity getters without casts', () => {
  const consumer = join(dir, 'consumer.php');
  writeFileSync(
    consumer,
    String.raw`<?php
use Example\Nullable\{Client,Detail};
function level(Client $client): ?string {return $client->api->getValues()->getRisk()?->getLevel();}
function detail(Client $client): ?Detail {return $client->api->getValues()->getRisk();}
`,
  );
  const config = join(dir, 'phpstan.neon');
  writeFileSync(
    config,
    `parameters:\n    level: max\n    phpVersion: 80200\n    tmpDir: ${JSON.stringify(join(dir, 'cache'))}\n    scanDirectories:\n        - ${JSON.stringify(join(out, 'php/src'))}\n`,
  );
  const checked = spawnSync(
    'php',
    [
      resolve('.generated/phpstan-vendor/bin/phpstan'),
      'analyse',
      '--no-progress',
      '--error-format=raw',
      '-c',
      config,
      consumer,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
});

test('Node response decoding preserves fields/enums, null, omission, and genuine unknown variants', async () => {
  let payload;
  const client = new sdk.Client({
    baseUrl: 'https://example.invalid',
    transport: async () => new Response(JSON.stringify(payload)),
  });
  for (payload of cases)
    assert.deepEqual(JSON.parse(JSON.stringify(await client.api.getValues())), payload);
  for (payload of malformed) await assert.rejects(client.api.getValues(), { kind: 'protocol' });
});

test('PHP response getters hydrate known nullable entities and retain raw JSON values', () => {
  writeFileSync(join(dir, 'cases.json'), JSON.stringify({ cases, malformed }));
  assert.equal(
    php(String.raw`
use Example\Nullable\{Client,ClientOptions,Detail,SdkError};
$fixtures=json_decode(file_get_contents($argv[1].'/../../cases.json'),true);
$body='{}';$c=new Client(new ClientOptions('https://example.invalid',transport:function()use(&$body){return ['status'=>200,'headers'=>[],'body'=>$body];}));
foreach($fixtures['cases'] as $i=>$payload){
 $body=json_encode((object)$payload);$r=$c->api->getValues();
 if($i===0){if(!($r->getRisk() instanceof Detail)||$r->getRisk()->getLevel()!=='future'||$r->getRisk()->get('additional')!==true||!($r->getReversed() instanceof Detail)||!($r->getInline() instanceof Detail)||$r->getChoice()->future!==true)exit(2);
 if(!($r->get('risk') instanceof Detail)||!($r->risk instanceof Detail)||$r->risk->getLevel()!=='future')exit(3);
 if(json_decode(json_encode($r),true)!==$payload)exit(4);}
 if($i===1&&($r->getRisk()!==null||$r->getReversed()!==null||$r->getInline()!==null))exit(5);
 if($i===2){if($r->hasRisk())exit(6);try{$r->getRisk();exit(7);}catch(SdkError $e){}}
}
foreach($fixtures['malformed'] as $payload){$body=json_encode($payload);try{$c->api->getValues();exit(8);}catch(SdkError $e){if($e->kind!=='protocol')throw $e;}}
echo 'ok';
`),
    'ok',
  );
});

test('nullable policy is deterministic and malformed serialized policies are rejected', () => {
  const before = JSON.stringify(contract);
  assert.deepEqual(compileSdkContract(contract), compileSdkContract(contract));
  assert.equal(JSON.stringify(contract), before);
  const codec = compileCodec({ anyOf: [detail, { type: 'null' }] });
  assert.equal(codec.nullableAlternative, 0);
  assertCodecPlan(codec);
  for (const nullableAlternative of [-1, 2, '0', null])
    assert.throws(() => assertCodecPlan({ ...codec, nullableAlternative }), /nullable alternative/);
  assert.throws(
    () => assertCodecPlan({ ...codec, some: [codec.some[0], codec.some[0]] }),
    /null alternative/,
  );
  for (const concrete of [
    codec.some[1],
    { ...codec.some[0], nullable: true },
    { ...codec.some[0], value: { kind: 'dynamic' } },
  ])
    assert.throws(
      () => assertCodecPlan({ ...codec, some: [concrete, codec.some[1]] }),
      /concrete nullable/,
    );
  assert.equal(compileCodec({ anyOf: [detail, detail] }).nullableAlternative, undefined);
  assert.equal(
    php(String.raw`
use Example\Nullable\Codec;
$plan=['value'=>['kind'=>'dynamic'],'nullable'=>true,'modelObjectInput'=>false,'requiredInput'=>[],'requiredOutput'=>[],'rejectInput'=>false,'hiddenOutput'=>false,'sensitive'=>false,'checks'=>[],'nullableAlternative'=>2,'some'=>[]];
foreach([-1,2,'0',null] as $index){$plan['nullableAlternative']=$index;try{Codec::assertPlan($plan);exit(2);}catch(InvalidArgumentException $e){}}
$null=$plan;unset($null['some'],$null['nullableAlternative']);$null['value']=['kind'=>'null'];
$plan['nullableAlternative']=0;$plan['some']=[$null,$null];
try{Codec::assertPlan($plan);exit(3);}catch(InvalidArgumentException $e){echo 'ok';}
`),
    'ok',
  );
});

test('historical nullable fallback decoding and PHP values remain visible to compatibility review', () => {
  const { plan: next } = compileSdkContract(contract);
  const previous = structuredClone(next);
  const response = previous.runtime.operations.find((op) => op.id === 'getValues').responses['200'];
  const resolveCodec = (codec) => {
    while (codec.reference) {
      codec = previous.runtime.definitions[codec.reference];
      assert(codec);
    }
    return codec;
  };
  const risk = resolveCodec(resolveCodec(response.codec).fields.risk);
  assert.equal(risk.nullableAlternative, 0);
  assert(risk.some[0].reference, 'large known branch retains normal codec sharing');
  delete risk.nullableAlternative;
  assert(
    compareCompiledContracts(previous, next).some(
      (f) =>
        f.severity === 'review' &&
        f.subject === 'compiled codecs' &&
        f.message.includes('decoding'),
    ),
  );
  const entity = previous.php.models.find(
    (model) => model.representation?.kind === 'record' && model.representation.fields.risk,
  );
  assert(entity);
  entity.representation.fields.risk = { kind: 'value', type: 'mixed' };
  assert(
    compareCompiledContracts(previous, next).some(
      (f) => f.severity === 'breaking' && f.message.includes('representation'),
    ),
  );
  assert.equal(
    previous.php.models.find((model) => model.name === 'Detail').name,
    next.php.models.find((model) => model.name === 'Detail').name,
  );
});
