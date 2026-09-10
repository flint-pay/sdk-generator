import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadContract, generate, validateFixtures } from '../dist/index.js';
const dir = mkdtempSync(join(tmpdir(), 'sdk-response-media-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const paths = {
  '/pdf': {
    get: {
      operationId: 'download',
      responses: {
        200: { description: 'PDF', content: { 'application/pdf': {} } },
        400: {
          description: 'Error',
          content: { 'application/json': { schema: { type: 'object' } } },
        },
      },
    },
  },
  '/redirect': {
    get: {
      operationId: 'redirectDownload',
      responses: {
        307: {
          description: 'Artifact',
          headers: { Location: { required: true, schema: { type: 'string' } } },
        },
      },
    },
  },
  '/authorize': {
    get: { operationId: 'authorize', responses: { 302: { description: 'Continue' } } },
  },
};
writeFileSync(
  join(dir, 'api.json'),
  JSON.stringify({ openapi: '3.1.0', info: { title: 'Media', version: 'v1' }, paths }),
);
writeFileSync(
  join(dir, 'sdk.json'),
  JSON.stringify({
    version: '1.0.0',
    npm: { name: '@example/response-media' },
    composer: { name: 'example/response-media', namespace: 'Example\\Media' },
  }),
);
test('binary bytes and declared redirects are returned unchanged by both clients', async () => {
  const out = join(dir, 'out');
  generate(loadContract(join(dir, 'api.json'), join(dir, 'sdk.json')), out);
  const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0, 255, 128, 0, 10]).toString('base64');
  const success = (name, operation, path, response, expected) => ({
    name,
    operation,
    input: {},
    expected: { method: 'GET', path },
    responses: [response],
    ...expected,
  });
  const failure = (name, operation, path, response, kind) =>
    success(name, operation, path, response, { error: { kind } });
  const cases = [
    success(
      'binary exact bytes',
      'download',
      '/v1/pdf',
      { status: 200, headers: { 'Content-Type': 'application/pdf' }, bodyBase64: bytes },
      { dataBase64: bytes, status: 200 },
    ),
    success(
      'empty PDF',
      'download',
      '/v1/pdf',
      { status: 200, headers: { 'Content-Type': 'application/pdf' }, bodyBase64: '' },
      { dataBase64: '', status: 200 },
    ),
    failure(
      'unexpected PDF media type',
      'download',
      '/v1/pdf',
      { status: 200, headers: { 'Content-Type': 'text/plain' }, body: 'x' },
      'protocol',
    ),
    failure(
      'PDF JSON error',
      'download',
      '/v1/pdf',
      { status: 400, body: '{"error":"invalid"}' },
      'validation',
    ),
    success(
      '307 location returned',
      'redirectDownload',
      '/v1/redirect',
      {
        status: 307,
        headers: { Location: 'https://untrusted.example.invalid/report.pdf' },
        body: '',
      },
      { data: { location: 'https://untrusted.example.invalid/report.pdf' }, status: 307 },
    ),
    success(
      '302 without optional location',
      'authorize',
      '/v1/authorize',
      { status: 302, body: '<html>Continue</html>' },
      { data: {}, status: 302 },
    ),
    failure(
      'required location missing',
      'redirectDownload',
      '/v1/redirect',
      { status: 307 },
      'protocol',
    ),
    failure(
      'undeclared redirect',
      'download',
      '/v1/pdf',
      { status: 302, headers: { Location: 'https://untrusted.example.invalid' } },
      'destination',
    ),
  ];
  writeFileSync(join(dir, 'cases.json'), JSON.stringify(cases));
  assert.deepEqual(
    (await validateFixtures(out, join(dir, 'cases.json'))).map((result) => result.scenarios),
    [8, 8],
  );
});

