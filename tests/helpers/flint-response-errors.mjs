import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { spawnSync } from 'node:child_process';

// These expectations come from the documented HTTP status contract, independently
// of the generated error factory. All other documented 4xx statuses use ApiError.
const kinds = {
  400: ['validation', 'ValidationError'],
  401: ['authentication', 'AuthenticationError'],
  403: ['authentication', 'AuthenticationError'],
  404: ['not_found', 'NotFoundError'],
  409: ['conflict', 'ConflictError'],
  412: ['conflict', 'ConflictError'],
  422: ['validation', 'ValidationError'],
  429: ['rate_limit', 'RateLimitError'],
};

// Expected values come from source JSON, with only the documented exact numeric
// representations applied. No generated codec or certificate sets expectations.
function expectedJson(value, schemas, source, path) {
  const expand = (schema, seen = new Set()) => {
    if (!schema || typeof schema !== 'object') return [];
    const children = ['allOf', 'anyOf', 'oneOf'].flatMap((key) => schema[key] ?? []);
    if (schema.$ref && !seen.has(schema.$ref)) {
      seen = new Set([...seen, schema.$ref]);
      children.push(
        schema.$ref
          .slice(2)
          .split('/')
          .reduce((node, key) => node[key.replaceAll('~1', '/').replaceAll('~0', '~')], source),
      );
    }
    return [schema, ...children.flatMap((child) => expand(child, seen))];
  };
  schemas = schemas.flatMap((schema) => expand(schema));
  if (typeof value === 'number') {
    const numeric = schemas.filter((schema) => ['integer', 'number'].includes(schema.type));
    const representations = new Set(
      numeric.map((schema) =>
        ['int64', 'uint64', 'decimal'].includes(schema.format) ? 'string' : 'number',
      ),
    );
    assert.equal(representations.size, 1, path + ': explicitly review numeric expectation');
    if (representations.has('string')) {
      assert.ok(Number.isSafeInteger(value), path + ': expected exact source integer');
      return String(value);
    }
    return value;
  }
  if (Array.isArray(value))
    return value.map((child, index) =>
      expectedJson(
        child,
        schemas.map((schema) => schema.items),
        source,
        `${path}[${index}]`,
      ),
    );
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        expectedJson(
          child,
          schemas.map((schema) => schema.properties?.[key] ?? schema.additionalProperties),
          source,
          `${path}.${key}`,
        ),
      ]),
    );
  return value;
}

function requestGroup(base, operation, plan) {
  // Reuse the emitted, validated runnable request example rather than maintaining
  // a second synthesizer for hundreds of unrelated provider input contracts.
  const example = readFileSync(
    join(base, 'examples', `${operation.resource}-${operation.method}.mjs`),
    'utf8',
  );
  const call = example.match(/const result = await client\.(\w+)\.(\w+)\(([\s\S]*?)\n\)/);
  assert.ok(call, operation.id + ': missing runnable request example');
  assert.equal(call[1], operation.resource);
  assert.equal(call[2], operation.method);
  const [input = {}, options = {}] = JSON.parse(
    runInNewContext(`JSON.stringify([${call[3]}])`, {
      idempotencyKey: 'response-example-audit',
    }),
  );
  const authMode = operation.authModes?.[0];
  if (authMode) {
    options.authMode = authMode;
    options.credentials = Object.fromEntries(
      plan.authentication[authMode].schemes.map((scheme) => [scheme.name, 'synthetic']),
    );
  }
  return {
    resource: operation.resource,
    method: operation.method,
    input,
    inputJson: JSON.stringify(input),
    options,
    verb: operation.verb,
    path: operation.path.replace(/\{([^}]+)\}/g, (_, name) => encodeURIComponent(input[name])),
  };
}

async function nodeErrors(base, audit, entry = 'index.js') {
  const sdk = await import(pathToFileURL(join(base, entry)).href);
  let requests = 0;
  const client = new sdk.Client({
    maxAttempts: 1,
    transport: async (url, init) => {
      const example = audit.examples[Number(init.headers['x-response-example'])];
      assert.ok(example, 'unexpected error audit request');
      const group = audit.groups[example.operation];
      assert.equal(url.pathname, group.path, example.location);
      assert.equal(init.method, group.verb, example.location);
      requests++;
      const body = JSON.parse(example.json);
      return new Response(example.json, {
        status: Number(example.status),
        headers: {
          'content-type': example.media,
          ...(body.error.request_id ? { 'x-request-id': body.error.request_id } : {}),
        },
      });
    },
  });
  try {
    for (const [index, example] of audit.examples.entries()) {
      const group = audit.groups[example.operation];
      const body = JSON.parse(example.json);
      const [kind, errorClass] = example.expectedError;
      await assert.rejects(
        client[group.resource][group.method](group.input, {
          ...group.options,
          maxAttempts: 1,
          headers: { 'x-response-example': String(index) },
        }),
        (error) => {
          assert.ok(
            error instanceof sdk.errors[errorClass],
            `${example.location}: expected ${errorClass}, got ${error.name}: ${error.message}`,
          );
          assert.equal(error.kind, kind, example.location + ': kind');
          assert.equal(error.status, Number(example.status), example.location + ': status');
          assert.equal(error.outcome, 'response', example.location + ': outcome');
          assert.equal(error.code, body.error.code, example.location + ': code');
          // No nonconforming-details exclusions: every published error object
          // must survive the public SdkError.details certification boundary.
          assert.deepEqual(
            error.details,
            JSON.parse(example.expectedDetailsJson),
            example.location + ': certified details',
          );
          assert.equal(
            error.meta.requestId,
            body.error.request_id,
            example.location + ': requestId',
          );
          assert.equal(error.meta.attempts, 1, example.location + ': attempts');
          return true;
        },
        example.location,
      );
    }
    assert.equal(requests, audit.examples.length, 'every error must reach the transport once');
  } finally {
    await client.close?.();
  }
}

