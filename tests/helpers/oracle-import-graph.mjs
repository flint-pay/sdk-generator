import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import ts from 'typescript';

/** Follow static imports/re-exports and literal dynamic imports with a real JS
 * parser. Public generation/loading belongs to the test harness, never this
 * expectation/parser graph, so there is no production-module allowlist. */
export function assertIndependentOracleGraph(entries) {
  const seen = new Set();
  const visit = (path) => {
    path = resolve(path);
    if (seen.has(path)) return;
    seen.add(path);
    assert.ok(!/(?:^|\/)(?:src|dist)\//.test(path), 'oracle reaches production module: ' + path);
    const source = ts.createSourceFile(
      path,
      readFileSync(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const follow = (value) => {
      if (value.startsWith('.')) visit(resolve(dirname(path), value));
    };
    const walk = (node) => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        follow(node.moduleSpecifier.text);
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        assert.equal(node.arguments.length, 1);
        assert.ok(
          ts.isStringLiteral(node.arguments[0]),
          'oracle dynamic imports must be auditable',
        );
        follow(node.arguments[0].text);
      }
      ts.forEachChild(node, walk);
    };
    walk(source);
  };
  for (const path of entries) visit(path);
  return [...seen].sort();
}
