import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const phpstan = spawnSync(
  'composer',
  ['install', '--working-dir=tests/phpstan', '--no-interaction', '--no-progress'],
  { stdio: 'inherit' },
);
if (phpstan.error) throw phpstan.error;
if (phpstan.status !== 0) process.exit(phpstan.status ?? 1);

const directory = new URL('./', import.meta.url);
const budgetTest = 'full-public-packages.test.mjs';
const tests = readdirSync(directory)
  .filter((name) => name.endsWith('.test.mjs') && name !== budgetTest)
  .sort();

// Keep the generation time/RSS budget independent of concurrent test processes.
// Both batches retain every test and the existing performance limits.
for (const batch of [tests, [budgetTest]]) {
  if (!batch.length) continue;
  const result = spawnSync(
    process.execPath,
    [
      '--test',
      ...process.argv.slice(2),
      ...batch.map((name) => fileURLToPath(new URL(name, directory))),
    ],
    { stdio: 'inherit' },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
