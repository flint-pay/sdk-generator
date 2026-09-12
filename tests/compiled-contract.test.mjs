import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  loadContract,
  generate,
  compare,
  preview,
  prepareRelease,
  validateFixtures,
} from '../dist/index.js';
import { compileSdkContract } from '../dist/target-plan.js';
import { compileResponsePlan } from '../dist/response-plan.js';
import { addedResultFits } from '../dist/response-compatibility.js';
import { restoreCompiledSnapshot, storeCompiledSnapshot } from '../dist/compiled-record.js';
function readRecord(path) {
  const record = JSON.parse(readFileSync(path));
  for (const key of ['compiled', 'compiledComparisonBase'])
    if (record[key]) record[key] = JSON.parse(JSON.stringify(restoreCompiledSnapshot(record[key])));
  return record;
}

const root = mkdtempSync(join(tmpdir(), 'sdk-compiled-'));
after(() => rmSync(root, { recursive: true, force: true }));
const mixed = {
  type: 'object',
  properties: { label: { type: 'string' } },
  required: ['entry'],
  additionalProperties: {
    type: 'object',
    required: ['id'],
    additionalProperties: { type: 'string' },
  },
};
function fixture(name, schema = mixed, targets = ['node', 'php']) {
  const dir = join(root, name);
  mkdirSync(dir);
  const api = {
    openapi: '3.1.0',
    info: { title: 'Compiled', version: '1' },
    paths: {
      '/value': {
        get: {
          operationId: 'readValue',
          responses: { 200: { description: 'Value', content: { 'application/json': { schema } } } },
        },
      },
    },
  };
  const config = {
    version: '1.0.0',
    targets,
    requests: { style: 'object' },
    npm: { name: '@example/compiled' },
    composer: { name: 'example/compiled', namespace: 'Example\\Compiled' },
    release: { policy: 'semver' },
  };
  const source = join(dir, 'api.json'),
    profile = join(dir, 'sdk.json'),
    output = join(dir, 'sdk');
  writeFileSync(source, JSON.stringify(api));
  writeFileSync(profile, JSON.stringify(config));
  const contract = loadContract(source, profile);
  return { dir, source, profile, output, contract };
}
function run(command, args, input) {
  const result = spawnSync(command, args, { input, encoding: 'utf8', timeout: 120000 });
  assert.equal(result.status, 0, result.error?.message ?? result.stdout + result.stderr);
  return result.stdout;
}

test('mixed-object nested runtime guarantee loss blocks stable patch/minor releases', () => {
  const f = fixture('mixed-release', mixed, ['node']);
  generate(f.contract, f.output);
  const next = structuredClone(f.contract);
  const added = structuredClone(next.operations[0].responses['200']);
  delete added.schema.additionalProperties.required;
  next.operations[0].responses['201'] = added;
  const oldPlan = compileResponsePlan(mixed),
    newPlan = compileResponsePlan(added.schema);
  assert.deepEqual(oldPlan.publicType, newPlan.publicType);
  const finding = addedResultFits([oldPlan], newPlan, 'readValue.response.201');
  assert.equal(finding.result, 'incompatible');
  assert.match(finding.path, /entry.id|\*\.id/);
  assert.ok(
    compare(f.contract, next).some(
      (c) => c.severity === 'breaking' && c.subject === 'readValue.response.201',
    ),
  );
  for (const version of ['1.0.1', '1.1.0']) {
    const output = f.output + '-' + version;
    generate(f.contract, output);
    next.config.version = version;
    generate(next, output);
    assert.throws(
      () => prepareRelease(output, join(f.dir, 'release-' + version)),
      /breaking changes require a new major/i,
    );
  }
  next.config.version = '2.0.0';
  generate(next, f.output);
  assert.doesNotThrow(() => prepareRelease(f.output, join(f.dir, 'release-major')));
});

