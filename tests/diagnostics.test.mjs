import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadContract } from '../dist/contract.js';
import { DiagnosticCollector } from '../dist/diagnostic.js';

const api = JSON.parse(readFileSync('examples/library.openapi.json', 'utf8'));
const config = JSON.parse(readFileSync('examples/library.sdk.json', 'utf8'));
config.requests = { style: 'object' };
function fixture(t, change = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sdk-diagnostics-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const spec = structuredClone(api),
    settings = structuredClone(config);
  change(settings, spec);
  const definition = join(dir, 'api.json'),
    configuration = join(dir, 'sdk.json');
  writeFileSync(definition, JSON.stringify(spec));
  writeFileSync(configuration, JSON.stringify(settings));
  const run = (command = 'diagnose') =>
    spawnSync(process.execPath, [resolve('dist/cli.js'), command, definition, configuration], {
      encoding: 'utf8',
    });
  return { dir, definition, configuration, run };
}
function findings(run) {
  const result = run();
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(result.stdout, '');
  const output = JSON.parse(result.stderr);
  assert.equal(output.valid, false);
  assert.ok(output.error);
  return output.diagnostics;
}

test('diagnose reports invalid version, a misspelled setting and two unknown IDs together', (t) => {
  const f = fixture(t, (c) => {
    c.version = '1.0';
    c.operatons = {};
    c.operations.findBok = {};
    c.operations.missingOperation = {};
  });
  const before = readFileSync(f.configuration, 'utf8');
  const items = findings(f.run);
  assert.equal(items.length, 4);
  const byLocation = Object.fromEntries(items.map((d) => [d.location, d.message]));
  assert.match(byLocation['config/operatons'], /Did you mean "operations"\?.*Valid settings:/);
  assert.match(byLocation['config/version'], /semantic package version/);
  assert.match(
    byLocation['config/operations/findBok'],
    /not in the contract.*Did you mean "findBook"/,
  );
  assert.match(byLocation['config/operations/missingOperation'], /not in the contract/);
  assert.equal(readFileSync(f.configuration, 'utf8'), before);
  assert.deepEqual(findings(f.run), items);
  assert.throws(() => loadContract(f.definition, f.configuration), /config\/operatons/);
});

test('diagnose reports all unknown keys and nested package issues', (t) => {
  const f = fixture(t, (c) => {
    c.operatons = {};
    c.targtes = [];
    c.npm.regsitry = 'https://example.com';
    c.npm.name = '!';
    c.composer.namespace = 'invalid';
  });
  const items = findings(f.run);
  assert.equal(items.length, 5);
  assert.match(
    items.find((d) => d.location === 'config/targtes').message,
    /Did you mean "targets"/,
  );
  assert.match(
    items.find((d) => d.location === 'config/npm/regsitry').message,
    /Did you mean "registry"/,
  );
});

test('missing package settings explain default and explicit targets', (t) => {
  for (const [key, target, alternative] of [
    ['composer', 'php', 'node'],
    ['npm', 'node', 'php'],
  ]) {
    const f = fixture(t, (c) => {
      delete c[key];
    });
    const items = findings(f.run);
    assert.equal(items.length, 1);
    assert.equal(items[0].location, 'config/' + key);
    assert.ok(items[0].message.includes('targets defaults to ["node", "php"]'));
    assert.ok(items[0].message.includes(`targets to ["${alternative}"]`));
    const single = fixture(t, (c) => {
      delete c[key];
      c.targets = [alternative];
    });
    const result = single.run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).valid, true);
    assert.deepEqual(JSON.parse(result.stdout).targets, [alternative]);
    const explicit = fixture(t, (c) => {
      delete c[key];
      c.targets = [target];
    });
    assert.match(findings(explicit.run)[0].message, /required for the/);
  }
});

test('malformed containers produce location diagnostics without dependent exceptions', (t) => {
  const f = fixture(t, (c) => {
    c.targets = 42;
    c.npm = null;
    c.operations = [];
  });
  assert.deepEqual(
    findings(f.run).map((d) => d.location),
    ['config/targets', 'config/npm', 'config/operations'],
  );
});

test('operation inventory follows local path-item references and checks include entries', (t) => {
  const f = fixture(t, (c, spec) => {
    const [path, item] = Object.entries(spec.paths)[0];
    spec['x-path-item'] = item;
    spec.paths[path] = { $ref: '#/x-path-item' };
    c.include = ['findBok', 'anotherTypo'];
    c.version = '1.0';
  });
  const items = findings(f.run);
  assert.equal(items.length, 3);
  assert.match(
    items.find((d) => d.location === 'config/include/0').message,
    /Did you mean "findBook"/,
  );
});

