import type { Json, Schema } from './contract.js';
import { compileCodec, type CodecPlan, type ValueInstruction } from './codec-plan.js';
import { stable } from './canonical.js';

/** Documentation's semantic contract. Collection children and union branches are
 * full trees, not rendered type strings. Execution facts come from CodecPlan;
 * annotations are paired with the same finalized declaration at compilation. */
export interface DocumentationFact {
  readonly value: ValueInstruction;
  readonly nullable: boolean;
  readonly model?: string;
  readonly reference?: string;
  readonly fields: Readonly<Record<string, DocumentationFact>>;
  readonly required: readonly string[];
  readonly readOnly: boolean;
  readonly writeOnly: boolean;
  readonly item?: DocumentationFact;
  readonly extra?: boolean | DocumentationFact;
  readonly keys?: DocumentationFact;
  readonly checks: CodecPlan['checks'];
  readonly enum?: readonly Json[];
  readonly constant?: string;
  readonly format?: string;
  readonly numberInput?: 'explicit';
  readonly description?: string;
  readonly defaultValue?: string;
  readonly example?: string;
  readonly all: readonly DocumentationFact[];
  readonly one: readonly DocumentationFact[];
  readonly any: readonly DocumentationFact[];
  readonly not?: DocumentationFact;
  readonly contains?: DocumentationFact;
  readonly when?: { test: DocumentationFact; then?: DocumentationFact; else?: DocumentationFact };
}
export interface DocumentationContext {
  readonly root: DocumentationFact;
  readonly definitions: Readonly<Record<string, DocumentationFact>>;
}
const indexes = new WeakMap<object, Map<string, string>>();
const modelNames = new WeakMap<object, WeakMap<Schema, string | undefined>>();
const definitionFacts = new WeakMap<object, Map<string, DocumentationContext['definitions']>>();
const contexts = new WeakMap<object, Map<string, WeakMap<object, DocumentationContext>>>();
const emptyDefinitions: Record<string, Schema> = {};

