# Contributing

Run commands from the repository root. Use Node.js 22.16+ (`nvm use` reads `.nvmrc`), PHP 8.2+ with curl/json/pdo_sqlite/zip/pcntl (pcntl is used only by cancellation tests), and Composer 2. The test runner checks the Node.js 22.16 minimum required by the contributor suite, including the SQLite examples. The published generator supports Node.js 22+; generated SDK runtime requirements are listed separately in the support matrix.

```sh
npm ci
npm run check
npm test
```

Start with the [architecture](docs/architecture.md) and [support matrix](docs/support-matrix.md). The [CLI reference](docs/cli.md) describes source-checkout commands and library exports. `npm run build` produces the ignored `dist/` directory; `npm test` builds automatically. Generated package runtimes do not depend on a globally installed generator or TypeScript.

## Test workflows

All npm test scripts rebuild `dist/` before running: tests import the compiled JavaScript, not `src/`. After changing source, rebuild before invoking `node --test` directly. Test fixtures and PHPStan paths are relative to the repository root.

```sh
npm run test:fast
npm run test:file -- tests/request-options.test.mjs
npm run test:file -- --test-name-pattern="object targets with schema" tests/request-options.test.mjs
npm run test:file -- --test-concurrency=2 tests/request-options.test.mjs tests/client-setup.test.mjs
```

`test:fast` omits `full-public-packages.test.mjs` (complete Flint generation, installation and budgets) and `full-public-spec.test.mjs` (complete export inventory and referenced graph generation). It retains the smaller Flint fixtures and both target runtimes. It is a development feedback path; run the full `npm test` before submitting code. Each test worker also checks configurations and their referenced profile fragments against the published config schema after successful library loads; completeness remains the loader’s responsibility after merging. Ordinary files run with concurrency four by default; override it with `--test-concurrency=N`. The full-public-package generation budget runs separately so concurrent test processes do not distort its time and memory limits. Shared generated packages are prepared in `before` hooks, so name-filtered runs do not generate packages for files with no matching tests.

The test runner installs the locked development-only PHPStan dependency from `tests/phpstan/` into ignored `.generated/phpstan-vendor/`. It is not a dependency of generated SDKs. `test:fast` and `test:file` perform the same setup. For direct `node --test` runs after a clean checkout, first run `composer install --working-dir=tests/phpstan --no-interaction --no-progress`.

`tests/php-runtime-analysis.test.mjs` also analyses the generated library package's entire `php/src/` tree, with synthetic authentication declarations to include the optional ambient-credential implementation, at PHPStan level 5 (PHP 8.2), alongside the existing level-max consumer tests. Its exact-count baseline in `tests/phpstan/runtime-baseline.neon` records 13 existing constructor/default typing and closure/control-flow inference diagnostics. Level 6 currently adds extensive missing collection/generic annotations; those require a separate typing effort. New errors and obsolete baseline entries fail the test. Do not refresh this baseline to hide a regression.

Tests generate packages in temporary directories, typecheck PHP and JS/TS consumer examples, install npm/Composer packages, exercise shared provider-style fixtures, verify signatures and durable duplicate handling, and call both default transports against a local HTTP server. They do not call a live payments provider. PHP and Composer are required; a missing target runtime is a test failure, not a skipped parity check.

When changing shared semantics, update the owning compiler decision and the affected executors or adapters, with cases in the shared fixtures. Review expected HTTP values independently of generator output. New capabilities require diagnostics for incomplete declarations, documentation and negative scenarios. Keep generated output readable and deterministic. Do not check generated artifacts, real credentials or private provider definitions into this repository.

For bug reports, include generator/package/runtime versions, a minimal sanitized API/configuration example, the expected and observed wire behavior, and a request ID when safe. Explain whether the reproduction uses local fixtures, a sandbox or a live provider. Redact credentials and sensitive bodies.

The generator is pre-1.0 and has no paid support SLA. Support covers the published capability and runtime matrix. Record deprecations and breaking changes in [CHANGELOG.md](CHANGELOG.md), with the effect on both targets described. A new language or provider capability starts from a concrete contract and its tests.

