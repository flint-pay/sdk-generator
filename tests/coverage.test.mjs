import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { inspect } from 'node:util';
import { loadContract, generate, compare, prepareRelease, publishSite } from '../dist/index.js';
import { compareSchemas } from '../dist/compatibility.js';
import { compareVersions, checkVersionPolicy } from '../dist/version.js';
import { validateFixtures } from '../dist/fixtures.js';

const directory = mkdtempSync(join(tmpdir(), 'sdk-coverage-'));
after(() => rmSync(directory, { recursive: true, force: true }));
const contract = loadContract('tests/fixtures/payment-api.json', 'tests/fixtures/payment-sdk.json');
contract.config.errors = {
  codePath: 'error.reason',
  detailsPath: 'error.fields',
  requestIdHeader: 'Trace-Id',
};
contract.config.documentation = {
  overview: 'Use authoritative resource state for recovery.',
  guides: {
    recovery: '# Recovering uncertain submissions\n\nPersist the operation key before submission.',
  },
};
const output = join(directory, 'sdk');
generate(contract, output);
const { Client } = await import(pathToFileURL(join(output, 'node/index.js')).href);

test('both clients reject malformed Unicode in HTTP JSON and authenticated webhook bodies', async () => {
  const invalidUtf8 = Buffer.concat([
    Buffer.from('{"id":"p","amount":1,"status":"pending","note":"'),
    Buffer.from([0xff]),
    Buffer.from('"}'),
  ]);
  const escapedSurrogate = Buffer.from('{"id":"p","amount":1,"status":"pending","note":"\\ud800"}');
  const bom = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from('{"id":"p","amount":1,"status":"pending"}'),
  ]);
  const malformed = [invalidUtf8, escapedSurrogate, bom];
  const timestamp = String(Math.floor(Date.now() / 1000));
  const fixtures = malformed.map((body) => ({
    body: body.toString('base64'),
    timestamp,
    signature: createHmac('sha256', 'fixture-secret')
      .update(Buffer.concat([Buffer.from(timestamp + '.'), body]))
      .digest('hex'),
  }));
  const client = new Client({ baseUrl: 'https://example.invalid', token: 'key' });
  for (let i = 0; i < malformed.length; i++) {
    const body = malformed[i],
      f = fixtures[i];
    const http = new Client({
      baseUrl: 'https://example.invalid',
      token: 'key',
      transport: async () => new Response(body, { headers: { 'Trace-Id': 'unicode-fixture' } }),
    });
    await assert.rejects(
      http.payments.retrieve({ id: 'p' }),
      (e) =>
        e.kind === 'protocol' && e.outcome === 'response' && e.meta.requestId === 'unicode-fixture',
    );
    assert.throws(
      () =>
        client.verifyWebhook(body, { 'X-Timestamp': timestamp, 'X-Signature': f.signature }, [
          'fixture-secret',
        ]),
      (e) => e.kind === 'protocol',
    );
  }
  const path = join(directory, 'malformed-unicode.json');
  writeFileSync(path, JSON.stringify(fixtures));
  const php = String.raw`require $argv[1].'/src/Runtime.php';require $argv[1].'/src/Client.php';$rows=[];foreach(json_decode(file_get_contents($argv[2]),true) as $f){$body=base64_decode($f['body']);$c=new Example\Payments\Client(new Example\Payments\ClientOptions('https://example.invalid',token:'key',transport:fn($r)=>['status'=>200,'headers'=>['Trace-Id'=>'unicode-fixture'],'body'=>$body]));try{$c->payments->retrieve(new Example\Payments\PaymentsRetrieveInput(['id'=>'p']));$rows[]='accepted';}catch(Example\Payments\SdkError $e){$rows[]=['kind'=>$e->kind,'outcome'=>$e->outcome,'requestId'=>$e->meta['requestId']??null];}try{$c->verifyWebhook($body,['X-Timestamp'=>$f['timestamp'],'X-Signature'=>$f['signature']],['fixture-secret']);$rows[]='accepted';}catch(Example\Payments\SdkError $e){$rows[]=$e->kind;}$c->close();}echo json_encode($rows);`;
  const result = spawnSync('php', ['-r', php, join(output, 'php'), path], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    JSON.parse(result.stdout),
    fixtures.flatMap(() => [
      { kind: 'protocol', outcome: 'response', requestId: 'unicode-fixture' },
      'protocol',
    ]),
  );
  const valid = Buffer.from('{"id":"p","amount":1,"status":"pending","note":"😀 café"}');
  const validClient = new Client({
    baseUrl: 'https://example.invalid',
    token: 'key',
    transport: async () => new Response(valid),
  });
  assert.equal((await validClient.payments.retrieve({ id: 'p' })).data.note, '😀 café');
});

