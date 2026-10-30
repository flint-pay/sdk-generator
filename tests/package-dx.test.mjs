import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  readdirSync,
  mkdirSync,
  copyFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { inspect } from 'node:util';
import { runInNewContext } from 'node:vm';
import { createHmac } from 'node:crypto';
import ts from 'typescript';
import { buildSync } from 'esbuild';
import { loadContract, generate } from '../dist/index.js';
import { splitNodeDeclarations, compactNodeDeclarations } from '../dist/package-render.js';

const root = mkdtempSync(join(tmpdir(), 'sdk-package-dx-'));
const output = join(root, 'sdk');
const contract = loadContract('tests/fixtures/payment-api.json', 'tests/fixtures/payment-sdk.json');
contract.operations.at(-1).resource = 'unrelated';
before(() => generate(contract, output));
after(() => rmSync(root, { recursive: true, force: true }));
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 30000, ...options });
  assert.equal(result.status, 0, String(result.error ?? '') + result.stdout + result.stderr);
  return result.stdout;
};

test('webhooks is a public standalone export with no operation data, including when copied', async () => {
  const node = join(output, 'node');
  const pkg = JSON.parse(readFileSync(join(node, 'package.json')));
  assert.equal(pkg.exports['./webhooks'].import, './webhooks.js');
  const { verifyWebhook, Client } = await import(pathToFileURL(join(node, 'index.js')));
  const subpath = await import(pathToFileURL(join(node, 'webhooks.js')));
  const body = Buffer.from('{"type":"future.event","id":"synthetic"}');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', 'synthetic-secret')
    .update(timestamp + '.')
    .update(body)
    .digest('hex');
  const headers = { 'x-signature': signature, 'x-timestamp': timestamp };
  const expected = verifyWebhook(body, headers, 'synthetic-secret');
  assert.deepEqual(subpath.verifyWebhook(body, headers, 'synthetic-secret'), expected);
  assert.deepEqual(
    new Client({ baseUrl: 'https://example.invalid', token: 'synthetic' }).verifyWebhook(
      body,
      headers,
      'synthetic-secret',
    ),
    expected,
  );
  assert.throws(() => subpath.verifyWebhook(body, headers, 'wrong-secret'), {
    name: 'WebhookVerificationError',
  });
  const bundle = buildSync({
    entryPoints: [join(node, 'webhooks.js')],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    globalName: 'SDK',
    write: false,
    metafile: true,
  });
  assert.ok(
    !Object.keys(bundle.metafile.inputs).some((path) =>
      /resource-|descriptors\/root\.js/.test(path),
    ),
  );
  // An edge-style import has neither process nor Buffer. Node remains the execution runtime.
  const context = { structuredClone };
  runInNewContext(bundle.outputFiles[0].text, context);
  assert.equal(typeof context.SDK.verifyWebhook, 'function');
  const consumer = join(root, 'consumer');
  mkdirSync(join(consumer, 'node_modules', ...pkg.name.split('/')), { recursive: true });
  // Copy the generated package, then copy its example out of that package.
  run('cp', ['-R', node + '/.', join(consumer, 'node_modules', ...pkg.name.split('/'))]);
  copyFileSync(join(node, 'examples/webhook-inbox.mjs'), join(consumer, 'inbox.mjs'));
  run(process.execPath, [
    '--input-type=module',
    '-e',
    `const m=await import(${JSON.stringify(pathToFileURL(join(consumer, 'inbox.mjs')).href)}); if(typeof m.openInbox!=='function')throw new Error('missing inbox');`,
  ]);
  run(
    process.execPath,
    [
      '--input-type=commonjs',
      '-e',
      `if(typeof require(${JSON.stringify(pkg.name + '/webhooks')}).verifyWebhook!=='function')throw new Error('missing CJS verifier');`,
    ],
    { cwd: consumer },
  );
});

test('unbundled resource imports ignore unrelated operation data and client inspection stays compact', async () => {
  const node = join(output, 'node');
  const resource = contract.operations[0].resource;
  const groups = [...new Set(contract.operations.map((op) => op.resource))];
  const unrelated = groups.find((name) => name !== resource);
  assert.ok(unrelated, 'independent resources make the import failure witness meaningful');
  const bad = join(node, 'descriptors/data', `resource-${encodeURIComponent(unrelated)}.js`);
  const original = readFileSync(bad, 'utf8');
  writeFileSync(bad, "throw new Error('unrelated operation data eagerly imported');\n");
  try {
    run(process.execPath, [
      '--input-type=module',
      '-e',
      `const {Client}=await import(${JSON.stringify(pathToFileURL(join(node, 'resources', resource + '.js')).href)});new Client({baseUrl:'https://example.invalid',token:'synthetic'});`,
    ]);
  } finally {
    writeFileSync(bad, original);
  }
  for (const entry of ['index.js', `resources/${resource}.js`]) {
    const { Client } = await import(pathToFileURL(join(node, entry)));
    const client = new Client({
      baseUrl: 'https://example.invalid',
      token: 'synthetic-secret-never-log',
    });
    const printed = inspect(client, { depth: null });
    assert.ok(printed.length < 120, printed);
    assert.ok(!printed.includes('synthetic-secret-never-log'));
    assert.equal(Object.keys(client).length, entry === 'index.js' ? groups.length : 1);
  }
});

