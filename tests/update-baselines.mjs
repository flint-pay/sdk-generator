import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { loadContract, render } from '../dist/index.js';
import {
  digest,
  hashEntries,
  runtimeEntries,
  declarationEntries,
  recordFiles,
  signatureEntries,
} from './helpers/output-baselines.mjs';

// Only current output tripwires are refreshed. Historical compatibility records,
// source provenance and provider fixture manifests need independent review.
const manifest = { groups: {}, contents: {} };
const root = mkdtempSync(join(tmpdir(), 'sdk-baselines-'));
const updates = [];
try {
  for (const name of ['webhook-output', 'dx-public']) {
    const file = `tests/fixtures/${name}-baseline.json`;
    const baseline = JSON.parse(readFileSync(file, 'utf8'));
    for (const fixture of baseline.fixtures) {
      const contract = loadContract(fixture.api, fixture.config);
      const files = render(contract);
      function record(key, entries, rawContent) {
        recordFiles(manifest, `${fixture.name}/${key}`, entries);
        return rawContent === undefined ? hashEntries(entries) : digest(rawContent);
      }
      if (name === 'webhook-output') {
        fixture.nodeRuntimeSha256 = record('nodeRuntime', runtimeEntries(files, 'node'));
        fixture.phpSha256 = record('php', runtimeEntries(files, 'php'));
        fixture.phpRuntimeSha256 = record('phpRuntime', runtimeEntries(files, 'php', true));
        for (const target of ['node', 'php']) {
          const selected = structuredClone(contract);
          selected.config.targets = [target];
          fixture.singleTarget[target] = record(
            target + 'Only',
            runtimeEntries(render(selected), target),
          );
        }
      } else {
        fixture.nodeDeclarationsSha256 = record('nodeDeclarations', declarationEntries(files));
        const directory = join(root, fixture.name);
        for (const [path, text] of files)
          if (path.startsWith('php/src/')) {
            const dest = join(directory, path.slice('php/src/'.length));
            mkdirSync(dirname(dest), { recursive: true });
            writeFileSync(dest, text);
          }
        const result = spawnSync('php', ['tests/compiled-api.php', directory], {
          encoding: 'utf8',
          maxBuffer: 8 * 1024 * 1024,
        });
        if (result.status !== 0) throw new Error(result.error?.message ?? result.stderr);
        fixture.phpDeclarationsSha256 = record(
          'phpDeclarations',
          signatureEntries(result.stdout, contract.config.composer.namespace),
          result.stdout,
        );
      }
    }
    updates.push([file, baseline]);
  }
  updates.push(['tests/fixtures/output-file-baseline.json', manifest]);
  for (const [file, value] of updates) {
    writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
    console.log('Updated ' + file);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
