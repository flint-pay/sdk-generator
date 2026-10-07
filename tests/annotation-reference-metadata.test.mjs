import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { inspect } from 'node:util';
import { loadContract, generate, render, validateFixtures } from '../dist/index.js';

const root = mkdtempSync(join(tmpdir(), 'sdk-annotation-metadata-'));
after(() => rmSync(root, { recursive: true, force: true }));
const ref = (name, metadata = {}) => ({ $ref: '#/components/schemas/' + name, ...metadata });
const config = {
  version: '1.0.0',
  validation: 'schema',
  requests: { style: 'object' },
  responses: { return: 'result' },
  npm: { name: 'annotation-metadata-sdk' },
  composer: { name: 'annotation/metadata-sdk', namespace: 'AnnotationSdk' },
};
function fixture(schema, schemas, settings = config) {
  const dir = mkdtempSync(join(root, 'case-'));
  const content = { 'application/json': { schema } };
  const doc = {
    openapi: '3.1.1',
    info: { title: 'Synthetic annotation metadata', version: '1' },
    paths: {
      '/records': {
        post: {
          operationId: 'sendRecord',
          requestBody: { required: true, content },
          responses: { 200: { description: 'Record', content } },
        },
      },
    },
    components: { schemas },
  };
  writeFileSync(join(dir, 'api.json'), JSON.stringify(doc));
  writeFileSync(join(dir, 'sdk.json'), JSON.stringify(settings));
  return {
    dir,
    output: join(dir, 'sdk'),
    load: () => loadContract(join(dir, 'api.json'), join(dir, 'sdk.json')),
  };
}

let redactionCase;
function redactionFixture() {
  if (redactionCase) return redactionCase;
  const pair = {
    type: 'object',
    required: ['label', 'credential'],
    properties: {
      label: ref('Text', { 'x-sensitive': true, description: 'Sensitive use site' }),
      credential: ref('Text', { writeOnly: true, description: 'Write-only use site' }),
    },
  };
  const properties = {
    ...pair.properties,
    clear: ref('Text', { 'x-sensitive': false, writeOnly: false }),
    nested: ref('Pair', { description: 'Nested pair' }),
    items: { type: 'array', minItems: 1, items: ref('Text', { 'x-sensitive': true }) },
    map: {
      type: 'object',
      minProperties: 1,
      additionalProperties: ref('Text', { 'x-sensitive': true }),
    },
    recordItems: { type: 'array', minItems: 1, items: ref('Pair', { description: 'Pair item' }) },
    recordMap: {
      type: 'object',
      minProperties: 1,
      additionalProperties: ref('Pair', { description: 'Pair value' }),
    },
    inherited: ref('Sensitive', { 'x-sensitive': false }),
    inheritedWrite: ref('Write', { writeOnly: false }),
    id: ref('Read', { readOnly: false }),
  };
  const i = fixture(ref('Envelope'), {
    Text: { type: 'string' },
    Pair: pair,
    Sensitive: { type: 'string', 'x-sensitive': true },
    Write: { type: 'string', writeOnly: true },
    Read: { type: 'string', readOnly: true },
    Envelope: { type: 'object', required: Object.keys(properties), properties },
  });
  const contract = i.load();
  generate(contract, i.output);
  const hidden = 'synthetic-private-value';
  const pairValue = { label: hidden, credential: hidden };
  const input = {
    ...pairValue,
    clear: 'synthetic-visible-value',
    nested: { ...pairValue },
    items: [hidden],
    map: { entry: hidden },
    recordItems: [{ ...pairValue }],
    recordMap: { entry: { ...pairValue } },
    inherited: hidden,
    inheritedWrite: hidden,
  };
  const output = {
    label: hidden,
    clear: 'synthetic-visible-value',
    nested: { label: hidden },
    items: [hidden],
    map: { entry: hidden },
    recordItems: [{ label: hidden }],
    recordMap: { entry: { label: hidden } },
    inherited: hidden,
    id: 'synthetic-response-id',
  };
  redactionCase = { ...i, contract, input, response: output, hidden };
  return redactionCase;
}

test('public Node redact honors annotation refs at fields, items and maps without hiding plain uses', async () => {
  const i = redactionFixture();
  const { redact, makeEnvelope } = await import(pathToFileURL(join(i.output, 'node/index.js')));
  const pair = { label: '[REDACTED]', credential: '[REDACTED]' };
  const expected = {
    ...pair,
    clear: 'synthetic-visible-value',
    nested: { ...pair },
    items: ['[REDACTED]'],
    map: { entry: '[REDACTED]' },
    recordItems: [{ ...pair }],
    recordMap: { entry: { ...pair } },
    inherited: '[REDACTED]',
    inheritedWrite: '[REDACTED]',
  };
  const schema = i.contract.operations[0].body;
  assert.deepEqual(redact(i.input, schema, [], i.contract.definitions), expected);
  assert.deepEqual(
    redact(i.input, { ...schema, 'x-sdk-definitions': i.contract.definitions }),
    expected,
  );
  assert.equal(redact(i.hidden, schema.properties.label, [], i.contract.definitions), '[REDACTED]');
  assert.equal(inspect(makeEnvelope(i.input), { depth: 30 }).includes(i.hidden), false);
  assert.equal(i.contract.definitions.Text['x-sensitive'], undefined);
  assert.equal(schema.properties.inherited['x-sensitive'], true);
  assert.equal(schema.properties.inheritedWrite.writeOnly, true);
  assert.equal(schema.properties.id.readOnly, true);
  assert.deepEqual(i.contract, i.load());
});

