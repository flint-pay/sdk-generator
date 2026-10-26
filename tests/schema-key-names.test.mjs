import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, cpSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  loadContract,
  generate,
  render,
  validateFixtures,
  preview,
  setCompatibilityBaseline,
} from '../dist/index.js';
import { compareSchemas } from '../dist/compatibility.js';
import { compileCodec, assertCodecPlan } from '../dist/codec-plan.js';

const dir = mkdtempSync(join(tmpdir(), 'sdk-schema-keys-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const config = {
  version: '1.0.0',
  validation: 'schema',
  requests: { style: 'object' },
  npm: { name: '@example/schema-keys' },
  composer: { name: 'example/schema-keys', namespace: 'Example\\SchemaKeys' },
};
const schemas = {
  names: {
    type: 'object',
    additionalProperties: { type: 'string' },
    propertyNames: { minLength: 2, maxLength: 3, pattern: '^[a-zé]+$' },
  },
  enums: { type: 'object', propertyNames: { enum: ['alpha', 'beta'] } },
  literal: { type: 'object', propertyNames: { const: 'only' } },
  fields: {
    type: 'object',
    properties: { known: { type: 'string' } },
    propertyNames: { maxLength: 4 },
  },
  variants: {
    type: ['object', 'array', 'string', 'null'],
    minLength: 2,
    properties: { count: { type: 'integer' } },
    additionalProperties: { type: 'string' },
    items: { type: 'integer' },
  },
  exactVariants: { type: ['object', 'integer', 'null'], format: 'int64' },
  intersection: { type: ['array', 'string'], anyOf: [{ type: 'string', minLength: 2 }] },
  nullOnly: { type: ['null'] },
};
function document(shapeMap = schemas, version = '3.1.0') {
  return {
    openapi: version,
    info: { title: 'Schema keys', version: 'v1' },
    paths: Object.fromEntries(
      Object.entries(shapeMap).map(([name, schema]) => [
        '/' + name,
        {
          post: {
            operationId: name,
            requestBody: { required: true, content: { 'application/json': { schema } } },
            responses: { 200: { description: 'ok', content: { 'application/json': { schema } } } },
          },
        },
      ]),
    ),
  };
}
function load(source, name = 'api') {
  const path = join(dir, name + '.json');
  writeFileSync(path, JSON.stringify(source));
  writeFileSync(join(dir, 'sdk.json'), JSON.stringify(config));
  return loadContract(path, join(dir, 'sdk.json'));
}
const output = join(dir, 'output');
before(() => generate(load(document()), output));

const valid = [
  ['names', { ab: 'x', éé: 'unicode' }],
  ['names', {}],
  ['enums', { alpha: 1, beta: false }],
  ['literal', { only: true }],
  ['fields', { okay: 'x' }],
  ['variants', { count: 2, label: 'two' }],
  ['variants', [1, 2]],
  ['variants', 'text'],
  ['variants', null],
  ['exactVariants', null],
  ['intersection', 'text'],
  ['nullOnly', null],
];
const invalid = [
  ['names', { a: 'short' }],
  ['names', { abcd: 'long' }],
  ['names', { AB: 'pattern' }],
  ['names', { é: 'one Unicode code point' }],
  ['enums', { future: 1 }],
  ['literal', { other: true }],
  ['fields', { known: 'too long even though declared' }],
  ['variants', true],
  ['variants', [false]],
  ['variants', { count: 'two' }],
  ['variants', 'x'],
  ['intersection', []],
  ['nullOnly', 'non-null'],
];

test('generated Node/PHP clients enforce key constraints and mixed-type unions on both sides of HTTP', async () => {
  const cases = valid.map(([operation, value], index) => ({
    name: 'valid ' + index,
    operation,
    baseUrl: 'https://example.invalid',
    input: { body: value },
    expected: { method: 'POST', path: '/' + operation, body: JSON.stringify(value) },
    responses: [{ status: 200, body: JSON.stringify(value) }],
    data: value,
  }));
  for (const [index, [operation, value]] of invalid.entries()) {
    cases.push({
      name: 'invalid request ' + index,
      operation,
      baseUrl: 'https://example.invalid',
      input: { body: value },
      responses: [],
      attempts: 0,
      error: { kind: 'validation' },
    });
    const control = valid.find(([name]) => name === operation)[1];
    // Existing anyOf response unions retain future variants. propertyNames is a strict
    // object-shape constraint, including enum/const and named properties.
    if (operation === 'variants' || operation === 'intersection') continue;
    cases.push({
      name: 'invalid response ' + index,
      operation,
      baseUrl: 'https://example.invalid',
      input: { body: control },
      expected: { method: 'POST', path: '/' + operation, body: JSON.stringify(control) },
      responses: [{ status: 200, body: JSON.stringify(value) }],
      error: { kind: 'protocol' },
    });
  }
  const file = join(dir, 'cases.json');
  writeFileSync(file, JSON.stringify(cases));
  assert.deepEqual(await validateFixtures(output, file), [
    { target: 'node', scenarios: cases.length },
    { target: 'php', scenarios: cases.length },
  ]);
});

test('type-array normalization retains exact formats in typed branches', async () => {
  const file = join(dir, 'exact-cases.json');
  writeFileSync(
    file,
    JSON.stringify([
      {
        name: 'exact typed branch',
        operation: 'exactVariants',
        baseUrl: 'https://example.invalid',
        input: { body: '9007199254740993' },
        expected: { method: 'POST', path: '/exactVariants', body: '9007199254740993' },
        responses: [{ status: 200, body: '9007199254740993' }],
        data: '9007199254740993',
      },
    ]),
  );
  assert.deepEqual(await validateFixtures(output, file), [
    { target: 'node', scenarios: 1 },
    { target: 'php', scenarios: 1 },
  ]);
});

test('unsupported propertyNames shapes fail with a specific remedy', () => {
  for (const propertyNames of [
    false,
    { type: 'integer' },
    { format: 'date' },
    { anyOf: [{}] },
    { enum: [1] },
    { const: 1 },
    { properties: {} },
  ]) {
    assert.throws(
      () => load(document({ invalid: { type: 'object', propertyNames } })),
      /propertyNames.*supports only string type.*express key constraints/,
    );
  }
  const plan = compileCodec(schemas.names);
  assertCodecPlan(plan);
  assert.throws(() => assertCodecPlan({ ...plan, propertyNames: {} }), /invalid compiled codec/);
});

test('key constraint compatibility follows input and response directions', () => {
  const map = (propertyNames) => ({ type: 'object', ...(propertyNames ? { propertyNames } : {}) });
  for (const [before, after] of [
    [{}, { minLength: 2 }],
    [{ maxLength: 10 }, { maxLength: 5 }],
    [{}, { pattern: '^[a-z]+$' }],
    [{}, { enum: ['only'] }],
    [{ enum: ['one', 'two'] }, { enum: ['one'] }],
    [{}, { const: 'only' }],
  ]) {
    assert.ok(
      compareSchemas(map(before), map(after), 'map', 'input').some(
        (c) => c.severity === 'breaking',
      ),
    );
    assert.ok(
      compareSchemas(map(before), map(after), 'map', 'response').every(
        (c) => c.severity !== 'breaking',
      ),
    );
    assert.ok(
      compareSchemas(map(after), map(before), 'map', 'input').every(
        (c) => c.severity !== 'breaking',
      ),
    );
  }
});

test('type arrays reject empty, duplicate and unsupported kinds and preserve OpenAPI 3.0 diagnostics', () => {
  for (const type of [[], ['string', 'string'], ['object', 'unknown']])
    assert.throws(() => load(document({ invalid: { type } })), /supported unique JSON types/);
  assert.throws(
    () => load(document({ invalid: { type: ['string', 'object'] } }, '3.0.3')),
    /use anyOf for non-null type alternatives/,
  );
});

test('identical nested alternatives avoid repeated representation comparisons without hiding ambiguity', () => {
  let nested = { type: 'object', properties: { amount: { type: 'integer', format: 'int64' } } };
  for (let i = 0; i < 5; i++)
    nested = {
      type: 'object',
      properties: {
        child: {
          anyOf: [
            structuredClone(nested),
            { ...structuredClone(nested), description: 'same shape' },
          ],
        },
      },
    };
  const source = document({ repeated: { anyOf: [nested, structuredClone(nested)] } });
  writeFileSync(join(dir, 'repeated.json'), JSON.stringify(source));
  const script = `import {loadContract} from ${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)};
const start=performance.now();loadContract(${JSON.stringify(join(dir, 'repeated.json'))},${JSON.stringify(join(dir, 'sdk.json'))});console.log(performance.now()-start);`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  console.log('Repeated-subtree loading: ' + result.stdout.trim() + ' ms');
  // The differing exact/native intersection must still fail, even when adjacent
  // branches are identical. Automatic string/exact inputs must still be marked.
  assert.throws(
    () =>
      load(
        document({
          bad: {
            allOf: [
              nested,
              structuredClone(nested),
              {
                type: 'object',
                properties: {
                  child: { allOf: [{ type: 'integer' }, { type: 'integer', format: 'int64' }] },
                },
              },
            ],
          },
        }),
      ),
    /intersected numeric schemas use different SDK representations/,
  );
  const c = load(
    document({ ambiguous: { anyOf: [{ type: 'string' }, { type: 'integer', format: 'int64' }] } }),
  );
  assert.equal(c.operations[0].body.anyOf[1]['x-sdk-number-input'], 'explicit');
});

test('saved compiled compatibility retains key constraints across regeneration', () => {
  const prior = join(dir, 'compatibility-output');
  const original = document({ names: { type: 'object', propertyNames: { maxLength: 10 } } });
  generate(load(original, 'compatibility-before'), prior);
  setCompatibilityBaseline(prior, 'released');
  const changed = structuredClone(original);
  changed.paths['/names'].post.requestBody.content[
    'application/json'
  ].schema.propertyNames.maxLength = 5;
  const result = preview(load(changed, 'compatibility-after'), prior);
  assert.ok(
    result.compatibility.some((c) => c.severity === 'breaking' && c.subject.includes('{key}')),
  );
  const responseOnly = JSON.parse(JSON.stringify(original));
  responseOnly.paths['/names'].post.responses['200'].content[
    'application/json'
  ].schema.propertyNames.maxLength = 5;
  assert.ok(
    preview(load(responseOnly, 'compatibility-response'), prior).compatibility.every(
      (c) => c.severity !== 'breaking',
    ),
  );
});

for (const annotation of ['x-sensitive', 'writeOnly']) {
  for (const inherited of [false, true]) {
    test(`protected map key schemas load and omit examples (${annotation}, inherited=${inherited})`, () => {
      const secret = 'SYNTHETIC_PROTECTED_MAP_EXAMPLE';
      const map = {
        type: 'object',
        propertyNames: { minLength: 1 },
        additionalProperties: { type: 'string', example: secret },
        example: { valid: secret },
      };
      const schema = inherited
        ? { type: 'object', [annotation]: true, properties: { nested: map } }
        : { ...map, [annotation]: true };
      const contract = load(document({ protectedMap: schema }));
      const files = render(contract);
      for (const [path, content] of files) {
        assert.ok(!content.includes(secret), path);
        assert.ok(!content.includes('x-sdk-example-protected'), path);
      }
    });
  }
}

test('caller reserved extensions stay rejected before publication markers are inserted', () => {
  for (const key of ['x-sdk-example-protected', 'x-sdk-pattern-php', 'x-sdk-unknown']) {
    for (const sensitive of [false, true]) {
      assert.throws(
        () =>
          load(
            document({
              invalid: {
                type: 'object',
                'x-sensitive': sensitive,
                propertyNames: { minLength: 1, [key]: true },
              },
            }),
          ),
        /x-sdk-\* extensions are reserved/,
      );
    }
    const path = join(dir, 'configured-reserved.json');
    writeFileSync(
      path,
      JSON.stringify({
        ...config,
        webhook: {
          algorithm: 'hmac-sha256',
          header: 'X-Signature',
          timestampHeader: 'X-Time',
          separator: '.',
          toleranceSeconds: 300,
          typeField: 'type',
          events: {
            'map.changed': {
              type: 'object',
              'x-sensitive': true,
              propertyNames: { minLength: 1, [key]: true },
            },
          },
        },
      }),
    );
    assert.throws(
      () => loadContract(join(dir, 'api.json'), path),
      /x-sdk-\* extensions are reserved/,
    );
  }
});

test('key constraint failures identify and escape the offending key in both generated executors', async () => {
  const codec = compileCodec({
    type: 'object',
    propertyNames: { minLength: 3, pattern: '^[a-z]+$' },
  });
  const { executeCodec } = await import(pathToFileURL(join(output, 'node/runtime.js')).href);
  const cases = [
    [{ ab: 'x' }, 'input["ab"]: string violates minLength'],
    [{ 'a"\\\n]': 'x' }, String.raw`input["a\"\\\n]"]: string violates pattern`],
  ];
  for (const mode of ['request', 'response']) {
    const path = mode === 'request' ? 'input' : 'response';
    for (const [value, expected] of cases) {
      assert.throws(() => executeCodec(value, codec, { mode, path }), {
        message: expected.replace(/^input/, path),
      });
    }
  }
  const plan = join(dir, 'key-errors-codec.json');
  writeFileSync(plan, JSON.stringify(codec));
  const php = String.raw`
require $argv[1].'/src/Client.php';
$codec=json_decode(file_get_contents($argv[2]),true,512,JSON_THROW_ON_ERROR);
$cases=[
 [(object)['ab'=>'x'], 'input["ab"]: string violates minLength'],
 [(object)["a\"\\\n]"=>'x'], <<<'ERROR'
input["a\"\\\n]"]: string violates pattern
ERROR],
];
foreach(['request','response'] as $mode){
 $path=$mode==='request'?'input':'response';
 foreach($cases as [$value,$expected]){
  try{Example\SchemaKeys\Codec::execute($value,$codec,['mode'=>$mode,'path'=>$path]);throw new RuntimeException('accepted invalid key');}
  catch(Example\SchemaKeys\SdkError $error){
   if($error->getMessage()!==str_replace('input[',$path.'[',$expected))throw new RuntimeException($error->getMessage());
  }
 }
}
echo 'ok';`;
  const result = spawnSync('php', ['-r', php, join(output, 'php'), plan], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  assert.equal(result.stdout, 'ok');
});

function referenceCli() {
  const root = join(dir, 'uncached');
  cpSync(new URL('../dist/', import.meta.url), join(root, 'dist'), { recursive: true });
  cpSync(new URL('../package.json', import.meta.url), join(root, 'package.json'));
  symlinkSync(resolve('node_modules'), join(root, 'node_modules'), 'dir');
  const contract = join(root, 'dist/contract.js');
  const source = readFileSync(contract, 'utf8');
  const cachedReturn = /if \(compared\.has\(key\)\)\s*return;/g;
  assert.equal([...source.matchAll(cachedReturn)].length, 1);
  writeFileSync(contract, source.replace(cachedReturn, 'if (false) return;'));
  return join(root, 'dist/cli.js');
}

test('identical union intersections retain numeric representation diagnostics', () => {
  const union = { anyOf: [{ type: 'integer', format: 'int64' }, { type: 'integer' }] };
  assert.throws(
    () => load(document({ invalid: { allOf: [union, structuredClone(union)] } })),
    /intersected numeric schemas use different SDK representations/,
  );
});

test('diagnose is identical with relation memoization on and off across composed identical subtrees', () => {
  const reference = referenceCli();
  const keywords = ['allOf', 'anyOf', 'oneOf'];
  const pairs = [
    [{ type: 'integer', format: 'int64' }, { type: 'integer' }],
    [{ type: 'string' }, { type: 'integer', format: 'int64' }],
    [
      { type: 'integer', format: 'int64' },
      { type: 'integer', format: 'int64', minimum: 0 },
    ],
  ];
  for (const [index, pair] of pairs.entries()) {
    const shapes = {};
    for (const inner of keywords)
      for (const outer of keywords) {
        const union = { [inner]: structuredClone(pair) };
        for (const [name, wrap] of [
          ['scalar', (schema) => schema],
          ['field', (schema) => ({ type: 'object', properties: { value: schema } })],
          ['items', (schema) => ({ type: 'array', items: schema })],
          ['map', (schema) => ({ type: 'object', additionalProperties: schema })],
        ]) {
          const repeated = wrap(union);
          shapes[`${inner}_${outer}_${name}`] = { [outer]: [repeated, structuredClone(repeated)] };
        }
      }
    const path = join(dir, `differential-${index}.json`);
    writeFileSync(path, JSON.stringify(document(shapes)));
    const run = (cli) => {
      const result = spawnSync(
        process.execPath,
        [cli, 'diagnose', path, join(dir, 'sdk.json'), '--json'],
        {
          encoding: 'utf8',
          timeout: 30000,
          maxBuffer: 8 * 1024 * 1024,
        },
      );
      assert.equal(result.error, undefined);
      assert.ok(result.status === 0 || result.status === 1, result.stderr);
      return { status: result.status, report: JSON.parse(result.stdout), stderr: result.stderr };
    };
    assert.deepEqual(run('dist/cli.js'), run(reference), `numeric pair ${index}`);
  }
});
