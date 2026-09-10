import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { loadContract, generate } from '../dist/index.js';
const dir = mkdtempSync(join(tmpdir(), 'sdk-numeric-unions-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const schema = {
  type: 'object',
  required: ['values'],
  properties: {
    values: {
      type: 'array',
      items: {
        oneOf: [{ type: 'string' }, { type: 'number', multipleOf: 0.0001 }, { type: 'boolean' }],
      },
    },
  },
};
writeFileSync(
  join(dir, 'api.json'),
  JSON.stringify({
    openapi: '3.1.0',
    info: { title: 'Values', version: 'v1' },
    paths: {
      '/values': {
        post: {
          operationId: 'createValues',
          requestBody: { required: true, content: { 'application/json': { schema } } },
          responses: { 204: { description: 'ok' } },
        },
      },
    },
  }),
);
const config = {
  version: '1.0.0',
  npm: { name: '@example/values' },
  composer: { name: 'example/values', namespace: 'Example\\Values' },
};
test('opt-in numeric unions preserve JSON strings and explicit numeric tokens in both clients', async () => {
  writeFileSync(join(dir, 'sdk.json'), JSON.stringify(config));
  assert.throws(
    () => loadContract(join(dir, 'api.json'), join(dir, 'sdk.json')),
    /ambiguous SDK string inputs/,
  );
  writeFileSync(join(dir, 'sdk.json'), JSON.stringify({ ...config, numericUnions: 'explicit' }));
  const contract = loadContract(join(dir, 'api.json'), join(dir, 'sdk.json'));
  assert.equal(
    contract.operations[0].body.properties.values.items.oneOf[1]['x-sdk-number-input'],
    'explicit',
  );
  generate(contract, join(dir, 'out'));
  const { Client, ExactNumber, serialize } = await import(join(dir, 'out/node/index.js'));
  const calls = [];
  const client = new Client({
    baseUrl: 'https://example.invalid',
    transport: async (_url, request) => {
      calls.push(request.body);
      return new Response(null, { status: 204 });
    },
  });
  const op = contract.operations[0];
  await client[op.resource][op.method]({
    body: {
      values: ['1.2500', new ExactNumber('1.2500'), true, new ExactNumber('9007199254740993')],
    },
  });
  assert.deepEqual(calls, ['{"values":["1.2500",1.2500,true,9007199254740993]}']);
  await assert.rejects(
    client[op.resource][op.method]({ body: { values: [new ExactNumber('0.12345')] } }),
    { kind: 'validation' },
  );
  assert.throws(() => new ExactNumber('1\n'), { kind: 'validation' });
  assert.match(readFileSync(join(dir, 'out/node/index.d.ts'), 'utf8'), /ExactNumber/);
  assert.equal(
    serialize({ values: ['1', new ExactNumber('1.0')] }, contract.operations[0].body),
    '{"values":["1",1.0]}',
  );
  writeFileSync(
    join(dir, 'test.php'),
    `<?php
require ${JSON.stringify(join(dir, 'out/php/src/Runtime.php'))};
require ${JSON.stringify(join(dir, 'out/php/src/Client.php'))};
use Example\\Values\\{Client,ClientOptions,ExactNumber,SdkError};
$calls=[];
$client=new Client(new ClientOptions(baseUrl:'https://example.invalid',transport: function($r) use (&$calls) { $calls[]=$r['body']; return ['status'=>204,'headers'=>[],'body'=>'']; }));
$client->${op.resource}->${op.method}(new Example\\Values\\${op.resource[0].toUpperCase() + op.resource.slice(1)}${op.method[0].toUpperCase() + op.method.slice(1)}Input(['body'=>['values'=>['1.2500',new ExactNumber('1.2500'),true,new ExactNumber('9007199254740993')]]]));
echo json_encode($calls, JSON_THROW_ON_ERROR);
`,
  );
  assert.deepEqual(
    JSON.parse(execFileSync('php', [join(dir, 'test.php')], { encoding: 'utf8' })),
    calls,
  );
});
