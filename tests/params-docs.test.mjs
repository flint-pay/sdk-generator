import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { loadContract, generate } from '../dist/index.js';
import { inputSchema } from '../dist/target-plan.js';
import { compileCodec } from '../dist/codec-plan.js';
const filterDescription = 'Filter by the original Idempotency-Key.';
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'sdk-params-docs-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const header = (name) => ({ name, in: 'header', schema: { type: 'string' } });
  const api = {
    openapi: '3.1.0',
    info: { title: 'Synthetic params', version: '1' },
    paths: {
      '/v1/refunds': {
        get: {
          operationId: 'listRefunds',
          parameters: [
            {
              name: 'idempotency_key',
              in: 'query',
              description: filterDescription,
              schema: { type: 'string' },
            },
            {
              name: 'status',
              in: 'query',
              description: 'Filter by refund status.',
              schema: { type: 'string', enum: ['pending', 'done'] },
            },
            {
              name: 'page_size',
              in: 'query',
              description: 'Parameter fallback must not replace schema prose.',
              schema: { type: 'integer', description: 'Schema description wins.' },
            },
            header('Flint-Version'),
          ],
          responses: { 204: { description: 'Done' } },
        },
      },
      '/v1/customers/{customer_id}': {
        patch: {
          operationId: 'updateCustomer',
          parameters: [
            {
              name: 'customer_id',
              in: 'path',
              required: true,
              description: 'Flint customer ID.',
              schema: { type: 'string' },
            },
            header('Idempotency-Key'),
            header('Flint-Version'),
            { ...header('X-Request-Id'), 'x-flint-request-option': 'client_request_id' },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['name'],
                  properties: { name: { type: 'string', description: 'New customer name.' } },
                },
              },
            },
          },
          responses: { 204: { description: 'Done' } },
        },
      },
    },
  };
  const config = {
    operationNames: 'path',
    version: '1.0.0',
    validation: 'schema',
    apiVersion: { header: 'Flint-Version', value: '2026-10-01' },
    npm: { name: '@example/params' },
    composer: { name: 'example/params', namespace: 'ParamsTest' },
    operations: {
      updateCustomer: {
        idempotency: { header: 'Idempotency-Key', retention: '24h', scope: 'command' },
      },
    },
  };
  const definition = join(dir, 'api.json'),
    settings = join(dir, 'sdk.json'),
    output = join(dir, 'out');
  writeFileSync(definition, JSON.stringify(api));
  writeFileSync(settings, JSON.stringify(config));
  const contract = loadContract(definition, settings);
  generate(contract, output);
  const declarations = readdirSync(join(output, 'node/declarations'))
    .filter((f) => f.endsWith('.d.ts'))
    .map((f) => readFileSync(join(output, 'node/declarations', f), 'utf8'))
    .join('\n');
  const resources = readdirSync(join(output, 'node/resources'))
    .filter((f) => f.endsWith('.d.ts'))
    .map((f) => readFileSync(join(output, 'node/resources', f), 'utf8'))
    .join('\n');
  return { contract, output, dir, declarations: declarations + resources };
}

