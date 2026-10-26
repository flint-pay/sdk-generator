import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { loadContract, generate } from '../dist/index.js';

const dir = mkdtempSync(join(tmpdir(), 'sdk-php-model-dx-'));
const output = join(dir, 'out');
after(() => rmSync(dir, { recursive: true, force: true }));
const item = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string' }, label: { type: ['string', 'null'] } },
};
const page = {
  type: 'object',
  required: ['data'],
  properties: {
    data: { type: 'array', items: { $ref: '#/components/schemas/Item' } },
    next: { type: 'string' },
    extra: { type: 'object', additionalProperties: true },
  },
};
const numeric = {
  type: 'object',
  required: ['count', 'amount'],
  properties: {
    count: { type: 'integer', format: 'int64' },
    amount: { type: 'number', format: 'decimal' },
    receipt: { type: 'string' },
  },
};
before(() => {
  writeFileSync(
    join(dir, 'api.json'),
    JSON.stringify({
      openapi: '3.1.0',
      info: { title: 'Models', version: '1' },
      components: { schemas: { Item: item, Page: page } },
      paths: {
        '/items/{id}': {
          get: {
            operationId: 'getItems',
            parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
            responses: {
              200: {
                description: 'Page',
                content: { 'application/json': { schema: { $ref: '#/components/schemas/Page' } } },
              },
            },
          },
        },
        '/numbers': {
          post: {
            operationId: 'saveNumbers',
            requestBody: { required: true, content: { 'application/json': { schema: numeric } } },
            responses: {
              200: { description: 'Numbers', content: { 'application/json': { schema: numeric } } },
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
      npm: { name: 'model-dx' },
      composer: { name: 'example/model-dx', namespace: 'ModelDx' },
      responses: { return: 'result' },
      operations: {
        getItems: { resource: 'catalog', method: 'retrieve' },
        saveNumbers: { resource: 'numbers', method: 'save' },
      },
    }),
  );
  generate(loadContract(join(dir, 'api.json'), join(dir, 'sdk.json')), output);
});
function php(code, args = [], options = []) {
  return execFileSync(
    'php',
    [
      ...options,
      '-r',
      String.raw`require $argv[1].'/php/src/Client.php'; ` + code,
      output,
      ...args,
    ],
    { encoding: 'utf8', timeout: 20000 },
  );
}

test('optional response access is nullable, presence-aware and typo-safe; required decode stays strict', async () => {
  assert.equal(
    php(String.raw`
use ModelDx\{Client,ClientOptions,SdkError};
$body='{"data":[{"id":"one"},{"id":"two","label":null}]}';
$c=new Client(new ClientOptions('https://example.invalid',transport:fn($r)=>['status'=>200,'headers'=>[],'body'=>$body]));
$p=$c->catalog->retrieve('list')->data;
if($p->next!==null || $p->getNext()!==null || $p->get('next')!==null || $p->has('next'))throw new Exception('omission');
if($p->data[0]->label!==null || $p->data[0]->has('label') || !$p->data[1]->has('label'))throw new Exception('presence');
foreach([fn()=>$p->nexxt,fn()=>$p->get('nexxt')] as $read){try{$read();throw new Exception('accepted typo');}catch(SdkError $e){if(!str_contains($e->getMessage(),'Unknown model property nexxt'))throw $e;}}
$c=new Client(new ClientOptions('https://example.invalid',transport:fn($r)=>['status'=>200,'headers'=>['x-request-id'=>'req_test'],'body'=>'{"data":[{}]}']));
try{$c->catalog->retrieve('list');throw new Exception('required field accepted');}catch(SdkError $e){if($e->kind!=='protocol' || $e->outcome!=='response' || !str_contains($e->getMessage(),'response.data[0].id') || !str_contains($e->getMessage(),'HTTP 200'))throw $e;}
echo 'ok';`),
    'ok',
  );
  const source = readFileSync(
    join(output, 'php/src/classes/CatalogRetrieveResponse200.php'),
    'utf8',
  );
  assert.match(source, /@property-read \?string \$next/);
  assert.match(source, /function getNext\(\): \?string/);
  const { Client } = await import(pathToFileURL(join(output, 'node/index.js')).href);
  const client = new Client({
    baseUrl: 'https://example.invalid',
    transport: async () => new Response('{"data":[{"id":"one"}]}'),
  });
  const result = await client.catalog.retrieve('list');
  assert.equal(result.data.next, undefined);
  assert.equal(Object.hasOwn(result.data, 'next'), false);
  const malformed = new Client({
    baseUrl: 'https://example.invalid',
    transport: async () => new Response('{"data":[{}]}'),
  });
  await assert.rejects(
    malformed.catalog.retrieve('list'),
    (e) => e.kind === 'protocol' && e.outcome === 'response',
  );
});

test('hydration caches immutable entities and collections while mutable values stay isolated', () => {
  assert.equal(
    php(String.raw`
use ModelDx\{Client,ClientOptions,SdkError};
$c=new Client(new ClientOptions('https://example.invalid',transport:fn($r)=>['status'=>200,'headers'=>[],'body'=>'{"data":[{"id":"one"}],"extra":{"nested":{"value":1}}}']));
$p=$c->catalog->retrieve('list')->data;
if($p->data[0]!==$p->data[0] || $p->getData()[0]!==$p->data[0])throw new Exception('unstable identity');
$copy=$p->data;unset($copy[0]);if(count($p->data)!==1)throw new Exception('mutable array');
$child=$p->data[0];try{$child->id='edited';throw new Exception('mutable model');}catch(SdkError $e){}
$copy=$p->extra;$copy['nested']->value=2;if($p->extra['nested']->value!==1)throw new Exception('mutable unknown object');
$copy=$p->toArray();$copy['data'][0]->id='edited';if($p->data[0]->id!=='one')throw new Exception('mutable export');
echo 'ok';`),
    'ok',
  );
});

test('native JSON parsing preserves numeric spellings, JSON string kinds, escapes and duplicate-key behavior', () => {
  const raw = String.raw`{"big":9007199254740993,"min":-9223372036854775808,"decimal":1.2300,"exp":5e3,"overflow":1e9999,"safe":9007199254740991,"negativeZero":-0,"string":"5e3","quoted":"escaped \" 1.2300 \\ 9007199254740993","marker":"\u00001.2300","doubleMarker":"\u0000\u00005e3","duplicate":9.999,"duplicate":1.000,"array":[1,1.0,"1.0"]}`;
  const parsed = JSON.parse(
    php(
      String.raw`
use ModelDx\{Codec,ParsedNumber};
$v=Codec::parse($argv[2],true);
if(!$v->decimal instanceof ParsedNumber || !$v->duplicate instanceof ParsedNumber || !is_string($v->string) || !is_int($v->safe))throw new Exception('numeric kinds');
echo json_encode(Codec::plainNumbers($v),JSON_THROW_ON_ERROR);`,
      [raw],
    ),
  );
  assert.deepEqual(parsed, {
    big: '9007199254740993',
    min: '-9223372036854775808',
    decimal: '1.2300',
    exp: '5e3',
    overflow: '1e9999',
    safe: 9007199254740991,
    negativeZero: 0,
    string: '5e3',
    quoted: 'escaped " 1.2300 \\ 9007199254740993',
    marker: '\0' + '1.2300',
    doubleMarker: '\0\0' + '5e3',
    duplicate: '1.000',
    array: [1, '1.0', '1.0'],
  });
  for (const invalid of ['01', '[1,]', '{"v":1.e3}', '"\\ud800"', '\ufeff{}']) {
    assert.equal(
      php(
        String.raw`try{ModelDx\Codec::parse($argv[2],true);echo 'accepted';}catch(JsonException $e){echo 'rejected';}`,
        [invalid],
      ),
      'rejected',
    );
  }
});

test('large escaped JSON strings decode exactly through the parser and generated client without PCRE limits', () => {
  const code = String.raw`
use ModelDx\{Client,ClientOptions,Codec,ParsedNumber};
$cases=[
    ['x\n', "x\n", 1000000],
    ['\"5e3', '"5e3', 400000],
    ['\\\\9007199254740993', '\\9007199254740993', 150000],
    ['\u0000\u263a\u0031', "\0☺1", 200000],
    [str_repeat('\\',1024).'\"1.2300', str_repeat('\\',512).'"1.2300', 1500],
];
foreach($cases as [$escaped,$unit,$count]){
    $expected=str_repeat($unit,$count);
    $raw='{"data":[],"next":"'.str_repeat($escaped,$count).'","extra":{"decimal":1.2300,"big":9007199254740993,"safe":42}}';
    foreach([false,true] as $preserve){
        $v=Codec::parse($raw,$preserve);
        if($v->next!==$expected || $v->extra->safe!==42)throw new Exception('string changed');
        if($preserve){
            if(!$v->extra->decimal instanceof ParsedNumber || $v->extra->decimal->value!=='1.2300' || $v->extra->big->value!=='9007199254740993')throw new Exception('exact tokens');
        }elseif($v->extra->decimal!=='1.2300' || $v->extra->big!=='9007199254740993')throw new Exception('exact strings');
        unset($v);
    }
    // The low-limit run isolates parsing; URL validation uses PCRE separately.
    if((int)ini_get('pcre.backtrack_limit')>1){
        $c=new Client(new ClientOptions('https://example.invalid',transport:fn($r)=>['status'=>200,'headers'=>[],'body'=>$raw]));
        if($c->catalog->retrieve('list')->data->next!==$expected)throw new Exception('client string changed');
        unset($c);
    }
}
echo 'ok';`;
  assert.equal(php(code, [], ['-d', 'memory_limit=128M']), 'ok');
  assert.equal(
    php(code, [], ['-d', 'memory_limit=128M', '-d', 'pcre.backtrack_limit=1', '-d', 'pcre.jit=0']),
    'ok',
  );
});

test('integer inputs reject decimal/exponent strings and ExactNumber tokens; responses retain integral-token support', () => {
  const rows = JSON.parse(
    php(String.raw`
use ModelDx\{Client,ClientOptions,ExactNumber,SdkError};
$requests=[];$c=new Client(new ClientOptions('https://example.invalid',maxAttempts:1,transport:function($r)use(&$requests){$requests[]=$r['body'];return ['status'=>200,'headers'=>[],'body'=>'{"count":5e3,"amount":1.2300}'];}));
foreach(['50.00','5e3',"50\n",new ExactNumber('50.00'),new ExactNumber('5e3')] as $value){try{$c->numbers->save(['count'=>$value,'amount'=>'1.2300']);throw new Exception('accepted non-integer spelling');}catch(SdkError $e){if($e->kind!=='validation' || $e->outcome!=='not_sent' || !str_contains($e->getMessage(),'integer string'))throw $e;}}
$r=$c->numbers->save(['count'=>new ExactNumber('50'),'amount'=>new ExactNumber('1.2300')]);
echo json_encode([$requests,$r->data->count,$r->data->amount]);`),
  );
  assert.deepEqual(rows, [['{"count":50,"amount":1.2300}'], '5000', '1.2300']);
});

test('HTTP errors carry useful context and constants without changing their kind or subclass', () => {
  const rows = JSON.parse(
    php(String.raw`
use ModelDx\{Client,ClientOptions,SdkError};
$c=new Client(new ClientOptions('https://example.invalid',maxAttempts:1,transport:fn($r)=>['status'=>422,'headers'=>['x-request-id'=>'req_test'],'body'=>'{"message":"Invalid item","code":"invalid_item"}']));
try{$c->catalog->retrieve('list');}catch(SdkError $e){echo json_encode([$e instanceof ModelDx\Errors\ValidationError,$e->kind===SdkError::KIND_VALIDATION,$e->outcome===SdkError::OUTCOME_RESPONSE,$e->getCode(),$e->errorCode,$e->getMessage()]);}`),
  );
  assert.deepEqual(rows, [
    true,
    true,
    true,
    422,
    'invalid_item',
    'Invalid item [HTTP 422, code invalid_item, requestId req_test]',
  ]);
});

test('resources initialize on first read, retain identity and remain readonly; path models fail precisely', () => {
  assert.equal(
    php(String.raw`
use ModelDx\{Client,ClientOptions,Model,SdkError};
$c=new Client(new ClientOptions('https://example.invalid',transport:fn($r)=>['status'=>200,'headers'=>[],'body'=>'{"data":[]}']));
if(class_exists(ModelDx\CatalogResource::class,false) || !isset($c->catalog))throw new Exception('eager resource');
if($c->catalog!==$c->catalog || !class_exists(ModelDx\CatalogResource::class,false) || class_exists(ModelDx\NumbersResource::class,false))throw new Exception('resource cache');
try{$c->catalog=$c->catalog;throw new Exception('mutable resource');}catch(SdkError $e){}
$c->catalog->retrieve(new Model('list',['type'=>'string']));
try{$c->catalog->retrieve(new Model(['id'=>'item'],['type'=>'object']));throw new Exception('accepted entity id');}catch(SdkError $e){if(!str_contains($e->getMessage(),'Path parameter id requires a scalar value or a scalar model'))throw $e;}
echo 'ok';`),
    'ok',
  );
});

test('large exact-number JSON parses within a 128 MiB process budget', () => {
  const result = JSON.parse(
    php(
      String.raw`
$record='{"id":"sample","amount":1.2300,"total":9007199254740993,"label":"'.str_repeat('x',100).'"}';
$raw='['.implode(',',array_fill(0,26000,$record)).']';
$parsed=ModelDx\Codec::parse($raw,true);
if($parsed[25999]->amount->value!=='1.2300' || $parsed[0]->total->value!=='9007199254740993')throw new Exception('precision');
echo json_encode([strlen($raw),count($parsed),memory_get_peak_usage(true)]);`,
      [],
      ['-d', 'memory_limit=128M', '-d', 'pcre.backtrack_limit=1', '-d', 'pcre.jit=0'],
    ),
  );
  assert.deepEqual(result.slice(0, 2), [4368001, 26000]);
  assert.ok(result[2] < 64 * 1024 * 1024, `parser peak ${result[2]} bytes`);
});

test('a 5000-item response supports indexed model reads within a 128 MiB process budget', () => {
  const result = JSON.parse(
    php(
      String.raw`
use ModelDx\{Client,ClientOptions};
$record='{"id":"sample","label":"'.str_repeat('x',850).'"}';
$raw='{"data":['.implode(',',array_fill(0,5000,$record)).']}';
$c=new Client(new ClientOptions('https://example.invalid',transport:fn($r)=>['status'=>200,'headers'=>[],'body'=>$raw]));
$p=$c->catalog->retrieve('list')->data;
$sum=0;for($i=0;$i<count($p->data);$i++){$sum+=strlen($p->data[$i]->id);}
echo json_encode([strlen($raw),$sum,$p->data[0]===$p->data[0],memory_get_peak_usage(true)]);`,
      [],
      ['-d', 'memory_limit=128M'],
    ),
  );
  assert.equal(result[0], 4385010);
  assert.equal(result[1], 30000);
  assert.equal(result[2], true);
  assert.ok(result[3] < 128 * 1024 * 1024);
});

test('reading an omitted field after POST does not trigger a not_sent retry wrapper', () => {
  const result = JSON.parse(
    php(String.raw`
use ModelDx\{Client,ClientOptions,SdkError};
$sent=0;$c=new Client(new ClientOptions('https://example.invalid',transport:function($r)use(&$sent){$sent++;return ['status'=>200,'headers'=>[],'body'=>'{"count":50,"amount":1.2300}'];}));
for($attempt=0;$attempt<3;$attempt++){
    try{$result=$c->numbers->save(['count'=>'50','amount'=>'1.2300']);$receipt=$result->data->receipt;break;}
    catch(SdkError $e){if($e->outcome!==SdkError::OUTCOME_NOT_SENT)throw $e;}
}
echo json_encode([$sent,$receipt,$result->data->has('receipt')]);`),
  );
  assert.deepEqual(result, [1, null, false]);
});
