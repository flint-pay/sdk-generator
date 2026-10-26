import { packageDocuments, assertPackageLinks } from './package-docs.mjs';
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
  const root = checker.getSymbolAtLocation(program.getSourceFile(entry));
  const clientSymbol = checker.getExportsOfModule(root).find((symbol) => symbol.name === 'Client');
  const client = checker.getDeclaredTypeOfSymbol(
    clientSymbol.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(clientSymbol)
      : clientSymbol,
  );
  for (const resource of checker.getPropertiesOfType(client)) {
    const type = checker.getTypeOfSymbolAtLocation(
      resource,
      resource.valueDeclaration ?? program.getSourceFile(entry),
    );
    for (const method of checker.getPropertiesOfType(type)) {
      const declaration = method.valueDeclaration;
      assert.ok(
        declaration?.jsDoc?.some((doc) => doc.comment),
        `${resource.name}.${method.name} needs a summary`,
      );
      assert.ok(
        ts.getJSDocTags(declaration).some((tag) => tag.tagName.text === 'see'),
        `${resource.name}.${method.name} needs a reference link`,
      );
    }
  }
  assertPackageLinks(directory);
  const runtime = readFileSync(join(directory, 'RUNTIME.md'), 'utf8');
  for (const name of ['ClientOptions', 'RequestOptions']) {
    const symbol = checker.getExportsOfModule(root).find((item) => item.name === name);
    const type = checker.getDeclaredTypeOfSymbol(
      symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol,
    );
    const documented = runtime.split(`### ${name}\n`)[1].split('\n### ')[0].split('\n## ')[0];
    const fields = [...documented.matchAll(/^\| (\w+) \|/gm)]
      .map((match) => match[1])
      .filter((name) => name !== 'Field');
    assert.deepEqual(
      fields.sort(),
      checker
        .getPropertiesOfType(type)
        .map((item) => item.name)
        .sort(),
      `${name} option inventory`,
    );
  }
  const models = packageDocuments(directory)
    .filter((p) => p.endsWith('/MODELS.md') || /\/models\/.*\.md$/.test(p))
    .map((p) => readFileSync(p, 'utf8'))
    .join('\n');
  const headings = [...models.matchAll(/^## (\w+)$/gm)]
    .map((match) => match[1])
    .filter((name) => name !== 'Index');
  assert.ok(headings.length > 0);
  for (const name of headings)
    assert.ok(exports.has(name), `MODELS.md documents unexported ${name}`);
  for (const file of packageDocuments(directory)) {
    const document = readFileSync(file, 'utf8');
    for (const match of document.matchAll(/^### (\w+)\.(\w+)$/gm)) {
      const resource = checker.getPropertyOfType(client, match[1]);
      assert.ok(resource, `${file} documents unknown resource ${match[1]}`);
      const type = checker.getTypeOfSymbolAtLocation(
        resource,
        resource.valueDeclaration ?? program.getSourceFile(entry),
      );
      assert.ok(
        checker.getPropertyOfType(type, match[2]),
        `${file} documents unknown method ${match[1]}.${match[2]}`,
      );
    }
    for (const match of document.matchAll(
      /\[(\w+)\]\((?:\.\.\/)?(?:MODELS\.md|models\/\w+\.md)#[^)]+\)/g,
    )) {
      assert.ok(exports.has(match[1]), `${file} links unexported ${match[1]}`);
      assert.ok(headings.includes(match[1]), `${file} links missing model section ${match[1]}`);
    }
  }
}

/** PHP model names must identify emitted Composer-autoloaded classes. */
export function assertDocumentedPhpExports(directory) {
  assertPackageLinks(directory);
  const classes = new Set(
    readdirSync(join(directory, 'src/classes')).map((name) => name.replace(/\.php$/, '')),
  );
  for (const file of packageDocuments(directory)) {
    const document = readFileSync(file, 'utf8');
    if (file.endsWith('/MODELS.md') || /\/models\/.*\.md$/.test(file))
      for (const match of document.matchAll(/^## (\w+)$/gm))
        if (match[1] !== 'Index')
          assert.ok(classes.has(match[1]), `${file} documents missing class ${match[1]}`);
    for (const match of document.matchAll(
      /\[(\w+)\]\((?:\.\.\/)?(?:MODELS\.md|models\/\w+\.md)#[^)]+\)/g,
    ))
      assert.ok(classes.has(match[1]), `${file} links missing class ${match[1]}`);
  }
}
