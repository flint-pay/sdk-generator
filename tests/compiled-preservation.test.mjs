import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { loadContract, render } from '../dist/index.js';
const baseline = JSON.parse(
  readFileSync(new URL('./fixtures/compiled-public-baseline.json', import.meta.url)),
);
const digest = (value) => createHash('sha256').update(value).digest('hex');

test('unchanged Node declarations and PHP public signatures match the frozen pre-migration baseline', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdk-public-preservation-'));
  try {
    for (const fixture of baseline.fixtures) {
      const contract = loadContract(fixture.api, fixture.config);
      const files = render(contract);
      assert.equal(
        digest(files.get('node/index.d.ts')),
        fixture.nodeDeclarationsSha256,
        fixture.name + ' Node interface changed',
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
      assert.equal(
        digest(result.stdout),
        fixture.phpDeclarationsSha256,
        fixture.name + ' PHP interface changed',
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
