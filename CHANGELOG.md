# Changelog

Generator changes that affect generated SDKs. Generated SDK versions are independent; regenerated packages record their own findings in their release notes and migration guidance. See [releases](docs/releases.md) for version policy and [upgrade steps](docs/releases.md#upgrade-an-existing-sdk).

## Unreleased (generator 0.1.0)

### Breaking changes for generator automation

- **CLI output.** Commands print readable summaries by default. Pass `--json` to keep the previous JSON on stdout and JSON errors and warnings on stderr; JSON shapes are unchanged. `effective` still prints JSON. Library functions are unchanged.

### Breaking changes for regenerated SDKs

- **Error kinds.** HTTP 404 uses kind `not_found` and HTTP 500–599 uses `server`, replacing `api` for those statuses. Update kind switches. Retry eligibility still follows the declared policy.
- **Error messages and codes.** Server messages, provider codes and code-based retries require original JSON strings. Decimal, exponent and large-integer JSON numbers do not become messages or codes or trigger string-code retries. Node error paths stop at scalar strings and ignore runtime-only array properties, matching PHP: `code.0` cannot turn a string into a one-character retry code, and `details.length` cannot expose an array length.
- **Numbers.** Plain `number`, float and double fields accept and return native numbers (PHP `int|float` inputs, `float` outputs). Replace numeric-string arguments with numbers. Declare `format: "decimal"` to keep exact decimal strings. int64/uint64 keep exact strings.
- **TypeScript objects.** Shaped objects have no implicit index signature. Correct misspelled request and response fields. This is a declaration change; runtime request-key rules are unchanged.
- **Compiled value semantics version 4.** Comparisons against older compiled semantics report a breaking migration; old snapshots keep their recorded codec decisions.
- **Payload-mode `Pages` and `Wait`** return the same projected payload as the base method. Use `PagesWithResponse` or `WaitWithResponse` for the full body, metadata and raw response. Result-mode helpers and `Items` are unchanged. Saved contracts record the helper return policy; under `semver` a stable SDK needs a major version.
- **Webhook error kinds.** Invalid caller inputs and unusable secrets use `validation`; missing or malformed signing headers, out-of-tolerance timestamps and signature mismatches use `authentication`; authenticated JSON and payload failures use `protocol`. Errors expose stable `webhook_*` codes.
- **Webhook `known`** requires a registered event name and a matching declared envelope, not name recognition alone. Authenticated unmatched variants return `known: false`.
- **Composed clients** reject `token` unless `auth.shortcuts.token` maps it, instead of ignoring it. TypeScript declarations omit the unsupported option.
- **Servers.** Relative or templated servers and path-level server overrides fail diagnosis instead of being ignored.
- **PHP nullable wrappers** return generated entities instead of `stdClass`, and malformed known values fail instead of escaping through an unknown-variant fallback. Existing component classes keep their names; newly typed inline objects get the usual owning-field class name. Adapt consumers with generated getters or the raw `toArray()`/`jsonSerialize()` exports. No configuration change is needed.
- **PHP entity representations and accessor names.** See [migrating PHP entity representations](docs/releases.md#migrating-php-entity-representations).
- **Retry defaults and `idempotencyKey` types.** See [retry defaults](docs/releases.md#retry-defaults).
- **Node type dependency.** `@types/node` moves from a pinned runtime dependency to an optional `>=22.16.0` peer dependency. TypeScript consumers must install it, for example `npm install --save-dev @types/node@22`.

- **Managed header inputs.** Headers supplied by an operation's permitted authentication modes and the configured API-version header are removed from method inputs and PHP input getters. Anonymous operations and operations whose modes never supply a declared header retain that input field. Pass credentials through authentication options; their wire values are validated against declared header schemas. Compatibility comparison reports the removed fields as breaking. Declared idempotency, conditional and request-ID headers retain input fields and their declared requiredness is enforced before dispatch; idempotency and conditional values may be supplied through request options or automatic idempotency keys.

### Added

- `preview --diff`.

- `errors.messagePath` (default `message`) and a direct HTTP `status` on errors in both targets. Node inspection and PHP debug output include provider codes, redacted details and stack frames.
- Destination errors distinguish protocol failures from allowed-origin failures.
- TypeScript nullable object fields support direct optional field access.
- Default base URL from the first declared top-level server. Explicit `baseUrl` values take precedence. Adding a default is additive; changing or removing one is breaking. PHP `ClientOptions.baseUrl` is nullable when omitted; positional argument order is unchanged.
- Typed nullable values for `anyOf`/`oneOf` wrappers with one typed non-null branch and a plain null branch.
- Date-time inputs accept JavaScript `Date` and PHP `DateTimeInterface`.
- Webhook verifiers accept one secret or an array for rotation; Node accepts Fetch `Headers` and Node/Express header records; PHP accepts PSR-7 header arrays. Parsed JSON and malformed inputs produce SDK errors instead of native type errors.
- CommonJS `require()` of the package root and resource subpaths on Node.js 22.12+.
- Optional `npm.repository` and `npm.homepage` metadata.
- Node resource subpaths, split declaration files and individual PHP class files with deferred descriptor loading. See [modular generated packages](docs/releases.md#modular-generated-packages).
- Generator CLI `<command> --help`, `--version` and `release --acknowledge-review`.
- `documentation.authShortcut` selects the authentication shortcut shown in README and operation examples.

### Fixed

- Selective generation with `include` skips operations without an operation ID in both targets. Missing-ID diagnostics explain how to select named operations, and missing override targets explain that overrides only replace existing values.
- Request bodies with no supported media type report that limitation immediately and suggest excluding the operation, rather than asking for an unusable media selection.
- `effective` omits unselected package metadata, and release plans omit unselected publication settings and instructions. Private records retain compatibility placeholders for existing comparisons.
- Node packages omit the unused `package-plan.d.ts`; transitive runtime dependencies, including `php-value-plan`, remain bundled.
- Node response types keep the component name referenced by the source schema when a structurally identical component shares its codec, so inferred return types match the reference (for example `CreatePaymentIntentResult`).
- Generated package READMEs start with a fenced install command and the quickstart, followed by short errors, pagination and webhook sections and documentation links. Pagination and webhook sections, the return-mode note and the idempotency note appear only when relevant; Node READMEs mention `client.close()` only for clients with streaming operations. Titles drop the `(node)`/`(php)` suffix.
- Example scripts and README samples stop with a `Set VARIABLE` error when a required credential variable is unset, instead of passing an empty credential that the client rejects at call time. Payload examples without printable ID fields print the result, empty descriptions no longer leave blank lines, and Node examples use double quotes throughout.
- `RUNTIME.md` uses short bullet sections ordered by task, with request-option and pagination snippets; numeric, PHP model and schema-helper details move to the end.
- Pagination iterators apply `deadlineMs` to each page request, including retries and decoding, instead of across the whole backfill. Bound an iteration with cancellation, `maxPages` or `maxItems`. Polling keeps its overall deadline.
- PHP normalizes HTTP/HTTPS scheme capitalization before omitting default ports, matching Node origin checks.
- Generator CLI errors name the cause: unknown command or flag, missing, empty or extra argument, a missing PHP or Composer tool for a selected target, and the JSON parse position. Hand-edit detection reports every edited file.
- Diagnostic locations escape JSON Pointer segments, for example `/paths/~1todos/get`.
- An operation no longer depends on models of another operation whose path extends it with a segment named like an HTTP method (for example `/values` `post` and `/values/post/nested`), so hidden operations do not pull their models into the SDK.
- Optional idempotency keys: mutations without a key send once instead of failing because retries were declared.
- Generated examples no longer use a fabricated sandbox fallback URL.
- Generated examples use the effective retry policy instead of disabling retries.
