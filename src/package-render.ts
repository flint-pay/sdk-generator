import ts from 'typescript';
import { codecClosure, packagePlan } from './package-plan.js';
import type { CompiledRuntimePlan } from './runtime-plan.js';
import type { CodecPlan } from './codec-plan.js';
import { stable } from './canonical.js';

export type Put = (path: string, value: string) => void;
const json = (value: unknown) => JSON.stringify(value);
const literal = (value: unknown) => json(value).replaceAll('"__proto__":', '["__proto__"]:');
const file = (name: string) => encodeURIComponent(name);

export function nodeDescriptors(runtime: CompiledRuntimePlan, put: Put) {
  const plan = packagePlan(runtime);
  const dataFiles = new Map<string, string[]>();
  const dataPaths = new Map<string, string>();
  let nextData = 0;
  let bucket = 0;
  let bucketSize = 0;
  const data = (value: unknown, codec = false, group?: string): string => {
    const name = 'd' + nextData++;
    const line = `export const ${name} = ${codec ? '/* @__PURE__ */ lazyCodec(' : ''}${json(json(value))}${codec ? ')' : ''};`;
    if (bucketSize > 32768) {
      bucket++;
      bucketSize = 0;
    }
    const path = group ?? `data/${bucket}.js`;
    if (!group) bucketSize += line.length;
    dataFiles.set(path, [...(dataFiles.get(path) ?? []), line]);
    dataPaths.set(name, path);
    return name;
  };
  const codecData = new Map<string, string>();
  const resourceData = new Map<string, string>();
  const factoryData = new Map<string, { data: string; dependencies: string[] }>();
  put(
    'descriptors/settings.js',
    `export default ${json(plan.settings).replaceAll('"__proto__":', '["__proto__"]:')};\n`,
  );
  // Keep codecs with the same resource consumers adjacent in bounded data chunks.
  const consumers = new Map<string, string>();
  for (const [resource, group] of Object.entries(plan.resources))
    for (const name of group.dependencies)
      consumers.set(name, (consumers.get(name) ?? '') + ',' + resource);
  const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  for (const [name, codec] of Object.entries(plan.definitions).sort(
    ([a], [b]) => order(consumers.get(a) ?? '', consumers.get(b) ?? '') || order(a, b),
  )) {
    const raw = data(codec, true);
    codecData.set(name, raw);
  }
  const dataImports = (entries: [string, string][], prefix: string): string => {
    const imports = new Map<string, string[]>();
    for (const [name, alias] of entries) {
      const path = dataPaths.get(name);
      if (!path) throw new Error('Missing descriptor data ' + name);
      imports.set(path, [...(imports.get(path) ?? []), `${name} as ${alias}`]);
    }
    return [...imports]
      .map(([path, names]) => `import { ${names.join(', ')} } from '${prefix}descriptors/${path}';`)
      .join('\n');
  };
  const dependencies = (names: string[], prefix: string) => ({
    imports: dataImports(
      names.map((name, index) => [codecData.get(name)!, `c${index}`]),
      prefix,
    ),
    object: `{${names.map((name, index) => `[${json(name)}]:c${index}()`).join(',')}}`,
  });
  const loaders: string[] = [];
  for (const [name, group] of Object.entries(plan.resources)) {
    const deps = dependencies(group.dependencies, '../../');
    const raw = data(group.operations, false, `data/resource-${file(name)}.js`);
    resourceData.set(name, raw);
    put(
      `descriptors/resources/${file(name)}.js`,
      `${deps.imports}\n${dataImports([[raw, raw]], '../../')}\nimport settings from '../settings.js';\nlet value;\nexport default function load() { return value ??= {...settings, operations: JSON.parse(${raw}), definitions:${deps.object}}; }\n`,
    );
    loaders.push(name);
  }
  const webhookData = plan.webhook
    ? data(plan.webhook.webhook, false, 'data/webhook.js')
    : undefined;
  if (plan.webhook) {
    const deps = dependencies(plan.webhook.dependencies, '../');
    put(
      'descriptors/webhook.js',
      `${deps.imports}\n${dataImports([[webhookData!, webhookData!]], '../')}\nimport settings from './settings.js';\nlet value;\nexport default function load() { return value ??= {...settings, webhook:JSON.parse(${webhookData}), definitions:${deps.object}}; }\n`,
    );
  }
  const source = (groups: string[], prefix: string, webhook: boolean, root = prefix === './') => {
    const imports = root
      ? `import { resource, webhook, modelCodec as _sdkModelCodec } from './descriptors/root.js';\n` +
        groups.map((name, index) => `const r${index} = () => resource(${json(name)});`).join('\n')
      : groups
          .map(
            (name, index) =>
              `import r${index} from '${prefix}descriptors/resources/${file(name)}.js';`,
          )
          .join('\n');
    const routes = groups
      .flatMap((name, index) =>
        (plan.resources[name]?.operations ?? []).map((op) => `[${json(op.id)}]:r${index}`),
      )
      .join(',');
    return `${imports}\nimport { DescriptorSource } from '${prefix}descriptor-source.js';\nimport settings from '${prefix}descriptors/settings.js';\n${!root && webhook && plan.webhook ? `import webhook from '${prefix}descriptors/webhook.js';` : ''}\nconst _sdkDescriptors = new DescriptorSource(settings, {${routes}}${webhook && plan.webhook ? ', webhook' : ''});\n`;
  };
  const codec = (name: string, value: CodecPlan, shared?: string): string => {
    const names = [
      ...new Set([...(shared ? [shared] : []), ...codecClosure(value, plan.definitions)]),
    ].sort();
    const raw = shared ? codecData.get(shared) : data(value, true);
    if (!raw) throw new Error('Missing shared model codec ' + shared);
    factoryData.set(name, { data: raw, dependencies: names });
    const deps = dependencies(names, '../');
    return `${deps.imports}\n${dataImports([[raw, raw]], '../')}\nimport { lazyCodec, preparedCodec } from '../descriptor-source.js';\nconst read = ${raw};\nlet prepared;\nfunction codec() { return prepared ??= preparedCodec(read(), ${deps.object}); }\nexport { codec as _validate };\n`;
  };
  const finish = () => {
    for (const [path, lines] of dataFiles)
      put(
        'descriptors/' + path,
        `import { lazyCodec } from '../../descriptor-source.js';\n` + lines.join('\n') + '\n',
      );
    put(
      'descriptors/data.js',
      [...dataFiles.keys()].map((path) => `export * from './${path}';`).join('\n') + '\n',
    );
    put(
      'descriptors/root.js',
      `import * as data from './data.js';
import settings from './settings.js';
import { lazyCodec, preparedCodec } from '../descriptor-source.js';
const codecKeys = ${literal(Object.fromEntries(codecData))};
const resourceKeys = ${literal(Object.fromEntries(resourceData))};
const dependencies = ${literal(Object.fromEntries(Object.entries(plan.resources).map(([name, group]) => [name, group.dependencies])))};
const factories = ${literal(Object.fromEntries(factoryData))};
const codecs = new Map(), resources = new Map(), models = new Map();
function definitions(names) { return Object.fromEntries(names.map(name => { if (!codecs.has(name)) codecs.set(name, data[codecKeys[name]]()); return [name, codecs.get(name)]; })); }
export function resource(name) { if (!resources.has(name)) resources.set(name, {...settings, operations:JSON.parse(data[resourceKeys[name]]), definitions:definitions(dependencies[name])}); return resources.get(name); }
export function modelCodec(name) { if (!models.has(name)) { const entry=factories[name]; models.set(name, preparedCodec(data[entry.data](), definitions(entry.dependencies))); } return models.get(name); }
let events;
export function webhook() { return events ??= ${plan.webhook ? `{...settings, webhook:JSON.parse(data.${webhookData}), definitions:definitions(${json(plan.webhook.dependencies)})}` : 'undefined'}; }
`,
    );
  };
  return { source, codec, finish, groups: loaders, definitions: plan.definitions };
}

