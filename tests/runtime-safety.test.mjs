import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync, execFile } from 'node:child_process';
import { promisify, inspect } from 'node:util';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { generate, loadContract } from '../dist/index.js';

const root = mkdtempSync(join(tmpdir(), 'sdk-runtime-safety-'));
after(() => rmSync(root, { recursive: true, force: true }));
const output = join(root, 'sdk');
const casesPath = resolve('tests/fixtures/runtime-safety.json');
const cases = JSON.parse(readFileSync(casesPath));
const sdkPath = join(output, 'node/index.js');
let Client, SdkError, errors, verifyWebhook, EventStream;
before(async () => {
  const api = JSON.parse(readFileSync('tests/fixtures/payment-api.json'));
  api.paths = Object.fromEntries(
    Object.entries(api.paths).map(([path, item]) => ['/v1' + path, item]),
  );
  const apiPath = join(root, 'api.json');
  writeFileSync(apiPath, JSON.stringify(api));
  generate(loadContract(apiPath, 'tests/fixtures/payment-sdk.json'), output);
  ({ Client, SdkError, errors, verifyWebhook } = await import(pathToFileURL(sdkPath)));
  ({ EventStream } = await import(pathToFileURL(join(output, 'node/runtime.js'))));
});
const defaults = { baseUrl: 'https://example.invalid', token: 'test', maxAttempts: 1 };
const payment = { id: 'p-synthetic', amount: 1, status: 'pending' };
function php(source, args = []) {
  const script = join(root, 'case.php');
  writeFileSync(script, '<?php\n' + source);
  const result = spawnSync('php', [script, join(output, 'php'), ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout);
}
const phpSetup = String.raw`
require $argv[1].'/src/Runtime.php';
require $argv[1].'/src/Client.php';
`;

test('generated Node and PHP pagination stop cycles, empty loops and page budgets', async () => {
  const expected = [];
  for (const scenario of cases.pagination) {
    for (const helper of ['Pages', 'Items']) {
      let calls = 0;
      const client = new Client({
        ...defaults,
        transport: async () => {
          calls++;
          return Response.json({
            items: scenario.empty.includes(calls) ? [] : [payment],
            next: scenario.next ? scenario.next[calls - 1] : `cursor-${calls}`,
          });
        },
      });
      let kind = null;
      try {
        for await (const _ of client.payments[`listAll${helper}`](
          scenario.initial ? { cursor: scenario.initial } : {},
          scenario.maxPages ? { maxPages: scenario.maxPages } : {},
        )) {
          /* consume */
        }
      } catch (error) {
        kind = error.kind;
      }
      assert.equal(kind, scenario.error, scenario.name);
      assert.equal(calls, scenario.calls, scenario.name);
      expected.push([scenario.name, helper, calls, kind]);
    }
  }
  const actual = php(
    phpSetup +
      String.raw`
$rows = [];
foreach (json_decode(file_get_contents($argv[2]), true)['pagination'] as $case) {
  foreach (['Pages', 'Items'] as $helper) {
    $calls = 0;
    $client = new Example\Payments\Client(new Example\Payments\ClientOptions('https://example.invalid', token:'test', maxAttempts:1, transport:function($r) use (&$calls, $case) {
      $calls++;
      return ['status'=>200, 'headers'=>[], 'body'=>json_encode(['items'=>in_array($calls, $case['empty']) ? [] : [['id'=>'p-synthetic','amount'=>1,'status'=>'pending']], 'next'=>isset($case['next']) ? $case['next'][$calls - 1] : 'cursor-'.$calls])];
    }));
    $kind = null;
    try {
      foreach ($client->payments->{'listAll'.$helper}(isset($case['initial']) ? ['cursor'=>$case['initial']] : [], new Example\Payments\RequestOptions(maxPages:$case['maxPages'] ?? null)) as $page) {}
    } catch (Example\Payments\SdkError $e) { $kind = $e->kind; }
    $rows[] = [$case['name'], $helper, $calls, $kind];
  }
}
echo json_encode($rows);
`,
    [casesPath],
  );
  assert.deepEqual(actual, expected);
});

test('Retry-After uses common decimal and HTTP-date syntax, never permissive date heuristics', async (t) => {
  t.mock.method(Date, 'now', () => 1700000000000);
  const values = [];
  for (const scenario of cases.retryAfter) {
    const client = new Client({
      ...defaults,
      transport: async () =>
        new Response('{}', { status: 429, headers: { 'retry-after': scenario.value } }),
    });
    await assert.rejects(client.payments.retrieve({ id: 'p-synthetic' }), (error) => {
      assert.equal(error.retryAfterMs ?? null, scenario.milliseconds, scenario.value);
      values.push(error.retryAfterMs ?? null);
      return true;
    });
  }
  const actual = php(
    String.raw`
namespace Example\Payments { function microtime(bool $asFloat = false): float { return 1700000000.0; } }
namespace { ` +
      phpSetup +
      String.raw`
$rows = [];
foreach (json_decode(file_get_contents($argv[2]), true)['retryAfter'] as $case) {
  $c = new Example\Payments\Client(new Example\Payments\ClientOptions('https://example.invalid', token:'test', maxAttempts:1, transport:fn($r)=>['status'=>429,'headers'=>['retry-after'=>$case['value']],'body'=>'{}']));
  try { $c->payments->retrieve(['id'=>'p-synthetic']); } catch (Example\Payments\SdkError $e) { $rows[] = $e->retryAfterMs; }
}
echo json_encode($rows); }
`,
    [casesPath],
  );
  assert.deepEqual(actual, values);
});

test('Node serialization and native crash output hide raw responses, headers, URLs and causes', async () => {
  const privateMarkers = [
    'synthetic-raw-body',
    'synthetic-cookie',
    'synthetic-query',
    'synthetic-auth',
  ];
  const cause = new Error('https://example.invalid/?token=synthetic-query', {
    cause: new Error('synthetic-auth'),
  });
  const error = new SdkError(
    'transport',
    'Safe transport failure',
    'unknown',
    false,
    {
      status: 502,
      headers: { 'set-cookie': privateMarkers[1], authorization: privateMarkers[3] },
      url: `https://example.invalid/?token=${privateMarkers[2]}`,
      attempts: 1,
      durationMs: 1,
    },
    'ECONNRESET',
    { transportCode: 'ECONNRESET' },
    { cause },
    privateMarkers[0],
  );
  assert.equal(error.raw, privateMarkers[0]);
  assert.equal(error.cause, cause);
  assert.equal(error.meta.headers['set-cookie'], privateMarkers[1]);
  for (const text of [
    JSON.stringify(error),
    JSON.stringify(error.toJSON()),
    inspect(error),
    inspect(error, { customInspect: false }),
  ]) {
    for (const marker of privateMarkers) assert.ok(!text.includes(marker), text);
    assert.ok(text.includes('ECONNRESET'));
  }
  const script = join(root, 'crash.mjs');
  writeFileSync(
    script,
    `import {SdkError} from ${JSON.stringify(pathToFileURL(sdkPath).href)};
const meta = ${JSON.stringify(error.meta)};
const cause = new Error('synthetic-auth');
const raw = 'synthetic-raw-body';
const error = new SdkError('transport','Safe transport failure','unknown',false,meta,'ECONNRESET',undefined,{cause},raw);
throw error;`,
  );
  const crash = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.notEqual(crash.status, 0);
  for (const marker of privateMarkers) assert.ok(!crash.stderr.includes(marker), crash.stderr);
});

test('PHP JSON, debug and fatal rendering omit private error state and trace arguments', () => {
  const serialized = php(
    phpSetup +
      String.raw`
function makeError($secret) {
  return new Example\Payments\SdkError('transport', 'Safe transport failure', 'unknown', false, ['status'=>null,'headers'=>['set-cookie'=>'synthetic-cookie','authorization'=>'synthetic-auth'],'url'=>'https://example.invalid/?token=synthetic-query'], 'ECONNRESET', ['field'=>'safe'], new Exception('synthetic-cause'), 'synthetic-raw-body');
}
$e = makeError('synthetic-argument');
ob_start(); var_dump($e); $debug = ob_get_clean();
echo json_encode([json_encode($e), $debug, (string)$e, $e->raw, $e->getPrevious()->getMessage()]);
`,
  );
  for (const text of serialized.slice(0, 3))
    for (const marker of [
      'synthetic-cookie',
      'synthetic-auth',
      'synthetic-query',
      'synthetic-raw-body',
      'synthetic-cause',
      'synthetic-argument',
    ])
      assert.ok(!text.includes(marker), text);
  assert.deepEqual(serialized.slice(3), ['synthetic-raw-body', 'synthetic-cause']);
  const script = join(root, 'fatal.php');
  writeFileSync(
    script,
    '<?php\n' +
      phpSetup +
      String.raw`throw new Example\Payments\SdkError('transport','Safe transport failure',previous:new Exception('synthetic-cause'),raw:'synthetic-raw-body');`,
  );
  const crash = spawnSync(
    'php',
    ['-d', 'zend.exception_ignore_args=0', script, join(output, 'php')],
    { encoding: 'utf8' },
  );
  assert.notEqual(crash.status, 0);
  assert.ok(!crash.stderr.includes('synthetic-cause'), crash.stderr);
  assert.ok(!crash.stderr.includes('synthetic-raw-body'), crash.stderr);
});

test('transport codes identify refusal and DNS without exposing native messages', async () => {
  for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']) {
    const cause = Object.assign(new Error('synthetic-private-url'), { code });
    const client = new Client({
      ...defaults,
      transport: async () => {
        throw new TypeError('fetch failed', { cause });
      },
    });
    await assert.rejects(client.payments.retrieve({ id: 'p-synthetic' }), (error) => {
      assert.ok(error instanceof errors.ConnectionError);
      assert.equal(error.code, code);
      assert.equal(error.details.transportCode, code);
      assert.deepEqual(error.toJSON().cause, { name: 'TypeError', code });
      assert.match(inspect(error), /cause:/);
      assert.equal(error.outcome, 'not_sent');
      assert.match(error.message, /request was not sent/);
      assert.ok(!inspect(error).includes('synthetic-private-url'));
      return true;
    });
  }
  assert.deepEqual(
    php(
      phpSetup +
        String.raw`
$rows = [];
foreach ([7,6,5,28] as $code) {
  $c = new Example\Payments\Client(new Example\Payments\ClientOptions('https://example.invalid',token:'test',maxAttempts:1,transport:fn($r)=>['status'=>0,'headers'=>[],'body'=>'','failureCode'=>$code]));
  try { $c->payments->retrieve(['id'=>'p-synthetic']); } catch (Example\Payments\SdkError $e) { $rows[] = [$e->kind,$e->errorCode,$e->outcome,$e->status,$e->meta['status'],$e->details['curlCode'],$e->details['curlError'] !== null]; }
}
echo json_encode($rows);
`,
    ),
    [
      ['transport', 'ECONNREFUSED', 'not_sent', null, null, 7, true],
      ['transport', 'ENOTFOUND', 'not_sent', null, null, 6, true],
      ['transport', 'ENOTFOUND', 'not_sent', null, null, 5, true],
      ['timeout', 'request_timeout', 'unknown', null, null, 28, true],
    ],
  );
});

