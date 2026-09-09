import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { loadContract, generate, render, compare, validateFixtures } from '../dist/index.js';
import { serialize, redact } from '../dist/runtime.js';

const root = mkdtempSync(join(tmpdir(), 'sdk-ref-siblings-'));
after(() => rmSync(root, { recursive: true, force: true }));
const config = {
  version: '1.0.0',
  validation: 'schema',
  npm: { name: 'siblings-sdk' },
  composer: { name: 'siblings/sdk', namespace: 'SiblingsSdk' },
};
const ref = (name, siblings = {}) => ({ $ref: '#/components/schemas/' + name, ...siblings });
const content = (schema) => ({ 'application/json': { schema } });
const operation = (schema, operationId = 'sendValue') => ({
  operationId,
  requestBody: { required: true, content: content(schema) },
  responses: { 200: { description: 'Value', content: content(schema) } },
});
function document(schema, schemas = {}, version = '3.1.1') {
  return {
    openapi: version,
    info: { title: 'Siblings', version: '1' },
    paths: { '/values': { post: operation(schema) } },
    components: { schemas },
  };
}
function inputs(doc, profile = config, files = {}) {
  const dir = mkdtempSync(join(root, 'case-'));
  const write = (name, value) => {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), JSON.stringify(value));
  };
  write('api.json', doc);
  write('sdk.json', profile);
  for (const [name, value] of Object.entries(files)) write(name, value);
  return {
    dir,
    output: join(dir, 'out'),
    load: () => loadContract(join(dir, 'api.json'), join(dir, 'sdk.json')),
  };
}
function accepted(name, body, wire = JSON.stringify(body), data = body) {
  return {
    name,
    operation: 'sendValue',
    input: { body },
    expected: { method: 'POST', path: '/v1/values', body: wire },
    responses: [{ status: 200, body: JSON.stringify(data) }],
    data,
  };
}
function rejected(name, body) {
  return {
    name,
    operation: 'sendValue',
    input: { body },
    responses: [],
    attempts: 0,
    error: { kind: 'validation' },
  };
}
async function fixtures(i, cases, disableAdapters = true) {
  generate(i.load(), i.output);
  if (disableAdapters) {
    const node = join(i.output, 'node/codec-plan.js');
    const source = readFileSync(node, 'utf8');
    assert.ok(source.includes('export function compileCodec(schema) {'));
    writeFileSync(
      node,
      source.replace(
        'export function compileCodec(schema) {',
        'export function compileCodec(schema) { throw new Error("adapter invoked");',
      ),
    );
    const php = join(i.output, 'php/src/SchemaAdapter.php');
    const sourcePhp = readFileSync(php, 'utf8');
    const disabled = sourcePhp.replace(
      /(public static function compile\(array \$schema\): array\s*\{)/,
      '$1 throw new \\Exception("adapter invoked");',
    );
    assert.notEqual(disabled, sourcePhp);
    writeFileSync(php, disabled);
  }
  const file = join(i.dir, 'cases.json');
  writeFileSync(file, JSON.stringify(cases));
  assert.deepEqual(
    (await validateFixtures(i.output, file)).map((r) => r.scenarios),
    [cases.length, cases.length],
  );
}

test('3.1 sibling constraints intersect, retain local metadata, and never contaminate cached targets', () => {
  const base = {
    type: 'string',
    minLength: 2,
    description: 'Base',
    example: { $ref: 'missing.json' },
  };
  const i = inputs(
    document(
      {
        type: 'object',
        properties: {
          short: ref('Text', { maxLength: 3, description: 'Short' }),
          long: ref('Text', { minLength: 5 }),
          plain: ref('Text'),
        },
      },
      { Text: base },
    ),
  );
  const c = i.load(),
    body = c.operations[0].body;
  assert.equal(body.properties.short.description, 'Short');
  assert.equal(body.properties.long.description, 'Base');
  assert.deepEqual(c.models.Text, base);
  assert.deepEqual(body.properties.plain, base);
  assert.equal(serialize({ short: 'abc', long: 'abcde' }, body), '{"short":"abc","long":"abcde"}');
  assert.throws(() => serialize({ short: 'a' }, body), /minLength/);
  assert.throws(() => serialize({ short: 'abcd' }, body), /maxLength/);
  assert.throws(() => serialize({ long: 'abcd' }, body), /minLength/);
});

test('3.0 ignores reference siblings without traversing them and preserves nullable wrappers', async () => {
  const i = inputs(
    document(
      {
        type: 'object',
        properties: {
          value: ref('Text', {
            nullable: true,
            description: 'Ignored',
            maxLength: 1,
            allOf: [{ $ref: 'missing.json' }],
          }),
          wrapped: { nullable: true, allOf: [ref('Text')] },
        },
      },
      { Text: { type: 'string', description: 'Original' } },
      '3.0.4',
    ),
  );
  const body = i.load().operations[0].body;
  assert.deepEqual(body.properties.value, { type: 'string', description: 'Original' });
  await fixtures(i, [
    accepted('ignored bounds', { value: 'long', wrapped: null }),
    rejected('ignored nullable', { value: null }),
  ]);
});

test('3.1 non-schema reference annotations override descriptions; other siblings are ignored', () => {
  for (const version of ['3.0.4', '3.1.1']) {
    const doc = document({ type: 'string' }, {}, version);
    doc.components.parameters = {
      Search: { name: 'q', in: 'query', description: 'Base', schema: { type: 'string' } },
    };
    doc.components.requestBodies = {
      Body: { required: true, content: content({ type: 'string' }) },
    };
    doc.components.responses = {
      Result: { description: 'Base', content: content({ type: 'string' }) },
    };
    const op = doc.paths['/values'].post;
    op.parameters = [
      {
        $ref: '#/components/parameters/Search',
        description: 'Local',
        summary: 'No effect',
        required: true,
        schema: { $ref: 'missing.json' },
      },
    ];
    op.requestBody = {
      $ref: '#/components/requestBodies/Body',
      description: 'Local',
      required: false,
    };
    op.responses[200] = {
      $ref: '#/components/responses/Result',
      description: 'Local',
      content: { $ref: 'missing.json' },
    };
    const c = inputs(doc).load();
    assert.equal(
      c.operations[0].parameters[0].description,
      version.startsWith('3.1') ? 'Local' : 'Base',
    );
    assert.equal(c.operations[0].parameters[0].required, undefined);
    assert.equal(c.operations[0].parameters[0].summary, undefined);
    assert.equal(c.operations[0].bodyRequired, true);
    assert.equal(c.operations[0].responses[200].schema.type, 'string');
  }
});

test('external sibling references retain their own origins, dependencies, and deterministic output', () => {
  const doc = document(
    {
      $ref: './base/schema.json',
      properties: { local: { $ref: './local.json' }, renamed: ref('Extra') },
    },
    { Extra: { type: 'string' }, Unused: ref('Unused') },
  );
  const i = inputs(
    doc,
    { ...config, models: { Extra: 'ExtraValue' } },
    {
      'base/schema.json': {
        $ref: './parent.json',
        properties: { nested: { $ref: './nested.json' } },
      },
      'base/parent.json': {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      'base/nested.json': { type: 'integer' },
      'local.json': { type: 'boolean' },
    },
  );
  const c = i.load();
  assert.ok(c.models.ExtraValue);
  assert.equal(c.models.Unused, undefined);
  for (const name of ['base/schema.json', 'base/parent.json', 'base/nested.json', 'local.json'])
    assert.ok(c.sources[name]);
  assert.equal(
    serialize({ id: 'a', nested: 2, local: true }, c.operations[0].body),
    '{"id":"a","nested":2,"local":true}',
  );
  const relocated = join(root, 'relocated');
  cpSync(i.dir, relocated, { recursive: true });
  const other = loadContract(join(relocated, 'api.json'), join(relocated, 'sdk.json'));
  assert.deepEqual(c.sources, other.sources);
  assert.deepEqual(render(c), render(other));
});

test('Path Item siblings combine with per-field origins and selection in both versions', async () => {
  for (const version of ['3.0.4', '3.1.1']) {
    const doc = document({ type: 'string' }, {}, version);
    doc.paths['/values'] = {
      $ref: './paths/item.json',
      post: operation({ $ref: './local.json' }),
      delete: operation({ $ref: 'missing.json' }, 'excluded'),
    };
    const i = inputs(
      doc,
      { ...config, include: ['sendValue', 'readValue'] },
      {
        'paths/item.json': { $ref: './parent.json', description: 'Path' },
        'paths/parent.json': {
          get: {
            operationId: 'readValue',
            responses: { 200: { content: content({ $ref: './value.json' }) } },
          },
        },
        'paths/value.json': { type: 'integer' },
        'local.json': { type: 'string' },
      },
    );
    const c = i.load();
    assert.equal(
      c.operations.find((op) => op.id === 'readValue').responses[200].schema.type,
      'integer',
    );
    assert.equal(c.operations.find((op) => op.id === 'sendValue').body.type, 'string');
    assert.equal(c.operations.length, 2);
    await fixtures(i, [
      accepted('local post', 'text'),
      {
        name: 'referenced get',
        operation: 'readValue',
        input: {},
        expected: { method: 'GET', path: '/v1/values' },
        responses: [{ status: 200, body: '2' }],
        data: 2,
      },
    ]);
    for (const key of ['description', 'get']) {
      const conflict = structuredClone(doc);
      conflict.paths['/values'][key] = key === 'description' ? 'Path' : { operationId: 'other' };
      const j = inputs(conflict, config, {
        'paths/item.json': { [key]: conflict.paths['/values'][key] },
      });
      assert.throws(j.load, new RegExp('conflicting path item \\$ref field ' + key));
    }
    const cycle = inputs(doc, config, { 'paths/item.json': { $ref: './item.json' } });
    assert.throws(cycle.load, /cyclic path item reference/);
  }
});

test('map keys and annotation payloads are literal; unsupported active siblings still fail', () => {
  const schema = {
    type: 'object',
    properties: {
      $ref: ref('Text', { description: 'Reference-named field' }),
      schemas: { type: 'string' },
      properties: { type: 'string' },
    },
    example: { $ref: 'missing.json' },
    default: { $ref: 'missing.json' },
    'x-vendor': { $ref: 'missing.json' },
  };
  const i = inputs(document(schema, { Text: { type: 'string' } }));
  assert.equal(serialize({ $ref: 'a' }, i.load().operations[0].body), '{"$ref":"a"}');
  for (const sibling of [{ multipleOf: 2 }, { 'x-sdk-ref': 'Forged' }, { readOnly: 'yes' }])
    assert.throws(
      inputs(document(ref('Text', sibling), { Text: { type: 'string', readOnly: true } })).load,
      /unsupported|reserved|boolean/,
    );
  assert.throws(
    inputs(document(ref('Loop', { description: 'Still a cycle' }), { Loop: ref('Loop') })).load,
    /must descend/,
  );
  for (const allOf of [null, {}, [], [null]])
    assert.throws(
      inputs(document(ref('Text', { allOf }), { Text: { type: 'string' } })).load,
      /expected a (nonempty schema array|schema object)/,
    );
  for (const [base, siblings] of [
    [{ type: 'integer' }, { format: 'int64' }],
    [{ type: 'integer', format: 'int64' }, { type: 'integer' }],
  ])
    assert.throws(
      inputs(document(ref('NumberValue', siblings), { NumberValue: base })).load,
      /different SDK representations/,
    );
});

test('both emitted codecs enforce sibling bounds, enums, object scope, arrays and nullability', async () => {
  const schemas = {
    Amount: { type: 'integer', format: 'int64', minimum: 2 },
    Choice: { type: 'string', enum: ['a', 'b'] },
    Values: { type: 'array', items: { type: 'string' }, minItems: 1 },
    RecordValue: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    Nullable: { type: ['string', 'null'] },
  };
  const body = {
    type: 'object',
    properties: {
      amount: ref('Amount', { maximum: 10 }),
      choice: ref('Choice', { enum: ['b', 'c'] }),
      values: ref('Values', { maxItems: 2, items: { minLength: 2 } }),
      record: ref('RecordValue', {
        required: ['extra'],
        properties: { extra: { type: 'boolean' } },
        allOf: [{ properties: { id: { minLength: 2 } } }],
      }),
      nullable: ref('Nullable', { type: 'string' }),
      nonnullable: ref('Choice', { type: ['string', 'null'] }),
      exact: ref('Amount', { minimum: 5 }),
      alternative: ref('Choice', {
        oneOf: [{ enum: ['a'] }, { enum: ['b'] }],
        not: { enum: ['a'] },
      }),
      any: ref('Choice', { anyOf: [{ enum: ['b'] }, { enum: ['c'] }] }),
    },
  };
  const i = inputs(document(body, schemas));
  await fixtures(i, [
    accepted(
      'intersections',
      { amount: '10', choice: 'b', values: ['ab'], record: { id: 'ok', extra: true } },
      '{"amount":10,"choice":"b","values":["ab"],"record":{"id":"ok","extra":true}}',
    ),
    accepted('large exact value', { exact: '9007199254740993' }, '{"exact":9007199254740993}'),
    rejected('referenced minimum', { amount: '1' }),
    rejected('sibling maximum', { amount: '11' }),
    rejected('sibling numeric constraint uses exact kind', { exact: '4' }),
    rejected('referenced enum', { choice: 'c' }),
    rejected('sibling enum', { choice: 'a' }),
    rejected('referenced required key', { record: { extra: true } }),
    rejected('sibling required key', { record: { id: 'ok' } }),
    rejected('existing sibling allOf retained', { record: { id: 'x', extra: true } }),
    rejected('referenced array minimum', { values: [] }),
    rejected('sibling array maximum', { values: ['ab', 'cd', 'ef'] }),
    rejected('sibling items', { values: ['a'] }),
    rejected('narrow nullable target', { nullable: null }),
    rejected('cannot broaden target nullability', { nonnullable: null }),
    accepted('sibling alternatives', { alternative: 'b', any: 'b' }),
    rejected('sibling not', { alternative: 'a' }),
    rejected('sibling anyOf', { any: 'a' }),
  ]);
  const closed = inputs(
    document(ref('Closed', { properties: { extra: { type: 'string' } } }), {
      Closed: {
        type: 'object',
        additionalProperties: false,
        properties: { id: { type: 'string' } },
      },
    }),
  );
  await fixtures(closed, [
    accepted('closed base', { id: 'a' }),
    rejected('siblings cannot open closed target', { id: 'a', extra: 'x' }),
  ]);
});

test('direction and redaction annotations cannot be weakened by siblings', async () => {
  const i = inputs(
    document(
      {
        type: 'object',
        required: ['id', 'credential', 'label'],
        properties: {
          id: ref('Read', { readOnly: false, minLength: 2 }),
          credential: ref('Write', { writeOnly: false }),
          label: ref('Text', { 'x-sensitive': true, minLength: 2 }),
          inherited: ref('Sensitive', { 'x-sensitive': false }),
        },
      },
      {
        Read: { type: 'string', readOnly: true },
        Write: { type: 'string', writeOnly: true },
        Text: { type: 'string' },
        Sensitive: { type: 'string', 'x-sensitive': true },
      },
    ),
  );
  const body = i.load().operations[0].body;
  assert.equal(body.properties.id.readOnly, true);
  assert.equal(body.properties.credential.writeOnly, true);
  assert.deepEqual(redact({ label: 'hidden', inherited: 'hidden', credential: 'hidden' }, body), {
    label: '[REDACTED]',
    inherited: '[REDACTED]',
    credential: '[REDACTED]',
  });
  await fixtures(i, [
    accepted(
      'directional fields',
      { credential: 'private', label: 'visible' },
      '{"credential":"private","label":"visible"}',
      { id: 'id', label: 'visible' },
    ),
    rejected('readOnly cannot be cleared', { id: 'id', credential: 'private', label: 'ok' }),
    rejected('writeOnly remains required', { label: 'ok' }),
  ]);
  const php = spawnSync(
    'php',
    [
      '-r',
      String.raw`
    require $argv[1].'/src/Runtime.php';require $argv[1].'/src/Client.php';
    $model=new SiblingsSdk\ApiSendValueInput(['body'=>['credential'=>'never-print-this','label'=>'never-print-this']]);
    var_dump($model);
  `,
      join(i.output, 'php'),
    ],
    { encoding: 'utf8' },
  );
  assert.equal(php.status, 0, php.stderr);
  assert.equal(php.stdout.includes('never-print-this'), false);
  assert.throws(
    inputs(document(ref('Read', { writeOnly: true }), { Read: { type: 'string', readOnly: true } }))
      .load,
    /both readOnly and writeOnly/,
  );
});

test('recursive field, item and dictionary siblings survive compaction and enforce both branches', async () => {
  const tree = {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string' },
      extra: { type: 'boolean' },
      child: ref('Tree', { required: ['extra'], 'x-sensitive': true }),
      children: { type: 'array', items: ref('Tree', { required: ['extra'] }) },
      lookup: { type: 'object', additionalProperties: ref('Tree', { required: ['extra'] }) },
    },
  };
  const i = inputs(document(ref('Tree'), { Tree: tree }), {
    ...config,
    models: { Tree: 'Branch' },
  });
  const c = i.load();
  assert.ok(c.definitions.Branch);
  const nested = {
    id: 'root',
    child: { id: 'child', extra: true, child: { id: 'leaf', extra: false } },
    children: [{ id: 'item', extra: true }],
    lookup: { key: { id: 'entry', extra: true } },
  };
  await fixtures(i, [
    accepted('recursive siblings', nested),
    rejected('field sibling at recursive edge', {
      id: 'a',
      child: { id: 'b', extra: true, child: { id: 'c' } },
    }),
    rejected('item sibling', { id: 'a', children: [{ id: 'b' }] }),
    rejected('dictionary sibling', { id: 'a', lookup: { key: { id: 'b' } } }),
    rejected('referenced required field', { id: 'a', child: { extra: true } }),
  ]);
  const { Client } = await import(pathToFileURL(join(i.output, 'node/index.js')).href);
  let attempts = 0;
  const client = new Client({
    baseUrl: 'https://example.invalid',
    transport: async () => {
      attempts++;
      return new Response(JSON.stringify(nested));
    },
  });
  const cycle = { id: 'a', extra: true };
  cycle.child = cycle;
  await assert.rejects(client.api.sendValue({ body: cycle }), (e) => e.kind === 'validation');
  assert.equal(attempts, 0);
  const file = join(i.output, 'node/consumer.ts');
  writeFileSync(
    file,
    `import { type BranchInput } from './index.js';
const valid: BranchInput = {id:'a',child:{id:'b',extra:true}};
// @ts-expect-error sibling required field
const missingExtra: BranchInput = {id:'a',child:{id:'b'}};
// @ts-expect-error referenced required field
const missingId: BranchInput = {id:'a',child:{extra:true}};
`,
  );
  const types = spawnSync(
    process.execPath,
    [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '--strict',
      '--skipLibCheck',
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      file,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(types.status, 0, types.stdout + types.stderr);
  const php = spawnSync(
    'php',
    [
      '-r',
      String.raw`
    require $argv[1].'/src/Runtime.php';require $argv[1].'/src/Client.php';
    $model=new SiblingsSdk\BranchInput(['id'=>'a','child'=>['id'=>'do-not-print','extra'=>true]]);
    if($model->getId()!=='a')exit(2); var_dump($model);
  `,
      join(i.output, 'php'),
    ],
    { encoding: 'utf8' },
  );
  assert.equal(php.status, 0, php.stderr);
  assert.equal(php.stdout.includes('do-not-print'), false);
});

test('scalar and scalar-array parameter siblings preserve constraints and wire serialization', async () => {
  const doc = document(
    { type: 'string' },
    {
      Id: { type: 'integer', format: 'int64' },
      Search: { type: 'string' },
      Tags: { type: 'array', items: { type: 'string' } },
      Nullable: { type: ['string', 'null'] },
    },
  );
  doc.paths = {
    '/values/{id}': {
      get: {
        operationId: 'readValue',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: ref('Id', { minimum: 5 }) },
          { name: 'q', in: 'query', schema: ref('Search', { minLength: 2 }) },
          {
            name: 'tags',
            in: 'query',
            schema: ref('Tags', { minItems: 1, maxItems: 2, items: { minLength: 2 } }),
          },
          { name: 'X-Test', in: 'header', schema: ref('Search', { maxLength: 3 }) },
          { name: 'narrow', in: 'query', schema: ref('Nullable', { type: 'string' }) },
        ],
        responses: { 204: { description: 'Empty' } },
      },
    },
  };
  const i = inputs(doc);
  const reject = (name, input) => ({
    name,
    operation: 'readValue',
    input,
    responses: [],
    attempts: 0,
    error: { kind: 'validation' },
  });
  await fixtures(i, [
    {
      name: 'parameter wire',
      operation: 'readValue',
      input: { id: '9007199254740993', q: 'a b', tags: ['ab', 'cd'], 'X-Test': 'yes' },
      expected: {
        method: 'GET',
        path: '/v1/values/9007199254740993?q=a%20b&tags=ab&tags=cd',
        headers: { 'x-test': 'yes' },
      },
      responses: [{ status: 204 }],
      empty: true,
    },
    reject('path bound', { id: '4' }),
    reject('query length', { id: '5', q: 'a' }),
    reject('array length', { id: '5', tags: [] }),
    reject('array item', { id: '5', tags: ['a'] }),
    reject('header length', { id: '5', 'X-Test': 'long' }),
    reject('narrow parameter excludes null', { id: '5', narrow: null }),
    {
      name: 'narrowed parameter',
      operation: 'readValue',
      input: { id: '5', narrow: 'yes' },
      expected: { method: 'GET', path: '/v1/values/5?narrow=yes' },
      responses: [{ status: 204 }],
      empty: true,
    },
  ]);
  for (const shape of [
    { type: 'object' },
    { type: ['string', 'null'] },
    { anyOf: [{ type: 'string' }, { type: 'boolean' }] },
  ]) {
    const invalid = structuredClone(doc);
    invalid.components.schemas.Search = shape;
    assert.throws(inputs(invalid).load, /parameters require/);
  }
});

test('tightened sibling constraints remain visible to compatibility analysis', () => {
  const base = document(ref('Text', { minLength: 2 }), { Text: { type: 'string' } });
  const next = structuredClone(base);
  next.paths['/values'].post.requestBody.content['application/json'].schema.minLength = 5;
  const changes = compare(inputs(base).load(), inputs(next).load());
  assert.ok(
    changes.some((change) => ['breaking', 'review'].includes(change.severity)),
    JSON.stringify(changes),
  );
});

test('external recursive siblings keep stable definitions and use-site annotations', async () => {
  const i = inputs(document({ $ref: './node.json' }), config, {
    'node.json': {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string' },
        extra: { type: 'boolean' },
        child: { $ref: './node.json', required: ['extra'], 'x-sensitive': true },
      },
    },
  });
  const c = i.load();
  assert.equal(Object.keys(c.definitions).length, 1);
  const relocated = join(root, 'recursive-relocated');
  cpSync(i.dir, relocated, { recursive: true });
  assert.deepEqual(
    render(c),
    render(loadContract(join(relocated, 'api.json'), join(relocated, 'sdk.json'))),
  );
  await fixtures(i, [
    accepted('external recursive constraint', { id: 'a', child: { id: 'b', extra: true } }),
    rejected('external recursive sibling missing', {
      id: 'a',
      child: { id: 'b', extra: true, child: { id: 'c' } },
    }),
  ]);
});

