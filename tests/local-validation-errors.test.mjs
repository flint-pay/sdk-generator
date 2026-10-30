import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { loadContract, generate } from '../dist/index.js';

const cases = [
  {
    body: { line_items: [{}] },
    param: 'line_items[0].type',
    code: 'REQUIRED',
    message: 'line_items[0].type is required: one of "variant", "bundle", "custom"',
  },
  {
    body: { line_items: [{ type: 'customm' }] },
    param: 'line_items[0].type',
    code: 'INVALID_VALUE',
    message:
      'line_items[0].type must be one of "variant", "bundle", "custom"; received "customm" (did you mean "custom"?)',
  },
  {
    params: { payment_status: ['piad'] },
    param: 'payment_status',
    code: 'INVALID_VALUE',
    message:
      'payment_status[0] must be one of "pending", "paid"; received "piad" (did you mean "paid"?)',
  },
  {
    body: { line_items: [{ type: 'custom', quantitty: 1 }] },
    param: 'line_items[0].quantitty',
    code: 'UNKNOWN_FIELD',
    message: 'line_items[0].quantitty is not a field of this line item (did you mean "quantity"?)',
  },
  {
    body: { metadata: { 'a.b': 42 } },
    param: 'metadata["a.b"]',
    code: 'INVALID_VALUE',
    message: 'metadata["a.b"] must be a string; received a number',
  },
  {
    body: { metadata: { plain_key: 42 } },
    param: 'metadata.plain_key',
    code: 'INVALID_VALUE',
    message: 'metadata.plain_key must be a string; received a number',
  },
  {
    body: { secret: 'customer-private-value' },
    param: 'secret',
    code: 'INVALID_VALUE',
    message: 'secret must be one of "pending", "paid"; received a value',
  },
  {
    body: { password: 'customer-private-value' },
    param: 'password',
    code: 'INVALID_VALUE',
    message: 'password must be one of "pending", "paid"; received a value',
  },
  {
    body: { redacted: 'customer-private-value' },
    param: 'redacted',
    code: 'INVALID_VALUE',
    message: 'redacted must be one of "pending", "paid"; received a value',
  },
  {
    body: { profile: {} },
    param: 'profile.email',
    code: 'REQUIRED',
    message: 'profile.email is required',
  },
  {
    body: { profile: { email: 42 } },
    param: 'profile.email',
    code: 'INVALID_VALUE',
    message: 'profile.email must be a string; received a number',
  },
  {
    body: { id: 'customer-private-value' },
    param: 'id',
    code: 'NOT_ALLOWED',
    message: "id can't be sent: it is read-only",
  },
  {
    body: { masked: { type: 'customer-private-value' } },
    param: 'masked.type',
    code: 'INVALID_VALUE',
    message: 'masked.type must be one of "a", "b"; received a value',
  },
];

for (const [field, value, message, param = field, code = 'INVALID_VALUE'] of [
  ['minimum', 0, 'minimum must be at least 1; received a number'],
  ['exclusive', 1, 'exclusive must be greater than 1; received a number'],
  ['multiple', 3, 'multiple must be a multiple of 2; received a number'],
  [
    'short_secret',
    'xy',
    'short_secret must be a string with at least 3 characters; received a string of length 2',
  ],
  ['choice', 'cat', 'choice must be one of "bat", "hat"; received "cat"'],
  ['astral', '😀😀', 'astral must be one of "a"; received "😀😀" (did you mean "a"?)'],
  [
    'secretChoice',
    { password: 'customer-private-value' },
    'secretChoice.password must be one of "a", "b"; received a value',
    'secretChoice.password',
  ],
  [
    'sensitive_parent',
    { state: 'customer-private-value' },
    'sensitive_parent.state must be one of "pending", "paid"; received a value',
    'sensitive_parent.state',
  ],
  [
    'credential',
    {},
    'credential matches none of its 2 shapes; closest is SavedCardCredential: credential.payment_method_id is required',
    'credential.payment_method_id',
  ],
])
  cases.push({ body: { [field]: value }, param, code, message });
for (const key of ['a"b', 'a[b]', 'é', '{expectation}']) {
  const param = `metadata[${JSON.stringify(key)}]`;
  cases.push({
    body: { metadata: { [key]: 42 } },
    param,
    code: 'INVALID_VALUE',
    message: `${param} must be a string; received a number`,
  });
}

