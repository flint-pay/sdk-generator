import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadContract, render, compare } from '../dist/index.js';
import { compileCodec, assertCodecPlan } from '../dist/codec-plan.js';
const child = { type: 'object', required: ['id'], properties: { id: { type: 'string' } } };
for (const [name, field] of Object.entries({
  untyped: { enum: [null] },
  anyOf: {
    anyOf: [{ $ref: '#/components/schemas/Child' }, { type: ['string', 'null'], enum: [null] }],
  },
  oneOf: {
    oneOf: [{ $ref: '#/components/schemas/Child' }, { type: ['string', 'null'], enum: [null] }],
  },
  untypedBranch: { anyOf: [{ $ref: '#/components/schemas/Child' }, { enum: [null] }] },
})) {
  test(`${name} null enum retains previous payload acceptance and compatibility`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'sdk-null-enum-policy-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const api = {
      openapi: '3.1.0',
      info: { title: 'Null enums', version: '1' },
      components: {
        schemas: {
          Child: child,
          Value: { type: 'object', required: ['child'], properties: { child: field } },
        },
      },
      paths: {
        '/value': {
          get: {
            operationId: 'getValue',
            responses: {
              200: {
                description: 'OK',
                content: { 'application/json': { schema: { $ref: '#/components/schemas/Value' } } },
              },
            },
          },
        },
      },
    };
    const source = join(root, 'api.json'),
      config = join(root, 'sdk.json');
    writeFileSync(
      config,
      JSON.stringify({
        version: '1.0.0',
        npm: { name: '@example/null-policy' },
        composer: { name: 'example/null-policy', namespace: 'Example\\NullPolicy' },
      }),
    );
    const load = () => {
      writeFileSync(source, JSON.stringify(api));
      return loadContract(source, config);
    };
    const before = load();
    const out = join(root, 'out');
    for (const [p, body] of render(before)) {
      mkdirSync(dirname(join(out, p)), { recursive: true });
      writeFileSync(join(out, p), body);
    }
    const codec = compileCodec({ ...before.models.Value, 'x-sdk-definitions': before.definitions });
    assertCodecPlan(codec);
    const { Client } = await import(pathToFileURL(join(out, 'node/index.js')).href);
    let payload;
    const client = new Client({
      baseUrl: 'https://example.invalid',
      transport: async () => Response.json({ child: payload }),
    });
    for (payload of [null, 'future', { id: 'ok' }]) {
      assert.deepEqual(JSON.parse(JSON.stringify(await client.api.getValue())), { child: payload });
      const p = spawnSync(
        'php',
        [
          '-r',
          String.raw`require $argv[1].'/src/Client.php';$value=new Example\NullPolicy\Value(['child'=>json_decode($argv[2])]);echo json_encode($value->getChild());`,
          join(out, 'php'),
          JSON.stringify(payload),
        ],
        { encoding: 'utf8' },
      );
      assert.equal(p.status, 0, p.stderr);
      assert.deepEqual(JSON.parse(p.stdout), payload);
    }
    // The dynamic adapters must also emit valid policies before normalization.
    const raw =
      name === 'untyped'
        ? field
        : {
            [name === 'oneOf' ? 'oneOf' : 'anyOf']: [
              child,
              name === 'untypedBranch'
                ? { enum: [null] }
                : { type: ['string', 'null'], enum: [null] },
            ],
          };
    assertCodecPlan(compileCodec(raw));
    const php = spawnSync(
      'php',
      [
        '-r',
        String.raw`require $argv[1].'/src/Client.php';$p=Example\NullPolicy\Internal\SchemaAdapter::compile(json_decode($argv[2],true));if(isset($p['nullableAlternative']))exit(1);`,
        join(out, 'php'),
        JSON.stringify(raw),
      ],
      { encoding: 'utf8' },
    );
    assert.equal(php.status, 0, php.stderr);
    const enumSchema = name === 'untyped' ? field : field[name === 'oneOf' ? 'oneOf' : 'anyOf'][1];
    enumSchema.enum.push('future');
    const after = load();
    // Findings independently pinned from the predecessor 575c9a41fa.
    const expected = JSON.parse(
      readFileSync(new URL('./fixtures/null-enum-compatibility.json', import.meta.url)),
    );
    assert.deepEqual(compare(before, after), expected[name]);
  });
}