test('unresolved references do not produce misleading unknown-operation findings', (t) => {
  const f = fixture(t, (c, spec) => {
    spec.paths = { '/books': { $ref: './missing.json#/item' } };
    c.version = '1.0';
  });
  const items = findings(f.run);
  assert.ok(items.some((d) => d.location === 'config/version'));
  assert.ok(items.length >= 2);
  assert.ok(items.every((d) => !d.message.includes('not in the contract')));
});

test('diagnose collects independent operation errors', (t) => {
  const f = fixture(t, (c, spec) => {
    const item = Object.values(spec.paths)[0];
    const operation = Object.values(item).find((v) => v.operationId === 'findBook');
    spec.paths['/another-book/{id}'] = {
      get: { ...structuredClone(operation), operationId: 'anotherBook' },
    };
    c.operations.findBook = { resource: 'books', method: 'class' };
    c.operations.anotherBook = { resource: 'books', method: 'class' };
  });
  const items = findings(f.run);
  assert.equal(items.length, 2);
  assert.ok(items.some((d) => d.location.includes('/books/')));
  assert.ok(items.some((d) => d.location.includes('/another-book/')));
});

test('diagnostic collector never swallows programming errors', () => {
  const collector = new DiagnosticCollector(true);
  const error = new TypeError('unexpected');
  assert.throws(
    () =>
      collector.check(() => {
        throw error;
      }),
    (e) => e === error,
  );
});

test('malformed containers do not hide unrelated scalar or spelling errors', (t) => {
  const f = fixture(t, (c) => {
    c.npm = null;
    c.version = '1.0';
    c.operatons = {};
  });
  assert.deepEqual(
    new Set(findings(f.run).map((d) => d.location)),
    new Set(['config/npm', 'config/version', 'config/operatons']),
  );
});

test('nested config fields report independent findings together', (t) => {
  const f = fixture(t, (c) => {
    c.release = { policy: 'bogus', baseUrl: 'not a URL' };
    c.errors = { codePath: '!', detailsPath: '!', requestIdHeader: '\n' };
    c.documentation = { overview: 42, examples: 42, guides: [] };
  });
  assert.equal(findings(f.run).length, 8);
});

test('operation inventory respects external path references, profiles and overrides', (t) => {
  const f = fixture(t, (c, spec) => {
    const [path, item] = Object.entries(spec.paths)[0];
    spec.paths[path] = { $ref: './paths.json#/item' };
    c.version = '1.0';
    c.operations.findBok = {};
  });
  writeFileSync(join(f.dir, 'paths.json'), JSON.stringify({ item: Object.values(api.paths)[0] }));
  assert.equal(findings(f.run).length, 2);
  const local = JSON.parse(readFileSync(f.configuration, 'utf8'));
  writeFileSync(join(f.dir, 'base.json'), JSON.stringify(local));
  writeFileSync(f.configuration, JSON.stringify({ profiles: ['./base.json'] }));
  assert.equal(findings(f.run).length, 2);
  const overridden = fixture(t, (c) => {
    c.operations = { renamedBook: { resource: 'books', method: 'retrieve' } };
    c.overrides = { '/paths/~1books~1{id}/get/operationId': 'renamedBook' };
  });
  const success = overridden.run();
  assert.equal(success.status, 0, success.stderr);
});

test('successful diagnose preserves the compiled contract hash', (t) => {
  const f = fixture(t);
  const expected = loadContract(f.definition, f.configuration);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    valid: true,
    operations: expected.operations.length,
    contractHash: expected.hash,
    targets: ['node', 'php'],
  });
});

test('invalid JSON is a structured fatal diagnostic', (t) => {
  const f = fixture(t);
  writeFileSync(f.configuration, '{broken');
  const items = findings(f.run);
  assert.equal(items.length, 1);
  assert.match(items[0].message, /JSON/);
});

test('diagnose collects errors from independent reachable models', (t) => {
  const f = fixture(t, (c, spec) => {
    spec.components = { schemas: { First: { type: 'bogus' }, Second: { type: 'bogus' } } };
    spec.paths['/books/{id}'].get.responses['200'].content['application/json'].schema = {
      type: 'object',
      properties: {
        first: { $ref: '#/components/schemas/First' },
        second: { $ref: '#/components/schemas/Second' },
      },
    };
  });
  const items = findings(f.run);
  assert.equal(items.length, 2);
  assert.deepEqual(
    new Set(items.map((d) => d.location)),
    new Set(['/components/schemas/First/type', '/components/schemas/Second/type']),
  );
});
