#!/usr/bin/env node
import { validateFixtures } from './fixtures.js';
import {
  loadContract,
  generate,
  validate,
  prepareRelease,
  publishRelease,
  render,
} from './generate.js';
import { DiagnosticGroup, suggestion } from './diagnostic.js';
import { Diagnostic, stable } from './contract.js';
import { publishSite } from './distribution.js';
import { readFileSync } from 'node:fs';
const args = process.argv.slice(2);
const command = args.shift();
interface Command {
  arguments: string[];
  flags: Record<string, { value?: string; required?: boolean; description: string }>;
  description: string;
}
const commands: Record<string, Command> = {
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
    flags: {},
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
      const checks = validate(output);
      console.log(
        stable({
          checks,
          ...(typeof fixtures === 'string'
            ? { fixtures: await validateFixtures(output, fixtures) }
            : {}),
        }),
      );
    } else if (command === 'release')
      console.log(
        stable(prepareRelease(positional[0]!, positional[1]!, flags.has('--acknowledge-review'))),
      );
    else if (command === 'publish' || command === 'publish-site') {
      const version = flags.get('--confirm-version');
      if (typeof version !== 'string')
        throw new Diagnostic('arguments', 'missing confirmed version');
      console.log(
        stable(
          command === 'publish'
            ? publishRelease(positional[0]!, version)
            : publishSite(positional[0]!, positional[1]!, version),
        ),
      );
    } else {
      const contract = loadContract(positional[0]!, positional[1]!, {
        collectDiagnostics: command === 'diagnose',
        onWarning: (warning) => console.error(stable({ warning: warning.message })),
      });
      // generate/preview already compile and render while inspecting the output.
      if (command === 'diagnose' || command === 'effective') render(contract);
      if (command === 'diagnose')
        console.log(
          stable({
            valid: true,
            operations: contract.operations.length,
            contractHash: contract.hash,
            targets: contract.config.targets ?? ['node', 'php'],
          }),
        );
      else if (command === 'effective') console.log(stable(contract));
      else {
        console.log(stable(generate(contract, positional[2]!, command === 'preview')));
      }
    }
  }
} catch (error) {
  console.error(
    stable({
      error: error instanceof Error ? error.message : String(error),
      ...(command === 'diagnose'
        ? {
            valid: false,
            diagnostics: (error instanceof DiagnosticGroup
              ? error.findings
              : error instanceof Diagnostic
                ? [error]
                : []
            ).map((finding) => ({ location: finding.location, message: finding.detail })),
          }
        : {}),
    }),
  );
  process.exitCode = 1;
}
