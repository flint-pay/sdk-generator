import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

/** Inspect emitted calls independently of the generator's sampler. */
export function assertRunnableExamples(output, operations) {
  const byCall = new Map(operations.map((op) => [`client.${op.resource}.${op.method}`, op]));
  let calls = 0;
  const inspect = (text, filename) => {
    const source = ts.createSourceFile(
      filename,
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        const op = byCall.get(node.expression.getText(source));
        if (op) {
          calls++;
          const count = [...op.path.matchAll(/\{[^}]+\}/g)].length;
          for (const argument of node.arguments.slice(0, count)) {
            assert.ok(
              !ts.isStringLiteral(argument) ||
                (argument.text !== 'example' && !argument.text.endsWith('_example')),
              filename + ': invalid path ID',
            );
            if (ts.isStringLiteral(argument) && argument.text.includes('_'))
              assert.match(
                argument.text,
                /^[a-z][a-z0-9]*_[0-7][0-9A-HJKMNP-TV-Z]{25}$/,
                filename + ': invalid ID format',
              );
          }
          if (op.verb === 'PATCH') {
            const body = node.arguments[count];
            assert.ok(
              body && ts.isObjectLiteralExpression(body) && body.properties.length,
              filename + ': empty PATCH',
            );
          }
        }
      }
      if (ts.isPropertyAssignment(node) && ts.isStringLiteral(node.initializer)) {
        const name = node.name.getText(source).replaceAll('"', '');
        if (name.endsWith('_id'))
          assert.ok(
            node.initializer.text !== 'example' && !node.initializer.text.endsWith('_example'),
            filename + ': invalid request resource ID',
          );
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  };
  for (const op of operations) {
    const file = op.resource + '-' + op.method + '.mjs';
    inspect(readFileSync(join(output, 'node/examples', file), 'utf8'), file);
  }
  for (const file of [
    ...readdirSync(join(output, 'node/declarations')).map((f) => 'declarations/' + f),
    ...readdirSync(join(output, 'node/resources')).map((f) => 'resources/' + f),
  ]) {
    if (!file.endsWith('.d.ts')) continue;
    const text = readFileSync(join(output, 'node', file), 'utf8');
    for (const match of text.matchAll(/@example\n([\s\S]*?)\*\//g))
      inspect(match[1].replace(/^\s*\* ?/gm, ''), file);
  }
  assert.ok(calls >= operations.length * 2, 'check scripts and declaration examples');
  return { calls, invalidIdExamples: 0, emptyPatchBodies: 0 };
}
