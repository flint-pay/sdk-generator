import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { loadContract, generate, validate } from '../dist/index.js';
import { DescriptorSource } from '../dist/descriptor-source.js';
import { compileRuntimePlan } from '../dist/runtime-plan.js';
import { codecClosure } from '../dist/package-plan.js';
import { compileCodec } from '../dist/codec-plan.js';
import { Runtime, runtimeFromPlan, Model, modelFromCodec } from '../dist/runtime.js';

const root = mkdtempSync(join(tmpdir(), 'sdk-loading-'));
after(() => rmSync(root, { recursive: true, force: true }));
const api = JSON.parse(readFileSync('examples/library.openapi.json'));
api.paths['/unused-marker'] = {
  get: { operationId: 'unused', responses: { 204: { description: 'Empty' } } },
};
const config = JSON.parse(readFileSync('examples/library.sdk.json'));
config.operations = {
  findBook: { resource: 'books', method: 'retrieve' },
  unused: { resource: 'unrelated', method: 'read' },
};
writeFileSync(join(root, 'api.json'), JSON.stringify(api));
writeFileSync(join(root, 'sdk.json'), JSON.stringify(config));
const output = join(root, 'sdk');
generate(loadContract(join(root, 'api.json'), join(root, 'sdk.json')), output);
const run = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout;
};

test('prepared descriptors own input, validate once per group and reject missing references', () => {
  const settings = compileRuntimePlan({ operations: [] });
  let calls = 0;
  const group = compileRuntimePlan({
    operations: [
      {
        id: 'one',
        resource: 'one',
        method: 'read',
        verb: 'GET',
        path: '/one',
        parameters: [],
        responses: { 204: {} },
        bodyRequired: false,
        authenticated: false,
        description: '',
      },
    ],
  });
  const source = new DescriptorSource(settings, {
    one: () => {
      calls++;
      return group;
    },
  });
  settings.userAgent = 'changed';
  assert.equal(source.settings.userAgent, undefined);
  assert.equal(source.operation('one').path, '/one');
  group.operations[0].path = '/mutated';
  assert.equal(source.operation('one').path, '/one');
  assert.equal(calls, 1);
  assert.throws(() => {
    source.definitions().fake = {};
  }, TypeError);
  const bad = structuredClone(group);
  bad.operations[0].body = compileCodec({ 'x-sdk-ref': 'Missing' });
  const broken = new DescriptorSource(settings, { one: () => bad });
  assert.throws(() => broken.operation('one'), /Missing compiled codec/);
  const duplicate = structuredClone(group);
  duplicate.operations.push({ ...duplicate.operations[0] });
  assert.throws(() => new DescriptorSource(duplicate), /Duplicate compiled operation one/);
  assert.throws(
    () => new DescriptorSource(settings, { one: () => duplicate }).operation('one'),
    /Duplicate compiled operation one/,
  );
  const unexpected = structuredClone(group);
  unexpected.operations[0].id = 'two';
  assert.throws(
    () => new DescriptorSource(settings, { one: () => unexpected }).operation('one'),
    /Unexpected compiled operation two/,
  );
  const reference = compileCodec({ 'x-sdk-ref': 'toString' });
  assert.throws(() => codecClosure(reference, {}), /Missing compiled codec toString/);
  const named = structuredClone(group);
  named.operations[0].body = reference;
  named.definitions = { toString: compileCodec({ type: 'string' }) };
  assert.deepEqual(codecClosure(reference, named.definitions), ['toString']);
  assert.equal(new DescriptorSource(settings, { one: () => named }).operation('one').id, 'one');
  assert.deepEqual(
    codecClosure(
      {
        codec: compileCodec({
          type: 'object',
          properties: { reference: { type: 'string', enum: ['literal'] } },
        }),
      },
      {},
    ),
    [],
  );
});