for (const policy of ['semver', 'review'])
  test(`release preparation includes fresh findings without file changes under ${policy} policy`, () => {
    const f = fixture('fresh-release-' + policy, mixed, ['node']);
    f.contract.config.release.policy = policy;
    generate(f.contract, f.output);
    const next = structuredClone(f.contract);
    next.config.version = '1.0.1';
    const added = structuredClone(next.operations[0].responses['200']);
    delete added.schema.additionalProperties.required;
    next.operations[0].responses['201'] = added;
    generate(next, f.output);

    const path = join(f.output, '.sdk-generator.json');
    const record = JSON.parse(readFileSync(path));
    const historical = {
      severity: 'review',
      subject: 'historical runtime',
      message: 'Previously recorded runtime behavior requires review.',
    };
    // Simulate an older analyzer's findings, preserving the actual emitted
    // files, source contracts, and compiled snapshots without modification.
    record.compatibility = policy === 'semver' ? [] : [historical];
    writeFileSync(path, JSON.stringify(record));
    const fresh = preview(next, f.output);
    assert.deepEqual(fresh.changes, []);
    assert.ok(
      fresh.compatibility.some(
        (finding) => finding.severity === 'breaking' && finding.subject.endsWith('.entry.id'),
      ),
    );
    if (policy === 'review') {
      // A finding already recorded must appear only once in the release.
      record.compatibility.push(fresh.compatibility[0]);
      writeFileSync(path, JSON.stringify(record));
    }
    const original = readFileSync(path, 'utf8');
    const destination = join(f.dir, 'release');
    if (policy === 'semver') {
      assert.throws(
        () => prepareRelease(f.output, destination),
        /breaking changes require a new major/i,
      );
      assert.equal(existsSync(destination), false);
    } else {
      const plan = prepareRelease(f.output, destination);
      assert.deepEqual(plan.compatibility, [historical, ...fresh.compatibility]);
      assert.equal(plan.previousVersion, '1.0.0');
      assert.equal(plan.reviewRequired, true);
      assert.deepEqual(
        JSON.parse(readFileSync(join(destination, 'release-plan.json'))).compatibility,
        plan.compatibility,
      );
      for (const file of ['CHANGELOG.md', 'MIGRATION.md']) {
        const text = readFileSync(join(destination, file), 'utf8');
        for (const finding of plan.compatibility) {
          assert.ok(text.includes(finding.subject), file + ': missing ' + finding.subject);
          assert.ok(text.includes(finding.message), file + ': missing ' + finding.message);
        }
      }
    }
    assert.equal(readFileSync(path, 'utf8'), original);
  });

