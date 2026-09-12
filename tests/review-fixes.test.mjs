import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, readdirSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { gzipSync } from 'node:zlib';
import { loadContract, generate, prepareRelease, validate } from '../dist/index.js';
import { compareSchemas } from '../dist/compatibility.js';
import { Runtime, serialize } from '../dist/runtime.js';

const run = promisify(execFile);
const root = mkdtempSync(join(tmpdir(), 'sdk-review-fixes-'));
after(() => rmSync(root, { recursive: true, force: true }));
const profile = {
  version: '1.0.0',
  requests: { style: 'object' },
  npm: { name: '@example/review' },
  composer: { name: 'example/review', namespace: 'Review' },
};
function fixture(label, response, { body, components, config = {}, render = true } = {}) {
  const dir = join(root, label);
  mkdirSync(dir);
  const op = {
    operationId: 'read',
    responses: {
      200: { description: 'OK', content: { 'application/json': { schema: response } } },
    },
  };
  if (body) op.requestBody = { required: true, content: { 'application/json': { schema: body } } };
  const doc = {
    openapi: '3.1.0',
    info: { title: 'Review', version: '1' },
    paths: { '/values': { [body ? 'post' : 'get']: op } },
    ...(components ? { components: { schemas: components } } : {}),
  };
  const f = { dir, doc, cfg: { ...structuredClone(profile), ...config }, out: join(dir, 'sdk') };
  save(f);
  if (render) emit(f);
  return f;
}
function save(f) {
  writeFileSync(join(f.dir, 'api.json'), JSON.stringify(f.doc));
  writeFileSync(join(f.dir, 'config.json'), JSON.stringify(f.cfg));
}
function emit(f) {
  save(f);
  return generate(loadContract(join(f.dir, 'api.json'), join(f.dir, 'config.json')), f.out);
}
function compile(f, source) {
  const file = join(f.dir, 'consumer.mts');
  writeFileSync(file, source);
  return spawnSync(
    process.execPath,
    [
      resolve('node_modules/typescript/bin/tsc'),
      '--strict',
      '--noEmit',
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--typeRoots',
      resolve('node_modules/@types'),
      file,
    ],
    { encoding: 'utf8', timeout: 120000 },
  );
}
const sdk = (f) => import(pathToFileURL(join(f.out, 'node/index.js')).href + '?v=' + f.cfg.version);
async function php(f, code, args = []) {
  const { stdout } = await run('php', [
    '-r',
    `require $argv[1].'/php/src/Runtime.php';require $argv[1].'/php/src/Client.php';${code}`,
    f.out,
    ...args,
  ]);
  return JSON.parse(stdout);
}

test('closed response alternatives match their own fields and retain unknown future objects', async () => {
  const f = fixture('closed-response-alternatives', {
    oneOf: [
      { type: 'object', properties: { card: { type: 'string' } }, additionalProperties: false },
      { type: 'object', properties: { bank: { type: 'string' } }, additionalProperties: false },
    ],
  });
  const { Client, isApiReadResponseKnown } = await sdk(f);
  for (const [data, known] of [
    [{ card: 'visa' }, true],
    [{ bank: 'account' }, true],
    [{ future: 'value' }, false],
  ]) {
    const client = new Client({
      baseUrl: 'https://example.invalid',
      transport: async () => Response.json(data),
    });
    const result = await client.api.read();
    assert.deepEqual(JSON.parse(JSON.stringify(result.data)), data);
    assert.equal(isApiReadResponseKnown(result.data), known);
    assert.deepEqual(
      await php(
        f,
        String.raw`
      $c = new Review\Client(new Review\ClientOptions('https://example.invalid',
        transport: fn($r) => ['status'=>200, 'headers'=>[], 'body'=>$argv[2]]));
      echo json_encode($c->api->read()->data);
    `,
        [JSON.stringify(data)],
      ),
      data,
    );
  }
  // An empty object really does match both branches and must not narrow to either.
  assert.equal(isApiReadResponseKnown({}), false);
  const client = new Client({
    baseUrl: 'https://example.invalid',
    transport: async () => Response.json({}),
  });
  await assert.rejects(client.api.read(), (e) => e.kind === 'protocol');
  assert.equal(
    await php(
      f,
      String.raw`
    $c = new Review\Client(new Review\ClientOptions('https://example.invalid',
      transport: fn($r) => ['status'=>200, 'headers'=>[], 'body'=>'{}']));
    try {$c->api->read();} catch (Review\SdkError $e) {echo json_encode($e->kind);}
  `,
    ),
    'protocol',
  );
});

test('response alternatives retain exact fields and known guards when new fields appear at recursive depths', async () => {
  const detail = {
    type: 'object',
    required: ['amount'],
    additionalProperties: false,
    properties: {
      amount: { type: 'integer', format: 'int64' },
      children: { type: 'array', items: { $ref: '#/components/schemas/Detail' } },
      related: { type: 'object', additionalProperties: { $ref: '#/components/schemas/Detail' } },
    },
  };
  const branches = [
    {
      type: 'object',
      required: ['card', 'amount'],
      additionalProperties: false,
      properties: {
        card: { type: 'string' },
        amount: { type: 'integer', format: 'int64' },
        detail: { $ref: '#/components/schemas/Detail' },
      },
    },
    {
      type: 'object',
      required: ['bank'],
      additionalProperties: false,
      properties: { bank: { type: 'string' } },
    },
  ];
  for (const keyword of ['oneOf', 'anyOf']) {
    const f = fixture(
      'future-fields-' + keyword,
      {
        type: 'object',
        [keyword]: [...branches, ...(keyword === 'anyOf' ? [{ type: 'object' }] : [])],
      },
      { components: { Detail: detail } },
    );
    const generated = await sdk(f);
    const data = {
      card: 'visa',
      amount: 42,
      future: true,
      detail: {
        amount: 7,
        future: true,
        children: [{ amount: 8, future: true }],
        related: { first: { amount: 9, future: true } },
      },
    };
    const expected = {
      card: 'visa',
      amount: '42',
      future: true,
      detail: {
        amount: '7',
        future: true,
        children: [{ amount: '8', future: true }],
        related: { first: { amount: '9', future: true } },
      },
    };
    const client = new generated.Client({
      baseUrl: 'https://example.invalid',
      transport: async () => Response.json(data),
    });
    const result = await client.api.read();
    assert.deepEqual(JSON.parse(JSON.stringify(result.data)), expected);
    assert.deepEqual(
      await php(
        f,
        String.raw`
      $c = new Review\Client(new Review\ClientOptions('https://example.invalid',
        transport: fn($r) => ['status'=>200, 'headers'=>[], 'body'=>$argv[2]]));
      echo json_encode($c->api->read()->data);
    `,
        [JSON.stringify(data)],
      ),
      expected,
    );
    // The response fallback must not permit extra fields in caller inputs.
    assert.throws(
      () => generated.makeDetail({ amount: '7', future: true }),
      (e) => e.kind === 'validation',
    );
    assert.equal(
      await php(
        f,
        String.raw`
      try {new Review\DetailInput(['amount'=>'7', 'future'=>true]);}
      catch (Review\SdkError $e) {echo json_encode($e->kind);}
    `,
      ),
      'validation',
    );
    if (keyword === 'oneOf') {
      const known = generated.isApiReadResponseKnown;
      assert.equal(known(result.data), true);
      assert.equal(known({ ...expected, amount: 'invalid' }), false);
      assert.equal(
        known({
          ...expected,
          detail: { ...expected.detail, children: [{ amount: 'invalid', future: true }] },
        }),
        false,
      );
      assert.equal(known({ ...expected, bank: 'account' }), false);
      assert.equal(known({ future: true }), false);
    }
  }
});

