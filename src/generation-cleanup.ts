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
  fstatSync,
  statSync,
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

/** Retire the published inode, then verify it before deleting it. */
export function releaseGenerationLock(path: string, fd: number): void {
  const retired = path + '.release-' + process.pid + '-' + randomUUID();
  try {
    renameSync(path, retired);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  const expected = fstatSync(fd),
    actual = statSync(retired);
  if (expected.dev !== actual.dev || expected.ino !== actual.ino) {
    // Preserve a replacement owner. Never overwrite a lock acquired since the rename.
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
  action: (cleanup: (pid: number) => void) => T,
): T {
  output = resolve(output);
  const recovery = output + '.sdk-generator.lock.recovery';
  let fd: number;
  try {
    fd = acquireGenerationLock(recovery, { pid: process.pid });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')
      throw new GenerationRecoveryBusy('another process holds the generation recovery lease');
    throw error;
  }
  try {
    return action((pid) => cleanupUnderLease(output, pid));
  } finally {
    try {
      releaseGenerationLock(recovery, fd);
    } finally {
      closeSync(fd);
    }
  }
}

/** Called only after the supervised generation worker has exited. */
export function cleanupInterruptedGeneration(output: string, pid: number): void {
  output = resolve(output);
  const lock = output + '.sdk-generator.lock';
  const parent = dirname(output);
  if (!existsSync(parent)) return;
  for (const path of readdirSync(parent))
    if (
      [basename(lock), basename(lock) + '.recovery'].some(
        (prefix) =>
          path.startsWith(prefix + '.acquire-' + pid + '-') &&
          /^[a-f0-9-]{36}$/.test(path.slice((prefix + '.acquire-' + pid + '-').length)),
      )
    )
      rmSync(join(parent, path), { force: true });
  const recovery = lock + '.recovery';
  // Only this supervisor can retire its dead child's lease. Recoverers never
  // remove another process's lease, including one held by this supervisor.
  let recoveryFd: number | undefined;
  try {
    recoveryFd = openSync(recovery, 'r');
    let lease: unknown;
    try {
      lease = JSON.parse(readFileSync(recoveryFd, 'utf8'));
    } catch {
      // An unknown lease owner requires manual inspection.
      return;
    }
    if (lease && typeof lease === 'object' && 'pid' in lease && lease.pid === pid)
      releaseGenerationLock(recovery, recoveryFd);
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT')
      throw error;
  } finally {
    if (recoveryFd !== undefined) closeSync(recoveryFd);
  }
  try {
    withGenerationRecovery(output, (cleanup) => cleanup(pid));
  } catch (error) {
    // A concurrent recovery now owns cleanup of the dead worker's transaction.
    if (!(error instanceof GenerationRecoveryBusy)) throw error;
  }
}

function cleanupUnderLease(output: string, pid: number): void {
  const lock = output + '.sdk-generator.lock';
  let fd: number;
  try {
    fd = openSync(lock, 'r');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  try {
    let owner: unknown;
    try {
      owner = JSON.parse(readFileSync(fd, 'utf8'));
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
    releaseGenerationLock(lock, fd);
  } finally {
    closeSync(fd);
  }
}
