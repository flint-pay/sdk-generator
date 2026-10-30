import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { loadContract, generate, render, preview, compare, prepareRelease } from '../dist/index.js';
import { compileSdkContract } from '../dist/target-plan.js';
import { isSchemaAnnotation } from '../dist/schema-annotations.js';
import {
  sourceExampleProtection,
  removesPublishedExamples,
  omitProtectedExamples,
  EXAMPLE_PROTECTION_MARKER,
} from '../dist/example-protection.js';

// Actual, unmodified generation records from before publication protection.
// Keep their saved compiled snapshots so upgrades exercise historical comparison too.
const publicationBaseline = JSON.parse(
  readFileSync(new URL('./fixtures/sensitive-publication-baseline.json', import.meta.url)),
);

const root = mkdtempSync(join(tmpdir(), 'sdk-sensitive-publication-'));
after(() => rmSync(root, { recursive: true, force: true }));
const marker = 'SYNTHETIC_NEVER_PUBLISH_SCHEMA_VALUE';
const visible = 'SYNTHETIC_PUBLIC_SCHEMA_VALUE';
const ref = (name, annotations = {}) => ({ $ref: '#/components/schemas/' + name, ...annotations });
const annotations = (value = marker) => ({ example: value, examples: [value], default: value });
const text = (extra = {}) => ({
  type: 'string',
  description: 'Synthetic field description',
  ...annotations(),
  ...extra,
});
const record = (extra = {}) => ({
  type: 'object',
  required: ['value'],
  properties: { value: text() },
  ...extra,
});
const media = (schema) => ({ 'application/json': { schema } });
const schemaChildContext = (context, key) => {
  if (context.startsWith('map:')) return context.slice(4);
  if (context !== 'schema') return 'literal';
  if (['properties', 'patternProperties'].includes(key)) return 'map:schema';
  if (key === 'dependentSchemas') return 'map:composition';
  return [
    'prefixItems',
    'items',
    'contains',
    'additionalProperties',
    'allOf',
    'anyOf',
    'oneOf',
    'not',
    'if',
    'then',
    'else',
  ].includes(key)
    ? 'schema'
    : 'literal';
};
function fixture(name, schemas, bodies, extra = {}) {
  const dir = join(root, name);
  mkdirSync(dir);
  const paths = Object.fromEntries(
    Object.entries(bodies).map(([name, body]) => [
      '/' + name,
      {
        post: {
          operationId: 'send' + name,
          requestBody: { required: true, content: media(body) },
          responses: { 200: { description: 'Synthetic result', content: media(body) } },
        },
      },
    ]),
  );
  const api = {
    openapi: '3.1.1',
    info: { title: 'Synthetic publication', version: '1' },
    paths,
    components: { schemas },
    ...extra.api,
  };
  const config = {
    version: '1.0.0',
    requests: { style: 'object' },
    responses: { return: 'result' },
    npm: { name: 'synthetic-sensitive-publication' },
    composer: { name: 'synthetic/sensitive-publication', namespace: 'SyntheticPublication' },
    ...extra.config,
  };
  const source = join(dir, 'api.json'),
    profile = join(dir, 'sdk.json'),
    output = join(dir, 'sdk');
  writeFileSync(source, JSON.stringify(api));
  writeFileSync(profile, JSON.stringify(config));
  return { dir, source, profile, output, contract: loadContract(source, profile) };
}
function assertSafe(files) {
  assert.deepEqual(
    [...files].filter(([_name, content]) => content.includes(marker)).map(([name]) => name),
    [],
    'protected marker must be absent from every package file',
  );
  for (const target of ['node', 'php']) {
    assert.ok(files.get(target + '/MODELS.md').includes(visible), target + ' control example');
    assert.ok(files.get(target + '/MODELS.md').includes('Synthetic field description'));
  }
}
function packageFiles(output) {
  return readdirSync(output, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => [
      join(entry.parentPath, entry.name),
      readFileSync(join(entry.parentPath, entry.name), 'utf8'),
    ]);
}
// Simulate a historical publisher using synthetic annotations, then remove
// its publication sidecar from the saved record to model the older format.
function historicalGeneration(contract, output) {
  generate({ ...contract, exampleProtection: { locations: [], schemas: [] } }, output);
  const path = join(output, '.sdk-generator.json');
  const record = JSON.parse(readFileSync(path));
  // Simulate a record written before draft/release baseline tracking.
  delete record.baseline;
  delete record.interface.exampleProtection;
  writeFileSync(path, JSON.stringify(record));
}
function comprehensiveFixture(flag, suffix = '') {
  const schemas = {
    VisibleModel: { type: 'object', properties: { value: text(annotations(visible)) } },
  };
  const bodies = { VisibleModel: ref('VisibleModel') };
  const add = (name, schema) => {
    schemas[name] = schema;
    bodies[name] = ref(name);
  };
  add('Field', { type: 'object', required: ['value'], properties: { value: text(flag) } });
  add('Ancestor', record(flag));
  add('NestedAncestor', { type: 'object', properties: { nested: record(flag) } });
  add('Single', { ...flag, allOf: [record()] });
  add('NestedSingle', { ...flag, allOf: [{ allOf: [record()] }] });
  add('CaseAll', { allOf: [{ ...flag, type: 'object' }, record()] });
  add('CaseAny', { anyOf: [record(flag), { type: 'object', properties: { other: text() } }] });
  add('CaseOne', {
    oneOf: [record(flag), { type: 'object', required: ['other'], properties: { other: text() } }],
  });
  add('Conditional', {
    type: 'object',
    properties: { value: text() },
    if: { ...flag, properties: { value: { type: 'string' } } },
    then: { properties: { value: text() } },
    else: { properties: { value: text() } },
  });
  add('Not', {
    type: 'object',
    properties: { value: text() },
    not: { ...flag, required: ['absent'] },
  });
  add('ProtectedList', { ...flag, type: 'array', minItems: 1, items: record() });
  add('Contains', { type: 'array', minItems: 1, items: text(), contains: text(flag) });
  add('Dictionary', { ...flag, type: 'object', minProperties: 1, additionalProperties: record() });
  add('DictionaryField', { type: 'object', minProperties: 1, additionalProperties: text(flag) });
  add('FieldBridgeA', record({ properties: { value: text(flag) } }));
  add('FieldBridgeB', record());
  add('FieldBridge', { allOf: [ref('FieldBridgeB'), ref('FieldBridgeA')] });
  add('A', record(flag));
  add('B', record());
  add('Bridge', { allOf: [ref('B'), ref('A')] });
  add('NestedBridge', { allOf: [{ allOf: [ref('Bridge')] }, record()] });
  add('Shared', record());
  bodies.ProtectedUse = ref('Shared', flag);
  add('Siblings', ref('Shared', { ...flag, minProperties: 1, ...annotations({ value: marker }) }));
  add('AncestorRef', { ...flag, type: 'object', properties: { child: ref('Shared') } });
  add('Recursive', {
    ...flag,
    type: 'object',
    properties: { value: text(), child: ref('Recursive') },
  });
  add('ContainerExample', {
    type: 'object',
    ...annotations({ value: marker }),
    required: ['value'],
    properties: { value: text(flag), plain: text(annotations(visible)) },
  });
  return fixture(Object.keys(flag)[0] + suffix, schemas, bodies);
}

