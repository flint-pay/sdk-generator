import type { Schema } from './contract.js';
import { stable } from './canonical.js';

/** Positive declarations constraining the same value, including referenced alternatives. */
export function valueScopes(
  shape: Schema,
  definitions: Readonly<Record<string, Schema>> = {},
  seen = new Set<string>(),
): Schema[] {
  const reference = shape['x-sdk-ref'];
  if (reference) {
    const target = Object.hasOwn(definitions, reference) ? definitions[reference] : undefined;
    return target && !seen.has(reference)
      ? valueScopes(target, definitions, new Set([...seen, reference]))
      : [];
  }
  return [
    shape,
    ...[...(shape.allOf ?? []), ...(shape.oneOf ?? []), ...(shape.anyOf ?? [])].flatMap((branch) =>
      valueScopes(branch, definitions, seen),
    ),
  ];
}

/** Project enum intersections into SDK input representations, without changing codecs.
 * A numeric enum around a union must be interpreted separately in each branch:
 * it constrains exact-number strings, but excludes a JSON-string branch.
 */
export function numericEnumDeclaration(
  schema: Schema,
  definitions: Readonly<Record<string, Schema>> = {},
): Schema {
  const children = (s: Schema): Schema[] => [
    ...Object.values(s.properties ?? {}),
    ...(s.items ? [s.items] : []),
    ...(typeof s.additionalProperties === 'object' ? [s.additionalProperties] : []),
    ...(s.allOf ?? []),
    ...(s.oneOf ?? []),
    ...(s.anyOf ?? []),
  ];
  const hasEnum = (s: Schema): boolean =>
    (s.type === undefined && Boolean(s.enum?.some((v) => typeof v === 'number'))) ||
    children(s).some(hasEnum);
  if (!hasEnum(schema)) return schema;
  const conjuncts = ({ allOf, ...s }: Schema): Schema[] => [s, ...(allOf ?? []).flatMap(conjuncts)];
  let parts = conjuncts(schema);
  if (parts.some((part) => part.enum?.some((value) => typeof value === 'number'))) {
    // An enum contains only scalar values in the supported subset. At this use
    // site, expose a reference's scalar alternatives without expanding recursive
    // properties/items, which cannot contribute to any of those enum values.
    const scalarView = (s: Schema, seen = new Set<string>()): Schema => {
      const reference = s['x-sdk-ref'];
      if (reference && Object.hasOwn(definitions, reference) && !seen.has(reference))
        return scalarView(definitions[reference]!, new Set([...seen, reference]));
      const { properties, items, additionalProperties, ...view } = s;
      // Keep array declarations structurally complete for the type renderer;
      // their element graph is irrelevant to the enclosing scalar enum.
      if (items) view.items = {};
      for (const key of ['allOf', 'anyOf', 'oneOf'] as const)
        if (s[key]) view[key] = s[key]!.map((branch) => scalarView(branch, seen));
      if (s.not) view.not = scalarView(s.not, seen);
      return view;
    };
    parts = parts.flatMap((part) => (part['x-sdk-ref'] ? conjuncts(scalarView(part)) : [part]));
  }
  const hasShape = (s: Schema): boolean =>
    s.type !== undefined || Boolean(s.properties || s.items || s.additionalProperties);
  for (const [index, part] of parts.entries()) {
    const keyword = part.oneOf ? 'oneOf' : part.anyOf ? 'anyOf' : undefined;
    if (!keyword) continue;
    const { [keyword]: branches, ...base } = part;
    const siblings = [...parts.slice(0, index), base, ...parts.slice(index + 1)];
    if (!siblings.some(hasEnum) && !(hasEnum(part) && siblings.some(hasShape))) continue;
    // Both union keywords are TypeScript unions. Keep keyword scope in the
    // original schema; only this declaration view distributes the intersection.
    return {
      anyOf: branches!.map((branch) =>
        numericEnumDeclaration({ allOf: [...siblings, branch] }, definitions),
      ),
    };
  }
  const projected = structuredClone(parts);
  const declared = parts.filter((s) => s.type !== undefined);
  const types = (s: Schema): string[] =>
    s.type === undefined ? [] : Array.isArray(s.type) ? s.type : [s.type];
  const numeric = declared.find((s) => types(s).some((t) => ['number', 'integer'].includes(t)));
  let changed = false;
  for (const part of projected) {
    if (part.type !== undefined || !part.enum?.some((v) => typeof v === 'number')) continue;
    const members = part.enum.filter((v) =>
      declared.every((s) =>
        types(s).some((t) =>
          v === null
            ? t === 'null'
            : typeof v === 'number'
              ? t === 'number' || t === 'integer'
              : t === typeof v,
        ),
      ),
    );
    if (members.length !== part.enum.length) {
      part.enum = members;
      changed = true;
    }
    if (numeric && members.some((v) => typeof v === 'number')) {
      part.type = structuredClone(numeric.type!);
      if (numeric.format !== undefined) part.format = numeric.format;
      changed = true;
    }
  }
  const specialize = (values: Schema[]): void => {
    if (values.length < 2) return;
    const intersection = { allOf: values };
    const view = numericEnumDeclaration(intersection, definitions);
    if (view === intersection) return;
    changed = true;
    // Each occurrence describes the same field. Sharing its complete projected
    // constraint keeps nested unions and dictionary/property scopes aligned.
    for (const value of values) {
      const flags = Object.fromEntries(
        ['readOnly', 'writeOnly'].filter((key) => value[key] === true).map((key) => [key, true]),
      );
      for (const key of Object.keys(value)) delete value[key];
      Object.assign(value, structuredClone(view), flags);
    }
  };
  visitIntersectedProperties(projected, specialize);
  specialize(projected.flatMap((s) => (s.items ? [s.items] : [])));
  specialize(
    projected.flatMap((s) =>
      typeof s.additionalProperties === 'object' ? [s.additionalProperties] : [],
    ),
  );
  return changed ? { allOf: projected } : schema;
}

/** Specialize corresponding fields in a caller-owned conjunction. */
export function visitIntersectedProperties(
  shapes: readonly Schema[],
  visit: (children: Schema[], name: string) => void,
): void {
  const names = new Set(shapes.flatMap((shape) => Object.keys(shape.properties ?? {})));
  for (const name of names) {
    const children: Schema[] = [];
    const defaults: { shape: Schema; child: Schema; before: string }[] = [];
    for (const shape of shapes) {
      const declared = Object.hasOwn(shape.properties ?? {}, name)
        ? shape.properties?.[name]
        : undefined;
      if (declared) children.push(declared);
      else if (typeof shape.additionalProperties === 'object') {
        // Each conjunct has its own property scope. Its dictionary rule still
        // applies when a different conjunct explicitly declares this name.
        // Specialization must not mutate the rule used by unrelated keys.
        const child = structuredClone(shape.additionalProperties);
        children.push(child);
        defaults.push({ shape, child, before: stable(child) });
      }
    }
    visit(children, name);
    for (const { shape, child, before } of defaults)
      if (stable(child) !== before) shape.properties = { ...shape.properties, [name]: child };
  }
}
