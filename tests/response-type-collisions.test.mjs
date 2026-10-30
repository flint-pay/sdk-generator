import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { loadContract, generate } from '../dist/index.js';
import { diagnoseContract } from '../dist/generate.js';
import { compileSdkContract } from '../dist/target-plan.js';

const object = { type: 'object', required: ['id'], properties: { id: { type: 'string' } } };
const ref = (name) => ({ $ref: '#/components/schemas/' + name });
function fixture(
  t,
  {
    schema,
    components,
    path = '/v1/widgets',
    method = 'get',
    operationId = 'getWidgets',
    extraResponses = {},
    configExtra = {},
  },
) {
  const dir = mkdtempSync(join(tmpdir(), 'sdk-response-collision-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const api = {
    openapi: '3.1.0',
    info: { title: 'Response names', version: '1' },
    components: { schemas: components },
    paths: {
      [path]: {
        [method]: {
          operationId,
          responses: {
            200: { description: 'OK', content: { 'application/json': { schema } } },
            ...extraResponses,
          },
        },
      },
    },
  };
  const config = {
    version: '1.0.0',
    operationNames: 'path',
    npm: { name: '@example/response-names' },
    composer: { name: 'example/response-names', namespace: 'ResponseNames' },
    ...configExtra,
    models: Object.fromEntries(
      Object.entries({ Money: 'MoneyValue', Return: 'ReturnResource' }).filter(
        ([name]) => components[name],
      ),
    ),
  };
  const definition = join(dir, 'api.json'),
    settings = join(dir, 'sdk.json'),
    output = join(dir, 'output');
  writeFileSync(definition, JSON.stringify(api));
  writeFileSync(settings, JSON.stringify(config));
  const contract = loadContract(definition, settings);
  generate(contract, output);
  return { dir, definition, settings, output, contract };
}
async function exercise(f, name, resource, method, body) {
  const { Client } = await import(pathToFileURL(join(f.output, 'node/index.js')));
  const client = new Client({
    baseUrl: 'https://example.invalid',
    transport: async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  });
  const result = await client[resource][method]();
  assert.deepEqual(JSON.parse(JSON.stringify(result)), body);
  await client.close?.();
  const php = execFileSync(
    'php',
    [
      '-r',
      String.raw`
require $argv[1].'/php/src/autoload.php';
$c = new \ResponseNames\Client(new \ResponseNames\ClientOptions(baseUrl: 'https://example.invalid', transport: fn($r) => ['status'=>200, 'headers'=>['content-type'=>'application/json'], 'body'=>$argv[4]]));
$resource=$argv[2];$method=$argv[3];$result=$c->$resource->$method();
echo get_class($result);$c->close();
`,
      f.output,
      resource,
      method,
      JSON.stringify(body),
    ],
    { encoding: 'utf8' },
  );
  assert.equal(php, 'ResponseNames\\' + name);
  const consumer = join(f.output, 'node/consumer.ts');
  writeFileSync(
    consumer,
    `import { Client, type ${name === 'WidgetsGetOperationResponse' || name.endsWith('OperationResponse2') ? 'WidgetsGetResponse' : name} } from './index.js';
declare const client: Client;
const result = await client.${resource}.${method}();
${resource === 'widgets' && name.startsWith('WidgetsGetOperation') ? 'const related: WidgetsGetResponse | undefined = result.related;' : `const body: ${name} = result;`}
`,
  );
  try {
    execFileSync(
      process.execPath,
      [
        resolve('node_modules/typescript/bin/tsc'),
        '--strict',
        '--noEmit',
        '--module',
        'NodeNext',
        '--target',
        'ES2022',
        '--typeRoots',
        resolve('node_modules/@types'),
        consumer,
      ],
      { stdio: 'pipe', encoding: 'utf8' },
    );
  } catch (error) {
    throw new Error(error.stdout || error.message);
  }
}

test('declared response components win over a same-name operation class in both targets', async (t) => {
  const f = fixture(t, {
    schema: ref('WidgetsGetResponse'),
    components: { WidgetsGetResponse: object },
  });
  assert.deepEqual(diagnoseContract(f.contract), {});
  assert.ok(existsSync(join(f.output, 'php/src/classes/WidgetsGetResponse.php')));
  assert.ok(!existsSync(join(f.output, 'php/src/classes/WidgetsGetOperationResponse.php')));
  await exercise(f, 'WidgetsGetResponse', 'widgets', 'get', { id: 'item_synthetic' });
});

test('declared response components share their PHP identity with nested references', async (t) => {
  const f = fixture(t, {
    schema: ref('Payment'),
    components: {
      Payment: {
        ...object,
        properties: { ...object.properties, related: ref('Payment') },
      },
    },
  });
  assert.deepEqual(diagnoseContract(f.contract), {});
  await exercise(f, 'Payment', 'widgets', 'get', {
    id: 'payment_synthetic',
    related: { id: 'related_synthetic' },
  });
});

for (const doubleCollision of [false, true])
  test(`inline response name collisions use deterministic suffixes (${doubleCollision ? 'occupied fallback' : 'first fallback'})`, async (t) => {
    const components = {
      WidgetsGetResponse: object,
      ...(doubleCollision ? { WidgetsGetOperationResponse: object } : {}),
    };
    const schema = {
      type: 'object',
      properties: {
        related: ref('WidgetsGetResponse'),
        ...(doubleCollision ? { other: ref('WidgetsGetOperationResponse') } : {}),
      },
    };
    const f = fixture(t, { schema, components });
    const name = 'WidgetsGetOperationResponse' + (doubleCollision ? '2' : '');
    const expected = [
      { operation: 'getWidgets', status: '200', from: 'WidgetsGetResponse', to: name },
    ];
    assert.deepEqual(diagnoseContract(f.contract).responseTypeRenames, expected);
    const diagnosis = JSON.parse(
      execFileSync(
        process.execPath,
        ['dist/cli.js', 'diagnose', f.definition, f.settings, '--json'],
        { encoding: 'utf8' },
      ),
    );
    assert.deepEqual(diagnosis.responseTypeRenames, expected);
    const body = {
      related: { id: 'component_synthetic' },
      ...(doubleCollision ? { other: { id: 'other_synthetic' } } : {}),
    };
    await exercise(f, name, 'widgets', 'get', body);
  });

test('Flint onboarding.start reuses OnboardingStartResponse from the pinned public fixture', async (t) => {
  const api = JSON.parse(
    readFileSync(new URL('./providers/flint/full-openapi.json', import.meta.url), 'utf8'),
  );
  const schema =
    api.paths['/v1/onboarding/start'].post.responses['200'].content['application/json'].schema;
  assert.deepEqual(schema, ref('OnboardingStartResponse'));
  const components = {};
  function include(value) {
    if (!value || typeof value !== 'object') return;
    if (value.$ref) {
      const name = value.$ref.split('/').at(-1);
      if (!components[name]) {
        components[name] = api.components.schemas[name];
        include(components[name]);
      }
    }
    for (const child of Object.values(value)) include(child);
  }
  include(schema);
  const f = fixture(t, {
    schema,
    components,
    path: '/v1/onboarding/start',
    method: 'post',
    operationId: 'startOnboarding',
  });
  await exercise(f, 'OnboardingStartResponse', 'onboarding', 'start', {
    data: {
      verification_started: true,
      verification_token: 'synthetic-verification',
      expires_at: '2026-10-30T12:00:00Z',
    },
    request_id: 'req_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  });
});

// Redirects and 304 are supported response statuses even though they are outside 2xx.
test('status-specific response classes retain names for redirects', (t) => {
  const redirect = { type: 'object', properties: { location: { type: 'string' } } };
  const f = fixture(t, {
    schema: object,
    components: {},
    configExtra: { responses: { return: 'result' } },
    extraResponses: {
      307: { description: 'Redirect', content: { 'application/json': { schema: redirect } } },
    },
  });
  const plan = compileSdkContract(f.contract).plan;
  assert.equal(plan.php.runtime.operations[0].responses['307'].model, 'WidgetsGetResponse307');
  assert.ok(existsSync(join(f.output, 'php/src/classes/WidgetsGetResponse307.php')));
  assert.ok(plan.php.models.every((model) => typeof model.name === 'string'));
});

test('combined Node response aliases also report a component-name fallback', (t) => {
  const f = fixture(t, {
    components: { WidgetsGetResponse: object },
    schema: { type: 'object', properties: { related: ref('WidgetsGetResponse') } },
    extraResponses: {
      201: {
        description: 'Created',
        content: {
          'application/json': {
            schema: { type: 'object', properties: { created: { type: 'boolean' } } },
          },
        },
      },
    },
  });
  assert.deepEqual(diagnoseContract(f.contract).responseTypeRenames, [
    {
      operation: 'getWidgets',
      status: 'combined',
      from: 'WidgetsGetResponse',
      to: 'WidgetsGetOperationResponse',
    },
  ]);
  assert.equal(
    compileSdkContract(f.contract).plan.node.operations.getWidgets.responseType,
    'WidgetsGetOperationResponse',
  );
});
