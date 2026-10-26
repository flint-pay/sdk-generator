import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { loadContract, generate } from '../dist/index.js';
import { compileSdkContract } from '../dist/target-plan.js';
import { compileRuntimePlan } from '../dist/runtime-plan.js';
import { ANY_CODEC } from '../dist/codec-plan.js';
import { publicTypePlanner, publicTypeDeclarations } from '../dist/public-type-plan.js';
import { certifies } from '../dist/type-certificate.js';

// An independent value/probe generator over the public type plan. It deliberately
// ignores schema codecs: the certificate must uphold declarations on its own.
function explore(certificate) {
  const resolveNode = (node) =>
    node.kind === 'reference' ? certificate.definitions[node.name] : node;
  function sample(declaration, depth = 0) {
    if (depth > 16) throw new Error('recursive sample');
    const node = resolveNode(declaration);
    switch (node.kind) {
      case 'unknown':
      case 'record': {
        const value = {};
        for (const [key, field] of Object.entries(node.fields ?? {}))
          if (!field.optional) value[key] = sample(field.type, depth + 1);
        return value;
      }
      case 'null':
        return null;
      case 'undefined':
        return undefined;
      case 'string':
        return 'synthetic';
      case 'integer-string':
        return '42';
      case 'number':
        return 42;
      case 'boolean':
        return true;
      case 'literal':
        return node.value;
      case 'array':
        return [sample(node.element, depth + 1)];
      case 'object':
      case 'nonnull':
        return {};
      case 'nonarray':
        return sample(node.value, depth + 1);
      case 'union': {
        for (const member of node.members) {
          try {
            const value = sample(member, depth + 1);
            if (certifies(value, { ...certificate, type: node })) return value;
          } catch {
            /* Try another finite inhabitant. */
          }
        }
        throw new Error('no finite union sample');
      }
      case 'intersection': {
        const values = node.members.map((member) => sample(member, depth + 1));
        const concrete = values.filter((v) => v !== undefined && v !== null);
        if (concrete.every((v) => typeof v === 'object' && !Array.isArray(v)))
          return Object.assign({}, ...concrete);
        return (
          concrete.find((v) => Array.isArray(v)) ??
          concrete.find((v) => typeof v !== 'object') ??
          values[0]
        );
      }
      default:
        throw new Error('uninhabited JSON sample: ' + node.kind);
    }
  }
  const paths = new Map();
  const knownKeys = new Set();
  function walk(declaration, path = [], depth = 0) {
    if (depth > 4) return;
    const node = resolveNode(declaration);
    if (!node) return;
    if (['string', 'integer-string', 'number'].includes(node.kind) || node.kind === 'literal') {
      const kind = node.kind === 'literal' ? typeof node.value : node.kind;
      if (kind === 'number' || kind === 'string' || kind === 'integer-string')
        paths.set(JSON.stringify(path) + kind, {
          path,
          method: kind === 'number' ? 'toFixed' : 'toUpperCase',
        });
    } else if (node.kind === 'record') {
      for (const [key, field] of Object.entries(node.fields)) {
        knownKeys.add(key);
        walk(field.type, [...path, key], depth + 1);
      }
    } else if (node.kind === 'array') walk(node.element, [...path, 0], depth + 1);
    else if (node.kind === 'union' || node.kind === 'intersection')
      node.members.forEach((member) => walk(member, path, depth + 1));
    else if (node.kind === 'nonarray') walk(node.value, path, depth + 1);
  }
  walk(certificate.type);
  return { sample: sample(certificate.type), paths: [...paths.values()], knownKeys };
}
function probe(name, root, { path, method }) {
  let expression = 'v';
  const guards = [];
  for (const key of path) {
    guards.push(
      key === 0
        ? `Array.isArray(${expression}) && ${expression}.length > 0`
        : `${expression} !== null && typeof ${expression} === 'object' && ${JSON.stringify(key)} in ${expression}`,
    );
    expression += `[${JSON.stringify(key)}]`;
  }
  guards.push(`${expression} !== undefined && ${expression} !== null`);
  return `export function ${name}(v: Root${root}) { if (${guards.join(' && ')}) return ${expression}.${method}(); }\n`;
}
function adversaries(sample, knownKeys) {
  const values = [sample];
  function mutate(value, path = [], depth = 0) {
    if (depth > 4) return;
    const replace = (replacement) => {
      if (!path.length) return values.push(replacement);
      const copy = structuredClone(sample);
      let parent = copy;
      for (const key of path.slice(0, -1)) parent = parent[key];
      parent[path.at(-1)] = replacement;
      values.push(copy);
    };
    for (const wrong of [null, 42, 'invalid', [], {}, { kind: 'future', foo: 42 }]) replace(wrong);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      replace({ ...value, kind: 'future', foo: 42, bar: 'invalid' });
      replace({ ...value, transportCode: 42 });
      for (const key of [...knownKeys].slice(0, 12))
        replace({ ...value, [key]: { invalid: true } });
    }
    if (value && typeof value === 'object')
      for (const [key, child] of Object.entries(value).slice(0, 12))
        mutate(child, [...path, Array.isArray(value) ? Number(key) : key], depth + 1);
  }
  mutate(sample);
  return values;
}

