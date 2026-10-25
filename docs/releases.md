# Releases and compatibility

- Generator releases and generated SDK versions are independent. Generator 0.1.0 supports the subset in the [support matrix](support-matrix.md). See the [changelog](../CHANGELOG.md) for generator changes.
- Node and PHP packages use the configured package `version`. The API `info.version` and an optional pinned version header are documented separately.
- Preview versions use a SemVer prerelease suffix and npm's `next` tag in the release plan.
- Commands below use the installed `sdk-generator` executable. From a source checkout, run `npm ci` and `npm run build`, then use `node dist/cli.js`. See the [CLI reference](cli.md) for arguments.

## Contributor Node prerequisites

The published generator continues to support Node.js 22+. Source-checkout contributor tests require Node.js 22.16+ for the SQLite examples, and the test runner reports a prerequisite error on earlier versions. Run `nvm use` before testing; `.nvmrc` and CI use the contributor minimum. No Node upgrade is required for existing generator installs. Generated SDK runtime requirements are unchanged. See the [support matrix](support-matrix.md) for consumer requirements.

## Prepare a release

1. Keep the pinned inputs, referenced local files, SDK configuration and generator revision in the provider's private or public source repository.
2. Run `preview --diff` against the current generated output. Review source, type and example differences and compatibility findings. `effective` explains the resolved contract but contains private API details.
3. Generate, then run `validate --fixtures` with independently provider-reviewed HTTP scenarios. Test relevant workflows against the provider sandbox separately.
4. Run `release OUTPUT NEW_RELEASE_DIRECTORY`. Inspect the archives, checksums, changelog, migration guidance and publication commands. Nothing is uploaded.

Release preparation:

- Checks generated file integrity and recomputes compatibility with the current generator.
- Combines fresh and recorded findings for version-policy checks, the release plan and migration notes, even when generated files are unchanged.
- Includes publication settings and instructions only for selected targets. The release plan's `packages.npm` or `packages.composer` is `null` for an unselected target.
- Does not rerun a fixture file; run `validate --fixtures` first.
- Does not establish that a version was published.

Before publishing:

- Keep private provenance records, API definitions and signing secrets out of distribution repositories.
- Review `custom/` contents; npm's explicit file allowlist includes that directory.
- No local test suite certifies a real provider's backend.

## Publish to npm

Supply registry authentication through your own npm configuration, then run:

```sh
sdk-generator publish PATH_TO_RELEASE --confirm-version 1.0.0
```

`publish` is the only command that uploads to npm. It:

- Verifies the exact reviewed version and every artifact checksum, including documentation.
- Ignores command strings in the plan and disables package scripts.
- Publishes the prepared npm archive to the configured HTTPS registry.
- Records a local publication receipt on success.

A failure may leave the registry outcome uncertain; check registry state before retrying.