function assertRestoredPublications(contract) {
  const files = render(contract);
  assertSafe(files);
  for (const restored of [JSON.parse(JSON.stringify(contract)), structuredClone(contract)]) {
    const restoredFiles = render(restored);
    assertSafe(restoredFiles);
    assert.deepEqual([...restoredFiles], [...files]);
    assert.deepEqual(compare(contract, restored), []);
  }
  return files;
}

for (const flag of [{ 'x-sensitive': true }, { writeOnly: true }, { format: 'password' }]) {
  test(`R2: a protected dictionary constrains explicit properties across allOf (${Object.keys(flag)[0]})`, () => {
    const f = fixture(
      'dictionary-allOf-' + Object.keys(flag)[0],
      {
        Dictionary: { type: 'object', additionalProperties: { type: 'string', ...flag } },
        Explicit: record(),
        Bridge: { allOf: [ref('Dictionary'), ref('Explicit')] },
        VisibleModel: record({ properties: { value: text(annotations(visible)) } }),
      },
      { Bridge: ref('Bridge'), Explicit: ref('Explicit'), VisibleModel: ref('VisibleModel') },
    );
    const files = assertRestoredPublications(f.contract);
    const definitions = compileSdkContract(f.contract).source.definitions;
    assert.equal(definitions.Explicit.properties.value.example, undefined);
    assert.match(files.get('node/examples/api-sendExplicit.mjs'), /value: "example"/);
    assert.match(files.get('php/examples/api-sendExplicit.php'), /'value' => 'example'/);
  });

  test(`R3: protected items constrain contains across allOf (${Object.keys(flag)[0]})`, () => {
    const f = fixture(
      'items-contains-allOf-' + Object.keys(flag)[0],
      {
        ElementRules: { type: 'array', minItems: 1, items: { type: 'string', ...flag } },
        ContainmentRules: { contains: text() },
        Bridge: { allOf: [ref('ElementRules'), ref('ContainmentRules')] },
        VisibleModel: record({ properties: { value: text(annotations(visible)) } }),
      },
      {
        Bridge: ref('Bridge'),
        ContainmentRules: ref('ContainmentRules'),
        VisibleModel: ref('VisibleModel'),
      },
      { config: { validation: 'schema' } },
    );
    const files = assertRestoredPublications(f.contract);
    const definitions = compileSdkContract(f.contract).source.definitions;
    assert.equal(definitions.ContainmentRules.contains.example, undefined);
  });

  test(`R4: vendored stream roots with the same pointer and event name stay distinct (${Object.keys(flag)[0]})`, () => {
    const f = fixture(
      'vendored-streams-' + Object.keys(flag)[0],
      {
        FirstEvent: record({ properties: { value: text(annotations(visible)) } }),
        SecondEvent: record({ properties: { value: text(flag) } }),
      },
      { FirstEvent: ref('FirstEvent') },
    );
    const api = JSON.parse(readFileSync(f.source));
    api.paths = {};
    for (const [name, id] of [
      ['first', 'watchFirst'],
      ['second', 'watchSecond'],
    ]) {
      api.paths['/' + name] = { $ref: './' + name + '.json#/item' };
      writeFileSync(
        join(f.dir, name + '.json'),
        JSON.stringify({
          item: {
            get: {
              operationId: id,
              responses: {
                200: {
                  description: 'Synthetic event stream',
                  content: { 'text/event-stream': { schema: { type: 'string' } } },
                },
              },
            },
          },
        }),
      );
    }
    writeFileSync(f.source, JSON.stringify(api));
    const config = JSON.parse(readFileSync(f.profile));
    config.operations = {
      watchFirst: { stream: { events: { ready: ref('FirstEvent').$ref } } },
      watchSecond: { stream: { events: { ready: ref('SecondEvent').$ref } } },
    };
    writeFileSync(f.profile, JSON.stringify(config));
    const contract = loadContract(f.source, f.profile);
    const files = assertRestoredPublications(contract);
    assert.deepEqual(
      contract.operations.map((op) => op.id),
      ['watchFirst', 'watchSecond'],
    );
    assert.ok(
      contract.exampleProtection.locations.some(
        (location) =>
          location.startsWith('#/config/operations/watchSecond/sources/local:') &&
          location.endsWith('/item/get/stream/events/ready'),
      ),
      'synthetic provenance includes the operation and vendored document identity',
    );
    const definitions = compileSdkContract(contract).source.definitions;
    assert.equal(definitions.FirstEvent.properties.value.example, visible);
    assert.equal(definitions.SecondEvent.properties.value.example, undefined);
  });
}

