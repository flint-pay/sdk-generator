import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as httpServer } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { connect } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadContract, generate } from '../dist/index.js';

const exec = promisify(execFile);
const dir = mkdtempSync(join(tmpdir(), 'sdk-php-review-'));
after(() => rmSync(dir, { recursive: true, force: true }));
writeFileSync(
  join(dir, 'api.json'),
  JSON.stringify({
    openapi: '3.1.0',
    info: { title: 'Review', version: '1' },
    paths: {
      '/save': {
        post: {
          operationId: 'save',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    nested: { type: 'object', properties: { value: { type: 'string' } } },
                    items: {
                      type: 'array',
                      items: { type: 'object', properties: { value: { type: 'string' } } },
                    },
                    amount: { anyOf: [{ type: 'number' }, { type: 'string' }] },
                  },
                },
              },
            },
          },
          responses: { 204: { description: 'empty' } },
        },
      },
      '/events': {
        get: {
          operationId: 'watch',
          responses: { 200: { description: 'stream', content: { 'text/event-stream': {} } } },
        },
      },
    },
  }),
);
writeFileSync(
  join(dir, 'sdk.json'),
  JSON.stringify({
    version: '1.0.0',
    numericUnions: 'explicit',
    requests: { style: 'object' },
    npm: { name: 'review-fixes' },
    composer: { name: 'review/fixes', namespace: 'ReviewFixes' },
  }),
);
const out = join(dir, 'out');
generate(loadContract(join(dir, 'api.json'), join(dir, 'sdk.json')), out);

test('PHP model exports isolate edits and retain exact numeric kinds when rebuilding inputs', async () => {
  const script = String.raw`
require $argv[1].'/php/src/Runtime.php';
require $argv[1].'/php/src/Client.php';
use ReviewFixes\{Client, ClientOptions, ApiSaveInput, ExactNumber};
$requests=[];
$client=new Client(new ClientOptions(baseUrl:'https://example.invalid',transport:function($request)use(&$requests){
    $requests[]=$request['body'];return ['status'=>204,'headers'=>[],'body'=>''];
}));
$input=new ApiSaveInput(['body'=>['nested'=>['value'=>'original'],'items'=>[['value'=>'original']],'amount'=>new ExactNumber('1.2500')]]);
$original=json_encode($input);
$exports=[
    fn()=>$input->get('body'), fn()=>$input->body, fn()=>$input->getBody(),
    fn()=>$input->toArray()['body'], fn()=>$input->jsonSerialize()->body,
    fn()=>$input->toInputArray()['body'], fn()=>$input->toInputValue()->body,
];
foreach($exports as $export){
    $copy=$export();$copy->nested->value='edited';$copy->items[0]->value='edited';$copy->amount='replacement';
    if(json_encode($input)!==$original)throw new Exception('Public model state was mutated');
    $client->api->save($input);
}
foreach([$input->toInputArray(),(array)$input->toInputValue()] as $copy){
    $copy['body']->nested->value='intentional';
    $client->api->save(new ApiSaveInput($copy));
}
$client->close();echo json_encode($requests);
`;
  const requests = JSON.parse((await exec('php', ['-r', script, out])).stdout);
  assert.equal(requests.length, 9);
  for (const [index, raw] of requests.entries()) {
    assert.match(raw, /"amount":1\.2500/);
    assert.deepEqual(JSON.parse(raw), {
      nested: { value: index < 7 ? 'original' : 'intentional' },
      items: [{ value: 'original' }],
      amount: 1.25,
    });
  }
});

test('native PHP SSE reads origin headers through an HTTPS CONNECT tunnel', async () => {
  const key = join(dir, 'localhost.key'),
    cert = join(dir, 'localhost.crt');
  await exec('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    key,
    '-out',
    cert,
    '-days',
    '1',
    '-subj',
    '/CN=localhost',
    '-addext',
    'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ]);
  let originRequests = 0,
    connections = 0;
  const origin = httpsServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
    originRequests++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: actual-origin-event\n\n');
  });
  const sockets = new Set(),
    timers = new Set();
  const track = (socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    return socket;
  };
  const proxy = httpServer();
  origin.on('connection', track);
  proxy.on('connection', track);
  proxy.on('connect', (req, client, head) => {
    connections++;
    const upstream = track(connect(origin.address().port, '127.0.0.1'));
    upstream.once('connect', () => {
      client.write('HTTP/1.1 200 Connection established\r\n\r\n');
      // Separate proxy headers from origin headers, as on a real network.
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (client.destroyed) {
          upstream.destroy();
          return;
        }
        if (head.length) upstream.write(head);
        client.pipe(upstream);
        upstream.pipe(client);
      }, 150);
      timers.add(timer);
    });
    client.once('close', () => upstream.destroy());
    upstream.once('close', () => client.destroy());
  });
  await new Promise((r) => origin.listen(0, '127.0.0.1', r));
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  // Trust only the fixture CA without changing the generated runtime or disabling TLS checks.
  const script = String.raw`
namespace ReviewFixes {
    function curl_init() {
        $handle=\curl_init();\curl_setopt($handle, CURLOPT_CAINFO, $GLOBALS['argv'][3]);return $handle;
    }
}
namespace {
    require $argv[1].'/php/src/Runtime.php';require $argv[1].'/php/src/Client.php';
    $client=new ReviewFixes\Client(new ReviewFixes\ClientOptions(baseUrl:$argv[2],timeoutMs:5000,deadlineMs:10000));
    try {
        $result=$client->api->watch();$events=[];
        foreach($result->data as $event)$events[]=$event->data;
        echo json_encode(['status'=>$result->meta['status'],'events'=>$events]);
    } finally {$client->close();}
}`;
  try {
    const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
    const result = await exec(
      'php',
      ['-r', script, out, `https://localhost:${origin.address().port}`, cert],
      {
        env: {
          ...process.env,
          https_proxy: proxyUrl,
          HTTPS_PROXY: proxyUrl,
          NO_PROXY: '',
          no_proxy: '',
          ALL_PROXY: '',
          all_proxy: '',
        },
        timeout: 15000,
      },
    );
    assert.deepEqual(JSON.parse(result.stdout), { status: 200, events: ['actual-origin-event'] });
    assert.equal(connections, 1);
    assert.equal(originRequests, 1);
  } finally {
    for (const timer of timers) clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    await Promise.all([new Promise((r) => origin.close(r)), new Promise((r) => proxy.close(r))]);
  }
});
