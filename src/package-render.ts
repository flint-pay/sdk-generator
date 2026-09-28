import ts from 'typescript';
import { codecClosure, packagePlan } from './package-plan.js';
import type { CompiledRuntimePlan } from './runtime-plan.js';
import type { CodecPlan } from './codec-plan.js';

export type Put = (path: string, value: string) => void;
const json = (value: unknown) => JSON.stringify(value);
const literal = (value: unknown) => json(value).replaceAll('"__proto__":', '["__proto__"]:');
const file = (name: string) => encodeURIComponent(name);

export function nodeDescriptors(runtime: CompiledRuntimePlan, put: Put) {
  const plan = packagePlan(runtime);
  const dataLines: string[] = [];
  const data = (value: unknown, codec = false): string => {
    const name = 'd' + dataLines.length;
    dataLines.push(
      `export const ${name} = ${codec ? '/* @__PURE__ */ lazyCodec(' : ''}${json(json(value))}${codec ? ')' : ''};`,
    );
    return name;
  };
  const codecData = new Map<string, string>();
  const resourceData = new Map<string, string>();
  const factoryData = new Map<string, { data: string; dependencies: string[] }>();
  put(
    'descriptors/settings.js',
    `export default ${json(plan.settings).replaceAll('"__proto__":', '["__proto__"]:')};\n`,
  );
  for (const [name, codec] of Object.entries(plan.definitions)) {
    const raw = data(codec, true);
    codecData.set(name, raw);
  }
  const dependencies = (names: string[], prefix: string) => ({
    imports: names.length
      ? `import { ${names.map((name, index) => `${codecData.get(name)} as c${index}`).join(', ')} } from '${prefix}descriptors/data.js';`
      : '',
    object: `{${names.map((name, index) => `[${json(name)}]:c${index}()`).join(',')}}`,
  });
  const loaders: string[] = [];
  for (const [name, group] of Object.entries(plan.resources)) {
    const deps = dependencies(group.dependencies, '../../');
    const raw = data(group.operations);
    resourceData.set(name, raw);
    put(
      `descriptors/resources/${file(name)}.js`,
      `${deps.imports}\nimport { ${raw} } from '../data.js';\nimport settings from '../settings.js';\nlet value;\nexport default function load() { return value ??= {...settings, operations: JSON.parse(${raw}), definitions:${deps.object}}; }\n`,
    );
    loaders.push(name);
  }
  const webhookData = plan.webhook ? data(plan.webhook.webhook) : undefined;
  if (plan.webhook) {
    const deps = dependencies(plan.webhook.dependencies, '../');
    put(
      'descriptors/webhook.js',
      `${deps.imports}\nimport { ${webhookData} } from './data.js';\nimport settings from './settings.js';\nlet value;\nexport default function load() { return value ??= {...settings, webhook:JSON.parse(${webhookData}), definitions:${deps.object}}; }\n`,
    );
  }
  const source = (groups: string[], prefix: string, webhook: boolean) => {
    const root = prefix === './';
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
    return `${deps.imports}\nimport { ${raw} } from '../descriptors/data.js';\nimport { lazyCodec, preparedCodec } from '../descriptor-source.js';\nconst read = ${raw};\nlet prepared;\nfunction codec() { return prepared ??= preparedCodec(read(), ${deps.object}); }\nexport { codec as _validate };\n`;
  };
  const finish = () => {
    put(
      'descriptors/data.js',
      `import { lazyCodec } from '../descriptor-source.js';\n` + dataLines.join('\n') + '\n',
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
    for (const name of symbols.keys()) if (name.startsWith(prefix)) names.add(name);
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
  for (const [name, nodes] of symbols) {
    let body = nodes.map((n) => n.getFullText(source)).join('\n');
    let names = refs(nodes, name);
    const alias = nodes.length === 1 ? nodes[0] : undefined;
    if (alias && ts.isTypeAliasDeclaration(alias) && !alias.typeParameters?.length) {
      const shape = alias.type.getText(source);
      const existing = shapes.get(shape);
      if (existing && shape.length > existing.length) {
        const start = alias.type.getStart(source) - alias.getFullStart();
        const end = alias.type.getEnd() - alias.getFullStart();
        body = body.slice(0, start) + existing + body.slice(end);
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
    put(`declarations/${file(name)}.d.ts`, `${headerFor(nodes)}\n${imports(names)}\n${body}\n`);
    const node = nodes[0];
    const publicSymbol =
      node &&
      ts.canHaveModifiers(node) &&
      ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (publicSymbol)
      rootExports.push(`export { ${name} } from './declarations/${file(name)}.js';`);
  }
  put('index.d.ts', rootExports.join('\n') + '\n');
  // Include the type dependency closure in selective entry points without importing the root.
  for (const [group, names] of roots) {
    const visit = (name: string): void => {
      for (const dependency of refs(symbols.get(name) ?? [], name))
        if (!names.has(dependency)) {
          names.add(dependency);
          visit(dependency);
        }
    };
    for (const name of [...names]) visit(name);
  }
  return roots;
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
