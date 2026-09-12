import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadContract, generate, validateFixtures } from '../dist/index.js';

const dir = mkdtempSync(join(tmpdir(), 'sdk-media-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const json = {
  schema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
};
const form = {
  schema: {
    type: 'object',
    properties: { form_only: { type: 'integer' } },
    required: ['form_only'],
  },
};
function load(content, selection) {
  const doc = {
    openapi: '3.1.0',
    info: { title: 'Media', version: 'v1' },
    paths: {
      '/token': {
        post: {
          operationId: 'exchange',
          requestBody: { required: true, content },
          responses: { 204: { description: 'OK' } },
        },
      },
    },
  };
  const config = {
    responses: { return: 'result' },
    version: '1.0.0',
    requests: { style: 'object' },
    npm: { name: '@example/media' },
    composer: { name: 'example/media', namespace: 'Example\\Media' },
    ...(selection === undefined
      ? {}
      : { operations: { exchange: { requestMediaType: selection } } }),
  };
  writeFileSync(join(dir, 'api.json'), JSON.stringify(doc));
  writeFileSync(join(dir, 'sdk.json'), JSON.stringify(config));
  return loadContract(join(dir, 'api.json'), join(dir, 'sdk.json'));
}
test('request selection is explicit when ambiguous and independent of declaration order', () => {
  for (const content of [
    { 'application/json': json, 'application/x-www-form-urlencoded': form },
    { 'application/x-www-form-urlencoded': form, 'application/json': json },
  ]) {
    assert.equal(load(content).operations[0].mediaType, 'application/json');
    assert.equal(load(content, 'application/json').operations[0].mediaType, 'application/json');
  }
  const ambiguous = { 'application/json': json, 'application/merge-patch+json': form };
  assert.throws(() => load(ambiguous), /requestBody must select/);
  assert.equal(
    load(ambiguous, 'application/merge-patch+json').operations[0].mediaType,
    'application/merge-patch+json',
  );
  assert.throws(() => load(ambiguous, 'text/plain'), /not declared/);
  assert.throws(
    () => load({ 'application/x-www-form-urlencoded': form }, 'application/x-www-form-urlencoded'),
    /unsupported request media/,
  );
  assert.throws(() => load(ambiguous, 42), /expected a media type string/);
});
test('selected JSON schema controls generated public request bytes in both targets', async () => {
  const output = join(dir, 'out');
  generate(
    load(
      { 'application/json': json, 'application/x-www-form-urlencoded': form },
      'application/json',
    ),
    output,
  );
  const cases = [
    {
      name: 'JSON code',
      operation: 'exchange',
      input: { body: { code: 'synthetic' } },
      expected: {
        method: 'POST',
        path: '/v1/token',
        headers: { 'content-type': 'application/json' },
        body: '{"code":"synthetic"}',
      },
      responses: [{ status: 204, body: '' }],
    },
    {
      name: 'unselected schema cannot validate input',
      operation: 'exchange',
      input: { body: { form_only: 7 } },
      responses: [],
      error: { kind: 'validation' },
      attempts: 0,
    },
  ];
  writeFileSync(join(dir, 'cases.json'), JSON.stringify(cases));
  assert.deepEqual(
    (await validateFixtures(output, join(dir, 'cases.json'))).map((result) => result.scenarios),
    [2, 2],
  );
});
