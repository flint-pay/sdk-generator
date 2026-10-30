# CLI and library reference

From a source checkout, run `npm ci` and `npm run build`, then invoke `node dist/cli.js`. Installing a packed generator exposes the same commands as `sdk-generator`; no global installation is required for source development.

## Commands

| Command                                                                                       | Result and side effects                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node dist/cli.js --help`                                                                     | Print plain-text usage for all commands.                                                                                                                                                                                                                                                            |
| `node dist/cli.js COMMAND --help`                                                             | Print plain-text usage, arguments, options and side effects for one command without executing it.                                                                                                                                                                                                   |
| `node dist/cli.js --version`                                                                  | Print the generator package version as plain text.                                                                                                                                                                                                                                                  |
| `node dist/cli.js init API_JSON SDK_JSON [--targets node\|php\|node,php] [--force] [--json]`  | Write a minimal configuration to a new `SDK_JSON`, then diagnose the pair. Defaults to both targets; no other files are written. The configuration is kept if diagnosis fails.                                                                                                                      |
| `node dist/cli.js diagnose API_JSON SDK_JSON [--json]`                                        | Load and compile-check the selected contract; print validity, operation count, contract hash and targets. No output files are written.                                                                                                                                                              |
| `node dist/cli.js effective API_JSON SDK_JSON [--json]`                                       | Print the resolved contract, selected operations, configuration and source hashes. This output can contain private API details. No output files are written.                                                                                                                                        |
| `node dist/cli.js preview API_JSON SDK_JSON OUTPUT [--diff] [--fail-on LEVEL] [--json]`       | Report proposed file changes and compatibility findings without writing; `--diff` also prints modified-file diffs. Existing output is checked for ownership conflicts.                                                                                                                              |
| `node dist/cli.js generate API_JSON SDK_JSON OUTPUT [--json]`                                 | Create or safely regenerate the selected packages and private ownership record; report changes and compatibility findings.                                                                                                                                                                          |
| `node dist/cli.js validate OUTPUT [--json]`                                                   | Check generated package syntax, TypeScript examples, npm package contents and Composer metadata for the targets present.                                                                                                                                                                            |
| `node dist/cli.js validate OUTPUT --fixtures CASES_JSON [--json]`                             | Also run the same expected HTTP scenarios through the generated public clients using injected transports. No provider requests are made.                                                                                                                                                            |
| `node dist/cli.js release OUTPUT RELEASE_DIRECTORY [--acknowledge-review] [--json]`           | Check integrity and validate, then write package archives, versioned documentation, changelog, migration guidance, checksums and a release plan. The destination must be new and outside `OUTPUT`. Optionally record review acknowledgment. On success, advance the private compatibility baseline. |
| `node dist/cli.js publish RELEASE_DIRECTORY --confirm-version VERSION [--json]`               | Verify the prepared artifacts and upload the npm archive using the caller's registry authentication. Write a publication receipt on success.                                                                                                                                                        |
| `node dist/cli.js publish-site RELEASE_DIRECTORY WEB_ROOT --confirm-version VERSION [--json]` | Verify and deploy the prepared Composer repository, archives and documentation into a dedicated local web root or hosting checkout. A hosting checkout still needs its normal deployment step.                                                                                                      |

Arguments are positional; named options may appear before or after them. Required paths must be nonempty. Quote paths containing spaces. Use `--` before positional paths beginning with `-`. Value-taking options consume the next argument even when it begins with `-` (for example, `--fixtures -cases.json`); an absent or empty value fails. Unknown commands and flags, missing arguments or option values, repeated options and unexpected extra positional arguments fail before execution. Unknown commands suggest close spellings.

## Output

`init` derives package names from `info.title` using ASCII kebab-case words and a matching PascalCase PHP namespace. Empty names fall back to `sdk` / `Sdk`. A namespace segment beginning with a digit gets an `Sdk` prefix: `123 Widgets` becomes `Example\Sdk123Widgets`. The shared package slug is shortened at a word boundary so the full scoped npm name is at most 214 characters, without a trailing hyphen; a first word longer than the available space is cut to fit. It writes version `0.1.0`, the selected targets and their package metadata, using `@example` / `example` placeholder vendors. If any successful response cannot return an object payload, including nonobject, empty or non-JSON responses, it explicitly sets `responses.return: "result"`; otherwise object payload mode remains the default.

It refuses an existing destination. Use `--force` to replace a regular configuration file; directories and symlinks are always refused. With multiple security schemes, it writes named modes for the complete declared alternatives and asks you to review `auth`. Invalid JSON and unsupported OpenAPI versions fail before writing. After writing, unsupported constructs exit with status 1 and the same findings as `diagnose`. Fix the specification or edit the configuration, including `include` / `hidden` operation selection, then rerun `diagnose`.

```text
Wrote sdk.json (targets: node, php)
Valid: 12 operations; targets: node, php; contract hash: <hash>
Next: replace @example/library and example/library, then run
  node dist/cli.js generate openapi.json sdk.json OUTPUT
