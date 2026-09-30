import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { loadContract, generate } from '../dist/index.js';

function fixture(t, style, headerParameter) {
  const dir = mkdtempSync(join(tmpdir(), 'sdk-recovery-example-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const api = {
    openapi: '3.1.0',
    info: { title: 'Synthetic recovery examples', version: '1' },
    paths: {
      '/actions': {
        post: {
          operationId: 'createAction',
          parameters: headerParameter
            ? [{ in: 'header', name: 'Idempotency-Key', schema: { type: 'string' } }]
            : [],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['reference'],
                  properties: { reference: { type: 'string' } },
                },
              },
            },
          },
          responses: {
            200: {
              description: 'OK',
              content: { 'application/json': { schema: { type: 'object' } } },
            },
          },
        },
      },
    },
  };
  const config = {
    version: '1.0.0',
    npm: { name: '@example/recovery' },
    composer: { name: 'example/recovery', namespace: 'RecoveryExample' },
    requests: { style },
    responses: { return: 'result' },
    operations: {
      createAction: {
        resource: 'actions',
        method: 'create',
        idempotency: { header: 'Idempotency-Key', auto: true, retention: '24h', scope: 'action' },
        retry: { maxAttempts: 3, statuses: [503], transport: false, baseDelayMs: 0 },
        example: { body: { reference: 'saved-input' } },
      },
    },
  };
  writeFileSync(join(dir, 'api.json'), JSON.stringify(api));
  writeFileSync(join(dir, 'sdk.json'), JSON.stringify(config));
  const output = join(dir, 'output');
  generate(loadContract(join(dir, 'api.json'), join(dir, 'sdk.json')), output);
  return { output, read: (path) => readFileSync(join(output, path), 'utf8') };
}

async function runNode(f, source, statuses) {
  const { Client, SdkError } = await import(pathToFileURL(join(f.output, 'node/index.js')));
  const requests = [];
  class ExampleClient extends Client {
    constructor(options) {
      super({
        ...options,
        transport: async (_url, init) => {
          requests.push({ key: new Headers(init.headers).get('idempotency-key'), body: init.body });
          return new Response('{}', { status: statuses[requests.length - 1] });
        },
      });
    }
  }
  const execute = new Function(
    'Client',
    'process',
    'console',
    `return (async () => {${source.replace(/^import .*;\n/gm, '')}})();`,
  );
  let status = 200;
  try {
    await execute(
      ExampleClient,
      { env: { API_BASE_URL: 'https://example.invalid', API_IDEMPOTENCY_KEY: 'saved-action-key' } },
      { log() {} },
    );
  } catch (error) {
    assert.ok(error instanceof SdkError);
    status = error.status;
  }
  return { status, requests };
}

function runPhp(f, source, statuses) {
  const executable = source
    .replace('<?php\n', '')
    .replace(
      "require __DIR__ . '/vendor/autoload.php';",
      `require $argv[1].'/src/Runtime.php'; require $argv[1].'/src/Client.php';`,
    )
    .replace(
      'new ClientOptions(',
      `new ClientOptions(transport: function($r) use (&$requests, $statuses) {
        $requests[] = ['key' => $r['headers']['idempotency-key'], 'body' => $r['body']];
        return ['status' => $statuses[count($requests) - 1], 'headers' => [], 'body' => '{}'];
      },`,
    )
    .replace(
      '$baseUrl =',
      `$requests = []; $statuses = json_decode($argv[2], true); $status = 200;
      ob_start(); try { $baseUrl =`,
    );
  return JSON.parse(
    execFileSync(
      'php',
      [
        '-r',
        executable +
          `} catch (\\RecoveryExample\\SdkError $e) { $status = $e->status; }
          ob_end_clean(); echo json_encode(['status' => $status, 'requests' => $requests]);`,
        join(f.output, 'php'),
        JSON.stringify(statuses),
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          API_BASE_URL: 'https://example.invalid',
          API_IDEMPOTENCY_KEY: 'saved-action-key',
        },
      },
    ),
  );
}

for (const style of ['object', 'positional']) {
  for (const headerParameter of [false, true]) {
    test(`recovery examples send once; new actions retain retries (${style}, key ${headerParameter ? 'parameter' : 'option'})`, async (t) => {
      const f = fixture(t, style, headerParameter);
      for (const [target, run] of [
        ['node', runNode],
        ['php', runPhp],
      ]) {
        const guide = f
          .read(`${target}/RUNTIME.md`)
          .split('## Resume an action with its saved key')[1];
        const recovery = guide.match(/```(?:typescript|php)\n([\s\S]*?)```/)[1];
        const resumed = await run(f, recovery, [503, 200]);
        assert.equal(resumed.status, 503, target);
        assert.deepEqual(
          resumed.requests,
          [{ key: 'saved-action-key', body: '{"reference":"saved-input"}' }],
          target,
        );

        const fresh = await run(
          f,
          f
            .read(`${target}/examples/actions-create.${target === 'node' ? 'mjs' : 'php'}`)
            .replace("'/../vendor/autoload.php'", "'/vendor/autoload.php'"),
          [503, 503, 200],
        );
        assert.equal(fresh.status, 200, target);
        assert.equal(fresh.requests.length, 3, target);
        assert.match(fresh.requests[0].key, /^[\da-f-]{32,36}$/);
        assert.ok(fresh.requests.every((request) => request.key === fresh.requests[0].key));
      }
    });
  }
}
