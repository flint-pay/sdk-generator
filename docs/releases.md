# Releases and compatibility

- Generator releases and generated SDK versions are independent. Generator 0.1.0 supports the subset in the [support matrix](support-matrix.md). See the [changelog](../CHANGELOG.md) for generator changes.
- Node and PHP packages use the configured package `version`. The API `info.version` and an optional pinned version header are documented separately.
- Preview versions use a SemVer prerelease suffix and npm's `next` tag in the release plan.
- Commands below use the installed `sdk-generator` executable. From a source checkout, run `npm ci` and `npm run build`, then use `node dist/cli.js`. See the [CLI reference](cli.md) for arguments.

## PHP model reads, integer inputs and errors

Regenerate and review PHP consumers before upgrading:

- Optional response getters and `@property-read` declarations are nullable. Reading an omitted optional field returns null; replace catches around optional reads with ordinary null handling, or use `has()` to distinguish omission from an explicit null. Required response fields still fail during decode with a `ProtocolError`, and unknown property names still fail loudly. Input omission behavior is unchanged.
- Repeated reads share immutable hydrated entities and use copy-on-write arrays for entity collections. Do not depend on distinct object identities between reads. Mutable untyped objects and raw/input exports remain isolated copies.
- Integer-field `ExactNumber` inputs require integer spelling: replace `new ExactNumber('50.00')` with `new ExactNumber('50')`, and `new ExactNumber('5e3')` with `new ExactNumber('5000')`. Plain integer strings use the same spelling rule. Decimal fields and integral decimal/exponent response tokens retain exact semantics.
- Error messages append available HTTP status, provider code and request ID. Avoid exact message matching; use the existing per-kind classes, `kind`, `status`, `errorCode` and `outcome`. `getCode()` now returns the HTTP status or 0 without a response. No error classes are renamed. PHP also exposes `SdkError::KIND_*` and `OUTCOME_*` constants.
- Resource properties initialize on first access and remain read-only. Resources use PHPDoc-typed magic properties backed by a private cache instead of public readonly slots; code using reflection, `property_exists()` or `get_object_vars()` should use ordinary property access or `isset()` instead. Assignments raise a local `ValidationError`.
- Positional identifier arguments accept scalar models; entity models now fail with a parameter-specific error instead of a generic codec failure.

## Schema key constraints and type arrays

Regenerated SDKs enforce newly declared `propertyNames` length, pattern, enum and constant constraints on every object key in requests and strict responses. Correct invalid keys instead of relying on response enum openness; value enums remain open. Tightening input key constraints is breaking under the existing release policy. Dictionary keys remain `string` in both targets. Key validation errors include the JSON-escaped offending key in brackets. Sensitive and write-only maps retain example publication protection.

OpenAPI 3.1 type arrays now load as equivalent unions. Loaded `["null"]` schemas accept only null in both targets: Node callers that previously sent non-null values through that declaration must use null or correct their source schema. Dynamic schema-taking helpers still require explicit `anyOf` or `type: "null"`. Repeated unions inside intersections still require consistent numeric SDK representations across intersecting branches; correct incompatible numeric formats in the source or provider override.

## Contributor Node prerequisites

The published generator continues to support Node.js 22+. Source-checkout contributor tests require Node.js 22.16+ for the SQLite examples, and the test runner reports a prerequisite error on earlier versions. Run `nvm use` before testing; `.nvmrc` and CI use the contributor minimum. No Node upgrade is required for existing generator installs. Generated SDK runtime requirements are unchanged. See the [support matrix](support-matrix.md) for consumer requirements.

## Flint provider fixture repin

The regression profiles now use the unmodified public Flint export at `dcd2401490dadf0be5733b2322e37056013dcb11`, retaining `Flint-Version: 2026-09-07`. Regenerating the full profiles changes both Node and PHP APIs: 612 raw operations replace 507 (+152/-47 IDs), and 607 operations are exposed after excluding five CLI/OAuth form flows. These fixture profiles keep synthetic package names and are not published SDK releases. Publishing these changes requires a major Flint SDK release because fields, PHP getters/classes and response contracts change even where method names are preserved.

- Same-route operation-ID renames preserve the existing SDK methods, including `orders.addCharge`, `orders.addLineItems`, `returns.processExisting`, `riskLists.addItems`, `paymentMethods.save` and `webhookEndpoints.rotateWebhookSecret`. The small risk profile also retains `addItems`. The 20 old-to-new IDs and 18 exposed method bindings are recorded in [provenance](../tests/providers/flint/provenance.json); two renamed CLI/OAuth form flows remain hidden. There are no behavior-based method-name exceptions. Removed routes have no automatic alias. Canonical input/result names still follow #84 and the new source: for example, the risk addition response components change from `RiskListItemResultsResponse` / `RiskListItemResultsData` to `AddRiskListItemsResponse` / `AddRiskListItemsResult`, even though `riskLists.addItems` remains unchanged. Update imports and PHP model classes using the generated reference.
- Replace checkout ID/secret header credentials with `checkoutToken` (or the explicit `checkout/CheckoutSessionBearer` mode) in both targets. Partner authorization entry is now anonymous and requires PKCE `code_challenge` and `code_challenge_method`; the form token exchange is hidden along with the four CLI device/OAuth form operations.
- Payment-intent create results now expose the payment fields directly: use `created.status` / `$created->getStatus()` rather than `created.payment_intent.status` / `$created->getPaymentIntent()->getStatus()`. The collection extension remains distinct: `PaymentIntentWithCollection` has an optional `payment_collection`, and creation requires it. Reads use canonical `PaymentIntentWithCollection` with an optional collection. Capture, cancel and update return `PaymentIntent`; confirm uses `PaymentIntentWithAction` with a required nullable `current_payment_action`. `GetPaymentIntentResult` and `CreatePaymentIntentResult` no longer exist in the source.
- Handle optional nullable `risk` and nullable `last_payment_error` using the published schema. Keep `payment_options` as an array; the server emits `[]` for legacy missing options. Risk-list additions take plural `values`; singular `value` is obsolete and the server rejects it as an unknown field.
- Read webhook resources through `event.data.object` in Node or the corresponding PHP entity property. Amount declarations now consistently use int64: expect exact integer strings, including values beyond JavaScript's safe integer range. Avoid converting these strings to floating-point numbers.
- Return decisions replace the obsolete `decision_basis` / `selected_resolution_type` fields with current override reasons and nullable `automatic_resolution_type`. Return policies use `release_timing` in place of `refund_timing`; it is required when allowed resolutions include refund or store credit.
- New source constraints and required fields remain enforced, including dictionary key rules and union declarations supported by the generic loader. Correct callers and synthetic examples to meet them. The fixture example audit keeps one strict expected failure for an upstream missing `supported_actions` annotation; it does not relax runtime decoding.

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

New output starts as an unreleased draft. Generation and preview do not compare drafts, even across package-version changes. The first successful `release` / `prepareRelease` records the generated interface and its saved compiled snapshot as the baseline for future generations. Its CHANGELOG and MIGRATION contain no draft-to-draft compatibility findings. Release preparation establishes this local baseline without publishing; if you discard that first prepared release, reset the output to draft as described below.

Later generations compare against the most recently prepared release, including edits made before a version bump. Successful release preparation advances the baseline only after writing all artifacts. The prepared release retains its findings; the next generation starts comparison against that newly prepared interface. Repeating preparation without regeneration retains the recorded findings.

Preserve the private generation record across upgrades; a fresh output directory has no earlier release to compare. Records from generators without explicit draft tracking retain their historical baseline and uncertainty until explicitly reset or a release is prepared. A package-version bump alone never resets a baseline, changes the API contract or changes the pinned request version header.

Version stable SDKs as follows:

| Change                                                                                                                                                             | Version |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| Removed or renamed public interfaces without aliases, changed HTTP semantics, tighter requiredness or nullability, changed exact representations, dropped runtimes | Major   |
| Additive compatible operations and optional response-model fields                                                                                                  | Minor   |
| Corrections that preserve behavior                                                                                                                                 | Patch   |

Unknown future response fields and enums are tolerated but never reinterpreted as success. Keep aliases until the provider's documented deprecation window has elapsed; the generator makes no promise about that window.

## Compatibility checks

Structural comparison covers added and removed fields, requiredness, nullability, enums, tagged variants, exact representations, parameter encoding and response statuses. No schema comparison proves server business semantics; ambiguous changes produce review findings.

### Direction

- Inputs and outputs break in opposite directions: a newly required input and a newly optional output both break callers.
- Exported models are checked in both directions, including their input factories when the model appears only in responses. Adding an optional response-model field is additive, including when `additionalProperties` is omitted or `true`. Model factories adopt its declared type when that field is supplied. Adding a required response field can require a major version because factories now require it. Models reachable through operation inputs, including nested named definitions, use the full input rules: adding an optional typed field can narrow previously accepted additional values and require a major version. Grouping repeated findings preserves their highest severity.
- Requiredness is independent of property declarations. Removing a required response key is breaking even when its old schema had no `properties` entry for that key and its new schema declares an optional typed field.
- The optional-field exemption requires positive response-only provenance in both the saved and new compiled contracts. Source reference uses are recorded before composition inlining, and request uses veto the exemption across shared aliases, nested properties, compositions, arrays, dictionaries and incoming webhook schemas. Missing or stale provenance uses full input rules. Older compiled records remain readable; unknown use is never treated as proof of response-only use.
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

Use the library API to reset an unpublished output or adopt an SDK released through another workflow:

```js
import { setCompatibilityBaseline } from '@public-sdk/generator';

// Discard draft history, including false findings in older unreleased records.
setCompatibilityBaseline('./generated', 'draft');

// Adopt the currently generated SDK as the already released comparison baseline.
setCompatibilityBaseline('./generated', 'released');
```

Both modes validate the existing output, preserve ownership hashes, source provenance and saved compiled decisions, and clear recorded findings and the superseded comparison base. They update only the private record under the generation lock. Regenerate from source first if the output is stale. Reset only an unpublished draft; using either mode to discard a shipped contract's history removes its compatibility protection. Never delete the private record to reset: that also loses file ownership.

