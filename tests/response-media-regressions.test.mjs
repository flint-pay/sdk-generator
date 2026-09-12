import { localExampleFile } from './local-example.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { loadContract, generate, compare, validate, prepareRelease } from '../dist/index.js';
import { compileSdkContract } from '../dist/target-plan.js';
import { compareCompiledContracts } from '../dist/compiled-compatibility.js';
import { restoreCompiledSnapshot, storeCompiledSnapshot } from '../dist/compiled-record.js';

const exec = promisify(execFile);
const root = mkdtempSync(join(tmpdir(), 'sdk-response-media-'));
after(() => rmSync(root, { recursive: true, force: true }));
const empty = { description: 'Empty' };
const binary = { description: 'PDF', content: { 'application/pdf': {} } };
const stream = { description: 'Events', content: { 'text/event-stream': {} } };
const redirect = {
  description: 'Redirect',
  headers: { Location: { required: true, schema: { type: 'string' } } },
};
const json = (schema) => ({ description: 'JSON', content: { 'application/json': { schema } } });
function fixture(name, responses, config = {}, components) {
  const dir = join(root, name);
  mkdirSync(dir);
  const source = join(dir, 'api.json'),
    profile = join(dir, 'sdk.json'),
    output = join(dir, 'out');
  writeFileSync(
    source,
    JSON.stringify({
      openapi: '3.1.0',
      info: { title: 'Response media', version: '1' },
      paths: { '/value': { get: { operationId: 'value', responses } } },
      ...(components ? { components } : {}),
    }),
  );
  writeFileSync(
    profile,
    JSON.stringify({
      responses: { return: 'result' },
      version: '1.0.0',
      requests: { style: 'object' },
      npm: { name: '@example/response-media' },
      composer: { name: 'example/response-media', namespace: 'Example\\Media' },
      validation: 'schema',
      release: { policy: 'semver' },
      ...config,
    }),
  );
  const contract = loadContract(source, profile);
  return { dir, output, contract };
}
const phpHeader = (output) =>
  `<?php require ${JSON.stringify(join(output, 'php/src/Runtime.php'))};require ${JSON.stringify(join(output, 'php/src/Client.php'))};\n`;
function php(f, program) {
  const file = join(f.dir, 'case.php');
  writeFileSync(file, phpHeader(f.output) + program);
  const result = spawnSync('php', [file], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout);
}
const breaking = (findings) => findings.some((finding) => finding.severity === 'breaking');
const compiledChanges = (before, after) =>
  compareCompiledContracts(compileSdkContract(before).plan, compileSdkContract(after).plan);
function tsc(file) {
  return spawnSync(
    process.execPath,
    [
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
    ],
    { encoding: 'utf8', timeout: 120000 },
  );
}

test('SSE event schemas inherit response annotations through composition in both targets', async () => {
  for (const sharing of ['inline', 'named']) {
    for (const wrapped of [false, true]) {
      const privateField = { type: 'string', writeOnly: true };
      const f = fixture(
        `annotations-${sharing}-${wrapped}`,
        { 200: stream },
        {
          ...(sharing === 'named' ? { schemaSharing: 'named' } : {}),
          operations: { value: { stream: { events: { ready: '#/components/schemas/Ready' } } } },
        },
        {
          schemas: {
            Ready: {
              type: 'object',
              required: ['visible', 'private_value'],
              properties: {
                visible: { type: 'string' },
                private_value: wrapped ? { type: 'string', allOf: [privateField] } : privateField,
              },
            },
          },
        },
      );
      generate(f.contract, f.output);
      const sdk = await import(join(f.output, 'node/index.js'));
      const wire = 'event: ready\ndata: {"visible":"yes"}\n\n';
      const client = new sdk.Client({
        baseUrl: 'https://example.invalid',
        transport: async () =>
          new Response(wire, { headers: { 'content-type': 'text/event-stream' } }),
      });
      try {
        assert.deepEqual(
          (await Array.fromAsync((await client.api.value()).data)).map((event) => ({
            ...event.data,
          })),
          [{ visible: 'yes' }],
        );
      } finally {
        await client.close?.();
      }
      assert.deepEqual(
        php(
          f,
          `$wire=base64_decode('${Buffer.from(wire).toString('base64')}');
        $client=new Example\\Media\\Client(new Example\\Media\\ClientOptions(baseUrl:'https://example.invalid',transport:function($request)use($wire){return ['status'=>200,'headers'=>['content-type'=>'text/event-stream'],'stream'=>new class($wire) implements Example\\Media\\ByteStream {
          public function __construct(private ?string $wire){} public function read():?string{$value=$this->wire;$this->wire=null;return $value;}public function close():void{}
        }];}));$seen=[];foreach($client->api->value()->data as $event)$seen[]=$event->data;$client->close();echo json_encode($seen);`,
        ),
        [{ visible: 'yes' }],
      );
    }
  }
});

