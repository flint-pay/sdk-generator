// Manual full-corpus self-check: node --max-old-space-size=3072
// tests/helpers/run-documentation-mutations.mjs --full OUTPUT_DIRECTORY
// Synthetic cases also run in documentation-facts.test.mjs during npm test.
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadContract } from '../../dist/index.js';
import { documentationFixture, documentationMutations } from './documentation-fixture.mjs';
import { rawDocumentationInput, readDocumentationProfile } from './raw-documentation.mjs';

assert.ok(process.argv.includes('--full'), 'Use --full to run complete Flint mutation checks');
const root = resolve(process.argv.at(-1));
mkdirSync(root, { recursive: true });
const probeDir = join(root, 'probe');
mkdirSync(probeDir, { recursive: true });
function prepare() {
  const probe = documentationFixture(probeDir),
    full = loadContract(
      'tests/providers/flint/full-openapi.json',
      'tests/providers/flint/full-sdk.json',
    );
  const contract = {
    ...full,
    models: { ...full.models, ...probe.models },
    definitions: { ...full.definitions, ...probe.definitions },
    operations: [...full.operations, ...probe.operations],
  };
  writeFileSync(join(root, 'contract.json'), JSON.stringify(contract));
  const api = JSON.parse(readFileSync('tests/providers/flint/full-openapi.json')),
    synthetic = JSON.parse(readFileSync(join(probeDir, 'api.json')));
  const profile = readDocumentationProfile('tests/providers/flint/full-sdk.json');
  profile.include = [...profile.include, ...probe.operations.map((o) => o.id)];
  const raw = rawDocumentationInput(
    {
      ...api,
      components: {
        ...api.components,
        schemas: { ...api.components.schemas, ...synthetic.components.schemas },
      },
      paths: { ...api.paths, ...synthetic.paths },
    },
    profile,
  );
  writeFileSync(join(root, 'raw-input.json'), JSON.stringify(raw));
  return Object.keys(probe.models).flatMap((n) => [n, n + 'Input']);
}
const selected = prepare(),
  results = [];
for (const mutation of [['control'], ...documentationMutations]) {
  const [label, file, before, after, affected = ['node', 'php']] = mutation;
  const dir = join(root, label.replaceAll(' ', '-'));
  mkdirSync(dir, { recursive: true });
  for (const path of ['dist', 'templates', 'LICENSE', 'tests/helpers'])
    cpSync(path, join(dir, path), { recursive: true });
  symlinkSync(resolve('node_modules'), join(dir, 'node_modules'));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  if (file) {
    const path = join(dir, 'dist', file),
      original = readFileSync(path, 'utf8');
    assert.ok(original.includes(before), label + ': mutation applies');
    let changed = original.replace(before, after);
    if (label === 'PHP model links')
      changed +=
        '\nexport function phpModelReference(...args){return _mutatedPhpModelReference(...args).replace(/\\[([^\\]]+)\\]\\(MODELS\\.md#[^)]+\\)/g,"$1");}\n';
    writeFileSync(path, changed);
  }
  const script = join(dir, 'run.mjs');
  writeFileSync(
    script,
    `
import {readFileSync,writeFileSync}from'node:fs';import{generate}from'./dist/index.js';
import{assertCanonicalBranchDocumentation,assertCanonicalOperationDocumentation}from'./tests/helpers/canonical-docs.mjs';
const c=JSON.parse(readFileSync(${JSON.stringify(join(root, 'contract.json'))}));const raw=JSON.parse(readFileSync(${JSON.stringify(join(root, 'raw-input.json'))}));
const out=${JSON.stringify(join(dir, 'out'))},start=performance.now();generate(c,out);
const result={label:${JSON.stringify(label)},generateMs:performance.now()-start};
for(const target of ['node','php']){try{const branches=assertCanonicalBranchDocumentation(out+'/'+target,raw,undefined,${label === 'control' ? 'undefined' : `new Set(${JSON.stringify(selected)})`});const operations=assertCanonicalOperationDocumentation(out+'/'+target,raw);result[target]={status:'pass',branches,operations};}catch(e){result[target]={status:'detected',message:e.message};}}
writeFileSync(${JSON.stringify(join(dir, 'result.json'))},JSON.stringify(result,null,2));console.log(JSON.stringify(result));
`,
  );
  const run = spawnSync(process.execPath, ['--max-old-space-size=3072', script], {
    encoding: 'utf8',
    timeout: 600000,
    maxBuffer: 1024 * 1024,
  });
  writeFileSync(join(dir, 'run.log'), run.stdout + run.stderr);
  assert.equal(run.status, 0, label + ': worker ' + run.stderr);
  const result = JSON.parse(readFileSync(join(dir, 'result.json')));
  results.push(result);
  writeFileSync(join(root, 'results.json'), JSON.stringify(results, null, 2));
  for (const target of ['node', 'php'])
    assert.equal(
      result[target].status,
      label !== 'control' && affected.includes(target) ? 'detected' : 'pass',
      label + ' ' + target + ': ' + result[target].message,
    );
  console.log(label, JSON.stringify(result));
  if (label !== 'control') rmSync(join(dir, 'out'), { recursive: true, force: true });
}
