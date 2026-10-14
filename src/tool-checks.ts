import { spawnSync } from 'node:child_process';
import { Diagnostic } from './diagnostic.js';

/** Probe only tools needed by the selected target, before package checks run. */
export function requireTool(tool: string, target: 'node' | 'php', location: string): void {
  const result = spawnSync(tool, ['--version'], { stdio: 'ignore', timeout: 120000 });
  if (!result.error) return;
  if ('code' in result.error && result.error.code === 'ENOENT')
    throw new Diagnostic(
      location,
      `required tool "${tool}" was not found for the ${target} target; install ${tool} and make it available on PATH, or set targets in SDK_JSON to omit "${target}" and regenerate`,
    );
  throw new Diagnostic(
    location,
    `cannot run required tool "${tool}" for the ${target} target: ${result.error.message}`,
  );
}
