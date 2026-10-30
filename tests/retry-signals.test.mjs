import { before } from 'node:test';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { inspect, promisify } from 'node:util';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { generate, loadContract } from '../dist/index.js';
import { compileSdkContract } from '../dist/target-plan.js';
import { assertRuntimePlan } from '../dist/runtime-plan.js';
import { storeCompiledSnapshot, restoreCompiledSnapshot } from '../dist/compiled-record.js';
import { compareCompiledContracts } from '../dist/compiled-compatibility.js';

const root = mkdtempSync(join(tmpdir(), 'sdk-retry-signals-'));
after(() => rmSync(root, { force: true, recursive: true }));
const retry = {
  maxAttempts: 3,
  statuses: [429, 500, 502, 503, 504],
  transport: true,
  baseDelayMs: 0,
  maxDelayMs: 5000,
};
const idempotency = { header: 'Idempotency-Key', retention: '24 hours', scope: 'action' };
const policies = {
  read: { retry },
  auto: { retry, idempotency: { ...idempotency, auto: true, autoKeyPrefix: 'flint-sdk-' } },
  required: { retry, idempotency, aliases: ['saved'] },
  plain: {},
  jitter: { retry: { ...retry, baseDelayMs: 10000, maxDelayMs: 20 } },
  cutoff: { retry: { ...retry, baseDelayMs: 10000, maxDelayMs: 10000 } },
  legacyRule: { retry: { ...retry, errors: [{ status: 400, codes: ['old_rule'] }] } },
};
const api = {
  openapi: '3.1.0',
  info: { title: 'Retry signals', version: '1' },
  paths: Object.fromEntries(
    Object.keys(policies).map((id) => [
      '/' + id,
      {
        [id === 'read' ||
        id === 'jitter' ||
        id === 'legacyRule' ||
        id === 'cutoff' ||
        id === 'cutoff'
          ? 'get'
          : 'post']: {
          operationId: id,
          ...(id === 'required' || id === 'auto'
            ? {
                parameters: [
                  {
                    in: 'header',
                    name: 'Idempotency-Key',
                    required: id === 'required',
                    schema: { type: 'string', minLength: 3 },
                  },
                ],
              }
            : {}),
          responses: { 204: { description: 'Success' } },
        },
      },
    ]),
  ),
};
const config = {
  version: '1.0.0',
  npm: { name: '@example/retry-signals' },
  composer: { name: 'example/retry-signals', namespace: 'RetrySignals' },
  requests: { style: 'object' },
  responses: { return: 'result' },
  errors: {
    retry: { path: 'remediation.retry', retryValues: ['same_request'] },
  },
  operations: policies,
};
writeFileSync(join(root, 'api.json'), JSON.stringify(api));
writeFileSync(join(root, 'config.json'), JSON.stringify(config));
const contract = loadContract(join(root, 'api.json'), join(root, 'config.json'));
const output = join(root, 'sdk');
let sdk;
before(async () => {
  generate(contract, output);
  sdk = await import(pathToFileURL(join(output, 'node/index.js')));
});
const rows = [
  ...[409, 429, 500, 503].flatMap((status) =>
    [false, true].map((header) => ({
      name: `same_request ${status} header=${header}`,
      op: 'auto',
      status,
      signal: 'same_request',
      headers: header ? { 'retry-after': '0' } : {},
      failures: 2,
      calls: 3,
    })),
  ),
  { name: 'GET conflict', status: 409, signal: 'same_request', failures: 1, calls: 2 },
  { name: 'none wins over status', signal: 'none', failures: 3, calls: 1, error: 'ServerError' },
  {
    name: 'after_refresh wins over status',
    signal: 'after_refresh',
    failures: 3,
    calls: 1,
    error: 'ServerError',
  },
  {
    name: 'after_refresh conflict',
    status: 409,
    signal: 'after_refresh',
    failures: 3,
    calls: 1,
    error: 'ConflictError',
  },
  { name: 'unknown signal vetoes', signal: 'future', failures: 3, calls: 1, error: 'ServerError' },
  {
    name: '412 never retries',
    status: 412,
    signal: 'same_request',
    failures: 3,
    calls: 1,
    error: 'ConflictError',
  },
  { name: 'proxy HTML fallback', status: 502, raw: '<html>proxy</html>', failures: 2, calls: 3 },
  ...[429, 500, 502, 503, 504].map((status) => ({
    name: `keyed proxy fallback ${status}`,
    op: 'auto',
    status,
    raw: '<html>proxy</html>',
    failures: 2,
    calls: 3,
  })),
  { name: 'nonstring signal fallback', signal: 42, failures: 1, calls: 2 },
  { name: 'missing signal fallback', failures: 1, calls: 2 },
  {
    name: 'signal replaces old error table',
    op: 'legacyRule',
    status: 400,
    failures: 3,
    calls: 1,
    error: 'InvalidRequestError',
  },
  { name: 'transport retry', op: 'auto', transport: true, failures: 2, calls: 3 },
  {
    name: 'attempt timeout after send',
    op: 'auto',
    timeout: true,
    options: { timeoutMs: 5 },
    failures: 1,
    calls: 2,
  },
  {
    name: 'required caller key',
    op: 'required',
    options: { idempotencyKey: 'durable-action-key' },
    transport: true,
    failures: 1,
    calls: 2,
  },
  {
    name: 'required missing key',
    op: 'required',
    calls: 0,
    error: 'InvalidInputError',
    outcome: 'not_sent',
    message: /api.required.*idempotencyKey/,
  },
  {
    name: 'none write transport once',
    op: 'plain',
    transport: true,
    failures: 2,
    calls: 1,
    error: 'ConnectionError',
  },
  {
    name: 'none write response once',
    op: 'plain',
    signal: 'same_request',
    failures: 2,
    calls: 1,
    error: 'ServerError',
  },
  {
    name: 'lower attempt budget',
    op: 'auto',
    options: { maxAttempts: 1 },
    signal: 'same_request',
    failures: 3,
    calls: 1,
    error: 'ServerError',
  },
  {
    name: 'caller cannot raise limit',
    op: 'auto',
    options: { maxAttempts: 10 },
    transport: true,
    failures: 10,
    calls: 3,
    error: 'ConnectionError',
  },
  {
    name: 'transport exhausted exposes key',
    op: 'auto',
    transport: true,
    failures: 3,
    calls: 3,
    error: 'ConnectionError',
  },
  {
    name: 'pre-send validation exposes generated key',
    op: 'auto',
    options: { maxAttempts: 0 },
    calls: 0,
    error: 'ConfigurationError',
    outcome: 'not_sent',
  },
  {
    name: 'pre-send validation exposes explicit key',
    op: 'required',
    options: { idempotencyKey: 'saved-key', maxAttempts: 0 },
    calls: 0,
    error: 'ConfigurationError',
    outcome: 'not_sent',
  },
  {
    name: 'Retry-After seconds preserves last error',
    op: 'auto',
    options: { deadlineMs: 1000 },
    headers: { 'retry-after': '10' },
    signal: 'same_request',
    failures: 3,
    calls: 1,
    error: 'ServerError',
    retryAfterMs: 10000,
  },
  {
    name: 'Retry-After date preserves last error',
    op: 'auto',
    options: { deadlineMs: 1000 },
    headers: { 'retry-after': new Date(Date.now() + 3600000).toUTCString() },
    signal: 'same_request',
    failures: 3,
    calls: 1,
    error: 'ServerError',
    date: true,
  },
  {
    name: 'backoff alone preserves last error',
    op: 'cutoff',
    options: { deadlineMs: 1000 },
    signal: 'same_request',
    failures: 3,
    calls: 1,
    error: 'ServerError',
  },
  {
    name: 'capped half-to-full jitter',
    op: 'jitter',
    signal: 'same_request',
    failures: 2,
    calls: 3,
    minElapsed: 18,
    maxElapsed: 4500,
  },
  {
    name: 'Retry-After is a minimum',
    headers: { 'retry-after': '0.03' },
    signal: 'same_request',
    failures: 1,
    calls: 2,
    minElapsed: 28,
  },
  {
    name: 'invalid Retry-After ignored',
    invalidRetryAfter: true,
    headers: { 'retry-after': 'invalid' },
    signal: 'same_request',
    failures: 1,
    calls: 2,
  },
];
const wireBody = (row) =>
  row.raw ??
  JSON.stringify({
    error: { code: 'old_rule', remediation: row.signal === undefined ? {} : { retry: row.signal } },
  });
