import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { loadContract, generate, validateFixtures } from '../dist/index.js';
const dir = mkdtempSync(join(tmpdir(), 'sdk-auth-modes-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const operation = (operationId, security) => ({
  get: { operationId, security, responses: { 204: { description: 'OK' } } },
});
const api = {
  openapi: '3.1.0',
  info: { title: 'Modes', version: 'v1' },
  components: {
    securitySchemes: {
      Merchant: { type: 'http', scheme: 'bearer' },
      Customer: { type: 'http', scheme: 'bearer' },
      Onboarding: { type: 'http', scheme: 'bearer' },
      CheckoutID: { type: 'apiKey', in: 'header', name: 'X-Checkout-ID' },
      CheckoutSecret: { type: 'apiKey', in: 'header', name: 'X-Checkout-Secret' },
    },
  },
  paths: {
    '/merchant': operation('merchantCall', [{ Merchant: [] }]),
    '/customer': operation('customerCall', [{ Customer: [] }]),
    '/onboarding': operation('onboardingCall', [{ Onboarding: [] }]),
    '/checkout': operation('checkoutCall', [
      { Merchant: [] },
      { CheckoutID: [], CheckoutSecret: [] },
    ]),
    '/health': operation('health', []),
  },
};
const config = {
  version: '1.0.0',
  npm: { name: '@example/modes' },
  composer: { name: 'example/modes', namespace: 'Example\\Modes' },
  auth: {
    modes: {
      merchant: { schemes: ['Merchant'] },
      customer: { schemes: ['Customer'] },
      onboarding: { schemes: ['Onboarding'] },
      checkout: { schemes: ['CheckoutID', 'CheckoutSecret'] },
    },
  },
};
function load(settings = config) {
  writeFileSync(join(dir, 'api.json'), JSON.stringify(api));
  writeFileSync(join(dir, 'sdk.json'), JSON.stringify(settings));
  return loadContract(join(dir, 'api.json'), join(dir, 'sdk.json'));
}
const out = join(dir, 'out');
generate(load(), out);
test('named authentication modes send one complete credential alternative in both clients', async () => {
  const valid = (mode, credentials, operation, path, headers, absentHeaders) => ({
    name: mode + ' ' + operation,
    operation,
    input: {},
    options: { authMode: mode, credentials },
    expected: { method: 'GET', path, headers, absentHeaders },
    responses: [{ status: 204 }],
    empty: true,
  });
  const invalid = (name, options) => ({
    name,
    operation: 'checkoutCall',
    input: {},
    options,
    responses: [],
    attempts: 0,
    error: { kind: 'authentication' },
  });
  const cases = [
    valid(
      'merchant',
      { Merchant: 'merchant-token' },
      'merchantCall',
      '/v1/merchant',
      { authorization: 'Bearer merchant-token' },
      ['x-checkout-id', 'x-checkout-secret'],
    ),
    valid(
      'customer',
      { Customer: 'customer-token' },
      'customerCall',
      '/v1/customer',
      { authorization: 'Bearer customer-token' },
      ['x-checkout-id', 'x-checkout-secret'],
    ),
    valid(
      'onboarding',
      { Onboarding: 'onboarding-token' },
      'onboardingCall',
      '/v1/onboarding',
      { authorization: 'Bearer onboarding-token' },
      ['x-checkout-id', 'x-checkout-secret'],
    ),
    valid(
      'checkout',
      { CheckoutID: 'session-id', CheckoutSecret: 'session-secret' },
      'checkoutCall',
      '/v1/checkout',
      { 'x-checkout-id': 'session-id', 'x-checkout-secret': 'session-secret' },
      ['authorization'],
    ),
    valid(
      'merchant',
      { Merchant: 'merchant-fallback' },
      'checkoutCall',
      '/v1/checkout',
      { authorization: 'Bearer merchant-fallback' },
      ['x-checkout-id', 'x-checkout-secret'],
    ),
    invalid('missing ID', { authMode: 'checkout', credentials: { CheckoutSecret: 'secret' } }),
    invalid('missing secret', { authMode: 'checkout', credentials: { CheckoutID: 'id' } }),
    invalid('inapplicable mode', { authMode: 'customer', credentials: { Customer: 'token' } }),
    invalid('ambiguous mode', {}),
    invalid('contradictory header', {
      authMode: 'merchant',
      credentials: { Merchant: 'token' },
      headers: { Authorization: 'Bearer other' },
    }),
    {
      name: 'anonymous',
      operation: 'health',
      input: {},
      expected: {
        method: 'GET',
        path: '/v1/health',
        absentHeaders: ['authorization', 'x-checkout-id', 'x-checkout-secret'],
      },
      responses: [{ status: 204 }],
      empty: true,
    },
  ];
  writeFileSync(join(dir, 'cases.json'), JSON.stringify(cases));
  assert.deepEqual(
    (await validateFixtures(out, join(dir, 'cases.json'))).map((result) => result.scenarios),
    [11, 11],
  );
});
test('concurrent Node requests keep selected credentials local and anonymous calls omit client defaults', async () => {
  const { Client } = await import(pathToFileURL(join(out, 'node/index.js')).href);
  const seen = [];
  const client = new Client({
    baseUrl: 'https://example.invalid',
    authMode: 'merchant',
    credentials: { merchant: { Merchant: 'default-token' } },
    transport: async (url, init) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      seen.push([url.pathname, init.headers.authorization, init.headers['x-checkout-id']]);
      return new Response(null, { status: 204 });
    },
  });
  await Promise.all([
    client.api.checkoutCall(
      {},
      { authMode: 'checkout', credentials: { CheckoutID: 'id', CheckoutSecret: 'secret' } },
    ),
    client.api.merchantCall(),
    client.api.health(),
  ]);
  assert.deepEqual(seen.sort(), [
    ['/checkout', undefined, 'id'],
    ['/health', undefined, undefined],
    ['/merchant', 'Bearer default-token', undefined],
  ]);
});
test('combined header conflicts and stale role bindings fail diagnosis', () => {
  assert.throws(
    () =>
      load({ ...config, auth: { modes: { collision: { schemes: ['Merchant', 'Customer'] } } } }),
    /conflicting header/,
  );
  assert.throws(
    () =>
      load({
        ...config,
        auth: {
          modes: {
            ...config.auth.modes,
            merchant: { schemes: ['Merchant'], operations: ['missing'] },
          },
        },
      }),
    /not a supported standalone|unknown operation binding/,
  );
});

