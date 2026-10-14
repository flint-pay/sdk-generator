import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadContract, generate, validateFixtures } from '../dist/index.js';

const cli = resolve('dist/cli.js');
const commandArguments = {
  diagnose: ['API_JSON', 'SDK_JSON'],
  effective: ['API_JSON', 'SDK_JSON'],
  preview: ['API_JSON', 'SDK_JSON', 'OUTPUT'],
  generate: ['API_JSON', 'SDK_JSON', 'OUTPUT'],
  validate: ['OUTPUT'],
  release: ['OUTPUT', 'RELEASE_DIRECTORY'],
  publish: ['RELEASE_DIRECTORY'],
  'publish-site': ['RELEASE_DIRECTORY', 'WEB_ROOT'],
};
const run = (args, env = process.env) =>
  spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env });
function failure(args, env) {
  const result = run(args, env);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(result.stdout, '');
  const output = JSON.parse(result.stderr);
  assert.equal(typeof output.error, 'string');
  return output.error;
}
function fixture(t, targets = ['php']) {
  const dir = mkdtempSync(join(tmpdir(), 'sdk-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const api = join(dir, 'api.json'),
    sdk = join(dir, 'sdk.json'),
    output = join(dir, 'output');
  const config = {
    version: '1.0.0',
    targets,
    requests: { style: 'object' },
    npm: { name: '@example/todos' },
    composer: { name: 'example/todos', namespace: 'Todos' },
  };
  writeFileSync(
    api,
    JSON.stringify({
      openapi: '3.1.0',
      info: { title: 'Synthetic Todos', version: '1' },
      paths: {
        '/todos': {
          get: {
            operationId: 'listTodos',
            responses: {
              200: {
                description: 'OK',
                content: { 'application/json': { schema: { type: 'string' } } },
              },
            },
          },
        },
      },
    }),
  );
  const emit = () => {
    writeFileSync(sdk, JSON.stringify(config));
    generate(loadContract(api, sdk), output);
  };
  emit();
  return { dir, api, sdk, output, config, emit };
}

test('argument errors name the cause and suggest nearby commands', () => {
  assert.match(failure(['diagnoes']), /unknown command "diagnoes".*Did you mean "diagnose"/);
  assert.doesNotMatch(failure(['completely-unknown']), /Did you mean/);
  assert.match(failure(['--unknown']), /unknown flag "--unknown"/);
  assert.match(
    failure(['diagnose', 'api.json', 'sdk.json', '--unknown']),
    /unknown flag "--unknown"/,
  );
  assert.match(
    failure(['validate', 'output', '--fixtures']),
    /flag "--fixtures" requires a value \(HTTP_CASES_JSON\)/,
  );
  assert.match(
    failure(['publish', 'release', '--confirm-version']),
    /flag "--confirm-version" requires a value \(VERSION\)/,
  );
  assert.match(
    failure(['publish-site', 'release', 'site', '--confirm-version']),
    /flag "--confirm-version" requires a value \(VERSION\)/,
  );
  for (const flag of ['--fixtures', '--confirm-version'])
    assert.match(
      failure(
        flag === '--fixtures' ? ['validate', 'output', flag, ''] : ['publish', 'release', flag, ''],
      ),
      /requires a value/,
    );
  assert.match(failure(['publish', 'release']), /missing required flag --confirm-version VERSION/);
  assert.match(
    failure(['validate', 'output', '--fixtures', 'one.json', '--fixtures', 'two.json']),
    /provided more than once/,
  );
  assert.match(failure(['constructor']), /unknown command/);
});

test('each command reports its missing named argument before reading inputs or writing output', () => {
  for (const [command, names] of Object.entries(commandArguments))
    for (let count = 0; count < names.length; count++)
      assert.ok(
        failure([command, ...names.slice(0, count)]).includes(
          `missing required argument ${names[count]}`,
        ),
      );
});

test('every command rejects empty required paths before reading inputs or writing output', () => {
  for (const [command, names] of Object.entries(commandArguments))
    for (let index = 0; index < names.length; index++) {
      const args = [...names];
      args[index] = '';
      if (command.startsWith('publish')) args.push('--confirm-version', '1.0.0');
      assert.equal(
        failure([command, ...args]),
        `arguments: missing required argument ${names[index]}`,
      );
    }
});

test('fixtures accepts a dash-prefixed filename as its value', (t) => {
  const f = fixture(t, ['node']);
  writeFileSync(
    join(f.dir, '-cases.json'),
    JSON.stringify([
      {
        name: 'synthetic todo',
        operation: 'listTodos',
        input: {},
        expected: { method: 'GET', path: '/v1/todos' },
        responses: [{ status: 200, body: '"ok"' }],
        data: 'ok',
      },
    ]),
  );
  const result = spawnSync(
    process.execPath,
    [cli, 'validate', f.output, '--fixtures', '-cases.json'],
    {
      cwd: f.dir,
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).fixtures, [{ target: 'node', scenarios: 1 }]);
});

test('confirm-version consumes dash-prefixed values and leaves version validation to publication', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sdk-cli-version-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'release-plan.json'), JSON.stringify({ version: '1.0.0' }));
  for (const command of ['publish', 'publish-site'])
    for (const value of ['-version', '--help', '-h', '--'])
      assert.match(
        failure([
          command,
          dir,
          ...(command === 'publish-site' ? [join(dir, 'site')] : []),
          '--confirm-version',
          value,
        ]),
        /confirm the exact reviewed version with --confirm-version/,
      );
  assert.equal(existsSync(join(dir, 'publication.json')), false);
  assert.equal(existsSync(join(dir, 'site')), false);
});

