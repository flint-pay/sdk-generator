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
import { Diagnostic, stable } from './contract.js';
import { publishSite } from './distribution.js';
const args = process.argv.slice(2);
const command = args.shift();
const usage = `sdk-generator <diagnose|effective|preview|generate> <openapi.json> <sdk.json> [output]\nsdk-generator validate <output> [--fixtures http-cases.json]\nsdk-generator release <output> <release-directory>\nsdk-generator publish <release-directory> --confirm-version <version>\nsdk-generator publish-site <release-directory> <web-root> --confirm-version <version>\n\nAll generation is local. Preview never writes. Release prepares packages and a publication plan; it does not publish.`;
try {
  if (!command || command === '--help' || command === '-h') console.log(usage);
  else if (
    command === 'validate' &&
    (args.length === 1 || (args.length === 3 && args[1] === '--fixtures'))
  ) {
    const checks = validate(args[0]!);
    console.log(
      stable({
        checks,
        ...(args[2] ? { fixtures: await validateFixtures(args[0]!, args[2]) } : {}),
      }),
    );
  } else if (command === 'release' && args.length === 2)
    console.log(stable(prepareRelease(args[0]!, args[1]!)));
  else if (command === 'publish' && args.length === 3 && args[1] === '--confirm-version')
    console.log(stable(publishRelease(args[0]!, args[2]!)));
  else if (command === 'publish-site' && args.length === 4 && args[2] === '--confirm-version')
    console.log(stable(publishSite(args[0]!, args[1]!, args[3]!)));
  else if (
    ['diagnose', 'effective', 'preview', 'generate'].includes(command) &&
    args.length >= 2 &&
    args.length <= 3
  ) {
    const contract = loadContract(args[0]!, args[1]!);
    render(contract);
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
      if (!args[2]) throw new Diagnostic('output', 'output directory is required');
      console.log(stable(generate(contract, args[2], command === 'preview')));
    }
  } else throw new Diagnostic('arguments', usage);
} catch (error) {
  console.error(stable({ error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
}
