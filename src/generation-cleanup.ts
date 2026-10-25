import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  openSync,
  closeSync,
  linkSync,
  readdirSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve, dirname, basename, join } from 'node:path';

/** Publish a complete owner record atomically; interrupts never leave an empty lock. */
export function acquireGenerationLock(path: string, owner: object): number {
  const temporary = path + '.acquire-' + process.pid + '-' + randomUUID();
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(owner));
    linkSync(temporary, path);
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Called only after the supervised generation worker has exited. */
export function cleanupInterruptedGeneration(output: string, pid: number): void {
  output = resolve(output);
  const lock = output + '.sdk-generator.lock';
  const parent = dirname(output);
  for (const path of existsSync(parent) ? readdirSync(parent) : [])
    if (
      [basename(lock), basename(lock) + '.recovery'].some(
        (prefix) =>
          path.startsWith(prefix + '.acquire-' + pid + '-') &&
          /^[a-f0-9-]{36}$/.test(path.slice((prefix + '.acquire-' + pid + '-').length)),
      )
    )
      rmSync(join(parent, path), { force: true });
  const recovery = lock + '.recovery';
  if (existsSync(recovery)) {
    let lease: unknown;
    try {
      lease = JSON.parse(readFileSync(recovery, 'utf8'));
    } catch {
      /* Unknown owners require manual inspection. */
    }
    if (lease && typeof lease === 'object' && 'pid' in lease && lease.pid === pid)
      rmSync(recovery, { force: true });
  }
  if (!existsSync(lock)) return;
  let owner: unknown;
  try {
    owner = JSON.parse(readFileSync(lock, 'utf8'));
  } catch {
    return;
  }
  if (!owner || typeof owner !== 'object' || !('pid' in owner) || owner.pid !== pid) return;
  const sibling = (key: 'stage' | 'backup'): string | undefined => {
    const value: unknown = Reflect.get(owner, key);
    const prefix = output + '.' + key + '-';
    return typeof value === 'string' &&
      value.startsWith(prefix) &&
      /^[a-f0-9-]{36}$/.test(value.slice(prefix.length))
      ? value
      : undefined;
  };
  const stage = sibling('stage'),
    backup = sibling('backup');
  if (backup && existsSync(backup)) {
    if (!existsSync(output)) renameSync(backup, output);
    else rmSync(backup, { recursive: true, force: true });
  }
  if (stage) rmSync(stage, { recursive: true, force: true });
  rmSync(lock, { force: true });
}
