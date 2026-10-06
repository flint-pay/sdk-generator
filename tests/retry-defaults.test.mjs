import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { loadContract, generate } from '../dist/index.js';
import { compileSdkContract } from '../dist/target-plan.js';
import { compileRuntimePlan, assertRuntimePlan } from '../dist/runtime-plan.js';
import { compareCompiledContracts } from '../dist/compiled-compatibility.js';
import { storeCompiledSnapshot, restoreCompiledSnapshot } from '../dist/compiled-record.js';
import { Runtime } from '../dist/runtime.js';

const root = mkdtempSync(join(tmpdir(), 'sdk-retry-defaults-'));
after(() => rmSync(root, { recursive: true, force: true }));
const retry = { maxAttempts: 3, statuses: [503], transport: true, baseDelayMs: 0 };
const idempotency = {
  header: 'Idempotency-Key',
  retention: '24 hours (synthetic)',
  scope: 'action',
};
const definitions = {
  read: ['get', {}],
  head: ['head', {}],
  options: ['options', {}],
  limited: ['get', { retry: { ...retry, maxAttempts: 2 } }],
  disabled: ['get', { retry: { ...retry, maxAttempts: 1 } }],
  custom: ['get', { retry: { ...retry, statuses: [502], transport: false } }],
  plain: ['post', {}],
  keyed: ['post', { retry, idempotency }],
  keyOnly: ['post', { idempotency }],
  auto: ['post', { retry, idempotency: { ...idempotency, auto: true } }],
  required: ['post', { retry, idempotency }],
  zeroCode: ['post', { retry: { ...retry, errors: [{ status: 409, codes: ['0'] }] }, idempotency }],
  conflict: [
    'post',
    { retry: { ...retry, errors: [{ status: 409, codes: ['in_progress'] }] }, idempotency },
  ],
};
const api = {
  openapi: '3.1.0',
  info: { title: 'Retry budgets', version: '1' },
  paths: Object.fromEntries(
    Object.entries(definitions).map(([id, [verb]]) => [
      '/' + id,
      {
        [verb]: {
          operationId: id,
          ...(verb === 'post'
            ? {
                requestBody: {
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        properties: { reference: { type: 'string' } },
                      },
                    },
                  },
                },
              }
            : {}),
          ...(id === 'required'
            ? {
                parameters: [
                  {
                    in: 'header',
                    name: 'Idempotency-Key',
                    required: true,
                    schema: { type: 'string', minLength: 3 },
                  },
                ],
              }
            : {}),
          responses: { 204: { description: 'Done' } },
        },
      },
    ]),
  ),
};
const config = {
  version: '1.0.0',
  npm: { name: '@example/retry-budgets' },
  composer: { name: 'example/retry-budgets', namespace: 'RetryBudgets' },
  requests: { style: 'object' },
  responses: { return: 'result' },
  operations: Object.fromEntries(
    Object.entries(definitions).map(([id, [, policy]]) => [id, policy]),
  ),
};
writeFileSync(join(root, 'api.json'), JSON.stringify(api));
writeFileSync(join(root, 'sdk.json'), JSON.stringify(config));
const contract = loadContract(join(root, 'api.json'), join(root, 'sdk.json'));
const output = join(root, 'sdk');
generate(contract, output);
const sdk = await import(pathToFileURL(join(output, 'node/index.js')));
const body = { body: { reference: 'synthetic-action' } };
const cases = [
  ...[408, 429, 500, 502, 503, 504].map((status) => ({
    name: 'read ' + status,
    op: 'read',
    status,
    failures: 2,
    attempts: 3,
  })),
  ...['head', 'options'].map((op) => ({ name: op, op, failures: 1, attempts: 2 })),
  { name: 'transport default', op: 'read', transport: true, failures: 1, attempts: 2 },
  {
    name: 'unlisted server status',
    op: 'read',
    status: 501,
    failures: 1,
    attempts: 1,
    error: 'server',
    eligible: false,
  },
  {
    name: 'undeclared read capped',
    op: 'read',
    client: { maxAttempts: 8 },
    failures: 3,
    attempts: 3,
    error: 'server',
    eligible: true,
  },
  {
    name: 'budget exhaustion',
    op: 'read',
    failures: 3,
    attempts: 3,
    error: 'server',
    eligible: true,
  },
  {
    name: 'global oversized budget',
    op: 'limited',
    client: { maxAttempts: 8 },
    failures: 1,
    attempts: 2,
  },
  {
    name: 'request oversized budget',
    op: 'limited',
    options: { maxAttempts: 1000 },
    failures: 2,
    attempts: 2,
    error: 'server',
    eligible: true,
  },
  {
    name: 'request overrides client',
    op: 'limited',
    client: { maxAttempts: 1 },
    options: { maxAttempts: 3 },
    failures: 1,
    attempts: 2,
  },
  {
    name: 'request opt out',
    op: 'read',
    client: { maxAttempts: 3 },
    options: { maxAttempts: 1 },
    failures: 1,
    attempts: 1,
    error: 'server',
    eligible: true,
  },
  {
    name: 'explicit policy off',
    op: 'disabled',
    failures: 1,
    attempts: 1,
    error: 'server',
    eligible: true,
  },
  {
    name: 'replace default statuses',
    op: 'custom',
    failures: 1,
    attempts: 1,
    error: 'server',
    eligible: false,
  },
  {
    name: 'replace transport policy',
    op: 'custom',
    transport: true,
    failures: 1,
    attempts: 1,
    error: 'transport',
    eligible: false,
  },
  { name: 'custom status', op: 'custom', status: 502, failures: 1, attempts: 2 },
  { name: 'plain mutation', op: 'plain', client: { maxAttempts: 3 }, input: body, attempts: 1 },
  {
    name: 'plain mutation failure',
    op: 'plain',
    client: { maxAttempts: 3 },
    input: body,
    failures: 1,
    attempts: 1,
    error: 'server',
    eligible: false,
  },
  { name: 'optional key missing', op: 'keyed', input: body, attempts: 1 },
  {
    name: 'keyless budget capped',
    op: 'keyed',
    input: body,
    options: { maxAttempts: 3 },
    failures: 1,
    attempts: 1,
    error: 'server',
    eligible: false,
  },
  {
    name: 'keyless lost response',
    op: 'keyed',
    input: body,
    transport: true,
    failures: 1,
    attempts: 1,
    error: 'transport',
    eligible: false,
  },
  {
    name: 'stable explicit key',
    op: 'keyed',
    input: body,
    options: { idempotencyKey: 'saved-key' },
    failures: 2,
    attempts: 3,
    key: 'saved-key',
  },
  {
    name: 'stable header key',
    op: 'keyed',
    input: body,
    options: { headers: { 'IDEMPOTENCY-KEY': 'header-key' } },
    failures: 1,
    attempts: 2,
    key: 'header-key',
  },
  { name: 'stable auto key', op: 'auto', input: body, failures: 2, attempts: 3, auto: true },
  {
    name: 'key alone enables nothing',
    op: 'keyOnly',
    input: body,
    options: { idempotencyKey: 'saved-key', maxAttempts: 3 },
    failures: 1,
    attempts: 1,
    error: 'server',
    eligible: false,
    key: 'saved-key',
  },
  {
    name: 'required key missing',
    op: 'required',
    attempts: 0,
    error: 'validation',
    eligible: false,
  },
  {
    name: 'required key option',
    op: 'required',
    options: { idempotencyKey: 'saved-key' },
    failures: 1,
    attempts: 2,
    key: 'saved-key',
  },
  {
    name: 'required key input',
    op: 'required',
    input: { 'Idempotency-Key': 'input-key' },
    failures: 1,
    attempts: 2,
    key: 'input-key',
  },
  {
    name: 'unsupported key',
    op: 'plain',
    options: { idempotencyKey: 'saved-key' },
    attempts: 0,
    error: 'validation',
    eligible: false,
  },
  {
    name: 'empty key',
    op: 'keyed',
    options: { idempotencyKey: '' },
    attempts: 0,
    error: 'validation',
    eligible: false,
  },
  {
    name: 'conflicting keys',
    op: 'keyed',
    options: { idempotencyKey: 'one', headers: { 'Idempotency-Key': 'two' } },
    attempts: 0,
    error: 'validation',
    eligible: false,
  },
  ...[0, -1, 1.5, 9007199254740992].flatMap((maxAttempts) =>
    ['client', 'options'].map((location) => ({
      name: location + ' invalid ' + maxAttempts,
      op: 'read',
      [location]: { maxAttempts },
      attempts: 0,
      error: 'validation',
      eligible: false,
    })),
  ),
  ...[409, 412].map((status) => ({
    name: 'no blanket ' + status,
    op: 'read',
    status,
    failures: 1,
    attempts: 1,
    error: 'conflict',
    eligible: false,
  })),
  {
    name: 'zero conflict code',
    op: 'zeroCode',
    status: 409,
    code: '0',
    options: { idempotencyKey: 'saved-key' },
    failures: 1,
    attempts: 2,
    key: 'saved-key',
  },
  {
    name: 'specific conflict',
    op: 'conflict',
    status: 409,
    options: { idempotencyKey: 'saved-key' },
    failures: 1,
    attempts: 2,
    key: 'saved-key',
  },
  {
    name: 'retry-after deadline',
    op: 'read',
    options: { deadlineMs: 100 },
    headers: { 'retry-after': '10' },
    failures: 1,
    attempts: 1,
    error: 'deadline',
    eligible: true,
  },
];
writeFileSync(join(root, 'cases.json'), JSON.stringify(cases));