test('selective Node imports call the same API and bundle no unrelated descriptors', async () => {
  globalThis.__sdkPreparedCounts = { plan: 0, codec: 0 };
  for (const [file, name, counter] of [
    ['runtime-plan.js', 'assertRuntimePlan', 'plan'],
    ['codec-plan.js', 'assertCodecPlan', 'codec'],
  ]) {
    const path = join(output, 'node', file);
    writeFileSync(
      path,
      readFileSync(path, 'utf8').replace(
        new RegExp('(export function ' + name + '\\([^\\n]+\\) \\{)'),
        '$1 globalThis.__sdkPreparedCounts.' + counter + '++;',
      ),
    );
  }
  const { Client } = await import(pathToFileURL(join(output, 'node/resources/books.js')));
  assert.deepEqual(globalThis.__sdkPreparedCounts, { plan: 1, codec: 0 });
  const seen = [];
  const c = new Client({
    baseUrl: 'https://example.invalid',
    transport: async (url) => {
      seen.push(url.pathname);
      return new Response('{"id":"a","title":"Book"}');
    },
  });
  assert.deepEqual(globalThis.__sdkPreparedCounts, { plan: 1, codec: 0 });
  assert.equal(c.unrelated, undefined);
  const value = await c.books.retrieve('a');
  assert.equal(value.title, 'Book');
  assert.deepEqual(seen, ['/books/a']);
  const counts = { ...globalThis.__sdkPreparedCounts };
  assert.equal(counts.plan, 2);
  assert.ok(counts.codec > 0);
  const other = new Client({
    baseUrl: 'https://example.invalid',
    transport: async () => new Response('{"id":"b","title":"Other"}'),
  });
  assert.equal((await other.books.retrieve('b')).title, 'Other');
  assert.deepEqual(globalThis.__sdkPreparedCounts, counts);
  const result = await build({
    stdin: {
      contents: `import {Client} from './resources/books.js'; export const client=new Client({baseUrl:'https://example.invalid'});`,
      resolveDir: join(output, 'node'),
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    minify: true,
    write: false,
    metafile: true,
  });
  assert.ok(
    !Object.keys(result.metafile.inputs).some(
      (path) => path.includes('unrelated') || path.endsWith('/index.js'),
    ),
  );
  assert.ok(!result.outputFiles[0].text.includes('/unused-marker'));
  assert.ok(
    !result.outputFiles[0].text.includes('x-sdk-ref'),
    'schema compiler leaked into selective bundle',
  );
  const file = join(output, 'node', 'selective.ts');
  writeFileSync(
    file,
    `import {Client, SdkError, Model, serialize, parseExact, redact, type Result, type Metadata, type RequestOptions, type BooksRetrieveInput} from './resources/books.js'; const c=new Client({baseUrl:'https://example.invalid'}); c.books.retrieve('a');
void [SdkError, Model, serialize, parseExact, redact];
const result: Result<string> | undefined = undefined;
const metadata: Metadata | undefined = undefined;
const options: RequestOptions = {};
// @ts-expect-error unrelated resource is absent
c.unrelated.read();`,
  );
  run(process.execPath, [
    'node_modules/typescript/bin/tsc',
    '--noEmit',
    '--strict',
    '--target',
    'ES2022',
    '--module',
    'NodeNext',
    '--typeRoots',
    'node_modules/@types',
    file,
  ]);
});

test('Composer autoload is inert and PHP clients defer descriptors until first use', () => {
  for (const [file, name, counter] of [
    ['Runtime.php', 'assertCompiledPlan', 'sdk_plan_validations'],
    ['Codec.php', 'assertPlan', 'sdk_codec_validations'],
  ]) {
    const path = join(output, 'php/src/classes', file);
    writeFileSync(
      path,
      readFileSync(path, 'utf8').replace(
        new RegExp('(public static function ' + name + '\\([^)]*\\): void\\s*\\{)'),
        "$1 $GLOBALS['" + counter + "'] = ($GLOBALS['" + counter + "'] ?? 0) + 1;",
      ),
    );
  }
  run('composer', [
    'install',
    '--no-interaction',
    '--no-progress',
    '--working-dir=' + join(output, 'php'),
  ]);
  run('composer', [
    'dump-autoload',
    '--classmap-authoritative',
    '--working-dir=' + join(output, 'php'),
  ]);
  // Corruption of an unused descriptor must not affect autoload, construction or another resource.
  writeFileSync(join(output, 'php/src/descriptors/resources/unrelated.json'), 'invalid');
  for (const opcache of ['0', '1']) {
    const result = run('php', [
      '-d',
      'memory_limit=128M',
      '-d',
      'opcache.enable_cli=' + opcache,
      '-r',
      String.raw`
      require $argv[1].'/vendor/autoload.php';
      foreach(get_included_files() as $file)if(str_contains($file,'/src/'))throw new Exception('eager SDK loading');
      $c=new Example\Library\Client(new Example\Library\ClientOptions(baseUrl:'https://example.invalid',transport:fn($r)=>['status'=>200,'headers'=>[],'body'=>'{"id":"a","title":"Book"}']));
      if(($GLOBALS['sdk_plan_validations']??0)!==1||($GLOBALS['sdk_codec_validations']??0)!==0)throw new Exception('construction loaded codecs');
      if(class_exists(Example\Library\BooksRetrieveResponse200::class,false))throw new Exception('eager model');
      $value=$c->books->retrieve('a');if($value->title!=='Book')throw new Exception('wrong response');
      $counts=[$GLOBALS['sdk_plan_validations'],$GLOBALS['sdk_codec_validations']];
      $other=new Example\Library\Client(new Example\Library\ClientOptions(baseUrl:'https://example.invalid',transport:fn($r)=>['status'=>200,'headers'=>[],'body'=>'{"id":"b","title":"Other"}']));
      if($other->books->retrieve('b')->title!=='Other')throw new Exception('shared client state');
      if($counts!==[$GLOBALS['sdk_plan_validations'],$GLOBALS['sdk_codec_validations']])throw new Exception('revalidated prepared descriptors');
      $other->close();
      try{$c->unrelated->read();throw new Exception('accepted malformed group');}catch(JsonException $expected){}
      $c->close();echo 'ok';`,
      join(output, 'php'),
    ]);
    assert.equal(result, 'ok');
  }
  for (const file of readdirSync(join(output, 'php/src/classes')))
    if (file.endsWith('.php')) {
      const source = readFileSync(join(output, 'php/src/classes', file), 'utf8');
      assert.equal(
        [...source.matchAll(/^(?:(?:final|abstract) )?(?:class|interface) /gm)].length,
        1,
        file,
      );
    }
});

test('selective clients preserve the independent HTTP corpus across repeated clients', async () => {
  const contract = loadContract(
    'tests/fixtures/payment-api.json',
    'tests/fixtures/payment-sdk.json',
  );
  const directory = join(root, 'payments');
  generate(contract, directory);
  const cases = JSON.parse(readFileSync('tests/fixtures/http-cases.json', 'utf8'));
  for (const scenario of cases) {
    const operation = contract.operations.find((op) => op.id === scenario.operation);
    const { Client } = await import(
      pathToFileURL(join(directory, 'node/resources', operation.resource + '.js'))
    );
    let attempts = 0;
    const client = new Client({
      baseUrl: 'https://api.example.invalid/v1',
      token: 'test-token',
      transport: async (url, init) => {
        const expected = scenario.expected;
        assert.equal(init.method, expected.method, scenario.name);
        assert.equal(url.pathname + url.search, expected.path, scenario.name);
        if (expected.body !== undefined) assert.equal(init.body, expected.body, scenario.name);
        for (const [key, value] of Object.entries(expected.headers ?? {}))
          assert.equal(init.headers[key], value, scenario.name);
        const response = scenario.responses[attempts++];
        assert.ok(response, 'unexpected dispatch: ' + scenario.name);
        if (response.transportError) throw new Error('Response lost');
        return new Response([204, 304].includes(response.status) ? null : response.body, {
          status: response.status,
          headers: response.headers,
        });
      },
    });
    const request = client[operation.resource][operation.method](scenario.input, scenario.options);
    if (scenario.error)
      await assert.rejects(request, (error) => {
        for (const [key, value] of Object.entries(scenario.error))
          assert.equal(
            ['status', 'requestId'].includes(key) ? error.meta?.[key] : error[key],
            value,
            scenario.name,
          );
        return true;
      });
    else {
      const result = await request;
      if (scenario.data)
        assert.deepEqual(JSON.parse(JSON.stringify(result.data)), scenario.data, scenario.name);
      if (scenario.empty) assert.equal(result.data, undefined, scenario.name);
    }
    assert.equal(attempts, scenario.attempts ?? 1, scenario.name);
    await client.close?.();
  }
});

test('codec-shaped field names and numeric operation IDs retain dependencies in both SDKs', async () => {
  const leaf = compileCodec({ type: 'string' });
  const codec = compileCodec({
    type: 'object',
    properties: { value: { 'x-sdk-ref': 'Leaf' }, nullable: { type: 'boolean' } },
  });
  assert.deepEqual(codecClosure(codec, { Leaf: leaf }), ['Leaf']);
  assert.ok(
    runtimeFromPlan(compileRuntimePlan({ operations: [] }), {
      baseUrl: 'https://example.invalid',
    }) instanceof Runtime,
  );
  assert.ok(modelFromCodec('value', leaf) instanceof Model);
  const definition = {
    openapi: '3.1.0',
    info: { title: 'Dependencies', version: '1' },
    components: { schemas: { Leaf: { type: 'string' } } },
    paths: {
      '/value': {
        get: {
          operationId: '123',
          responses: {
            200: {
              description: 'Value',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      value: { $ref: '#/components/schemas/Leaf' },
                      nullable: { type: 'boolean' },
                    },
                    required: ['value', 'nullable'],
                  },
                },
              },
            },
          },
        },
      },
    },
  };
  const profile = {
    version: '1.0.0',
    npm: { name: 'dependency-sdk' },
    composer: { name: 'example/dependencies', namespace: 'Dependencies' },
    responses: { return: 'result' },
    operations: { 123: { resource: 'values', method: 'read' } },
  };
  writeFileSync(join(root, 'dependencies-api.json'), JSON.stringify(definition));
  writeFileSync(join(root, 'dependencies-sdk.json'), JSON.stringify(profile));
  const directory = join(root, 'dependencies');
  generate(
    loadContract(join(root, 'dependencies-api.json'), join(root, 'dependencies-sdk.json')),
    directory,
  );
  const { Client } = await import(pathToFileURL(join(directory, 'node/index.js')));
  const client = new Client({
    baseUrl: 'https://example.invalid',
    transport: async () => new Response('{"value":"leaf","nullable":false}'),
  });
  assert.deepEqual({ ...(await client.values.read()).data }, { value: 'leaf', nullable: false });
  const result = run('php', [
    '-r',
    String.raw`require $argv[1].'/src/Client.php';$c=new Dependencies\Client(new Dependencies\ClientOptions(baseUrl:'https://example.invalid',transport:fn()=>['status'=>200,'headers'=>[],'body'=>'{"value":"leaf","nullable":false}']));$value=$c->values->read()->data;if($value->get('value')!=='leaf'||$value->get('nullable')!==false)throw new Exception('wrong decoded fields');$plan=Dependencies\SchemaRegistry::contract();if($plan['operations'][0]['id']!=='123')throw new Exception('operation ID changed');Dependencies\SchemaRegistry::source()->validateAll();echo 'ok';`,
    join(directory, 'php'),
  ]);
  assert.equal(result, 'ok');
});

