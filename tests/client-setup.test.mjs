import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { loadContract, generate, preview, compare } from '../dist/index.js';
import { compileSdkContract } from '../dist/target-plan.js';
import { assertRuntimePlan } from '../dist/runtime-plan.js';
import { compareCompiledContracts } from '../dist/compiled-compatibility.js';
import { storeCompiledSnapshot, restoreCompiledSnapshot } from '../dist/compiled-record.js';

const dir = mkdtempSync(join(tmpdir(), 'sdk-client-setup-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const operation = (id, security) => ({
  get: { operationId: id, security, responses: { 204: { description: 'OK' } } },
});
const api = {
  openapi: '3.1.0',
  info: { title: 'Setup', version: '1' },
  servers: [
    { url: 'https://first.example.invalid/v1' },
    { url: 'https://second.example.invalid/sandbox' },
  ],
  components: {
    securitySchemes: {
      Merchant: { type: 'http', scheme: 'bearer' },
      Key: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
      Customer: { type: 'http', scheme: 'bearer' },
      Onboarding: { type: 'http', scheme: 'bearer' },
      Invoice: { type: 'http', scheme: 'bearer' },
      ID: { type: 'apiKey', in: 'header', name: 'X-Checkout-ID' },
      Secret: { type: 'apiKey', in: 'header', name: 'X-Checkout-Secret' },
    },
  },
  paths: {
    '/merchant': operation('merchant', [{ Merchant: [] }, { Key: [] }]),
    '/customer': operation('customer', [{ Customer: [] }]),
    '/onboarding': operation('onboarding', [{ Onboarding: [] }]),
    '/invoice': operation('invoice', [{ Invoice: [] }]),
    '/checkout': operation('checkout', [{ ID: [], Secret: [] }]),
    '/health': operation('health', []),
  },
};
const config = {
  version: '1.0.0',
  npm: { name: '@example/setup' },
  composer: { name: 'example/setup', namespace: 'Example\\Setup' },
  requests: { style: 'object' },
  operations: Object.fromEntries(
    Object.keys(api.paths).map((path) => [
      path.slice(1),
      { resource: 'api', method: path.slice(1) },
    ]),
  ),
  auth: {
    modes: {
      merchant: { schemes: ['Merchant'] },
      merchantKey: { schemes: ['Key'] },
      customer: { schemes: ['Customer'] },
      onboarding: { schemes: ['Onboarding'] },
      invoice: { schemes: ['Invoice'] },
      checkout: { schemes: ['ID', 'Secret'] },
    },
    shortcuts: {
      token: { mode: 'merchant', scheme: 'Merchant' },
      apiKey: { mode: 'merchantKey', scheme: 'Key' },
      customerToken: { mode: 'customer', scheme: 'Customer' },
      onboardingToken: { mode: 'onboarding', scheme: 'Onboarding' },
      invoiceToken: { mode: 'invoice', scheme: 'Invoice' },
    },
  },
};
function load(spec = api, settings = config) {
  writeFileSync(join(dir, 'api.json'), JSON.stringify(spec));
  writeFileSync(join(dir, 'sdk.json'), JSON.stringify(settings));
  return loadContract(join(dir, 'api.json'), join(dir, 'sdk.json'));
}
const contract = load();
const output = join(dir, 'mapped');
generate(contract, output);
const { Client } = await import(pathToFileURL(join(output, 'node/index.js')).href);
const unmappedConfig = structuredClone(config);
delete unmappedConfig.auth.shortcuts.token;
const unmapped = join(dir, 'unmapped');
generate(load(api, unmappedConfig), unmapped);
const noDefault = join(dir, 'no-default');
generate(load({ ...api, servers: [] }), noDefault);

