import { localExampleFile } from './local-example.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createHmac, createHash } from 'node:crypto';
import { inspect } from 'node:util';
import { createServer } from 'node:http';
import {
  loadContract,
  generate,
  preview,
  compare,
  validate,
  prepareRelease,
  publishRelease,
  render,
} from '../dist/index.js';
import { Runtime, serialize, parseExact, Model, SdkError } from '../dist/runtime.js';
const fixture = (name) => resolve('tests/fixtures/' + name);
const contract = loadContract(fixture('payment-api.json'), fixture('payment-sdk.json'));
const runtimeContract = {
  operations: contract.operations,
  auth: contract.auth,
  apiVersion: contract.config.apiVersion,
  webhook: contract.config.webhook,
  money: contract.config.money,
};
const temporary = mkdtempSync(join(tmpdir(), 'sdk-generator-test-'));
const output = join(temporary, 'sdk');
const runtimeFile = join(temporary, 'runtime.json');
writeFileSync(runtimeFile, JSON.stringify(runtimeContract));
before(() => generate(contract, output));
after(() => rmSync(temporary, { recursive: true, force: true }));
const cases = JSON.parse(readFileSync(fixture('http-cases.json'), 'utf8'));
for (const scenario of cases)
  test('Node HTTP fixture: ' + scenario.name, async () => {
    let attempts = 0;
    const runtime = new Runtime(runtimeContract, {
      baseUrl: 'https://api.example.invalid/v1',
      token: 'test-token',
      transport: async (url, init) => {
        const expected = scenario.expected;
        assert.equal(init.method, expected.method);
        assert.equal(url.pathname + url.search, expected.path);
        if (expected.body !== undefined) assert.equal(init.body, expected.body);
        for (const [k, v] of Object.entries(expected.headers ?? {}))
          assert.equal(init.headers[k], v);
        const response = scenario.responses[attempts++];
        assert.ok(response, 'unexpected extra attempt');
        if (response.transportError) throw new Error('Response lost');
        return new Response([204, 304].includes(response.status) ? null : response.body, {
          status: response.status,
          headers: response.headers,
        });
      },
    });
    if (scenario.error)
      await assert.rejects(
        runtime.request(scenario.operation, scenario.input, scenario.options),
        (error) => {
          for (const [k, v] of Object.entries(scenario.error))
            assert.equal(['status', 'requestId'].includes(k) ? error.meta?.[k] : error[k], v, k);
          return true;
        },
      );
    else {
      const result = await runtime.request(scenario.operation, scenario.input, scenario.options);
      if (scenario.data) assert.deepEqual(JSON.parse(JSON.stringify(result.data)), scenario.data);
      if (scenario.empty) assert.equal(result.data, undefined);
    }
    assert.equal(attempts, scenario.attempts ?? 1);
  });
