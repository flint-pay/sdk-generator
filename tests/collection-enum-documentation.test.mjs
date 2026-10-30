import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generate, loadContract } from '../dist/index.js';
import { internDocumentationTables } from '../dist/package-documentation.js';
import { schemaEnumValues } from '../dist/schema-documentation.js';
import { assertPackageLinks, packageDocuments } from './helpers/package-docs.mjs';
import {
  assertDocumentedModelExports,
  assertDocumentedPhpExports,
} from './helpers/docs-exports.mjs';

test('collection enums survive references, nested arrays and maps in both packages and field comments', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sdk-collection-docs-'));
  try {
    const choice = {
      type: 'string',
      enum: ['card', 'apple_pay', 'google_pay', 'affirm', 'ach_debit'],
    };
    const fields = {
      payment_options: { type: 'array', items: choice, description: 'Permitted payment options.' },
      event_sources: { type: 'array', items: { $ref: '#/components/schemas/Source' } },
      nested: {
        type: 'array',
        items: { type: 'array', items: { $ref: '#/components/schemas/Source' } },
      },
      mapping: { type: 'object', additionalProperties: { $ref: '#/components/schemas/Source' } },
      grouped: { type: 'object', additionalProperties: { type: 'array', items: choice } },
      referenced: { $ref: '#/components/schemas/Options' },
    };
    const body = { type: 'object', properties: fields, required: ['payment_options'] };
    const codeValues = Array.from({ length: 30 }, (_, index) => `synthetic_error_${index}`);
    const response = (schema) => ({
      description: 'Synthetic response',
      content: { 'application/json': { schema } },
    });
    const operation = (name, inline) => ({
      operationId: name,
      tags: ['records'],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: inline
              ? { ...body, properties: { ...fields, marker: { type: 'boolean' } } }
              : { $ref: '#/components/schemas/Selection' },
          },
        },
      },
      responses: {
        200: response(
          inline
            ? { type: 'object', properties: { choices: fields.payment_options } }
            : { $ref: '#/components/schemas/Selection' },
        ),
        400: response({ $ref: '#/components/schemas/Failure' }),
      },
    });
    writeFileSync(
      join(directory, 'api.json'),
      JSON.stringify({
        openapi: '3.1.0',
        info: { title: 'Collection docs', version: '1' },
        components: {
          schemas: {
            Selection: body,
            Source: { type: 'string', enum: ['api', 'dashboard'] },
            Options: { type: 'array', items: choice },
            Failure: { type: 'object', properties: { code: { type: 'string', enum: codeValues } } },
          },
        },
        paths: {
          '/first': { post: operation('first', false) },
          '/second': { post: operation('second', false) },
          '/inline': { post: operation('inline', true) },
        },
      }),
    );
    const policy = {
      header: 'Idempotency-Key',
      retention: '24 synthetic hours',
      scope: 'synthetic tenant',
      auto: true,
    };
    writeFileSync(
      join(directory, 'sdk.json'),
      JSON.stringify({
        version: '1.0.0',
        requests: { style: 'object' },
        responses: { return: 'payload' },
        npm: { name: '@example/collections' },
        composer: { name: 'example/collections', namespace: 'Example\\Collections' },
        errors: { objectPath: '', fields: { code: 'code' } },
        operations: {
          first: { resource: 'records', method: 'first', idempotency: policy },
          second: { resource: 'records', method: 'second', idempotency: policy },
          inline: { resource: 'records', method: 'inline' },
        },
      }),
    );
    const output = join(directory, 'out');
    generate(loadContract(join(directory, 'api.json'), join(directory, 'sdk.json')), output);
    for (const target of ['node', 'php']) {
      const root = join(output, target);
      assertPackageLinks(root);
      const docs = packageDocuments(root).map((path) => [path, readFileSync(path, 'utf8')]);
      const models = docs
        .filter(([path]) => /MODELS\.md|\/models\//.test(path))
        .map(([, text]) => text)
        .join('\n');
      const reference = readFileSync(join(root, 'reference/records.md'), 'utf8');
      const runtime = readFileSync(join(root, 'RUNTIME.md'), 'utf8');
      for (const text of [models, reference]) {
        assert.match(
          text,
          /Items values: `"card"`, `"apple_pay"`, `"google_pay"`, `"affirm"`, `"ach_debit"`/,
        );
        assert.match(text, /Items values: `"api"`, `"dashboard"`/);
        assert.match(text, /Items\[\] values: `"api"`, `"dashboard"`/);
        assert.match(text, /Map values: `"api"`, `"dashboard"`/);
        assert.match(text, /Map\[\] values: `"card"`/);
      }
      const first = reference.split('### records.first')[1].split('### records.')[0];
      assert.doesNotMatch(
        first,
        /\| `payment_options`|\| `event_sources`|\| 24 synthetic hours \||Methods accept/,
      );
      assert.match(first, /Returned payload: \[[^\]]+\]/);
      assert.match(first, /Idempotent: key automatic/);
      assert.equal(runtime.split('| 24 synthetic hours |').length - 1, 1);
      assert.equal(
        docs.reduce(
          (count, [, text]) => count + (text.match(/^- `"synthetic_error_0"`$/gm)?.length ?? 0),
          0,
        ),
        1,
      );
      assert.match(models, /\[30 declared values\]\(ERRORS.md#api-error-codes\)/);
      if (target === 'node') {
        assertDocumentedModelExports(root);
        const declarations = readdirSync(join(root, 'declarations'))
          .filter((file) => file.endsWith('.d.ts'))
          .map((file) => readFileSync(join(root, 'declarations', file), 'utf8'))
          .join('\n')
          .replace(/\n\s*\*\s?/g, ' ');
        assert.match(
          declarations,
          /Permitted payment options\. \[\] enum: "card", "apple_pay", "google_pay", "affirm", "ach_debit"/,
        );
        assert.match(declarations, /\[\]\[\] enum: "api", "dashboard"/);
        assert.match(declarations, /\.\* enum: "api", "dashboard"/);
      } else {
        assertDocumentedPhpExports(root);
        const classes = readdirSync(join(root, 'src/classes'))
          .filter((file) => file.endsWith('.php'))
          .map((file) => readFileSync(join(root, 'src/classes', file), 'utf8'))
          .join('\n');
        assert.match(
          classes,
          /Permitted payment options\. \[\] enum: "card", "apple_pay", "google_pay", "affirm", "ach_debit"/,
        );
        assert.match(classes, /\[\]\[\] enum: "api", "dashboard"/);
        assert.match(classes, /\.\* enum: "api", "dashboard"/);
        assert.match(runtime, /\| clientRequestId \|[^\n]*operation declares/i);
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('enum metadata resolves referenced collections without looping recursive definitions', () => {
  const definitions = {
    Values: { type: 'array', items: { 'x-sdk-ref': 'Value' } },
    Value: { enum: ['one', 'two'] },
    Recursive: { type: 'array', items: { 'x-sdk-ref': 'Recursive' } },
  };
  assert.deepEqual(schemaEnumValues({ 'x-sdk-ref': 'Values' }, definitions), [
    { path: '[]', values: ['"one"', '"two"'] },
  ]);
  assert.deepEqual(schemaEnumValues({ 'x-sdk-ref': 'Recursive' }, definitions), []);
});

test('long enum lists have one canonical owner across model files and combined indexes', () => {
  const values = Array.from({ length: 40 }, (_, i) => '- `"synthetic_event_' + i + '"`').join('\n');
  for (const target of ['node', 'php']) {
    const files = new Map([
      [
        target + '/MODELS.md',
        '# Models\n\n## First\n\n[Values](#firstkind-values)\n\n### First.kind values\n\n' +
          values +
          '\n\n## Second\n\n[Values](#secondkind-values)\n\n### Second.kind values\n\n' +
          values +
          '\n\n## Third\n\nRetained model.\n',
      ],
      [
        target + '/models/Another.md',
        '## Another\n\n[Values](#anotherkind-values)\n\n### Another.kind values\n\n' +
          values +
          '\n',
      ],
    ]);
    internDocumentationTables(files, target);
    assert.equal([...files.values()].join('\n').split(values).length - 1, 1);
    assert.match(files.get(target + '/MODELS.md'), /## Third\n\nRetained model/);
    assert.match(files.get(target + '/MODELS.md'), /\[Values\]\(#firstkind-values\)/);
    assert.match(
      files.get(target + '/models/Another.md'),
      /\[Values\]\(\.\.\/MODELS.md#firstkind-values\)/,
    );
    assert.doesNotMatch(
      [...files.values()].join('\n'),
      /### Second.kind values|### Another.kind values/,
    );
  }
});
