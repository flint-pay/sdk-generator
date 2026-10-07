import { npmPackResult } from '../dist/distribution.js';
import { measureSdkWeight } from './helpers/sdk-weight.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  statSync,
  readdirSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';

const fixture = resolve('tests/providers/flint');
const api = join(fixture, 'full-openapi.json');
const config = join(fixture, 'full-sdk.json');
function run(command, args, options = {}) {
  // Large-source generation has a documented 4-GiB process budget. Node 22
  // otherwise caps its heap at 2 GiB in the minimum-runtime container.
  if (
    command === process.execPath &&
    (args[0] === 'dist/cli.js' || args[0]?.endsWith('/generate.mjs'))
  )
    args = ['--max-old-space-size=3072', ...args];
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 600000,
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  assert.equal(
    result.status,
    0,
    `${command}: ${result.error?.message ?? ''}\n${result.stderr}\n${result.stdout.slice(-12000)}`,
  );
  return result.stdout;
}
const size = (path) =>
  readdirSync(path, { withFileTypes: true }).reduce(
    (total, file) =>
      total +
      (file.isDirectory() ? size(join(path, file.name)) : statSync(join(path, file.name)).size),
    0,
  );

test(
  'unmodified full export diagnoses, generates, regenerates, validates and installs complete Node/PHP packages',
  { timeout: 600000 },
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'sdk-full-public-'));
    const output = join(dir, 'output');
    try {
      const diagnosis = JSON.parse(run(process.execPath, ['dist/cli.js', 'diagnose', api, config]));
      assert.equal(diagnosis.operations, 503);
      const script = join(dir, 'generate.mjs');
      writeFileSync(
        script,
        `import {loadContract,generate,preview} from ${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)};
import {writeFileSync} from 'node:fs';
const started=performance.now();
const c=loadContract(${JSON.stringify(api)},${JSON.stringify(config)});
generate(c,${JSON.stringify(output)});
writeFileSync(${JSON.stringify(join(dir, 'summary.json'))},JSON.stringify({operations:c.operations.map(o=>o.id),methods:c.operations.map(o=>({resource:o.resource,method:o.method,payload:o.response?.return==='payload',pagination:Boolean(o.pagination),polling:Boolean(o.polling)})),incoming:c.incoming.map(o=>({name:o.name,model:o.model})),events:Object.keys(c.config.webhook.events),modes:c.authentication,elapsedMs:performance.now()-started,maxRSS:process.resourceUsage().maxRSS,definitions:Object.keys(c.definitions).length}));
`,
      );
      run(process.execPath, [script]);
      const summary = JSON.parse(readFileSync(join(dir, 'summary.json')));
      const inventory = JSON.parse(readFileSync(join(fixture, 'full-inventory.json')));
      assert.deepEqual(
        summary.operations.slice().sort(),
        inventory.operations
          .filter(
            (o) =>
              ![
                'authorizeCLIDevice',
                'listCLIContexts',
                'reauthorizeCLIDevice',
                'revokeCLIGrant',
              ].includes(o.id),
          )
          .map((o) => o.id)
          .sort(),
      );
      assert.deepEqual(
        summary.incoming.map((o) => o.name).sort(),
        inventory.incoming.map((o) => o.key).sort(),
      );
      assert.equal(summary.events.length, 191);
      assert.equal(summary.incoming.length, 191);
      assert.ok(summary.definitions > 100);
      assert.ok(
        summary.maxRSS < 4 * 1024 * 1024,
        `full generation peak RSS ${summary.maxRSS} KiB exceeds 4 GiB budget`,
      );
      assert.ok(size(output) < 300 * 1024 * 1024, 'full package/record size budget exceeded');
      const preview = JSON.parse(
        run(process.execPath, ['dist/cli.js', 'preview', api, config, output]),
      );
      assert.equal(
        preview.changes.length,
        0,
        JSON.stringify(preview.changes.map((change) => change.path)),
      );
      const regenerated = JSON.parse(
        run(process.execPath, ['dist/cli.js', 'generate', api, config, output]),
      );
      assert.equal(regenerated.changes.length, 0);
      run(process.execPath, [
        'dist/cli.js',
        'validate',
        output,
        '--fixtures',
        join(fixture, 'full-http-cases.json'),
      ]);

      const packed = npmPackResult(
        run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', dir], {
          cwd: join(output, 'node'),
        }),
      );
      const consumer = join(dir, 'consumer');
      mkdirSync(consumer);
      writeFileSync(
        join(consumer, 'package.json'),
        JSON.stringify({ private: true, type: 'module' }),
      );
      run(
        'npm',
        ['install', '--ignore-scripts', '--no-audit', '--no-fund', join(dir, packed.filename)],
        { cwd: consumer },
      );
      writeFileSync(
        join(consumer, 'composer.json'),
        JSON.stringify({
          require: { 'example/flint-full-sdk': '2.0.0' },
          repositories: [
            {
              type: 'path',
              url: join(output, 'php'),
              options: { symlink: false },
            },
          ],
        }),
      );
      run('composer', ['install', '--no-interaction', '--no-dev', '--no-progress'], {
        cwd: consumer,
      });
      const webhookTypes = join(consumer, 'webhook-types.ts');
      writeFileSync(
        webhookTypes,
        `import {Client} from '@example/flint-full-sdk';
import type {IncomingHttpHeaders} from 'node:http';
const client=new Client({token:'synthetic'});
declare const headers: IncomingHttpHeaders;
const secrets: readonly string[]=['synthetic'];
client.verifyWebhook(new Uint8Array(),headers,secrets);
const result=client.verifyWebhook(new Uint8Array(),new Headers(),'synthetic');
if(result.known) {
  const name: string=result.event.event_type;
  if(result.event.event_type==='balance_transaction.created') {
    const amount: string=result.event.data.amount_money.amount;
  }
  if(result.event.event_type==='payment_intent.succeeded') {
    const id: string=result.event.data.payment_intent.payment_intent_id;
  }
} else {
  // @ts-expect-error Unknown events must be validated by the application.
  result.event.data;
}
`,
      );
      run(process.execPath, [
        resolve('node_modules/typescript/bin/tsc'),
        '--noEmit',
        '--strict',
        '--target',
        'es2022',
        '--module',
        'nodenext',
        webhookTypes,
      ]);
      const clientDeclarations = readFileSync(
        join(output, 'node/declarations/Client.d.ts'),
        'utf8',
      );
      assert.ok(
        clientDeclarations.length < 100000,
        'webhook signature must reference compact aliases',
      );
      const nodeAdapter = join(consumer, 'node_modules/@example/flint-full-sdk/codec-plan.js');
      writeFileSync(
        nodeAdapter,
        readFileSync(nodeAdapter, 'utf8').replace(
          'export function compileCodec(schema) {',
          'export function compileCodec(schema) { throw new Error("dynamic adapter invoked");',
        ),
      );
      const phpAdapter = join(consumer, 'vendor/example/flint-full-sdk/src/SchemaAdapter.php');
      writeFileSync(
        phpAdapter,
        readFileSync(phpAdapter, 'utf8').replace(
          /(public static function compile\(array \$schema\): array\s*\{)/,
          '$1 throw new \\Exception("dynamic adapter invoked");',
        ),
      );
      const modelCases = JSON.parse(readFileSync(join(fixture, 'full-model-cases.json')));
      const source = JSON.parse(readFileSync(api));
      const envelope = structuredClone(
        source.webhooks['balance_transaction.created'].post.requestBody.content['application/json']
          .examples.merchant.value,
      );
      const raw = JSON.stringify(envelope).replace('"amount":5000', '"amount":9007199254740993');
      const secret = Buffer.alloc(32, 7);
      const encodedSecret = 'whsec_' + secret.toString('base64');
      const timestamp = '1780000000';
      const id = 'whev_test';
      const signature = createHmac('sha256', secret)
        .update(`${id}.${timestamp}.${raw}`)
        .digest('base64');
      const headers = {
        'webhook-id': id,
        'webhook-timestamp': timestamp,
        'webhook-signature': 'v1,' + signature,
      };
      writeFileSync(
        join(consumer, 'check.mjs'),
        `import assert from 'node:assert/strict';
import * as sdk from '@example/flint-full-sdk';
const {Client,ExactNumber}=sdk;
const c=new Client({token:'synthetic'});
const ids=${JSON.stringify(summary.operations)};
const methods=${JSON.stringify(summary.methods)};
assert.equal(methods.length,ids.length);
for(const {resource,method,payload,pagination,polling} of methods) {
 assert.equal(typeof c[resource][method],'function');
 if(payload)assert.equal(typeof c[resource][method+'WithResponse'],'function');
 if(pagination)for(const suffix of ['Pages','Items'])assert.equal(typeof c[resource][method+suffix],'function');
 if(polling)assert.equal(typeof c[resource][method+'Wait'],'function');
 if(payload && pagination)assert.equal(typeof c[resource][method+'PagesWithResponse'],'function');
 if(payload && polling)assert.equal(typeof c[resource][method+'WaitWithResponse'],'function');
}
assert.ok(Object.keys(c).length > 1);
assert.equal(typeof c.paymentIntents.create,'function');
for(const incoming of ${JSON.stringify(summary.incoming)}) assert.equal(typeof sdk['make'+incoming.model],'function',incoming.name);
const verified=c.verifyWebhook(Buffer.from(${JSON.stringify(raw)}),${JSON.stringify(headers)},[${JSON.stringify(encodedSecret)}],${timestamp});
assert.equal(verified.known,true);
assert.equal(verified.event.data.amount_money.amount,'9007199254740993');
assert.throws(()=>c.verifyWebhook(Buffer.from(${JSON.stringify(raw)}+' '),${JSON.stringify(headers)},[${JSON.stringify(encodedSecret)}],${timestamp}));
assert.equal(new ExactNumber('1.0000').value,'1.0000');
for(const scenario of ${JSON.stringify(modelCases)}) {
 const factory=()=>sdk['make'+scenario.model](scenario.value);
 if(scenario.valid) factory(); else assert.throws(factory,{kind:'validation'},scenario.name);
}
const payment = {
  amount_money: {amount: '9007199254740993', currency: 'USD'},
  payment_flow: 'api', payment_intent_id: 'pi_fixture', payment_options: ['card'],
  status: 'requires_payment_method', support_reference: 'PAY-TEST',
  risk: null, last_payment_error: null,
};
const report = {
  created_at: '2026-09-29T00:00:00Z', currency: 'USD',
  interval_start_at: '2026-09-28T00:00:00Z', interval_end_at: '2026-09-29T00:00:00Z',
  report_id: 'rep_fixture', report_type: 'orders_itemized_v1', status: 'pending', timezone: 'UTC',
};
const requestKeys = [];
let reportReads = 0;
const audit = new Client({token:'synthetic', transport:async (url, init) => {
  let body;
  let status = 200;
  if (url.pathname === '/v1/payment-intents/pi_fixture') body = {data:payment, request_id:'req_body', meta:{trace_id:'provider'}};
  else if (url.pathname === '/v1/payment-intents' && init.method === 'POST') {
    body = {data:{payment_intent:payment, payment_collection:{}}, request_id:'req_create'};
    status = 201;
  } else if (url.pathname === '/v1/payment-intents') {
    const next = url.searchParams.get('page_token');
    assert.ok(next === null || next === 'page_two');
    body = {data:[{...payment,payment_intent_id:next ? 'pi_second' : 'pi_fixture'}], ...(next ? {} : {next_page_token:'page_two'})};
  } else if (url.pathname === '/v1/balances') body = {data:[]};
  else if (url.pathname === '/v1/reports' && init.method === 'POST') {
    requestKeys.push(init.headers['idempotency-key']);
    status = requestKeys.length === 1 ? 503 : 201;
    body = status === 503 ? {error:{code:'UNAVAILABLE',message:'Try again'}} : {data:report};
  } else if (url.pathname === '/v1/reports/rep_fixture') {
    reportReads++;
    body = {data:reportReads === 1 ? report : {...report,status:'succeeded',download:{expires_at:'2026-09-30T00:00:00Z',report_download_id:'rdl_fixture',url:'https://api.withflintpay.com/v1/report-downloads/rdl_fixture'}}};
  } else throw new Error('Unexpected audit request ' + url);
  const wire = JSON.stringify(body).replaceAll('"9007199254740993"','9007199254740993');
  return new Response(wire,{status,headers:{'content-type':'application/json','x-request-id':'req_http'}});
}});
assert.deepEqual(JSON.parse(JSON.stringify(await audit.paymentIntents.get({payment_intent_id:'pi_fixture'}))),payment);
const fullResponse = await audit.paymentIntents.getWithResponse({payment_intent_id:'pi_fixture'});
assert.equal(fullResponse.body.request_id,'req_body');
assert.equal(fullResponse.body.meta.trace_id,'provider');
assert.equal(fullResponse.meta.requestId,'req_http');
const createdPayment = await audit.paymentIntents.create({body:{amount_money:{amount:'100',currency:'USD'},payment_options:['card'],capture_method:'manual'}});
assert.equal(createdPayment.payment_intent.status,'requires_payment_method');
const firstPage = await audit.paymentIntents.list({page_size:1});
assert.equal(firstPage.next_page_token,'page_two');
assert.equal(firstPage.data[0].payment_intent_id,'pi_fixture');
assert.deepEqual(await Array.fromAsync(audit.paymentIntents.listItems({page_size:1}),item=>item.payment_intent_id),['pi_fixture','pi_second']);
const auditPages = await Array.fromAsync(audit.paymentIntents.listPages({page_size:1}));
assert.equal(auditPages.length,2);
assert.equal(auditPages[0].next_page_token,'page_two');
assert.equal(auditPages[0].data[0].payment_intent_id,'pi_fixture');
assert.equal(auditPages[1].data[0].payment_intent_id,'pi_second');
const fullPages = await Array.fromAsync(audit.paymentIntents.listPagesWithResponse({page_size:1}));
assert.equal(fullPages.length,2);
assert.equal(fullPages[0].body.next_page_token,'page_two');
assert.equal(fullPages[1].body.data[0].payment_intent_id,'pi_second');
assert.equal(fullPages[1].meta.requestId,'req_http');
assert.equal(JSON.parse(fullPages[0].raw).next_page_token,'page_two');
assert.deepEqual((await audit.balances.list()).data,[]);
assert.equal(audit.balances.listItems,undefined);
const createdReport = await audit.reports.create({body:{currency:'USD',interval_start_at:report.interval_start_at,interval_end_at:report.interval_end_at,report_type:report.report_type}});
assert.equal(createdReport.status,'pending');
assert.equal(requestKeys.length,2);
assert.ok(typeof requestKeys[0] === 'string' && requestKeys[0].length > 0);
assert.equal(requestKeys[0],requestKeys[1]);
const waited = await audit.reports.getWait({report_id:'rep_fixture'},{deadlineMs:5000});
assert.equal(waited.status,'succeeded');
assert.equal(reportReads,2);
reportReads = 0;
const waitedResponse = await audit.reports.getWaitWithResponse({report_id:'rep_fixture'},{deadlineMs:5000});
assert.equal(waitedResponse.body.data.status,'succeeded');
assert.equal(waitedResponse.meta.requestId,'req_http');
assert.equal(JSON.parse(waitedResponse.raw).data.status,'succeeded');
assert.equal(reportReads,2);
await audit.close();

const streaming=new Client({token:'synthetic',transport:async (url,request)=>{
 assert.equal(url.origin,'https://api.withflintpay.com');
 assert.equal(request.headers.authorization,'Bearer synthetic');
 assert.equal(request.headers['last-event-id'],'whev_previous');
 return new Response('event: ready\\ndata: {"cursor":"whev_resume"}\\n\\n',{headers:{'content-type':'text/event-stream'}});
}});
const stream=await streaming.webhookEvents.stream({'Last-Event-ID':'whev_previous'});
const frames=await Array.fromAsync(stream.data);
assert.equal(frames[0].data.cursor,'whev_resume');
await streaming.close();
await c.close();
`,
      );
      run(process.execPath, ['check.mjs'], { cwd: consumer });
      writeFileSync(
        join(consumer, 'check.php'),
        `<?php
require __DIR__.'/vendor/autoload.php';
use Example\\FlintFull\\{Client,ClientOptions,ExactNumber,ByteStream,SdkError,WebhookEventsStreamInput};
$c=new Client(new ClientOptions(token:'synthetic'));
$ids=json_decode('${JSON.stringify(summary.operations)}',true,512,JSON_THROW_ON_ERROR);
foreach(json_decode('${JSON.stringify(summary.methods)}',true) as $method) {
 $names=[$method['method']];
 if($method['payload'])$names[]=$method['method'].'WithResponse';
 if($method['pagination'])foreach(['Pages','Items'] as $suffix)$names[]=$method['method'].$suffix;
 if($method['polling'])$names[]=$method['method'].'Wait';
 if($method['payload'] && $method['pagination'])$names[]=$method['method'].'PagesWithResponse';
 if($method['payload'] && $method['polling'])$names[]=$method['method'].'WaitWithResponse';
 foreach($names as $name)if(!method_exists($c->{$method['resource']},$name))throw new Exception('Missing method '.$name);
}
foreach(json_decode('${JSON.stringify(summary.incoming)}',true,512,JSON_THROW_ON_ERROR) as $incoming) if(!class_exists('Example'.chr(92).'FlintFull'.chr(92).$incoming['model'].'Input'))throw new Exception('Missing incoming model '.$incoming['name']);
$event=$c->verifyWebhook(base64_decode('${Buffer.from(raw).toString('base64')}'),json_decode('${JSON.stringify(headers)}',true,512,JSON_THROW_ON_ERROR),['${encodedSecret}'],${timestamp});
if(!$event['known'] || $event['event']->get('data')->amount_money->amount !== '9007199254740993') throw new Exception('Webhook payload mismatch');
try{$c->verifyWebhook(base64_decode('${Buffer.from(raw).toString('base64')}').' ',json_decode('${JSON.stringify(headers)}',true,512,JSON_THROW_ON_ERROR),['${encodedSecret}'],${timestamp});throw new Exception('accepted tampered webhook');}catch(SdkError $error){}
foreach(json_decode(base64_decode('${Buffer.from(JSON.stringify(modelCases)).toString('base64')}'),true,512,JSON_THROW_ON_ERROR) as $scenario){
 $class='Example'.chr(92).'FlintFull'.chr(92).$scenario['model'].'Input';$valid=true;
 try{new $class($scenario['value']);}catch(Example\\FlintFull\\SdkError $error){$valid=false;}
 if($valid!==$scenario['valid'])throw new Exception($scenario['name']);
}
$c->close();
$payment = ['amount_money'=>['amount'=>'9007199254740993','currency'=>'USD'], 'payment_flow'=>'api','payment_intent_id'=>'pi_fixture','payment_options'=>['card'],'status'=>'requires_payment_method','support_reference'=>'PAY-TEST','risk'=>null,'last_payment_error'=>null];
$report = ['created_at'=>'2026-09-29T00:00:00Z','currency'=>'USD','interval_start_at'=>'2026-09-28T00:00:00Z','interval_end_at'=>'2026-09-29T00:00:00Z','report_id'=>'rep_fixture','report_type'=>'orders_itemized_v1','status'=>'pending','timezone'=>'UTC'];
$requestKeys = []; $reportReads = 0;
$audit = new Client(new ClientOptions(token:'synthetic', transport:function($request)use($payment,$report,&$requestKeys,&$reportReads){
  $path = parse_url($request['url'],PHP_URL_PATH); $status = 200;
  if($path === '/v1/payment-intents/pi_fixture') $body=['data'=>$payment,'request_id'=>'req_body','meta'=>['trace_id'=>'provider']];
  elseif($path === '/v1/payment-intents' && $request['method'] === 'POST') { $status=201; $body=['data'=>['payment_intent'=>$payment,'payment_collection'=>(object)[]]]; }
  elseif($path === '/v1/payment-intents') {
    parse_str(parse_url($request['url'],PHP_URL_QUERY)??'', $query);
    $next=$query['page_token']??null;
    if($next!==null && $next!=='page_two')throw new Exception('wrong continuation');
    $item=$payment; if($next)$item['payment_intent_id']='pi_second';
    $body=['data'=>[$item]]; if(!$next)$body['next_page_token']='page_two';
  } elseif($path === '/v1/balances') $body=['data'=>[]];
  elseif($path === '/v1/reports' && $request['method'] === 'POST') {
    $requestKeys[]=$request['headers']['idempotency-key']??null;
    $status=count($requestKeys)===1?503:201;
    $body=$status===503?['error'=>['code'=>'UNAVAILABLE','message'=>'Try again']]:['data'=>$report];
  } elseif($path === '/v1/reports/rep_fixture') {
    $reportReads++; $value=$report;
    if($reportReads>1){$value['status']='succeeded';$value['download']=['expires_at'=>'2026-09-30T00:00:00Z','report_download_id'=>'rdl_fixture','url'=>'https://api.withflintpay.com/v1/report-downloads/rdl_fixture'];}
    $body=['data'=>$value];
  } else throw new Exception('unexpected audit request '.$path);
  return ['status'=>$status,'headers'=>['content-type'=>'application/json','x-request-id'=>'req_http'],'body'=>str_replace('"9007199254740993"','9007199254740993',json_encode($body,JSON_THROW_ON_ERROR))];
}));
$got=$audit->paymentIntents->get(['payment_intent_id'=>'pi_fixture']);
if($got->getStatus()!=='requires_payment_method' || $got->getAmountMoney()->getAmount()!=='9007199254740993')throw new Exception('unwrapped payment');
$full=$audit->paymentIntents->getWithResponse(['payment_intent_id'=>'pi_fixture']);
if($full->body->getRequestId()!=='req_body' || $full->body->getMeta()->getTraceId()!=='provider' || $full->meta['requestId']!=='req_http')throw new Exception('full response metadata');
$created=$audit->paymentIntents->create(['body'=>['amount_money'=>['amount'=>'100','currency'=>'USD'],'payment_options'=>['card'],'capture_method'=>'manual']]);
if($created->getPaymentIntent()->getStatus()!=='requires_payment_method')throw new Exception('create shape');
$first=$audit->paymentIntents->list(['page_size'=>1]);
if($first->getNextPageToken()!=='page_two')throw new Exception('lost cursor');
$ids=[];foreach($audit->paymentIntents->listItems(['page_size'=>1]) as $item)$ids[]=$item->getPaymentIntentId();
if($ids!==['pi_fixture','pi_second'])throw new Exception('pagination items');
$pages=iterator_to_array($audit->paymentIntents->listPages(['page_size'=>1]));
if(count($pages)!==2 || $pages[0]->getNextPageToken()!=='page_two' || $pages[0]->getData()[0]->getPaymentIntentId()!=='pi_fixture' || $pages[1]->getData()[0]->getPaymentIntentId()!=='pi_second')throw new Exception('pagination pages');
$fullPages=iterator_to_array($audit->paymentIntents->listPagesWithResponse(['page_size'=>1]));
if(count($fullPages)!==2 || $fullPages[0]->body->getNextPageToken()!=='page_two' || $fullPages[1]->body->getData()[0]->getPaymentIntentId()!=='pi_second' || $fullPages[1]->meta['requestId']!=='req_http' || json_decode($fullPages[0]->raw,true)['next_page_token']!=='page_two')throw new Exception('pagination full pages');
if($audit->balances->list()->getData()!==[] || method_exists($audit->balances,'listItems'))throw new Exception('nonpaginated balances');
$created=$audit->reports->create(['body'=>['currency'=>'USD','interval_start_at'=>$report['interval_start_at'],'interval_end_at'=>$report['interval_end_at'],'report_type'=>$report['report_type']]]);
if($created->status!=='pending' || count($requestKeys)!==2 || !is_string($requestKeys[0]) || $requestKeys[0]==='' || $requestKeys[0]!==$requestKeys[1])throw new Exception('stable retry key');
$waited=$audit->reports->getWait(['report_id'=>'rep_fixture'],new Example\\FlintFull\\RequestOptions(deadlineMs:5000));
if($waited->status!=='succeeded' || $reportReads!==2)throw new Exception('report polling');
$reportReads=0;
$waitedResponse=$audit->reports->getWaitWithResponse(['report_id'=>'rep_fixture'],new Example\\FlintFull\\RequestOptions(deadlineMs:5000));
if($waitedResponse->body->getData()->status!=='succeeded' || $waitedResponse->meta['requestId']!=='req_http' || json_decode($waitedResponse->raw,true)['data']['status']!=='succeeded' || $reportReads!==2)throw new Exception('report full polling');
$audit->close();

$streaming=new Client(new ClientOptions(token:'synthetic',transport:function($request){
 if(!str_starts_with($request['url'],'https://api.withflintpay.com/') || ($request['headers']['authorization']??null)!=='Bearer synthetic')throw new Exception('wrong default or token');
 if($request['headers']['last-event-id']!=='whev_previous')throw new Exception('resume header');
 return ['status'=>200,'headers'=>['content-type'=>'text/event-stream'],'stream'=>new class implements ByteStream {
  private bool $done=false;
  public function read():?string{if($this->done)return null;$this->done=true;return "event: ready\\ndata: {\\"cursor\\":\\"whev_resume\\"}\\n\\n";}
  public function close():void{$this->done=true;}
 }];
}));
$stream=$streaming->webhookEvents->stream(new WebhookEventsStreamInput(['Last-Event-ID'=>'whev_previous']));
$frames=iterator_to_array($stream->data);
if($frames[0]->data->cursor!=='whev_resume')throw new Exception('stream payload');
$streaming->close();
`,
      );
      for (const opcache of ['0', '1'])
        run(
          'php',
          ['-d', 'memory_limit=128M', '-d', 'opcache.enable_cli=' + opcache, 'check.php'],
          { cwd: consumer },
        );
      run('composer', ['install', '--no-interaction', '--no-progress'], {
        cwd: join(output, 'php'),
      });
      const weight = measureSdkWeight(output);
      console.log('SDK consumer budget ' + JSON.stringify(weight));
      assert.equal(weight.node.failed, undefined, JSON.stringify(weight.node));
      assert.ok(weight.sizes.node['.js'] < 15 * 1024 * 1024, 'Node source size budget exceeded');
      assert.ok(weight.sizes.node['.d.ts'] < 13 * 1024 * 1024, 'declaration size budget exceeded');
      assert.ok(
        weight.sizes.php['.json'] < 24 * 1024 * 1024,
        'PHP descriptor size budget exceeded',
      );
      assert.ok(weight.node.importRss < 128 * 1024 * 1024, 'root import RSS budget exceeded');
      assert.ok(weight.node.repeatedClientMs < 10, 'repeated Node construction budget exceeded');
      assert.ok(
        weight.bundles['resources/invoices'] < weight.bundles.index / 2,
        'selective bundle must exclude most of the full contract',
      );
      assert.ok(weight.sizes.php.largestSource < 512 * 1024, 'PHP source exceeds indexing budget');
      assert.ok(
        weight.bundles['resources/invoices'] < 1024 * 1024,
        'selective bundle exceeds 1 MiB',
      );
      for (const [target, bytes] of Object.entries(weight.archives))
        assert.ok(typeof bytes === 'number' && bytes > 0, 'archive measurement failed: ' + target);
      for (const result of weight.php) {
        assert.equal(result.failed, undefined, JSON.stringify(result));
        assert.ok(result.autoloadMemory < 4 * 1024 * 1024, 'Composer eagerly loaded SDK code');
        assert.ok(result.peakMemory < 128 * 1024 * 1024, 'PHP consumer memory budget exceeded');
        assert.ok(result.repeatedClientMs < 10, 'repeated PHP construction budget exceeded');
      }
      // Report consumer measurements and exercise installed packages before a
      // generation timing failure (for example on a contended CI worker).
      assert.ok(summary.elapsedMs < 180000, `full generation took ${summary.elapsedMs} ms`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  'each full authentication profile generates its complete permitted operation selection',
  { timeout: 600000 },
  () => {
    const combined = JSON.parse(readFileSync(config));
    const union = new Set();
    for (const profile of combined.profiles) {
      const configured = JSON.parse(readFileSync(join(fixture, profile)));
      configured.include.forEach((id) => union.add(id));
      const diagnosis = JSON.parse(
        run(process.execPath, ['dist/cli.js', 'diagnose', api, join(fixture, profile)]),
      );
      assert.equal(diagnosis.operations, configured.include.length, profile);
    }
    assert.equal(union.size, 503);
  },
);
