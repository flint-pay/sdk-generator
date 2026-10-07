import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import { generate, loadContract, preview, render } from '../dist/index.js';
import { npmPackResult } from '../dist/distribution.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'sdk-npm-metadata-')));
after(() => rmSync(root, { recursive: true, force: true }));
const config = JSON.parse(readFileSync('examples/library.sdk.json', 'utf8'));
const repository = {
  type: 'git',
  url: 'git+https://github.com/example/library-sdk.git',
  directory: 'packages/node',
};
const homepage = 'https://sdk.example.com/library/#readme';
function contract(npm = {}) {
  const file = join(root, 'sdk.json');
  writeFileSync(
    file,
    JSON.stringify({ ...config, targets: ['node'], npm: { ...config.npm, ...npm } }),
  );
  return loadContract('examples/library.openapi.json', file);
}
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 120000 });
  assert.equal(result.status, 0, result.error?.message ?? result.stdout + result.stderr);
  return result.stdout;
}

test('publication metadata is optional, explicit and deterministic', () => {
  const absent = JSON.parse(render(contract()).get('node/package.json'));
  assert.equal(Object.hasOwn(absent, 'repository'), false);
  assert.equal(Object.hasOwn(absent, 'homepage'), false);
  for (const url of [
    repository.url,
    'https://github.com/example/library-sdk.git',
    'GIT+HTTPS://github.com/example/library-sdk.git',
  ]) {
    const configured = contract({ homepage, repository: { type: 'git', url } });
    const metadata = JSON.parse(render(configured).get('node/package.json'));
    assert.equal(metadata.homepage, homepage);
    assert.deepEqual(metadata.repository, { type: 'git', url });
  }
  const uppercaseHomepage = 'HTTPS://sdk.example.com/library/';
  assert.equal(
    JSON.parse(render(contract({ homepage: uppercaseHomepage })).get('node/package.json')).homepage,
    uppercaseHomepage,
  );
  const configured = contract({ homepage, repository });
  const output = join(root, 'deterministic');
  generate(configured, output);
  assert.deepEqual(preview(configured, output).changes, []);
  // Equivalent input key ordering must not change the rendered manifest.
  const reordered = contract({
    repository: { directory: repository.directory, url: repository.url, type: 'git' },
    homepage,
  });
  assert.deepEqual(preview(reordered, output).changes, []);
  const metadata = JSON.parse(readFileSync(join(output, 'node/package.json'), 'utf8'));
  assert.deepEqual(metadata.repository, repository);
  assert.equal(metadata.homepage, homepage);
});

test('publication metadata rejects invalid values with configuration paths', () => {
  for (const value of [
    null,
    42,
    {},
    '',
    'http://example.com',
    '/docs',
    'git+https://example.com',
    'https://user:placeholder@example.com',
    'https://',
    'https:///sdk.example.com/library/',
    'https://sdk.example.com/library/\u0000',
    'https://sdk.example.com\\library/',
  ]) {
    assert.throws(() => contract({ homepage: value }), /config\/npm\/homepage:/);
  }
  for (const value of [null, [], 'https://github.com/example/library-sdk']) {
    assert.throws(() => contract({ repository: value }), /config\/npm\/repository:/);
  }
  assert.throws(
    () => contract({ repository: { ...repository, type: 'svn' } }),
    /config\/npm\/repository\/type:/,
  );
  assert.throws(
    () => contract({ repository: { ...repository, branch: 'main' } }),
    /config\/npm\/repository\/branch:/,
  );
  for (const url of [
    undefined,
    null,
    42,
    '',
    'http://example.com/sdk.git',
    'git@github.com:example/sdk.git',
    'git+https://user:placeholder@example.com/sdk.git',
    'git+https://',
    'https:///github.com/example/library-sdk.git',
    'git+https://github.com/example/library-sdk.git\u0000',
    'https://github.com/example\\library-sdk.git',
  ]) {
    assert.throws(
      () => contract({ repository: { ...repository, url } }),
      /config\/npm\/repository\/url:/,
    );
  }
  for (const directory of [
    null,
    42,
    '',
    '/packages/node',
    '../node',
    'packages/../node',
    './node',
    'packages//node',
    'packages/node/',
    'C:/node',
    'packages\\node',
    'packages/\nnode',
  ]) {
    assert.throws(
      () => contract({ repository: { ...repository, directory } }),
      /config\/npm\/repository\/directory:/,
    );
  }
});

