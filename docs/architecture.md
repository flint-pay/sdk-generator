# Architecture and extension points

The generator is a TypeScript CLI/library. There is no daemon, telemetry, hosted account requirement or network fetch during contract loading/generation.

Start with the [CLI and library reference](cli.md) for invocation, [configuration](configuration.md) for provider inputs, or [using generated SDKs](using-sdks.md) for the consumer API.

1. `src/contract.ts` reads local inputs, resolves references, applies explicit provider overrides, validates the supported subset, selects operations, and produces a language-neutral resolved contract. Source hashes record all referenced files, including the configuration.
2. `src/generate.ts` creates Node and PHP source/package/documentation artifacts from the same contract. Inputs/responses have separate public representations. Selected operations include required models but not excluded API surfaces.
3. `src/runtime.ts` is the Node runtime copied into the npm output. `templates/Runtime.php` implements the corresponding PHP semantics. They have no dependency on the installed generator.
4. `src/fixtures.ts` and `templates/fixtures.php` exercise generated public clients with externally supplied expected HTTP cases. Tests also install packages and call both default transports against a local HTTP server.
5. A private ownership/provenance record drives previews, conflict detection and regeneration. Generated packages do not include this record or upstream private definitions. Generated operation/schema information necessarily exists inside the SDK; private SDKs must be distributed privately.

## Regeneration transaction

Preview renders all artifacts in memory, checks prior owned file hashes, refuses unowned-file conflicts and symlinks, and reports created/modified/removed files without writing anything. Generation acquires an exclusive sibling lock, rechecks the plan, stages a complete replacement tree with handwritten neighbors preserved, then swaps the directory. A failure before commit leaves old output intact; a failed rename restores the backup. Existing generated files edited by hand are a conflict, not silently overwritten. Move intentional helpers to `custom/`.

Atomic directory replacement is scoped to one output directory on the same filesystem. Readers may briefly observe a missing directory between the backup and replacement renames. A process crash can leave a sibling backup/staging directory or lock; inspect these before recovery. Concurrent manual changes during generation are unsupported. Do not generate into a repository root or a directory used by a running deployment.

Deterministic rendering normalizes object-key order, excludes timestamps/absolute workspace paths from generated packages, and pins compiler versions with package-lock.json. The private record contains resolved data and source hashes. Local source files and the pinned generator revision are required to reproduce provenance.

## Extending the project

For a new schema construct or API capability, add its contract type and validation first. Implement observable semantics in **both** runtimes, update the support matrix, add independently expected HTTP fixtures and negative scenarios, and test published artifacts. A language-specific convenience may vary, but must preserve shared API semantics. Unsupported requested features must remain diagnostic failures until implemented.

Ordinary diagnostics hooks receive operation/attempt/status/request ID/timing only. Transport injection is a separate privileged boundary: it sees URLs, headers and bodies. Keep credentials out of diagnostics and examples. The application owns injected transports and any downstream retry/connection policy.

Provider-owned domain helpers live in generated package `custom/` directories and may wrap public resource methods. They should expose partial completion/recovery explicitly; a sequence of SDK calls does not become a server transaction. `examples/library.openapi.json` is a synthetic non-payment contract, and `tests/fixtures/payment-api.json` is a synthetic payment contract. Source checkouts also contain pinned provider regression inputs under `tests/providers/`, with provenance and explicit profile corrections. Those inputs are excluded from the generator's npm distribution. Provider-specific declarations remain in profiles and fixtures.

Node consumers import helpers using `package-name/custom/helper.js`; matching `.d.ts` files can supply helper types. PHP classes in `custom/` are discovered by Composer's generated classmap during installation or `composer dump-autoload`. The generator owns only the PHP directory marker and never overwrites handwritten helper files. Both package archives include intentional custom files and exclude unrelated neighboring source files.

`src/compatibility.ts` compares schema evolution in the direction of input acceptance and response guarantees. `src/distribution.ts` prepares and deploys an independently hosted Composer repository and versioned documentation. Markdown rendering disables raw HTML; downloadable examples receive a `.txt` suffix so PHP-capable hosting cannot execute them as scripts. Release checksums cover docs and examples as well as archives.
