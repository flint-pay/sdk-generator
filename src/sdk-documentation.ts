import { errorMapping } from './runtime-plan.js';
import { integerDocumentation } from './integer-policy.js';
import {
  compileDocumentation,
  factShape,
  factVariants,
  factVariantName,
  factEnums,
  factParts,
  factIdentity,
  factAtoms,
  factFromAtoms,
  factConjunction,
  type DocumentationFact,
  type DocumentationContext,
} from './documentation-plan.js';
import { factType, factNotes, factCollectionNotes } from './documentation-format.js';
import { stable } from './canonical.js';
import { compileRetry, requiresIdempotencyKey } from './runtime-plan.js';
import { directionalSchema } from './codec-plan.js';
import type { Contract, Operation, Schema } from './contract.js';
import {
  schemaNotes,
  schemaLiteral as literal,
  schemaEnumValues,
  enumIdentity,
  enumNotes,
  type EnumLinks,
} from './schema-documentation.js';

const cell = (text: string) =>
  text
    .replaceAll('|', '\\|')
    .replace(/[\r\n]+/g, ' ')
    .replaceAll('<', '&lt;');
const literalCell = (text: string) => literal(text, true);
const markdownNotes = (schema: Schema, table = false) =>
  schemaNotes(schema, {
    literal: (text) => literal(text, table),
    ...(table ? { description: cell } : {}),
  });
export function modelDescriptions(
  schema: Schema,
  definitions: Record<string, Schema>,
  response?: boolean,
  inheritedOnly = false,
): string {
  const facts = compileDocumentation(schema, definitions, response);
  return [
    ...new Set(
      factParts(facts.root, facts.definitions).flatMap((part) =>
        part.description && (!inheritedOnly || part.description !== schema.description)
          ? [part.description]
          : [],
      ),
    ),
  ].join('\n\n');
}

const anchor = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_\s-]/gu, '')
    .replace(/\s/g, '-');