export async function checkErrorResponseExamples(output, examples, routes, casesFile, source) {
  const base = join(output, 'node');
  const groups = {};
  for (const example of examples) {
    const route = routes.get(example.operation);
    assert.ok(route, example.location);
    groups[example.operation] ??= requestGroup(base, route.operation, route.plan);
  }
  const audit = {
    groups,
    examples: examples.map((example) => {
      const operation = routes.get(example.operation).operation;
      const schema =
        source.paths[operation.path][operation.verb.toLowerCase()].responses[example.status]
          .content[example.media].schema;
      return {
        ...example,
        // PHP's public details are mixed raw JSON: safe integers stay numeric;
        // fractional/unsafe tokens remain exact strings, independently of schema.
        expectedPhpDetailsJson: JSON.stringify(
          JSON.parse(example.json, (_, value, context) =>
            typeof value === 'number' &&
            (!Number.isSafeInteger(value) || /[.eE]/.test(context.source))
              ? context.source
              : value,
          ).error,
        ),
        expectedDetailsJson: JSON.stringify(
          expectedJson(JSON.parse(example.json), [schema], source, example.location).error,
        ),
        expectedError:
          kinds[example.status] ??
          (Number(example.status) >= 500 ? ['server', 'ServerError'] : ['api', 'ApiError']),
      };
    }),
  };
  writeFileSync(casesFile, JSON.stringify(audit));
  await nodeErrors(base, audit);

  // Run the same assertion through a real client with certification deliberately
  // dropping its result. A direct-codec-only audit would accept this mutation.
  const runtime = readFileSync(join(base, 'runtime.js'), 'utf8');
  const assignment = 'details = structuredClone(decoded);';
  assert.equal(runtime.split(assignment).length, 2, 'locate error certification mutation');
  const mutantRuntime = '.response-audit-runtime.js';
  const mutantEntry = '.response-audit-client.js';
  try {
    writeFileSync(join(base, mutantRuntime), runtime.replace(assignment, 'details = undefined;'));
    const client = readFileSync(join(base, 'index.js'), 'utf8');
    const mutantClient = client.replaceAll("'./runtime.js'", `'./${mutantRuntime}'`);
    assert.notEqual(mutantClient, client, 'locate client runtime import');
    writeFileSync(join(base, mutantEntry), mutantClient);
    await assert.rejects(
      nodeErrors(base, { ...audit, examples: audit.examples.slice(0, 1) }, mutantEntry),
      /certified details/,
      'dropping certified Node error details must fail the client audit',
    );
  } finally {
    rmSync(join(base, mutantRuntime), { force: true });
    rmSync(join(base, mutantEntry), { force: true });
  }

  const php = (mutant) =>
    spawnSync(
      'php',
      [
        '-d',
        'memory_limit=128M',
        new URL('./flint-response-errors.php', import.meta.url).pathname,
        output,
        casesFile,
        ...(mutant ? [mutant] : []),
      ],
      { encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024 },
    );
  const result = php();
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { errorThroughClient: examples.length });
  const phpRuntime = readFileSync(join(output, 'php/src/classes/Runtime.php'), 'utf8');
  const pattern = /\$details,(\s*raw: \$raw,)/g;
  assert.equal([...phpRuntime.matchAll(pattern)].length, 1, 'locate PHP error details mutation');
  const mutantPhp = join(dirname(casesFile), 'response-audit-runtime.php');
  try {
    writeFileSync(mutantPhp, phpRuntime.replace(pattern, 'null,$1'));
    const result = php(mutantPhp);
    assert.notEqual(result.status, 0, 'dropping PHP error details must fail the client audit');
    assert.match(result.stderr, /public error details/);
  } finally {
    rmSync(mutantPhp, { force: true });
  }
  return examples.length;
}
