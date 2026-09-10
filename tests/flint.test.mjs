import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createHash, createHmac } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { loadContract, generate, validate, validateFixtures } from '../dist/index.js';
const dir = mkdtempSync(join(tmpdir(), 'sdk-flint-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const root = resolve('tests/providers/flint');
const contract = loadContract(join(root, 'openapi.json'), join(root, 'sdk.json'));
const output = join(dir, 'sdk');
generate(contract, output);
const cases = JSON.parse(readFileSync(join(root, 'http-cases.json')));
test('provider regression inputs match their pinned fixture manifest', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'fixture-manifest.json')));
  const provenance = JSON.parse(readFileSync(join(root, 'provenance.json')));
  assert.equal(manifest.specRevision, provenance.revision);
  assert.equal(manifest.behaviorRevision, provenance.behaviorRevision);
  assert.deepEqual(Object.keys(manifest.files).sort(), [
    'full-checkout-sdk.json',
    'full-common-sdk.json',
    'full-customer-sdk.json',
    'full-http-cases.json',
    'full-inventory.json',
    'full-invoice-sdk.json',
    'full-merchant-sdk.json',
    'full-merchantKey-sdk.json',
    'full-model-cases.json',
    'full-onboarding-sdk.json',
    'full-openapi.json',
    'full-sdk.json',
    'http-cases.json',
    'openapi.json',
    'risk-http-cases.json',
    'risk-openapi.json',
    'risk-sdk.json',
    'sdk.json',
  ]);
  for (const [file, expected] of Object.entries(manifest.files)) {
    assert.equal(
      createHash('sha256')
        .update(readFileSync(join(root, file)))
        .digest('hex'),
      expected,
      `${file} changed; verify its source and expected behavior before updating the manifest`,
    );
  }
});
function run(command, args, cwd) {
  const r = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, r.error?.message ?? r.stderr + r.stdout);
  return r.stdout;
}
test('Flint reference pins local source, all seven selected operations and recursive dependencies', () => {
  const evidence = JSON.parse(readFileSync(join(root, 'signing-vector.json')));
  const provenance = JSON.parse(readFileSync(join(root, 'provenance.json')));
  assert.equal(provenance.behaviorRevision, evidence.source.revision);
  assert.equal(provenance.previousSpec.revision, evidence.source.revision);
  assert.equal(provenance.previousSpec.sourceSha256, evidence.source.files[provenance.source]);
  assert.equal(
    provenance.sliceSha256,
    createHash('sha256')
      .update(readFileSync(join(root, 'openapi.json')))
      .digest('hex'),
  );
  assert.equal(contract.operations.length, 7);
  assert.equal(Object.keys(contract.models).length, 91);
  assert.ok(contract.models.PaymentCollection);
  assert.ok(Object.keys(contract.definitions).length > 0);
  const bytes = (path) =>
    readdirSync(path).reduce((size, name) => {
      const file = join(path, name),
        s = statSync(file);
      return size + (s.isDirectory() ? bytes(file) : s.size);
    }, 0);
  assert.ok(
    bytes(join(output, 'node')) + bytes(join(output, 'php')) < 4_000_000,
    'named shapes must be shared rather than repeatedly expanded',
  );
});
test('Flint profiles pin the dated spec independently of the URL and package versions', () => {
  for (const prefix of ['', 'risk-']) {
    const raw = JSON.parse(readFileSync(join(root, `${prefix}openapi.json`)));
    const c = loadContract(join(root, `${prefix}openapi.json`), join(root, `${prefix}sdk.json`));
    assert.equal(raw.info.version, 'v1');
    assert.equal(raw['x-flint-api-version'], '2026-09-07');
    assert.deepEqual(c.config.apiVersion, {
      header: 'Flint-Version',
      value: raw['x-flint-api-version'],
    });
    assert.equal(c.apiVersion, '2026-09-07');
    assert.equal(c.config.version, '0.2.0');
  }
  for (const target of ['node', 'php']) {
    assert.match(
      readFileSync(join(output, target, 'README.md'), 'utf8'),
      /generated for API 2026-09-07/,
    );
  }
});
test('local Flint schema passes the same fifteen source-informed HTTP cases in both public clients', async () => {
  assert.deepEqual(await validateFixtures(output, join(root, 'http-cases.json')), [
    { target: 'node', scenarios: 15 },
    { target: 'php', scenarios: 15 },
  ]);
});
test('Flint read overrides correct nullability while preserving the source export', () => {
  const raw = JSON.parse(readFileSync(join(root, 'openapi.json')));
  for (const field of ['last_payment_error', 'risk']) {
    assert.equal(
      raw.components.schemas.GetPaymentIntentResult.properties[field].nullable,
      undefined,
    );
    assert.ok(
      contract.models.GetPaymentIntentResult.properties[field].anyOf.some((s) => s.type === 'null'),
    );
  }
});
test('Flint reference verifies its declared payment event envelope in both public clients', async () => {
  const { Client } = await import(pathToFileURL(join(output, 'node/index.js')).href);
  const event = {
    webhook_event_id: 'whev_fixture',
    event_type: 'payment_intent.succeeded',
    api_version: '2026-02-01',
    mode: 'test',
    merchant_id: 'mer_fixture',
    data: {
      payment_intent: {
        payment_intent_id: 'pi_fixture',
        status: 'succeeded',
        amount_money: { amount: '9007199254740993', currency: 'USD' },
      },
    },
  };
  const raw = JSON.stringify(event).replace('"9007199254740993"', '9007199254740993');
  const key = Buffer.alloc(32, 7),
    secret = 'whsec_' + key.toString('base64');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const headers = {
    'webhook-id': event.webhook_event_id,
    'webhook-timestamp': timestamp,
    'webhook-signature':
      'v1,' +
      createHmac('sha256', key)
        .update(`${event.webhook_event_id}.${timestamp}.${raw}`)
        .digest('base64'),
  };
  const client = new Client({ baseUrl: 'https://example.invalid' });
  const verified = client.verifyWebhook(raw, headers, [secret]);
  assert.equal(verified.known, true);
  assert.deepEqual(JSON.parse(JSON.stringify(verified.event)), event);
  const fixture = join(dir, 'signed-payment-event.json');
  writeFileSync(fixture, JSON.stringify({ raw, headers, secret }));
  const php = String.raw`require $argv[1].'/src/Runtime.php';require $argv[1].'/src/Client.php';$f=json_decode(file_get_contents($argv[2]),true);$c=new Example\Flint\Client(new Example\Flint\ClientOptions('https://example.invalid'));echo json_encode($c->verifyWebhook($f['raw'],$f['headers'],[$f['secret']]));`;
  assert.deepEqual(JSON.parse(run('php', ['-r', php, join(output, 'php'), fixture], dir)), {
    event,
    known: true,
  });
});
test('Flint quickstarts typecheck and both packages install with usable public interfaces', async () => {
  const checks = validate(output);
  assert.ok(checks.some((c) => c.command.includes('--strict')));
  const archive = JSON.parse(
    run('npm', ['pack', '--ignore-scripts', '--json'], join(output, 'node')),
  )[0].filename;
  const consumer = join(dir, 'consumer');
  mkdirSync(consumer);
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  run(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
      join(output, 'node', archive),
    ],
    consumer,
  );
  const installed = join(consumer, 'node_modules/@example/flint-sdk/index.js');
  const { Client } = await import(pathToFileURL(installed).href);
  const listing = cases.find((c) => c.operation === 'listPaymentIntents');
  let calls = 0;
  const c = new Client({
    baseUrl: 'https://api.example.invalid',
    token: 'test-token',
    transport: async (url, init) => {
      assert.equal(url.pathname, '/v1/payment-intents');
      assert.equal(init.headers.authorization, 'Bearer test-token');
      assert.equal(init.headers['flint-version'], '2026-09-07');
      if (calls++) assert.equal(url.searchParams.get('page_token'), 'next_cursor');
      return new Response(listing.responses[0].body, { status: 200 });
    },
  });
  const items = [];
  for await (const item of c.paymentIntents.listItems({ page_size: 1 }, { maxItems: 2 }))
    items.push(item);
  assert.equal(calls, 2);
  assert.equal(items[0].amount_money.amount, '9007199254740993');
  run(
    'composer',
    ['install', '--no-interaction', '--no-dev', '--no-plugins', '--no-scripts'],
    join(output, 'php'),
  );
  const php = String.raw`require $argv[1].'/vendor/autoload.php';$response=json_decode(file_get_contents($argv[2]),true)[5]['responses'][0];$calls=0;$client=new Example\Flint\Client(new Example\Flint\ClientOptions('https://api.example.invalid',token:'test-token',transport:function($r)use($response,&$calls){$calls++;if(($r['headers']['flint-version']??null)!=='2026-09-07')throw new RuntimeException('wrong API version');if(!str_contains($r['url'],'/v1/payment-intents'))throw new RuntimeException('wrong path');return $response;}));$items=iterator_to_array($client->paymentIntents->listItems(new Example\Flint\PaymentIntentsListInput(['page_size'=>1]),new Example\Flint\RequestOptions(maxItems:2)));echo json_encode(['calls'=>$calls,'items'=>$items]);$client->close();`;
  const result = JSON.parse(
    run('php', ['-r', php, join(output, 'php'), join(root, 'http-cases.json')], dir),
  );
  assert.equal(result.calls, 2);
  assert.equal(result.items[0].amount_money.amount, '9007199254740993');
});

