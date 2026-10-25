import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  mkdirSync,
  existsSync,
  readdirSync,
  closeSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Ajv from 'ajv/dist/2020.js';
import { pathToFileURL } from 'node:url';
import {
  loadContract,
  generate,
  render,
  initialConfig,
  prepareRelease,
  validateFixtures,
} from '../dist/index.js';
import {
  cleanupInterruptedGeneration,
  acquireGenerationLock,
  withGenerationRecovery,
  releaseGenerationLock,
} from '../dist/generation-cleanup.js';
const cli = resolve('dist/cli.js');
const retry = { maxAttempts: 3, statuses: [503], transport: true, baseDelayMs: 0 };
const idempotency = {
  header: 'Idempotency-Key',
  retention: '24 hours (synthetic)',
  scope: 'account and operation',
  auto: true,
};
const pagination = { kind: 'cursor', items: 'items', next: 'next', parameter: 'cursor' };
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'sdk-cli-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const response = {
    description: 'OK',
    content: {
      'application/json': {
        schema: {
          type: 'object',
          required: ['items'],
          properties: {
            items: { type: 'array', items: { type: 'string' } },
            next: { type: ['string', 'null'] },
          },
        },
      },
    },
  };
  const spec = {
    openapi: '3.1.0',
    info: { title: 'Synthetic API', version: '1' },
    paths: {
      '/widgets': {
        post: {
          operationId: 'createWidget',
          tags: ['widgets'],
          parameters: [{ name: 'Idempotency-Key', in: 'header', schema: { type: 'string' } }],
          responses: { 200: response },
        },
        get: {
          operationId: 'listWidgets',
          tags: ['widgets'],
          parameters: [{ name: 'cursor', in: 'query', schema: { type: 'string' } }],
          responses: { 200: response },
        },
      },
    },
  };
  const config = {
    version: '1.0.0',
    requests: { style: 'object' },
    npm: { name: '@synthetic/widgets' },
    composer: { name: 'synthetic/widgets', namespace: 'Synthetic\\Widgets' },
  };
  const api = join(dir, 'api.json'),
    sdk = join(dir, 'sdk.json'),
    output = join(dir, 'out');
  const save = () => {
    writeFileSync(api, JSON.stringify(spec));
    writeFileSync(sdk, JSON.stringify(config));
  };
  const load = (options) => {
    save();
    return loadContract(api, sdk, options);
  };
  const run = (...args) => {
    save();
    return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  };
  return { dir, spec, config, api, sdk, output, save, load, run };
}
test('published config schema accepts defaults, overrides and profile fragments and rejects typos', () => {
  const schema = JSON.parse(readFileSync('sdk-config.schema.json', 'utf8'));
  const validate = new Ajv({ strict: true }).compile(schema);
  for (const config of [
    JSON.parse(readFileSync('examples/library.sdk.json')),
    JSON.parse(readFileSync('tests/fixtures/payment-sdk.json')),
    ...readdirSync('tests/providers/flint')
      .filter((file) => file.endsWith('sdk.json'))
      .map((file) => JSON.parse(readFileSync(join('tests/providers/flint', file)))),
    {
      $schema: './sdk-config.schema.json',
      profiles: ['base.json'],
      defaults: { idempotency, retry, pagination },
      operations: { createWidget: { retry: { maxAttempts: 1 }, pagination: false } },
    },
  ])
    assert.equal(validate(config), true, JSON.stringify(validate.errors));
  for (const config of [
    { operatons: {} },
    { defaults: { retry: { maxAtempts: 2 } } },
    { operations: { createWidget: { idempotency: { haeder: 'Idempotency-Key' } } } },
  ])
    assert.equal(validate(config), false);
  const metadata = JSON.parse(readFileSync('package.json'));
  assert.ok(metadata.files.includes('sdk-config.schema.json'));
  assert.equal(metadata.exports['./sdk-config.schema.json'], './sdk-config.schema.json');
});
test('published schema and loader agree on profile metadata, request defaults and polling intervals', (t) => {
  const validate = new Ajv({ strict: true }).compile(
    JSON.parse(readFileSync('sdk-config.schema.json', 'utf8')),
  );
  const polling = { state: 'next', success: ['done'], failure: ['failed'], intervalMs: 1.5 };
  for (const [name, settings, accepted] of [
    ['partial npm metadata', { npm: { homepage: 'https://example.invalid' } }, true],
    ['partial composer metadata', { composer: { namespace: 'Synthetic\\Widgets' } }, true],
    ['empty request settings', { requests: {} }, true],
    ['fractional polling interval', { operations: { listWidgets: { polling } } }, true],
    [
      'integer polling interval',
      { operations: { listWidgets: { polling: { ...polling, intervalMs: 1 } } } },
      true,
    ],
    ['unknown npm key', { npm: { hompage: 'https://example.invalid' } }, false],
    ['invalid request style', { requests: { style: 'tuple' } }, false],
    [
      'polling interval below minimum',
      { operations: { listWidgets: { polling: { ...polling, intervalMs: 0.5 } } } },
      false,
    ],
    [
      'string polling interval',
      { operations: { listWidgets: { polling: { ...polling, intervalMs: '1.5' } } } },
      false,
    ],
  ]) {
    const f = fixture(t);
    delete f.config.requests;
    writeFileSync(join(f.dir, 'base.json'), JSON.stringify(f.config));
    for (const key of Object.keys(f.config)) delete f.config[key];
    Object.assign(f.config, { profiles: ['base.json'], ...settings });
    assert.equal(validate(f.config), accepted, name + ': ' + JSON.stringify(validate.errors));
    if (accepted) assert.doesNotThrow(() => f.load(), name);
    else assert.throws(() => f.load(), undefined, name);
  }
});
test('SDK defaults resolve independently in both targets and overrides preserve explicit contracts', async (t) => {
  const f = fixture(t);
  f.config.$schema = './sdk-config.schema.json';
  f.config.defaults = { idempotency, retry, pagination };
  f.config.operations = {
    createWidget: { pagination: false, retry: { maxAttempts: 2 } },
    listWidgets: { idempotency: false, retry: { maxAttempts: 1 } },
  };
  const contract = f.load();
  const [create, list] = contract.operations;
  assert.deepEqual(create.idempotency, idempotency);
  assert.deepEqual(create.retry, { ...retry, maxAttempts: 2 });
  assert.equal(create.pagination, undefined);
  assert.equal(list.idempotency, undefined);
  assert.deepEqual(list.retry, { ...retry, maxAttempts: 1 });
  assert.deepEqual(list.pagination, pagination);
  generate(contract, f.output);
  const cases = join(f.dir, 'cases.json');
  writeFileSync(
    cases,
    JSON.stringify([
      {
        name: 'defaults retry mutation with supplied durable key',
        operation: 'createWidget',
        input: {},
        options: { idempotencyKey: 'synthetic-key' },
        expected: {
          method: 'POST',
          path: '/v1/widgets',
          headers: { 'idempotency-key': 'synthetic-key' },
        },
        responses: [
          { status: 503, body: '{}' },
          { status: 200, body: '{"items":["created"]}' },
        ],
        data: { items: ['created'] },
        attempts: 2,
      },
      {
        name: 'override disables retries',
        operation: 'listWidgets',
        input: {},
        expected: { method: 'GET', path: '/v1/widgets' },
        responses: [{ status: 503, body: '{}' }],
        error: { kind: 'server' },
        attempts: 1,
      },
    ]),
  );
  const result = await validateFixtures(f.output, cases);
  assert.equal(result.length, 2);
  const { Client } = await import(pathToFileURL(join(f.output, 'node/index.js')).href);
  let calls = 0;
  const client = new Client({
    baseUrl: 'https://example.invalid',
    transport: async (url) => {
      assert.equal(new URL(url).searchParams.get('cursor'), calls ? 'second' : null);
      return new Response(
        JSON.stringify(
          calls++ ? { items: ['two'], next: null } : { items: ['one'], next: 'second' },
        ),
        { status: 200 },
      );
    },
  });
  const items = [];
  for await (const item of client.widgets.listItems()) items.push(item);
  assert.deepEqual(items, ['one', 'two']);
  assert.equal(calls, 2);
  const php = spawnSync(
    'php',
    [
      '-r',
      String.raw`
require $argv[1].'/src/Runtime.php'; require $argv[1].'/src/Client.php';
$calls=0; $client=new Synthetic\Widgets\Client(new Synthetic\Widgets\ClientOptions(baseUrl:'https://example.invalid',transport:function($request)use(&$calls){
parse_str(parse_url($request['url'],PHP_URL_QUERY)??'', $query);
if(($query['cursor']??null)!==($calls?'second':null))throw new RuntimeException('wrong cursor');
return ['status'=>200,'headers'=>['content-type'=>'application/json'],'body'=>json_encode($calls++ ? ['items'=>['two'],'next'=>null] : ['items'=>['one'],'next'=>'second'])];
})); echo json_encode([iterator_to_array($client->widgets->listItems(),false),$calls]);`,
      join(f.output, 'php'),
    ],
    { encoding: 'utf8' },
  );
  assert.equal(php.status, 0, php.stderr);
  assert.deepEqual(JSON.parse(php.stdout), [['one', 'two'], 2]);
});
test('header typo warnings identify local and inherited config fields and offer candidates', (t) => {
  const f = fixture(t);
  for (const inherited of [false, true]) {
    f.config.defaults = inherited
      ? { idempotency: { ...idempotency, header: 'Idempotency-Kye' } }
      : undefined;
    f.config.operations = {
      createWidget: {
        idempotency: inherited ? { auto: false } : { ...idempotency, header: 'Idempotency-Kye' },
      },
      listWidgets: { idempotency: false },
    };
    const warnings = [];
    f.load({ onWarning: (warning) => warnings.push(warning) });
    assert.equal(warnings.length, 1);
    assert.equal(
      warnings[0].location,
      inherited
        ? 'config/defaults/idempotency/header'
        : 'config/operations/createWidget/idempotency/header',
    );
    assert.match(warnings[0].detail, /Did you mean "Idempotency-Key"/);
    assert.equal(resolve(warnings[0].source), f.sdk);
    const result = f.run('generate', f.api, f.sdk, f.output, '--json');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /Idempotency-Key/);
  }
});
test('diagnostic schema pointers exist and config errors name the actual profile', (t) => {
  const f = fixture(t);
  f.spec.paths['/widgets'].get.responses[200].content[
    'application/json'
  ].schema.properties.items.items.type = 'bogus';
  assert.throws(
    () => f.load(),
    (error) => {
      assert.equal(
        error.location,
        '/paths/~1widgets/post/responses/200/content/application~1json/schema/properties/items/items/type',
      );
      return true;
    },
  );
  f.spec.paths['/widgets'].get.responses[200].content[
    'application/json'
  ].schema.properties.items.items.type = 'string';
  f.config.profiles = ['names.json'];
  writeFileSync(
    join(f.dir, 'names.json'),
    JSON.stringify({ operations: { createWidget: { method: 'class' } } }),
  );
  assert.throws(
    () => f.load(),
    (error) => {
      assert.equal(error.location, 'config/operations/createWidget/method');
      assert.equal(resolve(error.source), join(f.dir, 'names.json'));
      return true;
    },
  );
});
test('naming fallbacks explain their cause and delete is a portable method in both SDKs', async (t) => {
  const f = fixture(t);
  f.spec.paths['/widgets'].get.operationId = 'find_widgets';
  f.spec.paths['/widgets'].get.tags = ['widget-controller'];
  const warnings = [];
  f.load({ onWarning: (warning) => warnings.push(warning) });
  assert.match(
    warnings[0].detail,
    /api.find_widgets.*snake_case.*config\/operations\/find_widgets\/method/,
  );
  delete f.spec.paths['/widgets'].get;
  f.spec.paths['/widgets'].delete = {
    operationId: 'deleteWidget',
    tags: ['widgets'],
    responses: { 204: { description: 'Deleted' } },
  };
  const contract = f.load();
  assert.equal(contract.operations.find((op) => op.id === 'deleteWidget').method, 'delete');
  generate(contract, f.output);
  const cases = join(f.dir, 'delete.json');
  writeFileSync(
    cases,
    JSON.stringify([
      {
        name: 'portable delete',
        operation: 'deleteWidget',
        input: {},
        expected: { method: 'DELETE', path: '/v1/widgets' },
        responses: [{ status: 204, body: '' }],
        empty: true,
      },
    ]),
  );
  assert.equal((await validateFixtures(f.output, cases)).length, 2);
});
test('JSON diagnosis failures use stdout and generation errors have stable codes and relative paths', (t) => {
  const f = fixture(t);
  f.config.version = 'invalid';
  const result = f.run('diagnose', f.api, f.sdk, '--json');
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  assert.equal(JSON.parse(result.stdout).code, 'INVALID_CONFIG');
  f.config.version = '1.0.0';
  generate(f.load(), f.output);
  writeFileSync(join(f.output, 'node/index.js'), '// hand edit');
  const conflict = f.run('generate', f.api, f.sdk, f.output, '--json');
  const report = JSON.parse(conflict.stderr);
  assert.equal(report.code, 'OUTPUT_CONFLICT');
  assert.equal(
    report.diagnostics.some((finding) => finding.location.startsWith('/')),
    false,
  );
  assert.equal(report.error.startsWith(f.dir), false);
});
test('JSON previews bound output by omitting diffs unless requested', (t) => {
  const f = fixture(t);
  generate(f.load(), f.output);
  f.spec.paths['/widgets'].get.deprecated = true;
  const plain = f.run('preview', f.api, f.sdk, f.output, '--json');
  const detailed = f.run('preview', f.api, f.sdk, f.output, '--json', '--diff');
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(detailed.status, 0, detailed.stderr);
  assert.ok(JSON.parse(plain.stdout).changes.every((change) => !('diff' in change)));
  assert.ok(JSON.parse(detailed.stdout).diffs.some((diff) => diff.includes('Deprecated')));
  assert.ok(plain.stdout.length < detailed.stdout.length);
});
test('init captures complete security alternatives and force overwrites only regular files', (t) => {
  const f = fixture(t);
  f.spec.components = {
    securitySchemes: {
      Key: { type: 'apiKey', in: 'header', name: 'X-Key' },
      Secret: { type: 'apiKey', in: 'header', name: 'X-Secret' },
    },
  };
  f.spec.security = [{ Key: [], Secret: [] }, { Key: [] }];
  f.save();
  const config = initialConfig(f.api);
  assert.deepEqual(
    Object.values(config.auth.modes).map((mode) => mode.schemes),
    [['Key', 'Secret'], ['Key']],
  );
  const result = f.run('init', f.api, f.sdk, '--force', '--json');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(f.sdk)), config);
});
test('lock precedes planning, stale dead owners recover, private records stay compact, missing records explain recovery', (t) => {
  const f = fixture(t);
  const contract = f.load();
  const lock = f.output + '.sdk-generator.lock';
  writeFileSync(lock, JSON.stringify({ pid: process.pid }));
  const invalid = structuredClone(contract);
  invalid.operations[0].resource = 'class';
  assert.throws(() => generate(invalid, f.output), /another generation is running/);
  const dead = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], {
    encoding: 'utf8',
  });
  const pid = Number(dead.stdout.trim());
  const stage = f.output + '.stage-00000000-0000-4000-8000-000000000000';
  const backup = f.output + '.backup-00000000-0000-4000-8000-000000000000';
  mkdirSync(stage);
  mkdirSync(backup);
  writeFileSync(join(backup, 'custom.txt'), 'preserved');
  writeFileSync(lock, JSON.stringify({ pid, stage, backup }));
  generate(contract, f.output);
  assert.equal(readFileSync(join(f.output, 'custom.txt'), 'utf8'), 'preserved');
  assert.equal(existsSync(stage), false);
  assert.equal(existsSync(lock), false);
  const record = readFileSync(join(f.output, '.sdk-generator.json'), 'utf8');
  assert.equal(record.split('\n').length, 2);
  assert.equal(JSON.parse(record).interface.title, 'Synthetic API');
  rmSync(join(f.output, '.sdk-generator.json'));
  assert.throws(
    () => prepareRelease(f.output, join(f.dir, 'release')),
    /private generation record is missing.*restore.*fresh directory/,
  );
  assert.throws(() => generate(contract, f.output), /restore the private.*record/);
});
test(
  'supervised SIGINT and SIGTERM remove owned locks and stages and preserve prior output',
  { timeout: 30000 },
  async (t) => {
    for (const signal of ['SIGINT', 'SIGTERM']) {
      const f = fixture(t);
      // A large copy keeps the worker in the synchronous transaction long enough to interrupt.
      generate(f.load(), f.output);
      mkdirSync(join(f.output, 'custom'));
      writeFileSync(join(f.output, 'custom/preserve.bin'), Buffer.alloc(32 * 1024 * 1024));
      f.save();
      const child = spawn(process.execPath, [cli, 'generate', f.api, f.sdk, f.output], {
        stdio: 'ignore',
      });
      t.after(() => child.kill('SIGKILL'));
      const exited = once(child, 'exit');
      const deadline = Date.now() + 10000;
      const lock = f.output + '.sdk-generator.lock';
      while (!existsSync(lock)) {
        assert.ok(Date.now() < deadline, 'worker did not acquire its lock');
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      child.kill(signal);
      const [code] = await exited;
      assert.equal(code, signal === 'SIGINT' ? 130 : 143);
      assert.equal(existsSync(lock), false);
      assert.ok(existsSync(join(f.output, 'custom/preserve.bin')));
      assert.ok(readdirSync(f.dir).every((name) => !/\.stage-|\.backup-/.test(name)));
    }
  },
);
test('interruption cleanup never removes another worker’s lock or arbitrary sibling directories', (t) => {
  const f = fixture(t);
  const lock = f.output + '.sdk-generator.lock';
  writeFileSync(lock, JSON.stringify({ pid: process.pid, stage: f.dir, backup: f.dir }));
  cleanupInterruptedGeneration(f.output, process.pid + 1);
  assert.ok(existsSync(lock));
  cleanupInterruptedGeneration(f.output, process.pid);
  assert.ok(existsSync(f.dir));
  assert.equal(existsSync(lock), false);
});

test(
  'supervisor cleanup serializes stale recovery while paused before removing a stage',
  { timeout: 30000 },
  async (t) => {
    const f = fixture(t);
    f.save();
    const dead = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], {
      encoding: 'utf8',
    });
    const pid = Number(dead.stdout.trim());
    const lock = f.output + '.sdk-generator.lock';
    const stage = f.output + '.stage-00000000-0000-4000-8000-000000000000';
    const paused = join(f.dir, 'paused'),
      resume = join(f.dir, 'resume');
    mkdirSync(stage);
    writeFileSync(lock, JSON.stringify({ pid, stage }));
    const cleanupModule = pathToFileURL(resolve('dist/generation-cleanup.js')).href;
    const supervisor = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const [output, stage, paused, resume, pid] = process.argv.slice(1);
    const remove = fs.rmSync;
    fs.rmSync = (path, options) => {
      if (path === stage) {
        fs.writeFileSync(paused, 'ready');
        const deadline = Date.now() + 15000;
        while (!fs.existsSync(resume)) {
          if (Date.now() > deadline) throw new Error('cleanup barrier timed out');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
      }
      return remove(path, options);
    };
    syncBuiltinESMExports();
    const { cleanupInterruptedGeneration } = await import(${JSON.stringify(cleanupModule)});
    cleanupInterruptedGeneration(output, Number(pid));
  `,
        f.output,
        stage,
        paused,
        resume,
        String(pid),
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    t.after(() => supervisor.kill('SIGKILL'));
    let errors = '';
    supervisor.stderr.on('data', (chunk) => {
      errors += chunk;
    });
    const exited = once(supervisor, 'exit');
    const deadline = Date.now() + 10000;
    while (!existsSync(paused)) {
      assert.ok(Date.now() < deadline, 'supervisor did not reach cleanup barrier: ' + errors);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const original = statSync(lock);
    assert.equal(JSON.parse(readFileSync(lock + '.recovery')).pid, supervisor.pid);
    const contender = f.run('generate', f.api, f.sdk, f.output, '--json');
    assert.equal(contender.status, 1, contender.stdout + contender.stderr);
    assert.match(contender.stderr, /another process is recovering/);
    assert.equal(statSync(lock).ino, original.ino);
    assert.ok(existsSync(stage));
    writeFileSync(resume, 'continue');
    assert.equal((await exited)[0], 0, errors);
    assert.equal(existsSync(lock), false);
    assert.equal(existsSync(lock + '.recovery'), false);
    assert.equal(existsSync(stage), false);
    // A subsequent live owner survives late cleanup, and excludes a third generator.
    const fd = acquireGenerationLock(lock, { pid: process.pid });
    try {
      const owned = statSync(lock);
      cleanupInterruptedGeneration(f.output, pid);
      assert.equal(statSync(lock).ino, owned.ino);
      const third = f.run('generate', f.api, f.sdk, f.output, '--json');
      assert.equal(third.status, 1);
      assert.match(third.stderr, /another generation is running/);
      assert.equal(statSync(lock).ino, owned.ino);
    } finally {
      releaseGenerationLock(lock, fd);
      closeSync(fd);
    }
  },
);
test('supervisor respects a recovery lease and retires only its dead worker’s lease', (t) => {
  const f = fixture(t),
    lock = f.output + '.sdk-generator.lock';
  const dead = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], {
    encoding: 'utf8',
  });
  const pid = Number(dead.stdout.trim());
  writeFileSync(lock, JSON.stringify({ pid }));
  withGenerationRecovery(f.output, (cleanup) => {
    const lease = statSync(lock + '.recovery');
    cleanupInterruptedGeneration(f.output, pid);
    assert.ok(existsSync(lock));
    assert.equal(statSync(lock + '.recovery').ino, lease.ino);
    cleanup(pid);
    assert.equal(existsSync(lock), false);
  });
  writeFileSync(lock, JSON.stringify({ pid }));
  writeFileSync(lock + '.recovery', JSON.stringify({ pid }));
  cleanupInterruptedGeneration(f.output, pid);
  assert.equal(existsSync(lock), false);
  assert.equal(existsSync(lock + '.recovery'), false);
});
test('lock release verifies the retired inode and preserves a replacement owner', (t) => {
  const f = fixture(t),
    lock = f.output + '.sdk-generator.lock';
  const original = acquireGenerationLock(lock, { pid: process.pid });
  rmSync(lock);
  const replacement = acquireGenerationLock(lock, { pid: process.pid + 1 });
  try {
    const owned = statSync(lock);
    assert.throws(() => releaseGenerationLock(lock, original), /ownership changed/);
    assert.equal(statSync(lock).ino, owned.ino);
    assert.deepEqual(JSON.parse(readFileSync(lock)), { pid: process.pid + 1 });
    assert.ok(readdirSync(f.dir).every((name) => !name.includes('.release-')));
  } finally {
    releaseGenerationLock(lock, replacement);
    closeSync(original);
    closeSync(replacement);
  }
});

test('unsupported wire features fail with a concrete remedy', (t) => {
  for (const media of ['application/octet-stream', '*/*']) {
    const f = fixture(t);
    f.spec.paths['/widgets'].get.responses = {
      200: { description: 'Unsupported', content: { [media]: { schema: { type: 'string' } } } },
    };
    assert.throws(
      () => f.load(),
      /unsupported response media type.*declare application\/json.*exclude/,
    );
  }
  const defaults = fixture(t);
  defaults.spec.paths['/widgets'].get.responses = { default: { description: 'Unspecified' } };
  assert.throws(() => defaults.load(), /explicit numeric 2xx.*default.*exclude/);
  for (const declaration of [
    { type: 'oauth2', flows: {} },
    { type: 'http', scheme: 'basic' },
  ]) {
    const f = fixture(t);
    f.spec.components = { securitySchemes: { Login: declaration } };
    f.spec.security = [{ Login: [] }];
    assert.throws(
      () => f.load(),
      /OAuth2 and HTTP basic declarations are unsupported.*Select.*exclude/,
    );
  }
  const scopes = fixture(t);
  scopes.spec.components = { securitySchemes: { Bearer: { type: 'http', scheme: 'bearer' } } };
  scopes.spec.security = [{ Bearer: ['read:widgets'] }];
  assert.throws(() => scopes.load(), /empty scope arrays; OAuth scopes are unsupported/);
});

test('defaults validate settings even when operations opt out and null clears inherited optional fields', (t) => {
  const f = fixture(t);
  f.config.defaults = { retry: { ...retry, errors: [{ status: 503, codes: ['BUSY'] }] } };
  f.config.operations = {
    createWidget: { retry: false },
    listWidgets: { retry: { errors: null, maxAttempts: 1 } },
  };
  const contract = f.load();
  assert.equal(contract.operations[0].retry, undefined);
  assert.deepEqual(contract.operations[1].retry, { ...retry, maxAttempts: 1 });
  f.config.defaults.retry.typo = true;
  assert.throws(
    () => f.load(),
    (error) => error.location === 'config/defaults/retry/typo',
  );
});

test('JSON failures keep prior warnings in the single report and diagnose checks runnable examples', (t) => {
  const f = fixture(t);
  f.config.operations = {
    createWidget: {
      idempotency: { ...idempotency, header: 'Idempotency-Kye' },
      example: { undeclared: true },
    },
  };
  const result = f.run('diagnose', f.api, f.sdk, '--json');
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout);
  assert.equal(report.diagnostics[0].location, 'config/operations/createWidget/example');
  assert.match(report.diagnostics[0].message, /provide an input example/);
  assert.match(report.warnings[0].warning, /Did you mean "Idempotency-Key"/);
});

test('CLI lock errors precede even invalid input parsing', (t) => {
  const f = fixture(t);
  f.save();
  writeFileSync(f.api, 'invalid JSON');
  writeFileSync(f.output + '.sdk-generator.lock', JSON.stringify({ pid: process.pid }));
  const result = spawnSync(process.execPath, [cli, 'generate', f.api, f.sdk, f.output, '--json'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).code, 'GENERATION_LOCKED');
  assert.doesNotMatch(result.stderr, /valid JSON/);
});

test('placeholder package warnings cover generate, validate and release', (t) => {
  const f = fixture(t);
  f.config.targets = ['node'];
  f.config.npm.name = '@example/widgets';
  const generated = f.run('generate', f.api, f.sdk, f.output, '--json');
  assert.equal(generated.status, 0, generated.stderr);
  assert.equal(JSON.parse(generated.stderr).code, 'PLACEHOLDER_PACKAGE');
  writeFileSync(join(f.output, 'node/index.js'), 'invalid JavaScript {');
  const validation = f.run('validate', f.output, '--json');
  assert.equal(validation.status, 1);
  assert.ok(
    JSON.parse(validation.stderr).warnings.some(
      (warning) => warning.code === 'PLACEHOLDER_PACKAGE',
    ),
  );
  rmSync(join(f.output, '.sdk-generator.json'));
  const release = f.run('release', f.output, join(f.dir, 'release'), '--json');
  assert.equal(release.status, 1);
  assert.equal(JSON.parse(release.stderr).code, 'GENERATION_RECORD_MISSING');
  assert.ok(
    JSON.parse(release.stderr).warnings.some((warning) => warning.code === 'PLACEHOLDER_PACKAGE'),
  );
});

test('pagination and named authentication typos identify the editable field and nearest candidate', (t) => {
  const f = fixture(t);
  f.config.operations = { listWidgets: { pagination: { ...pagination, parameter: 'cursro' } } };
  assert.throws(
    () => f.load(),
    (error) =>
      error.location === 'config/operations/listWidgets/pagination/parameter' &&
      error.detail.includes('Did you mean "cursor"'),
  );
  delete f.config.operations;
  f.spec.components = { securitySchemes: { KeyAuth: { type: 'http', scheme: 'bearer' } } };
  f.config.auth = { modes: { merchant: { schemes: ['KeyAut'] } } };
  assert.throws(
    () => f.load(),
    (error) =>
      error.location === 'config/auth/modes/merchant/schemes/0' &&
      error.detail.includes('Did you mean "KeyAuth"'),
  );
});
