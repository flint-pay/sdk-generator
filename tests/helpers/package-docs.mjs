import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import MarkdownIt from 'markdown-it';

export function packageDocuments(directory) {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /(?:\.md|llms\.txt)$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

/** Read operation sections for assertions whose subject spans resources. */
export function readReference(source, target) {
  if (source instanceof Map)
    return [...source]
      .filter(
        ([name]) => name === `${target}/REFERENCE.md` || name.startsWith(`${target}/reference/`),
      )
      .map(([, text]) => text.replaceAll('](../', ']('))
      .join('\n');
  const directory = target ? join(source, target) : source;
  return [join(directory, 'REFERENCE.md'), ...packageDocuments(join(directory, 'reference'))]
    .map((path) => readFileSync(path, 'utf8').replaceAll('](../', ']('))
    .join('\n');
}

const markdown = new MarkdownIt();
const slug = (name) =>
  name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_\s-]/gu, '')
    .replace(/\s/g, '-');
export function assertPackageLinks(directory) {
  const documents = new Map(
    packageDocuments(directory).map((path) => [
      resolve(path),
      markdown.parse(readFileSync(path, 'utf8'), {}),
    ]),
  );
  const headings = new Map();
  for (const [path, tokens] of documents) {
    const ids = new Set();
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].type !== 'heading_open') continue;
      const base = slug(tokens[i + 1].content);
      let id = base;
      for (let suffix = 1; ids.has(id); suffix++) id = base + '-' + suffix;
      ids.add(id);
    }
    headings.set(path, ids);
  }
  for (const [path, tokens] of documents) {
    for (const token of tokens.flatMap((t) => t.children ?? [])) {
      if (token.type !== 'link_open') continue;
      const destination = token.attrGet('href');
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(destination)) continue;
      const [file, fragment] = destination.split('#');
      const target = file ? resolve(dirname(path), decodeURIComponent(file)) : path;
      assert.ok(
        !relative(resolve(directory), target).startsWith('..'),
        `${path}: link escapes package: ${destination}`,
      );
      assert.ok(existsSync(target), `${path}: missing link ${destination}`);
      if (fragment)
        assert.ok(
          headings.get(target)?.has(decodeURIComponent(fragment)),
          `${path}: missing anchor ${destination}`,
        );
    }
  }
}

/** Large field tables must have one canonical location per package. */
export function assertUniqueFieldTables(directory, minimumBytes = 256) {
  const seen = new Map();
  // No allowlist: navigation, policies and HTTP status tables are separate
  // justified repeated blocks, not model/request field definitions.
  for (const path of packageDocuments(directory)) {
    const source = readFileSync(path, 'utf8');
    const lines = source.split('\n');
    for (const token of markdown.parse(source, {})) {
      if (token.type !== 'table_open') continue;
      const [start, end] = token.map;
      const table = lines.slice(start, end).join('\n');
      if (!table.startsWith('| Field | Presence |') || Buffer.byteLength(table) < minimumBytes)
        continue;
      assert.ok(
        !seen.has(table),
        `repeated ${Buffer.byteLength(table)}-byte field table: ${seen.get(table)} and ${path}:${start + 1}`,
      );
      seen.set(table, `${path}:${start + 1}`);
    }
  }
  return seen.size;
}
