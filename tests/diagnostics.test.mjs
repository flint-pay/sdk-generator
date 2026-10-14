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
    spawnSync(
      process.execPath,
      [resolve('dist/cli.js'), command, definition, configuration, '--json'],
      {
        encoding: 'utf8',
      },
    );
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

test('npm names enforce the 214-character limit including scope', (t) => {
  for (const prefix of ['', '@example/']) {
    const valid = fixture(t, (c) => {
      c.npm.name = prefix + 'a'.repeat(214 - prefix.length);
    });
    assert.doesNotThrow(() => loadContract(valid.definition, valid.configuration));
    const invalid = fixture(t, (c) => {
      c.npm.name = prefix + 'a'.repeat(215 - prefix.length);
    });
    assert.throws(() => loadContract(invalid.definition, invalid.configuration), {
      name: 'Diagnostic',
      message: 'config/npm/name: npm package names must be at most 214 characters, including scope',
    });
    assert.throws(
      () => loadContract(invalid.definition, invalid.configuration, { collectDiagnostics: true }),
      /config\/npm\/name: npm package names must be at most 214 characters, including scope/,
    );
  }
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
  assert.ok(items.some((d) => d.location.startsWith('/paths/~1books~1{id}/')));
  assert.ok(items.some((d) => d.location.startsWith('/paths/~1another-book~1{id}/')));
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

test('invalid JSON reports line and column without quoting input or blaming YAML', (t) => {
  for (const [content, line, column] of [
    ['{\n  "version":\n', 3, 1],
    ['{\n  "version": "1.0.0",\n}', 3, 1],
    ['{\r\n  "version": nope\r\n}', 2, 15],
    ['{\r  "version": "1.0.0",\r}', 3, 1],
    ['{\r  "version": nope\r}', 2, 15],
    ['[\n  true,\n]', 3, 1],
    ['{\n  "example": "synthetic-private-value",\n  "version": NaN\n}', 3, 14],
  ]) {
    const f = fixture(t);
    writeFileSync(f.configuration, content);
    const items = findings(f.run);
    assert.deepEqual(items, [
      {
        location: f.configuration,
        message: `expected valid JSON at line ${line}, column ${column}`,
      },
    ]);
    assert.doesNotMatch(f.run().stderr, /synthetic-private-value/);
  }
});

test('YAML hints depend on the input extension or content', (t) => {
  for (const [name, content] of [
    ['sdk.yaml', '{\n'],
    ['sdk.YML', '{\n'],
    ['sdk.json', 'openapi: 3.1.0\npaths: {}\n'],
  ]) {
    const f = fixture(t);
    const path = join(f.dir, name);
    writeFileSync(path, content);
    const items = findings(() =>
      spawnSync(
        process.execPath,
        [resolve('dist/cli.js'), 'diagnose', f.definition, path, '--json'],
        {
          encoding: 'utf8',
        },
      ),
    );
    assert.equal(items[0].location, path);
    assert.match(items[0].message, /line \d+, column \d+; YAML is not supported/);
  }
});

test('path diagnostic pointers escape slashes and tildes in both CLI and library errors', (t) => {
  const f = fixture(t, (c, spec) => {
    spec.paths['/shelves~archive/{id}'] = spec.paths['/books/{id}'];
    delete spec.paths['/books/{id}'];
    c.operations.findBook.method = 'class';
  });
  const location = '/paths/~1shelves~0archive~1{id}/get/method';
  const items = findings(f.run);
  assert.equal(items[0].location, location);
  assert.throws(
    () => loadContract(f.definition, f.configuration),
    (error) => error.location === location,
  );
});

test('nested schema property and unknown-key locations escape every segment', (t) => {
  for (const [child, suffix] of [
    [{ type: 'bogus' }, 'type'],
    [{ type: 'string', 'a/b~c': true }, 'a~1b~0c'],
    [{ type: 'object', properties: { 'a/b~c': { type: 'bogus' } } }, 'properties/a~1b~0c/type'],
  ]) {
    const f = fixture(t, (c, spec) => {
      spec.paths['/books/{id}'].get.responses['200'].content['application/json'].schema = {
        type: 'object',
        properties: { 'a/b~c': child },
      };
    });
    const location = '/paths/~1books~1{id}/get/responses/200/properties/a~1b~0c/' + suffix;
    assert.throws(
      () => loadContract(f.definition, f.configuration),
      (error) => error.location === location,
    );
    assert.throws(
      () => loadContract(f.definition, f.configuration, { collectDiagnostics: true }),
      (error) => error.findings[0].location === location,
    );
  }
});

test('diagnostic builders escape arbitrary configuration, model and schema keys', (t) => {
  const cases = [
    [
      'config/a~1b~0c',
      (c) => {
        c['a/b~c'] = true;
      },
    ],
    [
      'config/requests/a~1b~0c',
      (c) => {
        c.requests['a/b~c'] = true;
      },
    ],
    [
      'config/responses/a~1b~0c',
      (c) => {
        c.responses = { 'a/b~c': true };
      },
    ],
    [
      'config/operations/a~1b~0c',
      (c) => {
        c.operations['a/b~c'] = {};
      },
    ],
    [
      'config/documentation/guides/a~1b~0c',
      (c) => {
        c.documentation = { guides: { 'a/b~c': 'text' } };
      },
    ],
    [
      'config/models/a~1b~0c',
      (c) => {
        c.models = { 'a/b~c': 'class' };
      },
    ],
    [
      'config/phpFieldClasses/Book/a~1b~0c',
      (c) => {
        c.phpFieldClasses = { Book: { 'a/b~c': 'class' } };
      },
    ],
    [
      'config/overrides/~1a~1b~0c',
      (c) => {
        c.overrides = { '/a/b~c': true };
      },
    ],
    [
      '/components/schemas/a~1b~0c/type',
      (c, spec, response) => {
        c.models = { 'a/b~c': 'CustomBook' };
        spec.components = { schemas: { 'a/b~c': { type: 'bogus' } } };
        response.schema = { $ref: '#/components/schemas/a~1b~0c' };
      },
    ],
    [
      '/paths/~1books~1{id}/get/responses/200/dependentRequired/a~1b~0c',
      (c, spec, response) => {
        response.schema = { type: 'object', dependentRequired: { 'a/b~c': 42 } };
      },
    ],
    [
      '/paths/~1books~1{id}/get/responses/200/content/application~1json/schema/discriminator/mapping/a~1b~0c',
      (c, spec, response) => {
        response.schema = {
          oneOf: [{ type: 'string' }],
          discriminator: { propertyName: 'kind', mapping: { 'a/b~c': 42 } },
        };
      },
    ],
    [
      '/paths/~1books~1{id}/get/responses/200/content/application~1json',
      (c, spec) => {
        spec.paths['/books/{id}'].get.responses['200'].content['application/json'] = null;
      },
    ],
    [
      '/paths/~1books~1{id}/get/parameters/a~1b~0c/type',
      (c, spec) => {
        spec.paths['/books/{id}'].get.parameters.push({
          name: 'a/b~c',
          in: 'query',
          schema: { type: 'bogus' },
        });
      },
    ],
  ];
  for (const [location, change] of cases) {
    const f = fixture(t, (c, spec) =>
      change(c, spec, spec.paths['/books/{id}'].get.responses['200'].content['application/json']),
    );
    assert.throws(
      () => loadContract(f.definition, f.configuration),
      (error) => {
        assert.equal(error.location, location);
        return true;
      },
    );
  }
});

test('escaped reference paths preserve operation and shared-parameter model dependencies', (t) => {
  const f = fixture(t, (c, spec) => {
    const item = spec.paths['/books/{id}'];
    const response = item.get.responses['200'].content['application/json'];
    spec.components = { schemas: { Book: response.schema, Label: { type: 'string' } } };
    response.schema = { $ref: '#/components/schemas/Book' };
    item.parameters = [
      { name: 'label', in: 'query', schema: { $ref: '#/components/schemas/Label' } },
    ];
    spec.paths['/shelves~archive/{id}'] = item;
    delete spec.paths['/books/{id}'];
  });
  const contract = loadContract(f.definition, f.configuration);
  assert.deepEqual(contract.modelDependencies.findBook, ['Book', 'Label']);
});

test('unknown settings list valid keys once per object and keep every spelling suggestion', (t) => {
  const f = fixture(t, (c) => {
    c.operatons = {};
    c.targtes = [];
  });
  const output = JSON.parse(f.run().stderr);
  assert.equal(output.diagnostics.length, 2);
  assert.equal((output.error.match(/Valid settings:/g) ?? []).length, 1);
  assert.equal(output.diagnostics.filter((d) => d.message.includes('Valid settings:')).length, 1);
  assert.match(output.diagnostics[0].message, /Did you mean "operations"/);
  assert.match(output.diagnostics[1].message, /Did you mean "targets"/);
  assert.doesNotMatch(output.error, /swapped/);
});

test('swapped API and SDK paths produce one valid-settings list and a swap hint', (t) => {
  const f = fixture(t);
  for (const command of ['diagnose', 'effective']) {
    const result = spawnSync(
      process.execPath,
      [resolve('dist/cli.js'), command, f.configuration, f.definition, '--json'],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(result.stdout, '');
    const output = JSON.parse(result.stderr);
    assert.match(
      output.error,
      /SDK_JSON looks like an OpenAPI document.*API_JSON and SDK_JSON arguments are swapped/,
    );
    assert.equal((output.error.match(/Valid settings:/g) ?? []).length, 1);
    if (command === 'diagnose') {
      const unknown = output.diagnostics.filter((d) =>
        d.message.startsWith('unsupported setting.'),
      );
      assert.ok(unknown.length > 1);
      assert.equal(unknown.filter((d) => d.message.includes('swapped')).length, 1);
    }
  }
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
