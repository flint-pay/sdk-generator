import assert from 'node:assert/strict';
import { expectedPositions, parsedType } from './documentation-expectations.mjs';

/** Read visible JSDoc/PHPDoc prose, rather than trusting renderer metadata. */
export function sourceFactRows(source) {
  return [...source.matchAll(/\/\*\*([\s\S]*?)\*\//g)]
    .map((comment) => {
      const text = comment[1]
        .replace(/\n\s*\* ?/g, ' ')
        .replace(/\n/g, ' ')
        .trim();
      return [
        ...text.matchAll(
          /Shape (\S+) \((Value|Required|Optional)\): ([\s\S]*?)(?= Shape \S+ \((?:Value|Required|Optional)\):|$)/g,
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
          path: m[1],
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
    })
    .filter((rows) => rows.length);
}
export function assertSourceFieldDocumentation(source, schema, definitions, names) {
  const expected = expectedPositions(schema, definitions, names);
  const comments = sourceFactRows(source);
  const match = (actual, row) =>
    actual.path === row.path &&
    actual.presence === row.presence &&
    JSON.stringify(actual.type) === JSON.stringify(row.type) &&
    JSON.stringify(actual.links) === JSON.stringify(row.links) &&
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