test('pagination and polling recognize types supplied by referenced conjuncts', () => {
  const doc = document(
    {},
    {
      Page: { type: 'array', items: { type: 'string' } },
      Cursor: { type: 'string' },
      State: { type: 'string' },
    },
  );
  doc.paths = {
    '/values': {
      get: {
        operationId: 'readValue',
        parameters: [{ name: 'cursor', in: 'query', schema: ref('Cursor', { minLength: 1 }) }],
        responses: {
          200: {
            content: content({
              type: 'object',
              properties: {
                items: ref('Page', { maxItems: 100 }),
                next: ref('Cursor', { maxLength: 100 }),
                state: ref('State', { enum: ['ready'] }),
              },
            }),
          },
        },
      },
    },
  };
  const i = inputs(doc, {
    ...config,
    operations: {
      readValue: {
        pagination: { kind: 'cursor', items: 'items', next: 'next', parameter: 'cursor' },
        polling: { state: 'state', success: ['ready'], failure: [], intervalMs: 1 },
      },
    },
  });
  const artifacts = render(i.load());
  assert.ok(artifacts.get('node/index.d.ts').includes('readValuePages'));
  assert.ok(artifacts.get('php/src/Client.php').includes('readValueWait'));
});

test('exact array items and dictionary values enforce composed numeric constraints in both targets', async () => {
  for (const form of ['siblings', 'allOf']) {
    const intersect = (name, siblings) =>
      form === 'siblings' ? ref(name, siblings) : { ...siblings, allOf: [ref(name)] };
    const body = {
      type: 'object',
      properties: {
        list: intersect('Numbers', { items: { minimum: 5, maximum: 10 } }),
        map: intersect('Dictionary', {
          additionalProperties: { minimum: 5, exclusiveMaximum: 10 },
        }),
        enumList: intersect('Numbers', { items: { enum: [5] } }),
        enumMap: intersect('Dictionary', { additionalProperties: { enum: [5] } }),
        decimal: intersect('Decimals', { items: { minimum: 5, maximum: 6 } }),
        nested: intersect('Nested', { items: { additionalProperties: { minimum: 5 } } }),
      },
    };
    const number = { type: 'integer', format: 'int64' };
    const schemas = {
      Numbers: { type: 'array', items: number },
      Dictionary: { type: 'object', additionalProperties: number },
      Decimals: { type: 'array', items: { type: 'number' } },
      Nested: { type: 'array', items: { type: 'object', additionalProperties: number } },
    };
    const i = inputs(document(body, schemas));
    await fixtures(i, [
      accepted(
        'valid intersections',
        {
          list: ['5', '10'],
          map: { a: '5' },
          enumList: ['5'],
          enumMap: { a: '5' },
          decimal: ['5.25'],
          nested: [{ a: '9007199254740993' }],
        },
        '{"list":[5,10],"map":{"a":5},"enumList":[5],"enumMap":{"a":5},"decimal":[5.25],"nested":[{"a":9007199254740993}]}',
      ),
      rejected('array minimum', { list: ['1'] }),
      rejected('array maximum', { list: ['11'] }),
      rejected('dictionary minimum', { map: { a: '1' } }),
      rejected('dictionary exclusive maximum', { map: { a: '10' } }),
      rejected('array numeric enum', { enumList: ['6'] }),
      rejected('dictionary numeric enum', { enumMap: { a: '6' } }),
      rejected('decimal bound', { decimal: ['4.99'] }),
      rejected('nested bound', { nested: [{ a: '1' }] }),
    ]);
    const encoding = inputs(document(body, schemas), { ...config, validation: 'encoding' });
    await fixtures(encoding, [
      accepted(
        'encoding profile retains server bounds',
        { list: ['1'], map: { a: '1' } },
        '{"list":[1],"map":{"a":1}}',
      ),
      rejected('encoding profile still checks numeric enums', { enumList: ['6'] }),
    ]);
    for (const schema of [
      intersect('Numbers', { items: { type: 'integer' } }),
      intersect('Dictionary', { additionalProperties: { type: 'integer' } }),
    ])
      assert.throws(inputs(document(schema, schemas)).load, /different SDK representations/);
  }
});

