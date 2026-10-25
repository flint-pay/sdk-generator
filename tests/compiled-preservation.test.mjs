import {
  OutputBaselines,
  declarationEntries,
  signatureEntries,
} from './helpers/output-baselines.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadContract, render } from '../dist/index.js';
const baseline = JSON.parse(
  readFileSync(new URL('./fixtures/dx-public-baseline.json', import.meta.url)),
);

test('Node declarations and PHP public signatures match the reviewed DX baseline', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdk-public-preservation-'));
  try {
    const checked = new OutputBaselines();
    for (const fixture of baseline.fixtures) {
      const contract = loadContract(fixture.api, fixture.config);
      const files = render(contract);
      checked.check(
        fixture.name + '/nodeDeclarations',
        declarationEntries(files),
        fixture.nodeDeclarationsSha256,
      );
      const path = join(root, fixture.name);
      for (const [file, content] of files)
        if (file.startsWith('php/src/')) {
          const target = join(path, file.slice('php/src/'.length));
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, content);
        }
      const result = spawnSync('php', ['tests/compiled-api.php', path], {
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
      });
      assert.equal(result.status, 0, result.stderr);
      checked.check(
        fixture.name + '/phpDeclarations',
        signatureEntries(result.stdout, contract.config.composer.namespace),
        fixture.phpDeclarationsSha256,
        result.stdout,
      );
      // Single-target selection preserves that target's public declarations.
      for (const target of ['node', 'php']) {
        const selected = structuredClone(contract);
        selected.config.targets = [target];
        const single = render(selected);
        assert.equal(
          single.get(target === 'node' ? 'node/index.d.ts' : 'php/src/Client.php'),
          files.get(target === 'node' ? 'node/index.d.ts' : 'php/src/Client.php'),
        );
        assert.ok([...single.keys()].every((path) => path.startsWith(target + '/')));
      }
    }
    checked.finish();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
