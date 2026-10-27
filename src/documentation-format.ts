import { exactValue, wireKind } from './codec-plan.js';
import {
  factParts,
  factEnums,
  factConjunction,
  type DocumentationFact,
  type DocumentationContext,
} from './documentation-plan.js';

type Definitions = DocumentationContext['definitions'];
const unnamedTypes = {};
const typeProjections = new WeakMap<
  Definitions,
  WeakMap<object, WeakMap<DocumentationFact, Map<string | undefined, string>>>
>();
const anchor = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_\s-]/gu, '')
    .replace(/\s/g, '-');

/** Pure projections: no schema interpretation or branch identity decisions. */
export function factType(
  fact: DocumentationFact,
  definitions: Definitions = {},
  names?: Readonly<Record<string, string>>,
  seen = new Set<string>(),
  ancestors = new Set<DocumentationFact>(),
  owner?: string,
): string {
  if (seen.size || ancestors.size)
    return renderFactType(fact, definitions, names, seen, ancestors, owner);
  let contexts = typeProjections.get(definitions);
  if (!contexts) typeProjections.set(definitions, (contexts = new WeakMap()));
  const symbols = names ?? unnamedTypes;
  let facts = contexts.get(symbols);
  if (!facts) contexts.set(symbols, (facts = new WeakMap()));
  let projections = facts.get(fact);
  if (!projections) facts.set(fact, (projections = new Map()));
  const saved = projections.get(owner);
  if (saved !== undefined) return saved;
  const type = renderFactType(fact, definitions, names, seen, ancestors, owner);
  projections.set(owner, type);
  return type;
}

function renderFactType(
  fact: DocumentationFact,
  definitions: Definitions,
  names: Readonly<Record<string, string>> | undefined,
  seen: Set<string>,
  ancestors: Set<DocumentationFact>,
  owner: string | undefined,
): string {
  const name = fact.model && (names ? names[fact.model] : fact.model);
  if (name && name !== owner) return `[${name}](MODELS.md#${anchor(name)})`;
  if (ancestors.has(fact)) {
    const reference = fact.model ?? fact.reference;
    return reference
      ? `[${reference}](MODELS.md#${anchor(reference)})`
      : (wireKind(fact.value) ?? 'recursive value');
  }
  ancestors = new Set(ancestors).add(fact);
  if (fact.reference && definitions[fact.reference] && !seen.has(fact.reference))
    return factType(
      definitions[fact.reference]!,
      definitions,
      names,
      new Set(seen).add(fact.reference),
      ancestors,
      owner,
    );
  if (fact.all.length) {
    const parts = factParts(fact, definitions, seen);
    const concrete = parts.filter((p) => p.value.kind !== 'dynamic');
    const items = parts.flatMap((p) => (p.item ? [p.item] : []));
    const extras = parts.flatMap((p) => (typeof p.extra === 'object' ? [p.extra] : []));
    const own = parts.filter(
      (p) =>
        p.value.kind !== 'dynamic' ||
        p.item ||
        typeof p.extra === 'object' ||
        p.one.length ||
        p.any.length ||
        p.model,
    );
    const types = [
      ...new Set(
        own.map((part) =>
          factType(
            {
              ...part,
              all: [],
              ...(items.length && (part.item || part.value.kind === 'array')
                ? { item: factConjunction(items) }
                : {}),
              ...(extras.length && (typeof part.extra === 'object' || part.value.kind === 'object')
                ? { extra: factConjunction(extras) }
                : {}),
              // A dynamic collection conjunct inherits the concrete container policy.
              ...(part.value.kind === 'dynamic' && concrete.length
                ? { nullable: concrete.every((p) => p.nullable) }
                : {}),
            },
            definitions,
            names,
            seen,
            ancestors,
            owner,
          ),
        ),
      ),
    ];
    return (
      types
        .filter((t) => t !== 'any')
        .map((t) => (t.includes(' or ') ? `(${t})` : t))
        .join(' and ') || 'any'
    );
  }
  const branches = [...fact.one, ...fact.any];
  if (branches.length) {
    const types = [
      ...new Set(branches.map((p) => factType(p, definitions, names, seen, ancestors, owner))),
    ];
    const alternatives = types.every((t) => t !== 'object' && t !== 'any')
      ? types.join(' or ')
      : 'Alternative shapes (see declared variants)';
    const own = factType({ ...fact, one: [], any: [] }, definitions, names, seen, ancestors, owner);
    const conjunct = (type: string) => (type.includes(' or ') ? `(${type})` : type);
    return own === 'any' || own === alternatives
      ? alternatives
      : `${conjunct(own)} and ${conjunct(alternatives)}`;
  }
  const childType = (child: DocumentationFact) => {
    const type = factType(child, definitions, names, seen, ancestors);
    return / or | and /.test(type) ? `(${type})` : type;
  };
  let type: string;
  if (fact.value.kind === 'array' || fact.item)
    type = `Array of ${fact.item ? childType(fact.item) : 'any'}`;
  else if (typeof fact.extra === 'object') type = `Map of ${childType(fact.extra)}`;
  else if (exactValue(fact.value))
    type =
      fact.numberInput === 'explicit'
        ? 'ExactNumber input; exact numeric string response'
        : fact.value.kind === 'exact-integer'
          ? 'integer string'
          : 'exact numeric string';
  else type = wireKind(fact.value) ?? 'any';
  return fact.nullable && type !== 'any' && type !== 'null' ? type + ' or null' : type;
}