test('recursive package syntax checks reject malformed modules and retain CommonJS helpers', () => {
  const directory = join(root, 'syntax');
  generate(loadContract(join(root, 'api.json'), join(root, 'sdk.json')), directory);
  const custom = join(directory, 'node/custom/nested');
  mkdirSync(custom, { recursive: true });
  writeFileSync(join(custom, 'package.json'), '{"type":"commonjs"}');
  writeFileSync(join(custom, 'helper.js'), '#!/usr/bin/env node\nreturn;');
  const typeless = join(directory, 'node/custom/typeless');
  mkdirSync(typeless);
  writeFileSync(join(typeless, 'package.json'), '{}');
  writeFileSync(join(typeless, 'helper.js'), 'export const value = await Promise.resolve(1);');
  const commonjs = join(directory, 'node/custom/helper.cjs');
  writeFileSync(commonjs, 'module.exports = 1;');
  rmSync(join(directory, '.sdk-generator.json'));
  validate(directory);
  writeFileSync(commonjs, 'module.exports = ;');
  assert.throws(() => validate(directory), /Unexpected token/);
  writeFileSync(commonjs, 'module.exports = 1;');
  const group = join(directory, 'node/descriptors/resources/books.js');
  const descriptor = readFileSync(group, 'utf8');
  rmSync(group);
  assert.throws(() => validate(directory), /Cannot find module|ERR_MODULE_NOT_FOUND/);
  writeFileSync(group, descriptor);
  const model = join(directory, 'php/src/descriptors/models/BooksRetrieveInput.json');
  const codec = readFileSync(model, 'utf8');
  rmSync(model);
  assert.throws(() => validate(directory), /Missing SDK descriptor/);
  writeFileSync(model, codec);
  const module = join(directory, 'node/resources/books.js');
  const original = readFileSync(module, 'utf8');
  writeFileSync(module, original + '\nexport const broken = ;');
  assert.throws(() => validate(directory), /Unexpected token/);
  writeFileSync(module, original);
  writeFileSync(join(directory, 'php/src/classes/BooksResource.php'), '<?php function broken(');
  assert.throws(() => validate(directory), /syntax error|Unclosed/);
});