test('property and dictionary intersections enforce numeric constraints without changing other keys', async () => {
  for (const form of ['siblings', 'allOf']) {
    const intersect = (name, siblings) =>
      form === 'siblings' ? ref(name, siblings) : { ...siblings, allOf: [ref(name)] };
    const exact = { type: 'integer', format: 'int64' };
    const schemas = {
      Dictionary: { type: 'object', additionalProperties: exact },
      Fields: {
        type: 'object',
        properties: { amount: exact, count: { type: 'integer' }, label: { type: 'string' } },
      },
      Nested: { type: 'object', additionalProperties: { type: 'array', items: exact } },
    };
    const body = {
      type: 'object',
      properties: {
        named: intersect('Dictionary', { properties: { amount: { minimum: 5, maximum: 10 } } }),
        extras: intersect('Fields', { additionalProperties: { minimum: 5, exclusiveMaximum: 10 } }),
        namedEnum: intersect('Dictionary', { properties: { amount: { enum: [5] } } }),
        extraEnum: intersect('Fields', { additionalProperties: { enum: [5] } }),
        nested: intersect('Nested', { properties: { amounts: { items: { minimum: 5 } } } }),
      },
    };
    const i = inputs(document(body, schemas));
    await fixtures(i, [
      accepted(
        'independent property and dictionary representations',
        {
          named: { amount: '5', other: '1' },
          extras: { amount: '5', count: 5, label: 'text', other: 'text', numeric: 5 },
          namedEnum: { amount: '5', other: '6' },
          extraEnum: { amount: '5', count: 5 },
          nested: { amounts: ['5'], other: ['1'] },
        },
        '{"named":{"amount":5,"other":1},"extras":{"amount":5,"count":5,"label":"text","other":"text","numeric":5},"namedEnum":{"amount":5,"other":6},"extraEnum":{"amount":5,"count":5},"nested":{"amounts":[5],"other":[1]}}',
      ),
      rejected('named property minimum', { named: { amount: '1' } }),
      rejected('named property maximum', { named: { amount: '11' } }),
      rejected('dictionary minimum on named field', { extras: { amount: '1' } }),
      rejected('dictionary exclusive maximum on named field', { extras: { amount: '10' } }),
      rejected('dictionary bounds on other numeric fields', { extras: { numeric: 1 } }),
      rejected('named numeric enum', { namedEnum: { amount: '6' } }),
      rejected('dictionary numeric enum on named field', { extraEnum: { amount: '6' } }),
      rejected('nested property bound supplied by dictionary', { nested: { amounts: ['1'] } }),
    ]);
    const encoding = inputs(document(body, schemas), { ...config, validation: 'encoding' });
    await fixtures(encoding, [
      accepted(
        'encoding leaves business bounds to the server',
        { named: { amount: '1' }, extras: { amount: '1' } },
        '{"named":{"amount":1},"extras":{"amount":1}}',
      ),
      rejected('encoding still enforces named enums', { namedEnum: { amount: '6' } }),
      rejected('encoding still enforces dictionary enums', { extraEnum: { amount: '6' } }),
    ]);
    assert.throws(
      inputs(
        document(intersect('Dictionary', { properties: { amount: { type: 'integer' } } }), schemas),
      ).load,
      /different SDK representations/,
    );
  }
});

test('tagged response guards specialize dictionary bounds for each variant field', async () => {
  const tagged = {
    oneOf: [
      {
        type: 'object',
        required: ['kind', 'amount'],
        properties: {
          kind: { type: 'string', enum: ['paid'] },
          amount: { type: 'integer', format: 'int64' },
        },
      },
      {
        type: 'object',
        required: ['kind', 'amount'],
        properties: { kind: { type: 'string', enum: ['text'] }, amount: { type: 'string' } },
      },
    ],
    discriminator: { propertyName: 'kind' },
  };
  const doc = document(ref('Event', { additionalProperties: { minimum: 5, maximum: 10 } }), {
    Event: tagged,
  });
  delete doc.paths['/values'].post.requestBody;
  const i = inputs(doc);
  await fixtures(
    i,
    [
      ['numeric branch', '{"kind":"paid","amount":5}', { kind: 'paid', amount: '5' }],
      ['string branch', '{"kind":"text","amount":"words"}', { kind: 'text', amount: 'words' }],
      ['tolerant response bounds', '{"kind":"paid","amount":1}', { kind: 'paid', amount: '1' }],
    ].map(([name, body, data]) => ({
      name,
      operation: 'sendValue',
      input: {},
      expected: { method: 'POST', path: '/v1/values' },
      responses: [{ status: 200, body }],
      data,
    })),
  );
  const sdk = await import(pathToFileURL(join(i.output, 'node/index.js')).href);
  const known = sdk.isApiSendValueResponseKnown;
  assert.equal(known({ kind: 'paid', amount: '5' }), true);
  assert.equal(known({ kind: 'paid', amount: '1' }), false);
  assert.equal(known({ kind: 'paid', amount: '11' }), false);
  assert.equal(known({ kind: 'text', amount: 'words', other: 'text' }), true);
  assert.equal(known({ kind: 'paid', amount: '5', other: 1 }), false);
});

