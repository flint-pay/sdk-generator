import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { inspect } from 'node:util';
import { generate, loadContract } from '../dist/index.js';
import { compileRuntimePlan, assertRuntimePlan } from '../dist/runtime-plan.js';

const payment = {
  type: 'object',
  required: ['id'],
  properties: {
    id: { type: 'string' },
    amount: { type: 'integer', format: 'int64' },
    secret: { type: 'string', 'x-sensitive': true },
  },
};
const json = (schema) => ({
  description: 'Synthetic response',
  content: { 'application/json': { schema } },
});
const envelope = { type: 'object', required: ['payment'], properties: { payment } };
const variants = {
  discriminator: { propertyName: 'kind' },
  oneOf: ['card', 'bank'].map((kind) => ({
    ...payment,
    required: ['id', 'kind'],
    properties: { ...payment.properties, kind: { type: 'string', enum: [kind] } },
  })),
};
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'sdk-response-drift-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const responses = {
    create: { 201: json(payment) },
    incomplete: {
      201: json({
        ...payment,
        required: ['id', 'status'],
        properties: { ...payment.properties, status: { type: 'string' } },
      }),
    },
    nested: { 201: json(envelope) },
    arrayPayments: { 201: json({ type: 'array', items: payment }) },
    ambiguous: { 201: json(payment), 202: json(payment) },
    exact: { 200: json(envelope), 201: json(payment) },
    fallbackDefault: { 201: json(payment), default: json(envelope) },
    noContent: { 204: { description: 'Empty' } },
    binary: { 201: { description: 'PDF', content: { 'application/pdf': {} } } },
    stream: { 201: { description: 'Events', content: { 'text/event-stream': {} } } },
    payload: { 201: json(envelope) },
    tagged: { 201: json(variants) },
    withEmpty: { 201: json(payment), 204: { description: 'Empty' } },
  };
  writeFileSync(
    join(dir, 'api.json'),
    JSON.stringify({
      openapi: '3.1.0',
      info: { title: 'Response drift', version: '1' },
      paths: Object.fromEntries(
        Object.entries(responses).map(([id, responses]) => [
          '/' + id,
          { post: { operationId: id, responses } },
        ]),
      ),
    }),
  );
  writeFileSync(
    join(dir, 'sdk.json'),
    JSON.stringify({
      version: '1.0.0',
      responses: { return: 'result' },
      requests: { style: 'object' },
      npm: { name: '@example/response-drift' },
      composer: { name: 'example/response-drift', namespace: 'Example\\Drift' },
      operations: Object.fromEntries(
        Object.keys(responses).map((id) => [
          id,
          {
            resource: 'api',
            method: id,
            idempotency: {
              header: 'Idempotency-Key',
              retention: '24 hours (synthetic)',
              scope: 'operation',
              auto: true,
            },
            retry: { maxAttempts: 3, statuses: [503], transport: true, baseDelayMs: 1 },
            ...(id === 'payload'
              ? { response: { return: 'payload', payloadPath: 'payment' } }
              : {}),
          },
        ]),
      ),
    }),
  );
  const contract = loadContract(join(dir, 'api.json'), join(dir, 'sdk.json'));
  const out = join(dir, 'out');
  generate(contract, out);
  return { dir, out, contract };
}
const valid = '{"id":"pay_synthetic","amount":9007199254740993,"secret":"synthetic-private-value"}';
const decoded = {
  id: 'pay_synthetic',
  amount: '9007199254740993',
  secret: 'synthetic-private-value',
};
const schemaMessage = 'Response cannot be represented by the declared schema';
const cases = [
  { op: 'create', raw: valid, data: decoded, model: 'ApiCreateResponse201' },
  { op: 'withEmpty', raw: valid, data: decoded, model: 'ApiWithEmptyResponse201' },
  {
    op: 'incomplete',
    raw: valid,
    message: schemaMessage + ': response.status: required field is missing',
    cause: true,
  },
  {
    op: 'create',
    raw: '{"secret":"synthetic-private-value"}',
    message: schemaMessage + ': response.id: required field is missing',
    cause: true,
  },
  {
    op: 'nested',
    raw: '{"payment":{"secret":"synthetic-private-value"}}',
    message: schemaMessage + ': response.payment.id: required field is missing',
    cause: true,
  },
  {
    op: 'arrayPayments',
    raw: '[{"secret":"synthetic-private-value"}]',
    message: schemaMessage + ': response[0].id: required field is missing',
    cause: true,
  },
  { op: 'create', raw: '', message: schemaMessage, cause: true },
  {
    op: 'create',
    raw: '{"id":42}',
    message: schemaMessage + ': response.id: expected a string',
    cause: true,
  },
  {
    op: 'create',
    raw: '{"secret":"synthetic-private-value",',
    message: 'Invalid JSON success response',
    cause: true,
  },
  { op: 'ambiguous', raw: valid, message: 'Undeclared success status', cause: false },
  {
    op: 'exact',
    raw: valid,
    message: schemaMessage + ': response.payment: required field is missing',
    cause: true,
  },
  {
    op: 'fallbackDefault',
    raw: valid,
    message: schemaMessage + ': response.payment: required field is missing',
    cause: true,
  },
  {
    op: 'exact',
    raw: '{"payment":{"id":"pay_exact"}}',
    data: { payment: { id: 'pay_exact' } },
    model: 'ApiExactResponse200',
  },
  {
    op: 'fallbackDefault',
    raw: '{"payment":{"id":"pay_default"}}',
    data: { payment: { id: 'pay_default' } },
    model: 'ApiFallbackDefaultResponseDefault',
  },
  ...['noContent', 'binary', 'stream'].map((op) => ({
    op,
    raw: valid,
    message: 'Undeclared success status',
    cause: false,
  })),
  { op: 'create', status: 304, raw: '', message: 'Undeclared success status', cause: false },
  { op: 'create', status: 204, raw: '', message: schemaMessage, cause: true },
  {
    op: 'payload',
    raw: '{"payment":{"id":"pay_payload"}}',
    data: { id: 'pay_payload' },
    payload: true,
  },
  {
    op: 'payloadWithResponse',
    raw: '{"payment":{"id":"pay_payload"}}',
    data: { payment: { id: 'pay_payload' } },
    withResponse: true,
    model: 'ApiPayloadResponse201',
  },
  {
    op: 'payload',
    raw: '{"payment":{}}',
    message: schemaMessage + ': response.payment.id: required field is missing',
    cause: true,
  },
  {
    op: 'tagged',
    raw: '{"id":"pay_tagged","kind":"card"}',
    data: { id: 'pay_tagged', kind: 'card' },
    model: 'ApiTaggedResponse201Variant0',
  },
];