test('generated Node and PHP local validation matches server stage 1 without sending requests', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sdk-local-validation-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lineItem = {
    title: 'LineItem',
    discriminator: { propertyName: 'type' },
    oneOf: ['variant', 'bundle', 'custom'].map((type) => ({
      type: 'object',
      required: ['type'],
      additionalProperties: false,
      properties: { type: { type: 'string', const: type }, quantity: { type: 'integer' } },
    })),
  };
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      masked: {
        discriminator: { propertyName: 'type' },
        oneOf: ['a', 'b'].map((type) => ({
          type: 'object',
          required: ['type'],
          properties: { type: { type: 'string', const: type } },
        })),
      },
      line_items: { type: 'array', items: lineItem },
      metadata: { type: 'object', additionalProperties: { type: 'string' } },
      profile: { type: 'object', required: ['email'], properties: { email: { type: 'string' } } },
      secret: { type: 'string', enum: ['pending', 'paid'], 'x-sensitive': true },
      password: { type: 'string', enum: ['pending', 'paid'], writeOnly: true },
      redacted: { type: 'string', enum: ['pending', 'paid'] },
      id: { type: 'string', readOnly: true },
      minimum: { type: 'number', minimum: 1 },
      exclusive: { type: 'number', exclusiveMinimum: 1 },
      multiple: { type: 'number', multipleOf: 2 },
      short_secret: { type: 'string', minLength: 3, 'x-sensitive': true },
      choice: { type: 'string', enum: ['bat', 'hat'] },
      astral: { type: 'string', enum: ['a'] },
      secretChoice: {
        discriminator: { propertyName: 'password' },
        oneOf: ['a', 'b'].map((password) => ({
          type: 'object',
          required: ['password'],
          properties: { password: { type: 'string', const: password } },
        })),
      },
      sensitive_parent: {
        type: 'object',
        'x-sensitive': true,
        properties: { state: { type: 'string', enum: ['pending', 'paid'] } },
      },
      credential: {
        oneOf: [
          {
            title: 'SavedCardCredential',
            type: 'object',
            required: ['payment_method_id'],
            properties: { payment_method_id: { type: 'string' } },
          },
          { title: 'TokenCredential', type: 'string' },
        ],
      },
    },
  };
  writeFileSync(
    join(dir, 'api.json'),
    JSON.stringify({
      openapi: '3.1.0',
      info: { title: 'Local validation', version: '1' },
      paths: {
        '/orders': {
          post: {
            operationId: 'createOrder',
            parameters: [
              {
                in: 'query',
                name: 'payment_status',
                schema: {
                  type: 'array',
                  items: { type: 'string', enum: ['pending', 'paid'] },
                },
              },
            ],
            requestBody: { content: { 'application/json': { schema } } },
            responses: { 204: { description: 'No content' } },
          },
        },
      },
    }),
  );
  writeFileSync(
    join(dir, 'sdk.json'),
    JSON.stringify({
      version: '1.0.0',
      responses: { return: 'result' },
      npm: { name: '@example/local-validation' },
      composer: { name: 'example/local-validation', namespace: 'LocalValidation' },
      requests: { style: 'object' },
      validation: 'schema',
    }),
  );
  const output = join(dir, 'sdk');
  generate(loadContract(join(dir, 'api.json'), join(dir, 'sdk.json')), output);
  const { Client, errors } = await import(pathToFileURL(join(output, 'node/index.js')));
  let sent = 0;
  const client = new Client({
    baseUrl: 'https://example.invalid',
    redactFields: ['redacted', 'masked'],
    transport: async () => {
      sent++;
      return new Response(null, { status: 204 });
    },
  });
  const expected = cases.map(({ code, param, message }) => ({
    class: 'InvalidInputError',
    code: 'INVALID_REQUEST',
    param,
    message,
    outcome: 'not_sent',
    details: [{ code, param }],
  }));
  for (const [i, row] of cases.entries()) {
    await assert.rejects(
      client.api.createOrder({ ...(row.body ? { body: row.body } : {}), ...(row.params ?? {}) }),
      (error) => {
        assert.ok(error instanceof errors.InvalidInputError);
        assert.deepEqual(
          {
            class: error.name,
            code: error.code,
            param: error.param,
            message: error.message,
            outcome: error.outcome,
            details: error.details.map(({ code, param }) => ({ code, param })),
          },
          expected[i],
        );
        assert.ok(!error.message.includes('customer-private-value'));
        return true;
      },
    );
  }
  assert.equal(sent, 0);
  const php = execFileSync(
    'php',
    [
      '-r',
      String.raw`
require $argv[1].'/src/Runtime.php'; require $argv[1].'/src/Client.php';
$sent=0; $rows=[];
$c=new \LocalValidation\Client(new \LocalValidation\ClientOptions(baseUrl:'https://example.invalid',redactFields:['redacted','masked'],transport:function($r)use(&$sent){$sent++;return ['status'=>204,'headers'=>[],'body'=>''];}));
foreach(json_decode(stream_get_contents(STDIN),false,512,JSON_THROW_ON_ERROR) as $case){
  $input=(array)($case->params??[]);if(property_exists($case,'body'))$input['body']=$case->body;
  try{$c->api->createOrder($input);$rows[]=['unexpected'=>'success'];}
  catch(\LocalValidation\Errors\InvalidInputError $e){$rows[]=['class'=>'InvalidInputError','code'=>$e->code,'param'=>$e->param,'message'=>$e->getMessage(),'outcome'=>$e->outcome,'details'=>array_map(fn($d)=>['code'=>$d['code'],'param'=>$d['param']],$e->details)];}
}
echo json_encode(['rows'=>$rows,'sent'=>$sent],JSON_THROW_ON_ERROR);
`,
      join(output, 'php'),
    ],
    { input: JSON.stringify(cases), encoding: 'utf8' },
  );
  assert.deepEqual(JSON.parse(php), { rows: expected, sent: 0 });
});