test('local profiles compose operation unions and named modes without duplicate methods', () => {
  load();
  const groups = {
    merchant: ['merchantCall', 'checkoutCall', 'health'],
    customer: ['customerCall'],
    onboarding: ['onboardingCall'],
    checkout: ['checkoutCall'],
  };
  const profiles = Object.entries(groups).map(([name, include]) => {
    const file = name + '.sdk.json';
    writeFileSync(
      join(dir, file),
      JSON.stringify({ ...config, include, auth: { modes: { [name]: config.auth.modes[name] } } }),
    );
    return file;
  });
  writeFileSync(join(dir, 'combined.json'), JSON.stringify({ profiles }));
  const contract = loadContract(join(dir, 'api.json'), join(dir, 'combined.json'));
  assert.equal(contract.operations.length, 5);
  assert.deepEqual(contract.operations.find((op) => op.id === 'checkoutCall').authModes, [
    'merchant',
    'checkout',
  ]);
  assert.equal(Object.keys(contract.authentication).length, 4);
  writeFileSync(
    join(dir, 'conflict.json'),
    JSON.stringify({ profiles, models: { Sample: 'Second' } }),
  );
  const first = JSON.parse(readFileSync(join(dir, profiles[0]), 'utf8'));
  first.models = { Sample: 'First' };
  writeFileSync(join(dir, profiles[0]), JSON.stringify(first));
  assert.throws(
    () => loadContract(join(dir, 'api.json'), join(dir, 'conflict.json')),
    /config\/models\/Sample.*conflicting/,
  );
  writeFileSync(join(dir, 'cycle.json'), JSON.stringify({ profiles: ['cycle.json'] }));
  assert.throws(
    () => loadContract(join(dir, 'api.json'), join(dir, 'cycle.json')),
    /profile reference cycle/,
  );
});

test('an unbounded referenced profile keeps the composed operation selection unbounded', () => {
  load();
  writeFileSync(join(dir, 'unbounded.json'), JSON.stringify(config));
  writeFileSync(
    join(dir, 'bounded.json'),
    JSON.stringify({ ...config, include: ['merchantCall'] }),
  );
  writeFileSync(
    join(dir, 'unbounded-combined.json'),
    JSON.stringify({ profiles: ['bounded.json', 'unbounded.json'] }),
  );
  assert.equal(
    loadContract(join(dir, 'api.json'), join(dir, 'unbounded-combined.json')).operations.length,
    5,
  );
});

