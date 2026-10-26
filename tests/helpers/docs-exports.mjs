import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

/** Check documentation against the declarations consumers actually import. */
export function assertDocumentedModelExports(directory) {
  const entry = join(directory, 'index.d.ts');
  const program = ts.createProgram([entry], { module: ts.ModuleKind.NodeNext });
  const checker = program.getTypeChecker();
  const exports = new Set(
    checker
      .getExportsOfModule(checker.getSymbolAtLocation(program.getSourceFile(entry)))
      .map((symbol) => symbol.name),
  );
  const models = readFileSync(join(directory, 'MODELS.md'), 'utf8');
  const headings = [...models.matchAll(/^## (\w+)$/gm)].map((match) => match[1]);
  assert.ok(headings.length > 0);
  for (const name of headings)
    assert.ok(exports.has(name), `MODELS.md documents unexported ${name}`);
  for (const file of readdirSync(directory).filter((name) => name.endsWith('.md'))) {
    const document = readFileSync(join(directory, file), 'utf8');
    for (const match of document.matchAll(/\[(\w+)\]\(MODELS\.md#[^)]+\)/g)) {
      assert.ok(exports.has(match[1]), `${file} links unexported ${match[1]}`);
      assert.ok(headings.includes(match[1]), `${file} links missing model section ${match[1]}`);
    }
  }
}