// These exact wire expectations are independent of the generated descriptors.
const cases = [
  {
    name: 'default and merchant token',
    options: { token: 'merchant-value' },
    operation: 'merchant',
    url: 'https://first.example.invalid/v1/merchant',
    headers: { authorization: 'Bearer merchant-value' },
  },
  {
    name: 'explicit override retains path',
    options: { baseUrl: 'https://override.example.invalid/prefix/', apiKey: 'key-value' },
    operation: 'merchant',
    url: 'https://override.example.invalid/prefix/merchant',
    headers: { 'x-api-key': 'key-value' },
  },
  ...['customer', 'onboarding', 'invoice'].map((mode) => ({
    name: mode,
    options: { [mode + 'Token']: mode + '-value' },
    operation: mode,
    url: `https://first.example.invalid/v1/${mode}`,
    headers: { authorization: `Bearer ${mode}-value` },
  })),
  {
    name: 'request token overrides key',
    options: { apiKey: 'client-key' },
    request: { token: 'request-value' },
    operation: 'merchant',
    url: 'https://first.example.invalid/v1/merchant',
    headers: { authorization: 'Bearer request-value' },
  },
  {
    name: 'explicit request overrides token',
    options: { token: 'client-token' },
    request: { authMode: 'customer', credentials: { Customer: 'explicit-value' } },
    operation: 'customer',
    url: 'https://first.example.invalid/v1/customer',
    headers: { authorization: 'Bearer explicit-value' },
  },
  {
    name: 'anonymous omits client auth',
    options: { token: 'client-token' },
    operation: 'health',
    url: 'https://first.example.invalid/v1/health',
    headers: {},
  },
  {
    name: 'checkout remains complete',
    options: {
      authMode: 'checkout',
      credentials: { checkout: { ID: 'id-value', Secret: 'secret-value' } },
    },
    operation: 'checkout',
    url: 'https://first.example.invalid/v1/checkout',
    headers: { 'x-checkout-id': 'id-value', 'x-checkout-secret': 'secret-value' },
  },
  {
    name: 'localhost opt-in',
    options: { baseUrl: 'http://localhost:9123/test', allowInsecureHttp: true },
    operation: 'health',
    url: 'http://localhost:9123/test/health',
    headers: {},
  },
  ...[
    [{ token: 'one', apiKey: 'two' }, {}, 'merchant', 'shortcut'],
    [{ token: 'one', authMode: 'merchant' }, {}, 'merchant', 'shortcut'],
    [{ token: 'one', credentials: { merchant: { Merchant: 'two' } } }, {}, 'merchant', 'shortcut'],
    [{ token: 'one' }, { token: 'two', authMode: 'merchant' }, 'merchant', 'shortcut'],
    [{ token: 'one' }, { token: 'two', apiKey: 'three' }, 'merchant', 'shortcut'],
    [{ token: 'one' }, {}, 'customer', 'not permitted'],
    [{ token: '' }, {}, 'merchant', 'Missing or invalid'],
    [
      { authMode: 'checkout', credentials: { checkout: { ID: 'id' } } },
      {},
      'checkout',
      'Missing or invalid',
    ],
  ].map(([options, request, operation, message], i) => ({
    name: `invalid auth ${i}`,
    options,
    request,
    operation,
    error: 'authentication',
    message,
  })),
  ...[
    '',
    'relative',
    'https://',
    'https://example.invalid/?q=1',
    'https://example.invalid/#',
    'https://hidden:password@example.invalid',
    'https://@example.invalid',
    'https://:@example.invalid',
    'https:///example.invalid',
    'https://example.invalid/\\path',
    'https://example.invalid/\npath',
  ].map((baseUrl) => ({
    name: 'invalid base URL',
    options: { baseUrl },
    operation: 'health',
    error: 'validation',
    message: 'baseUrl',
  })),
  {
    name: 'HTTP needs opt-in',
    options: { baseUrl: 'http://localhost' },
    operation: 'health',
    error: 'destination',
    message: 'allowInsecureHttp: true',
  },
  {
    name: 'unsupported protocol',
    options: { baseUrl: 'ftp://example.invalid' },
    operation: 'health',
    error: 'destination',
    message: 'Unsupported destination protocol',
  },
  {
    name: 'explicit origins restrict default',
    options: { allowedOrigins: ['https://other.example.invalid'] },
    operation: 'health',
    error: 'destination',
    message: 'allowedOrigins',
  },
];
function authHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers).filter(([key]) =>
      ['authorization', 'x-api-key', 'x-checkout-id', 'x-checkout-secret'].includes(key),
    ),
  );
}
function phpCases(out, rows) {
  const file = join(dir, 'cases.json');
  writeFileSync(file, JSON.stringify(rows));
  const script = String.raw`
require $argv[1].'/src/Runtime.php'; require $argv[1].'/src/Client.php';
use Example\Setup\{Client,ClientOptions,RequestOptions,SdkError};
foreach(json_decode(file_get_contents($argv[2]),true) as $case) {
  $sent=0;
  try {
    $o=$case['options']??[];
    $o['transport']=function($r)use(&$sent,$case){
      $sent++;
      if($r['url']!==$case['url'])throw new Exception('wrong URL: '.$case['name']);
      $headers=array_intersect_key($r['headers'],array_flip(['authorization','x-api-key','x-checkout-id','x-checkout-secret']));
      if($headers!=($case['headers']??[]))throw new Exception('wrong auth: '.$case['name']);
      return ['status'=>204,'headers'=>[],'body'=>''];
    };
    $client=new Client(new ClientOptions(...$o));
    $request=new RequestOptions(...($case['request']??[]));
    // Exercises forwarding of token through pagination/polling deadline copies.
    $client->api->{$case['operation']}(options:$request->withDeadline(10000));
    if(isset($case['error']))throw new Exception('accepted invalid setup: '.$case['name']);
    if($sent!==1)throw new Exception('missing dispatch');
    $client->close();
  } catch(SdkError $e) {
    if(($case['error']??null)!==$e->kind || !str_contains($e->getMessage(),$case['message']) || $sent!==0 || $e->outcome!=='not_sent')throw $e;
    if(str_contains($e->getMessage(),'password'))throw new Exception('leaked URL');
  }
}
echo 'ok';`;
  assert.equal(
    execFileSync('php', ['-r', script, join(out, 'php'), file], { encoding: 'utf8' }),
    'ok',
  );
}