async function nodeCase(row) {
  const calls = [];
  const start = performance.now();
  const client = new sdk.Client({
    baseUrl: 'https://example.invalid',
    transport: async (_url, request) => {
      calls.push(new Headers(request.headers).get('idempotency-key'));
      if (calls.length <= (row.failures ?? 0)) {
        if (row.transport) throw new Error('Synthetic connection reset');
        if (row.timeout)
          return new Promise((_resolve, reject) =>
            request.signal.addEventListener('abort', () => reject(new Error('Synthetic timeout')), {
              once: true,
            }),
          );
        return new Response(wireBody(row), { status: row.status ?? 503, headers: row.headers });
      }
      return new Response(null, { status: 204 });
    },
  });
  try {
    const result = await client.api[row.op ?? 'read']({}, row.options);
    return {
      calls,
      key: result.lastResponse.idempotencyKey ?? null,
      elapsed: performance.now() - start,
    };
  } catch (error) {
    if (row.message) assert.match(error.message, row.message);
    if (row.error === 'ServerError') {
      assert.equal(error.code, 'old_rule');
      assert.equal(
        error.remediation.retry,
        ['same_request', 'after_refresh', 'none'].includes(row.signal) ? row.signal : undefined,
      );
      assert.equal(error.body.error.remediation.retry, row.signal);
      assert.equal(
        error.outcome,
        ['auto', 'required', 'plain'].includes(row.op) ? 'unknown' : 'response',
        row.name,
      );
    }
    assert.ok(inspect(error).includes('idempotencyKey'));
    return {
      calls,
      key: error.idempotencyKey ?? null,
      error: error.name,
      outcome: error.outcome,
      retryAfterMs: error.retryAfterMs,
      elapsed: performance.now() - start,
    };
  }
}
function verify(row, actual) {
  assert.equal(actual.calls.length, row.calls, row.name);
  assert.equal(actual.error ?? undefined, row.error, row.name);
  if (row.outcome) assert.equal(actual.outcome, row.outcome, row.name);
  const key = row.op === 'auto' ? actual.key : (row.options?.idempotencyKey ?? null);
  if (row.op === 'auto')
    assert.match(
      key,
      /^flint-sdk-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  assert.equal(actual.key, key, row.name);
  for (const sent of actual.calls) assert.equal(sent, key, row.name);
  if (row.retryAfterMs !== undefined) assert.equal(actual.retryAfterMs, row.retryAfterMs, row.name);
  if (row.invalidRetryAfter) assert.equal(actual.retryAfterMs ?? null, null, row.name);
  if (row.date) assert.ok(actual.retryAfterMs > 3500000, row.name);
  if (row.minElapsed) assert.ok(actual.elapsed >= row.minElapsed, row.name + ': ' + actual.elapsed);
  if (row.maxElapsed) assert.ok(actual.elapsed < row.maxElapsed, row.name);
}

test('body-driven retries, deadlines, key lifetime and exposure agree in generated Node and PHP', async () => {
  for (const row of rows) verify(row, await nodeCase(row));
  writeFileSync(
    join(root, 'rows.json'),
    JSON.stringify(rows.map((row) => ({ ...row, raw: wireBody(row) }))),
  );
  const actual = JSON.parse(
    execFileSync(
      'php',
      [
        '-r',
        String.raw`
require $argv[1].'/src/Runtime.php'; require $argv[1].'/src/Client.php';
$results=[];
foreach(json_decode(file_get_contents($argv[2]),true) as $row){
  $calls=[];$start=hrtime(true);
  $client=new \RetrySignals\Client(new \RetrySignals\ClientOptions(baseUrl:'https://example.invalid',transport:function($request)use(&$calls,$row){
    $calls[]=$request['headers']['idempotency-key']??null;
    if(count($calls)<=($row['failures']??0)){
      if($row['transport']??false)throw new \RuntimeException('Synthetic reset');
      if($row['deadline']??false){usleep(6000);throw new \RuntimeException('Synthetic timeout after send');}
      return ['status'=>$row['status']??503,'headers'=>$row['headers']??[],'body'=>$row['raw']];
    }
    return ['status'=>204,'headers'=>[],'body'=>''];
  }));
  try{$result=$client->api->{$row['op']??'read'}([],new \RetrySignals\RequestOptions(...($row['options']??[])));$results[]=['calls'=>$calls,'key'=>$result->lastResponse()->idempotencyKey??null,'elapsed'=>(hrtime(true)-$start)/1000000];}
  catch(\RetrySignals\SdkError $error){
    if(($row['name']??'')==='required missing key' && !str_contains($error->getMessage(),'api.required requires idempotencyKey'))throw new \Exception('Missing method/key guidance');
    if(($row['error']??null)==='ServerError' && ($error->code!=='old_rule'||$error->outcome!==(in_array($row['op']??'read',['auto','required','plain'],true)?'unknown':'response')))throw new \Exception('Lost last error');
    $results[]=['calls'=>$calls,'key'=>$error->idempotencyKey,'error'=>substr(strrchr(get_class($error), chr(92)), 1),'outcome'=>$error->outcome,'retryAfterMs'=>$error->retryAfterMs,'elapsed'=>(hrtime(true)-$start)/1000000];
  }
}
echo json_encode($results,JSON_THROW_ON_ERROR);`,
        join(output, 'php'),
        join(root, 'rows.json'),
      ],
      { encoding: 'utf8' },
    ),
  );
  rows.forEach((row, index) => verify(row, actual[index]));
});

test('required keys are required across Node styles, aliases and response info', async () => {
  for (const style of ['object', 'positional']) {
    const localConfig = { ...config, requests: { style }, responses: { return: 'result' } };
    writeFileSync(join(root, 'typed-config.json'), JSON.stringify(localConfig));
    const out = join(root, style);
    generate(loadContract(join(root, 'api.json'), join(root, 'typed-config.json')), out);
    const generated = await import(pathToFileURL(join(out, 'node/index.js')));
    const client = new generated.Client({
      baseUrl: 'https://example.invalid',
      transport: async () => new Response(null, { status: 204 }),
    });
    const response = await client.api.auto({}, {});
    assert.match(response.lastResponse.idempotencyKey, /^flint-sdk-/);
    execFileSync('php', [
      '-r',
      String.raw`
require $argv[1].'/src/Runtime.php';require $argv[1].'/src/Client.php';
$c=new \RetrySignals\Client(new \RetrySignals\ClientOptions(baseUrl:'https://example.invalid',transport:fn()=>['status'=>204,'headers'=>[],'body'=>'']));
$r=$c->api->auto();if(!str_starts_with($r->lastResponse()->idempotencyKey??'','flint-sdk-'))throw new \Exception('Missing response key');`,
      join(out, 'php'),
    ]);
    const source = `import {Client} from './index.js';
const c = new Client({baseUrl:'https://example.invalid'});
${['required', 'saved']
  .map(
    (method) => `
c.api.${method}({}, {idempotencyKey:'saved-key'});
c.api.${method}(undefined, {idempotencyKey:'saved-key'});
// @ts-expect-error key is required
c.api.${method}();
// @ts-expect-error key is required
c.api.${method}({});
// @ts-expect-error options must contain a key
c.api.${method}({}, {});
// @ts-expect-error input header does not replace the required options key
c.api.${method}({'Idempotency-Key':'saved-key'});`,
  )
  .join('\n')}
c.api.auto();
c.api.read();
`;
    writeFileSync(join(out, 'node/required.ts'), source);
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
        join(out, 'node/required.ts'),
      ],
      { encoding: 'utf8' },
    );
  }
});

