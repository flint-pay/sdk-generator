import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { loadContract, generate, validateFixtures } from '../dist/index.js';
import { compileSdkContract } from '../dist/target-plan.js';
import { assertRuntimePlan } from '../dist/runtime-plan.js';
function fixture(t, option = 'scalar-or-array') {
  const dir = mkdtempSync(join(tmpdir(), 'sdk-query-arrays-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const field = (name, extra = {}) => ({
    name,
    in: 'query',
    style: 'form',
    explode: true,
    schema: {
      type: 'array',
      items: { type: 'string', enum: ['duplicate', 'fraud'] },
      ...extra,
    },
  });
  const api = {
    openapi: '3.1.0',
    info: { title: 'Synthetic query arrays', version: '1' },
    paths: {
      '/v1/refunds': {
        get: {
          operationId: 'listRefunds',
          parameters: [
            field('reason'),
            field('multiple', { minItems: 2 }),
            { ...field('csv'), explode: false },
          ],
          responses: { 204: { description: 'Done' } },
        },
      },
    },
  };
  const sdk = {
    operationNames: 'path',
    validation: 'schema',
    version: '1.0.0',
    npm: { name: '@example/query-arrays' },
    composer: { name: 'example/query-arrays', namespace: 'QueryArrays' },
    ...(option ? { queryArrays: option } : {}),
  };
  const apiFile = join(dir, 'api.json'),
    config = join(dir, 'sdk.json'),
    output = join(dir, 'out');
  writeFileSync(apiFile, JSON.stringify(api));
  writeFileSync(config, JSON.stringify(sdk));
  const contract = loadContract(apiFile, config);
  generate(contract, output);
  return { dir, output, contract };
}

test('scalar and singleton arrays send identical queries; invalid enum items and original bounds fail in both runtimes', async (t) => {
  const f = fixture(t);
  const cases = [
    ...['duplicate', ['duplicate']].map((reason, index) => ({
      name: 'same wire ' + index,
      input: { reason },
      expected: { method: 'GET', path: '/v1/refunds?reason=duplicate' },
      responses: [{ status: 204, body: '' }],
      empty: true,
    })),
    {
      name: 'multiple values',
      input: { reason: ['duplicate', 'fraud'] },
      expected: { method: 'GET', path: '/v1/refunds?reason=duplicate&reason=fraud' },
      responses: [{ status: 204, body: '' }],
      empty: true,
    },
    {
      name: 'minimum control',
      input: { multiple: ['duplicate', 'fraud'] },
      expected: { method: 'GET', path: '/v1/refunds?multiple=duplicate&multiple=fraud' },
      responses: [{ status: 204, body: '' }],
      empty: true,
    },
    ...[
      { reason: 'invalid' },
      { reason: ['duplicate', 'invalid'] },
      { multiple: 'duplicate' },
      { multiple: ['duplicate'] },
      { csv: 'duplicate' },
    ].map((input, index) => ({
      name: 'invalid ' + index,
      input,
      responses: [],
      error: { name: 'InvalidInputError', outcome: 'not_sent' },
      attempts: 0,
    })),
  ].map((c) => ({ ...c, operation: 'listRefunds', baseUrl: 'https://example.invalid' }));
  const file = join(f.dir, 'cases.json');
  writeFileSync(file, JSON.stringify(cases));
  assert.deepEqual(await validateFixtures(f.output, file), [
    { target: 'node', scenarios: 9 },
    { target: 'php', scenarios: 9 },
  ]);
  const php = execFileSync(
    'php',
    [
      '-r',
      String.raw`
require $argv[1].'/src/Client.php';
use QueryArrays\{Client,ClientOptions,RefundsListParams};
$sent=[];$client=new Client(new ClientOptions('https://example.invalid',transport:function($r)use(&$sent){$sent[]=$r['url'];return ['status'=>204,'headers'=>[],'body'=>''];}));
$client->refunds->list(new RefundsListParams(['reason'=>'duplicate']));
$client->refunds->list(new RefundsListParams(['reason'=>['duplicate']]));
echo json_encode($sent);
`,
      join(f.output, 'php'),
    ],
    { encoding: 'utf8' },
  );
  assert.deepEqual(JSON.parse(php), [
    'https://example.invalid/v1/refunds?reason=duplicate',
    'https://example.invalid/v1/refunds?reason=duplicate',
  ]);
});