test('generated Node and PHP setup has independent destination and credential expectations', async () => {
  for (const row of cases) {
    let sent = 0;
    const run = async () => {
      const client = new Client({
        ...row.options,
        transport: async (url, init) => {
          sent++;
          assert.equal(url.href, row.url, row.name);
          assert.deepEqual(authHeaders(init.headers), row.headers, row.name);
          return new Response(null, { status: 204 });
        },
      });
      await client.api[row.operation]({}, row.request ?? {});
    };
    if (row.error)
      await assert.rejects(
        run,
        (error) =>
          error.kind === row.error &&
          error.message.includes(row.message) &&
          error.outcome === 'not_sent' &&
          !error.message.includes('password'),
        row.name,
      );
    else await run();
    assert.equal(sent, row.error ? 0 : 1, row.name);
  }
  phpCases(output, cases);
});

test('omitted defaults and unmapped tokens fail clearly in both targets', async () => {
  const NoDefault = (await import(pathToFileURL(join(noDefault, 'node/index.js')).href)).Client;
  assert.throws(
    () => new NoDefault(),
    (e) => e.kind === 'validation' && /baseUrl.*no default/.test(e.message),
  );
  for (const value of [null, [], 'options'])
    assert.throws(
      () => new Client(value),
      (e) => e.kind === 'validation' && /options/.test(e.message),
    );
  for (const value of [null, 123, {}])
    assert.throws(
      () => new Client({ baseUrl: value }),
      (e) => e.kind === 'validation' && /baseUrl/.test(e.message),
    );
  const Unmapped = (await import(pathToFileURL(join(unmapped, 'node/index.js')).href)).Client;
  assert.throws(
    () => new Unmapped({ token: 'hidden-token' }),
    (e) =>
      e.kind === 'authentication' &&
      /token.*apiKey/.test(e.message) &&
      !e.message.includes('hidden-token'),
  );
  phpCases(noDefault, [
    { name: 'no default', operation: 'health', error: 'validation', message: 'baseUrl: required' },
  ]);
  phpCases(unmapped, [
    {
      name: 'unmapped token',
      options: { token: 'hidden-token' },
      operation: 'health',
      error: 'authentication',
      message: 'token is not configured',
    },
  ]);
  assert.doesNotThrow(() => new Client());
  assert.equal(
    execFileSync(
      'php',
      [
        '-r',
        String.raw`require $argv[1].'/src/Runtime.php';require $argv[1].'/src/Client.php';new Example\Setup\Client();new Example\Setup\Client(new Example\Setup\ClientOptions('https://example.invalid','legacy-position'));echo 'ok';`,
        join(output, 'php'),
      ],
      { encoding: 'utf8' },
    ),
    'ok',
  );
});