/** Format existing type expressions without changing compiler-owned type decisions. */
export function referenceType(label: string, source: string, target: 'node' | 'php'): string {
  if (source.length <= 140) return `${label}: ${literal(source)}\n\n`;
  // Quoted literals are atomic, including punctuation and escaped quotes.
  const tokens =
    source.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\s+|[A-Za-z_$][\w$]*|./g) ??
    [];
  const lines: string[] = [];
  let line = '',
    depth = 0,
    genericDepth = 0,
    recordDepth = 0,
    continuation = 0;
  const newline = () => {
    if (line.trim()) lines.push(line.trimEnd());
    line = '  '.repeat(depth + continuation);
  };
  const longUnion = (index: number) => {
    let first = index,
      last = index;
    while (first > 0 && ![';', '{', '}'].includes(tokens[first - 1]!)) first--;
    while (last < tokens.length && ![';', '{', '}'].includes(tokens[last]!)) last++;
    return tokens.slice(first, last).join('').length > 100;
  };
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token === '<') {
      genericDepth++;
      if (!recordDepth && tokens[index - 1] === 'Record') recordDepth = genericDepth;
      line += token;
    } else if (token === '>') {
      if (genericDepth === recordDepth) recordDepth = 0;
      genericDepth = Math.max(0, genericDepth - 1);
      line += token;
    } else if (recordDepth) line += token;
    else if (token === '{') {
      line += token;
      depth++;
      continuation = 0;
      newline();
    } else if (token === '}') {
      depth = Math.max(0, depth - 1);
      continuation = 0;
      newline();
      line += token;
    } else if (token === ';' || (token === ',' && !genericDepth)) {
      line += token;
      continuation = 0;
      newline();
    } else if (token === '|' && longUnion(index)) {
      line += token;
      continuation = 1;
      newline();
    } else if (!(/^\s+$/.test(token) && line.endsWith(' '))) line += token;
  }
  const output = [...lines, line].join('\n').trim();
  const delimiter = '`'.repeat(
    Math.max(2, ...[...output.matchAll(/`+/g)].map((match) => match[0].length)) + 1,
  );
  return `${label}:\n\n${delimiter}${target === 'node' ? 'typescript' : 'text'}\n${output.trim()}\n${delimiter}\n\n`;
}

export function schemaFields(
  schema: Schema,
  definitions: Record<string, Schema>,
  seen = new Set<string>(),
  intersect = false,
): { fields: Record<string, Schema>; required: Set<string> } {
  const fields: Record<string, Schema> = Object.assign(Object.create(null), schema.properties);
  const required = new Set(schema.required ?? []);
  const ref = schema['x-sdk-ref'];
  const branches = [...(schema.allOf ?? [])];
  if (ref && definitions[ref] && !seen.has(ref)) {
    seen = new Set(seen).add(ref);
    branches.push(definitions[ref]!);
  }
  for (const branch of branches) {
    const nested = schemaFields(branch, definitions, seen, intersect);
    for (const [key, value] of Object.entries(nested.fields)) {
      const previous = fields[key];
      fields[key] =
        intersect && previous && stable(previous) !== stable(value)
          ? {
              allOf: [previous, value],
              ...(previous.readOnly || value.readOnly ? { readOnly: true } : {}),
              ...(previous.writeOnly || value.writeOnly ? { writeOnly: true } : {}),
            }
          : (previous ?? value);
    }
    for (const key of nested.required) required.add(key);
  }
  return { fields, required };
}
const documentedModels = new WeakMap<Record<string, Schema>, Map<string, string>>();
export function modelName(schema: Schema, definitions: Record<string, Schema>): string | undefined {
  if (schema['x-sdk-ref']) return schema['x-sdk-ref'];
  if (schema['x-sdk-type-name']) return schema['x-sdk-type-name'];
  let index = documentedModels.get(definitions);
  if (!index) {
    index = new Map();
    for (const [name, shape] of Object.entries(definitions)) {
      const identity = stable(shape);
      if (!index.has(identity)) index.set(identity, name);
    }
    documentedModels.set(definitions, index);
  }
  return index.get(stable(schema));
}
type ModelNames = Readonly<Record<string, string>>;
function directionalFields(
  schema: Schema,
  definitions: Record<string, Schema>,
  seen = new Set<string>(),
): boolean {
  const ref = schema['x-sdk-ref'];
  if (
    ref &&
    definitions[ref] &&
    !seen.has(ref) &&
    directionalFields(definitions[ref]!, definitions, new Set(seen).add(ref))
  )
    return true;
  return Boolean(
    schema.readOnly ||
      schema.writeOnly ||
      [
        ...Object.values(schema.properties ?? {}).filter(
          (child) => child.readOnly || child.writeOnly || !modelName(child, definitions),
        ),
        ...(schema.allOf ?? []),
        ...(schema.oneOf ?? []),
        ...(schema.anyOf ?? []),
        ...(schema.items ? [schema.items] : []),
        ...(typeof schema.additionalProperties === 'object' ? [schema.additionalProperties] : []),
      ].some((child) => directionalFields(child, definitions, seen)),
  );
}
export interface ModelDocumentationExport {
  output: string;
  input?: string;
}

export const modelDocumentationConventions =
  'Schema defaults are metadata; clients do not apply them. Field definitions apply to all variants. Rules under each condition specify presence and additional constraints. Composed alternative groups apply together: satisfy a variant from each numbered group.\n\n';

export function fieldReferenceNotes(
  field: string,
  references: ReadonlyMap<string, Set<string>>,
): string {
  return [...references]
    .filter(
      ([path]) =>
        path === field ||
        path.startsWith(field + '.') ||
        path.startsWith(field + '[') ||
        path.startsWith(field + '{'),
    )
    .map(([path, links]) => `${literalCell(path)}: ${[...links].join(', ')}.`)
    .join(' ');
}

/** One registry per target package; identities retain direction and declared constraints. */
export class DocumentationFragments {
  private readonly locations = new Map<string, string>();
  private readonly anchors = new Set<string>();
  reserveScope(scope: string): void {
    this.anchors.add(anchor(scope));
  }
  claimScope(scope: string): string {
    let claimed = scope;
    for (let suffix = 1; this.anchors.has(anchor(claimed)); suffix++)
      claimed = `${scope} fields ${suffix}`;
    this.anchors.add(anchor(claimed));
    return claimed;
  }
  private readonly models = new Map<string, DocumentationFact>();
  location(fact: DocumentationFact, response?: boolean) {
    return this.locations.get(String(response) + ':' + factIdentity(fact));
  }
  model(name: string, response?: boolean) {
    return this.models.get(String(response) + ':' + name);
  }
  registerFact(fact: DocumentationFact, scope: string, response?: boolean): string | undefined {
    this.anchors.add(anchor(scope));
    const key = String(response) + ':' + factIdentity(fact);
    const previous = this.locations.get(key);
    if (!previous) this.locations.set(key, scope);
    return previous;
  }
  register(
    schema: Schema,
    scope: string,
    response?: boolean,
    definitions: Record<string, Schema> = {},
  ): string | undefined {
    const fact = compileDocumentation(schema, definitions, response).root;
    this.models.set(String(response) + ':' + scope, fact);
    return this.registerFact(fact, scope, response);
  }
}

/** Canonical field tables must retain the constraints of every alternative. */
export function modelFieldReference(
  schema: Schema,
  definitions: Record<string, Schema>,
  scope: string,
  names?: ModelNames,
  enumLinks?: EnumLinks,
  response?: boolean,
  includeFields = true,
  ancestors = new Set<string>(),
  fragments?: DocumentationFragments,
  fieldReferences = new Map<string, Set<string>>(),
): string {
  const facts = compileDocumentation(schema, definitions, response);
  return renderModelFields(
    facts.root,
    facts.definitions,
    scope,
    names,
    enumLinks,
    response,
    includeFields,
    ancestors,
    fragments,
    fieldReferences,
  );
}

const fieldSignatures = new WeakMap<
  DocumentationContext['definitions'],
  WeakMap<DocumentationFact, string>
>();

function renderModelFields(
  fact: DocumentationFact,
  definitions: DocumentationContext['definitions'],
  scope: string,
  names?: ModelNames,
  enumLinks?: EnumLinks,
  response?: boolean,
  includeFields = true,
  ancestors = new Set<string>(),
  fragments?: DocumentationFragments,
  fieldReferences = new Map<string, Set<string>>(),
): string {
  const identity = factIdentity(fact);
  if (ancestors.has(identity)) return '';
  fragments?.registerFact(fact, scope, response);
  ancestors = new Set(ancestors).add(identity);
  const shapes = factVariants(fact, definitions).map((variant) => {
    const shape = factShape(variant.fact, definitions);
    return {
      ...variant,
      fields: Object.fromEntries(
        Object.entries(shape.fields).filter(([, field]) =>
          response === undefined ? true : response ? !field.writeOnly : !field.readOnly,
        ),
      ),
      required: shape.required,
    };
  });
  const first = shapes[0];
  if (!first) return 'No satisfiable declared object variants.\n\n';
  const valueOwner = (fact.model && names?.[fact.model]) || scope;
  const variants = shapes.some((shape) => shape.conditions.length);
  const declarations = factAtoms;
  const conjunction = factFromAtoms;
  // Presence is independent of a field's definition. Retain shared conjuncts
  // once, then document only the extra constraints under each condition.
  const fields: Record<string, DocumentationFact> = Object.create(null);
  const presence = new Map<string, string>();
  const types = new Map<string, string>();
  const shared = new Map<string, Set<string>>();
  for (const field of new Set(shapes.flatMap((shape) => Object.keys(shape.fields)))) {
    const children = shapes.flatMap((shape) => (shape.fields[field] ? [shape.fields[field]!] : []));
    const parts = children.map(declarations);
    const common = parts[0]!.filter((part) =>
      parts.every((entries) => entries.some((entry) => factIdentity(entry) === factIdentity(part))),
    );
    fields[field] = conjunction(common);
    const effectiveTypes = new Set(children.map((child) => factType(child, definitions, names)));
    types.set(field, effectiveTypes.size === 1 ? [...effectiveTypes][0]! : 'Varies by condition');
    shared.set(field, new Set(common.map(factIdentity)));
    presence.set(
      field,
      shapes.every((shape) => shape.fields[field] && shape.required.has(field))
        ? 'Required'
        : shapes.every((shape) => shape.fields[field] && !shape.required.has(field))
          ? 'Optional'
          : 'Conditional',
    );
  }
  let output = '';
  if (variants) {
    if (!fragments) output += modelDocumentationConventions;
    const alternatives = new Map<
      string,
      { indices: number[]; rules: string; tags: string[]; conditions: string[] }
    >();
    for (const [index, shape] of shapes.entries()) {
      const tags = Object.entries(shape.fields).flatMap(([field, child]) =>
        factEnums(child, definitions)
          .filter((entry) => !entry.path && entry.values.length === 1)
          .map((entry) => `${literal(field)} = ${literal(entry.values[0]!)}`),
      );
      const condition = (value: DocumentationFact): string => {
        const parts = [
          ...(value.required?.length
            ? [`present(${value.required.map((field) => literal(field)).join(', ')})`]
            : []),
          ...Object.entries(value.fields).map(
            ([field, child]) =>
              `${literal(field)}: ${enumNotes(factEnums(child, definitions), literal, enumLinks) || factType(child, definitions, names)}`,
          ),
          ...value.all.map(condition).filter(Boolean),
          ...(
            [
              ['oneOf', value.one],
              ['anyOf', value.any],
            ] as const
          ).flatMap(([keyword, branches]) =>
            branches.length
              ? [
                  `${keyword === 'oneOf' ? 'exactly one' : 'at least one'}(${branches.map(condition).join('; ')})`,
                ]
              : [],
          ),
          ...(value.not ? [`not (${condition(value.not)})`] : []),
        ];
        return parts.join(' and ');
      };
      const objectConstraints = (value: DocumentationFact): string[] => [
        ...(value.not ? [`- Condition: not (${condition(value.not)}).\n`] : []),
        ...value.all.flatMap(objectConstraints),
      ];
      let rules = [...new Set(objectConstraints(shape.fact))].join('');
      for (const [label, selected] of [
        [
          'Required',
          Object.keys(shape.fields).filter(
            (field) => presence.get(field) === 'Conditional' && shape.required.has(field),
          ),
        ],
        [
          'Optional',
          Object.keys(shape.fields).filter(
            (field) => presence.get(field) === 'Conditional' && !shape.required.has(field),
          ),
        ],
        ['Undeclared', Object.keys(fields).filter((field) => !shape.fields[field])],
      ] as const)
        if (selected.length)
          rules += `- ${label}: ${selected.map((field) => literal(field)).join(', ')}.\n`;
      for (const [field, child] of Object.entries(shape.fields)) {
        const extra = declarations(child).filter(
          (part) => !shared.get(field)!.has(factIdentity(part)),
        );
        const effectiveType = factType(child, definitions, names);
        if (!extra.length && effectiveType === types.get(field)) continue;
        const delta = conjunction(extra);
        const notes = factCollectionNotes(delta, { literal }).replace(/[\r\n]+/g, ' ');
        const values = enumNotes(factEnums(child, definitions), literal, enumLinks);
        // Compare complete effective types, including item/value schemas and
        // named links. Looking only at scalar keywords loses collection deltas.
        const type = effectiveType;
        const facts = [type === types.get(field) ? '' : type + '.', notes, values]
          .filter(Boolean)
          .join(' ');
        if (facts) rules += `- Constraints for ${literal(field)}: ${facts}\n`;
      }
      if (!Object.keys(shape.fields).length)
        rules += `- Value shape: ${factType(shape.fact, definitions, names, new Set(), new Set(), valueOwner)}. ${factCollectionNotes(shape.fact, { literal }).replace(/[\r\n]+/g, ' ')} ${enumNotes(factEnums(shape.fact, definitions), literal, enumLinks)}\n`;
      const key = factIdentity(factFromAtoms(factAtoms(shape.fact)));
      const previous = alternatives.get(key);
      if (previous) {
        previous.indices.push(index + 1);
        previous.conditions.push(...shape.conditions);
      } else
        alternatives.set(key, {
          indices: [index + 1],
          rules,
          tags,
          conditions: [...shape.conditions],
        });
    }
    for (const alternative of alternatives.values()) {
      const title = `${scope} variant ${alternative.indices.join(', ')}${alternative.tags.length ? ': ' + alternative.tags.join(', ') : ''}`;
      fragments?.reserveScope(title);
      output += `### ${title}\n\n${alternative.conditions.join('; ')}.\n\n${alternative.rules || 'No additional constraints.\n'}\n`;
    }
  }
  if (!variants && !Object.keys(first.fields).length)
    output += `Value shape: ${factType(first.fact, definitions, names, new Set(), new Set(), valueOwner)}. ${factCollectionNotes(first.fact, { literal })} ${enumNotes(factEnums(first.fact, definitions), literal, enumLinks)}\n\n`;
  // Inline unions inside fields, array items and map values need their own
  // tables. Named children already link to their canonical model section.
  const visited = new Set<string>();
  let signatures = fieldSignatures.get(definitions);
  if (!signatures) fieldSignatures.set(definitions, (signatures = new WeakMap()));
  const signature = (fact: DocumentationFact) => {
    let key = signatures.get(fact);
    if (key) return key;
    key = stable(
      factVariants(fact, definitions).map(({ fact }) => {
        const shape = factShape(fact, definitions);
        return {
          fields: Object.fromEntries(
            Object.entries(shape.fields).map(([name, child]) => [
              name,
              factIdentity(factFromAtoms(factAtoms(child))),
            ]),
          ),
          required: [...shape.required].sort(),
        };
      }),
    );
    signatures.set(fact, key);
    return key;
  };
  const canonicalModel = (child: DocumentationFact) => {
    const label = child.model && names?.[child.model];
    if (!label) return false;
    const canonical = fragments?.model(label, response) ?? definitions[child.model!];
    return !canonical || signature(child) === signature(canonical);
  };
  const namedComposition = (child: DocumentationFact): boolean =>
    canonicalModel(child) ||
    Boolean(
      child.all.length &&
        !Object.keys(child.fields).length &&
        !child.one.length &&
        !child.any.length &&
        child.all.every(namedComposition),
    ) ||
    Boolean(
      [...child.one, ...child.any].length > 0 &&
        [...child.one, ...child.any].every(
          (part) => part.value.kind === 'null' || namedComposition(part),
        ),
    );
  const nested = (
    child: DocumentationFact,
    path: string,
    parents = ancestors,
    context = scope,
  ): string => {
    const reference = (link: string) => {
      const links = fieldReferences.get(path) ?? new Set<string>();
      links.add(link);
      fieldReferences.set(path, links);
    };
    if (namedComposition(child)) {
      if (
        !includeFields &&
        factVariants(child, definitions).some((variant) => variant.conditions.length)
      )
        reference(factType(child, definitions, names));
      return '';
    }
    const childIdentity = factIdentity(child);
    if (parents.has(childIdentity)) {
      const previous = fragments?.location(child, response);
      if (!previous)
        return (
          (child.item ? nested(child.item, path + '[]', parents, context) : '') +
          (typeof child.extra === 'object'
            ? nested(child.extra, path + '{}', parents, context)
            : '')
        );
      const scope = fragments!.claimScope(`${context}.${path}`);
      reference(`[field definitions](MODELS.md#${anchor(previous)})`);
      return `### ${scope}\n\nField definitions: [${previous}](MODELS.md#${anchor(previous)}).\n\n`;
    }
    const identity = context + '.' + path + childIdentity;
    if (visited.has(identity)) return '';
    visited.add(identity);
    const alternatives = factVariants(child, definitions);
    const union = alternatives.some((variant) => variant.conditions.length);
    const fields = alternatives.some(
      (variant) => Object.keys(factShape(variant.fact, definitions).fields).length,
    );
    if (union || fields || factParts(child, definitions).some((part) => part.reference)) {
      const scope = fragments?.claimScope(`${context}.${path}`) ?? `${context}.${path}`;
      const previous = fragments?.registerFact(child, scope, response);
      reference(
        `[${union ? 'declared alternatives' : 'field definitions'}](MODELS.md#${anchor(previous ?? scope)})`,
      );
      if (previous)
        return `### ${scope}\n\n${union ? 'Declared alternatives' : 'Field definitions'}: [${previous}](MODELS.md#${anchor(previous)}).\n\n`;
      const annotations = fields
        ? [...new Set(factParts(child, definitions).map((part) => factNotes(part, { literal })))]
            .filter(Boolean)
            .join(' ')
        : '';
      return (
        `### ${scope}\n\n` +
        (annotations ? annotations + '\n\n' : '') +
        renderModelFields(
          child,
          definitions,
          scope,
          names,
          enumLinks,
          response,
          true,
          parents,
          fragments,
        )
      );
    }
    const shape = factShape(child, definitions);
    const next = new Set(parents).add(childIdentity);
    return (
      Object.entries(shape.fields)
        .map(([field, value]) => nested(value, `${path}.${field}`, next, context))
        .join('') +
      (child.item ? nested(child.item, path + '[]', next, context) : '') +
      (typeof child.extra === 'object' ? nested(child.extra, path + '{}', next, context) : '')
    );
  };
  for (const [index, shape] of shapes.entries())
    for (const [field, child] of Object.entries(shape.fields))
      output += nested(
        child,
        field,
        ancestors,
        shapes.every(
          (other) =>
            other.fields[field] && factIdentity(other.fields[field]!) === factIdentity(child),
        )
          ? scope
          : `${scope} variant ${index + 1}`,
      );
  for (const [index, shape] of shapes.entries()) {
    if (Object.keys(shape.fields).length) continue;
    for (const part of factParts(shape.fact, definitions)) {
      if (part.item) output += nested(part.item, '[]', ancestors, `${scope} variant ${index + 1}`);
      if (typeof part.extra === 'object')
        output += nested(part.extra, '{}', ancestors, `${scope} variant ${index + 1}`);
    }
  }
  return (
    (includeFields
      ? factFieldTable(
          fields,
          new Set(),
          definitions,
          scope,
          true,
          names,
          enumLinks,
          presence,
          new Map(
            Object.keys(fields).map((field) => [
              field,
              fieldReferenceNotes(field, fieldReferences),
            ]),
          ),
          types,
        )
      : '') + output
  );
}
export function typeDescription(
  s: Schema,
  definitions: Record<string, Schema> = {},
  names?: ModelNames,
  seen = new Set<string>(),
): string {
  const facts = compileDocumentation(s, definitions);
  return factType(facts.root, facts.definitions, names, seen);
}

export function fieldTable(
  schema: Schema,
  definitions: Record<string, Schema>,
  scope = 'Field',
  includeExamples = true,
  names?: ModelNames,
  enumLinks?: EnumLinks,
  presence?: ReadonlyMap<string, string>,
  references?: ReadonlyMap<string, string>,
  types?: ReadonlyMap<string, string>,
): string {
  const facts = compileDocumentation(schema, definitions);
  const { fields, required } = factShape(facts.root, facts.definitions);
  return factFieldTable(
    fields,
    required,
    facts.definitions,
    scope,
    includeExamples,
    names,
    enumLinks,
    presence,
    references,
    types,
  );
}
function factFieldTable(
  fields: Readonly<Record<string, DocumentationFact>>,
  required: ReadonlySet<string>,
  definitions: DocumentationContext['definitions'],
  scope: string,
  includeExamples: boolean,
  names?: ModelNames,
  enumLinks?: EnumLinks,
  presence?: ReadonlyMap<string, string>,
  references?: ReadonlyMap<string, string>,
  types?: ReadonlyMap<string, string>,
): string {
  if (!Object.keys(fields).length) return '';
  const enums: string[] = [];
  return (
    '| Field | Presence | Type | Description |\n| --- | --- | --- | --- |\n' +
    Object.entries(fields)
      .map(([name, child]) => {
        // Effective body fields retain conjuncts rather than overwriting parent
        // constraints with branch annotations. Render every retained declaration.
        const parts = factParts(child, definitions);
        const entries = factEnums(child, definitions);
        const enumDescriptions = entries
          .map((entry) => {
            const { path, values } = entry;
            const label = path ? `${path} values` : 'values';
            const heading = `${scope} ${name} ${label}`;
            const link = enumLinks?.get(enumIdentity(values));
            if (!link && values.join(', ').length > 140) {
              enums.push(
                `#### ${heading}\n\n${values.map((value) => '- ' + literal(value)).join('\n')}\n\n`,
              );
              return enumNotes(
                [entry],
                literalCell,
                new Map([[enumIdentity(values), '#' + anchor(heading)]]),
              );
            }
            return enumNotes([entry], literalCell, enumLinks);
          })
          .join(' ');
        const notes = [
          [
            ...new Set(
              parts.map((part) =>
                factCollectionNotes(part, {
                  literal: literalCell,
                  description: cell,
                  examples: includeExamples,
                }),
              ),
            ),
          ]
            .filter(Boolean)
            .join(' '),
          enumDescriptions,
          child.readOnly ? 'Response only.' : '',
          child.writeOnly ? 'Input only.' : '',
          references?.get(name),
        ]
          .filter(Boolean)
          .join(' ');
        return `| \`${cell(name).replaceAll('`', '&#96;')}\` | ${presence?.get(name) ?? (required.has(name) ? 'Required' : 'Optional')} | ${types?.get(name) ?? factType(child, definitions, names)} | ${notes} |`;
      })
      .join('\n') +
    '\n\n' +
    enums.join('')
  );
}
/** Keep canonical body fields visible beside parameters in both target references. */
export function bodyReference(
  op: Operation,
  definitions: Record<string, Schema>,
  names?: ModelNames,
  sharedBodies?: ReadonlySet<string>,
  enumLinks?: EnumLinks,
): string {
  if (!op.body) return '';
  const facts = compileDocumentation(op.body, definitions, false);
  const body = facts.root;
  const documentedDefinitions = facts.definitions;
  const named = body.model;
  if (named && sharedBodies?.has(named) && names?.[named]) return '';
  const tables = new Map<string, { heading: string; destination: string }>();
  const headings = new Map<string, number>();
  const document = (
    fact: DocumentationFact,
    label: string,
    seen = new Set<string>(),
    inherited: DocumentationFact = factConjunction([]),
  ): string => {
    const shape = factShape(factConjunction([inherited, fact]), documentedDefinitions);
    const table = factFieldTable(
      shape.fields,
      shape.required,
      documentedDefinitions,
      label,
      false,
      names,
      enumLinks,
    );
    let output = fact.model
      ? `Body model: ${factType(fact, documentedDefinitions, names)}.\n\n`
      : '';
    if (table) {
      const previous = tables.get(table);
      if (previous) output += `Fields: [${previous.heading}](${previous.destination}).\n\n`;
      else {
        const variantFields =
          label.includes(' with ') || label.startsWith(`${op.resource}.${op.method}: `);
        const heading = variantFields ? label : `${label} fields`;
        const base = anchor(heading);
        const occurrence = headings.get(base) ?? 0;
        headings.set(base, occurrence + 1);
        tables.set(table, {
          heading,
          destination: '#' + base + (occurrence ? '-' + occurrence : ''),
        });
        output += variantFields ? table : `#### ${heading}\n\n${table}`;
      }
    }
    // Carry only the common field view into alternatives. Reusing the enclosing
    // graph would traverse the same references/compositions again at every level.
    const parent = { ...factConjunction([]), fields: shape.fields, required: [...shape.required] };
    for (const [keyword, branches] of [
      ['oneOf', fact.one],
      ['anyOf', fact.any],
    ] as const)
      for (const [index, variant] of branches.entries()) {
        const variantName = factVariantName(fact, variant, index, documentedDefinitions);
        const scope = `${op.resource}.${op.method}`;
        const title = variantName.startsWith('with ')
          ? `${scope} with ${literal(variantName.slice(5))}`
          : `${scope}: ${variantName}`;
        output += `#### ${title}\n\n${factNotes(variant, { literal, examples: false })}\n\n`;
        // Named variants link to their canonical field table instead of duplicating it.
        if (variant.model && names?.[variant.model]) {
          output += `Body model: ${factType(variant, documentedDefinitions, names)}.\n\n`;
          continue;
        }
        output +=
          document(variant, title, seen, parent) ||
          `Value shape: ${factType(variant, documentedDefinitions, names)}. ${factCollectionNotes(variant, { literal, examples: false })} ${enumNotes(factEnums(variant, documentedDefinitions), literal, enumLinks)}\n\n`;
      }
    // Composition-only wrappers can hide unions several allOf/reference levels
    // deep. Keep the complete common field view while following each wrapper.
    for (const branch of fact.all)
      if (branch.one.length || branch.any.length || branch.all.length || branch.reference)
        output += document(branch, label, seen, parent);
    const ref = fact.reference;
    if (ref && documentedDefinitions[ref] && !seen.has(ref)) {
      const target = documentedDefinitions[ref]!;
      if (target.one.length || target.any.length || target.all.length || target.reference)
        output += document(target, label, new Set(seen).add(ref), parent);
    }
    return output;
  };
  return (
    document(body, `${op.resource}.${op.method} body`) ||
    `Body shape: ${factType(body, documentedDefinitions, names)}.\n\n`
  );
}
export function modelReference(
  c: Contract,
  exports?: Readonly<Record<string, ModelDocumentationExport>>,
  target: 'node' | 'php' = 'node',
  enumLinks?: EnumLinks,
  fieldAliases?: Map<string, string>,
): string {
  const outputs =
    exports &&
    Object.fromEntries(Object.entries(exports).map(([name, entry]) => [name, entry.output]));
  const inputs =
    exports &&
    Object.fromEntries(
      Object.entries(exports).flatMap(([name, entry]) =>
        entry.input ? [[name, entry.input]] : [],
      ),
    );
  const fragments = new DocumentationFragments();
  // A public TypeScript alias proves assignability, not identical validation or
  // annotation facts. Keep each distinct declaration under its exported owner.
  const outputSchemas = new Map<string, Schema>();
  const declarationsByOwner = new Map<string, [string, Schema][]>();
  for (const [source, schema] of Object.entries(c.models)) {
    const owner = exports?.[source]?.output;
    if (!owner) continue;
    const declarations = declarationsByOwner.get(owner) ?? [];
    declarations.push([source, schema]);
    declarationsByOwner.set(owner, declarations);
  }
  for (const [name, entry] of Object.entries(exports ?? {})) {
    if (entry.output !== name) continue;
    const declared = declarationsByOwner.get(name) ?? [];
    if (declared.length <= 1) {
      outputSchemas.set(name, directionalSchema(c.models[name]!, true));
      continue;
    }
    const descriptions = declared
      .map(([source, schema]) => `Declared schema ${source}: ${schema.description ?? ''}`)
      .join('\n\n');
    const declarations = [
      ...new Map(
        declared.map(([source, schema]) => {
          const view = directionalSchema(schema, true);
          const { description, 'x-sdk-type-name': _name, ...shape } = view;
          return [
            stable(shape),
            { ...view, description: `Declared schema ${source}. ${view.description ?? ''}` },
          ];
        }),
      ).values(),
    ];
    outputSchemas.set(
      name,
      declarations.length > 1
        ? { anyOf: declarations }
        : {
            ...directionalSchema(c.models[name]!, true),
            ...(declared.length > 1 ? { description: descriptions } : {}),
          },
    );
  }
  for (const [name, schema] of Object.entries(c.models)) {
    const entry = exports?.[name];
    if (!exports || entry?.output === name)
      fragments.register(
        exports ? outputSchemas.get(name)! : schema,
        name,
        exports ? true : undefined,
        c.definitions ?? c.models,
      );
    if (entry?.input)
      fragments.register(
        directionalSchema(schema, false),
        entry.input,
        false,
        c.definitions ?? c.models,
      );
  }
  const section = (
    name: string,
    schema: Schema,
    names?: ModelNames,
    replacement = '',
    response?: boolean,
  ) =>
    `## ${name}\n\n${replacement}${markdownNotes(schema)}\n\n${modelDescriptions(schema, c.definitions ?? c.models, response, true)}\n\n${enumNotes(schemaEnumValues(schema, c.definitions ?? c.models), literal, enumLinks)}\n\n${modelFieldReference(schema, c.definitions ?? c.models, name, names, enumLinks, response, true, new Set(), fragments)}`;
  return (
    `# ${c.title} models\n\n[API reference](REFERENCE.md) · [Runtime guide](RUNTIME.md)\n\nFields describe the API's declared shape. Inputs omit read-only fields; responses omit write-only fields and preserve unknown fields and enum values. ${target === 'node' ? 'Request enums are closed unions; response enums accept unknown strings. Input types use the Input suffix.' : 'Operation responses use presence-aware classes with typed getters; optional omitted fields return null.'}\n\n${integerDocumentation(c.config, target === 'node')} Decimal fields use exact numeric strings. Use each field's declared units.\n\n` +
    modelDocumentationConventions +
    Object.entries(c.models)
      .map(([name, schema]) => {
        if (!exports) return section(name, schema);
        const entry = exports[name];
        if (!entry) return '';
        let document =
          entry.output === name ? section(name, outputSchemas.get(name)!, outputs, '', true) : '';
        if (entry.input) {
          if (
            entry.output === name &&
            !directionalFields(schema, c.definitions ?? c.models) &&
            stable(directionalSchema(schema, false)) === stable(outputSchemas.get(name))
          ) {
            fieldAliases?.set(entry.input, entry.output);
            document += `## ${entry.input}\n\nRequest input. Response: [${entry.output}](MODELS.md#${anchor(entry.output)}). Fields, descriptions and enum values are shared with that model; request enums accept only the listed values.\n\n`;
          } else
            document += section(
              entry.input,
              directionalSchema(schema, false),
              inputs,
              `Request input. Response: [${entry.output}](MODELS.md#${anchor(entry.output)}).\n\n`,
              false,
            );
        }
        return document;
      })
      .join('')
  );
}
export function authenticationGuide(c: Contract, target: 'node' | 'php' = 'node'): string {
  if (!c.authentication)
    return c.auth
      ? 'Supply `token` from your credential source.\n\n'
      : 'This SDK does not require a client credential for its selected operations.\n\n';
  const shortcuts = Object.entries(c.authShortcuts ?? {})
    .map(
      ([key, value]) =>
        `- \`${key}\` selects \`${value.mode}\` and supplies \`${value.scheme}\`.\n`,
    )
    .join('');
  return (
    (shortcuts
      ? 'Authentication shortcuts are accepted on both client and request options:\n\n' +
        shortcuts +
        '\nRequest shortcuts override client authentication for that call. Explicit request modes still work. Use only one shortcut, and do not combine it with authMode or credentials in the same options object.\n\n'
      : '') +
    (c.authShortcuts?.token
      ? ''
      : 'The legacy `token` option is not configured for this composed client and is rejected. Use a listed shortcut or explicit mode credentials.\n\n') +
    'Set `authMode` to one of the modes below and put its credentials under `credentials[mode]`. Request overrides use the mode’s credential map directly, without the outer mode key. A request credential map replaces the selected mode’s client map; supply every required key.\n\n| Mode | Required credential keys |\n| --- | --- |\n' +
    Object.entries(c.authentication)
      .map(
        ([name, auth]) =>
          `| \`${cell(name)}\` | ${auth.schemes.map((s) => '`' + cell(s.name) + '`').join(', ')} |`,
      )
      .join('\n') +
    `\n\n${target === 'node' ? 'TypeScript checks mode names, credential keys, and the modes permitted by each operation. ' : ''}Credentials themselves are never shown in SDK diagnostics.\n\n`
  );
}
export function operationGuidance(c: Contract, op: Operation): string {
  const { retry } = compileRetry(op);
  return (
    `#### Request behavior\n\nAttempt limit: ${retry.maxAttempts}; retry statuses: ${retry.statuses.join(', ') || 'none'}; transport retries: ${retry.transport ? 'enabled' : 'disabled'}. See [retries and idempotency](RUNTIME.md#retries-and-idempotency).\n\n` +
    (retry.errors?.length
      ? `Code-specific retries: ${retry.errors.map((rule) => `HTTP ${rule.status} (${rule.codes.map((code) => literal(code)).join(', ')})`).join('; ')}.\n\n`
      : '') +
    (op.response?.return === 'payload'
      ? `Complete body and metadata: ${literal(op.method + 'WithResponse')}. See [response modes](RUNTIME.md#responses-and-errors).\n\n`
      : '') +
    (op.idempotency
      ? `Idempotent: key ${requiresIdempotencyKey(op) ? 'required' : op.idempotency.auto ? 'automatic' : 'optional'}, [${cell(idempotencyPolicyName(c, op.idempotency))}](RUNTIME.md#idempotency).\n\n`
      : '') +
    (c.authentication
      ? `Authentication modes: ${op.authModes?.map((mode) => literal(mode)).join(', ') || 'none (anonymous)'}. [Credential setup](RUNTIME.md#authentication).\n\n`
      : '') +
    (op.conditional
      ? `Conditional header: ${literal(op.conditional.header)}, supplied through ifMatch.\n\n`
      : '') +
    (op.pagination
      ? `Pagination: ${literal(op.method + 'Items')}, ${literal(op.method + 'Pages')}${op.response?.return === 'payload' ? ', ' + literal(op.method + 'PagesWithResponse') : ''}. [Canonical pagination example](RUNTIME.md#pagination-and-polling).\n\n`
      : '') +
    (op.polling
      ? `Polling: ${literal(op.method + 'Wait')}${op.response?.return === 'payload' ? ', ' + literal(op.method + 'WaitWithResponse') : ''}; state ${literal(op.polling.state)}; success ${op.polling.success.map((v) => literal(v)).join(', ')}; failure ${op.polling.failure.map((v) => literal(v)).join(', ')}. [Polling deadlines](RUNTIME.md#pagination-and-polling).\n\n`
      : '')
  );
}

/** Show top-level response alternatives without traversing nested object fields. */
export function responseReference(
  schema: Schema,
  definitions: Record<string, Schema>,
  scope: string,
  names?: ModelNames,
  enumLinks?: EnumLinks,
): string {
  const named = modelName(schema, definitions);
  if (named && names?.[named]) return '';
  const context = compileDocumentation(schema, definitions, true);
  const parts = factParts(context.root, context.definitions).map((part) => ({ ...part, all: [] }));
  const alternative = parts.find((part) => part.one.length || part.any.length);
  const table = (fact: DocumentationFact, label: string) => {
    const shape = factShape(fact, context.definitions);
    return factFieldTable(
      shape.fields,
      shape.required,
      context.definitions,
      label,
      false,
      names,
      enumLinks,
    );
  };
  if (!alternative) return table(context.root, scope);
  const common = parts.map((part) => ({ ...part, one: [], any: [] }));
  return [...alternative.one, ...alternative.any]
    .map(
      (variant, index) =>
        `##### Response variant ${index + 1}\n\n${variant.description ?? ''}\n\n` +
        (table(factConjunction([...common, variant]), `${scope} variant ${index + 1}`) ||
          `Value shape: ${factType(variant, context.definitions, names)}. ${factCollectionNotes(variant, { literal, examples: false })} ${enumNotes(factEnums(variant, context.definitions), literal, enumLinks)}\n\n`),
    )
    .join('');
}

/** Preserve each distinct declared policy once; key selection remains operation-specific. */
export function idempotencyPolicies(c: Contract) {
  return [
    ...new Map(
      c.operations.flatMap((op) =>
        op.idempotency
          ? ([
              [
                JSON.stringify([
                  op.idempotency.header,
                  op.idempotency.retention,
                  op.idempotency.scope,
                ]),
                {
                  header: op.idempotency.header,
                  retention: op.idempotency.retention,
                  scope: op.idempotency.scope,
                },
              ],
            ] as const)
          : [],
      ),
    ).values(),
  ];
}
type IdempotencyPolicy = ReturnType<typeof idempotencyPolicies>[number];
/** Retention classes are named by retention, adding scope and then header only to tell them apart. */
function idempotencyPolicyNames(policies: IdempotencyPolicy[]): string[] {
  const plain = (text: string) => text.replace(/[.\s]+$/, '');
  const forms = [
    (p: IdempotencyPolicy) => `${plain(p.retention)} retention`,
    (p: IdempotencyPolicy) => `${plain(p.retention)} retention, ${plain(p.scope)} scope`,
    (p: IdempotencyPolicy) =>
      `${plain(p.retention)} retention, ${plain(p.scope)} scope, ${p.header}`,
  ];
  const form =
    forms.find((f) => new Set(policies.map(f)).size === policies.length) ?? forms.at(-1)!;
  return policies.map(form);
}
export function idempotencyPolicyName(c: Contract, used: NonNullable<Operation['idempotency']>) {
  const policies = idempotencyPolicies(c);
  const names = idempotencyPolicyNames(policies);
  return names[
    policies.findIndex(
      (policy) =>
        policy.header === used.header &&
        policy.retention === used.retention &&
        policy.scope === used.scope,
    )
  ]!;
}
export function idempotencyReference(c: Contract): string {
  const policies = idempotencyPolicies(c);
  const names = idempotencyPolicyNames(policies);
  return policies.length
    ? '| Retention class | Header | Retention | Scope |\n| --- | --- | --- | --- |\n' +
        policies
          .map(
            (policy, index) =>
              `| ${cell(names[index]!)} | ${literalCell(policy.header)} | ${cell(policy.retention)} | ${cell(policy.scope)} |`,
          )
          .join('\n') +
        '\n\n'
    : '';
}

/** Name of the described API in generated prose: `documentation.apiName`, else "the API". */
export const apiName = (c: Contract): string => c.config.documentation?.apiName ?? 'the API';
/** Heading for the API's declared error-code values, with the ERRORS.md anchor that follows from it. */
export const errorCodesTitle = (c: Contract): string =>
  `${apiName(c).replace(/^the /i, '')} error codes`;
export const errorCodesLink = (c: Contract): string =>
  'ERRORS.md#' +
  errorCodesTitle(c)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_\s-]/gu, '')
    .replace(/\s/g, '-');