test('generated Node and PHP preserve typed successes and actionable recovery on response drift', async (t) => {
  const f = fixture(t);
  const { Client, SdkError } = await import(pathToFileURL(join(f.out, 'node/index.js')));
  for (const c of cases) {
    let calls = 0;
    const diagnostics = [];
    const client = new Client({
      baseUrl: 'https://example.invalid',
      diagnostics: (event) => diagnostics.push(event),
      transport: async () => {
        calls++;
        return new Response([204, 304].includes(c.status) ? null : c.raw, {
          status: c.status ?? 200,
          headers: { 'content-type': 'application/json', 'x-request-id': 'req_synthetic' },
        });
      },
    });
    try {
      if (c.message) {
        await assert.rejects(client.api[c.op](), (error) => {
          assert.ok(error instanceof SdkError);
          assert.equal(error.message, c.message, c.op);
          assert.equal(error.kind, 'protocol');
          assert.equal(error.outcome, 'response');
          assert.equal(error.retryAllowed, false);
          assert.equal(error.status, c.status ?? 200);
          assert.equal(error.meta.requestId, 'req_synthetic');
          assert.equal(error.raw, c.raw);
          assert.equal(Boolean(error.cause), c.cause);
          assert.ok(!inspect(error).includes('synthetic-private-value'));
          return true;
        });
      } else {
        const result = await client.api[c.op]();
        assert.deepEqual(
          JSON.parse(
            JSON.stringify(c.payload ? result : c.withResponse ? result.body : result.data),
          ),
          c.data,
          c.op,
        );
        if (!c.payload) {
          assert.equal(result.meta.status, 200);
          assert.equal(result.raw, c.raw);
        }
      }
      assert.equal(calls, 1, c.op);
      assert.equal(diagnostics.length, 1);
      assert.equal(diagnostics[0].errorKind, c.message ? 'protocol' : undefined);
      assert.ok(!JSON.stringify(diagnostics).includes('synthetic-private-value'));
    } finally {
      client.close();
    }
  }
  writeFileSync(join(f.dir, 'cases.json'), JSON.stringify(cases));
  const output = execFileSync(
    'php',
    [
      '-r',
      String.raw`
require $argv[1].'/php/src/Runtime.php'; require $argv[1].'/php/src/Client.php';
use Example\Drift\{Client,ClientOptions,SdkError};
$results=[];
foreach(json_decode(file_get_contents($argv[2]),true) as $case){
    $calls=0;$events=[];
    $client=new Client(new ClientOptions(baseUrl:'https://example.invalid',
        diagnostics:function($event)use(&$events){$events[]=$event;},
        transport:function($request)use(&$calls,$case){$calls++;return [
            'status'=>$case['status']??200,'headers'=>['content-type'=>'application/json','x-request-id'=>'req_synthetic'], 'body'=>$case['raw']];}));
    try{
        $result=$client->api->{$case['op']}();
        $data=($case['payload']??false)?$result:(($case['withResponse']??false)?$result->body:$result->data);
        $row=['data'=>$data];
        if(!($case['payload']??false)){
            $row+=['status'=>$result->meta['status'],'raw'=>$result->raw,'model'=>(new ReflectionClass($data))->getShortName()];
        }
    }catch(SdkError $error){
        ob_start();var_dump($error);$debug=ob_get_clean();
        $row=['message'=>$error->getMessage(),'kind'=>$error->kind,'outcome'=>$error->outcome,
            'retryAllowed'=>$error->retryAllowed,'status'=>$error->status,'raw'=>$error->raw,
            'cause'=>$error->getPrevious()!==null,'requestId'=>$error->meta['requestId'],
            'leaked'=>str_contains($debug,'synthetic-private-value')];
    }finally{$client->close();}
    $row+=['calls'=>$calls,'events'=>$events];$results[]=$row;
}
echo json_encode($results,JSON_THROW_ON_ERROR);
`,
      f.out,
      join(f.dir, 'cases.json'),
    ],
    { encoding: 'utf8' },
  );
  const rows = JSON.parse(output);
  assert.equal(rows.length, cases.length);
  for (const [i, row] of rows.entries()) {
    const c = cases[i];
    assert.equal(row.calls, 1, c.op);
    assert.equal(row.events.length, 1);
    assert.equal(row.events[0].errorKind, c.message ? 'protocol' : undefined);
    assert.ok(!JSON.stringify(row.events).includes('synthetic-private-value'));
    if (c.message) {
      assert.deepEqual(
        { ...row, events: undefined },
        {
          message: c.message,
          kind: 'protocol',
          outcome: 'response',
          retryAllowed: false,
          status: c.status ?? 200,
          raw: c.raw,
          cause: c.cause,
          requestId: 'req_synthetic',
          leaked: false,
          calls: 1,
          events: undefined,
        },
        c.op,
      );
    } else {
      assert.deepEqual(row.data, c.data, c.op);
      if (!c.payload) {
        assert.equal(row.status, 200);
        assert.equal(row.raw, c.raw);
        assert.equal(row.model, c.model);
      }
    }
  }
});