test('a write-only property leaves sibling examples and their shared components public', () => {
  const currency = { type: 'string', pattern: '^[A-Z]{3}$', example: 'USD' };
  const f = fixture(
    'write-only-siblings',
    {
      ProtectedCode: {
        type: 'object',
        properties: { code: { type: 'string' }, secret: text() },
      },
      PublicMoney: { type: 'object', required: ['currency'], properties: { currency } },
      PublicChoice: { oneOf: [{ type: 'string' }, ref('PublicMoney')] },
      Envelope: {
        type: 'object',
        allOf: [{ type: 'object' }],
        ...annotations({ codes: [{ secret: marker }] }),
        required: ['label', 'money'],
        properties: {
          codes: { type: 'array', writeOnly: true, items: ref('ProtectedCode') },
          label: text(annotations(visible)),
          money: ref('PublicMoney'),
          choice: ref('PublicChoice'),
        },
      },
    },
    {
      Envelope: ref('Envelope'),
      PublicMoney: ref('PublicMoney'),
      PublicChoice: ref('PublicChoice'),
    },
    { config: { validation: 'schema' } },
  );
  assert.equal(
    f.contract.exampleProtection.locations.some((location) =>
      location.startsWith('#/components/schemas/Public'),
    ),
    false,
  );
  for (const contract of [f.contract, JSON.parse(JSON.stringify(f.contract))]) {
    const files = render(contract);
    for (const [name, contents] of files) assert.equal(contents.includes(marker), false, name);
    for (const target of ['node', 'php']) {
      const models = files.get(target + '/MODELS.md');
      assert.ok(models.includes(visible), target + ' sibling example');
      assert.ok(models.includes('USD'), target + ' shared component example');
      assert.ok(
        files
          .get(target + '/examples/api-sendEnvelope.' + (target === 'node' ? 'mjs' : 'php'))
          .includes('USD'),
      );
    }
    const definitions = compileSdkContract(f.contract).source.definitions;
    assert.equal(definitions.Envelope.example, undefined, 'container example can embed a secret');
    assert.equal(definitions.Envelope.properties.label.example, visible);
    assert.equal(definitions.PublicMoney.properties.currency.example, 'USD');
  }
});

for (const flag of [{ 'x-sensitive': true }, { writeOnly: true }, { format: 'password' }])
  test(`composed fields share ${Object.keys(flag)[0]} protection without protecting sibling fields`, () => {
    const f = fixture(
      'composed-siblings-' + Object.keys(flag)[0],
      {
        SensitiveField: { type: 'object', properties: { value: text(flag) } },
        PublicFields: {
          type: 'object',
          properties: { value: text(), sibling: text(annotations(visible)) },
        },
        Bridge: { allOf: [ref('SensitiveField'), ref('PublicFields')] },
      },
      { Bridge: ref('Bridge'), PublicFields: ref('PublicFields') },
    );
    assertSafe(render(f.contract));
    const definitions = compileSdkContract(f.contract).source.definitions;
    assert.equal(definitions.PublicFields.properties.value.example, undefined);
    assert.equal(definitions.PublicFields.properties.sibling.example, visible);
  });

