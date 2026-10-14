import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  symlinkSync,
  cpSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname, delimiter } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  loadContract,
  initialConfig,
  generate,
  render,
  preview,
  validate,
  validateFixtures,
  prepareRelease,
  publishRelease,
  publishSite,
  Diagnostic,
  DiagnosticGroup,
} from '../dist/index.js';
import { stable } from '../dist/contract.js';

const cli = resolve('dist/cli.js');
const commandArguments = {
  init: ['API_JSON', 'SDK_JSON'],
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

test('the package exports the documented library API', async () => {
  assert.deepEqual(
    Object.keys(await import('../dist/index.js')).sort(),
    [
      'Diagnostic',
      'DiagnosticGroup',
      'compare',
      'generate',
      'initialConfig',
      'loadContract',
      'prepareRelease',
      'preview',
      'publishRelease',
      'publishSite',
      'render',
      'validate',
      'validateFixtures',
    ].sort(),
  );
});
function failure(args, env) {
  const result = run([args[0], '--json', ...args.slice(1)], env);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(result.stdout, '');
  const output = JSON.parse(result.stderr);
  assert.equal(typeof output.error, 'string');
  return output.error;
}
function fixture(t, targets = ['php'], { generated = true } = {}) {
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
  if (generated) emit();
  return { dir, api, sdk, output, config, emit };
}

test('init writes only the expected minimal config and reports diagnosis and next steps', (t) => {
  const f = fixture(t, ['node', 'php'], { generated: false });
  const result = spawnSync(process.execPath, [cli, 'init', 'api.json', 'sdk.json'], {
    cwd: f.dir,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const config = {
    version: '0.1.0',
    targets: ['node', 'php'],
    npm: { name: '@example/synthetic-todos' },
    composer: { name: 'example/synthetic-todos', namespace: 'Example\\SyntheticTodos' },
  };
  assert.equal(readFileSync(f.sdk, 'utf8'), JSON.stringify(config, null, 2) + '\n');
  assert.deepEqual(readdirSync(f.dir).sort(), ['api.json', 'sdk.json']);
  const diagnosis = run(['diagnose', f.api, f.sdk]);
  assert.equal(diagnosis.status, 0, diagnosis.stderr);
  assert.equal(
    result.stdout,
    'Wrote sdk.json (targets: node, php)\n' +
      diagnosis.stdout +
      'Next: replace the @example/example package names, then run\n' +
      '  sdk-generator generate api.json sdk.json OUTPUT\n',
  );
});

test('initialConfig reuses ASCII naming words and fallbacks without writing files', (t) => {
  const f = fixture(t, ['node', 'php'], { generated: false });
  for (const [title, slug, pascal] of [
    ['  Widgets... & HTTP_API/v2!  ', 'widgets-http-api-v2', 'WidgetsHttpApiV2'],
    ['myHTTPService', 'my-http-service', 'MyHttpService'],
    ['123 Widgets', '123-widgets', 'Sdk123Widgets'],
    ['123', '123', 'Sdk123'],
    ['9HTTPService', '9-http-service', 'Sdk9HttpService'],
    ['Café Über 支付', 'caf-ber', 'CafBer'],
    ['支付 🚀', 'sdk', 'Sdk'],
    ['--- !!!', 'sdk', 'Sdk'],
    ['', 'sdk', 'Sdk'],
    [undefined, 'sdk', 'Sdk'],
  ]) {
    const api = JSON.parse(readFileSync(f.api, 'utf8'));
    api.info.title = title;
    writeFileSync(f.api, JSON.stringify(api));
    const config = initialConfig(f.api, { targets: ['node', 'php'] });
    assert.deepEqual(config, {
      version: '0.1.0',
      targets: ['node', 'php'],
      npm: { name: '@example/' + slug },
      composer: { name: 'example/' + slug, namespace: 'Example\\' + pascal },
    });
    assert.deepEqual(readdirSync(f.dir), ['api.json']);
    writeFileSync(f.sdk, JSON.stringify(config));
    assert.doesNotThrow(() => render(loadContract(f.api, f.sdk)));
    rmSync(f.sdk);
    assert.deepEqual(readdirSync(f.dir), ['api.json']);
  }
});

test('init writes valid digit-leading names for every target selection', (t) => {
  const f = fixture(t, ['node', 'php'], { generated: false });
  const api = JSON.parse(readFileSync(f.api, 'utf8'));
  api.info.title = '123 Widgets';
  writeFileSync(f.api, JSON.stringify(api));
  for (const targets of ['node', 'php', 'node,php']) {
    const result = run(['init', f.api, f.sdk, '--targets', targets, '--json']);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.diagnose.valid, true);
    assert.deepEqual(report.config, initialConfig(f.api, { targets: targets.split(',') }));
    assert.deepEqual(JSON.parse(readFileSync(f.sdk, 'utf8')), report.config);
    rmSync(f.sdk);
  }
});

test('initialConfig bounds package names and keeps whole slug words where possible', (t) => {
  const f = fixture(t, ['node', 'php'], { generated: false });
  for (const [title, slug] of [
    ['a'.repeat(205), 'a'.repeat(205)],
    ['a'.repeat(206), 'a'.repeat(205)],
    ['alpha '.repeat(40), Array(34).fill('alpha').join('-')],
    ['a'.repeat(200) + ' widgets', 'a'.repeat(200)],
    ['a'.repeat(205) + ' widgets', 'a'.repeat(205)],
    ['a'.repeat(206) + ' widgets', 'a'.repeat(205)],
    ['123 widgets '.repeat(30), Array(17).fill('123-widgets').join('-')],
  ]) {
    const api = JSON.parse(readFileSync(f.api, 'utf8'));
    api.info.title = title;
    writeFileSync(f.api, JSON.stringify(api));
    const config = initialConfig(f.api);
    assert.equal(config.npm.name, '@example/' + slug);
    assert.ok(config.npm.name.length <= 214);
    assert.equal(config.composer.name, 'example/' + slug);
    assert.ok(!slug.endsWith('-'));
    writeFileSync(f.sdk, JSON.stringify(config));
    assert.doesNotThrow(() => render(loadContract(f.api, f.sdk)));
  }
});

test('init quotes shell-sensitive paths only in the human generate suggestion', (t) => {
  const f = fixture(t, ['node'], { generated: false });
  for (const [apiName, sdkName, expected] of [
    ['api input.json', 'sdk output.json', "'api input.json' 'sdk output.json'"],
    ["api's.json", "sdk's.json", "'api'\\''s.json' 'sdk'\\''s.json'"],
    [
      'api$(echo unsafe).json',
      'sdk;echo unsafe.json',
      "'api$(echo unsafe).json' 'sdk;echo unsafe.json'",
    ],
  ]) {
    writeFileSync(join(f.dir, apiName), readFileSync(f.api));
    const invoke = (json) =>
      spawnSync(process.execPath, [cli, 'init', apiName, sdkName, ...(json ? ['--json'] : [])], {
        cwd: f.dir,
        encoding: 'utf8',
      });
    const human = invoke(false);
    assert.equal(human.status, 0, human.stderr);
    assert.ok(human.stdout.endsWith(`  sdk-generator generate ${expected} OUTPUT\n`));
    // Ask a POSIX shell to parse the displayed arguments without executing generation.
    const parsed = spawnSync('sh', ['-c', `printf '%s\\n' ${expected}`], {
      cwd: f.dir,
      encoding: 'utf8',
    });
    assert.equal(parsed.status, 0, parsed.stderr);
    assert.equal(parsed.stdout, `${apiName}\n${sdkName}\n`);
    rmSync(join(f.dir, sdkName));
    const json = invoke(true);
    assert.equal(json.status, 0, json.stderr);
    assert.equal(JSON.parse(json.stdout).written, sdkName);
    rmSync(join(f.dir, sdkName));
  }
});

test('init target selection omits unselected metadata and preserves diagnose JSON', (t) => {
  const f = fixture(t, ['node'], { generated: false });
  for (const [option, targets] of [
    ['node', ['node']],
    ['php', ['php']],
    ['node,php', ['node', 'php']],
  ]) {
    const result = run(['init', '--targets', option, f.api, f.sdk, '--json']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    const diagnosis = run(['diagnose', f.api, f.sdk, '--json']);
    assert.equal(diagnosis.status, 0, diagnosis.stderr);
    const config = {
      version: '0.1.0',
      targets,
      ...(targets.includes('node') ? { npm: { name: '@example/synthetic-todos' } } : {}),
      ...(targets.includes('php')
        ? { composer: { name: 'example/synthetic-todos', namespace: 'Example\\SyntheticTodos' } }
        : {}),
    };
    assert.deepEqual(JSON.parse(result.stdout), {
      written: f.sdk,
      config,
      diagnose: JSON.parse(diagnosis.stdout),
    });
    assert.deepEqual(JSON.parse(readFileSync(f.sdk, 'utf8')), config);
    assert.deepEqual(initialConfig(f.api, { targets }), config);
    rmSync(f.sdk);
  }
  const targets = ['node'];
  const config = initialConfig(f.api, { targets });
  targets.push('php');
  assert.deepEqual(config.targets, ['node']);
  for (const invalid of [[], ['node', 'node'], ['ruby']])
    assert.throws(() => initialConfig(f.api, { targets: invalid }), /select node and\/or php/);
});

test('init rejects invalid flags and target values before writing', (t) => {
  const f = fixture(t, ['node'], { generated: false });
  for (const args of [
    ['--unknown'],
    ['--force'],
    ['--targets'],
    ['--targets', ''],
    ['--targets', 'ruby'],
    ['--targets', 'node,node'],
    ['--targets', 'node,'],
    ['--targets', 'php,node'],
    ['--targets', 'node', '--targets', 'php'],
  ]) {
    assert.match(failure(['init', f.api, f.sdk, ...args]), /arguments:/);
    assert.deepEqual(readdirSync(f.dir), ['api.json']);
  }
});

test('init refuses existing files, directories and symlinks without changing them', (t) => {
  const f = fixture(t, ['node'], { generated: false });
  const original = 'synthetic existing config\n';
  writeFileSync(f.sdk, original);
  const refuse = () => {
    const error = failure(['init', f.api, f.sdk]);
    assert.ok(error.includes(f.sdk));
    assert.match(error, /already exists; refusing to overwrite/);
  };
  refuse();
  assert.equal(readFileSync(f.sdk, 'utf8'), original);
  rmSync(f.sdk);
  mkdirSync(f.sdk);
  refuse();
  assert.deepEqual(readdirSync(f.sdk), []);
  rmSync(f.sdk, { recursive: true });
  symlinkSync(join(f.dir, 'absent.json'), f.sdk);
  refuse();
  assert.equal(existsSync(join(f.dir, 'absent.json')), false);
});

test('init keeps the written config and reports the same diagnosis on failure', (t) => {
  const f = fixture(t, ['node'], { generated: false });
  const api = JSON.parse(readFileSync(f.api, 'utf8'));
  api.paths['/todos'].post = api.paths['/todos'].get;
  delete api.paths['/todos'].get;
  api.paths['/todos'].post.requestBody = {
    content: { 'multipart/form-data': { schema: { type: 'object' } } },
  };
  writeFileSync(f.api, JSON.stringify(api));
  for (const json of [false, true]) {
    const result = run(['init', f.api, f.sdk, ...(json ? ['--json'] : [])]);
    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(readFileSync(f.sdk, 'utf8')), initialConfig(f.api));
    const diagnosis = run(['diagnose', f.api, f.sdk, ...(json ? ['--json'] : [])]);
    assert.equal(diagnosis.status, 1);
    if (json) {
      assert.equal(result.stdout, '');
      assert.deepEqual(JSON.parse(result.stderr), {
        written: f.sdk,
        config: initialConfig(f.api),
        diagnose: JSON.parse(diagnosis.stderr),
      });
    } else {
      assert.equal(result.stdout, `Wrote ${f.sdk} (targets: node, php)\n`);
      assert.equal(result.stderr, diagnosis.stderr);
      assert.match(result.stderr, /no supported media type/);
    }
    rmSync(f.sdk);
  }
  assert.deepEqual(readdirSync(f.dir), ['api.json']);
});

test('init uses the existing input diagnostics and does not write unreadable or invalid inputs', (t) => {
  const f = fixture(t, ['node'], { generated: false });
  const valid = JSON.parse(readFileSync(f.api, 'utf8'));
  const existingSdk = join(f.dir, 'existing-sdk.json');
  writeFileSync(existingSdk, JSON.stringify(f.config));
  for (const input of [
    '{\n "openapi":',
    'openapi: 3.1.0',
    'null',
    '[]',
    '{}',
    JSON.stringify({ ...valid, openapi: '2.0' }),
  ]) {
    writeFileSync(f.api, input);
    const diagnosis = run(['diagnose', f.api, existingSdk, '--json']);
    assert.equal(diagnosis.status, 1);
    const error = failure(['init', f.api, f.sdk]);
    assert.equal(error, JSON.parse(diagnosis.stderr).error);
    assert.throws(() => initialConfig(f.api), { message: error });
    assert.equal(existsSync(f.sdk), false);
  }
  rmSync(f.api);
  assert.match(failure(['init', f.api, f.sdk]), /cannot read input/);
  assert.equal(existsSync(f.sdk), false);
});

test('a Node config written by init generates and validates a real package', (t) => {
  const f = fixture(t, ['node'], { generated: false });
  const initialized = run(['init', f.api, f.sdk, '--targets', 'node']);
  assert.equal(initialized.status, 0, initialized.stderr);
  const generated = run(['generate', f.api, f.sdk, f.output]);
  assert.equal(generated.status, 0, generated.stderr);
  const validated = run(['validate', f.output, '--json']);
  assert.equal(validated.status, 0, validated.stderr);
  assert.ok(JSON.parse(validated.stdout).checks.length > 0);
  assert.deepEqual(readdirSync(f.output).sort(), ['.sdk-generator.json', 'node']);
  const metadata = JSON.parse(readFileSync(join(f.output, 'node/package.json'), 'utf8'));
  assert.equal(metadata.name, '@example/synthetic-todos');
  assert.equal(metadata.version, '0.1.0');
});

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
    [cli, 'validate', f.output, '--fixtures', '-cases.json', '--json'],
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
  assert.match(run(['--version', 'extra']).stderr, /unexpected extra argument/);
});