test('tagged response guards retain known variants with additional response fields', async () => {
  const f = fixture('tagged-future-fields', {
    oneOf: [
      {
        type: 'object',
        required: ['kind', 'amount'],
        additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: ['card'] },
          amount: { type: 'integer', format: 'int64' },
        },
      },
      {
        type: 'object',
        required: ['kind'],
        additionalProperties: false,
        properties: { kind: { type: 'string', enum: ['bank'] } },
      },
    ],
    discriminator: { propertyName: 'kind' },
  });
  const { Client, isApiReadResponseKnown } = await sdk(f);
  const raw = '{"kind":"card","amount":42,"future":true}';
  const { data } = await new Client({
    baseUrl: 'https://example.invalid',
    transport: async () => new Response(raw),
  }).api.read();
  assert.equal(data.amount, '42');
  assert.equal(isApiReadResponseKnown(data), true);
  assert.equal(isApiReadResponseKnown({ ...data, kind: 'future' }), false);
  assert.equal(isApiReadResponseKnown({ ...data, amount: 'invalid' }), false);
});

test('unconstrained type changes use input and response compatibility directions during release', () => {
  for (const [before, after, direction, severity] of [
    [{}, { type: 'string' }, 'input', 'breaking'],
    [{ type: 'string' }, {}, 'input', 'additive'],
    [{}, { type: 'string' }, 'response', 'additive'],
    [{ type: 'string' }, {}, 'response', 'breaking'],
  ]) {
    const changes = compareSchemas(before, after, 'value', direction);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].severity, severity);
  }
  const f = fixture(
    'unconstrained-release',
    { type: 'string' },
    {
      body: {},
      config: { targets: ['node'], release: { policy: 'semver' } },
    },
  );
  f.doc.paths['/values'].post.requestBody.content['application/json'].schema = { type: 'string' };
  f.cfg.version = '1.1.0';
  assert(
    emit(f).compatibility.some((c) => c.subject === 'read.input.body' && c.severity === 'breaking'),
  );
  assert.throws(
    () => prepareRelease(f.out, join(f.dir, 'minor')),
    /breaking changes require a new major/,
  );
  f.cfg.version = '2.0.0';
  emit(f);
  assert.equal(prepareRelease(f.out, join(f.dir, 'major')).version, '2.0.0');
});

test('exact numeric representation changes remain breaking when accepted JSON kinds widen', () => {
  for (const numeric of [
    { type: 'number' },
    { type: ['number', 'null'] },
    { type: 'integer', format: 'int64' },
    { type: ['integer', 'null'], format: 'uint64' },
  ]) {
    for (const [before, after] of [
      [numeric, {}],
      [{}, numeric],
    ]) {
      for (const direction of ['input', 'response']) {
        assert(
          compareSchemas(before, after, 'value', direction).some(
            (c) => c.severity === 'breaking' && /representation/.test(c.message),
          ),
          JSON.stringify({ before, after, direction }),
        );
      }
    }
  }
  // Widening kinds is still compatible when existing values keep their encoding.
  for (const before of [{ type: 'string' }, { type: 'integer' }, { type: 'boolean' }]) {
    assert(!compareSchemas(before, {}, 'value', 'input').some((c) => c.severity === 'breaking'));
  }
  const number = { type: 'number' },
    nullable = { type: ['number', 'null'] };
  assert(
    !compareSchemas(number, nullable, 'value', 'input').some((c) => c.severity === 'breaking'),
  );
  assert(
    !compareSchemas(nullable, number, 'value', 'response').some((c) => c.severity === 'breaking'),
  );
});

test('removing numeric input encoding requires a major release in both generated clients', async () => {
  const f = fixture(
    'numeric-encoding-release',
    { type: 'string' },
    {
      body: { type: 'object', required: ['amount'], properties: { amount: { type: 'number' } } },
      config: { release: { policy: 'semver' } },
    },
  );
  const requestWire = async () => {
    const { Client } = await sdk(f);
    let wire;
    await new Client({
      baseUrl: 'https://example.invalid',
      transport: async (_url, init) => {
        wire = init.body;
        return Response.json('ok');
      },
    }).api.read({ body: { amount: '42' } });
    const phpWire = await php(
      f,
      String.raw`
      $wire = null;
      $c = new Review\Client(new Review\ClientOptions('https://example.invalid',
        transport: function($r) use (&$wire) {
          $wire = $r['body'];
          return ['status'=>200, 'headers'=>[], 'body'=>'"ok"'];
        }));
      $c->api->read(new Review\ApiReadInput(['body'=>['amount'=>'42']]));
      echo json_encode($wire);
    `,
    );
    assert.equal(wire, phpWire);
    return wire;
  };
  assert.equal(await requestWire(), '{"amount":42}');
  f.doc.paths['/values'].post.requestBody.content['application/json'].schema.properties.amount = {};
  f.cfg.version = '1.1.0';
  const changes = emit(f).compatibility;
  assert.equal(await requestWire(), '{"amount":"42"}');
  assert(changes.some((c) => c.subject === 'read.input.body.amount' && c.severity === 'breaking'));
  assert.throws(
    () => prepareRelease(f.out, join(f.dir, 'minor')),
    /breaking changes require a new major/,
  );
  f.cfg.version = '2.0.0';
  emit(f);
  assert.equal(prepareRelease(f.out, join(f.dir, 'major')).version, '2.0.0');
});

