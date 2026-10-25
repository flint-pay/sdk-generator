# Changelog

Generator changes that affect generated SDKs. Generated SDK versions are independent; regenerated packages record their own findings in their release notes and migration guidance. See [releases](docs/releases.md) for version policy and [upgrade steps](docs/releases.md#upgrade-an-existing-sdk).

## Unreleased (generator 0.1.0)

- Route optional headers marked `x-flint-request-option: client_request_id` to Node `clientRequestId` and PHP `client_request_id` per-call options, excluding them from operation inputs and positional params. Validate 1 to 128 visible ASCII characters before transport in both validation modes. Reject unknown extensions and conflicting header values. Preserve response request IDs and report request-option compatibility changes.

- Add opt-in `auth.defaultCredentials` configuration and lazy environment/workload identity providers in Node and PHP, with `defaultCredentials()` and `workloadIdentityCredentials()` exports and an `ambientCredentials: false` opt-out. Token and token-file sources exchange RFC 8693 forms, validate audience/expiry before sending, redact credentials in failures, refresh process-cached tokens ahead of expiry, retry transient exchanges within request deadlines, and invalidate/re-exchange once on replay-safe HTTP 401. PHP also accepts a PSR-16 compatible credential cache. Shared conformance cases cover both runtimes.

### Breaking changes for generator automation

- **JSON diagnostics and previews.** `diagnose --json` failures now use stdout. JSON errors carry stable codes and relative file paths; diagnostic pointers identify existing input nodes and their source file. `preview --json` omits diffs unless `--diff` is supplied; its optional `diffs` array contains only modified-file diffs. Update scripts parsing the previous channels, absolute locations or per-change diffs. Library `generate(..., true)` retains its existing diff report.

- **CLI output.** Commands print readable summaries by default. Pass `--json` for machine-readable output; see the JSON diagnostics and previews changes above for channels and report shapes. `effective` still prints JSON. Library functions are unchanged.
- **npm package names.** Configuration validation now rejects `npm.name` values over 214 characters, including the scope. Shorten any oversized names before generation.

### Breaking changes for regenerated SDKs

- **Node SSE transport.** Default SSE connections use native HTTP/HTTPS for socket lifetime control. Pass an explicit `transport` to retain application-specific fetch/Undici behavior.

- **Runtime safety.** Pagination defaults to 1,000 pages; set `maxPages` explicitly for larger traversals. Cursor cycles and two consecutive empty pages with continuations raise protocol errors. Per-attempt timeouts now use `timeout` / `TimeoutError`; update error-kind switches. Refused connections and DNS failures report `not_sent`, with stable error codes and safe transport detail. PHP transport failures without an HTTP response use `null` instead of `0` for status and metadata status. Both targets parse `Retry-After` using decimal seconds or canonical GMT HTTP dates; permissive signed/exponent/relative-date spellings are ignored. Error JSON exports omit raw bodies, headers, URLs and unsanitized causes; use explicit access for recovery. JavaScript rejects unknown client options, both targets reject base URLs repeating operation path prefixes, and PHP model assignment raises a validation error instead of creating a dynamic property. See [runtime safety migration](docs/releases.md#runtime-safety).
- **Inferred delete methods.** `deleteWidget` tagged `widgets` now infers `widgets.delete` in both targets instead of `api.deleteWidget`. Pin explicit resource/method names to preserve an existing SDK interface. Other conservative naming fallbacks now warn with a configuration remedy.

- **Retry contract (`budgets-2`).** Required idempotency headers with `auto` disabled require TypeScript options containing `idempotencyKey`. PHP still rejects missing keys before dispatch. Both targets use half-to-full backoff jitter, optional `retry.maxDelayMs`, and preserve the last error when a retry wait exceeds the deadline. PHP automatic keys now use UUID v4. Older compiled records remain readable for compatibility comparison; regenerate descriptors together with runtimes. See [retry migration](docs/releases.md#retry-defaults).

- Event names that share a type name or have no ASCII letters or digits fail diagnosis for every target.
- When `webhook` is configured, `VerifiedWebhook`, `KnownWebhookEvent` and each `WebhookEvent<EventName>` type name are reserved for every target selection, including PHP-only generation. Configurations whose model, resource or operation helper names collide with these symbols now fail diagnosis. Customize the conflicting model/resource/method name or change the event declaration.
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

- Contributor test workflows require Node.js 22.16+ for SQLite examples, with `.nvmrc`, CI and a clear test-runner prerequisite check. The published generator retains its Node.js 22+ engine requirement.
- Published SDK-config JSON Schema with `$schema` support and SDK-wide idempotency/retry/pagination defaults, field overrides, `false` opt-outs and `null` field clearing. The Flint full profile uses defaults without changing generated packages.
- `diagnose` checks compiled plans and runnable inputs without rendering packages. Header declarations warn with spelling candidates; unsupported wire features include remedies. Init supports multiple security alternatives, `--force` for regular files, and executable next-step commands. Generation/validation/release warn about placeholder package vendors.
- Generation locks precede loading/planning; dead owners recover with a warning. CLI SIGINT/SIGTERM cleans up its worker’s transaction under the same lease as stale recovery, verifying the retired lock’s inode before removal. Private ownership records use compact JSON; missing records explain backup/fresh-generation recovery.

- Node and PHP credential options accept providers resolved on every request attempt. Replay-safe requests invalidate provider credentials on HTTP 401 and retry once with the same idempotency key. PHP also accepts credential closures. Applications own token loading, caching and expiry handling.

- Optional `errors.retry: { path, retryValues }` for body-driven retries, with configured status fallback when the path has no string. Optional `idempotency.autoKeyPrefix` prefixes generated UUID v4 keys. Keyed errors and response metadata expose `idempotencyKey`; errors expose a valid server wait as `retryAfterMs`. Both targets retain attempt/deadline bounds and never retry HTTP 412 or cancellation.

- `init API_JSON SDK_JSON [--targets node|php|node,php] [--json]` writes a minimal configuration with placeholder package names, refuses overwrites and reports diagnosis while keeping the file on diagnostic failure. Library callers can use `initialConfig` without writing files.
- SDK errors now have one subclass per `kind`: Node exposes them through the root/resource `errors` namespace and PHP through the `Errors` sub-namespace. `SdkError` and `kind` remain authoritative, and `instanceof SdkError` keeps working. Node `error.name` and inspection now show the subclass name (for example `NotFoundError`), a visible change.
- Webhook results with `known: false` include `reason: 'unknown_event' | 'unmatched_envelope'` in both targets. Packages with verification declared expose standalone Node `verifyWebhook` and PHP `Webhooks::verify`, requiring no client options, base URL or API credentials; client methods delegate to the shared verifier. PHP keeps guarded `mixed` arguments so invalid inputs produce SDK error subclasses. If a model uses the `Webhooks` name (case insensitive), PHP preserves the model and omits the standalone verifier class; `Client::verifyWebhook` and Node's standalone function remain available.
- `preview --diff`.
- Node exports `VerifiedWebhook`, `KnownWebhookEvent` and `WebhookEvent<EventName>`; `verifyWebhook` returns `VerifiedWebhook`.

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

- Runtime error messages identify caller authentication options; PHP invalid header values raise SDK validation errors. Malformed SSE events retain their event ID and one-based position. Unconsumed default Node SSE streams no longer keep the process alive and expire their idle budget before iteration. Node webhook verification accepts ArrayBuffer and Uint8Array bytes, and both targets explain millisecond-scale `nowSeconds` mistakes.

- Webhook declarations and root exports use canonical event-name order, matching PHP class order. Freshly generated SDKs render identically after restoring their saved contract, so release preparation no longer incorrectly requires regeneration.
- Full generation reuses compiled sample validators instead of recompiling one per candidate example, restoring generation time for large APIs (about 30% faster on the full Flint export).
- `init` prefixes digit-leading PHP namespace segments with `Sdk`, shortens package slugs to fit npm's 214-character name limit and quotes shell-sensitive paths in its human `generate` suggestion.
- Built-in Node SDK error names remain stable in minified bundles, including `AuthenticationError` and the base `SdkError`; user subclasses retain their constructor names. Error factories preserve the calling site in Node stack traces and PHP exception file/line metadata.
- APIs with a `Webhooks` model and webhook configuration generate in both targets without renaming the model. PHP omits the optional standalone verifier class when its name is taken; client verification still works.
- **Security: protected schema annotations.** Node and PHP packages omit schema examples and defaults at sensitive, write-only, and password locations, including protected reference uses, nested containers, compositions, and shared component bridges. Source-graph protection survives private record restoration, regeneration, and release preparation. Descriptions remain; runnable samples use placeholders. Removing published annotation values requires compatibility review.
- Protected dictionary and array-element constraints now suppress annotations at every child location of the same value across compositions, including explicit properties and split `items`/`contains` constraints. Configured stream roots distinguish operations from different vendored files even when their source pointers and event names match. Both fixes apply to Node and PHP publications and restored contracts.
- Protected properties no longer suppress examples on unrelated sibling fields or components in either target. Matching fields across compositions remain protected, while ancestor annotations that could embed protected values are still omitted. This preserves valid inferred examples such as Flint money currency codes.

- Generated examples and README inputs can replace inferred placeholders with validated, non-sensitive path/query parameter examples. Existing schema example/enum selection and default metadata behavior are preserved, as is explicit SDK configuration precedence. Added format-valid placeholders for UUID, URI, hostname and IP addresses, with the existing sampler retained when a format placeholder conflicts with schema constraints. Exact numeric-string parameter tokens are preserved; parsed exact numeric literals fall back.
- Node and PHP operation references list request body fields and inline alternative variants without schema examples. Variant tables combine parent and branch field declarations, requiredness and constraints. Long unions are indented, `Record<…>` expressions stay intact, and idempotency scope text no longer gains a doubled period.
- IPv4 and IPv6 formats are accepted as textual annotations, with format-valid inferred sample values; SDK wire validation is unchanged.

- Selective generation with `include` skips operations without an operation ID in both targets. Missing-ID diagnostics explain how to select named operations, and missing override targets explain that overrides only replace existing values.
- Request bodies with no supported media type report that limitation immediately and suggest excluding the operation, rather than asking for an unusable media selection.
- `effective` omits unselected package metadata, and release plans omit unselected publication settings and instructions. Private records retain compatibility placeholders for existing comparisons.
- Node packages omit the unused `package-plan.d.ts`; transitive runtime dependencies, including `php-value-plan`, remain bundled.
- Node response types keep the component name referenced by the source schema when a structurally identical component shares its codec, so inferred return types match the reference (for example `CreatePaymentIntentResult`).
- Generated package READMEs start with a fenced install command and the quickstart, followed by short errors, pagination and webhook sections and documentation links. Pagination and webhook sections, the return-mode note and the idempotency note appear only when relevant; Node READMEs mention `client.close()` only for clients with streaming operations. Titles drop the `(node)`/`(php)` suffix.
- Example scripts and README samples stop with a `Set VARIABLE` error when a required credential variable is unset, instead of passing an empty credential that the client rejects at call time. For operations that also allow anonymous access, examples send credentials only when their variables are set, so composed clients no longer reject the anonymous call. Payload examples without printable ID fields print the result, calls without arguments stay on one line, empty descriptions no longer leave blank lines, and Node README samples, operation examples and runtime-guide snippets use double quotes.
- `RUNTIME.md` uses short bullet sections ordered by task, with request-option and pagination snippets; numeric, PHP model and schema-helper details move to the end.
- Pagination iterators apply `deadlineMs` to each page request, including retries and decoding, instead of across the whole backfill. Bound an iteration with cancellation, `maxPages` or `maxItems`. Polling keeps its overall deadline.
- PHP normalizes HTTP/HTTPS scheme capitalization before omitting default ports, matching Node origin checks.
- Generator CLI errors name the cause: unknown command or flag, missing, empty or extra argument, a missing PHP or Composer tool for a selected target, and the JSON parse position. Hand-edit detection reports every edited file.
- Diagnostic locations escape JSON Pointer segments, for example `/paths/~1todos/get`.
- An operation no longer depends on models of another operation whose path extends it with a segment named like an HTTP method (for example `/values` `post` and `/values/post/nested`), so hidden operations do not pull their models into the SDK.
- Optional idempotency keys: mutations without a key send once instead of failing because retries were declared.
- Generated examples no longer use a fabricated sandbox fallback URL.
- Generated examples use the effective retry policy instead of disabling retries.