test('composed tagged responses retain guards and PHP variants with all sibling constraints', async () => {
  const tagged = {
    oneOf: [
      {
        type: 'object',
        required: ['kind', 'amount'],
        properties: {
          kind: { type: 'string', enum: ['paid'] },
          amount: { type: 'integer', format: 'int64' },
        },
      },
      {
        type: 'object',
        required: ['kind', 'reason'],
        properties: {
          kind: { type: 'string', enum: ['failed'] },
          reason: { type: 'string' },
          amount: { type: 'string' },
        },
      },
    ],
    discriminator: { propertyName: 'kind' },
  };
  const siblings = {
    required: ['traceId'],
    properties: {
      traceId: { type: 'string', minLength: 3 },
      label: { type: 'string', 'x-sensitive': true },
      amount: { minimum: 5, maximum: 10 },
    },
    not: { required: ['forbidden'] },
  };
  for (const form of ['siblings', 'nested-allOf', 'typed-siblings', 'sibling-oneOf']) {
    const shape =
      form === 'nested-allOf'
        ? { ...siblings, allOf: [{ allOf: [ref('Event')] }] }
        : ref('Event', {
            ...siblings,
            ...(form === 'typed-siblings' ? { type: 'object' } : {}),
            ...(form === 'sibling-oneOf'
              ? {
                  oneOf: [
                    { properties: { traceId: { enum: ['abc'] } } },
                    { properties: { traceId: { enum: ['x'] } } },
                  ],
                }
              : {}),
          });
    const doc = document(shape, { Event: tagged });
    delete doc.paths['/values'].post.requestBody;
    const i = inputs(doc);
    const responseCase = (name, body, data = body) => ({
      name,
      operation: 'sendValue',
      input: {},
      expected: { method: 'POST', path: '/v1/values' },
      responses: [{ status: 200, body: JSON.stringify(body) }],
      data,
    });
    await fixtures(i, [
      responseCase('known paid variant', {
        kind: 'paid',
        amount: '5',
        traceId: 'abc',
        label: 'private',
      }),
      responseCase('known failed variant', { kind: 'failed', reason: 'declined', traceId: 'abc' }),
      responseCase('string branch keeps its representation', {
        kind: 'failed',
        reason: 'declined',
        amount: 'text',
        traceId: 'abc',
      }),
      responseCase('future tag preserved', { kind: 'future', traceId: 'abc', future: true }),
      responseCase('responses tolerate business bounds', {
        kind: 'paid',
        amount: '1',
        traceId: 'x',
      }),
      {
        name: 'response missing sibling required key',
        operation: 'sendValue',
        input: {},
        expected: { method: 'POST', path: '/v1/values' },
        responses: [{ status: 200, body: '{"kind":"paid","amount":5}' }],
        error: { kind: 'protocol' },
      },
    ]);
    const sdk = await import(pathToFileURL(join(i.output, 'node/index.js')).href);
    const known = sdk.isApiSendValueResponseKnown;
    assert.equal(typeof known, 'function');
    assert.equal(known({ kind: 'paid', amount: '5', traceId: 'abc', future: true }), true);
    if (form === 'sibling-oneOf')
      assert.equal(known({ kind: 'paid', amount: '5', traceId: 'xyz' }), false);
    assert.equal(known({ kind: 'failed', reason: 'declined', traceId: 'abc' }), true);
    assert.equal(
      known({ kind: 'failed', reason: 'declined', amount: 'text', traceId: 'abc' }),
      true,
    );
    for (const value of [
      { kind: 'paid', amount: '5' },
      { kind: 'paid', amount: '5', traceId: 'x' },
      { kind: 'paid', amount: 'bad', traceId: 'abc' },
      { kind: 'paid', amount: '1', traceId: 'abc' },
      { kind: 'paid', amount: '11', traceId: 'abc' },
      { kind: 'paid', amount: '5', traceId: 'abc', forbidden: true },
      { kind: 'future', traceId: 'abc' },
      { kind: 'failed', traceId: 'abc' },
    ])
      assert.equal(known(value), false, JSON.stringify(value));
    const file = join(i.output, 'node/consumer.ts');
    writeFileSync(
      file,
      `import {type ApiSendValueResponse,isApiSendValueResponseKnown} from './index.js';
declare const value:ApiSendValueResponse;
if(isApiSendValueResponseKnown(value)) {
  const trace:string=value.traceId;
  if(value.kind==='paid'){const amount:string=value.amount;}
  if(value.kind==='failed'){const reason:string=value.reason;}
  // @ts-expect-error guard preserves the finite tag union
  const never:'future'=value.kind;
}
`,
    );
    const types = spawnSync(
      process.execPath,
      [
        'node_modules/typescript/bin/tsc',
        '--noEmit',
        '--strict',
        '--skipLibCheck',
        '--target',
        'ES2022',
        '--module',
        'NodeNext',
        '--moduleResolution',
        'NodeNext',
        file,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(types.status, 0, types.stdout + types.stderr);
    const php = spawnSync(
      'php',
      [
        '-r',
        String.raw`
      require $argv[1].'/src/Runtime.php';require $argv[1].'/src/Client.php';
      $raw='{"kind":"paid","amount":5,"traceId":"abc","label":"do-not-print"}';
      $client=new SiblingsSdk\Client(new SiblingsSdk\ClientOptions('https://example.invalid',transport:fn($r)=>['status'=>200,'headers'=>[],'body'=>$raw]));
      $value=$client->api->sendValue(new SiblingsSdk\ApiSendValueInput())->data;
      if(!($value instanceof SiblingsSdk\ApiSendValueResponse200Variant0))exit(2);
      if($value->getAmount()!=='5'||$value->getTraceId()!=='abc')exit(3);
      var_dump($value);
      try { new SiblingsSdk\ApiSendValueResponse200Variant0(['kind'=>'paid','amount'=>'5']);exit(4); }
      catch(SiblingsSdk\SdkError $e){if($e->kind!=='validation')throw $e;}
      try { new SiblingsSdk\ApiSendValueResponse200Variant0(['kind'=>'paid','amount'=>'5','traceId'=>'abc','forbidden'=>true]);exit(5); }
      catch(SiblingsSdk\SdkError $e){if($e->kind!=='validation')throw $e;}
    `,
        join(i.output, 'php'),
      ],
      { encoding: 'utf8' },
    );
    assert.equal(php.status, 0, php.stdout + php.stderr);
    assert.equal(php.stdout.includes('do-not-print'), false);
  }
});

test('union siblings validate numeric wire values in requests under both policies', async () => {
  for (const keyword of ['oneOf', 'anyOf']) {
    for (const validation of ['schema', 'encoding']) {
      const choice = {
        [keyword]: [
          {
            type: 'object',
            required: ['kind', 'amount'],
            properties: { kind: { type: 'string', enum: ['paid'] }, amount: { type: 'number' } },
          },
          {
            type: 'object',
            required: ['kind', 'amount'],
            properties: { kind: { type: 'string', enum: ['text'] }, amount: { type: 'string' } },
          },
        ],
      };
      const i = inputs(
        document(
          {
            type: 'object',
            properties: {
              bounded: ref('Choice', { properties: { amount: { minimum: 5, maximum: 10 } } }),
              enumerated: ref('Choice', { properties: { amount: { enum: [5] } } }),
              excluded: ref('Choice', {
                not: { required: ['amount'], properties: { amount: { enum: [7] } } },
              }),
            },
          },
          { Choice: choice },
        ),
        { ...config, validation },
      );
      await fixtures(i, [
        accepted(
          'numeric boundary',
          { bounded: { kind: 'paid', amount: '5' } },
          '{"bounded":{"kind":"paid","amount":5}}',
        ),
        accepted('string branch keeps string semantics', {
          bounded: { kind: 'text', amount: '1' },
        }),
        accepted(
          'numeric enum accepts equivalent decimal',
          { enumerated: { kind: 'paid', amount: '5e0' } },
          '{"enumerated":{"kind":"paid","amount":5e0}}',
        ),
        rejected('numeric enum rejects different number', {
          enumerated: { kind: 'paid', amount: '6' },
        }),
        rejected('numeric enum does not accept a JSON string', {
          enumerated: { kind: 'text', amount: '5' },
        }),
        rejected('negation sees numeric wire kind', { excluded: { kind: 'paid', amount: '7' } }),
        accepted('negation preserves JSON strings', { excluded: { kind: 'text', amount: '7' } }),
        ...(validation === 'schema'
          ? [
              rejected('numeric minimum', { bounded: { kind: 'paid', amount: '1' } }),
              rejected('numeric maximum', { bounded: { kind: 'paid', amount: '11' } }),
            ]
          : [
              accepted(
                'encoding policy leaves bounds to server',
                { bounded: { kind: 'paid', amount: '1' } },
                '{"bounded":{"kind":"paid","amount":1}}',
              ),
            ]),
      ]);
    }
  }
});

test('numeric negation preserves JSON strings in generated requests and responses', async () => {
  for (const validation of ['schema', 'encoding']) {
    const numeric = { type: 'number' };
    const exactInteger = { type: 'integer', format: 'int64' };
    const text = { type: 'string', not: numeric };
    const schema = {
      type: 'object',
      properties: {
        inline: text,
        sibling: ref('Text', { not: exactInteger }),
        nested: {
          type: 'object',
          properties: { value: { type: 'string' } },
          not: { required: ['value'], properties: { value: numeric } },
        },
        list: { type: 'array', items: { type: 'string', not: { anyOf: [numeric, exactInteger] } } },
        map: {
          type: 'object',
          additionalProperties: { type: 'string', not: { allOf: [numeric, { enum: [7] }] } },
        },
        amount: { type: 'number', not: { type: 'number', enum: [7] } },
      },
    };
    const i = inputs(document(schema, { Text: { type: 'string' } }), { ...config, validation });
    const body = {
      inline: '7',
      sibling: '7',
      nested: { value: '7' },
      list: ['7', '7.0', '7e0', 'abc'],
      map: { value: '7' },
      amount: '8',
    };
    const wire = JSON.stringify({ ...body, amount: 8 });
    const success = accepted(
      'strings stay quoted and positive numeric declarations still encode',
      body,
      wire,
    );
    success.responses[0].body = wire;
    await fixtures(i, [
      success,
      rejected('numeric negation still excludes actual numbers', { amount: '7' }),
      rejected('numeric negation still excludes equivalent numeric spellings', { amount: '7e0' }),
      rejected('string fields still reject native numbers', { inline: 7 }),
    ]);
  }
});

test('dynamic numeric negation matches the established JSON kind', () => {
  assert.equal(serialize('7', { type: 'string', not: { type: 'number' } }), '"7"');
  assert.equal(serialize('7', { type: 'number', not: { type: 'string' } }), '7');
  assert.throws(() => serialize('7', { type: 'string', not: { not: { type: 'number' } } }), {
    kind: 'validation',
  });
});

test('recursive numeric siblings enforce bounds and enums at every value depth', async () => {
  for (const validation of ['schema', 'encoding']) {
    const bounded = () => ref('Branch', { properties: { amount: { minimum: 5, maximum: 10 } } });
    const branch = {
      type: 'object',
      required: ['amount'],
      properties: {
        amount: { type: 'integer', format: 'int64' },
        child: bounded(),
        children: { type: 'array', items: bounded() },
        lookup: {
          type: 'object',
          additionalProperties: ref('Branch', { properties: { amount: { enum: [5] } } }),
        },
      },
    };
    const i = inputs(document(ref('Branch'), { Branch: branch }), { ...config, validation });
    await fixtures(i, [
      accepted(
        'exact recursive fields items and values',
        {
          amount: '9007199254740993',
          child: { amount: '5', child: { amount: '10' } },
          children: [{ amount: '5' }],
          lookup: { first: { amount: '5' } },
        },
        '{"amount":9007199254740993,"child":{"amount":5,"child":{"amount":10}},"children":[{"amount":5}],"lookup":{"first":{"amount":5}}}',
      ),
      rejected('recursive dictionary numeric enum', {
        amount: '1',
        lookup: { first: { amount: '6' } },
      }),
      rejected('deep recursive dictionary numeric enum', {
        amount: '1',
        child: { amount: '5', lookup: { first: { amount: '6' } } },
      }),
      ...(validation === 'schema'
        ? [
            rejected('first recursive edge minimum', { amount: '1', child: { amount: '1' } }),
            rejected('later recursive edge maximum', {
              amount: '1',
              child: { amount: '5', child: { amount: '11' } },
            }),
            rejected('recursive item bound', { amount: '1', children: [{ amount: '1' }] }),
          ]
        : [
            accepted(
              'encoding preserves recursive policy',
              { amount: '1', child: { amount: '1' } },
              '{"amount":1,"child":{"amount":1}}',
            ),
          ]),
    ]);
    if (validation === 'schema') {
      const sdk = await import(pathToFileURL(join(i.output, 'node/index.js')).href);
      assert.throws(
        () => sdk.makeBranch({ amount: '1', child: { amount: '1' } }),
        (e) => e.kind === 'validation',
      );
      const php = spawnSync(
        'php',
        [
          '-r',
          String.raw`
        require $argv[1].'/src/Runtime.php';require $argv[1].'/src/Client.php';
        try { new SiblingsSdk\BranchInput(['amount'=>'1','child'=>['amount'=>'1']]);exit(2); }
        catch(SiblingsSdk\SdkError $e){if($e->kind!=='validation')throw $e;}
      `,
          join(i.output, 'php'),
        ],
        { encoding: 'utf8' },
      );
      assert.equal(php.status, 0, php.stdout + php.stderr);
    }
  }
});

test('wrapped untagged guards enforce numeric siblings on decoded response values', async () => {
  const choice = {
    oneOf: [
      {
        type: 'object',
        required: ['kind', 'amount'],
        properties: {
          kind: { type: 'string', enum: ['paid'] },
          amount: { type: 'integer', format: 'int64' },
        },
      },
      {
        type: 'object',
        required: ['kind', 'amount'],
        properties: { kind: { type: 'string', enum: ['text'] }, amount: { type: 'string' } },
      },
    ],
  };
  for (const validation of ['schema', 'encoding']) {
    const doc = document(ref('Choice', { properties: { amount: { minimum: 5, maximum: 10 } } }), {
      Choice: choice,
    });
    delete doc.paths['/values'].post.requestBody;
    const i = inputs(doc, { ...config, validation });
    generate(i.load(), i.output);
    const sdk = await import(pathToFileURL(join(i.output, 'node/index.js')).href);
    const known = sdk.isApiSendValueResponseKnown;
    for (const [wire, expected] of [
      ['{"kind":"paid","amount":1}', false],
      ['{"kind":"paid","amount":5}', true],
      ['{"kind":"paid","amount":11}', false],
      ['{"kind":"text","amount":"1"}', true],
      ['{"kind":"paid","amount":5,"future":true}', true],
      ['{"kind":"future","amount":5}', false],
    ]) {
      const client = new sdk.Client({
        baseUrl: 'https://example.invalid',
        transport: async () => new Response(wire),
      });
      const { data } = await client.api.sendValue({});
      assert.equal(known(data), expected, wire);
    }
  }
});

test('recursive untagged alternatives retain sibling numeric meaning through nested values', async () => {
  const amount = { type: 'integer', format: 'int64' };
  const choice = {
    oneOf: [
      {
        type: 'object',
        required: ['kind', 'amount'],
        properties: { kind: { type: 'string', enum: ['leaf'] }, amount },
      },
      {
        type: 'object',
        required: ['kind', 'amount', 'child'],
        properties: {
          kind: { type: 'string', enum: ['node'] },
          amount,
          child: ref('TreeChoice', { properties: { amount: { minimum: 5 } } }),
        },
      },
    ],
  };
  let valid = { kind: 'leaf', amount: '5' };
  let invalid = { kind: 'leaf', amount: '1' };
  for (let depth = 0; depth < 8; depth++) {
    valid = { kind: 'node', amount: '5', child: valid };
    invalid = { kind: 'node', amount: '5', child: invalid };
  }
  const i = inputs(document(ref('TreeChoice'), { TreeChoice: choice }));
  await fixtures(i, [
    accepted(
      'nested numeric alternatives',
      valid,
      JSON.stringify(valid, (key, value) => (key === 'amount' ? Number(value) : value)),
    ),
    rejected('deep alternative sibling minimum', invalid),
  ]);
});

test('optional undefined union fields are omitted before selection in generated Node requests', async () => {
  for (const keyword of ['oneOf', 'anyOf']) {
    for (const validation of ['schema', 'encoding']) {
      const choice = { [keyword]: [{ type: 'string' }, { type: 'boolean' }] };
      const shape = {
        type: 'object',
        required: ['requiredChoice'],
        properties: { requiredChoice: choice, optionalChoice: choice },
      };
      const i = inputs(document(shape), {
        ...config,
        validation,
        operations: { sendValue: { example: { body: { requiredChoice: true } } } },
      });
      generate(i.load(), i.output);
      const sdk = await import(pathToFileURL(join(i.output, 'node/index.js')).href);
      const wires = [];
      const client = new sdk.Client({
        baseUrl: 'https://example.invalid',
        transport: async (url, request) => {
          wires.push(request.body);
          return new Response('{"requiredChoice":true}');
        },
      });
      for (const body of [
        { requiredChoice: true },
        { requiredChoice: true, optionalChoice: undefined },
        { requiredChoice: true, optionalChoice: false },
      ]) {
        await client.api.sendValue({ body });
        assert.equal(wires.at(-1), JSON.stringify(body));
        assert.equal(serialize(body, shape), JSON.stringify(body));
      }
      const sent = wires.length;
      for (const body of [
        { requiredChoice: undefined },
        { requiredChoice: true, optionalChoice: null },
        { requiredChoice: true, optionalChoice: 5 },
      ])
        await assert.rejects(client.api.sendValue({ body }), { kind: 'validation' });
      assert.equal(wires.length, sent);
    }
  }
});

test('numeric unions share their representation regardless of conjunct order in both clients', async () => {
  for (const keyword of ['oneOf', 'anyOf']) {
    for (const validation of ['schema', 'encoding']) {
      const numeric = {
        [keyword]: ['a', 'b'].map((kind) => ({
          type: 'object',
          required: ['kind', 'amount'],
          properties: {
            kind: { type: 'string', enum: [kind] },
            amount: { type: 'number' },
          },
        })),
      };
      const enumerated = {
        [keyword]: [5, 6].map((amount) => ({ properties: { amount: { enum: [amount] } } })),
      };
      for (const allOf of [
        [numeric, enumerated],
        [enumerated, numeric],
      ]) {
        const shape = { allOf };
        const i = inputs(document(shape), {
          ...config,
          validation,
          operations: { sendValue: { example: { body: { kind: 'a', amount: 5 } } } },
        });
        await fixtures(i, [
          accepted('exact enum value', { kind: 'a', amount: '5' }, '{"kind":"a","amount":5}'),
          accepted(
            'equivalent enum spelling',
            { kind: 'b', amount: '6e0' },
            '{"kind":"b","amount":6e0}',
          ),
          accepted(
            'safe numeric caller value',
            { kind: 'a', amount: 5 },
            '{"kind":"a","amount":5}',
            { kind: 'a', amount: '5' },
          ),
          rejected('outside both enum alternatives', { kind: 'a', amount: '7' }),
          rejected('undeclared numeric alternative', { kind: 'future', amount: '5' }),
          rejected('missing numeric field', { kind: 'a' }),
        ]);
        assert.equal(serialize({ kind: 'a', amount: '5' }, shape), '{"kind":"a","amount":5}');
      }
    }
  }
});

test('numeric enum siblings retain usable branch-specific TypeScript inputs', async () => {
  for (const keyword of ['oneOf', 'anyOf']) {
    const choice = {
      [keyword]: [
        {
          type: 'object',
          required: ['kind', 'amount'],
          properties: { kind: { type: 'string', enum: ['paid'] }, amount: { type: 'number' } },
        },
        {
          type: 'object',
          required: ['kind', 'amount'],
          properties: { kind: { type: 'string', enum: ['text'] }, amount: { type: 'string' } },
        },
      ],
    };
    for (const form of ['ref', 'inline', 'nested']) {
      const siblings = { type: 'object', properties: { amount: { enum: [5] } } };
      const value = { kind: 'paid', amount: '5' };
      const body = form === 'nested' ? { values: [value], map: { first: value } } : value;
      const schema =
        form === 'ref'
          ? ref('Choice', siblings)
          : form === 'inline'
            ? { ...siblings, allOf: [choice] }
            : {
                type: 'object',
                required: ['values', 'map'],
                allOf: [
                  {
                    properties: {
                      values: { type: 'array', items: choice },
                      map: { type: 'object', additionalProperties: choice },
                    },
                  },
                  {
                    properties: {
                      values: { items: siblings },
                      map: { additionalProperties: siblings },
                    },
                  },
                ],
              };
      const i = inputs(document(schema, { Choice: choice }), {
        ...config,
        operations: { sendValue: { example: { body } } },
      });
      const c = i.load();
      const before = structuredClone(c);
      generate(c, i.output);
      assert.deepEqual(c, before, 'declaration projection must not mutate the source contract');
      const sdk = await import(pathToFileURL(join(i.output, 'node/index.js')).href);
      let sent = 0;
      const client = new sdk.Client({
        baseUrl: 'https://example.invalid',
        transport: async (url, request) => {
          sent++;
          const wire = JSON.parse(request.body);
          assert.equal(form === 'nested' ? wire.values[0].amount : wire.amount, 5);
          return new Response(request.body);
        },
      });
      await client.api.sendValue({ body });
      const input = (kind, amount) =>
        form === 'nested'
          ? `{values:[{kind:${JSON.stringify(kind)},amount:${amount}}],map:{first:{kind:'paid',amount:'5'}}}`
          : `{kind:${JSON.stringify(kind)},amount:${amount}}`;
      const file = join(i.output, 'node/consumer.ts');
      writeFileSync(
        file,
        `import {Client} from './index.js';
const client = new Client({baseUrl:'https://example.invalid'});
client.api.sendValue({body:${input('paid', "'5'")}});
client.api.sendValue({body:${input('paid', "'5e0'")}});
// @ts-expect-error exact numbers retain their SDK string representation
client.api.sendValue({body:${input('paid', '5')}});
// @ts-expect-error a numeric enum cannot admit the JSON string branch
client.api.sendValue({body:${input('text', "'5'")}});
`,
      );
      const result = spawnSync(
        process.execPath,
        [
          'node_modules/typescript/bin/tsc',
          '--noEmit',
          '--strict',
          '--skipLibCheck',
          '--target',
          'ES2022',
          '--module',
          'NodeNext',
          '--moduleResolution',
          'NodeNext',
          file,
        ],
        { encoding: 'utf8' },
      );
      assert.equal(result.status, 0, result.stdout + result.stderr);
      for (const invalid of [
        { kind: 'paid', amount: '6' },
        { kind: 'text', amount: '5' },
      ])
        await assert.rejects(
          client.api.sendValue({
            body: form === 'nested' ? { values: [invalid], map: { first: value } } : invalid,
          }),
          { kind: 'validation' },
        );
      assert.equal(sent, 1);
    }
  }
});

test('anyOf interpretation revisits earlier matches when another conjunct enables numeric branches', async () => {
  const dependent = {
    anyOf: [{}, { type: 'object', properties: { a: { type: 'number' }, b: { enum: [5] } } }],
  };
  const source = { anyOf: [{ type: 'object', properties: { b: { type: 'number' } } }] };
  for (const validation of ['schema', 'encoding']) {
    for (const allOf of [
      [dependent, source],
      [source, dependent],
    ]) {
      const schema = {
        type: 'object',
        required: ['a', 'b'],
        properties: { a: { enum: [5] } },
        allOf,
      };
      const i = inputs(document(schema), {
        ...config,
        validation,
        operations: { sendValue: { example: { body: { a: 5, b: 5 } } } },
      });
      await fixtures(i, [
        accepted(
          'later numeric context enables earlier branch',
          { a: '5', b: '5' },
          '{"a":5,"b":5}',
        ),
        rejected('numeric sibling enum still rejects', { a: '6', b: '5' }),
        rejected('unmatched numeric branch cannot coerce a string', { a: '5', b: '6' }),
      ]);
      assert.equal(serialize({ a: '5', b: '5' }, schema), '{"a":5,"b":5}');
    }
  }
});

test('numeric anyOf merges equivalent exact tokens in both clients without weakening oneOf', async () => {
  const branches = [{ type: 'number' }, { type: 'integer', format: 'int64' }];
  for (const validation of ['schema', 'encoding']) {
    for (const alternatives of [branches, [...branches].reverse()]) {
      const choice = { anyOf: alternatives };
      for (const nested of [false, true]) {
        const schema = nested
          ? {
              anyOf: alternatives.map((amount) => ({
                type: 'object',
                properties: { amounts: { type: 'array', items: amount } },
              })),
            }
          : choice;
        const wrap = (value) => (nested ? { amounts: [value] } : value);
        const i = inputs(document(schema), {
          ...config,
          validation,
          operations: { sendValue: { example: { body: wrap('1') } } },
        });
        const cases = ['1', '1.0', '1e0', '-0.0', '9007199254740993.0', '1.5'].map((token) => {
          const wire = nested ? `{"amounts":[${token}]}` : token;
          return {
            ...accepted(token, wrap(token), wire, wrap(token)),
            responses: [{ status: 200, body: wire }],
          };
        });
        cases.push(
          rejected('invalid numeric token', wrap('1x')),
          rejected('wrong JSON kind', wrap(true)),
        );
        await fixtures(i, cases);
        assert.equal(serialize(wrap('1e0'), schema), nested ? '{"amounts":[1e0]}' : '1e0');
      }
    }
    const exclusive = inputs(document({ oneOf: branches }), {
      ...config,
      validation,
      operations: { sendValue: { example: { body: '1.5' } } },
    });
    await fixtures(exclusive, [
      accepted('only decimal branch', '1.5', '1.5'),
      rejected('both branches match', '1.0'),
      rejected('both exponent branches match', '1e0'),
    ]);
    const integers = inputs(document({ anyOf: [branches[1], branches[1]] }), {
      ...config,
      validation,
      operations: { sendValue: { example: { body: '1' } } },
    });
    await fixtures(integers, [
      {
        ...accepted('matching integer decoders retain canonical output', '1', '1', '1'),
        responses: [{ status: 200, body: '1e0' }],
      },
    ]);
    const text = {
      oneOf: [
        {
          type: 'object',
          required: ['kind', 'value'],
          properties: { kind: { type: 'string', enum: ['number'] }, value: { type: 'number' } },
        },
        {
          type: 'object',
          required: ['kind', 'value'],
          properties: { kind: { type: 'string', enum: ['text'] }, value: { type: 'string' } },
        },
      ],
    };
    await fixtures(inputs(document(text), { ...config, validation }), [
      accepted('JSON string retains quotes', { kind: 'text', value: '1e0' }),
      accepted(
        'JSON number remains numeric',
        { kind: 'number', value: '1e0' },
        '{"kind":"number","value":1e0}',
      ),
    ]);
  }
});

test('pagination and polling combine nested object-level sibling fields without accepting untyped alternatives', async () => {
  const page = {
    type: 'object',
    required: ['data'],
    properties: {
      data: {
        type: 'object',
        required: ['items', 'next', 'state'],
        properties: {
          items: ref('StringItems', { type: 'array' }),
          next: { type: ['string', 'null'] },
          state: { type: 'string' },
        },
      },
    },
  };
  const siblings = {
    properties: {
      data: {
        properties: {
          items: { maxItems: 2 },
          state: { enum: ['pending', 'ready'] },
        },
      },
    },
  };
  const make = (schema) => ({
    ...document(
      {},
      { Page: page, StringItems: { type: ['array', 'null'], items: { type: 'string' } } },
    ),
    paths: {
      '/values': {
        get: {
          operationId: 'readValue',
          parameters: [{ name: 'cursor', in: 'query', schema: { type: 'string' } }],
          responses: { 200: { description: 'Page', content: content(schema) } },
        },
      },
    },
  });
  const profile = {
    ...config,
    operations: {
      readValue: {
        pagination: { kind: 'cursor', items: 'data.items', next: 'data.next', parameter: 'cursor' },
        polling: { state: 'data.state', success: ['ready'], failure: [], intervalMs: 1 },
      },
    },
  };
  const i = inputs(make(ref('Page', siblings)), profile);
  generate(i.load(), i.output);
  const sdk = await import(pathToFileURL(join(i.output, 'node/index.js')).href);
  let calls = 0;
  const urls = [];
  const client = new sdk.Client({
    baseUrl: 'https://example.invalid',
    transport: async (url) => {
      urls.push(String(url));
      return new Response(
        JSON.stringify({
          data: {
            items: [++calls === 1 ? 'a' : 'b'],
            next: calls === 1 ? 'next' : null,
            state: calls === 1 ? 'pending' : 'ready',
          },
        }),
      );
    },
  });
  const items = [];
  for await (const item of client.api.readValueItems({})) items.push(item);
  assert.deepEqual(items, ['a', 'b']);
  assert.equal(urls[1], 'https://example.invalid/values?cursor=next');
  calls = 0;
  assert.equal((await client.api.readValueWait({})).data.data.state, 'ready');
  assert.equal(calls, 2);
  const php = spawnSync(
    'php',
    [
      '-r',
      String.raw`
require $argv[1].'/src/Runtime.php';require $argv[1].'/src/Client.php';
$calls=0;$urls=[];
$c=new SiblingsSdk\Client(new SiblingsSdk\ClientOptions('https://example.invalid',transport:function($r)use(&$calls,&$urls){$urls[]=$r['url'];$calls++;return ['status'=>200,'headers'=>[],'body'=>json_encode(['data'=>['items'=>[$calls===1?'a':'b'],'next'=>$calls===1?'next':null,'state'=>$calls===1?'pending':'ready']])];}));
$items=iterator_to_array($c->api->readValueItems(new SiblingsSdk\ApiReadValueInput()),false);
if($items!==['a','b']||$urls[1]!=='https://example.invalid/values?cursor=next')exit(2);
$calls=0;$result=$c->api->readValueWait(new SiblingsSdk\ApiReadValueInput());
if($result->data->data->state!=='ready'||$calls!==2)exit(3);
`,
      join(i.output, 'php'),
    ],
    { encoding: 'utf8' },
  );
  assert.equal(php.status, 0, php.stdout + php.stderr);
  const consumer = join(i.output, 'node/items.ts');
  writeFileSync(
    consumer,
    `import {Client} from './index.js';
const client=new Client({baseUrl:'https://example.invalid'});
for await(const item of client.api.readValueItems({})){const value:string=item;}
`,
  );
  const types = spawnSync(
    process.execPath,
    [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '--strict',
      '--skipLibCheck',
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      consumer,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(types.status, 0, types.stdout + types.stderr);
  for (const keyword of ['oneOf', 'anyOf']) {
    assert.throws(
      inputs(make({ [keyword]: [page, { type: 'object' }] }), profile).load,
      /pagination items\/next/,
    );
    const wrong = structuredClone(page);
    wrong.properties.data.properties.state = { type: 'integer' };
    assert.throws(inputs(make({ [keyword]: [page, wrong] }), profile).load, /polling state/);
    assert.doesNotThrow(inputs(make({ ...page, [keyword]: [siblings, {}] }), profile).load);
  }
});

test('array type narrowing uses referenced items and retains generated element types', async () => {
  const values = { type: ['array', 'null'], items: { type: 'string', minLength: 2 } };
  const shape = ref('ValuesArray', { type: 'array' });
  const i = inputs(document(shape, { ValuesArray: values }));
  await fixtures(i, [
    accepted('inherited array items', ['ab', 'cd']),
    rejected('narrowed array excludes null', null),
    rejected('inherited item type', [5]),
    rejected('inherited item constraint', ['a']),
  ]);
  const file = join(i.output, 'node/consumer.ts');
  writeFileSync(
    file,
    `import {Client} from './index.js';
const c=new Client({baseUrl:'https://example.invalid'});
c.api.sendValue({body:['ab']}).then(({data})=>{const value:string=data[0]!;});
// @ts-expect-error referenced item type is retained
c.api.sendValue({body:[5]});
// @ts-expect-error narrowing removes null
c.api.sendValue({body:null});
`,
  );
  const types = spawnSync(
    process.execPath,
    [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '--strict',
      '--skipLibCheck',
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      file,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(types.status, 0, types.stdout + types.stderr);
  assert.throws(inputs(document({ type: 'array' })).load, /arrays require items/);
  assert.throws(
    inputs(document({ type: 'array', anyOf: [{ items: { type: 'string' } }, {}] })).load,
    /arrays require items/,
  );
});

test('mutually dependent numeric unions share declarations before validating their candidates', async () => {
  const text = {
    type: 'object',
    required: ['kind', 'a', 'b'],
    properties: {
      kind: { type: 'string', enum: ['text'] },
      a: { type: 'string' },
      b: { type: 'string' },
    },
  };
  const numeric = (a, b) => ({
    type: 'object',
    required: ['kind', 'a', 'b'],
    properties: { kind: { type: 'string', enum: ['number'] }, a, b },
  });
  const exact = { kind: 'number', a: '5', b: '5' };
  const wire = '{"kind":"number","a":5,"b":5}';
  for (const keyword of ['oneOf', 'anyOf']) {
    const left = { [keyword]: [numeric({ type: 'number' }, { enum: [5] }), text] };
    const right = { [keyword]: [numeric({ enum: [5] }, { type: 'number' }), text] };
    for (const validation of ['schema', 'encoding']) {
      for (const [referenced, sibling] of [
        [left, right],
        [right, left],
      ]) {
        const i = inputs(document(ref('Choice', sibling), { Choice: referenced }), {
          ...config,
          validation,
          operations: { sendValue: { example: { body: { kind: 'number', a: 5, b: 5 } } } },
        });
        const numericCase = (name, body, json = wire, data = exact) => ({
          ...accepted(name, body, json, data),
          responses: [{ status: 200, body: json }],
        });
        await fixtures(i, [
          numericCase('mutually dependent exact strings', exact),
          numericCase('safe numeric caller values', { kind: 'number', a: 5, b: 5 }),
          numericCase(
            'equivalent exact spellings',
            { kind: 'number', a: '5e0', b: '5.0' },
            '{"kind":"number","a":5e0,"b":5.0}',
            { kind: 'number', a: '5e0', b: '5.0' },
          ),
          accepted('string alternative preserves strings', { kind: 'text', a: '5', b: '5' }),
          rejected('numeric enum remains enforced', { kind: 'number', a: '5', b: '6' }),
          rejected('unmatched branches cannot supply numeric meaning', {
            kind: 'future',
            a: '5',
            b: '5',
          }),
          rejected('missing cross-constrained field', { kind: 'number', a: '5' }),
        ]);
        const inline = { allOf: [referenced, sibling] };
        assert.equal(serialize(exact, inline), wire);
        const sdk = await import(pathToFileURL(join(i.output, 'node/index.js')).href);
        if (keyword === 'oneOf') {
          const client = new sdk.Client({
            baseUrl: 'https://example.invalid',
            transport: async () => new Response(wire),
          });
          const { data } = await client.api.sendValue({ body: exact });
          assert.equal(sdk.isApiSendValueResponseKnown(data), true);
          assert.equal(sdk.isApiSendValueResponseKnown({ ...data, b: '6' }), false);
          const exclusive = {
            allOf: [referenced, { oneOf: [...sibling.oneOf, sibling.oneOf[0]] }],
          };
          assert.throws(() => serialize(exact, exclusive), /exactly one alternative/);
        }
      }
    }
  }
});

test('pagination item declarations intersect sibling constraints while retaining alternatives', async () => {
  const names = { type: 'array', items: { type: 'string' } };
  const itemVariants = [
    ref('Names'),
    ref('Names', { items: { minLength: 0 } }),
    ref('Names', { items: { minLength: 2 } }),
    { type: 'array', items: { type: 'string', minLength: 2 } },
  ];
  const doc = document({}, { Names: names });
  doc.paths = Object.fromEntries(
    itemVariants.map((items, n) => [
      `/values${n}`,
      {
        get: {
          operationId: 'listValues' + n,
          parameters: [{ name: 'cursor', in: 'query', schema: { type: 'string' } }],
          responses: {
            200: {
              description: 'Page',
              content: content({
                type: 'object',
                required: ['items', 'next'],
                properties: { items, next: { type: ['string', 'null'] } },
              }),
            },
          },
        },
      },
    ]),
  );
  // An intersection combines both object fields, whereas response alternatives
  // still produce a union of string and boolean elements.
  doc.paths['/objects'] = {
    get: {
      operationId: 'listObjects',
      parameters: [{ name: 'cursor', in: 'query', schema: { type: 'string' } }],
      responses: {
        200: {
          description: 'Page',
          content: content({
            type: 'object',
            properties: {
              items: {
                type: 'array',
                items: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
                allOf: [
                  {
                    items: {
                      type: 'object',
                      required: ['name'],
                      properties: { name: { type: 'string' } },
                    },
                  },
                ],
              },
              next: { type: ['string', 'null'] },
            },
          }),
        },
      },
    },
  };
  doc.paths['/choices'] = {
    get: {
      operationId: 'listChoices',
      parameters: [{ name: 'cursor', in: 'query', schema: { type: 'string' } }],
      responses: {
        200: {
          description: 'Page',
          content: content({
            oneOf: ['string', 'boolean'].map((type) => ({
              type: 'object',
              required: ['items', 'next'],
              properties: {
                items: { type: 'array', items: { type }, allOf: [{ items: { minLength: 0 } }] },
                next: { type: ['string', 'null'] },
              },
            })),
          }),
        },
      },
    },
  };
  const i = inputs(doc, {
    ...config,
    operations: Object.fromEntries(
      Object.values(doc.paths).map(({ get }) => [
        get.operationId,
        {
          pagination: { kind: 'cursor', items: 'items', next: 'next', parameter: 'cursor' },
        },
      ]),
    ),
  });
  generate(i.load(), i.output);
  const file = join(i.output, 'node/consumer.ts');
  writeFileSync(
    file,
    `import {Client} from './index.js';
const c = new Client({baseUrl:'https://example.invalid'});
${itemVariants.map((_, n) => `for await(const item of c.api.listValues${n}Items({})){const value:string=item;}`).join('\n')}
for await(const item of c.api.listObjectsItems({})){const id:string=item.id;const name:string=item.name;}
for await(const item of c.api.listChoicesItems({})){const value:string|boolean=item;
// @ts-expect-error Boolean alternatives must not be lost.
const invalid:string=item;}
`,
  );
  const types = spawnSync(
    process.execPath,
    [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '--strict',
      '--skipLibCheck',
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      file,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(types.status, 0, types.stdout + types.stderr);
  const { Client } = await import(pathToFileURL(join(i.output, 'node/index.js')).href);
  const client = new Client({
    baseUrl: 'https://example.invalid',
    transport: async () => new Response('{"items":["ab"],"next":null}'),
  });
  for (let n = 0; n < itemVariants.length; n++) {
    const items = [];
    for await (const item of client.api['listValues' + n + 'Items']({})) items.push(item);
    assert.deepEqual(items, ['ab']);
  }
});

test('joint anyOf interpretation can use multiple validated branches from each union', async () => {
  const shape = (properties) => ({ type: 'object', properties });
  const schema = {
    type: 'object',
    required: ['a', 'b', 'c', 'd'],
    allOf: [
      {
        anyOf: [
          shape({ a: { type: 'number' }, b: { enum: [5] } }),
          shape({ c: { type: 'number' }, d: { enum: [5] } }),
        ],
      },
      {
        anyOf: [
          shape({ b: { type: 'number' }, c: { enum: [5] } }),
          shape({ d: { type: 'number' }, a: { enum: [5] } }),
        ],
      },
    ],
  };
  const exact = { a: '5', b: '5', c: '5', d: '5' };
  const wire = '{"a":5,"b":5,"c":5,"d":5}';
  const i = inputs(document(schema), {
    ...config,
    operations: { sendValue: { example: { body: { a: 5, b: 5, c: 5, d: 5 } } } },
  });
  await fixtures(i, [
    {
      ...accepted('all contributing branches share numeric context', exact, wire),
      responses: [{ status: 200, body: wire }],
    },
    rejected('unmatched branch cannot supply a missing numeric declaration', { ...exact, d: '6' }),
    rejected('invalid numeric token', { ...exact, a: 'invalid' }),
  ]);
  assert.equal(serialize(exact, schema), wire);
});

test('joint numeric search keeps recursive definitions and independent collection elements', async () => {
  const branch = (a, b) => ({ type: 'object', required: ['a', 'b'], properties: { a, b } });
  const choice = {
    type: 'object',
    properties: { child: ref('Entry') },
    allOf: [
      { oneOf: [branch({ type: 'number' }, { enum: [5] })] },
      { oneOf: [branch({ enum: [5] }, { type: 'number' })] },
    ],
  };
  const i = inputs(document({ type: 'array', items: ref('Entry') }, { Entry: choice }), {
    ...config,
    operations: { sendValue: { example: { body: [{ a: 5, b: 5 }] } } },
  });
  const body = Array.from({ length: 300 }, () => ({ a: '5', b: '5' }));
  body[0].child = { a: '5', b: '5', child: { a: '5', b: '5' } };
  const wire = JSON.stringify(body, (key, value) => (key === 'a' || key === 'b' ? 5 : value));
  const invalid = structuredClone(body);
  invalid[0].child.child.b = '6';
  await fixtures(i, [
    {
      ...accepted('each element has its own joint search limit', body, wire),
      responses: [{ status: 200, body: wire }],
    },
    rejected('recursive sibling enum remains enforced', invalid),
  ]);
});

test('joint numeric search fails closed at its combination limit in both runtimes', async () => {
  const branch = (a, b) => ({ type: 'object', required: ['a', 'b'], properties: { a, b } });
  const values = Array.from({ length: 17 }, (_, n) => n + 5);
  const schema = {
    allOf: [
      { oneOf: values.map((v) => branch({ type: 'number' }, { enum: [v] })) },
      { oneOf: values.map((v) => branch({ enum: [v] }, { type: 'number' })) },
    ],
  };
  const i = inputs(document(schema), {
    ...config,
    operations: { sendValue: { example: { body: { a: 5, b: 5 } } } },
  });
  const wire = '{"a":5,"b":5}';
  await fixtures(i, [
    {
      ...accepted('a matching joint candidate still works', { a: '5', b: '5' }, wire),
      responses: [{ status: 200, body: wire }],
    },
    rejected('exhausted search never dispatches', { a: '99', b: '99' }),
  ]);
  assert.throws(() => serialize({ a: '99', b: '99' }, schema), /256 alternative combinations/);
  const php = spawnSync(
    'php',
    [
      '-r',
      String.raw`
require $argv[1].'/src/Runtime.php';require $argv[1].'/src/Client.php';
try{new SiblingsSdk\ApiSendValueInput(['body'=>['a'=>'99','b'=>'99']]);exit(2);}
catch(SiblingsSdk\SdkError $e){if($e->kind!=='validation'||!str_contains($e->getMessage(),'256 alternative combinations'))throw $e;}
`,
      join(i.output, 'php'),
    ],
    { encoding: 'utf8', timeout: 10000 },
  );
  assert.equal(php.status, 0, php.stdout + php.stderr);
});

test('joint selection preserves tagged sibling validation policies', async () => {
  const branch = (a, b) => ({ type: 'object', required: ['a', 'b'], properties: { a, b } });
  const schema = {
    allOf: [
      { oneOf: [branch({ type: 'number' }, { enum: [5] })] },
      { oneOf: [branch({ enum: [5] }, { type: 'number' })] },
      {
        discriminator: { propertyName: 'tag' },
        oneOf: [
          {
            type: 'object',
            required: ['tag', 'note'],
            properties: {
              tag: { type: 'string', enum: ['known'] },
              note: { type: 'string', minLength: 3 },
            },
          },
        ],
      },
    ],
  };
  const body = { a: '5', b: '5', tag: 'known', note: 'x' };
  const wire = '{"a":5,"b":5,"tag":"known","note":"x"}';
  for (const validation of ['encoding', 'schema']) {
    const i = inputs(document(schema), {
      ...config,
      validation,
      operations: { sendValue: { example: { body: { a: 5, b: 5, tag: 'known', note: 'valid' } } } },
    });
    await fixtures(i, [
      validation === 'encoding'
        ? {
            ...accepted('tagged bounds retain encoding policy', body, wire),
            responses: [{ status: 200, body: wire }],
          }
        : rejected('tagged bounds retain schema policy', body),
    ]);
  }
});

test('recursive numeric enum siblings retain exact TypeScript inputs at reference edges', async () => {
  for (const scalar of [
    { type: 'number' },
    { type: 'integer', format: 'int64' },
    { type: 'integer' },
  ]) {
    const exact = scalar.type === 'number' || scalar.format === 'int64';
    const tree = { anyOf: [scalar, { type: 'array', items: ref('Tree', { enum: [5] }) }] };
    const i = inputs(document(ref('Tree'), { Tree: tree }));
    const source = i.load();
    const before = structuredClone(source);
    generate(source, i.output);
    assert.deepEqual(source, before);
    const file = join(i.output, 'node/consumer.ts');
    writeFileSync(
      file,
      `import {Client, makeTree, type TreeInput} from './index.js';
const c = new Client({baseUrl:'https://example.invalid'});
const body:TreeInput = [${exact ? "'5'" : '5'}];
c.api.sendValue({body});
c.api.sendValue({body:makeTree(body)});
${scalar.type === 'number' ? "c.api.sendValue({body:['5e0']});" : ''}
// @ts-expect-error numeric SDK representation must survive a recursive enum edge
c.api.sendValue({body:[${exact ? '5' : "'5'"}]});
// @ts-expect-error enum scalar intersection excludes nested arrays
c.api.sendValue({body:[[${exact ? "'5'" : '5'}]]});
`,
    );
    const types = spawnSync(
      process.execPath,
      [
        'node_modules/typescript/bin/tsc',
        '--noEmit',
        '--strict',
        '--skipLibCheck',
        '--target',
        'ES2022',
        '--module',
        'NodeNext',
        file,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(types.status, 0, types.stdout + types.stderr);
    await fixtures(i, [
      {
        ...accepted('recursive numeric enum', [exact ? '5' : 5], '[5]'),
        responses: [{ status: 200, body: '[5]' }],
      },
      rejected('recursive enum membership remains enforced', [exact ? '6' : 6]),
      rejected('recursive enum excludes collection values', [[exact ? '5' : 5]]),
    ]);
  }
});

test('numeric interpretations from invalidated alternatives fail before dispatch', async () => {
  const numeric = {
    type: 'object',
    properties: { x: { type: 'number' } },
    not: { required: ['y'], properties: { y: { enum: [1] } } },
  };
  const cases = [];
  for (const validation of ['schema', 'encoding']) {
    // Unknown fields and constraint-only fields must not retain a numeric
    // declaration contributed by an alternative that no longer matches.
    for (const field of [undefined, {}, { not: { type: 'object' } }]) {
      const other = {
        type: 'object',
        properties: { y: { type: 'number' }, ...(field ? { x: field } : {}) },
      };
      for (const anyOf of [
        [numeric, other],
        [other, numeric],
      ]) {
        const choice = { anyOf };
        const bad = { x: '2', y: '1' },
          good = { x: '2', y: '3' };
        const schema = {
          type: 'object',
          properties: {
            direct: choice,
            list: { type: 'array', items: choice },
            dictionary: { type: 'object', additionalProperties: choice },
          },
        };
        const i = inputs(document(schema), { ...config, validation });
        await fixtures(i, [
          rejected('invalidated direct contribution', { direct: bad }),
          rejected('invalidated array contribution', { list: [bad] }),
          rejected('invalidated dictionary contribution', { dictionary: { entry: bad } }),
          accepted(
            'stable matching contributions',
            { direct: good, list: [good] },
            '{"direct":{"x":2,"y":3},"list":[{"x":2,"y":3}]}',
          ),
          {
            ...accepted('wire numbers need no SDK string interpretation', {}, '{}', {
              direct: { x: 2, y: '1' },
            }),
            responses: [{ status: 200, body: '{"direct":{"x":2,"y":1}}' }],
          },
        ]);
        assert.throws(() => serialize(bad, choice), /unmatched alternative/);
        assert.equal(serialize(good, choice), '{"x":2,"y":3}');
        cases.push(choice);
      }
    }
  }
  const php = spawnSync(
    'php',
    [
      '-r',
      String.raw`
require 'templates/Runtime.php';
foreach(json_decode(stream_get_contents(STDIN),true) as $schema){
  try { \SdkNamespace\Codec::normalize((object)['x'=>'2','y'=>'1'],$schema); throw new Exception('accepted invalidated contribution'); }
  catch(\SdkNamespace\SdkError $e){ if($e->kind!=='validation'||!str_contains($e->getMessage(),'unmatched alternative'))throw $e; }
  if(\SdkNamespace\Codec::encode(\SdkNamespace\Codec::normalize((object)['x'=>'2','y'=>'3'],$schema))!=='{"x":2,"y":3}')throw new Exception('wrong control wire');
}
`,
    ],
    { input: JSON.stringify(cases), encoding: 'utf8' },
  );
  assert.equal(php.status, 0, php.stdout + php.stderr);
});

test('numeric contribution checks follow final selections across parent and child unions', async () => {
  const child = {
    anyOf: [
      {
        type: 'object',
        properties: { x: { type: 'number' } },
        not: { properties: { y: { enum: [1] } }, required: ['y'] },
      },
      {},
    ],
  };
  const schema = {
    type: 'object',
    properties: { detail: child },
    anyOf: [
      {
        type: 'object',
        properties: { detail: { type: 'object', properties: { y: { type: 'number' } } } },
      },
    ],
  };
  await fixtures(inputs(document(schema)), [
    rejected('parent invalidates a nested numeric contributor', { detail: { x: '2', y: '1' } }),
    accepted(
      'nested contributor remains valid',
      { detail: { x: '2', y: '3' } },
      '{"detail":{"x":2,"y":3}}',
    ),
  ]);
});

test('mixed numeric intersections behind unions fail diagnosis while aligned and disjoint choices remain supported', async () => {
  for (const keyword of ['anyOf', 'oneOf']) {
    const left = { [keyword]: [{ type: 'number' }, { type: 'boolean' }] };
    const right = { [keyword]: [{ type: 'integer' }, { type: 'null' }] };
    for (const allOf of [
      [left, right],
      [right, left],
    ]) {
      const conflict = { allOf };
      for (const schema of [
        conflict,
        { type: 'object', properties: { amount: conflict } },
        { type: 'array', items: conflict },
        { type: 'object', additionalProperties: conflict },
        { allOf: allOf.map((amount) => ({ type: 'object', properties: { amount } })) },
        { allOf: allOf.map((items) => ({ type: 'array', items })) },
        { allOf: allOf.map((additionalProperties) => ({ type: 'object', additionalProperties })) },
      ])
        assert.throws(inputs(document(schema)).load, /different SDK representations/);
    }
    const aligned = {
      allOf: [left, { [keyword]: [{ type: 'integer', format: 'int64' }, { type: 'null' }] }],
    };
    const i = inputs(document(aligned));
    await fixtures(i, [
      accepted('aligned numeric input', '1', '1'),
      rejected('incompatible boolean input', true),
    ]);
    writeFileSync(
      join(i.output, 'node/consumer.ts'),
      `import {Client} from './index.js';
new Client({baseUrl:'https://example.invalid'}).api.sendValue({body:'1'});
`,
    );
    const ts = spawnSync(
      process.execPath,
      [
        'node_modules/typescript/bin/tsc',
        '--noEmit',
        '--strict',
        '--skipLibCheck',
        '--target',
        'ES2022',
        '--module',
        'NodeNext',
        join(i.output, 'node/consumer.ts'),
      ],
      { encoding: 'utf8' },
    );
    assert.equal(ts.status, 0, ts.stdout + ts.stderr);
  }
  const tagged = (kind, amount) => ({
    type: 'object',
    required: ['kind', 'amount'],
    properties: { kind: { type: 'string', enum: [kind] }, amount },
  });
  const choices = {
    anyOf: [tagged('exact', { type: 'number' }), tagged('native', { type: 'integer' })],
  };
  await fixtures(inputs(document({ allOf: [choices, choices] })), [
    accepted(
      'disjoint exact branch',
      { kind: 'exact', amount: '1' },
      '{"kind":"exact","amount":1}',
    ),
    accepted('disjoint native branch', { kind: 'native', amount: 1 }),
  ]);
});