```

The suggested command uses the running Node executable and CLI path for a checkout, or `npx --package @public-sdk/generator sdk-generator` for an installed package. It uses POSIX single quotes for paths containing spaces or shell metacharacters, escaping embedded single quotes.

With `--json`, `init` prints `{ "written": "<path>", "config": {...}, "diagnose": {...} }`, where `diagnose` is the same report as `diagnose --json`. Success goes to stdout; if diagnosis fails after writing, the envelope containing the failure report goes to stderr. Errors before writing use the ordinary JSON error format.

Commands print readable, plain ASCII summaries by default, with no color or TTY detection. `validate` streams one line per finished check group. Results go to stdout; errors and warnings go to stderr. Success exits with status 0, including compatibility findings by default; any failure exits with status 1. `preview --fail-on breaking|review|additive|none` can also exit 1 after printing its normal compatibility report: thresholds include all higher levels in the order additive, review, breaking. The default is `none`. The flag writes no files and applies equally to human and JSON output.

Every command accepts `--json` for machine-readable output. Successful reports go to stdout and warnings go to stderr. JSON errors include a stable `code` and `diagnostics` with codes, locations and messages; input findings also identify their `source` file. Paths to local files are relative to the current working directory. `diagnose --json` writes failures to stdout with `valid: false`; other commands write failures to stderr. Warnings on a failed JSON command are included in its `warnings` array. **Automation that parses output must pass `--json`.** `effective` always prints JSON, with or without `--json`.

`preview --diff` prints the library diff for each modified file after the summary. Created and removed files are listed on regeneration and never dumped as diffs. Without `--diff`, preview computes no diffs. `preview --json` omits diffs by default; use `preview --json --diff` to add a `diffs` array for modified files. Created/removed files remain summaries, so a first JSON preview never embeds every generated file. Other commands reject `--diff`.

First generation reports target file counts without path lists or a compatibility comparison. Regeneration lists sorted created, modified and removed paths and all compatibility findings, ordered breaking, review, then additive. User paths retain their spelling; output file paths are relative to `OUTPUT` with `/` separators. For example, a first preview of the bundled library:

```text
Preview of .generated/library (no files written)
Files: 103 created (node 46, php 57); no previous generation
Compatibility: not compared; no previous generation
```

Validation summarizes each group instead of dumping inline scripts and package file lists:

```text
Validating .generated/library
  passed  node  JavaScript syntax
  passed  node  npm package contents
  passed  node  module and descriptor loading
  passed  node  TypeScript examples (1 file)
  passed  php   PHP syntax (42 files)
  passed  php   Composer metadata
  passed  php   descriptor validation