export function compileDocumentation(
  schema: Schema,
  definitions: Readonly<Record<string, Schema>> = emptyDefinitions,
  response?: boolean,
): DocumentationContext {
  let caches = contexts.get(definitions);
  if (!caches) contexts.set(definitions, (caches = new Map()));
  const direction = String(response);
  let cache = caches.get(direction);
  if (!cache) caches.set(direction, (cache = new WeakMap()));
  const saved = cache.get(schema);
  if (saved) return saved;
  let index = indexes.get(definitions);
  if (!index) {
    index = new Map();
    for (const [name, shape] of Object.entries(definitions)) {
      const identity = stable(shape);
      if (!index.has(identity)) index.set(identity, name);
    }
    indexes.set(definitions, index);
  }
  let schemaNames = modelNames.get(definitions);
  if (!schemaNames) modelNames.set(definitions, (schemaNames = new WeakMap()));
  const build = (s: Schema, p: CodecPlan): DocumentationFact => {
    const child = (value: Schema, plan?: CodecPlan) => build(value, plan ?? compileCodec(value));
    let model = s['x-sdk-type-name'] ?? s['x-sdk-ref'];
    if (!model && index.size) {
      if (!schemaNames.has(s)) schemaNames.set(s, index.get(stable(s)));
      model = schemaNames.get(s);
    }
    const example = Object.hasOwn(s, 'example')
      ? s.example
      : Array.isArray(s.examples)
        ? s.examples[0]
        : undefined;
    return {
      value: p.value,
      nullable: p.nullable,
      ...(model ? { model } : {}),
      ...(p.reference ? { reference: p.reference } : {}),
      fields: Object.fromEntries(
        Object.entries(p.fields ?? {})
          .filter(([, f]) => response === undefined || !(response ? f.hiddenOutput : f.rejectInput))
          .map(([name, f]) => [name, child(s.properties?.[name] ?? {}, f)]),
      ),
      required:
        response === undefined
          ? [...new Set([...p.requiredInput, ...p.requiredOutput])]
          : response
            ? p.requiredOutput
            : p.requiredInput,
      readOnly: p.rejectInput,
      writeOnly: p.hiddenOutput,
      ...(p.element ? { item: child(s.items ?? {}, p.element) } : {}),
      ...(p.extra !== undefined
        ? {
            extra:
              typeof p.extra === 'boolean'
                ? p.extra
                : child(
                    typeof s.additionalProperties === 'object' ? s.additionalProperties : {},
                    p.extra,
                  ),
          }
        : {}),
      ...(p.propertyNames ? { keys: child(s.propertyNames ?? {}, p.propertyNames) } : {}),
      checks: p.checks,
      ...(p.members ? { enum: p.members } : {}),
      ...(p.literal !== undefined ? { constant: p.literal } : {}),
      ...(s.format ? { format: s.format } : {}),
      ...(p.numberInput ? { numberInput: p.numberInput } : {}),
      ...(s.description ? { description: s.description } : {}),
      ...(Object.hasOwn(s, 'default') ? { defaultValue: JSON.stringify(s.default) } : {}),
      ...(example !== undefined ? { example: JSON.stringify(example) } : {}),
      all: (p.every ?? []).map((f, i) => child(s.allOf?.[i] ?? {}, f)),
      one: (p.exactlyOne ?? []).map((f, i) => child(s.oneOf?.[i] ?? {}, f)),
      any: (p.some ?? []).map((f, i) => child(s.anyOf?.[i] ?? {}, f)),
      ...(p.exclude ? { not: child(s.not ?? {}, p.exclude) } : {}),
      ...(p.includes ? { contains: child(s.contains ?? {}, p.includes) } : {}),
      ...(p.when
        ? {
            when: {
              test: child(s.if ?? {}, p.when.test),
              ...(p.when.then ? { then: child(s.then ?? {}, p.when.then) } : {}),
              ...(p.when.else ? { else: child(s.else ?? {}, p.when.else) } : {}),
            },
          }
        : {}),
    };
  };
  let directions = definitionFacts.get(definitions);
  if (!directions) definitionFacts.set(definitions, (directions = new Map()));
  let compiledDefinitions = directions.get(direction);
  if (!compiledDefinitions) {
    compiledDefinitions = Object.create(null) as Record<string, DocumentationFact>;
    directions.set(direction, compiledDefinitions);
  }
  const root = build(schema, compileCodec(schema));
  const referenced = new Set<string>();
  const visit = (fact: DocumentationFact) => {
    if (fact.reference && definitions[fact.reference] && !referenced.has(fact.reference)) {
      referenced.add(fact.reference);
      if (!compiledDefinitions[fact.reference]) {
        Object.assign(compiledDefinitions, {
          [fact.reference]: build(
            definitions[fact.reference]!,
            compileCodec(definitions[fact.reference]!),
          ),
        });
        visit(compiledDefinitions[fact.reference]!);
      }
    }
    for (const child of [
      ...Object.values(fact.fields),
      ...fact.all,
      ...fact.one,
      ...fact.any,
      ...(fact.item ? [fact.item] : []),
      ...(typeof fact.extra === 'object' ? [fact.extra] : []),
      ...(fact.not ? [fact.not] : []),
      ...(fact.contains ? [fact.contains] : []),
      ...(fact.when
        ? [
            fact.when.test,
            ...(fact.when.then ? [fact.when.then] : []),
            ...(fact.when.else ? [fact.when.else] : []),
          ]
        : []),
    ])
      visit(child);
  };
  visit(root);
  const result = { root, definitions: compiledDefinitions };
  cache.set(schema, result);
  return result;
}

const empty: DocumentationFact = {
  value: { kind: 'dynamic' },
  nullable: true,
  fields: {},
  required: [],
  readOnly: false,
  writeOnly: false,
  checks: {},
  all: [],
  one: [],
  any: [],
};
export const factConjunction = (all: readonly DocumentationFact[]): DocumentationFact => ({
  ...empty,
  all,
});
const identities = new WeakMap<Partial<DocumentationFact>, string>();
export function factIdentity(fact: Partial<DocumentationFact>): string {
  let identity = identities.get(fact);
  if (identity === undefined) {
    identity = stable(fact);
    identities.set(fact, identity);
  }
  return identity;
}

