import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadContract, generate, preview } from '../dist/index.js';
import { compileSdkContract } from '../dist/target-plan.js';
import { compareCompiledContracts } from '../dist/compiled-compatibility.js';
import { checkVersionPolicy } from '../dist/version.js';
import { storeCompiledSnapshot, restoreCompiledSnapshot } from '../dist/compiled-record.js';

const root = mkdtempSync(join(tmpdir(), 'sdk-dx-review-'));
after(() => rmSync(root, { recursive: true, force: true }));
function fixture(name, { header, example, response, auth = false, components = {} } = {}) {
  const dir = join(root, name);
  mkdirSync(dir);
  const api = {
    openapi: '3.1.0',
    info: { title: 'DX review', version: '1' },
    components,
    paths: {
      '/value': {
        post: {
          operationId: 'createValue',
          ...(header
            ? {
                parameters: [
                  { name: 'Idempotency-Key', in: 'header', required: true, schema: header },
                ],
              }
            : {}),
          responses: response
            ? { 200: { description: 'OK', content: { 'application/json': { schema: response } } } }
            : { 204: { description: 'OK' } },
        },
      },
    },
  };
  const config = {
    version: '1.0.0',
    requests: { style: 'object' },
    npm: { name: '@example/dx-review' },
    composer: { name: 'example/dx-review', namespace: 'Example\\DxReview' },
    validation: 'schema',
  };
  if (header)
    config.operations = {
      createValue: {
        example: { 'Idempotency-Key': example },
        idempotency: {
          header: 'Idempotency-Key',
          retention: '24 hours',
          scope: 'operation',
          auto: false,
        },
      },
    };
  if (auth) {
    api.components.securitySchemes = {
      BearerAuth: { type: 'http', scheme: 'bearer' },
      CheckoutKey: { type: 'apiKey', in: 'header', name: 'X-Checkout' },
    };
    api.paths['/value'].post.security = [{ BearerAuth: [] }];
    api.paths['/checkout'] = {
      get: {
        operationId: 'getCheckout',
        security: [{ CheckoutKey: [] }],
        responses: { 204: { description: 'OK' } },
      },
    };
    config.auth = {
      modes: {
        merchant: { schemes: ['BearerAuth'], operations: ['createValue'] },
        checkout: { schemes: ['CheckoutKey'], operations: ['getCheckout'] },
      },
    };
  }
  writeFileSync(join(dir, 'api.json'), JSON.stringify(api));
  writeFileSync(join(dir, 'sdk.json'), JSON.stringify(config));
  const contract = loadContract(join(dir, 'api.json'), join(dir, 'sdk.json'));
  const output = join(dir, 'out');
  generate(contract, output);
  return { dir, output, contract, read: (name) => readFileSync(join(output, name), 'utf8') };
}
function runExample(f, target, source, key) {
  const env = { ...process.env, API_BASE_URL: 'https://example.invalid' };
  delete env.API_IDEMPOTENCY_KEY;
  if (key !== undefined) env.API_IDEMPOTENCY_KEY = key;
  if (target === 'node') {
    source = source.replace(
      'new Client({',
      `new Client({transport:async(_url,r)=>{if(r.headers['idempotency-key']!==${JSON.stringify(key)})throw new Error('wrong key');return new Response(null,{status:204});},`,
    );
    const file = join(f.output, 'node', 'run-example.mjs');
    writeFileSync(file, source);
    return execFileSync(process.execPath, [file], { env, stdio: 'pipe' });
  }
  source = source
    .replace(
      /require __DIR__ \. '[^']*vendor\/autoload.php';/,
      `require ${JSON.stringify(join(f.output, 'php/src/Runtime.php'))};require ${JSON.stringify(join(f.output, 'php/src/Client.php'))};`,
    )
    .replace(
      'new ClientOptions(',
      `new ClientOptions(transport:function($r){if($r['headers']['idempotency-key']!==${key === undefined ? 'null' : JSON.stringify(key)})throw new \\Exception('wrong key');return ['status'=>204,'headers'=>[],'body'=>''];},`,
    );
  const file = join(f.output, 'php', 'run-example.php');
  writeFileSync(file, source);
  return execFileSync('php', [file], { env, stdio: 'pipe' });
}

