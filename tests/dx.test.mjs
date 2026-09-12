import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { loadContract, generate } from '../dist/index.js';

const dir = mkdtempSync(join(tmpdir(), 'sdk-dx-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const api = JSON.parse(readFileSync('tests/fixtures/payment-api.json'));
const config = JSON.parse(readFileSync('tests/fixtures/payment-sdk.json'));
config.auth = {
  modes: {
    merchant: { schemes: ['BearerAuth'] },
    checkout: { schemes: ['CheckoutKey'], operations: ['getPayment'] },
  },
};
api.components.securitySchemes = {
  BearerAuth: { type: 'http', scheme: 'bearer' },
  CheckoutKey: { type: 'apiKey', in: 'header', name: 'X-Checkout-Key' },
};
api.security = [{ BearerAuth: [] }];
for (const path of Object.values(api.paths))
  for (const operation of Object.values(path)) {
    if (operation?.operationId === 'getPayment')
      operation.security = [{ BearerAuth: [] }, { CheckoutKey: [] }];
  }
api.components.schemas.CreatePayment.properties.amount.description =
  "Amount in the currency's minor unit, such as cents for USD.";
api.components.schemas.CreatePayment.properties.amount.example = 100;
writeFileSync(join(dir, 'api.json'), JSON.stringify(api));
writeFileSync(join(dir, 'sdk.json'), JSON.stringify(config));
const contract = loadContract(join(dir, 'api.json'), join(dir, 'sdk.json'));
const output = join(dir, 'output');
generate(contract, output);
const sdk = await import(pathToFileURL(join(output, 'node/index.js')));
const read = (path) => readFileSync(join(output, path), 'utf8');

test('authentication options reject misspelled modes, credentials and operation-incompatible modes at compile time', () => {
  const source = `import {Client} from './index.js';
const client = new Client({baseUrl:'https://example.invalid',authMode:'merchant',credentials:{merchant:{BearerAuth:'token'}}});
client.payments.retrieve({id:'p_1'}, {authMode:'checkout',credentials:{CheckoutKey:'key'}});
// @ts-expect-error Misspelled mode
new Client({baseUrl:'https://example.invalid',authMode:'merhcant'});
// @ts-expect-error Misspelled scheme
new Client({baseUrl:'https://example.invalid',credentials:{merchant:{BearerAth:'token'}}});
// @ts-expect-error Incomplete mode credentials
new Client({baseUrl:'https://example.invalid',credentials:{merchant:{}}});
// @ts-expect-error Operation does not allow checkout credentials
client.payments.create({body:{amount:'100',currency:'USD',reference:'order'}},{authMode:'checkout',credentials:{CheckoutKey:'key'}});
// @ts-expect-error Credential map must match the selected mode
client.payments.retrieve({id:'p_1'}, {authMode:'checkout',credentials:{BearerAuth:'token'}});
`;
  const file = join(output, 'node/typecheck.ts');
  writeFileSync(file, source);
  execFileSync(
    process.execPath,
    [
      resolve('node_modules/typescript/bin/tsc'),
      '--noEmit',
      '--strict',
      '--module',
      'nodenext',
      '--target',
      'es2022',
      '--typeRoots',
      resolve('node_modules/@types'),
      file,
    ],
    { stdio: 'pipe' },
  );
});

test('authentication failures identify permitted modes and missing keys without exposing credentials', async () => {
  const client = new sdk.Client({ baseUrl: 'https://example.invalid', authMode: 'merhcant' });
  await assert.rejects(
    client.payments.retrieve({ id: 'p_1' }),
    (e) => /merchant, checkout/.test(e.message) || /checkout, merchant/.test(e.message),
  );
  const missing = new sdk.Client({
    baseUrl: 'https://example.invalid',
    authMode: 'merchant',
    credentials: { merchant: { wrong: 'private-secret' } },
  });
  await assert.rejects(
    missing.payments.retrieve({ id: 'p_1' }),
    (e) =>
      /BearerAuth/.test(e.message) &&
      /merchant/.test(e.message) &&
      !/private-secret/.test(e.message),
  );
});

test('hover and standalone mutation examples send a fresh idempotency key and valid request', async () => {
  const requests = [];
  const client = new sdk.Client({
    baseUrl: 'https://example.invalid',
    authMode: 'merchant',
    credentials: { merchant: { BearerAuth: 'test' } },
    transport: async (_url, init) => {
      requests.push(init);
      return new Response('{"id":"p_1","amount":100,"status":"pending"}', { status: 201 });
    },
  });
  const example = read('node/index.d.ts').match(/@example (client\.payments\.create\([^\n]+)/)[1];
  await new Function('client', `return ${example}`)(client);
  assert.match(requests[0].headers['idempotency-key'], /^[\da-f-]{36}$/);
  const standalone = read('node/examples/payments-create.mjs');
  assert.match(standalone, /const idempotencyKey = crypto.randomUUID\(\)/);
  assert.match(standalone, /idempotencyKey: idempotencyKey/);
  assert.doesNotMatch(read('node/README.md'), /await client.close\(\)/);
});

test('reference explains response envelopes, numeric units, models and every convenience method', () => {
  assert.match(
    read('node/index.d.ts'),
    /\/\*\* Amount in the currency's minor unit[^\n]+\*\/ "amount": string/,
  );
  assert.match(read('node/MODELS.md'), /minor unit/);
  assert.match(read('node/MODELS.md'), /Example: 100/);
  for (const target of ['node', 'php']) {
    const ref = read(`${target}/REFERENCE.md`);
    for (const method of ['listAllItems', 'listAllPages', 'retrieveWait'])
      assert.ok(ref.includes('payments.' + method));
    assert.match(ref, /Result.data is the full decoded API response body/);
    assert.match(read(`${target}/RUNTIME.md`), /API_IDEMPOTENCY_KEY/);
    assert.match(read(`${target}/RUNTIME.md`), /BearerAuth/);
  }
});

test('PHP accepts arrays, supports optional-field fallback without collapsing null, and names omitted fields', () => {
  const script = `require $argv[1].'/src/Runtime.php';require $argv[1].'/src/Client.php';
use Example\\Payments\\{Client,ClientOptions,RequestOptions,PaymentsCreateInput,SdkError};
$c=new Client(new ClientOptions('https://example.invalid',authMode:'merchant',credentials:['merchant'=>['BearerAuth'=>'token']],transport:fn($r)=>['status'=>201,'headers'=>[],'body'=>'{"id":"p_1","amount":100,"status":"pending"}']));
$input=['body'=>['amount'=>'100','currency'=>'USD','reference'=>'order']];
foreach([$input,new PaymentsCreateInput($input)] as $value){
 $data=$c->payments->create($value,new RequestOptions(idempotencyKey:'saved-key',maxAttempts:1))->data;
 if($data->hasDescription() || $data->valueOrDefault('description','fallback')!=='fallback')throw new Exception('omission');
 try{$data->getDescription();throw new Exception('did not throw');}catch(SdkError $e){if(!str_contains($e->getMessage(),'description'))throw $e;}
}
$model=new Example\\Payments\\PaymentsCreateResponse201(['id'=>'p_1','amount'=>'100','status'=>'pending','description'=>null]);
if(!$model->hasDescription() || $model->valueOrDefault('description','fallback')!==null)throw new Exception('null');
$fallback=(object)['nested'=>(object)['value'=>1]];$copy=$model->valueOrDefault('absent',$fallback);$copy->nested->value=2;if($fallback->nested->value!==1)throw new Exception('copy');
$c->close();echo 'ok';`;
  assert.equal(execFileSync('php', ['-r', script, output + '/php'], { encoding: 'utf8' }), 'ok');
});

test('pagination and polling recipes run in both generated SDKs', () => {
  const body = JSON.stringify({ id: 'p_1', amount: 100, status: 'succeeded' });
  const list = JSON.stringify({ items: [JSON.parse(body)], next: null });
  for (const target of ['node', 'php']) {
    const reference = read(`${target}/REFERENCE.md`);
    const snippets = [...reference.matchAll(/```(?:typescript|php)\n([\s\S]*?)```/g)].map(
      (m) => m[1],
    );
    assert.equal(snippets.length, 5);
    for (const [index, snippet] of snippets.entries()) {
      if (target === 'node') {
        const source = snippet.replace(
          'new Client({',
          `new Client({transport: async (url) => new Response(String(url).includes('/payments/') ? ${JSON.stringify(body)} : ${JSON.stringify(list)}, {status:200}),`,
        );
        const file = join(output, 'node', `recipe-${index}.mjs`);
        writeFileSync(file, source);
        execFileSync(process.execPath, [file], {
          env: {
            ...process.env,
            API_BASE_URL: 'https://example.invalid',
            API_MERCHANT_BEARERAUTH: 'token',
          },
        });
      } else {
        const source = snippet
          .replace('<?php', '')
          .replace(
            "require __DIR__ . '/vendor/autoload.php';",
            `require ${JSON.stringify(output + '/php/src/Runtime.php')};require ${JSON.stringify(output + '/php/src/Client.php')};`,
          )
          .replace(
            'new ClientOptions(',
            `new ClientOptions(transport: fn($r)=>['status'=>200,'headers'=>[],'body'=>str_contains($r['url'],'/payments/') ? '${body}' : '${list}'],`,
          );
        execFileSync('php', ['-r', source], {
          env: {
            ...process.env,
            API_BASE_URL: 'https://example.invalid',
            API_MERCHANT_BEARERAUTH: 'token',
          },
        });
      }
    }
  }
});
