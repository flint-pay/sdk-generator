import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { setImmediate as immediate } from 'node:timers/promises';
import { generate, loadContract } from '../dist/index.js';
import { compileRuntimePlan, assertRuntimePlan } from '../dist/runtime-plan.js';

const root = mkdtempSync(join(tmpdir(), 'sdk-retry-outcomes-'));
after(() => rmSync(root, { recursive: true, force: true }));
const output = join(root, 'sdk');
const retry = {
  maxAttempts: 3,
  statuses: [429, 500, 502, 503, 504],
  transport: true,
  baseDelayMs: 100,
};
const money = [
  'payOrder',
  'confirmPaymentIntent',
  'capturePaymentIntent',
  'captureOrderPayment',
  'createRefund',
  'createOrderRefund',
  'routeClassPayment',
];
const definitions = Object.fromEntries([
  ...money.map((id) => [id, 'post']),
  ['write', 'patch'],
  ['authenticatedWrite', 'post'],
  ['plain', 'post'],
  ['read', 'get'],
  ['head', 'head'],
  ['binary', 'get'],
  ['events', 'get'],
]);
const keyed = (id) => !['plain', 'read', 'head', 'binary', 'events'].includes(id);
const api = {
  openapi: '3.1.0',
  info: { title: 'Outcome fixture', version: '1' },
  components: { securitySchemes: { Bearer: { type: 'http', scheme: 'bearer' } } },
  paths: Object.fromEntries(
    Object.entries(definitions).map(([id, verb]) => [
      '/' + id,
      {
        [verb]: {
          operationId: id,
          ...(id === 'authenticatedWrite' ? { security: [{ Bearer: [] }] } : {}),
          ...(id === 'routeClassPayment' ? { 'x-flint-route-class': 'payment' } : {}),
          ...(keyed(id)
            ? {
                parameters: [{ name: 'Idempotency-Key', in: 'header', schema: { type: 'string' } }],
              }
            : {}),
          responses: {
            200: {
              description: 'Success',
              content: {
                [id === 'binary'
                  ? 'application/pdf'
                  : id === 'events'
                    ? 'text/event-stream'
                    : 'application/json']: {
                  schema:
                    id === 'binary'
                      ? { type: 'string', format: 'binary' }
                      : id === 'events'
                        ? { type: 'string' }
                        : {
                            type: 'object',
                            required: ['value'],
                            properties: { value: { type: 'string' } },
                          },
                },
              },
            },
            204: { description: 'Empty success' },
          },
        },
      },
    ]),
  ),
};
const profile = {
  errors: {
    codePath: 'error.code',
    messagePath: 'error.message',
    detailsPath: 'error',
    inProgressCodes: ['IDEMPOTENCY_KEY_IN_PROGRESS', 'SYNTHETIC_IN_PROGRESS'],
    retry: { path: 'error.remediation.retry', retryValues: ['same_request'] },
  },
  operations: Object.fromEntries(
    money.map((id) => [id, { defaults: { timeoutMs: 150000, deadlineMs: 300000 } }]),
  ),
};
const config = {
  version: '1.0.0',
  npm: { name: '@example/retry-outcomes' },
  composer: { name: 'example/retry-outcomes', namespace: 'RetryOutcomes' },
  profiles: ['profile.json'],
  auth: { scheme: 'Bearer' },
  requests: { style: 'object' },
  responses: { return: 'result' },
  operations: Object.fromEntries(
    Object.keys(definitions).map((id) => [
      id,
      {
        resource: 'api',
        method: id,
        ...(id === 'plain' ? {} : { retry }),
        ...(keyed(id)
          ? {
              idempotency: {
                header: 'Idempotency-Key',
                retention: '24 hours',
                scope: 'action',
                auto: true,
              },
            }
          : {}),
      },
    ]),
  ),
};
writeFileSync(join(root, 'api.json'), JSON.stringify(api));
writeFileSync(join(root, 'profile.json'), JSON.stringify(profile));
writeFileSync(join(root, 'config.json'), JSON.stringify(config));
const contract = loadContract(join(root, 'api.json'), join(root, 'config.json'));
const rawContract = {
  operations: contract.operations,
  errors: profile.errors,
  auth: contract.auth,
};
writeFileSync(join(root, 'raw.json'), JSON.stringify(rawContract));
let sdk, Runtime;
before(async () => {
  generate(contract, output);
  sdk = await import(pathToFileURL(join(output, 'node/index.js')));
  ({ Runtime } = await import(pathToFileURL(join(output, 'node/runtime.js'))));
});

