import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
/** Read declaration content across the package layout for documentation assertions. */
export function declarations(directory) {
  return [
    'index.d.ts',
    ...['declarations', 'resources'].flatMap((dir) =>
      readdirSync(join(directory, dir))
        .filter((name) => name.endsWith('.d.ts'))
        .sort()
        .map((name) => dir + '/' + name),
    ),
  ]
    .map((path) => readFileSync(join(directory, path), 'utf8'))
    .join('\n');
}
export function renderedDeclarations(files) {
  return [...files]
    .filter(
      ([path]) =>
        path === 'node/index.d.ts' || /^node\/(declarations|resources)\/.*\.d\.ts$/.test(path),
    )
    .sort(([a], [b]) => a.localeCompare(b, 'en'))
    .map(([path, content]) => path + '\n' + content)
    .join('\n');
}
