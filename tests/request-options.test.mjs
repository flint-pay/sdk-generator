import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { loadContract, generate, preview, validateFixtures } from '../dist/index.js';
import { compileSdkContract } from '../dist/target-plan.js';
import { compareCompiledContracts } from '../dist/compiled-compatibility.js';
import { assertRuntimePlan } from '../dist/runtime-plan.js';
import { storeCompiledSnapshot, restoreCompiledSnapshot } from '../dist/compiled-record.js';

const responseId = 'req_01KWM6WAHG3N9Q8T2V5XRZ7C4D';
const errorId = 'req_01KWM6WAHG3N9Q8T2V5XRZ7C4E';
const parameter = (name = 'X-Request-Id', option = 'client_request_id') => ({
  in: 'header',
  name,
  required: false,
  schema: { type: 'string' },
  'x-flint-request-option': option,
});

test('historical records retain the shipped PHP option spelling without weakening executable plans', (t) => {
  const { load } = setup(t, 'positional');
  const current = compileSdkContract(load()).plan;
  const historical = structuredClone(current);
  historical.node.errorTypes = { code: 'string', details: 'unknown' };
  delete historical.node.errorSurfaceVersion;
  delete historical.php.errorSurfaceVersion;
  for (const runtime of [historical.runtime, historical.php.runtime])
    for (const operation of runtime.operations)
      for (const field of operation.parameters)
        if (field.source === 'request-option') field.requestOption.php = 'client_request_id';
  const snapshot = {
    plan: historical,
    runtimeIdentity: { node: '0'.repeat(64), php: '1'.repeat(64) },
  };
  const restored = restoreCompiledSnapshot(storeCompiledSnapshot(snapshot));
  assert.deepEqual(restored.plan, historical);
  assert.throws(() => assertRuntimePlan(restored.plan.runtime), /Invalid compiled request option/);
  assert.ok(
    compareCompiledContracts(restored.plan, current).some(
      (finding) =>
        finding.severity === 'breaking' &&
        finding.subject === 'send.requestOptions.client_request_id',
    ),
  );
  for (const mutation of [
    (field) => {
      field.requestOption.php = 'unknown';
    },
    (field) => {
      field.requestOption.node = 'unknown';
    },
    (field) => {
      field.required = true;
    },
    (field) => {
      field.codec.checks.minLength = 0;
    },
  ]) {
    const malformed = structuredClone(historical.runtime);
    const field = malformed.operations
      .flatMap((op) => op.parameters)
      .find((field) => field.source === 'request-option');
    mutation(field);
    assert.throws(() => assertRuntimePlan(malformed, true), /Invalid compiled request option/);
  }
  const missingCurrentFields = structuredClone(snapshot);
  missingCurrentFields.plan.node.errorSurfaceVersion = current.node.errorSurfaceVersion;
  assert.throws(
    () => restoreCompiledSnapshot(storeCompiledSnapshot(missingCurrentFields)),
    /node.errorTypes.type/,
  );
  const malformedLegacyFields = structuredClone(snapshot);
  malformedLegacyFields.plan.node.errorTypes.type = 1;
  assert.throws(
    () => restoreCompiledSnapshot(storeCompiledSnapshot(malformedLegacyFields)),
    /node.errorTypes.type/,
  );
});
function setup(t, style, validation = 'schema') {
  const dir = mkdtempSync(join(tmpdir(), 'sdk-request-option-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const api = {
    openapi: '3.1.0',
    info: { title: 'Request options', version: '1' },
    paths: {
      '/commands': {
        parameters: [parameter()],
        post: {
          operationId: 'send',
          responses: {
            200: {
              description: 'OK',
              content: { 'application/json': { schema: { type: 'object' } } },
            },
          },
        },
      },
      '/alternate': {
        post: {
          operationId: 'alternate',
          parameters: [parameter('X-Correlation-Id')],
          responses: {
            200: {
              description: 'OK',
              content: { 'application/json': { schema: { type: 'object' } } },
            },
          },
        },
      },
    },
  };
  const config = {
    version: '1.0.0',
    npm: { name: '@example/request-options' },
    composer: { name: 'example/request-options', namespace: 'RequestOptionTest' },
    validation,
    requests: { style },
    responses: { return: 'result' },
    errors: { requestIdHeader: 'x-request-id' },
  };
  const load = () => {
    writeFileSync(join(dir, 'api.json'), JSON.stringify(api));
    writeFileSync(join(dir, 'sdk.json'), JSON.stringify(config));
    return loadContract(join(dir, 'api.json'), join(dir, 'sdk.json'));
  };
  return { dir, api, load };
}

for (const style of ['object', 'positional'])
  for (const validation of ['schema', 'encoding']) {
    test(`request options validate and dispatch in both ${style} targets with ${validation} validation`, async (t) => {
      const { dir, load } = setup(t, style, validation);
      const contract = load();
      const plan = compileSdkContract(contract).plan;
      assert.doesNotMatch(plan.node.operations.send.input, /X-Request-Id/);
      if (style === 'positional') assert.equal(plan.requestCalls.send.params, false);
      const output = join(dir, 'out');
      generate(contract, output);
      assert.deepEqual(preview(contract, output).changes, []);
      const fixturePath = join(dir, 'http-cases.json');
      writeFileSync(
        fixturePath,
        JSON.stringify([
          {
            name: 'caller correlation is independent of the response request ID',
            operation: 'send',
            baseUrl: 'https://example.invalid',
            input: {},
            options: { clientRequestId: 'fixture-caller' },
            expected: {
              method: 'POST',
              path: '/commands',
              headers: { 'x-request-id': 'fixture-caller' },
            },
            responses: [
              {
                status: 200,
                headers: { 'content-type': 'application/json', 'x-request-id': responseId },
                body: '{}',
              },
            ],
            data: {},
          },
        ]),
      );
      assert.deepEqual(await validateFixtures(output, fixturePath), [
        { target: 'node', scenarios: 1 },
        { target: 'php', scenarios: 1 },
      ]);
      const declarations = readFileSync(join(output, 'node/index.d.ts'), 'utf8');
      assert.doesNotMatch(declarations, /X-Request-Id|X-Correlation-Id/);
      assert.match(
        readFileSync(join(output, 'php/src/classes/RequestOptions.php'), 'utf8'),
        /\$clientRequestId/,
      );
      const sdk = await import(pathToFileURL(join(output, 'node/index.js')));
      const sent = [];
      let status = 200;
      const client = new sdk.Client({
        baseUrl: 'https://example.invalid',
        transport: async (_url, init) => {
          sent.push(Object.fromEntries(new Headers(init.headers)));
          return new Response('{}', {
            status,
            headers: {
              'content-type': 'application/json',
              'x-request-id': status === 200 ? responseId : errorId,
            },
          });
        },
      });
      const call = (options, method = 'send') =>
        style === 'object' ? client.api[method]({}, options) : client.api[method](options);
      const unset = await call({});
      assert.equal(unset.lastResponse.requestId, responseId);
      const good = [
        '!',
        '~',
        'a'.repeat(128),
        'Order-123:Attempt_2',
        Array.from({ length: 94 }, (_, i) => String.fromCharCode(33 + i)).join(''),
      ];
      for (const value of good) await call({ clientRequestId: value });
      await call({ headers: { 'X-REQUEST-ID': 'header-only' } });
      await call({ headers: { 'X-Request-Id': 'same' }, clientRequestId: 'same' });
      assert.equal(sent[0]['x-request-id'], undefined);
      assert.deepEqual(
        sent.slice(1).map((h) => h['x-request-id']),
        [...good, 'header-only', 'same'],
      );
      const before = sent.length;
      for (const value of [
        '',
        'a'.repeat(129),
        ' ',
        'a b',
        '\t',
        '\r',
        '\n',
        'a\n',
        '\0',
        '\x1f',
        '\x7f',
        'é',
        '😀',
        null,
        42,
        [],
        {},
      ]) {
        await assert.rejects(
          call({ clientRequestId: value }),
          (error) =>
            error instanceof sdk.SdkError &&
            error.name === 'InvalidInputError' &&
            error.outcome === 'not_sent',
        );
      }
      await assert.rejects(call({ headers: { 'x-request-id': 'a b' } }), sdk.SdkError);
      await assert.rejects(
        call({ clientRequestId: 'one', headers: { 'x-request-id': 'two' } }),
        sdk.SdkError,
      );
      if (style === 'object')
        await assert.rejects(client.api.send({ 'X-Request-Id': 'input' }), sdk.SdkError);
      assert.equal(sent.length, before);
      await call({ clientRequestId: 'alternate-name' }, 'alternate');
      assert.equal(sent.at(-1)['x-correlation-id'], 'alternate-name');
      assert.equal(sent.at(-1)['x-request-id'], undefined);
      status = 400;
      await assert.rejects(
        call({ clientRequestId: 'caller-value' }),
        (error) => error.requestId === errorId,
      );
      assert.equal(sent.at(-1)['x-request-id'], 'caller-value');

      writeFileSync(
        join(output, 'node/check.ts'),
        `import {Client, type RequestOptions} from './index.js';
const c = new Client({baseUrl:'https://example.invalid'});
const options = {clientRequestId:'order-123'} satisfies RequestOptions;
c.api.send(${style === 'object' ? '{}, ' : ''}options);
// @ts-expect-error request option values must be strings
c.api.send(${style === 'object' ? '{}, ' : ''}{clientRequestId:42});
`,
      );
      execFileSync(
        process.execPath,
        [
          'node_modules/typescript/bin/tsc',
          '--strict',
          '--noEmit',
          '--skipLibCheck',
          '--module',
          'NodeNext',
          '--moduleResolution',
          'NodeNext',
          '--target',
          'ES2022',
          join(output, 'node/check.ts'),
        ],
        { stdio: 'inherit' },
      );
      const cases = {
        good,
        bad: [
          '',
          'a'.repeat(129),
          ' ',
          'a b',
          '\t',
          '\r',
          '\n',
          'a\n',
          '\0',
          '\x1f',
          '\x7f',
          'é',
          '😀',
        ],
        responseId,
        errorId,
        style,
      };
      execFileSync(
        'php',
        [
          '-r',
          String.raw`
set_error_handler(static function($severity, $message, $file, $line) { throw new \ErrorException($message, 0, $severity, $file, $line); });
require $argv[1].'/src/Runtime.php'; require $argv[1].'/src/Client.php';
$cases=json_decode($argv[2],true,512,JSON_THROW_ON_ERROR); $sent=[]; $status=200;
$c=new \RequestOptionTest\Client(new \RequestOptionTest\ClientOptions(baseUrl:'https://example.invalid',transport:function($r)use(&$sent,&$status,$cases){$sent[]=$r['headers'];return ['status'=>$status,'headers'=>['content-type'=>'application/json','x-request-id'=>$status===200?$cases['responseId']:$cases['errorId']],'body'=>'{}'];}));
$call=fn($o,$method='send')=>$cases['style']==='object'?$c->api->$method([],$o):$c->api->$method($o);
if($call(new \RequestOptionTest\RequestOptions())->lastResponse()->requestId!==$cases['responseId'])throw new \Exception('response ID');
foreach($cases['good'] as $v)$call(new \RequestOptionTest\RequestOptions(clientRequestId:$v));
$call(new \RequestOptionTest\RequestOptions(headers:['X-REQUEST-ID'=>'header-only']));
$call(new \RequestOptionTest\RequestOptions(headers:['X-Request-Id'=>'same'],clientRequestId:'same'));
if(isset($sent[0]['x-request-id'])||array_column(array_slice($sent,1),'x-request-id')!==[...$cases['good'],'header-only','same'])throw new \Exception('wire headers');
$before=count($sent);
foreach($cases['bad'] as $v){try{$call(new \RequestOptionTest\RequestOptions(clientRequestId:$v));throw new \Exception('expected validation');}catch(\RequestOptionTest\SdkError $e){if(substr(strrchr(get_class($e), chr(92)), 1)!=='InvalidInputError'||$e->outcome!=='not_sent')throw $e;}}
foreach([new \RequestOptionTest\RequestOptions(headers:['x-request-id'=>'a b']),new \RequestOptionTest\RequestOptions(headers:['x-request-id'=>'two'],clientRequestId:'one')] as $o){try{$call($o);throw new \Exception('expected validation');}catch(\RequestOptionTest\SdkError $e){}}
if($cases['style']==='object'){try{$c->api->send(['X-Request-Id'=>'input']);throw new \Exception('expected input rejection');}catch(\RequestOptionTest\SdkError $e){}}
if(count($sent)!==$before)throw new \Exception('invalid values dispatched');
$call(new \RequestOptionTest\RequestOptions(clientRequestId:'alternate-name'),'alternate');
if(end($sent)['x-correlation-id']!=='alternate-name'||isset(end($sent)['x-request-id']))throw new \Exception('extension routing');
$o=(new \RequestOptionTest\RequestOptions(clientRequestId:'preserved'))->withDeadline(1000);
if($o->clientRequestId!=='preserved')throw new \Exception('option forwarding');
$status=400;
try{$call(new \RequestOptionTest\RequestOptions(clientRequestId:'caller-value'));throw new \Exception('expected error');}catch(\RequestOptionTest\SdkError $e){if($e->requestId!==$cases['errorId'])throw $e;}
`,
          join(output, 'php'),
          JSON.stringify(cases),
        ],
        { stdio: 'pipe' },
      );
    });
  }

test('unknown or misplaced request-option extensions fail instead of becoming inputs', (t) => {
  const { api, load } = setup(t, 'object');
  api.paths['/commands'].parameters[0]['x-flint-request-option'] = 'unknown_option';
  assert.throws(load, /Unknown x-flint-request-option.*client_request_id/);
  for (const value of [null, 1, '', {}, []]) {
    api.paths['/commands'].parameters[0]['x-flint-request-option'] = value;
    assert.throws(load, /Unknown x-flint-request-option/);
  }
  api.paths['/commands'].parameters[0] = { ...parameter(), in: 'query' };
  assert.throws(load, /requires an optional header/);
  api.paths['/commands'].parameters[0] = { ...parameter(), required: true };
  assert.throws(load, /requires an optional header/);
});

test('compiled compatibility reports additive request options against the shipped input shape', (t) => {
  const { api, load } = setup(t, 'positional');
  const parameters = api.paths['/commands'].parameters;
  api.paths['/commands'].parameters = [];
  const before = compileSdkContract(load()).plan;
  api.paths['/commands'].parameters = parameters;
  const after = compileSdkContract(load()).plan;
  const findings = compareCompiledContracts(before, after);
  assert.deepEqual(
    findings.map((f) => [f.severity, f.subject]),
    [
      ['additive', 'send.requestOptions.client_request_id'],
      ['review', 'compiled codecs'],
    ],
  );
  assert.equal(
    compareCompiledContracts(after, before).some(
      (f) => f.severity === 'breaking' && f.subject === 'send.requestOptions.client_request_id',
    ),
    true,
  );
  assert.deepEqual(compareCompiledContracts(after, structuredClone(after)), []);
  // Historical generators retained unknown extension metadata on ordinary input parameters.
  const historical = structuredClone(after.runtime);
  for (const operation of historical.operations)
    for (const parameter of operation.parameters) {
      delete parameter.source;
      delete parameter.requestOption;
    }
  assert.doesNotThrow(() => assertRuntimePlan(historical, true));
  assert.throws(() => assertRuntimePlan(historical), /Missing compiled request-option source/);
  const malformed = structuredClone(after.runtime);
  malformed.operations[0].parameters[0].requestOption.node = 'unknown';
  assert.throws(() => assertRuntimePlan(malformed), /Invalid compiled request option/);
});
