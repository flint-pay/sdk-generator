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
      assert.equal(diagnosis.operations, 497);
      const script = join(dir, 'generate.mjs');
      writeFileSync(
        script,
        `import {loadContract,generate,preview} from ${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)};
import {writeFileSync} from 'node:fs';
const started=performance.now();
const c=loadContract(${JSON.stringify(api)},${JSON.stringify(config)});
generate(c,${JSON.stringify(output)});
writeFileSync(${JSON.stringify(join(dir, 'summary.json'))},JSON.stringify({operations:c.operations.map(o=>o.id),methods:c.operations.map(o=>({resource:o.resource,method:o.method})),incoming:c.incoming.map(o=>({name:o.name,model:o.model})),events:Object.keys(c.config.webhook.events),modes:c.authentication,elapsedMs:performance.now()-started,maxRSS:process.resourceUsage().maxRSS,definitions:Object.keys(c.definitions).length}));
`,
      );
      run(process.execPath, [script]);
      const summary = JSON.parse(readFileSync(join(dir, 'summary.json')));
      const inventory = JSON.parse(readFileSync(join(fixture, 'full-inventory.json')));
      assert.deepEqual(
        summary.operations.slice().sort(),
        inventory.operations.map((o) => o.id).sort(),
      );
      assert.deepEqual(
        summary.incoming.map((o) => o.name).sort(),
        inventory.incoming.map((o) => o.key).sort(),
      );
      assert.equal(summary.events.length, 189);
      assert.equal(summary.incoming.length, 189);
      assert.ok(summary.definitions > 100);
      assert.ok(
        summary.maxRSS < 4 * 1024 * 1024,
        `full generation peak RSS ${summary.maxRSS} KiB exceeds 4 GiB budget`,
      );
      assert.ok(summary.elapsedMs < 180000, `full generation took ${summary.elapsedMs} ms`);
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

      const packed = JSON.parse(
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
        ['install', '--ignore-scripts', '--no-audit', '--no-fund', join(dir, packed[0].filename)],
        { cwd: consumer },
      );
      writeFileSync(
        join(consumer, 'composer.json'),
        JSON.stringify({
          require: { 'example/flint-full-sdk': '1.0.0' },
          repositories: [{ type: 'path', url: join(output, 'php'), options: { symlink: false } }],
        }),
      );
      run('composer', ['install', '--no-interaction', '--no-dev', '--no-progress'], {
        cwd: consumer,
      });
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
const c=new Client({baseUrl:'https://api.example.invalid'});
const ids=${JSON.stringify(summary.operations)};
const methods=${JSON.stringify(summary.methods)};
assert.equal(methods.length,ids.length);
for(const {resource,method} of methods) assert.equal(typeof c[resource][method],'function');
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
const streaming=new Client({baseUrl:'https://api.example.invalid',authMode:'merchant',credentials:{merchant:{BearerAuth:'synthetic'}},transport:async (_url,request)=>{
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
$c=new Client(new ClientOptions(baseUrl:'https://api.example.invalid'));
$ids=json_decode('${JSON.stringify(summary.operations)}',true,512,JSON_THROW_ON_ERROR);
foreach(json_decode('${JSON.stringify(summary.methods)}',true) as $method) if(!method_exists($c->{$method['resource']},$method['method'])) throw new Exception('Missing method '.$method['method']);
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
$streaming=new Client(new ClientOptions(baseUrl:'https://api.example.invalid',authMode:'merchant',credentials:['merchant'=>['BearerAuth'=>'synthetic']],transport:function($request){
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
      run('php', ['check.php'], { cwd: consumer });
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
    assert.equal(union.size, 497);
  },
);