for (const flag of [{ 'x-sensitive': true }, { writeOnly: true }, { format: 'password' }]) {
  test(`all publications and saved-contract regeneration protect ${Object.keys(flag)[0]}`, () => {
    const f = comprehensiveFixture(flag);
    const original = JSON.stringify(f.contract);
    assert.ok(f.contract.exampleProtection.locations.includes('#/components/schemas/B'));
    assert.ok(f.contract.exampleProtection.schemas.includes('/models/B/properties/value'));
    assert.equal(original.includes(EXAMPLE_PROTECTION_MARKER), false);
    const files = render(f.contract);
    assertSafe(files);
    const definitions = compileSdkContract(f.contract).source.definitions;
    assert.deepEqual(definitions.Shared.properties.value, {
      type: 'string',
      description: 'Synthetic field description',
    });
    assert.match(files.get('node/examples/api-sendShared.mjs'), /value: "example"/);
    assert.match(files.get('php/examples/api-sendShared.php'), /'value' => 'example'/);

    assert.equal(JSON.stringify(f.contract), original);
    generate(f.contract, f.output);
    assertSafe(
      new Map(
        packageFiles(f.output)
          .filter(([path]) => /\/(node|php)\//.test(path))
          .map(([path, contents]) => [path.slice(f.output.length + 1), contents]),
      ),
    );
    const saved = JSON.parse(readFileSync(join(f.output, '.sdk-generator.json'))).interface;
    assert.deepEqual(saved.exampleProtection, f.contract.exampleProtection);
    assertSafe(render(saved));
    assert.deepEqual([...render(saved)], [...render(f.contract)]);
    assert.deepEqual([...render(structuredClone(saved))], [...render(f.contract)]);
    assert.deepEqual(preview(saved, f.output).changes, []);
    assert.deepEqual(compare(f.contract, saved), []);
    generate(saved, f.output);
    assertSafe(render(JSON.parse(readFileSync(join(f.output, '.sdk-generator.json'))).interface));
  });
}

for (const flag of [{ 'x-sensitive': true }, { writeOnly: true }, { format: 'password' }])
  test(`release archives protect every ${Object.keys(flag)[0]} source path after record restoration`, () => {
    const f = comprehensiveFixture(flag, '-release');
    generate(f.contract, f.output);
    const saved = JSON.parse(readFileSync(join(f.output, '.sdk-generator.json'))).interface;
    assert.deepEqual(preview(saved, f.output).changes, []);
    const destination = join(f.dir, 'release');
    const plan = prepareRelease(f.output, destination);
    assert.equal(plan.reviewRequired, false);
    for (const [path, content] of packageFiles(destination)) {
      if (!/\.(tgz|zip)$/.test(path)) assert.equal(content.includes(marker), false, path);
    }
    const npm = readdirSync(destination).find((name) => name.endsWith('.tgz'));
    const zip = readdirSync(destination).find((name) => name.endsWith('.zip'));
    assert.ok(npm && zip);
    const unpacked = join(f.dir, 'unpacked');
    mkdirSync(unpacked);
    execFileSync('tar', ['-xzf', join(destination, npm), '-C', unpacked]);
    execFileSync('php', [
      '-r',
      '$z=new ZipArchive();if($z->open($argv[1])!==true)exit(1);$z->extractTo($argv[2]);',
      join(destination, zip),
      unpacked,
    ]);
    for (const [path, content] of packageFiles(unpacked))
      assert.equal(content.includes(marker), false, path);
  });

test('every protected child constraint protects all children of its value equivalence group', () => {
  // Include keywords rejected by generation: this tests the source-graph rule,
  // not support for new schema capabilities or combinations of value types.
  const childLocations = (schema) => ({
    properties: { value: schema },
    additionalProperties: schema,
    patternProperties: { '^x': schema },
    items: schema,
    prefixItems: [schema],
    contains: schema,
  });
  const childPointers = [
    '/properties/value',
    '/additionalProperties',
    '/patternProperties/^x',
    '/items',
    '/prefixItems/0',
    '/contains',
  ];
  for (const flag of [{ 'x-sensitive': true }, { writeOnly: true }, { format: 'password' }])
    for (const [keyword, constraint] of Object.entries(childLocations(ref('ProtectedValue')))) {
      if (keyword === 'properties') continue;
      for (const composition of ['allOf', 'anyOf', 'oneOf', 'if', 'then', 'else']) {
        const branches = [ref('Constrained'), ref('Other')];
        const schemas = {
          ProtectedValue: { type: 'string', ...flag },
          Constrained: { [keyword]: constraint },
          Other: childLocations({ type: 'string' }),
          Bridge: {
            [composition]: composition.endsWith('Of') ? branches : { allOf: branches },
          },
          Money: { type: 'object', properties: { currency: { type: 'string', example: 'USD' } } },
        };
        const graph = sourceExampleProtection(
          [
            {
              document: '',
              pointer: '/envelope',
              context: 'schema',
              value: {
                type: 'object',
                properties: { value: ref('Bridge'), sibling: ref('Money') },
              },
            },
          ],
          schemaChildContext,
          (_source, reference) => ({
            document: '',
            pointer: reference.slice(1),
            context: 'schema',
            value: schemas[reference.split('/').at(-1)],
          }),
          false,
          isSchemaAnnotation,
        );
        const message = Object.keys(flag)[0] + '/' + keyword + '/' + composition;
        for (const pointer of childPointers)
          assert.equal(
            graph.protects('', '/components/schemas/Other' + pointer),
            true,
            message + pointer,
          );
        assert.equal(graph.protects('', '/envelope/properties/sibling'), false, message);
        assert.equal(graph.protects('', '/components/schemas/Money'), false, message);
        assert.equal(
          graph.protects('', '/components/schemas/Money/properties/currency'),
          false,
          message,
        );
      }
    }
});

test('source protection reaches prefix items, patterns and dependent schemas before unsupported-input diagnosis', () => {
  const schemas = { Shared: record(), Other: record() };
  for (const flag of [{ 'x-sensitive': true }, { writeOnly: true }])
    for (const [keyword, child] of [
      ['prefixItems', [ref('Shared')]],
      ['patternProperties', { '^x': ref('Shared') }],
      ['dependentSchemas', { x: ref('Shared') }],
    ]) {
      const graph = sourceExampleProtection(
        [
          {
            document: '',
            pointer: '/inline',
            context: 'schema',
            value: { ...flag, [keyword]: child },
          },
          {
            document: '',
            pointer: '/components/schemas/Bridge',
            context: 'schema',
            value: { allOf: [ref('Shared'), ref('Other')] },
          },
        ],
        schemaChildContext,
        (source, reference) => ({
          document: '',
          pointer: reference.slice(1),
          context: 'schema',
          value: schemas[reference.split('/').at(-1)],
        }),
        false,
        isSchemaAnnotation,
      );
      assert.equal(
        graph.protects('', '/components/schemas/Shared/properties/value'),
        true,
        keyword,
      );
      assert.equal(
        graph.protects('', '/components/schemas/Other/properties/value'),
        true,
        keyword + ' bridge',
      );
      assert.throws(
        () =>
          fixture(
            'unsupported-' + Object.keys(flag)[0] + '-' + keyword,
            { Unsupported: { ...flag, type: 'object', [keyword]: child }, Shared: record() },
            { Unsupported: ref('Unsupported') },
          ),
        /unsupported|unknown/i,
      );
    }
});

test('effective output and loaded schemas contain no temporary publication annotations', () => {
  const f = fixture(
    'effective',
    { Shared: record() },
    { Shared: ref('Shared', { 'x-sensitive': true }) },
  );
  const result = spawnSync(process.execPath, ['dist/cli.js', 'effective', f.source, f.profile], {
    encoding: 'utf8',
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const effective = JSON.parse(result.stdout);
  assert.equal(effective.exampleProtection, undefined);
  assert.equal(result.stdout.includes(EXAMPLE_PROTECTION_MARKER), false);
  assert.ok(f.contract.exampleProtection);
});

test('provenance alone gives no compatibility finding; removing published annotations requires review', () => {
  for (const examples of [false, true]) {
    const f = fixture(
      'legacy-' + examples,
      { Shared: record({ properties: { value: examples ? text() : { type: 'string' } } }) },
      { Shared: ref('Shared', { 'x-sensitive': true }) },
    );
    const legacy = structuredClone(f.contract);
    delete legacy.exampleProtection;
    const oldPlan = compileSdkContract(legacy).plan,
      nextPlan = compileSdkContract(f.contract).plan;
    assert.deepEqual(oldPlan.policy, nextPlan.policy);
    const findings = compare(legacy, f.contract);
    if (examples) {
      assert.ok(findings.some((finding) => finding.severity === 'review'));
      assert.ok(findings.every((finding) => finding.severity === 'review'));
    } else assert.deepEqual(findings, []);
    historicalGeneration(legacy, f.output);
    const plan = generate(f.contract, f.output);
    assert.deepEqual(plan.compatibility, findings);
    assert.deepEqual(preview(f.contract, f.output).changes, []);
  }
});

for (const baseline of publicationBaseline.records) {
  const { targets, sensitive, api, config, record: savedRecord } = baseline;
  test(`historical ${targets.join('/')} upgrade ${sensitive ? 'finds sendB removal' : 'keeps sendB published'} when sendA is added`, () => {
    assert.equal(savedRecord.interface.exampleProtection, undefined);
    assert.deepEqual(
      savedRecord.interface.operations.map(({ id }) => id),
      ['sendB'],
    );
    const nextApi = structuredClone(api);
    const added = structuredClone(nextApi.paths['/b']);
    added.post.operationId = 'sendA';
    const value = added.post.requestBody.content['application/json'].schema.properties.value;
    value.example = 'SYNTHETIC_ADDED_OPERATION_EXAMPLE';
    if (sensitive) delete value['x-sensitive'];
    else value['x-sensitive'] = true;
    nextApi.paths['/a'] = added;
    const f = fixture(
      'operation-upgrade-' + targets.join('-') + '-' + sensitive,
      {},
      {},
      {
        api: nextApi,
        config,
      },
    );
    assert.deepEqual(
      f.contract.operations.map(({ id }) => id),
      ['sendA', 'sendB'],
    );
    const sourceExpected = [
      ...(sensitive ? [{ severity: 'review', subject: 'published schema examples' }] : []),
      { severity: 'additive', subject: 'sendA' },
    ];
    const expected = [
      ...sourceExpected,
      // Historical records predate codec semantics 5's intentional 8.0 representation break.
      { severity: 'breaking', subject: 'SDK value representations' },
    ];
    // Records predate later generator capabilities (runtime and target flags); keep
    // the comparison focused on operations and published examples, excluding retry migrations.
    const summarize = (findings) =>
      findings
        .filter(
          ({ subject }) =>
            subject !== 'runtime' && !/^(node|php)\./.test(subject) && !subject.endsWith('.retry'),
        )
        .map(({ severity, subject }) => ({ severity, subject }));
    assert.deepEqual(summarize(compare(savedRecord.interface, f.contract)), sourceExpected);
    mkdirSync(f.output);
    writeFileSync(join(f.output, '.sdk-generator.json'), JSON.stringify(savedRecord));
    assert.deepEqual(summarize(preview(f.contract, f.output).compatibility), expected);
    assert.deepEqual(summarize(generate(f.contract, f.output).compatibility), expected);
    const saved = JSON.parse(readFileSync(join(f.output, '.sdk-generator.json')));
    assert.deepEqual(summarize(saved.compatibility), expected);
    assert.deepEqual(preview(saved.interface, f.output).changes, []);
    assert.deepEqual(summarize(preview(saved.interface, f.output).compatibility), expected);
    const example =
      api.paths['/b'].post.requestBody.content['application/json'].schema.properties.value.example;
    const files = render(saved.interface);
    for (const target of targets)
      assert.equal(
        [...files].some(
          ([path, contents]) => path.startsWith(target + '/') && contents.includes(example),
        ),
        !sensitive,
        target + ' sendB publication',
      );
  });
}

test('reordering source operations produces no compatibility findings', () => {
  const f = fixture(
    'publication-source-reordering',
    {},
    {
      B: record({ 'x-sensitive': true }),
      C: record({ properties: { value: text(annotations(visible)) } }),
    },
  );
  const api = JSON.parse(readFileSync(f.source));
  api.paths = Object.fromEntries(Object.entries(api.paths).reverse());
  writeFileSync(f.source, JSON.stringify(api));
  const reordered = loadContract(f.source, f.profile);
  assert.deepEqual(compare(f.contract, reordered), []);
  assert.deepEqual(compare(reordered, f.contract), []);
});

test('reordering contract operations and parameters preserves publication decisions', () => {
  const f = fixture(
    'publication-reordering',
    {},
    {
      B: record({ 'x-sensitive': true }),
      C: record({ properties: { value: text(annotations(visible)) } }),
    },
  );
  // Sidecar indices always belong to their own contract. Move the protected
  // owners and update those indices without changing any publication decision.
  const before = structuredClone(f.contract);
  before.operations[0].parameters = [
    { in: 'query', name: 'value', schema: text() },
    { in: 'header', name: 'other', schema: text(annotations(visible)) },
  ];
  before.exampleProtection.schemas.push('/operations/0/parameters/0/schema');
  const after = structuredClone(before);
  after.operations.reverse();
  after.operations[1].parameters.reverse();
  after.exampleProtection.schemas = before.exampleProtection.schemas.map((pointer) =>
    pointer.replace('/operations/0/', '/operations/1/').replace('/parameters/0/', '/parameters/1/'),
  );
  assert.equal(removesPublishedExamples(before, after), false);
  assert.equal(removesPublishedExamples(after, before), false);
  const published = (contract) => {
    const copy = structuredClone(contract);
    omitProtectedExamples(copy);
    copy.operations.sort((a, b) => a.id.localeCompare(b.id));
    for (const op of copy.operations) op.parameters.sort((a, b) => a.in.localeCompare(b.in));
    return copy.operations;
  };
  assert.deepEqual(published(before), published(after));
});

test('publication comparisons distinguish parameter location/name, body media types and response status', () => {
  const f = fixture('publication-owner-identities', {}, { B: record() });
  const before = structuredClone(f.contract);
  before.operations[0].parameters = [{ in: 'query', name: 'value', schema: text() }];
  before.exampleProtection.schemas = [];
  const cases = [
    ['same parameter', '/parameters/0/schema', () => {}, true],
    [
      'other parameter name',
      '/parameters/0/schema',
      (op) => {
        op.parameters[0].name = 'other';
      },
      false,
    ],
    [
      'other parameter location',
      '/parameters/0/schema',
      (op) => {
        op.parameters[0].in = 'header';
      },
      false,
    ],
    ['same request body', '/body/properties/value', () => {}, true],
    [
      'other request media type',
      '/body/properties/value',
      (op) => {
        op.mediaType = 'application/merge-patch+json';
      },
      false,
    ],
    ['same response body', '/responses/200/schema/properties/value', () => {}, true],
    [
      'other response media type',
      '/responses/200/schema/properties/value',
      (op) => {
        op.responses['200'].mediaType = 'application/merge-patch+json';
      },
      false,
    ],
    [
      'other response status',
      '/responses/201/schema/properties/value',
      (op) => {
        op.responses['201'] = op.responses['200'];
        delete op.responses['200'];
      },
      false,
    ],
  ];
  for (const [name, relative, change, expected] of cases) {
    const after = structuredClone(before);
    change(after.operations[0]);
    after.exampleProtection.schemas = ['/operations/0' + relative];
    assert.equal(removesPublishedExamples(before, after), expected, name);
  }
  for (const sensitive of [false, true]) {
    const after = structuredClone(before);
    after.operations[0].parameters.unshift({ in: 'query', name: 'earlier', schema: text() });
    after.exampleProtection.schemas = [
      '/operations/0/parameters/' + (sensitive ? '1' : '0') + '/schema',
    ];
    assert.equal(removesPublishedExamples(before, after), sensitive, 'parameter insertion');
  }
});

test('publication comparisons match components by name and incoming webhooks by name/method', () => {
  const f = fixture('publication-named-owners', {}, { B: record() });
  for (const collection of ['models', 'definitions']) {
    const before = structuredClone(f.contract);
    before[collection] = { 'B/~': record() };
    const after = structuredClone(before);
    after[collection] = { A: record(), ...after[collection] };
    after.exampleProtection.schemas = ['/' + collection + '/A/properties/value'];
    assert.equal(removesPublishedExamples(before, after), false, collection + ' added name');
    after.exampleProtection.schemas = ['/' + collection + '/B~1~0/properties/value'];
    assert.equal(removesPublishedExamples(before, after), true, collection + ' matching name');
  }
  const before = structuredClone(f.contract);
  before.incoming = ['B/~', 'C'].map((name) => ({
    name,
    method: 'POST',
    pointer: '/webhooks/' + name,
    model: 'Incoming' + name,
    schema: record(),
    dependencies: [],
  }));
  before.exampleProtection.schemas = ['/incoming/0/schema/properties/value'];
  const after = structuredClone(before);
  after.incoming.reverse();
  after.exampleProtection.schemas = ['/incoming/1/schema/properties/value'];
  assert.equal(removesPublishedExamples(before, after), false, 'reordered incoming webhooks');
  before.exampleProtection.schemas = [];
  assert.equal(removesPublishedExamples(before, after), true, 'same incoming webhook');
  after.incoming[1].method = 'PUT';
  assert.equal(removesPublishedExamples(before, after), false, 'other incoming method');
  after.incoming[1].method = 'POST';
  after.incoming[1].name = 'A';
  assert.equal(removesPublishedExamples(before, after), false, 'other incoming name');
});

for (const flag of [{ 'x-sensitive': true }, { writeOnly: true }])
  test(`protected ancestors, vendored sources, parameters and webhook events use ${Object.keys(flag)[0]} publication provenance`, () => {
    const f = fixture(
      'sources-' + Object.keys(flag)[0],
      {
        Shared: record(),
        VisibleModel: record({ properties: { value: text(annotations(visible)) } }),
      },
      { VisibleModel: ref('VisibleModel') },
      {
        config: {
          webhook: {
            algorithm: 'hmac-sha256',
            header: 'X-Signature',
            timestampHeader: 'X-Timestamp',
            separator: '.',
            toleranceSeconds: 300,
            typeField: 'type',
            events: {
              'record.updated': {
                type: 'object',
                properties: {
                  type: { type: 'string', const: 'record.updated' },
                  value: text(flag),
                },
              },
            },
          },
        },
      },
    );
    const api = JSON.parse(readFileSync(f.source));
    api.paths['/ancestor'] = {
      post: {
        operationId: 'sendAncestor',
        requestBody: { ...flag, required: true, content: media(ref('Shared')) },
        responses: { 204: { description: 'Empty' } },
      },
    };
    api.paths['/parameter'] = {
      get: {
        operationId: 'readParameter',
        parameters: [
          {
            name: 'label',
            in: 'query',
            required: true,
            example: marker,
            examples: { sample: { value: marker } },
            schema: ref('SharedText', flag),
          },
        ],
        responses: { 204: { description: 'Empty' } },
      },
    };
    api.components.schemas.SharedText = text();
    api.paths['/external'] = { $ref: './vendored.json#/pathItem' };
    writeFileSync(
      join(f.dir, 'vendored.json'),
      JSON.stringify({
        pathItem: {
          post: {
            operationId: 'sendExternal',
            requestBody: { ...flag, required: true, content: media({ $ref: '#/payload' }) },
            responses: { 204: { description: 'Empty' } },
          },
        },
        payload: record(),
      }),
    );
    writeFileSync(f.source, JSON.stringify(api));
    const contract = loadContract(f.source, f.profile);
    assertSafe(render(contract));
    assert.deepEqual([...render(JSON.parse(JSON.stringify(contract)))], [...render(contract)]);
    assert.ok(
      contract.exampleProtection.locations.some(
        (location) =>
          location.startsWith('local:') && location.endsWith('#/payload/properties/value'),
      ),
    );
    assert.ok(
      contract.exampleProtection.locations.includes(
        'config#/webhook/events/record.updated/properties/value',
      ),
    );
    assert.equal(JSON.stringify(contract).includes(EXAMPLE_PROTECTION_MARKER), false);
  });

test('PHP default-only publication removal requires review with unchanged compiled policies', () => {
  const f = fixture(
    'legacy-default',
    { Shared: { type: 'string', 'x-sensitive': true, default: marker } },
    { Shared: ref('Shared') },
    { config: { targets: ['php'] } },
  );
  const legacy = structuredClone(f.contract);
  delete legacy.exampleProtection;
  assert.deepEqual(
    compileSdkContract(legacy).plan.policy,
    compileSdkContract(f.contract).plan.policy,
  );
  assert.deepEqual(
    compare(legacy, f.contract).map(({ severity, subject }) => ({ severity, subject })),
    [{ severity: 'review', subject: 'published schema examples' }],
  );
});

test('Node default publication removal requires documentation review without execution changes', () => {
  const f = fixture(
    'node-default',
    { Shared: { type: 'string', 'x-sensitive': true, default: marker } },
    { Shared: ref('Shared') },
    { config: { targets: ['node'] } },
  );
  const legacy = structuredClone(f.contract);
  delete legacy.exampleProtection;
  assert.ok(
    [...render({ ...legacy, exampleProtection: { locations: [], schemas: [] } })].some(
      ([, source]) => source.includes(marker),
    ),
  );
  for (const [name, source] of render(f.contract))
    assert.equal(source.includes(marker), false, name);
  assert.deepEqual(
    compare(legacy, f.contract).map(({ severity, subject }) => ({ severity, subject })),
    [{ severity: 'review', subject: 'published schema examples' }],
  );
});

for (const flag of [{ 'x-sensitive': true }, { writeOnly: true }])
  test(`fragment references retain ${Object.keys(flag)[0]} on an unselected source ancestor`, () => {
    const f = fixture(
      'fragment-' + Object.keys(flag)[0],
      {
        Parent: record(flag),
        VisibleModel: record({ properties: { value: text(annotations(visible)) } }),
      },
      {
        Fragment: { $ref: '#/components/schemas/Parent/properties/value' },
        VisibleModel: ref('VisibleModel'),
      },
    );
    assertSafe(render(f.contract));
    assertSafe(render(JSON.parse(JSON.stringify(f.contract))));
    assert.ok(
      f.contract.exampleProtection.locations.includes(
        '#/components/schemas/Parent/properties/value',
      ),
    );
  });

test('invalid saved publication provenance is rejected before rendering values', () => {
  const f = fixture(
    'invalid-provenance',
    { Shared: record() },
    { Shared: ref('Shared', { 'x-sensitive': true }) },
  );
  for (const invalid of [
    null,
    {},
    { locations: [], schemas: [3] },
    { locations: [], schemas: ['relative'] },
  ])
    assert.throws(
      () => render({ ...f.contract, exampleProtection: invalid }),
      /exampleProtection: expected/,
    );
});

test('sample-free publication provenance preserves historical component sharing', () => {
  const schema = { type: 'object', properties: { label: { type: 'string' } } };
  const f = fixture(
    'historical-sharing',
    {
      Alpha: schema,
      Beta: schema,
      Envelope: {
        type: 'object',
        properties: { first: ref('Alpha', { 'x-sensitive': true }), second: ref('Beta') },
      },
    },
    { Envelope: ref('Envelope') },
  );
  assert.equal(f.contract.models.Envelope.properties.first['x-sdk-ref'], 'Beta');
  assert.equal(f.contract.models.Envelope.properties.second['x-sdk-ref'], 'Beta');
  const legacy = structuredClone(f.contract);
  delete legacy.exampleProtection;
  assert.deepEqual(compare(legacy, f.contract), []);
});

for (const targets of [['node'], ['php'], ['node', 'php']])
  test(`release requires source regeneration for records predating protection (${targets.join(', ')})`, () => {
    const f = fixture(
      'legacy-release-' + targets.join('-'),
      { Shared: record() },
      { Shared: ref('Shared', { 'x-sensitive': true }) },
      { config: { targets } },
    );
    const legacy = structuredClone(f.contract);
    delete legacy.exampleProtection;
    historicalGeneration(legacy, f.output);
    assert.throws(
      () => prepareRelease(f.output, join(f.dir, 'release')),
      /regenerate before preparing a release.*publication protection/,
    );
  });

test('publishers require source protection provenance while historical comparison remains available', () => {
  const f = fixture(
    'missing-provenance',
    { Shared: record() },
    { Shared: ref('Shared', { 'x-sensitive': true }) },
  );
  const legacy = structuredClone(f.contract);
  delete legacy.exampleProtection;
  for (const publish of [
    () => render(legacy),
    () => generate(legacy, f.output),
    () => preview(legacy, f.output),
  ])
    assert.throws(publish, /exampleProtection: reload the source inputs with loadContract/);
  assert.ok(compare(legacy, f.contract).every((finding) => finding.severity === 'review'));
});

test('identical Node default schemas preserve historical aliases with documentation-only review', () => {
  const schema = { type: 'object', properties: { value: { type: 'string', default: marker } } };
  const f = fixture(
    'default-sharing',
    {
      Alpha: schema,
      Beta: schema,
      Envelope: {
        type: 'object',
        properties: { first: ref('Alpha', { 'x-sensitive': true }), second: ref('Beta') },
      },
    },
    { Envelope: ref('Envelope') },
    { config: { targets: ['node'] } },
  );
  assert.equal(f.contract.models.Envelope.properties.first['x-sdk-ref'], 'Beta');
  const legacy = structuredClone(f.contract);
  delete legacy.exampleProtection;
  assert.deepEqual(
    compare(legacy, f.contract).map(({ severity, subject }) => ({ severity, subject })),
    [{ severity: 'review', subject: 'published schema examples' }],
  );
});

for (const flag of [{ 'x-sensitive': true }, { writeOnly: true }])
  test(`structural reference siblings propagate ${Object.keys(flag)[0]} from a field to the named base`, () => {
    const f = fixture(
      'structural-field-' + Object.keys(flag)[0],
      {
        Shared: record(),
        VisibleModel: record({ properties: { value: text(annotations(visible)) } }),
      },
      {
        Protected: ref('Shared', { properties: { value: { type: 'string', ...flag } } }),
        VisibleModel: ref('VisibleModel'),
      },
    );
    assertSafe(render(f.contract));
    assertSafe(render(JSON.parse(JSON.stringify(f.contract))));
  });

test('publication filtering preserves PHP implicit entity names and getter types', () => {
  const bare = { type: 'object', properties: { value: { type: 'string' } } };
  const f = fixture(
    'php-identity',
    {
      Alpha: { type: 'object', properties: { value: text() } },
      Envelope: { type: 'object', properties: { entry: bare } },
    },
    { Alpha: ref('Alpha', { 'x-sensitive': true }), Envelope: ref('Envelope') },
  );
  const legacy = structuredClone(f.contract);
  delete legacy.exampleProtection;
  const old = compileSdkContract(legacy).plan,
    next = compileSdkContract(f.contract).plan;
  const identities = (plan) =>
    plan.php.models.map(({ name, getters, constructorType }) => ({
      name,
      getters,
      constructorType,
    }));
  assert.deepEqual(identities(next), identities(old));
  const findings = compare(legacy, f.contract);
  assert.ok(findings.length && findings.every((finding) => finding.severity === 'review'));
  for (const [name, content] of render(f.contract))
    assert.equal(content.includes(marker), false, name);
});