test('payload extraction retains raw response in both adapters', async (t) => {
  const f = fixture(t);
  const { responsePayload } = await import(pathToFileURL(join(f.out, 'node/response.js')));
  const raw = '{"id":"pay_recover"}';
  const meta = { status: 200, headers: {}, attempts: 1, durationMs: 0 };
  assert.throws(
    () => responsePayload({ data: { id: 'pay_recover' }, meta, raw }, ['payment']),
    (e) =>
      e.raw === raw &&
      e.meta === meta &&
      e.kind === 'protocol' &&
      e.outcome === 'response' &&
      !e.retryAllowed,
  );
  const output = execFileSync(
    'php',
    [
      '-r',
      String.raw`
require $argv[1].'/php/src/Runtime.php';require $argv[1].'/php/src/SdkResponse.php';
use Example\Drift\{SdkResponse,Result,SdkError};
try{SdkResponse::payload(new Result((object)['id'=>'pay_recover'],['status'=>200],$argv[2]),['payment']);}
catch(SdkError $e){echo json_encode([$e->raw,$e->status,$e->kind,$e->outcome,$e->retryAllowed]);}
`,
      f.out,
      raw,
    ],
    { encoding: 'utf8' },
  );
  assert.deepEqual(JSON.parse(output), [raw, 200, 'protocol', 'response', false]);
});

