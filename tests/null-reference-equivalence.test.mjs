import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { loadContract, render, compare } from '../dist/index.js';
import { nullableAlternative, nullOnlySchema, compileCodec } from '../dist/codec-plan.js';
import { executeCodec } from '../dist/runtime.js';
const nulls = [
  { type: 'null' },
  { const: null },
  { const: null, type: ['number', 'null'], format: 'decimal' },
  { type: ['null'] },
  { type: ['null'], const: null, enum: [null] },
  { allOf: [{ const: null }, {}] },
  { anyOf: [{ const: null }, { type: 'null' }] },
  { const: null, not: { type: 'string' } },
  { const: null, if: { type: 'null' }, then: { enum: [null] } },
];
test('equivalent null-only forms preserve every declaration, descriptor, PHP class and hydration', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sdk-null-forms-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const api = {
    openapi: '3.1.0',
    info: { title: 'Nullable fixture', version: '1' },
    paths: {
      '/containers': {
        get: {
          operationId: 'getContainers',
          responses: {
            200: {
              description: 'OK',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/Container' } },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Container: {
          type: 'object',
          required: ['child'],
          properties: { child: { anyOf: [{ $ref: '#/components/schemas/Child' }, nulls[0]] } },
        },
        Child: { type: 'object', required: ['value'], properties: { value: { type: 'string' } } },
      },
    },
  };
  const path = join(root, 'api.json'),
    settings = join(root, 'sdk.json');
  writeFileSync(
    settings,
    JSON.stringify({
      version: '1.0.0',
      npm: { name: '@example/null-equivalence' },
      composer: { name: 'example/null-equivalence', namespace: 'Example\\NullEquivalence' },
    }),
  );
  let baseline, prior;
  for (const [index, branch] of nulls.entries()) {
    api.components.schemas.Container.properties.child.anyOf[1] = branch;
    writeFileSync(path, JSON.stringify(api));
    const c = loadContract(path, settings),
      files = render(c);
    if (baseline) {
      assert.deepEqual([...files], [...baseline]);
      assert.deepEqual(compare(prior, c), []);
    } else {
      baseline = files;
      prior = c;
    }
    const out = join(root, String(index));
    for (const [p, body] of files) {
      const dest = join(out, p);
      mkdirSync(dest.slice(0, dest.lastIndexOf('/')), { recursive: true });
      writeFileSync(dest, body);
    }
    const { Client } = await import(pathToFileURL(join(out, 'node/index.js')).href);
    let payload = { child: { value: 'ok' } };
    const client = new Client({
      baseUrl: 'https://example.invalid',
      transport: async () => new Response(JSON.stringify(payload)),
    });
    assert.deepEqual(JSON.parse(JSON.stringify(await client.api.getContainers())), payload);
    payload = { child: null };
    assert.deepEqual(JSON.parse(JSON.stringify(await client.api.getContainers())), payload);
    payload = { child: { value: 1 } };
    await assert.rejects(client.api.getContainers(), { name: 'UnexpectedResponseError' });
    const php = spawnSync(
      'php',
      [
        '-r',
        String.raw`require $argv[1].'/src/Client.php';$c=new Example\NullEquivalence\Container(['child'=>(object)['value'=>'ok']]);$child=$c->getChild();if(!$child instanceof Example\NullEquivalence\Child || $child->getValue()!=='ok')exit(1);if((new ReflectionMethod($c,'getChild'))->getReturnType()->getName()!=='Example\\NullEquivalence\\Child')exit(2);$null=new Example\NullEquivalence\Container(['child'=>null]);if($null->getChild()!==null)exit(3);$schema=json_decode($argv[2],true);$plan=Example\NullEquivalence\Internal\SchemaAdapter::compile(['anyOf'=>[['type'=>'object'], $schema]]);if(($plan['nullableAlternative']??null)!==(($schema['type']??null)==='null'?0:null))exit(4);`,
        join(out, 'php'),
        JSON.stringify(branch),
      ],
      { encoding: 'utf8' },
    );
    assert.equal(php.status, 0, php.stdout + php.stderr);
    assert.equal(
      nullableAlternative({ anyOf: [{ type: 'object' }, branch] }),
      branch.type === 'null' ? 0 : undefined,
    );
  }
});
test('null-only proofs do not mistake empty or contradictory schemas for null', () => {
  for (const s of [
    {},
    { enum: [] },
    { type: 'string', const: null },
    { type: 'null', not: {} },
    { oneOf: [{ type: 'null' }, { const: null }] },
    { const: null, enum: ['x'] },
    { anyOf: [{ type: 'null' }, { type: 'string' }] },
    { const: null, not: { 'x-sdk-ref': 'Null' } },
    { const: null, if: { 'x-sdk-ref': 'Unknown' }, then: { type: 'string' } },
    { const: null, oneOf: [{ type: 'null' }, { 'x-sdk-ref': 'Null' }] },
  ])
    assert.equal(nullOnlySchema(s), false, JSON.stringify(s));
});
test('recursive placeholders inherit titles, with sibling overrides taking precedence', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sdk-recursive-titles-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const branches = [
    { $ref: '#/components/schemas/Group', title: 'Rule group' },
    { $ref: '#/components/schemas/Leaf', title: 'Rule' },
  ];
  const api = {
    openapi: '3.1.0',
    info: { title: 'Recursive labels', version: '1' },
    paths: {
      '/groups': {
        get: {
          operationId: 'getGroups',
          responses: {
            200: {
              description: 'OK',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Group' } } },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Group: {
          title: 'Rule group',
          type: 'object',
          required: ['children'],
          properties: { children: { type: 'array', items: { oneOf: branches } } },
        },
        Leaf: {
          title: 'Rule',
          type: 'object',
          required: ['value'],
          properties: { value: { type: 'string' } },
        },
      },
    },
  };
  const path = join(root, 'api.json'),
    settings = join(root, 'sdk.json');
  writeFileSync(
    settings,
    JSON.stringify({
      version: '1.0.0',
      npm: { name: '@example/recursive-labels' },
      composer: { name: 'example/recursive-labels', namespace: 'Example\\Labels' },
    }),
  );
  const load = () => {
    writeFileSync(path, JSON.stringify(api));
    return loadContract(path, settings);
  };
  const before = load(),
    files = render(before);
  for (const branch of branches) delete branch.title;
  const after = load();
  assert.deepEqual([...render(after)], [...files]);
  assert.deepEqual(compare(before, after), []);
  branches[0]['x-go-name'] = 'ForeignName';
  branches[0]['x-go-type-name'] = 'ForeignType';
  assert.deepEqual([...render(load())], [...files]);
  const codec = compileCodec({ ...after.models.Group, 'x-sdk-definitions': after.definitions });
  assert.throws(
    () =>
      executeCodec({ children: [{ children: [{}] }] }, codec, {
        mode: 'request',
        validateConstraints: true,
      }),
    /closest is Rule group/,
  );
  branches[0].title = 'Custom group';
  assert.equal(load().models.Group.properties.children.items.oneOf[0].title, 'Custom group');
});
