import { publicInventory } from './helpers/public-inventory.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadContract, generate, compare } from '../dist/index.js';
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

test('callback response construction types close nested tagged unions', () => {
  const doc = structuredClone(api);
  const outcome = {
    type: 'object',
    oneOf: [
      {
        type: 'object',
        required: ['type', 'amount_money', 'expires_at', 'selection_guarantee_expires_at'],
        properties: {
          type: { const: 'available' },
          amount_money: { type: 'integer' },
          expires_at: { type: 'string' },
          selection_guarantee_expires_at: { type: 'string' },
        },
      },
      {
        type: 'object',
        required: ['type', 'reason'],
        properties: { type: { const: 'unavailable' }, reason: { type: 'string' } },
      },
    ],
  };
  doc.components.schemas.Outcome = outcome;
  doc.components.schemas.RateEvaluationResponse = {
    type: 'object',
    required: ['results'],
    properties: { results: { type: 'array', items: { $ref: '#/components/schemas/Outcome' } } },
  };
  const path = join(root, 'strict.json'),
    out = join(root, 'strict');
  writeFileSync(path, JSON.stringify(doc));
  generate(loadContract(path, fixture + 'sdk.json'), out);
  const consumer = join(out, 'node/consumer.ts');
  writeFileSync(
    consumer,
    `import {makeRateEvaluationResponse} from './index.js';
import type {RateEvaluationResponseInput} from './index.js';
const valid: RateEvaluationResponseInput = {results:[{type:'available',amount_money:1,expires_at:'later',selection_guarantee_expires_at:'later'}]};
makeRateEvaluationResponse(valid);
// @ts-expect-error available requires price and both expiry fields
const invalid: RateEvaluationResponseInput = {results:[{type:'available'}]};
// @ts-expect-error factory uses the same strict nested construction type
makeRateEvaluationResponse({results:[{type:'available'}]});
`,
  );
  const result = spawnSync(
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
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('callback path item references merge sibling methods and diagnose trace', () => {
  const doc = structuredClone(api);
  doc.components.pathItems = {
    Evaluation: doc.components.callbacks.evaluation['{$request.body#/url}'],
  };
  doc.components.schemas.PutOnly = {
    type: 'object',
    required: ['count'],
    properties: { count: { type: 'integer' } },
  };
  doc.components.callbacks.evaluation['{$request.body#/url}'] = {
    $ref: '#/components/pathItems/Evaluation',
    put: {
      responses: {
        200: {
          description: 'OK',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/PutOnly' } } },
        },
      },
    },
  };
  const path = join(root, 'siblings.json');
  writeFileSync(path, JSON.stringify(doc));
  const before = loadContract(path, fixture + 'sdk.json'),
    out = join(root, 'siblings');
  generate(before, out);
  assert.ok(before.modelDependencies.createDeliveryRateCallback.includes('PutOnly'));
  assert.match(readFileSync(join(out, 'node/index.d.ts'), 'utf8'), /PutOnlyInput/);
  assert.match(
    readFileSync(join(out, 'php/src/classes/PutOnlyInput.php'), 'utf8'),
    /class PutOnlyInput/,
  );
  doc.components.schemas.PutOnly.required.push('label');
  doc.components.schemas.PutOnly.properties.label = { type: 'string' };
  writeFileSync(path, JSON.stringify(doc));
  assert.ok(compare(before, loadContract(path, fixture + 'sdk.json')).length > 0);
  doc.components.callbacks.evaluation['{$request.body#/url}'].trace = {};
  writeFileSync(path, JSON.stringify(doc));
  assert.throws(
    () => loadContract(path, fixture + 'sdk.json'),
    /callbacks.*unsupported incoming callback method.*trace/,
  );
});

test('inline callback request and response bodies get stable public models and compatibility facts', () => {
  const doc = structuredClone(api);
  const op = doc.components.callbacks.evaluation['{$request.body#/url}'].post;
  op.requestBody.content['application/json'].schema = {
    type: 'object',
    required: ['request_value'],
    properties: { request_value: { type: 'string' } },
  };
  op.responses['2XX'].content['application/json'].schema = {
    type: 'object',
    required: ['response_value'],
    properties: { response_value: { type: 'string' } },
  };
  const path = join(root, 'inline-bodies.json');
  writeFileSync(path, JSON.stringify(doc));
  const before = loadContract(path, fixture + 'sdk.json'),
    out = join(root, 'inline-bodies');
  generate(before, out);
  const bodies = before.callbackBodies.filter((body) => body.pointer.includes('/evaluation/'));
  assert.equal(bodies.length, 2);
  for (const body of bodies) {
    assert.ok(before.models[body.model]);
    assert.ok(readFileSync(join(out, 'node/index.d.ts'), 'utf8').includes(body.model));
    assert.match(
      readFileSync(join(out, 'php/src/classes', body.model + 'Input.php'), 'utf8'),
      new RegExp('class ' + body.model + 'Input'),
    );
  }
  assert.deepEqual(loadContract(path, fixture + 'sdk.json').callbackBodies, before.callbackBodies);
  for (const schema of [
    op.requestBody.content['application/json'].schema,
    op.responses['2XX'].content['application/json'].schema,
  ]) {
    schema.required.push('added');
    schema.properties.added = { type: 'string' };
    writeFileSync(path, JSON.stringify(doc));
    assert.ok(compare(before, loadContract(path, fixture + 'sdk.json')).length > 0);
    schema.required.pop();
    delete schema.properties.added;
  }
});

test('merged callback sibling examples are protected in every publisher', () => {
  for (const referenced of [false, true])
    for (const merged of [false, true]) {
      const doc = structuredClone(api);
      const marker = 'SYNTHETIC_CALLBACK_SIBLING_SECRET_EXAMPLE';
      const visible = 'SYNTHETIC_CALLBACK_SIBLING_PUBLIC_EXAMPLE';
      const schema = {
        type: 'object',
        properties: {
          secret: {
            type: 'string',
            'x-sensitive': true,
            example: marker,
            examples: [marker],
            default: marker,
          },
          public_value: { type: 'string', example: visible },
        },
      };
      doc.components.schemas.SiblingPayload = schema;
      const original = doc.components.callbacks.evaluation['{$request.body#/url}'];
      const put = {
        responses: {
          200: {
            description: 'OK',
            content: {
              'application/json': {
                schema: referenced ? { $ref: '#/components/schemas/SiblingPayload' } : schema,
              },
            },
          },
        },
      };
      doc.components.pathItems = { Evaluation: original };
      doc.components.callbacks.evaluation['{$request.body#/url}'] = merged
        ? { $ref: '#/components/pathItems/Evaluation', put }
        : { ...original, put };
      const inventory = publicInventory(doc);
      assert.ok(inventory.callbacks.some((body) => body.pointer.endsWith('/put')));
      assert.ok(
        Object.values(inventory.keywords)
          .flat()
          .some((path) => path.includes('/put/') && path.endsWith('/x-sensitive')) || referenced,
      );
      const path = join(root, `protected-${referenced}-${merged}.json`),
        out = join(root, `protected-${referenced}-${merged}`);
      writeFileSync(path, JSON.stringify(doc));
      const contract = loadContract(path, fixture + 'sdk.json');
      generate(contract, out);
      const model = contract.callbackBodies.find((body) => body.pointer.includes('/put/')).model;
      for (const file of [
        join(out, 'node/declarations', model + '.d.ts'),
        join(out, 'node/declarations', model + 'Input.d.ts'),
        join(out, 'php/src/classes', model + 'Input.php'),
        join(out, 'node/MODELS.md'),
        join(out, 'php/MODELS.md'),
      ]) {
        const text = readFileSync(file, 'utf8');
        assert.ok(!text.includes(marker), file);
        if (!file.endsWith('Input.d.ts'))
          assert.ok(text.includes(visible), file + ' retains public sibling annotations');
      }
    }
});
