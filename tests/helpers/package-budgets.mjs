import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const tsc = fileURLToPath(new URL('../../node_modules/typescript/bin/tsc', import.meta.url));
const typeRoots = fileURLToPath(new URL('../../node_modules/@types', import.meta.url));

// Rebaseline with: node tests/helpers/package-budgets.mjs GENERATED_OUTPUT
// First: npm run build; node --max-old-space-size=3072 dist/cli.js generate
// tests/providers/flint/full-openapi.json tests/providers/flint/full-sdk.json GENERATED_OUTPUT
// Baseline: #102, Node 24.22.1 / TypeScript 5.9.3, 2026-10-30 (PR has full medians).
// Three fresh strict, no-skipLibCheck compiler processes per entry; median metrics.
// Raise only after reviewing intentional public contract/package growth and recording
// new measurements in the PR. Size/count/RSS limits allow ~20% over the baseline;
// wall time only warns because host load and filesystem caches are uncontrolled.
export const PACKAGE_BUDGETS = {
  node: { packedBytes: 3_530_000, unpackedBytes: 42_600_000, files: 6_130 },
  php: { packedBytes: 28_800_000, unpackedBytes: 86_000_000, files: 35_120 },
  root: { loadedDts: 435, peakRssKiB: 634_000, wallSeconds: 6 },
  subpath: { loadedDts: 305, peakRssKiB: 603_000, wallSeconds: 5.4 },
};

export function median(values) {
  assert.equal(values.length, 3, 'measure exactly three runs');
  assert.ok(values.every((value) => Number.isFinite(value) && value > 0));
  return [...values].sort((a, b) => a - b)[1];
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
  assert.equal(
    result.status,
    0,
    `${command}: ${result.error?.message ?? ''}\n${result.stderr}\n${result.stdout?.slice(-8000)}`,
  );
  return result.stdout;
}

function tree(directory) {
  const paths = readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    // Composer dependencies are not distributed as SDK package contents.
    return entry.isDirectory() ? (entry.name === 'vendor' ? [] : tree(path).paths) : [path];
  });
  return {
    paths,
    files: paths.length,
    unpackedBytes: paths.reduce((n, path) => n + statSync(path).size, 0),
  };
}

// Same 30-line consumer as the type-name PR baseline. Never executed.
const consumer = `import { Client } from 'PACKAGE';

const client = new Client({
  baseUrl: 'https://example.invalid',
  token: 'synthetic',
});

async function readCustomers() {
  const result = await client.customers.list({ page_size: 10 });
  return result;
}

async function readRefunds() {
  const result = await client.refunds.list({ page_size: 10 });
  return result;
}

type Customers = Awaited<ReturnType<typeof readCustomers>>;
type Refunds = Awaited<ReturnType<typeof readRefunds>>;

function keepTypes(customers: Customers, refunds: Refunds) {
  return { customers, refunds };
}

export { readCustomers, readRefunds, keepTypes };
export type { Customers, Refunds };

// This consumer is typechecked only.
// It never performs an HTTP request.
// Baseline and changed runs use identical source.
`;

export function measurePackageBudgets(output) {
  output = resolve(output);
  const directory = mkdtempSync(join(tmpdir(), 'sdk-package-budgets-'));
  try {
    const packageRuns = [];
    for (let i = 0; i < 3; i++) {
      const packed = JSON.parse(
        run('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], {
          cwd: join(output, 'node'),
        }),
      )[0];
      const php = tree(join(output, 'php'));
      run('composer', ['archive', '--format=zip', '--dir=' + directory, '--file=sdk'], {
        cwd: join(output, 'php'),
      });
      packageRuns.push({
        node: {
          packedBytes: packed.size,
          unpackedBytes: packed.unpackedSize,
          files: packed.entryCount,
        },
        php: {
          packedBytes: statSync(join(directory, 'sdk.zip')).size,
          unpackedBytes: php.unpackedBytes,
          files: php.files,
        },
      });
      rmSync(join(directory, 'sdk.zip'));
    }
    const packages = Object.fromEntries(
      ['node', 'php'].map((target) => [
        target,
        Object.fromEntries(
          ['packedBytes', 'unpackedBytes', 'files'].map((metric) => [
            metric,
            median(packageRuns.map((run) => run[target][metric])),
          ]),
        ),
      ]),
    );
    const name = JSON.parse(readFileSync(join(output, 'node/package.json'), 'utf8')).name;
    const packagePath = join(directory, 'node_modules', name);
    mkdirSync(resolve(packagePath, '..'), { recursive: true });
    symlinkSync(join(output, 'node'), packagePath, 'dir');
    writeFileSync(join(directory, 'package.json'), '{"private":true,"type":"module"}');
    const metrics = join(directory, 'process.json');
    const wrapper = join(directory, 'tsc.mjs');
    // Measure the compiler process itself, including startup and native allocations.
    // Node reports maxRSS in KiB on Linux and macOS; no platform-specific time tool.
    writeFileSync(
      wrapper,
      `import {writeFileSync} from 'node:fs';
process.on('exit', () => writeFileSync(${JSON.stringify(metrics)}, JSON.stringify({peakRssKiB:process.resourceUsage().maxRSS})));
await import(${JSON.stringify(pathToFileURL(tsc).href)});
`,
    );
    const result = {
      ...packages,
      nodeVersion: process.version,
      typescript: JSON.parse(readFileSync(resolve(tsc, '../../package.json'), 'utf8')).version,
    };
    for (const [entry, source] of Object.entries({
      root: consumer.replace('PACKAGE', name),
      subpath: consumer
        .replace('PACKAGE', name + '/resources/customers')
        .replace('client.refunds.list({ page_size: 10 })', "client.customers.get('cus_synthetic')"),
    })) {
      const file = join(directory, entry + '.ts');
      writeFileSync(file, source);
      const runs = [];
      for (let i = 0; i < 3; i++) {
        const started = performance.now();
        const stdout = run(process.execPath, [
          wrapper,
          '--strict',
          '--noEmit',
          '--target',
          'ES2022',
          '--module',
          'NodeNext',
          '--typeRoots',
          typeRoots,
          '--listFiles',
          file,
        ]);
        runs.push({
          wallSeconds: (performance.now() - started) / 1000,
          ...JSON.parse(readFileSync(metrics, 'utf8')),
          loadedDts: stdout.split('\n').filter((line) => line.trimEnd().endsWith('.d.ts')).length,
        });
      }
      result[entry] = Object.fromEntries(
        ['wallSeconds', 'peakRssKiB', 'loadedDts'].map((key) => [
          key,
          median(runs.map((run) => run[key])),
        ]),
      );
      result[entry].runs = runs;
    }
    return result;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function assertPackageBudgets(measured, budgets = PACKAGE_BUDGETS, warn = console.warn) {
  for (const [group, limits] of Object.entries(budgets))
    for (const [metric, limit] of Object.entries(limits)) {
      const value = measured[group]?.[metric];
      assert.ok(Number.isFinite(value) && value > 0, `${group}.${metric}: missing measurement`);
      const message = `${group}.${metric}: ${value} exceeds budget ${limit}`;
      if (metric === 'wallSeconds') {
        if (value > limit) warn(message);
      } else assert.ok(value <= limit, message);
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const measured = measurePackageBudgets(process.argv[2]);
  console.log(JSON.stringify(measured, null, 2));
  assertPackageBudgets(measured);
}