function verify(row, actual) {
  assert.equal(actual.calls.length, row.attempts, row.name);
  assert.equal(actual.error, row.error ?? null, row.name);
  assert.equal(actual.eligible, row.eligible ?? null, row.name);
  assert.equal(actual.events.length, row.attempts, row.name);
  assert.deepEqual(
    actual.events.map((event) => event.attempt),
    Array.from({ length: row.attempts }, (_, index) => index + 1),
    row.name,
  );
  if (!row.error) assert.equal(actual.attempts, row.attempts, row.name);
  for (const call of actual.calls) {
    assert.equal(call.body, row.input?.body ? '{"reference":"synthetic-action"}' : null, row.name);
    if (row.auto) assert.match(call.key, /^[0-9a-f-]{32,36}$/);
    else assert.equal(call.key, row.key ?? null, row.name);
  }
  assert.ok(new Set(actual.calls.map((call) => call.key)).size <= 1, row.name);
}

async function nodeCase(row, dynamic = false) {
  const calls = [],
    events = [];
  const options = {
    baseUrl: 'https://example.invalid',
    ...row.client,
    diagnostics: (event) => events.push(event),
    transport: async (_url, request) => {
      calls.push({
        key: new Headers(request.headers).get('idempotency-key'),
        body: request.body ?? null,
      });
      if (calls.length <= (row.failures ?? 0)) {
        if (row.transport) throw new Error('Synthetic connection loss');
        return new Response(JSON.stringify({ code: row.code ?? 'in_progress' }), {
          status: row.status ?? 503,
          headers: row.headers,
        });
      }
      return new Response(null, { status: 204 });
    },
  };
  try {
    const result = dynamic
      ? await new Runtime({ operations: contract.operations }, options).request(
          row.op,
          row.input ?? {},
          row.options,
        )
      : await new sdk.Client(options).api[row.op](row.input ?? {}, row.options);
    return { calls, events, error: null, eligible: null, attempts: result.meta.attempts };
  } catch (error) {
    return { calls, events, error: error.kind, eligible: error.retryAllowed };
  }
}