for (const provider of ['library', 'flint']) {
  test(`generated ${provider} public types certify conforming and adversarial values before tsc-approved accesses`, async (t) => {
    mkdirSync('.generated', { recursive: true });
    const dir = mkdtempSync(resolve('.generated/type-certificate-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    let contract;
    if (provider === 'library') {
      const api = JSON.parse(readFileSync('examples/library.openapi.json', 'utf8'));
      const profile = JSON.parse(readFileSync('examples/library.sdk.json', 'utf8'));
      const object = (properties) => ({
        type: 'object',
        properties,
        required: Object.keys(properties),
      });
      const first = object({ kind: { type: 'string', enum: ['a'] }, foo: { type: 'string' } });
      const second = object({ kind: { type: 'string', enum: ['b'] }, bar: { type: 'number' } });
      const alternative = { oneOf: [first, second] };
      const shapes = {
        Choice: alternative,
        Nested: object({ content: alternative }),
        ArrayChoice: {
          oneOf: [
            { type: 'array', items: first },
            { type: 'array', items: second },
          ],
        },
        NestedChoice: { oneOf: [object({ content: first }), object({ content: second })] },
        Nullable: { oneOf: [first, { type: 'null' }] },
        Dictionary: { type: 'object', additionalProperties: first },
      };
      api.components ??= {};
      api.components.schemas ??= {};
      for (const [name, schema] of Object.entries(shapes)) {
        api.components.schemas['Certificate' + name] = schema;
        api.paths['/certificates/' + name] = {
          get: {
            operationId: 'certificate' + name,
            responses: {
              200: {
                description: 'Synthetic',
                content: {
                  'application/json': {
                    schema: { $ref: '#/components/schemas/Certificate' + name },
                  },
                },
              },
            },
          },
        };
      }
      const apiPath = join(dir, 'api.json');
      const profilePath = join(dir, 'profile.json');
      writeFileSync(apiPath, JSON.stringify(api));
      writeFileSync(profilePath, JSON.stringify(profile));
      contract = loadContract(apiPath, profilePath);
    } else
      contract = loadContract(
        'tests/providers/flint/openapi.json',
        'tests/providers/flint/sdk.json',
      );
    contract.config.targets = ['node'];
    const { plan } = compileSdkContract(contract);
    const output = join(dir, 'out');
    generate(contract, output);
    const declarations = {
      ...Object.fromEntries(
        Object.entries(plan.node.models).map(([name, model]) => [
          name,
          model.outputAlias ?? model.output,
        ]),
      ),
      ...publicTypeDeclarations(plan.node.eventDeclarations ?? ''),
    };
    const certificate = publicTypePlanner(declarations);
    let roots = Object.entries(plan.node.models)
      .filter(([, model]) => !model.outputAlias)
      .map(([name]) => ({ name, expression: name }));
    if (provider === 'library') {
      for (const [id, node] of Object.entries(plan.node.operations)) {
        roots.push({ name: id + ' response', expression: node.output });
        if (plan.responseReturns?.[id])
          roots.push({ name: id + ' payload', expression: plan.responseReturns[id].node });
        if (node.items !== 'never') roots.push({ name: id + ' item', expression: node.items });
        if (node.known) roots.push({ name: id + ' known', expression: node.known.type });
      }
      if (plan.node.eventDeclarations)
        roots.push({ name: 'KnownWebhookEvent', expression: 'KnownWebhookEvent' });
    } else
      roots = roots
        .filter(({ name }) => /PaymentIntent|Money|Error|Page|Refund/.test(name))
        .slice(0, 12);
    assert.ok(roots.length > 0);
    const imports = `import type {${Object.keys(declarations)
      .filter((name) => !name.startsWith('_Sdk') && !plan.node.models[name]?.outputAlias)
      .join(',')}} from './index.js';\n`;
    // Webhook helper aliases are internal; inline root expressions only reference exported models.
    const headers =
      imports +
      Object.entries(plan.node.models)
        .filter(([, model]) => model.outputAlias)
        .map(([name, model]) => `type ${name} = ${model.outputAlias};\n`)
        .join('') +
      roots.map((root, index) => `type Root${index} = ${root.expression};\n`).join('');
    const probes = [];
    for (const [index, root] of roots.entries()) {
      root.certificate = certificate(root.expression);
      root.explored = explore(root.certificate);
      assert.ok(
        certifies(root.explored.sample, root.certificate),
        root.name + ' conforming sample',
      );
      for (const path of root.explored.paths)
        probes.push({
          root: index,
          source: probe('p' + probes.length, index, path),
          name: 'p' + probes.length,
        });
    }
    const file = join(output, 'node/properties.ts');
    writeFileSync(file, headers + probes.map((p) => p.source).join(''));
    const options = {
      strict: true,
      exactOptionalPropertyTypes: true,
      module: ts.ModuleKind.NodeNext,
      target: ts.ScriptTarget.ES2022,
      noEmit: true,
    };
    const program = ts.createProgram([file], options);
    const diagnostics = ts.getPreEmitDiagnostics(program);
    const source = program.getSourceFile(file);
    const ranges = new Map(
      source.statements
        .filter(ts.isFunctionDeclaration)
        .map((node) => [node.name.text, [node.pos, node.end]]),
    );
    const checker = program.getTypeChecker();
    const unchecked = new Set();
    for (const statement of source.statements)
      if (ts.isFunctionDeclaration(statement)) {
        const visit = (node) => {
          if (
            ts.isCallExpression(node) &&
            ts.isPropertyAccessExpression(node.expression) &&
            ['toFixed', 'toUpperCase'].includes(node.expression.name.text)
          ) {
            const type = checker.getTypeAtLocation(node.expression.expression);
            // Array.isArray(unknown) produces any[] in lib.d.ts. That is an
            // unchecked assertion, not a narrowed type promised by this SDK.
            if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))
              unchecked.add(statement.name.text);
          }
          ts.forEachChild(node, visit);
        };
        visit(statement);
      }
    const accepted = probes.filter(
      ({ name }) =>
        !unchecked.has(name) &&
        !diagnostics.some(
          (diagnostic) =>
            diagnostic.file?.fileName === file &&
            diagnostic.start >= ranges.get(name)[0] &&
            diagnostic.start < ranges.get(name)[1],
        ),
    );
    writeFileSync(file, headers + accepted.map((p) => p.source).join(''));
    const final = ts.createProgram([file], options);
    assert.deepEqual(
      ts
        .getPreEmitDiagnostics(final)
        .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')),
      [],
    );
    assert.ok(
      accepted.length > 0,
      `${provider}: ${accepted.length} executable probes for ${roots.length} public types`,
    );
    const js = file.replace('.ts', '.js');
    writeFileSync(
      js,
      ts.transpileModule(readFileSync(file, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.ESNext },
      }).outputText,
    );
    const consumer = await import(pathToFileURL(js));
    const runtimeModule = await import(pathToFileURL(join(output, 'node/runtime.js')));
    const runtimePlan = compileRuntimePlan({ operations: contract.operations.slice(0, 1) });
    const operation = runtimePlan.operations[0];
    operation.verb = 'GET';
    operation.authenticated = false;
    operation.bodyRequired = false;
    delete operation.authModes;
    delete operation.body;
    delete operation.pagination;
    delete operation.response;
    operation.parameters = [];
    operation.responses = {
      200: { bodyKind: 'json', mediaType: 'application/json', codec: ANY_CODEC },
    };
    delete operation.successJsonFallback;
    let body;
    let cases = 0;
    for (const [index, root] of roots.entries()) {
      operation.outputCertificate = root.certificate;
      const runtime = runtimeModule.runtimeFromPlan(runtimePlan, {
        baseUrl: 'https://example.invalid',
        transport: async () => new Response(JSON.stringify(body)),
      });
      for (const value of adversaries(root.explored.sample, root.explored.knownKeys)) {
        body = value;
        let result;
        try {
          result = await runtime.request(operation.id);
        } catch (error) {
          assert.equal(error.kind, 'protocol', `${root.name}: ${error.stack}`);
          assert.equal(error.raw, JSON.stringify(body));
        }
        if (result) {
          assert.ok(certifies(result.data, root.certificate), root.name);
          for (const p of accepted.filter((p) => p.root === index))
            assert.doesNotThrow(() => consumer[p.name](result.data), `${root.name}: ${p.source}`);
        }
        cases++;
      }
    }
    t.diagnostic(
      `${roots.length} public types, ${accepted.length} tsc-approved accesses, ${cases} generated values`,
    );
  });
}
