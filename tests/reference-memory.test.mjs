import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Mirrors the repeated error envelopes in the public export without provider data.
// A small heap detects copying annotation string storage before named sharing.
test('repeated response references retain large enum annotations within the loading budget', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sdk-reference-memory-'));
  try {
    const values = Array.from({ length: 64 }, (_, i) => 'value_' + i);
    const descriptions = values.map((value) => value + ': ' + 'synthetic description '.repeat(400));
    const detail = {
      type: 'object',
      properties: { code: { type: 'string', enum: values, 'x-enum-descriptions': descriptions } },
    };
    const response = {
      description: 'Synthetic error',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Envelope' } } },
    };
    const document = {
      openapi: '3.1.0',
      info: { title: 'Memory regression', version: '1' },
      components: {
        schemas: {
          Detail: detail,
          Envelope: {
            type: 'object',
            properties: { error: { $ref: '#/components/schemas/Detail' } },
          },
        },
      },
      paths: Object.fromEntries(
        Array.from({ length: 256 }, (_, i) => [
          '/items/' + i,
          { get: { operationId: 'getItem' + i, responses: { 200: response, 400: response } } },
        ]),
      ),
    };
    const api = join(dir, 'api.json'),
      config = join(dir, 'sdk.json');
    writeFileSync(api, JSON.stringify(document));
    writeFileSync(
      config,
      JSON.stringify({
        version: '1.0.0',
        targets: ['node'],
        npm: { name: '@example/memory' },
      }),
    );
    const script = join(dir, 'load.mjs');
    writeFileSync(
      script,
      `
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {loadContract} from ${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)};
const api=${JSON.stringify(api)}, config=${JSON.stringify(config)};
const before=readFileSync(api,'utf8');
const contract=loadContract(api,config);
assert.equal(contract.operations.length,256);
assert.deepEqual(contract.definitions.Detail.properties.code.enum,${JSON.stringify(values)});
assert.deepEqual(contract.definitions.Detail.properties.code['x-enum-descriptions'],${JSON.stringify(descriptions)});
assert.equal(contract.operations[0].responses['400'].schema.properties.error['x-sdk-ref'],'Detail');
contract.operations[0].responses['400'].schema.properties.error.readOnly=true;
assert.equal(contract.operations[1].responses['400'].schema.properties.error.readOnly,undefined);
assert.equal(contract.models.Envelope.properties.error.readOnly,undefined);
assert.equal(readFileSync(api,'utf8'),before);
console.log(JSON.stringify({maxRSSKiB:process.resourceUsage().maxRSS}));
`,
    );
    const result = spawnSync(process.execPath, ['--max-old-space-size=128', script], {
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    assert.ok(JSON.parse(result.stdout).maxRSSKiB < 200 * 1024, 'loading exceeds 200 MiB RSS');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