test('every command rejects extra positional arguments before doing work', () => {
  for (const [command, names] of Object.entries(commandArguments)) {
    const args = [command, ...names, 'extra'];
    if (command.startsWith('publish')) args.push('--confirm-version', '1.0.0');
    assert.match(failure(args), /unexpected extra argument "extra"/);
  }
  assert.match(failure(['--version', 'extra']), /unexpected extra argument/);
});

test('global and command help are plain text and describe arguments and side effects', () => {
  for (const flag of ['--help', '-h']) {
    const result = run([flag]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /sdk-generator diagnose API_JSON SDK_JSON/);
    for (const [command, names] of Object.entries(commandArguments)) {
      const result = run([command, flag]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      assert.ok(result.stdout.startsWith(`sdk-generator ${command} ${names.join(' ')}`));
      assert.match(result.stdout, /Arguments:\n/);
      for (const name of names) assert.ok(result.stdout.includes(`  ${name}  `));
      assert.match(result.stdout, /write|written|upload|deploy|caches/i);
    }
  }
  assert.match(run(['validate', '--help']).stdout, /--fixtures HTTP_CASES_JSON/);
  assert.match(run(['release', '--help']).stdout, /--acknowledge-review.*approved: true/);
  assert.match(
    run(['generate', 'missing-api', 'missing-sdk', '--help']).stdout,
    /Refuse hand edits/,
  );
});

test('version prints the generator package version as plain text', () => {
  const result = run(['--version']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, JSON.parse(readFileSync('package.json', 'utf8')).version + '\n');
});

test('missing selected-target tools name the tool, target and configuration alternative', (t) => {
  for (const target of ['php', 'node']) {
    const f = fixture(t, [target]);
    const bin = join(f.dir, 'bin');
    mkdirSync(bin);
    const env = { ...process.env, PATH: bin };
    const runtime = target === 'php' ? 'php' : 'node';
    const packageTool = target === 'php' ? 'composer' : 'npm';
    const assertTool = (tool, args) => {
      const message = failure(args, env);
      assert.ok(message.includes(`required tool "${tool}" was not found for the ${target} target`));
      assert.ok(message.includes(`install ${tool}`));
      assert.ok(message.includes(`targets in SDK_JSON to omit "${target}" and regenerate`));
      assert.doesNotMatch(message, /spawnSync|ENOENT/);
    };
    assertTool(runtime, ['validate', f.output]);
    const binary =
      target === 'php'
        ? spawnSync('php', ['-r', 'echo PHP_BINARY;'], { encoding: 'utf8' })
        : { status: 0, stdout: process.execPath };
    assert.equal(binary.status, 0, binary.stderr);
    symlinkSync(binary.stdout, join(bin, runtime));
    assertTool(packageTool, ['validate', f.output]);
    assertTool(packageTool, ['release', f.output, join(f.dir, 'release')]);
    assert.equal(existsSync(join(f.dir, 'release')), false);
  }
});

test('single-target validation does not require tools from the omitted target', (t) => {
  for (const target of ['php', 'node']) {
    const f = fixture(t, [target]);
    const bin = join(f.dir, 'bin');
    mkdirSync(bin);
    const tools = target === 'php' ? ['php', 'composer'] : ['node', 'npm'];
    for (const tool of tools) {
      const bundledNpm = join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
      const executable =
        tool === 'node'
          ? process.execPath
          : tool === 'npm' && existsSync(bundledNpm)
            ? bundledNpm
            : process.env.PATH.split(delimiter)
                .map((dir) => join(dir, tool))
                .find((path) => existsSync(path));
      assert.ok(executable, `required test tool ${tool} must be installed`);
      symlinkSync(executable, join(bin, tool));
    }
    const result = run(['validate', f.output], { ...process.env, PATH: bin });
    assert.equal(result.status, 0, result.stderr);
    const checks = JSON.parse(result.stdout).checks;
    assert.ok(checks.length > 0);
    assert.ok(
      checks.every(
        (c) =>
          !c.command.startsWith(target === 'php' ? 'node ' : 'php ') &&
          !c.command.startsWith(target === 'php' ? 'npm ' : 'composer '),
      ),
    );
  }
});

test('PHP fixture validation also explains a missing PHP runtime', async (t) => {
  const f = fixture(t);
  const cases = join(f.dir, 'cases.json'),
    bin = join(f.dir, 'empty-bin');
  writeFileSync(
    cases,
    JSON.stringify([
      {
        name: 'synthetic todo',
        operation: 'listTodos',
        input: {},
        expected: { method: 'GET', path: '/v1/todos' },
        responses: [{ status: 200, body: '"ok"' }],
        data: 'ok',
      },
    ]),
  );
  mkdirSync(bin);
  const previous = process.env.PATH;
  process.env.PATH = bin;
  try {
    await assert.rejects(
      validateFixtures(f.output, cases),
      /required tool "php" was not found for the php target/,
    );
  } finally {
    process.env.PATH = previous;
  }
});

test('installed tools still report real validation failures', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.output, 'php/src/Client.php'), '<?php function {');
  const message = failure(['validate', f.output]);
  assert.match(message, /php -l src\/Client.php failed/);
  assert.doesNotMatch(message, /was not found/);
});

