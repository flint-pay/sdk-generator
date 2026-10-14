#!/usr/bin/env node
import { validateFixtures, validateFixturesWithProgress } from './fixtures.js';
import {
  loadContract,
  generate,
  validate,
  prepareRelease,
  publishRelease,
  render,
  preview,
  generateWithSummary,
  modifiedFileDiffs,
  validateWithProgress,
} from './generate.js';
import {
  generationText,
  validationLine,
  releaseText,
  messageText,
  errorMessage,
} from './cli-output.js';
import { DiagnosticGroup, suggestion } from './diagnostic.js';
import { Diagnostic, stable } from './contract.js';
import { publishSite } from './distribution.js';
import { initialConfig } from './initial-config.js';
import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
// Select the error format before parsing, including unknown commands/flags;
// parsed flags take over once arguments are accepted.
const separator = args.indexOf('--');
let jsonErrors = args.slice(0, separator < 0 ? args.length : separator).includes('--json');
const command = args.shift();
let initialized: { written: string; config: ReturnType<typeof initialConfig> } | undefined;
interface Command {
  arguments: string[];
  flags: Record<string, { value?: string; required?: boolean; description: string }>;
  description: string;
}
const commands: Record<string, Command> = {
  init: {
    arguments: ['API_JSON', 'SDK_JSON'],
    flags: {
      '--targets': {
        value: 'node|php|node,php',
        description: 'Select SDK targets (default: node,php).',
      },
    },
    description:
      'Write a minimal SDK configuration, refuse an existing SDK_JSON, then diagnose the pair. The file is kept if diagnosis fails. Replace the placeholder package names before generating.',
  },
  diagnose: {
    arguments: ['API_JSON', 'SDK_JSON'],
    flags: {},
    description: 'Load and render-check the contract; report diagnostics. No files are written.',
  },
  effective: {
    arguments: ['API_JSON', 'SDK_JSON'],
    flags: {},
    description:
      'Print the resolved contract and configuration. No files are written. Output can contain private API details.',
  },
  preview: {
    arguments: ['API_JSON', 'SDK_JSON', 'OUTPUT'],
    flags: { '--diff': { description: 'Print diffs for modified files.' } },
    description:
      'Report proposed file changes, diffs and compatibility findings. No files are written.',
  },
  generate: {
    arguments: ['API_JSON', 'SDK_JSON', 'OUTPUT'],
    flags: {},
    description:
      'Write selected SDK packages and a private ownership record to OUTPUT. Refuse hand edits and unowned conflicts.',
  },
  validate: {
    arguments: ['OUTPUT'],
    flags: {
      '--fixtures': {
        value: 'HTTP_CASES_JSON',
        description: 'Also run local HTTP fixtures in the selected targets.',
      },
    },
    description:
      'Check generated syntax, types and packaging using local tools. Tools can use caches or configured registries. No packages are published.',
  },
  release: {
    arguments: ['OUTPUT', 'RELEASE_DIRECTORY'],
    flags: {
      '--acknowledge-review': {
        description:
          'Record approved: true after reviewing compatibility findings; version checks still apply.',
      },
    },
    description:
      'Validate OUTPUT and write archives, documentation and a publication plan to a new RELEASE_DIRECTORY. No packages are published.',
  },
  publish: {
    arguments: ['RELEASE_DIRECTORY'],
    flags: {
      '--confirm-version': {
        value: 'VERSION',
        required: true,
        description: 'Confirm the exact reviewed package version.',
      },
    },
    description:
      'Verify checksums, upload the prepared npm archive to its registry and write a local publication receipt.',
  },
  'publish-site': {
    arguments: ['RELEASE_DIRECTORY', 'WEB_ROOT'],
    flags: {
      '--confirm-version': {
        value: 'VERSION',
        required: true,
        description: 'Confirm the exact reviewed package version.',
      },
    },
    description:
      'Verify and deploy the prepared Composer repository, archives and documentation to a dedicated local WEB_ROOT; write a publication receipt. Hosting deployment remains a separate step.',
  },
};
for (const definition of Object.values(commands))
  definition.flags['--json'] = {
    description: 'Print machine-readable JSON (stdout) and JSON errors (stderr).',
  };
