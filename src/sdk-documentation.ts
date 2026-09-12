import type { Contract, Operation, Schema } from './contract.js';
import { schemaNotes } from './schema-documentation.js';

const cell = (text: string) =>
  text
    .replaceAll('|', '\\|')
    .replace(/[\r\n]+/g, ' ')
    .replaceAll('<', '&lt;');
const anchor = (name: string) => name.toLowerCase();
export function schemaFields(
  schema: Schema,
  definitions: Record<string, Schema>,
  seen = new Set<string>(),
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
    const nested = schemaFields(branch, definitions, seen);
    for (const [key, value] of Object.entries(nested.fields)) fields[key] ??= value;
    for (const key of nested.required) required.add(key);
  }
  return { fields, required };
}
function typeDescription(s: Schema): string {
  if (s['x-sdk-ref']) return `[${s['x-sdk-ref']}](MODELS.md#${anchor(s['x-sdk-ref'])})`;
  if (s.oneOf || s.anyOf) return 'Alternative shapes (see declared variants)';
  if (s.type === 'array') return `Array of ${typeDescription(s.items ?? {})}`;
  const types = Array.isArray(s.type) ? s.type : [s.type ?? 'any'];
  return types
    .map((t) =>
      t === 'number' || (t === 'integer' && ['int64', 'uint64'].includes(s.format ?? ''))
        ? s['x-sdk-number-input'] === 'explicit'
          ? 'ExactNumber input; exact numeric string response'
          : 'exact numeric string'
        : t,
    )
    .join(' or ');
}
export function fieldTable(schema: Schema, definitions: Record<string, Schema>): string {
  const { fields, required } = schemaFields(schema, definitions);
  if (!Object.keys(fields).length) return '';
  return (
    '| Field | Presence | Type | Description |\n| --- | --- | --- | --- |\n' +
    Object.entries(fields)
      .map(([name, child]) => {
        const notes = [
          schemaNotes(child),
          child.enum ? 'Values: ' + child.enum.map((v) => JSON.stringify(v)).join(', ') + '.' : '',
          child.readOnly ? 'Response only.' : '',
          child.writeOnly ? 'Input only.' : '',
        ]
          .filter(Boolean)
          .join(' ');
        return `| \`${cell(name).replaceAll('`', '&#96;')}\` | ${required.has(name) ? 'Required' : 'Optional'} | ${typeDescription(child)} | ${cell(notes)} |`;
      })
      .join('\n') +
    '\n\n'
  );
}
export function modelReference(c: Contract): string {
  return (
    `# ${c.title} models\n\n[API reference](REFERENCE.md) · [Runtime guide](RUNTIME.md)\n\nFields below describe the API's declared shape. Inputs omit read-only fields; responses omit write-only fields and preserve unknown fields and enum values. Node input types add the suffix \`Input\`. PHP operation responses use presence-aware classes; nested values use the shapes below.\n\nExact numeric strings preserve JSON numeric precision. For a minor-unit amount, \`"100"\` is 100 minor units (USD 1.00), not USD 100.00. Use the field's documented units.\n\n` +
    Object.entries(c.models)
      .map(
        ([name, schema]) =>
          `## ${name}\n\n${schemaNotes(schema)}\n\n${fieldTable(schema, c.definitions ?? c.models)}${schema.oneOf || schema.anyOf ? `Variants: ${(schema.oneOf ?? schema.anyOf ?? []).map(typeDescription).join(', ')}.\n\n` : ''}`,
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
  return (
    (op.response?.return === 'payload'
      ? `Returns ${op.response.payloadPath ? 'the payload at `' + cell(op.response.payloadPath) + '`' : 'the complete decoded body'} directly. Use \`${op.method}WithResponse\` for \`body\`, \`meta\` and \`raw\` without unwrapping.\n\n`
      : '') +
    (c.authentication
      ? `Authentication modes: ${op.authModes?.map((m) => '`' + m + '`').join(', ') || 'none (unauthenticated)'}. See [credential setup](RUNTIME.md#authentication).\n\n`
      : '') +
    `Request options are the second argument. Default attempts: ${op.retry?.maxAttempts ?? 1}; maximum: ${op.retry?.maxAttempts ?? 1}. ` +
    (op.idempotency
      ? 'For mutation retries, supply a stable idempotency key and reuse it for the same business action. '
      : '') +
    (op.conditional
      ? `Use \`ifMatch\` to send the declared \`${op.conditional.header}\` header. `
      : '') +
    '\n\n'
  );
}