type RetryClass = { retry: ReturnType<typeof compileRetry>['retry']; count: number };
function retryClasses(ops: Operation[]): RetryClass[] {
  const classes = new Map<string, RetryClass>();
  for (const op of ops) {
    const { retry } = compileRetry(op);
    const key = stable([retry.maxAttempts, retry.statuses, retry.transport, retry.errors ?? null]);
    const known = classes.get(key);
    if (known) known.count++;
    else classes.set(key, { retry, count: 1 });
  }
  return [...classes.values()].sort((a, b) => b.count - a.count);
}
const list = (items: readonly (string | number)[]) =>
  items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
function attempts(retry: RetryClass['retry']): string {
  if (retry.maxAttempts <= 1) return 'one attempt';
  const signals = [
    retry.transport ? 'transport failures' : '',
    retry.statuses.length ? `HTTP ${list(retry.statuses)}` : '',
    retry.errors?.length ? 'declared error codes' : '',
  ].filter(Boolean);
  return `up to ${retry.maxAttempts} total attempts for ${signals.join(' and ') || 'declared retry signals'}`;
}
/** What a group of operations allows, plus how many of them declare other limits. */
function allowance(ops: Operation[], plural = ops.length !== 1): string {
  const [main, ...others] = retryClasses(ops);
  const rest = others.reduce((sum, other) => sum + other.count, 0);
  return (
    `${plural ? 'allow' : 'allows'} ${attempts(main!.retry)}` +
    (rest
      ? `; ${rest} of them declare other limits, listed in each operation's request behavior`
      : '')
  );
}
/** Retry and automatic-key behavior as compiled for each operation, not as a fixed default. */
export function retryPolicyParagraph(c: Contract): string {
  const reads = c.operations.filter((op) => compileRetry(op).replay === 'safe');
  const writes = c.operations.filter((op) => compileRetry(op).replay !== 'safe');
  const keyed = writes.filter((op) => op.idempotency);
  const automatic = keyed.filter((op) => op.idempotency!.auto);
  const manual = keyed.filter((op) => !op.idempotency!.auto);
  const writing = (ops: Operation[], one: string, many: string) =>
    `${ops.length} write operation${ops.length === 1 ? ' ' + one : 's ' + many}`;
  const sentences: string[] = [];
  if (reads.length) sentences.push(`Reads (GET, HEAD and OPTIONS) ${allowance(reads, true)}.`);
  if (automatic.length) {
    const headers = [...new Set(automatic.map((op) => '`' + op.idempotency!.header + '`'))];
    const prefixes = [...new Set(automatic.map((op) => op.idempotency!.autoKeyPrefix))];
    sentences.push(
      `${writing(automatic, 'creates', 'create')} ${list(headers)} automatically when you supply none` +
        (prefixes.length === 1 && prefixes[0] ? `, beginning with ${literal(prefixes[0])}` : '') +
        ` and ${allowance(automatic)}.`,
    );
  }
  if (manual.length)
    sentences.push(
      `${writing(manual, 'accepts', 'accept')} \`idempotencyKey\` and ${manual.length === 1 ? 'sends' : 'send'} once until you supply a key; with a key, ${manual.length === 1 ? 'it' : 'they'} ${allowance(manual)}.`,
    );
  const unkeyed = writes.filter((op) => !op.idempotency);
  if (unkeyed.length)
    sentences.push(
      `${writing(unkeyed, 'declares', 'declare')} no idempotency key and always ${unkeyed.length === 1 ? 'sends' : 'send'} once.`,
    );
  return `${sentences.join(' ')} maxAttempts caps total attempts including the first. HTTP 412 never retries.`;
}

