import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generate, loadContract } from '../dist/index.js';
import { modelFieldReference } from '../dist/sdk-documentation.js';
import { compilePhpModel, compileSdkContract } from '../dist/target-plan.js';
import { compareCompiledContracts } from '../dist/compiled-compatibility.js';
import {
  assertPackageLinks,
  packageDocuments,
  assertUniqueFieldTables,
} from './helpers/package-docs.mjs';
import {
  assertCanonicalOperationDocumentation,
  operationDocuments,
  linkedModelSections,
} from './helpers/canonical-docs.mjs';
import {
  assertDocumentedModelExports,
  assertDocumentedPhpExports,
} from './helpers/docs-exports.mjs';

const string = { type: 'string' };
const object = (properties, required = []) => ({ type: 'object', properties, required });
const branch = (tag, field) =>
  object(
    {
      mode: { const: tag },
      [field]: { type: 'array', items: { type: 'string', enum: ['first', 'second'] } },
    },
    ['mode', field],
  );
const ref = (name) => ({ $ref: '#/components/schemas/' + name });
const response = (schema) => ({
  description: 'Synthetic response',
  content: { 'application/json': { schema } },
});

test('canonical union tables retain effective branch fields, presence and enums in both targets', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sdk-canonical-docs-'));
  try {
    const shared = {
      anyOf: [
        object(
          {
            shared_email: { ...string, description: 'Unique shared email definition. '.repeat(6) },
          },
          ['shared_email'],
        ),
        object({ shared_postal: { ...string, enum: ['home', 'office'] } }, ['shared_postal']),
      ],
    };
    const schemas = {
      EnvelopeOne: object({ data: { type: 'array', items: shared } }, ['data']),
      EnvelopeTwo: object(
        {
          data: {
            type: 'array',
            items: {
              anyOf: [
                object({ separate_left: string }, ['separate_left']),
                object({ separate_right: string }, ['separate_right']),
              ],
            },
          },
        },
        ['data'],
      ),
      ConstraintGroups: {
        oneOf: [1, 2].map((length) =>
          object(
            {
              code: {
                type: 'string',
                description: 'Stable constrained definition.',
                enum: [length === 1 ? 'first' : 'second'],
                minLength: length,
              },
            },
            ['code'],
          ),
        ),
      },
      OwnerOne: object({
        choice: shared,
        owner_one: string,
        nullable_named: { anyOf: [ref('NamedChoice'), { type: 'null' }] },
      }),
      OwnerTwo: object({
        choice: shared,
        owner_two: string,
        nullable_named: { anyOf: [ref('NamedChoice'), { type: 'null' }] },
      }),
      MultiGroup: {
        ...object({
          first: { ...string, description: 'Stable first definition.' },
          second: { ...string, description: 'Stable second definition.' },
        }),
        allOf: ['first', 'second'].map((field) => ({
          anyOf: [{ not: { required: [field] } }, { required: [field] }, { required: [field] }],
        })),
      },
      Conditional: {
        allOf: [
          object(
            {
              id: string,
              mode: string,
              eligibility: { type: 'array', items: string },
              resolution: { type: 'array', items: string },
            },
            ['id'],
          ),
          {
            oneOf: [branch('eligibility', 'eligibility'), branch('resolution', 'resolution')],
            discriminator: { propertyName: 'mode' },
          },
        ],
      },
      Directional: {
        oneOf: [
          object(
            {
              mode: { enum: ['input'] },
              secret: { ...string, writeOnly: true },
              server_id: { ...string, readOnly: true },
            },
            ['mode', 'secret', 'server_id'],
          ),
          object({ mode: { enum: ['other'] }, value: string }, ['mode', 'value']),
        ],
      },
      NamedChoice: {
        oneOf: [branch('left', 'left_values'), branch('right', 'right_values')],
        discriminator: { propertyName: 'mode' },
      },
      Untagged: {
        anyOf: [object({ email: string }, ['email']), object({ address: string }, ['address'])],
      },
      Nested: object(
        {
          details: { oneOf: [branch('email', 'email_values'), branch('postal', 'postal_values')] },
        },
        ['details'],
      ),
      Revocation: object({ revoked: { type: 'boolean' } }, ['revoked']),
    };
    const operation = (name, output, body) => ({
      operationId: name,
      tags: ['records'],
      ...(body
        ? {
            requestBody: { required: true, content: { 'application/json': { schema: ref(body) } } },
          }
        : {}),
      responses: { 200: response(ref(output)) },
    });
    writeFileSync(
      join(directory, 'api.json'),
      JSON.stringify({
        openapi: '3.1.0',
        info: { title: 'Canonical docs', version: '1' },
        components: { schemas },
        paths: {
          '/envelope-one': { get: operation('envelopeOne', 'EnvelopeOne') },
          '/envelope-two': { get: operation('envelopeTwo', 'EnvelopeTwo') },
          '/constraints': { get: operation('constraints', 'ConstraintGroups') },
          '/owner-one': { post: operation('ownerOne', 'OwnerOne', 'MultiGroup') },
          '/owner-two': { post: operation('ownerTwo', 'OwnerTwo', 'MultiGroup') },
          '/directional': { post: operation('directional', 'Directional', 'Directional') },
          '/directional-second': {
            post: operation('directionalSecond', 'Revocation', 'Directional'),
          },
          '/first': { post: operation('first', 'NamedChoice', 'Conditional') },
          '/second': { post: operation('second', 'Untagged', 'Conditional') },
          '/nested': { get: operation('nested', 'Nested') },
          '/revoke': { post: operation('revoke', 'Revocation', 'Revocation') },
        },
      }),
    );
    writeFileSync(
      join(directory, 'sdk.json'),
      JSON.stringify({
        version: '1.0.0',
        requests: { style: 'object' },
        responses: { return: 'payload' },
        npm: { name: '@example/canonical' },
        composer: { name: 'example/canonical', namespace: 'Example\\Canonical' },
      }),
    );
    const contract = loadContract(join(directory, 'api.json'), join(directory, 'sdk.json'));
    const compiled = compileSdkContract(contract).plan;
    const annotated = structuredClone(compiled);
    for (const model of annotated.php.models)
      model.documentationSchema = {
        ...model.documentationSchema,
        description: 'Documentation-only change.',
      };
    assert.deepEqual(
      compareCompiledContracts(compiled, annotated),
      [],
      'source documentation is not an execution descriptor',
    );
    const output = join(directory, 'out');
    generate(contract, output);
    for (const target of ['node', 'php']) {
      const root = join(output, target);
      assertPackageLinks(root);
      assertUniqueFieldTables(root);
      (target === 'node' ? assertDocumentedModelExports : assertDocumentedPhpExports)(root);
      const coverage = assertCanonicalOperationDocumentation(root, contract);
      assert.ok(
        coverage.suppressed >= 3,
        `${target}: cover shared request and named response suppression`,
      );
      assert.ok(coverage.checkedFacts >= 12, `${target}: check branch-specific facts`);
      const docs = packageDocuments(root)
        .filter((path) => /MODELS.md|\/models\//.test(path))
        .map((path) => readFileSync(path, 'utf8'))
        .join('\n');
      for (const field of [
        'eligibility',
        'resolution',
        'left_values',
        'right_values',
        'email',
        'address',
        'email_values',
        'postal_values',
      ])
        assert.match(docs, new RegExp('\\| `' + field + '` \\| (?:Required|Conditional) \\|'));
      assert.match(docs, /variant 1: `mode` = `"eligibility"`/);
      assert.match(docs, /variant 2: `mode` = `"resolution"`/);
      assert.match(docs, /Field definitions apply to all variants/);
      assert.match(docs, /Items values: `"first"`, `"second"`/);
      if (target === 'node') {
        assert.match(docs, /`nullable_named` \| Optional \| \[NamedChoice\]\([^)]+\) or null/);
        assert.equal(
          (docs.match(/^\| `left_values` \|/gm) ?? []).length,
          1,
          'named nullable branches use their canonical model',
        );
      } else {
        assert.match(docs, /`nullable_named`: \[NamedChoiceInput\]\([^)]+\) or null/);
        assert.match(
          docs,
          /### ApiOwnerOneResponse200.nullable_named[\s\S]*?- Required: [^\n]*`left_values`/,
        );
      }
      assert.equal(
        (docs.match(/Unique shared email definition/g) ?? []).length,
        6,
        `${target}: both owners share one anonymous union definition`,
      );
      for (const definition of [
        'Stable first definition.',
        'Stable second definition.',
        'Stable constrained definition.',
      ])
        assert.equal(
          docs.split(definition).length - 1,
          1,
          `${target}: stable definition appears once`,
        );
      for (const field of ['first', 'second']) {
        assert.equal(
          (docs.match(new RegExp('^- Required: `' + field + '`\\.', 'gm')) ?? []).length,
          1,
          `${target}: dedupe identical alternatives`,
        );
        assert.match(docs, new RegExp('- Condition: not \\(present\\(`' + field + '`'));
      }
      assert.match(docs, /Constraints for `code`: minLength: `1`\. Values: `"first"`/);
      assert.match(docs, /Constraints for `code`: minLength: `2`\. Values: `"second"`/);
      const directional = operationDocuments(root).find((op) => op.name.endsWith('.directional'));
      const inputs = linkedModelSections(
        directional.path,
        directional.source.split('#### Response')[0],
      );
      assert.ok(inputs.some((model) => model.source.includes('| `secret` | Conditional |')));
      assert.ok(inputs.every((model) => !model.source.includes('| `server_id` |')));
      const revoke = operationDocuments(root).find((op) => op.name.endsWith('.revoke'));
      const returned = linkedModelSections(
        revoke.path,
        revoke.source.split('#### Response')[1].split('#### Errors')[0],
      );
      assert.ok(returned.length);
      assert.match(returned[0].source, /\| `revoked` \| Required \|/);
      if (target === 'php') assert.equal(returned[0].label, 'ApiRevokeResponse200');
      const first = operationDocuments(root).find((op) => op.name.endsWith('.first'));
      const branchDoc = linkedModelSections(
        first.path,
        first.source.split('#### Response')[0],
      ).find((model) => model.source.includes('| `eligibility` | Conditional |'));
      assert.ok(branchDoc);
      const original = readFileSync(branchDoc.path, 'utf8');
      writeFileSync(
        branchDoc.path,
        original.replace(
          branchDoc.source,
          branchDoc.source.replace(/^\| `eligibility` \|.*\n/gm, ''),
        ),
      );
      assert.throws(
        () => assertCanonicalOperationDocumentation(root, contract),
        /lost.*eligibility/,
      );
      writeFileSync(branchDoc.path, original);
      writeFileSync(
        branchDoc.path,
        original.replace(
          branchDoc.source,
          branchDoc.source.replace('- Required: `eligibility`.', '- Optional: `eligibility`.'),
        ),
      );
      assert.throws(
        () => assertCanonicalOperationDocumentation(root, contract),
        /lost.*eligibility/,
      );
      writeFileSync(branchDoc.path, original);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('independent composed union groups stay explicit without multiplying combinations', () => {
  const schema = {
    allOf: ['first', 'second', 'third'].map((name) => ({
      anyOf: [
        object({ [name]: string }, [name]),
        object({ [name + '_alternative']: string }, [name + '_alternative']),
      ],
    })),
  };
  const docs = modelFieldReference(schema, {}, 'Groups');
  assert.equal((docs.match(/^### Groups variant /gm) ?? []).length, 6);
  assert.match(docs, /satisfy a variant from each numbered group/);
  for (const name of ['first', 'second', 'third']) {
    assert.match(docs, new RegExp('\\| `' + name + '` \\| Conditional \\|'));
    assert.match(docs, new RegExp('\\| `' + name + '_alternative` \\| Conditional \\|'));
  }
});

test('PHP source documentation keeps union branches without publishing response examples', () => {
  const schema = object({
    choice: {
      oneOf: [
        object({ value: { ...string, example: 'synthetic-private-example' } }, ['value']),
        object({ other: string }, ['other']),
      ],
    },
  });
  const plan = compilePhpModel('Response', schema, true, new Map(), schema, {}, false);
  assert.equal(
    JSON.stringify(plan.documentationSchema).includes('synthetic-private-example'),
    false,
  );
  assert.match(
    modelFieldReference(plan.documentationSchema, {}, 'Response'),
    /\| `value` \| Conditional \|/,
  );
});

test('referenced alternatives retain enclosing requiredness without impossible tag combinations', () => {
  const alternatives = {
    oneOf: [
      object({ mode: { enum: ['left'] }, left: string }, ['mode', 'left']),
      object({ mode: { enum: ['right'] }, right: string }, ['mode', 'right']),
    ],
  };
  const schema = {
    allOf: [object({ id: string }, ['id']), { 'x-sdk-ref': 'Choice' }, { 'x-sdk-ref': 'Choice' }],
  };
  const docs = modelFieldReference(schema, { Choice: alternatives }, 'Composed');
  assert.equal((docs.match(/^### Composed variant /gm) ?? []).length, 2);
  assert.equal((docs.match(/\| `id` \| Required \|/g) ?? []).length, 1);
  assert.match(docs, /\| `left` \| Conditional \|/);
  assert.match(docs, /\| `right` \| Conditional \|/);
});

test('inline nested unions keep branch tables through arrays and map values', () => {
  const union = {
    anyOf: [object({ email: string }, ['email']), object({ postal: string }, ['postal'])],
  };
  const schema = object({
    nested: object({ choice: union }),
    items: { type: 'array', items: union },
    mapping: { type: 'object', additionalProperties: union },
  });
  const docs = modelFieldReference(schema, {}, 'Container');
  for (const path of ['nested.choice', 'items[]', 'mapping{}'])
    assert.ok(docs.includes('### Container.' + path));
  assert.equal((docs.match(/\| `email` \| Conditional \|/g) ?? []).length, 3);
  assert.equal((docs.match(/\| `postal` \| Conditional \|/g) ?? []).length, 3);
});

test('nested union fields retain their enclosing branch condition', () => {
  const nested = (name) => ({
    anyOf: [
      object({ [name]: string }, [name]),
      object({ [name + '_other']: string }, [name + '_other']),
    ],
  });
  const schema = {
    oneOf: [
      object({ mode: { enum: ['first'] }, details: nested('first_field') }, ['mode', 'details']),
      object({ mode: { enum: ['second'] }, details: nested('second_field') }, ['mode', 'details']),
    ],
  };
  const docs = modelFieldReference(schema, {}, 'Outer');
  assert.match(docs, /### Outer variant 1.details[\s\S]*?\| `first_field` \| Conditional \|/);
  assert.match(docs, /### Outer variant 2.details[\s\S]*?\| `second_field` \| Conditional \|/);
  const shared = nested('shared');
  const repeated = modelFieldReference(
    {
      oneOf: [
        object({ mode: { enum: ['required'] }, details: shared }, ['mode', 'details']),
        object({ mode: { enum: ['optional'] }, details: shared }, ['mode']),
      ],
    },
    {},
    'Presence',
  );
  assert.equal((repeated.match(/^### Presence.details$/gm) ?? []).length, 1);
  assert.match(repeated, /variant 1: `mode` = `"required"`[\s\S]*?- Required: `details`/);
  assert.match(repeated, /variant 2: `mode` = `"optional"`[\s\S]*?- Optional: `details`/);
});

test('same-instance recursive union references terminate while retaining concrete branches', () => {
  const recursive = { oneOf: [{ 'x-sdk-ref': 'Recursive' }, object({ value: string }, ['value'])] };
  const docs = modelFieldReference(recursive, { Recursive: recursive }, 'Recursive');
  assert.ok(docs.length < 10000);
  assert.match(docs, /\| `value` \| Conditional \|/);
});

test('the package field-table guard detects a repeated fragment and ignores fenced examples', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sdk-doc-table-guard-'));
  try {
    const table =
      '| Field | Presence | Type | Description |\n| --- | --- | --- | --- |\n| `value` | Required | string | ' +
      'Synthetic field description. '.repeat(10) +
      ' |\n';
    writeFileSync(join(directory, 'first.md'), table);
    writeFileSync(join(directory, 'second.md'), '```markdown\n' + table + '```\n');
    assert.equal(assertUniqueFieldTables(directory), 1);
    writeFileSync(join(directory, 'second.md'), table);
    assert.throws(() => assertUniqueFieldTables(directory), /repeated.*field table/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