Configure the destination with `npm.registry` and `npm.access` (`public` or `restricted`); see [publication metadata](configuration.md#publication-metadata). Keep credentials in npm's authentication configuration, never in the SDK configuration or generated metadata.

## Publish the Composer repository and documentation

Set `release.baseUrl` to the URL that will serve the distribution site, for example `https://sdk.example.com/`. HTTPS is required except for loopback integration tests. Without it, Composer archive URLs are relative to the host root; set a base URL for subdirectory hosting.

`release` prepares:

- `site/packages.json`, a standard [Composer repository](https://getcomposer.org/doc/05-repositories.md#composer) with ZIP distributions.
- Immutable `site/versions/VERSION/` archives.
- Browsable reference and guide pages, examples, changelog and migrations.
- A checksum for every file.

Deploy it to a dedicated provider-owned web root or hosting checkout:

```sh
sdk-generator publish-site release/1.2.0 /path/to/sdk-web-root --confirm-version 1.2.0
```

`publish-site`:

- Stages a complete tree and preserves previous versions and Composer package entries.
- Rejects unrelated directories, edited published versions, symlinks and tampered artifacts.
- Is safe to repeat for the same reviewed publication.

HTTP serving and authentication belong to the provider's hosting; the generator needs no cloud account. A hosting checkout still needs its normal deployment step.

Consumers add the repository and install the package normally:

```json
{ "repositories": [{ "type": "composer", "url": "https://sdk.example.com/" }] }
```

The test suite installs from a generated repository served locally over HTTP. Alternatively, distribute PHP through your existing VCS or Packagist process.

## Partial publication

Publish npm and the site as separate reviewed steps; npm and the site cannot be committed atomically. `publication.json` and `site-publication.json` record each outcome. If one succeeds and the other fails:

1. Keep the successful immutable version.
2. Check the failed destination's state.
3. Retry only the failed step.

Never rebuild different contents under an already published version.

## Version policy

Set `release.policy` in the SDK configuration:

| Policy             | Behavior                                                                                                                                                                                                                                                                            |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `review` (default) | Reports compatibility findings in the preview, release plan and migration notes. Does not enforce a version increase.                                                                                                                                                               |
| `semver`           | With a recorded prior version, requires a newer version. Breaking findings require a new major version (a new minor before 1.0). Additive findings require a new minor unless the major increases. A prior prerelease requires a newer version but can evolve before stabilization. |

Findings marked `review` still require provider judgment under either policy.

The release plan's `reviewRequired` is `true` when findings include a breaking or `review` finding. Its `approved` field records caller acknowledgment:

- CLI preparation records `approved: false` unless you pass `--acknowledge-review` after reviewing the findings.
- Library callers pass `true` as the third argument: `prepareRelease(output, destination, acknowledgeReview)`.
- Acknowledgment is metadata only. It does not bypass validation or version policy, remove findings, or publish anything.

The generator compares against the previous interface in the private generation record. Preserve that record across upgrades; a fresh output directory has no earlier version to compare. A package-version bump does not change the API contract or the pinned request version header.

Version stable SDKs as follows:

| Change                                                                                                                                                             | Version |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| Removed or renamed public interfaces without aliases, changed HTTP semantics, tighter requiredness or nullability, changed exact representations, dropped runtimes | Major   |
| Additive compatible operations                                                                                                                                     | Minor   |
| Corrections that preserve behavior                                                                                                                                 | Patch   |

Unknown future response fields and enums are tolerated but never reinterpreted as success. Keep aliases until the provider's documented deprecation window has elapsed; the generator makes no promise about that window.

## Compatibility checks

Structural comparison covers added and removed fields, requiredness, nullability, enums, tagged variants, exact representations, parameter encoding and response statuses. No schema comparison proves server business semantics; ambiguous changes produce review findings.

### Direction

- Inputs and outputs break in opposite directions: a newly required input and a newly optional output both break callers.
- Exported models are checked in both directions, including their input factories when the model appears only in responses. Adding a required response field can therefore require a major version.
- Dictionary value policies follow the same direction as ordinary fields when both versions permit objects under their types and input enums. Replacing omitted or `true` `additionalProperties` with a restrictive schema can break object inputs. Dictionary rules cannot tighten string-only or null-only inputs. Equivalent unconstrained declarations are not breaking; exact numeric representation changes for dictionary values are still checked.

### Names and aliases

- A method alias preserves a name only while the HTTP operation is the same. Changing the endpoint behind a name is a behavioral compatibility change.
- Renaming a resource or method can change operation input and response type names and pagination and polling helper names. An alias does not preserve these. Such renames are breaking even with an alias, and `semver` blocks a patch or minor release of a stable SDK. Consumers update imports, PHP input classes and helper calls.
- Authentication option types are part of the public contract. Moving from unrestricted options to named modes, or narrowing an operation's accepted modes, is breaking. Consumers update shared wrappers to the mode-specific type, such as `RequestOptions<'merchant'>`.
- Payload return settings, payload paths, request styles and positional path order are recorded; changing them is breaking.

### Added success responses

Adding a success status is breaking when it introduces:

- An empty result where every previous result had a body, or a body where all were empty.
- A provably incompatible simple result shape.

A matching existing shape produces a review finding for its HTTP semantics, unless it introduces incompatible PHP classes (below). Rules:

- Declared 302/307 redirects, 304 and `default` responses count as result possibilities.
- PDF bytes, SSE streams and redirect location objects count as returned values without a JSON schema. PDF results are byte arrays in Node and strings in PHP, so their compatibility depends on the selected targets.
- Shapes compare as decoded SDK values. Textual formats and exact numbers are strings in both SDKs, so adding a UUID-formatted string or an exact numeric response beside a string response does not widen the type; it produces a review finding. This applies to nested fields, array items and dictionary values. Representation changes to an existing response or input keep their wire compatibility checks.
- Comparison follows public response fields. `readOnly` does not change the output type; `writeOnly` fields and their requiredness are excluded.
- Object responses tolerate unknown fields even with `additionalProperties: false`. Adding such a result beside a typed dictionary can widen its values to `unknown` and is breaking.
- Removing a guaranteed response field or widening a field's public type is breaking.
- Pure dictionaries (schema-valued `additionalProperties` with no declared properties) emit `Record<string, T>`:
  - Runtime validation enforces their `required` keys, but the type does not declare them. The comparison checks both, including nested dictionaries.
  - Adding a dictionary result that drops a previously required key is breaking, even when the TypeScript type is unchanged.
  - Adding a dictionary result beside an object with an explicitly required property is breaking, even if the dictionary requires the same key. Declare the property in `properties` to keep its field guarantee.
- Inclusion between distinct result unions, composed schemas, recursive schemas and schemas with typeless fields at any depth can require manual review.

### PHP class names

- PHP object and tagged response classes include the response status: `Response201` does not satisfy a consumer expecting `Response200`. Adding a success or default response with a matching JSON schema is breaking when PHP is a selected target, unless the previous return type already includes `mixed` or `object`. Node-only matching shapes produce a review finding. Existing PHP class names are preserved.
- PHP tagged response classes include their `oneOf` branch positions. Reordering or inserting branches can reassign a class to another tag and is breaking when PHP is a selected target. Append new alternatives to keep positions, or make a major upgrade and update class-based dispatch. Node-only reordering does not produce this finding.

### Saved baselines

- Error subclasses and unrecognized-webhook reasons are recorded as additive runtime APIs; Node and PHP standalone verification are additive when declared. Existing `SdkError` catches and `kind` checks keep working. Node error names and inspection now show the subclass name.
- Node webhook event types are public identities. Removing or renaming a recorded `WebhookEvent<EventName>` export is breaking. Additions follow the existing event-configuration compatibility check.
- The first regeneration with named Node webhook types produces the existing `webhook` declaration and `compiled codecs` review findings. The equivalent named return shape preserves consumers; the declaration upgrade alone produces no breaking finding. Older records without the event-name map remain readable.

- The private generation record saves compiled contracts and runtime identities with source provenance and the original comparison baseline. Regeneration preserves that baseline even when a generator-only change affects compatibility without changing generated files.
- Older records remain usable and keep explicit historical review findings; recompiling their schemas does not establish what an older runtime guaranteed. Older snapshots without non-JSON result guarantees remain readable; comparisons that depend on those guarantees require review and are not reinterpreted as empty results.
- Malformed or unrecognized records fail with diagnostics.
- Runtime implementation changes produce review findings even when compiled value guarantees are equal.

## Known compatibility limitations

- Added-result checks compare public types and runtime guarantees separately. Mixed objects keep schema-valued additional-field guarantees even when TypeScript exposes those values as `unknown`. Losing a nested required key, incompatible dictionary declarations, body absence/null changes and new PHP classes outside the previous return type are breaking. Proven breaking findings survive uncertainty elsewhere.
- Returned-value inclusion covers single explicit scalar, object and array types, pure and mixed dictionaries, and nested forms. Recursive references, compositions, typeless schemas, nullable type unions and arbitrary prior-result unions produce review findings where inclusion cannot be proved. Generation and execution support for them is unaffected.
- Changes inside `allOf`, `anyOf` and `not` produce a generic `review` finding; nested constraint changes are not classified recursively. Other comparisons may still find a breaking change, but a `review` finding alone does not block a patch release under `semver` or require acknowledgment.

For example, with `validation: "schema"`, adding `minLength: 3` to a string input inside an otherwise unchanged `allOf` branch can reject a previously valid one-character value but produces only a `review` finding. Review nested constraints and choose the version increase manually. Successful release preparation does not establish that these changes are compatible.

## Upgrade an existing SDK

CLI automation must read failed `diagnose --json` reports from stdout. Other JSON failures remain on stderr and now include stable codes, diagnostic source files and relative file paths. Diagnostic locations point to existing nodes; missing settings are named in the message. JSON previews omit diffs by default: pass `preview --json --diff` and read its modified-file `diffs` array. The library's dry-run diff API is unchanged.

The method name `delete` is now allowed in both targets. For an existing SDK whose `deleteWidget` operation was inferred as `api.deleteWidget`, pin `resource: "api"` and `method: "deleteWidget"` to preserve that public call, or review the move to `widgets.delete` as a breaking change. Other fallback names are unchanged and now produce warnings. Shared [capability defaults](configuration.md#capability-defaults) are optional; compare generated output before replacing explicit blocks. Replace `@example/` and `example/` package vendors before publishing.

Regenerate older SDKs to remove schema examples/defaults from sensitive, write-only and password locations, including shared reference targets and compositions. Removing previously published annotation values requires review; publication provenance alone does not change compatibility. Rendering, generation and release preparation require reloading the source inputs for records that predate publication protection, including PHP-only SDKs. Private records preserve source examples and must remain private.

Regenerate packages as a complete unit, review the preview and compatibility findings, and follow the version policy. Do not publish breaking findings as a compatible patch. The [changelog](../CHANGELOG.md) lists every generator change that affects regenerated SDKs.

Configuration validation rejects `npm.name` values longer than 214 characters, including the scope and separator. Shorten an oversized package name before regenerating.

### Migrating PHP entity representations

PHP response models expose declared nested objects as generated entities, lists of typed entities, and PHP arrays for dictionaries. Node wire behavior is unaffected.

| Before                                        | After                                                     |
| --------------------------------------------- | --------------------------------------------------------- |
| `$result->data->getData()->id`                | `$result->data->getData()->getId()`                       |
| `$payment->getMetadata()->label`              | `$payment->getMetadata()['label']`                        |
| `getRequest_id()`, `hasRequest_id()`          | `getRequestId()`, `hasRequestId()`                        |
| `WebhookEvent0` (numbered by insertion order) | `WebhookEventPaymentIntentSucceeded` (from the event key) |

- Declared magic properties remain available with PHPDoc types.
- There are no deprecated naming aliases. Update imports and class-based dispatch from the regenerated package's class inventory.
- `toArray()` and `jsonSerialize()` return raw normalized values, not hydrated entities. `toInputArray()` and `toInputValue()` also preserve exact numeric kinds for reuse in requests. JSON dictionaries stay objects in raw exports, including empty ones. Explicit null and omitted fields stay distinct.
- Changed representations, field classes, and removed methods and classes are reported as compatibility findings. Use them to find fields that need [`phpFieldClasses`](configuration.md#php-response-entity-names) pins.

### Runtime safety

Regenerate each package as a unit and update these consumers:

- Pagination now ends at 1,000 pages by default. Pass an explicit larger `maxPages` when needed. Catch protocol errors for continuation cycles and two consecutive empty pages with continuations; fix the provider continuation rather than restarting a loop.
- Add `timeout` / `TimeoutError` to error handling for per-attempt timeouts. `deadline` remains non-retryable in both targets. Refused connections and DNS failures now report `not_sent`. PHP transport status and metadata status are `null` without an HTTP response; replace comparisons to `0`.
- Error JSON serialization and native crash rendering omit raw bodies, headers, URLs and unsanitized causes. Explicit recovery access remains available; use `raw`, `meta`, Node `cause` or PHP `getPrevious()` deliberately and protect their contents when logging.
- `Retry-After` now accepts nonnegative decimal seconds with optional surrounding spaces/tabs or canonical GMT HTTP dates in both targets. Exponents, signed numbers, relative dates and malformed dates are ignored. Send a canonical header from providers and test transports.
- Replace unknown JavaScript client options such as `maxRetries` with `maxAttempts` (total attempts). Remove operation path prefixes duplicated in `baseUrl`. PHP model properties are read-only; construct a new model with updated values instead of assigning dynamic properties. PHP headers require string names and values and now fail with `ValidationError`.
- Default Node SSE connections now use native HTTP/HTTPS. Supply `ClientOptions.transport` for application-specific fetch/Undici customization; injected transports own their socket lifecycle. Consume a Node SSE result within `streamIdleTimeoutMs` or it closes. Unconsumed default SSE sockets and timers do not retain the Node process; an active iterator does. Injected transports remain responsible for their sockets. Malformed known events fail with `sse_invalid_event` and `details.eventId` / `details.position` for recovery.
- Pass webhook `nowSeconds` in seconds. Millisecond-scale values now fail input validation with a conversion hint. Node also accepts original `ArrayBuffer` bytes alongside Buffer and Uint8Array.

### Retry defaults

Retry semantics are now `budgets-2`. Saved `budgets-1` compiled records remain readable for comparison, but new runtimes require newly generated descriptors. Comparisons flag retry semantics and configured body-signal changes for review; old snapshots retain their recorded policy. Regenerate each package as a complete unit.

- Required idempotency headers with `auto` disabled now require TypeScript options containing `idempotencyKey`. This is a breaking signature change; choose a major SDK version under the semver release policy. PHP still fails before sending a missing required key.
- Backoff now uses half-to-full jitter with optional `maxDelayMs`. A deadline-crossing retry wait returns the last error instead of replacing it with a deadline error. `retryAfterMs` exposes a valid server wait.
- Optional `errors.retry` reads provider retry instructions without a client-side code table. Optional `idempotency.autoKeyPrefix` prefixes UUID v4 keys. PHP automatic keys now use the same UUID v4 format as Node.
- Keyed errors, including pre-send errors after resolution, and response metadata expose `idempotencyKey`.

GET/HEAD/OPTIONS retry by default (see [errors and retries](using-sdks.md#errors-and-retries)), and mutations with a missing optional idempotency key send once.

- Set client or request `maxAttempts: 1` to keep single-attempt reads. Explicit retry policies replace the defaults.
- Persist and reuse idempotency keys across application resubmissions; automatic keys cover one SDK call.
- TypeScript method options reject `idempotencyKey` on unsupported operations. Wrappers that forward a broad `RequestOptions` variable must narrow or omit that property. PHP keeps its shared options constructor with runtime checks.
- Compatibility reports identify the type narrowing and flag changed retry behavior for review in both targets.

### Modular generated packages

Node packages have resource subpaths and split declaration files; PHP emits one file per class with class-based Composer autoloading. Root imports, constructors, factories and method signatures are unchanged.

- Refresh Composer autoload metadata on installation. Do not copy individual generated files between versions.
- Regeneration removes obsolete owned files and preserves handwritten helpers.
- Direct includes of `src/Runtime.php` and `src/Client.php` load a compatibility autoloader.
- The PHP `contract.json` artifact is replaced by descriptor groups. Call `SchemaRegistry::contract()` for the complete plan.
- Descriptors decode on first use, so the first call can cost more. Package validation checks every descriptor group before release.
- Compiled compatibility snapshots keep their recorded semantic representation.

### Client request ID options

Regenerate with `x-flint-request-option: client_request_id` on optional request
headers before publishing a spec that adds these headers. Both targets keep them
out of operation inputs and positional params. Callers use `clientRequestId` in
Node and `client_request_id` in PHP. Response request ID configuration stays
`x-request-id`.

Compared with a shipped contract without the header input, the compiled report
shows an additive per-call option and a `compiled codecs` review for the changed
execution descriptor, with no breaking input change. A hypothetical older package
that already exposed the header as an operation input can report input removal or
positional params changes. That report describes that package accurately; do not
publish the intermediate input shape. Existing compatibility findings are retained.
