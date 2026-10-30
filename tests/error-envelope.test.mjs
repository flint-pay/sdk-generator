import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadContract, generate } from '../dist/index.js';
import { compileSdkContract } from '../dist/target-plan.js';

test('configured error envelopes preserve fields in Node and PHP and close retry typing', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sdk-envelope-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const string = { type: 'string' };
  const properties = {
    code: { ...string, enum: ['INVALID_REQUEST'] },
    message: string,
    type: { ...string, enum: ['invalid_request'] },
    param: string,
    details: {
      type: 'array',
      items: {
        type: 'object',
        properties: { param: string, reason: { ...string, enum: ['required'] } },
        required: ['param', 'reason'],
      },
    },
    remediation: {
      type: 'object',
      properties: {
        retry: { ...string, enum: ['same_request', 'after_refresh', 'none'] },
        next_steps: { type: 'array', items: string },
      },
    },
    error_source: string,
    doc_url: string,
    request_id: string,
    request_log_url: string,
    secret: { ...string, 'x-sensitive': true },
  };
  properties.issues = properties.details;
  delete properties.details;
  const source = join(dir, 'api.json'),
    config = join(dir, 'sdk.json'),
    output = join(dir, 'sdk');
  writeFileSync(
    source,
    JSON.stringify({
      openapi: '3.1.0',
      info: { title: 'Envelope', version: '1' },
      paths: {
        '/read': {
          get: {
            operationId: 'read',
            responses: {
              200: { description: 'OK' },
              default: {
                description: 'Error',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: { failure: { type: 'object', properties } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    }),
  );
  const settings = {
    version: '1.0.0',
    responses: { return: 'result' },
    npm: { name: '@example/envelope' },
    composer: { name: 'example/envelope', namespace: 'Example' },
    errors: { objectPath: 'failure', fields: { message: 'message', details: 'issues' } },
  };
  writeFileSync(config, JSON.stringify(settings));
  generate(loadContract(source, config), output);
  const { Client, errors } = await import(pathToFileURL(join(output, 'node/index.js')));
  const rows = [
    [
      400,
      {
        failure: {
          code: 'INVALID_REQUEST',
          message: 'Choose a currency',
          type: 'invalid_request',
          param: 'metadata["a.b"]',
          details: [{ param: 'line_items[0].type', reason: 'required' }],
          error_source: 'caller',
          doc_url: '/errors/invalid',
          request_id: 'req_body',
          request_log_url: '/requests/1',
          secret: 'hidden-value',
        },
      },
    ],
    [
      403,
      {
        failure: {
          code: 'INSUFFICIENT_SCOPE',
          message: 'Ask the merchant',
          error_source: 'merchant_endpoint',
          remediation: { retry: 'after_refresh', next_steps: ['Ask for scope'] },
        },
      },
    ],
    [400, { error: 'invalid_grant', error_description: 'Grant expired' }],
    [502, '<html>Proxy failure</html>'],
    [
      400,
      {
        failure: {
          code: 'FUTURE_CODE',
          message: 'Still mapped',
          param: 'X-Request-Id',
          details: [{ param: 42, reason: 'required' }],
        },
      },
    ],
  ];
  rows.push([
    403,
    {
      failure: {
        code: 'FUTURE',
        remediation: { retry: 'future', next_steps: ['Contact support'] },
      },
    },
  ]);
  rows.push([
    400,
    { failure: { code: 'INVALID_REQUEST', details: { 0: { param: 'name', reason: 'required' } } } },
  ]);
  for (const [, body] of rows)
    if (body.failure && Object.hasOwn(body.failure, 'details')) {
      body.failure.issues = body.failure.details;
      delete body.failure.details;
    }
  const observed = [];
  for (const [status, body] of rows) {
    const client = new Client({
      baseUrl: 'https://example.invalid',
      maxAttempts: 1,
      transport: async () =>
        new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
    });
    await assert.rejects(client.api.read(), (e) => {
      assert.ok(e instanceof errors.ApiError);
      assert.ok(Array.isArray(e.details));
      assert.equal(Object.keys(e).includes('body'), false);
      assert.equal(JSON.stringify(e).includes('hidden-value'), false);
      const fields = Object.fromEntries(
        [
          'code',
          'type',
          'param',
          'details',
          'remediation',
          'errorSource',
          'docUrl',
          'requestLogUrl',
          'requestId',
          'requestIds',
          'body',
        ].map((k) => [k, e[k] ?? null]),
      );
      observed.push({ message: e.message, ...fields });
      return true;
    });
  }
  assert.equal(observed[0].details[0].param, 'line_items[0].type');
  assert.equal(observed[0].param, 'metadata["a.b"]');
  assert.equal(observed[0].requestId, 'req_body');
  assert.deepEqual(observed[0].requestIds, ['req_body']);
  assert.equal(JSON.stringify(observed[0].body).includes('hidden-value'), false);
  assert.deepEqual(observed[1].remediation.next_steps, ['Ask for scope']);
  assert.equal(observed[2].code, 'invalid_grant');
  assert.equal(observed[2].message, 'Grant expired');
  assert.equal(observed[3].code, 'http_error');
  assert.deepEqual(observed[4].details, []);
  assert.equal(observed[4].param, 'X-Request-Id');
  assert.deepEqual(observed[5].remediation, { next_steps: ['Contact support'] });
  assert.equal(observed[5].body.failure.remediation.retry, 'future');
  assert.deepEqual(observed[6].details, []);
  writeFileSync(
    join(dir, 'rows.json'),
    JSON.stringify(
      rows.map(([status, body]) => [
        status,
        typeof body === 'string' ? body : JSON.stringify(body),
      ]),
    ),
  );
  writeFileSync(
    join(dir, 'check.php'),
    `<?php
require $argv[1].'/php/src/Runtime.php';
require $argv[1].'/php/src/Client.php';
$out=[];
foreach(json_decode(file_get_contents($argv[2]),true) as [$status,$body]) {
 $client=new Example\\Client(new Example\\ClientOptions(baseUrl:'https://example.invalid',maxAttempts:1,transport:fn()=>['status'=>$status,'headers'=>[],'body'=>is_string($body)?$body:json_encode($body)]));
 try {$client->api->read();} catch(Example\\Errors\\ApiError $e) {
  $row=['message'=>$e->getMessage()]; foreach(['code','type','param','details','remediation','errorSource','docUrl','requestLogUrl','requestId','requestIds','body'] as $k) $row[$k]=$e->$k;
  $out[]=$row;
 }
}
echo json_encode($out);
`,
  );
  const php = spawnSync('php', [join(dir, 'check.php'), output, join(dir, 'rows.json')], {
    encoding: 'utf8',
  });
  assert.equal(php.status, 0, php.stderr);
  const phpRows = JSON.parse(php.stdout);
  assert.deepEqual(phpRows.slice(0, 4), observed.slice(0, 4));
  assert.deepEqual(phpRows.slice(5), observed.slice(5));
  // PHP exposes API arrays without Node's declaration certificate. Other fields still agree.
  const { details: phpDetails, ...phpOther } = phpRows[4];
  const { details: nodeDetails, ...nodeOther } = observed[4];
  assert.ok(Array.isArray(phpDetails));
  assert.deepEqual(phpOther, nodeOther);
  const consumer = join(output, 'node/consumer.ts');
  writeFileSync(
    consumer,
    `import {errors} from './index.js';
function check(e:errors.ApiError) {
 const retry: 'same_request'|'after_refresh'|'none'|undefined=e.remediation?.retry;
 if(retry==='after_refresh') { const narrowed:'after_refresh'=retry; }
 // @ts-expect-error retry is closed
 const future: NonNullable<typeof retry>='future';
 const reason:string|undefined=e.details[0]?.reason;
 const source:string|undefined=e.errorSource;
 const code:string=e.code;
}
`,
  );
  const types = spawnSync(
    process.execPath,
    [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '--strict',
      '--module',
      'nodenext',
      '--target',
      'es2022',
      '--skipLibCheck',
      consumer,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(types.status, 0, types.stdout + types.stderr);
  assert.match(readFileSync(join(output, 'node/ERRORS.md'), 'utf8'), /requestLogUrl/);
  for (const type of [['array', 'null'], 'object']) {
    const api = JSON.parse(readFileSync(source));
    api.paths['/read'].get.responses.default.content[
      'application/json'
    ].schema.properties.failure.properties.issues.type = type;
    writeFileSync(source, JSON.stringify(api));
    const { plan } = compileSdkContract(loadContract(source, config));
    assert.doesNotMatch(plan.node.errorTypes.details, /\bnull\b/);
    assert.match(plan.node.errorTypes.details, /ReadonlyArray<|\[\]/);
  }
  settings.errors.fields.param = 'missing';
  writeFileSync(config, JSON.stringify(settings));
  assert.throws(() => generate(loadContract(source, config), output), /fields\/param.*absent/);
});
