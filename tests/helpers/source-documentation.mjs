import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import {
  expectedPositions,
  parsedType,
  schemaFields,
  expectedType,
  typeLinks,
} from './documentation-expectations.mjs';

/** Read visible JSDoc/PHPDoc prose, rather than trusting renderer metadata. */
export function sourceFactRows(source) {
  return [...source.matchAll(/\/\*\*([\s\S]*?)\*\//g)]
    .map((comment) => {
      const text = comment[1]
        .replace(/\n\s*\* ?/g, ' ')
        .replace(/\n/g, ' ')
        .trim();
      const nested = [
        ...text.matchAll(
          /(\S+) \((Value|Required|Optional)\): ([\s\S]*?)(?= \S+ \((?:Value|Required|Optional)\):|$)/g,
        ),
      ].map((m) => {
        const body = m[3]
            .split(/\s+@(?:return|throws|see)\b/)[0]
            .trim()
            .replace(/\{@(?:link|see) (\w+)\}/g, '[$1](#model)'),
          type = body.match(/^(.*?)\.(?: |$)/)?.[1];
        assert.ok(type, `invalid source shape at ${m[1]}`);
        const notes = body.slice(type.length + 1).trim();
        const enums = [...notes.matchAll(/(\S+) enum: ([\s\S]*?)\.(?= \S+ enum:|$)/g)].map(
          (entry) => ({
            path: entry[1] === 'Value' ? '' : entry[1],
            values: JSON.parse('[' + entry[2] + ']').map((v) => JSON.stringify(v)),
          }),
        );
        return {
          path: m[1].startsWith('[') ? '$' + m[1] : '$.' + m[1],
          presence: m[2],
          type: parsedType(type),
          links: [...type.matchAll(/\[([^\]]+)\]\([^)]+\)/g)].map((m) => m[1]).sort(),
          constraints: [
            ...notes.matchAll(
              /\b(format|minimum|maximum|exclusiveMinimum|exclusiveMaximum|multipleOf|minLength|maxLength|minItems|maxItems|minProperties|maxProperties|uniqueItems|pattern): (.*?)(?:\.(?= |$))/gi,
            ),
          ]
            .map((m) => `${m[1].toLowerCase()}:${m[2]}`)
            .sort(),
          enums,
          notes,
        };
      });
      const notes = text
        .split(/\S+ \((?:Value|Required|Optional)\):|\s+@(?:return|throws|see)\b/)[0]
        .trim();
      const enums = [...notes.matchAll(/(\S+) enum: ([\s\S]*?)\.(?= \S+ enum:|$)/g)].map(
        (entry) => ({
          path: entry[1] === 'Value' ? '' : entry[1],
          values: JSON.parse('[' + entry[2] + ']').map((value) => JSON.stringify(value)),
        }),
      );
      const constraints = [
        ...notes.matchAll(
          /\b(format|minimum|maximum|exclusiveMinimum|exclusiveMaximum|multipleOf|minLength|maxLength|minItems|maxItems|minProperties|maxProperties|uniqueItems|pattern): (.*?)(?:\.(?= |$))/gi,
        ),
      ]
        .map((m) => `${m[1].toLowerCase()}:${m[2]}`)
        .sort();
      return [
        { path: '$', presence: 'Value', type: null, links: [], notes, enums, constraints },
        ...nested,
      ];
    })
    .filter((rows) => rows.length);
}
export function assertSourceFieldDocumentation(source, schema, definitions, names) {
  const expected = expectedPositions(schema, definitions, names);
  const comments = sourceFactRows(source);
  const match = (actual, row) =>
    actual.path === row.path &&
    actual.presence === row.presence &&
    (row.path === '$' ||
      (JSON.stringify(actual.type) === JSON.stringify(row.type) &&
        JSON.stringify(actual.links) === JSON.stringify(row.links))) &&
    JSON.stringify([...new Set(actual.constraints)]) === JSON.stringify(row.constraints) &&
    JSON.stringify(actual.enums) === JSON.stringify(row.enums) &&
    row.descriptions.every((d) =>
      actual.notes.includes(d.replaceAll('*/', '* /').replace(/[\r\n]+/g, ' ')),
    ) &&
    row.defaults.every((d) => actual.notes.includes('Default: ' + d + '.'));
  assert.ok(
    comments.some((rows) => expected.every((row) => rows.some((actual) => match(actual, row)))),
    `source documentation lost a fact: ${JSON.stringify(expected)}`,
  );
  return expected.length;
}

/** Certify nullable named values in their own declaration/getter comments.
 * Optional-getter return null is separate from schema-value nullability. */
export function assertNamedNullabilitySource(directory, inventory) {
  const { models, definitions, outputNames } = inventory;
  const hasModel = (t) =>
    t.kind === 'model' ||
    !!(t.item && hasModel(t.item)) ||
    !!(t.value && hasModel(t.value)) ||
    (t.branches ?? []).some(hasModel);
  const hasNull = (t) =>
    !!t.nullable ||
    t.kind === 'null' ||
    !!(t.item && hasNull(t.item)) ||
    !!(t.value && hasNull(t.value)) ||
    (t.branches ?? []).some(hasNull);
  const declarations = new Map();
  if (!directory.endsWith('/php'))
    for (const file of readdirSync(join(directory, 'declarations')).filter((n) =>
      n.endsWith('.d.ts'),
    )) {
      const source = ts.createSourceFile(
        file,
        readFileSync(join(directory, 'declarations', file), 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      for (const node of source.statements)
        if (ts.isTypeAliasDeclaration(node)) declarations.set(node.name.text, node.type);
    }
  let checked = 0;
  for (const model of models) {
    if (!model.response) continue;
    const fields = schemaFields(model.schema, definitions, new Set(), true).fields;
    const comments = sourceModelFields(directory, model.name, declarations);
    for (const [field, schema] of Object.entries(fields)) {
      if (schema.writeOnly) continue;
      const type = expectedType(schema, definitions, outputNames);
      if (!hasModel(type) || !hasNull(type)) continue;
      const candidates = comments.get(field) ?? [];
      assert.ok(
        candidates.some(
          (text) => /\bnull\b/.test(text) && typeLinks(type).every((name) => text.includes(name)),
        ),
        `${model.name}.${field}: declaration lost nullable named value`,
      );
      checked++;
    }
  }
  return checked;
}

function sourceModelFields(directory, name, declarations) {
  const result = new Map();
  const add = (field, text) => {
    const rows = result.get(field) ?? [];
    rows.push(text);
    result.set(field, rows);
  };
  if (directory.endsWith('/php')) {
    const text = readFileSync(join(directory, 'src/classes', name + '.php'), 'utf8');
    for (const m of text.matchAll(
      /(\/\*\*[\s\S]*?\*\/)\s*public function \w+\(\): [^{]+\{ return \$this->get\('([^']+)'\); \}/g,
    ))
      add(m[2], m[1]);
  } else {
    const seen = new Set();
    const visit = (node) => {
      if (seen.has(node)) return;
      seen.add(node);
      if (ts.isPropertySignature(node)) add(node.name.text, node.getFullText(node.getSourceFile()));
      else if (ts.isTypeReferenceNode(node) && declarations.has(node.typeName.getText()))
        visit(declarations.get(node.typeName.getText()));
      else ts.forEachChild(node, visit);
    };
    if (declarations.has(name)) visit(declarations.get(name));
  }
  return result;
}