test('default transports distinguish per-attempt timeouts, overall deadlines, refusal and DNS', async (t) => {
  const server = createServer((req, res) => {
    res.on('error', () => {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  for (const deadline of [false, true]) {
    const client = new Client({
      ...defaults,
      baseUrl,
      allowInsecureHttp: true,
      timeoutMs: deadline ? 2000 : 30,
      deadlineMs: deadline ? 30 : 2000,
    });
    await assert.rejects(client.payments.retrieve({ id: 'p-synthetic' }), (e) => {
      assert.ok(e instanceof (deadline ? errors.DeadlineError : errors.TimeoutError));
      assert.equal(e.retryAllowed, false === deadline);
      assert.match(e.message, deadline ? /deadline/ : /timed out/);
      return true;
    });
  }
  const script = join(root, 'transport.php');
  writeFileSync(
    script,
    '<?php\n' +
      phpSetup +
      String.raw`
$rows=[];
foreach ([false,true] as $deadline) {
  $c=new Example\Payments\Client(new Example\Payments\ClientOptions($argv[2],token:'test',allowInsecureHttp:true,maxAttempts:1,timeoutMs:$deadline?2000:30,deadlineMs:$deadline?30:2000));
  try { $c->payments->retrieve(['id'=>'p-synthetic']); } catch (Example\Payments\SdkError $e) { $rows[]=[$e->kind,$e->retryAllowed,$e->status,$e->details['curlCode']]; }
}
echo json_encode($rows);
`,
  );
  const result = await promisify(execFile)('php', [script, join(output, 'php'), baseUrl]);
  assert.deepEqual(JSON.parse(result.stdout), [
    ['timeout', true, null, 28],
    ['deadline', false, null, 28],
  ]);
  const refusal = createServer();
  await new Promise((r) => refusal.listen(0, '127.0.0.1', r));
  const refusedUrl = `http://127.0.0.1:${refusal.address().port}`;
  await new Promise((r) => refusal.close(r));
  for (const [url, code] of [
    [refusedUrl, 'ECONNREFUSED'],
    ['http://runtime-safety.invalid', 'ENOTFOUND'],
  ]) {
    const client = new Client({ ...defaults, baseUrl: url, allowInsecureHttp: true });
    await assert.rejects(client.payments.retrieve({ id: 'p-synthetic' }), {
      code,
      outcome: 'not_sent',
      kind: 'transport',
    });
  }
  assert.deepEqual(
    php(
      phpSetup +
        String.raw`
$rows=[];
putenv('no_proxy=*'); putenv('NO_PROXY=*');
foreach ([$argv[2], 'http://runtime-safety.invalid'] as $url) {
  $c=new Example\Payments\Client(new Example\Payments\ClientOptions($url,token:'test',allowInsecureHttp:true,maxAttempts:1));
  try { $c->payments->retrieve(['id'=>'p-synthetic']); } catch (Example\Payments\SdkError $e) { $rows[]=[$e->errorCode,$e->outcome,$e->status]; }
}
echo json_encode($rows);
`,
      [refusedUrl],
    ),
    [
      ['ECONNREFUSED', 'not_sent', null],
      ['ENOTFOUND', 'not_sent', null],
    ],
  );
});

test('unknown JavaScript client options and duplicated operation base paths fail helpfully', async () => {
  assert.throws(() => new Client({ ...defaults, maxRetries: 2 }), /maxRetries.*use maxAttempts/);
  assert.throws(
    () => new Client({ ...defaults, deadline: 1000 }),
    /deadline.*unknown client option/,
  );
  const client = new Client({
    ...defaults,
    baseUrl: 'https://example.invalid/v1',
    transport: async () => assert.fail('must reject before sending'),
  });
  await assert.rejects(
    client.payments.retrieve({ id: 'p-synthetic' }),
    /baseUrl.*remove that path/,
  );
  assert.deepEqual(
    php(
      phpSetup +
        String.raw`
$c = new Example\Payments\Client(new Example\Payments\ClientOptions('https://example.invalid/v1', token:'test'));
try { $c->payments->retrieve(['id'=>'p-synthetic']); } catch (Example\Payments\SdkError $e) { echo json_encode([$e->kind,$e->outcome,str_contains($e->getMessage(),'remove that path')]); }
`,
    ),
    ['validation', 'not_sent', true],
  );
});

test('webhook byte containers verify identically and millisecond clocks fail clearly', () => {
  const now = 1700000000;
  const bytes = Buffer.from('{"type":"unknown"}');
  const signature = createHmac('sha256', 'synthetic-signing-key')
    .update(String(now) + '.')
    .update(bytes)
    .digest('hex');
  // The payment fixture uses separate timestamp and signature headers.
  const headers = {};
  const config = JSON.parse(readFileSync('tests/fixtures/payment-sdk.json'));
  headers[config.webhook.header] = signature;
  headers[config.webhook.timestampHeader] = String(now);
  const body = new Uint8Array(bytes);
  for (const raw of [bytes, body, body.buffer]) {
    assert.doesNotThrow(() => verifyWebhook(raw, headers, 'synthetic-signing-key', now));
    assert.throws(
      () => verifyWebhook(raw, headers, 'synthetic-signing-key', now * 1000),
      /nowSeconds.*milliseconds.*1000/,
    );
  }
  assert.deepEqual(
    php(
      phpSetup +
        String.raw`
try { Example\Payments\Webhooks::verify('{}', [], 'synthetic-signing-key',1700000000000); } catch (Example\Payments\SdkError $e) { echo json_encode([$e->kind,str_contains($e->getMessage(),'milliseconds')]); }
`,
    ),
    ['validation', true],
  );
});

test('PHP rejects integer header values and model assignment as SDK validation errors', () => {
  assert.deepEqual(
    php(
      phpSetup +
        String.raw`
$rows=[];
$c=new Example\Payments\Client(new Example\Payments\ClientOptions('https://example.invalid',token:'test'));
try { $c->payments->retrieve(['id'=>'p-synthetic'],new Example\Payments\RequestOptions(headers:['X-Test'=>42])); } catch (Example\Payments\SdkError $e) { $rows[]=[$e->kind,$e->outcome,str_contains($e->getMessage(),'header')]; }
$m=new Example\Payments\Payment(['id'=>'p-synthetic','amount'=>1,'status'=>'pending']);
try { $m->status='failed'; } catch (Example\Payments\SdkError $e) { $rows[]=[$e->kind,$e->outcome,str_contains($e->getMessage(),'read-only')]; }
echo json_encode($rows);
`,
    ),
    [
      ['validation', 'not_sent', true],
      ['validation', 'not_sent', true],
    ],
  );
});

test('malformed SSE events retain event id and one-based position, then release the stream', async () => {
  let released = false;
  const source = new ReadableStream({
    start(c) {
      c.enqueue(Buffer.from('id: event-1\ndata: {}\n\nid: event-2\ndata: bad-json\n\n'));
    },
    cancel() {
      released = true;
    },
  });
  const stream = new EventStream(
    source.getReader(),
    { status: 200, headers: {}, attempts: 1, durationMs: 1 },
    { idleTimeoutMs: 100, maxEventBytes: 1000 },
    (_event, raw) => JSON.parse(raw),
  );
  let count = 0;
  await assert.rejects(
    async () => {
      for await (const event of stream) count++;
    },
    (e) => {
      assert.equal(e.code, 'sse_invalid_event');
      assert.deepEqual(e.details, { eventId: 'event-2', position: 2 });
      assert.match(e.message, /event 2/);
      return true;
    },
  );
  assert.equal(count, 1);
  assert.equal(released, true);
  assert.deepEqual(
    php(
      phpSetup +
        String.raw`
$source=new class implements Example\Payments\ByteStream {
  private bool $done=false;
  public function read(): ?string { if($this->done)return null;$this->done=true;return "id: event-1\ndata: {}\n\nid: event-2\ndata: bad-json\n\n"; }
  public function close():void {}
};
$s=new Example\Payments\EventStream($source,['status'=>200],['idleTimeoutMs'=>100,'maxEventBytes'=>1000],fn($event,$raw)=>json_decode($raw,flags:JSON_THROW_ON_ERROR),fn()=>null);
$count=0;
try { foreach($s as $event)$count++; } catch(Example\Payments\SdkError $e) { echo json_encode([$count,$e->errorCode,$e->details]); }
`,
    ),
    [1, 'sse_invalid_event', { eventId: 'event-2', position: 2 }],
  );
});

test('a later refused connection cannot erase an earlier unknown request outcome', async () => {
  for (const unknownFirst of [false, true, 'response']) {
    let attempts = 0;
    const client = new Client({
      baseUrl: defaults.baseUrl,
      token: 'test',
      transport: async () => {
        attempts++;
        if (unknownFirst === 'response' && attempts === 1)
          return new Response('{}', { status: 503 });
        throw Object.assign(new Error('synthetic-transport-detail'), {
          code: unknownFirst && attempts === 1 ? 'ECONNRESET' : 'ECONNREFUSED',
        });
      },
    });
    await assert.rejects(client.payments.retrieve({ id: 'p-synthetic' }), {
      kind: 'transport',
      outcome: unknownFirst ? 'unknown' : 'not_sent',
    });
    assert.equal(attempts, 3);
  }
  assert.deepEqual(
    php(
      phpSetup +
        String.raw`
$rows=[];
foreach([false,true,'response'] as $unknownFirst){
 $attempts=0;
 $c=new Example\Payments\Client(new Example\Payments\ClientOptions('https://example.invalid',token:'test',transport:function($r)use(&$attempts,$unknownFirst){$attempts++;if($unknownFirst==='response' && $attempts===1)return ['status'=>503,'headers'=>[],'body'=>'{}'];return ['status'=>0,'headers'=>[],'body'=>'','failureCode'=>$unknownFirst && $attempts===1 ? 56 : 7];}));
 try{$c->payments->retrieve(['id'=>'p-synthetic']);}catch(Example\Payments\SdkError $e){$rows[]=[$e->outcome,$attempts];}
}
echo json_encode($rows);
`,
    ),
    [
      ['not_sent', 3],
      ['unknown', 3],
      ['unknown', 3],
    ],
  );
});

test('opaque custom transport exception text and codes remain private and unclassified', async () => {
  const client = new Client({
    ...defaults,
    transport: async () => {
      throw Object.assign(new Error('synthetic-secret-text'), { code: 'SYNTHETIC_SECRET_CODE' });
    },
  });
  await assert.rejects(client.payments.retrieve({ id: 'p-synthetic' }), (e) => {
    assert.equal(e.code, 'transport_failure');
    assert.equal(e.outcome, 'unknown');
    assert.ok(!JSON.stringify(e).includes('synthetic-secret-text'));
    assert.ok(!JSON.stringify(e).includes('SYNTHETIC_SECRET_CODE'));
    return true;
  });
  assert.deepEqual(
    php(
      phpSetup +
        String.raw`
$c=new Example\Payments\Client(new Example\Payments\ClientOptions('https://example.invalid',token:'test',maxAttempts:1,transport:fn($r)=>throw new RuntimeException('synthetic-secret-text',7)));
try{$c->payments->retrieve(['id'=>'p-synthetic']);}catch(Example\Payments\SdkError $e){echo json_encode([$e->kind,$e->outcome,$e->details['curlCode'],str_contains(json_encode($e),'synthetic-secret-text'),$e->getPrevious()->getMessage()]);}
`,
    ),
    ['transport', 'unknown', null, false, 'synthetic-secret-text'],
  );
});

test('link pagination recognizes a cycle back to its original request URL', async () => {
  let calls = 0;
  const client = new Client({
    ...defaults,
    transport: async () => {
      calls++;
      return Response.json({
        items: [payment],
        next: calls === 1 ? '/v1/links?page=B' : '/v1/links',
      });
    },
  });
  await assert.rejects(
    async () => {
      for await (const _ of client.payments.linksPages()) {
      }
    },
    { kind: 'protocol' },
  );
  assert.equal(calls, 2);
  assert.deepEqual(
    php(
      phpSetup +
        String.raw`
$calls=0;
$c=new Example\Payments\Client(new Example\Payments\ClientOptions('https://example.invalid',token:'test',maxAttempts:1,transport:function($r)use(&$calls){$calls++;return ['status'=>200,'headers'=>[],'body'=>json_encode(['items'=>[['id'=>'p-synthetic','amount'=>1,'status'=>'pending']],'next'=>$calls===1?'/v1/links?page=B':'/v1/links'])];}));
try{foreach($c->payments->linksPages() as $page){}}catch(Example\Payments\SdkError $e){echo json_encode([$e->kind,$calls]);}
`,
    ),
    ['protocol', 2],
  );
});

test('PHP fractional millisecond webhook clocks also explain the seconds conversion', () => {
  assert.deepEqual(
    php(
      phpSetup +
        String.raw`
try{Example\Payments\Webhooks::verify('{}',[],'synthetic-signing-key',1700000000000.5);}catch(Example\Payments\SdkError $e){echo json_encode([$e->kind,str_contains($e->getMessage(),'milliseconds')]);}
`,
    ),
    ['validation', true],
  );
});
