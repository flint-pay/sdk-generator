import { readdirSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runRequired, testBatches } from './helpers/test-runner.mjs';

try {
  const directory = new URL('./', import.meta.url);
  if (realpathSync(process.cwd()) !== realpathSync(new URL('../', import.meta.url)))
    throw new Error('Run tests from the repository root (see CONTRIBUTING.md).');
  const { flags, batches } = testBatches(
    readdirSync(directory).filter((name) => name.endsWith('.test.mjs')),
    process.argv.slice(2),
  );
  runRequired('php', ['--version'], { stdio: 'ignore' });
  runRequired('composer', [
    'install',
    '--working-dir=tests/phpstan',
    '--no-interaction',
    '--no-progress',
  ]);
  // Keep the full generation time/RSS budget independent of concurrent tests.
  for (const batch of batches) {
    if (!batch.length) continue;
    runRequired(process.execPath, [
      '--test',
      ...flags,
      ...batch.map((name) => fileURLToPath(new URL(name, directory))),
    ]);
  }
} catch (error) {
  console.error(`Tests: ${error.message}`);
  process.exitCode = 1;
}