export function factParts(
  fact: DocumentationFact,
  definitions: DocumentationContext['definitions'],
  seen = new Set<string>(),
): DocumentationFact[] {
  return [
    fact,
    ...fact.all.flatMap((f) => factParts(f, definitions, seen)),
    ...(fact.reference && definitions[fact.reference] && !seen.has(fact.reference)
      ? factParts(definitions[fact.reference]!, definitions, new Set(seen).add(fact.reference))
      : []),
  ];
}
export function factShape(
  fact: DocumentationFact,
  definitions: DocumentationContext['definitions'],
): { fields: Record<string, DocumentationFact>; required: Set<string> } {
  const fields: Record<string, DocumentationFact> = Object.create(null);
  const required = new Set<string>();
  for (const part of factParts(fact, definitions)) {
    for (const [key, value] of Object.entries(part.fields))
      fields[key] =
        fields[key] && factIdentity(fields[key]!) !== factIdentity(value)
          ? factConjunction([fields[key]!, value])
          : value;
    for (const key of part.required) required.add(key);
  }
  return { fields, required };
}
export function factVariants(
  fact: DocumentationFact,
  definitions: DocumentationContext['definitions'],
  seen = new Set<string>(),
): { fact: DocumentationFact; conditions: string[] }[] {
  const common: DocumentationFact[] = [];
  const groups = new Map<string, { keyword: string; branches: readonly DocumentationFact[] }>();
  const references = new Set(seen);
  const collect = (part: DocumentationFact) => {
    const { reference, model, ...own } = part;
    common.push({ ...own, all: [], one: [], any: [] });
    for (const child of part.all) collect(child);
    if (reference && definitions[reference] && !references.has(reference)) {
      references.add(reference);
      collect(definitions[reference]!);
    }
    for (const [keyword, branches] of [
      ['oneOf', part.one],
      ['anyOf', part.any],
    ] as const)
      if (branches.length) groups.set(keyword + stable(branches), { keyword, branches });
  };
  collect(fact);
  if (!groups.size) return [{ fact: factConjunction(common), conditions: [] }];
  return [...groups.values()].flatMap(({ keyword, branches }, group) =>
    branches.flatMap((branch, index) =>
      factVariants(branch, definitions, references).flatMap((variant) => {
        const fact = factConjunction([...common, variant.fact]);
        const shape = factShape(fact, definitions);
        const impossible = Object.entries(shape.fields).some(
          ([field, child]) =>
            shape.required.has(field) &&
            factEnums(child, definitions).some((e) => !e.path && !e.values.length),
        );
        return impossible
          ? []
          : [
              {
                fact,
                conditions: [
                  `${keyword}${groups.size > 1 ? ' group ' + (group + 1) : ''} variant ${index + 1}${branch.description ? ': ' + branch.description : ''}`,
                  ...variant.conditions,
                ],
              },
            ];
      }),
    ),
  );
}
export interface DocumentationEnum {
  path: string;
  values: string[];
}
export function factEnums(
  fact: DocumentationFact,
  definitions: DocumentationContext['definitions'] = {},
  seen = new Set<string>(),
): DocumentationEnum[] {
  const values = new Map<string, string[]>();
  const merge = (entries: DocumentationEnum[], intersection = true) => {
    for (const entry of entries) {
      const previous = values.get(entry.path);
      values.set(
        entry.path,
        previous
          ? intersection
            ? previous.filter((v) => entry.values.includes(v))
            : [...new Set([...previous, ...entry.values])]
          : entry.values,
      );
    }
  };
  if (fact.enum) merge([{ path: '', values: fact.enum.map((v) => JSON.stringify(v)) }]);
  if (fact.constant !== undefined) merge([{ path: '', values: [fact.constant] }]);
  if (fact.item)
    merge(factEnums(fact.item, definitions, seen).map((e) => ({ ...e, path: '[]' + e.path })));
  if (typeof fact.extra === 'object')
    merge(factEnums(fact.extra, definitions, seen).map((e) => ({ ...e, path: '.*' + e.path })));
  if (fact.reference && definitions[fact.reference] && !seen.has(fact.reference))
    merge(factEnums(definitions[fact.reference]!, definitions, new Set(seen).add(fact.reference)));
  for (const part of fact.all) merge(factEnums(part, definitions, seen));
  const alternatives = new Map<string, string[]>();
  for (const part of [...fact.one, ...fact.any])
    for (const entry of factEnums(part, definitions, seen))
      alternatives.set(entry.path, [
        ...new Set([...(alternatives.get(entry.path) ?? []), ...entry.values]),
      ]);
  merge([...alternatives].map(([path, values]) => ({ path, values })));
  return [...values].map(([path, values]) => ({ path, values }));
}

