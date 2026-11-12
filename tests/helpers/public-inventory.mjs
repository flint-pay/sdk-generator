import { pathItemFields } from '../../dist/path-item.js';
// Traverse schema locations, never annotation/literal data (including const.$ref).
const pointer = (value) => value.replaceAll('~', '~0').replaceAll('/', '~1');
const methods = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
export function publicInventory(document) {
  const keywords = {};
  const mappings = [];
  const operations = [];
  const incoming = [];
  const callbacks = [];
  const reference = (source, ref) => {
    if (!ref.startsWith('#/'))
      throw new Error('Inventory requires bundled local references: ' + ref);
    let value = document;
    for (const part of ref.slice(2).split('/'))
      value = value?.[part.replaceAll('~1', '/').replaceAll('~0', '~')];
    if (value === undefined) throw new Error('Unresolved inventory reference: ' + ref);
    return { ...source, pointer: ref.slice(1), value };
  };
  const fields = (value, pointer) =>
    Object.fromEntries(
      Object.entries(pathItemFields({ document: '', pointer, value }, reference)).map(
        ([key, field]) => [key, field.value],
      ),
    );
  const callback = (value, base, seen = new Set()) => {
    if (value?.$ref) {
      if (seen.has(value.$ref))
        throw new Error('Cyclic inventory callback reference: ' + value.$ref);
      return callback(
        reference({ document: '', pointer: base }, value.$ref).value,
        base,
        new Set([...seen, value.$ref]),
      );
    }
    for (const [expression, item] of Object.entries(value ?? {}).sort()) {
      if (expression.startsWith('x-')) continue;
      const path = base + '/' + pointer(expression);
      for (const [verb, op] of Object.entries(fields(item, path)).sort()) {
        if (!methods.has(verb)) continue;
        const location = path + '/' + verb;
        callbacks.push({
          pointer: location,
          id: op.operationId,
          requestMediaTypes: media(op.requestBody?.content, location + '/requestBody/content'),
          responses: Object.fromEntries(
            Object.entries(op.responses ?? {})
              .sort()
              .map(([status, response]) => [
                status,
                media(response.content, location + '/responses/' + status + '/content'),
              ]),
          ),
        });
        for (const [name, declaration] of Object.entries(op.callbacks ?? {}).sort())
          callback(declaration, location + '/callbacks/' + pointer(name), seen);
      }
    }
  };
  function schema(value, path) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    for (const key of Object.keys(value).sort())
      (keywords[key] ??= []).push(path + '/' + pointer(key));
    if (value.discriminator?.mapping)
      mappings.push({
        pointer: path + '/discriminator/mapping',
        mapping: value.discriminator.mapping,
      });
    for (const [name, child] of Object.entries(value.properties ?? {}).sort())
      schema(child, path + '/properties/' + pointer(name));
    for (const key of [
      'items',
      'additionalProperties',
      'not',
      'if',
      'then',
      'else',
      'contains',
      'propertyNames',
    ])
      schema(value[key], path + '/' + key);
    for (const key of ['allOf', 'anyOf', 'oneOf'])
      value[key]?.forEach((child, index) => schema(child, path + '/' + key + '/' + index));
  }
  function media(content, path) {
    return Object.entries(content ?? {})
      .sort()
      .map(([type, value]) => {
        schema(value.schema, path + '/' + pointer(type) + '/schema');
        return type;
      });
  }
  for (const [name, value] of Object.entries(document.components?.schemas ?? {}).sort())
    schema(value, '/components/schemas/' + pointer(name));
  for (const collection of ['paths', 'webhooks']) {
    for (const [path, source] of Object.entries(document[collection] ?? {}).sort()) {
      const base = '/' + collection + '/' + pointer(path);
      const item = fields(source, base);
      for (const [index, parameter] of (item.parameters ?? []).entries())
        schema(parameter.schema, base + '/parameters/' + index + '/schema');
      for (const [verb, operation] of Object.entries(item).sort()) {
        if (!methods.has(verb)) continue;
        const location = base + '/' + verb;
        for (const [index, parameter] of (operation.parameters ?? []).entries())
          schema(parameter.schema, location + '/parameters/' + index + '/schema');
        const record = {
          id: operation.operationId,
          pointer: location,
          security: operation.security ?? document.security ?? [],
          requestMediaTypes: media(
            operation.requestBody?.content,
            location + '/requestBody/content',
          ),
          responses: Object.fromEntries(
            Object.entries(operation.responses ?? {})
              .sort()
              .map(([status, response]) => [
                status,
                media(response.content, location + '/responses/' + status + '/content'),
              ]),
          ),
        };
        for (const [name, declaration] of Object.entries(operation.callbacks ?? {}).sort())
          callback(declaration, location + '/callbacks/' + pointer(name));
        if (collection === 'paths') operations.push(record);
        else incoming.push({ key: path, ...record });
      }
    }
  }
  return { operations, incoming, keywords, mappings, ...(callbacks.length ? { callbacks } : {}) };
}