test('configuration and serialized runtime boundaries reject malformed retry declarations', () => {
  const bad = [
    ...[
      null,
      {},
      { path: '', retryValues: ['same_request'] },
      { path: 'error.retry', retryValues: [] },
      { path: 'error.retry', retryValues: [1] },
    ].map((retry) => ({ errors: { ...config.errors, retry } })),
    ...[-1, '5'].map((maxDelayMs) => ({
      operations: { ...policies, read: { retry: { ...retry, maxDelayMs } } },
    })),
    ...['\r\nInjected: value', ' leading', 5].map((autoKeyPrefix) => ({
      operations: {
        ...policies,
        auto: { ...policies.auto, idempotency: { ...policies.auto.idempotency, autoKeyPrefix } },
      },
    })),
  ];
  for (const patch of bad) {
    writeFileSync(join(root, 'bad-config.json'), JSON.stringify({ ...config, ...patch }));
    assert.throws(() => loadContract(join(root, 'api.json'), join(root, 'bad-config.json')));
  }
  writeFileSync(
    join(root, 'clear-config.json'),
    JSON.stringify({
      ...config,
      operations: {
        ...policies,
        read: { retry: { ...retry, maxDelayMs: null } },
        auto: {
          ...policies.auto,
          idempotency: { ...policies.auto.idempotency, autoKeyPrefix: null },
        },
      },
    }),
  );
  const cleared = loadContract(join(root, 'api.json'), join(root, 'clear-config.json'));
  assert.equal(cleared.operations.find((op) => op.id === 'read').retry.maxDelayMs, undefined);
  assert.equal(
    cleared.operations.find((op) => op.id === 'auto').idempotency.autoKeyPrefix,
    undefined,
  );
  const plan = compileSdkContract(contract).plan.runtime;
  const invalid = [
    { ...plan, errors: { ...config.errors, retry: null } },
    { ...plan, errors: { ...config.errors, retry: { path: '', retryValues: [] } } },
    { ...plan, operations: [{ ...plan.operations[0], retry: { ...retry, maxDelayMs: -1 } }] },
    { ...plan, operations: [{ ...plan.operations[0], retry: { ...retry, maxDelayMs: null } }] },
    {
      ...plan,
      operations: [{ ...plan.operations[0], idempotency: { ...idempotency, autoKeyPrefix: '\n' } }],
    },
    {
      ...plan,
      operations: [{ ...plan.operations[0], idempotency: { ...idempotency, autoKeyPrefix: null } }],
    },
  ];
  for (const row of invalid) assert.throws(() => assertRuntimePlan(row));
  writeFileSync(join(root, 'invalid-plans.json'), JSON.stringify(invalid));
  execFileSync('php', [
    '-r',
    String.raw`require $argv[1].'/src/Runtime.php';foreach(json_decode(file_get_contents($argv[2]),true) as $plan){try{\RetrySignals\Runtime::assertCompiledPlan($plan);}catch(\InvalidArgumentException){continue;}throw new \Exception('Accepted invalid plan');}`,
    join(output, 'php'),
    join(root, 'invalid-plans.json'),
  ]);
});