test('expanding nullable numeric input enums permits minor releases without changing existing values', async () => {
  for (const numeric of [
    { type: ['number', 'null'] },
    { type: ['integer', 'null'], format: 'int64' },
    { type: ['integer', 'null'], format: 'uint64' },
  ]) {
    const before = { ...numeric, enum: [null] };
    for (const after of [{ ...numeric, enum: [null, 1] }, numeric]) {
      assert(
        !compareSchemas(before, after, 'amount', 'input').some((c) => c.severity === 'breaking'),
      );
      assert.equal(serialize(null, before), serialize(null, after));
      assert.equal(serialize('1', after), '1');
      assert(
        compareSchemas(after, before, 'amount', 'input').some((c) => c.severity === 'breaking'),
      );
    }
    // Response enums remain open, so dropping their numeric representation is breaking.
    assert(compareSchemas(before, {}, 'amount', 'response').some((c) => c.severity === 'breaking'));
  }
  const f = fixture(
    'numeric-enum-expansion-release',
    { type: 'string' },
    {
      body: {
        type: 'object',
        required: ['amount'],
        properties: { amount: { type: ['number', 'null'], enum: [null] } },
      },
      config: { release: { policy: 'semver' } },
    },
  );
  const requestWire = async (amount) => {
    const { Client } = await sdk(f);
    let wire;
    await new Client({
      baseUrl: 'https://example.invalid',
      transport: async (_url, init) => {
        wire = init.body;
        return Response.json('ok');
      },
    }).api.read({ body: { amount } });
    assert.equal(
      await php(
        f,
        String.raw`
      $wire = null;
      $c = new Review\Client(new Review\ClientOptions('https://example.invalid',
        transport: function($r) use (&$wire) {
          $wire = $r['body'];
          return ['status'=>200, 'headers'=>[], 'body'=>'"ok"'];
        }));
      $c->api->read(new Review\ApiReadInput(['body'=>['amount'=>json_decode($argv[2])]]));
      echo json_encode($wire);
    `,
        [JSON.stringify(amount)],
      ),
      wire,
    );
    return wire;
  };
  assert.equal(await requestWire(null), '{"amount":null}');
  const amount =
    f.doc.paths['/values'].post.requestBody.content['application/json'].schema.properties.amount;
  amount.enum.push(1);
  f.cfg.version = '1.1.0';
  assert(!emit(f).compatibility.some((c) => c.severity === 'breaking'));
  assert.equal(await requestWire(null), '{"amount":null}');
  assert.equal(await requestWire('1'), '{"amount":1}');
  assert.equal(prepareRelease(f.out, join(f.dir, 'minor')).version, '1.1.0');
});

test('redundant enum input types permit minor releases without weakening representation or response checks', () => {
  for (const [members, type] of [
    [['card', 'bank'], 'string'],
    [[true, false], 'boolean'],
    [[1, 2], 'integer'],
    [[null], 'null'],
    [[null], ['number', 'null']],
    [
      ['card', null],
      ['string', 'null'],
    ],
    [['card'], ['string', 'null']],
  ]) {
    const implicit = { enum: members },
      explicit = { type, enum: members };
    for (const [before, after] of [
      [implicit, explicit],
      [explicit, implicit],
    ]) {
      assert(
        !compareSchemas(before, after, 'input', 'input').some((c) => c.severity === 'breaking'),
      );
      for (const value of members) assert.equal(serialize(value, before), serialize(value, after));
    }
  }
  const implicit = { enum: ['card', 'bank'] },
    explicit = { type: 'string', enum: ['card', 'bank'] };
  for (const shape of [implicit, explicit]) {
    for (const value of [123, null, {}, 'cash']) assert.throws(() => serialize(value, shape));
  }
  // Numeric wire representations and open response enums are still significant.
  assert(
    compareSchemas({ enum: [1] }, { type: 'number', enum: [1] }, 'input', 'input').some(
      (c) => c.severity === 'breaking',
    ),
  );
  assert(
    compareSchemas(
      { enum: [1] },
      { type: 'integer', format: 'int64', enum: [1] },
      'input',
      'input',
    ).some((c) => c.severity === 'breaking'),
  );
  assert(
    compareSchemas(explicit, implicit, 'response', 'response').some(
      (c) => c.severity === 'breaking',
    ),
  );
  assert(
    compareSchemas(implicit, { type: 'string', enum: ['card'] }, 'input', 'input').some(
      (c) => c.severity === 'breaking',
    ),
  );
  const f = fixture(
    'enum-type-release',
    { type: 'string' },
    { body: implicit, config: { targets: ['node'], release: { policy: 'semver' } } },
  );
  const declarations = readFileSync(join(f.out, 'node/index.d.ts'), 'utf8');
  f.doc.paths['/values'].post.requestBody.content['application/json'].schema = explicit;
  f.cfg.version = '1.1.0';
  assert(!emit(f).compatibility.some((c) => c.severity === 'breaking'));
  assert.equal(readFileSync(join(f.out, 'node/index.d.ts'), 'utf8'), declarations);
  assert.equal(prepareRelease(f.out, join(f.dir, 'minor')).version, '1.1.0');
});

