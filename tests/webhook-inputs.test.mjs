import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createHmac } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { generate, loadContract } from '../dist/index.js';
import { compileSdkContract } from '../dist/target-plan.js';
import { compareCompiledContracts } from '../dist/compiled-compatibility.js';
import { restoreCompiledSnapshot, storeCompiledSnapshot } from '../dist/compiled-record.js';

const dir = mkdtempSync(join(tmpdir(), 'sdk-webhook-inputs-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const now = 1700000000;
const amount = { type: 'integer', format: 'int64' };
const envelope = (audience) => ({
  type: 'object',
  properties: {
    event_type: { type: 'string', const: 'payment.updated' },
    audience: { type: 'string', enum: [audience] },
    data: { type: 'object', properties: { amount }, required: ['amount'] },
  },
  required: ['event_type', 'audience', 'data'],
});
const doc = {
  openapi: '3.1.0',
  info: { title: 'Webhook Inputs', version: '1' },
  paths: {
    '/health': { get: { operationId: 'health', responses: { 204: { description: 'OK' } } } },
  },
  components: { schemas: { Merchant: envelope('merchant'), Partner: envelope('partner') } },
  webhooks: {
    payment: {
      post: {
        requestBody: {
          content: {
            'application/json': {
              schema: {
                oneOf: [
                  { $ref: '#/components/schemas/Merchant' },
                  { $ref: '#/components/schemas/Partner' },
                ],
                discriminator: { propertyName: 'audience' },
              },
            },
          },
        },
        responses: { 200: { description: 'OK' } },
      },
    },
  },
};
writeFileSync(join(dir, 'api.json'), JSON.stringify(doc));
function run(command, args) {
  const r = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return r.stdout;
}
for (const format of ['hex', 'timestamped-hex', 'standard-webhooks']) {
  test(`${format}: framework headers, input errors, signed bytes, and known envelopes agree across targets`, async () => {
    const config = {
      version: '1.0.0',
      npm: { name: '@example/webhooks' },
      composer: { name: 'example/webhooks', namespace: 'Example\\Webhooks' },
      webhook: {
        algorithm: 'hmac-sha256',
        format,
        header: 'Webhook-Signature',
        ...(format === 'timestamped-hex' ? {} : { timestampHeader: 'Webhook-Timestamp' }),
        ...(format === 'standard-webhooks' ? { idHeader: 'Webhook-Id' } : {}),
        separator: '.',
        toleranceSeconds: 300,
        typeField: 'event_type',
        events: {
          'balance.changed': {
            type: 'object',
            properties: { event_type: { type: 'string' }, amount },
            required: ['event_type', 'amount'],
          },
        },
      },
    };
    const profile = join(dir, format + '.json');
    writeFileSync(profile, JSON.stringify(config));
    const out = join(dir, format);
    generate(loadContract(join(dir, 'api.json'), profile), out);
    const { Client, SdkError } = await import(pathToFileURL(join(out, 'node/index.js')));
    const client = new Client({ baseUrl: 'https://example.invalid' });
    const key = format === 'standard-webhooks' ? Buffer.alloc(32, 17) : 'synthetic-webhook-secret';
    const secret = format === 'standard-webhooks' ? 'whsec_' + key.toString('base64') : key;
    const raw =
      '{ "event_type":"payment.updated","audience":"merchant","data":{"amount":9007199254740993}}';
    const sign = (body, timestamp = String(now)) => {
      const digest = createHmac('sha256', key)
        .update((format === 'standard-webhooks' ? 'evt_fixture.' : '') + timestamp + '.' + body)
        .digest(format === 'standard-webhooks' ? 'base64' : 'hex');
      return {
        ...(format === 'timestamped-hex' ? {} : { 'Webhook-Timestamp': timestamp }),
        ...(format === 'standard-webhooks' ? { 'Webhook-Id': 'evt_fixture' } : {}),
        'Webhook-Signature':
          format === 'standard-webhooks'
            ? 'v1,' + digest
            : format === 'timestamped-hex'
              ? `t=${timestamp},v1=${digest}`
              : digest,
      };
    };
    const headers = sign(raw);
    const ok = {
      known: true,
      event: {
        event_type: 'payment.updated',
        audience: 'merchant',
        data: { amount: '9007199254740993' },
      },
    };
    const base = { body: raw, headers, secrets: secret, now, expected: ok };
    const failure = (code, kind = 'authentication') => ({
      error: kind,
      code: code ? 'webhook_' + code : null,
    });
    const arrays = Object.fromEntries(
      Object.entries(headers).map(([k, v]) => [k.toLowerCase(), [v]]),
    );
    const cases = [
      base,
      { ...base, headers: arrays },
      { ...base, secrets: ['wrong', secret] },
      { ...base, now: now - 300 },
      { ...base, now: now + 300 },
      ...[now - 301, now + 301].map((time) => ({
        ...base,
        now: time,
        expected: failure('timestamp_out_of_tolerance'),
      })),
      { ...base, body: raw + ' ', expected: failure('invalid_signature') },
      { ...base, body: JSON.stringify(JSON.parse(raw)), expected: failure('invalid_signature') },
      { ...base, body: JSON.parse(raw), expected: failure('invalid_input', 'validation') },
      { ...base, headers: {}, expected: failure('missing_header') },
      {
        ...base,
        headers: { ...headers, 'Webhook-Signature': 42 },
        expected: failure('invalid_input', 'validation'),
      },
      {
        ...base,
        headers: { ...headers, 'Webhook-Signature': [42] },
        expected: failure('invalid_input', 'validation'),
      },
      { ...base, headers: null, expected: failure('invalid_input', 'validation') },
      ...[[], '', [123], null].map((secrets) => ({
        ...base,
        secrets,
        expected: failure('invalid_secret', 'validation'),
      })),
      { ...base, now: 'yesterday', expected: failure('invalid_input', 'validation') },
      { ...base, headers: sign(raw, 'not-a-timestamp'), expected: failure('invalid_timestamp') },
      { ...base, body: '{', headers: sign('{'), expected: failure('invalid_json', 'protocol') },
      {
        ...base,
        body: '{"event_type":"balance.changed"}',
        headers: sign('{"event_type":"balance.changed"}'),
        expected: failure(null, 'protocol'),
      },
    ];
    for (const body of [
      'null',
      '42',
      '"synthetic-unknown-event"',
      '[1,2]',
      '{"event_type":"future.event","data":{"amount":1}}',
      '{"event_type":"payment.updated","audience":"future","data":{"amount":1}}',
    ]) {
      cases.push({
        ...base,
        body,
        headers: sign(body),
        expected: { known: false, event: JSON.parse(body) },
      });
    }
    if (format !== 'timestamped-hex') {
      cases.push({
        ...base,
        headers: { ...headers, 'Webhook-Timestamp': [String(now), String(now)] },
        expected: failure('invalid_timestamp'),
      });
      cases.push({
        ...base,
        headers: { ...headers, 'webhook-timestamp': String(now) },
        expected: failure('invalid_timestamp'),
      });
    } else
      cases.push({
        ...base,
        headers: { ...headers, 'Webhook-Signature': headers['Webhook-Signature'] + ',t=' + now },
        expected: failure('invalid_timestamp'),
      });
    if (format === 'standard-webhooks') {
      cases.push({
        ...base,
        headers: { ...headers, 'Webhook-Id': ['evt_fixture', 'evt_other'] },
        expected: failure('invalid_signature'),
      });
      cases.push({
        ...base,
        secrets: 'whsec_YQ==',
        expected: failure('invalid_secret', 'validation'),
      });
    }
    const additional =
      format === 'standard-webhooks'
        ? 'v1,' + Buffer.alloc(32).toString('base64')
        : format === 'timestamped-hex'
          ? 'v1=' + '0'.repeat(64)
          : '0'.repeat(64);
    const repeated = { ...arrays, 'webhook-signature': [headers['Webhook-Signature'], additional] };
    cases.push({ ...base, headers: repeated });
    for (const [index, c] of cases.entries()) {
      let actual;
      try {
        actual = JSON.parse(
          JSON.stringify(
            client.verifyWebhook(
              typeof c.body === 'string' ? Buffer.from(c.body) : c.body,
              c.headers,
              c.secrets,
              c.now,
            ),
          ),
        );
      } catch (error) {
        assert.ok(error instanceof SdkError, String(error));
        assert.ok(!error.message.includes(secret));
        assert.ok(!error.message.includes(raw));
        assert.ok(!error.message.includes(headers['Webhook-Signature']));
        actual = { error: error.kind, code: error.code ?? null };
      }
      assert.deepEqual(actual, c.expected, `case ${index}`);
    }
    for (const record of [headers, repeated]) {
      const fetchHeaders = new Headers();
      for (const [name, value] of Object.entries(record))
        for (const item of Array.isArray(value) ? value : [value]) fetchHeaders.append(name, item);
      assert.deepEqual(
        JSON.parse(
          JSON.stringify(client.verifyWebhook(Buffer.from(raw), fetchHeaders, secret, now)),
        ),
        ok,
      );
    }
    assert.deepEqual(
      JSON.parse(
        JSON.stringify(
          client.verifyWebhook(
            new Uint8Array(Buffer.from(raw)),
            { ...headers, irrelevant: undefined },
            Object.freeze([secret]),
            now,
          ),
        ),
      ),
      ok,
    );
    assert.throws(() => client.verifyWebhook(raw, headers, secret, now), {
      kind: 'validation',
      code: 'webhook_invalid_input',
    });
    const caseFile = join(dir, format + '-cases.json');
    writeFileSync(caseFile, JSON.stringify(cases));
    const php = String.raw`require $argv[1].'/src/Runtime.php';require $argv[1].'/src/Client.php';$c=new Example\Webhooks\Client(new Example\Webhooks\ClientOptions(baseUrl:'https://example.invalid'));$out=[];foreach(json_decode(file_get_contents($argv[2]),true) as $case){try{$out[]=$c->verifyWebhook($case['body'],$case['headers'],$case['secrets'],$case['now']);}catch(Example\Webhooks\SdkError $e){$sensitive=array_merge((array)$case['secrets'],(array)($case['headers']['Webhook-Signature']??[]),is_string($case['body'])?[$case['body']]:[]);foreach($sensitive as $value){if(is_string($value)&&strlen($value)>8&&str_contains($e->getMessage(),$value))throw new \RuntimeException('Webhook error exposed a sensitive fixture value');}$out[]=['error'=>$e->kind,'code'=>$e->errorCode];}}echo json_encode($out,JSON_THROW_ON_ERROR);`;
    assert.deepEqual(
      JSON.parse(run('php', ['-r', php, join(out, 'php'), caseFile])),
      cases.map((c) => c.expected),
    );
    assert.match(
      readFileSync(join(out, 'php/src/classes/Client.php'), 'utf8'),
      /array\{known: false, event: mixed\}/,
    );
    // Exercise the actual generated documentation, including middleware order.
    const guide = readFileSync(join(out, 'node/RUNTIME.md'), 'utf8');
    const blocks = [...guide.matchAll(/```js\n([\s\S]*?)```/g)].map((m) => m[1]);
    const fetchExample = blocks.find((body) =>
      body.includes('export async function verifyWebhookRequest'),
    );
    assert.ok(fetchExample);
    const helper = await import('data:text/javascript,' + encodeURIComponent(fetchExample));
    const currentHeaders = sign(raw, String(Math.floor(Date.now() / 1000)));
    const received = await helper.verifyWebhookRequest(
      client,
      new Request('https://example.invalid/webhooks', {
        method: 'POST',
        body: raw,
        headers: currentHeaders,
      }),
      secret,
    );
    assert.deepEqual(JSON.parse(JSON.stringify(received)), ok);
    const expressExample = blocks.find((body) => body.includes("app.post('/webhooks'"));
    let handler, forwarded, nextError;
    const order = [];
    const app = {
      post(path, parser, callback) {
        order.push('route');
        handler = callback;
      },
      use(parser) {
        order.push(parser);
      },
    };
    const express = {
      raw(options) {
        assert.equal(options.type, 'application/json');
        return 'raw';
      },
      json() {
        return 'json';
      },
    };
    new Function('app', 'express', 'client', 'webhookSecret', 'receiveVerified', expressExample)(
      app,
      express,
      client,
      secret,
      (verified) => {
        forwarded = verified;
      },
    );
    assert.deepEqual(order, ['route', 'json']);
    handler({ body: Buffer.from(raw), headers: currentHeaders }, {}, (error) => {
      nextError = error;
    });
    assert.equal(nextError, undefined);
    assert.deepEqual(JSON.parse(JSON.stringify(forwarded)), ok);
    handler({ body: JSON.parse(raw), headers: currentHeaders }, {}, (error) => {
      nextError = error;
    });
    assert.equal(nextError.code, 'webhook_invalid_input');
    const phpGuide = readFileSync(join(out, 'php/RUNTIME.md'), 'utf8');
    const phpExample = [...phpGuide.matchAll(/```php\n([\s\S]*?)```/g)]
      .map((m) => m[1])
      .find((body) => body.includes('function verifyWebhookRequest'));
    assert.ok(phpExample);
    const docCase = join(dir, format + '-doc.json');
    writeFileSync(
      docCase,
      JSON.stringify({
        raw,
        headers: Object.fromEntries(Object.entries(currentHeaders).map(([k, v]) => [k, [v]])),
        secret,
      }),
    );
    const docRunner =
      String.raw`require $argv[1].'/src/Runtime.php';require $argv[1].'/src/Client.php';` +
      phpExample +
      String.raw`
$f=json_decode(file_get_contents($argv[2]),true);$request=new class($f){public function __construct(private array $fixture){}public function getBody(){return $this->fixture['raw'];}public function getHeaders(){return $this->fixture['headers'];}};
echo json_encode(verifyWebhookRequest(new Example\Webhooks\Client(new Example\Webhooks\ClientOptions(baseUrl:'https://example.invalid')),$request,$f['secret']),JSON_THROW_ON_ERROR);`;
    assert.deepEqual(JSON.parse(run('php', ['-r', docRunner, join(out, 'php'), docCase])), ok);
    for (const target of ['node', 'php']) {
      assert.match(
        readFileSync(join(out, target, 'README.md'), 'utf8'),
        /verifyWebhook examples and errors/,
      );
      assert.match(readFileSync(join(out, target, 'REFERENCE.md'), 'utf8'), /## verifyWebhook/);
    }
    const keyedSecretsRunner = docRunner.replace(
      "$request,$f['secret']",
      "$request,['current'=>$f['secret']]",
    );
    assert.deepEqual(
      JSON.parse(run('php', ['-r', keyedSecretsRunner, join(out, 'php'), docCase])),
      ok,
    );
    const consumer = join(dir, format + '-consumer.ts');
    writeFileSync(
      consumer,
      `import {Client} from ${JSON.stringify(join(out, 'node/index.js'))};
import type {IncomingHttpHeaders} from 'node:http';
declare const headers: IncomingHttpHeaders;
const client=new Client({baseUrl:'https://example.invalid'});
const secret: readonly string[]=['synthetic'];
client.verifyWebhook(Buffer.from(''),headers,secret);
const result=client.verifyWebhook(new Uint8Array(),new Headers(),'synthetic');
if(result.known) {
  const name: 'payment.updated'|'balance.changed'=result.event.event_type;
  if(result.event.event_type==='payment.updated') { const amount: string=result.event.data.amount; }
  if(result.event.event_type==='balance.changed') { const amount: string=result.event.amount; }
} else {
  // @ts-expect-error Unknown authenticated events require application validation.
  result.event.data;
}
// @ts-expect-error Parsed JSON is not the original body.
client.verifyWebhook({event_type:'payment.updated'},headers,secret);
`,
    );
    run(process.execPath, [
      resolve('node_modules/typescript/bin/tsc'),
      '--noEmit',
      '--strict',
      '--target',
      'es2022',
      '--module',
      'nodenext',
      '--typeRoots',
      resolve('node_modules/@types'),
      consumer,
    ]);
    const declarations = readFileSync(join(out, 'node/declarations/Client.d.ts'), 'utf8');
    assert.match(declarations, /_SdkWebhookEnvelope/);
    assert.ok(declarations.match(/verifyWebhook[^\n]+/)[0].length < 1000);
  });
}

test('webhook declaration aliases remain deterministic, validated and visible to compatibility review', () => {
  const profile = join(dir, 'declarations.json');
  writeFileSync(
    profile,
    JSON.stringify({
      version: '1.0.0',
      npm: { name: '@example/webhook-declarations' },
      composer: { name: 'example/webhook-declarations', namespace: 'Example\\Webhooks' },
      webhook: {
        algorithm: 'hmac-sha256',
        header: 'X-Signature',
        timestampHeader: 'X-Timestamp',
        separator: '.',
        toleranceSeconds: 300,
        typeField: 'event_type',
        events: {
          'balance.changed': {
            type: 'object',
            properties: { event_type: { type: 'string' }, amount },
            required: ['event_type', 'amount'],
          },
        },
      },
    }),
  );
  const contract = loadContract(join(dir, 'api.json'), profile);
  const original = JSON.stringify(contract);
  const previous = compileSdkContract(contract).plan;
  assert.deepEqual(compileSdkContract(contract).plan, previous);
  assert.equal(JSON.stringify(contract), original);
  const changed = structuredClone(contract);
  changed.config.webhook.events['balance.changed'].properties.amount = { type: 'boolean' };
  const next = compileSdkContract(changed).plan;
  assert.equal(next.node.eventType, previous.node.eventType);
  assert.ok(
    compareCompiledContracts(previous, next).some((finding) => finding.subject === 'webhook'),
  );
  const malformed = structuredClone(previous);
  malformed.node.eventDeclarations = 42;
  assert.throws(
    () =>
      restoreCompiledSnapshot(
        storeCompiledSnapshot({
          plan: malformed,
          runtimeIdentity: { node: '0'.repeat(64), php: '0'.repeat(64) },
        }),
      ),
    /eventDeclarations/,
  );
});