test('generated Node and PHP clients use the same independently expected retry budgets and wire values', async () => {
  for (const row of cases) verify(row, await nodeCase(row));
  const program = String.raw`
require $argv[1].'/src/Runtime.php'; require $argv[1].'/src/Client.php';
$rows=json_decode(file_get_contents($argv[2]),true,512,JSON_THROW_ON_ERROR);$results=[];
foreach($rows as $row){
  $calls=[];$events=[];
  $options=new \RetryBudgets\ClientOptions(...array_merge(['baseUrl'=>'https://example.invalid'], $row['client']??[], [
    'diagnostics'=>function($event)use(&$events){$events[]=$event;},
    'transport'=>function($r)use(&$calls,$row){
      $calls[]=['key'=>$r['headers']['idempotency-key']??null,'body'=>$r['body']??null];
      if(count($calls)<=($row['failures']??0)){
        if($row['transport']??false)throw new \RuntimeException('Synthetic connection loss');
        return ['status'=>$row['status']??503,'headers'=>$row['headers']??[],'body'=>json_encode(['code'=>$row['code']??'in_progress'])];
      }
      return ['status'=>204,'headers'=>[],'body'=>''];
    }
  ]));
  try {
    $c=new \RetryBudgets\Client($options);
    $result=$c->api->{$row['op']}($row['input']??[],new \RetryBudgets\RequestOptions(...($row['options']??[])));
    $results[]=['calls'=>$calls,'events'=>$events,'error'=>null,'eligible'=>null,'attempts'=>$result->meta['attempts']];
  }catch(\RetryBudgets\SdkError $e){$results[]=['calls'=>$calls,'events'=>$events,'error'=>$e->kind,'eligible'=>$e->retryAllowed];}
}
echo json_encode($results,JSON_THROW_ON_ERROR);
`;
  const results = JSON.parse(
    execFileSync('php', ['-r', program, join(output, 'php'), join(root, 'cases.json')], {
      encoding: 'utf8',
    }),
  );
  cases.forEach((row, index) => verify(row, results[index]));
});

