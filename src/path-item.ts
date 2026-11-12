import { Diagnostic, pointerSegment } from './diagnostic.js';

interface Source {
  document: string;
  pointer: string;
  value: unknown;
}

/** Merge Path Item references without losing each field's source identity. */
export function pathItemFields<T extends Source>(
  source: T,
  reference: (source: T, ref: string) => T,
  location = source.pointer,
  seen: ReadonlySet<string> = new Set(),
): Record<string, T> {
  const item = source.value;
  if (!item || typeof item !== 'object' || Array.isArray(item))
    throw new Diagnostic(location, 'expected an object');
  let fields: Record<string, T> = Object.create(null);
  if ('$ref' in item) {
    const ref: unknown = item.$ref;
    if (typeof ref !== 'string' || /^\w+:/.test(ref) || ref.startsWith('//'))
      throw new Diagnostic(
        location,
        'remote references must be vendored locally for reproducible generation',
      );
    const target = reference(source, ref);
    const key = target.document + '#' + target.pointer;
    if (seen.has(key)) throw new Diagnostic(location, 'cyclic path item reference');
    fields = pathItemFields(target, reference, location, new Set([...seen, key]));
  }
  for (const [key, value] of Object.entries(item)) {
    if (key === '$ref') continue;
    if (key.startsWith('x-sdk-'))
      throw new Diagnostic(
        location,
        'x-sdk-* extensions are reserved for resolved generator metadata',
      );
    if (Object.hasOwn(fields, key))
      throw new Diagnostic(
        location + '/' + pointerSegment(key),
        'conflicting path item $ref field ' + key,
      );
    fields[key] = { ...source, value, pointer: source.pointer + '/' + pointerSegment(key) };
  }
  return fields;
}
