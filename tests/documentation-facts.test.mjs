import { spawnSync } from 'node:child_process';
import { assertIndependentOracleGraph } from './helpers/oracle-import-graph.mjs';
import {
  rawDocumentationInput,
  payloadSchemas,
  schemaInstruction,
} from './helpers/raw-documentation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  cpSync,
  symlinkSync,
  rmSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { generate } from '../dist/index.js';
import { assertSourceFieldDocumentation, sourceFactRows } from './helpers/source-documentation.mjs';
import {
  compileDocumentation,
  documentationDescriptions,
  factIdentity,
} from '../dist/documentation-plan.js';
import { schemaComment } from '../dist/schema-documentation.js';
import { compilePhpModel } from '../dist/target-plan.js';
import { expectedFieldFacts } from './helpers/documentation-expectations.mjs';
import {
  assertCanonicalBranchDocumentation,
  assertCanonicalOperationDocumentation,
  operationDocuments,
  linkedModelSections,
} from './helpers/canonical-docs.mjs';
import {
  assertPackageLinks,
  assertUniqueFieldTables,
  packageDocuments,
} from './helpers/package-docs.mjs';
import {
  documentationFixture as fixture,
  documentationMutations as mutations,
} from './helpers/documentation-fixture.mjs';

test('the entire oracle import graph excludes all production modules', () => {
  const paths = assertIndependentOracleGraph([
    'tests/helpers/canonical-docs.mjs',
    'tests/helpers/source-documentation.mjs',
  ]);
  assert.ok(paths.some((p) => p.endsWith('/raw-documentation.mjs')));
  const dir = mkdtempSync(join(tmpdir(), 'sdk-oracle-boundary-'));
  try {
    mkdirSync(join(dir, 'dist'));
    writeFileSync(join(dir, 'dist', 'documentation-plan.js'), '');
    writeFileSync(join(dir, 'indirect.mjs'), "export * from './dist/documentation-plan.js';");
    writeFileSync(join(dir, 'entry.mjs'), "import './indirect.mjs';");
    assert.throws(
      () => assertIndependentOracleGraph([join(dir, 'entry.mjs')]),
      /reaches production/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('structural fact identities preserve nested facts and ignore object property order', () => {
  const fact = compileDocumentation({
    type: 'array',
    items: { type: 'string', enum: ['red', 'green'], minLength: 2 },
  }).root;
  const reverse = (value) =>
    Array.isArray(value)
      ? value.map(reverse)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value)
              .reverse()
              .map(([key, child]) => [key, reverse(child)]),
          )
        : value;
  assert.equal(factIdentity(fact), factIdentity(reverse(fact)));
  for (const delta of [
    { nullable: true },
    { value: { kind: 'safe-integer' } },
    { checks: { minLength: 3 } },
    { enum: ['green', 'red'] },
    { model: 'ReadableModel' },
    { reference: 'ReadableReference' },
    { description: 'Distinct annotation.' },
    { defaultValue: '"red"' },
    { required: ['extra'] },
  ])
    assert.notEqual(
      factIdentity(fact),
      factIdentity({ ...fact, item: { ...fact.item, ...delta } }),
    );
  assert.notEqual(factIdentity(fact), factIdentity({ ...fact, nullable: true }));
  assert.equal(factIdentity({}), factIdentity({ model: undefined }));
});

test('schema fact memoization retains field order and direction', () => {
  const definitions = {};
  const first = { type: 'string', description: 'First field.' };
  const second = { type: 'string', description: 'Second field.', readOnly: true };
  const schema = { type: 'object', properties: { first, second } };
  const response = compileDocumentation(schema, definitions, true);
  assert.equal(compileDocumentation(schema, definitions, true).root, response.root);
  const reordered = compileDocumentation(
    { type: 'object', properties: { second, first } },
    definitions,
    true,
  );
  assert.deepEqual(Object.keys(response.root.fields), ['first', 'second']);
  assert.deepEqual(Object.keys(reordered.root.fields), ['second', 'first']);
  assert.equal(factIdentity(response.root), factIdentity(reordered.root));
  assert.deepEqual(Object.keys(compileDocumentation(schema, definitions, false).root.fields), [
    'first',
  ]);
});

test('hoisted common prose follows compiler conjunctions without leaking branch or child prose', () => {
  const definitions = {
    Common: {
      type: 'object',
      description: 'Common description.',
      properties: { value: { type: 'string', description: 'Child description.' } },
    },
  };
  assert.deepEqual(
    documentationDescriptions(
      {
        description: 'Outer description.',
        allOf: [{ 'x-sdk-ref': 'Common' }],
        oneOf: [{ description: 'Branch description.', type: 'object' }],
      },
      definitions,
    ),
    ['Outer description.', 'Common description.'],
  );
});

test('fact trees retain container/item/value nullability, every branch constraint and annotations', () => {
  const schema = {
    type: ['array', 'null'],
    items: {
      type: ['object', 'null'],
      additionalProperties: {
        type: ['string', 'null'],
        enum: ['red', 'green'],
        minLength: 2,
        description: 'Value description.',
        default: 'red',
      },
    },
    minItems: 1,
    maxItems: 3,
    uniqueItems: true,
  };
  const { root } = compileDocumentation(schema);
  assert.equal(root.nullable, true);
  assert.equal(root.item.nullable, true);
  assert.equal(root.item.extra.nullable, true);
  assert.equal(root.item.extra.value.kind, 'string');
  assert.deepEqual(root.item.extra.enum, ['red', 'green']);
  assert.equal(root.item.extra.description, 'Value description.');
  assert.equal(root.item.extra.defaultValue, '"red"');
  assert.deepEqual(root.checks, { minItems: 1, maxItems: 3, uniqueItems: true });
});

test('shared documentation inventories preserve direction-specific field presence', () => {
  const schema = {
    type: 'object',
    properties: {
      server: { type: 'string', readOnly: true },
      client: { type: 'string', writeOnly: true },
    },
    required: ['server', 'client'],
  };
  const definitions = {};
  for (const response of [false, true, false, true]) {
    const facts = compileDocumentation(schema, definitions, response).root;
    assert.deepEqual(Object.keys(facts.fields), response ? ['server'] : ['client']);
    assert.deepEqual(facts.required, response ? ['server'] : ['client']);
    const expected = expectedFieldFacts(schema, definitions, {}, response).map((fact) => ({
      path: '$.' + fact.field,
      presence: fact.presence,
      type: fact.type,
      links: fact.links,
    }));
    const php = compilePhpModel(
      'Directional',
      { type: 'object', properties: { nested: schema } },
      response,
      new Map(),
    );
    for (const comment of [
      schemaComment(schema, definitions, response),
      '/** ' + php.documentation.nested.description + ' */',
    ]) {
      const actual = sourceFactRows(comment)[0]
        .filter((fact) => fact.path !== '$')
        .map(({ path, presence, type, links }) => ({ path, presence, type, links }));
      assert.deepEqual(actual, expected, comment);
    }
  }
});

test('independent certifier covers value branches, nested collections and declaration comments in both targets', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sdk-documentation-facts-'));
  try {
    const contract = fixture(directory);
    const oracleInput = rawDocumentationInput(
      join(directory, 'api.json'),
      join(directory, 'sdk.json'),
    );
    const output = join(directory, 'out');
    generate(contract, output);
    for (const target of ['node', 'php']) {
      const root = join(output, target);
      assertPackageLinks(root);
      assertUniqueFieldTables(root);
      const result = assertCanonicalBranchDocumentation(root, oracleInput);
      assert.ok(result.checkedBranches >= 10);
      assert.ok(result.checkedFacts >= 10);
      assertCanonicalOperationDocumentation(root, oracleInput);
      const docs = packageDocuments(root)
        .map((p) => readFileSync(p, 'utf8'))
        .join('\n');
      assert.match(docs, /Array of \(string or null\)/);
      assert.match(docs, /minItems: `2`/);
      assert.match(docs, /minItems: `3`/);
      assert.match(docs, /uniqueItems: `true`/);
      assert.match(docs, /"blue"/);
      // Field tables retain element types; low-level Result.data summaries may be generic.
      assert.deepEqual(
        docs
          .split('\n')
          .filter(
            (line) => line.startsWith('| `') && /Array of any|list(?:&lt;|<)mixed/.test(line),
          ),
        [],
      );
      const sourceDir = join(root, target === 'node' ? 'declarations' : 'src/classes');
      const source = readdirSync(sourceDir)
        .filter((name) => /\.(?:d\.ts|php)$/.test(name))
        .map((name) => readFileSync(join(sourceDir, name), 'utf8'))
        .join('\n');
      const definitions = oracleInput.definitions;
      const names = Object.fromEntries(
        Object.keys(definitions).map((name) => [name, name + 'Input']),
      );
      for (const field of Object.values(oracleInput.models.Facts.properties))
        assertSourceFieldDocumentation(source, field, definitions, names);
      assert.doesNotMatch(source, /Shape \$/);
      assert.match(source, /minItems: 2/);
      assert.match(source, /minItems: 3/);
      assert.match(source, /Array of \(string or null\)/);
      const annotated = [...source.matchAll(/\/\*\*[\s\S]*?\*\//g)]
        .map(([comment]) => comment.replace(/\n\s*\* ?/g, ' '))
        .filter((comment) => comment.includes('A synthetic description.'));
      assert.ok(annotated.length, `${target}: scalar annotation witness`);
      for (const comment of annotated) {
        assert.equal(comment.split('A synthetic description.').length - 1, 1, comment);
        assert.equal(comment.split('Default: "placeholder".').length - 1, 1, comment);
        assert.equal(comment.split('"other"').length - 1, 1, comment);
      }
      for (const [annotation, failure] of [
        ['Integer branch annotation.', /lost .* description/],
        ['Default: `2`.', /lost .* default/],
      ]) {
        const changed = packageDocuments(root)
          .map((path) => [path, readFileSync(path, 'utf8')])
          .filter(([, text]) => text.includes(annotation));
        assert.ok(changed.length, `${target}: annotation mutation applies`);
        for (const [path, text] of changed) writeFileSync(path, text.replaceAll(annotation, ''));
        try {
          assert.throws(() => assertCanonicalBranchDocumentation(root, oracleInput), failure);
        } finally {
          for (const [path, text] of changed) writeFileSync(path, text);
        }
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('every coupled compiler, projection and renderer mutation fails the raw-schema oracle', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sdk-documentation-mutations-'));
  try {
    const contract = fixture(directory);
    const oracleInput = rawDocumentationInput(
      join(directory, 'api.json'),
      join(directory, 'sdk.json'),
    );
    for (const [label, file, before, after, affected = ['node', 'php']] of mutations)
      await t.test(label, async () => {
        const isolated = join(directory, label.replaceAll(' ', '-'));
        mkdirSync(isolated);
        cpSync('dist', join(isolated, 'dist'), { recursive: true });
        cpSync('templates', join(isolated, 'templates'), { recursive: true });
        cpSync('LICENSE', join(isolated, 'LICENSE'));
        cpSync('tests/helpers', join(isolated, 'tests/helpers'), { recursive: true });
        symlinkSync(resolve('node_modules'), join(isolated, 'node_modules'));
        writeFileSync(join(isolated, 'package.json'), '{"type":"module"}');
        const path = join(isolated, 'dist', file),
          original = readFileSync(path, 'utf8');
        assert.ok(original.includes(before), label + ': mutation applies');
        let changed = original.replace(before, after);
        if (label === 'PHP model links')
          changed +=
            '\nexport function phpModelReference(...args){return _mutatedPhpModelReference(...args).replace(/\\[([^\\]]+)\\]\\(MODELS\\.md#[^)]+\\)/g,"$1");}\n';
        writeFileSync(path, changed);
        const generator = await import(pathToFileURL(join(isolated, 'dist/index.js')).href);
        const oracle = await import(
          pathToFileURL(join(isolated, 'tests/helpers/canonical-docs.mjs')).href
        );
        const output = join(isolated, 'out');
        generator.generate(contract, output);
        for (const target of ['node', 'php']) {
          const certify = () => {
            oracle.assertCanonicalBranchDocumentation(join(output, target), oracleInput);
            oracle.assertCanonicalOperationDocumentation(join(output, target), oracleInput);
          };
          if (affected.includes(target))
            assert.throws(
              certify,
              /lost|degraded|missing/,
              `${label}: ${target} must detect the coupled mutation`,
            );
          else assert.doesNotThrow(certify, `${label}: ${target} clean control`);
        }
        if (label === 'constraint-only merge')
          for (const target of ['node', 'php'])
            assert.throws(
              () =>
                oracle.assertCanonicalBranchDocumentation(
                  join(output, target),
                  oracleInput,
                  undefined,
                  new Set(['ConstraintOnly', 'ConstraintOnlyInput']),
                ),
              /ConstraintOnly(?:Input)? branch 2: lost \$value constraints/,
              `${target}: branches differing only in minItems/maxItems must stay distinct`,
            );
        if (
          [
            'container nullability',
            'item nullability',
            'item type',
            'model link',
            'branch constraint',
          ].includes(label)
        ) {
          const sourceOracle = await import(
            pathToFileURL(join(isolated, 'tests/helpers/source-documentation.mjs')).href
          );
          for (const target of ['node', 'php']) {
            const sourceDir = join(
              output,
              target,
              target === 'node' ? 'declarations' : 'src/classes',
            );
            const source = readdirSync(sourceDir)
              .filter((name) => /\.(?:d\.ts|php)$/.test(name))
              .map((name) => readFileSync(join(sourceDir, name), 'utf8'))
              .join('\n');
            const definitions = oracleInput.definitions;
            const names = Object.fromEntries(
              Object.keys(definitions).map((name) => [name, name + 'Input']),
            );
            assert.throws(
              () => {
                for (const field of Object.values(oracleInput.models.Facts.properties))
                  sourceOracle.assertSourceFieldDocumentation(source, field, definitions, names);
              },
              /lost a fact/,
              `${target}: source-comment witness for ${label}`,
            );
          }
        }
      });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('nullable named response positions and inline item enums match both clients', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sdk-round6-facts-'));
  try {
    const contract = fixture(directory),
      output = join(directory, 'out');
    generate(contract, output);
    const raw = rawDocumentationInput(join(directory, 'api.json'), join(directory, 'sdk.json'));
    for (const target of ['node', 'php']) {
      const root = join(output, target);
      assertCanonicalBranchDocumentation(root, raw);
      assertCanonicalOperationDocumentation(root, raw);
      const op = operationDocuments(root).find((o) => o.name === 'api.inlineBranches');
      const response = linkedModelSections(
        op.path,
        op.source.split('#### Response')[1].split('#### Errors')[0],
      )[0];
      for (const [field, type] of [
        ['single', '\\[[^\\]]+\\]\\([^)]+\\) or null'],
        ['items', 'Array of \\(\\[[^\\]]+\\]\\([^)]+\\) or null\\)'],
        ['map', 'Map of \\(\\[[^\\]]+\\]\\([^)]+\\) or null\\)'],
      ])
        assert.match(
          response.source,
          new RegExp('\\| `' + field + '` \\| Required \\| ' + type + ' \\|'),
        );
      assert.match(response.source, /\| `nonnull` \| Required \| \[[^\]]+\]\([^)]+\) \|/);
      assert.match(
        op.source,
        /Value shape: Array of string\. minItems: `2`\. maxItems: `2`\. uniqueItems: `true`\. Items values: `"red"`, `"green"`\./,
      );
      assert.match(
        op.source,
        /Value shape: Array of string\. minItems: `3`\. maxItems: `3`\. uniqueItems: `true`\. Items values: `"red"`, `"green"`, `"blue"`\./,
      );
    }
    const payload = {
      single: null,
      items: [null],
      map: { placeholder: null },
      nonnull: { id: 'placeholder' },
    };
    const { Client } = await import(pathToFileURL(join(output, 'node/index.js')).href);
    let sent = 0;
    const client = new Client({
      baseUrl: 'http://localhost:9876',
      allowInsecureHttp: true,
      transport: async () => {
        sent++;
        return new Response(JSON.stringify(payload), {
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    for (const body of [
      ['red', 'green'],
      ['red', 'green', 'blue'],
    ])
      assert.deepEqual(
        JSON.parse(JSON.stringify(await client.api.inlineBranches({ body }))),
        payload,
      );
    const before = sent;
    await assert.rejects(
      client.api.inlineBranches({ body: ['blue', 'red'] }),
      (e) => e.name === 'InvalidInputError',
    );
    assert.equal(sent, before);
    const script = join(directory, 'runtime.php');
    writeFileSync(
      script,
      `<?php
require ${JSON.stringify(join(output, 'php/src/Client.php'))};
$sent=0;
$client=new \\Example\\Facts\\Client(new \\Example\\Facts\\ClientOptions(baseUrl:'http://localhost:9876', allowInsecureHttp:true, transport:function($request)use(&$sent){$sent++;return ['status'=>200,'headers'=>['content-type'=>'application/json'],'body'=>${JSON.stringify(JSON.stringify(payload))}];}));
foreach([['red','green'],['red','green','blue']] as $body){$response=$client->api->inlineBranches(['body'=>$body]);if($response->getSingle()!==null||$response->getItems()!==[null]||$response->getMap()!==['placeholder'=>null])throw new \\RuntimeException('valid nullable response');}
$before=$sent;try{$client->api->inlineBranches(['body'=>['blue','red']]);throw new \\RuntimeException('invalid body accepted');}catch(\\Example\\Facts\\SdkError $e){if(substr(strrchr(get_class($e), chr(92)), 1)!=='InvalidInputError')throw $e;}if($sent!==$before)throw new \\RuntimeException('dispatched invalid body');
`,
    );
    const result = spawnSync('php', [script], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr + result.stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('raw payload projection intersects reference siblings before deriving requiredness', () => {
  const ref = (name) => ({ $ref: '#/components/schemas/' + name });
  const raw = rawDocumentationInput(
    {
      openapi: '3.1.0',
      components: {
        schemas: {
          Payload: {
            type: 'object',
            properties: { payment_collection: { type: 'object' } },
            required: [],
          },
          Envelope: { type: 'object', properties: { data: ref('Payload') }, required: ['data'] },
        },
      },
      paths: {
        '/value': {
          get: {
            operationId: 'value',
            responses: {
              200: {
                content: {
                  'application/json': {
                    schema: {
                      allOf: [
                        ref('Envelope'),
                        { properties: { data: { required: ['payment_collection'] } } },
                      ],
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    { responses: { return: 'payload', payloadPath: 'data' } },
  );
  const schemas = payloadSchemas(raw.operations[0], raw.definitions);
  assert.equal(schemas.length, 1);
  assert.equal(
    expectedFieldFacts(schemas[0], raw.definitions, {}, true).find(
      (f) => f.field === 'payment_collection',
    ).presence,
    'Required',
  );
});

test('raw documentation expectations honor native counters and exact component shapes', () => {
  const money = {
    type: 'object',
    properties: { amount: { type: 'integer', format: 'int64' }, currency: { type: 'string' } },
  };
  const api = {
    components: {
      schemas: {
        Money: money,
        Version: { type: 'integer', format: 'int64' },
        Inline: { type: 'object', properties: { amount_money: money } },
      },
    },
  };
  const native = rawDocumentationInput(api, {
    integers: { mode: 'number', exactComponents: ['Money'] },
  });
  assert.equal(schemaInstruction(native.models.Version).value.kind, 'safe-integer');
  assert.equal(native.models.Version.format, 'int64', 'wire format documentation stays intact');
  assert.equal(
    schemaInstruction(native.models.Money.properties.amount).value.kind,
    'exact-integer',
  );
  assert.equal(
    schemaInstruction(native.models.Inline.properties.amount_money.properties.amount).value.kind,
    'exact-integer',
  );
  assert.equal(
    schemaInstruction(rawDocumentationInput(api, {}).models.Version).value.kind,
    'exact-integer',
  );
});