test('shared HTTP expectations exercise both generated public clients', async () => {
  const baseline = join(directory, 'baseline');
  generate(
    loadContract('tests/fixtures/payment-api.json', 'tests/fixtures/payment-sdk.json'),
    baseline,
  );
  const result = await validateFixtures(baseline, 'tests/fixtures/http-cases.json');
  assert.deepEqual(
    result.map((r) => r.target),
    ['node', 'php'],
  );
  assert.ok(result.every((r) => r.scenarios >= 19));
});

test('schema compatibility distinguishes caller requirements from result guarantees', () => {
  const initial = {
    type: 'object',
    properties: { title: { type: 'string' } },
    required: [],
    additionalProperties: false,
  };
  const required = { ...initial, required: ['title'] };
  assert.ok(
    compareSchemas(initial, required, 'call', 'input').some(
      (c) => c.severity === 'breaking' && c.subject === 'call.title',
    ),
  );
  assert.ok(
    compareSchemas(required, initial, 'call', 'response').some((c) => c.severity === 'breaking'),
  );
  assert.ok(
    compareSchemas(required, initial, 'call', 'input').every((c) => c.severity === 'additive'),
  );
  const nullable = { ...required, properties: { title: { type: ['string', 'null'] } } };
  assert.ok(
    compareSchemas(required, nullable, 'call', 'input').every((c) => c.severity === 'additive'),
  );
  assert.ok(
    compareSchemas(required, nullable, 'call', 'response').some((c) => c.severity === 'breaking'),
  );
  const next = structuredClone(contract);
  next.operations.find((o) => o.id === 'getPayment').parameters[0].style = 'label';
  assert.ok(compare(contract, next).some((c) => c.message.includes('encoding')));
});

test('release policy and compatibility retain changes made before a version bump', () => {
  assert.equal(compareVersions('1.0.0', '1.0.0-rc.1'), 1);
  assert.equal(compareVersions('1.0.0-beta.10', '1.0.0-beta.2'), 1);
  const breaking = [{ severity: 'breaking', subject: 'field', message: 'Removed' }];
  assert.throws(() => checkVersionPolicy('1.0.0', '1.0.1', breaking), /major/);
  checkVersionPolicy('1.0.0', '2.0.0', breaking);
  checkVersionPolicy('0.1.0', '0.2.0', breaking);
  const baseline = structuredClone(contract);
  baseline.config.version = '1.0.0';
  const path = join(directory, 'draft-history');
  generate(baseline, path);
  const draft = structuredClone(baseline);
  draft.operations.find((op) => op.id === 'getPayment').path = '/new/{id}';
  generate(draft, path);
  draft.config.version = '1.0.1';
  draft.config.release = { policy: 'semver' };
  generate(draft, path);
  assert.throws(() => prepareRelease(path, join(directory, 'invalid-version-release')), /major/);
  const record = JSON.parse(readFileSync(join(path, '.sdk-generator.json')));
  assert.ok(record.compatibility.some((c) => c.message.includes('HTTP destination')));
  const restored = structuredClone(baseline);
  restored.config.version = '1.0.1';
  generate(restored, path);
  assert.equal(
    JSON.parse(readFileSync(join(path, '.sdk-generator.json'))).compatibility.some((c) =>
      c.message.includes('HTTP destination'),
    ),
    false,
  );
});

