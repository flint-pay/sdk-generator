import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
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
const transactionOwner = (pid = process.pid) => ({ pid, token: randomUUID() });
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
    responses: { return: 'result' },
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
test('schema accepts nested profile splits while loader enforces merged completeness', (t) => {
  const validate = new Ajv({ strict: true }).compile(
    JSON.parse(readFileSync('sdk-config.schema.json', 'utf8')),
  );
  const f = fixture(t);
  const config = JSON.parse(readFileSync('tests/fixtures/payment-sdk.json', 'utf8'));
  config.npm.repository = { type: 'git', url: 'https://example.invalid/sdk.git', directory: 'sdk' };
  config.auth = {
    modes: { merchant: { schemes: ['bearer'] } },
    shortcuts: { token: { mode: 'merchant', scheme: 'bearer' } },
  };
  const leaves = [];
  const visit = (value, path = []) => {
    for (const [key, child] of Object.entries(value)) {
      const next = [...path, key];
      if (child && typeof child === 'object' && !Array.isArray(child)) visit(child, next);
      else leaves.push([next, child]);
    }
  };
  visit(config);
  const set = (object, path, value) => {
    for (const key of path.slice(0, -1)) object = object[key] ??= {};
    object[path.at(-1)] = value;
  };
  for (const [path, value] of leaves) {
    const base = structuredClone(config);
    let parent = base;
    for (const key of path.slice(0, -1)) parent = parent[key];
    delete parent[path.at(-1)];
    const split = { profiles: ['base.json'] };
    set(split, path, value);
    const root = { profiles: ['split.json'] };
    for (const [name, part] of [
      ['base', base],
      ['split', split],
      ['root', root],
    ]) {
      assert.equal(validate(part), true, path.join('/') + ': ' + JSON.stringify(validate.errors));
      writeFileSync(join(f.dir, name + '.json'), JSON.stringify(part));
    }
    assert.doesNotThrow(
      () => loadContract(resolve('tests/fixtures/payment-api.json'), join(f.dir, 'root.json')),
      path.join('/'),
    );
  }
  assert.ok(leaves.length > 50);
  for (const incomplete of [
    { auth: { shortcuts: {} } },
    { webhook: { header: 'X-Signature' } },
    { apiVersion: { value: '1' } },
    { operations: { getPayment: { polling: { intervalMs: 1 } } } },
  ]) {
    assert.equal(validate(incomplete), true, JSON.stringify(validate.errors));
    writeFileSync(f.sdk, JSON.stringify({ ...config, ...incomplete }));
    assert.throws(() => loadContract(resolve('tests/fixtures/payment-api.json'), f.sdk));
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
        error: { name: 'ServerError' },
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
  writeFileSync(lock, JSON.stringify(transactionOwner()));
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
  writeFileSync(lock, JSON.stringify({ ...transactionOwner(pid), stage, backup }));
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
  const owner = transactionOwner();
  writeFileSync(lock, JSON.stringify({ ...owner, stage: f.dir, backup: f.dir }));
  cleanupInterruptedGeneration(f.output, transactionOwner(process.pid + 1));
  assert.ok(existsSync(lock));
  cleanupInterruptedGeneration(f.output, owner);
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
    const deadOwner = transactionOwner(pid);
    writeFileSync(lock, JSON.stringify({ ...deadOwner, stage }));
    const cleanupModule = pathToFileURL(resolve('dist/generation-cleanup.js')).href;
    const supervisor = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const [output, stage, paused, resume, identity] = process.argv.slice(1);
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
    cleanupInterruptedGeneration(output, JSON.parse(identity));
  `,
        f.output,
        stage,
        paused,
        resume,
        JSON.stringify(deadOwner),
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
    const liveOwner = transactionOwner();
    const fd = acquireGenerationLock(lock, liveOwner);
    try {
      const owned = statSync(lock);
      cleanupInterruptedGeneration(f.output, deadOwner);
      assert.equal(statSync(lock).ino, owned.ino);
      const third = f.run('generate', f.api, f.sdk, f.output, '--json');
      assert.equal(third.status, 1);
      assert.match(third.stderr, /another generation is running/);
      assert.equal(statSync(lock).ino, owned.ino);
    } finally {
      releaseGenerationLock(lock, fd, liveOwner);
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
  const deadOwner = transactionOwner(pid);
  writeFileSync(lock, JSON.stringify(deadOwner));
  withGenerationRecovery(f.output, (cleanup) => {
    const lease = statSync(lock + '.recovery');
    cleanupInterruptedGeneration(f.output, deadOwner);
    assert.ok(existsSync(lock));
    assert.equal(statSync(lock + '.recovery').ino, lease.ino);
    cleanup(deadOwner);
    assert.equal(existsSync(lock), false);
  });
  writeFileSync(lock, JSON.stringify(deadOwner));
  writeFileSync(lock + '.recovery', JSON.stringify(deadOwner));
  cleanupInterruptedGeneration(f.output, deadOwner);
  assert.equal(existsSync(lock), false);
  assert.equal(existsSync(lock + '.recovery'), false);
});
test(
  'same PID with a different transaction token preserves a live generation and its lease',
  { timeout: 30000 },
  async (t) => {
    const f = fixture(t);
    f.save();
    const paused = join(f.dir, 'paused'),
      resume = join(f.dir, 'resume');
    const generator = pathToFileURL(resolve('dist/generate.js')).href;
    const worker = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const [api, config, output, paused, resume] = process.argv.slice(1);
    const mkdir = fs.mkdirSync;
    fs.mkdirSync = (path, options) => {
      const result = mkdir(path, options);
      if (String(path).startsWith(output + '.stage-')) {
        fs.writeFileSync(paused, 'ready');
        const deadline = Date.now() + 20000;
        while (!fs.existsSync(resume)) {
          if (Date.now() > deadline) throw new Error('generation barrier timed out');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
      }
      return result;
    };
    syncBuiltinESMExports();
    const { generateFromInputs, loadContract } = await import(${JSON.stringify(generator)});
    generateFromInputs(() => loadContract(api, config), output);
  `,
        f.api,
        f.sdk,
        f.output,
        paused,
        resume,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    t.after(() => worker.kill('SIGKILL'));
    let errors = '';
    worker.stderr.on('data', (chunk) => {
      errors += chunk;
    });
    const exited = once(worker, 'exit');
    const deadline = Date.now() + 10000;
    while (!existsSync(paused)) {
      assert.ok(Date.now() < deadline, 'generator did not reach stage barrier: ' + errors);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const lock = f.output + '.sdk-generator.lock';
    const record = JSON.parse(readFileSync(lock));
    assert.equal(record.pid, worker.pid);
    assert.match(record.token, /^[a-f0-9-]{36}$/);
    const delayed = transactionOwner(worker.pid);
    mkdirSync(record.backup);
    writeFileSync(join(record.backup, 'preserve.txt'), 'prior output');
    const scratch = lock + '.acquire-' + record.pid + '-' + record.token + '-' + randomUUID();
    writeFileSync(scratch, 'unfinished new transaction record');
    const leaseFd = acquireGenerationLock(lock + '.recovery', record);
    try {
      const before = [lock, lock + '.recovery', record.stage, record.backup].map(
        (path) => statSync(path).ino,
      );
      cleanupInterruptedGeneration(f.output, delayed);
      assert.deepEqual(
        [lock, lock + '.recovery', record.stage, record.backup].map((path) => statSync(path).ino),
        before,
      );
      assert.equal(
        existsSync(f.output),
        false,
        'delayed cleanup must not restore another transaction backup',
      );
      assert.ok(existsSync(scratch));
      const third = f.run('generate', f.api, f.sdk, f.output, '--json');
      assert.equal(third.status, 1);
      assert.match(third.stderr, /another process is recovering/);
    } finally {
      releaseGenerationLock(lock + '.recovery', leaseFd, record);
      closeSync(leaseFd);
    }
    cleanupInterruptedGeneration(f.output, delayed);
    assert.ok(existsSync(record.stage));
    assert.equal(readFileSync(join(record.backup, 'preserve.txt'), 'utf8'), 'prior output');
    const third = f.run('generate', f.api, f.sdk, f.output, '--json');
    assert.equal(third.status, 1);
    assert.match(third.stderr, /another generation is running/);
    // Let the real transaction finish without the synthetic backup/scratch fixture.
    rmSync(record.backup, { recursive: true });
    rmSync(scratch);
    writeFileSync(resume, 'continue');
    assert.equal((await exited)[0], 0, errors);
    assert.ok(existsSync(join(f.output, '.sdk-generator.json')));
    assert.equal(existsSync(lock), false);
  },
);
test('ambiguous legacy transaction owners fail closed', (t) => {
  const f = fixture(t);
  const contract = f.load(),
    lock = f.output + '.sdk-generator.lock';
  const stage = f.output + '.stage-' + randomUUID(),
    backup = f.output + '.backup-' + randomUUID();
  mkdirSync(stage);
  mkdirSync(backup);
  writeFileSync(lock, JSON.stringify({ pid: process.pid, stage, backup }));
  cleanupInterruptedGeneration(f.output, { pid: process.pid });
  cleanupInterruptedGeneration(f.output, transactionOwner());
  assert.ok(existsSync(lock));
  assert.ok(existsSync(stage));
  assert.ok(existsSync(backup));
  assert.equal(existsSync(f.output), false);
  assert.throws(() => generate(contract, f.output), /no valid transaction owner\/token.*inspect/);
});
test('lock release verifies the retired inode and preserves a replacement owner', (t) => {
  const f = fixture(t),
    lock = f.output + '.sdk-generator.lock';
  const originalOwner = transactionOwner();
  const replacementOwner = transactionOwner(process.pid + 1);
  const original = acquireGenerationLock(lock, originalOwner);
  rmSync(lock);
  const replacement = acquireGenerationLock(lock, replacementOwner);
  try {
    const owned = statSync(lock);
    assert.throws(() => releaseGenerationLock(lock, original, originalOwner), /ownership changed/);
    assert.equal(statSync(lock).ino, owned.ino);
    assert.deepEqual(JSON.parse(readFileSync(lock)), replacementOwner);
    assert.ok(readdirSync(f.dir).every((name) => !name.includes('.release-')));
  } finally {
    releaseGenerationLock(lock, replacement, replacementOwner);
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
  writeFileSync(f.output + '.sdk-generator.lock', JSON.stringify(transactionOwner()));
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

test('path naming lint is a diagnose error and explained overrides remain possible', (t) => {
  const f = fixture(t);
  f.config.operationNames = 'path';
  f.config.operations = { createWidget: { method: 'invent' } };
  let result = f.run('diagnose', f.api, f.sdk, '--json');
  assert.equal(result.status, 1);
  assert.match(result.stdout, /namingReason/);
  f.config.operations.createWidget.namingReason = 'Use the domain-specific creation verb.';
  assert.equal(f.run('diagnose', f.api, f.sdk, '--json').status, 0);
  f.config.operations.createWidget.namingReason = '  ';
  assert.throws(() => f.load(), /namingReason/);
  f.config.operations = { createWidget: { resource: 'widgets' } };
  assert.throws(() => f.load(), /namingReason/);
  f.config.operations = {};
  f.config.operationNames = 'invalid';
  assert.throws(() => f.load(), /expected tags or path/);
});
test('void and close methods run in both generated targets', async (t) => {
  const f = fixture(t);
  f.config.operationNames = 'path';
  f.spec.paths = Object.fromEntries(
    ['void', 'close', 'delete'].map((verb) => [
      '/v1/widgets/' + verb,
      { post: { operationId: verb + 'Widget', responses: { 204: { description: 'Done' } } } },
    ]),
  );
  const contract = f.load();
  assert.deepEqual(contract.operations.map((op) => op.method).sort(), ['close', 'delete', 'void']);
  generate(contract, f.output);
  const cases = join(f.dir, 'portable-methods.json');
  writeFileSync(
    cases,
    JSON.stringify(
      ['void', 'close', 'delete'].map((verb) => ({
        name: 'portable ' + verb,
        baseUrl: 'https://api.example.invalid',
        operation: verb + 'Widget',
        input: {},
        expected: { method: 'POST', path: '/v1/widgets/' + verb },
        responses: [{ status: 204, body: '' }],
        empty: true,
      })),
    ),
  );
  assert.deepEqual(await validateFixtures(f.output, cases), [
    { target: 'node', scenarios: 3 },
    { target: 'php', scenarios: 3 },
  ]);
  f.spec.paths['/v1/widgets/new'] = {
    post: { operationId: 'newWidget', responses: { 204: { description: 'Done' } } },
  };
  assert.throws(() => f.load(), /reserved|portable/);
});
