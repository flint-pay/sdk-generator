# CLI and library reference

From a source checkout, run `npm ci` and `npm run build`, then invoke `node dist/cli.js`. Installing a packed generator exposes the same commands as `sdk-generator`; no global installation is required for source development.

## Commands

| Command                                                                              | Result and side effects                                                                                                                                                                            |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node dist/cli.js --help`                                                            | Print usage.                                                                                                                                                                                       |
| `node dist/cli.js diagnose API_JSON SDK_JSON`                                        | Load and render-check the selected contract; print validity, operation count, contract hash and targets. No output files are written.                                                              |
| `node dist/cli.js effective API_JSON SDK_JSON`                                       | Print the resolved contract, selected operations, configuration and source hashes. This output can contain private API details. No output files are written.                                       |
| `node dist/cli.js preview API_JSON SDK_JSON OUTPUT`                                  | Report proposed file changes, unified diffs and compatibility findings without writing. Existing output is checked for ownership conflicts.                                                        |
| `node dist/cli.js generate API_JSON SDK_JSON OUTPUT`                                 | Create or safely regenerate the selected packages and private ownership record; report changes and compatibility findings.                                                                         |
| `node dist/cli.js validate OUTPUT`                                                   | Check generated package syntax, TypeScript examples, npm package contents and Composer metadata for the targets present.                                                                           |
| `node dist/cli.js validate OUTPUT --fixtures CASES_JSON`                             | Also run the same expected HTTP scenarios through the generated public clients using injected transports. No provider requests are made.                                                           |
| `node dist/cli.js release OUTPUT RELEASE_DIRECTORY`                                  | Check integrity and validate, then write package archives, versioned documentation, changelog, migration guidance, checksums and a release plan. The destination must be new and outside `OUTPUT`. |
| `node dist/cli.js publish RELEASE_DIRECTORY --confirm-version VERSION`               | Verify the prepared artifacts and upload the npm archive using the caller's registry authentication. Write a publication receipt on success.                                                       |
| `node dist/cli.js publish-site RELEASE_DIRECTORY WEB_ROOT --confirm-version VERSION` | Verify and deploy the prepared Composer repository, archives and documentation into a dedicated local web root or hosting checkout. A hosting checkout still needs its normal deployment step.     |

Arguments are positional; `--fixtures` and `--confirm-version` must appear as shown. Quote paths containing spaces. Commands other than help print JSON to stdout. Failures print a JSON object with an `error` message to stderr and exit with status 1. Syntax is shown by `--help`; there is no separate `--version` command.

Contract loading and generation use local inputs. Relative `$ref` paths resolve from the file containing the reference. Package tooling can use local caches or configured registries. `validate` does not install consumer packages or execute operation examples against a server; the repository test suite performs those additional checks. `release` runs package validation but does not implicitly rerun a fixture file, so run `validate --fixtures` first.

Only `publish` uploads to npm. `generate`, `validate`, `preview` and `release` do not publish. See [releases](releases.md) for version policy, destinations and recovery after partial publication.

## Generated layout

```text
OUTPUT/
  .sdk-generator.json   Private ownership, resolved contract and provenance
  node/                 Selected npm target
    package.json
    index.js / index.d.ts
    runtime.js / runtime.d.ts
    README.md / REFERENCE.md / LICENSE
    examples/           JavaScript and TypeScript operation examples
    custom/             Provider-maintained helpers
    guides/             Optional provider narrative guides
  php/                  Selected Composer target
    composer.json
    src/                Client, runtime, models and selected contract
    README.md / REFERENCE.md / LICENSE
    examples/           PHP operation examples
    custom/             Provider-maintained helpers
    guides/             Optional provider narrative guides
```

Only selected targets are emitted. Webhook inbox/outbox examples appear when verification is configured. The private root record is excluded from package archives; preserve it to detect hand edits, remove obsolete owned files and compare future versions. Generated packages contain their selected operation and schema information.

## Using the generator as a library

The built module exports the same operations for automation. From a script in the repository root:

```js
import { loadContract, generate, validate, validateFixtures } from './dist/index.js';

const contract = loadContract('examples/library.openapi.json', 'examples/library.sdk.json');
const plan = generate(contract, '.generated/library', true); // No-write preview with diffs
console.log(plan);
generate(contract, '.generated/library');
console.log(validate('.generated/library'));
// For a contract with a matching fixture corpus:
// await validateFixtures('.generated/payments', 'tests/fixtures/http-cases.json');
```

An installed generator exposes these exports from `@public-sdk/generator`. `render(contract)` returns a map of relative paths to contents without writing. `preview(contract, output)` returns the rendered files, previous record, changes and compatibility findings; `generate(contract, output, true)` adds unified diffs to its serializable report. `compare(before, after)` compares resolved contracts. `prepareRelease`, `publishRelease` and `publishSite` perform the corresponding release operations; the latter two take an explicit confirmed version. `validateFixtures` is asynchronous; the other listed functions are synchronous. Failures throw errors, including `Diagnostic` with a source/configuration location.

## Troubleshooting

| Symptom                                                | Action                                                                                                                                                                                                           |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dist/cli.js` cannot be found                          | Run `npm ci` and `npm run build` from the repository root.                                                                                                                                                       |
| Unsupported schema, reference, format or encoding      | Follow the diagnostic's source pointer and [support matrix](support-matrix.md). Vendor remote references locally or select supported operations; do not discard required wire semantics to silence a diagnostic. |
| Generated example fails validation                     | Supply a valid input under `operations.<operationId>.example` in the [configuration](configuration.md).                                                                                                          |
| Generated file was edited or an unowned file conflicts | Move intentional helper code to the appropriate `custom/` directory, or generate into a fresh output directory and reconcile changes.                                                                            |
| A sibling generation lock remains after a crash        | Verify no generation is running, then inspect the lock, staging directory and backup before recovery. See [regeneration transactions](architecture.md#regeneration-transaction).                                 |
| PHP or Composer validation cannot run                  | Install the required runtime/tools, or select only the Node target if PHP output is not needed.                                                                                                                  |
| Release destination already exists                     | Choose a new release directory; prepared releases are not overwritten.                                                                                                                                           |
| Release asks you to regenerate                         | Use the matching generator and pinned inputs to regenerate, then rerun validation and review the new preview.                                                                                                    |

For a reproducible bug report, follow [contributing](../CONTRIBUTING.md). Keep private contracts and credentials out of public diagnostics and reports.
