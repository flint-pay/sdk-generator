import type { Contract, Schema } from './contract.js';
import { Diagnostic, pointerSegment } from './diagnostic.js';

export interface ExampleSource {
  document: string;
  pointer: string;
  context: string;
  value: unknown;
  /** A fragment reference can start below a protected ancestor in its source document. */
  protectedAncestor?: boolean;
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const sourceKey = (source: Pick<ExampleSource, 'document' | 'pointer'>): string =>
  source.document + '#' + source.pointer;

/** Temporary, serializable provenance carried through normalization, then removed at load. */
export const EXAMPLE_PROTECTION_MARKER = 'x-sdk-example-protected';

/** Resolve the source graph once, before schema normalization can flatten or clone locations. */
export function sourceExampleProtection(
  roots: readonly ExampleSource[],
  childContext: (context: string, key: string) => string,
  reference: (source: ExampleSource, ref: string) => ExampleSource,
  ignoredSiblings: boolean,
  isAnnotation: (key: string) => boolean,
): { locations: string[]; protects: (document: string, pointer: string) => boolean } {
  const edges = new Map<string, Set<string>>();
  const parents = new Map<string, Set<string>>();
  const seeds = new Set<string>();
  const schemas = new Set<string>();
  const compositions = new Set<string>();
  // Intern shallow tree descriptions instead of repeatedly serializing whole
  // subtrees. These exact identities include annotation payloads and are keyed
  // by source pointers; identical source shapes can share component aliases.
  const values = new Map<string, number>();
  const identities = new Map<string, number>();
  const shapes = new Map<number, string>();
  const identity = (source: ExampleSource): number => {
    const key = sourceKey(source);
    const previous = values.get(key);
    if (previous !== undefined) return previous;
    const value = source.value;
    const description =
      value !== null && typeof value === 'object'
        ? JSON.stringify([
            Array.isArray(value) ? 'array' : 'object',
            Object.entries(value)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([name, child]) => [
                name,
                identity({
                  ...source,
                  pointer: source.pointer + '/' + pointerSegment(name),
                  value: child,
                }),
              ]),
          ])
        : JSON.stringify(['literal', JSON.stringify(value) ?? 'undefined']);
    let result = identities.get(description);
    if (result === undefined) {
      result = identities.size;
      identities.set(description, result);
    }
    values.set(key, result);
    return result;
  };