test('budgets-1 records restore for comparison, and required key typing is breaking', () => {
  const next = compileSdkContract(contract).plan;
  const previous = structuredClone(next);
  for (const runtime of [previous.runtime, previous.php.runtime])
    runtime.retrySemantics = 'budgets-1';
  const op = previous.node.operations.required;
  op.requestOptions = 'RequestOptions';
  delete op.idempotencyKeyRequired;
  const restored = restoreCompiledSnapshot(
    storeCompiledSnapshot({
      plan: previous,
      runtimeIdentity: { node: '0'.repeat(64), php: '0'.repeat(64) },
    }),
  ).plan;
  assert.equal(restored.runtime.retrySemantics, 'budgets-1');
  assert.throws(() => assertRuntimePlan(restored.runtime), /retry semantics/);
  const findings = compareCompiledContracts(restored, next);
  assert.ok(findings.some((f) => f.subject === 'required.options' && f.severity === 'breaking'));
  assert.ok(findings.some((f) => f.subject === 'read.retry' && f.severity === 'review'));
  const signalOnly = structuredClone(next);
  signalOnly.runtime.errors.retry.retryValues = ['other'];
  assert.ok(
    compareCompiledContracts(signalOnly, next).some(
      (f) => f.subject === 'read.retry' && f.severity === 'review',
    ),
  );
});

