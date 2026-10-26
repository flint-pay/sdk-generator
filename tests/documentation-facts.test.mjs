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
import { compileDocumentation } from '../dist/documentation-plan.js';
import { schemaComment } from '../dist/schema-documentation.js';
import { compilePhpModel } from '../dist/target-plan.js';
import { expectedFieldFacts } from './helpers/documentation-expectations.mjs';
import {
  assertCanonicalBranchDocumentation,
  assertCanonicalOperationDocumentation,
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

test('certifier expectations cannot import documentation compilers or formatters', () => {
  const expectations = readFileSync(
    new URL('./helpers/documentation-expectations.mjs', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(
    expectations,
    /from ['"][^'"]*(?:sdk-documentation|documentation-format|documentation-plan)/,
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
    const output = join(directory, 'out');
    generate(contract, output);
    for (const target of ['node', 'php']) {
      const root = join(output, target);
      assertPackageLinks(root);
      assertUniqueFieldTables(root);
      const result = assertCanonicalBranchDocumentation(root, contract);
      assert.ok(result.checkedBranches >= 10);
      assert.ok(result.checkedFacts >= 10);
      assertCanonicalOperationDocumentation(root, contract);
      const docs = packageDocuments(root)
        .map((p) => readFileSync(p, 'utf8'))
        .join('\n');
      assert.match(docs, /Array of \(string or null\)/);
      assert.match(docs, /minItems: `2`/);
      assert.match(docs, /minItems: `3`/);
      assert.match(docs, /uniqueItems: `true`/);
      assert.match(docs, /"blue"/);
      assert.doesNotMatch(docs, /Array of any|list(?:&lt;|<)mixed/);
      const sourceDir = join(root, target === 'node' ? 'declarations' : 'src/classes');
      const source = readdirSync(sourceDir)
        .filter((name) => /\.(?:d\.ts|php)$/.test(name))
        .map((name) => readFileSync(join(sourceDir, name), 'utf8'))
        .join('\n');
      const definitions = contract.definitions ?? contract.models;
      const names = Object.fromEntries(
        Object.keys(definitions).map((name) => [name, name + 'Input']),
      );
      for (const field of Object.values(contract.models.Facts.properties))
        assertSourceFieldDocumentation(source, field, definitions, names);
      assert.match(source, /Shape \$/);
      assert.match(source, /minItems: 2/);
      assert.match(source, /minItems: 3/);
      assert.match(source, /Array of \(string or null\)/);
      const annotated = [...source.matchAll(/\/\*\*[\s\S]*?\*\//g)]
        .map(([comment]) => comment.replace(/\n\s*\* ?/g, ' '))
        .filter((comment) => comment.includes('Shape $ (Value): string. A synthetic description.'));
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
          assert.throws(() => assertCanonicalBranchDocumentation(root, contract), failure);
        } finally {
          for (const [path, text] of changed) writeFileSync(path, text);
        }
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('all seven coupled renderer mutations fail the independent oracle in both targets', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sdk-documentation-mutations-'));
  try {
    const contract = fixture(directory);
    for (const [label, file, before, after] of mutations)
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
        writeFileSync(path, original.replace(before, after));
        const generator = await import(pathToFileURL(join(isolated, 'dist/index.js')).href);
        const oracle = await import(
          pathToFileURL(join(isolated, 'tests/helpers/canonical-docs.mjs')).href
        );
        const output = join(isolated, 'out');
        generator.generate(contract, output);
        for (const target of ['node', 'php'])
          assert.throws(
            () => oracle.assertCanonicalBranchDocumentation(join(output, target), contract),
            /lost|degraded|missing/,
            `${label}: ${target} must detect the coupled mutation`,
          );
        if (label === 'constraint-only merge')
          for (const target of ['node', 'php'])
            assert.throws(
              () =>
                oracle.assertCanonicalBranchDocumentation(
                  join(output, target),
                  contract,
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
            const definitions = contract.definitions ?? contract.models;
            const names = Object.fromEntries(
              Object.keys(definitions).map((name) => [name, name + 'Input']),
            );
            assert.throws(
              () => {
                for (const field of Object.values(contract.models.Facts.properties))
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
