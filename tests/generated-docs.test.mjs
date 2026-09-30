import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import MarkdownIt from 'markdown-it';
import ts from 'typescript';
import { loadContract, generate } from '../dist/index.js';
import { fieldTable, modelReference, referenceType } from '../dist/sdk-documentation.js';
import { schemaNotes, schemaComment } from '../dist/schema-documentation.js';
import { localExampleSource } from './local-example.mjs';

const exec = promisify(execFile);
const root = mkdtempSync(join(tmpdir(), 'sdk-generated-docs-'));
after(() => rmSync(root, { recursive: true, force: true }));
const markdown = new MarkdownIt({ html: false });

test('Markdown schema constraints and sample values remain literal while prose links work', () => {
  const pattern = '^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,3}[A-Za-z0-9])?\\.)+[A-Za-z]{2,3}$';
  const example = '[label](https://example.invalid/sample) | `<tag>` \\d';
  const description = 'See [field guide](https://example.invalid/guide).';
  const child = { type: 'string', pattern, example, enum: [example], description };
  const schema = { type: 'object', properties: { domain_name: child } };
  const documents = [
    fieldTable(schema, {}),
    modelReference({ title: 'Synthetic', models: { Domain: schema, Literal: child } }),
  ];
  for (const document of documents) {
    const tokens = markdown.parse(document, {}).flatMap((token) => token.children ?? []);
    const links = tokens
      .filter((token) => token.type === 'link_open')
      .map((token) => token.attrGet('href'));
    assert.ok(links.includes('https://example.invalid/guide'));
    assert.ok(!links.includes('https://example.invalid/sample'));
    assert.ok(!links.some((link) => link.startsWith('?:')));
    const code = tokens
      .filter((token) => token.type === 'code_inline')
      .map((token) => token.content);
    assert.ok(code.includes(pattern));
    assert.ok(code.includes(JSON.stringify(example)));
    const html = markdown.render(document);
    assert.match(html, /&lt;tag&gt;/);
  }
  // Markdown delimiters must not leak into generated declaration comments.
  assert.equal(
    schemaNotes(child),
    `${description} pattern: ${pattern}. Example: ${JSON.stringify(example)}.`,
  );
  assert.equal(schemaComment(child), `/** ${schemaNotes(child)} */ `);
});