test('default transports retry a timeout after send with the same key and preserve mid-flight deadline errors', async () => {
  const calls = new Map();
  const server = createServer((request, response) => {
    const key = request.headers['idempotency-key'];
    const count = (calls.get(key) ?? 0) + 1;
    calls.set(key, count);
    const reply = () => {
      response.writeHead(204);
      response.end();
    };
    if (count === 1) setTimeout(reply, 300);
    else reply();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const client = new sdk.Client({ baseUrl, allowInsecureHttp: true });
    const result = await client.api.auto({}, { timeoutMs: 100, deadlineMs: 3000 });
    assert.equal(result.lastResponse.attempts, 2);
    assert.equal(calls.get(result.lastResponse.idempotencyKey), 2);
    await assert.rejects(
      client.api.auto({}, { idempotencyKey: 'node-deadline', timeoutMs: 1000, deadlineMs: 100 }),
      (error) => error.name === 'TimeoutError' && error.idempotencyKey === 'node-deadline',
    );
    assert.equal(calls.get('node-deadline'), 1);
    const { stdout } = await promisify(execFile)('php', [
      '-r',
      String.raw`
require $argv[1].'/src/Runtime.php';require $argv[1].'/src/Client.php';
$c=new \RetrySignals\Client(new \RetrySignals\ClientOptions(baseUrl:$argv[2],allowInsecureHttp:true));
$r=$c->api->auto([],new \RetrySignals\RequestOptions(timeoutMs:100,deadlineMs:3000));
if($r->lastResponse()->attempts!==2)throw new \Exception('Did not retry timeout');
echo $r->lastResponse()->idempotencyKey;
try{$c->api->auto([],new \RetrySignals\RequestOptions(idempotencyKey:'php-deadline',timeoutMs:1000,deadlineMs:100));throw new \Exception('No deadline');}
catch(\RetrySignals\SdkError $e){if(substr(strrchr(get_class($e), chr(92)), 1)!=='TimeoutError'||$e->idempotencyKey!=='php-deadline')throw $e;}
$c->close();`,
      join(output, 'php'),
      baseUrl,
    ]);
    assert.equal(calls.get(stdout), 2);
    assert.equal(calls.get('php-deadline'), 1);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('truncated responses retain Retry-After and the HTTP 412 veto in generated Node and PHP', async () => {
  const rows = [
    {
      name: 'retry-after',
      status: 429,
      headers: { 'retry-after': '10' },
      calls: 1,
      retryAfterMs: 10000,
      retryAllowed: true,
    },
    {
      name: 'precondition',
      status: 412,
      headers: { 'retry-after': '0' },
      calls: 1,
      retryAfterMs: 0,
      retryAllowed: false,
    },
    { name: 'transport-control', status: 503, headers: {}, calls: 2 },
  ];
  const calls = new Map();
  const server = createServer((request, response) => {
    const key = request.headers['idempotency-key'];
    const row = rows.find((row) => key.endsWith(row.name));
    const count = (calls.get(key) ?? 0) + 1;
    calls.set(key, count);
    if (count > 1) {
      response.writeHead(204);
      response.end();
      return;
    }
    response.writeHead(row.status, { ...row.headers, 'content-length': '100' });
    response.write('{');
    setTimeout(() => response.destroy(), 20);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const assertError = (error, row, key) => {
    assert.equal(error.name, 'ConnectionError', row.name);
    assert.equal(error.outcome, 'unknown', row.name);
    assert.equal(error.status, row.status, row.name);
    assert.equal(error.retryAfterMs, row.retryAfterMs, row.name);
    assert.equal(error.retryAllowed, row.retryAllowed, row.name);
    assert.equal(error.idempotencyKey, key, row.name);
  };
  try {
    const client = new sdk.Client({ baseUrl, allowInsecureHttp: true });
    for (const row of rows) {
      const key = 'node-' + row.name;
      const request = client.api.auto({}, { idempotencyKey: key, deadlineMs: 1000 });
      if (row.calls === 1) {
        await assert.rejects(request, (error) => {
          assertError(error, row, key);
          return true;
        });
      } else {
        assert.equal((await request).lastResponse.attempts, 2);
      }
      assert.equal(calls.get(key), row.calls, row.name);
    }
    const { stdout } = await promisify(execFile)('php', [
      '-r',
      String.raw`
require $argv[1].'/src/Runtime.php';require $argv[1].'/src/Client.php';
$c=new \RetrySignals\Client(new \RetrySignals\ClientOptions(baseUrl:$argv[2],allowInsecureHttp:true));
$results=[];
foreach(json_decode($argv[3],true) as $row){
  $key='php-'.$row['name'];
  try{
    $result=$c->api->auto([],new \RetrySignals\RequestOptions(idempotencyKey:$key,deadlineMs:1000));
    $results[]=['attempts'=>$result->lastResponse()->attempts];
  }catch(\RetrySignals\SdkError $e){
    $results[]=['name'=>substr(strrchr(get_class($e), chr(92)), 1),'outcome'=>$e->outcome,'status'=>$e->status,'retryAfterMs'=>$e->retryAfterMs,'retryAllowed'=>$e->retryAllowed,'idempotencyKey'=>$e->idempotencyKey];
  }
}
$c->close();echo json_encode($results);`,
      join(output, 'php'),
      baseUrl,
      JSON.stringify(rows),
    ]);
    const results = JSON.parse(stdout);
    for (const [index, row] of rows.entries()) {
      const key = 'php-' + row.name;
      if (row.calls === 1) assertError(results[index], row, key);
      else assert.equal(results[index].attempts, 2);
      assert.equal(calls.get(key), row.calls, row.name);
    }
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('keyed cancellation and protocol failures expose their resolved key without retrying', async () => {
  for (const failure of ['CancelledError', 'UnexpectedResponseError']) {
    let calls = 0;
    const client = new sdk.Client({
      baseUrl: 'https://example.invalid',
      transport: async () => {
        calls++;
        return new Response('unexpected body', { status: 200 });
      },
    });
    await assert.rejects(
      client.api.auto({}, failure === 'CancelledError' ? { signal: AbortSignal.abort() } : {}),
      (error) => error.name === failure && /^flint-sdk-/.test(error.idempotencyKey),
    );
    assert.equal(calls, failure === 'CancelledError' ? 0 : 1);
  }
  execFileSync('php', [
    '-r',
    String.raw`
require $argv[1].'/src/Runtime.php';require $argv[1].'/src/Client.php';
foreach(['CancelledError','UnexpectedResponseError'] as $kind){
$calls=0;$token=new \RetrySignals\Cancellation();if($kind==='CancelledError')$token->cancel();
$c=new \RetrySignals\Client(new \RetrySignals\ClientOptions(baseUrl:'https://example.invalid',transport:function()use(&$calls){$calls++;return ['status'=>200,'headers'=>[],'body'=>'unexpected body'];}));
try{$c->api->auto([],new \RetrySignals\RequestOptions(cancellation:$token));throw new \Exception('No failure');}
catch(\RetrySignals\SdkError $e){if(substr(strrchr(get_class($e), chr(92)), 1)!==$kind||!str_starts_with($e->idempotencyKey??'','flint-sdk-')||$e->__debugInfo()['idempotencyKey']!==$e->idempotencyKey)throw $e;}
if($calls!==($kind==='CancelledError'?0:1))throw new \Exception('Unexpected retry');
}`,
    join(output, 'php'),
  ]);
});
