import { resolve } from 'node:path';
import type { Config } from './contract.js';
import { Diagnostic } from './diagnostic.js';
import { kebabWords, pascalWords } from './naming.js';
import { openApiObject, assertOpenApiVersion, readInput } from './openapi-input.js';

type Target = NonNullable<Config['targets']>[number];
type InitialConfig = Pick<Config, 'version'> & {
  targets: Target[];
  npm?: Config['npm'];
  composer?: Config['composer'];
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
  const value = openApiObject(readInput(resolve(apiPath)).value);
  assertOpenApiVersion(value.openapi);
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
  return {
    version: '0.1.0',
    targets: [...targets],
    ...(targets.includes('node') ? { npm: { name: '@example/' + slug } } : {}),
    ...(targets.includes('php') ? { composer: { name: 'example/' + slug, namespace } } : {}),
  };
}