/** Filter only generated class syntax; resource semantics are already compiled. */
export function scopedNodeClients(code: string): (group: string) => string {
  const source = ts.createSourceFile(
    'index.js',
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const client = source.statements.find(
    (statement): statement is ts.ClassDeclaration =>
      ts.isClassDeclaration(statement) && statement.name?.text === 'Client',
  );
  if (!client) throw new Error('Missing generated Client');
  return (group) => {
    const members = client.members.flatMap((member) => {
      if (ts.isConstructorDeclaration(member)) {
        const statements =
          member.body?.statements.filter((statement) => {
            if (
              !ts.isExpressionStatement(statement) ||
              !ts.isBinaryExpression(statement.expression)
            )
              return true;
            const left = statement.expression.left;
            return (
              !ts.isPropertyAccessExpression(left) ||
              left.name.text === '#runtime' ||
              left.name.text === group
            );
          }) ?? [];
        return [
          `constructor(options = {}) {\n${statements.map((s) => s.getText(source)).join('\n')}\n}`,
        ];
      }
      if (member.name?.getText(source) === 'verifyWebhook') return [];
      return [member.getText(source)];
    });
    return `export class Client {\n${members.join('\n')}\n}\n`;
  };
}

/** Separate declarations by symbol, retaining overloads, documentation and public names. */
export function splitNodeDeclarations(
  text: string,
  groups: string[],
  put: Put,
  publicModels: ReadonlySet<string> = new Set(),
  modelCodecs: ReadonlyMap<string, CodecPlan> = new Map(),
  rootOnlyTypes: ReadonlySet<string> = new Set(),
): Map<string, Set<string>> {
  const source = ts.createSourceFile('index.d.ts', text, ts.ScriptTarget.Latest, true);
  const importStatements = source.statements.filter(ts.isImportDeclaration);
  const exports = source.statements
    .filter((s) => ts.isExportDeclaration(s))
    .map((s) => s.getText(source))
    .join('\n');
  const symbols = new Map<string, ts.Statement[]>();
  for (const s of source.statements) {
    if (
      (ts.isTypeAliasDeclaration(s) ||
        ts.isInterfaceDeclaration(s) ||
        ts.isFunctionDeclaration(s) ||
        ts.isClassDeclaration(s)) &&
      s.name
    ) {
      const name = s.name.text;
      symbols.set(name, [...(symbols.get(name) ?? []), s]);
    }
  }
  const refs = (nodes: readonly ts.Node[], exclude: string): Set<string> => {
    const names = new Set<string>();
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && node.text !== exclude && symbols.has(node.text))
        names.add(node.text);
      ts.forEachChild(node, visit);
    };
    nodes.forEach(visit);
    return names;
  };
  const imports = (names: Set<string>, prefix = './') =>
    [...names]
      .sort()
      .map((name) => `import type { ${name} } from '${prefix}${file(name)}.js';`)
      .join('\n');
  const headerFor = (nodes: readonly ts.Node[]): string => {
    const used = new Set<string>();
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) used.add(node.text);
      ts.forEachChild(node, visit);
    };
    nodes.forEach(visit);
    return importStatements
      .flatMap((statement) => {
        if (!ts.isStringLiteral(statement.moduleSpecifier)) return [];
        const bindings = statement.importClause?.namedBindings;
        if (!bindings || !ts.isNamedImports(bindings)) return [];
        const names = bindings.elements
          .filter((binding) => used.has(binding.name.text))
          .map((binding) => binding.getText(source));
        return names.length
          ? [
              `import type { ${names.join(', ')} } from '${statement.moduleSpecifier.text.replace('./', '../')}';`,
            ]
          : [];
      })
      .join('\n');
  };
  const client = symbols.get('Client')?.[0];
  if (!client || !ts.isClassDeclaration(client)) throw new Error('Missing Client declaration');
  const roots = new Map<string, Set<string>>();
  for (const group of groups) {
    const property = client.members.find((member) => member.name?.getText(source) === group);
    if (!property || !ts.isPropertyDeclaration(property) || !property.type)
      throw new Error('Missing resource declaration ' + group);
    const names = refs([property], 'Client');
    const prefix = (group[0]?.toUpperCase() ?? '') + group.slice(1);
    for (const name of symbols.keys())
      if (name.startsWith(prefix) && !rootOnlyTypes.has(name)) names.add(name);
    names.add('ClientOptions');
    roots.set(group, names);
    const resourceName = group[0]?.toUpperCase() + group.slice(1) + 'Resource';
    const common = client.members.filter(
      (m) => !ts.isPropertyDeclaration(m) && m.name?.getText(source) !== 'verifyWebhook',
    );
    const memberRefs = refs(common, 'Client');
    put(
      `resources/${file(group)}.d.ts`,
      `${exports.replaceAll("'./", "'../")}\n${headerFor([property, ...common])}\n${imports(new Set([...names, ...memberRefs]), '../declarations/')}\nexport interface ${resourceName} ${property.type.getText(source)}\nexport declare class Client {\n${common.map((m) => m.getFullText(source)).join('\n')}\nreadonly ${group}: ${resourceName};\n}\n`,
    );
  }
  const rootExports: string[] = [exports];
  const shapes = new Map<string, string>();
  const declarationRefs = new Map<string, Set<string>>();
  // Extending a fixed object keeps the owning symbol in inferred types. Be
  // conservative with intersections: conflicting discriminants can reduce an
  // otherwise object-shaped alias to never, which an interface cannot extend.
  const canExtend = (type: ts.TypeNode): boolean => {
    const fields = new Map<string, string>();
    const visit = (node: ts.TypeNode): boolean => {
      if (ts.isParenthesizedTypeNode(node)) return visit(node.type);
      if (ts.isIntersectionTypeNode(node)) return node.types.every(visit);
      if (!ts.isTypeLiteralNode(node)) return false;
      for (const member of node.members) {
        if (ts.isIndexSignatureDeclaration(member)) continue;
        if (!ts.isPropertySignature(member) || !member.type) return false;
        const key = member.name.getText(source);
        const value = member.type.getText(source);
        const previous = fields.get(key);
        if (previous && previous !== value && previous !== 'unknown' && value !== 'unknown')
          return false;
        if (value !== 'unknown' || !previous) fields.set(key, value);
      }
      return true;
    };
    return visit(type);
  };
  for (const [name, nodes] of symbols) {
    let body = nodes.map((n) => n.getFullText(source)).join('\n');
    let names = refs(nodes, name);
    const alias = nodes.length === 1 ? nodes[0] : undefined;
    if (alias && ts.isTypeAliasDeclaration(alias) && !alias.typeParameters?.length) {
      const shape = alias.type.getText(source);
      const existing = shapes.get(shape);
      if (existing && shape.length > existing.length) {
        if (publicModels.has(name) && canExtend(alias.type)) {
          const start = alias.getStart(source) - alias.getFullStart();
          // Preserve the declaration's own documentation and export modifier.
          const prefix = alias
            .getText(source)
            .slice(0, alias.name.getStart(source) - alias.getStart(source));
          body =
            body.slice(0, start) +
            prefix.replace(/type\s*$/, 'interface ') +
            `${name} extends ${existing} {}`;
        } else {
          const start = alias.type.getStart(source) - alias.getFullStart();
          const end = alias.type.getEnd() - alias.getFullStart();
          body = body.slice(0, start) + existing + body.slice(end);
        }
        names = new Set([existing]);
      } else shapes.set(shape, name);
    }
    if (name === 'Client') {
      const common = client.members.filter((m) => !ts.isPropertyDeclaration(m));
      names = refs(common, name);
      body = `export declare class Client {\n${common.map((m) => m.getFullText(source)).join('\n')}\n${groups.map((group) => `readonly ${group}: import('../resources/${file(group)}.js').${group[0]?.toUpperCase() + group.slice(1)}Resource;`).join('\n')}\n}`;
    }
    // Internal helper types become module exports solely for sibling declarations.
    const first = nodes[0];
    const exported =
      first &&
      ts.canHaveModifiers(first) &&
      ts.getModifiers(first)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported) body = 'export ' + body.trimStart();
    declarationRefs.set(name, names);
    put(`declarations/${file(name)}.d.ts`, `${headerFor(nodes)}\n${imports(names)}\n${body}\n`);
    const node = nodes[0];
    const publicSymbol =
      node &&
      ts.canHaveModifiers(node) &&
      ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (publicSymbol)
      rootExports.push(
        `export ${rootOnlyTypes.has(name) ? 'type ' : ''}{ ${name} } from './declarations/${file(name)}.js';`,
      );
  }
  put('index.d.ts', rootExports.join('\n') + '\n');
  // Retain component exports reached through the previous shared name, including
  // resource subpaths, while methods use their owning source component's name.
  const equivalentModels = new Map<string, string[]>();
  for (const [name, codec] of modelCodecs) {
    const key = stable(codec);
    equivalentModels.set(key, [...(equivalentModels.get(key) ?? []), name]);
  }
  const peers = new Map(
    [...equivalentModels.values()].flatMap((names) => names.map((name) => [name, names] as const)),
  );
  // Include the type dependency closure in selective entry points without importing the root.
  for (const [group, names] of roots) {
    const visit = (name: string): void => {
      for (const dependency of [...(peers.get(name) ?? []), ...refs(symbols.get(name) ?? [], name)])
        if (!names.has(dependency)) {
          names.add(dependency);
          visit(dependency);
        }
    };
    for (const name of [...names]) visit(name);
    // Add emitted sharing dependencies after the original closure, preserving
    // existing export order and names even when different codecs share a type.
    const visitShared = (name: string): void => {
      for (const dependency of declarationRefs.get(name) ?? [])
        if (!names.has(dependency)) {
          names.add(dependency);
          visitShared(dependency);
        }
    };
    for (const name of [...names]) visitShared(name);
  }
  return roots;
}