for (const [kind, status, response] of [
  ['binary', '200', binary],
  ['stream', '200', stream],
  ['redirect', '307', redirect],
  ['json', '200', json({ type: 'string' })],
]) {
  test(`adding ${kind} results to an empty operation breaks consumers and blocks stable patch releases`, async () => {
    const f = fixture('addition-' + kind, { 204: empty });
    generate(f.contract, f.output);
    const consumer = join(f.dir, 'consumer.mts');
    writeFileSync(
      consumer,
      "import {Client} from './out/node/index.js';const client=new Client({baseUrl:'https://example.invalid'});const absent:undefined=(await client.api.value()).data;",
    );
    assert.equal(tsc(consumer).status, 0);
    // Loading through the public input path resolves media classification and defaults.
    const next = fixture(
      'addition-next-' + kind,
      { 204: empty, [status]: response },
      { version: '1.0.1' },
    ).contract;
    assert.ok(breaking(compare(f.contract, next)));
    assert.ok(breaking(compiledChanges(f.contract, next)));
    generate(next, f.output);
    const failure = tsc(consumer);
    assert.notEqual(failure.status, 0);
    assert.match(failure.stdout, /not assignable to type 'undefined'/);
    assert.throws(
      () => prepareRelease(f.output, join(f.dir, 'release')),
      /breaking changes require a new major/i,
    );

    // Exercise the new result through real generated Node and PHP clients.
    const sdk = await import(join(f.output, 'node/index.js'));
    const wire =
      kind === 'binary'
        ? '%PDF-1.7\u0000'
        : kind === 'stream'
          ? 'data: hello\n\n'
          : kind === 'json'
            ? '"hello"'
            : '';
    const headers =
      kind === 'redirect'
        ? { location: 'https://example.invalid/file' }
        : {
            'content-type':
              kind === 'binary'
                ? 'application/pdf'
                : kind === 'stream'
                  ? 'text/event-stream'
                  : 'application/json',
          };
    const client = new sdk.Client({
      baseUrl: 'https://example.invalid',
      transport: async () => new Response(wire, { status: Number(status), headers }),
    });
    try {
      const data = (await client.api.value()).data;
      if (kind === 'binary') assert.deepEqual(data, new TextEncoder().encode(wire));
      else if (kind === 'stream') assert.equal((await Array.fromAsync(data))[0].data, 'hello');
      else if (kind === 'redirect')
        assert.deepEqual(data, { location: 'https://example.invalid/file' });
      else assert.equal(data, 'hello');
    } finally {
      await client.close?.();
    }
    const phpResult = php(
      f,
      `$wire=base64_decode('${Buffer.from(wire).toString('base64')}');$headers=json_decode('${JSON.stringify(headers)}',true);
      $client=new Example\\Media\\Client(new Example\\Media\\ClientOptions(baseUrl:'https://example.invalid',transport:function($request)use($wire,$headers){$response=['status'=>${status},'headers'=>$headers,'body'=>$wire];
      ${kind === 'stream' ? "$response['stream']=new class($wire) implements Example\\Media\\ByteStream {public function __construct(private ?string $wire){}public function read():?string{$value=$this->wire;$this->wire=null;return $value;}public function close():void{}};" : ''}
      return $response;}));$data=$client->api->value()->data;
      ${kind === 'stream' ? '$events=[];foreach($data as $event)$events[]=$event->data;$data=$events;' : ''}
      echo json_encode($data);$client->close();`,
    );
    assert.deepEqual(
      phpResult,
      kind === 'stream'
        ? ['hello']
        : kind === 'redirect'
          ? { location: 'https://example.invalid/file' }
          : kind === 'binary'
            ? wire
            : 'hello',
    );
  });
}

