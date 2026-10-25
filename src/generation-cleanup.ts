import {
  existsSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
  openSync,
  closeSync,
  linkSync,
  readdirSync,
  fstatSync,
  statSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve, dirname, basename, join } from 'node:path';

export interface GenerationOwner {
  pid: number;
  token: string;
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export function isGenerationOwner(value: unknown): value is GenerationOwner {
  return (
    !!value &&
    typeof value === 'object' &&
    'pid' in value &&
    typeof value.pid === 'number' &&
    Number.isSafeInteger(value.pid) &&
    value.pid > 0 &&
    'token' in value &&
    typeof value.token === 'string' &&
    uuid.test(value.token)
  );
}
function readOwner(fd: number): unknown {
  const size = fstatSync(fd).size;
  if (size > 65536) return undefined;
  const contents = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const bytes = readSync(fd, contents, offset, size - offset, offset);
    if (!bytes) return undefined;
    offset += bytes;
  }
  try {
    return JSON.parse(contents.toString('utf8'));
  } catch {
    return undefined;
  }
}
function matchesOwner(value: unknown, expected: GenerationOwner): value is GenerationOwner {
  return isGenerationOwner(value) && isGenerationOwner(expected) && value.token === expected.token;
}

/** Publish a complete owner record atomically; interrupts never leave an empty lock. */
export function acquireGenerationLock<T extends GenerationOwner>(path: string, owner: T): number {
  if (!isGenerationOwner(owner)) throw new Error('generation lock requires a transaction token');
  const temporary = path + '.acquire-' + owner.pid + '-' + owner.token + '-' + randomUUID();
  const fd = openSync(temporary, 'wx+', 0o600);
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

/** Check transaction identity before retiring the pathname, then verify its inode. */
export function releaseGenerationLock(path: string, fd: number, owner: GenerationOwner): void {
  if (!matchesOwner(readOwner(fd), owner)) throw new Error('generation lock ownership changed');
  const expected = fstatSync(fd);
  const retired = path + '.release-' + process.pid + '-' + owner.token + '-' + randomUUID();
  try {
    const published = statSync(path);
    if (expected.dev !== published.dev || expected.ino !== published.ino)
      throw new Error('generation lock ownership changed; preserved the replacement lock');
    renameSync(path, retired);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  const actual = statSync(retired);
  if (expected.dev !== actual.dev || expected.ino !== actual.ino) {
    linkSync(retired, path);
    rmSync(retired);
    throw new Error('generation lock ownership changed; preserved the replacement lock');
  }
  rmSync(retired);
}

export class GenerationRecoveryBusy extends Error {}

/** All stale recovery and supervisor filesystem cleanup share this lease. */
export function withGenerationRecovery<T>(
  output: string,
  action: (cleanup: (owner: GenerationOwner) => void) => T,
  owner: GenerationOwner = { pid: process.pid, token: randomUUID() },
): T {
  output = resolve(output);
  const recovery = output + '.sdk-generator.lock.recovery';
  const lease = { pid: process.pid, token: owner.token };
  let fd: number;
  try {
    fd = acquireGenerationLock(recovery, lease);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')
      throw new GenerationRecoveryBusy('another process holds the generation recovery lease');
    throw error;
  }
  try {
    return action((expected) => cleanupOwnedGeneration(output, expected));
  } finally {
    try {
      releaseGenerationLock(recovery, fd, lease);
    } finally {
      closeSync(fd);
    }
  }
}

/** Called only after the supervised generation worker has exited. */
export function cleanupInterruptedGeneration(output: string, owner: GenerationOwner): void {
  if (!isGenerationOwner(owner)) return;
  output = resolve(output);
  const lock = output + '.sdk-generator.lock';
  const parent = dirname(output);
  if (!existsSync(parent)) return;
  // An interrupted publication can leave an incomplete record. Its filename
  // carries the supervisor's token so PID reuse cannot claim another worker's file.
  for (const path of readdirSync(parent))
    if (
      [basename(lock), basename(lock) + '.recovery'].some((prefix) =>
        ['acquire', 'release'].some((kind) => {
          const start = prefix + '.' + kind + '-' + owner.pid + '-' + owner.token + '-';
          return path.startsWith(start) && uuid.test(path.slice(start.length));
        }),
      )
    )
      rmSync(join(parent, path), { force: true });
  const recovery = lock + '.recovery';
  let recoveryFd: number | undefined;
  try {
    recoveryFd = openSync(recovery, 'r');
    const lease = readOwner(recoveryFd);
    if (matchesOwner(lease, owner)) releaseGenerationLock(recovery, recoveryFd, owner);
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT')
      throw error;
  } finally {
    if (recoveryFd !== undefined) closeSync(recoveryFd);
  }
  try {
    withGenerationRecovery(output, (cleanup) => cleanup(owner), owner);
  } catch (error) {
    // A concurrent recovery now owns cleanup of the dead worker's transaction.
    if (!(error instanceof GenerationRecoveryBusy)) throw error;
  }
}

/** Caller owns the active transaction or holds the shared recovery lease. */
export function cleanupOwnedGeneration(output: string, expected: GenerationOwner): void {
  if (!isGenerationOwner(expected)) return;
  output = resolve(output);
  const lock = output + '.sdk-generator.lock';
  let fd: number;
  try {
    fd = openSync(lock, 'r');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  try {
    const owner = readOwner(fd);
    if (!matchesOwner(owner, expected)) return;
    const sibling = (key: 'stage' | 'backup'): string | undefined => {
      const value: unknown = Reflect.get(owner, key);
      const prefix = output + '.' + key + '-';
      return typeof value === 'string' &&
        value.startsWith(prefix) &&
        uuid.test(value.slice(prefix.length))
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
    releaseGenerationLock(lock, fd, expected);
  } finally {
    closeSync(fd);
  }
}