const atoms = new WeakMap<DocumentationFact, Partial<DocumentationFact>[]>();
/** Atomic semantic declarations used by compact definition/delta rendering. */
export function factAtoms(fact: DocumentationFact): Partial<DocumentationFact>[] {
  const saved = atoms.get(fact);
  if (saved) return saved;
  const { all, value, nullable, ...rest } = fact;
  const result: Partial<DocumentationFact>[] = [
    ...(value.kind !== 'dynamic' ? [{ value, nullable }] : []),
    ...Object.entries(rest)
      .filter(
        ([key, value]) =>
          !['one', 'any', 'fields', 'required', 'checks', 'readOnly', 'writeOnly'].includes(key) ||
          (Array.isArray(value)
            ? value.length
            : typeof value === 'object'
              ? Object.keys(value).length
              : value),
      )
      .map(([key, value]) => ({ [key]: value })),
    ...all.flatMap(factAtoms),
  ];
  atoms.set(fact, result);
  return result;
}
export function factFromAtoms(atoms: readonly Partial<DocumentationFact>[]): DocumentationFact {
  const result = { ...empty },
    additional: DocumentationFact[] = [];
  const assigned = new Set<string>();
  for (const atom of atoms) {
    if (
      Object.keys(atom).some(
        (key) =>
          assigned.has(key) &&
          stable(result[key as keyof DocumentationFact]) !==
            stable(atom[key as keyof DocumentationFact]),
      )
    )
      additional.push({ ...empty, ...atom });
    else {
      Object.assign(result, atom);
      for (const key of Object.keys(atom)) assigned.add(key);
    }
  }
  return additional.length ? factConjunction([result, ...additional]) : result;
}

/** Position inventory shared by declaration comments and documentation certifiers.
 * References terminate at their public symbol; their fields have a canonical owner. */
export function documentationPositions(
  fact: DocumentationFact,
  definitions: DocumentationContext['definitions'],
  path = '$',
  presence: 'Value' | 'Required' | 'Optional' = 'Value',
  ancestors = new Set<string>(),
): { path: string; presence: 'Value' | 'Required' | 'Optional'; fact: DocumentationFact }[] {
  const identity = factIdentity(fact);
  if (ancestors.has(identity)) return [];
  const next = new Set(ancestors).add(identity);
  const result = [{ path, presence, fact }];
  if (fact.model || fact.reference) return result;
  const shape = factShape(fact, definitions);
  for (const [field, child] of Object.entries(shape.fields))
    result.push(
      ...documentationPositions(
        child,
        definitions,
        path + '.' + field,
        shape.required.has(field) ? 'Required' : 'Optional',
        next,
      ),
    );
  for (const part of factParts(fact, definitions)) {
    if (part.item)
      result.push(...documentationPositions(part.item, definitions, path + '[]', 'Value', next));
    if (typeof part.extra === 'object')
      result.push(...documentationPositions(part.extra, definitions, path + '.*', 'Value', next));
    for (const [keyword, branches] of [
      ['oneOf', part.one],
      ['anyOf', part.any],
    ] as const)
      for (const [index, branch] of branches.entries())
        result.push(
          ...documentationPositions(
            branch,
            definitions,
            `${path}.${keyword}[${index + 1}]`,
            'Value',
            next,
          ),
        );
  }
  return [...new Map(result.map((row) => [row.path + factIdentity(row.fact), row])).values()];
}
