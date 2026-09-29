import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { generate, loadContract } from '../dist/index.js';
import { compileCodec, assertCodecPlan } from '../dist/codec-plan.js';
import { executeCodec, serialize, ExactNumber, Model } from '../dist/runtime.js';
import { compileSdkContract } from '../dist/target-plan.js';
import { compareCompiledContracts } from '../dist/compiled-compatibility.js';

const dir = mkdtempSync(join(tmpdir(), 'sdk-value-representations-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const date = { type: 'string', format: 'date-time' };
const fields = {
  receipt_email: { type: 'string' },
  status: { type: 'string', enum: ['succeeded'] },
  latitude: { type: 'number' },
  numeric_enum: { type: 'number', enum: [1] },
  numeric_const: { type: 'number', const: 0.25 },
  child: { $ref: '#/components/schemas/Value' },
  change_percent: { type: 'number', format: 'double' },
  decimal: { type: 'number', format: 'decimal' },
  large: { type: 'integer', format: 'int64' },
  at: { $ref: '#/components/schemas/Timestamp' },
  dates: { type: 'array', items: date },
  times: { type: 'object', additionalProperties: date },
  choice: { anyOf: [date, { type: 'boolean' }] },
  composed_date: { allOf: [date, { type: 'string', minLength: 24 }] },
  numeric_choice: { oneOf: [{ type: 'number' }, { type: 'string' }] },
  secret_only: { type: 'object', properties: { secret: { type: 'string', writeOnly: true } } },
  open: { type: 'object', properties: { known: { type: 'string' } }, additionalProperties: true },
  mixed: {
    type: 'object',
    properties: { known: { type: 'string' } },
    additionalProperties: { type: 'number' },
  },
  variant: {
    oneOf: [
      { type: 'object', required: ['kind'], properties: { kind: { type: 'string', enum: ['a'] } } },
      { type: 'object', required: ['kind'], properties: { kind: { type: 'string', enum: ['b'] } } },
    ],
  },
};
const schema = { type: 'object', properties: fields };
const ref = { $ref: '#/components/schemas/Value' };
writeFileSync(
  join(dir, 'api.json'),
  JSON.stringify({
    openapi: '3.1.0',
    info: { title: 'Values', version: '1' },
    components: { schemas: { Value: schema, Timestamp: date } },
    paths: {
      '/values': {
        post: {
          operationId: 'save',
          parameters: [
            { in: 'query', name: 'at', schema: date },
            { in: 'query', name: 'latitude', schema: { type: 'number' } },
          ],
          requestBody: { required: true, content: { 'application/json': { schema: ref } } },
          responses: {
            200: { description: 'value', content: { 'application/json': { schema: ref } } },
          },
        },
      },
    },
  }),
);
writeFileSync(
  join(dir, 'sdk.json'),
  JSON.stringify({
    version: '1.0.0',
    validation: 'schema',
    responses: { return: 'result' },
    requests: { style: 'object' },
    npm: { name: '@example/values' },
    composer: { name: 'example/values', namespace: 'Example\\Values' },
  }),
);
const contract = loadContract(join(dir, 'api.json'), join(dir, 'sdk.json'));
const out = join(dir, 'out');
generate(contract, out);
const sdk = await import(pathToFileURL(join(out, 'node/index.js')).href);
const stamp = '2026-09-28T16:34:56.789Z';
const wire =
  '{"latitude":42.125,"change_percent":-0.25,"decimal":1.00000000000000000001,"large":9007199254740993,"at":"2026-09-28T16:34:56.789Z","dates":["2026-09-28T16:34:56.789Z"],"times":{"sent":"2026-09-28T16:34:56.789Z"},"choice":"2026-09-28T16:34:56.789Z","numeric_choice":0.125}';
function php(source) {
  const result = spawnSync(
    'php',
    [
      '-r',
      String.raw`require $argv[1].'/src/Runtime.php'; require $argv[1].'/src/Client.php'; ` +
        source,
      join(out, 'php'),
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout;
}

test('generated clients encode native numbers and dates and retain exact formats', async () => {
  const nativeDate = new Date('2026-09-28T12:34:56.789-04:00');
  assert.equal(
    sdk.makeValue({ child: { at: nativeDate, latitude: 0.25 } }).toJSON().child.at,
    stamp,
  );
  const input = {
    latitude: 42.125,
    change_percent: -0.25,
    decimal: '1.00000000000000000001',
    large: '9007199254740993',
    at: nativeDate,
    dates: [nativeDate],
    times: { sent: nativeDate },
    choice: nativeDate,
    numeric_choice: 0.125,
  };
  let calls = 0;
  const client = new sdk.Client({
    baseUrl: 'https://example.invalid',
    transport: async (url, request) => {
      calls++;
      assert.equal(request.body, wire);
      assert.equal(new URL(url).searchParams.get('at'), stamp);
      assert.equal(new URL(url).searchParams.get('latitude'), '42.125');
      return new Response(wire.slice(0, -1) + ',"future":true}', { status: 200 });
    },
  });
  for (const body of [input, sdk.makeValue(input)]) {
    const result = await client.api.save({ body, at: nativeDate, latitude: 42.125 });
    assert.equal(result.data.latitude, 42.125);
    assert.equal(result.data.change_percent, -0.25);
    assert.equal(result.data.decimal, '1.00000000000000000001');
    assert.equal(result.data.large, '9007199254740993');
    assert.equal(result.data.at, stamp);
    assert.equal(result.data.future, true);
  }
  assert.equal(calls, 2);
  assert.equal(nativeDate.toISOString(), stamp);
  assert.equal(sdk.makeValue(input).toJSON().latitude, 42.125);
  assert.equal(
    php(String.raw`
use Example\Values\{Client,ClientOptions,ValueInput,ApiSaveInput,TimestampInput};
$d=new DateTime('2026-09-28T12:34:56.789-04:00');
$input=['latitude'=>42.125,'change_percent'=>-0.25,'decimal'=>'1.00000000000000000001','large'=>'9007199254740993','at'=>$d,'dates'=>[$d],'times'=>['sent'=>$d],'choice'=>$d,'numeric_choice'=>0.125];
$c=new Client(new ClientOptions('https://example.invalid',transport:function($r){parse_str(parse_url($r['url'],PHP_URL_QUERY),$q);if($q['at']!=='2026-09-28T16:34:56.789Z'||$q['latitude']!=='42.125')exit(6);echo $r['body']."\n";return ['status'=>200,'headers'=>[],'body'=>substr($r['body'],0,-1).',"future":true}'];}));
foreach ([$input,new ValueInput($input)] as $body) {
 $r=$c->api->save(new ApiSaveInput(['body'=>$body,'at'=>$d,'latitude'=>42.125]));
 if($r->data->latitude!==42.125 || $r->data->change_percent!==-0.25 || $r->data->at!=='2026-09-28T16:34:56.789Z' || $r->data->future!==true || $r->data->decimal!=='1.00000000000000000001' || $r->data->large!=='9007199254740993') exit(2);
}
if($d->format('P')!=='-04:00') exit(3);
if((new TimestampInput($d))->jsonSerialize()!=='2026-09-28T16:34:56.789Z') exit(4);
`),
    wire + '\n' + wire + '\n',
  );
});

test('generated TypeScript catches typos and retains deliberate open types', () => {
  const file = join(out, 'node/consumer.ts');
  writeFileSync(
    file,
    `import { Client, makeValue, makeTimestamp, type Value, type ValueInput } from './index.js';
import { Client as ScopedClient } from './resources/api.js';
const client = new Client({baseUrl:'https://example.invalid'});
client.api.save({body:{receipt_email:'demo@example.invalid', latitude:42.125, at:new Date(), numeric_choice:1}});
new ScopedClient({baseUrl:'https://example.invalid'}).api.save({body:{at:new Date()}});
makeTimestamp(new Date());
makeValue({composed_date:new Date(), numeric_enum:1, numeric_const:0.25, child:{at:new Date()}});
// @ts-expect-error native numeric enums use numeric literals
makeValue({numeric_enum:'1'});
// @ts-expect-error native numeric constants use numeric literals
makeValue({numeric_const:'0.25'});
makeValue({open:{known:'x',extra:true}, times:{sent:new Date()}, mixed:{known:'x',extra:1}});
// @ts-expect-error misspelled input field
client.api.save({body:{recipt_email:'demo@example.invalid'}});
// @ts-expect-error factory input typo
makeValue({recipt_email:'demo@example.invalid'});
// @ts-expect-error native numbers do not accept strings
makeValue({latitude:'42.125'});
declare const r: {data:{data:Value}};
// @ts-expect-error misspelled response field
r.data.data.stauts === 'succeeded';
// @ts-expect-error filtering write-only fields must not reopen a shaped response
r.data.data.secret_only?.stauts;
const latitude: number | undefined = r.data.data.latitude;
const at: string | undefined = r.data.data.at;
// @ts-expect-error future variants require narrowing
r.data.data.variant?.stauts;
const input: ValueInput = {at:new Date()};
`,
  );
  const result = spawnSync(
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
      file,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('native-number codecs enforce finite values and exact validation before projection', () => {
  for (const format of [undefined, 'float', 'double']) {
    const s = { type: 'number', ...(format ? { format } : {}) };
    const plan = compileCodec(s);
    assert.equal(plan.value.kind, 'native-number');
    assertCodecPlan(plan);
    assert.equal(serialize(0.125, s), '0.125');
    for (const bad of ['0.125', NaN, Infinity, -Infinity])
      assert.throws(() => serialize(bad, s), { kind: 'validation' });
    assert.equal(executeCodec(new ExactNumber('0.125'), plan, { mode: 'response' }), 0.125);
    assert.throws(
      () => executeCodec(new ExactNumber('1e999'), plan, { mode: 'response' }),
      /finite/,
    );
  }
  assert.equal(serialize(0.25, { type: 'number', enum: [0.25] }), '0.25');
  assert.equal(serialize(0.25, { type: 'number', const: 0.25 }), '0.25');
  assert.equal(serialize(0.25, { type: 'number', multipleOf: 0.25 }), '0.25');
  assert.throws(() => serialize(0.3, { type: 'number', multipleOf: 0.25 }), /multipleOf/);
  const bounded = compileCodec({ type: 'number', maximum: 0.1 });
  assert.throws(
    () =>
      executeCodec(new ExactNumber('0.10000000000000001'), bounded, {
        mode: 'match',
        direction: 'response',
      }),
    /maximum/,
  );
  assert.equal(
    executeCodec(new ExactNumber('0.10000000000000001'), bounded, { mode: 'response' }),
    0.1,
  );
  assert.equal(serialize(2, { allOf: [{ type: 'number' }, { type: 'integer' }] }), '2');
  assert.equal(serialize(null, { type: ['number', 'null'] }), 'null');
});

test('date conveniences remain schema directed, validated and nonmutating', () => {
  const native = new Date(stamp);
  for (const s of [
    date,
    { allOf: [date, { type: 'string', minLength: 24 }] },
    { anyOf: [date, { type: 'boolean' }] },
  ]) {
    assert.equal(serialize(native, s), JSON.stringify(stamp));
    assert.equal(new Model(native, s).toJSON(), stamp);
  }
  assert.throws(() => serialize(new Date(NaN), date), /valid Date/);
  assert.throws(() => serialize(native, { type: 'string' }), /string/);
  assert.throws(() => serialize(native, { type: 'string', format: 'date' }), /string/);
  assert.equal(serialize('offset string', date), '"offset string"');
  assert.equal(native.toISOString(), stamp);
  assert.equal(
    php(String.raw`
use Example\Values\{Codec,SdkError};
foreach ([['type'=>'number'],['type'=>'number','format'=>'float'],['type'=>'number','format'=>'double']] as $s) {
 if(Codec::encode(Codec::normalize(0.125,$s))!=='0.125') exit(2);
 foreach (['0.125',NAN,INF,-INF] as $bad) {try {Codec::normalize($bad,$s);exit(3);}catch(SdkError $e){}}
 try {Codec::normalize(Codec::parse('1e999',true),$s,'response',true);exit(4);}catch(SdkError $e){}
}
foreach ([['type'=>'number','enum'=>[0.25]],['type'=>'number','const'=>0.25],['type'=>'number','multipleOf'=>0.25]] as $s) if(Codec::encode(Codec::normalize(0.25,$s))!=='0.25')exit(5);
$d=new DateTimeImmutable('2026-09-28T12:34:56.789-04:00');
$s=['allOf'=>[['type'=>'string','format'=>'date-time'],['type'=>'string','minLength'=>24]]];
echo Codec::encode(Codec::normalize($d,$s));
`),
    JSON.stringify(stamp),
  );
});

test('compiled representation changes are reported as breaking without reinterpreting old codecs', () => {
  const { plan: next } = compileSdkContract(contract);
  const previous = structuredClone(next);
  previous.runtime.semantics = '3';
  assert(
    compareCompiledContracts(previous, next).some(
      (f) => f.severity === 'breaking' && f.subject === 'SDK value representations',
    ),
  );
  assert.equal(
    executeCodec(
      '0.125',
      { ...compileCodec({ type: 'number' }), value: { kind: 'decimal' } },
      { mode: 'response' },
    ),
    '0.125',
  );
});

test('invalid native inputs stop dispatch; native response overflow is a protocol error', async () => {
  let calls = 0;
  let raw = '{"latitude":1e999}';
  const client = new sdk.Client({
    baseUrl: 'https://example.invalid',
    transport: async () => {
      calls++;
      return new Response(raw);
    },
  });
  for (const body of [{ latitude: '1.25' }, { latitude: Infinity }, { at: new Date(NaN) }])
    await assert.rejects(client.api.save({ body }), { kind: 'validation' });
  assert.equal(calls, 0);
  await assert.rejects(client.api.save({ body: {} }), { kind: 'protocol' });
  raw = '{"latitude":0.10000000000000001,"future":0.10000000000000001}';
  const result = await client.api.save({ body: {} });
  assert.equal(result.data.latitude, 0.1);
  assert.equal(result.data.future, '0.10000000000000001');
  assert.equal(
    php(String.raw`
use Example\Values\{Client,ClientOptions,ApiSaveInput,SdkError};
$calls=0;
$c=new Client(new ClientOptions('https://example.invalid',transport:function()use(&$calls){$calls++;return ['status'=>200,'headers'=>[],'body'=>'{"latitude":1e999}'];}));
foreach (['1.25',INF] as $bad) {try {$c->api->save(new ApiSaveInput(['body'=>['latitude'=>$bad]]));exit(2);}catch(SdkError $e){if($e->kind!=='validation')throw $e;}}
if($calls!==0)exit(3);
try {$c->api->save(new ApiSaveInput(['body'=>[]]));exit(4);}catch(SdkError $e){echo $e->kind;}
`),
    'protocol',
  );
});

test('native and exact anyOf projections merge only from the same validated token', () => {
  const branches = [{ type: 'number' }, { type: 'number', format: 'decimal' }];
  const token = '0.10000000000000001';
  for (const anyOf of [branches, [...branches].reverse()]) {
    const s = { anyOf };
    assert.equal(serialize(token, s), token);
    assert.equal(
      executeCodec(new ExactNumber(token), compileCodec(s), { mode: 'response' }),
      token,
    );
  }
  assert.equal(
    php(String.raw`
use Example\Values\Codec;
$branches=[['type'=>'number'],['type'=>'number','format'=>'decimal']];
foreach ([$branches,array_reverse($branches)] as $branches) {
 $s=['anyOf'=>$branches];
 if(Codec::normalize(1,$s,'response',true)!=='1')exit(4);
 $token='0.10000000000000001';
 if(Codec::encode(Codec::normalize($token,$s))!==$token)exit(2);
 if(Codec::normalize(Codec::parse($token,true),$s,'response',true)!==$token)exit(3);
}
$s=['allOf'=>[['type'=>'number'],['type'=>'integer']]];
if(Codec::normalize(2,$s,'response',true)!==2.0)exit(5);
echo 'ok';
`),
    'ok',
  );
});