/** Coalesce large declaration graphs without duplicating types or changing public symbols. */
export function compactNodeDeclarations(files: Map<string, string>, prefix: string): void {
  const directory = prefix + 'declarations/';
  const declarations = [...files.keys()]
    .filter(
      (path) =>
        path.startsWith(directory) && path.endsWith('.d.ts') && path !== directory + 'Client.d.ts',
    )
    .sort();
  if (declarations.length < 128) return;
  const destinations = new Map(
    declarations.map((path, index) => [path, `${directory}types-${Math.floor(index / 64)}.d.ts`]),
  );
  const groups = new Map<string, string[]>();
  for (const [path, destination] of destinations)
    groups.set(destination, [...(groups.get(destination) ?? []), path]);
  const rewrite = (paths: string[], destination: string): string => {
    const imports = new Map<string, Map<string, string>>();
    const exports = new Map<string, { module: string; typeOnly: boolean; names: Set<string> }>();
    const bodies: string[] = [];
    for (const path of paths) {
      const source = ts.createSourceFile(path, files.get(path)!, ts.ScriptTarget.Latest, true);
      for (const statement of source.statements) {
        if (
          (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
          statement.moduleSpecifier &&
          ts.isStringLiteral(statement.moduleSpecifier)
        ) {
          const module = statement.moduleSpecifier.text;
          const base =
            module.startsWith('../declarations/') || module.startsWith('./declarations/')
              ? directory
              : path.startsWith(directory) && module.startsWith('./')
                ? directory
                : undefined;
          const target = base
            ? base + module.slice(module.lastIndexOf('/') + 1).replace(/\.js$/, '.d.ts')
            : undefined;
          const mapped = target ? destinations.get(target) : undefined;
          const specifier = mapped
            ? (destination.startsWith(directory)
                ? './'
                : destination.slice(prefix.length).includes('/')
                  ? '../declarations/'
                  : './declarations/') + mapped.slice(directory.length).replace(/\.d\.ts$/, '.js')
            : module;
          if (mapped === destination && ts.isImportDeclaration(statement)) continue;
          if (ts.isImportDeclaration(statement)) {
            const bindings = statement.importClause?.namedBindings;
            if (!bindings || !ts.isNamedImports(bindings) || statement.importClause?.name)
              throw new Error('Unsupported generated declaration import');
            const key = `${statement.importClause?.isTypeOnly ? 'type ' : ''}${specifier}`;
            const names = imports.get(key) ?? new Map<string, string>();
            for (const binding of bindings.elements)
              names.set(binding.name.text, binding.getText(source));
            imports.set(key, names);
          } else if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
            const key = `${statement.isTypeOnly ? 'type ' : ''}${specifier}`;
            const entry = exports.get(key) ?? {
              module: specifier,
              typeOnly: statement.isTypeOnly,
              names: new Set<string>(),
            };
            for (const binding of statement.exportClause.elements)
              entry.names.add(binding.getText(source));
            exports.set(key, entry);
          } else throw new Error('Unsupported generated declaration export');
        } else bodies.push(statement.getFullText(source));
      }
    }
    return (
      [...imports]
        .map(([key, names]) => {
          const typeOnly = key.startsWith('type ');
          return `import ${typeOnly ? 'type ' : ''}{ ${[...names.values()].join(', ')} } from '${typeOnly ? key.slice(5) : key}';`;
        })
        .join('\n') +
      '\n' +
      [...exports.values()]
        .map(
          (entry) =>
            `export ${entry.typeOnly ? 'type ' : ''}{ ${[...entry.names].join(', ')} } from '${entry.module}';`,
        )
        .join('\n') +
      '\n' +
      bodies.join('\n') +
      '\n'
    );
  };
  // Render against the complete old map before replacing any source modules.
  const updates = new Map<string, string>();
  for (const [destination, paths] of groups) updates.set(destination, rewrite(paths, destination));
  for (const path of files.keys())
    if (
      path.startsWith(prefix) &&
      path.endsWith('.d.ts') &&
      !destinations.has(path) &&
      (path === directory + 'Client.d.ts' ||
        /from ['\"]\.\.?\/declarations\//.test(files.get(path)!))
    )
      updates.set(path, rewrite([path], path));
  for (const path of destinations.keys()) files.delete(path);
  for (const [path, text] of updates) files.set(path, text);
}

/** PHP lexical scan: braces inside strings and comments do not delimit classes. */
export function splitPhpClasses(text: string): Map<string, string> {
  const result = new Map<string, string>();
  const pattern = /^(?:(?:final|abstract) )?(?:class|interface|trait) (\w+)/gm;
  let match: RegExpExecArray | null;
  let previousEnd = text.indexOf(';', text.indexOf('namespace ')) + 1;
  while ((match = pattern.exec(text))) {
    let position = text.indexOf('{', match.index),
      depth = 1;
    let quote = '',
      comment = '';
    while (++position < text.length && depth) {
      const char = text[position],
        next = text[position + 1];
      if (quote) {
        if (char === '\\') position++;
        else if (char === quote) quote = '';
        continue;
      }
      if (comment === '//') {
        if (char === '\n') comment = '';
        continue;
      }
      if (comment === '/*') {
        if (char === '*' && next === '/') {
          comment = '';
          position++;
        }
        continue;
      }
      if (char === "'" || char === '"') {
        quote = char;
        continue;
      }
      if (char === '/' && (next === '/' || next === '*')) {
        comment = '/' + next;
        position++;
        continue;
      }
      if (char === '{') depth++;
      if (char === '}') depth--;
    }
    if (depth) throw new Error('Unclosed generated PHP class ' + match[1]);
    const gap = text.slice(previousEnd, match.index);
    const doc = gap.lastIndexOf('/**');
    const prefix = doc >= 0 ? gap.slice(doc) : '';
    result.set(match[1] ?? '', prefix + text.slice(match.index, position));
    previousEnd = position;
    pattern.lastIndex = position;
  }
  return result;
}
