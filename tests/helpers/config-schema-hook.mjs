import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, resolve, relative } from 'node:path';
import Ajv from 'ajv/dist/2020.js';

const validate = new Ajv({ strict: true }).compile(
  JSON.parse(readFileSync(new URL('../../sdk-config.schema.json', import.meta.url), 'utf8')),
);
const checked = new Set();
const rejected = new Set();
process.once('exit', () => {
  if (!rejected.size) return;
  console.error(
    'Loader-accepted configurations failed the published schema:\n' + [...rejected].join('\n'),
  );
  process.exitCode = 1;
});
export function assertConfigSchema(file, visited = new Set()) {
  file = resolve(file);
  if (visited.has(file)) return;
  visited.add(file);
  const text = readFileSync(file, 'utf8');
  const config = JSON.parse(text);
  if (!checked.has(text)) {
    const valid = validate(config);
    const message = relative(process.cwd(), file) + ': ' + JSON.stringify(validate.errors);
    if (!valid) rejected.add(message);
    assert.ok(valid, message);
    checked.add(text);
  }
  for (const profile of config.profiles ?? [])
    assertConfigSchema(resolve(dirname(file), profile), visited);
}

// Observe successful loads throughout the suite, including configs built by tests.
// Invalid inputs still reach the loader unchanged and retain its diagnostics.
const contract = new URL('../../dist/contract.js', import.meta.url).href;
registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (url !== contract) return loaded;
    const source =
      typeof loaded.source === 'string'
        ? loaded.source
        : Buffer.from(loaded.source).toString('utf8');
    assert.ok(source.includes('export function loadContract('));
    return {
      ...loaded,
      source:
        source.replace('export function loadContract(', 'function loadContractBeforeSchemaCheck(') +
        `
import { assertConfigSchema } from ${JSON.stringify(import.meta.url)};
export function loadContract(...args) {
  const result = loadContractBeforeSchemaCheck(...args);
  assertConfigSchema(args[1]);
  return result;
}
`,
    };
  },
});