test('named Params, Input property prose, path @param and reference rows retain parameter descriptions', (t) => {
  const f = fixture(t);
  assert.match(f.declarations, /list\(params\?: RefundsListParams, options\?/);
  assert.match(f.declarations, /update\(customer_id:.*params: CustomersUpdateParams/);
  assert.match(f.declarations, /@param customer_id Flint customer ID\./);
  for (const name of ['RefundsListInput', 'RefundsListParams']) {
    const declaration = f.declarations.split('export type ' + name + ' = ')[1]?.split('export ')[0];
    assert.ok(declaration, name);
    assert.match(
      declaration,
      /Filter by the original Idempotency-Key\.[\s\S]*?"idempotency_key"\?/,
    );
    assert.match(declaration, /Schema description wins\./);
    assert.doesNotMatch(declaration, /Parameter fallback must not replace/);
    assert.doesNotMatch(declaration, /Flint-Version/);
  }
  for (const target of ['node', 'php']) {
    const reference = readFileSync(join(f.output, target, 'reference/refunds.md'), 'utf8');
    const row = reference.split('\n').find((line) => line.startsWith('| `idempotency_key` |'));
    assert.ok(row?.includes(filterDescription));
    const status = reference.split('\n').find((line) => line.startsWith('| `status` |'));
    assert.match(status, /pending/);
    assert.doesNotMatch(status, /\]\([^)]*(customer|error)/i);
  }
  const php = readFileSync(join(f.output, 'php/src/classes/CustomersResource.php'), 'utf8');
  assert.match(php, /@param string\|Model \$customer_id Flint customer ID\./);
  assert.match(php, /@param CustomersUpdateParams\|array/);
  assert.match(
    readFileSync(join(f.output, 'php/src/classes/RefundsListParams.php'), 'utf8'),
    /Filter by the original Idempotency-Key/,
  );
  const op = f.contract.operations.find((op) => op.id === 'listRefunds');
  const schema = inputSchema(op, f.contract.config.apiVersion, f.contract).properties
    .idempotency_key;
  assert.deepEqual(
    compileCodec(schema),
    compileCodec({ type: 'string' }),
    'descriptions do not change codec sharing identities',
  );
});

test('managed headers are absent from Params types and their former input paths are rejected', async (t) => {
  const f = fixture(t);
  const consumer = join(f.output, 'node/consumer.ts');
  writeFileSync(
    consumer,
    `import {Client, type RefundsListInput, type RefundsListParams, type CustomersUpdateParams} from './index.js';
const client = new Client({baseUrl:'https://example.invalid'});
const filters: RefundsListInput = {idempotency_key:'recovery-key'};
const params: RefundsListParams = filters;
client.refunds.list(params);
const update: CustomersUpdateParams = {name:'new'};
client.customers.update('cus', update, {idempotencyKey:'option-key',clientRequestId:'caller'});
// @ts-expect-error The key belongs in request options.
client.customers.update('cus', {name:'new','Idempotency-Key':'input-key'});
// @ts-expect-error Version is managed by the SDK.
client.customers.update('cus', {name:'new','Flint-Version':'old'});
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
  const { Client } = await import(pathToFileURL(join(f.output, 'node/index.js')));
  const requests = [];
  const client = new Client({
    baseUrl: 'https://example.invalid',
    transport: async (url, init) => {
      requests.push({ path: url.pathname + url.search, headers: init.headers, body: init.body });
      return new Response(null, { status: 204 });
    },
  });
  await client.customers.update(
    'cus',
    { name: 'new' },
    { idempotencyKey: 'option-key', clientRequestId: 'caller' },
  );
  assert.equal(requests[0].headers['idempotency-key'], 'option-key');
  assert.equal(requests[0].headers['flint-version'], '2026-10-01');
  assert.equal(requests[0].headers['x-request-id'], 'caller');
  for (const field of ['Idempotency-Key', 'Flint-Version', 'X-Request-Id'])
    await assert.rejects(
      client.customers.update(
        'cus',
        { name: 'new', [field]: 'input-key' },
        { idempotencyKey: 'option-key' },
      ),
      { name: 'InvalidInputError' },
    );
  await assert.rejects(
    client.customers.update(
      'cus',
      { name: 'new' },
      { headers: { 'idempotency-key': 'header-key' } },
    ),
    { name: 'InvalidInputError' },
  );
  assert.equal(requests.length, 1);
  const php = execFileSync(
    'php',
    [
      '-r',
      String.raw`
require $argv[1].'/src/Client.php';
use ParamsTest\{Client,ClientOptions,RequestOptions,CustomersUpdateParams,SdkError};
$sent=[];
$client=new Client(new ClientOptions('https://example.invalid',transport:function($request)use(&$sent){$sent[]=$request;return ['status'=>204,'headers'=>[],'body'=>''];}));
$client->customers->update('cus',new CustomersUpdateParams(['name'=>'new']),new RequestOptions(idempotencyKey:'option-key',clientRequestId:'caller'));
foreach(['Idempotency-Key','Flint-Version','X-Request-Id'] as $field){try{$client->customers->update('cus',['name'=>'new',$field=>'input'],new RequestOptions(idempotencyKey:'option-key'));throw new Exception('accepted params header');}catch(SdkError $error){}}
try{$client->customers->update('cus',['name'=>'new'],new RequestOptions(headers:['Idempotency-Key'=>'header-key']));throw new Exception('accepted header key');}catch(SdkError $error){}
echo json_encode($sent);
`,
      join(f.output, 'php'),
    ],
    { encoding: 'utf8' },
  );
  const sent = JSON.parse(php);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].headers['idempotency-key'], 'option-key');
  assert.equal(sent[0].headers['x-request-id'], 'caller');
  assert.equal(sent[0].body, '{"name":"new"}');
});