test('composed input constraints recognize redundant types while still detecting narrowed inputs', () => {
  for (const [implicit, type] of [
    [{ allOf: [{ type: 'string' }, { minLength: 1 }] }, 'string'],
    [
      {
        anyOf: [
          { type: 'string', enum: ['card'] },
          { type: 'string', enum: ['bank'] },
        ],
      },
      'string',
    ],
    [
      {
        oneOf: [
          { type: 'string', enum: ['card'] },
          { type: 'string', enum: ['bank'] },
        ],
      },
      'string',
    ],
    [{ anyOf: [{ type: 'string' }, { type: 'null' }] }, ['string', 'null']],
    [
      { allOf: [{ anyOf: [{ type: 'string' }, { type: 'boolean' }] }, { enum: ['card', 'bank'] }] },
      'string',
    ],
  ]) {
    const explicit = { ...implicit, type };
    for (const [before, after] of [
      [implicit, explicit],
      [explicit, implicit],
    ]) {
      assert(
        !compareSchemas(before, after, 'body', 'input').some((c) => c.severity === 'breaking'),
      );
      for (const value of ['card', 'bank', true, null, 42, {}]) {
        const encode = (schema) => {
          try {
            return { wire: serialize(value, schema) };
          } catch {
            return { rejected: true };
          }
        };
        assert.deepEqual(encode(before), encode(after));
      }
    }
  }
  for (const before of [
    { anyOf: [{ type: 'string' }, { type: 'boolean' }] },
    { allOf: [{ minLength: 1 }, { maxLength: 10 }] },
  ]) {
    assert(
      compareSchemas(before, { ...before, type: 'string' }, 'body', 'input').some(
        (c) => c.severity === 'breaking',
      ),
    );
  }
  const numeric = { minimum: 1, anyOf: [{ type: 'number' }] };
  assert(
    compareSchemas(numeric, { ...numeric, type: 'number' }, 'body', 'input').some(
      (c) => c.severity === 'breaking',
    ),
  );
  // Unlike inputs, response alternatives may retain unknown future JSON kinds.
  const alternatives = { anyOf: [{ type: 'string' }] };
  assert(
    compareSchemas({ ...alternatives, type: 'string' }, alternatives, 'body', 'response').some(
      (c) => c.severity === 'breaking',
    ),
  );
  const f = fixture(
    'composed-type-release',
    { type: 'string' },
    {
      body: {
        anyOf: [
          { type: 'string', enum: ['card'] },
          { type: 'string', enum: ['bank'] },
        ],
      },
      config: { targets: ['node'], release: { policy: 'semver' } },
    },
  );
  const consumer =
    "import {Client} from './sdk/node/index.js'; const client = new Client({baseUrl:'https://example.invalid'}); client.api.read({body:'card'}); client.api.read({body:'bank'});";
  let compilation = compile(f, consumer);
  assert.equal(compilation.status, 0, compilation.stdout + compilation.stderr);
  f.doc.paths['/values'].post.requestBody.content['application/json'].schema.type = 'string';
  f.cfg.version = '1.1.0';
  assert(!emit(f).compatibility.some((c) => c.severity === 'breaking'));
  compilation = compile(f, consumer);
  assert.equal(compilation.status, 0, compilation.stdout + compilation.stderr);
  assert.equal(prepareRelease(f.out, join(f.dir, 'minor')).version, '1.1.0');
});