/** Error-code values are shared across model and operation field docs. */
export function errorCodeDocumentation(c: Contract): {
  links: Map<string, string>;
  reference: string;
} {
  const links = new Map<string, string>();
  const values = new Set<string>();
  for (const op of c.operations)
    for (const response of Object.values(op.responses)) {
      if (response.classification !== 'error' || !response.schema) continue;
      let shapes = [response.schema];
      for (const field of [
        errorMapping(c.config.errors).objectPath,
        errorMapping(c.config.errors).fields.code,
      ]
        .filter(Boolean)
        .join('.')
        .split('.'))
        shapes = shapes.flatMap((shape) =>
          [shape, ...(shape.oneOf ?? shape.anyOf ?? [])].flatMap((part) => {
            const child = schemaFields(part, c.definitions ?? c.models).fields[field];
            return child ? [child] : [];
          }),
        );
      for (const shape of shapes)
        for (const entry of schemaEnumValues(shape, c.definitions ?? c.models)) {
          if (entry.path) continue;
          links.set(enumIdentity(entry.values), errorCodesLink(c));
          for (const value of entry.values) values.add(value);
        }
    }
  return {
    links,
    reference:
      `# ${errorCodesTitle(c)}\n\n[Runtime error reference](RUNTIME.md#error-reference)\n\nApiError exposes code, type, param, details (always an array), remediation, errorSource, docUrl, requestId, requestLogUrl and the redacted decoded body. Object values keep wire names. remediation.retry is one of same_request, after_refresh or none. Unknown codes, types, sources and detail reasons remain extensible. Envelope paths follow errors.objectPath and errors.fields. OAuth errors use error/error_description; missing envelopes use http_error. body, raw and headers are omitted from inspection.\n\nObject path: ${JSON.stringify(errorMapping(c.config.errors).objectPath)}.\n\n| Property | Object-relative path |\n| --- | --- |\n${Object.entries(
        errorMapping(c.config.errors).fields,
      )
        .map(([name, path]) => `| ${name} | ${path} |`)
        .join(
          '\n',
        )}\n\nInspect the error code together with status and class; retry only when the operation permits it. Declared values:\n\n` +
      [...values]
        .sort()
        .map((value) => '- ' + literal(value))
        .join('\n') +
      '\n\n',
  };
}
