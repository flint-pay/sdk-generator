# Architecture and extension points

The generator is a TypeScript CLI/library. There is no daemon, telemetry, hosted account requirement or network fetch during contract loading/generation.

Start with the [CLI and library reference](cli.md) for invocation, [configuration](configuration.md) for provider inputs, or [using generated SDKs](using-sdks.md) for the consumer API.

## Pipeline

| Stage                                                                                               | Owner                                                   |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Read local inputs, resolve references, apply overrides, select operations, validate and hash source | `src/contract.ts`                                       |
| Compile the resolved contract into codecs, declarations, descriptors and compatibility facts        | `src/target-plan.ts`, `src/codec-plan.ts`               |
| Render the plans into standalone packages                                                           | `src/generate.ts`                                       |
| Execute compiled descriptors at runtime                                                             | `src/runtime.ts`, `templates/Runtime.php`               |
| Run generated clients against independently specified HTTP cases                                    | `src/fixtures.ts`, `templates/fixtures.php`             |
| Compare saved plans with new ones                                                                   | `src/compatibility.ts`, `src/compiled-compatibility.ts` |

Compilation and comparison take explicit inputs and perform no filesystem, network, clock or environment access; generation owns file reads and writes. Compiler dependency checks inspect TypeScript imports and PHP tokens to block forbidden edges and cycles.

Generated packages carry their compiled descriptors and execute them with their own language's JSON and transport primitives. Ordinary generated calls do not compile schemas. Public schema-taking helpers remain available for application-supplied schemas: Node bundles the same pure codec compiler used during generation, and PHP's isolated `Internal\SchemaAdapter` translates schemas into the same descriptor format. Neither is a fallback path for generated operations, and generated-client tests disable the adapters to enforce that boundary.

Public declarations and runtime guarantees remain separate facts in the compiled contract. A target exposing `unknown` or `mixed` does not discard guarantees enforced by its codec.

The private generation record stores resolved source provenance and compiled snapshots, so compatibility compares saved previous decisions against new plans rather than reinterpreting old source schemas. It is excluded from SDK archives. Selected descriptors and public dynamic schema definitions are SDK source, so an SDK for a private API must be distributed privately.

## Regeneration transaction

Preview renders all artifacts in memory, checks prior owned file hashes, refuses unowned-file conflicts and symlinks, and reports created/modified/removed files without writing anything. Generation acquires an exclusive sibling lock, rechecks the plan, stages a complete replacement tree with handwritten neighbors preserved, then swaps the directory. A failure before commit leaves old output intact; a failed rename restores the backup. Existing generated files edited by hand are a conflict, not silently overwritten. Move intentional helpers to `custom/`. Removing a target preserves its handwritten neighbors; validation and release preparation use the selected targets in the private record, not leftover directories.

Atomic directory replacement is scoped to one output directory on the same filesystem. Readers may briefly observe a missing directory between the backup and replacement renames. A process crash can leave a sibling backup/staging directory or lock; inspect these before recovery. Concurrent manual changes during generation are unsupported. Do not generate into a repository root or a directory used by a running deployment.

Deterministic rendering normalizes object-key order, excludes timestamps/absolute workspace paths from generated packages, and pins compiler versions with package-lock.json. Local source files and the pinned generator revision are required to reproduce provenance.

## Extending the project

For a new schema construct or API capability, add its contract type and validation first. Add explicit compiler decisions and implement their execution in **both** runtimes, update the support matrix, add independently expected HTTP fixtures and negative scenarios, and test published artifacts. A language-specific convenience may vary, but must preserve shared API semantics. A requested feature that is not supported stays a diagnostic failure until both runtimes implement it.

Ordinary diagnostics hooks receive operation/attempt/status/request ID/timing only. Transport injection is a separate privileged boundary: it sees URLs, headers and bodies. Keep credentials out of diagnostics and examples. The application owns injected transports and any downstream retry/connection policy.

Provider-owned domain helpers live in generated package `custom/` directories and may wrap public resource methods. They should expose partial completion/recovery explicitly; a sequence of SDK calls does not become a server transaction. `examples/library.openapi.json` is a synthetic non-payment contract, and `tests/fixtures/payment-api.json` is a synthetic payment contract. Source checkouts also contain pinned provider regression inputs under `tests/providers/`, with provenance and explicit profile corrections. Those inputs are excluded from the generator's npm distribution. Provider-specific declarations remain in profiles and fixtures.

Node consumers import helpers using `package-name/custom/helper.js`; matching `.d.ts` files can supply helper types. PHP classes in `custom/` are discovered by Composer's generated classmap during installation or `composer dump-autoload`. The generator owns only the PHP directory marker and never overwrites handwritten helper files. Both package archives include intentional custom files and exclude unrelated neighboring source files.

Unsupported generation input produces a diagnostic; unavailable compatibility proof produces a review finding. The public schema comparison entry points compile their arguments under current semantics and cannot recover arbitrary historical runtime behavior.

`src/distribution.ts` prepares and deploys an independently hosted Composer repository and versioned documentation. Markdown rendering disables raw HTML; downloadable examples receive a `.txt` suffix so PHP-capable hosting cannot execute them as scripts. Release checksums cover docs and examples as well as archives.