test('PHP reuses one client across credential modes without retaining prior headers', async () => {
  const { execFileSync } = await import('node:child_process');
  const contract = load();
  const output = join(dir, 'php-sequential');
  generate(contract, output);
  writeFileSync(
    join(dir, 'sequential.php'),
    `<?php
require ${JSON.stringify(join(output, 'php/src/Runtime.php'))};
require ${JSON.stringify(join(output, 'php/src/Client.php'))};
use Example\\Modes\\{Client,ClientOptions,RequestOptions};
$seen=[];
$c=new Client(new ClientOptions(baseUrl:'https://example.invalid',transport:function($r)use(&$seen){$seen[]=$r['headers'];return ['status'=>204,'headers'=>[],'body'=>''];},credentials:['merchant'=>['Merchant'=>'merchant-token'],'checkout'=>['CheckoutID'=>'cs_test','CheckoutSecret'=>'secret-test']]));
$c->api->checkoutCall(options:new RequestOptions(authMode:'checkout'));
$c->api->checkoutCall(options:new RequestOptions(authMode:'merchant'));
$c->api->health();
if(isset($seen[0]['authorization'])||$seen[0]['x-checkout-id']!=='cs_test'||$seen[0]['x-checkout-secret']!=='secret-test')throw new Exception('checkout headers');
if($seen[1]['authorization']!=='Bearer merchant-token'||isset($seen[1]['x-checkout-id'])||isset($seen[1]['x-checkout-secret']))throw new Exception('retained checkout headers');
if(isset($seen[2]['authorization'])||isset($seen[2]['x-checkout-id'])||isset($seen[2]['x-checkout-secret']))throw new Exception('anonymous headers');
$c->close();echo 'ok';
`,
  );
  assert.equal(execFileSync('php', [join(dir, 'sequential.php')], { encoding: 'utf8' }), 'ok');
});