test('PHP input-model debug and public Codec redact honor annotation refs at fields, items and maps', () => {
  const i = redactionFixture();
  const php = spawnSync(
    'php',
    [
      '-r',
      String.raw`
      require $argv[1].'/src/Client.php';
      $input=json_decode($argv[2],true);
      $schema=json_decode($argv[3],true);
      $definitions=json_decode($argv[4],true);
      var_dump(new AnnotationSdk\EnvelopeInput($input));
      var_dump(new AnnotationSdk\ApiSendRecordInput(['body'=>$input]));
      var_dump(AnnotationSdk\Codec::redact((object)$input,$schema,[],$definitions));
      $client=new AnnotationSdk\Client(new AnnotationSdk\ClientOptions('https://example.invalid',transport:fn($r)=>['status'=>200,'headers'=>[],'body'=>$argv[5]]));
      var_dump($client->api->sendRecord(new AnnotationSdk\ApiSendRecordInput(['body'=>$input]))->data);
      `,
      join(i.output, 'php'),
      JSON.stringify(i.input),
      JSON.stringify(i.contract.operations[0].body),
      JSON.stringify(i.contract.definitions),
      JSON.stringify(i.response),
    ],
    { encoding: 'utf8' },
  );
  assert.equal(php.status, 0, php.stderr);
  assert.equal(php.stdout.includes(i.hidden), false, php.stdout);
  assert.ok(php.stdout.includes('synthetic-visible-value'));
  assert.ok(php.stdout.includes('[REDACTED]'));
});

test('annotated refs retain both-target input requiredness and output omission without weakening inherited flags', async () => {
  const i = redactionFixture();
  const { credential, ...missingCredential } = i.input;
  const { inheritedWrite, ...missingInheritedWrite } = i.input;
  const { label, ...missingLabel } = i.response;
  const rejected = (name, body) => ({
    name,
    operation: 'sendRecord',
    input: { body },
    responses: [],
    attempts: 0,
    error: { kind: 'validation' },
  });
  const accepted = (name, response, data = i.response) => ({
    name,
    operation: 'sendRecord',
    input: { body: i.input },
    expected: { method: 'POST', path: '/v1/records', body: JSON.stringify(i.input) },
    responses: [{ status: 200, body: JSON.stringify(response) }],
    data,
  });
  const cases = [
    accepted('write-only requirements omitted from response', i.response),
    accepted(
      'explicit response values remain available as data',
      { ...i.input, id: 'synthetic-response-id' },
      { ...i.input, id: 'synthetic-response-id' },
    ),
    rejected('local write-only field remains required', missingCredential),
    rejected('false cannot clear inherited write-only requiredness', missingInheritedWrite),
    rejected('false cannot clear inherited read-only input rejection', { ...i.input, id: 'id' }),
    rejected('nested write-only field remains required', {
      ...i.input,
      nested: { label: 'label' },
    }),
    {
      name: 'sensitive output field remains required',
      operation: 'sendRecord',
      input: { body: i.input },
      expected: { method: 'POST', path: '/v1/records', body: JSON.stringify(i.input) },
      responses: [{ status: 200, body: JSON.stringify(missingLabel) }],
      error: { kind: 'protocol' },
    },
  ];
  const file = join(i.dir, 'cases.json');
  writeFileSync(file, JSON.stringify(cases));
  assert.deepEqual(
    (await validateFixtures(i.output, file)).map((r) => r.scenarios),
    [7, 7],
  );
  const files = render(i.contract);
  assert.doesNotMatch(
    files.get('node/declarations/Envelope.d.ts'),
    /"credential"|"inheritedWrite"/,
  );
  assert.doesNotMatch(
    files.get('php/src/classes/ApiSendRecordResponse200.php'),
    /getCredential|getInheritedWrite/,
  );
});

