import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import MarkdownIt from 'markdown-it';
import { packageDocuments } from './package-docs.mjs';
import { bodyReference, responseReference } from '../../dist/sdk-documentation.js';
import { payloadSchemas } from '../../dist/response-return.js';

const markdown = new MarkdownIt();
const slug = (value) =>
  value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_\s-]/gu, '')
    .replace(/\s/g, '-');

export function operationDocuments(directory) {
  return packageDocuments(join(directory, 'reference')).flatMap((path) =>
    [
      ...readFileSync(path, 'utf8').matchAll(/^### (\w+\.\w+)\n([\s\S]*?)(?=^### |$(?![\s\S]))/gm),
    ].map((match) => ({ path, name: match[1], source: match[2] })),
  );
}

export function linkedModelSections(path, source) {
  return [...source.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)].flatMap((match) => {
    const [file, fragment] = match[2].split('#');
    const destination = file ? resolve(dirname(path), file) : path;
    if (
      !fragment ||
      (!/(?:MODELS\.md|models\/\w+\.md)$/.test(destination) &&
        !(match[1] === 'shared fields' && /reference\/\w+\.md$/.test(destination)))
    )
      return [];
    const text = readFileSync(destination, 'utf8');
    const headings = [...text.matchAll(/^(#{2,6}) (.+)\n/gm)];
    const ids = new Set();
    const heading = headings.find((entry) => {
      const base = slug(entry[2]);
      let id = base;
      for (let suffix = 1; ids.has(id); suffix++) id = base + '-' + suffix;
      ids.add(id);
      return id === fragment;
    });
    assert.ok(heading, `missing canonical section ${match[2]}`);
    const next = headings.find(
      (entry) => entry.index > heading.index && entry[1].length <= heading[1].length,
    );
    return [
      {
        label: match[1],
        path: destination,
        source: text.slice(heading.index + heading[0].length, next?.index ?? text.length),
      },
    ];
  });
}

function fieldFacts(source, path) {
  const tokens = markdown.parse(source, {}),
    facts = [];
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].type !== 'tr_open') continue;
    const cells = [];
    while (tokens[++index]?.type !== 'tr_close') {
      if (tokens[index].type === 'inline') cells.push(tokens[index]);
    }
    if (cells.length !== 4 || !['Required', 'Optional', 'Conditional'].includes(cells[1].content))
      continue;
    const enums = cells[3].children
      .filter(
        (child) =>
          child.type === 'code_inline' && /^(?:"|true$|false$|null$|-?\d)/.test(child.content),
      )
      .map((child) => child.content);
    for (const [index, child] of cells[3].children.entries()) {
      if (
        child.type !== 'link_open' ||
        !/\d+ declared values/.test(cells[3].children[index + 1]?.content ?? '')
      )
        continue;
      const [file, fragment] = child.attrGet('href').split('#');
      const text = file && path ? readFileSync(resolve(dirname(path), file), 'utf8') : source;
      const lines = text.split('\n');
      const headings = new Set();
      const references = markdown.parse(text, {});
      for (let heading = 0; heading < references.length; heading++) {
        if (references[heading].type !== 'heading_open') continue;
        const base = slug(references[heading + 1].content);
        let id = base;
        for (let suffix = 1; headings.has(id); suffix++) id = base + '-' + suffix;
        headings.add(id);
        if (id !== fragment) continue;
        const start = references[heading].map[0];
        const end =
          references.slice(heading + 1).find((token) => token.type === 'heading_open')?.map[0] ??
          lines.length;
        enums.push(
          ...markdown
            .parse(lines.slice(start, end).join('\n'), {})
            .flatMap((token) => token.children ?? [])
            .filter((token) => token.type === 'code_inline')
            .map((token) => token.content),
        );
        break;
      }
    }
    facts.push({
      field: cells[0].children.find((child) => child.type === 'code_inline')?.content,
      presence: cells[1].content,
      enums,
    });
  }
  // Canonical definitions carry invariant facts; compact rules supply presence
  // and narrowed constraints without repeating descriptions and types.
  const definitions = new Map(facts.map((fact) => [fact.field, fact]));
  for (const token of tokens.filter((token) => token.type === 'inline')) {
    const presence = token.content.match(/^(Required|Optional): /)?.[1];
    const constraint = token.content.match(/^Constraints for `([^`]+)`: /)?.[1];
    const code = (token.children ?? []).filter((child) => child.type === 'code_inline');
    if (presence)
      for (const child of code) {
        const definition = definitions.get(child.content);
        // A requiredness bullet without a definition must not mask a lost field.
        if (definition) facts.push({ ...definition, presence });
      }
    if (constraint && definitions.has(constraint)) {
      const enums = code
        .slice(1)
        .filter((child) => /^(?:"|true$|false$|null$|-?\d)/.test(child.content))
        .map((child) => child.content);
      for (const fact of facts.filter((fact) => fact.field === constraint))
        fact.enums = [...new Set([...fact.enums, ...enums])];
    }
  }
  return facts;
}

/** Compare unsuppressed operation facts, independently of canonical rendering. */
export function assertCanonicalOperationDocumentation(directory, contract) {
  const definitions = contract.definitions ?? contract.models;
  let suppressed = 0,
    checkedFacts = 0;
  for (const operation of operationDocuments(directory)) {
    const op = contract.operations.find(
      (entry) => `${entry.resource}.${entry.method}` === operation.name,
    );
    assert.ok(op, operation.name);
    const [request, rest] = operation.source.split('#### Response\n');
    const response = rest.split('#### Errors\n')[0];
    for (const section of linkedModelSections(operation.path, request + response)) {
      assert.doesNotMatch(
        section.source,
        /Fields, types, descriptions and enum values:|Fields, descriptions and enum values are shared/,
        `${operation.name}: ${section.label} adds a second hop`,
      );
    }
    const outputs = op.response?.payloadPath
      ? payloadSchemas(op, definitions)
      : Object.entries(op.responses)
          .filter(([status]) => /^(?:2\d\d|2XX)$/.test(status))
          .flatMap(([, entry]) => (entry.schema ? [entry.schema] : []));
    for (const [section, original] of [
      [request, bodyReference(op, definitions)],
      [
        response,
        outputs.map((schema) => responseReference(schema, definitions, operation.name)).join(''),
      ],
    ]) {
      // The old request renderer also printed an incomplete common view before
      // applying alternatives (e.g. an "optional" discriminator required by
      // every branch). Compare its complete effective variant tables instead.
      const variant = original.search(/^#{4,5} .* variant /m);
      const oldFacts = fieldFacts(variant < 0 ? original : original.slice(variant));
      if (!oldFacts.length) continue;
      const matches = (entry, fact) =>
        entry.field === fact.field &&
        entry.presence === fact.presence &&
        fact.enums.every((value) => entry.enums.includes(value));
      const inline = fieldFacts(section, operation.path);
      // Check each missing fact, including mixed inline/named responses.
      if (oldFacts.every((fact) => inline.some((entry) => matches(entry, fact)))) continue;
      const linked = linkedModelSections(operation.path, section);
      assert.ok(linked.length, `${operation.name}: suppressed fields need a canonical link`);
      const facts = [...inline, ...linked.flatMap((model) => fieldFacts(model.source, model.path))];
      for (const fact of oldFacts) {
        assert.ok(
          facts.some((entry) => matches(entry, fact)),
          `${operation.name}: lost ${JSON.stringify(fact)} in canonical docs`,
        );
        checkedFacts++;
      }
      suppressed++;
    }
  }
  return { suppressed, checkedFacts };
}
