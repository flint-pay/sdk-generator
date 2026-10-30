import { resolve, relative } from 'node:path';
import { locateDiagnostic } from './input-diagnostics.js';
import type { Config, Schema } from './contract.js';
import { objectBodyConstraint } from './target-types.js';
import { successStatus } from './runtime-plan.js';
import { Diagnostic } from './diagnostic.js';
import { kebabWords, pascalWords } from './naming.js';
import { openApiObject, assertOpenApiVersion, readInput } from './openapi-input.js';

type Target = NonNullable<Config['targets']>[number];
type InitialConfig = Pick<Config, 'version'> & {
  targets: Target[];
  npm?: Config['npm'];
  composer?: Config['composer'];
  auth?: Config['auth'];
  responses?: Config['responses'];
};

/** Build editable package metadata without writing files or validating API capabilities. */
export function initialConfig(
  apiPath: string,
  { targets = ['node', 'php'] }: { targets?: readonly Target[] } = {},
): InitialConfig {
  if (
    !targets.length ||
    new Set(targets).size !== targets.length ||
    targets.some((target) => target !== 'node' && target !== 'php')
  )
    throw new Diagnostic('config/targets', 'select node and/or php, each once');
  const input = readInput(resolve(apiPath));
  let value: Record<string, unknown>;
  try {
    value = openApiObject(input.value);
    assertOpenApiVersion(value.openapi);
  } catch (error) {
    if (error instanceof Diagnostic)
      throw locateDiagnostic(error, [
        {
          source: relative(process.cwd(), resolve(apiPath)).replaceAll('\\', '/'),
          value: input.value,
        },
      ]);
    throw error;
  }
  const record = (item: unknown): item is Record<string, unknown> =>
    item !== null && typeof item === 'object' && !Array.isArray(item);
  // Adapt raw OpenAPI references and nullability for the owning object constraint.
  const responseShape = (item: unknown): Schema => {
    if (!record(item)) return {};
    const shape: Schema = {};
    if (typeof item.type === 'string') shape.type = item.nullable ? [item.type, 'null'] : item.type;
    else if (Array.isArray(item.type) && item.type.every((type) => typeof type === 'string'))
      shape.type = item.nullable ? [...new Set([...item.type, 'null'])] : item.type;
    if (typeof item.$ref === 'string' && item.$ref.startsWith('#/components/schemas/'))
      shape['x-sdk-ref'] = item.$ref.slice(21).replaceAll('~1', '/').replaceAll('~0', '~');
    for (const key of ['allOf', 'oneOf', 'anyOf'] as const)
      if (Array.isArray(item[key])) shape[key] = item[key].map(responseShape);
    return item.nullable && item.type === undefined ? { anyOf: [shape, { type: 'null' }] } : shape;
  };
  const rawSchemas =
    record(value.components) && record(value.components.schemas) ? value.components.schemas : {};
  const definitions = Object.fromEntries(
    Object.entries(rawSchemas).map(([name, schema]) => [name, responseShape(schema)]),
  );
  let requiresResult = false;
  if (record(value.paths))
    for (const item of Object.values(value.paths)) {
      if (!record(item)) continue;
      if (typeof item.$ref === 'string') requiresResult = true;
      for (const method of ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']) {
        const operation = item[method];
        if (!record(operation) || !record(operation.responses)) continue;
        for (const [status, response] of Object.entries(operation.responses)) {
          if (!successStatus(status) && status !== 'default') continue;
          const content = record(response) && record(response.content) ? response.content : {};
          const media = Object.entries(content).find(([name]) =>
            /(?:^|\/)json$|\+json$/.test(name),
          )?.[1];
          if (!record(media) || !objectBodyConstraint(responseShape(media.schema), definitions))
            requiresResult = true;
        }
      }
    }
  const info = value.info;
  const title =
    info && typeof info === 'object' && 'title' in info && typeof info.title === 'string'
      ? info.title
      : '';
  let slug = kebabWords(title) || 'sdk';
  // Leave room for @example/; preserve whole words unless the first word alone is too long.
  const maxSlugLength = 214 - '@example/'.length;
  if (slug.length > maxSlugLength) {
    const boundary = slug.lastIndexOf('-', maxSlugLength);
    slug = slug.slice(0, boundary > 0 ? boundary : maxSlugLength);
  }
  const pascal = pascalWords(title) || 'Sdk';
  const namespace = 'Example\\' + (/^\d/.test(pascal) ? 'Sdk' + pascal : pascal);
  const components = value.components;
  const schemes =
    components && typeof components === 'object' && 'securitySchemes' in components
      ? components.securitySchemes
      : undefined;
  const names =
    schemes && typeof schemes === 'object' && !Array.isArray(schemes) ? Object.keys(schemes) : [];
  const alternatives = new Map<string, string[]>();
  const collect = (security: unknown) => {
    if (!Array.isArray(security)) return;
    for (const requirement of security) {
      if (!requirement || typeof requirement !== 'object' || Array.isArray(requirement)) continue;
      const selected = Object.keys(requirement).sort();
      if (selected.length && selected.every((key) => names.includes(key)))
        alternatives.set(JSON.stringify(selected), selected);
    }
  };
  collect(value.security);
  if (value.paths && typeof value.paths === 'object')
    for (const item of Object.values(value.paths)) {
      if (!item || typeof item !== 'object') continue;
      for (const verb of ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'])
        if (verb in item) {
          const operation: unknown = Reflect.get(item, verb);
          if (operation && typeof operation === 'object' && 'security' in operation)
            collect(operation.security);
        }
    }
  if (!alternatives.size) for (const name of names) alternatives.set(name, [name]);
  const auth =
    names.length > 1
      ? {
          modes: Object.fromEntries(
            [...alternatives.values()].map((schemes, index) => ['auth' + (index + 1), { schemes }]),
          ),
        }
      : undefined;
  return {
    ...(auth ? { auth } : {}),
    version: '0.1.0',
    ...(requiresResult ? { responses: { return: 'result' as const } } : {}),
    targets: [...targets],
    ...(targets.includes('node') ? { npm: { name: '@example/' + slug } } : {}),
    ...(targets.includes('php') ? { composer: { name: 'example/' + slug, namespace } } : {}),
  };
}
