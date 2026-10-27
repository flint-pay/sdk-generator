import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import MarkdownIt from 'markdown-it';
import { packageDocuments } from './package-docs.mjs';
import {
  documentationVariants,
  schemaFields,
  modelName,
  expectedFieldFacts,
  expectedAnnotations,
  expectedDocumentationFacts,
  expectedType,
  expectedConstraints,
  expectedEnums,
  typeLinks,
  parsedType,
  normalizedEnums,
} from './documentation-expectations.mjs';
import {
  documentedModels,
  directionalSchema,
  schemaInstruction,
  payloadSchemas,
} from './raw-documentation.mjs';

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
  const links = markdown.parse(source, {}).flatMap((token) => {
    const children = token.children ?? [];
    return children.flatMap((child, index) =>
      child.type === 'link_open'
        ? [
            [
              null,
              children
                .slice(
                  index + 1,
                  children.findIndex((entry, end) => end > index && entry.type === 'link_close'),
                )
                .map((entry) => entry.content)
                .join(''),
              child.attrGet('href'),
            ],
          ]
        : [],
    );
  });
  return links.flatMap((match) => {
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
      (entry) =>
        entry.index > heading.index &&
        entry[1].length <= heading[1].length &&
        !entry[2].startsWith(heading[2] + ' variant ') &&
        !entry[2].startsWith(heading[2] + '.'),
    );
    return [
      {
        label: match[1],
        heading: heading[2],
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
    const enums = [],
      enumEntries = new Map();
    let enumRegion = false,
      enumPath = '';
    const addValues = (values) => {
      enums.push(...values);
      enumEntries.set(enumPath, [...(enumEntries.get(enumPath) ?? []), ...values]);
    };
    const pathFor = (label) =>
      label.startsWith('Items')
        ? '[]' + label.slice(5).replace(/ values$/, '')
        : label.startsWith('Map')
          ? '.*' + label.slice(3).replace(/ values$/, '')
          : '';
    for (const child of cells[3].children) {
      if (child.type === 'text') {
        if (/(?:Values|Items[\[\].*]* values|Map[\[\].*]* values): $/.test(child.content)) {
          enumRegion = true;
          enumPath = pathFor(
            child.content.match(/(Values|Items[\[\].*]* values|Map[\[\].*]* values): $/)[1],
          );
        } else if (child.content.includes('.')) enumRegion = false;
      }
      if (enumRegion && child.type === 'code_inline') addValues([child.content]);
    }
    for (const [index, child] of cells[3].children.entries()) {
      if (
        child.type !== 'link_open' ||
        !/\d+ declared values/.test(cells[3].children[index + 1]?.content ?? '')
      )
        continue;
      enumPath = pathFor(
        cells[3].children[index - 1]?.content.match(
          /(Values|Items[\[\].*]* values|Map[\[\].*]* values): $/,
        )?.[1] ?? 'Values',
      );
      const [file, fragment] = child.attrGet('href').split('#');
      const text = path ? readFileSync(file ? resolve(dirname(path), file) : path, 'utf8') : source;
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
        addValues(
          markdown
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
      enumEntries: normalizedEnums([...enumEntries].map(([path, values]) => ({ path, values }))),
      type: inlineType(cells[2].content),
      links: modelLinks(cells[2].content),
      constraints: constraintFacts(cells[3].content),
      notes: cells[3].content,
    });
  }
  // A nullable child may be displayed as an inline type or as two linked
  // value branches. Recover its non-null bounds at the original child path.
  // This is a Markdown grammar rule, independent of source/target projections.
  for (const row of facts) {
    for (const section of path ? linkedModelSections(path, row.notes) : []) {
      const groups = new Map();
      const headings = [...section.source.matchAll(/^### (.+)\n/gm)];
      for (const [i, h] of headings.entries()) {
        const base = h[1].match(/^(.*) variant [\d, ]+(?::.*)?$/)?.[1];
        if (!base) continue;
        const body = section.source.slice(
          h.index + h[0].length,
          headings[i + 1]?.index ?? section.source.length,
        );
        const value = body.match(/^- Value shape: (.*)$/m)?.[1];
        if (value) {
          const values = groups.get(base) ?? [];
          values.push(value);
          groups.set(base, values);
        }
      }
      for (const [owner, values] of groups) {
        if (values.length !== 2 || !values.some((v) => /^null\./.test(v))) continue;
        const value = values.find((v) => !/^null\./.test(v));
        const localLabel =
          row.notes.match(/`([^`]+)`: \[declared alternatives\]/)?.[1] ?? row.field;
        const suffix = (localLabel.slice(row.field.length) + owner.slice(section.heading.length))
          .replace(/ variant [\d, ]+(?=\.|$)/g, '')
          .replace(/ fields \d+/g, '')
          .replace(/\.(?=\[|\{)/g, '');
        if (!/^(?:\[\]|\{\})*$/.test(suffix)) continue;
        const prefix = suffix.replaceAll('{}', '.*');
        row.constraints = [
          ...new Set([...row.constraints, ...constraintFacts(value).map((s) => prefix + s)]),
        ].sort();
      }
    }
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
      if (section.label === 'declared conditions') continue;
      assert.doesNotMatch(
        section.source,
        /Fields, types, descriptions and enum values:|Fields, descriptions and enum values are shared/,
        `${operation.name}: ${section.label} adds a second hop`,
      );
      assert.doesNotMatch(
        section.source.split(/^### /m)[0],
        /Field definitions: \[shared fields\]/,
        `${operation.name}: ${section.label} must link directly to definitions`,
      );
    }
    const outputs = op.response?.payloadPath
      ? payloadSchemas(op, definitions)
      : Object.entries(op.responses)
          .filter(([status]) => /^(?:2\d\d|2XX)$/.test(status))
          .flatMap(([, entry]) => (entry.schema ? [entry.schema] : []));
    for (const [section, schemas, isResponse] of [
      [request, op.body ? [op.body] : [], false],
      [response, outputs, true],
    ]) {
      const oldFacts = schemas.flatMap((schema) =>
        documentationVariants(schema, definitions).flatMap((variant) =>
          expectedFieldFacts(variant.schema, definitions, {}, isResponse),
        ),
      );
      if (!oldFacts.length) {
        // Unnamed value bodies/responses have no object rows. Certify each
        // full branch tuple, including item enum association, rather than
        // treating an empty field list as coverage.
        const values = [...section.matchAll(/(?:^- )?Value shape: (.*)$/gm)]
          .map((m) => {
            const type = m[1].match(/^(.*?)\.(?: |$)/)?.[1];
            return type
              ? fieldFacts(
                  '| Field | Presence | Type | Description |\n| --- | --- | --- | --- |\n| `$value` | Required | ' +
                    type +
                    ' | ' +
                    m[1].slice(type.length + 1) +
                    ' |\n',
                  operation.path,
                )[0]
              : null;
          })
          .filter(Boolean);
        for (const schema of schemas) {
          if (modelName(schema, definitions)) continue;
          const variants = documentationVariants(schema, definitions, new Set(), isResponse);
          if (!variants.some((v) => v.conditions.length)) continue;
          for (const variant of variants) {
            const expected = {
              type: expectedType(variant.schema, definitions, {}),
              constraints: expectedConstraints(variant.schema, definitions),
              enums: normalizedEnums(expectedEnums(variant.schema, definitions)),
            };
            assert.ok(
              values.some(
                (v) =>
                  JSON.stringify(parsedType(v.type)) === JSON.stringify(expected.type) &&
                  JSON.stringify([...new Set(v.constraints)].sort()) ===
                    JSON.stringify(expected.constraints) &&
                  JSON.stringify(v.enumEntries) === JSON.stringify(expected.enums),
              ),
              operation.name + ': lost inline value branch ' + JSON.stringify(expected),
            );
            checkedFacts++;
          }
        }
        continue;
      }
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

// Facts are extracted from visible Markdown, never hidden renderer metadata.
const inlineType = (text) => text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replaceAll('\\|', '|');
const modelLinks = (text) =>
  [...text.matchAll(/\[([^\]]+)\]\([^)]+\)/g)].map((match) => match[1]).sort();
const constraintFacts = (text) => {
  const scopes = [...text.matchAll(/\b(Items[\[\].*]*|Map[\[\].*]* values): /g)];
  return [
    ...text.matchAll(
      /\b(format|minimum|maximum|exclusiveMinimum|exclusiveMaximum|multipleOf|minLength|maxLength|minItems|maxItems|minProperties|maxProperties|uniqueItems|pattern): (`+)(.*?)\2/gi,
    ),
  ]
    .map((match) => {
      const label = scopes.filter((scope) => scope.index < match.index).at(-1)?.[1];
      const path = !label
        ? ''
        : label.startsWith('Items')
          ? '[]' + label.slice(5)
          : '.*' + label.slice(3).replace(/ values$/, '');
      return `${path}:${match[1].toLowerCase()}:${match[3]}`;
    })
    .sort();
};

/** Reconstruct each visible branch's full fact tuple from definitions and deltas. */
function branchFacts(source, path, scope, index) {
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const headings = [...source.matchAll(/^### (.+)\n/gm)];
  const first = headings[0]?.index ?? source.length;
  let definitions = source.slice(0, first);
  // Table interning can relocate the invariant definitions, but not the rules.
  for (const shared of linkedModelSections(path, definitions))
    if (shared.label === 'shared fields' && /\| Field \| Presence \|/.test(shared.source))
      definitions += '\n' + shared.source.split(/^### /m)[0];
  const facts = new Map(fieldFacts(definitions, path).map((fact) => [fact.field, fact]));
  let rules = definitions;
  if (index !== undefined) {
    const heading = headings.find(
      (entry) =>
        new RegExp('^' + escape(scope) + ' variant ([\\d, ]+)(?::|$)').test(entry[1]) &&
        entry[1]
          .slice((scope + ' variant ').length)
          .split(':')[0]
          .split(', ')
          .includes(String(index + 1)),
    );
    assert.ok(
      heading,
      `${scope}: lost branch ${index + 1}; headings ${JSON.stringify(headings.map((entry) => entry[1]))}`,
    );
    const end = headings.find((entry) => entry.index > heading.index)?.index ?? source.length;
    rules = source.slice(heading.index + heading[0].length, end);
  }
  for (const token of markdown.parse(rules, {}).filter((token) => token.type === 'inline')) {
    const presence = token.content.match(/^(Required|Optional|Undeclared): /)?.[1];
    if (presence)
      for (const field of [...token.content.matchAll(/`([^`]+)`/g)].map((match) => match[1])) {
        if (presence === 'Undeclared') facts.delete(field);
        else if (facts.has(field)) facts.get(field).presence = presence;
      }
    const value = token.content.match(/^Value shape: (.*)$/);
    if (value) {
      const type = value[1].match(/^(.*?)\.(?: |$)/)?.[1];
      assert.ok(type, `${scope}: missing value type`);
      const row = fieldFacts(
        '| Field | Presence | Type | Description |\n| --- | --- | --- | --- |\n| `$value` | Required | ' +
          type +
          ' | ' +
          value[1].slice(type.length + 1) +
          ' |\n',
        path,
      )[0];
      facts.set('$value', row);
    }
    const delta = token.content.match(/^Constraints for `([^`]+)`: (.*)$/);
    if (!delta || !facts.has(delta[1])) continue;
    const fact = facts.get(delta[1]);
    const type = delta[2].match(/^(.*?)\.(?: |$)/)?.[1];
    if (
      type &&
      /^(?:Array of |Map of |\[|any(?:$| and )|object(?:$| and )|integer(?:$| or | and | string)|string(?:$| or | and )|boolean(?:$| or | and )|number(?:$| or | and )|null(?:$| or | and )|Alternative shapes|ExactNumber input|exact numeric string)/.test(
        type,
      )
    ) {
      fact.type = inlineType(type);
      fact.links = modelLinks(type);
    }
    fact.notes += ' ' + delta[2];
    fact.constraints = [...new Set([...fact.constraints, ...constraintFacts(delta[2])])].sort();
    // Reuse the long-enum resolver through a synthetic row; definitions may
    // carry common enum facts, while the delta carries the narrowed set.
    const enums =
      fieldFacts(
        '| Field | Presence | Type | Description |\n| --- | --- | --- | --- |\n| `delta` | Required | string | ' +
          delta[2] +
          ' |\n',
        path,
      )[0]?.enums ?? [];
    if (enums.length) {
      fact.enums = [...new Set(enums)];
      fact.enumEntries = fieldFacts(
        '| Field | Presence | Type | Description |\n| --- | --- | --- | --- |\n| `delta` | Required | string | ' +
          delta[2] +
          ' |\n',
        path,
      )[0].enumEntries;
    }
  }
  return [...facts.values()];
}

// A separate raw-schema witness catches even a mutation in the shared
// type formatter (which the old-table comparison alone could not detect).
function assertConcreteCollectionType(type, schema, definitions, context) {
  if (!/Array of any|list(?:&lt;|<)mixed|\"kind\":\"array\",\"item\":\{\"kind\":\"any\"/.test(type))
    return;
  const concrete = (plan, seen = new Set()) => {
    if (plan.value.kind !== 'dynamic') return true;
    if (plan.reference && definitions[plan.reference] && !seen.has(plan.reference))
      return concrete(
        schemaInstruction(definitions[plan.reference]),
        new Set(seen).add(plan.reference),
      );
    return [...(plan.every ?? []), ...(plan.some ?? []), ...(plan.exactlyOne ?? [])].some((part) =>
      concrete(part, seen),
    );
  };
  const collection = (plan) =>
    (plan.element && concrete(plan.element)) || (plan.every ?? []).some(collection);
  assert.ok(
    !collection(schemaInstruction(schema)),
    `${context}: concrete collection degraded to any`,
  );
}

/** Compare full branch tuples against raw OpenAPI and the SDK profile.
 * Expected facts use no production semantic or documentation modules.
 * This covers every canonical model used by suppressed operations, including nested unions.
 */
export function assertCanonicalBranchDocumentation(directory, contract, report, selectedModels) {
  const target = directory.endsWith('/php') ? 'php' : 'node';
  const c = contract;
  const { models, inputNames, outputNames, definitions, origins } = documentedModels(directory, c);
  const names = (response) => (response ? outputNames : inputNames);
  const files = packageDocuments(directory);
  const sections = new Map();
  const canonicalSchemas = new Map(models.map((model) => [model.name, model.schema]));
  const modelLocations = new Map();
  for (const path of files.filter((path) => /(?:MODELS\.md|\/models\/[^/]+\.md)$/.test(path)))
    for (const match of readFileSync(path, 'utf8').matchAll(/^#{2,6} (.+)\n/gm))
      modelLocations.set(match[1], path);
  const modelSection = (name) => {
    if (sections.has(name)) return sections.get(name);
    const path = modelLocations.get(name) ?? join(directory, 'MODELS.md');
    const section = linkedModelSections(path, `[${name}](#${slug(name)})`)[0];
    sections.set(name, section);
    return section;
  };
  const aliases = new Map();
  const originOwners = new Map();
  for (const model of [...models].sort(
    (a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name),
  )) {
    const origin = origins.get(model.name);
    if (origin && !originOwners.has(origin)) originOwners.set(origin, model.name);
  }

  const fieldAlias = (section) => {
    const intro = section?.source.split(/^### /m)[0] ?? '';
    const explicit = intro.match(
      /Fields, types, descriptions and enum values: \[[^\]]+\]\([^)]+\)/,
    )?.[0];
    if (explicit) return linkedModelSections(section.path, explicit)[0];
    if (/Fields, descriptions and enum values are shared/.test(intro))
      return linkedModelSections(
        section.path,
        intro.match(/Response: \[[^\]]+\]\([^)]+\)/)?.[0] ?? '',
      )[0];
    const fragment = intro.match(
      /(?:Declared alternatives|Field definitions): \[[^\]]+\]\([^)]+\)/,
    )?.[0];
    if (fragment) {
      const linked = linkedModelSections(section.path, fragment)[0];
      if (linked?.label !== 'shared fields') return linked;
    }
  };
  const canonicalLabel = (name, seen = new Set()) => {
    if (aliases.has(name)) return aliases.get(name);
    if (seen.has(name) || !models.some((model) => model.name === name)) return name;
    const owner = originOwners.get(origins.get(name));
    if (owner && owner !== name) {
      const canonical = canonicalLabel(owner, new Set(seen).add(name));
      aliases.set(name, canonical);
      return canonical;
    }
    const section = modelSection(name);
    const alias = fieldAlias(section);
    const canonical = alias ? canonicalLabel(alias.heading, new Set(seen).add(name)) : name;
    aliases.set(name, canonical);
    return canonical;
  };
  const canonicalSection = (section, seen = new Set()) => {
    const identity = section.path + '#' + section.heading;
    if (seen.has(identity)) return section;
    const alias = fieldAlias(section);
    return alias ? canonicalSection(alias, new Set(seen).add(identity)) : section;
  };
  const objectModels = new Set(
    Object.entries(definitions).flatMap(([name, schema]) => {
      const plan = schemaInstruction(schema);
      return plan.value.kind === 'object' && !plan.nullable
        ? [canonicalLabel(inputNames[name] ?? name), canonicalLabel(outputNames[name] ?? name)]
        : [];
    }),
  );
  const normalizeTree = (tree) => {
    const result = JSON.parse(
      JSON.stringify(tree, (key, value) => (key === 'name' ? canonicalLabel(value) : value)),
    );
    if (result.item) result.item = normalizeTree(result.item);
    if (result.value) result.value = normalizeTree(result.value);
    if (result.branches) {
      result.branches = result.branches
        .map(normalizeTree)
        .flatMap((branch) =>
          branch.kind === result.kind && !branch.nullable ? branch.branches : [branch],
        );
      if (
        result.kind === 'and' &&
        result.branches.some((b) => b.kind === 'model' && objectModels.has(b.name))
      )
        result.branches = result.branches.filter((b) => b.kind !== 'object');
      result.branches = [
        ...new Map(result.branches.map((branch) => [JSON.stringify(branch), branch])).values(),
      ].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      if (result.branches.length === 1)
        return result.nullable ? { ...result.branches[0], nullable: true } : result.branches[0];
    }
    return result;
  };
  const normalizeType = (fact) => ({
    ...fact,
    annotationLinks: fact.links,
    type: normalizeTree(typeof fact.type === 'string' ? parsedType(fact.type) : fact.type),
    links: [...new Set(fact.links.map((name) => canonicalLabel(name)))].sort(),
  });
  const annotationNotes = (section, seen = new Set()) => {
    if (!section) return '';
    const identity = section.path + '#' + section.heading;
    if (seen.has(identity)) return '';
    const alias = fieldAlias(section);
    return [
      section?.source ?? '',
      ...(alias ? [annotationNotes(alias, new Set(seen).add(identity))] : []),
    ].join(' ');
  };
  let checkedBranches = 0,
    checkedFacts = 0;
  const seen = new Set();
  const check = (schema, section, scope, response, ancestors = new Set()) => {
    if (!schema) return;
    const origin = scope;
    section = canonicalSection(section);
    scope = section.heading;
    const declaredVariants = documentationVariants(schema, definitions, new Set(), response);
    const variantKey = (v) =>
      JSON.stringify({
        fields: expectedFieldFacts(v.schema, definitions, names(response), response),
        type: expectedType(v.schema, definitions, names(response), new Set(), () => true),
        constraints: expectedConstraints(v.schema, definitions),
        enums: normalizedEnums(expectedEnums(v.schema, definitions)),
      });
    const variants = [...new Map(declaredVariants.map((v) => [variantKey(v), v])).values()];
    const identity = JSON.stringify([
      expectedDocumentationFacts(schema, definitions, response),
      section.path,
      scope,
      response,
    ]);
    if (seen.has(identity) || ancestors.has(JSON.stringify(schema))) return;
    seen.add(identity);
    ancestors = new Set(ancestors).add(JSON.stringify(schema));
    const valueOwner = canonicalLabel(names(response)[modelName(schema, definitions)] ?? scope);
    const actualIndices = [
      ...new Set(
        [...section.source.matchAll(/^### (.+) variant ([\d, ]+)(?::.*)?\n/gm)]
          .filter((m) => m[1] === scope)
          .map((m) => Number(m[2].split(', ')[0]) - 1),
      ),
    ];
    const hasVariants = actualIndices.length > 0;
    const matchedIndices = new Map();
    const invariant = branchFacts(section.source, section.path, scope);
    for (const fact of invariant) {
      const fields = variants.flatMap((variant) => {
        const child = schemaFields(variant.schema, definitions, new Set(), true).fields[fact.field];
        return child ? [child] : [];
      });
      for (const child of fields)
        assertConcreteCollectionType(fact.type, child, definitions, `${scope}.${fact.field}`);
    }
    for (const [index, variant] of variants.entries()) {
      const shape = schemaFields(variant.schema, definitions, new Set(), true);
      const properties = Object.fromEntries(
        Object.entries(shape.fields).filter(([, child]) =>
          response ? !child.writeOnly : !child.readOnly,
        ),
      );
      const expected = expectedFieldFacts(variant.schema, definitions, names(response), response);
      if (!expected.length) {
        const type = expectedType(
          variant.schema,
          definitions,
          names(response),
          new Set(),
          (name) => canonicalLabel(name) === valueOwner,
        );
        expected.push({
          ...expectedAnnotations(variant.schema, definitions),
          field: '$value',
          presence: 'Required',
          type,
          links: typeLinks(type),
          constraints: expectedConstraints(variant.schema, definitions),
          enums: expectedEnums(variant.schema, definitions).flatMap((e) => e.values),
          enumEntries: normalizedEnums(expectedEnums(variant.schema, definitions)),
        });
      }
      let progress = 0;
      const validate = (actual) => {
        for (const fact of expected.map(normalizeType)) {
          const found = actual.find((entry) => entry.field === fact.field);
          assert.ok(
            found,
            `${scope} branch ${index + 1}: lost ${fact.field} (linked from ${origin})`,
          );
          assertConcreteCollectionType(
            JSON.stringify(found.type),
            properties[fact.field] ?? variant.schema,
            definitions,
            `${scope}.${fact.field}`,
          );
          for (const key of ['type', 'links', 'presence'])
            assert.deepEqual(
              found[key],
              fact[key],
              `${scope} branch ${index + 1}: lost ${fact.field} ${key}`,
            );
          assert.deepEqual(
            found.enumEntries,
            fact.enumEntries,
            `${scope} branch ${index + 1}: lost ${fact.field} enums`,
          );
          const linkedBounds = (tree, path = '') => {
            if (tree.kind === 'model') {
              const labels = found.annotationLinks.filter((n) => canonicalLabel(n) === tree.name);
              if (!labels.length) labels.push(tree.name);
              return labels.flatMap((name) =>
                constraintFacts(
                  modelSection(name)?.source.split(/^(?:\| Field \||### )/m)[0] ?? '',
                ).map((c) => path + c),
              );
            }
            return [
              ...(tree.item ? linkedBounds(tree.item, path + '[]') : []),
              ...(tree.value ? linkedBounds(tree.value, path + '.*') : []),
              ...(tree.branches ?? []).flatMap((t) => linkedBounds(t, path)),
            ];
          };
          found.constraints = [
            ...new Set([...found.constraints, ...linkedBounds(found.type)]),
          ].sort();
          for (const key of ['constraints', 'enums'])
            assert.deepEqual(
              [...new Set(found[key])].sort(),
              [...new Set(fact[key])].sort(),
              `${scope} branch ${index + 1}: lost ${fact.field} ${key}`,
            );
          assert.ok(
            !/Array of any|list(?:&lt;|<)mixed/.test(JSON.stringify(found.type)) ||
              /Array of any|list(?:&lt;|<)mixed/.test(JSON.stringify(fact.type)),
            `${scope}: concrete collection degraded to any`,
          );
          progress++;
          const reachableNotes = [
            found.notes,
            ...found.annotationLinks.map((name) => annotationNotes(modelSection(name))),
            ...linkedModelSections(section.path, found.notes).map((entry) =>
              annotationNotes(entry),
            ),
          ].join(' ');
          const prose = (text) =>
            markdown
              .parseInline(text.replace(/[\r\n]+/g, ' '), {})
              .flatMap((token) => token.children ?? [])
              .filter((token) => !['link_open', 'link_close'].includes(token.type))
              .map((token) => token.content)
              .join('')
              .replace(/\s+/g, ' ')
              .trim();
          for (const description of fact.descriptions ?? [])
            assert.ok(
              prose(reachableNotes).includes(prose(description)),
              `${scope}: lost ${fact.field} description`,
            );
          for (const value of fact.defaults ?? [])
            assert.ok(
              prose(reachableNotes).includes('Default: ' + value + '.'),
              `${scope}: lost ${fact.field} default`,
            );
        }
      };
      let matched = false,
        failure,
        best = -1;
      for (const actualIndex of hasVariants ? actualIndices : [undefined]) {
        const actual = branchFacts(section.source, section.path, scope, actualIndex).map(
          normalizeType,
        );
        progress = 0;
        try {
          validate(actual);
          matched = true;
          matchedIndices.set(index, actualIndex);
          break;
        } catch (error) {
          if (progress > best) {
            failure = error;
            best = progress;
          }
        }
      }
      if (!matched) throw failure;
      checkedFacts += expected.length;
      checkedBranches++;
    }
    // Nested declared alternatives have canonical links (shared across owners).
    // Traverse links whose schemas are inline, keeping their branch association.
    for (const [index, variant] of variants.entries()) {
      const shape = schemaFields(variant.schema, definitions, new Set(), true);
      const visit = (child, path, context, parents = new Set()) => {
        const identity = JSON.stringify(child);
        if (parents.has(identity) || ancestors.has(identity)) return;
        parents = new Set(parents).add(identity);
        if ((response && child.writeOnly) || (!response && child.readOnly)) return;
        const fieldSignatures = (value) =>
          new Set(
            documentationVariants(value, definitions, new Set(), response).map((v) =>
              JSON.stringify(
                expectedFieldFacts(v.schema, definitions, {}, response).map(
                  ({ descriptions, defaults, ...facts }) => facts,
                ),
              ),
            ),
          );
        const covers = (value, canonical) =>
          [...fieldSignatures(value)].every((key) => fieldSignatures(canonical).has(key));
        const named = (value) =>
          Boolean(
            names(response)[modelName(value, definitions)] &&
              (!canonicalSchemas.get(names(response)[modelName(value, definitions)]) ||
                covers(
                  value,
                  canonicalSchemas.get(names(response)[modelName(value, definitions)]),
                )),
          ) ||
          Boolean(
            value.allOf?.length &&
              !value.properties &&
              !value.oneOf &&
              !value.anyOf &&
              value.allOf.every(named),
          ) ||
          Boolean(
            (value.oneOf ?? value.anyOf)?.every((part) => part.type === 'null' || named(part)),
          );
        if (named(child)) return;
        if (
          documentationVariants(child, definitions, new Set(), response).some(
            (variant) => variant.conditions.length,
          ) ||
          Object.values(schemaFields(child, definitions).fields).some((field) =>
            response ? !field.writeOnly : !field.readOnly,
          ) ||
          child['x-sdk-ref']
        ) {
          let localScope = context + '.' + path;
          let local;
          // Equivalent field facts may have one invariant fragment even when
          // their source annotations differ in non-documentary metadata.
          for (const candidate of new Set([localScope, scope + '.' + path])) {
            local = section.source.match(
              new RegExp(
                '^### ' +
                  candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
                  '(?: fields \\d+)?' +
                  '\\n([\\s\\S]*?)(?=^### |$(?![\\s\\S]))',
                'm',
              ),
            );
            if (local) {
              localScope = local[0].slice(4, local[0].indexOf('\n'));
              break;
            }
          }
          if (!local) {
            // A recursive union can already be represented by its named
            // members. Prove every branch tuple against those compiler-owned
            // declarations, then certify the linked documents themselves.
            const links = typeLinks(expectedType(child, definitions, names(response))).filter(
              (name) => canonicalSchemas.has(name),
            );
            const branchSignature = (schema) =>
              JSON.stringify({
                fields: expectedFieldFacts(schema, definitions, names(response), response).map(
                  normalizeType,
                ),
                type: normalizeTree(
                  expectedType(schema, definitions, names(response), new Set(), () => true),
                ),
                constraints: expectedConstraints(schema, definitions),
                enums: normalizedEnums(expectedEnums(schema, definitions)),
              });
            const wanted = documentationVariants(child, definitions, new Set(), response);
            const available = new Set(
              links.flatMap((name) =>
                documentationVariants(
                  canonicalSchemas.get(name),
                  definitions,
                  new Set(),
                  response,
                ).map((v) => branchSignature(v.schema)),
              ),
            );
            if (
              links.length > 1 &&
              wanted.every(
                (v) =>
                  expectedFieldFacts(v.schema, definitions, names(response), response).length &&
                  available.has(branchSignature(v.schema)),
              )
            ) {
              for (const name of links)
                check(canonicalSchemas.get(name), modelSection(name), name, response, ancestors);
              return;
            }
          }
          assert.ok(local, `${localScope}: lost nested variant definitions`);
          if (local) {
            const linked = linkedModelSections(section.path, local[1]).find(
              (entry) => entry.label !== 'shared fields',
            );
            if (linked && /(?:Declared alternatives|Field definitions):/.test(local[1]))
              check(child, linked, linked.heading, response, ancestors);
            else {
              check(
                child,
                {
                  ...section,
                  heading: localScope,
                  source: section.source.slice(
                    section.source.indexOf(local[0]) + local[0].indexOf('\n') + 1,
                  ),
                },
                localScope,
                response,
                ancestors,
              );
            }
          }
          return;
        }
        for (const [field, value] of Object.entries(schemaFields(child, definitions).fields))
          visit(value, path + '.' + field, context, parents);
        if (child.items) visit(child.items, path + '[]', context, parents);
        if (typeof child.additionalProperties === 'object')
          visit(child.additionalProperties, path + '{}', context, parents);
      };
      if (!Object.keys(shape.fields).length) {
        const collectionParts = (value) => {
          if (value.items)
            visit(
              value.items,
              '[]',
              `${scope} variant ${(matchedIndices.get(index) ?? index) + 1}`,
            );
          if (typeof value.additionalProperties === 'object')
            visit(
              value.additionalProperties,
              '{}',
              `${scope} variant ${(matchedIndices.get(index) ?? index) + 1}`,
            );
          for (const part of value.allOf ?? []) collectionParts(part);
        };
        collectionParts(variant.schema);
      }
      for (const [field, child] of Object.entries(shape.fields))
        visit(
          child,
          field,
          variants.every(
            (other) =>
              JSON.stringify(
                schemaFields(other.schema, definitions, new Set(), true).fields[field],
              ) === JSON.stringify(child),
          )
            ? scope
            : `${scope} variant ${(matchedIndices.get(index) ?? index) + 1}`,
        );
    }
  };
  for (const model of models) {
    if (selectedModels && !selectedModels.has(model.name)) continue;
    if (!model.schema) continue;
    const section = modelSection(model.name);
    assert.ok(section, `missing canonical model ${model.name}`);
    const alias = fieldAlias(section);
    const canonical = alias ? modelSection(canonicalLabel(model.name)) : section;
    try {
      check(
        model.schema,
        canonical,
        canonical.heading,
        model.response || (target === 'node' && !canonical.heading.endsWith('Input')),
      );
    } catch (error) {
      if (!report) throw error;
      report(error);
    }
  }
  return { checkedBranches, checkedFacts };
}