test('PHP passes the same HTTP fixtures and native capability checks', () => {
  const r = spawnSync(
    'php',
    ['tests/php-contract.php', join(output, 'php'), runtimeFile, fixture('http-cases.json')],
    { encoding: 'utf8' },
  );
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(JSON.parse(r.stdout).length, cases.length);
});
test('generation is deterministic and preview never writes', () => {
  const missing = join(temporary, 'no-write');
  const p = generate(contract, missing, true);
  assert.ok(p.changes.length);
  assert.equal(existsSync(missing), false);
  const record = readFileSync(join(output, '.sdk-generator.json'), 'utf8');
  assert.deepEqual(preview(contract, output).changes, []);
  generate(contract, output);
  assert.equal(readFileSync(join(output, '.sdk-generator.json'), 'utf8'), record);
});
test('regeneration removes only owned files and preserves custom helpers', () => {
  const out = join(temporary, 'custom');
  generate(contract, out);
  mkdirSync(join(out, 'node/custom'));
  writeFileSync(join(out, 'node/custom/helper.js'), 'export const helper = 42;\n');
  const next = structuredClone(contract);
  next.operations = next.operations.filter((o) => o.id !== 'updatePayment');
  const changes = generate(next, out).changes;
  assert.ok(changes.some((c) => c.kind === 'removed' && c.path.includes('update')));
  assert.ok(existsSync(join(out, 'node/custom/helper.js')));
  assert.throws(() => {
    writeFileSync(join(out, 'node/index.js'), 'manual edit');
    generate(next, out);
  }, /generated file was edited/);
  assert.equal(readFileSync(join(out, 'node/index.js'), 'utf8'), 'manual edit');
});
test('ownership records cannot traverse paths or follow symlinks', () => {
  const out = join(temporary, 'unsafe');
  generate(contract, out);
  const record = JSON.parse(readFileSync(join(out, '.sdk-generator.json')));
  record.files['../victim'] = 'bad';
  writeFileSync(join(out, '.sdk-generator.json'), JSON.stringify(record));
  assert.throws(() => preview(contract, out), /invalid owned file/);
  const sym = join(temporary, 'symbolic');
  mkdirSync(sym);
  symlinkSync(output, join(sym, 'neighbor'));
  assert.throws(() => generate(contract, sym), /symlinks/);
});
test('diagnostics identify unsupported constructs, stale overrides and naming conflicts', () => {
  function invalid(change, expected, configChange = () => {}) {
    const api = JSON.parse(readFileSync(fixture('payment-api.json')));
    const config = JSON.parse(readFileSync(fixture('payment-sdk.json')));
    change(api);
    configChange(config);
    const folder = mkdtempSync(join(temporary, 'bad-'));
    writeFileSync(join(folder, 'api.json'), JSON.stringify(api));
    writeFileSync(join(folder, 'sdk.json'), JSON.stringify(config));
    assert.throws(() => loadContract(join(folder, 'api.json'), join(folder, 'sdk.json')), expected);
  }
  invalid(
    (a) =>
      (a.components.schemas.Payment.properties.id = {
        anyOf: [],
      }),
    /anyOf/,
  );
  invalid((a) => (a.paths['/payments'].get.parameters[0].style = 'deepObject'), /style/);
  invalid(
    (a) =>
      (a.components.schemas.Payment.properties.id = { $ref: 'https://example.invalid/api.json' }),
    /vendored/,
  );
  invalid(
    (a) => {},
    /stale operation/,
    (c) => (c.operations.missing = { method: 'gone' }),
  );
  invalid(
    (a) => {},
    /collision/,
    (c) => (c.operations.getPayment.method = 'create'),
  );
  invalid(
    (a) => {},
    /reserved/,
    (c) => (c.operations.getPayment.method = 'constructor'),
  );
  invalid(
    (a) => {},
    /idempotency contract/,
    (c) => delete c.operations.createPayment.idempotency,
  );
  invalid(
    (a) => {},
    /unsupported setting/,
    (c) => (c.stripNulls = true),
  );
  invalid(
    (a) => {},
    /auto must be boolean/,
    (c) => (c.operations.createPayment.idempotency.auto = 'false'),
  );
  invalid(
    (a) => {},
    /declared array/,
    (c) => (c.operations.listPayments.pagination.items = 'missing'),
  );
  invalid(
    (a) => {},
    /declared string/,
    (c) => (c.operations.getPayment.polling.state = 'missing'),
  );
});
test('local references and semantic overrides affect both targets', () => {
  const dir = mkdtempSync(join(temporary, 'override-'));
  const api = JSON.parse(readFileSync(fixture('payment-api.json')));
  const config = JSON.parse(readFileSync(fixture('payment-sdk.json')));
  writeFileSync(join(dir, 'types.json'), JSON.stringify({ type: 'string' }));
  api.components.schemas.Payment.properties.id = { $ref: './types.json' };
  config.overrides = {
    '/components/schemas/CreatePayment/properties/description': { type: 'string' },
  };
  writeFileSync(join(dir, 'api.json'), JSON.stringify(api));
  writeFileSync(join(dir, 'sdk.json'), JSON.stringify(config));
  const c = loadContract(join(dir, 'api.json'), join(dir, 'sdk.json'));
  assert.ok(c.sources['types.json']);
  const op = c.operations.find((o) => o.id === 'createPayment');
  assert.equal(op.body.properties.description.type, 'string');
  const rendered = render(c);
  assert.ok(rendered.get('node/index.d.ts').includes('"description"?: string;'));
  assert.ok(rendered.get('php/src/Client.php').includes('description'));
});
test('non-payment provider excludes domain APIs and unselected private models', async () => {
  const library = loadContract('examples/library.openapi.json', 'examples/library.sdk.json');
  const out = join(temporary, 'library');
  generate(library, out);
  const { Client } = await import(pathToFileURL(join(out, 'node/index.js')).href);
  const client = new Client({ baseUrl: 'https://example.invalid' });
  assert.equal(client.money, undefined);
  assert.equal(client.verifyWebhook, undefined);
  assert.equal(client.payments, undefined);
  assert.equal(typeof client.books.retrieve, 'function');
  assert.ok(!readFileSync(join(output, 'node/index.d.ts'), 'utf8').includes('PrivateAdmin'));
  assert.ok(!readFileSync(join(output, 'node/index.js'), 'utf8').includes('adminSecrets'));
});
test('compatibility distinguishes rename, alias and changed HTTP behavior', () => {
  const next = structuredClone(contract);
  const op = next.operations.find((o) => o.id === 'createPayment');
  op.method = 'submit';
  assert.ok(compare(contract, next).some((c) => c.severity === 'breaking'));
  op.aliases = ['create'];
  assert.ok(!compare(contract, next).some((c) => c.message.includes('renamed')));
  op.path = '/refunds';
  assert.ok(compare(contract, next).some((c) => c.message.includes('HTTP')));
});
test('exact parser rejects malformed JSON and serializer preserves all presence combinations', () => {
  assert.equal(
    parseExact('{"n":9007199254740993,"d":0.1234567890123456789}').n,
    '9007199254740993',
  );
  for (const invalid of ['01', '1.', '[1 2]', '{"n":1e}']) assert.throws(() => parseExact(invalid));
  const s = {
    type: 'object',
    required: ['requiredNullable', 'requiredValue'],
    properties: {
      requiredNullable: { type: ['string', 'null'] },
      requiredValue: { type: 'string' },
      optionalNullable: { type: ['string', 'null'] },
      optionalValue: { type: 'string' },
    },
    additionalProperties: false,
  };
  assert.equal(
    serialize({ requiredNullable: null, requiredValue: '', optionalNullable: undefined }, s),
    '{"requiredNullable":null,"requiredValue":""}',
  );
  assert.equal(
    serialize({ requiredNullable: 'x', requiredValue: '', optionalNullable: null }, s),
    '{"requiredNullable":"x","requiredValue":"","optionalNullable":null}',
  );
  assert.throws(() => serialize({ requiredValue: 'x' }, s), /required/);
  assert.throws(
    () => serialize({ requiredNullable: null, requiredValue: '', optionalValue: null }, s),
    /null/,
  );
});
test('webhooks preserve bytes, tolerate rotating secrets and reject stale/tampered payloads', () => {
  const runtime = new Runtime(runtimeContract, { baseUrl: 'https://example.invalid' });
  const body = Buffer.from(
    '{"id":"e1","type":"payment.updated","data":{"id":"p","amount":100,"status":"pending"}}',
  );
  const headers = {
    'X-Timestamp': '1000',
    'X-Signature': createHmac('sha256', 'new')
      .update(Buffer.concat([Buffer.from('1000.'), body]))
      .digest('hex'),
  };
  assert.equal(runtime.verifyWebhook(body, headers, ['old', 'new'], 1000).known, true);
  assert.throws(
    () => runtime.verifyWebhook(Buffer.concat([body, Buffer.from(' ')]), headers, ['new'], 1000),
    /signature/,
  );
  assert.throws(() => runtime.verifyWebhook(body, headers, ['new'], 1400), /timestamp/);
  const future = Buffer.from('{"type":"future.event"}');
  const sig = createHmac('sha256', 'new')
    .update(Buffer.concat([Buffer.from('1000.'), future]))
    .digest('hex');
  assert.equal(
    runtime.verifyWebhook(future, { ...headers, 'X-Signature': sig }, ['new'], 1000).known,
    false,
  );
});
test('pagination is lazy, bounded, cancellable and refuses foreign credential destinations', async () => {
  let calls = 0;
  const abort = new AbortController();
  const runtime = new Runtime(runtimeContract, {
    baseUrl: 'https://example.invalid',
    token: 'test',
    transport: async () => {
      calls++;
      return Response.json({
        items: [{ id: 'p', amount: 100, status: 'pending' }],
        next: 'cursor',
      });
    },
  });
  for await (const item of runtime.items('listPayments', {}, { maxItems: 1 }))
    assert.equal(item.id, 'p');
  assert.equal(calls, 1);
  for await (const item of runtime.items('listPayments', {}, { signal: abort.signal })) {
    abort.abort();
    break;
  }
  assert.equal(calls, 2);
  await assert.rejects(
    async () => {
      for await (const page of runtime.pages('listPayments', {}, { signal: abort.signal })) {
      }
    },
    (e) => e.kind === 'cancelled',
  );
  let foreignCalls = 0;
  const unsafe = new Runtime(runtimeContract, {
    baseUrl: 'https://example.invalid',
    token: 'test',
    transport: async () => {
      foreignCalls++;
      return Response.json({ items: [], next: 'https://evil.invalid/steal' });
    },
  });
  await assert.rejects(
    async () => {
      for await (const page of unsafe.pages('listLinks')) {
      }
    },
    (e) => e.kind === 'destination',
  );
  assert.equal(foreignCalls, 1);
});
test('concurrent tenants have independent request headers and diagnostics omit secrets', async () => {
  const seen = [];
  const events = [];
  let releaseFirst;
  const secondArrived = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const runtime = new Runtime(runtimeContract, {
    baseUrl: 'https://example.invalid',
    token: 'secret-key',
    diagnostics: (e) => events.push(e),
    transport: async (_url, init) => {
      // Force overlap and completion order without relying on timer scheduling.
      if (init.headers['x-tenant'] === 'a') await secondArrived;
      seen.push(init.headers['x-tenant']);
      if (init.headers['x-tenant'] === 'b') releaseFirst();
      return Response.json(
        { id: init.headers['x-tenant'], amount: 1, status: 'pending' },
        { headers: { 'x-request-id': 'r1' } },
      );
    },
  });
  const results = await Promise.all(
    ['a', 'b'].map((tenant) => runtime.request('getPayment', { id: 'p', 'X-Tenant': tenant })),
  );
  assert.deepEqual(
    results.map((r) => r.data.id),
    ['a', 'b'],
  );
  assert.deepEqual(seen, ['b', 'a']);
  assert.ok(!JSON.stringify(events).includes('secret-key'));
  assert.equal(events[0].requestId, 'r1');
  const model = new Model(
    { nested: { secret: 'hidden' } },
    {
      type: 'object',
      properties: {
        nested: { type: 'object', properties: { secret: { type: 'string', 'x-sensitive': true } } },
      },
    },
  );
  assert.ok(!inspect(model).includes('hidden'));
  assert.ok(JSON.stringify(model).includes('hidden'));
});
test('unknown polling states never count as success', async () => {
  let count = 0;
  const runtime = new Runtime(runtimeContract, {
    baseUrl: 'https://example.invalid',
    token: 'test',
    transport: async () => {
      count++;
      return Response.json({
        id: 'p',
        amount: 1,
        status: count > 1 ? 'succeeded' : 'new_unknown_state',
      });
    },
  });
  const result = await runtime.wait('getPayment', { id: 'p' });
  assert.equal(count, 2);
  assert.equal(result.data.status, 'succeeded');
});
test('installable packages lint and Node package types/examples compile', async () => {
  validate(output);
  const cwd = join(output, 'node');
  const result = spawnSync(
    resolve('node_modules/.bin/tsc'),
    [
      '--strict',
      '--noEmit',
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--types',
      'node',
      '--typeRoots',
      resolve('node_modules/@types'),
      ...readdirSync(join(cwd, 'examples'))
        .filter((p) => p.endsWith('.ts'))
        .map((p) => 'examples/' + p),
    ],
    { cwd, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const composer = spawnSync('composer', ['install', '--no-interaction', '--no-dev'], {
    cwd: join(output, 'php'),
    encoding: 'utf8',
  });
  assert.equal(composer.status, 0, composer.stderr);
  const { Client } = await import(pathToFileURL(join(output, 'node/index.js')).href);
  assert.equal(
    typeof new Client({ baseUrl: 'https://example.invalid' }).payments.create,
    'function',
  );
});
test('release archives can be installed and do not contain private generation records', () => {
  const release = join(temporary, 'release');
  const plan = prepareRelease(output, release);
  assert.ok(plan.publication.length);
  assert.equal(plan.approved, false);
  const tarball = readdirSync(release).find((p) => p.endsWith('.tgz'));
  const contents = spawnSync('tar', ['-tzf', join(release, tarball)], { encoding: 'utf8' }).stdout;
  assert.ok(contents.includes('package/index.d.ts'));
  assert.ok(!contents.includes('.sdk-generator'));
  assert.ok(!contents.includes('payment-api.json'));
  const consumer = join(temporary, 'consumer');
  mkdirSync(consumer);
  writeFileSync(join(consumer, 'package.json'), '{"type":"module","private":true}');
  const install = spawnSync(
    'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', join(release, tarball)],
    { cwd: consumer, encoding: 'utf8' },
  );
  assert.equal(install.status, 0, install.stderr);
  const imported = spawnSync(
    'node',
    [
      '--input-type=module',
      '-e',
      "import { Client } from '@example/payments'; console.log(typeof Client)",
    ],
    { cwd: consumer, encoding: 'utf8' },
  );
  assert.equal(imported.stdout.trim(), 'function');
});
test('default Node and PHP transports perform real local HTTP requests', async () => {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, body, auth: req.headers.authorization });
    res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'local-http' });
    res.end('{"id":"p","amount":9007199254740993,"status":"pending"}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const runtime = new Runtime(runtimeContract, {
      baseUrl: base,
      token: 'local-token',
      allowInsecureHttp: true,
    });
    const result = await runtime.request('getPayment', { id: 'x/y' });
    assert.equal(result.data.amount, '9007199254740993');
    const { spawn } = await import('node:child_process');
    const script = `require $argv[1].'/src/Runtime.php'; $r = new Example\\Payments\\Runtime(json_decode(file_get_contents($argv[2]),true), new Example\\Payments\\ClientOptions($argv[3],token:'local-token',allowInsecureHttp:true)); echo $r->request('getPayment',['id'=>'x/y'])->data->amount; $r->close();`;
    const child = spawn('php', ['-r', script, join(output, 'php'), runtimeFile, base]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => (stdout += b));
    child.stderr.on('data', (b) => (stderr += b));
    const code = await new Promise((r) => child.on('close', r));
    assert.equal(code, 0, stderr);
    assert.equal(stdout, '9007199254740993');
    assert.equal(requests.length, 2);
    assert.ok(
      requests.every((r) => r.url === '/payments/x%2Fy' && r.auth === 'Bearer local-token'),
    );
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('provider fixture validation runs against both emitted runtimes', async () => {
  const { validateFixtures } = await import('../dist/fixtures.js');
  assert.deepEqual(await validateFixtures(output, fixture('http-cases.json')), [
    { target: 'node', scenarios: cases.length },
    { target: 'php', scenarios: cases.length },
  ]);
});
test('durable webhook inbox handles redelivery across database reopen in Node and PHP', async () => {
  const { Client } = await import(pathToFileURL(join(output, 'node/index.js')).href);
  const { openInbox, receiveWebhook } = await import(
    pathToFileURL(join(output, 'node/examples/webhook-inbox.mjs')).href
  );
  const client = new Client({ baseUrl: 'https://example.invalid' });
  const body = Buffer.from(
    '{"id":"evt-1","type":"payment.updated","data":{"id":"p","amount":100,"status":"pending"}}',
  );
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', 'signing-key')
    .update(Buffer.concat([Buffer.from(timestamp + '.'), body]))
    .digest('hex');
  const headers = { 'x-timestamp': timestamp, 'x-signature': signature };
  const path = join(temporary, 'inbox.sqlite');
  let db = openInbox(path);
  assert.equal(
    receiveWebhook(client, db, body, headers, ['signing-key'], (e) => e.id).queued,
    true,
  );
  db.close();
  db = openInbox(path);
  assert.equal(
    receiveWebhook(client, db, body, headers, ['signing-key'], (e) => e.id).queued,
    false,
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM inbox').get().count, 1);
  assert.throws(
    () => receiveWebhook(client, db, Buffer.from('invalid'), headers, ['signing-key'], (e) => e.id),
    /signature/,
  );
  db.close();
  const script = `require $argv[1].'/src/Runtime.php'; require $argv[1].'/src/Client.php'; require $argv[1].'/examples/webhook-inbox.php'; $client = new Example\\Payments\\Client(new Example\\Payments\\ClientOptions('https://example.invalid')); $db = Example\\Payments\\Examples\\openInbox($argv[2]); $body=$argv[3]; $headers=['x-timestamp'=>$argv[4],'x-signature'=>$argv[5]]; $a=Example\\Payments\\Examples\\receiveWebhook($client,$db,$body,$headers,['signing-key'],fn($e)=>$e->id); $db=null; $db=Example\\Payments\\Examples\\openInbox($argv[2]); $b=Example\\Payments\\Examples\\receiveWebhook($client,$db,$body,$headers,['signing-key'],fn($e)=>$e->id); echo json_encode([$a['queued'],$b['queued']]);`;
  const result = spawnSync(
    'php',
    [
      '-r',
      script,
      join(output, 'php'),
      join(temporary, 'php-inbox.sqlite'),
      body.toString(),
      timestamp,
      signature,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [true, false]);
});
test('generated PHP responses expose typed getters and redact model printing', () => {
  const code = `require $argv[1].'/src/Runtime.php'; require $argv[1].'/src/Client.php'; $r = new Example\\Payments\\PaymentsRetrieveResponse200(['id'=>'p','amount'=>'9007199254740993','status'=>'future','secret'=>'hidden-secret']); if ($r->getAmount() !== '9007199254740993') exit(1); var_dump($r);`;
  const r = spawnSync('php', ['-r', code, join(output, 'php')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('[REDACTED]'));
  assert.ok(!r.stdout.includes('hidden-secret'));
});

test('release PHP archive excludes neighboring handwritten/private files', () => {
  const out = join(temporary, 'release-filter');
  generate(contract, out);
  writeFileSync(join(out, 'php/private-definition.json'), '{"private":"do-not-publish"}');
  const dest = join(temporary, 'filtered-release');
  prepareRelease(out, dest);
  const archive = readdirSync(dest).find((p) => p.endsWith('.zip'));
  const listing = spawnSync('unzip', ['-l', join(dest, archive)], { encoding: 'utf8' });
  assert.equal(listing.status, 0, listing.stderr);
  assert.ok(!listing.stdout.includes('private-definition'));
  assert.ok(listing.stdout.includes('src/contract.json'));
});
test('compatibility findings persist into release migrations', () => {
  const out = join(temporary, 'migration');
  generate(contract, out);
  const next = structuredClone(contract);
  next.config.version = '1.0.0';
  const op = next.operations.find((o) => o.id === 'getPayment');
  op.method = 'fetchOne';
  op.aliases = ['retrieve'];
  op.path = '/changed/{id}';
  generate(next, out);
  generate(next, out);
  const dest = join(temporary, 'migration-release');
  const plan = prepareRelease(out, dest);
  assert.ok(plan.reviewRequired);
  assert.equal(plan.previousVersion, '0.1.0');
  assert.ok(readFileSync(join(dest, 'MIGRATION.md'), 'utf8').includes('payments.fetchOne'));
  assert.ok(readFileSync(join(dest, 'CHANGELOG.md'), 'utf8').includes('HTTP destination'));
});
test('real Node timeout and cancellation release a stalled response', async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const runtime = new Runtime(runtimeContract, {
      baseUrl: base,
      token: 'test',
      allowInsecureHttp: true,
    });
    const start = performance.now();
    // Keep the overall deadline clear of process scheduling during the full
    // fixture suite; this case exercises the 20-ms HTTP-attempt timeout.
    await assert.rejects(
      runtime.request(
        'getPayment',
        { id: 'p' },
        { timeoutMs: 20, deadlineMs: 1000, maxAttempts: 1 },
      ),
      (e) => ['transport', 'deadline'].includes(e.kind) && e.outcome === 'unknown',
    );
    assert.ok(performance.now() - start < 500);
    const controller = new AbortController();
    const pending = runtime.request('getPayment', { id: 'p' }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(pending, (e) => e.kind === 'cancelled');
    const { spawn } = await import('node:child_process');
    const script = `require $argv[1].'/src/Runtime.php'; $r = new Example\\Payments\\Runtime(json_decode(file_get_contents($argv[2]),true),new Example\\Payments\\ClientOptions($argv[3],token:'test',allowInsecureHttp:true)); try {$r->request('getPayment',['id'=>'p'],new Example\\Payments\\RequestOptions(timeoutMs:20,deadlineMs:50,maxAttempts:1));exit(1);}catch(Example\\Payments\\SdkError $e){echo $e->kind;}$r->close();`;
    const child = spawn('php', ['-r', script, join(output, 'php'), runtimeFile, base]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => (stdout += b));
    child.stderr.on('data', (b) => (stderr += b));
    const code = await new Promise((r) => child.on('close', r));
    assert.equal(code, 0, stderr);
    assert.ok(['transport', 'deadline'].includes(stdout));
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

test('known sensitive response fields and raw bodies are redacted in default inspection', async () => {
  const runtime = new Runtime(runtimeContract, {
    baseUrl: 'https://example.invalid',
    token: 'credential-value',
    transport: async () =>
      Response.json(
        { id: 'p', amount: 1, status: 'pending', secret: 'private-value' },
        { headers: { 'set-cookie': 'cookie-secret' } },
      ),
  });
  const result = await runtime.request('getPayment', { id: 'p' });
  assert.ok(!inspect(result).includes('private-value'));
  assert.ok(!inspect(result).includes('cookie-secret'));
  assert.ok(!inspect(result.data).includes('private-value'));
  assert.ok(!inspect(runtime).includes('credential-value'));
  assert.equal(result.data.secret, 'private-value');
  assert.ok(result.raw.includes('private-value'));
});

test('all generated JavaScript, TypeScript and PHP operation examples execute', async () => {
  const { spawn } = await import('node:child_process');
  let calls = 0;
  const server = createServer(async (req, res) => {
    for await (const chunk of req) {
    }
    calls++;
    const collection =
      req.method === 'GET' && ['/payments', '/links'].includes(req.url.split('?')[0]);
    res.writeHead(req.method === 'POST' && req.url === '/payments' ? 201 : 200, {
      'content-type': 'application/json',
      'x-request-id': 'quickstart-request',
    });
    res.end(collection ? '{"items":[],"next":null}' : '{"id":"p","amount":100,"status":"pending"}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const env = {
    ...process.env,
    API_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    API_TOKEN: 'synthetic-test-token',
  };
  try {
    for (const target of ['node', 'php']) {
      const dir = join(output, target, 'examples');
      for (const file of readdirSync(dir).filter((f) => f.startsWith('payments-'))) {
        const localFile = localExampleFile(join(dir, file));
        const child = spawn(
          target === 'php' ? 'php' : process.execPath,
          [...(file.endsWith('.ts') ? ['--experimental-strip-types'] : []), localFile],
          {
            env,
          },
        );
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (b) => (stdout += b));
        child.stderr.on('data', (b) => (stderr += b));
        const code = await new Promise((r) => child.on('close', r));
        rmSync(localFile);
        assert.equal(code, 0, file + ': ' + stderr);
        // Examples show response data before the request ID.
        assert.match(stdout.trim(), /(?:^|\n)quickstart-request$/);
      }
    }
    assert.equal(calls, contract.operations.length * 3);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
test('automatic idempotency keys remain stable within retries and change for new submissions', async () => {
  const keys = [];
  let calls = 0;
  const runtime = new Runtime(runtimeContract, {
    baseUrl: 'https://example.invalid',
    token: 'test',
    transport: async (_url, init) => {
      keys.push(init.headers['idempotency-key']);
      if (++calls % 2) throw new Error('lost response');
      return Response.json({ id: 'p', amount: 100, status: 'succeeded' });
    },
  });
  await runtime.request('refundPayment', { id: 'p', body: { amount: '100' } });
  await runtime.request('refundPayment', { id: 'p', body: { amount: '100' } });
  assert.equal(keys.length, 4);
  assert.equal(keys[0], keys[1]);
  assert.equal(keys[2], keys[3]);
  assert.notEqual(keys[0], keys[2]);
  const script = `require $argv[1].'/src/Runtime.php'; $keys=[];$calls=0;$transport=function($r)use(&$keys,&$calls){$keys[]=$r['headers']['idempotency-key'];if(++$calls%2)throw new RuntimeException('lost');return ['status'=>200,'headers'=>[],'body'=>'{"id":"p","amount":100,"status":"succeeded"}'];};$r=new Example\\Payments\\Runtime(json_decode(file_get_contents($argv[2]),true),new Example\\Payments\\ClientOptions('https://example.invalid',token:'test',transport:$transport));$r->request('refundPayment',['id'=>'p','body'=>['amount'=>'100']]);$r->request('refundPayment',['id'=>'p','body'=>['amount'=>'100']]);echo json_encode($keys);`;
  const result = spawnSync('php', ['-r', script, join(output, 'php'), runtimeFile], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const phpKeys = JSON.parse(result.stdout);
  assert.equal(phpKeys[0], phpKeys[1]);
  assert.equal(phpKeys[2], phpKeys[3]);
  assert.notEqual(phpKeys[0], phpKeys[2]);
});
test('preview includes reviewable unified diffs without changing output', () => {
  const next = structuredClone(contract);
  next.config.version = '1.0.0';
  const plan = generate(next, output, true);
  const packageChange = plan.changes.find((c) => c.path === 'node/package.json');
  assert.ok(packageChange.diff.startsWith('--- a/node/package.json\n+++ b/node/package.json'));
  assert.ok(packageChange.diff.includes('+  "version": "1.0.0"'));
  assert.equal(JSON.parse(readFileSync(join(output, 'node/package.json'))).version, '0.1.0');
});

test('publishing requires a reviewed version and verifies archives before invoking npm', () => {
  const dir = join(temporary, 'publish-control');
  mkdirSync(dir);
  const archive = Buffer.from('test archive fixture');
  writeFileSync(join(dir, 'sdk.tgz'), archive);
  writeFileSync(
    join(dir, 'release-plan.json'),
    JSON.stringify({
      version: '1.2.3',
      checksums: { 'sdk.tgz': createHash('sha256').update(archive).digest('hex') },
      npm: { registry: 'https://registry.example.invalid', access: 'restricted' },
      publication: [['untrusted-command']],
      composer: 'manual Composer distribution',
    }),
  );
  let calls = 0;
  const execute = (args) => {
    calls++;
    assert.equal(args[0], 'publish');
    assert.ok(args.includes('--ignore-scripts'));
    assert.ok(args.includes('https://registry.example.invalid/'));
    return { status: 0 };
  };
  assert.throws(() => publishRelease(dir, 'wrong-version', execute), /confirm/);
  assert.equal(calls, 0);
  assert.equal(publishRelease(dir, '1.2.3', execute).npmPublished, true);
  assert.equal(calls, 1);
  assert.equal(publishRelease(dir, '1.2.3', execute).npmPublished, true);
  assert.equal(calls, 1, 'a successful publication receipt prevents duplicate uploads');
  writeFileSync(join(dir, 'sdk.tgz'), 'changed');
  assert.throws(() => publishRelease(dir, '1.2.3', execute), /changed after review/);
  assert.equal(calls, 1);
});

test('shared serialization corpus preserves requiredness, null, exact values and tagged inputs', () => {
  const corpus = JSON.parse(readFileSync(fixture('serialization-cases.json')));
  for (const scenario of corpus) {
    if (scenario.error)
      assert.throws(
        () => serialize(scenario.value, scenario.schema),
        (e) => e.kind === 'validation',
        scenario.name,
      );
    else assert.equal(serialize(scenario.value, scenario.schema), scenario.wire, scenario.name);
  }
  const script = `require $argv[1].'/src/Runtime.php';$cases=json_decode(file_get_contents($argv[2]),false,512,JSON_THROW_ON_ERROR);foreach($cases as $case){$schema=json_decode(json_encode($case->schema),true);try{$wire=Example\\Payments\\Codec::encode(Example\\Payments\\Codec::normalize($case->value,$schema));if(($case->error??false)||$wire!==$case->wire)throw new RuntimeException($case->name);}catch(Example\\Payments\\SdkError $e){if(!($case->error??false))throw $e;}}echo count($cases);`;
  const r = spawnSync(
    'php',
    ['-r', script, join(output, 'php'), fixture('serialization-cases.json')],
    { encoding: 'utf8' },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.equal(Number(r.stdout), corpus.length);
});
test('generator itself installs from its npm archive and produces validated packages', () => {
  const folder = join(temporary, 'generator-consumer');
  mkdirSync(folder);
  writeFileSync(join(folder, 'package.json'), '{"private":true}');
  const pack = spawnSync(
    'npm',
    ['pack', '--ignore-scripts', '--json', '--pack-destination', folder],
    { cwd: resolve('.'), encoding: 'utf8' },
  );
  assert.equal(pack.status, 0, pack.stderr);
  const packed = JSON.parse(pack.stdout)[0];
  const packedPaths = packed.files.map((file) => file.path);
  assert.ok(
    packedPaths.every(
      (path) =>
        !/flint|\.context|providers\/|\.go$|(?:acceptance|review-scans|implementation-checklist|sdk-generator-feature-brief)\.md/i.test(
          path,
        ),
    ),
    'provider inputs and development history must not ship in the generator package',
  );
  const archive = join(folder, packed.filename);
  const install = spawnSync(
    'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', archive],
    { cwd: folder, encoding: 'utf8', timeout: 120000 },
  );
  assert.equal(install.status, 0, install.stderr);
  const installed = join(folder, 'node_modules/@public-sdk/generator');
  const cli = join(installed, 'dist/cli.js');
  const target = join(folder, 'library');
  const generated = spawnSync(
    process.execPath,
    [
      cli,
      'generate',
      join(installed, 'examples/library.openapi.json'),
      join(installed, 'examples/library.sdk.json'),
      target,
    ],
    { cwd: folder, encoding: 'utf8' },
  );
  assert.equal(generated.status, 0, generated.stderr);
  const verified = spawnSync(process.execPath, [cli, 'validate', target], {
    cwd: folder,
    encoding: 'utf8',
    timeout: 120000,
  });
  assert.equal(verified.status, 0, verified.stderr);
  assert.ok(JSON.parse(verified.stdout).checks.length > 0);
});

test('dangling symlinks are rejected before writes and older generation records can migrate', () => {
  const out = join(temporary, 'dangling');
  mkdirSync(out);
  mkdirSync(join(out, 'node'));
  const victim = join(temporary, 'must-not-create');
  symlinkSync(victim, join(out, 'node/index.js'));
  assert.throws(() => generate(contract, out), /symlinks/);
  assert.equal(existsSync(victim), false);
  const migrate = join(temporary, 'generator-upgrade');
  generate(contract, migrate);
  const record = JSON.parse(readFileSync(join(migrate, '.sdk-generator.json')));
  record.generator = '0.0.9';
  writeFileSync(join(migrate, '.sdk-generator.json'), JSON.stringify(record));
  assert.ok(generate(contract, migrate, true).compatibility.some((c) => c.subject === 'generator'));
  generate(contract, migrate);
  assert.equal(JSON.parse(readFileSync(join(migrate, '.sdk-generator.json'))).generator, '0.1.0');
});
test('tagged PHP responses retain typed known variants and preserve future variants', async () => {
  const api = JSON.parse(readFileSync('examples/library.openapi.json'));
  const config = JSON.parse(readFileSync('examples/library.sdk.json'));
  api.paths['/books/{id}'].get.responses['200'].content['application/json'].schema = {
    oneOf: [
      {
        type: 'object',
        required: ['kind', 'url'],
        properties: { kind: { type: 'string', enum: ['redirect'] }, url: { type: 'string' } },
      },
      {
        type: 'object',
        required: ['kind', 'code'],
        properties: {
          kind: { type: 'string', enum: ['verify'] },
          code: { type: 'string', 'x-sensitive': true },
        },
      },
    ],
    discriminator: { propertyName: 'kind' },
  };
  const dir = join(temporary, 'variants');
  mkdirSync(dir);
  writeFileSync(join(dir, 'api.json'), JSON.stringify(api));
  writeFileSync(join(dir, 'sdk.json'), JSON.stringify(config));
  const selected = loadContract(join(dir, 'api.json'), join(dir, 'sdk.json'));
  const out = join(dir, 'out');
  generate(selected, out);
  validate(out);
  const { Client, isBooksRetrieveResponseKnown } = await import(
    pathToFileURL(join(out, 'node/index.js')).href
  );
  assert.equal(
    isBooksRetrieveResponseKnown({ kind: 'redirect', url: 'https://next.invalid' }),
    true,
  );
  assert.equal(isBooksRetrieveResponseKnown({ kind: 'future', other: true }), false);
  assert.equal(isBooksRetrieveResponseKnown({ kind: 'redirect' }), false);
  const typecheck = join(out, 'node/variants.ts');
  writeFileSync(
    typecheck,
    `import {isBooksRetrieveResponseKnown, type BooksRetrieveResponse} from './index.js';
declare const data: BooksRetrieveResponse;
if (isBooksRetrieveResponseKnown(data)) {
  if (data.kind === 'redirect') { const url: string = data.url; }
  else { const code: string = data.code; }
}
`,
  );
  const compiled = spawnSync(
    resolve('node_modules/.bin/tsc'),
    [
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
      typecheck,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
  const client = new Client({
    baseUrl: 'https://example.invalid',
    transport: async () => Response.json({ kind: 'future', other: true }),
  });
  assert.equal((await client.books.retrieve({ id: '1' })).data.kind, 'future');
  const script = `require $argv[1].'/src/Runtime.php';require $argv[1].'/src/Client.php';$calls=0;$client=new Example\\Library\\Client(new Example\\Library\\ClientOptions('https://example.invalid',transport:function($r)use(&$calls){return ['status'=>200,'headers'=>[],'body'=>++$calls===1?'{"kind":"redirect","url":"https://next.invalid"}':'{"kind":"future","other":true}'];}));$a=$client->books->retrieve(new Example\\Library\\BooksRetrieveInput(['id'=>'1']));$b=$client->books->retrieve(new Example\\Library\\BooksRetrieveInput(['id'=>'1']));echo json_encode([$a->data->getUrl(),$b->data->kind]);`;
  const r = spawnSync('php', ['-r', script, join(out, 'php')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), ['https://next.invalid', 'future']);
});
test('prototype property names do not bypass required fields or identify known webhook types', () => {
  assert.throws(
    () =>
      serialize(
        {},
        { type: 'object', required: ['toString'], properties: { toString: { type: 'string' } } },
      ),
    /required/,
  );
  assert.throws(
    () =>
      serialize(JSON.parse('{"__proto__":"value"}'), {
        type: 'object',
        additionalProperties: false,
      }),
    /unknown request field/,
  );
  const runtime = new Runtime(runtimeContract, { baseUrl: 'https://example.invalid' });
  assert.throws(() => runtime.money('constructor', '1'), /currency is not declared/);
  const raw = Buffer.from('{"type":"constructor"}');
  const sig = createHmac('sha256', 'secret')
    .update(Buffer.concat([Buffer.from('1000.'), raw]))
    .digest('hex');
  assert.equal(
    runtime.verifyWebhook(raw, { 'X-Timestamp': '1000', 'X-Signature': sig }, ['secret'], 1000)
      .known,
    false,
  );
});