test('server declarations diagnose unsupported routing and preserve source order', () => {
  assert.equal(contract.defaultBaseUrl, 'https://first.example.invalid/v1');
  assert.equal(load({ ...api, servers: [] }).defaultBaseUrl, undefined);
  const missing = structuredClone(api);
  delete missing.servers;
  assert.equal(load(missing).defaultBaseUrl, undefined);
  for (const servers of [
    null,
    {},
    [{}],
    [{ url: '/v1' }],
    [{ url: 'https://{region}.example.invalid' }],
    [{ url: 'https://example.invalid?key=hidden' }],
    [{ url: 'https://secret@example.invalid' }],
    [{ url: 'https://@example.invalid' }],
    [{ url: 'https://:@example.invalid' }],
    [{ url: 'https:///example.invalid' }],
    [{ url: 'file:///tmp/api' }],
    [{ url: 'bad' }, api.servers[0]],
  ]) {
    assert.throws(() => load({ ...api, servers }), /\/servers/);
  }
  for (const location of ['path', 'operation']) {
    const spec = structuredClone(api);
    (location === 'path' ? spec.paths['/health'] : spec.paths['/health'].get).servers = [
      { url: 'https://other.example.invalid' },
    ];
    assert.throws(() => load(spec), /\/paths\/\/health.*servers/);
  }
  assert.throws(
    () =>
      load(api, {
        ...config,
        auth: { ...config.auth, shortcuts: { token: { mode: 'checkout', scheme: 'ID' } } },
      }),
    /sole scheme/,
  );
  assert.throws(
    () =>
      load(api, {
        ...config,
        auth: { ...config.auth, shortcuts: { Token: { mode: 'merchant', scheme: 'Merchant' } } },
      }),
    /shortcut name/,
  );
});