test('risk-list source correction preserves raw provenance and enforces all four field choices', async () => {
  const raw = JSON.parse(readFileSync(join(root, 'risk-openapi.json')));
  assert.deepEqual(raw.components.schemas.AddRiskListItemsRequest.required, ['values']);
  const corrected = loadContract(join(root, 'risk-openapi.json'), join(root, 'risk-sdk.json'));
  assert.deepEqual(corrected.operations[0].body.required, []);
  const riskOutput = join(dir, 'risk');
  generate(corrected, riskOutput);
  assert.deepEqual(await validateFixtures(riskOutput, join(root, 'risk-http-cases.json')), [
    { target: 'node', scenarios: 4 },
    { target: 'php', scenarios: 4 },
  ]);
  assert.ok(validate(riskOutput).some((c) => c.command.includes('--strict')));
  assert.deepEqual(
    JSON.parse(readFileSync(join(root, 'risk-openapi.json'))),
    raw,
    'the source artifact is not edited by its separate override',
  );
});

test('automatic idempotency respects every explicit header source and rejects conflicting keys', async () => {
  const base = structuredClone(cases.find((c) => c.operation === 'createPaymentIntent'));
  const variants = [];
  for (const source of ['input', 'headers', 'both']) {
    const c = structuredClone(base);
    c.name = 'explicit key via ' + source;
    c.options = {};
    if (source !== 'headers') c.input['Idempotency-Key'] = 'durable-create-key';
    if (source !== 'input') c.options.headers = { 'Idempotency-Key': 'durable-create-key' };
    variants.push(c);
  }
  for (const options of [
    { idempotencyKey: 'different-key' },
    { headers: { 'Idempotency-Key': 'different-key' } },
  ]) {
    const c = structuredClone(base);
    c.name = 'conflicting ' + Object.keys(options)[0];
    c.input['Idempotency-Key'] = 'durable-create-key';
    c.options = options;
    delete c.expected;
    delete c.data;
    c.responses = [];
    c.error = { kind: 'validation', outcome: 'not_sent' };
    c.attempts = 0;
    variants.push(c);
  }
  const fixture = join(dir, 'idempotency-header-sources.json');
  writeFileSync(fixture, JSON.stringify(variants));
  assert.deepEqual(
    (await validateFixtures(output, fixture)).map((r) => r.scenarios),
    [5, 5],
  );
});
