import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { generateAnalysisPackage } from './helpers/php-runtime-analysis.mjs';

test('generated PHP runtime is analysed at level 5 with an exact existing-debt baseline', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdk-runtime-analysis-'));
  try {
    const output = generateAnalysisPackage(root);
    const config = join(root, 'phpstan.neon');
    writeFileSync(
      config,
      `includes:\n    - ${JSON.stringify(resolve('tests/phpstan/runtime.neon'))}\nparameters:\n    tmpDir: ${JSON.stringify(join(root, 'cache'))}\n`,
    );
    const result = spawnSync(
      'php',
      [
        resolve('.generated/phpstan-vendor/bin/phpstan'),
        'analyse',
        '--no-progress',
        '--memory-limit=512M',
        '--configuration=' + config,
        join(output, 'php/src'),
      ],
      { encoding: 'utf8', timeout: 120000 },
    );
    assert.equal(result.status, 0, result.error?.message ?? result.stdout + result.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
