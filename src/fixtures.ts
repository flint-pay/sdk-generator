import { requestArguments } from './request-style.js';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import type { Contract } from './contract.js';
import { Diagnostic, hash } from './contract.js';
interface Scenario {
  name: string;
  operation: string;
  input: Record<string, unknown>;
  baseUrl?: string;
  options?: Record<string, unknown>;
  expected?: {
    method: string;
    path: string;
    headers?: Record<string, string>;
    absentHeaders?: string[];
    body?: string;
  };
  responses: {
    status?: number;
    headers?: Record<string, string>;
    body?: string;
    bodyBase64?: string;
    transportError?: boolean;
  }[];
  data?: unknown;
  dataBase64?: string;
  status?: number;
  empty?: boolean;
  error?: Record<string, unknown>;
  attempts?: number;
}
/** Expected HTTP values must be reviewed independently of schema generation. Never calls the server. */
export async function validateFixtures(
  output: string,
  fixtures: string,
): Promise<{ target: string; scenarios: number }[]> {
  output = resolve(output);
  fixtures = resolve(fixtures);
  const cases: Scenario[] = JSON.parse(readFileSync(fixtures, 'utf8'));
  if (!Array.isArray(cases) || !cases.length)
    throw new Diagnostic(fixtures, 'expected a nonempty array of HTTP scenarios');
  const names = new Set<string>();
  for (const [index, scenario] of cases.entries()) {
    if (
      !scenario ||
      typeof scenario !== 'object' ||
      typeof scenario.name !== 'string' ||
      !scenario.name ||
      names.has(scenario.name) ||
      typeof scenario.operation !== 'string' ||
      !scenario.input ||
      typeof scenario.input !== 'object' ||
      Array.isArray(scenario.input) ||
      !Array.isArray(scenario.responses)
    )
      throw new Diagnostic(
        `${fixtures}/${index}`,
        'scenario requires a unique name, operation, input object and response array',
      );
    names.add(scenario.name);
    if (
      scenario.error !== undefined &&
      (!scenario.error || typeof scenario.error !== 'object' || Array.isArray(scenario.error))
    )
      throw new Diagnostic(`${fixtures}/${index}/error`, 'expected an error field map');
    if (
      scenario.attempts !== undefined &&
      (!Number.isSafeInteger(scenario.attempts) || scenario.attempts < 0)
    )
      throw new Diagnostic(`${fixtures}/${index}/attempts`, 'expected a nonnegative integer');
  }
  const c = JSON.parse(readFileSync(join(output, '.sdk-generator.json'), 'utf8'))
    .interface as Contract;
  const contract = {
    authShortcuts: c.authShortcuts ?? {},
    operations: c.operations.map((op) => ({
      ...op,
    })),
  };
  const report: { target: string; scenarios: number }[] = [];
  if ((c.config.targets ?? ['node', 'php']).includes('node')) {
    const entry = join(output, 'node/index.js');
    const { Client } = await import(
      pathToFileURL(entry).href + '?generation=' + hash(readFileSync(entry, 'utf8'))
    );
    for (const scenario of cases) {
      let attempts = 0;
      const operation = c.operations.find((op) => op.id === scenario.operation);
      if (!operation)
        throw new Diagnostic(`${fixtures}/${scenario.name}`, 'operation is not included');
      const client = new Client({
        baseUrl: scenario.baseUrl ?? 'https://api.example.invalid/v1',
        token: 'test-token',
        transport: async (
          url: URL,
          init: { method: string; headers: Record<string, string>; body?: string },
        ) => {
          const expected = scenario.expected;
          assert.ok(expected, 'unexpected HTTP request');
          assert.equal(init.method, expected.method);
          assert.equal(url.pathname + url.search, expected.path);
          if (expected.body !== undefined) assert.equal(init.body, expected.body);
          for (const [k, v] of Object.entries(expected.headers ?? {}))
            assert.equal(init.headers[k.toLowerCase()], v);
          for (const key of expected.absentHeaders ?? [])
            assert.equal(init.headers[key.toLowerCase()], undefined);
          const response = scenario.responses[attempts++];
          assert.ok(response, 'unexpected extra attempt');
          if (response.transportError) throw new Error('Fixture: lost response');
          return new Response(
            [204, 304].includes(response.status!)
              ? null
              : response.bodyBase64 !== undefined
                ? Buffer.from(response.bodyBase64, 'base64')
                : (response.body ?? ''),
            { status: response.status!, headers: response.headers ?? {} },
          );
        },
      });
      try {
        if (scenario.error)
          await assert.rejects(
            client[operation.resource][operation.method](
              ...requestArguments(operation, scenario.input),
              scenario.options,
            ),
            (e: any) => {
              for (const [k, v] of Object.entries(scenario.error!))
                assert.deepEqual(['status', 'requestId'].includes(k) ? e.meta?.[k] : e[k], v);
              return true;
            },
          );
        else {
          const payload = operation.response?.return === 'payload';
          const response = await client[operation.resource][
            operation.method + (payload ? 'WithResponse' : '')
          ](...requestArguments(operation, scenario.input), scenario.options);
          const result = payload
            ? { data: response.body, meta: response.meta, raw: response.raw }
            : response;
          if (scenario.data !== undefined)
            assert.deepEqual(JSON.parse(JSON.stringify(result.data)), scenario.data);
          if (scenario.dataBase64 !== undefined) {
            assert.ok(result.data instanceof Uint8Array);
            assert.equal(Buffer.from(result.data).toString('base64'), scenario.dataBase64);
            assert.equal(result.raw, result.data);
          }
          if (scenario.status !== undefined) assert.equal(result.meta.status, scenario.status);
          if (scenario.empty) assert.equal(result.data, undefined);
        }
        assert.equal(attempts, scenario.attempts ?? 1);
      } catch (e) {
        throw new Diagnostic(
          `${fixtures}/${scenario.name}/node`,
          e instanceof Error ? e.message : String(e),
        );
      }
    }
    report.push({ target: 'node', scenarios: cases.length });
  }
  if ((c.config.targets ?? ['node', 'php']).includes('php')) {
    const temp = mkdtempSync(join(tmpdir(), 'sdk-fixtures-'));
    try {
      const runtimePath = join(temp, 'runtime.json');
      // The PHP harness only needs call routing, not a second copy of every codec.
      writeFileSync(
        runtimePath,
        JSON.stringify({
          authShortcuts: contract.authShortcuts,
          operations: contract.operations.map((op) => ({
            id: op.id,
            resource: op.resource,
            method: op.method,
            path: op.path,
            request: op.request,
            response: op.response,
            ...(op.body !== undefined ? { body: true } : {}),
            bodyRequired: op.bodyRequired,
            parameters: op.parameters.map(({ name, in: location }) => ({ name, in: location })),
          })),
        }),
      );
      const r = spawnSync(
        'php',
        [
          join(dirname(fileURLToPath(import.meta.url)), '../templates/fixtures.php'),
          join(output, 'php'),
          runtimePath,
          fixtures,
          c.config.composer.namespace,
        ],
        { encoding: 'utf8', timeout: 120000 },
      );
      if (r.status !== 0 || r.error)
        throw new Diagnostic(`${fixtures}/php`, r.error?.message ?? r.stderr + r.stdout);
      report.push({ target: 'php', scenarios: JSON.parse(r.stdout).length });
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }
  return report;
}