test('defaults and token mappings survive records and produce compatibility findings', () => {
  const snapshot = restoreCompiledSnapshot(
    JSON.parse(readFileSync(join(output, '.sdk-generator.json'))).compiled,
  );
  const restored = restoreCompiledSnapshot(
    JSON.parse(JSON.stringify(storeCompiledSnapshot(snapshot))),
  ).plan;
  assert.equal(restored.runtime.defaultBaseUrl, contract.defaultBaseUrl);
  assert.deepEqual(restored.runtime.authShortcuts.token, { mode: 'merchant', scheme: 'Merchant' });
  assertRuntimePlan(restored.runtime);
  const historical = structuredClone(snapshot);
  delete historical.plan.node.clientOptions;
  delete historical.plan.runtime.defaultBaseUrl;
  delete historical.plan.php.runtime.defaultBaseUrl;
  assert.doesNotThrow(() => restoreCompiledSnapshot(storeCompiledSnapshot(historical)));
  const malformed = structuredClone(snapshot);
  malformed.plan.node.clientOptions.optional = 'yes';
  assert.throws(
    () => restoreCompiledSnapshot(storeCompiledSnapshot(malformed)),
    /node.clientOptions/,
  );
  for (const defaultBaseUrl of [
    null,
    123,
    '/relative',
    'https://{host}',
    'http://user:password@example.invalid',
  ]) {
    assert.throws(
      () => assertRuntimePlan({ ...restored.runtime, defaultBaseUrl }),
      /defaultBaseUrl/,
    );
  }
  const before = load({ ...api, servers: [] });
  const changed = load({ ...api, servers: api.servers.slice().reverse() });
  for (const [left, right, severity] of [
    [before, contract, 'additive'],
    [contract, before, 'breaking'],
    [contract, changed, 'breaking'],
  ]) {
    const findings = compare(left, right);
    assert.ok(findings.some((f) => f.subject === 'defaultBaseUrl' && f.severity === severity));
    if (severity === 'additive') assert.ok(!findings.some((f) => f.severity === 'breaking'));
    assert.ok(
      compareCompiledContracts(compileSdkContract(left).plan, compileSdkContract(right).plan).some(
        (f) => f.subject === 'defaultBaseUrl' && f.severity === severity,
      ),
    );
  }
  const record = JSON.parse(readFileSync(join(output, '.sdk-generator.json')));
  assert.equal(record.interface.defaultBaseUrl, contract.defaultBaseUrl);
  assert.deepEqual(
    preview(contract, output).changes.filter((c) => c.status !== 'unchanged'),
    [],
  );
});

test('consumer types allow defaults and configured token only where supported', () => {
  const file = join(dir, 'consumer.mts');
  writeFileSync(
    file,
    `import {Client} from './mapped/node/index.js';
import {Client as NoDefault} from './no-default/node/index.js';
import {Client as Unmapped} from './unmapped/node/index.js';
const c=new Client({token:'value'}); new Client();
c.api.merchant({}, {token:'request'});
// @ts-expect-error merchant token is not allowed on customer endpoints
c.api.customer({}, {token:'request'});
// @ts-expect-error baseUrl is required without a default
new NoDefault({token:'value'});
// @ts-expect-error options are required without a default
new NoDefault();
new NoDefault({baseUrl:'https://example.invalid',token:'value'});
// @ts-expect-error composed client has no token mapping
new Unmapped({token:'value'});
`,
  );
  execFileSync(process.execPath, [
    'node_modules/typescript/bin/tsc',
    '--noEmit',
    '--strict',
    '--skipLibCheck',
    '--module',
    'NodeNext',
    '--target',
    'ES2022',
    '--typeRoots',
    join(process.cwd(), 'node_modules/@types'),
    file,
  ]);
});

test('examples prefer permitted token shortcuts and never invent a sandbox URL', () => {
  for (const target of ['node', 'php']) {
    const ext = target === 'node' ? 'mjs' : 'php';
    const example = readFileSync(join(output, target, `examples/api-merchant.${ext}`), 'utf8');
    assert.match(example, /API_TOKEN/);
    assert.match(example, /first\.example\.invalid\/v1/);
    assert.doesNotMatch(example, /API_MERCHANT_|sandbox\.example\.invalid|authMode:/);
    const missing = readFileSync(join(noDefault, target, `examples/api-health.${ext}`), 'utf8');
    assert.match(missing, /Set API_BASE_URL: this SDK has no default server/);
    assert.doesNotMatch(missing, /sandbox\.example\.invalid/);
  }
});

