import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadContract, generate, validateFixtures } from '../dist/index.js';
import { EventStream } from '../dist/runtime.js';
const exec = promisify(execFile);
const dir = mkdtempSync(join(tmpdir(), 'sdk-sse-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const meta = { status: 200, headers: {}, attempts: 1, durationMs: 0 };
const wire =
  '\ufeff:heartbeat\r\nid: cursor-1\revent: ready\ndata: héllo\r\ndata: world\r\nretry: 1500\r\n\r\ndata:\n\nid: bad\0id\ndata: last\n\ndata: discarded';
const expected = [
  { event: 'ready', id: 'cursor-1', data: 'héllo\nworld', rawData: 'héllo\nworld', retry: 1500 },
  { event: 'message', id: 'cursor-1', data: '', rawData: '', retry: 1500 },
  { event: 'message', id: 'cursor-1', data: 'last', rawData: 'last', retry: 1500 },
];
function reader(chunks, released = () => {}) {
  return new ReadableStream({
    start(controller) {
      chunks.forEach((chunk) => controller.enqueue(chunk));
      controller.close();
    },
    cancel: released,
  }).getReader();
}
test('Node SSE parser handles byte boundaries and releases on every exit', async () => {
  const bytes = Buffer.from(wire);
  for (const chunks of [[bytes], Array.from(bytes, (byte) => Uint8Array.of(byte))]) {
    let released = 0;
    const stream = new EventStream(
      reader(chunks),
      meta,
      { idleTimeoutMs: 100, maxEventBytes: 1000 },
      undefined,
      () => released++,
    );
    assert.deepEqual(await Array.fromAsync(stream), expected);
    assert.equal(released, 1);
    await assert.rejects(async () => Array.fromAsync(stream), /only be consumed once/);
  }
  let cancelled = false;
  const open = new EventStream(
    new ReadableStream({
      start(c) {
        c.enqueue(Buffer.from('data: first\n\ndata: second\n\n'));
      },
      cancel() {
        cancelled = true;
      },
    }).getReader(),
    meta,
    { idleTimeoutMs: 100, maxEventBytes: 1000 },
  );
  for await (const frame of open) {
    assert.equal(frame.data, 'first');
    break;
  }
  assert.equal(cancelled, true);
  const invalid = new EventStream(reader([Uint8Array.of(255)]), meta, {
    idleTimeoutMs: 100,
    maxEventBytes: 1000,
  });
  await assert.rejects(async () => Array.fromAsync(invalid), { kind: 'protocol' });
  const oversized = new EventStream(reader([Buffer.from('data: 12345\n\n')]), meta, {
    idleTimeoutMs: 100,
    maxEventBytes: 5,
  });
  await assert.rejects(async () => Array.fromAsync(oversized), { kind: 'protocol' });
  const idle = new EventStream(new ReadableStream().getReader(), meta, {
    idleTimeoutMs: 10,
    maxEventBytes: 1000,
  });
  await assert.rejects(async () => Array.fromAsync(idle), { kind: 'deadline' });
  const controller = new AbortController();
  const cancelledStream = new EventStream(new ReadableStream().getReader(), meta, {
    idleTimeoutMs: 1000,
    maxEventBytes: 1000,
    signal: controller.signal,
  });
  const pending = Array.fromAsync(cancelledStream);
  controller.abort();
  await assert.rejects(pending, { kind: 'cancelled' });
});
writeFileSync(
  join(dir, 'api.json'),
  JSON.stringify({
    openapi: '3.1.0',
    info: { title: 'Streams', version: 'v1' },
    paths: {
      '/events': {
        get: {
          operationId: 'watch',
          responses: {
            200: {
              description: 'stream',
              content: { 'text/event-stream': { schema: { type: 'string' } } },
            },
            400: {
              description: 'error',
              content: { 'application/json': { schema: { type: 'object' } } },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Ready: {
          type: 'object',
          required: ['sequence'],
          properties: { sequence: { type: 'integer', format: 'int64' } },
        },
      },
    },
  }),
);
writeFileSync(
  join(dir, 'sdk.json'),
  JSON.stringify({
    version: '1.0.0',
    npm: { name: '@example/streams' },
    composer: { name: 'example/streams', namespace: 'Example\\Streams' },
    operations: {
      watch: {
        resource: 'events',
        method: 'watch',
        stream: { events: { ready: '#/components/schemas/Ready' } },
      },
    },
  }),
);
const out = join(dir, 'out');
generate(loadContract(join(dir, 'api.json'), join(dir, 'sdk.json')), out);
test('PHP parser matches independently specified event frames for split UTF-8 and lines', async () => {
  writeFileSync(
    join(dir, 'parser.php'),
    `<?php
require ${JSON.stringify(join(out, 'php/src/Runtime.php'))};
use Example\\Streams\\{ByteStream,EventStream};
$wire=base64_decode('${Buffer.from(wire).toString('base64')}');
foreach ([$wire, str_split($wire)] as $chunks) {
 $source=new class(is_array($chunks) ? $chunks : [$chunks]) implements ByteStream {
  public bool $closed=false;
  public function __construct(private array $chunks) {}
  public function read(): ?string { return array_shift($this->chunks); }
  public function close(): void { $this->closed=true; }
 };
 $stream=new EventStream($source, [], ['idleTimeoutMs'=>1000,'maxEventBytes'=>1000], fn($event,$raw)=>$raw, fn()=>null);
 $frames=iterator_to_array($stream);
 if (!$source->closed) throw new Exception('connection leak');
 echo json_encode($frames, JSON_THROW_ON_ERROR)."\\n";
}
`,
  );
  const { stdout } = await exec('php', [join(dir, 'parser.php')]);
  for (const line of stdout.trim().split('\n')) assert.deepEqual(JSON.parse(line), expected);
});
test('both generated default transports yield before EOF and close the connection', async () => {
  let requests = 0,
    closed = 0;
  const server = createServer((request, response) => {
    requests++;
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'x-request-id': 'stream-test' });
    response.write('event: ready\ndata: {"sequence":9007199254740993}\n\n');
    const timer = setTimeout(() => response.end('data: too late\n\n'), 5000);
    response.on('close', () => {
      clearTimeout(timer);
      closed++;
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const { Client } = await import(join(out, 'node/index.js'));
    const client = new Client({ baseUrl, allowInsecureHttp: true });
    const start = performance.now();
    const result = await client.events.watch({}, { timeoutMs: 1000 });
    for await (const frame of result.data) {
      assert.equal(frame.data.sequence, '9007199254740993');
      break;
    }
    assert.ok(performance.now() - start < 2000, 'Node buffered until EOF');
    assert.equal(result.meta.requestId, 'stream-test');
    await client.close();
    writeFileSync(
      join(dir, 'transport.php'),
      `<?php
require ${JSON.stringify(join(out, 'php/src/Runtime.php'))};
require ${JSON.stringify(join(out, 'php/src/Client.php'))};
use Example\\Streams\\{Client,ClientOptions,RequestOptions};
$client=new Client(new ClientOptions(baseUrl: $argv[1], allowInsecureHttp: true));
$start=microtime(true);
$result=$client->events->watch(options: new RequestOptions(timeoutMs: 1000));
foreach ($result->data as $frame) { if ($frame->data->sequence !== '9007199254740993') throw new Exception('precision'); break; }
if (microtime(true)-$start > 2) throw new Exception('PHP buffered until EOF');
if ($result->meta['requestId'] !== 'stream-test') throw new Exception('metadata');
$client->close();
echo 'ok';
`,
    );
    const { stdout } = await exec('php', [join(dir, 'transport.php'), baseUrl]);
    assert.equal(stdout, 'ok');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(requests, 2);
    assert.equal(closed, 2);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('injected streams retain unknown events, reject malformed known payloads and never replay events', async () => {
  const { Client } = await import(join(out, 'node/index.js'));
  let calls = 0;
  let released = 0;
  let payload =
    'event: future\ndata: raw future payload\n\nevent: ready\ndata: {"sequence":false}\n\n';
  const client = new Client({
    baseUrl: 'https://example.invalid',
    transport: async () => {
      calls++;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(Buffer.from(payload));
          },
          cancel() {
            released++;
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const result = await client.events.watch();
  const iterator = result.data[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value.data, 'raw future payload');
  await assert.rejects(iterator.next(), { kind: 'protocol' });
  assert.equal(calls, 1);
  assert.equal(released, 1);
  const closeable = await client.events.watch();
  await client.close();
  assert.deepEqual(await Array.fromAsync(closeable.data), []);
  assert.equal(released, 2);
  await assert.rejects(client.events.watch({}, { streamIdleTimeoutMs: 0 }), { kind: 'validation' });
  assert.equal(calls, 2);

  writeFileSync(
    join(dir, 'injected.php'),
    `<?php
require ${JSON.stringify(join(out, 'php/src/Runtime.php'))};
require ${JSON.stringify(join(out, 'php/src/Client.php'))};
use Example\\Streams\\{ByteStream,Client,ClientOptions,SdkError};
$calls=0;$closed=0;
$client=new Client(new ClientOptions(baseUrl:'https://example.invalid',transport:function($request) use (&$calls,&$closed) {
 $calls++;
 $source=new class($closed) implements ByteStream {
  private bool $read=false; private bool $done=false;
  public function __construct(private mixed &$closed) {}
  public function read(): ?string { if($this->read)return null;$this->read=true;return "event: future\\ndata: raw future payload\\n\\nevent: ready\\ndata: {\\"sequence\\":false}\\n\\n"; }
  public function close(): void { if(!$this->done){$this->done=true;$this->closed++;} }
 };
 return ['status'=>200,'headers'=>['content-type'=>'text/event-stream'],'stream'=>$source];
}));
$result=$client->events->watch();$seen=[];
try { foreach($result->data as $event)$seen[]=$event->data;throw new Exception('accepted malformed event'); }
catch(SdkError $error){if($error->kind!=='protocol')throw $error;}
if($seen!==['raw future payload']||$calls!==1||$closed!==1)throw new Exception('stream contract');
$client->close();echo 'ok';
`,
  );
  assert.equal((await exec('php', [join(dir, 'injected.php')])).stdout, 'ok');
});

test('default streams bound slow-consumer memory and release idle, cancelled and lifetime-limited connections', async () => {
  let closed = 0;
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.flushHeaders();
    response.on('close', () => closed++);
    if (request.headers['x-stream-test'] !== 'bulk') return;
    const frame = 'data: ' + 'x'.repeat(16384) + '\n\n';
    let sent = 0;
    const pump = () => {
      while (sent < 2048 && !response.destroyed) {
        sent++;
        if (!response.write(frame)) {
          response.once('drain', pump);
          return;
        }
      }
      response.end();
    };
    pump();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const { Client } = await import(join(out, 'node/index.js'));
    const client = new Client({ baseUrl, allowInsecureHttp: true });
    const baseline = process.memoryUsage().arrayBuffers;
    let peak = baseline;
    const bulk = await client.events.watch({}, { headers: { 'x-stream-test': 'bulk' } });
    let count = 0;
    for await (const event of bulk.data) {
      assert.equal(event.rawData.length, 16384);
      count++;
      peak = Math.max(peak, process.memoryUsage().arrayBuffers);
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    assert.equal(count, 2048);
    assert.ok(peak - baseline < 24 * 1024 * 1024, `Node stream buffered ${peak - baseline} bytes`);
    for (const options of [{ streamIdleTimeoutMs: 30 }, { streamLifetimeMs: 30 }]) {
      const result = await client.events.watch({}, options);
      await assert.rejects(async () => Array.fromAsync(result.data), { kind: 'deadline' });
    }
    const controller = new AbortController();
    const result = await client.events.watch({}, { signal: controller.signal });
    const pending = Array.fromAsync(result.data);
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(pending, { kind: 'cancelled' });
    await client.close();
    writeFileSync(
      join(dir, 'bounded.php'),
      `<?php
require ${JSON.stringify(join(out, 'php/src/Runtime.php'))};
require ${JSON.stringify(join(out, 'php/src/Client.php'))};
use Example\\Streams\\{Client,ClientOptions,RequestOptions,Cancellation,SdkError};
$c=new Client(new ClientOptions(baseUrl:$argv[1],allowInsecureHttp:true));
$base=memory_get_usage(true);$peak=$base;
for($round=0;$round<3;$round++) {
 $result=$c->events->watch(options:new RequestOptions(headers:['x-stream-test'=>'bulk']));
 $count=0;
 foreach($result->data as $frame) {
  if(strlen($frame->rawData)!==16384)throw new Exception('frame corruption');
  $count++;$peak=max($peak,memory_get_usage(true));usleep(1000);
  if($round>0 && $count===10)break;
 }
 if($round===0 && $count!==2048)throw new Exception('missing frames');
}
if($peak-$base>8*1024*1024)throw new Exception('unbounded PHP stream memory');
foreach([new RequestOptions(streamIdleTimeoutMs:30),new RequestOptions(streamLifetimeMs:30)] as $options) {
 $result=$c->events->watch(options:$options);
 try{iterator_to_array($result->data);throw new Exception('missing deadline');}
 catch(SdkError $e){if($e->kind!=='deadline')throw $e;}
}
$cancel=new Cancellation();
$result=$c->events->watch(options:new RequestOptions(cancellation:$cancel));
pcntl_async_signals(true);pcntl_signal(SIGALRM,fn()=>$cancel->cancel());pcntl_alarm(1);
try{iterator_to_array($result->data);throw new Exception('missing cancellation');}
catch(SdkError $e){if($e->kind!=='cancelled')throw $e;}
finally{pcntl_alarm(0);$c->close();}
echo 'ok';
`,
    );
    assert.equal((await exec('php', [join(dir, 'bounded.php'), baseUrl])).stdout, 'ok');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(requests, 10);
    assert.equal(closed, requests);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('stream operations decode JSON HTTP errors before exposing an event iterator', async () => {
  const file = join(dir, 'http-error.json');
  writeFileSync(
    file,
    JSON.stringify([
      {
        name: 'stream JSON rejection',
        operation: 'watch',
        input: {},
        expected: { method: 'GET', path: '/v1/events' },
        responses: [
          {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
            body: '{"code":"invalid_cursor"}',
          },
        ],
        error: { kind: 'validation', code: 'invalid_cursor' },
      },
    ]),
  );
  assert.deepEqual(
    (await validateFixtures(out, file)).map((result) => result.scenarios),
    [1, 1],
  );
});
