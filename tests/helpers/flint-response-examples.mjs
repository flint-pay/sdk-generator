import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadContract } from '../../dist/index.js';
import { compileCodec } from '../../dist/codec-plan.js';

const formOperations = new Set([
  'authorizeCLIDevice',
  'exchangeOAuthToken',
  'listCLIContexts',
  'reauthorizeCLIDevice',
  'revokeOAuthToken',
]);
const pointer = (part) => part.replaceAll('~', '~0').replaceAll('/', '~1');
function referenced(source, ref) {
  assert.ok(ref.startsWith('#/'), `response example must use a bundled reference: ${ref}`);
  return ref
    .slice(2)
    .split('/')
    .reduce((value, key) => value[key.replaceAll('~1', '/').replaceAll('~0', '~')], source);
}

// Inspect schema positions only: example values can themselves contain keys such
// as properties, example or $ref. Shared source annotations are checked once,
// regardless of how many response routes reference their component.
export function responseExamples(source) {
  const routes = [],
    schemas = [],
    omitted = [];
  const seen = new Set();
  const visit = (schema, location) => {
    if (!schema || typeof schema !== 'object' || seen.has(location)) return;
    seen.add(location);
    if (schema.$ref) visit(referenced(source, schema.$ref), schema.$ref.slice(1));
    const values = [];
    if (Object.hasOwn(schema, 'example')) values.push(['example', schema.example]);
    if (schema.examples) {
      assert.ok(Array.isArray(schema.examples), location);
      schema.examples.forEach((value, index) => values.push([`examples/${index}`, value]));
    }
    for (const [name, value] of values)
      schemas.push({
        location: location + '/' + name,
        schemaRef: '#' + location,
        json: JSON.stringify(value),
      });
    for (const [key, child] of Object.entries(schema.properties ?? {}))
      visit(child, location + '/properties/' + pointer(key));
    for (const key of [
      'items',
      'additionalProperties',
      'propertyNames',
      'not',
      'if',
      'then',
      'else',
      'contains',
    ])
      visit(schema[key], location + '/' + key);
    for (const key of ['allOf', 'anyOf', 'oneOf'])
      (schema[key] ?? []).forEach((child, index) => visit(child, `${location}/${key}/${index}`));
  };
  for (const [path, item] of Object.entries(source.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      for (const [status, response] of Object.entries(operation.responses ?? {})) {
        if (!/^2\d\d$/.test(status)) continue;
        for (const [media, content] of Object.entries(response.content ?? {})) {
          const location = `/paths/${pointer(path)}/${method}/responses/${status}/content/${pointer(media)}`;
          const examples = Object.entries(content.examples ?? {}).map(([name, example]) => {
            const resolved = example.$ref ? referenced(source, example.$ref) : example;
            assert.ok(
              Object.hasOwn(resolved, 'value'),
              `${location}/examples/${name}: externalValue is not bundled`,
            );
            return ['examples/' + name, resolved.value];
          });
          if (Object.hasOwn(content, 'example')) examples.push(['example', content.example]);
          if (media === 'application/json' || media.endsWith('+json')) {
            visit(content.schema, location + '/schema');
            for (const [name, value] of examples) {
              const record = {
                operation: operation.operationId,
                status,
                media,
                exampleName: name,
                location: location + '/' + name,
                json: JSON.stringify(value),
              };
              // Request flows are excluded, but their documented JSON responses
              // still use response-only compiled plans and both strict decoders.
              if (formOperations.has(record.operation))
                schemas.push({ ...record, schemaRef: '#' + location + '/schema' });
              else routes.push(record);
            }
          } else {
            for (const [name] of examples) {
              assert.equal(media, 'text/event-stream', location);
              assert.equal(operation.operationId, 'streamWebhookEvents');
              omitted.push({
                location: location + '/' + name,
                reason:
                  'SSE wire text, exercised by stream transport tests; not a JSON response body.',
              });
            }
          }
        }
      }
    }
  }
  return { routes, schemas, omitted };
}