Validation passed: 7 checks (node, php)
```

`--help` (also `-h`) and `--version` print plain text and do not accept a top-level `--json`. Command help lists the required arguments, options and side effects; `validate --help` reads no output directory.

Contract loading and generation use local inputs. Relative `$ref` paths resolve from the file containing the reference. Package tooling can use local caches or configured registries. `validate` does not install consumer packages or execute operation examples against a server; the repository test suite performs those additional checks. `release` runs package validation but does not implicitly rerun a fixture file, so run `validate --fixtures` first.

Only `publish` uploads to npm. `generate`, `validate`, `preview` and `release` do not publish. See [releases](releases.md) for version policy, destinations and recovery after partial publication.

The release plan's `approved` field records review acknowledgment. It defaults to `false`; `release --acknowledge-review` sets it to `true`. This optional record does not bypass validation or version policy, clear compatibility findings, or authorize publication. `publish` and `publish-site` still require `--confirm-version`.

## Diagnostic findings

`diagnose` collects independent configuration errors and unknown operation IDs, then validates models and operations in separate stages. Unknown settings list current keys, including `profiles`, once per settings object and suggest close spellings. Deprecated keys remain accepted and produce warnings. Undeclared idempotency, conditional, API-version and response request-ID and webhook signing header names warn with declared candidates; check the spelling or correct the provider export. Inferred `api.<operationId>` names warn with their reason and the configuration fields to set. `generate`, `validate` and `release` warn about `@example/` and `example/` package names before publication. If the SDK input looks like an OpenAPI document, the error suggests checking whether `API_JSON` and `SDK_JSON` are swapped. Unknown operation IDs suggest nearby IDs from the contract, including local path-item references.

On failure, it exits with status 1 and lists each `location: message` on stderr. With `--json`, it writes a diagnostic report to stdout:

```json
{
  "code": "INVALID_CONFIG",
  "valid": false,
  "error": "config/version: expected a semantic package version",
  "diagnostics": [
    {
      "code": "INVALID_CONFIG",
      "source": "sdk.json",
      "location": "config/version",
      "message": "expected a semantic package version"
    }
  ]
}
```

The `error` string includes the reported findings; each `diagnostics` entry has a code, location and message without the repeated location prefix. `config/...` locations address the SDK JSON or profile named by `source`; `/...` locations address the API input. When a required field is missing, the location points at the nearest existing parent and the message names the setting to add. No files are written.

Diagnostic pointer segments escape `/` as `~1` and `~` as `~0` using JSON Pointer rules: `/todos` becomes `/paths/~1todos/get`, and a nested property named `a/b~c` becomes `a~1b~0c`. This applies to unknown keys and configuration locations too. Invalid JSON reports a one-based line and column without quoting input contents. The YAML hint appears only for `.yaml`/`.yml` files or content that does not start with a JSON object or array.

Checks that depend on an invalid setting are skipped. Loading failures (such as invalid JSON or unresolved references) can prevent later checks; config errors stop compilation, and model errors stop operation validation. Within model and operation validation, diagnostics report the first failure per model or operation and continue checking the others. Fix the reported findings and rerun to reach dependent checks.

Library callers can opt in with `loadContract(apiPath, configPath, { collectDiagnostics: true })` and inspect `DiagnosticGroup.findings`. Other commands and ordinary `loadContract` calls still stop on a validation failure.

## Generated layout

```text
OUTPUT/
  .sdk-generator.json   Private ownership, resolved contract and provenance
  node/                 Selected npm target
    package.json
    index.js / index.d.ts
    runtime.js / runtime.d.ts
    codec-plan.js / runtime-plan.js  Bundled codecs and schema adapters
    README.md / REFERENCE.md / MODELS.md / RUNTIME.md / LICENSE
    examples/           JavaScript and TypeScript operation examples
    custom/             Provider-maintained helpers
    guides/             Optional provider narrative guides
  php/                  Selected Composer target
    composer.json
    src/                Client, runtime, models and compiled contract
    README.md / REFERENCE.md / MODELS.md / RUNTIME.md / LICENSE
    examples/           PHP operation examples
    custom/             Provider-maintained helpers
    guides/             Optional provider narrative guides