test('mapped token overrides stay request-local on reused clients in both targets', async () => {
  const seen = [];
  const client = new Client({
    apiKey: 'client-key',
    transport: async (_url, request) => {
      seen.push(authHeaders(request.headers));
      return new Response(null, { status: 204 });
    },
  });
  await Promise.all([
    client.api.merchant({}, { token: 'first' }),
    client.api.merchant({}, { token: 'second' }),
    client.api.merchant(),
    client.api.health(),
  ]);
  assert.deepEqual(seen, [
    { authorization: 'Bearer first' },
    { authorization: 'Bearer second' },
    { 'x-api-key': 'client-key' },
    {},
  ]);
  const script = String.raw`
require $argv[1].'/src/Runtime.php';require $argv[1].'/src/Client.php';
use Example\Setup\{Client,ClientOptions,RequestOptions};
$seen=[];
$c=new Client(new ClientOptions(apiKey:'client-key',transport:function($r)use(&$seen){$seen[]=array_intersect_key($r['headers'],array_flip(['authorization','x-api-key']));return ['status'=>204,'headers'=>[],'body'=>''];}));
$c->api->merchant(options:new RequestOptions(token:'first'));
$c->api->merchant(options:new RequestOptions(token:'second'));
$c->api->merchant();$c->api->health();
if($seen!==[['authorization'=>'Bearer first'],['authorization'=>'Bearer second'],['x-api-key'=>'client-key'],[]])throw new Exception('credential isolation failed');
$c->close();echo 'ok';`;
  assert.equal(
    execFileSync('php', ['-r', script, join(output, 'php')], { encoding: 'utf8' }),
    'ok',
  );
});

test('PHP rejects malformed serialized server defaults and reserved shortcut names', () => {
  const script = String.raw`
require $argv[1].'/src/Runtime.php';
use Example\Setup\{Runtime,ClientOptions};
$plan=Example\Setup\SchemaRegistry::contract();
foreach([null,123,'/relative','https://{host}','http://user:password@example.invalid','https://example.invalid/'.chr(255)] as $url){
 $bad=$plan;$bad['defaultBaseUrl']=$url;
 try{new Runtime($bad,new ClientOptions(),true);throw new Exception('accepted invalid default');}
 catch(InvalidArgumentException $e){if(!str_contains($e->getMessage(),'defaultBaseUrl'))throw $e;}
}
$plan['authShortcuts']['baseUrl']=['mode'=>'merchant','scheme'=>'Merchant'];
try{new Runtime($plan,new ClientOptions(),true);throw new Exception('accepted reserved shortcut');}
catch(InvalidArgumentException $e){if(!str_contains($e->getMessage(),'shortcut'))throw $e;}
echo 'ok';`;
  assert.equal(
    execFileSync('php', ['-r', script, join(output, 'php')], { encoding: 'utf8' }),
    'ok',
  );
});

test('an API with no authentication supports defaults and still requires HTTP opt-in', async () => {
  const settings = structuredClone(config);
  delete settings.auth;
  settings.operations = { health: config.operations.health };
  const anonymous = join(dir, 'anonymous');
  generate(
    load({ ...api, components: {}, paths: { '/health': api.paths['/health'] } }, settings),
    anonymous,
  );
  const Anonymous = (await import(pathToFileURL(join(anonymous, 'node/index.js')).href)).Client;
  assert.doesNotThrow(() => new Anonymous());
  assert.throws(
    () => new Anonymous({ baseUrl: 'http://localhost' }),
    (e) => e.kind === 'destination' && /allowInsecureHttp/.test(e.message),
  );
  const row = cases.find((row) => row.name === 'localhost opt-in');
  phpCases(anonymous, [row, cases.find((row) => row.name === 'HTTP needs opt-in')]);
  let sent = 0;
  await new Anonymous({
    ...row.options,
    transport: async (url) => {
      assert.equal(url.href, row.url);
      sent++;
      return new Response(null, { status: 204 });
    },
  }).api.health();
  assert.equal(sent, 1);
  const file = join(anonymous, 'node/consumer.mts');
  writeFileSync(file, "import {Client} from './index.js'; new Client(); new Client({});");
  execFileSync(process.execPath, [
    'node_modules/typescript/bin/tsc',
    '--noEmit',
    '--strict',
    '--skipLibCheck',
    '--module',
    'NodeNext',
    '--target',
    'ES2022',
    '--typeRoots',
    join(process.cwd(), 'node_modules/@types'),
    file,
  ]);
});
