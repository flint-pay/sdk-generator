import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { generate, loadContract } from '../dist/index.js';
import { schemaNotes } from '../dist/schema-documentation.js';

test('numeric field docs agree with generated declarations and factories in both targets', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sdk-numeric-docs-'));
  try {
    const native = {
      plain: { type: 'number' },
      float: { type: 'number', format: 'float' },
      double: { type: 'number', format: 'double' },
      single: { type: ['number'] },
      nullable: { type: ['number', 'null'] },
      integer: { type: 'integer', format: 'int32' },
    };
    const exact = {
      decimal: { type: 'number', format: 'decimal' },
      signed: { type: 'integer', format: 'int64' },
      unsigned: { type: 'integer', format: 'uint64' },
      single_decimal: { type: ['number'], format: 'decimal' },
      nullable_decimal: { type: ['number', 'null'], format: 'decimal' },
    };
    const fields = Object.fromEntries(
      Object.entries({ ...native, ...exact }).map(([name, schema]) => [
        name,
        { ...schema, description: `${name} reading.` },
      ]),
    );
    const numbers = {
      type: 'object',
      properties: { ...fields, choice: { $ref: '#/components/schemas/ExactChoice' } },
    };
    writeFileSync(
      join(dir, 'api.json'),
      JSON.stringify({
        openapi: '3.1.0',
        info: { title: 'Numeric readings', version: '1' },
        components: {
          schemas: {
            Numbers: numbers,
            ExactChoice: {
              oneOf: [{ type: 'number', format: 'decimal' }, { type: 'string' }],
            },
          },
        },
        paths: {
          '/readings': {
            post: {
              operationId: 'save',
              parameters: Object.entries(fields)
                .filter(([, schema]) => !schema.type.includes('null'))
                .map(([name, schema]) => ({ in: 'query', name, schema })),
              requestBody: {
                required: true,
                content: {
                  'application/json': { schema: { $ref: '#/components/schemas/Numbers' } },
                },
              },
              responses: { 204: { description: 'empty' } },
            },
          },
        },
      }),
    );
    writeFileSync(
      join(dir, 'sdk.json'),
      JSON.stringify({
        version: '1.0.0',
        requests: { style: 'object' },
        responses: { return: 'result' },
        npm: { name: '@example/numeric-readings' },
        composer: { name: 'example/numeric-readings', namespace: 'Example\\Readings' },
      }),
    );
    const contract = loadContract(join(dir, 'api.json'), join(dir, 'sdk.json'));
    const out = join(dir, 'out');
    generate(contract, out);
    for (const target of ['node', 'php']) {
      for (const filename of ['MODELS.md', 'REFERENCE.md']) {
        const docs = readFileSync(join(out, target, filename), 'utf8');
        for (const [name, schema] of Object.entries(native)) {
          if (filename === 'REFERENCE.md' && schema.type.includes('null')) continue;
          const type = Array.isArray(schema.type) ? schema.type.join(' or ') : schema.type;
          const row = docs.split('\n').find((line) => line.startsWith(`| \`${name}\` |`));
          assert.ok(row, `${target}/${filename}: ${name}`);
          assert.ok(row.includes(`| ${type} | ${name} reading.`), row);
          assert.doesNotMatch(row, /exact numeric string|ExactNumber/);
        }
        for (const [name, schema] of Object.entries(exact)) {
          if (filename === 'REFERENCE.md' && schema.type.includes('null')) continue;
          const row = docs.split('\n').find((line) => line.startsWith(`| \`${name}\` |`));
          assert.ok(row, `${target}/${filename}: ${name}`);
          const type = `exact numeric string${Array.isArray(schema.type) && schema.type.includes('null') ? ' or null' : ''}`;
          assert.ok(row.includes(`| ${type} |`), row);
          assert.match(row, /Use an exact numeric string, not a floating-point number\./);
        }
      }
      assert.match(
        readFileSync(join(out, target, 'MODELS.md'), 'utf8'),
        /Variants: ExactNumber input; exact numeric string response, string\./,
      );
    }
    const declarations = readFileSync(join(out, 'node/declarations/NumbersInput.d.ts'), 'utf8');
    for (const name of Object.keys(native)) {
      const comment = declarations.match(new RegExp(`/\\*\\* ${name} reading\\.(.*?)\\*/`))?.[0];
      assert.ok(comment, name);
      assert.doesNotMatch(comment, /exact numeric string|ExactNumber/);
    }
    assert.match(declarations, /plain reading\. \*\/ "plain"\?: number/);
    assert.match(declarations, /decimal reading\. Use an exact numeric string/);
    const branch = contract.models.ExactChoice.oneOf[0];
    assert.equal(schemaNotes(branch), 'Use ExactNumber for an exact JSON number. Format: decimal.');

    const sdk = await import(pathToFileURL(join(out, 'node/index.js')).href);
    for (const name of Object.keys(native)) {
      assert.equal(sdk.makeNumbers({ [name]: 15 }).toJSON()[name], 15);
      assert.throws(() => sdk.makeNumbers({ [name]: '15' }), { kind: 'validation' });
    }
    for (const name of Object.keys(exact)) {
      assert.equal(sdk.makeNumbers({ [name]: '15' }).toJSON()[name], '15');
      assert.throws(() => sdk.makeNumbers({ [name]: 15.5 }), { kind: 'validation' });
    }
    assert.equal(sdk.makeExactChoice(new sdk.ExactNumber('15')).toJSON(), '15');
    const php = spawnSync(
      'php',
      [
        '-r',
        String.raw`require $argv[1].'/src/Runtime.php'; require $argv[1].'/src/Client.php';
use Example\Readings\{NumbersInput,ExactChoiceInput,ExactNumber,SdkError};
foreach (json_decode($argv[2],true) as $name) {
 if ((new NumbersInput([$name=>15]))->jsonSerialize()->$name!==15) exit(2);
 try { new NumbersInput([$name=>'15']); exit(3); } catch (SdkError $e) { if($e->kind!=='validation') exit(4); }
}
foreach (json_decode($argv[3],true) as $name) {
 if ((new NumbersInput([$name=>'15']))->jsonSerialize()->$name!=='15') exit(5);
 try { new NumbersInput([$name=>15.5]); exit(6); } catch (SdkError $e) { if($e->kind!=='validation') exit(7); }
}
if ((new ExactChoiceInput(new ExactNumber('15')))->jsonSerialize()!=='15') exit(8);
echo 'ok';`,
        join(out, 'php'),
        JSON.stringify(Object.keys(native)),
        JSON.stringify(Object.keys(exact)),
      ],
      { encoding: 'utf8' },
    );
    assert.equal(php.status, 0, php.stdout + php.stderr);
    assert.equal(php.stdout, 'ok');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
