import type { Schema } from './contract.js';
import { compileDocumentation, factEnums, documentationPositions } from './documentation-plan.js';
import { factNotes, factSourceDocumentation } from './documentation-format.js';

export function schemaLiteral(text: string, table = false): string {
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
/** Human-facing field semantics; kept out of codec and compatibility plans. */
export function schemaNotes(
  s: Schema,
  formatting: { literal?: (text: string) => string; description?: (text: string) => string } = {},
): string {
  return factNotes(compileDocumentation(s).root, formatting);
}

const noAliases: Readonly<Record<string, string>> = {};
const symbolNames = new WeakMap<
  object,
  WeakMap<object, Map<boolean, Readonly<Record<string, string>>>>
>();
/** Share the target's symbol inventory across field projections. */
export function modelDocumentationNames(
  definitions: Readonly<Record<string, Schema>>,
  response: boolean,
  aliases: Readonly<Record<string, string>> = noAliases,
): Readonly<Record<string, string>> {
  let inventories = symbolNames.get(definitions);
  if (!inventories) symbolNames.set(definitions, (inventories = new WeakMap()));
  let directions = inventories.get(aliases);
  if (!directions) inventories.set(aliases, (directions = new Map()));
  let names = directions.get(response);
  if (!names) {
    names = Object.fromEntries(
      Object.keys(definitions).map((name) => [
        name,
        (aliases[name] ?? name) + (response ? '' : 'Input'),
      ]),
    );
    directions.set(response, names);
  }
  return names;
}

export function schemaComment(
  s: Schema,
  definitions: Readonly<Record<string, Schema>> = {},
  response = false,
  aliases: Readonly<Record<string, string>> = noAliases,
): string {
  const names = modelDocumentationNames(definitions, response, aliases);
  const facts = compileDocumentation(s, definitions, response);
  const notes = factSourceDocumentation(
    facts.root,
    facts.definitions,
    documentationPositions(facts.root, facts.definitions),
    names,
  );
  return notes ? '\n/** ' + notes.replaceAll('*/', '* /').replace(/[\r\n]+/g, ' ') + ' */\n' : '';
}

export interface SchemaEnumValues {
  /** Empty for the value itself; [] for items and .* for dictionary values. */
  path: string;
  values: string[];
}
export type EnumLinks = ReadonlyMap<string, string>;
export const enumIdentity = (values: readonly string[]) => JSON.stringify([...values].sort());

/** Read declared enum metadata through references, compositions and collection elements. */
export function schemaEnumValues(
  schema: Schema,
  definitions: Readonly<Record<string, Schema>> = {},
  seen = new Set<string>(),
): SchemaEnumValues[] {
  const facts = compileDocumentation(schema, schema['x-sdk-definitions'] ?? definitions);
  return factEnums(facts.root, facts.definitions, seen);
}

export function enumNotes(
  entries: readonly SchemaEnumValues[],
  literal: (text: string) => string = (text) => text,
  links?: EnumLinks,
): string {
  return entries
    .map(({ path, values }) => {
      const label = path
        ? `${path.startsWith('[]') ? 'Items' : 'Map'}${path.slice(2)} values`
        : 'Values';
      const link = links?.get(enumIdentity(values));
      return `${label}: ${link ? `[${values.length} declared values](${link})` : values.map(literal).join(', ')}.`;
    })
    .join(' ');
}