test('pagination item types compile as declared models and reject invalid consumer assumptions', () => {
  const path = join(output, 'node', 'consumer.ts');
  writeFileSync(
    path,
    `import { Client, makeCreatePayment } from './index.js';
const client = new Client({baseUrl: 'https://example.invalid'});
const body = makeCreatePayment({amount: '100', currency: 'USD', reference: 'order'});
client.payments.create({body}, {idempotencyKey: 'key'});
for await (const item of client.payments.listAllItems()) {
  const id: string = item.id;
  const amount: string = item.amount;
  // @ts-expect-error Exact monetary values are not JavaScript numbers.
  const unsafe: number = item.amount;
}
`,
  );
  const result = spawnSync(
    process.execPath,
    [
      resolve('node_modules/typescript/bin/tsc'),
      '--noEmit',
      '--strict',
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--types',
      'node',
      '--typeRoots',
      resolve('node_modules/@types'),
      path,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('configured error metadata and diagnostics include failed attempts without exposing bodies', async () => {
  const events = [];
  let attempt = 0;
  const client = new Client({
    baseUrl: 'https://example.invalid',
    token: 'secret',
    diagnostics: (e) => events.push(e),
    transport: async () => {
      if (!attempt++) throw new Error('lost response secret');
      return new Response('{"error":{"reason":"bad_input","fields":{"title":"required"}}}', {
        status: 422,
        headers: { 'Trace-Id': 'trace-123' },
      });
    },
  });
  await assert.rejects(client.payments.retrieve({ id: 'p' }), (error) => {
    assert.equal(error.code, 'bad_input');
    assert.equal(error.meta.requestId, 'trace-123');
    assert.deepEqual(error.details, { title: 'required' });
    assert.match(error.raw, /bad_input/);
    return true;
  });
  assert.deepEqual(
    events.map((e) => e.errorKind),
    ['transport', 'validation'],
  );
  assert.equal(JSON.stringify(events).includes('secret'), false);
  assert.equal(JSON.stringify(events).includes('required'), false);
});

test('provider narrative is versioned in both generated packages', () => {
  for (const target of ['node', 'php']) {
    assert.match(
      readFileSync(join(output, target, 'README.md'), 'utf8'),
      /authoritative resource state/,
    );
    assert.match(readFileSync(join(output, target, 'guides/recovery.md'), 'utf8'), /Package 0.1.0/);
  }
});

test('relative pagination preserves the requested resource path in Node and PHP', async () => {
  const urls = [];
  const client = new Client({
    baseUrl: 'https://example.invalid/v1',
    token: 'key',
    transport: async (url) => {
      urls.push(url.pathname + url.search);
      return Response.json({
        items: [{ id: 'p', amount: 1, status: 'pending' }],
        next: urls.length === 1 ? '?page=2' : null,
      });
    },
  });
  for await (const _ of client.payments.linksItems()) {
    /* Consume both pages. */
  }
  assert.deepEqual(urls, ['/v1/links', '/v1/links?page=2']);
  const php = `require $argv[1].'/src/Runtime.php';require $argv[1].'/src/Client.php';$urls=[];$client=new Example\\Payments\\Client(new Example\\Payments\\ClientOptions('https://example.invalid/v1',token:'key',transport:function($r)use(&$urls){$urls[]=$r['url'];return ['status'=>200,'headers'=>[],'body'=>json_encode(['items'=>[['id'=>'p','amount'=>1,'status'=>'pending']],'next'=>count($urls)===1?'?page=2':null])];}));foreach($client->payments->linksItems(new Example\\Payments\\PaymentsLinksInput()) as $item){} echo json_encode($urls);`;
  const result = spawnSync('php', ['-r', php, join(output, 'php')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [
    'https://example.invalid/v1/links',
    'https://example.invalid/v1/links?page=2',
  ]);
});

test('additional consumer redaction applies to response model inspection in both targets', async () => {
  const body = '{"id":"private-id","amount":1,"status":"pending"}';
  const client = new Client({
    baseUrl: 'https://example.invalid',
    token: 'key',
    redactFields: ['id'],
    transport: async () => new Response(body),
  });
  const result = await client.payments.retrieve({ id: 'p' });
  assert.equal(result.data.id, 'private-id');
  assert.equal(inspect(result).includes('private-id'), false);
  assert.equal(inspect(result.data).includes('private-id'), false);
  const php = `require $argv[1].'/src/Runtime.php';require $argv[1].'/src/Client.php';$client=new Example\\Payments\\Client(new Example\\Payments\\ClientOptions('https://example.invalid',token:'key',redactFields:['id'],transport:fn($r)=>['status'=>200,'headers'=>[],'body'=>$argv[2]]));$result=$client->payments->retrieve(new Example\\Payments\\PaymentsRetrieveInput(['id'=>'p']));var_dump($result->data);`;
  const printed = spawnSync('php', ['-r', php, join(output, 'php'), body], { encoding: 'utf8' });
  assert.equal(printed.status, 0, printed.stderr);
  assert.equal(printed.stdout.includes('private-id'), false);
});

test('cancellation before dispatch is not sent and ignored transport aborts still respect Node deadlines', async () => {
  let calls = 0;
  const client = new Client({
    baseUrl: 'https://example.invalid',
    token: 'key',
    transport: () => {
      calls++;
      return new Promise(() => {});
    },
  });
  await assert.rejects(
    client.payments.retrieve({ id: 'p' }, { signal: AbortSignal.abort() }),
    (e) => e.kind === 'cancelled' && e.outcome === 'not_sent',
  );
  assert.equal(calls, 0);
  const start = performance.now();
  await assert.rejects(
    client.payments.retrieve({ id: 'p' }, { timeoutMs: 20, deadlineMs: 30, maxAttempts: 1 }),
    (e) => ['transport', 'deadline'].includes(e.kind),
  );
  assert.ok(performance.now() - start < 500);
});

test('body transport failures preserve received request IDs in both native clients', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Trace-Id': 'partial-response-id', 'Content-Length': '1000' });
    response.write('{');
    setTimeout(() => response.destroy(), 30);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const events = [];
    const client = new Client({
      baseUrl: base,
      allowInsecureHttp: true,
      token: 'key',
      diagnostics: (event) => events.push(event),
    });
    await assert.rejects(
      client.payments.retrieve({ id: 'p' }, { maxAttempts: 1 }),
      (e) =>
        e.kind === 'transport' &&
        e.outcome === 'unknown' &&
        e.meta?.requestId === 'partial-response-id',
    );
    assert.equal(events[0].requestId, 'partial-response-id');
    const script = `require $argv[1].'/src/Runtime.php'; require $argv[1].'/src/Client.php'; $events=[]; $client=new Example\\Payments\\Client(new Example\\Payments\\ClientOptions($argv[2],token:'key',allowInsecureHttp:true,diagnostics:function($e)use(&$events){$events[]=$e;})); try{$client->payments->retrieve(new Example\\Payments\\PaymentsRetrieveInput(['id'=>'p']),new Example\\Payments\\RequestOptions(maxAttempts:1));exit(1);}catch(Example\\Payments\\SdkError $e){echo json_encode([$e->kind,$e->outcome,$e->meta['requestId']??null,$events[0]['requestId']??null]);}`;
    const child = spawn('php', ['-r', script, join(output, 'php'), base]);
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (b) => (stdout += b));
    child.stderr.on('data', (b) => (stderr += b));
    assert.equal(await new Promise((resolve) => child.on('close', resolve)), 0, stderr);
    assert.deepEqual(JSON.parse(stdout), [
      'transport',
      'unknown',
      'partial-response-id',
      'partial-response-id',
    ]);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('both native clients identify their package and permit User-Agent overrides', async () => {
  const received = [];
  const server = createServer((request, response) => {
    received.push(request.headers['user-agent']);
    if (!request.headers['user-agent']) {
      response.writeHead(403);
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"id":"p","amount":1,"status":"pending"}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const client = new Client({ baseUrl: base, allowInsecureHttp: true, token: 'test' });
    await client.payments.retrieve({ id: 'p' });
    await client.payments.retrieve({ id: 'p' }, { headers: { 'User-Agent': 'Consumer/1.0' } });
    const script = `require $argv[1].'/src/Runtime.php';require $argv[1].'/src/Client.php';$client=new Example\\Payments\\Client(new Example\\Payments\\ClientOptions($argv[2],token:'test',allowInsecureHttp:true));$client->payments->retrieve(new Example\\Payments\\PaymentsRetrieveInput(['id'=>'p']));$client->payments->retrieve(new Example\\Payments\\PaymentsRetrieveInput(['id'=>'p']),new Example\\Payments\\RequestOptions(headers:['User-Agent'=>'Consumer/1.0']));$client->close();`;
    const child = spawn('php', ['-r', script, join(output, 'php'), base]);
    let stderr = '';
    child.stderr.on('data', (b) => (stderr += b));
    assert.equal(await new Promise((resolve) => child.on('close', resolve)), 0, stderr);
    assert.deepEqual(received, [
      `${contract.config.npm.name.replace(/^@/, '').replaceAll('/', '-')}/${contract.config.version} (Node.js)`,
      'Consumer/1.0',
      `${contract.config.composer.name.replaceAll('/', '-')}/${contract.config.version} (PHP)`,
      'Consumer/1.0',
    ]);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('unsupported prereleases and malformed new configuration fail during diagnosis', () => {
  const path = join(directory, 'invalid-config.json');
  for (const change of [
    { version: '1.0.0-preview.1' },
    { version: '01.0.0' },
    { errors: false },
    { documentation: { guides: { '../escape': 'bad' } } },
    { release: { baseUrl: 'https://user:secret@example.invalid/' } },
  ]) {
    writeFileSync(path, JSON.stringify({ ...contract.config, ...change }));
    assert.throws(() => loadContract('tests/fixtures/payment-api.json', path), /config/);
  }
});

test('model dependencies exclude structurally identical unreferenced private models', () => {
  const api = JSON.parse(readFileSync('examples/library.openapi.json'));
  const config = JSON.parse(readFileSync('examples/library.sdk.json'));
  const response = api.paths['/books/{id}'].get.responses['200'].content['application/json'];
  api.components = { schemas: { Book: response.schema } };
  response.schema = { $ref: '#/components/schemas/Book' };
  const [name, schema] = Object.entries(api.components.schemas)[0];
  api.components.schemas.PrivateDuplicate = structuredClone(schema);
  const definition = join(directory, 'model-dependencies.json'),
    configuration = join(directory, 'model-dependencies-sdk.json');
  writeFileSync(definition, JSON.stringify(api));
  writeFileSync(configuration, JSON.stringify(config));
  const selected = loadContract(definition, configuration);
  const output = join(directory, 'model-dependencies');
  generate(selected, output);
  assert.equal(
    readFileSync(join(output, 'node/index.d.ts'), 'utf8').includes('PrivateDuplicate'),
    false,
  );
  assert.equal(
    readFileSync(join(output, 'php/src/Client.php'), 'utf8').includes('PrivateDuplicate'),
    false,
  );
  assert.ok(Object.values(selected.modelDependencies).some((names) => names.includes(name)));
});

test('webhook worker rolls back, reconciles old events, deduplicates effects and resumes delivery', async () => {
  const { openInbox, receiveWebhook, processInbox, enqueueEffect, deliverOutbox } = await import(
    pathToFileURL(join(output, 'node/examples/webhook-inbox.mjs')).href
  );
  const client = new Client({ baseUrl: 'https://example.invalid' });
  const path = join(directory, 'workflow.sqlite');
  let db = openInbox(path);
  function receive(id, status = 'pending', type = 'payment.updated') {
    const body = Buffer.from(JSON.stringify({ id, type, data: { id: 'p', amount: 100, status } }));
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', 'key')
      .update(timestamp + '.')
      .update(body)
      .digest('hex');
    return receiveWebhook(
      client,
      db,
      body,
      { 'x-timestamp': timestamp, 'x-signature': signature },
      ['key'],
      (e) => e.id,
    );
  }
  receive('evt-new', 'succeeded');
  receive('evt-old', 'pending'); // Out of order, but current API state remains succeeded.
  receive('evt-unknown', 'pending', 'future.event');
  const loadCurrent = async () => ({ orderId: 'order-1', status: 'succeeded' });
  const apply = (transaction, event, current) => {
    if (current.status === 'succeeded')
      enqueueEffect(transaction, `fulfill:${current.orderId}`, { orderId: current.orderId });
  };
  await assert.rejects(
    processInbox(db, {
      loadCurrent,
      apply: (...args) => {
        apply(...args);
        throw new Error('worker crashed');
      },
    }),
    /worker crashed/,
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n, 0);
  assert.equal(db.prepare('SELECT SUM(processed) AS n FROM inbox').get().n, 0);
  assert.equal(await processInbox(db, { loadCurrent, apply }), true);
  assert.equal(await processInbox(db, { loadCurrent, apply }), true);
  assert.equal(await processInbox(db, { loadCurrent, apply }), false); // Unknown remains pending.
  assert.equal(receive('evt-new').queued, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n, 1);
  const fulfilled = new Set();
  const identities = [];
  const send = async (key) => {
    identities.push(key);
    fulfilled.add(key);
  };
  await assert.rejects(
    deliverOutbox(db, async (key) => {
      await send(key);
      throw new Error('ack lost');
    }),
    /ack lost/,
  );
  db.close();
  db = openInbox(path);
  assert.equal(await deliverOutbox(db, send), true);
  assert.equal(await deliverOutbox(db, send), false);
  assert.equal(fulfilled.size, 1);
  assert.deepEqual(identities, ['fulfill:order-1', 'fulfill:order-1']);
  db.close();
});

test('PHP public client and durable worker cover error mapping, rollback and duplicate effects', () => {
  const result = spawnSync(
    'php',
    ['tests/php-workflow.php', join(output, 'php'), join(directory, 'php-workflow.sqlite')],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(result.stdout, 'ok');
});

test('coordinated site publishes versioned docs and an installable Composer repository', async () => {
  const site = join(directory, 'published-site');
  const server = createServer((request, response) => {
    try {
      const path = new URL(request.url, 'http://localhost').pathname;
      if (path.includes('..')) throw new Error('Invalid path');
      const body = readFileSync(join(site, path));
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const baseUrl = `http://127.0.0.1:${server.address().port}/`;
  try {
    const definition = structuredClone(contract);
    definition.config.release = { baseUrl };
    const generated = join(directory, 'distributed-sdk');
    generate(definition, generated);
    mkdirSync(join(generated, 'node/custom'));
    writeFileSync(
      join(generated, 'node/custom/recovery.js'),
      'export const recover = (client, id) => client.payments.retrieve({ id });\n',
    );
    writeFileSync(
      join(generated, 'php/custom/Recovery.php'),
      '<?php namespace Example\\Payments\\Custom; class Recovery { public static function retrieve(\\Example\\Payments\\Client $client, string $id): \\Example\\Payments\\Result { return $client->payments->retrieve(new \\Example\\Payments\\PaymentsRetrieveInput(["id" => $id])); } }',
    );
    generate(definition, generated); // Handwritten helpers survive a second generation.
    writeFileSync(
      join(generated, 'node/private-neighbor.js'),
      'const privateApiDefinition = "not-for-distribution";',
    );
    const release = join(directory, 'release');
    const plan = prepareRelease(generated, release);
    assert.ok(plan.checksums['site/versions/0.1.0/node/guides/recovery.md']);
    const tarball = Object.keys(plan.checksums).find((p) => p.endsWith('.tgz') && !p.includes('/'));
    assert.equal(
      spawnSync('tar', ['-tzf', join(release, tarball)], { encoding: 'utf8' }).stdout.includes(
        'private-neighbor',
      ),
      false,
    );
    assert.throws(() => publishSite(release, site, 'wrong'), /confirm/);
    assert.equal(publishSite(release, site, '0.1.0').sitePublished, true);
    assert.equal(publishSite(release, site, '0.1.0').sitePublished, true);
    for (const path of Object.keys(plan.checksums).filter(
      (p) => p.startsWith('site/') && p.endsWith('.html'),
    )) {
      const source = readFileSync(join(release, path), 'utf8');
      for (const match of source.matchAll(/href="([^"]+)"/g)) {
        const url = new URL(match[1], baseUrl + path.slice(5));
        if (url.origin === new URL(baseUrl).origin)
          assert.equal((await fetch(url)).status, 200, `Broken documentation link: ${url}`);
      }
    }
    assert.equal(
      Object.keys(plan.checksums).some((p) => p.startsWith('site/') && p.endsWith('.php')),
      false,
    );
    const consumer = join(directory, 'composer-site-consumer');
    mkdirSync(consumer);
    writeFileSync(join(consumer, 'package.json'), '{"private":true,"type":"module"}');
    const npmInstall = spawnSync(
      'npm',
      ['install', '--ignore-scripts', '--no-audit', '--no-fund', join(release, tarball)],
      { cwd: consumer, encoding: 'utf8' },
    );
    assert.equal(npmInstall.status, 0, npmInstall.stderr);
    const nodeHelper = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import {Client} from '@example/payments'; import {recover} from '@example/payments/custom/recovery.js'; const client = new Client({baseUrl:'https://example.invalid',token:'test',transport:async()=>Response.json({id:'p',amount:1,status:'pending'})}); if ((await recover(client,'p')).data.id !== 'p') process.exit(1);`,
      ],
      { cwd: consumer, encoding: 'utf8' },
    );
    assert.equal(nodeHelper.status, 0, nodeHelper.stderr);
    writeFileSync(
      join(consumer, 'composer.json'),
      JSON.stringify({
        name: 'test/consumer',
        require: { 'example/payments': '0.1.0' },
        repositories: [{ type: 'composer', url: baseUrl }, { 'packagist.org': false }],
        config: { 'secure-http': false },
      }),
    );
    const install = await new Promise((done, reject) => {
      const child = spawn(
        'composer',
        ['install', '--no-interaction', '--no-plugins', '--no-scripts'],
        {
          cwd: consumer,
          env: { ...process.env, COMPOSER_CACHE_DIR: join(directory, 'composer-cache') },
        },
      );
      let log = '';
      child.stdout.on('data', (b) => (log += b));
      child.stderr.on('data', (b) => (log += b));
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(log + '\nComposer timed out'));
      }, 30000);
      child.on('error', reject);
      child.on('close', (status) => {
        clearTimeout(timer);
        done({ status, log });
      });
    });
    assert.equal(install.status, 0, install.log);
    const call = spawnSync(
      'php',
      [
        '-r',
        `require $argv[1]; $client = new Example\\Payments\\Client(new Example\\Payments\\ClientOptions('https://example.invalid')); echo get_class($client->payments);`,
        join(consumer, 'vendor/autoload.php'),
      ],
      { encoding: 'utf8' },
    );
    assert.equal(call.status, 0, call.stderr);
    assert.equal(call.stdout, 'Example\\Payments\\PaymentsResource');
    const phpHelper = spawnSync(
      'php',
      [
        '-r',
        `require $argv[1]; $client = new Example\\Payments\\Client(new Example\\Payments\\ClientOptions('https://example.invalid',token:'test',transport:fn($r)=>['status'=>200,'headers'=>[],'body'=>'{"id":"p","amount":1,"status":"pending"}'])); echo Example\\Payments\\Custom\\Recovery::retrieve($client,'p')->data->getId();`,
        join(consumer, 'vendor/autoload.php'),
      ],
      { encoding: 'utf8' },
    );
    assert.equal(phpHelper.status, 0, phpHelper.stderr);
    assert.equal(phpHelper.stdout, 'p');
    assert.match(
      await (await fetch(baseUrl + 'versions/0.1.0/node/guides/recovery.md.html')).text(),
      /Recovering uncertain submissions/,
    );
    definition.config.version = '0.2.0-beta.1';
    generate(definition, generated);
    const nextRelease = join(directory, 'next-release');
    prepareRelease(generated, nextRelease);
    publishSite(nextRelease, site, definition.config.version);
    const packages = JSON.parse(readFileSync(join(site, 'packages.json'))).packages[
      'example/payments'
    ];
    assert.deepEqual(Object.keys(packages).sort(), ['0.1.0', '0.2.0-beta.1']);
    writeFileSync(join(nextRelease, 'site/versions/0.2.0-beta.1/CHANGELOG.md'), 'tampered');
    assert.throws(
      () => publishSite(nextRelease, site, definition.config.version),
      /changed after review/,
    );
  } finally {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
});

test('generated webhook verifiers match the local Flint Go signing implementation', async () => {
  const vector = JSON.parse(readFileSync('tests/providers/flint/signing-vector.json')).webhook;
  for (const format of ['standard-webhooks', 'timestamped-hex']) {
    const config = structuredClone(contract.config);
    config.webhook = {
      algorithm: 'hmac-sha256',
      format,
      separator: '.',
      toleranceSeconds: 300,
      typeField: 'type',
      events: {},
      ...(format === 'standard-webhooks'
        ? {
            header: 'webhook-signature',
            timestampHeader: 'webhook-timestamp',
            idHeader: 'webhook-id',
          }
        : { header: 'X-Flint-Signature' }),
    };
    const configPath = join(directory, `${format}.json`);
    writeFileSync(configPath, JSON.stringify(config));
    const path = join(directory, format);
    generate(loadContract('tests/fixtures/payment-api.json', configPath), path);
    const { Client: GeneratedClient } = await import(
      pathToFileURL(join(path, 'node/index.js')).href
    );
    const client = new GeneratedClient({ baseUrl: 'https://example.invalid' });
    const headers =
      format === 'standard-webhooks'
        ? {
            'Webhook-Id': vector.eventId,
            'Webhook-Timestamp': String(vector.timestamp),
            'Webhook-Signature': 'v1,bad ' + vector.standard,
          }
        : { 'X-Flint-Signature': vector.legacy + ',v1=bad' };
    const cases = [
      { headers, body: vector.body, secrets: [vector.secret], now: vector.timestamp, valid: true },
      {
        headers,
        body: vector.body,
        secrets: ['whsec_wrong', vector.secret],
        now: vector.timestamp,
        valid: true,
      },
      {
        headers,
        body: vector.body + ' ',
        secrets: [vector.secret],
        now: vector.timestamp,
        valid: false,
      },
      {
        headers,
        body: vector.body,
        secrets: [vector.secret],
        now: vector.timestamp + 301,
        valid: false,
      },
      {
        headers,
        body: vector.body,
        secrets: [vector.secret],
        now: vector.timestamp - 301,
        valid: false,
      },
      { headers, body: vector.body, secrets: ['whsec_YQ=='], now: vector.timestamp, valid: false },
      {
        headers: {},
        body: vector.body,
        secrets: [vector.secret],
        now: vector.timestamp,
        valid: false,
      },
    ];
    if (format === 'standard-webhooks')
      cases.push({ ...cases[0], headers: { ...headers, 'Webhook-Id': 'different' }, valid: false });
    else
      cases.push({
        ...cases[0],
        headers: { 'X-Flint-Signature': vector.legacy + ',t=1700000000' },
        valid: false,
      });
    for (const c of cases) {
      const verify = () => client.verifyWebhook(Buffer.from(c.body), c.headers, c.secrets, c.now);
      if (c.valid) assert.deepEqual(verify(), { event: JSON.parse(vector.body), known: false });
      else assert.throws(verify, (e) => e.kind === 'authentication');
    }
    const php = `require $argv[1].'/src/Runtime.php'; require $argv[1].'/src/Client.php'; $client=new Example\\Payments\\Client(new Example\\Payments\\ClientOptions('https://example.invalid')); $results=[]; foreach(json_decode($argv[2],true) as $c){try{$r=$client->verifyWebhook($c['body'],$c['headers'],$c['secrets'],$c['now']);$results[]=$r['known']===false;}catch(Example\\Payments\\SdkError $e){if($e->kind!=='authentication')throw $e;$results[]=false;}}echo json_encode($results);`;
    const result = spawnSync('php', ['-r', php, join(path, 'php'), JSON.stringify(cases)], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      JSON.parse(result.stdout),
      cases.map((c) => c.valid),
    );
  }
});

test('code-specific idempotency retries preserve the key and never retry other conflicts', async () => {
  const config = structuredClone(contract.config);
  config.errors = { codePath: 'error.code' };
  config.operations.createPayment.retry.errors = [
    { status: 409, codes: ['IDEMPOTENCY_KEY_IN_PROGRESS'] },
  ];
  const configPath = join(directory, 'retry-codes.json');
  writeFileSync(configPath, JSON.stringify(config));
  const path = join(directory, 'retry-codes');
  generate(loadContract('tests/fixtures/payment-api.json', configPath), path);
  const baseline = JSON.parse(readFileSync('tests/fixtures/http-cases.json'))[0];
  const success = baseline.responses[0];
  const cases = [
    {
      ...baseline,
      name: 'same-key in-progress then original result',
      attempts: 2,
      responses: [
        { status: 409, body: '{"error":{"code":"IDEMPOTENCY_KEY_IN_PROGRESS"}}' },
        success,
      ],
    },
    ...['IDEMPOTENCY_KEY_REUSED', 'VERSION_CONFLICT', 'FUTURE_CONFLICT'].map((code) => {
      const c = {
        ...baseline,
        name: code,
        responses: [{ status: 409, body: JSON.stringify({ error: { code } }) }],
        error: { kind: 'conflict', code, retryAllowed: false },
        attempts: 1,
      };
      delete c.data;
      return c;
    }),
  ];
  const fixtures = join(directory, 'retry-code-cases.json');
  writeFileSync(fixtures, JSON.stringify(cases));
  assert.deepEqual(
    (await validateFixtures(path, fixtures)).map((r) => r.scenarios),
    [4, 4],
  );
  for (const change of [
    { errors: [{ status: 412, codes: ['IDEMPOTENCY_KEY_IN_PROGRESS'] }] },
    { statuses: [409] },
    { errors: [{ status: 409, codes: [] }] },
  ]) {
    const invalid = structuredClone(config);
    Object.assign(invalid.operations.createPayment.retry, change);
    writeFileSync(configPath, JSON.stringify(invalid));
    assert.throws(() => loadContract('tests/fixtures/payment-api.json', configPath));
  }
  config.operations.createPayment.conditional = { header: 'If-Match' };
  writeFileSync(configPath, JSON.stringify(config));
  assert.throws(() => loadContract('tests/fixtures/payment-api.json', configPath), /conditional/);
});
