const identifier = /^[A-Za-z][A-Za-z0-9_]*$/;
const reserved = new Set(
  'class function public private protected static new default delete constructor prototype then tostring valueof tojson catch finally call request close pages items wait verifywebhook verifywebhookasync verifywebhookdelivery money client runtime model result sdkerror codec rawnumber cancellation clientoptions requestoptions namespace use match enum readonly trait interface extends implements clone throw return const var let await yield list echo print empty isset unset true false null string int bool float mixed void never object array iterable self parent static abstract final break case continue declare die do else elseif enddeclare endfor endforeach endif endswitch endwhile eval exit for foreach global goto if include include_once instanceof insteadof require require_once switch try while xor and or switch'.split(
    ' ',
  ),
);
/** Apply the same public identifier rules to inference and contract validation. */
export function isPublicName(value: unknown, method = false): value is string {
  return (
    typeof value === 'string' &&
    identifier.test(value) &&
    (!reserved.has(value.toLowerCase()) ||
      (method && ['list', 'delete', 'void', 'close'].includes(value.toLowerCase())))
  );
}

/** Split OpenAPI camelCase, acronym, snake_case and human-readable tags consistently. */
function words(value: string): string[] {
  return value
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

export function kebabWords(value: string): string {
  return words(value).join('-');
}

export function pascalWords(value: string): string {
  return words(value)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join('');
}

/** Public webhook identities shared by Node event types and PHP event classes. */
export function webhookEventTypeName(
  event: string,
  occupied: ReadonlySet<string> = new Set(),
): string {
  const base = pascalWords(event);
  return base + (occupied.has((base + 'Event').toLowerCase()) ? 'WebhookEvent' : 'Event');
}
const camel = (parts: string[]) =>
  parts.map((part, i) => (i ? part[0]!.toUpperCase() + part.slice(1) : part)).join('');
function singular(value: string): string {
  if (value.endsWith('ies')) return value.slice(0, -3) + 'y';
  if (/(?:ches|shes|xes|zes|sses)$/.test(value)) return value.slice(0, -2);
  return value.endsWith('s') && !/(?:ss|us|is)$/.test(value) ? value.slice(0, -1) : value;
}

/** Only shorten a method when exactly one tag matches its resource words. */
function inferOperationNames(
  id: string,
  tags: unknown,
): {
  names: { resource: string; method: string };
  reason?: string;
} {
  const parts = words(id);
  const candidates = new Map<string, { resource: string; method: string }>();
  const rejected = new Set<string>();
  const declared = Array.isArray(tags)
    ? tags.filter((tag): tag is string => typeof tag === 'string')
    : [];
  for (const tag of declared) {
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
      if (isPublicName(resource) && isPublicName(method, true))
        candidates.set(resource + '.' + method, { resource, method });
      else rejected.add(resource + '.' + method);
    }
  }
  if (candidates.size === 1) return { names: [...candidates.values()][0]! };
  const reason =
    candidates.size > 1
      ? `multiple tags select different names: ${[...candidates.keys()].sort().join(', ')}`
      : rejected.size
        ? `tag-derived names use reserved words or SDK runtime members: ${[...rejected].sort().join(', ')}`
        : !declared.length
          ? 'no resource tags are declared'
          : `${id.includes('_') ? 'the operation ID uses snake_case; ' : ''}no tag matches the operation ID resource words (tags: ${declared.join(', ')})`;
  return { names: { resource: 'api', method: id }, reason };
}

/** Only shorten a method when exactly one tag matches its resource words. */
export function operationNames(id: string, tags: unknown): { resource: string; method: string } {
  return inferOperationNames(id, tags).names;
}

/** Explain conservative naming without changing fallback operation IDs. */
export function operationNamingReason(id: string, tags: unknown): string {
  return inferOperationNames(id, tags).reason ?? 'an explicit public name is required';
}

/** Preserve operation-ID acronym spelling while matching nouns by spelling. */
function spelledWords(value: string): string[] {
  return value
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
}
function pathSingular(value: string): string {
  const lower = value.toLowerCase();
  if (['analytics', 'settings'].includes(lower)) return lower;
  if (lower === 'refreshes') return 'refresh';
  return singular(lower);
}