for (const [name, header, key, components] of [
  ['pattern', { type: 'string', pattern: '^key_[a-z]+$' }, 'key_demo'],
  ['enum', { type: 'string', enum: ['key_demo'] }, 'key_demo'],
  ['zero', { type: 'string', enum: ['0'] }, '0'],
  ['short', { type: 'string', maxLength: 8 }, 'key_demo'],
  ['composed', { allOf: [{ type: 'string' }, { pattern: '^key_[a-z]+$' }] }, 'key_demo'],
  [
    'reference',
    { $ref: '#/components/schemas/Key' },
    'key_demo',
    { schemas: { Key: { type: 'string', pattern: '^key_[a-z]+$' } } },
  ],
])
  test(`constrained ${name} keys use explicit schema-compatible values in Node and PHP examples`, () => {
    const f = fixture(name, { header, example: key, components });
    for (const target of ['node', 'php']) {
      const script = f.read(
        `${target}/examples/api-createValue.${target === 'node' ? 'mjs' : 'php'}`,
      );
      assert.match(script, /API_IDEMPOTENCY_KEY/);
      assert.doesNotMatch(script, /randomUUID|random_bytes/);
      runExample(f, target, script, key);
      assert.throws(
        () => runExample(f, target, script),
        (error) => error.stderr.toString().includes('Set API_IDEMPOTENCY_KEY'),
      );
      const readme = f.read(`${target}/README.md`).match(/```(?:typescript|php)\n([\s\S]*?)```/)[1];
      runExample(f, target, readme, key);
    }
    const hover = f.read('node/index.d.ts');
    assert.match(hover, /@example .*API_IDEMPOTENCY_KEY/);
  });