const answer = (status, code = 'TEMPORARY', retry = 'same_request', extra = {}) => ({
  status,
  code,
  retry,
  ...extra,
});
const timeout = { failure: 'timeout' },
  refused = { failure: 'refused' };
const rows = [
  ...[null, timeout, answer(503), answer(429)].map((first) => ({
    name: 'credential failure after ' + (first?.failure ?? first?.status ?? 'no dispatch'),
    op: 'authenticatedWrite',
    chain: first ? [first] : [],
    authFailAt: first ? 2 : 1,
    attempts: first ? 2 : 1,
    error: 'ConfigurationError',
    outcome: first?.failure === 'timeout' || first?.status === 503 ? 'unknown' : 'not_sent',
    retryAllowed: false,
  })),
  {
    name: 'timeout then in-progress then replay keeps caller key',
    chain: [timeout, answer(409, 'IDEMPOTENCY_KEY_IN_PROGRESS'), answer(200)],
    options: { idempotencyKey: 'saved-synthetic-key' },
    result: true,
  },
  { name: 'timeout then 200 replay', chain: [timeout, answer(200)], result: true },
  {
    name: 'timeout then recorded VERSION_CONFLICT',
    chain: [timeout, answer(409, 'VERSION_CONFLICT', 'after_refresh')],
    error: 'ConflictError',
    outcome: 'response',
    retryAllowed: false,
  },
  {
    name: 'timeout then in-progress wait past deadline',
    chain: [
      timeout,
      answer(409, 'IDEMPOTENCY_KEY_IN_PROGRESS', 'same_request', { retryAfter: '120' }),
    ],
    options: { timeoutMs: 100, deadlineMs: 1000 },
    error: 'ConflictError',
    outcome: 'unknown',
    retryAllowed: true,
    retryAfterMs: 120000,
  },
  {
    name: 'only in-progress attempt',
    chain: [answer(409, 'IDEMPOTENCY_KEY_IN_PROGRESS')],
    options: { maxAttempts: 1 },
    error: 'ConflictError',
    outcome: 'unknown',
    retryAllowed: true,
  },
  {
    name: 'in-progress codes come from profile',
    chain: [answer(409, 'SYNTHETIC_IN_PROGRESS')],
    options: { maxAttempts: 1 },
    error: 'ConflictError',
    outcome: 'unknown',
    retryAllowed: true,
  },
  {
    name: 'timeout x3 keyed write',
    chain: [timeout, timeout, timeout],
    error: 'TimeoutError',
    outcome: 'unknown',
    retryAllowed: true,
  },
  {
    name: 'first refused connection',
    chain: [refused],
    options: { maxAttempts: 1 },
    error: 'ConnectionError',
    outcome: 'not_sent',
    retryAllowed: true,
  },
  {
    name: '429 then refused',
    chain: [answer(429), refused, refused],
    error: 'ConnectionError',
    outcome: 'not_sent',
    retryAllowed: true,
  },
  {
    name: '500 then refused',
    chain: [answer(500), refused, refused],
    error: 'ConnectionError',
    outcome: 'unknown',
    retryAllowed: true,
  },
  {
    name: 'timeout then cancelled during wait',
    chain: [timeout],
    cancelWait: true,
    error: 'CancelledError',
    outcome: 'unknown',
    retryAllowed: true,
  },
  {
    name: '503 x3 keyed write',
    chain: [answer(503), answer(503), answer(503)],
    error: 'ServerError',
    outcome: 'unknown',
    retryAllowed: true,
  },
  {
    name: 'unkeyed write timeout sends once',
    op: 'plain',
    chain: [timeout],
    error: 'TimeoutError',
    outcome: 'unknown',
    retryAllowed: false,
  },
  {
    name: 'recovery required keyed write',
    chain: [answer(500, 'IDEMPOTENCY_RECOVERY_REQUIRED', 'none')],
    error: 'ServerError',
    outcome: 'unknown',
    retryAllowed: true,
  },
  {
    name: 'recovery required read',
    op: 'read',
    chain: [answer(500, 'IDEMPOTENCY_RECOVERY_REQUIRED', 'none')],
    error: 'ServerError',
    outcome: 'response',
    retryAllowed: false,
  },
  {
    name: 'recovery required unkeyed write',
    op: 'plain',
    chain: [answer(500, 'IDEMPOTENCY_RECOVERY_REQUIRED', 'none')],
    error: 'ServerError',
    outcome: 'unknown',
    retryAllowed: false,
  },
  {
    name: 'outcome_unknown reason write',
    chain: [answer(409, 'OPERATION_IN_PROGRESS', 'none', { reason: 'outcome_unknown' })],
    error: 'ConflictError',
    outcome: 'unknown',
    retryAllowed: true,
  },
  {
    name: 'outcome_unknown reason read',
    op: 'read',
    chain: [answer(409, 'OPERATION_IN_PROGRESS', 'none', { reason: 'outcome_unknown' })],
    error: 'ConflictError',
    outcome: 'response',
    retryAllowed: false,
  },
  {
    name: '503 x3 read',
    op: 'read',
    chain: [answer(503), answer(503), answer(503)],
    error: 'ServerError',
    outcome: 'response',
    retryAllowed: true,
  },
  {
    name: '503 HEAD is a read',
    op: 'head',
    chain: [answer(503)],
    options: { maxAttempts: 1 },
    error: 'ServerError',
    outcome: 'response',
    retryAllowed: true,
  },
  {
    name: 'in-progress read remains unknown',
    op: 'read',
    chain: [answer(409, 'IDEMPOTENCY_KEY_IN_PROGRESS')],
    options: { maxAttempts: 1 },
    error: 'ConflictError',
    outcome: 'unknown',
    retryAllowed: true,
  },
  ...[401, 403, 412, 429].map((status) => ({
    name: 'timeout then answered ' + status,
    chain: [timeout, answer(status, 'REFUSAL', status === 429 ? 'same_request' : 'none')],
    options: { maxAttempts: 2 },
    error:
      status === 401
        ? 'AuthenticationError'
        : status === 403
          ? 'PermissionError'
          : status === 412
            ? 'ConflictError'
            : 'RateLimitError',
    outcome: 'response',
    retryAllowed: status === 429,
  })),
  {
    name: '401 vetoes unknown retry permission',
    chain: [answer(401, 'IDEMPOTENCY_KEY_IN_PROGRESS')],
    error: 'AuthenticationError',
    outcome: 'unknown',
    retryAllowed: false,
  },
  {
    name: '412 vetoes unknown retry permission',
    chain: [answer(412, 'IDEMPOTENCY_KEY_IN_PROGRESS')],
    error: 'ConflictError',
    outcome: 'unknown',
    retryAllowed: false,
  },
  {
    name: 'body read fails after 200 headers',
    chain: [answer(200, undefined, undefined, { bodyFailure: true })],
    options: { maxAttempts: 1 },
    error: 'ConnectionError',
    outcome: 'unknown',
    retryAllowed: true,
  },
  ...['bodyFailure', 'bodyTimeout'].flatMap((failure) =>
    [false, true].map((earlierTimeout) => ({
      name: (earlierTimeout ? 'timeout then ' : '') + 'incomplete 401: ' + failure,
      chain: [
        ...(earlierTimeout ? [timeout] : []),
        answer(401, undefined, undefined, { [failure]: true }),
      ],
      options: { maxAttempts: earlierTimeout ? 2 : 1 },
      error: 'AuthenticationError',
      status: 401,
      outcome: 'unknown',
      retryAllowed: false,
      elapsed: failure === 'bodyTimeout' ? (earlierTimeout ? 250 : 100) : undefined,
    })),
  ),
  ...[403, 412, 429, 503].map((status) => ({
    name: 'timeout then incomplete ' + status,
    chain: [timeout, answer(status, undefined, undefined, { bodyFailure: true })],
    options: { maxAttempts: 2 },
    error: 'ConnectionError',
    status,
    outcome: 'unknown',
    retryAllowed: status !== 412,
  })),
  {
    name: 'timeout then 412 cancellation during body read vetoes retry',
    chain: [timeout, answer(412, undefined, undefined, { cancelBody: true })],
    options: { maxAttempts: 2 },
    error: 'CancelledError',
    status: 412,
    outcome: 'unknown',
    retryAllowed: false,
    elapsed: 160,
  },
  ...[false, true].map((earlierTimeout) => ({
    name: (earlierTimeout ? 'timeout then ' : '') + 'complete invalid SSE handshake',
    op: 'events',
    chain: [...(earlierTimeout ? [timeout] : []), answer(200)],
    error: 'UnexpectedResponseError',
    status: 200,
    outcome: 'response',
    retryAllowed: false,
  })),
  {
    name: 'timeout then incomplete invalid SSE handshake preserves uncertainty',
    op: 'events',
    chain: [timeout, answer(200, undefined, undefined, { bodyFailure: true })],
    options: { maxAttempts: 2 },
    error: 'ConnectionError',
    status: 200,
    outcome: 'unknown',
    retryAllowed: true,
  },
  {
    name: 'invalid success after timeout',
    chain: [timeout, answer(200, undefined, undefined, { raw: '{' })],
    error: 'UnexpectedResponseError',
    outcome: 'response',
    retryAllowed: false,
  },
  {
    name: 'proxy 502 keyed write',
    chain: [answer(502, undefined, undefined, { raw: '<html>proxy</html>' })],
    options: { maxAttempts: 1 },
    error: 'ServerError',
    outcome: 'unknown',
    retryAllowed: true,
  },
  {
    name: 'proxy 502 read',
    op: 'read',
    chain: [answer(502, undefined, undefined, { raw: '<html>proxy</html>' })],
    options: { maxAttempts: 1 },
    error: 'ServerError',
    outcome: 'response',
    retryAllowed: true,
  },
  {
    name: 'envelope without retry signal read',
    op: 'read',
    chain: [answer(503, 'TEMPORARY', null)],
    options: { maxAttempts: 1 },
    error: 'ServerError',
    outcome: 'response',
    retryAllowed: false,
  },
  {
    name: 'cancel before dispatch',
    chain: [],
    cancelBefore: true,
    error: 'CancelledError',
    outcome: 'not_sent',
    retryAllowed: true,
  },
  {
    name: '429 then cancelled during wait',
    chain: [answer(429)],
    cancelWait: true,
    error: 'CancelledError',
    outcome: 'not_sent',
    retryAllowed: true,
  },
  {
    name: '500 then cancelled during wait',
    chain: [answer(500)],
    cancelWait: true,
    error: 'CancelledError',
    outcome: 'unknown',
    retryAllowed: true,
  },
  {
    name: '429 then deadline during wait',
    chain: [answer(429)],
    overrunWait: true,
    error: 'TimeoutError',
    outcome: 'not_sent',
    retryAllowed: true,
  },
  {
    name: '500 then deadline during wait',
    chain: [answer(500)],
    overrunWait: true,
    error: 'TimeoutError',
    outcome: 'unknown',
    retryAllowed: true,
  },
  {
    name: 'in-progress then refused',
    chain: [answer(409, 'IDEMPOTENCY_KEY_IN_PROGRESS'), refused, refused],
    error: 'ConnectionError',
    outcome: 'unknown',
    retryAllowed: true,
  },
  {
    name: 'fully read success after deadline',
    chain: [answer(200, undefined, undefined, { lateRead: true })],
    result: true,
  },
  {
    name: 'decoding finishes after deadline',
    chain: [answer(200, undefined, undefined, { lateDecode: true })],
    result: true,
  },
  {
    name: 'cancellation after complete read preserves success',
    chain: [answer(200, undefined, undefined, { cancelRead: true })],
    result: true,
  },
  {
    name: 'fully read binary after deadline',
    op: 'binary',
    chain: [answer(200, undefined, undefined, { lateRead: true })],
    result: true,
  },
  {
    name: 'delayed money success uses operation timeout',
    op: 'payOrder',
    chain: [answer(200, undefined, undefined, { delayMs: 40000 })],
    options: { maxAttempts: 1 },
    defaults: true,
    result: true,
  },
];
// Each probe spends its effective attempt budget. A timeout larger than the deadline
// exposes the independent deadline default through the transport's bounded timeout.
const budgets = [
  { op: 'payOrder', dynamic: true, expected: 150000 },
  ...money.map((op) => ({ op, expected: 150000 })),
  { op: 'read', expected: 10000 },
  { op: 'write', expected: 10000 },
  { op: 'payOrder', client: { timeoutMs: 900000 }, expected: 300000 },
  { op: 'read', client: { timeoutMs: 900000 }, expected: 30000 },
  { op: 'payOrder', client: { timeoutMs: 5000 }, expected: 5000 },
  { op: 'payOrder', client: { deadlineMs: 4000 }, expected: 4000 },
  {
    op: 'payOrder',
    client: { timeoutMs: 5000, deadlineMs: 4000 },
    options: { timeoutMs: 3000 },
    expected: 3000,
  },
  {
    op: 'payOrder',
    client: { timeoutMs: 5000, deadlineMs: 4000 },
    options: { timeoutMs: 900000, deadlineMs: 6000 },
    expected: 6000,
  },
].map((row, index) => ({
  name: 'budget precedence ' + index,
  chain: [timeout],
  ...row,
  options: { maxAttempts: 1, ...row.options },
  defaults: true,
}));

