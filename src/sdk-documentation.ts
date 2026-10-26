import { stable } from './canonical.js';
import { compileRetry, requiresIdempotencyKey } from './runtime-plan.js';
import { directionalSchema, exactValue, valueInstruction } from './codec-plan.js';
import type { Contract, Operation, Schema } from './contract.js';
import { schemaNotes } from './schema-documentation.js';

const cell = (text: string) =>
  text
    .replaceAll('|', '\\|')
    .replace(/[\r\n]+/g, ' ')
    .replaceAll('<', '&lt;');
function literal(text: string, table = false): string {
  const value = (table ? text.replaceAll('|', '\\|') : text).replace(/[\r\n]+/g, ' ');
  const delimiter = '`'.repeat(
    Math.max(0, ...[...value.matchAll(/`+/g)].map((m) => m[0].length)) + 1,
  );
  const padding =
    value.startsWith('`') ||
    value.endsWith('`') ||
    (value.startsWith(' ') && value.endsWith(' ') && !/^ +$/.test(value))
      ? ' '
      : '';
  return `${delimiter}${padding}${value}${padding}${delimiter}`;
}
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
function modelName(schema: Schema, definitions: Record<string, Schema>): string | undefined {
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
function typeDescription(s: Schema, definitions: Record<string, Schema> = {}): string {
  const name = modelName(s, definitions);
  if (name) return `[${name}](MODELS.md#${anchor(name)})`;
  if (s.allOf) {
    const { allOf, ...base } = s;
    const types = [...new Set([base, ...allOf].map((part) => typeDescription(part, definitions)))];
    return types.filter((type) => type !== 'any').join(' and ') || 'any';
  }
  if (s.oneOf || s.anyOf) return 'Alternative shapes (see declared variants)';
  if (s.type === 'array') return `Array of ${typeDescription(s.items ?? {}, definitions)}`;
  const types = Array.isArray(s.type) ? s.type : [s.type ?? 'any'];
  return types
    .map((t) =>
      exactValue(valueInstruction(t, s.format))
        ? s['x-sdk-number-input'] === 'explicit'
          ? 'ExactNumber input; exact numeric string response'
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
        const declarations = (s: Schema): Schema[] => [s, ...(s.allOf ?? []).flatMap(declarations)];
        const parts = includeExamples ? [child] : declarations(child);
        const enumSets = parts.flatMap((part) =>
          part.enum ? [part.enum.map((value) => JSON.stringify(value))] : [],
        );
        const values = enumSets[0]?.filter((value) => enumSets.every((set) => set.includes(value)));
        const heading = `${scope} ${name} values`;
        const longEnum = values && values.join(', ').length > 140;
        if (longEnum)
          enums.push(
            `#### ${heading}\n\n${values.map((value) => '- ' + literal(value)).join('\n')}\n\n`,
          );
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
          longEnum
            ? `Values: [${values.length} declared values](#${anchor(heading)}).`
            : values
              ? 'Values: ' + values.map(literalCell).join(', ') + '.'
              : '',
          child.readOnly ? 'Response only.' : '',
          child.writeOnly ? 'Input only.' : '',
        ]
          .filter(Boolean)
          .join(' ');
        return `| \`${cell(name).replaceAll('`', '&#96;')}\` | ${required.has(name) ? 'Required' : 'Optional'} | ${typeDescription(child, includeExamples ? {} : definitions)} | ${notes} |`;
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
export function bodyReference(op: Operation, definitions: Record<string, Schema>): string {
  if (!op.body) return '';
  const body = op.body;
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
    );
    let output = modelName(schema, definitions)
      ? `Body model: ${typeDescription(schema, definitions)}.\n\n`
      : '';
    if (table) output += `#### ${label} fields\n\n${table}`;
    // Carry only the common field view into alternatives. Reusing the enclosing
    // graph would traverse the same references/compositions again at every level.
    const parent = { properties: shape.fields, required: [...shape.required] };
    for (const keyword of ['oneOf', 'anyOf'] as const)
      for (const [index, variant] of (schema[keyword] ?? []).entries()) {
        const title = `${label} ${keyword} variant ${index + 1}`;
        output += `#### ${title}\n\n${markdownNotes(withoutExamples(variant))}\n\n`;
        output +=
          document(variant, title, seen, parent) ||
          `Body shape: ${typeDescription(variant, definitions)}.\n\n`;
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
    `Body shape: ${typeDescription(body, definitions)}.\n\n`
  );
}
export function modelReference(c: Contract): string {
  return (
    `# ${c.title} models\n\n[API reference](REFERENCE.md) · [Runtime guide](RUNTIME.md)\n\nFields below describe the API's declared shape. Inputs omit read-only fields; responses omit write-only fields and preserve unknown fields and enum values. Node input types add the suffix \`Input\`. PHP operation responses use presence-aware classes; nested values use the shapes below.\n\nExact numeric strings preserve JSON numeric precision. For a minor-unit amount, \`"100"\` is 100 minor units (USD 1.00), not USD 100.00. Use the field's documented units.\n\n` +
    Object.entries(c.models)
      .map(
        ([name, schema]) =>
          `## ${name}\n\n${markdownNotes(schema)}\n\n${fieldTable(schema, c.definitions ?? c.models, name)}${schema.oneOf || schema.anyOf ? `Variants: ${(schema.oneOf ?? schema.anyOf ?? []).map((variant) => typeDescription(variant)).join(', ')}.\n\n` : ''}`,
      )
      .join('')
  );
}
export function authenticationGuide(c: Contract): string {
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
    '\n\nTypeScript checks mode names, credential keys, and the modes permitted by each operation. Credentials themselves are never shown in SDK diagnostics.\n\n'
  );
}
export function operationGuidance(c: Contract, op: Operation): string {
  const { retry, replay } = compileRetry(op);
  const guidance =
    (op.response?.return === 'payload'
      ? `Returns ${op.response.payloadPath ? 'the payload at `' + cell(op.response.payloadPath) + '`' : 'the complete decoded body'} directly. Use \`${op.method}WithResponse\` for \`body\`, \`meta\` and \`raw\` without unwrapping.\n\n`
      : '') +
    (c.authentication
      ? `Authentication modes: ${op.authModes?.map((m) => '`' + m + '`').join(', ') || 'none (unauthenticated)'}. See [credential setup](RUNTIME.md#authentication).\n\n`
      : '') +
    `Pass request options as the last argument. Attempt limit: ${retry.maxAttempts}. Client and request maxAttempts are capped at this limit. ` +
    (retry.maxAttempts > 1
      ? `Retry statuses: ${retry.statuses.join(', ') || 'none'}; transport retries: ${retry.transport ? 'enabled' : 'disabled'}. `
      : 'The SDK sends at most one attempt. ') +
    (retry.maxAttempts > 1 && c.config.errors?.retry
      ? `Body retry signal: \`${cell(c.config.errors.retry.path)}\`; retry values: ${c.config.errors.retry.retryValues.map((value) => literalCell(value)).join(', ')}. A string signal overrides statuses and code rules; otherwise statuses apply. HTTP 412 never retries. `
      : '') +
    (retry.maxAttempts > 1 && !c.config.errors?.retry && retry.errors?.length
      ? `Code-specific retries: ${retry.errors.map((rule) => `HTTP ${rule.status} (${rule.codes.map((code) => '`' + cell(code) + '`').join(', ')})`).join('; ')}. `
      : '') +
    (replay === 'idempotency' && op.idempotency && !op.idempotency.auto
      ? 'Without an optional idempotency key, mutations send once; required keys remain required. '
      : '') +
    (op.idempotency
      ? `${requiresIdempotencyKey(op) ? 'Required idempotencyKey: save a key with the action before the first attempt and reuse it on retry. ' : ''}Supports idempotencyKey for the declared ${op.idempotency.header} header. Persist and reuse the key for the same business action. ${op.idempotency.auto ? 'When no key is supplied, the SDK generates one for this call; automatic keys cover one SDK call only. ' : ''}`
      : 'idempotencyKey is not supported on this operation. ') +
    (op.conditional
      ? `Use \`ifMatch\` to send the declared \`${op.conditional.header}\` header. `
      : '');
  return guidance.trimEnd() + '\n\n';
}