test('valid local and inherited examples survive annotation refs, including nested fields, items and maps', async () => {
  const local = () => ref('Special', { description: 'Use-site example', example: 'SPECIAL' });
  const i = fixture(
    {
      type: 'object',
      required: ['local', 'inherited', 'nested', 'items', 'map'],
      properties: {
        local: local(),
        inherited: ref('Inherited', { description: 'Inherited example' }),
        nested: ref('Container', { description: 'Nested example' }),
        items: { type: 'array', minItems: 1, items: local() },
        map: { type: 'object', minProperties: 1, additionalProperties: local() },
      },
    },
    {
      Special: { type: 'string', pattern: '^SPECIAL$' },
      Inherited: { type: 'string', pattern: '^INHERITED$', example: 'INHERITED' },
      Container: { type: 'object', required: ['value'], properties: { value: local() } },
    },
  );
  const c = i.load();
  const snapshot = JSON.stringify(c);
  const files = render(c);
  assert.deepEqual([...files], [...render(c)]);
  assert.equal(JSON.stringify(c), snapshot);
  generate(c, i.output);
  const expected = {
    body: {
      local: 'SPECIAL',
      inherited: 'INHERITED',
      nested: { value: 'SPECIAL' },
      items: ['SPECIAL'],
      map: { example0: 'SPECIAL' },
    },
  };
  for (const target of ['node', 'php']) {
    const example = files.get(
      target + '/examples/api-sendRecord.' + (target === 'node' ? 'mjs' : 'php'),
    );
    assert.ok(example?.includes('SPECIAL'));
    assert.ok(example?.includes('INHERITED'));
  }
  const file = join(i.dir, 'cases.json');
  writeFileSync(
    file,
    JSON.stringify([
      {
        name: 'constrained annotated examples',
        operation: 'sendRecord',
        input: expected,
        expected: { method: 'POST', path: '/v1/records', body: JSON.stringify(expected.body) },
        responses: [{ status: 200, body: JSON.stringify(expected.body) }],
        data: expected.body,
      },
    ]),
  );
  assert.deepEqual(
    (await validateFixtures(i.output, file)).map((r) => r.scenarios),
    [1, 1],
  );
});

test('local examples override inherited examples, including explicit null and finite recursive examples', () => {
  const i = fixture(
    {
      type: 'object',
      required: ['value', 'nullable', 'tree'],
      properties: {
        value: ref('Choice', { example: 'LOCAL', default: 'DOCUMENTATION' }),
        nullable: ref('Nullable', { example: null }),
        tree: ref('Tree', { description: 'Finite recursive example', example: { child: {} } }),
      },
    },
    {
      Choice: { type: 'string', pattern: '^(LOCAL|BASE)$', example: 'BASE', default: 'BASE' },
      Nullable: { type: ['string', 'null'], example: 'BASE' },
      Tree: { type: 'object', properties: { child: ref('Tree') } },
    },
  );
  const files = render(i.load());
  const example = files.get('node/examples/api-sendRecord.mjs');
  assert.match(example, /value: "LOCAL"/);
  assert.match(example, /nullable: null/);
  assert.match(example, /child: \{\}/);
});

test('invalid local examples remain rejected against referenced pattern constraints', () => {
  for (const siblings of [{ example: 'INVALID' }, { example: 'INVALID', default: 'SPECIAL' }]) {
    const i = fixture(
      { type: 'object', required: ['value'], properties: { value: ref('Special', siblings) } },
      { Special: { type: 'string', pattern: '^SPECIAL$', example: 'SPECIAL' } },
    );
    assert.throws(
      () => render(i.load()),
      /config\/operations\/sendRecord\/example:.*input\.body\.value: string violates pattern/,
    );
  }
});

test('local and inherited defaults remain metadata and never supply missing constrained inputs', async () => {
  const i = fixture(
    {
      type: 'object',
      required: ['value'],
      properties: {
        value: ref('Special', { description: 'Local default', default: 'SPECIAL' }),
        inherited: ref('Special', { description: 'Inherited default' }),
      },
    },
    { Special: { type: 'string', pattern: '^SPECIAL$', default: 'SPECIAL' } },
  );
  const c = i.load();
  assert.equal(c.operations[0].body.properties.value.default, 'SPECIAL');
  assert.equal(c.operations[0].body.properties.inherited.default, 'SPECIAL');
  assert.throws(() => render(c), /input\.body\.value: string violates pattern/);
  const configured = fixture(
    {
      type: 'object',
      properties: { value: ref('Special', { description: 'Local default', default: 'LOCAL' }) },
    },
    { Special: { type: 'string', default: 'BASE' } },
    { ...config, operations: { sendRecord: { example: { body: {} } } } },
  );
  const contract = configured.load();
  assert.equal(contract.operations[0].body.properties.value.default, 'LOCAL');
  assert.equal(contract.definitions.Special.default, 'BASE');
  generate(contract, configured.output);
  const file = join(configured.dir, 'cases.json');
  writeFileSync(
    file,
    JSON.stringify([
      {
        name: 'default does not fill absent field',
        operation: 'sendRecord',
        input: { body: {} },
        expected: { method: 'POST', path: '/v1/records', body: '{}' },
        responses: [{ status: 200, body: '{}' }],
        data: {},
      },
    ]),
  );
  assert.deepEqual(
    (await validateFixtures(configured.output, file)).map((r) => r.scenarios),
    [1, 1],
  );
});