function wire(step) {
  if (step.raw !== undefined) return step.raw;
  if (step.status === 200) return '{"value":"settled"}';
  return JSON.stringify({
    error: {
      code: step.code,
      message: 'Synthetic answer',
      remediation: { retry: step.retry },
      ...(step.reason ? { details: [{ reason: step.reason }] } : {}),
    },
  });
}
// Fake only the runtime's clocks and timers. Generated package code is unmodified.
async function nodeCase(row, t) {
  let now = 0,
    sequence = 0,
    settled = false,
    actual,
    lateDecode = false,
    cancelDecode = false;
  const timers = new Map(),
    calls = [],
    controller = new AbortController();
  const schedule = (fn, ms = 0) => {
    const handle = { id: ++sequence, unref() {} };
    timers.set(handle, { at: now + ms, fn });
    return handle;
  };
  t.mock.method(globalThis, 'setTimeout', schedule);
  t.mock.method(globalThis, 'clearTimeout', (handle) => timers.delete(handle));
  t.mock.method(performance, 'now', () => now);
  t.mock.method(Math, 'random', () => 0);
  const decode = TextDecoder.prototype.decode;
  t.mock.method(TextDecoder.prototype, 'decode', function (...args) {
    const value = decode.apply(this, args);
    if (lateDecode) {
      now += 2000;
      lateDecode = false;
    }
    if (cancelDecode) {
      controller.abort();
      cancelDecode = false;
    }
    return value;
  });
  const transport = async (_url, request) => {
    const step = row.chain[calls.length];
    assert.ok(step, row.name + ': unexpected dispatch');
    calls.push(new Headers(request.headers).get('idempotency-key'));
    if (step.failure === 'refused')
      throw Object.assign(new Error('Synthetic refusal'), { code: 'ECONNREFUSED' });
    if (step.failure === 'timeout') return new Promise(() => {});
    if (step.delayMs) await new Promise((resolve) => schedule(resolve, step.delayMs));
    const response = new Response(row.op === 'binary' ? '%PDF-synthetic' : wire(step), {
      status: step.status,
      headers: {
        'content-type': row.op === 'binary' ? 'application/pdf' : 'application/json',
        'x-request-id': 'req_' + calls.length,
        ...(step.retryAfter ? { 'retry-after': step.retryAfter } : {}),
      },
    });
    const read = response.arrayBuffer.bind(response);
    response.arrayBuffer = async () => {
      if (step.bodyFailure) throw new Error('Synthetic incomplete body');
      if (step.cancelBody) schedule(() => controller.abort(), 10);
      if (step.bodyTimeout || step.cancelBody) return new Promise(() => {});
      const bytes = await read();
      if (step.lateRead) now += 2000;
      if (step.lateDecode) lateDecode = true;
      if (step.cancelRead) cancelDecode = true;
      return bytes;
    };
    return response;
  };
  if (row.cancelBefore) controller.abort();
  let credentialCalls = 0;
  const token = {
    async getCredential() {
      if (++credentialCalls === row.authFailAt) throw new Error('Synthetic provider failure');
      return { value: 'synthetic-token' };
    },
  };
  const client = new sdk.Client({
    baseUrl: 'https://example.invalid',
    token,
    ...row.client,
    transport,
    diagnostics: () => {
      if (row.cancelWait) schedule(() => controller.abort(), 10);
    },
  });
  const request = row.dynamic
    ? (input, options) =>
        new Runtime(rawContract, {
          baseUrl: 'https://example.invalid',
          ...row.client,
          transport,
        }).request(row.op ?? 'write', input, options)
    : client.api[row.op ?? 'write'].bind(client.api);
  request(
    {},
    {
      ...(row.defaults ? {} : { timeoutMs: 100, deadlineMs: 1000 }),
      ...row.options,
      signal: controller.signal,
    },
  )
    .then(
      (result) => {
        actual = {
          result: true,
          raw: typeof result.raw === 'string' ? result.raw : Buffer.from(result.raw).toString(),
          ...result.meta,
        };
      },
      (error) => {
        actual = {
          error: error.name,
          status: error.status,
          code: error.code,
          outcome: error.outcome,
          retryAllowed: error.retryAllowed,
          retryAfterMs: error.retryAfterMs,
          requestIds: error.requestIds,
          attempts: error.attempts,
          key: error.idempotencyKey,
          message: error.message,
        };
      },
    )
    .finally(() => {
      settled = true;
    });
  for (let turn = 0; turn < 100 && !settled; turn++) {
    await immediate();
    if (settled) break;
    const entry = [...timers].sort((a, b) => a[1].at - b[1].at || a[0].id - b[0].id)[0];
    assert.ok(entry, row.name + ': no timer can make progress');
    timers.delete(entry[0]);
    now = Math.max(now, entry[1].at);
    if (row.overrunWait && calls.length) now += 2000;
    entry[1].fn();
  }
  assert.ok(settled, row.name + ': bounded fake-clock execution');
  t.mock.restoreAll();
  return { ...actual, calls, elapsed: now };
}
function verify(row, actual) {
  assert.equal(actual.calls.length, row.chain.length, row.name);
  if (row.expected !== undefined) {
    assert.equal(actual.elapsed, row.expected, row.name);
    return;
  }
  assert.equal(actual.result ?? false, row.result ?? false, row.name);
  if (row.result) {
    assert.equal(
      actual.raw,
      row.op === 'binary' ? '%PDF-synthetic' : '{"value":"settled"}',
      row.name,
    );
  } else {
    assert.equal(actual.error, row.error, row.name);
    assert.equal(actual.outcome, row.outcome, row.name);
    assert.equal(actual.retryAllowed, row.retryAllowed, row.name);
    if (row.status !== undefined) assert.equal(actual.status, row.status, row.name);
    if (row.retryAfterMs) {
      assert.equal(actual.retryAfterMs, row.retryAfterMs, row.name);
      assert.equal(actual.message, 'Synthetic answer', row.name);
    }
  }
  if (row.elapsed !== undefined) assert.equal(actual.elapsed, row.elapsed, row.name);
  assert.equal(actual.attempts, row.attempts ?? row.chain.length, row.name);
  const ids = row.chain.flatMap((step, index) => (step.status ? ['req_' + (index + 1)] : []));
  assert.deepEqual(actual.requestIds ?? [], ids, row.name);
  if (keyed(row.op ?? 'write')) {
    assert.ok(
      actual.calls.every((key) => key === actual.calls[0]),
      row.name + ': one key across attempts',
    );
    if (actual.calls.length) {
      if (row.options?.idempotencyKey)
        assert.equal(actual.calls[0], row.options.idempotencyKey, row.name);
      else assert.match(actual.calls[0], /^[0-9a-f-]{36}$/);
      assert.equal(actual.key ?? actual.idempotencyKey, actual.calls[0], row.name);
    }
  }
}