test('named input and params types accept scalars and readonly arrays with per-item enum types', (t) => {
  const f = fixture(t);
  const consumer = join(f.output, 'node/consumer.ts');
  writeFileSync(
    consumer,
    `import {Client,type RefundsListParams,type RefundsListInput} from './index.js';
const client=new Client({baseUrl:'https://example.invalid'});
const singleton=['duplicate'] as const;
const params:RefundsListParams={reason:singleton};
const input:RefundsListInput={reason:'fraud'};
client.refunds.list(params);client.refunds.list(input);client.refunds.list({reason:'duplicate'});
// @ts-expect-error Scalar enum values are checked.
client.refunds.list({reason:'invalid'});
// @ts-expect-error Every array item must be a declared enum value.
client.refunds.list({reason:['duplicate','invalid']});
// @ts-expect-error Nonexploded queries retain their array-only type.
client.refunds.list({csv:'duplicate'});
`,
  );
  try {
    execFileSync(
      process.execPath,
      [
        resolve('node_modules/typescript/bin/tsc'),
        '--strict',
        '--noEmit',
        '--module',
        'NodeNext',
        '--target',
        'ES2022',
        '--typeRoots',
        resolve('node_modules/@types'),
        consumer,
      ],
      { stdio: 'pipe' },
    );
  } catch (error) {
    throw new Error(error.stdout?.toString() ?? error.message);
  }
  const declarations = readdirSync(join(f.output, 'node/declarations'))
    .filter((file) => file.endsWith('.d.ts'))
    .map((file) => readFileSync(join(f.output, 'node/declarations', file), 'utf8'))
    .join('\n');
  assert.match(declarations, /readonly \(/);
});

test('array-only remains the default and malformed options/serialized flags fail', async (t) => {
  const f = fixture(t, null);
  const { Client } = await import(pathToFileURL(join(f.output, 'node/index.js')));
  let requests = 0;
  const client = new Client({
    baseUrl: 'https://example.invalid',
    transport: async () => {
      requests++;
      return new Response(null, { status: 204 });
    },
  });
  await assert.rejects(client.refunds.list({ reason: 'duplicate' }), { name: 'InvalidInputError' });
  await client.refunds.list({ reason: ['duplicate'] });
  assert.equal(requests, 1);
  assert.throws(() => fixture(t, 'arrays-only'), /expected scalar-or-array/);
  const enabled = fixture(t);
  const runtime = structuredClone(compileSdkContract(enabled.contract).plan.runtime);
  assertRuntimePlan(runtime);
  assert.equal(runtime.operations[0].parameters[0].scalarArray, true);
  runtime.operations[0].parameters[0].scalarArray = 'true';
  assert.throws(() => assertRuntimePlan(runtime), /Invalid compiled scalar query array/);
});

test('PHP rejects malformed scalar-array descriptors before dispatch', (t) => {
  const f = fixture(t);
  const file = join(f.output, 'php/src/descriptors/resources/refunds.json');
  const descriptor = JSON.parse(readFileSync(file, 'utf8'));
  descriptor.operations[0].parameters[0].scalarArray = 'true';
  writeFileSync(file, JSON.stringify(descriptor));
  const result = execFileSync(
    'php',
    [
      '-r',
      String.raw`
require $argv[1].'/src/Client.php';
try { $client = new QueryArrays\Client(new QueryArrays\ClientOptions('https://example.invalid')); $client->refunds->list(['reason'=>'duplicate']); throw new Exception('accepted malformed descriptor'); }
catch (Throwable $error) { if (!str_contains($error->getMessage(), 'Invalid compiled scalar query array')) throw $error; echo 'rejected'; }
`,
      join(f.output, 'php'),
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result, 'rejected');
});
