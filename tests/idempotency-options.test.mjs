import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { loadContract, generate } from '../dist/index.js';

test('required idempotency headers accept request options in both targets without weakening wire validation', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sdk-required-key-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    join(dir, 'api.json'),
    JSON.stringify({
      openapi: '3.1.0',
      info: { title: 'Required key', version: '1' },
      paths: {
        '/commands': {
          post: {
            operationId: 'mutate',
            parameters: [
              {
                in: 'header',
                name: 'Idempotency-Key',
                required: true,
                schema: { type: 'string', minLength: 3 },
              },
            ],
            responses: {
              200: {
                description: 'OK',
                content: { 'application/json': { schema: { type: 'object' } } },
              },
            },
          },
        },
      },
    }),
  );
  writeFileSync(
    join(dir, 'sdk.json'),
    JSON.stringify({
      version: '1.0.0',
      npm: { name: '@example/required-key' },
      composer: { name: 'example/required-key', namespace: 'RequiredKey' },
      validation: 'schema',
      operations: {
        mutate: {
          idempotency: {
            header: 'Idempotency-Key',
            retention: '24h',
            scope: 'command',
            auto: false,
          },
        },
      },
    }),
  );
  const output = join(dir, 'output');
  generate(loadContract(join(dir, 'api.json'), join(dir, 'sdk.json')), output);
  const sdk = await import(pathToFileURL(join(output, 'node/index.js')));
  const keys = [];
  const client = new sdk.Client({
    baseUrl: 'https://example.invalid',
    transport: async (_url, init) => {
      keys.push(new Headers(init.headers).get('idempotency-key'));
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    },
  });
  await client.api.mutate({}, { idempotencyKey: 'option-key' });
  await client.api.mutate({}, { headers: { 'IDEMPOTENCY-KEY': 'header-key' } });
  await client.api.mutate({ 'Idempotency-Key': 'same-key' }, { idempotencyKey: 'same-key' });
  await assert.rejects(client.api.mutate({}), sdk.SdkError);
  await assert.rejects(client.api.mutate({}, { idempotencyKey: '' }), sdk.SdkError);
  await assert.rejects(
    client.api.mutate({ 'Idempotency-Key': 'input-key' }, { idempotencyKey: 'other-key' }),
    sdk.SdkError,
  );
  assert.deepEqual(keys, ['option-key', 'header-key', 'same-key']);
  writeFileSync(
    join(output, 'node/check.ts'),
    "import {Client} from './index.js'; const c = new Client({baseUrl:'https://example.invalid'}); c.api.mutate({}, {idempotencyKey:'key'});\n",
  );
  execFileSync(process.execPath, [
    'node_modules/typescript/bin/tsc',
    '--strict',
    '--noEmit',
    '--skipLibCheck',
    '--module',
    'NodeNext',
    '--moduleResolution',
    'NodeNext',
    '--target',
    'ES2022',
    join(output, 'node/check.ts'),
  ]);
  execFileSync('php', [
    '-r',
    String.raw`
set_error_handler(static function($severity, $message, $file, $line) { throw new \ErrorException($message, 0, $severity, $file, $line); });
require $argv[1].'/src/Runtime.php'; require $argv[1].'/src/Client.php';
$keys = [];
$c = new \RequiredKey\Client(new \RequiredKey\ClientOptions(baseUrl: 'https://example.invalid', transport: function($r) use (&$keys) {
  $keys[] = $r['headers']['idempotency-key'];
  return ['status'=>200,'headers'=>['content-type'=>'application/json'],'body'=>'{}'];
}));
$c->api->mutate([], new \RequiredKey\RequestOptions(idempotencyKey: 'option-key'));
$c->api->mutate([], new \RequiredKey\RequestOptions(headers: ['IDEMPOTENCY-KEY'=>'header-key']));
$c->api->mutate(['Idempotency-Key'=>'same-key'], new \RequiredKey\RequestOptions(idempotencyKey: 'same-key'));
foreach ([fn() => $c->api->mutate([]), fn() => $c->api->mutate([], new \RequiredKey\RequestOptions(idempotencyKey: '')), fn() => $c->api->mutate(['Idempotency-Key'=>'input-key'], new \RequiredKey\RequestOptions(idempotencyKey: 'other-key'))] as $call) {
  try { $call(); throw new \RuntimeException('Expected key validation'); } catch (\RequiredKey\SdkError $e) {}
}
if ($keys !== ['option-key','header-key','same-key']) throw new \RuntimeException('Incorrect keys on wire');
`,
    join(output, 'php'),
  ]);
});
