import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const semantic = new Set([
  'canonical',
  'diagnostic',
  'codec-plan',
  'codec-sharing',
  'runtime-plan',
  'schema-policy',
  'schema-intersections',
  'target-types',
  'schema-documentation',
  'target-plan',
  'value-guarantee',
  'response-plan',
  'response-return',
  'response-compatibility',
  'compiled-compatibility',
  'compiled-record',
  'compatibility',
]);
function source(name) {
  return ts.createSourceFile(
    name,
    readFileSync(new URL('../src/' + name, import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
}
function visit(node, inspect) {
  inspect(node);
  ts.forEachChild(node, (child) => visit(child, inspect));
}

test('semantic modules have effect-free dependencies and no implementation cycles', () => {
  const graph = new Map();
  for (const name of semantic) {
    const edges = [];
    const file = source(name + '.ts');
    visit(file, (node) => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        if (!node.moduleSpecifier || node.isTypeOnly || node.importClause?.isTypeOnly) return;
        const bindings = node.importClause?.namedBindings;
        if (
          bindings &&
          ts.isNamedImports(bindings) &&
          !node.importClause.name &&
          bindings.elements.every((e) => e.isTypeOnly)
        )
          return;
        const dependency = node.moduleSpecifier.text.replace(/^\.\//, '').replace(/\.js$/, '');
        assert.ok(
          semantic.has(dependency),
          `${name} must not depend on implementation ${dependency}`,
        );
        edges.push(dependency);
      }
      if (ts.isCallExpression(node)) {
        assert.notEqual(
          node.expression.kind,
          ts.SyntaxKind.ImportKeyword,
          name + ': dynamic imports bypass boundaries',
        );
        assert.ok(
          !['require', 'fetch', 'setTimeout', 'setInterval'].includes(
            node.expression.getText(file),
          ),
          name + ': effectful call',
        );
      }
      if (ts.isPropertyAccessExpression(node))
        assert.ok(
          !['process.env', 'Date.now', 'Math.random', 'globalThis.process'].includes(
            node.getText(file),
          ),
          name + ': ambient effects',
        );
    });
    graph.set(name, edges);
  }
  function walk(name, path) {
    assert.ok(!path.includes(name), 'Implementation cycle: ' + [...path, name].join(' -> '));
    for (const child of graph.get(name)) walk(child, [...path, name]);
  }
  for (const name of semantic) walk(name, []);
});

test('compiled executor entry points never call dynamic schema adapters', () => {
  const file = source('runtime.ts');
  const names = new Set([
    'executeCodec',
    'executeNode',
    'numericView',
    'jointNumericView',
    'numericViewChanged',
    'selectAlternatives',
    'redactCodec',
    'isKnownCodec',
  ]);
  for (const statement of file.statements) {
    if (!ts.isFunctionDeclaration(statement) || !names.has(statement.name?.text)) continue;
    names.delete(statement.name.text);
    visit(statement, (node) => {
      if (ts.isCallExpression(node))
        assert.ok(
          !['normalize', 'redact', 'isKnownVariant', 'compileCodec', 'compileRuntimePlan'].includes(
            node.expression.getText(file),
          ),
          statement.name.text + ' calls schema adapter',
        );
    });
  }
  assert.equal(names.size, 0);
  const renderer = source('generate.ts');
  for (const statement of renderer.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    assert.ok(
      !['./codec-plan.js', './target-types.js', './response-plan.js', './runtime-plan.js'].includes(
        statement.moduleSpecifier.text,
      ),
      'Renderer imports semantic derivation',
    );
  }
});

test('PHP compiled execution is isolated from schema lowering and dispatches every instruction', async () => {
  const { spawnSync } = await import('node:child_process');
  const program = String.raw`
    $tokens=token_get_all(file_get_contents($argv[1]));$methods=[];
    for($i=0;$i<count($tokens);$i++){
      if(!is_array($tokens[$i])||$tokens[$i][0]!==T_FUNCTION)continue;
      while(++$i<count($tokens)&&is_array($tokens[$i])&&$tokens[$i][0]===T_WHITESPACE){}
      if(!is_array($tokens[$i])||$tokens[$i][0]!==T_STRING)continue;
      $name=$tokens[$i][1];while($i<count($tokens)&&$tokens[$i]!=='{')$i++;
      $depth=1;$body=[];
      while(++$i<count($tokens)&&$depth){$token=$tokens[$i];if($token==='{')$depth++;elseif($token==='}')$depth--;if($depth)$body[]=is_array($token)?[token_name($token[0]),$token[1]]:$token;}
      $methods[$name]=$body;
    }
    echo json_encode($methods,JSON_THROW_ON_ERROR);
  `;
  const result = spawnSync(
    'php',
    ['-r', program, new URL('../templates/Runtime.php', import.meta.url).pathname],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  const methods = JSON.parse(result.stdout);
  for (const name of [
    'execute',
    'executeValue',
    'executeNode',
    'numericView',
    'jointNumericView',
    'numericViewChanged',
    'selectAlternatives',
    'redactPlan',
  ]) {
    assert.ok(methods[name]);
    for (const token of methods[name])
      if (Array.isArray(token) && token[0] === 'T_STRING')
        assert.ok(
          !['compile', 'normalize', 'redact', 'SchemaAdapter'].includes(token[1]),
          name + ' references schema lowering',
        );
  }
  const file = source('codec-plan.ts');
  const instruction = file.statements.find(
    (node) => ts.isTypeAliasDeclaration(node) && node.name.text === 'ValueInstruction',
  );
  const kinds = instruction.type.types.map(
    (node) => node.members.find((member) => member.name.text === 'kind').type.literal.text,
  );
  const dispatch = methods.wireKind
    .filter((token) => Array.isArray(token) && token[0] === 'T_CONSTANT_ENCAPSED_STRING')
    .map((token) => token[1].slice(1, -1));
  for (const kind of kinds)
    assert.ok(dispatch.includes(kind), 'PHP lacks codec instruction ' + kind);
});

test('new compiled assertions and stream descriptors reject malformed serialized instructions', async () => {
  const { compileCodec, assertCodecPlan, CODEC_FORMAT, CODEC_SEMANTICS } = await import(
    '../dist/codec-plan.js'
  );
  const { assertRuntimePlan } = await import('../dist/runtime-plan.js');
  const codec = compileCodec({
    type: 'object',
    const: {},
    minProperties: 0,
    maxProperties: 0,
    if: { required: ['x'] },
    then: { properties: { x: { const: true } } },
  });
  assert.doesNotThrow(() => assertCodecPlan(codec));
  for (const patch of [
    { literal: '{' },
    { literal: {} },
    { when: {} },
    { when: { test: codec, then: false } },
    { includes: false },
    { tagValues: [1] },
    { numberInput: 'explicit' },
    { numberInput: 'guess' },
    { checks: { multipleOf: 0 } },
    { checks: { multipleOf: Infinity } },
    { checks: { uniqueItems: 1 } },
    { checks: { minProperties: -1 } },
    { checks: { maxProperties: 0.1 } },
  ])
    assert.throws(() => assertCodecPlan({ ...codec, ...patch }), /invalid compiled codec/);
  const runtime = { format: CODEC_FORMAT, semantics: CODEC_SEMANTICS, operations: [] };
  assert.doesNotThrow(() => assertRuntimePlan(runtime));
  for (const patch of [
    { streamEventSchemas: {} },
    { streamEventCodecs: { ready: false } },
    { stream: { idleTimeoutMs: 0, maxEventBytes: 1 } },
    { stream: { idleTimeoutMs: 1, maxEventBytes: -1 } },
  ])
    assert.throws(() =>
      assertRuntimePlan({
        ...runtime,
        operations: [{ id: 'watch', path: '/events', verb: 'get', parameters: [], ...patch }],
      }),
    );
});
