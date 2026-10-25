import { spawnSync } from 'node:child_process';

export const budgetTest = 'full-public-packages.test.mjs';
export const slowTests = new Set([budgetTest, 'full-public-spec.test.mjs']);

export function requireTestNode(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 16))
    throw new Error(
      `Contributor tests require Node.js 22.16+ (current: ${version}) for the SQLite examples. Run nvm use or install the version in .nvmrc (see CONTRIBUTING.md). The published generator supports Node.js 22+.`,
    );
}

export function testBatches(available, args) {
  const fast = args.includes('--fast');
  const requested = args.filter((arg) => !arg.startsWith('-') && arg.endsWith('.test.mjs'));
  const flags = args.filter((arg) => arg !== '--fast' && !requested.includes(arg));
  for (const file of requested)
    if (!available.includes(file.replace(/^tests\//, '')))
      throw new Error(
        `Unknown test file: ${file}. Use tests/NAME.test.mjs from the repository root.`,
      );
  if (!flags.some((arg) => arg.startsWith('--test-concurrency')))
    flags.unshift('--test-concurrency=4');
  const selected = available
    .filter(
      (name) =>
        !requested.length || requested.includes(name) || requested.includes('tests/' + name),
    )
    .filter((name) => !fast || !slowTests.has(name))
    .sort();
  if (!selected.length) throw new Error('No test files selected.');
  return {
    flags,
    batches: [
      selected.filter((name) => name !== budgetTest),
      selected.filter((name) => name === budgetTest),
    ],
  };
}

export function runRequired(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) {
    const missing = result.error.code === 'ENOENT';
    throw new Error(
      missing
        ? `Required tool "${command}" was not found. Install ${command === 'php' ? 'PHP 8.2+' : command === 'composer' ? 'Composer 2' : command} and make it available on PATH (see CONTRIBUTING.md).`
        : `Cannot run ${command}: ${result.error.message}`,
    );
  }
  if (result.status !== 0)
    throw new Error(
      `${command} failed (${result.signal ?? `exit ${result.status ?? 1}`}): ${args.join(' ')}`,
    );
}