export async function checkResponseExamples(output, sourceFile, casesFile) {
  const source = JSON.parse(readFileSync(sourceFile, 'utf8'));
  const expectedFailures = JSON.parse(
    readFileSync(join(dirname(sourceFile), 'response-example-failures.json'), 'utf8'),
  );
  assert.equal(expectedFailures.length, 1, 'review any change to the single upstream defect');
  const key = (example) =>
    JSON.stringify([example.operation, example.status, example.media, example.exampleName]);
  const expected = new Map(expectedFailures.map((example) => [key(example), example]));
  assert.equal(expected.size, expectedFailures.length, 'duplicate expected failure');
  const observed = new Set();
  const audit = responseExamples(source);
  assert.equal(audit.routes.length, 424, 'review changed media-level example coverage');
  assert.equal(
    audit.schemas.length,
    413,
    'review changed nested/hidden-operation example coverage',
  );
  assert.equal(audit.omitted.length, 2, 'only explicit unsupported-media exclusions are permitted');
  // Compile each source schema without a request body or profile corrections.
  // This covers nested annotations and hidden form routes without relaxing them
  // or exposing test operations in the SDK. The actual generated executors below
  // consume these plans; neither target invokes its dynamic schema adapter.
  const paths = Object.fromEntries(
    audit.schemas.map((example, index) => [
      `/__response_example/${index}`,
      {
        get: {
          operationId: 'responseExample' + index,
          security: [],
          responses: {
            200: {
              description: 'Response example audit',
              content: { 'application/json': { schema: { $ref: example.schemaRef } } },
            },
          },
        },
      },
    ]),
  );
  const api = join(dirname(casesFile), 'response-example-api.json');
  const config = join(dirname(casesFile), 'response-example-sdk.json');
  const { webhooks, ...document } = source;
  writeFileSync(api, JSON.stringify({ ...document, paths: { ...source.paths, ...paths } }));
  writeFileSync(
    config,
    JSON.stringify({
      version: '1.0.0',
      auth: { scheme: 'BearerAuth' },
      include: audit.schemas.map((_, i) => 'responseExample' + i),
      npm: { name: '@example/response-audit' },
      composer: { name: 'example/response-audit', namespace: 'Example\\ResponseAudit' },
    }),
  );
  const contract = loadContract(api, config);
  const definitions = Object.fromEntries(
    Object.entries(contract.definitions).map(([name, schema]) => [name, compileCodec(schema)]),
  );
  const operations = new Map(contract.operations.map((operation) => [operation.id, operation]));
  const schemas = audit.schemas.map((example, index) => ({
    ...example,
    codec: compileCodec(operations.get('responseExample' + index).responses['200'].schema),
  }));
  writeFileSync(
    casesFile,
    JSON.stringify({ routes: audit.routes, schemas, definitions, expectedFailures }),
  );
  const base = join(output, 'node');
  const { executeCodec, parseExact, ExactNumber } = await import(
    pathToFileURL(join(base, 'runtime.js')).href
  );
  const routes = new Map();
  for (const file of readdirSync(join(base, 'descriptors/resources'))) {
    const { default: load } = await import(
      pathToFileURL(join(base, 'descriptors/resources', file)).href
    );
    const plan = load();
    for (const operation of plan.operations) routes.set(operation.id, { operation, plan });
  }
  const failures = [];
  const parseWire = (json) => {
    const mark = (value, original) => {
      if (typeof original === 'number' && typeof value === 'string') return new ExactNumber(value);
      if (value && typeof value === 'object')
        for (const key of Object.keys(value)) value[key] = mark(value[key], original[key]);
      return value;
    };
    return mark(parseExact(json), JSON.parse(json));
  };
  const decode = (example, codec, definitions) => {
    let failure;
    try {
      executeCodec(parseWire(example.json), codec, {
        mode: 'response',
        path: 'response',
        definitions,
      });
    } catch (error) {
      failure = error.message;
    }
    const defect = expected.get(key(example));
    if (defect) {
      observed.add(key(example));
      assert.equal(
        failure,
        defect.error,
        `${key(example)}: expected upstream defect changed or now passes; review and remove its entry`,
      );
    } else if (failure) failures.push(`${example.location}: ${failure}`);
  };
  for (const example of audit.routes) {
    const route = routes.get(example.operation);
    assert.ok(route, example.location);
    const codec = route.operation.responses[example.status]?.codec;
    assert.ok(codec, example.location);
    decode(example, codec, route.plan.definitions);
  }
  for (const example of schemas) decode(example, example.codec, definitions);
  assert.deepEqual(failures, []);
  assert.deepEqual(
    [...observed].sort(),
    [...expected.keys()].sort(),
    'expected defect example disappeared',
  );
  const route = routes.get('getPaymentIntent');
  assert.throws(
    () =>
      executeCodec({ data: {} }, route.operation.responses['200'].codec, {
        mode: 'response',
        definitions: route.plan.definitions,
      }),
    /required field is missing/,
  );
  const php = spawnSync(
    'php',
    [
      '-d',
      'memory_limit=128M',
      new URL('./flint-response-examples.php', import.meta.url).pathname,
      output,
      casesFile,
    ],
    { encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024 },
  );
  assert.equal(php.status, 0, php.error?.message ?? php.stderr);
  assert.deepEqual(JSON.parse(php.stdout), {
    inspected: audit.routes.length + schemas.length,
    expectedFailures: expectedFailures.length,
  });
  return {
    inspected: audit.routes.length + schemas.length,
    expectedFailures: expectedFailures.length,
    mediaExamples: audit.routes.length + 4,
    schemaExamples: schemas.length - 4,
    omitted: audit.omitted,
  };
}