For CI, `preview API_JSON SDK_JSON OUTPUT --fail-on breaking` prints the ordinary report and exits 1 for breaking findings. `review` fails for review or breaking findings; `additive` fails for any finding; `none` (the default) reports without failing. Both human and `--json` output use the same threshold, and preview writes no files. Version-policy enforcement during `release` is independent of this flag.

Repeated shared-schema changes are reported at the exported model instead of every response use site. Input and response guarantees remain distinct. Generic declaration reviews for the same changed model are grouped; independent compiled guarantees, PHP identities and historical uncertainty still participate.

- Error subclasses and unrecognized-webhook reasons are recorded as additive runtime APIs; Node and PHP standalone verification are additive when declared. Existing `SdkError` catches and `kind` checks keep working. Node error names and inspection now show the subclass name.
- Node webhook event types are public identities. Removing or renaming a recorded `WebhookEvent<EventName>` export is breaking. Additions follow the existing event-configuration compatibility check.
- The first regeneration with named Node webhook types produces the existing `webhook` declaration and `compiled codecs` review findings. The equivalent named return shape preserves consumers; the declaration upgrade alone produces no breaking finding. Older records without the event-name map remain readable.

- The private generation record saves compiled contracts and runtime identities with source provenance and the release comparison baseline. Regeneration preserves that baseline even when a generator-only change affects compatibility without changing generated files.
- Older records remain usable and keep explicit historical review findings; recompiling their schemas does not establish what an older runtime guaranteed. Older snapshots without non-JSON result guarantees remain readable; comparisons that depend on those guarantees require review and are not reinterpreted as empty results.
- Malformed or unrecognized records fail with diagnostics.
- Runtime implementation changes produce review findings even when compiled value guarantees are equal.
- Codec changes without a semantic policy change require review, including when the old snapshot lacks response-only provenance. This comparison uses models, definitions and operations; adding derived provenance alone neither suppresses codec review nor creates a compatibility finding.

## Known compatibility limitations

- Added-result checks compare public types and runtime guarantees separately. Mixed objects keep schema-valued additional-field guarantees even when TypeScript exposes those values as `unknown`. Losing a nested required key, incompatible dictionary declarations, body absence/null changes and new PHP classes outside the previous return type are breaking. Proven breaking findings survive uncertainty elsewhere.
- Returned-value inclusion covers single explicit scalar, object and array types, pure and mixed dictionaries, and nested forms. Recursive references, compositions, typeless schemas, nullable type unions and arbitrary prior-result unions produce review findings where inclusion cannot be proved. Generation and execution support for them is unaffected.
- Changes inside `allOf`, `anyOf` and `not` produce a generic `review` finding; nested constraint changes are not classified recursively. Other comparisons may still find a breaking change, but a `review` finding alone does not block a patch release under `semver` or require acknowledgment.

For example, with `validation: "schema"`, adding `minLength: 3` to a string input inside an otherwise unchanged `allOf` branch can reject a previously valid one-character value but produces only a `review` finding. Review nested constraints and choose the version increase manually. Successful release preparation does not establish that these changes are compatible.

## Upgrade an existing SDK

Generated documentation now uses `REFERENCE.md` as an index, with operations in `reference/<resource>.md`. Model references over 100 KB use `MODELS.md` as an index with sections in `models/<name>.md`. Named response fields and shared named request body fields are documented in their canonical model tables. Calling conventions and idempotency policies live in `RUNTIME.md`; configured provider error-code lists move to `ERRORS.md`. Update bookmarks and tooling that read the previous single files, or start at `llms.txt`. Generated example scripts require `API_BASE_URL`; set it to your sandbox or local mock and supply the listed credential environment variables.

CLI automation must read failed `diagnose --json` reports from stdout. Other JSON failures remain on stderr and now include stable codes, diagnostic source files and relative file paths. Diagnostic locations point to existing nodes; missing settings are named in the message. JSON previews omit diffs by default: pass `preview --json --diff` and read its modified-file `diffs` array. The library's dry-run diff API is unchanged.

