import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspect } from 'node:util';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadContract, generate, render } from '../dist/generate.js';
import { EventStream } from '../dist/runtime.js';

const exec = promisify(execFile);
const dir = mkdtempSync(join(tmpdir(), 'sdk-followup-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const api = {
  openapi: '3.1.0',
  info: { title: 'Followup', version: '1' },
  components: {
    schemas: {
      Notice: { type: 'object', properties: { contact: { type: 'string', 'x-sensitive': true } } },
      Payload: {
        type: 'object',
        properties: {
          amount: { anyOf: [{ type: 'number' }, { type: 'string' }] },
          nested: { type: 'object', properties: { value: { type: 'string' } } },
          items: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
  paths: {
    '/events': {
      get: {
        operationId: 'watch',
        parameters: [
          { in: 'header', name: 'X-Context', required: true, schema: { type: 'string' } },
        ],
        responses: { 200: { description: 'stream', content: { 'text/event-stream': {} } } },
      },
    },
    '/pdf': {
      get: {
        operationId: 'download',
        responses: { 200: { description: 'pdf', content: { 'application/pdf': {} } } },
      },
    },
    '/save': {
      post: {
        operationId: 'save',
        requestBody: {
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Payload' } } },
        },
        responses: { 204: { description: 'empty' } },
      },
    },
  },
};
const profile = {
  version: '1.0.0',
  numericUnions: 'explicit',
  npm: { name: 'followup-sdk' },
  composer: { name: 'followup/sdk', namespace: 'FollowupSdk' },
  operations: {
    watch: {
      resource: 'events',
      method: 'watch',
      stream: { events: { message: '#/components/schemas/Notice' } },
      retry: { maxAttempts: 2, statuses: [], transport: true, baseDelayMs: 0 },
    },
  },
};
const definition = join(dir, 'api.json'),
  config = join(dir, 'sdk.json'),
  out = join(dir, 'out');
writeFileSync(definition, JSON.stringify(api));
writeFileSync(config, JSON.stringify(profile));
const contract = loadContract(definition, config);
generate(contract, out);
const sdk = await import(pathToFileURL(join(out, 'node/index.js')));

test('native SSE connection retries and empty headers agree in Node and PHP', async () => {
  let received = [];
  const server = createServer((req, res) => {
    received.push(req.headers);
    if (received.length === 1) {
      req.socket.destroy();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {}\n\n');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const php = join(dir, 'native.php');
  writeFileSync(
    php,
    `<?php
require $argv[1].'/php/src/Runtime.php';require $argv[1].'/php/src/Client.php';
$c=new FollowupSdk\\Client(new FollowupSdk\\ClientOptions(baseUrl:$argv[2],allowInsecureHttp:true));
try {$result=$c->events->watch(new FollowupSdk\\EventsWatchInput(['X-Context'=>'original']),new FollowupSdk\\RequestOptions(headers:['X-Context'=>''],maxAttempts:(int)$argv[3]));$result->data->close();echo json_encode(['attempts'=>$result->meta['attempts']]);}
catch(FollowupSdk\\SdkError $e){echo json_encode(['kind'=>$e->kind]);}finally{$c->close();}
`,
  );
  try {
    const client = new sdk.Client({ baseUrl, allowInsecureHttp: true });
    const result = await client.events.watch(
      { 'X-Context': 'original' },
      { headers: { 'X-Context': '' } },
    );
    await result.data.close();
    assert.equal(result.meta.attempts, 2);
    assert.deepEqual(
      received.map((h) => h['x-context']),
      ['', ''],
    );
    received = [];
    const success = await exec('php', [php, out, baseUrl, '2']);
    assert.deepEqual(JSON.parse(success.stdout), { attempts: 2 });
    assert.deepEqual(
      received.map((h) => h['x-context']),
      ['', ''],
    );
    received = [];
    const failure = await exec('php', [php, out, baseUrl, '1']);
    assert.deepEqual(JSON.parse(failure.stdout), { kind: 'transport' });
    assert.equal(received.length, 1);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

test('binary and stream inspection omits privileged data but explicit access preserves it', async () => {
  const client = new sdk.Client({
    baseUrl: 'https://example.invalid',
    transport: async (url) =>
      new Response(
        new URL(url).pathname === '/pdf' ? '%PDF' : 'data: {"contact":"private-contact"}\n\n',
        {
          headers: {
            'content-type':
              new URL(url).pathname === '/pdf' ? 'application/pdf' : 'text/event-stream',
            'set-cookie': 'session=private-cookie',
          },
        },
      ),
  });
  const pdf = await client.api.download();
  const stream = await client.events.watch({ 'X-Context': '' });
  for (const value of [pdf, stream, stream.data]) {
    assert.doesNotMatch(
      inspect(value, { depth: null }),
      /private-cookie|example.invalid|set-cookie/,
    );
    assert.equal(value.meta.headers['set-cookie'], 'session=private-cookie');
  }
  assert.equal(Buffer.from(pdf.raw).toString(), '%PDF');
  for await (const event of stream.data) {
    assert.doesNotMatch(inspect(event), /private-contact|rawData/);
    assert.equal(event.data.contact, 'private-contact');
    assert.equal(event.rawData, '{"contact":"private-contact"}');
  }
  const php = join(dir, 'inspect.php');
  writeFileSync(
    php,
    `<?php
require $argv[1].'/php/src/Runtime.php';
$source=new class implements FollowupSdk\\ByteStream {public function read():?string{return null;}public function close():void{}};
$s=new FollowupSdk\\EventStream($source,['status'=>200,'headers'=>['set-cookie'=>'private-cookie'],'url'=>'https://private.example'],[],fn($e,$d)=>$d,fn()=>null);
ob_start();var_dump($s);$debug=ob_get_clean();echo json_encode(['debug'=>$debug,'cookie'=>$s->meta['headers']['set-cookie']]);$s->close();
`,
  );
  const value = JSON.parse((await exec('php', [php, out])).stdout);
  assert.doesNotMatch(value.debug, /private-cookie|private.example/);
  assert.equal(value.cookie, 'private-cookie');
});

test('model JSON copies cannot change stored values or exact numeric wire kinds', async () => {
  const model = sdk.makePayload({
    amount: new sdk.ExactNumber('1.2500'),
    nested: { value: 'original' },
    items: ['one'],
  });
  const copy = model.toJSON();
  copy.amount = '2';
  copy.nested.value = 'edited';
  copy.items.push('two');
  const expected = { amount: '1.2500', nested: { value: 'original' }, items: ['one'] };
  assert.deepEqual(model.toJSON(), expected);
  assert.deepEqual(JSON.parse(JSON.stringify(model)), expected);
  let body;
  const client = new sdk.Client({
    baseUrl: 'https://example.invalid',
    transport: async (_url, request) => {
      body = request.body;
      return new Response(null, { status: 204 });
    },
  });
  await client.api.save({ body: model });
  assert.match(body, /"amount":1\.2500/);
  assert.deepEqual(JSON.parse(body), { ...expected, amount: 1.25 });
  assert.equal(sdk.serialize(new sdk.Model(null, { type: 'null' }), { type: 'null' }), 'null');
});

test('binary intrinsic names cannot be shadowed by provider models', () => {
  writeFileSync(
    join(dir, 'collision.json'),
    JSON.stringify({ ...profile, models: { Payload: 'Uint8Array' } }),
  );
  assert.throws(
    () => render(loadContract(definition, join(dir, 'collision.json'))),
    /generated type collision: Uint8Array/,
  );
});

test('long stream lifetime is preserved across native timer boundaries', async (t) => {
  const max = 2147483647,
    duration = 30 * 24 * 60 * 60 * 1000;
  let now = 0,
    closed = false;
  t.mock.method(performance, 'now', () => now);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stream = new EventStream(
    new ReadableStream({
      cancel() {
        closed = true;
      },
    }).getReader(),
    { status: 200, headers: {}, attempts: 1, durationMs: 0 },
    { lifetimeMs: duration, idleTimeoutMs: duration, maxEventBytes: 1024 },
  );
  now = 1;
  t.mock.timers.tick(1);
  assert.equal(closed, false);
  now = max;
  t.mock.timers.tick(max - 1);
  assert.equal(closed, false);
  now = duration - 1;
  t.mock.timers.tick(duration - max - 1);
  assert.equal(closed, false);
  now = duration;
  t.mock.timers.tick(1);
  assert.equal(closed, true);
  await assert.rejects(async () => Array.fromAsync(stream), { kind: 'deadline' });
});