test('non-JSON compatibility retains matching results and respects PHP binary strings and classes', () => {
  for (const [name, statuses, response] of [
    ['binary', ['200', '201'], binary],
    ['stream', ['200', '201'], stream],
    ['redirect', ['302', '307'], redirect],
  ]) {
    const before = fixture('matching-' + name, { [statuses[0]]: response }).contract;
    const next = fixture('matching-next-' + name, {
      [statuses[0]]: response,
      [statuses[1]]: response,
    }).contract;
    assert.equal(breaking(compare(before, next)), false);
    assert.equal(breaking(compiledChanges(before, next)), false);
    const absent = structuredClone(next);
    absent.operations[0].responses['204'] = { bodyKind: 'empty', classification: 'success' };
    assert.ok(breaking(compare(before, absent)));
    assert.ok(breaking(compiledChanges(before, absent)));
  }
  for (const targets of [['php'], ['node'], ['node', 'php']]) {
    const name = targets.join('-');
    const before = fixture(
      'string-' + name,
      { 200: json({ type: 'string' }) },
      { targets },
    ).contract;
    const next = fixture(
      'string-next-' + name,
      { 200: json({ type: 'string' }), 201: binary },
      { targets },
    ).contract;
    assert.equal(breaking(compare(before, next)), targets.includes('node'));
    assert.equal(breaking(compiledChanges(before, next)), targets.includes('node'));
  }
  const location = json({ type: 'object', properties: { location: { type: 'string' } } });
  const before = fixture('redirect-class', { 200: location }, { targets: ['php'] }).contract;
  const next = fixture(
    'redirect-class-next',
    { 200: location, 307: redirect },
    { targets: ['php'] },
  ).contract;
  assert.ok(breaking(compare(before, next)));
  assert.ok(breaking(compiledChanges(before, next)));
});

test('non-JSON guarantees round-trip and historical missing guarantees remain uncertain', () => {
  const contract = fixture('snapshots', { 200: binary, 201: stream, 307: redirect }).contract;
  const snapshot = {
    plan: compileSdkContract(contract).plan,
    runtimeIdentity: { node: '0'.repeat(64), php: '1'.repeat(64) },
  };
  assert.deepEqual(restoreCompiledSnapshot(storeCompiledSnapshot(snapshot)), snapshot);
  for (const mutate of [
    (p) => {
      p.responses.value['200'].body.publicType.kind = 'future';
    },
    (p) => {
      p.responses.value['200'].body.phpRuntime = { kind: 'future' };
    },
    (p) => {
      p.responses.value['201'].body.runtime = { kind: 'future' };
    },
  ]) {
    const invalid = structuredClone(snapshot);
    mutate(invalid.plan);
    assert.throws(() => restoreCompiledSnapshot(invalid), /compiled guarantee/);
  }
  const legacy = structuredClone(snapshot);
  legacy.plan.semantics = legacy.plan.runtime.semantics;
  for (const response of Object.values(legacy.plan.responses.value)) delete response.body;
  const saved = JSON.stringify(legacy);
  assert.doesNotThrow(() => restoreCompiledSnapshot(legacy));
  const changes = compareCompiledContracts(legacy.plan, snapshot.plan);
  assert.equal(breaking(changes), false);
  for (const status of ['200', '201', '307'])
    assert.ok(
      changes.some((c) => c.subject === 'value.response.' + status && c.severity === 'review'),
    );
  assert.equal(JSON.stringify(legacy), saved);
});

test('mixed JSON, empty and SSE examples validate and run every result path in Node and PHP', async () => {
  let selected = 'stream';
  const server = createServer((request, response) => {
    const status = selected === 'stream' ? 201 : selected === 'empty' ? 204 : 200;
    response.writeHead(status, {
      'content-type': selected === 'stream' ? 'text/event-stream' : 'application/json',
    });
    response.end(
      selected === 'stream' ? 'data: hello\n\n' : selected === 'empty' ? '' : '{"id":"ok"}',
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const env = {
    ...process.env,
    API_BASE_URL: `http://127.0.0.1:${server.address().port}`,
  };
  try {
    for (const mixed of [false, true]) {
      const f = fixture('examples-' + mixed, {
        201: stream,
        ...(mixed
          ? {
              200: json({
                type: 'object',
                required: ['id'],
                properties: { id: { type: 'string' } },
              }),
              204: empty,
            }
          : {}),
      });
      generate(f.contract, f.output);
      assert.doesNotThrow(() => validate(f.output));
      mkdirSync(join(f.output, 'php/vendor'));
      writeFileSync(join(f.output, 'php/vendor/autoload.php'), phpHeader(f.output));
      for (const result of mixed ? ['json', 'empty', 'stream'] : ['stream']) {
        selected = result;
        for (const [command, file] of [
          [process.execPath, 'node/examples/api-value.mjs'],
          [process.execPath, 'node/examples/api-value.ts'],
          ['php', 'php/examples/api-value.php'],
        ]) {
          const localFile = localExampleFile(join(f.output, file));
          const args = file.endsWith('.ts')
            ? ['--experimental-strip-types', localFile]
            : [localFile];
          const execution = await exec(command, args, { env, timeout: 15000 });
          rmSync(localFile);
          if (command === 'php') assert.doesNotMatch(execution.stderr, /Warning:|Fatal error:/);
          if (result === 'stream') assert.match(execution.stdout, /message/);
        }
      }
    }
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
