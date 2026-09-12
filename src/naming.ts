/** Split OpenAPI camelCase, acronym, snake_case and human-readable tags consistently. */
function words(value: string): string[] {
  return value
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}
const camel = (parts: string[]) =>
  parts.map((part, i) => (i ? part[0]!.toUpperCase() + part.slice(1) : part)).join('');
function singular(value: string): string {
  if (value.endsWith('ies')) return value.slice(0, -3) + 'y';
  if (/(?:ches|shes|xes|zes|sses)$/.test(value)) return value.slice(0, -2);
  return value.endsWith('s') && !/(?:ss|us|is)$/.test(value) ? value.slice(0, -1) : value;
}

/** Only shorten a method when exactly one tag matches its resource words. */
export function operationNames(id: string, tags: unknown): { resource: string; method: string } {
  const parts = words(id);
  const candidates = new Map<string, { resource: string; method: string }>();
  if (Array.isArray(tags))
    for (const tag of tags) {
      if (typeof tag !== 'string') continue;
      const resourceWords = words(tag);
      if (!resourceWords.length || !/^[a-z]/.test(resourceWords[0]!)) continue;
      for (let start = 1; start + resourceWords.length <= parts.length; start++) {
        if (!resourceWords.every((word, i) => singular(word) === singular(parts[start + i]!)))
          continue;
        const resource = camel(resourceWords);
        const method = camel([
          ...parts.slice(0, start),
          ...parts.slice(start + resourceWords.length),
        ]);
        candidates.set(resource + '.' + method, { resource, method });
      }
    }
  return candidates.size === 1 ? [...candidates.values()][0]! : { resource: 'api', method: id };
}

/** Reserve explicit names first; generated Input helpers must not shadow source models. */
export function modelNames(originals: string[], overrides: Record<string, string> = {}) {
  const names = new Map<string, string>();
  const occupied = new Set<string>();
  const reserve = (original: string, name: string) => {
    names.set(original, name);
    occupied.add(name.toLowerCase());
    occupied.add((name + 'Input').toLowerCase());
  };
  for (const original of originals.slice().sort())
    if (Object.hasOwn(overrides, original)) reserve(original, overrides[original]!);
    else if (!original.endsWith('Input')) reserve(original, original);
  for (const original of originals.slice().sort()) {
    if (names.has(original)) continue;
    const base = original.slice(0, -5) + 'Request';
    let name = base;
    let suffix = 1;
    while (occupied.has(name.toLowerCase()) || occupied.has((name + 'Input').toLowerCase()))
      name = base + 'Model' + (suffix++ === 1 ? '' : suffix - 1);
    reserve(original, name);
  }
  return names;
}
