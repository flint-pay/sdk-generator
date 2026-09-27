import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { inspect } from 'node:util';
import { loadContract, generate } from '../dist/index.js';

function fixture(t, errors, operations) {
  const dir = mkdtempSync(join(tmpdir(), 'sdk-api-errors-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const errorSchema = {
    type: 'object',
    properties: {
      message: { type: 'string' },
      explanation: { type: 'string' },
      privateMessage: { type: 'string', 'x-sensitive': true },
      privateDetail: { type: 'string', writeOnly: true },
    },
  };
  const source = join(dir, 'api.json');
  const config = join(dir, 'sdk.json');
  writeFileSync(
    source,
    JSON.stringify({
      openapi: '3.1.0',
      info: { title: 'API errors', version: '1' },
      paths: {
        '/value': {
          get: {
            operationId: 'readValue',
            responses: {
              200: { description: 'Empty' },
              default: {
                description: 'Error',
                content: {
                  'application/json': {
                    schema: {
                      ...errorSchema,
                      properties: {
                        ...errorSchema.properties,
                        error: { $ref: '#/components/schemas/Error' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      components: { schemas: { Error: errorSchema } },
    }),
  );
  writeFileSync(
    config,
    JSON.stringify({
      version: '1.0.0',
      npm: { name: '@example/api-errors' },
      composer: { name: 'example/api-errors', namespace: 'Example\\Errors' },
      ...(errors ? { errors } : {}),
      ...(operations ? { operations } : {}),
    }),
  );
  return { source, config, output: join(dir, 'sdk') };
}

const cases = [
  {
    status: 404,
    payload: { code: 'NOT_FOUND', message: 'Payment intent pi_1 not found' },
    message: 'Payment intent pi_1 not found',
    kind: 'not_found',
  },
  {
    status: 500,
    payload: { message: 'Payment service unavailable' },
    message: 'Payment service unavailable',
    kind: 'server',
  },
  { status: 503, payload: { message: 'Try later' }, message: 'Try later', kind: 'server' },
  ...[
    [400, 'validation'],
    [422, 'validation'],
    [401, 'authentication'],
    [403, 'authentication'],
    [409, 'conflict'],
    [412, 'conflict'],
    [429, 'rate_limit'],
    [418, 'api'],
  ].map(([status, kind]) => ({
    status,
    payload: { message: 'Provider explanation' },
    message: 'Provider explanation',
    kind,
  })),
  ...[
    undefined,
    null,
    '',
    ' \t\n',
    '\u00a0\u2003\u2028\ufeff',
    42,
    false,
    {},
    ['not a message'],
  ].map((message) => ({
    status: 404,
    payload: { message },
    message: 'API returned HTTP 404',
    kind: 'not_found',
  })),
  ...['\u0085', '\0', ' café 😀 '].map((message) => ({
    status: 404,
    payload: { message },
    message,
    kind: 'not_found',
  })),
  ...['', '<html>Bad gateway</html>', '{broken', 'null', '42', '"just a string"'].map((raw) => ({
    status: 502,
    raw,
    message: 'API returned HTTP 502',
    kind: 'server',
  })),
];

for (const nested of [false, true]) {
  test(`generated errors expose actionable messages and status (${nested ? 'configured' : 'default'} paths) in both targets`, async (t) => {
    const f = fixture(
      t,
      nested
        ? {
            codePath: 'error.code',
            messagePath: 'error.explanation',
            detailsPath: 'error.fields',
            requestIdHeader: 'Trace-Id',
          }
        : undefined,
    );
    generate(loadContract(f.source, f.config), f.output);
    const { Client, SdkError } = await import(pathToFileURL(join(f.output, 'node/index.js')));
    const wireCases = cases.map((c) => ({
      ...c,
      raw:
        c.raw ??
        JSON.stringify(
          nested
            ? {
                error: {
                  code: c.payload.code,
                  explanation: c.payload.message,
                  message: 'Wrong field',
                  fields: { reason: 'Missing payment' },
                },
              }
            : c.payload,
        ),
    }));
    const expected = [];
    for (const c of wireCases) {
      const events = [];
      const client = new Client({
        baseUrl: 'https://example.invalid',
        diagnostics: (event) => events.push(event),
        transport: async () =>
          new Response(c.raw, {
            status: c.status,
            headers: {
              [nested ? 'Trace-Id' : 'x-request-id']: 'req_error',
              'set-cookie': 'cookie-secret',
            },
          }),
      });
      await assert.rejects(client.api.readValue(), (error) => {
        assert.ok(error instanceof SdkError);
        assert.equal(error.message, c.message);
        assert.equal(error.status, c.status);
        assert.equal(error.meta.status, c.status);
        assert.equal(error.kind, c.kind);
        assert.equal(error.code, c.payload?.code);
        assert.equal(error.outcome, 'response');
        assert.equal(error.retryAllowed, false);
        assert.equal(error.raw, c.raw);
        assert.equal(error.meta.requestId, 'req_error');
        if (nested && c.payload) assert.deepEqual(error.details, { reason: 'Missing payment' });
        const logged = inspect(error);
        assert.ok(logged.includes('stack:'));
        assert.ok(logged.includes('code:'));
        assert.ok(logged.includes('details:'));
        assert.ok(logged.includes('SdkError:'));
        assert.ok(!logged.includes('cookie-secret'));
        expected.push({
          message: c.message,
          status: c.status,
          kind: c.kind,
          code: c.payload?.code ?? null,
          details: error.details ?? null,
          raw: c.raw,
        });
        return true;
      });
      assert.equal(events.length, 1);
      assert.equal(events[0].errorKind, c.kind);
      assert.equal(events[0].status, c.status);
      assert.equal(events[0].message, undefined);
    }
    const local = new SdkError('validation', 'Invalid input');
    assert.equal(local.status, undefined);
    const result = spawnSync(
      'php',
      [
        '-d',
        'zend.exception_ignore_args=0',
        '-r',
        String.raw`
require $argv[1].'/src/Runtime.php';require $argv[1].'/src/Client.php';
$results=[];
foreach(json_decode(stream_get_contents(STDIN),true) as $c){
  $client=new Example\Errors\Client(new Example\Errors\ClientOptions('https://example.invalid',transport:fn($r)=>['status'=>$c['status'],'headers'=>['Trace-Id'=>'req_error','x-request-id'=>'req_error','set-cookie'=>'cookie-secret'],'body'=>$c['raw']]));
  try{$client->api->readValue();throw new Exception('Expected error');}
  catch(Example\Errors\SdkError $e){
    if($e->status!==$e->meta['status']||$e->outcome!=='response'||$e->retryAllowed||$e->meta['requestId']!=='req_error')throw $e;
    if(!array_key_exists('stack',$e->__debugInfo())||!$e->__debugInfo()['stack'])throw new Exception('Missing stack');
    ob_start();var_dump($e);$logged=ob_get_clean();
    if(str_contains($logged,'cookie-secret')||!str_contains($logged,'details')||!str_contains($logged,'errorCode'))throw new Exception('Invalid debug output');
    $results[]=['message'=>$e->getMessage(),'status'=>$e->status,'kind'=>$e->kind,'code'=>$e->errorCode,'details'=>$e->details,'raw'=>$e->raw];
  }
}
if((new Example\Errors\SdkError('validation','Invalid input'))->status!==null)throw new Exception('Unexpected status');
echo json_encode($results);
`,
        join(f.output, 'php'),
      ],
      { encoding: 'utf8', input: JSON.stringify(wireCases) },
    );
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.deepEqual(JSON.parse(result.stdout), expected);
  });
}

test('message extraction and debug output honor schema and consumer redaction in both targets', async (t) => {
  const f = fixture(t, {
    codePath: 'error.privateDetail',
    messagePath: 'error.privateMessage',
    detailsPath: 'error',
  });
  generate(loadContract(f.source, f.config), f.output);
  const { Client } = await import(pathToFileURL(join(f.output, 'node/index.js')));
  const body = JSON.stringify({
    error: {
      privateMessage: 'hidden-message',
      privateDetail: 'hidden-detail',
      customField: 'hidden-custom',
      token: 'hidden-token',
      reason: 'Missing payment',
    },
  });
  const client = new Client({
    baseUrl: 'https://example.invalid',
    redactFields: ['customField'],
    transport: async () => new Response(body, { status: 404 }),
  });
  await assert.rejects(client.api.readValue(), (error) => {
    assert.equal(error.message, '[REDACTED]');
    assert.equal(error.code, '[REDACTED]');
    assert.equal(error.details.privateDetail, '[REDACTED]');
    assert.equal(error.details.customField, '[REDACTED]');
    assert.ok(inspect(error).includes('Missing payment'));
    assert.ok(!inspect(error).includes('hidden-'));
    assert.equal(error.raw, body);
    return true;
  });
  const result = spawnSync(
    'php',
    [
      '-d',
      'zend.exception_ignore_args=0',
      '-r',
      String.raw`
require $argv[1].'/src/Runtime.php';require $argv[1].'/src/Client.php';
$body=stream_get_contents(STDIN);
$client=new Example\Errors\Client(new Example\Errors\ClientOptions('https://example.invalid',redactFields:['customField'],transport:fn($r)=>['status'=>404,'headers'=>[],'body'=>$body]));
try{$client->api->readValue();exit(1);}catch(Example\Errors\SdkError $e){
  if($e->getMessage()!=='[REDACTED]'||$e->errorCode!=='[REDACTED]'||$e->raw!==$body)throw $e;
  ob_start();var_dump($e);$logged=ob_get_clean();
  if(str_contains($logged,'hidden-')||!str_contains($logged,'Missing payment'))throw new Exception('Invalid redaction');
}
`,
      join(f.output, 'php'),
    ],
    { encoding: 'utf8', input: body },
  );
  assert.equal(result.status, 0, result.stderr + result.stdout);
});

test('messagePath rejects invalid field paths during configuration validation', (t) => {
  for (const messagePath of ['', '.', 'error..message', 'error[message]', 1, null, {}]) {
    const f = fixture(t, { messagePath });
    assert.throws(
      () => loadContract(f.source, f.config),
      /config\/errors\/messagePath.*dot-separated/,
    );
  }
});

test('redacting provider codes does not change code-specific retry eligibility', async (t) => {
  const f = fixture(
    t,
    { codePath: 'error.privateDetail' },
    {
      readValue: {
        retry: {
          maxAttempts: 2,
          statuses: [],
          errors: [{ status: 503, codes: ['hidden-detail'] }],
          transport: false,
          baseDelayMs: 1,
        },
      },
    },
  );
  generate(loadContract(f.source, f.config), f.output);
  const { Client } = await import(pathToFileURL(join(f.output, 'node/index.js')));
  const body = JSON.stringify({ error: { privateDetail: 'hidden-detail' } });
  let attempts = 0;
  const client = new Client({
    baseUrl: 'https://example.invalid',
    transport: async () =>
      ++attempts === 1 ? new Response(body, { status: 503 }) : new Response(null, { status: 200 }),
  });
  await client.api.readValue();
  assert.equal(attempts, 2);
  const result = spawnSync(
    'php',
    [
      '-r',
      String.raw`
require $argv[1].'/src/Runtime.php';require $argv[1].'/src/Client.php';
$body=stream_get_contents(STDIN);$attempts=0;
$c=new Example\Errors\Client(new Example\Errors\ClientOptions('https://example.invalid',transport:function($r)use(&$attempts,$body){return ++$attempts===1?['status'=>503,'headers'=>[],'body'=>$body]:['status'=>200,'headers'=>[],'body'=>''];}));
$c->api->readValue();echo $attempts;
`,
      join(f.output, 'php'),
    ],
    { encoding: 'utf8', input: body },
  );
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(result.stdout, '2');
});

test('redaction does not turn invalid messages or codes into valid strings', async (t) => {
  const f = fixture(t, { messagePath: 'error.privateMessage', codePath: 'error.privateDetail' });
  generate(loadContract(f.source, f.config), f.output);
  const { Client } = await import(pathToFileURL(join(f.output, 'node/index.js')));
  const bodies = [null, 42, false, {}, [], '', ' \u00a0\ufeff'].map((value) =>
    JSON.stringify({ error: { privateMessage: value, privateDetail: value } }),
  );
  const expected = bodies.map((body) => ({
    message: 'API returned HTTP 404',
    code: typeof JSON.parse(body).error.privateDetail === 'string' ? '[REDACTED]' : null,
  }));
  for (const [i, body] of bodies.entries()) {
    const client = new Client({
      baseUrl: 'https://example.invalid',
      transport: async () => new Response(body, { status: 404 }),
    });
    await assert.rejects(client.api.readValue(), (error) => {
      assert.equal(error.message, expected[i].message);
      assert.equal(error.code ?? null, expected[i].code);
      return true;
    });
  }
  const result = spawnSync(
    'php',
    [
      '-r',
      String.raw`
require $argv[1].'/src/Runtime.php';require $argv[1].'/src/Client.php';$rows=[];
foreach(json_decode(stream_get_contents(STDIN)) as $body){
$c=new Example\Errors\Client(new Example\Errors\ClientOptions('https://example.invalid',transport:fn($r)=>['status'=>404,'headers'=>[],'body'=>$body]));
try{$c->api->readValue();exit(1);}catch(Example\Errors\SdkError $e){$rows[]=['message'=>$e->getMessage(),'code'=>$e->errorCode];}}
echo json_encode($rows);
`,
      join(f.output, 'php'),
    ],
    { encoding: 'utf8', input: JSON.stringify(bodies) },
  );
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), expected);
});
