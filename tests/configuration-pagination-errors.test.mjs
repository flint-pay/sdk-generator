import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { inspect } from 'node:util';
import { generate, loadContract } from '../dist/index.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'sdk-configuration-pagination-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const plain = (operationId, security = []) => ({
    operationId,
    security,
    responses: { 204: { description: 'Empty' } },
  });
  const api = {
    openapi: '3.1.0',
    info: { title: 'Configuration and pagination', version: '1' },
    components: {
      securitySchemes: {
        Key: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
        Other: { type: 'http', scheme: 'bearer' },
      },
    },
    paths: {
      '/plain': { get: plain('plain') },
      '/secure': { get: plain('secure', [{ Key: [] }]) },
      '/keyed': {
        post: {
          ...plain('keyed'),
          parameters: [
            { in: 'header', name: 'Idempotency-Key', required: true, schema: { type: 'string' } },
          ],
        },
      },
      '/records': {
        get: {
          operationId: 'listRecords',
          security: [],
          parameters: [{ name: 'cursor', in: 'query', schema: { type: 'string' } }],
          responses: {
            200: {
              description: 'Page',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['items', 'next'],
                    properties: {
                      items: { type: 'array', items: { type: 'string' } },
                      next: { type: ['string', 'null'] },
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
  const config = {
    version: '1.0.0',
    requests: { style: 'object' },
    responses: { return: 'result' },
    npm: { name: '@example/configuration-pagination' },
    composer: { name: 'example/configuration-pagination', namespace: 'ConfigurationPagination' },
    auth: {
      modes: { key: { schemes: ['Key'] }, other: { schemes: ['Other'] } },
      shortcuts: { apiKey: { mode: 'key', scheme: 'Key' } },
    },
    operations: {
      plain: { resource: 'api', method: 'plain' },
      secure: { resource: 'api', method: 'secure' },
      keyed: {
        resource: 'api',
        method: 'keyed',
        idempotency: {
          header: 'Idempotency-Key',
          retention: '24 hours',
          scope: 'operation',
          auto: false,
        },
      },
      listRecords: {
        resource: 'api',
        method: 'listRecords',
        pagination: { kind: 'cursor', items: 'items', next: 'next', parameter: 'cursor' },
      },
    },
  };
  writeFileSync(join(root, 'api.json'), JSON.stringify(api));
  writeFileSync(join(root, 'sdk.json'), JSON.stringify(config));
  const output = join(root, 'sdk');
  generate(loadContract(join(root, 'api.json'), join(root, 'sdk.json')), output);
  return output;
}
const paginationCases = [
  { name: 'implicit continuing limit', count: 1000, error: true },
  { name: 'explicit short limit', maxPages: 3, count: 3 },
  { name: 'explicit default-sized limit', maxPages: 1000, count: 1000 },
  { name: 'terminal thousandth page', terminal: true, count: 1000 },
];
const configurationCases = [
  {
    name: 'unknown client',
    client: { timeoutMss: 1 },
    code: 'invalid_option',
    option: 'timeoutMss',
  },
  {
    name: 'unknown request',
    request: { deadlineMss: 1 },
    code: 'invalid_option',
    option: 'deadlineMss',
  },
  { name: 'absent', method: 'secure', code: 'credential_missing' },
  {
    name: 'header conflict',
    client: { apiKey: 'synthetic' },
    request: { headers: { 'X-API-Key': 'different' } },
    method: 'secure',
    code: 'credential_conflict',
  },
  { name: 'timeout', client: { timeoutMs: 0 }, code: 'invalid_option', option: 'timeoutMs' },
  { name: 'attempts', request: { maxAttempts: 0 }, code: 'invalid_option', option: 'maxAttempts' },
  {
    name: 'pages',
    request: { maxPages: 0 },
    method: 'listRecordsPages',
    code: 'invalid_option',
    option: 'maxPages',
  },
  {
    name: 'malformed',
    client: { baseUrl: 'not a url' },
    code: 'invalid_destination',
    option: 'baseUrl',
  },
  {
    name: 'origin',
    client: { allowedOrigins: ['https://other.example.invalid'] },
    code: 'invalid_destination',
  },
  {
    name: 'mode',
    request: { authMode: 'other' },
    method: 'secure',
    code: 'auth_mode_not_permitted',
  },
  { name: 'provider', provider: true, method: 'secure', code: 'credential_provider_failed' },
  {
    name: 'invalid',
    client: { apiKey: 'synthetic\ninvalid' },
    method: 'secure',
    code: 'credential_invalid',
  },
  {
    name: 'conflict',
    client: { apiKey: 'synthetic', authMode: 'key' },
    method: 'secure',
    code: 'credential_conflict',
  },
  { name: 'missing', client: { apiKey: ' ' }, code: 'credential_missing' },
];

const inputCases = [
  { method: 'keyed', code: 'REQUIRED', param: 'Idempotency-Key' },
  {
    method: 'plain',
    request: { idempotencyKey: 'synthetic' },
    code: 'NOT_ALLOWED',
    param: 'Idempotency-Key',
  },
  { method: 'plain', request: { ifMatch: 'synthetic' }, code: 'NOT_ALLOWED', param: 'If-Match' },
  { method: 'plain', input: { body: {} }, code: 'NOT_ALLOWED', param: 'body' },
];

test('pagination caps and configuration errors agree in generated Node and PHP clients', async (t) => {
  const output = fixture(t);
  const { Client, errors } = await import(pathToFileURL(join(output, 'node/index.js')));
  const pages = [];
  for (const method of ['listRecordsPages', 'listRecordsItems'])
    for (const row of paginationCases) {
      let calls = 0,
        count = 0,
        failure = null;
      const client = new Client({
        baseUrl: 'https://example.invalid',
        transport: async () => {
          calls++;
          return new Response(
            JSON.stringify({
              items: ['record'],
              next: row.terminal && calls === 1000 ? null : `token${calls}`,
            }),
          );
        },
      });
      try {
        for await (const value of client.api[method](
          {},
          row.maxPages ? { maxPages: row.maxPages } : {},
        )) {
          assert.ok(value);
          count++;
        }
      } catch (error) {
        assert.ok(error instanceof errors.PaginationLimitError);
        failure = { code: error.code, pages: error.pages, nextPageToken: error.nextPageToken };
      }
      const expected = row.error
        ? { code: 'pagination_limit_exceeded', pages: 1000, nextPageToken: 'token1000' }
        : null;
      assert.deepEqual(
        { count, calls, failure },
        { count: row.count, calls: row.count, failure: expected },
        `${method}: ${row.name}`,
      );
      pages.push({ count, calls, failure });
    }
  const config = [];
  for (const row of configurationCases) {
    let calls = 0;
    const invoke = async () => {
      const client = new Client({
        baseUrl: 'https://example.invalid',
        ...row.client,
        ...(row.provider
          ? {
              apiKey: {
                getCredential() {
                  throw new Error('synthetic-provider-secret');
                },
              },
            }
          : {}),
        transport: async () => {
          calls++;
          return new Response(null, { status: 204 });
        },
      });
      const value = client.api[row.method ?? 'plain']({}, row.request ?? {});
      if (row.method?.endsWith('Pages')) {
        for await (const page of value) assert.fail('unexpected page');
      } else await value;
    };
    await assert.rejects(invoke, (error) => {
      assert.ok(error instanceof errors.ConfigurationError, row.name);
      assert.equal(error.code, row.code, row.name);
      if (row.code !== 'credential_missing') assert.equal(error.param, undefined, row.name);
      assert.equal(error.outcome, 'not_sent');
      if (row.option) assert.ok(error.message.includes(row.option), error.message);
      assert.doesNotMatch(inspect(error), /synthetic-provider-secret/);
      config.push({ code: error.code, outcome: error.outcome });
      return true;
    });
    assert.equal(calls, 0, row.name);
  }
  const inputs = [];
  for (const row of inputCases) {
    let calls = 0;
    const client = new Client({
      baseUrl: 'https://example.invalid',
      transport: async () => {
        calls++;
        return new Response(null, { status: 204 });
      },
    });
    await assert.rejects(client.api[row.method](row.input ?? {}, row.request ?? {}), (error) => {
      assert.ok(error instanceof errors.InvalidInputError);
      assert.equal(error.code, 'INVALID_REQUEST');
      assert.equal(error.outcome, 'not_sent');
      assert.equal(error.param, row.param);
      assert.deepEqual(error.details, [{ code: row.code, param: row.param }]);
      inputs.push({
        code: error.code,
        outcome: error.outcome,
        details: error.details,
        param: error.param,
      });
      return true;
    });
    assert.equal(calls, 0);
  }
  const php = execFileSync(
    'php',
    [
      '-r',
      String.raw`
require $argv[1].'/src/Runtime.php';require $argv[1].'/src/Client.php';
use ConfigurationPagination\Client;use ConfigurationPagination\ClientOptions;use ConfigurationPagination\RequestOptions;
$input=json_decode(stream_get_contents(STDIN),true,512,JSON_THROW_ON_ERROR);$pages=[];$config=[];$inputs=[];
foreach(['listRecordsPages','listRecordsItems'] as $method)foreach($input['pagination'] as $row){
 $calls=0;$count=0;$failure=null;
 $c=new Client(new ClientOptions(baseUrl:'https://example.invalid',transport:function($r)use(&$calls,$row){$calls++;return ['status'=>200,'headers'=>[],'body'=>json_encode(['items'=>['record'],'next'=>($row['terminal']??false)&&$calls===1000?null:'token'.$calls])];}));
 try{foreach($c->api->$method([],new RequestOptions(maxPages:$row['maxPages']??null)) as $v)$count++;}
 catch(ConfigurationPagination\Errors\PaginationLimitError $e){$failure=['code'=>$e->code,'pages'=>$e->pages,'nextPageToken'=>$e->nextPageToken];}
 $pages[]=['count'=>$count,'calls'=>$calls,'failure'=>$failure];
}
foreach($input['configuration'] as $row){
 $calls=0;$options=$row['client']??[];$options+=['baseUrl'=>'https://example.invalid'];
 if($row['provider']??false)$options['apiKey']=function(){throw new Exception('synthetic-provider-secret');};
 $options['transport']=function($r)use(&$calls){$calls++;return ['status'=>204,'headers'=>[],'body'=>''];};
 try{$c=new Client(new ClientOptions(...$options));$method=$row['method']??'plain';$v=$c->api->$method([],new RequestOptions(...($row['request']??[])));if(str_ends_with($method,'Pages'))foreach($v as $_){};throw new Exception('expected failure '.$row['name']);}
 catch(ConfigurationPagination\Errors\ConfigurationError $e){
  if($e->code!==$row['code']||$e->outcome!=='not_sent'||$calls!==0)throw $e;
  if($e->code!=='credential_missing'&&$e->param!==null)throw new Exception('unexpected param');
  if(isset($row['option'])&&!str_contains($e->getMessage(),$row['option']))throw $e;
  if(str_contains((string)$e,'synthetic-provider-secret')||$e->getPrevious()!==null)throw new Exception('provider cause leaked');
  $config[]=['code'=>$e->code,'outcome'=>$e->outcome];
 }
}
foreach($input['inputCases'] as $row){
 $calls=0;$c=new Client(new ClientOptions(baseUrl:'https://example.invalid',transport:function($r)use(&$calls){$calls++;return ['status'=>204,'headers'=>[],'body'=>''];}));
 try{$method=$row['method'];$c->api->$method($row['input']??[],new RequestOptions(...($row['request']??[])));throw new Exception('expected local input failure');}
 catch(ConfigurationPagination\Errors\InvalidInputError $e){
  if($calls!==0)throw new Exception('input was sent');
  $inputs[]=['code'=>$e->code,'outcome'=>$e->outcome,'details'=>$e->details,'param'=>$e->param];
 }
}
echo json_encode(['pages'=>$pages,'config'=>$config,'inputs'=>$inputs],JSON_THROW_ON_ERROR);
`,
      join(output, 'php'),
    ],
    {
      input: JSON.stringify({
        pagination: paginationCases,
        configuration: configurationCases,
        inputCases,
      }),
      encoding: 'utf8',
    },
  );
  assert.deepEqual(JSON.parse(php), { pages, config, inputs });
});
