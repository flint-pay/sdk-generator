import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadContract, generate, validateFixtures } from '../dist/index.js';
import { isKnownCodec } from '../dist/runtime.js';
import { compileCodec } from '../dist/codec-plan.js';
const exec = promisify(execFile);
const root = mkdtempSync(join(tmpdir(), 'sdk-full-regressions-'));
after(() => rmSync(root, { recursive: true, force: true }));
const settings = {
  version: '1.0.0',
  npm: { name: '@example/regressions' },
  composer: { name: 'example/regressions', namespace: 'Example\\Regressions' },
  validation: 'schema',
};
function load(name, document, extra = {}) {
  const dir = mkdtempSync(join(root, name));
  writeFileSync(
    join(dir, 'api.json'),
    JSON.stringify({
      openapi: '3.1.0',
      info: { title: 'Regressions', version: 'v1' },
      ...document,
    }),
  );
  writeFileSync(join(dir, 'sdk.json'), JSON.stringify({ ...settings, ...extra }));
  return { dir, contract: loadContract(join(dir, 'api.json'), join(dir, 'sdk.json')) };
}
async function build(name, document, extra = {}) {
  const result = load(name, document, extra);
  generate(result.contract, join(result.dir, 'out'));
  return {
    ...result,
    sdk: await import(join(result.dir, 'out/node/index.js')),
    op: result.contract.operations[0],
  };
}
const responseDocument = (schema) => ({
  paths: {
    '/value': {
      get: {
        operationId: 'getValue',
        responses: { 200: { description: 'value', content: { 'application/json': { schema } } } },
      },
    },
  },
});
const inputDocument = (schema, schemas) => ({
  ...(schemas ? { components: { schemas } } : {}),
  paths: {
    '/value': {
      post: {
        operationId: 'save',
        requestBody: { required: true, content: { 'application/json': { schema } } },
        responses: { 204: { description: 'ok' } },
      },
    },
  },
});
const phpHeader = (dir) => `<?php
require ${JSON.stringify(join(dir, 'out/php/src/Runtime.php'))};
require ${JSON.stringify(join(dir, 'out/php/src/Client.php'))};
`;

test('shared response codecs retain Node narrowing and PHP variant classes', async () => {
  const union = {
    discriminator: { propertyName: 'kind' },
    oneOf: ['a', 'b'].map((kind) => ({
      type: 'object',
      required: ['kind', 'value'],
      properties: { kind: { type: 'string', enum: [kind] }, value: { type: 'string' } },
    })),
  };
  for (const sharing of [false, true]) {
    const { dir, sdk, op } = await build(
      'sharing-',
      responseDocument(union),
      sharing ? { schemaSharing: 'named' } : {},
    );
    let payload = { kind: 'a', value: 'hello' };
    const client = new sdk.Client({
      baseUrl: 'https://example.invalid',
      transport: async () => new Response(JSON.stringify(payload)),
    });
    const guard = sdk.isApiGetValueResponseKnown;
    const known = await client[op.resource][op.method]();
    assert.equal(guard(known.data), true);
    assert.equal(guard({ kind: 'a' }), false);
    payload = { kind: 'future', value: 'hello' };
    const unknown = await client[op.resource][op.method]();
    assert.equal(unknown.data.kind, 'future');
    assert.equal(guard(unknown.data), false);
    writeFileSync(
      join(dir, 'test.php'),
      phpHeader(dir) +
        `
set_error_handler(function($level,$message){throw new Exception($message);});
$payload='{"kind":"a","value":"hello"}';
$c=new Example\\Regressions\\Client(new Example\\Regressions\\ClientOptions(baseUrl:'https://example.invalid',transport:function($r)use(&$payload){return ['status'=>200,'headers'=>[],'body'=>$payload];}));
$result=$c->${op.resource}->${op.method}();
if(!($result->data instanceof Example\\Regressions\\ApiGetValueResponse200Variant0))throw new Exception('missing variant class');
if($result->data->getValue()!=='hello')throw new Exception('missing typed getter');
$payload='{"kind":"future","value":"hello"}';
if(get_class($c->${op.resource}->${op.method}()->data)!=='stdClass')throw new Exception('unknown variant lost');
echo 'ok';
`,
    );
    assert.equal((await exec('php', [join(dir, 'test.php')])).stdout, 'ok');
  }
  const unionCodec = compileCodec({ oneOf: [{ type: 'string' }, { type: 'boolean' }] });
  const ref = { ...compileCodec({}), reference: 'Union' };
  assert.equal(isKnownCodec(true, { ...ref, definitions: { Union: unionCodec } }), true);
  assert.equal(isKnownCodec(1, { ...ref, definitions: { Union: unionCodec } }), false);
  assert.equal(isKnownCodec(true, ref), false);
  assert.equal(isKnownCodec(true, { ...ref, definitions: { Union: ref } }), false);
});