test('generated calls in both languages execute with dynamic schema compilation disabled', () => {
  const f = fixture('execution-boundary');
  generate(f.contract, f.output);
  const phpPlan = JSON.parse(readFileSync(join(f.output, 'php/src/contract.json')));
  assert.equal(phpPlan.format, 1);
  assert.ok(phpPlan.operations[0].responses['200'].codec);
  assert.equal(phpPlan.operations[0].responses['200'].schema, undefined);
  const js = join(f.output, 'node/codec-plan.js');
  writeFileSync(
    js,
    readFileSync(js, 'utf8').replace(
      'export function compileCodec(schema) {',
      'export function compileCodec(schema) { throw new Error("dynamic adapter invoked");',
    ),
  );
  const php = join(f.output, 'php/src/SchemaAdapter.php');
  writeFileSync(
    php,
    readFileSync(php, 'utf8').replace(
      /(public static function compile\(array \$schema\): array\s*\{)/,
      '$1 throw new \\Exception("dynamic adapter invoked");',
    ),
  );
  const nodeProgram = `
    import assert from 'node:assert/strict';
    const {Client}=await import(${JSON.stringify('file://' + join(f.output, 'node/index.js'))});
    let body='{"entry":{"id":"abc"}}';
    const client=new Client({baseUrl:'https://example.invalid',transport:async()=>new Response(body)});
    assert.equal((await client.api.readValue()).data.entry.id,'abc');
    body='{"entry":{}}';
    await assert.rejects(client.api.readValue(),e=>e.kind==='protocol' && /entry.id/.test(e.cause.message));
  `;
  run(process.execPath, ['--input-type=module', '-'], nodeProgram);
  const phpProgram = `<?php
    require $argv[1].'/src/Runtime.php'; require $argv[1].'/src/Client.php';
    $body='{"entry":{"id":"abc"}}';
    $client=new Example\\Compiled\\Client(new Example\\Compiled\\ClientOptions('https://example.invalid', transport:function($r)use(&$body){return ['status'=>200,'headers'=>[],'body'=>$body];}));
    if($client->api->readValue()->data->get('entry')->id!=='abc')exit(2);
    $body='{"entry":{}}';
    try{$client->api->readValue();exit(3);}catch(Example\\Compiled\\SdkError $e){if($e->kind!=='protocol'||!str_contains($e->getPrevious()->getMessage(),'entry.id'))throw $e;}
  `;
  const script = join(f.dir, 'consumer.php');
  writeFileSync(script, phpProgram);
  run('php', [script, join(f.output, 'php')]);
});

test('compiled target plans are deterministic, preserve source contracts, and name real PHP classes', () => {
  const f = fixture('target-plan');
  const source = structuredClone(f.contract);
  const a = compileSdkContract(f.contract),
    b = compileSdkContract(f.contract);
  assert.deepEqual(a, b);
  assert.deepEqual(f.contract, source);
  assert.equal(a.plan.php.runtime.operations[0].responses['200'].model, 'ApiReadValueResponse200');
  assert.equal(a.plan.node.operations.readValue.inputRequired, false);
  assert.equal(
    a.plan.php.models.find((m) => m.name === 'ApiReadValueResponse200').constructorType,
    'array|object',
  );
});

test('bounded inclusion cases distinguish declarations, runtime guarantees, and uncertainty', () => {
  const dictionary = { type: 'object', required: ['id'], additionalProperties: { type: 'string' } };
  const declared = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] };
  const plan = compileResponsePlan;
  for (const wrap of [
    (s) => s,
    (s) => ({ type: 'array', items: s }),
    (s) => ({ type: 'object', properties: { value: s }, required: ['value'] }),
    (s) => ({ type: 'object', additionalProperties: s }),
  ]) {
    const relaxed = structuredClone(mixed);
    delete relaxed.additionalProperties.required;
    assert.equal(
      addedResultFits([plan(wrap(mixed))], plan(wrap(relaxed)), 'result').result,
      'incompatible',
    );
    assert.equal(
      addedResultFits([plan(wrap(mixed))], plan(wrap(mixed)), 'result').result,
      'compatible',
    );

    assert.equal(
      addedResultFits([plan(wrap(declared))], plan(wrap(dictionary)), 'result').result,
      'incompatible',
    );
    assert.equal(
      addedResultFits(
        [plan(wrap(dictionary))],
        plan(wrap({ ...dictionary, required: [] })),
        'result',
      ).result,
      'incompatible',
    );
    assert.equal(
      addedResultFits([plan(wrap(dictionary))], plan(wrap(dictionary)), 'result').result,
      'compatible',
    );
  }
  assert.equal(
    addedResultFits([plan({ type: 'string' })], plan({ type: 'number' }), 'result').result,
    'compatible',
  );
  assert.equal(
    addedResultFits([undefined], plan({ type: 'null' }), 'result').result,
    'incompatible',
  );
  assert.equal(
    addedResultFits([plan({ type: 'null' })], undefined, 'result').result,
    'incompatible',
  );
  assert.equal(
    addedResultFits(
      [plan({ type: 'string' }), plan({ type: 'boolean' })],
      plan({ type: 'object' }),
      'result',
    ).result,
    'unresolved',
  );
});

test('legacy records retain their historical uncertainty and baseline through repeated regeneration', () => {
  const f = fixture('legacy-record', mixed, ['node']);
  generate(f.contract, f.output);
  const path = join(f.output, '.sdk-generator.json');
  const record = readRecord(path);
  delete record.compiled;
  record.recordVersion = 1;
  writeFileSync(path, JSON.stringify(record));
  const next = structuredClone(f.contract);
  next.config.version = '1.0.1';
  assert.ok(
    preview(next, f.output).compatibility.some(
      (c) => c.subject === 'compiled contract' && c.severity === 'review',
    ),
  );
  generate(next, f.output);
  generate(next, f.output);
  const updated = readRecord(path);
  assert.equal(updated.recordVersion, 2);
  assert.equal(updated.compiled.plan.format, 1);
  assert.equal(updated.comparisonBase.config.version, '1.0.0');
  assert.equal(updated.compiledComparisonBase, undefined);
  assert.ok(updated.compatibility.some((c) => c.subject === 'compiled contract'));
  assert.deepEqual(updated.sources, record.sources);
});