test('nonfinite and unsafe request budgets fail before dispatch in both runtimes', async () => {
  for (const maxAttempts of [NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    for (const location of ['client', 'options']) {
      const row = {
        name: 'invalid budget',
        op: 'read',
        [location]: { maxAttempts },
        attempts: 0,
        error: 'validation',
        eligible: false,
      };
      verify(row, await nodeCase(row));
    }
  }
  execFileSync('php', [
    '-r',
    String.raw`
require $argv[1].'/src/Runtime.php'; require $argv[1].'/src/Client.php';
foreach([3,3.0,9007199254740991]as $budget){
$c=new \RetryBudgets\Client(new \RetryBudgets\ClientOptions(baseUrl:'https://example.invalid',maxAttempts:$budget,transport:fn()=>['status'=>204,'headers'=>[],'body'=>'']));$c->api->read();
}
foreach([NAN,INF,-INF,9007199254740992] as $budget)foreach([false,true] as $client){
  $c=new \RetryBudgets\Client(new \RetryBudgets\ClientOptions(baseUrl:'https://example.invalid',maxAttempts:$client?$budget:null,transport:fn()=>throw new \Exception('Unexpected dispatch')));
  try{$c->api->read([],new \RetryBudgets\RequestOptions(maxAttempts:$client?null:$budget));throw new \Exception('Accepted invalid budget');}
  catch(\RetryBudgets\SdkError $e){if($e->kind!=='validation')throw $e;}
}`,
    join(output, 'php'),
  ]);
});

test('compilation is deterministic and dynamic contract adapters preserve retry behavior', async () => {
  const original = JSON.stringify(contract);
  const first = compileRuntimePlan({ operations: contract.operations });
  assert.deepEqual(first, compileRuntimePlan({ operations: contract.operations }));
  assert.equal(JSON.stringify(contract), original);
  const row = cases.find((row) => row.name === 'transport default');
  verify(row, await nodeCase(row, true));
  writeFileSync(join(root, 'raw.json'), JSON.stringify({ operations: contract.operations }));
  const result = execFileSync(
    'php',
    [
      '-r',
      String.raw`
require $argv[1].'/src/Runtime.php';$count=0;
$r=new \RetryBudgets\Runtime(json_decode(file_get_contents($argv[2]),true),new \RetryBudgets\ClientOptions(baseUrl:'https://example.invalid',transport:function()use(&$count){$count++;return ['status'=>$count===1?503:204,'headers'=>[],'body'=>''];}));
echo $r->request('read')->meta['attempts'];`,
      join(output, 'php'),
      join(root, 'raw.json'),
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result, '2');
});

test('malformed compiled retry descriptors are rejected by both runtimes', () => {
  const plan = compileRuntimePlan({
    operations: [contract.operations.find((op) => op.id === 'read')],
  });
  const patches = [
    { retry: undefined },
    { replay: 'guess' },
    { replay: ['safe'] },
    { replay: null },
    { retry: { ...retry, maxAttempts: 0 } },
    { retry: { ...retry, statuses: [409] } },
    { retry: { ...retry, statuses: [412] } },
    { retry: { ...retry, transport: 'yes' } },
    { retry: { ...retry, baseDelayMs: -1 } },
    { retry: { ...retry, errors: [{ status: 412, codes: ['x'] }] } },
    { retry: { ...retry, errors: [{ status: 503, codes: [] }] } },
    { retry: { ...retry, errors: [{ status: 409, codes: ['x'] }] } },
    { replay: 'idempotency' },
  ];
  const bad = patches.map((patch) => ({
    ...plan,
    operations: [{ ...plan.operations[0], ...patch }],
  }));
  bad.push({ ...plan, retrySemantics: 'future' });
  for (const descriptor of bad) assert.throws(() => assertRuntimePlan(descriptor));
  writeFileSync(join(root, 'bad.json'), JSON.stringify(bad));
  execFileSync('php', [
    '-r',
    String.raw`
require $argv[1].'/src/Runtime.php';
foreach(json_decode(file_get_contents($argv[2]),true) as $plan){
try{new \RetryBudgets\Runtime($plan,new \RetryBudgets\ClientOptions(baseUrl:'https://example.invalid'),true);throw new \Exception('Accepted bad plan');}
catch(\InvalidArgumentException $e){}}
`,
    join(output, 'php'),
    join(root, 'bad.json'),
  ]);
});

test('operation references explain automatic keys and code-specific retries', () => {
  for (const target of ['node', 'php']) {
    const reference = readFileSync(join(output, target, 'REFERENCE.md'), 'utf8');
    assert.match(reference, /When no key is supplied, the SDK generates one for this call/);
    assert.match(reference, /Code-specific retries: HTTP 409 \(`in_progress`\)/);
    assert.match(reference, /Without an optional idempotency key, mutations send once/);
    assert.doesNotMatch(reference, /[\t ]+\r?$/m);
  }
});

test('historical records preserve old retry declarations and report narrowing independently of authentication', () => {
  const next = compileSdkContract(contract).plan;
  const previous = structuredClone(next);
  for (const runtime of [previous.runtime, previous.php.runtime]) {
    delete runtime.retrySemantics;
    for (const op of runtime.operations) {
      delete op.replay;
      if (!definitions[op.id][1].retry) delete op.retry;
    }
  }
  for (const op of Object.values(previous.node.operations)) {
    delete op.idempotencyKey;
    op.requestOptions = 'RequestOptions';
    op.authModes = ['merchant'];
  }
  for (const op of Object.values(next.node.operations)) op.authModes = ['merchant'];
  const restored = restoreCompiledSnapshot(
    storeCompiledSnapshot({
      plan: previous,
      runtimeIdentity: { node: '0'.repeat(64), php: '0'.repeat(64) },
    }),
  ).plan;
  assert.equal(restored.runtime.operations.find((op) => op.id === 'read').retry, undefined);
  const findings = compareCompiledContracts(restored, next);
  assert.ok(findings.some((f) => f.subject === 'read.options' && f.severity === 'breaking'));
  assert.ok(findings.some((f) => f.subject === 'read.retry' && f.severity === 'review'));
  assert.ok(findings.some((f) => f.subject === 'keyed.retry' && f.severity === 'review'));
  assert.ok(!findings.some((f) => f.subject === 'keyed.options' && f.severity === 'breaking'));
});

test('generated option types enforce idempotency across method forms without weakening auth unions', () => {
  const paymentApi = JSON.parse(readFileSync('tests/fixtures/payment-api.json', 'utf8'));
  const paymentConfig = JSON.parse(readFileSync('tests/fixtures/payment-sdk.json', 'utf8'));
  paymentApi.components.securitySchemes.checkout = {
    type: 'apiKey',
    in: 'header',
    name: 'X-Checkout-Key',
  };
  paymentApi.paths['/payments/{id}'].get.security = [{ bearer: [] }, { checkout: [] }];
  paymentConfig.auth = {
    modes: {
      merchant: { schemes: ['bearer'] },
      checkout: { schemes: ['checkout'], operations: ['getPayment'] },
    },
  };
  paymentConfig.responses = { return: 'payload' };
  paymentConfig.operations.getPayment.aliases = ['fetch'];
  for (const style of ['object', 'positional']) {
    paymentConfig.requests = { style };
    writeFileSync(join(root, 'typed-api.json'), JSON.stringify(paymentApi));
    writeFileSync(join(root, 'typed-config.json'), JSON.stringify(paymentConfig));
    const dir = join(root, style);
    generate(loadContract(join(root, 'typed-api.json'), join(root, 'typed-config.json')), dir);
    const id = style === 'object' ? "{id:'p'}" : "'p', {}";
    const value = "{amount:'100',currency:'USD',reference:'synthetic'}";
    const input = style === 'object' ? `{body:${value}}` : value;
    const source = `import {Client,type RequestOptions} from './index.js';
const c=new Client({baseUrl:'https://example.invalid',authMode:'merchant',credentials:{merchant:{bearer:'synthetic'}}});
c.payments.create(${input},{idempotencyKey:'saved-key'});
c.payments.createWithResponse(${input},{idempotencyKey:'saved-key'});
c.payments.retrieve(${id},{authMode:'checkout',credentials:{checkout:'synthetic'}});
const shared:RequestOptions={idempotencyKey:'saved-key'};
// @ts-expect-error Broad forwarded options may contain an unsupported key
c.payments.retrieve(${id},shared);
// @ts-expect-error Removing a key must preserve auth/credential correlation
c.payments.retrieve(${id},{authMode:'checkout',credentials:{bearer:'synthetic'}});
// @ts-expect-error Unsupported authentication mode on mutation
c.payments.create(${input},{authMode:'checkout',credentials:{checkout:'synthetic'},idempotencyKey:'saved-key'});
${['retrieve', 'fetch', 'retrieveWithResponse', 'fetchWithResponse', 'retrieveWait'].map((method) => `// @ts-expect-error Unsupported idempotency key\nc.payments.${method}(${id},{idempotencyKey:'unsupported'});`).join('\n')}
${['listAll', 'listAllPages', 'listAllItems'].map((method) => `// @ts-expect-error Unsupported iterator key\nc.payments.${method}({}, {idempotencyKey:'unsupported'});`).join('\n')}
`;
    const file = join(dir, 'node/check.ts');
    writeFileSync(file, source);
    execFileSync(
      process.execPath,
      [
        resolve('node_modules/typescript/bin/tsc'),
        '--noEmit',
        '--strict',
        '--exactOptionalPropertyTypes',
        '--module',
        'nodenext',
        '--target',
        'es2022',
        '--typeRoots',
        resolve('node_modules/@types'),
        file,
      ],
      { encoding: 'utf8' },
    );
  }
});

test('generated examples retry transient failures without an explicit attempt override', async () => {
  for (const op of ['read', 'keyed']) {
    const source = readFileSync(join(output, `node/examples/api-${op}.mjs`), 'utf8');
    assert.doesNotMatch(source, /maxAttempts/);
    const calls = [];
    const client = new sdk.Client({
      baseUrl: 'https://example.invalid',
      transport: async (_url, init) => {
        calls.push(init);
        return calls.length === 1
          ? new Response('{}', { status: 503 })
          : new Response(null, { status: 204 });
      },
    });
    const start = source.indexOf(op === 'read' ? 'const result = await' : '// Persist');
    const call = source.slice(start).split('console.log')[0];
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const result = await new AsyncFunction('client', call + '\nreturn result;')(client);
    assert.equal(result.meta.attempts, 2);
    if (op === 'keyed')
      assert.equal(calls[0].headers['idempotency-key'], calls[1].headers['idempotency-key']);
    let php = readFileSync(join(output, `php/examples/api-${op}.php`), 'utf8');
    assert.doesNotMatch(php, /maxAttempts/);
    php = php
      .replace(
        /require[^;]+;/,
        `require $argv[1].'/src/Runtime.php'; require $argv[1].'/src/Client.php'; $calls=[];`,
      )
      .replace(
        'new ClientOptions(',
        `new ClientOptions(transport: function($r)use(&$calls){$calls[]=$r;return ['status'=>count($calls)===1?503:204,'headers'=>[],'body'=>''];},`,
      );
    php += '\nif(count($calls)!==2)throw new Exception("Example did not retry");\n';
    if (op === 'keyed')
      php +=
        'if($calls[0]["headers"]["idempotency-key"]!==$calls[1]["headers"]["idempotency-key"])throw new Exception("Unstable key");\n';
    const file = join(root, 'example-' + op + '.php');
    writeFileSync(file, php);
    execFileSync('php', [file, join(output, 'php')], {
      env: { ...process.env, API_BASE_URL: 'https://example.invalid' },
    });
  }
});

test('cancellation stops default retries before dispatch and between attempts in both runtimes', async () => {
  for (const before of [true, false]) {
    const controller = new AbortController();
    if (before) controller.abort();
    let calls = 0;
    const client = new sdk.Client({
      baseUrl: 'https://example.invalid',
      diagnostics: () => controller.abort(),
      transport: async () => {
        calls++;
        return new Response('{}', { status: 503 });
      },
    });
    await assert.rejects(client.api.read({}, { signal: controller.signal }), { kind: 'cancelled' });
    assert.equal(calls, before ? 0 : 1);
  }
  execFileSync('php', [
    '-r',
    String.raw`
require $argv[1].'/src/Runtime.php';require $argv[1].'/src/Client.php';
foreach([true,false]as $before){$calls=0;$token=new \RetryBudgets\Cancellation();if($before)$token->cancel();
$c=new \RetryBudgets\Client(new \RetryBudgets\ClientOptions(baseUrl:'https://example.invalid',diagnostics:fn()=>$token->cancel(),transport:function()use(&$calls){$calls++;return ['status'=>503,'headers'=>[],'body'=>'{}'];}));
try{$c->api->read([],new \RetryBudgets\RequestOptions(cancellation:$token));throw new \Exception('Ignored cancellation');}catch(\RetryBudgets\SdkError $e){if($e->kind!=='cancelled')throw $e;}
if($calls!==($before?0:1))throw new \Exception('Retried cancelled call');
}`,
    join(output, 'php'),
  ]);
});