test('default transports preserve PDF bytes and return cross-origin redirects without following', async () => {
  const { createServer } = await import('node:http');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const out = join(dir, 'native');
  generate(loadContract(join(dir, 'api.json'), join(dir, 'sdk.json')), out);
  const bytes = Buffer.from([37, 80, 68, 70, 0, 255, 128]);
  let stolen = 0;
  let requests = 0;
  const destination = createServer((_request, response) => {
    stolen++;
    response.end('unexpected');
  });
  await new Promise((resolve) => destination.listen(0, '127.0.0.1', resolve));
  const location = `http://127.0.0.1:${destination.address().port}/artifact`;
  const server = createServer((request, response) => {
    requests++;
    if (request.url === '/pdf') {
      response.writeHead(200, { 'Content-Type': 'application/pdf', 'x-request-id': 'pdf-native' });
      response.end(bytes);
    } else {
      response.writeHead(307, { Location: location });
      response.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const { Client } = await import(join(out, 'node/index.js'));
    const client = new Client({ baseUrl, allowInsecureHttp: true });
    const result = await client.api.download();
    assert.deepEqual(Buffer.from(result.data), bytes);
    assert.equal(result.meta.requestId, 'pdf-native');
    assert.equal((await client.api.redirectDownload()).data.location, location);
    writeFileSync(
      join(dir, 'native.php'),
      `<?php
require ${JSON.stringify(join(out, 'php/src/Runtime.php'))};
require ${JSON.stringify(join(out, 'php/src/Client.php'))};
use Example\\Media\\{Client,ClientOptions};
$c=new Client(new ClientOptions(baseUrl:$argv[1],allowInsecureHttp:true));
$result=$c->api->download();
if(base64_encode($result->data)!=='${bytes.toString('base64')}'||$result->raw!==$result->data||$result->meta['requestId']!=='pdf-native')throw new Exception('binary corruption');
if($c->api->redirectDownload()->data->location!==$argv[2])throw new Exception('redirect');
$c->close();echo 'ok';
`,
    );
    const { stdout } = await promisify(execFile)('php', [
      join(dir, 'native.php'),
      baseUrl,
      location,
    ]);
    assert.equal(stdout, 'ok');
    assert.equal(requests, 4);
    assert.equal(stolen, 0);
  } finally {
    server.closeAllConnections();
    destination.closeAllConnections();
    await Promise.all([
      new Promise((resolve) => server.close(resolve)),
      new Promise((resolve) => destination.close(resolve)),
    ]);
  }
});

test('buffered PDF reads honor cancellation and deadlines in both default transports', async () => {
  const { createServer } = await import('node:http');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const out = join(dir, 'deadlines');
  generate(loadContract(join(dir, 'api.json'), join(dir, 'sdk.json')), out);
  let closed = 0;
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/pdf' });
    response.write(Buffer.from([37, 80, 68, 70, 0, 255]));
    response.on('close', () => closed++);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const { Client } = await import(join(out, 'node/index.js'));
    const c = new Client({ baseUrl, allowInsecureHttp: true, maxAttempts: 1 });
    await assert.rejects(c.api.download({}, { deadlineMs: 50 }), { kind: 'deadline' });
    const controller = new AbortController();
    const pending = c.api.download({}, { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(pending, { kind: 'cancelled' });
    writeFileSync(
      join(dir, 'deadlines.php'),
      `<?php
require ${JSON.stringify(join(out, 'php/src/Runtime.php'))};
require ${JSON.stringify(join(out, 'php/src/Client.php'))};
use Example\\Media\\{Client,ClientOptions,RequestOptions,Cancellation,SdkError};
$c=new Client(new ClientOptions(baseUrl:$argv[1],allowInsecureHttp:true,maxAttempts:1));
try{$c->api->download(options:new RequestOptions(deadlineMs:50));throw new Exception('missing deadline');}
catch(SdkError $e){if($e->kind!=='deadline')throw $e;}
$cancel=new Cancellation();pcntl_async_signals(true);pcntl_signal(SIGALRM,fn()=>$cancel->cancel());pcntl_alarm(1);
try{$c->api->download(options:new RequestOptions(cancellation:$cancel));throw new Exception('missing cancellation');}
catch(SdkError $e){if($e->kind!=='cancelled')throw $e;}
finally{pcntl_alarm(0);$c->close();}
echo 'ok';
`,
    );
    assert.equal(
      (await promisify(execFile)('php', [join(dir, 'deadlines.php'), baseUrl])).stdout,
      'ok',
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(closed, 4);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