export function factNotes(
  fact: DocumentationFact,
  formatting: {
    literal?: (text: string) => string;
    description?: (text: string) => string;
    examples?: boolean;
  } = {},
): string {
  const literal = formatting.literal ?? ((text: string) => text);
  const notes = fact.description
    ? [(formatting.description ?? ((text: string) => text))(fact.description)]
    : [];
  if (exactValue(fact.value))
    notes.push(
      fact.numberInput === 'explicit'
        ? 'Use ExactNumber for an exact JSON number.'
        : fact.value.kind === 'exact-integer'
          ? 'Use an integer string (decimal digits), not a floating-point number.'
          : 'Use an exact numeric string, not a floating-point number.',
    );
  if (fact.format) notes.push('Format: ' + literal(fact.format) + '.');
  for (const [key, value] of Object.entries(fact.checks))
    notes.push(key + ': ' + literal(String(value)) + '.');
  if (fact.defaultValue !== undefined) notes.push('Default: ' + literal(fact.defaultValue) + '.');
  if (fact.example !== undefined && formatting.examples !== false) {
    const value: unknown = JSON.parse(fact.example);
    notes.push(
      'Example: ' +
        literal(
          exactValue(fact.value) && typeof value === 'number'
            ? JSON.stringify(String(value))
            : fact.example,
        ) +
        '.',
    );
  }
  return notes.join(' ');
}
export function factCollectionNotes(
  fact: DocumentationFact,
  formatting: Parameters<typeof factNotes>[1] = {},
): string {
  const notes = new Map<string, Set<string>>();
  const collect = (node: DocumentationFact, path: string) => {
    const text = factNotes(node, formatting);
    if (text) {
      const group = notes.get(path) ?? new Set<string>();
      group.add(text);
      notes.set(path, group);
    }
    for (const part of node.all) collect(part, path);
    if (node.item) collect(node.item, path + '[]');
    if (typeof node.extra === 'object') collect(node.extra, path + '.*');
  };
  collect(fact, '');
  return [...notes]
    .map(([path, group]) => {
      const label = !path
        ? ''
        : path.startsWith('[]')
          ? 'Items' + path.slice(2)
          : 'Map' + path.slice(2) + ' values';
      return (label ? label + ': ' : '') + [...group].join(' ');
    })
    .join(' ');
}

/** Human-readable shape rows in source comments retain facts at every depth. */
export function factSourceDocumentation(
  fact: DocumentationFact,
  definitions: Definitions,
  positions: readonly { path: string; presence: string; fact: DocumentationFact }[],
  names?: Readonly<Record<string, string>>,
  linkTag: 'link' | 'see' = 'link',
): string {
  return positions
    .map((position) => {
      const type = factType(position.fact, definitions, names).replace(
        /\[([^\]]+)\]\([^)]+\)/g,
        (_, name: string) => `{@${linkTag} ${name}}`,
      );
      const notes = [
        ...new Set(
          factParts(position.fact, definitions)
            .map((part) => factNotes(part))
            .filter(Boolean),
        ),
      ].join(' ');
      const enums = factEnumsForComment(position.fact, definitions);
      return `Shape ${position.path} (${position.presence}): ${type}. ${notes} ${enums}`.trim();
    })
    .join(' ');
}
function factEnumsForComment(fact: DocumentationFact, definitions: Definitions): string {
  return factEnums(fact, definitions)
    .map(({ path, values }) => `${path || 'Value'} enum: ${values.join(', ')}.`)
    .join(' ');
}