test('native clients decode compressed successes and code-specific retry errors with default and explicit encoding headers', async () => {
  const f = fixture(
    'compressed-http',
    {
      type: 'object',
      required: ['value'],
      properties: { value: { type: 'integer' } },
    },
    {
      config: {
        operations: {
          read: {
            retry: {
              maxAttempts: 2,
              statuses: [],
              errors: [{ status: 503, codes: ['temporarily_unavailable'] }],
              transport: false,
              baseDelayMs: 0,
            },
          },
        },
      },
    },
  );
  const counts = new Map(),
    requests = [];
  const server = createServer((req, res) => {
    const key = req.headers['x-test-run'];
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    requests.push(req.headers);
    const retry = key.endsWith('retry') && count === 1;
    res.writeHead(retry ? 503 : 200, {
      'content-type': 'application/json',
      'content-encoding': 'gzip',
    });
    res.end(gzipSync(JSON.stringify(retry ? { code: 'temporarily_unavailable' } : { value: 1 })));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { Client } = await sdk(f);
    const client = new Client({ baseUrl: base, allowInsecureHttp: true });
    for (const explicit of [false, true]) {
      for (const kind of ['success', 'retry']) {
        const result = await client.api.read(
          {},
          {
            headers: {
              'x-test-run': `node-${explicit}-${kind}`,
              ...(explicit ? { 'accept-encoding': 'gzip' } : {}),
            },
          },
        );
        assert.equal(result.data.value, 1);
        assert.equal(result.meta.attempts, kind === 'retry' ? 2 : 1);
      }
    }
    const results = await php(
      f,
      String.raw`
      $c = new Review\Client(new Review\ClientOptions($argv[2], allowInsecureHttp:true));
      $results = [];
      foreach ([false, true] as $explicit) {
        foreach (['success', 'retry'] as $kind) {
          $headers = ['x-test-run'=>'php-'.($explicit ? 'true' : 'false').'-'.$kind];
          if ($explicit) $headers['accept-encoding'] = 'gzip';
          $r = $c->api->read(options:new Review\RequestOptions(headers:$headers));
          $results[] = [$r->data->getValue(), $r->meta['attempts']];
        }
      }
      $c->close();
      echo json_encode($results);
    `,
      [base],
    );
    assert.deepEqual(results, [
      [1, 1],
      [1, 2],
      [1, 1],
      [1, 2],
    ]);
    assert.equal(requests.length, 12);
    for (const headers of requests) assert.match(headers['accept-encoding'], /gzip/);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('an installed generated npm archive typechecks without the generator type roots', async () => {
  const f = fixture('standalone-types', { type: 'string' }, { config: { targets: ['node'] } });
  const packed = await run(
    'npm',
    ['pack', '--ignore-scripts', '--json', '--pack-destination', f.dir],
    { cwd: join(f.out, 'node') },
  );
  const archive = join(f.dir, JSON.parse(packed.stdout)[0].filename);
  const consumer = join(f.dir, 'consumer');
  mkdirSync(consumer);
  writeFileSync(
    join(consumer, 'package.json'),
    JSON.stringify({ name: 'review-consumer', private: true, type: 'module' }),
  );
  await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', archive], {
    cwd: consumer,
  });
  writeFileSync(
    join(consumer, 'index.ts'),
    `import {Client} from '@example/review';
    const client = new Client({baseUrl:'https://example.invalid'});
    const result: string = (await client.api.read()).data;
  `,
  );
  const compilation = spawnSync(
    process.execPath,
    [
      resolve('node_modules/typescript/bin/tsc'),
      '--strict',
      '--noEmit',
      '--target',
      'ES2022',
      '--lib',
      'ES2022',
      '--module',
      'NodeNext',
      'index.ts',
    ],
    { cwd: consumer, encoding: 'utf8', timeout: 120000 },
  );
  assert.equal(compilation.status, 0, compilation.stdout + compilation.stderr);
});

test('exported response-model factories enforce major versions when their inputs tighten', async () => {
  const f = fixture(
    'compatibility',
    { $ref: '#/components/schemas/Book' },
    {
      components: {
        Book: { type: 'object', required: ['title'], properties: { title: { type: 'string' } } },
      },
      config: { targets: ['node'], release: { policy: 'semver' } },
    },
  );
  const consumer = "import {makeBook} from './sdk/node/index.js'; makeBook({title:'A book'});";
  assert.equal(compile(f, consumer).status, 0);
  const shape = f.doc.components.schemas.Book;
  shape.properties.isbn = { type: 'string' };
  shape.required.push('isbn');
  f.cfg.version = '1.1.0';
  const findings = emit(f).compatibility;
  assert(findings.some((c) => c.severity === 'breaking' && c.subject === 'models.Book.input.isbn'));
  assert.equal(compile(f, consumer).status, 2);
  assert.throws(
    () => prepareRelease(f.out, join(f.dir, 'minor')),
    /breaking changes require a new major/,
  );
  f.cfg.version = '2.0.0';
  emit(f);
  assert.equal(
    compile(
      f,
      "import {makeBook} from './sdk/node/index.js'; makeBook({title:'A book',isbn:'123'});",
    ).status,
    0,
  );
  assert.equal(prepareRelease(f.out, join(f.dir, 'major')).version, '2.0.0');
});

test('diagnosis rejects TypeScript built-ins and forbidden aliases with model rename recovery', () => {
  for (const name of [
    'Promise',
    'AsyncGenerator',
    'Record',
    'Exclude',
    'unknown',
    'any',
    'number',
    'boolean',
    'bigint',
    'symbol',
    'undefined',
    'intrinsic',
  ]) {
    const f = fixture(
      'name-' + name,
      { $ref: '#/components/schemas/' + name },
      { components: { [name]: { type: 'string' } }, config: { targets: ['node'] }, render: false },
    );
    const diagnosis = spawnSync(
      process.execPath,
      [resolve('dist/cli.js'), 'diagnose', join(f.dir, 'api.json'), join(f.dir, 'config.json')],
      { encoding: 'utf8' },
    );
    assert.notEqual(diagnosis.status, 0, name);
    assert.match(diagnosis.stderr, /collision|reserved/);
    f.cfg.models = { [name]: 'ProviderValue' };
    emit(f);
    if (['Promise', 'unknown', 'Exclude'].includes(name)) {
      const result = compile(
        f,
        "import {Client} from './sdk/node/index.js'; new Client({baseUrl:'https://example.invalid'}).api.read();",
      );
      assert.equal(result.status, 0, result.stdout);
    }
  }
});

test('PHP distinguishes array and object alternatives in requests and native HTTP responses', async () => {
  const schema = { oneOf: [{ type: 'object' }, { type: 'array', items: { type: 'string' } }] };
  const f = fixture('union', schema, { body: schema });
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (bytes) => (body += bytes));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const baseUrl = 'http://127.0.0.1:' + server.address().port;
    const { Client } = await sdk(f);
    const client = new Client({ baseUrl, allowInsecureHttp: true });
    for (const body of [['x'], [], {}, { field: 'value' }])
      assert.equal(JSON.stringify((await client.api.read({ body })).data), JSON.stringify(body));
    const result = await php(
      f,
      String.raw`$c=new Review\Client(new Review\ClientOptions($argv[2],allowInsecureHttp:true));$out=[];foreach([['x'],[],new stdClass(),['field'=>'value']] as $body){$r=$c->api->read(new Review\ApiReadInput(['body'=>$body]));$out[]=$r->raw;}echo json_encode($out);`,
      [baseUrl],
    );
    assert.deepEqual(result, ['["x"]', '[]', '{}', '{"field":"value"}']);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  const object = fixture('object-response', { type: 'object' });
  const rejection = await php(
    object,
    String.raw`$c=new Review\Client(new Review\ClientOptions('https://example.invalid',transport:fn($r)=>['status'=>200,'headers'=>[],'body'=>'[]']));try{$c->api->read();echo json_encode('accepted');}catch(Review\SdkError $e){echo json_encode($e->kind);}`,
  );
  assert.equal(rejection, 'protocol');
});

test('PHP nested model getters retain plain values, exact numbers, lists, objects and null presence', async () => {
  const f = fixture(
    'getters',
    { type: 'string' },
    {
      body: { $ref: '#/components/schemas/Payload' },
      components: {
        Title: { type: 'string' },
        Tags: { type: 'array', items: { type: 'string' } },
        Amount: { type: 'number' },
        Payload: {
          type: 'object',
          required: ['title'],
          properties: {
            title: { $ref: '#/components/schemas/Title' },
            tags: { $ref: '#/components/schemas/Tags' },
            amount: { $ref: '#/components/schemas/Amount' },
            empty: { type: 'object' },
            note: { type: ['string', 'null'] },
            missing: { type: 'string' },
          },
        },
      },
    },
  );
  const result = await php(
    f,
    String.raw`$p=new Review\PayloadInput(['title'=>new Review\TitleInput('hello'),'tags'=>new Review\TagsInput(['x']),'amount'=>new Review\AmountInput('1.00'),'empty'=>[],'note'=>null]);$wire=null;$c=new Review\Client(new Review\ClientOptions('https://example.invalid',transport:function($r)use(&$wire){$wire=$r['body'];return ['status'=>200,'headers'=>[],'body'=>'"ok"'];}));$c->api->read(new Review\ApiReadInput(['body'=>$p]));echo json_encode(['title'=>$p->getTitle(),'tags'=>$p->getTags(),'amount'=>$p->getAmount(),'empty'=>$p->getEmpty(),'hasNote'=>$p->has('note'),'note'=>$p->getNote(),'hasMissing'=>$p->has('missing'),'wire'=>$wire]);`,
  );
  assert.deepEqual(result, {
    title: 'hello',
    tags: ['x'],
    amount: '1.00',
    empty: {},
    hasNote: true,
    note: null,
    hasMissing: false,
    wire: '{"title":"hello","tags":["x"],"amount":1.00,"empty":{},"note":null}',
  });
});

test('exact numeric enums accept equal spellings but reject unequal values in both public clients', async () => {
  const f = fixture('enum', { type: 'number' }, { body: { type: 'number', enum: [0, 1] } });
  const valid = ['1', '1.0', '1e0', '0', '-0', '-0.00', '0e999999'];
  const invalid = ['2', '1.000000000000000001', 'abc', '', '01', true, null];
  const { Client } = await sdk(f);
  const bodies = [];
  const client = new Client({
    baseUrl: 'https://example.invalid',
    transport: async (_url, request) => {
      bodies.push(request.body);
      return new Response('1');
    },
  });
  for (const body of valid) await client.api.read({ body });
  for (const body of invalid)
    await assert.rejects(client.api.read({ body }), (e) => e.kind === 'validation');
  assert.deepEqual(bodies, valid);
  const result = await php(
    f,
    String.raw`$values=json_decode($argv[2],true);$out=[];$c=new Review\Client(new Review\ClientOptions('https://example.invalid',transport:function($r)use(&$out){$out[]=$r['body'];return ['status'=>200,'headers'=>[],'body'=>'1'];}));foreach($values[0] as $v)$c->api->read(new Review\ApiReadInput(['body'=>$v]));$errors=[];foreach($values[1] as $v){try{$c->api->read(new Review\ApiReadInput(['body'=>$v]));$errors[]='accepted';}catch(Review\SdkError $e){$errors[]=$e->kind;}}echo json_encode(['bodies'=>$out,'errors'=>$errors]);`,
    [JSON.stringify([valid, invalid])],
  );
  assert.deepEqual(result, { bodies: valid, errors: invalid.map(() => 'validation') });
  const compilation = compile(
    f,
    "import {Client} from './sdk/node/index.js'; const c=new Client({baseUrl:'https://example.invalid'}); c.api.read({body:'1.0'}); c.api.read({body:'1e0'});",
  );
  assert.equal(compilation.status, 0, compilation.stdout);
  const union = fixture('enum-response', {
    oneOf: [
      { type: 'number', enum: [1] },
      { type: 'number', enum: [2] },
    ],
  });
  const generated = await sdk(union);
  for (const raw of ['1', '1.0', '1e0', '3']) {
    const c = new generated.Client({
      baseUrl: 'https://example.invalid',
      transport: async () => new Response(raw),
    });
    assert.equal(generated.isApiReadResponseKnown((await c.api.read()).data), raw !== '3');
  }
});

test('required-only fields enforce input and response compatibility and block breaking patch releases', () => {
  const optional = { type: 'object' };
  const required = { type: 'object', required: ['tenant'] };
  for (const [before, after, direction, severity] of [
    [optional, required, 'input', 'breaking'],
    [required, optional, 'input', 'additive'],
    [optional, required, 'response', 'additive'],
    [required, optional, 'response', 'breaking'],
  ]) {
    assert(
      compareSchemas(before, after, 'payload', direction).some(
        (c) => c.subject === 'payload.tenant' && c.severity === severity,
      ),
    );
  }
  const f = fixture(
    'required-only-release',
    { type: 'string' },
    {
      body: optional,
      config: { targets: ['node'], release: { policy: 'semver' } },
    },
  );
  f.doc.paths['/values'].post.requestBody.content['application/json'].schema = required;
  f.cfg.version = '1.0.1';
  assert(emit(f).compatibility.some((c) => c.severity === 'breaking'));
  assert.throws(() => prepareRelease(f.out, join(f.dir, 'release'), true), /new major version/);
});

test('relative and absolute pagination self-links stop before duplicate dispatch in both clients', async () => {
  const f = fixture(
    'pagination-self-links',
    {
      type: 'object',
      properties: {
        items: { type: 'array', items: { type: 'string' } },
        next: { type: ['string', 'null'] },
      },
    },
    {
      config: {
        operations: { read: { pagination: { kind: 'link', items: 'items', next: 'next' } } },
      },
    },
  );
  const { Client } = await sdk(f);
  const scenarios = [
    { links: ['?page=2', '?page=2'], error: 'protocol' },
    { links: ['?page=2', 'https://example.invalid/values?page=2'], error: 'protocol' },
    { links: ['/values'], error: 'protocol' },
    { links: ['?page=2', '?page=3', null], error: null },
  ];
  for (const scenario of scenarios) {
    const urls = [],
      items = [];
    const c = new Client({
      baseUrl: 'https://example.invalid',
      transport: async (url) => {
        urls.push(String(url));
        return Response.json({ items: [String(url)], next: scenario.links[urls.length - 1] });
      },
    });
    let error = null;
    try {
      for await (const item of c.api.readItems({}, { maxPages: 5 })) items.push(item);
    } catch (e) {
      error = e.kind;
    }
    assert.equal(error, scenario.error);
    assert.equal(urls.length, scenario.links.length);
    assert.equal(new Set(urls).size, urls.length);
    const result = await php(
      f,
      String.raw`$links=json_decode($argv[2],true);$urls=[];$items=[];$error=null;$c=new Review\Client(new Review\ClientOptions('https://example.invalid',transport:function($r)use(&$urls,$links){$urls[]=$r['url'];return ['status'=>200,'headers'=>[],'body'=>json_encode(['items'=>[$r['url']],'next'=>$links[count($urls)-1]])];}));try{foreach($c->api->readItems(new Review\ApiReadInput(),new Review\RequestOptions(maxPages:5)) as $item)$items[]=$item;}catch(Review\SdkError $e){$error=$e->kind;}echo json_encode(['urls'=>$urls,'items'=>$items,'error'=>$error]);`,
      [JSON.stringify(scenario.links)],
    );
    assert.deepEqual(result, { urls, items, error });
  }
});

test('negated value constraints allow valid TypeScript inputs while retaining runtime validation', async () => {
  const f = fixture(
    'negated-value-types',
    { type: 'string' },
    {
      body: {
        type: 'object',
        properties: { mode: { type: 'string' } },
        not: {
          required: ['mode'],
          properties: { mode: { enum: ['forbidden'] } },
        },
      },
      config: { operations: { read: { example: { body: { mode: 'allowed' } } } } },
    },
  );
  const compilation = compile(
    f,
    "import {Client} from './sdk/node/index.js'; const c=new Client({baseUrl:'https://example.invalid'}); c.api.read({body:{mode:'allowed'}}); c.api.read({body:{}});",
  );
  assert.equal(compilation.status, 0, compilation.stdout);
  validate(f.out);
  const { Client } = await sdk(f);
  let calls = 0;
  const c = new Client({
    baseUrl: 'https://example.invalid',
    transport: async () => {
      calls++;
      return Response.json('ok');
    },
  });
  await c.api.read({ body: { mode: 'allowed' } });
  await c.api.read({ body: {} });
  await assert.rejects(c.api.read({ body: { mode: 'forbidden' } }), (e) => e.kind === 'validation');
  assert.equal(calls, 2);
  const result = await php(
    f,
    String.raw`$calls=0;$c=new Review\Client(new Review\ClientOptions('https://example.invalid',transport:function($r)use(&$calls){$calls++;return ['status'=>200,'headers'=>[],'body'=>'"ok"'];}));$c->api->read(new Review\ApiReadInput(['body'=>['mode'=>'allowed']]));$c->api->read(new Review\ApiReadInput(['body'=>new stdClass()]));try{$c->api->read(new Review\ApiReadInput(['body'=>['mode'=>'forbidden']]));}catch(Review\SdkError $e){echo json_encode(['calls'=>$calls,'error'=>$e->kind]);}`,
  );
  assert.deepEqual(result, { calls: 2, error: 'validation' });
});

test('removing either target preserves custom files and validates/releases only the selected package', () => {
  for (const target of ['node', 'php']) {
    const f = fixture('remove-target-' + target, { type: 'string' });
    for (const language of ['node', 'php']) {
      mkdirSync(join(f.out, language, 'custom'), { recursive: true });
      writeFileSync(join(f.out, language, 'custom', 'notes.txt'), 'handwritten');
    }
    f.cfg.targets = [target];
    emit(f);
    for (const language of ['node', 'php'])
      assert.equal(
        readFileSync(join(f.out, language, 'custom', 'notes.txt'), 'utf8'),
        'handwritten',
      );
    const checks = validate(f.out);
    assert(!checks.some((c) => c.command.startsWith(target === 'node' ? 'php ' : 'node ')));
    const destination = join(f.dir, 'release');
    const plan = prepareRelease(f.out, destination, true);
    const archives = readdirSync(destination).filter((p) => /\.(tgz|zip)$/.test(p));
    assert.equal(archives.length, 1);
    assert(archives[0].endsWith(target === 'node' ? '.tgz' : '.zip'));
    assert.equal(plan.packages[target === 'node' ? 'composer' : 'npm'], null);
  }
});

test('GET/HEAD bodies are diagnosed for Node targets and fail before runtime dispatch', async () => {
  for (const verb of ['get', 'head']) {
    const f = fixture(
      'body-' + verb,
      { type: 'string' },
      { body: { type: 'object' }, render: false },
    );
    f.doc.paths['/values'] = { [verb]: f.doc.paths['/values'].post };
    for (const targets of [undefined, ['node']]) {
      f.cfg.targets = targets;
      save(f);
      assert.throws(
        () => loadContract(join(f.dir, 'api.json'), join(f.dir, 'config.json')),
        /requestBody: GET\/HEAD request bodies are unsupported/,
      );
    }
    f.cfg.targets = ['php'];
    save(f);
    const contract = loadContract(join(f.dir, 'api.json'), join(f.dir, 'config.json'));
    let calls = 0;
    const runtime = new Runtime(
      { operations: contract.operations },
      {
        baseUrl: 'https://example.invalid',
        transport: async () => {
          calls++;
          return Response.json('ok');
        },
      },
    );
    await assert.rejects(
      runtime.request('read', { body: {} }),
      (e) => e.kind === 'validation' && e.outcome === 'not_sent',
    );
    assert.equal(calls, 0);
    delete f.doc.paths['/values'][verb].requestBody;
    f.cfg.targets = ['node'];
    save(f);
    assert.doesNotThrow(() => loadContract(join(f.dir, 'api.json'), join(f.dir, 'config.json')));
  }
});

test('typeless object constraints preserve nonobject inputs and require response narrowing', async () => {
  const loose = { properties: { id: { type: 'string' } }, required: ['id'] };
  const f = fixture(
    'typeless-object-constraints',
    { $ref: '#/components/schemas/Loose' },
    {
      body: { $ref: '#/components/schemas/Loose' },
      components: { Loose: loose },
    },
  );
  const compiled = compile(
    f,
    `
import { Client, makeLoose, type Loose, type LooseInput } from './sdk/node/index.js';
const values: LooseInput[] = [null, true, 42, 'text', [], {id:'ok'}];
for (const value of values) makeLoose(value);
// @ts-expect-error Object inputs still require id.
const missing: LooseInput = {};
async function consume(client: Client) {
  for (const body of values) {
    const {data} = await client.api.read({body});
    // @ts-expect-error A typeless schema does not guarantee an object response.
    data.id.toUpperCase();
    if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
      const id: string = data.id;
    }
  }
}
`,
  );
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
  const { Client, makeLoose } = await sdk(f);
  const sent = [];
  const client = new Client({
    baseUrl: 'https://example.invalid',
    transport: async (_, init) => {
      sent.push(init.body);
      return new Response(init.body);
    },
  });
  const values = [null, true, 42, 'text', [], { id: 'ok' }];
  for (const body of values) {
    const { data } = await client.api.read({ body: makeLoose(body) });
    assert.equal(JSON.stringify(data), JSON.stringify(body));
  }
  assert.deepEqual(
    sent,
    values.map((v) => JSON.stringify(v)),
  );
  await assert.rejects(client.api.read({ body: {} }), /required field/);
});

test('typeless nested schemas and alternatives stay broad while object intersections retain fields', async () => {
  const loose = { properties: { id: { type: 'string' } }, required: ['id'] };
  const f = fixture('typeless-composition-context', {
    type: 'object',
    required: ['loose', 'choice', 'constrained'],
    properties: {
      loose,
      choice: { anyOf: [loose, { type: 'string' }] },
      constrained: {
        allOf: [{ type: 'object' }, loose],
      },
    },
  });
  const compiled = compile(
    f,
    `
import {Client} from './sdk/node/index.js';
async function consume(client: Client) {
  const {data} = await client.api.read();
  const id: string = data.constrained.id;
  // @ts-expect-error The enclosing object's type does not constrain its children.
  data.loose.id.toUpperCase();
  // @ts-expect-error Typeless alternatives can return nonobjects, including future values.
  data.choice.id.toUpperCase();
}
`,
  );
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
  const { Client } = await sdk(f);
  const expected = { loose: null, choice: true, constrained: { id: 'ok' } };
  const { data } = await new Client({
    baseUrl: 'https://example.invalid',
    transport: async () => new Response(JSON.stringify(expected)),
  }).api.read();
  assert.equal(JSON.stringify(data), JSON.stringify(expected));
});

test('nullable object intersections retain field types after narrowing without excluding null', async () => {
  const loose = { properties: { id: { type: 'string' } }, required: ['id'] };
  const nullable = { allOf: [{ type: ['object', 'null'] }, loose] };
  const f = fixture('nullable-object-intersections', {
    type: 'object',
    required: ['nullable', 'object', 'text'],
    properties: {
      nullable,
      object: { allOf: [nullable, { type: 'object' }] },
      text: { allOf: [{ type: 'string' }, loose] },
    },
  });
  const compiled = compile(
    f,
    `
import { Client, type ApiReadResponse } from './sdk/node/index.js';
const value: ApiReadResponse = {nullable:null, object:{id:'ok'}, text:'ok'};
async function consume(client:Client) {
  const {data} = await client.api.read();
  // @ts-expect-error Null still requires a check.
  data.nullable.id.toUpperCase();
  if (data.nullable !== null) { const id:string = data.nullable.id; }
  const id:string = data.object.id;
  const text:string = data.text;
}
`,
  );
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
  const { Client } = await sdk(f);
  for (const value of [null, { id: 'ok' }]) {
    const expected = { nullable: value, object: { id: 'ok' }, text: 'ok' };
    const { data } = await new Client({
      baseUrl: 'https://example.invalid',
      transport: async () => new Response(JSON.stringify(expected)),
    }).api.read();
    assert.equal(JSON.stringify(data), JSON.stringify(expected));
  }
});

test('recursive typeless models retain object constraints at each reference without narrowing the root', async () => {
  const reference = { $ref: '#/components/schemas/Recursive' };
  const f = fixture('recursive-object-context', reference, {
    body: reference,
    components: {
      Recursive: {
        properties: {
          id: { type: 'string' },
          next: { allOf: [{ type: 'object' }, reference] },
          nullableNext: { allOf: [{ type: ['object', 'null'] }, reference] },
        },
        required: ['id'],
      },
    },
  });
  const compiled = compile(
    f,
    `
import {Client,makeRecursive,type RecursiveInput} from './sdk/node/index.js';
makeRecursive(null);
makeRecursive('root');
makeRecursive([]);
makeRecursive({id:'a',next:{id:'b',next:{id:'c'}},nullableNext:null});
// @ts-expect-error The nested reference requires an object.
const badNull:RecursiveInput={id:'a',next:null};
// @ts-expect-error Arrays are not objects under the schema.
const badArray:RecursiveInput={id:'a',next:[]};
// @ts-expect-error Nullable object references still reject strings.
const badString:RecursiveInput={id:'a',nullableNext:'wrong'};
async function consume(client:Client){
 const {data}=await client.api.read({body:null});
 // @ts-expect-error The root remains typeless and must be narrowed.
 data.id.toUpperCase();
 if(data!==null && typeof data==='object' && !Array.isArray(data)){
   const id:string=data.id;
   if(data.next){
     const nextId:string=data.next.id;
     if(data.next.next){const deeperId:string=data.next.next.id;}
   }
   if(data.nullableNext!==undefined && data.nullableNext!==null){
     const nullableId:string=data.nullableNext.id;
     if(data.nullableNext.next){const deeperId:string=data.nullableNext.next.id;}
   }
 }
}
`,
  );
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
  const { Client, makeRecursive } = await sdk(f);
  let sent = 0;
  const client = new Client({
    baseUrl: 'https://example.invalid',
    transport: async (_, init) => {
      sent++;
      return new Response(init.body);
    },
  });
  for (const value of [
    null,
    'root',
    [],
    { id: 'a', next: { id: 'b', next: { id: 'c' } }, nullableNext: null },
    { id: 'a', nullableNext: { id: 'b', next: { id: 'c' } } },
  ]) {
    const { data } = await client.api.read({ body: makeRecursive(value) });
    assert.equal(JSON.stringify(data), JSON.stringify(value));
  }
  const before = sent;
  for (const body of [
    { id: 'a', next: null },
    { id: 'a', next: [] },
    { id: 'a', nullableNext: 'wrong' },
  ])
    await assert.rejects(client.api.read({ body }), /object|null is not permitted/);
  assert.equal(sent, before);
});

test('object-valued factories compose through mutually recursive typeless models', async () => {
  const a = { $ref: '#/components/schemas/TreeRoot' };
  const b = { $ref: '#/components/schemas/Child' };
  const f = fixture('mutual-recursive-factories', a, {
    body: a,
    components: {
      TreeRoot: {
        properties: {
          id: { type: 'string' },
          child: { allOf: [{ type: 'object' }, b] },
          maybe: { allOf: [{ type: ['object', 'null'] }, b] },
        },
        required: ['id'],
      },
      Child: {
        properties: {
          label: { type: 'string' },
          parent: { allOf: [{ type: 'object' }, a] },
        },
        required: ['label'],
      },
    },
  });
  const compiled = compile(
    f,
    `
import {Client,makeTreeRoot,makeChild} from './sdk/node/index.js';
const child=makeChild({label:'b',parent:makeTreeRoot({id:'c'})});
const label:string=child.toJSON().label;
const body=makeTreeRoot({id:'a',child,maybe:makeChild({label:'d'})});
new Client({baseUrl:'https://example.invalid'}).api.read({body});
makeTreeRoot({id:'a',child:makeChild(child),maybe:null});
makeTreeRoot(null);makeChild('root');makeChild([]);
// @ts-expect-error A factory does not waive required fields.
makeChild({});
// @ts-expect-error A factory does not waive field types.
makeChild({label:123});
// @ts-expect-error A possibly nonobject model cannot enter an object-only field.
makeTreeRoot({id:'a',child:makeChild(null)});
// @ts-expect-error An array model cannot enter an object-only field.
makeTreeRoot({id:'a',child:makeChild([])});
const broad=makeChild(null);
// @ts-expect-error Nonobject factory inputs retain the broad result type.
broad.toJSON().label;
`,
  );
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
  const { Client, makeTreeRoot, makeChild } = await sdk(f);
  let sent = 0;
  const client = new Client({
    baseUrl: 'https://example.invalid',
    transport: async (_, init) => {
      sent++;
      return new Response(init.body);
    },
  });
  const body = makeTreeRoot({
    id: 'a',
    child: makeChild({ label: 'b', parent: makeTreeRoot({ id: 'c' }) }),
    maybe: makeChild({ label: 'd' }),
  });
  const { data } = await client.api.read({ body });
  assert.equal(
    JSON.stringify(data),
    JSON.stringify({ id: 'a', child: { label: 'b', parent: { id: 'c' } }, maybe: { label: 'd' } }),
  );
  const before = sent;
  for (const child of [makeChild(null), makeChild([])])
    await assert.rejects(
      client.api.read({ body: { id: 'a', child } }),
      /object|null is not permitted/,
    );
  assert.equal(sent, before);
});