test('global and command help are plain text and describe arguments and side effects', () => {
  for (const flag of ['--help', '-h']) {
    const result = run([flag]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /sdk-generator init API_JSON SDK_JSON/);
    assert.match(result.stdout, /sdk-generator diagnose API_JSON SDK_JSON/);
    for (const [command, names] of Object.entries(commandArguments)) {
      const result = run([command, flag]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      assert.ok(result.stdout.startsWith(`sdk-generator ${command} ${names.join(' ')}`));
      assert.match(result.stdout, /Arguments:\n/);
      for (const name of names) assert.ok(result.stdout.includes(`  ${name}  `));
      assert.match(result.stdout, /write|written|upload|deploy|caches/i);
      assert.ok(
        result.stdout.includes(
          '--json  Print machine-readable JSON (stdout) and JSON errors (stderr).',
        ),
      );
      if (command === 'preview')
        assert.ok(result.stdout.includes('--diff  Print diffs for modified files.'));
    }
  }
  assert.match(run(['validate', '--help']).stdout, /--fixtures HTTP_CASES_JSON/);
  assert.match(run(['init', '--help']).stdout, /--targets node\|php\|node,php/);
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
    const result = run(['validate', f.output, '--json'], { ...process.env, PATH: bin });
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
  assert.match(message, /PHP syntax failed in/);
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
      '--json',
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

function fakeTools(f) {
  const bin = join(f.dir, 'fake-bin');
  mkdirSync(bin);
  const script = `#!${process.execPath}
import {writeFileSync} from 'node:fs';
import {join,basename} from 'node:path';
const args=process.argv.slice(2), tool=basename(process.argv[1]);
if(process.env.SDK_CLI_FAIL_TOOL===tool) { console.error('synthetic tool failure'); process.exit(1); }
if(tool==='npm' && args[0]==='pack') {
  const index=args.indexOf('--pack-destination');
  if(index>=0) writeFileSync(join(args[index+1],'todos-1.0.0.tgz'),'synthetic npm archive');
  console.log(JSON.stringify([{filename:'todos-1.0.0.tgz'}]));
} else if(tool==='composer' && args[0]==='archive') {
  const dir=args.find(a=>a.startsWith('--dir=')).slice(6);
  const file=args.find(a=>a.startsWith('--file=')).slice(7);
  writeFileSync(join(dir,file+'.zip'),'synthetic Composer archive');
} else console.log('synthetic tool success');
`;
  for (const tool of ['npm', 'composer']) {
    const path = join(bin, tool);
    writeFileSync(path, script);
    chmodSync(path, 0o755);
  }
  return { ...process.env, PATH: bin + delimiter + process.env.PATH };
}
function withEnv(env, execute) {
  const previous = process.env.PATH;
  process.env.PATH = env.PATH;
  try {
    return execute();
  } finally {
    process.env.PATH = previous;
  }
}
function jsonSuccess(args, expected, env) {
  const result = run([...args, '--json'], env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, stable(expected) + '\n');
  return result;
}
function jsonFailure(args, execute, env) {
  let error;
  try {
    execute();
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof Error);
  const command = args[0];
  const expected = {
    error: error.message,
    ...(command === 'diagnose'
      ? {
          valid: false,
          diagnostics: (error instanceof DiagnosticGroup
            ? error.findings
            : error instanceof Diagnostic
              ? [error]
              : []
          ).map((f) => ({ location: f.location, message: f.detail })),
        }
      : {}),
  };
  const result = run([...args, '--json'], env);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, stable(expected) + '\n');
  assert.deepEqual(JSON.parse(result.stderr), expected);
}
function casesFile(f) {
  const path = join(f.dir, 'cases.json');
  writeFileSync(
    path,
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
  return path;
}

test('--json preserves every command success byte for byte, including publication receipts', async (t) => {
  const f = fixture(t, ['node', 'php']);
  const env = fakeTools(f);
  const contract = loadContract(f.api, f.sdk);
  render(contract);
  jsonSuccess(['diagnose', f.api, f.sdk], {
    valid: true,
    operations: 1,
    contractHash: contract.hash,
    targets: ['node', 'php'],
  });
  jsonSuccess(['effective', f.api, f.sdk], contract);
  const humanEffective = run(['effective', f.api, f.sdk]);
  assert.equal(humanEffective.stdout, stable(contract) + '\n');
  assert.equal(humanEffective.status, 0);
  const fresh = join(f.dir, 'fresh');
  jsonSuccess(['preview', f.api, f.sdk, fresh], generate(contract, fresh, true));
  assert.equal(existsSync(fresh), false);
  const generated = generate(contract, fresh);
  rmSync(fresh, { recursive: true });
  jsonSuccess(['generate', f.api, f.sdk, fresh], generated);
  const cases = casesFile(f);
  const checks = withEnv(env, () => validate(f.output));
  const fixtures = await validateFixtures(f.output, cases);
  jsonSuccess(['validate', f.output, '--fixtures', cases], { checks, fixtures }, env);
  const directory = join(f.dir, 'release');
  const plan = withEnv(env, () => prepareRelease(f.output, directory));
  rmSync(directory, { recursive: true });
  jsonSuccess(['release', f.output, directory], plan, env);
  const published = publishRelease(directory, '1.0.0', () => ({ status: 0 }));
  rmSync(join(directory, 'publication.json'));
  jsonSuccess(['publish', directory, '--confirm-version', '1.0.0'], published, env);
  jsonSuccess(
    ['publish', directory, '--confirm-version', '1.0.0'],
    publishRelease(directory, '1.0.0', () => {
      throw new Error('receipt must prevent re-publication');
    }),
    env,
  );
  const destination = join(f.dir, 'site');
  const deployed = publishSite(directory, destination, '1.0.0');
  rmSync(destination, { recursive: true });
  rmSync(join(directory, 'site-publication.json'));
  jsonSuccess(
    ['publish-site', directory, destination, '--confirm-version', '1.0.0'],
    deployed,
    env,
  );
});

test('--json preserves every command failure object and serialization', (t) => {
  const f = fixture(t, ['node', 'php']);
  const env = fakeTools(f);
  const directory = join(f.dir, 'release');
  withEnv(env, () => prepareRelease(f.output, directory));
  const publishEnv = { ...env, SDK_CLI_FAIL_TOOL: 'npm' };
  jsonFailure(
    ['publish', directory, '--confirm-version', '1.0.0'],
    () =>
      publishRelease(directory, '1.0.0', () => ({ status: 1, stderr: 'synthetic tool failure\n' })),
    publishEnv,
  );
  const destination = join(f.dir, 'site');
  mkdirSync(destination);
  jsonFailure(
    ['publish-site', directory, destination, '--confirm-version', '1.0.0'],
    () => publishSite(directory, destination, '1.0.0'),
    env,
  );
  const contract = loadContract(f.api, f.sdk);
  writeFileSync(join(f.output, 'node/index.js'), 'export const = ;');
  jsonFailure(['validate', f.output], () => validate(f.output), env);
  for (const command of ['preview', 'generate'])
    jsonFailure([command, f.api, f.sdk, f.output], () =>
      generate(contract, f.output, command === 'preview'),
    );
  jsonFailure(
    ['release', f.output, join(f.dir, 'failed-release')],
    () => prepareRelease(f.output, join(f.dir, 'failed-release')),
    env,
  );
  f.config.version = 'invalid';
  writeFileSync(f.sdk, JSON.stringify(f.config));
  jsonFailure(['diagnose', f.api, f.sdk], () =>
    loadContract(f.api, f.sdk, { collectDiagnostics: true }),
  );
  jsonFailure(['effective', f.api, f.sdk], () => loadContract(f.api, f.sdk));
});

test('human preview and generation summarize first generation and unchanged files', (t) => {
  const f = fixture(t, ['node', 'php']);
  const fresh = join(f.dir, 'new output');
  const expected = `Files: 96 created (node 43, php 53); no previous generation\nCompatibility: not compared; no previous generation\n`;
  for (const flags of [[], ['--diff']]) {
    const result = run(['preview', f.api, f.sdk, fresh, ...flags]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, `Preview of ${fresh} (no files written)\n` + expected);
    assert.ok(Buffer.byteLength(result.stdout) < 2048);
    assert.doesNotMatch(result.stdout, /@@|\+\+\+|Created \(|Diffs \(/);
    assert.equal(existsSync(fresh), false);
  }
  const generated = run(['generate', f.api, f.sdk, fresh]);
  assert.equal(generated.status, 0, generated.stderr);
  assert.equal(generated.stdout, `Generated ${fresh}\n` + expected);
  for (const command of ['preview', 'generate']) {
    const result = run([command, f.api, f.sdk, fresh]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout,
      `${command === 'preview' ? `Preview of ${fresh} (no files written)` : `Generated ${fresh}`}\nFiles: no changes (96 unchanged)\nCompatibility: no findings\n`,
    );
    assert.ok(Buffer.byteLength(result.stdout) < 1024);
  }
  // Relative user paths retain their spelling.
  const relative = spawnSync(
    process.execPath,
    [cli, 'preview', 'api.json', 'sdk.json', './relative output'],
    { cwd: f.dir, encoding: 'utf8' },
  );
  assert.equal(relative.status, 0, relative.stderr);
  assert.ok(relative.stdout.startsWith('Preview of ./relative output (no files written)\n'));
});

test('human regeneration lists sorted paths and every finding; --diff prints only modified library diffs', (t) => {
  const f = fixture(t, ['node', 'php']);
  f.config.targets = ['node'];
  f.config.version = '2.0.0';
  f.config.operations = { listTodos: { method: 'fetch' } };
  writeFileSync(f.sdk, JSON.stringify(f.config));
  const api = JSON.parse(readFileSync(f.api, 'utf8'));
  api.paths['/todos'].get.responses['200'].content['application/json'].schema.type = 'integer';
  writeFileSync(f.api, JSON.stringify(api));
  const contract = loadContract(f.api, f.sdk);
  const plan = preview(contract, f.output);
  const plain = run(['preview', f.api, f.sdk, f.output]);
  assert.equal(plain.status, 0, plain.stderr);
  assert.match(plain.stdout, /Files: 4 created, 12 modified, 57 removed, 27 unchanged\n/);
  assert.match(plain.stdout, /Modified \(12\):\n  node\/README.md\n/);
  assert.match(plain.stdout, /\n  php\/README.md\n/);
  assert.match(plain.stdout, /Compatibility: 6 breaking, 2 review, 0 additive\n/);
  assert.match(
    plain.stdout,
    /  breaking  listTodos: Public method renamed without a compatible alias\n/,
  );
  const expectedFindings = ['breaking', 'review', 'additive'].flatMap((severity) =>
    plan.compatibility
      .filter((f) => f.severity === severity)
      .map((f) => `  ${severity.padEnd(8)}  ${f.subject}: ${f.message}`),
  );
  assert.deepEqual(
    plain.stdout.split('\n').filter((line) => /^  (breaking|review|additive) /.test(line)),
    expectedFindings,
  );
  for (const [label, kind] of [
    ['Created', 'created'],
    ['Modified', 'modified'],
    ['Removed', 'removed'],
  ]) {
    const paths = plan.changes
      .filter((c) => c.kind === kind)
      .map((c) => c.path)
      .sort();
    assert.ok(
      plain.stdout.includes(
        `${label} (${paths.length}):\n${paths.map((p) => '  ' + p).join('\n')}\n`,
      ),
    );
  }
  assert.doesNotMatch(plain.stdout, /@@|\+\+\+/);
  assert.ok(
    plain.stdout.endsWith(
      'Use --diff to show modified-file diffs, or --json for the full report.\n',
    ),
  );
  const diff = run(['preview', f.api, f.sdk, f.output, '--diff']);
  assert.equal(diff.status, 0, diff.stderr);
  assert.match(diff.stdout, /Diffs \(12 modified files\):\n/);
  const libraryDiffs = generate(contract, f.output, true)
    .changes.filter((c) => c.kind === 'modified')
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  assert.ok(diff.stdout.endsWith(libraryDiffs.map((c) => c.diff).join('\n') + '\n'));
  for (const change of libraryDiffs) assert.ok(diff.stdout.includes(`--- a/${change.path}\n`));
  assert.doesNotMatch(diff.stdout, /\/dev\/null|Use --diff/);
  const generated = run(['generate', f.api, f.sdk, f.output]);
  assert.equal(generated.status, 0, generated.stderr);
  assert.equal(
    generated.stdout,
    plain.stdout
      .replace(`Preview of ${f.output} (no files written)`, `Generated ${f.output}`)
      .replace('Use --diff to show modified-file diffs, or --json for the full report.\n', ''),
  );
  // Regeneration preserves the comparison baseline, so unchanged files keep their findings.
  const again = run(['preview', f.api, f.sdk, f.output]);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /\nFiles: no changes \(\d+ unchanged\)\n/);
  assert.match(again.stdout, /\nCompatibility: 6 breaking, 2 review, 0 additive\n/);
  assert.doesNotMatch(again.stdout, /no findings|Use --diff/);
});

test('human validation prints one line per finished check group and fixtures, hiding tool details', (t) => {
  const f = fixture(t, ['node', 'php']);
  const cases = casesFile(f);
  const result = run(['validate', f.output, '--fixtures', cases]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(
    result.stdout,
    `Validating ${f.output}\n` +
      [
        '  passed  node  JavaScript syntax',
        '  passed  node  npm package contents',
        '  passed  node  module and descriptor loading',
        '  passed  node  TypeScript examples (1 file)',
        '  passed  php   PHP syntax (39 files)',
        '  passed  php   Composer metadata',
        '  passed  php   descriptor validation',
        '  passed  node  HTTP fixtures (1 scenario)',
        '  passed  php   HTTP fixtures (1 scenario)',
        'Validation passed: 9 checks (node, php)',
        '',
      ].join('\n'),
  );
  assert.doesNotMatch(result.stdout, /SourceTextModule|"files"|"filename"|"path"/);
});

test('human validation reports a corrupted JavaScript file in a copy with a readable failure', (t) => {
  const f = fixture(t, ['node']);
  const output = join(f.dir, 'corrupt copy');
  cpSync(f.output, output, { recursive: true });
  writeFileSync(join(output, 'node/index.js'), 'export const = ;');
  const result = spawnSync(process.execPath, [cli, 'validate', './corrupt copy'], {
    cwd: f.dir,
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, 'Validating ./corrupt copy\n  FAILED  node  JavaScript syntax\n');
  assert.ok(
    result.stderr.startsWith('error: JavaScript syntax failed in ./corrupt copy/node:\n  '),
  );
  assert.match(result.stderr, /SyntaxError/);
  assert.doesNotMatch(
    result.stderr,
    /import \{ readdirSync|--input-type|for \(const file|arguments:/,
  );
  for (const line of result.stderr.trimEnd().split('\n').slice(1)) assert.ok(line.startsWith('  '));
});

test('human errors and literal --json selection survive argument parsing failures', () => {
  const human = run(['diagnoes']);
  assert.equal(human.status, 1);
  assert.equal(human.stdout, '');
  assert.match(human.stderr, /^error: unknown command "diagnoes".*Did you mean "diagnose"/);
  assert.doesNotMatch(human.stderr, /[{}]|arguments:/);
  for (const args of [
    ['diagnoes', '--json'],
    ['diagnose', '--unknown', '--json'],
    ['diagnose', '--json', '--unknown'],
    ['--help', '--json'],
    ['--version', '--json'],
    ['generate', '--diff', '--json'],
  ]) {
    const result = run(args);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(JSON.parse(result.stderr).error, /arguments: unknown/);
  }
  assert.equal(
    JSON.parse(run(['preview', '--diff', '--json']).stderr).error,
    'arguments: --diff applies to human output; --json already includes every diff',
  );
  const conflict = run(['preview', 'api', 'sdk', 'output', '--diff', '--json']);
  assert.equal(conflict.status, 1);
  assert.equal(conflict.stdout, '');
  assert.deepEqual(JSON.parse(conflict.stderr), {
    error: 'arguments: --diff applies to human output; --json already includes every diff',
  });
  for (const command of Object.keys(commandArguments).filter((c) => c !== 'preview')) {
    const result = run([command, '--diff']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^error: unknown flag "--diff"/);
  }
  const literal = run(['generate', '--', '--json']);
  assert.equal(literal.status, 1);
  assert.match(literal.stderr, /^error: missing required argument SDK_JSON/);
  const repeated = run(['diagnose', '--json', '--json']);
  assert.equal(repeated.status, 1);
  assert.match(JSON.parse(repeated.stderr).error, /provided more than once/);
});

test('human diagnose success and failure list counts and each location and message', (t) => {
  const f = fixture(t, ['node', 'php']);
  const success = run(['diagnose', f.api, f.sdk]);
  assert.equal(success.status, 0, success.stderr);
  assert.equal(
    success.stdout,
    `Valid: 1 operation; targets: node, php; contract hash: ${loadContract(f.api, f.sdk).hash}\n`,
  );
  f.config.version = 'bad';
  f.config.operatons = {};
  writeFileSync(f.sdk, JSON.stringify(f.config));
  const result = run(['diagnose', f.api, f.sdk]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^Invalid: 2 findings\n/);
  assert.match(result.stderr, /\n  config\/version: expected a semantic package version\n/);
  assert.match(result.stderr, /\n  config\/operatons: unsupported setting/);
  const findings = JSON.parse(run(['diagnose', f.api, f.sdk, '--json']).stderr).diagnostics;
  assert.equal(
    result.stderr,
    'Invalid: 2 findings\n' + findings.map((f) => `  ${f.location}: ${f.message}\n`).join(''),
  );
});

test('warnings use human text or the unchanged JSON format on stderr', (t) => {
  const f = fixture(t, ['node']);
  f.config.schemaSharing = 'named';
  writeFileSync(f.sdk, JSON.stringify(f.config));
  const warnings = [];
  loadContract(f.api, f.sdk, { onWarning: (w) => warnings.push(w.message) });
  for (const command of ['diagnose', 'effective', 'preview', 'generate']) {
    const args = [
      command,
      f.api,
      f.sdk,
      ...(['preview', 'generate'].includes(command) ? [f.output] : []),
    ];
    const human = run(args);
    assert.equal(human.status, 0, human.stderr);
    assert.equal(human.stderr, warnings.map((w) => `warning: ${w}\n`).join(''));
    const json = run([...args, '--json']);
    assert.equal(json.status, 0, json.stderr);
    assert.equal(json.stderr, warnings.map((w) => stable({ warning: w }) + '\n').join(''));
  }
});

test('human release and publication formats include review state, receipts and next steps', (t) => {
  const f = fixture(t, ['node', 'php']);
  const env = fakeTools(f);
  const directory = join(f.dir, 'release');
  const result = run(['release', f.output, directory], env);
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(readFileSync(join(directory, 'release-plan.json'), 'utf8'));
  assert.equal(
    result.stdout,
    [
      `Prepared release 1.0.0 in ${directory}. Nothing was published.`,
      'Packages: npm @example/todos, Composer example/todos',
      'Previous version: none',
      'Compatibility: no findings',
      'Review acknowledged: no',
      `Artifacts: release-plan.json, CHANGELOG.md, MIGRATION.md, site/ (${Object.keys(plan.checksums).length} checksummed files)`,
      `Next: sdk-generator publish ${directory} --confirm-version 1.0.0`,
      `      sdk-generator publish-site ${directory} WEB_ROOT --confirm-version 1.0.0`,
      '',
    ].join('\n'),
  );
  const published = run(['publish', directory, '--confirm-version', '1.0.0'], env);
  assert.equal(published.status, 0, published.stderr);
  assert.equal(
    published.stdout,
    `Published 1.0.0 to npm. Receipt: ${directory}/publication.json\nComposer: ${plan.composer}\n`,
  );
  const destination = join(f.dir, 'web');
  const deployed = run(['publish-site', directory, destination, '--confirm-version', '1.0.0'], env);
  assert.equal(deployed.status, 0, deployed.stderr);
  assert.equal(
    deployed.stdout,
    `Deployed site for 1.0.0 to ${destination}. Receipt: ${directory}/site-publication.json\nRun your hosting deployment step to serve it.\n`,
  );
});

test('human release prints prior version, required review, acknowledgment and optional site base URL', (t) => {
  const f = fixture(t);
  const env = fakeTools(f);
  f.config.version = '2.0.0';
  f.config.operations = { listTodos: { method: 'fetch' } };
  f.config.release = { baseUrl: 'https://sdk.example.invalid/' };
  f.emit();
  const directory = join(f.dir, 'php-release');
  const result = run(['release', f.output, directory, '--acknowledge-review'], env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Packages: Composer example\/todos\nPrevious version: 1.0.0\n/);
  assert.match(
    result.stdout,
    /Compatibility: \d+ breaking, \d+ review, \d+ additive; review required\n/,
  );
  assert.match(result.stdout, /Review acknowledged: yes\n/);
  assert.doesNotMatch(result.stdout, /sdk-generator publish /);
  assert.match(result.stdout, /Next: sdk-generator publish-site /);
  const deployed = run(
    ['publish-site', directory, join(f.dir, 'web'), '--confirm-version', '2.0.0'],
    env,
  );
  assert.equal(deployed.status, 0, deployed.stderr);
  assert.match(
    deployed.stdout,
    /\nBase URL: https:\/\/sdk.example.invalid\/\nRun your hosting deployment step to serve it.\n$/,
  );
});

test(
  'human validation streams finished groups before the next tool completes',
  { timeout: 15000 },
  async (t) => {
    const f = fixture(t, ['node']);
    const env = fakeTools(f);
    const waiting = join(f.dir, 'waiting'),
      proceed = join(f.dir, 'proceed');
    writeFileSync(
      join(f.dir, 'fake-bin/npm'),
      `#!${process.execPath}
import {existsSync,writeFileSync} from 'node:fs';
if (process.argv[2] === '--version') { console.log('0.0.0'); process.exit(0); }
writeFileSync(${JSON.stringify(waiting)}, 'waiting');
const deadline = Date.now() + 12000;
while (!existsSync(${JSON.stringify(proceed)}) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
if (!existsSync(${JSON.stringify(proceed)})) process.exit(1);
console.log('[{"filename":"todos-1.0.0.tgz"}]');
`,
    );
    const child = spawn(process.execPath, [cli, 'validate', f.output], { env });
    t.after(() => {
      child.kill();
    });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (data) => {
      stdout += data;
    });
    child.stderr.on('data', (data) => {
      stderr += data;
    });
    const exited = once(child, 'close');
    const deadline = Date.now() + 10000;
    while (!existsSync(waiting) || !stdout.includes('  passed  node  JavaScript syntax\n')) {
      assert.ok(Date.now() < deadline, stdout + stderr);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(stdout, `Validating ${f.output}\n  passed  node  JavaScript syntax\n`);
    writeFileSync(proceed, 'continue');
    const [status] = await exited;
    assert.equal(status, 0, stderr);
    assert.match(stdout, /Validation passed: 4 checks \(node\)\n$/);
  },
);

test('human fixture failures identify the finished failing target group', (t) => {
  const f = fixture(t, ['node', 'php']);
  const cases = casesFile(f);
  const corpus = JSON.parse(readFileSync(cases, 'utf8'));
  corpus[0].data = 'wrong';
  writeFileSync(cases, JSON.stringify(corpus));
  const result = run(['validate', f.output, '--fixtures', cases], fakeTools(f));
  assert.equal(result.status, 1);
  assert.ok(result.stdout.endsWith('  FAILED  node  HTTP fixtures\n'));
  assert.doesNotMatch(result.stdout, /Validation passed:|passed  php   HTTP fixtures/);
  assert.ok(result.stderr.startsWith('error: '));
});

test('human preview lists additive findings after the other severities', (t) => {
  const f = fixture(t, ['node']);
  f.config.operations = {
    listTodos: { method: 'fetch', deprecated: 'Use the new todos operation.' },
  };
  writeFileSync(f.sdk, JSON.stringify(f.config));
  const api = JSON.parse(readFileSync(f.api, 'utf8'));
  api.paths['/new-todos'] = {
    get: { ...structuredClone(api.paths['/todos'].get), operationId: 'newTodos' },
  };
  writeFileSync(f.api, JSON.stringify(api));
  const result = run(['preview', f.api, f.sdk, f.output]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Compatibility: 2 breaking, 1 review, 1 additive\n/);
  assert.deepEqual(
    result.stdout.split('\n').filter((line) => /^  (breaking|review|additive) /.test(line)),
    [
      '  breaking  listTodos: Public method renamed without a compatible alias',
      '  breaking  listTodos: Operation input/response types and capability helper names changed; a method alias does not preserve these exported interfaces.',
      '  review    listTodos: Deprecation notice: Use the new todos operation.',
      '  additive  newTodos: Operation added',
    ],
  );
});

test('a --json flag after an option that consumes "--" still selects JSON errors', () => {
  const missing = join(tmpdir(), 'sdk-cli-missing-output');
  const result = run(['validate', missing, '--fixtures', '--', '--json']);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(JSON.parse(result.stderr).error, /no generated packages found/);
});