The method name `delete` is now allowed in both targets. For an existing SDK whose `deleteWidget` operation was inferred as `api.deleteWidget`, pin `resource: "api"` and `method: "deleteWidget"` to preserve that public call, or review the move to `widgets.delete` as a breaking change. Other fallback names are unchanged and now produce warnings. Shared [capability defaults](configuration.md#capability-defaults) are optional; compare generated output before replacing explicit blocks. Replace `@example/` and `example/` package vendors before publishing.

Compatibility tracking now distinguishes drafts from released SDKs. Existing records keep their historical comparisons; reset an output that has never shipped with `setCompatibilityBaseline(output, 'draft')`. For packages published outside this release workflow, adopt the generated published version with `setCompatibilityBaseline(output, 'released')` before editing it. New outputs start as drafts automatically. Release preparation now updates the private record after success; retain it along with your generated output.

Optional response-model additions now permit minor releases. CI that previously relied on these false breaking findings should use `preview --fail-on additive` to fail on every reported change, or `--fail-on review` to include uncertain changes. Compatibility reports group shared schemas, so automation must not rely on finding counts or repeated use-site subjects.

Regenerate older SDKs to remove schema examples/defaults from sensitive, write-only and password locations, including shared reference targets and compositions. Removing previously published annotation values requires review; publication provenance alone does not change compatibility. Rendering, generation and release preparation require reloading the source inputs for records that predate publication protection, including PHP-only SDKs. Private records preserve source examples and must remain private.

Regenerate packages as a complete unit, review the preview and compatibility findings, and follow the version policy. Do not publish breaking findings as a compatible patch. The [changelog](../CHANGELOG.md) lists every generator change that affects regenerated SDKs.

Configuration validation rejects `npm.name` values longer than 214 characters, including the scope and separator. Shorten an oversized package name before regenerating.

### Generated package contents and imports

Regenerate the complete package and import through the package name or its public subpaths. Large Node packages coalesce internal `declarations/NAME.d.ts` files into shared chunks; direct file imports into those internals must migrate to root or resource exports. Node's minimum ESM runtime is now 22.3, allowing built-ins to load on feature use; CommonJS still requires 22.12. Node remains the supported execution runtime.

For webhook-only consumers, use `import { verifyWebhook } from 'package-name/webhooks'`. The subpath also exports `parseExact`, `VerifiedWebhook`, `KnownWebhookEvent` and the event types. Existing root imports and `client.verifyWebhook()` keep working. Resource subpaths load bounded shared codec chunks and their own operation data. Node client inspection now shows a resource count; use explicit resource properties when exploring methods.

Replace references to generated `.ts` operation examples with the corresponding `.mjs` files. These JavaScript examples are checked against the public SDK declarations with TypeScript `checkJs`. Copied webhook inbox examples use public package imports. PHP operation examples locate the application's Composer autoloader from a project or vendor installation.

PHP packages no longer include `src/schema-definitions.json` or `SchemaRegistry::definitions()`. Applications using raw schemas must keep their own schemas and pass them to the existing dynamic schema helpers. `SchemaRegistry::contract()` and `codecs()` still expose the complete compiled plan; compiled codecs are not raw JSON Schemas. Generated PHP classes retain individual files for Composer autoloading and editor indexing.

### TypeScript consumer types

- Future object alternatives now include `Record<string, unknown>` rather than `object`. An `in` check alone no longer certifies a known variant's field type; use the generated known-variant predicate or check the field value. This also applies to nested alternatives and `WithResponse` envelopes. Responses, projected payloads and pagination items are checked recursively against their emitted public types. Incompatible successes fail with a protocol error and retain `raw`. Referenced pagination arrays now expose their actual element type instead of `never`.
- Error details are certified against the complete `SdkErrorDetails` union across statuses, operations and built-in runtime details. A known key from a different member can select that member in TypeScript; incompatible combinations therefore yield `details === undefined`, with `raw` retained. Treat details as optional even for declared error statuses. Known-response predicates return false and webhook verification returns `known: false` when retained fields violate the corresponding public union.

Regeneration changes the Node type surface. PHP representations and wire behavior remain unchanged.

- Use `${bigint}` for int64/uint64 strings; bigint inputs serialize without precision loss. Replace broad `string` variables with validated integer strings or bigint. Decimal schemas retain `string`, since `${number}` accepts invalid exact-decimal spellings. Integer inputs, including `ExactNumber` wrappers, reject decimal/exponent spellings and trailing line breaks in both runtimes. Narrowed Node integer-string responses also require canonical spelling (`^-?(0|[1-9][0-9]*)$`, without trailing whitespace): `+1`, `01` and `-01` cause a protocol error, or undefined API error details, with `raw` retained. JSON number tokens still normalize to canonical exact decimal strings. Runtime format/range validation still applies.
- Request enums stay closed; response enums retain an open string alternative. Correct input typos instead of asserting them into an enum.
- Import the canonical response name shown below. Equal declarations share the shortest name, then alphabetical order. The comparison uses effective response declarations after directional and profile rules; different shapes retain separate types. Payload methods use named types or unions. `WithResponse` uses the envelope type and includes HTTP metadata. Unmatched projected alternatives now raise a protocol error; use `WithResponse` when handling future envelope variants explicitly.
- Request bodies use the referenced component’s `NameInput`; anonymous request bodies stay in the owning operation’s input type. Replace unrelated structural aliases with the operation’s input type, for example `Parameters<typeof client.paymentIntents.cancel>[0]`.
- Remove response-only `NameInput` and `makeName` imports. Use the response type for reading, or the owning operation’s input type when preparing a request. Models reachable through nested request fields retain their input types and factories.
- Narrow `SdkError.details` before reading fields. It combines schema-derived API details with runtime failure details; malformed API details and incompatible redacted details are `undefined`. Projected details are checked independently of a future envelope alternative. Projected unions reject fields belonging to a different member so property guards remain safe; success payloads report a protocol error for these incompatible shapes. Explicit `raw` access retains the original response. `SdkError.code` provides known code completions and accepts future strings.

Representative Flint replacements from the pinned public fixture:

| Previous type                                                                                                                    | Replacement                     |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `CreateOrderPaymentIntentResult`                                                                                                 | `CreatePaymentIntentResult`     |
| `CreateOrderPaymentIntentResponse`                                                                                               | `CreatePaymentIntentResponse`   |
| `StripePaymentIntentClientAction`                                                                                                | `StripeSetupIntentClientAction` |
| `PaymentIntentsGetResponse`                                                                                                      | `GetPaymentIntentResponse`      |
| `PaymentIntentsCancelResponse`, `PaymentIntentsCaptureResponse`, `PaymentIntentsConfirmResponse`, `PaymentIntentsUpdateResponse` | `PaymentIntentResponse`         |

`PaymentIntent`, `GetPaymentIntentResult` and `CreatePaymentIntentResult` remain distinct. The pinned `PaymentIntent` requires `risk` and `last_payment_error`; the get result makes them optional and the profile additionally makes them nullable. `CreatePaymentIntentResult` instead contains `payment_intent` and `payment_collection`. Their envelopes (`PaymentIntentResponse`, `GetPaymentIntentResponse`, `CreatePaymentIntentResponse`) therefore also remain distinct. `paymentIntents.get()` returns `GetPaymentIntentResult`. No fixture/profile correction is included; the later provider repin/profile correction must resolve the upstream drift (FLI-577).

The full pinned fixture removes 420 equivalent component aliases and 493 redundant operation response aliases. Input names are tracked independently and may remain where request-reachable. The lists below map removed response names to retained names; they do not rename provider schema components or change runtime codecs.

<details>
<summary>Component response alias replacements</summary>

- `PostalAddress` → `Address`
- `InvoiceCheckoutSessionRequest` → `AssessInvoiceLateFeeRequest`
- `CancelOrderPaymentAttemptRequest` → `CancelPaymentIntentRequest`
- `DeletePayoutDestinationRequest` → `CancelPayoutRequest`
- `CancelReturnResolutionRequest` → `CancelReturnRequest`
- `PendingPaymentActionSetupPaymentSourceSubject` → `ChangeSubscriptionPaymentMethodRequest`
- `CheckoutCustomTextWriteConfig` → `CheckoutCustomTextConfig`
- `CheckoutSavedPaymentDetailsSettings` → `CheckoutTaxConfig`
- `CloseCheckoutSessionRequest`, `ResendWebhookDeliveryRequest`, `ResolveOrderInventoryExceptionRequest` → `CloseOrderRequest`
- `CreateInlineModifierGroupRequest` → `CreateModifierGroupRequest`
- `ApplyDiscountRequest` → `CreateOrderDiscount`
- `CreateOrderPaymentIntentResponse` → `CreatePaymentIntentResponse`
- `CreateOrderPaymentIntentResult` → `CreatePaymentIntentResult`
- `DeliveryBuyerLocationResource` → `DeliveryBuyerLocationRequest`
- `DeliveryCalculatedPricingStrategyRequest` → `DeliveryCalculatedPricingStrategy`
- `DeliveryDistanceUnitPriceRequest` → `DeliveryDistanceUnitPrice`
- `DeliveryFixedPricingStrategyRequest` → `DeliveryFixedPricingStrategy`
- `DeliveryPricingTierBandRequest` → `DeliveryPricingTierBand`
- `DeliveryPickupAvailabilityQuantityResource` → `DeliveryQuoteLineItemResource`
- `DeliverySelectionRecipientRequest` → `DeliveryRecipientResource`
- `DeliveryLocalDeliveryDetails` → `DeliveryShipmentDetails`
- `DeliveryCountryCondition` → `DeliveryStateCondition`
- `DeliveryTieredPricingStrategyRequest` → `DeliveryTieredPricingStrategy`
- `DeliveryWeightUnitPriceRequest` → `DeliveryWeightUnitPrice`
- `DeliveryWindowResource` → `DeliveryWindowRequest`
- `LineItemFulfillmentSizeRequest` → `Dimensions`
- `CancelReturnDispositionResponse`, `CreateReturnDispositionResponse`, `RetryReturnDispositionResponse` → `GetReturnDispositionResponse`
- `CreateReturnInspectionResponse`, `DecideReturnInspectionLineItemResponse` → `GetReturnInspectionResponse`
- `CreateReturnPolicyResponse`, `DeleteReturnPolicyResponse`, `PublishReturnPolicyRevisionResponse`, `UpdateReturnPolicyResponse` → `GetReturnPolicyResponse`
- `CreateReturnReasonResponse`, `DeleteReturnReasonResponse`, `UpdateReturnReasonResponse` → `GetReturnReasonResponse`
- `CreateReturnReceiptResponse`, `VerifyReturnReceiptLineItemResponse` → `GetReturnReceiptResponse`
- `CancelReturnResolutionResponse`, `ConfirmReturnResolutionResponse`, `CreateReturnResolutionResponse`, `ReleaseReturnResolutionResponse`, `RetryReturnResolutionResponse`, `UpdateReturnResolutionResponse` → `GetReturnResolutionResponse`
- `AddReturnLineItemResponse`, `CancelReturnLineItemResponse`, `CancelReturnResponse`, `CompleteReturnResponse`, `CreateReturnResponse`, `DecideReturnResponse`, `DeleteReturnLineItemResponse`, `ReopenReturnResponse`, `UpdateReturnLineItemResponse`, `UpdateReturnResponse`, `WaiveReturnLineInspectionResponse` → `GetReturnResponse`
- `IncomingWebhook498370f9652cPayload`, `IncomingWebhook66f11b3fe6a8Payload`, `IncomingWebhook8d0ecb37ce13Payload`, `IncomingWebhookb887d4b2753cPayload`, `IncomingWebhookbd445ea5b01aPayload`, `IncomingWebhookd5c9a344b9b1Payload`, `IncomingWebhooke3b79e3983d2Payload` → `IncomingWebhook04494e8bd1b3Payload`
- `IncomingWebhook3e1e165872bePayload`, `IncomingWebhook7253fff5f748Payload`, `IncomingWebhookbca943d8a28aPayload`, `IncomingWebhookdb74c29bf1ffPayload`, `IncomingWebhookefe153a00c42Payload` → `IncomingWebhook0480be55a902Payload`
- `IncomingWebhook1eb1077dc5faPayload`, `IncomingWebhook2111a23e6e7cPayload`, `IncomingWebhook22d72673a8cdPayload`, `IncomingWebhook25a1d8aaa819Payload`, `IncomingWebhook2873f18b6724Payload`, `IncomingWebhook28c5dc1777e5Payload`, `IncomingWebhook2b16597f72aaPayload`, `IncomingWebhook2c03ad91f156Payload`, `IncomingWebhook33ee5571b4b4Payload`, `IncomingWebhook3ae537b058b5Payload`, `IncomingWebhook46209f173440Payload`, `IncomingWebhook5552ddfae579Payload`, `IncomingWebhook58b33e47adbePayload`, `IncomingWebhook64406eae7092Payload`, `IncomingWebhook647f08b314c3Payload`, `IncomingWebhook701c073b0a0cPayload`, `IncomingWebhook7216a23a3dddPayload`, `IncomingWebhook7730424c8474Payload`, `IncomingWebhook7adf7ff33e7aPayload`, `IncomingWebhook7cb66beed654Payload`, `IncomingWebhook7dc0310d3669Payload`, `IncomingWebhook8172dd26545fPayload`, `IncomingWebhook96ad40704e72Payload`, `IncomingWebhook9ae0cd21c3dbPayload`, `IncomingWebhook9b7963c3e444Payload`, `IncomingWebhook9f970012f914Payload`, `IncomingWebhookb5e016d3aecaPayload`, `IncomingWebhookbfe731fc8c52Payload`, `IncomingWebhookc823e4336c4aPayload`, `IncomingWebhookc82943441c1dPayload`, `IncomingWebhookc8cb35576c0fPayload`, `IncomingWebhookcfa0fc3e7b61Payload`, `IncomingWebhookd5308faf7210Payload`, `IncomingWebhookd61edf29f9d2Payload`, `IncomingWebhookd7ae2aa49927Payload`, `IncomingWebhookd8d5a73039b9Payload`, `IncomingWebhookdc2332579846Payload`, `IncomingWebhooke24aaa50d5c2Payload`, `IncomingWebhookea0ef7d1c212Payload`, `IncomingWebhookeab48bfd0932Payload`, `IncomingWebhooked8e7a89077ePayload`, `IncomingWebhookf5b72c2a310ePayload`, `IncomingWebhookf9640e80dd75Payload`, `IncomingWebhookfd258d9a47caPayload`, `IncomingWebhookff9afffd27c6Payload` → `IncomingWebhook0caa82ed1aafPayload`
- `IncomingWebhookd7a01fed3e2fPayload` → `IncomingWebhook0d891c599afbPayload`
- `IncomingWebhook3b80f4a3f54aPayload` → `IncomingWebhook0d9fec82cba8Payload`
- `IncomingWebhook88c91570cbe0Payload`, `IncomingWebhookad7368dbf165Payload`, `IncomingWebhookcbaf05798f54Payload` → `IncomingWebhook10de2029f92ePayload`
- `IncomingWebhook2525f823ec7cPayload`, `IncomingWebhook3573c4463034Payload`, `IncomingWebhook38eda7a4e990Payload`, `IncomingWebhook54f21d035575Payload`, `IncomingWebhook72368f2647acPayload`, `IncomingWebhookbb439dd961a8Payload`, `IncomingWebhookfce7e0c4eba0Payload` → `IncomingWebhook1255f92e9f23Payload`
- `IncomingWebhook68e5035f44d1Payload` → `IncomingWebhook14d267be17f3Payload`
- `IncomingWebhook2786e5956695Payload`, `IncomingWebhook566155358f70Payload`, `IncomingWebhook67cf9ddb98ebPayload`, `IncomingWebhook6a2a6e17495ePayload`, `IncomingWebhook8364247aa322Payload`, `IncomingWebhook96bb47deea93Payload`, `IncomingWebhookc71d9380e0c9Payload`, `IncomingWebhookce317e37a514Payload`, `IncomingWebhookdd77f0f69512Payload` → `IncomingWebhook155e0b06aa8fPayload`
- `IncomingWebhook1a6523f8bf80Payload`, `IncomingWebhook2410dfed959ePayload`, `IncomingWebhook26154f9b0abbPayload`, `IncomingWebhook31bad37575e1Payload`, `IncomingWebhook335ccd991b2bPayload`, `IncomingWebhook35b36170e2ebPayload`, `IncomingWebhook3dbc0a577678Payload`, `IncomingWebhook60391de8320bPayload`, `IncomingWebhook6f55e77725f4Payload`, `IncomingWebhook90b44f6ab93dPayload`, `IncomingWebhook9a3120a73ba6Payload`, `IncomingWebhookb1a3cccf875cPayload`, `IncomingWebhookb85f38361fb8Payload`, `IncomingWebhookbec68ec6ef2ePayload`, `IncomingWebhookc6907837bb30Payload`, `IncomingWebhookdb9dd209977aPayload` → `IncomingWebhook1824a72a4c81Payload`
- `IncomingWebhook2100acf09455Payload`, `IncomingWebhook8061fc32f027Payload`, `IncomingWebhook8b9272735b74Payload`, `IncomingWebhookfcf5fa4b1850Payload` → `IncomingWebhook18deb3ad40c4Payload`
- `IncomingWebhook43a17bfb8144Payload`, `IncomingWebhook6d96c0c875cdPayload`, `IncomingWebhook9f2c64cbfcafPayload` → `IncomingWebhook2841a4070c41Payload`
- `IncomingWebhook3b618fd743f5Payload`, `IncomingWebhooka9876afe4b94Payload` → `IncomingWebhook28eb66b9f1a5Payload`
- `IncomingWebhooka9d01c88ec13Payload`, `IncomingWebhookc8e851ec1b62Payload` → `IncomingWebhook290918a8af6ePayload`
- `IncomingWebhookac68e02edc21Payload` → `IncomingWebhook30ac14eea065Payload`
- `IncomingWebhook88596065c1b9Payload`, `IncomingWebhookb9b1da5ab933Payload`, `IncomingWebhookc3ebf1cf7ec9Payload`, `IncomingWebhookd429a10e7388Payload`, `IncomingWebhookd5a6f520dad7Payload` → `IncomingWebhook358012160ab8Payload`
- `IncomingWebhook527f9bd2c39dPayload`, `IncomingWebhook7d17f7f10156Payload`, `IncomingWebhook7dd2b7d6ef54Payload` → `IncomingWebhook44e6923a1369Payload`
- `IncomingWebhook78590778ef68Payload` → `IncomingWebhook607f05b24d65Payload`
- `IncomingWebhook769913a11504Payload` → `IncomingWebhook72eec85cad89Payload`
- `IncomingWebhookcf769e4fa54cPayload` → `IncomingWebhook89b737dd7119Payload`
- `IncomingWebhook90c487338917Payload` → `IncomingWebhook8c8f435e6e23Payload`
- `IncomingWebhooke807fdb62367Payload` → `IncomingWebhooka532d2deefcaPayload`
- `IncomingWebhooke22691fcc424Payload` → `IncomingWebhookd2d184df8ba4Payload`
- `IncomingWebhookf6f719ba2af4Payload` → `IncomingWebhookf2be10231857Payload`
- `InventoryTransferProvenanceRequest` → `InventoryReservationProvenance`
- `OrderInventoryRoutingSourceRequest` → `InventoryRoutingSource`
- `CheckoutLegalConfig` → `LegalSettings`
- `DeliveryAddressRequest`, `DeliveryAddressResource` → `LocationAddress`
- `SignedMoney` → `MoneyValue`
- `OrderDraftLineItemTaxRequest` → `OrderCalculatedLineItemTax`
- `FulfillmentTransitionRequestMarkPacked` → `PackageTransitionRequestMarkPacked`
- `CancelOrderPaymentAttemptResponse` → `PayOrderResponse`
- `CancelOrderPaymentAttemptResult` → `PayOrderResult`
- `CreditNoteRefundListResponse` → `RefundListResponse`
- `CheckoutSessionLaunchResponse`, `GetOrCreateReturnResolutionCheckoutSessionResponse` → `ResolvePaymentLinkResponse`
- `ConfirmReturnResolutionRequest`, `InventoryCountTransitionRequest` → `ResourceVersionRequest`
- `ReturnHandoffRequirementLineItem`, `ReturnShipmentLineItemAllocation` → `ReturnResolutionLineItemRequest`
- `StripePaymentIntentClientAction` → `StripeSetupIntentClientAction`
- `OrderDraftLineItemTaxCalculationRequest` → `TaxCalculationRequest`
- `OrderDraftTaxComponentRequest` → `TaxComponentRequest`
- `TaxIdentityRequest` → `TaxIdentityPatch`
- `OrderDraftTaxJurisdictionRequest` → `TaxJurisdiction`
- `AvailableTextModifierConfig` → `TextModifierConfig`
- `PublicResolvedTextModifier` → `TextModifierConfigRequest`
- `ResolvePaymentLinkTextModifierRequest` → `TextModifierRequest`
- `UpdateReturnPolicyRequest` → `UpdateLocationRequest`
- `OrderDeliveryDestinationRecipient` → `UpdateMeRequest`
- `UpdatePayoutDestinationRequest` → `UpdateRefundRequest`
- `VoidShipmentRequest` → `VoidPackageRequest`
- `Webhook_balance_transaction_updated_merchant` → `Webhook_balance_transaction_created_merchant`
- `Webhook_credit_note_allocation_reversed_installed_merchants` → `Webhook_credit_note_allocation_created_installed_merchants`
- `Webhook_credit_note_allocation_reversed_merchant` → `Webhook_credit_note_allocation_created_merchant`
- `Webhook_credit_note_created_installed_merchants`, `Webhook_credit_note_updated_installed_merchants`, `Webhook_credit_note_voided_installed_merchants` → `Webhook_credit_note_issued_installed_merchants`
- `Webhook_credit_note_created_merchant`, `Webhook_credit_note_updated_merchant`, `Webhook_credit_note_voided_merchant` → `Webhook_credit_note_issued_merchant`
- `Webhook_customer_updated_installed_merchants` → `Webhook_customer_created_installed_merchants`
- `Webhook_customer_updated_merchant` → `Webhook_customer_created_merchant`
- `Webhook_dispute_closed_merchant`, `Webhook_dispute_created_merchant`, `Webhook_dispute_lost_merchant`, `Webhook_dispute_needs_response_merchant`, `Webhook_dispute_prevented_merchant`, `Webhook_dispute_updated_merchant`, `Webhook_dispute_warning_closed_merchant` → `Webhook_dispute_won_merchant`
- `Webhook_fraud_warning_updated_installed_merchants` → `Webhook_fraud_warning_created_installed_merchants`
- `Webhook_fraud_warning_updated_merchant` → `Webhook_fraud_warning_created_merchant`
- `Webhook_invoice_updated_installed_merchants` → `Webhook_invoice_created_installed_merchants`
- `Webhook_invoice_updated_merchant` → `Webhook_invoice_created_merchant`
- `Webhook_invoice_late_fee_assessed_installed_merchants` → `Webhook_invoice_late_fee_waived_installed_merchants`
- `Webhook_invoice_late_fee_assessed_merchant` → `Webhook_invoice_late_fee_waived_merchant`
- `Webhook_invoice_delivery_failed_installed_merchants`, `Webhook_invoice_delivery_succeeded_installed_merchants`, `Webhook_invoice_manual_payment_recorded_installed_merchants`, `Webhook_invoice_manual_payment_reversed_installed_merchants`, `Webhook_invoice_partially_paid_installed_merchants`, `Webhook_invoice_partially_refunded_installed_merchants`, `Webhook_invoice_refunded_installed_merchants`, `Webhook_invoice_sent_installed_merchants`, `Webhook_invoice_voided_installed_merchants` → `Webhook_invoice_paid_installed_merchants`
- `Webhook_invoice_delivery_failed_merchant`, `Webhook_invoice_delivery_succeeded_merchant`, `Webhook_invoice_manual_payment_recorded_merchant`, `Webhook_invoice_manual_payment_reversed_merchant`, `Webhook_invoice_partially_paid_merchant`, `Webhook_invoice_partially_refunded_merchant`, `Webhook_invoice_refunded_merchant`, `Webhook_invoice_sent_merchant`, `Webhook_invoice_voided_merchant` → `Webhook_invoice_paid_merchant`
- `Webhook_merchant_subscription_invoice_updated_merchant` → `Webhook_merchant_subscription_invoice_issued_merchant`
- `Webhook_order_updated_installed_merchants` → `Webhook_order_closed_installed_merchants`
- `Webhook_order_updated_merchant` → `Webhook_order_closed_merchant`
- `Webhook_order_fulfillment_completed_installed_merchants`, `Webhook_order_fulfillment_updated_installed_merchants` → `Webhook_order_fulfillment_created_installed_merchants`
- `Webhook_order_fulfillment_completed_merchant`, `Webhook_order_fulfillment_updated_merchant` → `Webhook_order_fulfillment_created_merchant`
- `Webhook_order_payment_authorization_canceled_installed_merchants`, `Webhook_order_payment_authorization_expired_installed_merchants`, `Webhook_order_payment_authorized_installed_merchants`, `Webhook_order_payment_captured_installed_merchants` → `Webhook_order_refunded_installed_merchants`
- `Webhook_order_inventory_action_required_merchant`, `Webhook_order_payment_authorization_canceled_merchant`, `Webhook_order_payment_authorization_expired_merchant`, `Webhook_order_payment_authorized_merchant`, `Webhook_order_payment_captured_merchant` → `Webhook_order_refunded_merchant`
- `Webhook_partner_app_install_permissions_updated_partner_app`, `Webhook_partner_app_install_revoked_partner_app`, `Webhook_partner_app_install_updated_partner_app` → `Webhook_partner_app_install_created_partner_app`
- `Webhook_partner_app_install_environment_grant_revoked_partner_app` → `Webhook_partner_app_install_environment_grant_created_partner_app`
- `Webhook_payment_intent_payment_failed_installed_merchants`, `Webhook_payment_intent_processing_installed_merchants`, `Webhook_payment_intent_requires_action_installed_merchants`, `Webhook_payment_intent_requires_capture_installed_merchants`, `Webhook_payment_intent_succeeded_installed_merchants` → `Webhook_payment_intent_canceled_installed_merchants`
- `Webhook_payment_intent_payment_failed_merchant`, `Webhook_payment_intent_processing_merchant`, `Webhook_payment_intent_requires_action_merchant`, `Webhook_payment_intent_requires_capture_merchant`, `Webhook_payment_intent_succeeded_merchant` → `Webhook_payment_intent_canceled_merchant`
- `Webhook_payout_destination_deleted_merchant`, `Webhook_payout_destination_disabled_merchant`, `Webhook_payout_destination_updated_merchant` → `Webhook_payout_destination_created_merchant`
- `Webhook_payout_canceled_merchant`, `Webhook_payout_created_merchant`, `Webhook_payout_failed_merchant`, `Webhook_payout_reversed_merchant`, `Webhook_payout_updated_merchant` → `Webhook_payout_paid_merchant`
- `Webhook_refund_created_installed_merchants`, `Webhook_refund_updated_installed_merchants` → `Webhook_refund_failed_installed_merchants`
- `Webhook_refund_created_merchant`, `Webhook_refund_updated_merchant` → `Webhook_refund_failed_merchant`
- `Webhook_report_succeeded_installed_merchants` → `Webhook_report_failed_installed_merchants`
- `Webhook_report_succeeded_merchant` → `Webhook_report_failed_merchant`
- `Webhook_delivery_location_set_activated_installed_merchants`, `Webhook_delivery_location_set_archived_installed_merchants`, `Webhook_delivery_location_set_created_installed_merchants`, `Webhook_delivery_location_set_deactivated_installed_merchants`, `Webhook_delivery_location_set_updated_installed_merchants`, `Webhook_delivery_method_activated_installed_merchants`, `Webhook_delivery_method_archived_installed_merchants`, `Webhook_delivery_method_created_installed_merchants`, `Webhook_delivery_method_deactivated_installed_merchants`, `Webhook_delivery_method_updated_installed_merchants`, `Webhook_delivery_profile_activated_installed_merchants`, `Webhook_delivery_profile_archived_installed_merchants`, `Webhook_delivery_profile_created_installed_merchants`, `Webhook_delivery_profile_deactivated_installed_merchants`, `Webhook_delivery_profile_updated_installed_merchants`, `Webhook_delivery_rate_archived_installed_merchants`, `Webhook_delivery_rate_callback_activated_installed_merchants`, `Webhook_delivery_rate_callback_archived_installed_merchants`, `Webhook_delivery_rate_callback_created_installed_merchants`, `Webhook_delivery_rate_callback_deactivated_installed_merchants`, `Webhook_delivery_rate_callback_updated_installed_merchants`, `Webhook_delivery_rate_created_installed_merchants`, `Webhook_delivery_rate_updated_installed_merchants`, `Webhook_delivery_revocation_created_installed_merchants`, `Webhook_delivery_selection_committed_installed_merchants`, `Webhook_delivery_zone_activated_installed_merchants`, `Webhook_delivery_zone_archived_installed_merchants`, `Webhook_delivery_zone_created_installed_merchants`, `Webhook_delivery_zone_deactivated_installed_merchants`, `Webhook_delivery_zone_updated_installed_merchants`, `Webhook_return_canceled_installed_merchants`, `Webhook_return_completed_installed_merchants`, `Webhook_return_decision_recorded_installed_merchants`, `Webhook_return_disposition_created_installed_merchants`, `Webhook_return_disposition_updated_installed_merchants`, `Webhook_return_inspection_acceptance_decided_installed_merchants`, `Webhook_return_inspection_created_installed_merchants`, `Webhook_return_inspection_superseded_installed_merchants`, `Webhook_return_receipt_created_installed_merchants`, `Webhook_return_receipt_superseded_installed_merchants`, `Webhook_return_receipt_verified_installed_merchants`, `Webhook_return_reopened_installed_merchants`, `Webhook_return_resolution_created_installed_merchants`, `Webhook_return_resolution_updated_installed_merchants`, `Webhook_return_updated_installed_merchants` → `Webhook_return_created_installed_merchants`
- `Webhook_delivery_location_set_activated_merchant`, `Webhook_delivery_location_set_archived_merchant`, `Webhook_delivery_location_set_created_merchant`, `Webhook_delivery_location_set_deactivated_merchant`, `Webhook_delivery_location_set_updated_merchant`, `Webhook_delivery_method_activated_merchant`, `Webhook_delivery_method_archived_merchant`, `Webhook_delivery_method_created_merchant`, `Webhook_delivery_method_deactivated_merchant`, `Webhook_delivery_method_updated_merchant`, `Webhook_delivery_profile_activated_merchant`, `Webhook_delivery_profile_archived_merchant`, `Webhook_delivery_profile_created_merchant`, `Webhook_delivery_profile_deactivated_merchant`, `Webhook_delivery_profile_updated_merchant`, `Webhook_delivery_rate_archived_merchant`, `Webhook_delivery_rate_callback_activated_merchant`, `Webhook_delivery_rate_callback_archived_merchant`, `Webhook_delivery_rate_callback_created_merchant`, `Webhook_delivery_rate_callback_deactivated_merchant`, `Webhook_delivery_rate_callback_updated_merchant`, `Webhook_delivery_rate_created_merchant`, `Webhook_delivery_rate_updated_merchant`, `Webhook_delivery_revocation_created_merchant`, `Webhook_delivery_selection_committed_merchant`, `Webhook_delivery_zone_activated_merchant`, `Webhook_delivery_zone_archived_merchant`, `Webhook_delivery_zone_created_merchant`, `Webhook_delivery_zone_deactivated_merchant`, `Webhook_delivery_zone_updated_merchant`, `Webhook_inventory_action_required_merchant`, `Webhook_inventory_count_applied_merchant`, `Webhook_inventory_level_updated_merchant`, `Webhook_inventory_receipt_created_merchant`, `Webhook_inventory_reservation_at_risk_merchant`, `Webhook_inventory_reservation_closed_merchant`, `Webhook_inventory_reservation_committed_merchant`, `Webhook_inventory_reservation_consumed_merchant`, `Webhook_inventory_reservation_created_merchant`, `Webhook_inventory_reservation_hold_expired_merchant`, `Webhook_inventory_reservation_released_merchant`, `Webhook_inventory_shortage_detected_merchant`, `Webhook_inventory_transfer_closed_merchant`, `Webhook_inventory_transfer_departed_merchant`, `Webhook_inventory_transfer_lost_merchant`, `Webhook_inventory_transfer_received_merchant`, `Webhook_inventory_transfer_returned_merchant`, `Webhook_return_canceled_merchant`, `Webhook_return_completed_merchant`, `Webhook_return_decision_recorded_merchant`, `Webhook_return_disposition_created_merchant`, `Webhook_return_disposition_updated_merchant`, `Webhook_return_inspection_acceptance_decided_merchant`, `Webhook_return_inspection_created_merchant`, `Webhook_return_inspection_superseded_merchant`, `Webhook_return_receipt_created_merchant`, `Webhook_return_receipt_superseded_merchant`, `Webhook_return_receipt_verified_merchant`, `Webhook_return_reopened_merchant`, `Webhook_return_resolution_created_merchant`, `Webhook_return_resolution_updated_merchant`, `Webhook_return_updated_merchant` → `Webhook_return_created_merchant`
- `Webhook_review_opened_installed_merchants` → `Webhook_review_closed_installed_merchants`
- `Webhook_review_opened_merchant` → `Webhook_review_closed_merchant`
- `Webhook_subscription_activated_installed_merchants`, `Webhook_subscription_canceled_installed_merchants`, `Webhook_subscription_created_installed_merchants`, `Webhook_subscription_past_due_installed_merchants`, `Webhook_subscription_payment_succeeded_installed_merchants`, `Webhook_subscription_resumed_installed_merchants`, `Webhook_subscription_trial_ending_installed_merchants` → `Webhook_subscription_paused_installed_merchants`
- `Webhook_subscription_activated_merchant`, `Webhook_subscription_canceled_merchant`, `Webhook_subscription_created_merchant`, `Webhook_subscription_past_due_merchant`, `Webhook_subscription_payment_succeeded_merchant`, `Webhook_subscription_resumed_merchant`, `Webhook_subscription_trial_ending_merchant` → `Webhook_subscription_paused_merchant`
- `LineItemFulfillmentWeightRequest` → `Weight`

</details>

<details>
<summary>Operation response alias replacements</summary>

- `ApiKeysListResponse` → `APIKeyListResponse`
- `ApiKeysGetResponse`, `ApiKeysRevokeResponse`, `ApiKeysUpdateResponse` → `APIKeyResponse`
- `DeveloperGetCurrentAPIKeyRequestLogResponse` → `APIRequestLogDetailResponse`
- `DeveloperListCurrentAPIKeyRequestLogsResponse` → `APIRequestLogListResponse`
- `CustomersDeleteAddressResponse`, `MeDeleteAddressResponse`, `MeRemovePaymentMethodResponse`, `MeResendOrderReceiptResponse`, `OrdersResendReceiptResponse`, `PaymentMethodsRemoveResponse`, `WebhookEndpointsRemoveResponse` → `ActionResponse`
- `AnalyticsGetOverviewResponse` → `AnalyticsOverviewResponse`
- `BalancesListResponse` → `BalanceListResponse`
- `BalanceTransactionsListResponse` → `BalanceTransactionListResponse`
- `BalanceTransactionsGetResponse` → `BalanceTransactionResponse`
- `BundlesListComponentsResponse` → `BundleComponentListResponse`
- `BundlesListResponse` → `BundleListResponse`
- `BundlesCreateResponse`, `BundlesGetResponse`, `BundlesRemoveResponse`, `BundlesUpdateResponse` → `BundleResponse`
- `MeListCreditNotesResponse` → `BuyerCreditNoteListResponse`
- `MeGetCreditNoteResponse` → `BuyerCreditNoteResponse`
- `MeListInvoicesResponse` → `BuyerInvoiceListResponse`
- `MeGetInvoiceResponse` → `BuyerInvoiceResponse`
- `MeCancelSubscriptionResponse`, `SubscriptionsCancelResponse` → `CancelSubscriptionResponse`
- `CapabilitiesListResponse` → `CapabilityListResponse`
- `CategoriesListResponse` → `CategoryListResponse`
- `CategoriesCreateResponse`, `CategoriesGetResponse`, `CategoriesRemoveResponse`, `CategoriesUpdateResponse` → `CategoryResponse`
- `CheckoutSessionsConfirmCustomerVerificationResponse` → `CheckoutCustomerVerificationConfirmationResponse`
- `CheckoutSessionsCreateCustomerVerificationResponse` → `CheckoutCustomerVerificationResponse`
- `CheckoutSessionsCreateDeliveryQuoteResponse`, `CheckoutSessionsGetDeliveryQuoteResponse` → `CheckoutDeliveryQuoteResponse`
- `CheckoutSessionsCreateDeliverySelectionResponse`, `CheckoutSessionsDeleteCurrentDeliverySelectionResponse` → `CheckoutDeliverySelectionResultResponse`
- `CheckoutSessionsGetCurrentDeliverySelectionResponse` → `CheckoutEffectiveDeliverySelectionResponse`
- `CheckoutSessionsListResponse` → `CheckoutSessionListResponse`
- `CheckoutSessionsCloseSessionResponse`, `CheckoutSessionsGetResponse`, `CheckoutSessionsUpdateResponse` → `CheckoutSessionResponse`
- `InvoicesCollectResponse` → `CollectInvoiceResponse`
- `ApiKeysCreateResponse`, `DeveloperIssueSandboxTestKeyResponse`, `OnboardingCreateAPIKeyResponse` → `CreateAPIKeyResponse`
- `DevicesCreateResponse` → `CreateDeviceResponse`
- `OrdersCreateFulfillmentResponse` → `CreateFulfillmentResponse`
- `ShipmentsCreatePackageResponse` → `CreatePackageResponse`
- `DeveloperCreatePartnerAppResponse` → `CreatePartnerAppResponse`
- `OrdersCreatePaymentIntentResponse`, `PaymentIntentsCreateResponse` → `CreatePaymentIntentResponse`
- `MeCreateReturnPreviewResponse`, `ReturnPreviewsCreateResponse` → `CreateReturnPreviewResponse`
- `FulfillmentsCreateShipmentResponse` → `CreateShipmentResponse`
- `CreditNotesListAllocationsResponse` → `CreditNoteAllocationListResponse`
- `CreditNotesGetAllocationResponse` → `CreditNoteAllocationResponse`
- `CreditNotesCreateAllocationResponse`, `CreditNotesReverseAllocationResponse` → `CreditNoteAllocationResultResponse`
- `CreditNotesListResponse` → `CreditNoteListResponse`
- `CreditNotesCreateResponse`, `CreditNotesGetResponse`, `CreditNotesUpdateResponse`, `CreditNotesVoidResourceResponse` → `CreditNoteResponse`
- `CustomersListAddressesResponse`, `MeListAddressesResponse` → `CustomerAddressListResponse`
- `CustomersCreateAddressResponse`, `CustomersGetAddressResponse`, `CustomersSetDefaultAddressResponse`, `CustomersUpdateAddressResponse`, `MeCreateAddressResponse`, `MeGetAddressResponse`, `MeSetDefaultAddressResponse`, `MeUpdateAddressResponse` → `CustomerAddressResponse`
- `CustomerDeletionRequestsListResponse` → `CustomerDeletionRequestListResponse`
- `CustomerDeletionRequestsResolveResponse`, `CustomersCreateDeletionRequestResponse`, `CustomersGetDeletionRequestResponse`, `MeCreateDeletionRequestResponse`, `MeGetDeletionRequestResponse` → `CustomerDeletionRequestResponse`
- `CustomersListResponse` → `CustomerListResponse`
- `CustomersCreateResponse`, `CustomersGetResponse`, `CustomersUpdateResponse`, `MeGetResponse`, `MeUpdateResponse` → `CustomerResponse`
- `CustomerSessionsCreateResponse`, `CustomerSessionsRefreshResponse` → `CustomerSessionResponse`
- `CustomerSessionsRevokeResponse` → `CustomerSessionRevocationResponse`
- `CustomersRevokeSessionsResponse` → `CustomerSessionsRevocationResponse`
- `DeliveryLocationSetsListResponse` → `DeliveryLocationSetListResponse`
- `DeliveryLocationSetsCreateResponse`, `DeliveryLocationSetsGetResponse`, `DeliveryLocationSetsRemoveResponse`, `DeliveryLocationSetsUpdateResponse` → `DeliveryLocationSetResponse`
- `DeliveryMethodsListResponse` → `DeliveryMethodListResponse`
- `DeliveryMethodsCreateResponse`, `DeliveryMethodsGetResponse`, `DeliveryMethodsRemoveResponse`, `DeliveryMethodsUpdateResponse` → `DeliveryMethodResponse`
- `CheckoutSessionsQueryPickupAvailabilityResponse` → `DeliveryPickupAvailabilityResponse`
- `DeliveryPreviewsCreateResponse` → `DeliveryPreviewResponse`
- `DeliveryProfilesAssignToUnconfiguredResponse` → `DeliveryProfileAssignmentResponse`
- `DeliveryProfilesListResponse` → `DeliveryProfileListResponse`
- `DeliveryProfilesCreateResponse`, `DeliveryProfilesGetResponse`, `DeliveryProfilesRemoveResponse`, `DeliveryProfilesUpdateResponse` → `DeliveryProfileResponse`
- `DeliveryQuotesListResponse` → `DeliveryQuoteListResponse`
- `DeliveryRateCallbacksCheckConnectionResponse` → `DeliveryRateCallbackConnectionCheckResponse`
- `DeliveryRateCallbacksListResponse` → `DeliveryRateCallbackListResponse`
- `DeliveryRateCallbacksCreateResponse`, `DeliveryRateCallbacksGetResponse`, `DeliveryRateCallbacksRemoveResponse`, `DeliveryRateCallbacksUpdateResponse` → `DeliveryRateCallbackResponse`
- `DeliveryRateCallbacksRotateSigningKeyResponse` → `DeliveryRateCallbackSigningKeyRotationResponse`
- `DeliveryRateCallbacksCreateTestDeliveryResponse` → `DeliveryRateCallbackTestDeliveryResponse`
- `DeliveryRevocationsGetResponse`, `DeliveryRevocationsRevokeDeliveryDependencyResponse` → `DeliveryRevocationResponse`
- `CheckoutSessionsGetDeliverySelectionHistoryResponse`, `OrdersGetCurrentDeliverySelectionResponse` → `DeliverySelectionResponse`
- `DeliveryZonesListResponse` → `DeliveryZoneListResponse`
- `DeliveryZonesCreateResponse`, `DeliveryZonesGetResponse`, `DeliveryZonesRemoveResponse`, `DeliveryZonesUpdateResponse` → `DeliveryZoneResponse`
- `DemoSessionsCreateResponse`, `DemoSessionsResetResponse` → `DemoSessionResponse`
- `DeveloperGetAuthContextResponse` → `DeveloperAuthContextResponse`
- `DevicesListResponse` → `DeviceListResponse`
- `DevicesGetResponse`, `DevicesRemoveResponse`, `DevicesUpdateResponse` → `DeviceResponse`
- `OrdersPreviewDiscountsResponse` → `DiscountPreviewResponse`
- `DisputesListResponse` → `DisputeListResponse`
- `DisputesGetResponse` → `DisputeResponse`
- `MeConfirmEmailChangeRequestResponse`, `MeCreateEmailChangeRequestResponse` → `EmailChangeRequestResponse`
- `FeedbackReportsListResponse` → `FeedbackReportListResponse`
- `FeedbackReportsCreateResponse`, `FeedbackReportsGetResponse` → `FeedbackReportResponse`
- `FraudWarningsListResponse` → `FraudWarningListResponse`
- `FraudWarningsGetResponse` → `FraudWarningResponse`
- `FulfillmentsTransitionResponse` → `FulfillmentCommandResponse`
- `FulfillmentEventsListResponse` → `FulfillmentEventListResponse`
- `FulfillmentEventsGetResponse` → `FulfillmentEventResourceResponse`
- `FulfillmentsCreateEventResponse` → `FulfillmentEventResponse`
- `FulfillmentsListResponse`, `MeListFulfillmentsResponse` → `FulfillmentListResponse`
- `FulfillmentNotificationsListResponse` → `FulfillmentNotificationListResponse`
- `FulfillmentNotificationsGetResponse` → `FulfillmentNotificationResponse`
- `FulfillmentsGetResponse` → `FulfillmentResponse`
- `PaymentIntentsGetResponse` → `GetPaymentIntentResponse`
- `ReturnDispositionsCancelResponse`, `ReturnDispositionsGetResponse`, `ReturnDispositionsRetryResponse`, `ReturnsCreateDispositionResponse` → `GetReturnDispositionResponse`
- `ReturnInspectionsDecideLineItemResponse`, `ReturnInspectionsGetResponse`, `ReturnsCreateInspectionResponse` → `GetReturnInspectionResponse`
- `ReturnsGetLineItemResponse` → `GetReturnLineItemResponse`
- `ReturnPoliciesCreateResponse`, `ReturnPoliciesGetResponse`, `ReturnPoliciesPublishRevisionResponse`, `ReturnPoliciesRemoveResponse`, `ReturnPoliciesUpdateResponse` → `GetReturnPolicyResponse`
- `ReturnPoliciesGetRevisionResponse` → `GetReturnPolicyRevisionResponse`
- `ReturnReasonsCreateResponse`, `ReturnReasonsGetResponse`, `ReturnReasonsRemoveResponse`, `ReturnReasonsUpdateResponse` → `GetReturnReasonResponse`
- `ReturnReceiptsGetResponse`, `ReturnReceiptsVerifyLineItemResponse`, `ReturnsCreateReceiptResponse` → `GetReturnReceiptResponse`
- `ReturnResolutionsCancelResponse`, `ReturnResolutionsConfirmResponse`, `ReturnResolutionsGetResponse`, `ReturnResolutionsReleaseResponse`, `ReturnResolutionsRetryResponse`, `ReturnResolutionsUpdateResponse`, `ReturnsCreateResolutionResponse` → `GetReturnResolutionResponse`
- `MeCancelReturnResponse`, `MeCreateReturnResponse`, `MeGetReturnResponse`, `ReturnsAddLineItemResponse`, `ReturnsCancelLineItemResponse`, `ReturnsCancelResponse`, `ReturnsCompleteResponse`, `ReturnsCreateResponse`, `ReturnsDecideResponse`, `ReturnsDeleteLineItemResponse`, `ReturnsGetResponse`, `ReturnsReopenResponse`, `ReturnsUpdateLineItemResponse`, `ReturnsUpdateResponse`, `ReturnsWaiveLineInspectionResponse` → `GetReturnResponse`
- `InventoryAdjustmentsListResponse` → `InventoryAdjustmentListResponse`
- `InventoryAdjustmentsCreateResponse` → `InventoryAdjustmentResultResponse`
- `InventoryAllocationPoliciesListResponse` → `InventoryAllocationPolicyListResponse`
- `InventoryAllocationPoliciesCreateResponse`, `InventoryAllocationPoliciesRemoveResponse`, `InventoryAllocationPoliciesUpdateResponse` → `InventoryAllocationPolicyResponse`
- `InventoryCountsListResponse` → `InventoryCountListResponse`
- `InventoryCountsCreateResponse`, `InventoryCountsUpdateResponse` → `InventoryCountResponse`
- `InventoryCountsApplyResponse`, `InventoryCountsCancelResponse` → `InventoryCountResultResponse`
- `InventoryItemsListResponse` → `InventoryItemListResponse`
- `InventoryItemsCreateResponse`, `InventoryItemsRemoveResponse`, `InventoryItemsUpdateResponse` → `InventoryItemResponse`
- `InventoryLevelsListResponse` → `InventoryLevelListResponse`
- `InventoryLevelsUpdateResponse` → `InventoryLevelUpdateResultResponse`
- `InventoryMovementsListResponse` → `InventoryMovementListResponse`
- `InventoryReceiptsListResponse` → `InventoryReceiptListResponse`
- `InventoryReceiptsCreateResponse` → `InventoryReceiptResultResponse`
- `InventoryReservationsListResponse` → `InventoryReservationListResponse`
- `InventoryReservationsCommitResponse`, `InventoryReservationsConsumeResponse`, `InventoryReservationsCreateResponse`, `InventoryReservationsReleaseResponse` → `InventoryReservationResultResponse`
- `InventoryTransfersListResponse` → `InventoryTransferListResponse`
- `InventoryTransfersCreateResponse`, `InventoryTransfersUpdateResponse` → `InventoryTransferResponse`
- `InventoryTransfersTransitionResponse` → `InventoryTransferResultResponse`
- `InvoicesGetOrCreateCheckoutSessionResponse`, `MeCreateInvoiceCheckoutSessionResponse` → `InvoiceCheckoutSessionResponse`
- `InvoicesListDeliveryAttemptsResponse` → `InvoiceDeliveryAttemptListResponse`
- `InvoicesListEventsResponse` → `InvoiceEventListResponse`
- `InvoicesListResponse` → `InvoiceListResponse`
- `InvoicesListPaymentAttemptsResponse` → `InvoicePaymentAttemptListResponse`
- `InvoicesCancelPaymentAttemptResponse`, `InvoicesGetPaymentAttemptResponse` → `InvoicePaymentAttemptResponse`
- `InvoicePaymentTermsListResponse` → `InvoicePaymentTermListResponse`
- `InvoicePaymentTermsCreateResponse`, `InvoicePaymentTermsGetResponse`, `InvoicePaymentTermsRemoveResponse`, `InvoicePaymentTermsUpdateResponse` → `InvoicePaymentTermResponse`
- `InvoicesAssessLateFeeResponse`, `InvoicesCreateResponse`, `InvoicesGetResponse`, `InvoicesMarkUncollectibleResponse`, `InvoicesPauseRemindersResponse`, `InvoicesRecordManualPaymentResponse`, `InvoicesResumeRemindersResponse`, `InvoicesReverseManualPaymentResponse`, `InvoicesUpdateResponse`, `InvoicesVoidResourceResponse`, `InvoicesWaiveLateFeeResponse` → `InvoiceResponse`
- `CreditNotesIssueResponse` → `IssueCreditNoteResponse`
- `InvoicesIssueResponse`, `InvoicesSendReminderResponse` → `IssueInvoiceResponse`
- `ReturnDispositionsListResponse` → `ListReturnDispositionsResponse`
- `ReturnInspectionsListResponse` → `ListReturnInspectionsResponse`
- `ReturnsListLineItemsResponse` → `ListReturnLineItemsResponse`
- `ReturnPoliciesListResponse` → `ListReturnPoliciesResponse`
- `ReturnPoliciesListRevisionsResponse` → `ListReturnPolicyRevisionsResponse`
- `ReturnReasonsListResponse` → `ListReturnReasonsResponse`
- `ReturnReceiptsListResponse` → `ListReturnReceiptsResponse`
- `ReturnResolutionsListResponse` → `ListReturnResolutionsResponse`
- `MeListReturnsResponse`, `ReturnsListResponse` → `ListReturnsResponse`
- `LocationsUpdateInventoryResponse` → `LocationInventoryResponse`
- `LocationsListResponse` → `LocationListResponse`
- `LocationsCreateResponse`, `LocationsGetResponse`, `LocationsPublishGeographyResponse`, `LocationsRemoveResponse`, `LocationsUpdateResponse` → `LocationResponse`
- `MerchantAccountSessionsCreateResponse`, `MerchantAccountSessionsRefreshResponse` → `MerchantAccountSessionResponse`
- `MerchantBillingBalancesListResponse` → `MerchantBillingBalanceListResponse`
- `MerchantBillingBalancesGetResponse` → `MerchantBillingBalanceResponse`
- `MerchantsGetResponse`, `MerchantsUpdateResponse` → `MerchantResponse`
- `MerchantSubscriptionInvoicesListResponse` → `MerchantSubscriptionInvoiceListResponse`
- `MerchantSubscriptionInvoicesGetResponse` → `MerchantSubscriptionInvoiceResponse`
- `ModifierGroupsListResponse` → `ModifierGroupListResponse`
- `ModifierGroupsCreateResponse`, `ModifierGroupsGetResponse`, `ModifierGroupsRemoveResponse`, `ModifierGroupsUpdateResponse` → `ModifierGroupResponse`
- `ModifierSetsListResponse` → `ModifierSetListResponse`
- `ModifierSetsCreateResponse`, `ModifierSetsGetResponse`, `ModifierSetsRemoveResponse`, `ModifierSetsUpdateResponse` → `ModifierSetResponse`
- `OnboardingStartFlowResponse` → `OnboardingStartResponse`
- `OnboardingAdvanceResponse`, `OnboardingGetStateResponse` → `OnboardingStateResponse`
- `OnboardingVerifyEmailCodeResponse` → `OnboardingVerifyEmailResponse`
- `MeListOrderActivitiesResponse`, `OrdersListActivitiesResponse` → `OrderActivityListResponse`
- `MeListOrdersResponse`, `OrdersListResponse` → `OrderListResponse`
- `OrdersListPaymentAttemptsResponse` → `OrderPaymentAttemptListResponse`
- `OrdersGetPaymentAttemptResponse` → `OrderPaymentAttemptResponse`
- `OrdersCancelPaymentResponse`, `OrdersCapturePaymentResponse` → `OrderPaymentLifecycleResponse`
- `FulfillmentsUpdateResponse`, `MeGetOrderResponse`, `OrdersAddChargeResponse`, `OrdersAddLineItemsResponse`, `OrdersApplyDiscountResponse`, `OrdersCloseSessionResponse`, `OrdersCreateResponse`, `OrdersDeleteChargeResponse`, `OrdersDeleteLineItemResponse`, `OrdersGetResponse`, `OrdersRemoveDiscountsResponse`, `OrdersRepriceDiscountsResponse`, `OrdersResolveInventoryExceptionResponse`, `OrdersUpdateChargeResponse`, `OrdersUpdateResponse` → `OrderResponse`
- `OrganizationsListResponse` → `OrganizationListResponse`
- `OrganizationsListMembershipsResponse` → `OrganizationMembershipListResponse`
- `OrganizationsGrantMembershipResponse` → `OrganizationMembershipResponse`
- `OrganizationsCreateResponse`, `OrganizationsGetResponse`, `OrganizationsRemoveResponse`, `OrganizationsUpdateResponse` → `OrganizationResponse`
- `PackagesListPackageItemsResponse` → `PackageItemListResponse`
- `PackagesCreateItemResponse`, `PackagesDeleteItemResponse`, `PackagesGetItemResponse`, `PackagesUpdateItemResponse` → `PackageItemResponse`
- `MeListPackagesResponse`, `PackagesListResponse` → `PackageListResponse`
- `PackagesGetResponse` → `PackageResponse`
- `PackagesTransitionResponse` → `PackageStatusUpdateResponse`
- `DeveloperListPartnerAppInstallsResponse` → `PartnerAppInstallListResponse`
- `DeveloperGetPartnerAppInstallResponse`, `DeveloperRevokePartnerAppInstallResponse`, `DeveloperRevokePartnerEnvironmentGrantResponse` → `PartnerAppInstallResponse`
- `DeveloperListPartnerAppsResponse` → `PartnerAppListResponse`
- `DeveloperGetPartnerAppResponse`, `DeveloperUpdatePartnerAppResponse` → `PartnerAppResponse`
- `OauthPreviewPartnerInstallAuthorizationResponse` → `PartnerAuthorizePreviewResponse`
- `OrdersCancelPaymentAttemptResponse`, `OrdersPayResponse` → `PayOrderResponse`
- `MeListPaymentsResponse`, `PaymentIntentsListResponse` → `PaymentIntentListResponse`
- `PaymentIntentsCancelResponse`, `PaymentIntentsCaptureResponse`, `PaymentIntentsConfirmResponse`, `PaymentIntentsUpdateResponse` → `PaymentIntentResponse`
- `PaymentLinksListResponse` → `PaymentLinkListResponse`
- `PaymentLinksCreateResponse`, `PaymentLinksGetResponse`, `PaymentLinksUpdateResponse` → `PaymentLinkResponse`
- `PaymentMethodDomainsListResponse` → `PaymentMethodDomainListResponse`
- `PaymentMethodDomainsCreateResponse`, `PaymentMethodDomainsGetResponse`, `PaymentMethodDomainsUpdateResponse` → `PaymentMethodDomainResponse`
- `MeListPaymentMethodsResponse`, `PaymentMethodsListResponse` → `PaymentMethodListResponse`
- `MeSetDefaultPaymentMethodResponse`, `PaymentMethodsGetResponse`, `PaymentMethodsSetDefaultResponse` → `PaymentMethodResponse`
- `AnalyticsGetPaymentVolumeTimeseriesResponse` → `PaymentVolumeTimeseriesResponse`
- `PayoutSettingsListPayoutDestinationsResponse` → `PayoutDestinationListResponse`
- `PayoutSettingsDeletePayoutDestinationResponse`, `PayoutSettingsGetPayoutDestinationResponse`, `PayoutSettingsUpdatePayoutDestinationResponse` → `PayoutDestinationResponse`
- `PayoutsListEntriesResponse` → `PayoutEntryListResponse`
- `PayoutsListResponse` → `PayoutListResponse`
- `PayoutsCancelResponse`, `PayoutsCreateResponse`, `PayoutsGetResponse` → `PayoutResponse`
- `PayoutSettingsGetResponse`, `PayoutSettingsUpdateResponse` → `PayoutSettingsResponse`
- `ReturnsProcessExistingResponse` → `ProcessExistingReturnResponse`
- `ProductsListResponse` → `ProductListResponse`
- `ProductsListOptionsResponse` → `ProductOptionListResponse`
- `ProductsGetOptionResponse` → `ProductOptionResponse`
- `ProductsCreateResponse`, `ProductsGetResponse`, `ProductsRemoveResponse`, `ProductsUpdateResponse` → `ProductResponse`
- `ProductsListVariantsResponse` → `ProductVariantListResponse`
- `ProductsCreateVariantResponse`, `ProductsDeleteVariantResponse`, `ProductsGetVariantResponse`, `ProductsUpdateVariantResponse` → `ProductVariantResponse`
- `PromotionsListCodesResponse` → `PromotionCodeListResponse`
- `PromotionsResolveCodeResponse` → `PromotionCodeResolutionResponse`
- `PromotionsCreateCodeResponse`, `PromotionsDeleteCodeResponse`, `PromotionsUpdateCodeResponse` → `PromotionCodeResponse`
- `PromotionsListResponse` → `PromotionListResponse`
- `PromotionsCreateResponse`, `PromotionsGetResponse`, `PromotionsRemoveResponse`, `PromotionsUpdateResponse` → `PromotionResponse`
- `PaymentLinksGetPublicResponse` → `PublicPaymentLinkResponse`
- `CreditNotesListRefundsResponse`, `MeListRefundsResponse`, `RefundsListResponse` → `RefundListResponse`
- `CreditNotesCreateRefundResponse`, `RefundsCreateResponse`, `RefundsGetResponse`, `RefundsUpdateResponse` → `RefundResponse`
- `InvoicesRegeneratePublicLinkResponse` → `RegenerateInvoiceLinkResponse`
- `ReportsListResponse` → `ReportListResponse`
- `ReportsCreateResponse`, `ReportsGetResponse` → `ReportResponse`
- `CheckoutSessionsCreateResponse`, `MeCreateReturnResolutionCheckoutSessionResponse`, `PaymentLinksResolveResponse`, `ReturnResolutionsGetOrCreateCheckoutSessionResponse` → `ResolvePaymentLinkResponse`
- `DeveloperGetResourceTimelineResponse` → `ResourceTimelineResponse`
- `ReviewsListResponse` → `ReviewListResponse`
- `ReviewsApproveResponse`, `ReviewsDeclineResponse`, `ReviewsGetResponse` → `ReviewResponse`
- `OrganizationsRevokeMembershipResponse` → `RevokeOrganizationMembershipResponse`
- `RiskListsListRiskListItemsResponse` → `RiskListItemListResponse`
- `RiskListsDeleteItemResponse`, `RiskListsGetItemResponse` → `RiskListItemResponse`
- `RiskListsAddItemsResponse` → `RiskListItemResultsResponse`
- `RiskListsListResponse` → `RiskListListResponse`
- `RiskListsCreateResponse`, `RiskListsGetResponse`, `RiskListsRemoveResponse`, `RiskListsUpdateResponse` → `RiskListResourceResponse`
- `RiskRulesGetAttributeRegistryResponse` → `RiskRuleAttributeRegistryResponse`
- `RiskRulesListResponse` → `RiskRuleListResponse`
- `RiskRulesCreateResponse`, `RiskRulesGetResponse`, `RiskRulesRemoveResponse`, `RiskRulesUpdateResponse` → `RiskRuleResponse`
- `RiskPreviewsCreateResponse` → `RiskRuleValidationResponse`
- `DeveloperRotatePartnerAppSecretResponse` → `RotatePartnerAppSecretResponse`
- `DeveloperListSandboxesResponse` → `SandboxListResponse`
- `DeveloperDeleteSandboxResponse`, `DeveloperGetSandboxResponse`, `DeveloperResetSandboxResponse` → `SandboxResponse`
- `DeveloperCreateSandboxResponse` → `SandboxWithAPIKeyResponse`
- `MeSavePaymentMethodResponse`, `PaymentMethodsSaveResponse` → `SavePaymentMethodResponse`
- `SettingsGetEffectiveResponse`, `SettingsGetResponse`, `SettingsUpdateResponse` → `SettingsResponse`
- `MeListShipmentsResponse`, `ShipmentsListResponse` → `ShipmentListResponse`
- `ShipmentsGetResponse` → `ShipmentResponse`
- `AnalyticsGetSubscriptionResponse` → `SubscriptionAnalyticsResponse`
- `MeListSubscriptionsResponse`, `SubscriptionsListResponse` → `SubscriptionListResponse`
- `SubscriptionsListPaymentRetriesResponse` → `SubscriptionPaymentRetryListResponse`
- `SubscriptionsCreatePaymentRetryResponse`, `SubscriptionsGetPaymentRetryResponse` → `SubscriptionPaymentRetryResponse`
- `SubscriptionPlansListResponse` → `SubscriptionPlanListResponse`
- `SubscriptionPlansCreateResponse`, `SubscriptionPlansGetResponse`, `SubscriptionPlansRemoveResponse`, `SubscriptionPlansUpdateResponse` → `SubscriptionPlanResponse`
- `MeChangeSubscriptionPaymentMethodResponse`, `MeGetSubscriptionResponse`, `MePauseSubscriptionResponse`, `MeReactivateSubscriptionResponse`, `MeResumeSubscriptionResponse`, `SubscriptionsChangePaymentMethodResponse`, `SubscriptionsCreateResponse`, `SubscriptionsGetResponse`, `SubscriptionsPauseResponse`, `SubscriptionsReactivateResponse`, `SubscriptionsResumeResponse`, `SubscriptionsSkipCycleResponse`, `SubscriptionsUpdateBillingScheduleResponse`, `SubscriptionsUpdateResponse` → `SubscriptionResponse`
- `OrganizationsTransferOwnershipResponse` → `TransferOrganizationOwnershipResponse`
- `PackagesUpdateResponse` → `UpdatePackageResponse`
- `ShipmentsUpdateResponse` → `UpdateShipmentResponse`
- `PackagesVoidResourceResponse` → `VoidPackageResponse`
- `ShipmentsVoidResourceResponse` → `VoidShipmentResponse`
- `WebhookDeliveriesResendResponse`, `WebhookEndpointsCreateWebhookTestEventResponse` → `WebhookDeliveryActionResponse`
- `WebhookDeliveriesListAttemptsResponse` → `WebhookDeliveryAttemptListResponse`
- `WebhookEventsListWebhookDeliveriesResponse` → `WebhookDeliveryListResponse`
- `WebhookDeliveriesGetResponse` → `WebhookDeliveryResponse`
- `WebhookEndpointsListResponse` → `WebhookEndpointListResponse`
- `WebhookEndpointsCreateResponse`, `WebhookEndpointsGetResponse`, `WebhookEndpointsUpdateResponse` → `WebhookEndpointResponse`
- `WebhookEventsListResponse` → `WebhookEventListResponse`
- `WebhookEventsGetResponse` → `WebhookEventResponse`
- `WebhookEventTypesListResponse` → `WebhookEventTypeListResponse`
- `WebhookEndpointsRotateWebhookSecretResponse` → `WebhookSecretRotationResponse`

</details>

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