```

Only selected targets are emitted. Webhook inbox/outbox examples appear when verification is configured. The private root record uses compact JSON and is excluded from package archives; preserve it to detect hand edits, remove obsolete owned files and compare future versions. Generated packages contain their selected operation descriptors, codecs and public types. Source schema definitions are retained where required by public schema-taking helpers.

`effective` omits unselected targets' package metadata. The resolved library contract and private record retain compatibility placeholders; see [overrides and effective configuration](configuration.md#overrides). Release plans contain publication settings and instructions only for selected targets; unselected entries in `packages` are `null`.

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

An installed generator exposes these exports from `@public-sdk/generator`. `render(contract)` returns a map of relative paths to contents without writing. `preview(contract, output)` returns the rendered files, previous record, changes and compatibility findings; `generate(contract, output, true)` adds unified diffs to its serializable report. `compare(before, after)` compiles and compares resolved contracts using current compiler semantics. It cannot establish arbitrary historical runtime behavior; generation and release preparation use the saved compiled baseline when available. `prepareRelease`, `publishRelease` and `publishSite` perform the corresponding release operations; the latter two take an explicit confirmed version. `validateFixtures` is asynchronous; the other listed functions are synchronous. Failures throw errors, including `Diagnostic` with a source/configuration location.

`initialConfig(apiPath, { targets: ['node'] })` returns the minimal editable configuration without writing files or diagnosing API capabilities. The options may be omitted to select both targets. It uses the same local JSON loader and OpenAPI version checks as contract loading; unselected package metadata is omitted. Like `init`, it selects explicit `responses.return: "result"` when any successful response cannot return an object payload, including nonobject, empty or non-JSON responses; otherwise it keeps the object payload default.

`setCompatibilityBaseline(output, 'draft' | 'released')` resets unpublished history or adopts the currently generated release without deleting ownership or recompiling historical decisions. See [saved baselines](releases.md#saved-baselines).

## Troubleshooting

| Symptom                                                | Action                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dist/cli.js` cannot be found                          | Run `npm ci` and `npm run build` from the repository root.                                                                                                                                                                                                                                                                                                              |
| Unsupported schema, reference, format or encoding      | Follow the diagnostic's source pointer and [support matrix](support-matrix.md). Vendor remote references locally or select supported operations; do not discard required wire semantics to silence a diagnostic.                                                                                                                                                        |
| Generated example fails validation                     | Supply a valid input under `operations.<operationId>.example` in the [configuration](configuration.md).                                                                                                                                                                                                                                                                 |
| Generated file was edited or an unowned file conflicts | All edited owned files are listed in the error. Move intentional helper code to the appropriate `custom/` directory, or generate into a fresh output directory and reconcile changes. Delete an edited generated file to let regeneration restore it. If the private record was lost, restore it from a backup or regenerate into a fresh directory from pinned inputs. |
| A sibling generation lock remains after a crash        | Dead-pid locks with transaction tokens recover automatically with a warning. Legacy locks without tokens and unknown owners require inspection; CLI SIGINT/SIGTERM removes the interrupted worker’s lock and stage and restores any pending backup. See [regeneration transactions](architecture.md#regeneration-transaction).                                          |
| A required validation tool cannot be found             | The error names the tool and selected target. Install it on `PATH`, or set `targets` in the SDK configuration to omit that target and regenerate. Node validation needs Node and npm; PHP needs PHP and Composer.                                                                                                                                                       |
| Release destination already exists                     | Choose a new release directory; prepared releases are not overwritten.                                                                                                                                                                                                                                                                                                  |
| Release asks you to regenerate                         | Use the matching generator and pinned inputs to regenerate, then rerun validation and review the new preview.                                                                                                                                                                                                                                                           |

For a reproducible bug report, follow [contributing](../CONTRIBUTING.md). Keep private contracts and credentials out of public diagnostics and reports.