/** Path naming is opt-in; tags retain their existing conservative inference. */
export function pathOperationNames(id: string, path: string): { resource: string; method: string } {
  const segments = path.split('/').filter(Boolean);
  const afterVersion = segments[0] === 'v1' ? segments.slice(1) : segments;
  const segment = afterVersion.find((part) => !part.startsWith('{'))?.split('.')[0] ?? '';
  const noun = words(segment);
  const resource = camel(noun);
  const parts = spelledWords(id);
  const targets = [
    noun.join(''),
    noun.map((word, i) => (i === noun.length - 1 ? pathSingular(word) : word)).join(''),
  ];
  const result = (remaining: string[]) => ({
    resource,
    method: remaining.map((word, i) => (i ? word : word.toLowerCase())).join(''),
  });
  for (let start = 1; start < parts.length; start++) {
    for (let end = start + 1; end <= parts.length; end++) {
      const run = parts.slice(start, end);
      const plain = run.join('').toLowerCase();
      const singularRun = run.slice(0, -1).join('').toLowerCase() + pathSingular(run.at(-1) ?? '');
      if (targets.includes(plain) || targets.includes(singularRun))
        return result([...parts.slice(0, start), ...parts.slice(end)]);
    }
  }
  // A shared leading noun is spoken once, immediately after the verb.
  for (let count = noun.length - 1; count > 0; count--) {
    if (
      parts.length > count + 1 &&
      noun
        .slice(0, count)
        .every((word, i) => pathSingular(word) === pathSingular(parts[i + 1] ?? ''))
    )
      return result([parts[0] ?? '', ...parts.slice(count + 1)]);
  }
  return { resource, method: id };
}

export function operationVerbOccurs(method: string, id: string): boolean {
  const verb = words(method)[0];
  return verb !== undefined && words(id).includes(verb);
}

/** Resolve pagination helper collisions before contract traversal, independent of path order. */
export function avoidPathHelperCollisions(
  entries: readonly {
    id: string;
    resource: string;
    method: string;
    pagination: boolean;
    explicit: boolean;
  }[],
): Map<string, { resource: string; method: string }> {
  const names = new Map(entries.map(({ id, resource, method }) => [id, { resource, method }]));
  let changed = true;
  while (changed) {
    changed = false;
    const helpers = new Set(
      entries
        .filter((entry) => entry.pagination)
        .flatMap((entry) => {
          const name = names.get(entry.id);
          return name
            ? ['Items', 'Pages'].map((suffix) =>
                (name.resource + '.' + name.method + suffix).toLowerCase(),
              )
            : [];
        }),
    );
    for (const entry of entries) {
      const name = names.get(entry.id);
      if (
        name &&
        !entry.explicit &&
        name.method !== entry.id &&
        helpers.has((name.resource + '.' + name.method).toLowerCase())
      ) {
        names.set(entry.id, { resource: name.resource, method: entry.id });
        changed = true;
      }
    }
  }
  return names;
}

/** Reserve explicit names first; generated Input helpers must not shadow source models. */
export function modelNames(originals: string[], overrides: Record<string, string> = {}) {
  const names = new Map<string, string>();
  const occupied = new Set(reserved);
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
    const stem = original.slice(0, -5);
    const base = stem.endsWith('Request') ? stem : stem + 'Request';
    let name = base;
    let suffix = 1;
    while (occupied.has(name.toLowerCase()) || occupied.has((name + 'Input').toLowerCase()))
      name = base + 'Model' + (suffix++ === 1 ? '' : suffix - 1);
    reserve(original, name);
  }
  return names;
}

// TypeScript keywords are case-sensitive and can still be property names.
const reservedTypeNames = new Set(
  'debugger export import in super this typeof with package arguments keyof infer unique'.split(
    ' ',
  ),
);
export function isReservedTypeName(value: string): boolean {
  return reservedTypeNames.has(value);
}