  const connect = (from: string, to: string, together = false): void => {
    edges.get(from)?.add(to);
    const incoming = parents.get(to) ?? new Set<string>();
    incoming.add(from);
    parents.set(to, incoming);
    if (together) {
      edges.get(to)?.add(from);
      const incoming = parents.get(from) ?? new Set<string>();
      incoming.add(to);
      parents.set(from, incoming);
    }
  };
  const visit = (source: ExampleSource): string | undefined => {
    const { value, context } = source;
    if (context === 'literal' || (!object(value) && !Array.isArray(value))) return undefined;
    const key = sourceKey(source);
    if (source.protectedAncestor) seeds.add(key);
    if (edges.has(key)) return key;
    edges.set(key, new Set());
    if (context === 'schema' && object(value)) {
      schemas.add(key);
      const shape = identity(source);
      const shared = shapes.get(shape);
      if (shared) connect(key, shared, true);
      else shapes.set(shape, key);
      if (
        ['allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else', 'dependentSchemas'].some(
          (keyword) => Object.hasOwn(value, keyword),
        ) ||
        (!ignoredSiblings &&
          typeof value.$ref === 'string' &&
          Object.keys(value).some((keyword) => keyword !== '$ref' && !isAnnotation(keyword)))
      )
        compositions.add(key);
    }
    if (
      object(value) &&
      !context.startsWith('map:') &&
      (value['x-sensitive'] === true || value.writeOnly === true || value.format === 'password')
    )
      seeds.add(key);
    if (object(value) && !context.startsWith('map:') && typeof value.$ref === 'string') {
      const target = visit(reference(source, value.$ref));
      if (target) connect(key, target, true);
      if (context !== 'schema' || ignoredSiblings) return key;
    }
    for (const [name, child] of Object.entries(value)) {
      if (name === '$ref' && !context.startsWith('map:')) continue;
      const nested = visit({
        ...source,
        pointer: source.pointer + '/' + pointerSegment(name),
        value: child,
        context: Array.isArray(value) ? context : childContext(context, name),
      });
      if (nested)
        connect(
          key,
          nested,
          // Same-instance compositions and array element constraints must agree
          // on publication, including components used plainly outside a bridge.
          Array.isArray(value) ||
            context === 'map:composition' ||
            (context === 'schema' &&
              [
                'allOf',
                'anyOf',
                'oneOf',
                'not',
                'if',
                'then',
                'else',
                'items',
                'prefixItems',
                'contains',
                'dependentSchemas',
              ].includes(name)),
        );
    }
    return key;
  };
  roots.forEach(visit);
  // Two monotone facts per source node: protected values flow down; embedded
  // protection flows up to omit container annotations. At composition owners,
  // embedded protection also protects sibling constraints and their components.
  // Each fact enters the queue once, including in recursive reference graphs.
  type Fact = { key: string; kind: 'protected' | 'embedded' };
  const protectedLocations = new Set<string>();
  const omitted = new Set<string>();
  const queue: Fact[] = [];
  const add = (key: string, kind: Fact['kind']): void => {
    const found = kind === 'protected' ? protectedLocations : omitted;
    if (!found.has(key)) {
      found.add(key);
      queue.push({ key, kind });
    }
  };
  for (const key of seeds) add(key, 'protected');
  for (let i = 0; i < queue.length; i++) {
    const fact = queue[i]!;
    if (fact.kind === 'protected') {
      add(fact.key, 'embedded');
      for (const next of edges.get(fact.key) ?? []) add(next, 'protected');
    } else {
      for (const parent of parents.get(fact.key) ?? []) add(parent, 'embedded');
      if (compositions.has(fact.key)) add(fact.key, 'protected');
    }
  }
  return {
    locations: [...omitted].filter((key) => schemas.has(key)).sort(),
    protects: (document, pointer) => omitted.has(sourceKey({ document, pointer })),
  };
}

/** Visit schema locations only: literal example/enum values are never schemas. */
function contractSchemas(
  contract: Contract,
  inspect: (schema: Schema, pointer: string, identity: string) => void,
): void {
  // Pointers address this contract's sidecar. Identities match schema owners
  // across contracts, followed by pointers relative to each owner's schema.
  const visit = (schema: Schema, pointer: string, identity = pointer): void => {
    inspect(schema, pointer, identity);
    const child = (schema: Schema, relative: string): void =>
      visit(schema, pointer + relative, identity + relative);
    for (const keyword of ['properties', 'patternProperties', 'dependentSchemas'] as const) {
      const map = schema[keyword];
      if (object(map))
        for (const [name, nested] of Object.entries(map))
          if (object(nested)) child(nested, '/' + keyword + '/' + pointerSegment(name));
    }
    for (const keyword of ['allOf', 'anyOf', 'oneOf', 'prefixItems'] as const) {
      const branches = schema[keyword];
      if (Array.isArray(branches))
        branches.forEach((nested, i) => {
          if (object(nested)) child(nested, '/' + keyword + '/' + i);
        });
    }
    for (const keyword of [
      'not',
      'if',
      'then',
      'else',
      'items',
      'contains',
      'additionalProperties',
    ] as const) {
      const nested = schema[keyword];
      if (object(nested)) child(nested, '/' + keyword);
    }
  };
  for (const keyword of ['models', 'definitions'] as const)
    for (const [name, schema] of Object.entries(contract[keyword] ?? {}))
      visit(schema, '/' + keyword + '/' + pointerSegment(name));
  contract.operations.forEach((op, i) => {
    const base = '/operations/' + i;
    const identity = '/operations/' + pointerSegment(op.id);
    op.parameters.forEach((parameter, j) =>
      visit(
        parameter.schema,
        base + '/parameters/' + j + '/schema',
        identity + '/parameters/' + parameter.in + '/' + pointerSegment(parameter.name) + '/schema',
      ),
    );
    if (op.body)
      visit(op.body, base + '/body', identity + '/body/' + pointerSegment(op.mediaType ?? ''));
    for (const [status, response] of Object.entries(op.responses))
      if (response.schema)
        visit(
          response.schema,
          base + '/responses/' + pointerSegment(status) + '/schema',
          identity +
            '/responses/' +
            pointerSegment(status) +
            '/' +
            pointerSegment(response.mediaType ?? '') +
            '/schema',
        );
    for (const [event, schema] of Object.entries(op.streamEventSchemas ?? {}))
      visit(
        schema,
        base + '/streamEventSchemas/' + pointerSegment(event),
        identity + '/streamEventSchemas/' + pointerSegment(event),
      );
  });
  contract.incoming?.forEach((incoming, i) =>
    visit(
      incoming.schema,
      '/incoming/' + i + '/schema',
      '/incoming/' +
        pointerSegment(incoming.name) +
        '/' +
        pointerSegment(incoming.method) +
        '/schema',
    ),
  );
  for (const [event, schema] of Object.entries(contract.config.webhook?.events ?? {}))
    visit(schema, '/config/webhook/events/' + pointerSegment(event));
}

