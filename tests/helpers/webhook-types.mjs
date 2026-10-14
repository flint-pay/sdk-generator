import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';

/** Compiler API checks on a generated package, including an exhaustive consumer. */
export function measureWebhookTypes(directory, eventTypes, phpEventModels, typeField) {
  const events = Object.keys(eventTypes);
  assert.ok(!typeField.includes('.'), 'exhaustive switch measurement requires a top-level tag');
  const literalCount = (text) =>
    new Set(
      [...text.matchAll(/["']([^"']*)["']/g)]
        .map((m) => m[1])
        .filter((name) => events.includes(name)),
    ).size;
  const owned = new Set(['KnownWebhookEvent', 'VerifiedWebhook', ...Object.values(eventTypes)]);
  const root = readFileSync(join(directory, 'index.d.ts'), 'utf8');
  for (const name of owned)
    assert.ok(root.includes(`export type { ${name} }`), name + ' missing root type export');
  const declarations = join(directory, 'declarations');
  let bytes = 0;
  for (const file of readdirSync(declarations)) {
    if (
      !file.endsWith('.d.ts') ||
      !(owned.has(file.slice(0, -5)) || file.startsWith('_SdkWebhookEnvelope'))
    )
      continue;
    const content = readFileSync(join(declarations, file), 'utf8');
    bytes += Buffer.byteLength(content);
    assert.ok(literalCount(content) < 10, file + ' repeats event-name literals');
  }
  assert.ok(bytes <= 256 * 1024, `webhook-owned declarations: ${bytes} bytes`);
  const client = readFileSync(join(declarations, 'Client.d.ts'), 'utf8');
  const signature = client.match(/verifyWebhook\([^\n]+/)[0];
  assert.ok(signature.length <= 200, `verifyWebhook signature: ${signature.length} characters`);
  const file = join(directory, '_webhook-types.ts');
  writeFileSync(
    file,
    `import {Client} from './index.js';
declare const client:Client;
const verified=client.verifyWebhook(new Uint8Array(),new Headers(),'synthetic');
if(verified.known) {
 const event=verified.event;
 switch(event[${JSON.stringify(typeField)}]) {
 ${events.map((name, index) => `case ${JSON.stringify(name)}: { const narrowed${index}=event; break; }`).join('\n')}
 default: { const exhaustive:never=event; }
 }
}
`,
  );
  try {
    const program = ts.createProgram([file], {
      strict: true,
      noEmit: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      typeRoots: [resolve('node_modules/@types')],
    });
    const diagnostics = ts.getPreEmitDiagnostics(program);
    assert.equal(
      diagnostics.length,
      0,
      ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCanonicalFileName: (f) => f,
        getCurrentDirectory: () => process.cwd(),
        getNewLine: () => '\n',
      }),
    );
    const checker = program.getTypeChecker();
    const displays = new Map();
    const source = program.getSourceFile(file);
    const visit = (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name))
        displays.set(
          node.name.text,
          checker.typeToString(
            checker.getTypeAtLocation(node.name),
            node,
            ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope,
          ),
        );
      ts.forEachChild(node, visit);
    };
    visit(source);
    assert.equal(displays.get('verified'), 'VerifiedWebhook');
    assert.equal(displays.get('event'), 'KnownWebhookEvent');
    let largestNarrowed = 0;
    let namedPhpEvents = 0;
    for (const [index, event] of events.entries()) {
      const display = displays.get('narrowed' + index);
      largestNarrowed = Math.max(largestNarrowed, display.length);
      assert.ok(literalCount(display) < 10, event + ' hover repeats event-name literals');
      if (phpEventModels[event]) {
        assert.equal(eventTypes[event], phpEventModels[event], event + ' PHP/Node naming');
        assert.equal(display, eventTypes[event], event + ' narrowed hover');
        namedPhpEvents++;
      }
    }
    for (const file of readdirSync(join(directory, 'resources'))) {
      if (!file.endsWith('.d.ts')) continue;
      const source = ts.createSourceFile(
        file,
        readFileSync(join(directory, 'resources', file), 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      );
      for (const statement of source.statements) {
        if (
          !ts.isExportDeclaration(statement) ||
          !statement.exportClause ||
          !ts.isNamedExports(statement.exportClause)
        )
          continue;
        for (const binding of statement.exportClause.elements)
          assert.ok(!owned.has(binding.name.text), file + ' exports ' + binding.name.text);
      }
    }
    return {
      signatureCharacters: signature.length,
      webhookDeclarationBytes: bytes,
      verifiedDisplay: displays.get('verified'),
      eventDisplay: displays.get('event'),
      largestNarrowedCharacters: largestNarrowed,
      namedPhpEvents,
      events: events.length,
      diagnostics: diagnostics.length,
    };
  } finally {
    rmSync(file, { force: true });
  }
}