test('saved compiled guarantees detect an upgrade that identical source schemas cannot describe', () => {
  const f = fixture('saved-guarantee', mixed, ['node']);
  generate(f.contract, f.output);
  const path = join(f.output, '.sdk-generator.json');
  const record = readRecord(path);
  // Simulate a historical compiler promising an additional response guarantee.
  record.compiled.plan.responses.readValue['200'].body.runtime.required.push('historical');
  writeFileSync(path, JSON.stringify(record));
  assert.ok(
    preview(f.contract, f.output).compatibility.some(
      (c) => c.severity === 'breaking' && c.subject.endsWith('.historical'),
    ),
  );
  generate(f.contract, f.output);
  generate(f.contract, f.output);
  const updated = readRecord(path);
  assert.ok(
    updated.compiledComparisonBase.plan.responses.readValue['200'].body.runtime.required.includes(
      'historical',
    ),
  );
  assert.ok(updated.compatibility.some((c) => c.subject.endsWith('.historical')));
});

test('runtime identity changes retain review even when compiled value guarantees are equal', () => {
  const f = fixture('runtime-identity', mixed, ['node']);
  generate(f.contract, f.output);
  const path = join(f.output, '.sdk-generator.json');
  const record = readRecord(path);
  assert.equal(preview(f.contract, f.output).compatibility.length, 0);
  record.compiled.runtimeIdentity.node = 'f'.repeat(64);
  writeFileSync(path, JSON.stringify(record));
  assert.ok(
    preview(f.contract, f.output).compatibility.some(
      (c) => c.subject === 'runtime' && c.severity === 'review',
    ),
  );
});

test('unsupported compiled formats are diagnosed without rewriting the prior record', () => {
  const f = fixture('future-record', mixed, ['node']);
  generate(f.contract, f.output);
  const path = join(f.output, '.sdk-generator.json');
  const record = readRecord(path);
  record.compiled.plan.format = 99;
  const original = JSON.stringify(record);
  writeFileSync(path, original);
  assert.throws(() => generate(f.contract, f.output), /Unsupported compiled contract format/);
  assert.equal(readFileSync(path, 'utf8'), original);
});

test('malformed historical plans fail at record ingestion with useful paths', () => {
  const f = fixture('malformed-record');
  generate(f.contract, f.output);
  const path = join(f.output, '.sdk-generator.json');
  const original = readRecord(path);
  for (const mutate of [
    (r) => {
      delete r.compiled.plan.policy.operations.readValue;
    },
    (r) => {
      delete r.compiled.runtimeIdentity.node;
    },
    (r) => {
      r.compiled.plan.runtime.operations[0].responses['200'].variants = { tag: 3 };
    },
    (r) => {
      r.compiled.plan.policy.operations.readValue.input.requiredKeys = [4];
    },
    (r) => {
      r.compiled.plan.php.models[0].codec.value = { kind: 'future' };
    },
    (r) => {
      r.compiled.plan.runtime.operations[0].responses['200'].codec.objectOnlyAlternative = 'yes';
    },
    (r) => {
      r.compiled.plan.node.operations.readValue.inputRequired = 'yes';
    },
    (r) => {
      r.compiled.plan.responses.readValue['200'].body.runtime.extra.kind = 'future';
    },
  ]) {
    const record = structuredClone(original);
    mutate(record);
    const bytes = JSON.stringify(record);
    writeFileSync(path, bytes);
    assert.throws(() => generate(f.contract, f.output), /compiled|expected|guarantee/i);
    assert.equal(readFileSync(path, 'utf8'), bytes);
  }
});