/** Remove temporary schema markers; records retain only this plain, sorted sidecar. */
export function saveExampleProtection(contract: Contract, locations: string[]): void {
  const schemas: string[] = [];
  contractSchemas(contract, (schema, pointer) => {
    if (schema[EXAMPLE_PROTECTION_MARKER] === true) schemas.push(pointer);
  });
  contractSchemas(contract, (schema) => {
    delete schema[EXAMPLE_PROTECTION_MARKER];
  });
  contract.exampleProtection = { locations, schemas: schemas.sort() };
}

const stringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry: unknown) => typeof entry === 'string');

function protectionPointers(contract: Contract): ReadonlySet<string> {
  const protection: unknown = contract.exampleProtection;
  if (protection === undefined) return new Set();
  if (
    !object(protection) ||
    !stringList(protection.locations) ||
    !stringList(protection.schemas) ||
    !protection.schemas.every((value) => value.startsWith('/'))
  )
    throw new Diagnostic(
      'exampleProtection',
      'expected source locations and contract schema pointers',
    );
  return new Set(protection.schemas);
}

/** One publication boundary for every target's declarations, docs, samples and descriptors.
 * The caller owns this cloned contract; private source annotations remain in saved records. */
export function omitProtectedExamples(contract: Contract): void {
  const protectedSchemas = protectionPointers(contract);
  contractSchemas(contract, (schema, pointer) => {
    if (protectedSchemas.has(pointer))
      for (const annotation of ['example', 'examples', 'default']) delete schema[annotation];
  });
  // Parameter-level examples must not reintroduce values hidden by the schema projection.
  const protectedParameters = new Set(
    [...protectedSchemas].flatMap((pointer) => {
      const match = /^\/operations\/\d+\/parameters\/\d+\/schema(?:\/|$)/.exec(pointer);
      return match ? [match[0].replace(/\/$/, '')] : [];
    }),
  );
  contract.operations.forEach((op, i) =>
    op.parameters.forEach((parameter, j) => {
      const base = '/operations/' + i + '/parameters/' + j + '/schema';
      if (protectedParameters.has(base)) {
        Reflect.deleteProperty(parameter, 'example');
        Reflect.deleteProperty(parameter, 'examples');
      }
    }),
  );
}

/** Compatibility reports publication removals without treating provenance as API behavior. */
export function removesPublishedExamples(before: Contract, after: Contract): boolean {
  const previousProtection = protectionPointers(before);
  const nextProtection = protectionPointers(after);
  const nextProtectedIdentities = new Set<string>();
  contractSchemas(after, (_schema, pointer, identity) => {
    if (nextProtection.has(pointer)) nextProtectedIdentities.add(identity);
  });
  const php =
    (before.config.targets ?? ['node', 'php']).includes('php') &&
    (after.config.targets ?? ['node', 'php']).includes('php');
  let removed = false;
  contractSchemas(before, (schema, pointer, identity) => {
    if (
      nextProtectedIdentities.has(identity) &&
      !previousProtection.has(pointer) &&
      (schema.example !== undefined ||
        (Array.isArray(schema.examples) && schema.examples.length > 0) ||
        (php &&
          pointer.startsWith('/definitions/') &&
          ['example', 'examples', 'default'].some((key) => Object.hasOwn(schema, key))))
    )
      removed = true;
  });
  return removed;
}
