import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { generate, loadContract } from '../dist/index.js';
import { compileCodec } from '../dist/codec-plan.js';
import { compileRuntimePlan } from '../dist/runtime-plan.js';

test('PHP validates every model within bounded memory without retaining earlier codecs', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdk-descriptor-memory-'));
  try {
    const output = join(root, 'sdk');
    const api = join(root, 'api.json');
    const config = join(root, 'sdk.json');
    writeFileSync(
      api,
      JSON.stringify({
        openapi: '3.1.0',
        info: { title: 'Memory validation', version: '1' },
        paths: {
          '/health': {
            get: { operationId: 'getHealth', responses: { 204: { description: 'Empty' } } },
          },
        },
      }),
    );
    writeFileSync(
      config,
      JSON.stringify({
        version: '1.0.0',
        targets: ['php'],
        operations: { getHealth: { response: { return: 'result' } } },
        composer: { name: 'example/memory', namespace: 'Example\\Library' },
      }),
    );
    generate(loadContract(api, config), output);
    const descriptors = join(root, 'descriptors');
    mkdirSync(join(descriptors, 'models'), { recursive: true });
    const put = (path, value) =>
      writeFileSync(join(descriptors, path + '.json'), JSON.stringify(value));
    put('settings', compileRuntimePlan({ operations: [] }));
    put('routes', {});
    const names = Array.from({ length: 64 }, (_, index) => 'MemoryModel' + index);
    put('models', names);
    const codec = compileCodec({
      type: 'string',
      enum: Array.from({ length: 4096 }, (_, index) => String(index).padStart(128, 'x')),
    });
    for (const name of names)
      put('models/' + name, {
        codec,
        dependencies: [],
        phpRepresentation: { kind: 'value', type: 'string' },
      });
    const script = String.raw`
require $argv[1].'/src/Client.php';
$source = new Example\Library\Internal\DescriptorSource($argv[2], false);
gc_disable(); // Descriptor validation must not rely on cyclic garbage collection.
$source->validateAll();
echo 'ok';
`;
    const check = () =>
      spawnSync('php', ['-d', 'memory_limit=32M', '-r', script, join(output, 'php'), descriptors], {
        encoding: 'utf8',
      });
    const valid = check();
    assert.equal(valid.status, 0, valid.stdout + valid.stderr);
    assert.equal(valid.stdout, 'ok');

    // Entity links must still be checked recursively after all valid models.
    put('models/' + names.at(-1), {
      codec,
      dependencies: [],
      phpRepresentation: { kind: 'list', value: { kind: 'entity', name: 'MissingEntity' } },
    });
    const missing = check();
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /Unknown PHP entity MissingEntity/);

    // A late malformed descriptor must still be visited after all valid models.
    put('models/' + names.at(-1), { codec: {}, dependencies: [] });
    const invalid = check();
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /invalid compiled codec/i);
    assert.doesNotMatch(invalid.stderr, /Allowed memory size/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
