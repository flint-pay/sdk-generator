import { mkdtempSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RESPONSE_OBJECT_CODEC } from '../../dist/target-plan.js';
import { VALIDATION_MESSAGES } from '../../dist/runtime-plan.js';

export function runtimeTemplate() {
  const table = JSON.stringify(VALIDATION_MESSAGES).replaceAll('\\', '\\\\').replaceAll("'", "\\'");
  const object = JSON.stringify(RESPONSE_OBJECT_CODEC)
    .replaceAll('\\', '\\\\')
    .replaceAll("'", "\\'");
  return readFileSync(new URL('../../templates/Runtime.php', import.meta.url), 'utf8')
    .replace("/* VALIDATION_MESSAGES */ '{}'", `'${table}'`)
    .replace("/* RESPONSE_OBJECT_CODEC */ '{}'", `'${object}'`);
}

export function runtimeTemplatePath(t) {
  const dir = mkdtempSync(join(tmpdir(), 'sdk-runtime-template-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'Runtime.php');
  writeFileSync(path, runtimeTemplate());
  copyFileSync(
    new URL('../../templates/SchemaAdapter.php', import.meta.url),
    join(dir, 'SchemaAdapter.php'),
  );
  return path;
}