test('all independent payment HTTP fixtures pass in both targets with adapters disabled', async () => {
  const output = join(root, 'no-adapter-payments');
  generate(
    loadContract('tests/fixtures/payment-api.json', 'tests/fixtures/payment-sdk.json'),
    output,
  );
  const js = join(output, 'node/codec-plan.js');
  const nodeSource = readFileSync(js, 'utf8');
  assert.ok(nodeSource.includes('export function compileCodec(schema) {'));
  writeFileSync(
    js,
    nodeSource.replace(
      'export function compileCodec(schema) {',
      'export function compileCodec(schema) { throw new Error("dynamic adapter invoked");',
    ),
  );
  const php = join(output, 'php/src/SchemaAdapter.php');
  const phpSource = readFileSync(php, 'utf8');
  const disabled = phpSource.replace(
    /(public static function compile\(array \$schema\): array\s*\{)/,
    '$1 throw new \\Exception("dynamic adapter invoked");',
  );
  assert.notEqual(disabled, phpSource);
  writeFileSync(php, disabled);
  const results = await validateFixtures(output, 'tests/fixtures/http-cases.json');
  assert.deepEqual(results.map((result) => result.target).sort(), ['node', 'php']);
  const count = JSON.parse(readFileSync('tests/fixtures/http-cases.json')).length;
  assert.ok(results.every((result) => result.scenarios === count));
});

test('saved target signatures and unexplained codec changes cannot bypass historical review', () => {
  const f = fixture('target-history');
  generate(f.contract, f.output);
  const path = join(f.output, '.sdk-generator.json');
  const original = readRecord(path);
  for (const [mutate, expected] of [
    [
      (r) => {
        r.compiled.plan.php.models[0].getters.push({
          field: 'legacy',
          method: 'getLegacy',
          type: 'string',
          doc: 'string',
        });
      },
      (c) => c.severity === 'breaking' && c.subject.endsWith('.getLegacy'),
    ],
    [
      (r) => {
        r.compiled.plan.php.models[0].constructorType = 'string';
      },
      (c) => c.severity === 'review' && c.message.includes('constructor/getter'),
    ],
    [
      (r) => {
        r.compiled.plan.node.operations.readValue.items = 'LegacyItem';
      },
      (c) => c.subject === 'readValue' && c.severity === 'review',
    ],
    [
      (r) => {
        r.compiled.plan.runtime.operations[0].responses['200'].codec.requiredOutput.push('legacy');
      },
      (c) => c.subject === 'compiled codecs' && c.severity === 'review',
    ],
  ]) {
    const record = structuredClone(original);
    mutate(record);
    writeFileSync(path, JSON.stringify(record));
    assert.ok(preview(f.contract, f.output).compatibility.some(expected));
  }
});

test('shared snapshot storage is deterministic, lossless, bounded, and rejects corrupt references', () => {
  const f = fixture('shared-storage', {
    type: 'object',
    properties: Object.fromEntries(
      Array.from({ length: 30 }, (_, index) => ['field' + index, mixed]),
    ),
  });
  generate(f.contract, f.output);
  const record = readRecord(join(f.output, '.sdk-generator.json'));
  const stored = storeCompiledSnapshot(record.compiled);
  assert.deepEqual(storeCompiledSnapshot(record.compiled), stored);
  assert.deepEqual(restoreCompiledSnapshot(stored), record.compiled);
  assert.ok(JSON.stringify(stored).length < JSON.stringify(record.compiled).length);
  for (const corrupted of [
    { ...stored, encoding: 'future' },
    { ...stored, root: { ref: stored.nodes.length } },
    {
      encoding: 'shared-json-v1',
      root: { ref: 0 },
      nodes: [{ kind: 'array', items: [{ ref: 0 }] }],
    },
    {
      encoding: 'shared-json-v1',
      root: { ref: 0 },
      nodes: [
        {
          kind: 'object',
          entries: [
            ['x', 1],
            ['x', 2],
          ],
        },
      ],
    },
  ])
    assert.throws(() => restoreCompiledSnapshot(corrupted), /compiled snapshot/i);
});