test('installed SDK supports ESM, CommonJS and consumer-owned Node types', () => {
  const output = join(root, 'packed');
  generate(contract({ homepage, repository }), output);
  const packed = npmPackResult(
    run(
      'npm',
      ['pack', '--ignore-scripts', '--json', '--pack-destination', root],
      join(output, 'node'),
    ),
  );
  const archive = join(root, packed.filename);
  const consumer = join(root, 'javascript');
  mkdirSync(consumer);
  writeFileSync(join(consumer, 'package.json'), '{"private":true}');
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', archive], consumer);
  const installed = join(consumer, 'node_modules/@example/library');
  const metadata = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
  assert.equal(metadata.homepage, homepage);
  assert.deepEqual(metadata.repository, repository);
  assert.equal(metadata.dependencies, undefined);
  assert.deepEqual(metadata.peerDependencies, { '@types/node': '>=22.16.0' });
  assert.deepEqual(metadata.peerDependenciesMeta, { '@types/node': { optional: true } });
  assert.equal(existsSync(join(consumer, 'node_modules/@types/node')), false);
  for (const subpath of ['.', './resources/*']) {
    assert.deepEqual(Object.keys(metadata.exports[subpath]), ['types', 'import', 'default']);
  }
  const readme = readFileSync(join(installed, 'README.md'), 'utf8');
  assert.match(readme, /Node\.js 22\.12\+/);
  assert.match(readme, /npm install --save-dev @types\/node@22/);
  const links = [...readme.matchAll(/\]\(([^)]+\.md)(?:#[^)]*)?\)/g)];
  assert.ok(links.length > 0);
  for (const [, target] of links) assert.ok(existsSync(join(installed, target)), target);
  run(
    process.execPath,
    [
      '--input-type=commonjs',
      '-e',
      `
    const assert = require('node:assert/strict');
    (async () => {
      for (const name of ['@example/library', '@example/library/resources/books']) {
        const required = require(name);
        const imported = await import(name);
        assert.equal(required.Client, imported.Client);
        for (const { Client } of [required, imported]) {
          let calls = 0;
          const client = new Client({
            baseUrl: 'https://example.invalid',
            transport: async (url, init) => {
              calls++;
              assert.equal(url.pathname, '/books/book-123');
              assert.equal(init.method, 'GET');
              return new Response('{"title":"Example book"}');
            },
          });
          assert.equal((await client.books.retrieve('book-123')).title, 'Example book');
          assert.equal(calls, 1);
        }
      }
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `,
    ],
    consumer,
  );

  for (const version of ['22.16.0', '24.0.0']) {
    const typescript = join(root, 'typescript-' + version);
    mkdirSync(typescript);
    writeFileSync(join(typescript, 'package.json'), '{"private":true}');
    run(
      'npm',
      ['install', '--ignore-scripts', '--no-audit', '--no-fund', archive, '@types/node@' + version],
      typescript,
    );
    assert.equal(
      JSON.parse(readFileSync(join(typescript, 'node_modules/@types/node/package.json'), 'utf8'))
        .version,
      version,
    );
    assert.equal(
      existsSync(join(typescript, 'node_modules/@example/library/node_modules/@types/node')),
      false,
    );
    const source = `
      import { Client } from '@example/library';
      import { Client as BooksClient } from '@example/library/resources/books';
      async function check() {
        for (const SDK of [Client, BooksClient]) {
          const client = new SDK({ baseUrl: 'https://example.invalid' });
          const book = await client.books.retrieve('book-123');
          const title: string = book.title;
          // @ts-expect-error response fields retain their declared types
          const wrong: number = book.title;
        }
      }
    `;
    for (const extension of ['mts', 'cts'])
      writeFileSync(join(typescript, 'consumer.' + extension), source);
    run(
      process.execPath,
      [
        resolve('node_modules/typescript/bin/tsc'),
        '--noEmit',
        '--strict',
        '--skipLibCheck',
        'false',
        '--target',
        'ES2022',
        '--module',
        'NodeNext',
        'consumer.mts',
        'consumer.cts',
      ],
      typescript,
    );
    for (const [name, declaration] of [
      ['@example/library', 'index.d.ts'],
      ['@example/library/resources/books', 'resources/books.d.ts'],
    ]) {
      const trace = [];
      const resolved = ts.resolveModuleName(
        name,
        join(typescript, 'consumer.mts'),
        {
          module: ts.ModuleKind.NodeNext,
          moduleResolution: ts.ModuleResolutionKind.NodeNext,
          traceResolution: true,
        },
        { ...ts.sys, trace: (message) => trace.push(message) },
        undefined,
        undefined,
        ts.ModuleKind.ESNext,
      );
      assert.equal(
        resolved.resolvedModule.resolvedFileName,
        join(typescript, 'node_modules/@example/library', declaration),
      );
      assert.ok(trace.includes("Matched 'exports' condition 'types'."));
    }
  }
});
