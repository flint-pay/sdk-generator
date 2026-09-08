import { Diagnostic } from './contract.js';
import type { Compatibility } from './compatibility.js';

export function compareVersions(a: string, b: string): number {
  const split = (value: string) => {
    const [core, ...pre] = value.split('-');
    return { core: core!.split('.').map(BigInt), pre: pre.join('-').split('.').filter(Boolean) };
  };
  const left = split(a),
    right = split(b);
  for (let i = 0; i < 3; i++)
    if (left.core[i] !== right.core[i]) return left.core[i]! < right.core[i]! ? -1 : 1;
  if (!left.pre.length || !right.pre.length) return left.pre.length ? -1 : right.pre.length ? 1 : 0;
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i],
      y = right.pre[i];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const xn = /^\d+$/.test(x),
      yn = /^\d+$/.test(y);
    if (xn && yn) return BigInt(x) < BigInt(y) ? -1 : 1;
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export function checkVersionPolicy(
  previous: string | undefined,
  next: string,
  findings: Compatibility[],
): void {
  if (!previous) return;
  if (compareVersions(next, previous) <= 0)
    throw new Diagnostic(
      'config/version',
      `semver release policy requires a version newer than ${previous}`,
    );
  if (previous.includes('-')) return; // Prerelease interfaces may evolve before stabilization.
  const before = previous.split('.').map(BigInt),
    after = next.split('-')[0]!.split('.').map(BigInt);
  if (after[0]! > before[0]!) return;
  if (
    findings.some((c) => c.severity === 'breaking') &&
    !(before[0] === 0n && after[1]! > before[1]!)
  )
    throw new Diagnostic(
      'config/version',
      'breaking changes require a new major version (or a new minor version before 1.0) under the semver release policy',
    );
  if (findings.some((c) => c.severity === 'additive') && after[1]! <= before[1]!)
    throw new Diagnostic(
      'config/version',
      'additive interfaces require a new minor version under the semver release policy',
    );
}