## Scope and maintenance

This generator exists to produce and maintain the Flint Pay SDKs. It is published under Apache-2.0 so that others can use it, learn from it and adapt it, but it is not a general-purpose SDK generator and does not aim to become one. The maintainers are a small team whose first obligation is to the packages Flint Pay ships from this code.

Every merged change is a maintenance commitment. It has to be understood, tested on each release, kept working through refactors and defended when a bug report arrives. Before opening a substantial pull request, open an issue describing the problem, the proposed approach and the ongoing cost. Expect a discussion about scope before a review of code.

A pull request may be declined even when it is correct, well tested and well written. The usual reasons are:

- It adds a target language, provider capability, transport or configuration surface that Flint Pay does not use and cannot realistically keep verified.
- Its size or spread across the compiler, emitters and both runtimes is large enough that a regression in it would put the existing SDKs at risk.
- It introduces a public API, option or generated-output shape that would have to be supported indefinitely without a concrete consumer here.
- It would require expertise or infrastructure the maintainers do not have.

Small, focused changes are the most likely to be merged: bug fixes with a failing test, corrections to documentation, diagnostics for inputs that currently fail silently, and support-matrix gaps that Flint Pay also needs. If you are unsure whether a change fits, ask in an issue first.

If your needs go beyond that, please fork. The license permits it, generated packages carry no dependency on this repository, and a fork that serves its own consumers well is a better outcome than a shared codebase that serves nobody well. We are happy to answer questions from forks and to accept upstream fixes for shared behavior.

## Code design and review rules

Apply these rules to new and substantially changed code. Existing violations are migration work, not a reason to combine unrelated rewrites with a focused fix. Compiler boundaries are enforced by `tests/compiled-boundaries.test.mjs`. Public dynamic-schema adapters remain an explicit compatibility boundary.

- **Give each semantic decision an owner.** Reuse the function/data that resolves a rule when its meaning is identical. Keep language-specific execution separate where necessary and verify it with shared behavioral cases. A PR changing representation, requiredness, validation, or routing must identify the owner and affected consumers; moving a duplicate into a helper file does not remove the duplication.
- **Model valid states explicitly.** Prefer discriminated unions and exhaustive handling for closed internal concepts such as codec kinds or comparison results. Do not use a bag of optional properties or unrelated booleans to represent mutually exclusive modes. Separate request encoding, response decoding, and alternative matching through named entry points or a typed context. Ordinary boolean options remain appropriate for independent on/off settings.
- **Validate at boundaries and keep the core typed.** Treat untrusted parsed input as `unknown` until validated. Avoid new `any`, unchecked assertions, and non-null assertions in semantic code; a necessary interop assertion must be local and explain the invariant that makes it safe. Retain runtime validation for serialized descriptors: static exhaustiveness does not validate external data.
- **Keep computation independent of effects.** Semantic compilation and comparison receive explicit inputs and return results without filesystem/network access, environment reads, clocks, randomness, or input mutation. Place those effects in orchestration/transport boundaries. Use readonly views for shared graphs; a phase may own a local mutable builder, then publish a stable result. Preserve source paths through transformations for useful diagnostics.
- **Make dependencies follow responsibilities.** Shared semantic code must not depend on CLI, package publication, or target transport implementations. Once a path consumes compiled plans, its emitter/comparator must not reinterpret raw schema keywords or import a legacy schema adapter. Prefer explicit parameters and narrow modules to global registries or service locators.
- **Preserve uncertainty and error meaning.** Unsupported generation input produces a diagnostic; unavailable compatibility proof produces a review result. Do not turn an unexpected exception, unknown descriptor kind, or missing implementation into success or a permissive fallback. Catch errors only at a boundary that can translate/recover from them; preserve causes and paths without leaking sensitive values. Intentionally isolated diagnostics callbacks and predicate APIs need their own documented behavior.
- **Keep public boundaries deliberate.** Inventory existing exports, subpath imports, constructors, and configuration defaults before changing them. Do not treat a callable API as removable merely because it was intended to be internal. Keep new codec/compiler internals out of package-root exports unless a concrete consumer requirement justifies the compatibility obligation. Adapters preserve existing signatures and delegate; they must not grow an independent business-policy implementation.
- **Keep generated code mechanical.** Resolve policy before rendering migrated paths. Templates may format syntax, escape values, reference symbols, and wire calls; they must not invent schema semantics. Provider corrections belong in configuration/profiles. Add abstractions when they remove demonstrated duplication or enforce an invariant, not in anticipation of hypothetical targets/features.
- **Verify behavior independently.** For semantic changes, exercise real generated clients in both targets with independently expected wire values and decoded outcomes. Include a failure witness and a compatible control where relevant. Snapshot/typechecking evidence supplements runtime behavior; neither alone proves SDK compatibility. Do not update expected outputs solely because the new implementation produced them.
- **Remove temporary paths deliberately.** Record the scope and exit condition for migration fallbacks and compatibility adapters. Generated operations must not silently fall back to legacy execution for unsupported compiled nodes. Preserve public dynamic-schema entry points while removing superseded operation paths; an adapter needed by callers is not removable migration scaffolding.