test('long type expressions become readable code blocks without changing their TypeScript syntax', () => {
  const source =
    '{ body?: { nested: { ' +
    Array.from(
      { length: 20 },
      (_, index) => `"field_${index}"?: "literal | { , ; } ${index}" | null;`,
    ).join(' ') +
    ' }; }; }';
  const document = referenceType('Input', source, 'node');
  const fence = markdown.parse(document, {}).find((token) => token.type === 'fence');
  assert.ok(fence);
  assert.ok(Math.max(...fence.content.split('\n').map((line) => line.length)) < 100);
  const print = (type) =>
    ts
      .createPrinter()
      .printFile(
        ts.createSourceFile('type.ts', 'type Check = ' + type + ';', ts.ScriptTarget.Latest, true),
      );
  assert.equal(print(fence.content), print(source));
  assert.match(referenceType('Input', 'string | null', 'node'), /`string \| null`/);
  assert.match(referenceType('Input', source, 'php'), /```text/);
});

test('large field enums link to complete nearby lists in the Markdown renderer', () => {
  const values = Array.from({ length: 100 }, (_, index) => `synthetic_code_${index}`);
  const table = fieldTable(
    { type: 'object', properties: { code: { type: 'string', enum: values } } },
    {},
    'Action input',
  );
  const tokens = markdown.parse(table, {});
  const inline = tokens.flatMap((token) => token.children ?? []);
  const link = inline.find((token) => token.type === 'link_open');
  assert.equal(link.attrGet('href'), '#action-input-code-values');
  assert.ok(
    tokens.some((token) => token.type === 'inline' && token.content === 'Action input code values'),
  );
  const literals = inline
    .filter((token) => token.type === 'code_inline')
    .map((token) => token.content);
  for (const value of values) assert.ok(literals.includes(JSON.stringify(value)));
  assert.ok(Math.max(...table.split('\n').map((line) => line.length)) < 160);
  assert.equal(tokens.filter((token) => token.type === 'list_item_open').length, values.length);
});

function fixture(mode) {
  const directory = join(root, mode);
  mkdirSync(directory);
  const paths = {
    '/pdf': {
      get: {
        operationId: 'download',
        responses: { 200: { description: 'PDF', content: { 'application/pdf': {} } } },
      },
    },
    '/redirect': {
      get: {
        operationId: 'redirect',
        responses: {
          307: {
            description: 'Download location',
            headers: { Location: { required: true, schema: { type: 'string' } } },
          },
        },
      },
    },
    '/optional': {
      get: { operationId: 'optional', responses: { 302: { description: 'Optional location' } } },
    },
  };
  writeFileSync(
    join(directory, 'api.json'),
    JSON.stringify({
      openapi: '3.1.0',
      info: { title: 'Download examples', version: '1' },
      paths,
      security: [{ Bearer: [] }],
      components: { securitySchemes: { Bearer: { type: 'http', scheme: 'bearer' } } },
    }),
  );
  writeFileSync(
    join(directory, 'sdk.json'),
    JSON.stringify({
      version: '1.0.0',
      requests: { style: 'object' },
      responses: { return: mode },
      auth: { scheme: 'Bearer' },
      npm: { name: '@example/download-docs' },
      composer: { name: 'example/download-docs', namespace: 'Example\\Downloads' },
      documentation: { examples: ['download', 'redirect', 'optional'] },
    }),
  );
  const output = join(directory, 'out');
  generate(loadContract(join(directory, 'api.json'), join(directory, 'sdk.json')), output);
  mkdirSync(join(output, 'php/vendor'));
  writeFileSync(
    join(output, 'php/vendor/autoload.php'),
    "<?php require_once __DIR__ . '/../src/Runtime.php'; require_once __DIR__ . '/../src/Client.php';",
  );
  return output;
}

async function runSource(output, target, name, source, environment, typescript = false) {
  const file = join(
    output,
    target,
    ...(target === 'php' && source.includes('/../vendor/autoload.php') ? ['examples'] : []),
    name + (target === 'php' ? '.php' : typescript ? '.ts' : '.mjs'),
  );
  writeFileSync(file, localExampleSource(source, target));
  if (target === 'node' && typescript) {
    await exec(process.execPath, [
      resolve('node_modules/typescript/bin/tsc'),
      '--noEmit',
      '--strict',
      '--target',
      'es2022',
      '--module',
      'nodenext',
      '--typeRoots',
      resolve('node_modules/@types'),
      file,
    ]);
  }
  const command = target === 'node' ? process.execPath : 'php';
  const args = typescript ? ['--experimental-strip-types', file] : [file];
  return exec(command, args, { env: { ...process.env, ...environment }, timeout: 15000 });
}

test('download scripts, quickstarts and runtime recipes save exact bytes and inspect redirects in both return modes', async () => {
  const bytes = Buffer.from([37, 80, 68, 70, 0, 255, 128, 10]);
  let followed = 0;
  const destination = createServer((_request, response) => {
    followed++;
    response.end('unexpected');
  });
  await new Promise((done) => destination.listen(0, '127.0.0.1', done));
  const location = `http://127.0.0.1:${destination.address().port}/artifact.pdf`;
  const calls = [];
  const server = createServer((request, response) => {
    calls.push(request.url);
    assert.equal(request.headers.authorization, 'Bearer synthetic-doc-token');
    if (request.url === '/pdf') {
      response.writeHead(200, { 'Content-Type': 'application/pdf', 'x-request-id': 'pdf-docs' });
      response.end(bytes);
    } else if (request.url === '/redirect') {
      response.writeHead(307, { Location: location });
      response.end();
    } else {
      response.writeHead(302);
      response.end();
    }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  try {
    for (const mode of ['result', 'payload']) {
      const output = fixture(mode);
      for (const target of ['node', 'php']) {
        const extension = target === 'php' ? 'php' : 'mjs';
        const examples = ['download', 'redirect', 'optional'].map((method) => [
          method,
          readFileSync(join(output, target, `examples/api-${method}.${extension}`), 'utf8'),
        ]);
        if (target === 'node')
          examples.push([
            'download-ts',
            readFileSync(join(output, target, 'examples/api-download.ts'), 'utf8'),
          ]);
        for (const document of ['README.md', 'RUNTIME.md']) {
          const source = readFileSync(join(output, target, document), 'utf8');
          const blocks = [...source.matchAll(/```(?:typescript|php)\n([\s\S]*?)```/g)].map(
            (match) => match[1],
          );
          const recipes =
            document === 'README.md'
              ? [blocks.join('\n')]
              : blocks.filter(
                  (block) => block.includes('Saved') || block.includes('No Location header'),
                );
          assert.ok(recipes.length);
          recipes.forEach((recipe, index) => examples.push([`${document}-${index}`, recipe]));
        }
        for (const [name, source] of examples) {
          const downloadPath = join(root, `${mode}-${target}-${name}.pdf`);
          const before = calls.length;
          const run = await runSource(
            output,
            target,
            name,
            source,
            {
              API_BASE_URL: `http://127.0.0.1:${server.address().port}`,
              API_TOKEN: 'synthetic-doc-token',
              API_DOWNLOAD_PATH: downloadPath,
            },
            target === 'node' && name !== 'redirect' && name !== 'optional',
          );
          if (source.includes('Saved')) {
            assert.deepEqual(readFileSync(downloadPath), bytes);
            assert.match(run.stdout, /Saved 8 bytes to/);
          }
          if (source.includes('No Location header')) {
            if (/(?:\.|->)redirect(?:WithResponse)?\(/.test(source))
              assert.ok(
                run.stdout.includes('307 ' + location),
                `${mode}/${target}/${name}: ${run.stdout}`,
              );
            if (/(?:\.|->)optional(?:WithResponse)?\(/.test(source))
              assert.match(run.stdout, /302 No Location header/);
          }
          if (target === 'php') assert.doesNotMatch(run.stderr, /Warning:|Fatal error:/);
          assert.equal(calls.length - before, name.startsWith('README') ? 3 : 1);
        }
      }
    }
    assert.equal(followed, 0);
  } finally {
    server.closeAllConnections();
    destination.closeAllConnections();
    await Promise.all([
      new Promise((done) => server.close(done)),
      new Promise((done) => destination.close(done)),
    ]);
  }
});