test('preview, generate and release report every hand edit without changing generated files', (t) => {
  const f = fixture(t, ['node', 'php']);
  const paths = ['node/README.md', 'php/src/Client.php'];
  for (const path of paths)
    writeFileSync(
      join(f.output, path),
      readFileSync(join(f.output, path), 'utf8') + '\n// synthetic hand edit\n',
    );
  const before = paths.map((p) => readFileSync(join(f.output, p), 'utf8'));
  const record = readFileSync(join(f.output, '.sdk-generator.json'), 'utf8');
  f.config.targets = ['node'];
  writeFileSync(f.sdk, JSON.stringify(f.config));
  for (const args of [
    ['preview', f.api, f.sdk, f.output],
    ['generate', f.api, f.sdk, f.output],
    ['release', f.output, join(f.dir, 'release')],
  ]) {
    const message = failure(args);
    for (const path of paths) assert.ok(message.includes(join(f.output, path)));
    assert.equal((message.match(/generated file was edited/g) ?? []).length, 2);
    assert.deepEqual(
      paths.map((p) => readFileSync(join(f.output, p), 'utf8')),
      before,
    );
    assert.equal(readFileSync(join(f.output, '.sdk-generator.json'), 'utf8'), record);
  }
  assert.equal(existsSync(join(f.dir, 'release')), false);
});

test('release acknowledgment records approval while default preparation remains unapproved', (t) => {
  const f = fixture(t);
  for (const approved of [false, true]) {
    const destination = join(f.dir, 'release-' + approved);
    const result = run([
      'release',
      f.output,
      destination,
      ...(approved ? ['--acknowledge-review'] : []),
    ]);
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.approved, approved);
    assert.deepEqual(
      JSON.parse(readFileSync(join(destination, 'release-plan.json'), 'utf8')),
      plan,
    );
    assert.equal(existsSync(join(destination, 'publication.json')), false);
  }
});

test('release acknowledgment does not bypass semantic version policy', (t) => {
  const f = fixture(t);
  f.config.version = '1.0.1';
  f.config.release = { policy: 'semver' };
  f.config.operations = { listTodos: { method: 'renamed' } };
  f.emit();
  const destination = join(f.dir, 'release');
  assert.match(
    failure(['release', f.output, destination, '--acknowledge-review']),
    /breaking changes require a new major version/,
  );
  assert.equal(existsSync(destination), false);
});