const argumentDescriptions: Record<string, string> = {
  API_JSON: 'OpenAPI 3.0/3.1 JSON file.',
  SDK_JSON: 'SDK configuration JSON file.',
  OUTPUT: 'Generated SDK output directory.',
  RELEASE_DIRECTORY: 'Directory containing prepared release artifacts (must be new for release).',
  WEB_ROOT: 'Dedicated local web root or hosting checkout.',
};
function usage(name: string, definition: Command): string {
  const flags = Object.entries(definition.flags).map(([flag, option]) => {
    const syntax = flag + (option.value ? ' ' + option.value : '');
    return option.required ? syntax : '[' + syntax + ']';
  });
  return ['sdk-generator', name, ...definition.arguments, ...flags].join(' ');
}
function parseArguments(definition: Command) {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  let help = false;
  let literal = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!literal && arg === '--') {
      literal = true;
      continue;
    }
    if (!literal && (arg === '--help' || arg === '-h')) {
      help = true;
      continue;
    }
    if (!literal && arg.startsWith('-')) {
      const option = Object.hasOwn(definition.flags, arg) ? definition.flags[arg] : undefined;
      if (!option) throw new Diagnostic('arguments', `unknown flag "${arg}"`);
      if (flags.has(arg))
        throw new Diagnostic('arguments', `flag "${arg}" was provided more than once`);
      if (option.value) {
        const value = args[i + 1];
        if (!value)
          throw new Diagnostic('arguments', `flag "${arg}" requires a value (${option.value})`);
        flags.set(arg, value);
        i++;
      } else flags.set(arg, true);
    } else positional.push(arg);
  }
  if (flags.has('--diff') && flags.has('--json'))
    throw new Diagnostic(
      'arguments',
      '--diff applies to human output; --json already includes every diff',
    );
  if (positional.length > definition.arguments.length)
    throw new Diagnostic(
      'arguments',
      `unexpected extra argument "${positional[definition.arguments.length]}"`,
    );
  if (!help) {
    const missing = definition.arguments.find((_, index) => !positional[index]);
    if (missing) throw new Diagnostic('arguments', `missing required argument ${missing}`);
    for (const [flag, option] of Object.entries(definition.flags))
      if (option.required && !flags.has(flag))
        throw new Diagnostic(
          'arguments',
          `missing required flag ${flag} ${option.value ?? ''}`.trim(),
        );
  }
  return { positional, flags, help };
}
try {
  if (!command || command === '--help' || command === '-h') {
    parseArguments({ arguments: [], flags: {}, description: '' });
    console.log(
      Object.entries(commands)
        .map(([name, definition]) => usage(name, definition))
        .join('\n') +
        '\n\nUse sdk-generator <command> --help for arguments and side effects.\nUse sdk-generator --version for the generator version.\nAll generation is local. Preview never writes. Release prepares packages and a publication plan; it does not publish.',
    );
  } else if (command === '--version') {
    parseArguments({ arguments: [], flags: {}, description: '' });
    const metadata: unknown = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    );
    if (
      !metadata ||
      typeof metadata !== 'object' ||
      !('version' in metadata) ||
      typeof metadata.version !== 'string'
    )
      throw new Error('generator package version is unavailable');
    console.log(metadata.version);
  } else {
    const definition = Object.hasOwn(commands, command) ? commands[command] : undefined;
    if (!definition)
      throw new Diagnostic(
        'arguments',
        `unknown ${command.startsWith('-') ? 'flag' : 'command'} "${command}".${command.startsWith('-') ? '' : suggestion(command, Object.keys(commands))} Use --help for available commands.`,
      );
    const { positional, flags, help } = parseArguments(definition);
    const json = flags.has('--json');
    jsonErrors = json;
    if (help) {
      console.log(
        usage(command, definition) +
          '\n\n' +
          definition.description +
          '\n\nArguments:\n' +
          definition.arguments.map((arg) => `  ${arg}  ${argumentDescriptions[arg]}`).join('\n') +
          '\n\nOptions:\n' +
          Object.entries(definition.flags)
            .map(
              ([flag, option]) =>
                `  ${flag}${option.value ? ' ' + option.value : ''}  ${option.description}\n`,
            )
            .join('') +
          '  --help, -h  Print this help.',
      );
    } else if (command === 'validate') {
      const output = positional[0]!;
      const fixtures = flags.get('--fixtures');
      if (json) {
        const checks = validate(output);
        console.log(
          stable({
            checks,
            ...(typeof fixtures === 'string'
              ? { fixtures: await validateFixtures(output, fixtures) }
              : {}),
          }),
        );
      } else {
        console.log(`Validating ${output}`);
        let checks = 0;
        const targets = new Set<string>();
        validateWithProgress(output, (check, passed) => {
          console.log(validationLine(check, passed));
          if (passed) {
            checks++;
            targets.add(check.target);
          }
        });
        if (typeof fixtures === 'string')
          await validateFixturesWithProgress(output, fixtures, (target, scenarios, passed) => {
            console.log(validationLine({ target, label: 'HTTP fixtures' }, passed, scenarios));
            if (passed) {
              checks++;
              targets.add(target);
            }
          });
        console.log(`Validation passed: ${checks} checks (${[...targets].join(', ')})`);
      }
    } else if (command === 'release') {
      const plan = prepareRelease(
        positional[0]!,
        positional[1]!,
        flags.has('--acknowledge-review'),
      );
      console.log(json ? stable(plan) : releaseText(plan, positional[1]!));
    } else if (command === 'publish' || command === 'publish-site') {
      const version = flags.get('--confirm-version');
      if (typeof version !== 'string')
        throw new Diagnostic('arguments', 'missing confirmed version');
      if (command === 'publish') {
        const result = publishRelease(positional[0]!, version);
        console.log(
          json
            ? stable(result)
            : `Published ${result.version} to npm. Receipt: ${positional[0]!}/publication.json\nComposer: ${result.composer}`,
        );
      } else {
        const result = publishSite(positional[0]!, positional[1]!, version);
        console.log(
          json
            ? stable(result)
            : [
                `Deployed site for ${result.version} to ${positional[1]!}. Receipt: ${positional[0]!}/site-publication.json`,
                ...(result.baseUrl ? [`Base URL: ${result.baseUrl}`] : []),
                'Run your hosting deployment step to serve it.',
              ].join('\n'),
        );
      }
    } else {
      if (command === 'init') {
        const targets = flags.get('--targets');
        if (
          targets !== undefined &&
          targets !== 'node' &&
          targets !== 'php' &&
          targets !== 'node,php'
        )
          throw new Diagnostic('arguments', '--targets must be node, php or node,php');
        const config = initialConfig(positional[0]!, {
          targets: targets === 'node' ? ['node'] : targets === 'php' ? ['php'] : ['node', 'php'],
        });
        const written = positional[1]!;
        try {
          writeFileSync(written, JSON.stringify(config, null, 2) + '\n', { flag: 'wx' });
        } catch (error) {
          if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')
            throw new Diagnostic(written, 'already exists; refusing to overwrite');
          throw error;
        }
        initialized = { written, config };
        if (!json) console.log(`Wrote ${written} (targets: ${config.targets.join(', ')})`);
      }
      const diagnosing = command === 'diagnose' || command === 'init';
      const contract = loadContract(positional[0]!, positional[1]!, {
        collectDiagnostics: diagnosing,
        onWarning: (warning) =>
          console.error(
            json ? stable({ warning: warning.message }) : messageText('warning', warning.message),
          ),
      });
      // generate/preview already compile and render while inspecting the output.
      if (diagnosing || command === 'effective') render(contract);
      if (diagnosing) {
        const result = {
          valid: true,
          operations: contract.operations.length,
          contractHash: contract.hash,
          targets: contract.config.targets ?? ['node', 'php'],
        };
        console.log(
          json
            ? stable(initialized ? { ...initialized, diagnose: result } : result)
            : `Valid: ${result.operations} ${result.operations === 1 ? 'operation' : 'operations'}; targets: ${result.targets.join(', ')}; contract hash: ${result.contractHash}`,
        );
        if (initialized && !json)
          console.log(
            'Next: replace the @example/example package names, then run\n' +
              `  sdk-generator generate ${positional[0]!} ${initialized.written} OUTPUT`,
          );
      } else if (command === 'effective') {
        const targets = contract.config.targets ?? ['node', 'php'];
        const config = { ...contract.config };
        // Resolved contracts retain metadata for saved-record compatibility.
        if (!targets.includes('node')) Reflect.deleteProperty(config, 'npm');
        if (!targets.includes('php')) Reflect.deleteProperty(config, 'composer');
        console.log(stable({ ...contract, config }));
      } else {
        const output = positional[2]!;
        if (json) console.log(stable(generate(contract, output, command === 'preview')));
        else if (command === 'preview') {
          const plan = preview(contract, output);
          console.log(
            generationText(
              'preview',
              output,
              plan,
              [...plan.files.keys()],
              !plan.before,
              flags.has('--diff') ? modifiedFileDiffs(plan, output) : undefined,
            ),
          );
        } else {
          const { report, files, firstGeneration } = generateWithSummary(contract, output);
          console.log(generationText('generate', output, report, files, firstGeneration));
        }
      }
    }
  }
} catch (error) {
  const diagnostics = (
    error instanceof DiagnosticGroup ? error.findings : error instanceof Diagnostic ? [error] : []
  ).map((finding) => ({ location: finding.location, message: finding.detail }));
  if (jsonErrors) {
    const report = {
      error: error instanceof Error ? error.message : String(error),
      ...(command === 'diagnose' || initialized
        ? {
            valid: false,
            diagnostics,
          }
        : {}),
    };
    console.error(stable(initialized ? { ...initialized, diagnose: report } : report));
  } else if (
    (command === 'diagnose' || initialized) &&
    diagnostics.length &&
    !(error instanceof Diagnostic && error.location === 'arguments')
  )
    console.error(
      [
        `Invalid: ${diagnostics.length} ${diagnostics.length === 1 ? 'finding' : 'findings'}`,
        ...diagnostics.map(
          (finding) => `  ${finding.location}: ${finding.message.replace(/\r?\n/g, '\n  ')}`,
        ),
      ].join('\n'),
    );
  else console.error(messageText('error', errorMessage(error)));
  process.exitCode = 1;
}
