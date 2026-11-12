import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadContract, generate } from '../dist/index.js';
import { validateFixtures } from '../dist/fixtures.js';

const root = mkdtempSync(join(tmpdir(), 'sdk-callbacks-'));
after(() => rmSync(root, { recursive: true, force: true }));
const fixture = 'tests/fixtures/callbacks/';
const api = JSON.parse(readFileSync(fixture + 'openapi.json', 'utf8'));
const output = join(root, 'output');

test('callback references expose both incoming directions and preserve outbound operations', async () => {
  const contract = loadContract(fixture + 'openapi.json', fixture + 'sdk.json');
  generate(contract, output);
  assert.deepEqual(
    contract.operations.map((op) => op.id),
    ['createDeliveryRateCallback', 'listPaymentMethodDomains'],
  );
  for (const model of [
    'ConnectionCheckRequest',
    'RateEvaluationRequest',
    'RateEvaluationResponse',
    'Candidate',
  ]) {
    assert.ok(contract.models[model], model);
    assert.ok(contract.modelDependencies.createDeliveryRateCallback.includes(model), model);
    const php = readFileSync(join(output, 'php/src/classes', model + 'Input.php'), 'utf8');
    assert.match(php, new RegExp('class ' + model + 'Input\\b'));
  }
  const exports = readFileSync(join(output, 'node/index.d.ts'), 'utf8');
  for (const model of ['ConnectionCheckRequest', 'RateEvaluationRequest', 'RateEvaluationResponse'])
    assert.ok(exports.includes('export { ' + model + ' }'));
  for (const model of ['RateEvaluationRequest', 'RateEvaluationResponse'])
    assert.equal(
      readFileSync(join(output, 'node/declarations', model + '.d.ts'), 'utf8'),
      readFileSync(fixture + model + '.d.ts.golden', 'utf8'),
    );
  const consumer = join(output, 'node/consumer.ts');
  writeFileSync(
    consumer,
    `import type { RateEvaluationRequest, RateEvaluationResponse } from './index.js';
const request: RateEvaluationRequest = { evaluation_id: 'evaluation_fixture', candidates: [{code: 'standard'}] };
const response: RateEvaluationResponse = {amount: '9007199254740993'};
// @ts-expect-error required callback field
const invalid: RateEvaluationRequest = {candidates: []};
// @ts-expect-error exact integer output
const imprecise: RateEvaluationResponse = {amount: 9007199254740993};
`,
  );
  const ts = spawnSync(
    process.execPath,
    [
      resolve('node_modules/typescript/bin/tsc'),
      '--noEmit',
      '--strict',
      '--skipLibCheck',
      '--target',
      'es2022',
      '--module',
      'nodenext',
      consumer,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(ts.status, 0, ts.stdout + ts.stderr);
  const php = spawnSync(
    'php',
    [
      '-r',
      `require ${JSON.stringify(join(output, 'php/src/Client.php'))};
$request = new Example\\Callbacks\\RateEvaluationRequestInput(['evaluation_id'=>'evaluation_fixture', 'candidates'=>[['code'=>'standard']]]);
$response = new Example\\Callbacks\\RateEvaluationResponseInput(['amount'=>'9007199254740993']);
if ($request->getEvaluationId() !== 'evaluation_fixture' || $response->getAmount() !== '9007199254740993') exit(1);
`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(php.status, 0, php.stdout + php.stderr);
  assert.deepEqual(
    (await validateFixtures(output, fixture + 'http.json')).map((r) => r.scenarios),
    [42, 42],
  );
});

test('inline and component callbacks have identical model dependencies', () => {
  const inline = structuredClone(api);
  inline.paths['/callbacks'].post.callbacks.evaluation = inline.components.callbacks.evaluation;
  const path = join(root, 'inline.json');
  writeFileSync(path, JSON.stringify(inline));
  assert.deepEqual(
    loadContract(path, fixture + 'sdk.json').modelDependencies,
    loadContract(fixture + 'openapi.json', fixture + 'sdk.json').modelDependencies,
  );
});

test('unsupported callback schemas and unresolved callback references fail with source locations', () => {
  for (const malformed of [
    {
      '{$request.body#/url}': {
        post: {
          requestBody: {
            content: { 'application/json': { schema: { type: 'string', pattern: '(?<=a)b' } } },
          },
        },
      },
    },
    { $ref: '#/components/callbacks/missing' },
    { '{$request.body#/url}': { trace: {} } },
  ]) {
    const doc = structuredClone(api);
    doc.paths['/callbacks'].post.callbacks.evaluation = malformed;
    const path = join(root, 'bad.json');
    writeFileSync(path, JSON.stringify(doc));
    assert.throws(() => loadContract(path, fixture + 'sdk.json'), /callbacks|missing/);
  }
});

test('negative query predicates are enforced in the default encoding profile too', async () => {
  const config = JSON.parse(readFileSync(fixture + 'sdk.json', 'utf8'));
  delete config.validation;
  const path = join(root, 'encoding.json');
  writeFileSync(path, JSON.stringify(config));
  const out = join(root, 'encoding');
  generate(loadContract(fixture + 'openapi.json', path), out);
  const cases = JSON.parse(readFileSync(fixture + 'http.json', 'utf8')).slice(0, 3);
  const http = join(root, 'encoding-http.json');
  writeFileSync(http, JSON.stringify(cases));
  assert.deepEqual(
    (await validateFixtures(out, http)).map((r) => r.scenarios),
    [3, 3],
  );
});