## Enforcement and evidence

CI runs `npm run check`, `npm test`, and `npm pack --dry-run` across the Node/PHP matrix. TypeScript already enables `strict`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes`. These checks do not automatically enforce semantic ownership, exhaustive switches, import boundaries, or the absence of explicit `any`. CI also runs `npm run format:check`. Five pre-existing root test files are explicitly excluded in `.prettier-check-ignore`; source, templates, documentation and the remaining tests are checked. Remove an exclusion when deliberately formatting that file.

A compiler or codec change needs automated checks for the boundary it adds: exhaustive handling of closed variants plus runtime rejection of malformed serialized ones, an import check that blocks forbidden edges and cycles, behavioral proof that compiled operations do not invoke the schema adapters, generated-consumer compilation against the public API, independently expected cases through both runtimes, and repeated compilation without input mutation. Semantic ownership, abstraction value, and fixture independence also require review; a passing dependency check cannot establish them.

For a semantic PR, explain the changed guarantee, its owner, public/configuration impact, any replaced logic or retained adapter, and the independent evidence. Keep this explanation proportional to the change. Do not use file size, test count, or a smaller diff as a substitute for showing that behavior remains correct.

## Documentation and package checks

Update the [configuration guide](docs/configuration.md), [consumer guide](docs/using-sdks.md) and support matrix whenever public behavior changes. Reference docs describe current behavior; record what changed in [CHANGELOG.md](CHANGELOG.md) and upgrade steps in [releases](docs/releases.md#upgrade-an-existing-sdk). Package README/reference text is emitted from `src/generate.ts`; update that text too when the change affects generated consumers. Keep working notes, provider acceptance logs and local investigation artifacts out of public documentation and package contents.

```sh
npm run format:check
npm pack --dry-run
```

Use `npm run format` to format repository source and documentation, or target only the changed paths with Prettier. `npm pack --dry-run` builds and reports the generator's distribution contents. Its explicit allowlist includes runtime files, user documentation and generic examples; provider regression fixtures and local working directories are excluded.

Provider regression inputs live under `tests/providers/` in a source checkout. The Flint fixtures retain source provenance, explicit schema corrections, synthetic signing vectors and a manifest of schema/profile/HTTP-case hashes. Follow `tests/providers/flint/README.md` when updating them: independently verify expected behavior before refreshing hashes. Normal `npm test` uses bundled inputs and does not require Go, provider credentials or a provider checkout. These fixtures exercise shared behavior; provider-specific declarations stay in test profiles.

## Baselines and fixture refreshes

Whole-output SHA-256 checks remain in `webhook-output-baseline.json` and `dx-public-baseline.json`. Failures collect every changed hash group and report added/removed/modified paths, byte changes and line ranges. `output-file-baseline.json` deduplicates per-file hashes and short line fingerprints for diagnostics; hunk previews show current text, with old lines represented by fingerprints. Use a previous checkout for a complete old/new text diff. The aggregate and per-file hashes both remain authoritative.

After independently reviewing the intended behavior and generated output, run:

```sh
npm run baselines:update
npm run test:file -- tests/webhook-types.test.mjs tests/compiled-preservation.test.mjs
```

The update rebuilds `dist/`, refreshes both current output baselines and the diagnostic inventory, and preserves reviewed root-export lists. Explain any hash changes in the PR. It does not update historical compatibility records (`compiled-public-baseline.json` and saved publication records), PHPStan debt, source provenance or provider manifests.

`tests/providers/flint/full-inventory.json` is a deterministic schema-location inventory of the pinned `full-openapi.json`, produced by `publicInventory` in `tests/helpers/public-inventory.mjs`. After following the [provider fixture review procedure](tests/providers/flint/README.md) and independently verifying the changed contract, refresh it from the repository root:

```sh
node --input-type=module <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
import { publicInventory } from './tests/helpers/public-inventory.mjs';
const root = 'tests/providers/flint/';
const source = JSON.parse(readFileSync(root + 'full-openapi.json', 'utf8'));
writeFileSync(root + 'full-inventory.json', JSON.stringify(publicInventory(source), null, 2) + '\n');
JS
```

Review operation/webhook counts and schema locations, update the inventory's SHA-256 entry in `fixture-manifest.json`, and update source provenance only when the pinned upstream source changes. Run `tests/full-public-spec.test.mjs`, `tests/flint.test.mjs` and `tests/full-public-packages.test.mjs`; refreshing hashes is not evidence that provider behavior is correct.

## Checks for the affected area

Every code PR runs `npm run check`, `npm test` and `npm run format:check`. The commands below describe additional focused evidence to run while developing and include in review; a fast or targeted run does not replace the full suite.

| Area                                                | Focused checks and review evidence                                                                                                                                                                                  |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contract loading, schema policy, target/codec plans | `compiled-boundaries`, `compiled-contract`, `compiled-codec`, `compiled-regressions` and the feature's fixture tests; check both runtime outcomes against independent wire values and malformed-input expectations. |
| Node/PHP runtime or templates                       | Feature tests in both targets, `generator`, `coverage`, `php-runtime-analysis`, and `sdk-type-correctness`; for HTTP, retry or streaming changes include the relevant local default-transport tests.                |
| Declarations, public names or PHP representation    | `sdk-type-correctness`, `php-entities`, `response-return`, `compiled-preservation`, `webhook-types`; inspect consumer errors and output changes before refreshing baselines.                                        |
| Rendering, package layout or publication            | `package-loading`, `selective-generation`, `npm-metadata`, `npm-pack`, `readme-regressions`, `generated-docs`, plus `npm pack --dry-run`; inspect the distribution allowlist and both generated packages.           |
| Provider fixture/profile changes                    | Follow the provider README, run `flint`, `full-public-spec`, `full-public-packages`, and review fixture manifests/provenance and independently expected HTTP cases.                                                 |
| CLI or test infrastructure                          | `cli`, `test-infrastructure`, the affected targeted runner command, and the full suite; exercise prerequisite/invalid-input failures.                                                                               |
| Documentation only                                  | Prettier on changed files and verify relative links/anchors. Run rendering tests when changing emitted documentation.                                                                                               |

Names in the table refer to `tests/NAME.test.mjs`; use `npm run test:file -- tests/NAME.test.mjs` (multiple files are accepted). Select the feature tests by the behavior changed, not only by the source file edited.

## Minimum-runtime container checks

For an isolated Node.js 22.16 / PHP 8.2 / Composer environment:

```sh
docker build -f tests/Dockerfile -t sdk-generator-minimum-test .
docker run --rm sdk-generator-minimum-test
```

The image copies the workspace inputs and runs the same suite, including generated package installs, HTTP fixtures, workflow recovery and local Composer repository publication. It does not mount or change your local dependencies. PHP 8.2 patch versions follow Debian's security updates; npm dependencies remain locked.
