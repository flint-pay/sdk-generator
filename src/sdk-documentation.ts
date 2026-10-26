import { stable } from './canonical.js';
import { compileRetry, requiresIdempotencyKey } from './runtime-plan.js';
import { directionalSchema, exactValue, valueInstruction } from './codec-plan.js';
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
export interface ModelDocumentationExport {
  output: string;
  input?: string;
}
function typeDescription(
  s: Schema,
  definitions: Record<string, Schema> = {},
  names?: ModelNames,
): string {
  const source = modelName(s, definitions);
  const name = source && (names ? names[source] : source);
  if (name) return `[${name}](MODELS.md#${anchor(name)})`;
  if (s.allOf) {
    const { allOf, ...base } = s;
    const types = [
      ...new Set([base, ...allOf].map((part) => typeDescription(part, definitions, names))),
    ];
    return types.filter((type) => type !== 'any').join(' and ') || 'any';
  }
  if (s.oneOf || s.anyOf) return 'Alternative shapes (see declared variants)';
  if (s.type === 'array') return `Array of ${typeDescription(s.items ?? {}, definitions, names)}`;
  const types = Array.isArray(s.type) ? s.type : [s.type ?? 'any'];
  return types
    .map((t) =>
      exactValue(valueInstruction(t, s.format))
        ? s['x-sdk-number-input'] === 'explicit'
          ? 'ExactNumber input; exact numeric string response'
          : ['int64', 'uint64'].includes(s.format ?? '')
            ? 'integer string'
            : 'exact numeric string'
        : t,
    )
    .join(' or ');
}
export function fieldTable(
  schema: Schema,
  definitions: Record<string, Schema>,
  scope = 'Field',
  includeExamples = true,
  names?: ModelNames,
  enumLinks?: EnumLinks,
): string {
  const { fields, required } = schemaFields(schema, definitions);
  if (!Object.keys(fields).length) return '';
  const enums: string[] = [];
  return (
    '| Field | Presence | Type | Description |\n| --- | --- | --- | --- |\n' +
    Object.entries(fields)
      .map(([name, child]) => {
        // Effective body fields retain conjuncts rather than overwriting parent
        // constraints with branch annotations. Render every retained declaration.
        const declarations = (s: Schema, seen = new Set<string>()): Schema[] => {
          const ref = s['x-sdk-ref'];
          return [
            s,
            ...(s.allOf ?? []).flatMap((part) => declarations(part, seen)),
            ...(ref && definitions[ref] && !seen.has(ref)
              ? declarations(definitions[ref]!, new Set(seen).add(ref))
              : []),
          ];
        };
        const parts = declarations(child);
        const entries = schemaEnumValues(child, definitions);
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
                markdownNotes(includeExamples ? part : withoutExamples(part), true),
              ),
            ),
          ]
            .filter(Boolean)
            .join(' '),
          enumDescriptions,
          child.readOnly ? 'Response only.' : '',
          child.writeOnly ? 'Input only.' : '',
        ]
          .filter(Boolean)
          .join(' ');
        return `| \`${cell(name).replaceAll('`', '&#96;')}\` | ${required.has(name) ? 'Required' : 'Optional'} | ${typeDescription(child, includeExamples ? {} : definitions, names)} | ${notes} |`;
      })
      .join('\n') +
    '\n\n' +
    enums.join('')
  );
}
function withoutExamples({ example, examples, ...schema }: Schema): Schema {
  return schema;
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
  const body = op.body;
  const named = modelName(body, definitions);
  if (named && sharedBodies?.has(named) && names?.[named]) return '';
  const tables = new Map<string, { heading: string; destination: string }>();
  const headings = new Map<string, number>();
  const document = (
    schema: Schema,
    label: string,
    seen = new Set<string>(),
    inherited: Schema = {},
  ): string => {
    const effective = { allOf: [inherited, schema] };
    const shape = schemaFields(directionalSchema(effective, false), definitions, new Set(), true);
    const table = fieldTable(
      {
        properties: Object.fromEntries(
          Object.entries(shape.fields).filter(([, child]) => !child.readOnly),
        ),
        required: [...shape.required],
      },
      definitions,
      label,
      false,
      names,
      enumLinks,
    );
    let output = modelName(schema, definitions)
      ? `Body model: ${typeDescription(schema, definitions, names)}.\n\n`
      : '';
    if (table) {
      const previous = tables.get(table);
      if (previous) output += `Fields: [${previous.heading}](${previous.destination}).\n\n`;
      else {
        const heading = `${label} fields`;
        const base = anchor(heading);
        const occurrence = headings.get(base) ?? 0;
        headings.set(base, occurrence + 1);
        tables.set(table, {
          heading,
          destination: '#' + base + (occurrence ? '-' + occurrence : ''),
        });
        output += `#### ${heading}\n\n${table}`;
      }
    }
    // Carry only the common field view into alternatives. Reusing the enclosing
    // graph would traverse the same references/compositions again at every level.
    const parent = { properties: shape.fields, required: [...shape.required] };
    for (const keyword of ['oneOf', 'anyOf'] as const)
      for (const [index, variant] of (schema[keyword] ?? []).entries()) {
        const title = `${label} ${keyword} variant ${index + 1}`;
        output += `#### ${title}\n\n${markdownNotes(withoutExamples(variant))}\n\n`;
        output +=
          document(variant, title, seen, parent) ||
          `Body shape: ${typeDescription(variant, definitions, names)}.\n\n`;
      }
    // Composition-only wrappers can hide unions several allOf/reference levels
    // deep. Keep the complete common field view while following each wrapper.
    for (const branch of schema.allOf ?? [])
      if (branch.oneOf || branch.anyOf || branch.allOf || branch['x-sdk-ref'])
        output += document(branch, label, seen, parent);
    const ref = schema['x-sdk-ref'];
    if (ref && definitions[ref] && !seen.has(ref)) {
      const target = definitions[ref]!;
      if (target.oneOf || target.anyOf || target.allOf || target['x-sdk-ref'])
        output += document(target, label, new Set(seen).add(ref), parent);
    }
    return output;
  };
  return (
    document(body, `${op.resource}.${op.method} body`) ||
    `Body shape: ${typeDescription(body, definitions, names)}.\n\n`
  );
}
export function schemaVariants(
  schema: Schema,
  definitions: Record<string, Schema>,
  names?: ModelNames,
): string {
  const variants = schema.oneOf ?? schema.anyOf;
  if (!variants) return '';
  return (
    'Variants:\n\n' +
    variants
      .map((variant, i) => {
        const shape = typeDescription(variant, definitions, names);
        const fields = Object.entries(schemaFields(variant, definitions).fields);
        const tags = fields
          .filter(([, s]) => s.const !== undefined || s.enum?.length === 1)
          .map(
            ([key, s]) => `${literal(key)} = ${literal(JSON.stringify(s.const ?? s.enum?.[0]))}`,
          );
        const description = [
          shape,
          variant.description,
          tags.length
            ? tags.join(', ')
            : fields.length
              ? 'Fields: ' + fields.map(([key]) => literal(key)).join(', ')
              : '',
        ]
          .filter(Boolean)
          .join(' — ');
        return `- Variant ${i + 1}: ${description}.`;
      })
      .join('\n') +
    '\n\n'
  );
}
export function modelReference(
  c: Contract,
  exports?: Readonly<Record<string, ModelDocumentationExport>>,
  target: 'node' | 'php' = 'node',
  enumLinks?: EnumLinks,
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
  const section = (name: string, schema: Schema, names?: ModelNames, replacement = '') =>
    `## ${name}\n\n${replacement}${markdownNotes(schema)}\n\n${enumNotes(schemaEnumValues(schema, c.definitions ?? c.models), literal, enumLinks)}\n\n${fieldTable(schema, c.definitions ?? c.models, name, true, names, enumLinks)}${schemaVariants(schema, c.definitions ?? c.models, names)}`;
  return (
    `# ${c.title} models\n\n[API reference](REFERENCE.md) · [Runtime guide](RUNTIME.md)\n\nFields describe the API's declared shape. Inputs omit read-only fields; responses omit write-only fields and preserve unknown fields and enum values. ${target === 'node' ? 'Request enums are closed unions; response enums accept unknown strings. Input types use the Input suffix.' : 'Operation responses use presence-aware classes with typed getters; optional omitted fields return null.'}\n\nint64/uint64 values are integer strings${target === 'node' ? ' (TypeScript `${bigint}`); inputs also accept bigint' : ''}. Decimal fields use exact numeric strings. Use each field's declared units.\n\n` +
    Object.entries(c.models)
      .map(([name, schema]) => {
        if (!exports) return section(name, schema);
        const entry = exports[name];
        if (!entry) return '';
        return (
          (entry.output === name ? section(name, directionalSchema(schema, true), outputs) : '') +
          (entry.input
            ? entry.output === name &&
              stable(directionalSchema(schema, false)) === stable(directionalSchema(schema, true))
              ? `## ${entry.input}\n\nRequest input. Response: [${entry.output}](MODELS.md#${anchor(entry.output)}). Fields, descriptions and enum values are shared with that model; request enums accept only the listed values.\n\n`
              : section(
                  entry.input,
                  directionalSchema(schema, false),
                  inputs,
                  `Request input. Response: [${entry.output}](MODELS.md#${anchor(entry.output)}).\n\n`,
                )
            : '')
        );
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
      ? `Idempotent: key ${requiresIdempotencyKey(op) ? 'required' : op.idempotency.auto ? 'automatic' : 'optional'} — [policy ${idempotencyPolicies(c).findIndex((policy) => policy.header === op.idempotency!.header && policy.retention === op.idempotency!.retention && policy.scope === op.idempotency!.scope) + 1}](RUNTIME.md#idempotency).\n\n`
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
  const expand = (value: Schema, seen = new Set<string>()): Schema[] => {
    const { allOf, ['x-sdk-ref']: ref, ...own } = value;
    return [
      own,
      ...(allOf ?? []).flatMap((part) => expand(part, seen)),
      ...(ref && definitions[ref] && !seen.has(ref)
        ? expand(definitions[ref]!, new Set(seen).add(ref))
        : []),
    ];
  };
  const parts = expand(directionalSchema(schema, true));
  const alternative = parts.find((part) => part.oneOf || part.anyOf);
  const table = (value: Schema, label: string) => {
    const shape = schemaFields(value, definitions, new Set(), true);
    return fieldTable(
      {
        properties: Object.fromEntries(
          Object.entries(shape.fields).filter(([, field]) => !field.writeOnly),
        ),
        required: [...shape.required],
      },
      definitions,
      label,
      false,
      names,
      enumLinks,
    );
  };
  if (!alternative) return table(schema, scope);
  const common = parts.map(({ oneOf, anyOf, ...part }) => part);
  return (alternative.oneOf ?? alternative.anyOf ?? [])
    .map((variant, index) => {
      const shape = schemaFields(
        { allOf: [...common, directionalSchema(variant, true)] },
        definitions,
        new Set(),
        true,
      );
      return (
        `##### Response variant ${index + 1}\n\n${variant.description ?? ''}\n\n` +
        (table(
          { properties: shape.fields, required: [...shape.required] },
          `${scope} variant ${index + 1}`,
        ) || 'No top-level object fields in this variant.\n\n')
      );
    })
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
export function idempotencyReference(c: Contract): string {
  const policies = idempotencyPolicies(c);
  return policies.length
    ? '| Policy | Header | Retention | Scope |\n| --- | --- | --- | --- |\n' +
        policies
          .map(
            (policy, index) =>
              `| ${index + 1} | ${literalCell(policy.header)} | ${cell(policy.retention)} | ${cell(policy.scope)} |`,
          )
          .join('\n') +
        '\n\n'
    : '';
}

/** Provider error-code values are shared across model and operation field docs. */
export function errorCodeDocumentation(c: Contract): {
  links: Map<string, string>;
  reference: string;
} {
  const links = new Map<string, string>();
  const values = new Set<string>();
  if (c.config.errors?.codePath)
    for (const op of c.operations)
      for (const response of Object.values(op.responses)) {
        if (response.classification !== 'error' || !response.schema) continue;
        let shapes = [response.schema];
        for (const field of c.config.errors.codePath.split('.'))
          shapes = shapes.flatMap((shape) =>
            [shape, ...(shape.oneOf ?? shape.anyOf ?? [])].flatMap((part) => {
              const child = schemaFields(part, c.definitions ?? c.models).fields[field];
              return child ? [child] : [];
            }),
          );
        for (const shape of shapes)
          for (const entry of schemaEnumValues(shape, c.definitions ?? c.models)) {
            if (entry.path) continue;
            links.set(enumIdentity(entry.values), 'ERRORS.md#provider-error-codes');
            for (const value of entry.values) values.add(value);
          }
      }
  return {
    links,
    reference: values.size
      ? '# Provider error codes\n\n[Runtime error reference](RUNTIME.md#error-reference)\n\nInspect the provider code together with status and kind; retry only when the operation permits it. Declared values:\n\n' +
        [...values]
          .sort()
          .map((value) => '- ' + literal(value))
          .join('\n') +
        '\n\n'
      : '',
  };
}
