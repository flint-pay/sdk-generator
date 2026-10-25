import type { Change, Compatibility, ValidationCheck, prepareRelease } from './generate.js';
import { Diagnostic } from './contract.js';

export function compatibilityLines(
  findings: readonly Compatibility[],
  reviewRequired = false,
): string[] {
  const severities = ['breaking', 'review', 'additive'] as const;
  const counts = severities.map(
    (severity) => [severity, findings.filter((finding) => finding.severity === severity)] as const,
  );
  return [
    'Compatibility: ' +
      (findings.length
        ? counts.map(([severity, items]) => `${items.length} ${severity}`).join(', ')
        : 'no findings') +
      (reviewRequired ? '; review required' : ''),
    ...counts.flatMap(([, items]) =>
      items.map(
        (finding) => `  ${finding.severity.padEnd(8)}  ${finding.subject}: ${finding.message}`,
      ),
    ),
  ];
}

export function generationText(
  command: 'preview' | 'generate',
  output: string,
  report: { changes: readonly Change[]; compatibility: readonly Compatibility[] },
  files: readonly string[],
  firstGeneration: boolean,
  diffs?: readonly string[],
): string {
  const paths = (kind: Change['kind']) =>
    report.changes
      .filter((change) => change.kind === kind)
      .map((change) => change.path.replaceAll('\\', '/'))
      .sort();
  const created = paths('created'),
    modified = paths('modified'),
    removed = paths('removed');
  const unchanged = files.length - created.length - modified.length;
  const lines = [
    command === 'preview' ? `Preview of ${output} (no files written)` : `Generated ${output}`,
  ];
  if (firstGeneration) {
    const targets = ['node', 'php']
      .map((target) => ({
        target,
        count: files.filter((path) => path.startsWith(target + '/')).length,
      }))
      .filter(({ count }) => count > 0);
    lines.push(
      `Files: ${created.length} created (${targets.map(({ target, count }) => `${target} ${count}`).join(', ')}); no previous generation`,
      'Compatibility: not compared; no previous generation',
    );
  } else {
    lines.push(
      report.changes.length
        ? `Files: ${created.length} created, ${modified.length} modified, ${removed.length} removed, ${unchanged} unchanged`
        : `Files: no changes (${unchanged} unchanged)`,
    );
    for (const [label, entries] of [
      ['Created', created],
      ['Modified', modified],
      ['Removed', removed],
    ] as const)
      if (entries.length)
        lines.push(`${label} (${entries.length}):`, ...entries.map((path) => `  ${path}`));
    lines.push(...compatibilityLines(report.compatibility));
  }
  if (command === 'preview' && modified.length) {
    if (diffs) lines.push(`Diffs (${modified.length} modified files):`, diffs.join('\n'));
    else lines.push('Use --diff to show modified-file diffs (also with --json).');
  }
  return lines.join('\n');
}

export function validationLine(
  check: ValidationCheck,
  passed: boolean,
  scenarios?: number,
): string {
  const count = passed
    ? scenarios !== undefined
      ? ` (${scenarios} ${scenarios === 1 ? 'scenario' : 'scenarios'})`
      : check.files !== undefined
        ? ` (${check.files} ${check.files === 1 ? 'file' : 'files'})`
        : ''
    : '';
  return `  ${passed ? 'passed' : 'FAILED'}  ${check.target.padEnd(4)}  ${check.label}${count}`;
}

export function releaseText(plan: ReturnType<typeof prepareRelease>, destination: string): string {
  const packages = [
    ...(plan.packages.npm ? [`npm ${plan.packages.npm}`] : []),
    ...(plan.packages.composer ? [`Composer ${plan.packages.composer}`] : []),
  ];
  const next = [
    ...(plan.packages.npm
      ? [`sdk-generator publish ${destination} --confirm-version ${plan.version}`]
      : []),
    `sdk-generator publish-site ${destination} WEB_ROOT --confirm-version ${plan.version}`,
  ];
  return [
    `Prepared release ${plan.version} in ${destination}. Nothing was published.`,
    `Packages: ${packages.join(', ')}`,
    `Previous version: ${plan.previousVersion ?? 'none'}`,
    ...compatibilityLines(plan.compatibility, plan.reviewRequired),
    `Review acknowledged: ${plan.approved ? 'yes' : 'no'}`,
    `Artifacts: release-plan.json, CHANGELOG.md, MIGRATION.md, site/ (${Object.keys(plan.checksums).length} checksummed files)`,
    `Next: ${next.join('\n      ')}`,
  ].join('\n');
}

export function messageText(prefix: 'error' | 'warning', message: string): string {
  return `${prefix}: ${message.replace(/\r?\n/g, '\n  ')}`;
}

export function errorMessage(error: unknown): string {
  return error instanceof Diagnostic && error.location === 'arguments'
    ? error.detail
    : error instanceof Error
      ? error.message
      : String(error);
}
