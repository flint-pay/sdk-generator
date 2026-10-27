import { createHash } from 'node:crypto';
import { protectedAnnotations } from './documentation-publication.mjs';
// Test-owned OpenAPI/profile derivation. No generated interface, compiler plan,
// documentation schema, or production semantic helper is an expectation input.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';

export const factKeys = [
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'minProperties',
  'maxProperties',
  'uniqueItems',
  'pattern',
];
export const words = (s) =>
  s
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((s) => s.toLowerCase());
export const pascal = (s) =>
  words(s)
    .map((s) => s[0].toUpperCase() + s.slice(1))
    .join('');
const camel = (s) => s.map((s, i) => (i ? s[0].toUpperCase() + s.slice(1) : s)).join('');
const singular = (s) =>
  s.endsWith('ies')
    ? s.slice(0, -3) + 'y'
    : /(?:ches|shes|xes|zes|sses)$/.test(s)
      ? s.slice(0, -2)
      : s.endsWith('s') && !/(?:ss|us|is)$/.test(s)
        ? s.slice(0, -1)
        : s;
function operationName(id, tags) {
  const parts = words(id),
    candidates = new Map();
  for (const tag of tags ?? []) {
    const w = words(tag);
    for (let i = 1; i + w.length <= parts.length; i++)
      if (w.length && w.every((s, j) => singular(s) === singular(parts[i + j]))) {
        const resource = camel(w),
          method = camel([...parts.slice(0, i), ...parts.slice(i + w.length)]);
        candidates.set(resource + '.' + method, { resource, method });
      }
  }
  return candidates.size === 1 ? [...candidates.values()][0] : { resource: 'api', method: id };
}
const merge = (a, b) => {
  if (Array.isArray(a) && Array.isArray(b)) return [...new Set([...a, ...b])];
  if (
    a &&
    b &&
    typeof a === 'object' &&
    typeof b === 'object' &&
    !Array.isArray(a) &&
    !Array.isArray(b)
  )
    return Object.fromEntries(
      [...new Set([...Object.keys(a), ...Object.keys(b)])].map((k) => [
        k,
        k in b ? merge(a[k], b[k]) : a[k],
      ]),
    );
  return b;
};
export function readDocumentationProfile(path, seen = new Set()) {
  path = resolve(path);
  assert.ok(!seen.has(path), 'profile cycle');
  const p = JSON.parse(readFileSync(path, 'utf8'));
  let result = {};
  for (const part of p.profiles ?? [])
    result = merge(
      result,
      readDocumentationProfile(resolve(dirname(path), part), new Set(seen).add(path)),
    );
  const { profiles, ...own } = p;
  return merge(result, own);
}
export function rawEnumDomain(s, definitions, seen = new Set()) {
  const sets = [];
  if (s.enum) sets.push(s.enum);
  if (Object.hasOwn(s, 'const')) sets.push([s.const]);
  const ref = s['x-sdk-ref'];
  if (ref && definitions[ref] && !seen.has(ref)) {
    const values = rawEnumDomain(definitions[ref], definitions, new Set(seen).add(ref));
    if (values) sets.push(values);
  }
  for (const part of s.allOf ?? []) {
    const values = rawEnumDomain(part, definitions, seen);
    if (values) sets.push(values);
  }
  for (const key of ['oneOf', 'anyOf'])
    if (s[key]) {
      const groups = s[key].map((part) => rawEnumDomain(part, definitions, seen));
      if (groups.every(Boolean)) sets.push([...new Set(groups.flat())]);
    }
  return sets.length ? sets.reduce((a, b) => a.filter((v) => b.includes(v))) : undefined;
}

