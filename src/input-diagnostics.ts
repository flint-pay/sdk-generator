import { Diagnostic } from './diagnostic.js';

/** Resolve synthetic/missing fields to the nearest existing input node and its file. */
export function locateDiagnostic(
  finding: Diagnostic,
  documents: readonly { source: string; value: unknown }[],
  prefix = '',
): Diagnostic {
  const parts = finding.location.slice(prefix.length).split('/').slice(1);
  let best: { source: string; length: number } | undefined;
  for (const document of documents) {
    let value = document.value,
      length = 0;
    for (const part of parts) {
      const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
      if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) break;
      value = Reflect.get(value, key);
      length++;
    }
    if (!best || length > best.length) best = { source: document.source, length };
  }
  if (!best) return finding;
  const location = prefix + (best.length ? '/' + parts.slice(0, best.length).join('/') : '');
  const result = new Diagnostic(
    location,
    finding.detail + (best.length < parts.length ? ` (Set or correct ${finding.location}.)` : ''),
  );
  result.source = best.source;
  return result;
}