test('SSE operations enforce both request budgets while buffering JSON errors', async () => {
  let closed = 0;
  const server = createServer((request, response) => {
    if (request.headers['x-test-body'] === 'events') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write('data: first\n\n');
      const timer = setTimeout(() => response.end('data: later\n\n'), 300);
      response.on('close', () => {
        clearTimeout(timer);
        closed++;
      });
      return;
    }
    response.writeHead(503, { 'Content-Type': 'application/json' });
    response.write('{');
    let count = 0;
    const interval = setInterval(() => {
      if (++count === 100) {
        clearInterval(interval);
        response.end('}');
      } else if (request.headers['x-test-body'] !== 'stalled') response.write(' ');
    }, 10);
    response.on('close', () => {
      clearInterval(interval);
      closed++;
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const document = responseDocument({ type: 'object' });
    document.paths['/value'].get.responses = {
      200: {
        description: 'events',
        content: { 'text/event-stream': { schema: { type: 'string' } } },
      },
      503: {
        description: 'error',
        content: { 'application/json': { schema: { type: 'object' } } },
      },
    };
    const { dir, sdk, op } = await build('timeout-', document);
    for (const body of ['trickle', 'stalled']) {
      for (const [kind, options] of [
        ['deadline', { deadlineMs: 100, timeoutMs: 2000 }],
        ['transport', { deadlineMs: 2000, timeoutMs: 100 }],
      ]) {
        const client = new sdk.Client({ baseUrl, allowInsecureHttp: true });
        const start = performance.now();
        await assert.rejects(
          client[op.resource][op.method]({}, { ...options, headers: { 'x-test-body': body } }),
          { kind },
        );
        assert.ok(performance.now() - start < 700, 'Node waited for the error body');
        writeFileSync(
          join(dir, 'test.php'),
          phpHeader(dir) +
            `
$c=new Example\\Regressions\\Client(new Example\\Regressions\\ClientOptions(baseUrl:$argv[1],allowInsecureHttp:true));
$start=microtime(true);
try {$c->${op.resource}->${op.method}(options:new Example\\Regressions\\RequestOptions(deadlineMs:${options.deadlineMs},timeoutMs:${options.timeoutMs},headers:['x-test-body'=>'${body}']));throw new Exception('expected timeout');}
catch(Example\\Regressions\\SdkError $e){if($e->kind!=='${kind}')throw $e;}
if(microtime(true)-$start>=0.7)throw new Exception('PHP waited for the error body');
$c->close();echo 'ok';
`,
        );
        assert.equal((await exec('php', [join(dir, 'test.php'), baseUrl])).stdout, 'ok');
      }
    }
    const client = new sdk.Client({ baseUrl, allowInsecureHttp: true });
    const events = await client[op.resource][op.method](
      {},
      {
        timeoutMs: 100,
        deadlineMs: 100,
        streamIdleTimeoutMs: 1000,
        headers: { 'x-test-body': 'events' },
      },
    );
    assert.deepEqual(
      (await Array.fromAsync(events.data)).map((event) => event.data),
      ['first', 'later'],
    );
    writeFileSync(
      join(dir, 'stream.php'),
      phpHeader(dir) +
        `
$c=new Example\\Regressions\\Client(new Example\\Regressions\\ClientOptions(baseUrl:$argv[1],allowInsecureHttp:true));
$result=$c->${op.resource}->${op.method}(options:new Example\\Regressions\\RequestOptions(timeoutMs:100,deadlineMs:100,streamIdleTimeoutMs:1000,headers:['x-test-body'=>'events']));
$events=[];foreach($result->data as $event)$events[]=$event->data;
if($events!==['first','later'])throw new Exception('stream must outlive request budget');
$c->close();echo 'ok';
`,
    );
    assert.equal((await exec('php', [join(dir, 'stream.php'), baseUrl])).stdout, 'ok');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(closed, 10, 'response connections must be released');
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('mapped variants sharing an allOf ancestor retain exact target and alias identity', async () => {
  const base = { type: 'object', required: ['kind'], properties: { kind: { type: 'string' } } };
  const schemas = {
    Base: base,
    A: { allOf: [{ $ref: '#/components/schemas/Base' }, { properties: { kind: { const: 'a' } } }] },
    B: { allOf: [{ $ref: '#/components/schemas/Base' }, { properties: { kind: { const: 'b' } } }] },
    Alias: { $ref: '#/components/schemas/A' },
  };
  const shape = {
    oneOf: [{ $ref: '#/components/schemas/A' }, { $ref: '#/components/schemas/B' }],
    discriminator: {
      propertyName: 'kind',
      mapping: { a: '#/components/schemas/Alias', b: '#/components/schemas/B' },
    },
  };
  const cases = ['a', 'b'].map((kind) => ({
    name: kind,
    operation: 'save',
    input: { body: { kind } },
    expected: { method: 'POST', path: '/v1/value', body: JSON.stringify({ kind }) },
    responses: [{ status: 204 }],
    empty: true,
  }));
  for (const body of [{ kind: 'c' }, {}])
    cases.push({
      name: JSON.stringify(body),
      operation: 'save',
      input: { body },
      responses: [],
      attempts: 0,
      error: { kind: 'validation' },
    });
  const siblingSchemas = structuredClone(schemas);
  for (const name of ['A', 'B']) siblingSchemas[name] = Object.assign({}, ...schemas[name].allOf);
  for (const components of [schemas, siblingSchemas]) {
    const { dir, contract } = load('mapping-', inputDocument(shape, components), {
      operations: { save: { example: { body: { kind: 'a' } } } },
    });
    generate(contract, join(dir, 'out'));
    writeFileSync(join(dir, 'cases.json'), JSON.stringify(cases));
    assert.deepEqual(
      (await validateFixtures(join(dir, 'out'), join(dir, 'cases.json'))).map((r) => r.scenarios),
      [4, 4],
    );
  }
  shape.discriminator.mapping.a = '#/components/schemas/B';
  assert.throws(() => load('conflict-', inputDocument(shape, schemas)), /mapping\/a.*conflicts/);
  shape.discriminator.mapping.a = '#/components/schemas/Base';
  assert.throws(() => load('ambiguous-', inputDocument(shape, schemas)), /mapping\/a.*exactly one/);
});

test('explicit numeric constants accept typed consumers and preserve numeric wire tokens', async () => {
  const choice = { oneOf: [{ type: 'string' }, { type: 'number', const: 0.25 }] };
  const schema = {
    type: 'object',
    required: ['scalar', 'items'],
    properties: { scalar: choice, items: { type: 'array', items: choice } },
  };
  const { dir, sdk, op } = await build('constant-', inputDocument(schema), {
    numericUnions: 'explicit',
  });
  const bodies = [];
  const client = new sdk.Client({
    baseUrl: 'https://example.invalid',
    transport: async (_url, request) => {
      bodies.push(request.body);
      return new Response(null, { status: 204 });
    },
  });
  await client[op.resource][op.method]({
    body: { scalar: new sdk.ExactNumber('0.25'), items: [new sdk.ExactNumber('0.250'), '0.25'] },
  });
  assert.deepEqual(bodies, ['{"scalar":0.25,"items":[0.250,"0.25"]}']);
  await assert.rejects(
    client[op.resource][op.method]({ body: { scalar: new sdk.ExactNumber('0.5'), items: [] } }),
    { kind: 'validation' },
  );
  writeFileSync(
    join(dir, 'consumer.ts'),
    `import {Client,ExactNumber} from './out/node/index.js';
const c=new Client({baseUrl:'https://example.invalid'});
c.${op.resource}.${op.method}({body:{scalar:new ExactNumber('0.25'),items:[new ExactNumber('0.250'),'0.25']}});
`,
  );
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
    join(dir, 'consumer.ts'),
  ]);
  writeFileSync(
    join(dir, 'test.php'),
    phpHeader(dir) +
      `
$c=new Example\\Regressions\\Client(new Example\\Regressions\\ClientOptions(baseUrl:'https://example.invalid',transport:function($r){if($r['body']!=='{"scalar":0.25,"items":[0.250,"0.25"]}')throw new Exception('wrong wire tokens');return ['status'=>204,'headers'=>[],'body'=>''];}));
$c->api->save(new Example\\Regressions\\ApiSaveInput(['body'=>['scalar'=>new Example\\Regressions\\ExactNumber('0.25'),'items'=>[new Example\\Regressions\\ExactNumber('0.250'),'0.25']]]));echo 'ok';
`,
  );
  assert.equal((await exec('php', [join(dir, 'test.php')])).stdout, 'ok');
});

test('shared object alternatives retain response shape checks and future objects', async () => {
  for (const keyword of ['oneOf', 'anyOf']) {
    const schema = {
      [keyword]: ['a', 'b'].map((name) => ({
        type: 'object',
        required: [name],
        properties: {
          [name]: { type: 'string' },
          extra: { type: 'string' },
          third: { type: 'string' },
        },
      })),
    };
    for (const sharing of [false, true]) {
      const { dir } = await build(
        'object-alternatives-',
        responseDocument(schema),
        sharing ? { schemaSharing: 'named' } : {},
      );
      const cases = ['{"a":"known"}', '{"future":true}', '"scalar"', '[]', 'null'].map((body) => ({
        name: body,
        operation: 'getValue',
        input: {},
        expected: { method: 'GET', path: '/v1/value' },
        responses: [{ status: 200, body }],
        ...(body.startsWith('{') ? { data: JSON.parse(body) } : { error: { kind: 'protocol' } }),
      }));
      writeFileSync(join(dir, 'cases.json'), JSON.stringify(cases));
      assert.deepEqual(
        (await validateFixtures(join(dir, 'out'), join(dir, 'cases.json'))).map((r) => r.scenarios),
        [5, 5],
      );
    }
  }
});

test('conditional direction policy preserves readOnly and writeOnly requiredness', async () => {
  const schema = {
    type: 'object',
    properties: {
      active: { type: 'boolean' },
      id: { type: 'string', readOnly: true },
      secret: { type: 'string', writeOnly: true },
      label: { type: 'string' },
    },
    if: { required: ['active'], properties: { active: { const: true } } },
    then: { required: ['id', 'secret', 'label'] },
    else: { if: {}, then: { required: ['id', 'secret'] } },
  };
  const document = inputDocument(schema);
  document.paths['/value'].post.responses = responseDocument(schema).paths['/value'].get.responses;
  const { dir, sdk } = await build('conditional-direction-', document, {
    operations: { save: { example: { body: { active: false, secret: 'private' } } } },
  });
  const cases = [false, true].flatMap((active) => {
    const body = { active, secret: 'private', ...(active ? { label: 'present' } : {}) };
    const data = { active, id: 'server-id', ...(active ? { label: 'present' } : {}) };
    const accepted = {
      name: `condition ${active}`,
      operation: 'save',
      input: { body },
      expected: { method: 'POST', path: '/v1/value', body: JSON.stringify(body) },
      responses: [{ status: 200, body: JSON.stringify(data) }],
      data,
    };
    const { secret, ...withoutSecret } = body;
    const { id, ...withoutId } = data;
    return [
      accepted,
      {
        name: `readonly ${active}`,
        operation: 'save',
        input: { body: { ...body, id: 'forbidden' } },
        responses: [],
        error: { kind: 'validation' },
        attempts: 0,
      },
      {
        name: `missing secret ${active}`,
        operation: 'save',
        input: { body: withoutSecret },
        responses: [],
        error: { kind: 'validation' },
        attempts: 0,
      },
      {
        ...accepted,
        name: `missing response id ${active}`,
        responses: [{ status: 200, body: JSON.stringify(withoutId) }],
        data: undefined,
        error: { kind: 'protocol' },
      },
    ];
  });
  cases.push({
    name: 'missing conditional label',
    operation: 'save',
    input: { body: { active: true, secret: 'private' } },
    responses: [],
    error: { kind: 'validation' },
    attempts: 0,
  });
  writeFileSync(join(dir, 'cases.json'), JSON.stringify(cases));
  assert.deepEqual(
    (await validateFixtures(join(dir, 'out'), join(dir, 'cases.json'))).map((r) => r.scenarios),
    [9, 9],
  );
  // Public dynamic adapters must preserve the same directional policy.
  assert.equal(
    sdk.serialize({ active: false, secret: 'private' }, schema),
    '{"active":false,"secret":"private"}',
  );
  assert.throws(
    () => sdk.serialize({ active: true, secret: 'private' }, schema),
    /label.*required/,
  );
  writeFileSync(
    join(dir, 'dynamic.php'),
    phpHeader(dir) +
      `
$schema=json_decode('${JSON.stringify(schema)}',true);
$value=Example\\Regressions\\Codec::normalize((object)['active'=>false,'secret'=>'private'],$schema);
if(Example\\Regressions\\Codec::encode($value)!=='{"active":false,"secret":"private"}')throw new Exception('dynamic request');
$value=Example\\Regressions\\Codec::normalize((object)['active'=>false,'id'=>'server-id'],$schema,response:true);
if(Example\\Regressions\\Codec::encode($value)!=='{"active":false,"id":"server-id"}')throw new Exception('dynamic response');
echo 'ok';`,
  );
  assert.equal((await exec('php', [join(dir, 'dynamic.php')])).stdout, 'ok');
});

test('parent constants retain numeric representations through composed children', async () => {
  const choice = { oneOf: [{ type: 'string' }, { type: 'number' }] };
  const schema = {
    type: 'object',
    const: { scalar: 1, items: [1], mapped: { value: 1 }, legacy: 1 },
    required: ['scalar', 'items', 'mapped', 'legacy'],
    properties: {
      scalar: { $ref: '#/components/schemas/Choice' },
      items: { type: 'array', items: choice },
      mapped: { type: 'object', additionalProperties: choice },
      legacy: { allOf: [{ type: 'number' }] },
    },
  };
  for (const sharing of [false, true]) {
    const { dir, sdk, op } = await build(
      'parent-constant-',
      inputDocument(schema, { Choice: choice }),
      {
        numericUnions: 'explicit',
        ...(sharing ? { schemaSharing: 'named' } : {}),
        operations: {
          save: { example: { body: { scalar: 1, items: [1], mapped: { value: 1 }, legacy: '1' } } },
        },
      },
    );
    const bodies = [];
    const client = new sdk.Client({
      baseUrl: 'https://example.invalid',
      transport: async (_url, request) => {
        bodies.push(request.body);
        return new Response(null, { status: 204 });
      },
    });
    const body = {
      scalar: new sdk.ExactNumber('1'),
      items: [new sdk.ExactNumber('1')],
      mapped: { value: new sdk.ExactNumber('1') },
      legacy: '1',
    };
    await client[op.resource][op.method]({ body });
    assert.deepEqual(bodies, ['{"scalar":1,"items":[1],"mapped":{"value":1},"legacy":1}']);
    await assert.rejects(
      client[op.resource][op.method]({ body: { ...body, scalar: new sdk.ExactNumber('2') } }),
      { kind: 'validation' },
    );
    await assert.rejects(client[op.resource][op.method]({ body: { ...body, scalar: '1' } }), {
      kind: 'validation',
    });
    writeFileSync(
      join(dir, 'consumer.ts'),
      `import {Client,ExactNumber} from './out/node/index.js';
new Client({baseUrl:'https://example.invalid'}).api.save({body:{scalar:new ExactNumber('1'),items:[new ExactNumber('1')],mapped:{value:new ExactNumber('1')},legacy:'1'}});`,
    );
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
      join(dir, 'consumer.ts'),
    ]);
    writeFileSync(
      join(dir, 'test.php'),
      phpHeader(dir) +
        `
$calls=[];$c=new Example\\Regressions\\Client(new Example\\Regressions\\ClientOptions(baseUrl:'https://example.invalid',transport:function($r)use(&$calls){$calls[]=$r['body'];return ['status'=>204,'headers'=>[],'body'=>''];}));
$body=['scalar'=>new Example\\Regressions\\ExactNumber('1'),'items'=>[new Example\\Regressions\\ExactNumber('1')],'mapped'=>(object)['value'=>new Example\\Regressions\\ExactNumber('1')],'legacy'=>'1'];
$c->api->save(new Example\\Regressions\\ApiSaveInput(['body'=>$body]));
foreach([new Example\\Regressions\\ExactNumber('2'),'1'] as $invalid){$body['scalar']=$invalid;try{$c->api->save(new Example\\Regressions\\ApiSaveInput(['body'=>$body]));throw new Exception('invalid constant accepted');}catch(Example\\Regressions\\SdkError $e){if($e->kind!=='validation')throw $e;}}
echo json_encode($calls);`,
    );
    assert.deepEqual(JSON.parse((await exec('php', [join(dir, 'test.php')])).stdout), bodies);
  }
});

test('SSE event routing preserves unknown prototype names and configured zero names', async () => {
  const document = responseDocument({});
  document.paths['/value'].get.responses[200].content = {
    'text/event-stream': { schema: { type: 'string' } },
  };
  document.components = {
    schemas: {
      Ready: { type: 'object', required: ['value'], properties: { value: { type: 'string' } } },
    },
  };
  const { dir, sdk } = await build('event-names-', document, {
    operations: {
      getValue: {
        stream: {
          events: { ready: '#/components/schemas/Ready', 0: '#/components/schemas/Ready' },
        },
      },
    },
  });
  const frames = [
    ...['future', 'constructor', 'toString', '__proto__'].map((event) => ({
      event,
      data: 'raw payload',
    })),
    { event: '0', data: { value: 'zero' } },
    { event: 'ready', data: { value: 'known' } },
    { event: '', data: 'default event' },
  ];
  const payload = frames
    .map(
      ({ event, data }) =>
        `event: ${event}\ndata: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`,
    )
    .join('');
  const expected = frames.map(({ event, data }) => ({ event: event || 'message', data }));
  const client = new sdk.Client({
    baseUrl: 'https://example.invalid',
    transport: async () =>
      new Response(payload, { headers: { 'content-type': 'text/event-stream' } }),
  });
  const result = await client.api.getValue();
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        (await Array.fromAsync(result.data)).map(({ event, data }) => ({ event, data })),
      ),
    ),
    expected,
  );
  writeFileSync(
    join(dir, 'test.php'),
    phpHeader(dir) +
      `
$c=new Example\\Regressions\\Client(new Example\\Regressions\\ClientOptions(baseUrl:'https://example.invalid',transport:function($r){
$s=new class implements Example\\Regressions\\ByteStream {private bool $done=false;public function read():?string{if($this->done)return null;$this->done=true;return base64_decode('${Buffer.from(payload).toString('base64')}');}public function close():void{}};
return ['status'=>200,'headers'=>['content-type'=>'text/event-stream'],'stream'=>$s];}));
$frames=[];foreach($c->api->getValue()->data as $event)$frames[]=['event'=>$event->event,'data'=>$event->data];echo json_encode($frames);`,
  );
  assert.deepEqual(JSON.parse((await exec('php', [join(dir, 'test.php')])).stdout), expected);
});
