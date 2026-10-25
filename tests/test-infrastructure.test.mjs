import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import { testBatches, runRequired } from './helpers/test-runner.mjs';
import { OutputBaselines, hashEntries, recordFiles } from './helpers/output-baselines.mjs';
import { substituteTemplate } from '../dist/template.js';

test('fast and targeted runs select files before import and preserve the isolated full budget', () => {
  const available = [
    'flint.test.mjs',
    'full-public-spec.test.mjs',
    'full-public-packages.test.mjs',
    'codec.test.mjs',
  ];
  assert.deepEqual(testBatches(available, ['--fast']).batches, [
    ['codec.test.mjs', 'flint.test.mjs'],
    [],
  ]);
  assert.deepEqual(testBatches(available, []).batches, [
    ['codec.test.mjs', 'flint.test.mjs', 'full-public-spec.test.mjs'],
    ['full-public-packages.test.mjs'],
  ]);
  const selected = testBatches(available, [
    'tests/codec.test.mjs',
    '--test-name-pattern=wire',
    '--test-concurrency=2',
  ]);
  assert.deepEqual(selected, {
    flags: ['--test-name-pattern=wire', '--test-concurrency=2'],
    batches: [['codec.test.mjs'], []],
  });
  assert.throws(() => testBatches(available, ['tests/missing.test.mjs']), /Unknown test file/);
  assert.throws(
    () => testBatches(available, ['--fast', 'tests/full-public-packages.test.mjs']),
    /No test files/,
  );
});

test('missing PHP and Composer explain the prerequisite without an ENOENT stack', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sdk-no-tools-'));
  try {
    for (const command of ['php', 'composer'])
      assert.throws(
        () => runRequired(command, ['--version'], { env: { PATH: directory }, stdio: 'ignore' }),
        new RegExp(`Required tool "${command}" was not found.*CONTRIBUTING`),
      );
    const result = spawnSync(process.execPath, [resolve('tests/run.mjs')], {
      cwd: directory,
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Tests: Run tests from the repository root/);
    assert.doesNotMatch(result.stderr, /\n\s+at /);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('output tripwires report every group and added, removed and changed files with hunk previews', () => {
  const manifest = { groups: {}, contents: {} };
  const before = [
    ['changed.php', 'same\nold\nlast'],
    ['removed.js', 'gone'],
  ];
  for (const name of ['one', 'two']) recordFiles(manifest, name, before);
  const checked = new OutputBaselines(manifest);
  checked.check(
    'one',
    [
      ['changed.php', 'same\nnew\nlast'],
      ['added.js', 'new'],
    ],
    hashEntries(before),
  );
  checked.check('two', [['changed.php', 'same\nnext\nlast']], hashEntries(before));
  assert.throws(
    () => checked.finish(),
    (error) => {
      for (const text of [
        '2 groups',
        'one:',
        'two:',
        '~ changed.php',
        '- removed.js',
        '+ added.js',
        '@@ -2,1 +2,1 @@',
        '+ new',
        '+ next',
        'npm run baselines:update',
      ])
        assert.ok(error.message.includes(text), text);
      return true;
    },
  );
  const unchanged = new OutputBaselines(manifest);
  unchanged.check('one', before, hashEntries(before));
  unchanged.finish();
  // File metadata cannot weaken the original aggregate tripwire.
  unchanged.check('one', before, 'incorrect aggregate');
  assert.throws(() => unchanged.finish(), /Aggregate hash changed/);
});

test('template wiring rejects absent and duplicate markers and preserves literal replacements', () => {
  assert.equal(substituteTemplate('a MARK b', 'Runtime.php', [['MARK', '$&']]), 'a $& b');
  for (const source of ['no marker', 'MARK MARK'])
    assert.throws(
      () => substituteTemplate(source, 'Runtime.php', [['MARK', 'wire']]),
      /Template Runtime.php: expected exactly one "MARK", found [02]/,
    );
});

test('test modules defer explicit generation calls until hooks or tests run', () => {
  for (const name of readdirSync('tests').filter((name) => name.endsWith('.test.mjs'))) {
    const file = ts.createSourceFile(
      name,
      readFileSync(join('tests', name), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node) => {
      if (ts.isFunctionLike(node)) return;
      if (ts.isCallExpression(node))
        assert.notEqual(
          node.expression.getText(file),
          'generate',
          name + ': move generation into a before hook or test',
        );
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
});