test('bounded ordinary string keys retain automatic generation when their lengths permit it', () => {
  const f = fixture('ordinary', {
    header: { type: 'string', minLength: 1, maxLength: 255 },
    example: 'key_demo',
  });
  assert.match(f.read('node/examples/api-createValue.mjs'), /crypto.randomUUID/);
  assert.match(f.read('php/examples/api-createValue.php'), /bin2hex\(random_bytes/);
  const exact = fixture('exact-length', {
    header: { type: 'string', minLength: 36, maxLength: 36 },
    example: '11111111-1111-4111-8111-111111111111',
  });
  assert.match(exact.read('node/examples/api-createValue.mjs'), /crypto.randomUUID/);
  assert.match(exact.read('php/examples/api-createValue.php'), /API_IDEMPOTENCY_KEY/);
});

test('PHP preserves orDefault field getters alongside the collision-safe fallback helper', () => {
  const f = fixture('getter', {
    response: {
      type: 'object',
      properties: {
        orDefault: { type: 'string' },
        valueOrDefault: { type: 'string' },
        nullable: { type: ['string', 'null'] },
      },
      required: ['orDefault'],
    },
  });
  const program = String.raw`require $argv[1].'/src/Runtime.php';require $argv[1].'/src/Client.php';
$model=new Example\DxReview\ApiCreateValueResponse200(['orDefault'=>'wire value','valueOrDefault'=>'another value','nullable'=>null]);
if($model->getOrDefault()!=='wire value'||!$model->hasOrDefault())throw new Exception('old getter');
if($model->getValueOrDefault()!=='another value'||!$model->hasValueOrDefault())throw new Exception('new-name field getter');
if($model->valueOrDefault('absent','fallback')!=='fallback')throw new Exception('fallback');
if($model->valueOrDefault('nullable','fallback')!==null)throw new Exception('null');
echo 'ok';`;
  assert.equal(
    execFileSync('php', ['-r', program, join(f.output, 'php')], { encoding: 'utf8' }),
    'ok',
  );
});

test('historical unrestricted authentication options cannot migrate in a semver patch release', () => {
  const f = fixture('auth', { auth: true });
  const current = compileSdkContract(f.contract).plan;
  const historical = structuredClone(current);
  delete historical.node.authentication;
  for (const op of Object.values(historical.node.operations)) {
    delete op.requestOptions;
    delete op.authModes;
  }
  const roundtrip = restoreCompiledSnapshot(
    storeCompiledSnapshot({
      plan: historical,
      runtimeIdentity: { node: '0'.repeat(64), php: '0'.repeat(64) },
    }),
  ).plan;
  const findings = compareCompiledContracts(roundtrip, current);
  assert.ok(
    findings.some((f) => f.severity === 'breaking' && f.subject === 'authentication options'),
  );
  assert.ok(findings.some((f) => f.severity === 'breaking' && f.subject === 'createValue.options'));
  assert.throws(() => checkVersionPolicy('1.0.0', '1.0.1', findings), /major version/);
  assert.doesNotThrow(() => checkVersionPolicy('1.0.0', '2.0.0', findings));
  assert.deepEqual(compareCompiledContracts(current, structuredClone(current)), []);
  const narrower = structuredClone(current);
  narrower.node.operations.createValue.authModes = [];
  narrower.node.operations.createValue.requestOptions = 'RequestOptions<never>';
  assert.ok(
    compareCompiledContracts(current, narrower).some(
      (f) => f.severity === 'breaking' && f.subject === 'createValue.options',
    ),
  );
  const invalid = structuredClone(current);
  invalid.node.authentication.modes.merchant = [42];
  assert.throws(
    () =>
      restoreCompiledSnapshot(
        storeCompiledSnapshot({
          plan: invalid,
          runtimeIdentity: { node: '0'.repeat(64), php: '0'.repeat(64) },
        }),
      ),
    /authentication/,
  );

  // Emulate the options declarations used by a historical consumer and prove
  // the exact wrapper that requires the major release still compiles there.
  const source = `import {Client,type RequestOptions} from './index.js';
const client=new Client({baseUrl:'https://example.invalid',authMode:'merchant',credentials:{merchant:{BearerAuth:'key'}}});
export function create(options:RequestOptions={}) { return client.api.createValue({}, options); }`;
  const file = join(f.output, 'node', 'consumer.ts');
  writeFileSync(file, source);
  const tsc = [
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
  ];
  assert.throws(
    () => execFileSync(process.execPath, tsc, { stdio: 'pipe' }),
    (error) => error.stdout.toString().includes('TS2345'),
  );
  const declarationPath = join(f.output, 'node/index.d.ts');
  const declarations = f.read('node/index.d.ts');
  const legacy = declarations
    .replace(
      /export type RequestOptions<M extends AuthMode = AuthMode> =[^\n]+\n/,
      'export type RequestOptions = RuntimeRequestOptions;\n',
    )
    .replace(/RequestOptions<[^>]+>/g, 'RequestOptions');
  writeFileSync(declarationPath, legacy);
  execFileSync(process.execPath, tsc, { stdio: 'pipe' });
  writeFileSync(declarationPath, declarations);

  // The same classification must reach preview, rather than remaining only
  // a direct comparison result disconnected from release/version policy.
  const recordPath = join(f.output, '.sdk-generator.json');
  const record = JSON.parse(readFileSync(recordPath));
  const snapshot = { ...restoreCompiledSnapshot(record.compiled), plan: historical };
  record.compiled = storeCompiledSnapshot(snapshot);
  writeFileSync(recordPath, JSON.stringify(record));
  assert.ok(
    preview(f.contract, f.output).compatibility.some(
      (f) => f.severity === 'breaking' && f.subject === 'authentication options',
    ),
  );
});
