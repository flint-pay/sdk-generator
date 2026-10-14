import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import {
  loadContract,
  generate,
  render,
  preview,
  compare,
  prepareRelease,
  validateFixtures,
} from '../dist/index.js';
import { compileSdkContract } from '../dist/target-plan.js';
import { npmPackResult } from '../dist/distribution.js';
import { hash } from '../dist/contract.js';

const todo = { type: 'object', required: ['title'], properties: { title: { type: 'string' } } };
const create = {
  operationId: 'createTodo',
  tags: ['todos'],
  requestBody: { required: true, content: { 'application/json': { schema: todo } } },
  responses: { 200: { description: 'Created', content: { 'application/json': { schema: todo } } } },
};
const settings = {
  version: '1.0.0',
  npm: { name: '@example/todos' },
  composer: { name: 'example/todos', namespace: 'Example\\Todos' },
};

function fixture(t, extraPaths = {}, config = settings) {
  const dir = mkdtempSync(join(tmpdir(), 'sdk-selective-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const api = join(dir, 'api.json');
  const sdk = join(dir, 'sdk.json');
  const doc = {
    openapi: '3.1.0',
    info: { title: 'Synthetic Todos', version: 'v1' },
    paths: { '/todos': { post: structuredClone(create) }, ...extraPaths },
  };
  const cfg = structuredClone(config);
  const save = () => {
    writeFileSync(api, JSON.stringify(doc));
    writeFileSync(sdk, JSON.stringify(cfg));
  };
  const load = () => {
    save();
    return loadContract(api, sdk);
  };
  return { dir, api, sdk, doc, cfg, save, load, output: join(dir, 'sdk') };
}

test('include skips unnamed operations before resolving unsupported input in both targets', async (t) => {
  const unsupported = {
    parameters: [{ name: 'session', in: 'cookie', schema: { type: 'string' } }],
    responses: { 200: { content: { 'application/xml': { schema: { type: 'object' } } } } },
  };
  const f = fixture(t, {
    '/unnamed': { get: unsupported },
    '/empty-id': { get: { ...unsupported, operationId: '' } },
    '/named': { get: { ...unsupported, operationId: 'getUnsupported' } },
    '/external': { $ref: './external.json#/item' },
  });
  writeFileSync(join(f.dir, 'external.json'), JSON.stringify({ item: { get: unsupported } }));
  assert.throws(() => f.load(), /add an operationId.*include.*hidden and audiences/);
  f.cfg.audiences = ['public'];
  f.cfg.operations = { createTodo: { audiences: ['public'] } };
  assert.throws(() => f.load(), /operationId must be a nonempty string/);
  f.cfg.include = ['createTodo'];
  const contract = f.load();
  assert.deepEqual(
    contract.operations.map((op) => op.id),
    ['createTodo'],
  );
  assert.deepEqual(f.load(), contract, 'selection must be deterministic');
  generate(contract, f.output);
  const cases = join(f.dir, 'cases.json');
  writeFileSync(
    cases,
    JSON.stringify([
      {
        name: 'selected JSON operation',
        operation: 'createTodo',
        input: { body: { title: 'Synthetic task' } },
        baseUrl: 'https://example.invalid',
        expected: {
          method: 'POST',
          path: '/todos',
          headers: { 'content-type': 'application/json' },
          body: '{"title":"Synthetic task"}',
        },
        responses: [{ status: 200, body: '{"title":"Synthetic task"}' }],
        data: { title: 'Synthetic task' },
      },
    ]),
  );
  assert.deepEqual(await validateFixtures(f.output, cases), [
    { target: 'node', scenarios: 1 },
    { target: 'php', scenarios: 1 },
  ]);
});

test('selection retains unknown include and duplicate operation ID diagnostics', (t) => {
  const f = fixture(t, { '/duplicate': { get: { ...create } } });
  f.cfg.include = ['createTodo'];
  assert.throws(() => f.load(), /operationId must be unique/);
  f.cfg.include = ['missing'];
  assert.throws(() => f.load(), /operation ID "missing" is not in the contract/);
});

test('overrides replace existing values and explain why adding an operation ID fails', (t) => {
  const f = fixture(t, { '/unnamed': { get: { responses: { 204: { description: 'Empty' } } } } });
  f.cfg.overrides = { '/paths/~1unnamed/get/operationId': 'getTodo' };
  assert.throws(
    () => f.load(),
    /override pointer does not exist; overrides replace existing values only/,
  );
  f.doc.paths['/unnamed'].get.operationId = 'original';
  f.cfg.include = ['getTodo'];
  assert.deepEqual(
    f.load().operations.map((op) => op.id),
    ['getTodo'],
  );
});

for (const target of ['node', 'php']) {
  test(`${target}-only output omits unselected metadata while preserving saved-record compatibility`, (t) => {
    const config = { version: '1.0.0', targets: [target] };
    const selected = target === 'node' ? 'npm' : 'composer';
    const absent = target === 'node' ? 'composer' : 'npm';
    config[selected] = settings[selected];
    const f = fixture(t, {}, config);
    const contract = f.load();
    const placeholder =
      absent === 'composer'
        ? { name: 'unused/sdk', namespace: 'UnusedSdk' }
        : { name: 'unused-sdk' };
    assert.deepEqual(contract.config[absent], placeholder);
    const effective = spawnSync(process.execPath, ['dist/cli.js', 'effective', f.api, f.sdk], {
      encoding: 'utf8',
    });
    assert.ifError(effective.error);
    assert.equal(effective.status, 0, effective.stderr);
    assert.equal(Object.hasOwn(JSON.parse(effective.stdout).config, absent), false);
    generate(contract, f.output);
    const recordPath = join(f.output, '.sdk-generator.json');
    const record = JSON.parse(readFileSync(recordPath, 'utf8'));
    assert.deepEqual(record.interface.config[absent], placeholder);

    // Removing placeholders is harmless to compilation, but source comparison
    // classifies it as a package identity change. Preserve the record shape.
    const historical = structuredClone(contract);
    const withoutPlaceholder = structuredClone(contract);
    delete withoutPlaceholder.config[absent];
    assert.deepEqual(
      compileSdkContract(historical).plan,
      compileSdkContract(withoutPlaceholder).plan,
    );
    assert.ok(
      compare(historical, withoutPlaceholder).some(
        (finding) => finding.subject === absent && finding.severity === 'breaking',
      ),
    );
    assert.deepEqual(compare(historical, contract), []);
    assert.deepEqual(render(historical), render(contract));
    for (const recordVersion of [1, 2]) {
      const older = { ...record, recordVersion, interface: historical };
      if (recordVersion === 1) delete older.compiled;
      writeFileSync(recordPath, JSON.stringify(older));
      const inspection = preview(contract, f.output);
      assert.deepEqual(inspection.changes, []);
      assert.equal(
        inspection.compatibility.some((finding) => finding.severity === 'breaking'),
        false,
      );
    }
    generate(contract, f.output);
    assert.deepEqual(JSON.parse(readFileSync(recordPath)).interface.config[absent], placeholder);
    const plan = prepareRelease(f.output, join(f.dir, 'release'));
    assert.equal(plan.packages[absent], null);
    assert.equal(Object.hasOwn(plan, absent), false);
    assert.equal(Object.hasOwn(plan, selected), true);
    assert.equal(plan.publication.length, target === 'node' ? 1 : 0);
    assert.deepEqual(JSON.parse(readFileSync(join(f.dir, 'release/release-plan.json'))), plan);
    delete f.cfg[selected];
    assert.throws(
      () => f.load(),
      new RegExp('config/' + selected + ': required for the ' + target),
    );
  });

  test(`${target} reports unsupported-only request media immediately and preserves supported selection`, (t) => {
    const f = fixture(
      t,
      {
        '/health': {
          get: { operationId: 'getHealth', responses: { 204: { description: 'Healthy' } } },
        },
      },
      { ...settings, targets: [target] },
    );
    const body = f.doc.paths['/todos'].post.requestBody;
    for (const media of [
      'multipart/form-data',
      'application/xml',
      'application/x-www-form-urlencoded',
    ]) {
      body.content = { [media]: { schema: todo } };
      for (const operations of [undefined, { createTodo: { requestMediaType: media } }]) {
        f.cfg.operations = operations;
        assert.throws(
          () => f.load(),
          /requestBody declares no supported media type;.*application\/json.*application\/merge-patch\+json.*include or operations.createTodo.hidden/,
        );
      }
    }
    f.cfg.operations = { createTodo: { hidden: true } };
    assert.deepEqual(
      f.load().operations.map((op) => op.id),
      ['getHealth'],
    );
    f.cfg.operations = undefined;
    f.cfg.include = ['getHealth'];
    assert.deepEqual(
      f.load().operations.map((op) => op.id),
      ['getHealth'],
    );
    delete f.cfg.include;
    body.content['application/json'] = { schema: todo };
    assert.equal(f.load().operations[0].mediaType, 'application/json');
    body.content['application/merge-patch+json'] = { schema: todo };
    assert.throws(() => f.load(), /configure operations.createTodo.requestMediaType/);
    for (const media of ['application/json', 'application/merge-patch+json']) {
      f.cfg.operations = { createTodo: { requestMediaType: media } };
      assert.equal(f.load().operations[0].mediaType, media);
    }
    f.cfg.operations.createTodo.requestMediaType = 'application/x-www-form-urlencoded';
    assert.throws(() => f.load(), /unsupported request media type/);
    f.cfg.operations.createTodo.requestMediaType = 'multipart/form-data';
    assert.throws(() => f.load(), /selected media type is not declared/);
  });
}

test('Node archives retain runtime dependencies and only reachable supporting declarations', async (t) => {
  const f = fixture(t, {}, { version: '1.0.0', targets: ['node'], npm: settings.npm });
  generate(f.load(), f.output);
  const node = join(f.output, 'node');
  // Regeneration removes the formerly owned declaration without changing the
  // runtime compatibility baseline or disturbing required files.
  const obsolete = readFileSync('dist/package-plan.d.ts', 'utf8');
  writeFileSync(join(node, 'package-plan.d.ts'), obsolete);
  const recordPath = join(f.output, '.sdk-generator.json');
  const record = JSON.parse(readFileSync(recordPath));
  record.files['node/package-plan.d.ts'] = hash(obsolete);
  writeFileSync(recordPath, JSON.stringify(record));
  const inspection = preview(f.load(), f.output);
  assert.deepEqual(
    inspection.changes.map(({ path, kind }) => ({ path, kind })),
    [{ path: 'node/package-plan.d.ts', kind: 'removed' }],
  );
  assert.deepEqual(inspection.compatibility, []);
  generate(f.load(), f.output);
  const packed = spawnSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], {
    cwd: node,
    encoding: 'utf8',
  });
  assert.ifError(packed.error);
  assert.equal(packed.status, 0, packed.stderr);
  const files = npmPackResult(packed.stdout).files.map((file) => file.path);
  assert.equal(files.includes('package-plan.d.ts'), false);
  for (const name of ['package-plan.js', 'php-value-plan.js', 'php-value-plan.d.ts'])
    assert.ok(files.includes(name), name + ' is required');
  const program = ts.createProgram([join(node, 'index.d.ts'), join(node, 'resources/todos.d.ts')], {
    noEmit: true,
    strict: true,
    skipLibCheck: false,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
  });
  assert.deepEqual(
    ts
      .getPreEmitDiagnostics(program)
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')),
    [],
  );
  for (const name of files.filter((file) => file.endsWith('.d.ts') && !file.includes('/')))
    assert.ok(
      program.getSourceFiles().some((file) => file.fileName === join(node, name)),
      name,
    );
  const { Client, serialize } = await import(pathToFileURL(join(node, 'index.js')));
  const { Client: ScopedClient } = await import(pathToFileURL(join(node, 'resources/todos.js')));
  for (const Constructor of [Client, ScopedClient]) {
    const client = new Constructor({
      baseUrl: 'https://example.invalid',
      transport: async () => new Response('{"title":"Synthetic task"}'),
    });
    assert.equal((await client.todos.create({ title: 'Synthetic task' })).title, 'Synthetic task');
  }
  assert.equal(serialize({ title: 'Synthetic task' }, todo), '{"title":"Synthetic task"}');
});