test('root and webhook types preserve their public exports', () => {
  const consumer = join(root, 'types.ts');
  const node = join(output, 'node');
  writeFileSync(
    consumer,
    `import {Client, type KnownWebhookEvent} from './sdk/node/index.js';\nimport {verifyWebhook, type VerifiedWebhook} from './sdk/node/webhooks.js';\nconst client=new Client({baseUrl:'https://example.invalid',token:'synthetic'});\nconst event:KnownWebhookEvent|null=null; void [client,event];\nconst result:VerifiedWebhook=verifyWebhook(new Uint8Array(),{},'synthetic'); void result;\n`,
  );
  const program = ts.createProgram([consumer], {
    noEmit: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    typeRoots: [resolve('node_modules/@types')],
  });
  assert.deepEqual(
    ts
      .getPreEmitDiagnostics(program)
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')),
    [],
  );
  writeFileSync(
    consumer,
    "import {Client} from './sdk/node/index.js'; new Client({baseUrl:'https://example.invalid',token:'synthetic'});\n",
  );
  const rootOnly = ts.createProgram([consumer], program.getCompilerOptions());
  assert.deepEqual(
    ts
      .getPreEmitDiagnostics(rootOnly)
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')),
    [],
  );
});

test('PHP packages omit raw schemas and examples bootstrap from a vendor installation or the project', () => {
  const php = join(output, 'php');
  assert.equal(existsSync(join(php, 'src/schema-definitions.json')), false);
  run('php', [
    '-r',
    `require $argv[1].'/src/Client.php'; $registry=$argv[2]; if(method_exists($registry,'definitions'))throw new Exception('removed raw schema API'); if(!is_array($registry::codecs()))throw new Exception('compiled API missing');`,
    php,
    contract.config.composer.namespace + '\\SchemaRegistry',
  ]);
  const operation = contract.operations[0];
  const example = readFileSync(
    join(php, 'examples', operation.resource + '-' + operation.method + '.php'),
    'utf8',
  );
  const bootstrap = example.slice(0, example.indexOf('\nuse ')) + "\necho 'bootstrapped';\n";
  const project = join(root, 'php-project');
  const installed = join(project, 'vendor', 'synthetic', 'sdk', 'examples');
  mkdirSync(installed, { recursive: true });
  writeFileSync(join(project, 'vendor/autoload.php'), '<?php $GLOBALS["loaded"] = true;');
  for (const directory of [project, installed]) {
    const file = join(directory, 'example.php');
    writeFileSync(file, bootstrap);
    assert.equal(run('php', [file]), 'bootstrapped');
  }
  assert.ok(readdirSync(join(output, 'node/examples')).every((file) => !file.endsWith('.ts')));
});

test('large declaration graphs share chunks without duplicating or renaming public types', () => {
  const files = new Map();
  const declarations =
    `export type ClientOptions = {};\nexport declare class Client { constructor(options?: ClientOptions); readonly books: { get(): Item0 }; }\n` +
    Array.from(
      { length: 192 },
      (_, i) =>
        `/** Item ${i}. */\nexport type Item${i} = { id: string; next?: Item${(i + 1) % 192} };\n`,
    ).join('');
  splitNodeDeclarations(declarations, ['books'], (path, text) => files.set('node/' + path, text));
  compactNodeDeclarations(files, 'node/');
  assert.equal([...files.keys()].filter((path) => /types-\d+\.d\.ts$/.test(path)).length, 4);
  assert.ok(files.has('node/declarations/Client.d.ts'));
  assert.ok(!files.has('node/declarations/Item0.d.ts'));
  const directory = join(root, 'chunked');
  for (const [path, text] of files) {
    const target = join(directory, path);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, text);
  }
  const consumer = join(directory, 'consumer.ts');
  writeFileSync(
    consumer,
    "import {Client, type Item0, type Item191} from './node/index.js';\nimport {Client as BooksClient} from './node/resources/books.js';\nconst a:Item0=new Client().books.get(); const b:Item0=new BooksClient().books.get(); const last:Item191={id:'last'}; void a; void b; void last;\n// @ts-expect-error response retains its string field\nconst bad:Item0={id:123};\n",
  );
  const program = ts.createProgram([consumer], {
    noEmit: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    typeRoots: [resolve('node_modules/@types')],
  });
  assert.deepEqual(
    ts
      .getPreEmitDiagnostics(program)
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')),
    [],
  );
  const syntax = [...files.values()].join('\n');
  assert.equal([...syntax.matchAll(/export type Item0 =/g)].length, 1);
  assert.ok(
    program.getSourceFiles().filter((file) => file.fileName.startsWith(directory)).length < 10,
  );
});