export function rawDocumentationInput(api, profile) {
  const document =
    typeof api === 'string' ? JSON.parse(readFileSync(api, 'utf8')) : structuredClone(api);
  const config =
    typeof profile === 'string' ? readDocumentationProfile(profile) : structuredClone(profile);
  for (const [pointer, value] of Object.entries(config.overrides ?? {})) {
    const keys = pointer
      .replace(/^#?\//, '')
      .split('/')
      .map((s) => s.replaceAll('~1', '/').replaceAll('~0', '~'));
    const key = keys.pop();
    const owner = keys.reduce((o, k) => o[k], document);
    owner[key] = value;
  }
  const protectedNodes = protectedAnnotations(document);
  const schemas = document.components?.schemas ?? {};
  const rename = Object.fromEntries(Object.keys(schemas).map((n) => [n, config.models?.[n] ?? n]));
  const normalize = (s) => {
    if (!s || typeof s !== 'object') return s;
    const out = { ...s };
    if (protectedNodes.has(s))
      for (const key of ['example', 'examples', 'default']) delete out[key];
    if (s.$ref) {
      assert.ok(
        s.$ref.startsWith('#/components/schemas/'),
        'oracle requires a bundled schema reference: ' + s.$ref,
      );
      const name = decodeURIComponent(s.$ref.slice('#/components/schemas/'.length))
        .replaceAll('~1', '/')
        .replaceAll('~0', '~');
      delete out.$ref;
      out['x-sdk-ref'] = rename[name];
    }
    if (s.nullable && s.type) {
      out.type = Array.isArray(s.type) ? [...new Set([...s.type, 'null'])] : [s.type, 'null'];
      delete out.nullable;
    }
    for (const key of ['properties'])
      if (s[key])
        out[key] = Object.fromEntries(Object.entries(s[key]).map(([k, v]) => [k, normalize(v)]));
    for (const key of [
      'items',
      'additionalProperties',
      'propertyNames',
      'not',
      'contains',
      'if',
      'then',
      'else',
    ])
      if (s[key] && typeof s[key] === 'object') out[key] = normalize(s[key]);
    for (const key of ['allOf', 'oneOf', 'anyOf']) if (s[key]) out[key] = s[key].map(normalize);
    if (Array.isArray(out.type) && out.type.filter((t) => t !== 'null').length > 1) {
      const { type, ...siblings } = out;
      return { ...siblings, anyOf: type.map((type) => ({ type })) };
    }
    return out;
  };
  const models = Object.fromEntries(
    Object.entries(schemas).map(([n, s]) => [rename[n], normalize(s)]),
  );
  // Incoming payload and event names are publication naming rules, derived
  // from their raw source keys rather than a generated contract inventory.
  for (const [key, item] of Object.entries(document.webhooks ?? {}))
    for (const method of ['post', 'put', 'get', 'patch', 'delete', 'head', 'options']) {
      const body = item[method]?.requestBody?.content?.['application/json']?.schema;
      if (body) {
        const name =
          'IncomingWebhook' +
          createHash('sha256')
            .update(key + '/' + method)
            .digest('hex')
            .slice(0, 12) +
          'Payload';
        models[name] = normalize(body);
      }
    }
  if (config.webhook)
    for (const [name, schema] of Object.entries(models).filter(([n]) =>
      n.startsWith('IncomingWebhook'),
    )) {
      const values = payloadSchemas(
        { responses: { 200: { schema } }, response: { payloadPath: config.webhook.typeField } },
        models,
      ).flatMap((s) => rawEnumDomain(s, models) ?? []);
      for (const event of values)
        if (typeof event === 'string') models['WebhookEvent' + pascal(event)] ??= schema;
    }
  for (const [event, schema] of Object.entries(config.webhook?.events ?? {}))
    models['WebhookEvent' + pascal(event)] ??= normalize(schema);
  const operations = [];
  for (const [path, item] of Object.entries(document.paths ?? {}))
    for (const verb of ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']) {
      const op = item[verb];
      if (!op) continue;
      const id = op.operationId,
        settings = config.operations?.[id] ?? {};
      if ((config.include && !config.include.includes(id)) || config.exclude?.includes(id))
        continue;
      const media = (content) =>
        Object.entries(content ?? {}).find(([name]) => /json/.test(name))?.[1]?.schema;
      const body = media(op.requestBody?.content);
      operations.push({
        id,
        path,
        verb,
        ...operationName(id, op.tags),
        ...settings,
        body: body && normalize(body),
        responses: Object.fromEntries(
          Object.entries(op.responses ?? {}).map(([status, r]) => [
            status,
            { schema: media(r.content) && normalize(media(r.content)) },
          ]),
        ),
        response: { ...config.responses, ...settings.response },
      });
    }
  return { rawDocumentation: true, document, config, models, definitions: models, operations };
}

// A small independent keyword reader, not an execution/compiler adapter. The
// records retain raw keyword values; no production normalization is consulted.
const instructions = new WeakMap();
export function schemaInstruction(s) {
  const saved = instructions.get(s);
  if (saved) return saved;
  const types = Array.isArray(s.type) ? s.type : [s.type],
    type = types.find((t) => t !== 'null') ?? (s.type === undefined ? undefined : 'null');
  const kind =
    type === 'integer'
      ? /^(?:u?int64)$/.test(s.format)
        ? 'exact-integer'
        : 'safe-integer'
      : type === 'number'
        ? s.format === 'decimal'
          ? 'decimal'
          : 'native-number'
        : type === 'string'
          ? s.format === 'date-time'
            ? 'date-time'
            : 'string'
          : (type ?? 'dynamic');
  const result = {
    value: { kind },
    nullable: s.type === undefined || types.includes('null'),
    reference: s['x-sdk-ref'],
    checks: Object.fromEntries(factKeys.filter((k) => s[k] !== undefined).map((k) => [k, s[k]])),
    members: s.enum,
    literal: Object.hasOwn(s, 'const') ? JSON.stringify(s.const) : undefined,
    requiredInput: (s.required ?? []).filter((k) => !s.properties?.[k]?.readOnly),
    requiredOutput: (s.required ?? []).filter((k) => !s.properties?.[k]?.writeOnly),
    rejectInput: !!s.readOnly,
    hiddenOutput: !!s.writeOnly,
    fields:
      s.properties &&
      Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, schemaInstruction(v)])),
    element: s.items && schemaInstruction(s.items),
    extra:
      typeof s.additionalProperties === 'object'
        ? schemaInstruction(s.additionalProperties)
        : s.additionalProperties,
  };
  for (const [key, out] of [
    ['allOf', 'every'],
    ['oneOf', 'exactlyOne'],
    ['anyOf', 'some'],
  ])
    if (s[key]) result[out] = s[key].map(schemaInstruction);
  instructions.set(s, result);
  return result;
}
export function directionalSchema(s, response) {
  return {
    ...s,
    ...(s.properties
      ? {
          properties: Object.fromEntries(
            Object.entries(s.properties)
              .filter(([, s]) => !(response ? s.writeOnly : s.readOnly))
              .map(([k, v]) => [k, directionalSchema(v, response)]),
          ),
          required: (s.required ?? []).filter(
            (k) => !(response ? s.properties[k]?.writeOnly : s.properties[k]?.readOnly),
          ),
        }
      : {}),
    ...Object.fromEntries(
      ['allOf', 'oneOf', 'anyOf']
        .filter((k) => s[k])
        .map((k) => [k, s[k].map((v) => directionalSchema(v, response))]),
    ),
  };
}
export function payloadSchemas(op, defs) {
  const common = (s, seen = new Set()) => {
    const { allOf, ['x-sdk-ref']: ref, ...own } = s;
    return [
      own,
      ...(allOf ?? []).flatMap((v) => common(v, seen)),
      ...(ref && defs[ref] && !seen.has(ref) ? common(defs[ref], new Set(seen).add(ref)) : []),
    ];
  };
  const project = (schema, keys) => {
    if (!keys.length) return [schema];
    const scopes = common(schema);
    const index = scopes.findIndex((s) => s.oneOf || s.anyOf);
    if (index >= 0) {
      const { oneOf, anyOf, ...own } = scopes[index];
      return (oneOf ?? anyOf).flatMap((branch) =>
        project(
          { allOf: [...scopes.slice(0, index), own, branch, ...scopes.slice(index + 1)] },
          keys,
        ),
      );
    }
    const [key, ...rest] = keys,
      children = scopes.flatMap((s) => (s.properties?.[key] ? [s.properties[key]] : []));
    if (!children.length) return [];
    return project(children.length === 1 ? children[0] : { allOf: children }, rest);
  };
  return Object.entries(op.responses)
    .filter(([status]) => /^2\d\d$/.test(status))
    .flatMap(([, r]) =>
      r.schema
        ? project(r.schema, (op.response?.payloadPath ?? '').split('.').filter(Boolean))
        : [],
    );
}