test('compiled fallback is deterministic and malformed routing descriptors are rejected in both targets', (t) => {
  const f = fixture(t);
  const before = JSON.stringify(f.contract);
  const plan = compileRuntimePlan(f.contract);
  assert.deepEqual(compileRuntimePlan(f.contract), plan);
  assert.equal(JSON.stringify(f.contract), before);
  assert.equal(plan.operations.find((o) => o.id === 'create').successJsonFallback, '201');
  assert.equal(plan.operations.find((o) => o.id === 'ambiguous').successJsonFallback, undefined);
  const malformed = ['202', 'default', 201].map((fallback) => {
    const invalid = structuredClone(plan);
    invalid.operations.find((o) => o.id === 'create').successJsonFallback = fallback;
    return invalid;
  });
  const ambiguous = structuredClone(plan);
  ambiguous.operations.find((o) => o.id === 'ambiguous').successJsonFallback = '201';
  malformed.push(ambiguous);
  const trailingNewline = structuredClone(plan);
  const op = trailingNewline.operations.find((o) => o.id === 'create');
  op.responses['201\n'] = op.responses['201'];
  delete op.responses['201'];
  op.successJsonFallback = '201\n';
  malformed.push(trailingNewline);
  for (const invalid of malformed) {
    assert.throws(() => assertRuntimePlan(invalid), /Invalid JSON success fallback/);
    const descriptor = join(f.dir, 'invalid.json');
    writeFileSync(descriptor, JSON.stringify(invalid));
    const output = execFileSync(
      'php',
      [
        '-r',
        String.raw`
require $argv[1].'/php/src/Runtime.php';
try{new Example\Drift\Runtime(json_decode(file_get_contents($argv[2]),true),new Example\Drift\ClientOptions('https://example.invalid'),true);echo 'accepted';}
catch(InvalidArgumentException $e){echo $e->getMessage();}
`,
        f.out,
        descriptor,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(output, 'Invalid JSON success fallback');
  }
});

test('PHP model-construction failures retain recovery data without promoting arbitrary exception messages', (t) => {
  const f = fixture(t);
  const output = execFileSync(
    'php',
    [
      '-r',
      String.raw`
namespace Example\Drift;
require $argv[1].'/php/src/Runtime.php';
class ExplodingResponse {
    public function __construct(array $data, array $redactFields) {
        throw new SdkError('validation', 'synthetic-private-constructor-message');
    }
}
$plan=json_decode(file_get_contents($argv[1].'/php/src/contract.json'),true);
foreach($plan['operations'] as &$op)if($op['id']==='create')$op['responses']['201']['model']='ExplodingResponse';
unset($op);
$calls=0;$events=[];
$runtime=new Runtime($plan,new ClientOptions('https://example.invalid',
    diagnostics:function($event)use(&$events){$events[]=$event;},
    transport:function($request)use(&$calls){$calls++;return ['status'=>200,'headers'=>[],'body'=>'{"id":"pay_recover"}'];}),true);
try{$runtime->request('create');}
catch(SdkError $e){
    ob_start();var_dump($e);$debug=ob_get_clean();
    echo json_encode([$e->getMessage(),$e->kind,$e->outcome,$e->retryAllowed,$e->status,$e->raw,
        $e->getPrevious()->getMessage(),$calls,$events[0]['errorKind'],str_contains($debug,'synthetic-private-constructor-message')]);
}finally{$runtime->close();}
`,
      f.out,
    ],
    { encoding: 'utf8' },
  );
  assert.deepEqual(JSON.parse(output), [
    schemaMessage,
    'protocol',
    'response',
    false,
    200,
    '{"id":"pay_recover"}',
    'synthetic-private-constructor-message',
    1,
    'protocol',
    false,
  ]);
});