test('configured shortcuts preserve request isolation and explicit modes in Node and PHP', async () => {
  const { execFileSync } = await import('node:child_process');
  const settings = {
    ...config,
    auth: {
      ...config.auth,
      shortcuts: {
        apiKey: { mode: 'merchant', scheme: 'Merchant' },
        apiToken: { mode: 'customer', scheme: 'Customer' },
      },
    },
  };
  const output = join(dir, 'shortcuts');
  generate(load(settings), output);
  const { Client } = await import(pathToFileURL(join(output, 'node/index.js')).href);
  const seen = [];
  const client = new Client({
    baseUrl: 'https://example.invalid',
    apiKey: 'default',
    transport: async (url, init) => {
      seen.push([url.pathname, init.headers.authorization, init.headers['x-checkout-id']]);
      return new Response(null, { status: 204 });
    },
  });
  await Promise.all([
    client.api.checkoutCall({}, { apiKey: 'override' }),
    client.api.checkoutCall(
      {},
      { authMode: 'checkout', credentials: { CheckoutID: 'id', CheckoutSecret: 'secret' } },
    ),
    client.api.customerCall({}, { apiToken: 'customer' }),
    client.api.merchantCall(),
    client.api.health(),
  ]);
  assert.deepEqual(seen, [
    ['/checkout', 'Bearer override', undefined],
    ['/checkout', undefined, 'id'],
    ['/customer', 'Bearer customer', undefined],
    ['/merchant', 'Bearer default', undefined],
    ['/health', undefined, undefined],
  ]);
  for (const options of [
    { apiKey: 'x', authMode: 'merchant' },
    { apiKey: 'x', credentials: { Merchant: 'x' } },
    { apiKey: 'x', apiToken: 'y' },
    { apiKey: '' },
    { apiKey: 'x\r\ny' },
  ])
    await assert.rejects(client.api.checkoutCall({}, options), { kind: 'authentication' });
  await assert.rejects(client.api.customerCall(), /not permitted/);
  await assert.rejects(client.api.health({}, { apiKey: 'x' }), /not permitted/);
  assert.equal(seen.length, 5);
  await assert.rejects(
    new Client({
      baseUrl: 'https://example.invalid',
      apiKey: 'x',
      authMode: 'merchant',
    }).api.merchantCall(),
    /shortcut/,
  );
  await assert.rejects(
    new Client({
      baseUrl: 'https://example.invalid',
      apiKey: 'x',
      credentials: { merchant: { Merchant: 'y' } },
    }).api.merchantCall(),
    /shortcut/,
  );

  const phpFile = join(dir, 'shortcuts.php');
  writeFileSync(
    phpFile,
    `<?php
require ${JSON.stringify(join(output, 'php/src/Runtime.php'))}; require ${JSON.stringify(join(output, 'php/src/Client.php'))};
use Example\\Modes\\{Client,ClientOptions,RequestOptions,SdkError};
$seen=[];
$c=new Client(new ClientOptions(baseUrl:'https://example.invalid',apiKey:'default',transport:function($r)use(&$seen){$seen[]=$r['headers'];return ['status'=>204,'headers'=>[],'body'=>''];}));
$c->api->checkoutCall(options:(new RequestOptions(apiKey:'override'))->withDeadline(1000));
$c->api->checkoutCall(options:new RequestOptions(authMode:'checkout',credentials:['CheckoutID'=>'id','CheckoutSecret'=>'secret']));
$c->api->customerCall(options:new RequestOptions(apiToken:'customer'));
$c->api->merchantCall(); $c->api->health();
if($seen[0]['authorization']!=='Bearer override'||$seen[1]['x-checkout-id']!=='id'||isset($seen[1]['authorization'])||$seen[2]['authorization']!=='Bearer customer'||$seen[3]['authorization']!=='Bearer default'||isset($seen[4]['authorization']))throw new Exception('headers');
foreach([new RequestOptions(apiKey:'x',authMode:'merchant'),new RequestOptions(apiKey:'x',credentials:['Merchant'=>'x']),new RequestOptions(apiKey:'x',apiToken:'y'),new RequestOptions(apiKey:'')] as $o){try{$c->api->checkoutCall(options:$o);throw new Exception('accepted invalid auth');}catch(SdkError $e){if($e->kind!=='authentication')throw $e;}}
ob_start();var_dump(new RequestOptions(apiKey:'secret-value'),new ClientOptions(baseUrl:'https://example.invalid',apiKey:'secret-value'));$debug=ob_get_clean();if(str_contains($debug,'secret-value'))throw new Exception('secret leaked');
if(count($seen)!==5)throw new Exception('dispatched invalid request');
$c->close();echo 'ok';`,
  );
  assert.equal(execFileSync('php', [phpFile], { encoding: 'utf8' }), 'ok');
  assert.match(readFileSync(join(output, 'node/index.d.ts'), 'utf8'), /"apiKey"\?: string/);
  const types = join(output, 'node/shortcuts.mts');
  writeFileSync(
    types,
    `import { Client } from './index.js';
const c = new Client({baseUrl:'https://example.invalid',apiKey:'default'});
c.api.checkoutCall({}, {apiKey:'override'});
c.api.customerCall({}, {apiToken:'customer'});
// @ts-expect-error merchant shortcut is not permitted on customer endpoints
c.api.customerCall({}, {apiKey:'merchant'});
// @ts-expect-error unknown shortcut
new Client({baseUrl:'https://example.invalid',accessKey:'x'});
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
    types,
  ]);
  assert.match(readFileSync(join(output, 'node/README.md'), 'utf8'), /apiKey:/);
  const { compileSdkContract } = await import('../dist/target-plan.js');
  const { assertRuntimePlan } = await import('../dist/runtime-plan.js');
  const { plan } = compileSdkContract(load(settings));
  const restored = JSON.parse(JSON.stringify(plan.runtime));
  assert.deepEqual(restored.authShortcuts, settings.auth.shortcuts);
  assertRuntimePlan(restored);
  restored.authShortcuts.apiKey.scheme = 'Customer';
  assert.throws(() => assertRuntimePlan(restored), /shortcut/);
});

test('shortcut configuration rejects unknown targets, combined credentials and option collisions', () => {
  for (const shortcuts of [
    { apiKey: { mode: 'missing', scheme: 'Merchant' } },
    { apiKey: { mode: 'merchant', scheme: 'Customer' } },
    { apiKey: { mode: 'checkout', scheme: 'CheckoutID' } },
    { baseUrl: { mode: 'merchant', scheme: 'Merchant' } },
    { this: { mode: 'merchant', scheme: 'Merchant' } },
    { 'api-key': { mode: 'merchant', scheme: 'Merchant' } },
  ])
    assert.throws(() => load({ ...config, auth: { ...config.auth, shortcuts } }), /shortcut/);
});

test('profiles compose shortcut mappings and reject conflicting targets', () => {
  load();
  writeFileSync(join(dir, 'shortcut-base.json'), JSON.stringify(config));
  writeFileSync(
    join(dir, 'shortcut-profile.json'),
    JSON.stringify({
      auth: { shortcuts: { apiKey: { mode: 'merchant', scheme: 'Merchant' } } },
    }),
  );
  const composed = { profiles: ['shortcut-base.json', 'shortcut-profile.json'] };
  writeFileSync(join(dir, 'shortcut-composed.json'), JSON.stringify(composed));
  assert.deepEqual(
    loadContract(join(dir, 'api.json'), join(dir, 'shortcut-composed.json')).authShortcuts,
    { apiKey: { mode: 'merchant', scheme: 'Merchant' } },
  );
  writeFileSync(
    join(dir, 'shortcut-composed.json'),
    JSON.stringify({
      ...composed,
      auth: { shortcuts: { apiKey: { mode: 'customer', scheme: 'Customer' } } },
    }),
  );
  assert.throws(
    () => loadContract(join(dir, 'api.json'), join(dir, 'shortcut-composed.json')),
    /conflict/,
  );
});