function commonScopes(schema, definitions, seen = new Set()) {
  const { allOf, ['x-sdk-ref']: ref, ...own } = schema;
  return [
    own,
    ...(allOf ?? []).flatMap((s) => commonScopes(s, definitions, seen)),
    ...(ref && definitions[ref] && !seen.has(ref)
      ? commonScopes(definitions[ref], definitions, new Set(seen).add(ref))
      : []),
  ];
}
/** Target naming inventory read from actual declarations, not documentation
 * plans. Alias spelling and hydrated class identities are the ONLY facts read
 * here; semantic nullability, bounds and branches always come from OpenAPI. */
export function documentedModels(directory, input) {
  assert.equal(input.rawDocumentation, true, 'oracle requires raw OpenAPI + profile');
  input = rawDocumentationInput(input.document, input.config);
  input.definitions = input.models;
  const php = directory.endsWith('/php'),
    source = join(directory, php ? 'src/classes' : 'declarations');
  const files = readdirSync(source).filter((n) => (php ? n.endsWith('.php') : n.endsWith('.d.ts')));
  const texts = files.map((n) => readFileSync(join(source, n), 'utf8'));
  const aliases = new Map();
  if (!php)
    for (const text of texts)
      for (const m of text.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/export type (\w+) = (\w+);/g))
        aliases.set(m[1], m[2]);
  if (!php) {
    // A response alias is a public name substitution, read from method return
    // declarations paired with the raw operation's declared payload reference.
    const resources = join(directory, 'resources');
    for (const file of readdirSync(resources).filter((n) => n.endsWith('.d.ts'))) {
      const resource = file.slice(0, -5),
        text = readFileSync(join(resources, file), 'utf8');
      for (const op of input.operations.filter((o) => o.resource === resource)) {
        const returned = text.match(
          new RegExp('\\b' + op.method + '\\([^\\n]*\\): Promise<([A-Z]\\w*)>;'),
        )?.[1];
        const values =
          op.response?.return === 'payload' && op.response?.payloadPath
            ? payloadSchemas(op, input.definitions)
            : Object.entries(op.responses)
                .filter(([s]) => /^2\d\d$/.test(s))
                .flatMap(([, r]) => (r.schema ? [r.schema] : []));
        for (const schema of values)
          if (returned && schema['x-sdk-ref'] && returned !== schema['x-sdk-ref'])
            aliases.set(schema['x-sdk-ref'], returned);
      }
    }
  }
  const nodeTypes = new Map();
  if (!php)
    for (const text of texts) {
      const ast = ts.createSourceFile(
        'declaration.d.ts',
        text,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      for (const node of ast.statements)
        if (ts.isTypeAliasDeclaration(node)) nodeTypes.set(node.name.text, node.type);
    }
  const unwrap = (n) => (ts.isParenthesizedTypeNode(n) ? unwrap(n.type) : n);
  const fieldsOf = (n) => {
    n = unwrap(n);
    if (ts.isTypeLiteralNode(n))
      return new Map(n.members.filter(ts.isPropertySignature).map((p) => [p.name.text, p.type]));
    if (ts.isUnionTypeNode(n) || ts.isIntersectionTypeNode(n))
      return new Map(n.types.flatMap((t) => [...fieldsOf(t)]));
    return new Map();
  };
  // Learn only reference spelling/aliases from the public type syntax. All
  // schema keywords, including nullable wrappers, remain independently raw.
  if (!php) {
    const seen = new WeakMap();
    const learn = (s, n, inputDirection = false) => {
      if (!s || !n) return;
      n = unwrap(n);
      const visited = seen.get(s) ?? new Set();
      if (visited.has(n)) return;
      visited.add(n);
      seen.set(s, visited);
      if (ts.isTypeReferenceNode(n)) {
        const label = n.typeName.getText();
        if (label === 'InputValue' && n.typeArguments?.[0])
          return learn(s, n.typeArguments[0], inputDirection);
        if (['Array', 'ReadonlyArray'].includes(label) && s.items && n.typeArguments?.[0])
          return learn(s.items, n.typeArguments[0], inputDirection);
        if (nodeTypes.has(label)) {
          const ref = s['x-sdk-ref'];
          if (ref && !inputDirection && ref !== label && !nodeTypes.has(ref))
            aliases.set(ref, label);
          if (!ref && !inputDirection) s['x-sdk-type-name'] = label;
          if (ref && input.definitions[ref])
            learn(input.definitions[ref], nodeTypes.get(label), inputDirection);
          return;
        }
      }
      if (s.items && ts.isArrayTypeNode(n)) learn(s.items, n.elementType, inputDirection);
      if (s.items && (ts.isUnionTypeNode(n) || ts.isIntersectionTypeNode(n)))
        for (const t of n.types)
          if (ts.isArrayTypeNode(unwrap(t))) learn(s.items, unwrap(t).elementType, inputDirection);
      const fields = fieldsOf(n);
      for (const [key, value] of Object.entries(s.properties ?? {}))
        if (fields.has(key)) learn(value, fields.get(key), inputDirection);
      if (typeof s.additionalProperties === 'object' && ts.isTypeLiteralNode(n))
        for (const member of n.members)
          if (ts.isIndexSignatureDeclaration(member))
            learn(s.additionalProperties, member.type, inputDirection);
      for (const key of ['allOf', 'oneOf', 'anyOf'])
        for (const part of s[key] ?? []) learn(part, n, inputDirection);
    };
    for (let pass = 0; pass < 3; pass++)
      for (const [name, schema] of Object.entries(input.models)) {
        let label = name;
        const seen = new Set();
        while (aliases.has(label) && !seen.has(label)) {
          seen.add(label);
          label = aliases.get(label);
        }
        if (nodeTypes.has(label)) learn(schema, nodeTypes.get(label));
        if (nodeTypes.has(name + 'Input')) learn(schema, nodeTypes.get(name + 'Input'), true);
      }
  }
  if (!php) {
    // Input-page response labels are public alias spelling. Read names only,
    // and require the destination to be an actual declared TypeScript symbol.
    const docs = [];
    const collect = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name === 'models') collect(join(dir, entry.name));
        else if (entry.isFile() && /\.md$/.test(entry.name))
          docs.push(readFileSync(join(dir, entry.name), 'utf8'));
      }
    };
    collect(directory);
    for (const text of docs)
      for (const m of text.matchAll(/^## (\w+)Input\n[\s\S]*?(?=^## |$(?![\s\S]))/gm)) {
        const label = m[0].match(/Request input\. Response: \[([^\]]+)\]/)?.[1];
        if (label && label !== m[1] && nodeTypes.has(label)) aliases.set(m[1], label);
      }
  }
  const outputName = (n) => {
    const seen = new Set();
    while (aliases.has(n) && !seen.has(n)) {
      seen.add(n);
      n = aliases.get(n);
    }
    return n;
  };
  const labels = new Set(
    php
      ? files.map((n) => n.slice(0, -4))
      : texts.flatMap((t) => [...t.matchAll(/export type (\w+) =/g)].map((m) => m[1])),
  );
  const documentRoots = new Set();
  const modelTexts = [
    readFileSync(join(directory, 'MODELS.md'), 'utf8'),
    ...(existsSync(join(directory, 'models'))
      ? readdirSync(join(directory, 'models'))
          .filter((n) => n.endsWith('.md'))
          .map((n) => readFileSync(join(directory, 'models', n), 'utf8'))
      : []),
  ];
  for (const text of modelTexts)
    for (const match of text.matchAll(/^## (\w+)\n/gm))
      if (match[1] !== 'Index') documentRoots.add(match[1]);
  const inputNames = Object.fromEntries(
    Object.keys(input.models)
      .filter((n) => labels.has(n + 'Input'))
      .map((n) => [n, n + 'Input']),
  );
  const outputNames = Object.fromEntries(
    Object.keys(input.models)
      .filter((n) => labels.has(php ? n : outputName(n)))
      .map((n) => [n, php ? n : outputName(n)]),
  );
  const models = [];
  const origins = new Map();
  const clean = (s) =>
    Array.isArray(s)
      ? s.map(clean)
      : s && typeof s === 'object'
        ? Object.fromEntries(
            Object.keys(s)
              .sort()
              .filter((k) => !['x-sdk-type-name', 'x-oracle-inline'].includes(k))
              .map((k) => [k, clean(s[k])]),
          )
        : s;
  const sourceKeys = new Map();
  const add = (name, schema, response) => {
    if (!labels.has(name) || !documentRoots.has(name)) return;
    const ref = schema['x-sdk-ref'];
    const origin =
      ref && input.definitions[ref]
        ? {
            ...input.definitions[ref],
            ...Object.fromEntries(Object.entries(schema).filter(([k]) => k !== 'x-sdk-ref')),
          }
        : schema;
    const key = JSON.stringify([response, clean(directionalSchema(origin, response))]);
    const previous = models.find((m) => m.name === name && m.response === response);
    if (!previous) {
      models.push({
        name,
        schema: directionalSchema(schema, response),
        sources: [directionalSchema(schema, response)],
        response,
      });
      origins.set(name, key);
      sourceKeys.set(name, new Set([key]));
    } else if (!sourceKeys.get(name).has(key)) {
      sourceKeys.get(name).add(key);
      previous.sources.push(directionalSchema(schema, response));
      previous.schema = { allOf: previous.sources };
      origins.delete(name);
    }
  };
  for (const [n, s] of Object.entries(input.models)) {
    add(n + 'Input', s, false);
    if (php) add(n, s, true);
  }
  if (!php)
    for (const name of new Set(Object.keys(input.models).map(outputName))) {
      const declarations = Object.entries(input.models)
        .filter(([n]) => outputName(n) === name)
        .map(([, s]) => directionalSchema(s, true));
      add(name, declarations.length > 1 ? { anyOf: declarations } : declarations[0], true);
    }
  if (!php)
    for (const [name, schema] of Object.entries(input.models))
      if (documentRoots.has(name) && !models.some((m) => m.name === name && m.response))
        add(name, schema, true);
  // Public operation response class names, including envelope/nested classes.
  for (const op of input.operations)
    for (const [status, r] of Object.entries(op.responses))
      if (r.schema)
        add(
          op.resource[0].toUpperCase() +
            op.resource.slice(1) +
            op.method[0].toUpperCase() +
            op.method.slice(1) +
            'Response' +
            status[0].toUpperCase() +
            status.slice(1),
          r.schema,
          true,
        );
  if (php)
    for (const op of input.operations)
      for (const [status, response] of Object.entries(op.responses))
        if (response.schema) {
          const scopes = commonScopes(response.schema, input.definitions),
            choice = scopes.find((s) => s.oneOf || s.anyOf);
          if (choice) {
            const prefix =
              op.resource[0].toUpperCase() +
              op.resource.slice(1) +
              op.method[0].toUpperCase() +
              op.method.slice(1) +
              'Response' +
              status[0].toUpperCase() +
              status.slice(1);
            for (const [index, branch] of (choice.oneOf ?? choice.anyOf).entries())
              add(
                prefix + 'Variant' + index,
                { allOf: [...scopes.map(({ oneOf, anyOf, ...s }) => s), branch] },
                true,
              );
          }
        }
  if (php) {
    const properties = new Map(
      texts.flatMap((t, i) => [
        [
          files[i].slice(0, -4),
          new Map([...t.matchAll(/@property-read ([^\n]+?) \$(\w+)/g)].map((m) => [m[2], m[1]])),
        ],
      ]),
    );
    const defs = input.definitions;
    const fields = (s, seen = new Set()) => {
      const ref = s['x-sdk-ref'];
      return Object.assign(
        {},
        s.properties,
        ...(s.allOf ?? []).map((s) => fields(s, seen)),
        ...(ref && defs[ref] && !seen.has(ref) ? [fields(defs[ref], new Set(seen).add(ref))] : []),
      );
    };
    const bind = (s, type, seen = new Set()) => {
      const names = [...type.matchAll(/\b[A-Z]\w*\b/g)]
        .map((m) => m[0])
        .filter((n) => labels.has(n));
      const ref = s['x-sdk-ref'];
      if (type.includes('stdClass') && names.length) {
        const parts = commonScopes(s, defs),
          choice = parts.find((v) => v.oneOf || v.anyOf),
          discriminator = parts.find((v) => v.discriminator)?.discriminator;
        if (choice && discriminator) {
          const mapping = discriminator.mapping ?? {};
          const branches = choice.oneOf ?? choice.anyOf;
          const tagBranches = new Map();
          for (const [tag, reference] of Object.entries(mapping)) {
            const rawName = reference.split('/').at(-1),
              name = input.config.models?.[rawName] ?? rawName;
            if (defs[name]) tagBranches.set(tag, defs[name]);
          }
          if (!tagBranches.size)
            for (const branch of branches) {
              const scalarSchemas = payloadSchemas(
                {
                  responses: {
                    200: {
                      schema: {
                        allOf: [...parts.map(({ oneOf, anyOf, ...base }) => base), branch],
                      },
                    },
                  },
                  response: { payloadPath: discriminator.propertyName },
                },
                defs,
              );
              for (const tag of scalarSchemas.flatMap((value) => rawEnumDomain(value, defs) ?? []))
                if (typeof tag === 'string') tagBranches.set(tag, branch);
            }
          const choices = [...tagBranches.keys()].sort(
            (a, b) => pascal(b).length - pascal(a).length,
          );
          for (const label of names) {
            const tag = choices.find((tag) => label.endsWith(pascal(tag))),
              branch = tagBranches.get(tag);
            if (branch)
              add(
                label,
                { allOf: [...parts.map(({ oneOf, anyOf, ...base }) => base), branch] },
                true,
              );
          }
          return s;
        }
      }
      if (
        ref &&
        !names.length &&
        defs[ref] &&
        ['string', 'integer', 'number', 'boolean'].includes(defs[ref].type) &&
        !seen.has(ref)
      ) {
        const { ['x-sdk-type-name']: _name, ...expanded } = defs[ref];
        return bind(
          { ...expanded, ...s, ['x-sdk-ref']: undefined, 'x-oracle-inline': true },
          type,
          new Set(seen).add(ref),
        );
      }
      if (ref && names.length === 1 && !s.items && !s.additionalProperties) {
        add(names[0], s, !names[0].endsWith('Input'));
        return { ...s, 'x-sdk-type-name': names[0], 'x-oracle-bound-owner': names[0] };
      }
      if (s.oneOf || s.anyOf)
        return {
          ...s,
          ...Object.fromEntries(
            ['oneOf', 'anyOf']
              .filter((k) => s[k])
              .map((k) => [k, s[k].map((s) => bind(s, type, seen))]),
          ),
        };
      if (s.items)
        return {
          ...s,
          items: bind(s.items, type.replace(/^list</, '').replace(/>\|null$|>$/, ''), seen),
        };
      if (typeof s.additionalProperties === 'object')
        return {
          ...s,
          additionalProperties: bind(
            s.additionalProperties,
            type.replace(/^array<array-key, /, '').replace(/>\|null$|>$/, ''),
            seen,
          ),
        };
      if (names.length === 1 && (s.type === 'object' || Object.keys(fields(s)).length)) {
        add(names[0], s, !names[0].endsWith('Input'));
        return { ...s, 'x-sdk-type-name': names[0], 'x-oracle-bound-owner': names[0] };
      }
      return s;
    };
    // Each class is paired with its original schema before following its getter
    // identities. Bound annotations never replace a containing union/null node.
    for (let pass = 0; pass < 2; pass++)
      for (let i = 0; i < models.length; i++) {
        const m = models[i];
        if (!m.response) continue;
        const types = properties.get(m.name) ?? new Map();
        const walk = (s, seen = new Set()) => {
          const ref = s['x-sdk-ref'];
          if (ref && defs[ref] && !seen.has(ref)) {
            const { ['x-sdk-ref']: _ref, ...own } = s;
            return { allOf: [walk(defs[ref], new Set(seen).add(ref)), walk(own, seen)] };
          }
          return {
            ...s,
            ...(s.properties
              ? {
                  properties: Object.fromEntries(
                    Object.entries(s.properties).map(([n, v]) => [n, bind(v, types.get(n) ?? '')]),
                  ),
                }
              : {}),
            ...Object.fromEntries(
              ['allOf', 'oneOf', 'anyOf']
                .filter((k) => s[k])
                .map((k) => [k, s[k].map((v) => walk(v, seen))]),
            ),
          };
        };
        // Resolve a root reference for its field layout, retaining raw semantics.
        const source = m.sources.length === 1 ? m.sources[0] : { allOf: m.sources };
        m.schema = walk(source);
      }
    Object.assign(
      outputNames,
      Object.fromEntries(models.filter((m) => m.response).map((m) => [m.name, m.name])),
    );
  }
  return {
    models,
    inputNames,
    outputNames,
    aliases,
    definitions: input.definitions,
    origins,
    documentRoots,
  };
}
