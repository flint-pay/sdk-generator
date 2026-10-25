import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const digest = (value) => createHash('sha256').update(value).digest('hex');
export const sortedEntries = (entries) => [...entries].sort(([a], [b]) => a.localeCompare(b, 'en'));
export const hashEntries = (entries) =>
  digest(
    sortedEntries(entries)
      .map(([path, text]) => path + '\n' + text)
      .join('\n'),
  );
export const runtimeEntries = (files, target, runtimeOnly = false) =>
  [...files].filter(([path]) =>
    target === 'node'
      ? path.startsWith('node/') && path.endsWith('.js')
      : path.startsWith('php/') &&
        (!runtimeOnly || (!path.endsWith('.md') && !path.includes('/examples/'))),
  );
export const declarationEntries = (files) =>
  [...files].filter(
    ([path]) =>
      path === 'node/index.d.ts' || /^node\/(declarations|resources)\/.*\.d\.ts$/.test(path),
  );
export const signatureEntries = (text, namespace) =>
  Object.entries(JSON.parse(text)).map(([name, signature]) => [
    'php/src/classes/' + name.slice(namespace.length + 1).replaceAll('\\', '/') + '.php',
    JSON.stringify(signature, null, 2),
  ]);
const lines = (text) => text.split('\n');
// Short line fingerprints locate diagnostic hunks only; full SHA-256 hashes remain authoritative.
const lineHashes = (text) =>
  lines(text)
    .map((line) => digest(line).slice(0, 8))
    .join('');

export function recordFiles(manifest, label, entries) {
  manifest.groups[label] = {};
  for (const [path, text] of sortedEntries(entries)) {
    const hash = digest(text);
    manifest.groups[label][path] = hash;
    manifest.contents[hash] ??= { bytes: Buffer.byteLength(text), lines: lineHashes(text) };
  }
}

export function diffFiles(manifest, label, entries) {
  const previous = manifest.groups[label];
  if (!previous) return ['Missing file inventory for ' + label];
  const current = new Map(entries);
  const changes = [];
  for (const path of [...new Set([...Object.keys(previous), ...current.keys()])].sort()) {
    const text = current.get(path);
    const oldHash = previous[path];
    if (text === undefined) {
      changes.push(`- ${path} (removed)`);
      continue;
    }
    if (!oldHash) {
      changes.push(`+ ${path} (added, ${Buffer.byteLength(text)} bytes)`);
      continue;
    }
    if (digest(text) === oldHash) continue;
    const old = manifest.contents[oldHash];
    const before = old.lines.match(/.{8}/g) ?? [];
    const after = lineHashes(text).match(/.{8}/g) ?? [];
    let start = 0,
      end = 0;
    while (start < Math.min(before.length, after.length) && before[start] === after[start]) start++;
    while (
      end < Math.min(before.length, after.length) - start &&
      before.at(-1 - end) === after.at(-1 - end)
    )
      end++;
    const removed = before.length - start - end;
    const added = after.length - start - end;
    changes.push(
      `~ ${path} (${old.bytes} -> ${Buffer.byteLength(text)} bytes)\n  @@ -${start + 1},${removed} +${start + 1},${added} @@\n  - [${removed} reviewed lines replaced/removed]\n` +
        lines(text)
          .slice(start, start + Math.min(added, 6))
          .map((line) => '  + ' + line.slice(0, 200))
          .join('\n') +
        (added > 6 ? `\n  ... ${added - 6} more current lines` : ''),
    );
  }
  return changes;
}

export class OutputBaselines {
  constructor(
    manifest = JSON.parse(readFileSync('tests/fixtures/output-file-baseline.json', 'utf8')),
  ) {
    this.manifest = manifest;
    this.failures = [];
  }
  check(label, entries, expected, rawContent) {
    const actual = rawContent === undefined ? hashEntries(entries) : digest(rawContent);
    const changes = diffFiles(this.manifest, label, entries);
    if (actual !== expected || changes.length)
      this.failures.push(
        `${label}: expected ${expected}, got ${actual}\n${changes.join('\n') || 'Aggregate hash changed; file inventory is unchanged.'}`,
      );
  }
  finish() {
    if (this.failures.length)
      throw new Error(
        `Output baselines changed (${this.failures.length} groups):\n\n${this.failures.join('\n\n')}\n\nReview the changes, then run npm run baselines:update. Hunk previews show current text; prior text is represented by reviewed line fingerprints.`,
      );
  }
}