test('package validation rejects missing declared webhook descriptors in both targets', () => {
  const directory = join(root, 'missing-webhook');
  generate(
    loadContract('tests/fixtures/payment-api.json', 'tests/fixtures/payment-sdk.json'),
    directory,
  );
  const node = join(directory, 'node/descriptors/webhook.js');
  const source = readFileSync(node, 'utf8');
  rmSync(node);
  assert.throws(() => validate(directory), /Cannot find module|ERR_MODULE_NOT_FOUND/);
  writeFileSync(node, source);
  rmSync(join(directory, 'php/src/descriptors/webhook.json'));
  assert.throws(() => validate(directory), /Missing SDK descriptor webhook/);
});

test('PHP rejects duplicate and foreign operations before a group can overwrite cached routes', () => {
  const directory = join(root, 'invalid-routes');
  generate(loadContract(join(root, 'api.json'), join(root, 'sdk.json')), directory);
  const path = join(directory, 'php/src/descriptors/resources/unrelated.json');
  const group = JSON.parse(readFileSync(path, 'utf8'));
  const duplicate = structuredClone(group);
  duplicate.operations.push({ ...duplicate.operations[0] });
  const foreign = structuredClone(group);
  foreign.operations[0].id = 'findBook';
  for (const [invalid, message] of [
    [duplicate, 'Duplicate compiled operation unused'],
    [foreign, 'Unexpected compiled operation findBook'],
  ]) {
    writeFileSync(path, JSON.stringify(invalid));
    const result = run('php', [
      '-r',
      String.raw`require $argv[1].'/src/Client.php';$source=Example\Library\SchemaRegistry::source();$before=$source->operation('findBook');try{$source->operation('unused');throw new Exception('accepted bad group');}catch(InvalidArgumentException $e){if($e->getMessage()!==$argv[2])throw $e;}if($source->operation('findBook')!==$before)throw new Exception('overwrote valid operation');echo 'ok';`,
      join(directory, 'php'),
      message,
    ]);
    assert.equal(result, 'ok');
  }
});
