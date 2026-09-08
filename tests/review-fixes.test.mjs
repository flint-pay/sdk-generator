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
import { loadContract, generate, prepareRelease, validate } from '../dist/index.js';
import { compareSchemas } from '../dist/compatibility.js';
import { Runtime } from '../dist/runtime.js';

const run = promisify(execFile);
const root = mkdtempSync(join(tmpdir(), 'sdk-review-fixes-'));
after(() => rmSync(root, { recursive: true, force: true }));
const profile = {
  version: '1.0.0',
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
    if (['Promise', 'unknown'].includes(name)) {
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