test('Node implements the outcome chain table with deterministic clocks', async (t) => {
  for (const row of rows) await t.test(row.name, async (t) => verify(row, await nodeCase(row, t)));
});
test('PHP implements the same independently expected outcome chains', () => {
  writeFileSync(join(root, 'rows.json'), JSON.stringify(rows));
  const results = JSON.parse(
    execFileSync(
      'php',
      ['tests/helpers/retry-outcomes.php', join(output, 'php'), join(root, 'rows.json')],
      { encoding: 'utf8' },
    ),
  );
  rows.forEach((row, i) => verify(row, results[i]));
});
test('request > client > operation > global budgets agree in both targets', async (t) => {
  // Explicit absence here lets the actual client and operation defaults apply.
  for (const row of budgets) {
    await t.test(row.name, async (t) => verify(row, await nodeCase(row, t)));
  }
  writeFileSync(join(root, 'budgets.json'), JSON.stringify(budgets));
  const results = JSON.parse(
    execFileSync(
      'php',
      ['tests/helpers/retry-outcomes.php', join(output, 'php'), join(root, 'budgets.json')],
      { encoding: 'utf8' },
    ),
  );
  budgets.forEach((row, i) => verify(row, results[i]));
});
test('generated RUNTIME options document operation defaults and their interim bound', () => {
  for (const target of ['node', 'php']) {
    const docs = readFileSync(join(output, target, 'RUNTIME.md'), 'utf8');
    assert.match(docs, /request > client > operation default > global default/);
    assert.match(docs, /interim until the server publishes an execution bound/);
    for (const op of money)
      assert.ok(docs.includes('| api.' + op + ' | 150000 | 300000 |'), target + ': ' + op);
  }
});
test('new profile fields reject invalid declarations and malformed runtime descriptors', () => {
  for (const defaults of [
    {},
    null,
    [],
    { unknown: 1 },
    { timeoutMs: 0 },
    { deadlineMs: -1 },
    { timeoutMs: 1.5 },
    { deadlineMs: Number.MAX_SAFE_INTEGER + 1 },
    { timeoutMs: '150000' },
  ]) {
    const invalid = structuredClone(config);
    invalid.operations.write.defaults = defaults;
    writeFileSync(join(root, 'invalid.json'), JSON.stringify(invalid));
    assert.throws(() => loadContract(join(root, 'api.json'), join(root, 'invalid.json')));
  }
  for (const inProgressCodes of [null, 'in_progress', [''], [42]]) {
    const invalid = { ...config, errors: { inProgressCodes } };
    writeFileSync(join(root, 'invalid-codes.json'), JSON.stringify(invalid));
    assert.throws(() => loadContract(join(root, 'api.json'), join(root, 'invalid-codes.json')));
  }
  const base = compileRuntimePlan(rawContract);
  const source = JSON.stringify(rawContract);
  assert.deepEqual(base, compileRuntimePlan(rawContract));
  assert.equal(JSON.stringify(rawContract), source);
  const malformed = [null, 'in_progress', [''], [42]].map((inProgressCodes) => ({
    ...base,
    errors: { ...base.errors, inProgressCodes },
  }));
  malformed.push(
    ...[
      null,
      [],
      { timeoutMs: 0 },
      { deadlineMs: 1.5 },
      { deadlineMs: '300000' },
      { surprise: 1 },
    ].map((defaults) => ({ ...base, operations: [{ ...base.operations[0], defaults }] })),
  );
  for (const descriptor of malformed) assert.throws(() => assertRuntimePlan(descriptor));
  writeFileSync(join(root, 'malformed.json'), JSON.stringify(malformed));
  execFileSync('php', [
    '-r',
    String.raw`require $argv[1].'/src/Runtime.php'; foreach(json_decode(file_get_contents($argv[2]), true) as $plan) { try { \RetryOutcomes\Runtime::assertCompiledPlan($plan); throw new \Exception('Accepted invalid descriptor'); } catch (\InvalidArgumentException $e) {} }`,
    join(output, 'php'),
    join(root, 'malformed.json'),
  ]);
});
