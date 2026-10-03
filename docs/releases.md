# Releases and compatibility

## Error parsing and origin normalization corrections

Regenerated Node and PHP clients require original JSON strings for server messages, provider codes and code-based retries. Decimal, exponent and large-integer JSON numbers no longer become messages or codes or trigger string-code retries. Node error paths also stop at scalar strings and ignore runtime-only array properties, matching PHP. A path such as `code.0` cannot turn a scalar string into a one-character retry code, and `details.length` cannot expose an array length. Object members and array indices remain supported. Parsed error details and explicit raw bodies retain their existing representations.

PHP now normalizes HTTP/HTTPS scheme capitalization before omitting default ports, matching Node origin checks. Equivalent pagination destinations such as `HTTPS://example.invalid:443` and `https://example.invalid` are accepted; nondefault ports remain distinct.

## Nullable response wrappers

Simple `anyOf`/`oneOf` wrappers with one explicitly typed non-null branch and a plain null branch now expose typed nullable values. TypeScript nullable object fields support direct optional field access. PHP getters hydrate the existing component class, preserving its name; newly typed inline objects receive the usual owning-field class name. Unknown fields and enum members remain preserved, and genuinely polymorphic alternatives retain their fallback behavior.

Regeneration changes PHP nullable object values from raw `stdClass` to generated entities and rejects malformed known values that previously escaped through an unknown-variant fallback. Use generated getters or raw `toArray()`/`jsonSerialize()` exports when adapting consumers; compatibility review should account for this representation correction before publishing a regenerated SDK. No provider configuration migration or component class rename is required.

## npm package metadata

Regenerated Node packages support `require()` for the package root and resource subpaths on Node.js 22.12+, using the same ESM files as imports. ESM imports continue to support Node.js 22+.

Node types move from a pinned runtime dependency to an optional `@types/node >=22.16.0` peer dependency. TypeScript consumers that previously relied on the transitive installation must add a compatible version to their own development dependencies, for example `npm install --save-dev @types/node@22`. Older Node type declarations can fail with TypeScript 5.9; the supported floor is 22.16.0. JavaScript consumers need no type packages. The generator retains its pinned tooling dependencies; PHP packages are unaffected.

Providers can set optional `npm.repository` and `npm.homepage` metadata; see [publication metadata](configuration.md#publication-metadata). README links remain relative to documentation committed alongside the SDK.

## Object, number and date-time representations

Regeneration changes the public SDK contract in both targets. Plain `number`, float and double fields now accept and return native numbers (PHP `int|float` inputs and `float` outputs). Replace numeric-string arguments with numbers and update consumers expecting string results. Preserve precision-sensitive decimals by declaring `format: "decimal"` in the schema or a provider override. int64/uint64 retain exact strings; ordinary integers retain their safe-range checks. Native numbers use floating-point precision and reject non-finite values.

TypeScript shaped objects no longer implicitly permit arbitrary property names. Correct misspelled request/response fields; explicitly open schemas and dictionaries remain open. Unknown response fields still survive decoding and can be inspected through explicit narrowing or a dictionary assertion. Unknown object variants require narrowing before accessing variant fields. This is a declaration change, not a new default runtime rejection of request keys.

Date-time inputs additionally accept JavaScript `Date` and PHP `DateTimeInterface`; native values become UTC ISO 8601 strings with milliseconds. Strings and response representations remain unchanged. Date-only fields still accept strings.

Compiled value semantics advance to version 4. Compatibility comparisons report a breaking migration from older compiled semantics; old snapshots keep their recorded codec decisions. Review the generated diff and version the SDK under the configured breaking-change policy before release.

## Pagination deadline correction

Regenerated Node and PHP page/item iterators apply `deadlineMs` separately to each page request, including retries and decoding. The default 30-second budget no longer expires across a backfill or counts time spent processing yielded values. Explicit client and request deadlines also apply per page. Callers relying on an overall iteration bound should use cancellation or `maxPages`/`maxItems`. Polling retains its overall deadline.

## Payload pagination and polling returns

Regeneration changes payload-mode `Pages` and `Wait` returns in both Node and PHP: they now expose the same projected payload as the base method. Replace previous Result envelope access with payload access. Use `PagesWithResponse` or `WaitWithResponse` when you need the complete body, metadata or raw response; these companions return `SdkResponse` with `body`, `meta`, and `raw`. Result-mode helpers and `Items` retain their previous behavior. Cursor and polling state paths still address the original provider body.

Saved compiled contracts record the helper return policy. Migrating existing payload-mode helpers from Result returns is reported as breaking, and stable SDKs using the semver policy require a major version. Review generated consumer types and migration notes before releasing the regenerated packages.

## Webhook verification changes

Regenerated Node and PHP verifiers accept either one signing secret or an array for rotation. Node now accepts Fetch `Headers` and Node/Express header records; PHP accepts PSR-7 header arrays. Original body bytes remain required: Node rejects plain strings as well as parsed objects, consistent with its Buffer/Uint8Array declaration. Parsed JSON and malformed inputs produce SDK errors instead of native type errors.

Webhook errors expose stable `webhook_*` reasons through Node `code` and PHP `errorCode`. Invalid caller inputs and unusable secrets now use `validation`; missing/malformed signing headers, timestamps outside tolerance, and signature mismatches use `authentication`. Authenticated JSON and payload failures use `protocol`. Update error-kind switches; see the [complete code table](using-sdks.md#webhook-verification).

`known: true` now requires a registered event name and a matching declared envelope, instead of name recognition alone. Authenticated unmatched variants return `known: false` and must remain pending for application review. Known-event TypeScript declarations use shared aliases and preserve event-name narrowing; nested response uncertainty remains explicit. Existing valid calls, signing formats and configuration remain supported. Review these behavior changes before regenerating an SDK; no provider configuration migration is required.

## Client setup changes

Regenerated Node and PHP packages use the first declared top-level server as their default base URL. Existing explicit `baseUrl` values retain precedence. Adding a default is additive; changing or removing an existing default is breaking because callers may omit their URL. Unsupported relative/templated servers and path-level overrides now fail diagnosis rather than being ignored. APIs without servers continue to require `baseUrl`, with structured setup errors.

The full Flint profile maps `token` to merchant bearer authentication and exposes `apiKey`, `customerToken`, `onboardingToken`, and `invoiceToken`. Its first server is production; sandbox callers must override the base URL. Checkout keeps its complete explicit credential map. Composed clients without a token mapping now reject `token` instead of silently ignoring it; TypeScript declarations omit that unsupported option. Legacy token clients remain supported. PHP `ClientOptions.baseUrl` is now nullable when omitted; the runtime stores the resolved URL independently and existing positional argument order is preserved.

HTTP remains opt-in through `allowInsecureHttp`, and destination errors now distinguish protocol and allowed-origin failures. Generated examples no longer use a fabricated sandbox fallback. Review these changes when regenerating packages and migrate callers that previously passed ignored tokens.

Generator releases and generated SDK package versions are independent. Generator 0.1.0 supports the subset in the [support matrix](support-matrix.md). Node and PHP outputs use the configured package version; API `info.version` and an optional pinned version header are separately documented. Preview versions use a SemVer prerelease suffix and npm's `next` tag in the release plan.

Release commands use the installed `sdk-generator` executable. From a source checkout, substitute `node dist/cli.js` after running `npm ci` and `npm run build`. See the [CLI reference](cli.md) for complete positional arguments. Package preparation and tests do not establish that a version has been published.

API error reporting now supports `errors.messagePath` (default `message`) and exposes HTTP `status` directly in both targets. Messages use the redacted server explanation when available. Node inspection and PHP debug output include provider codes, redacted details and stack frames. HTTP 404 errors now use kind `not_found`, and HTTP 500–599 errors use `server`, replacing `api` for those statuses. Update kind switches when regenerating existing SDKs; retry eligibility continues to follow the declared policy.

Before publication:

1. Keep pinned inputs, referenced local files, SDK configuration and generator revision in the provider's private or public source repository as appropriate.
2. Run `preview` against the current generated output. Review source/type/example differences and compatibility findings. `effective` explains the resolved contract but contains private API details.
3. Generate and run `validate --fixtures` with independently provider-reviewed HTTP scenarios. Test relevant workflows against the provider sandbox separately.
4. Run `release OUTPUT NEW_RELEASE_DIRECTORY`. Inspect archives, checksums, changelog, migration guidance and publication commands. Nothing is uploaded automatically.
5. Publish the reviewed npm archive with `publish`. Deploy the prepared Composer repository, documentation and archives together with `publish-site RELEASE WEB_ROOT --confirm-version VERSION`. Alternatively, use your existing VCS/Packagist distribution process for PHP.

A method alias preserves a name only while the HTTP operation remains the same. Changing an endpoint behind the same name is a behavioral compatibility change. Structural comparisons identify added/removed fields, requiredness, nullability, enums, tagged variants, exact representations, parameter encoding and response status changes. Inputs and outputs have different compatibility directions: a newly required input and a newly optional output both break callers. Exported models are checked in both directions, including their input factories even when the model is used only in responses. Adding a required response field can therefore require a major version when it tightens the exported model factory input. Ambiguous changes retain review findings; no schema comparison proves server business semantics.

Renaming a resource or method can also change generated operation input/response type names and pagination/polling helper names. A method alias does not preserve these interfaces. Renames that change them are reported as breaking even when an alias retains the old method, and the `semver` policy blocks a patch or minor release of a stable SDK. Update consumer imports, PHP input classes and helper calls when making the corresponding major upgrade.

Stable SDK releases should use a major version for removed/renamed public interfaces without aliases, changed HTTP semantics, tighter requiredness/nullability, changed exact representations, or dropped runtimes. Additive compatible operations normally require a minor version; corrections preserving behavior may use a patch. Unknown future response fields/enums are tolerated but never reinterpreted as success. Do not remove aliases until the provider's documented deprecation window has elapsed; the generator makes no unsupported promise about that window.

Dictionary value policies are compared in the same direction as ordinary fields when both versions permit objects under their types and input enums. Replacing omitted or `true` `additionalProperties` with a restrictive schema can break existing object inputs and requires the corresponding version increase under `semver`. Dictionary rules cannot tighten string-only or null-only inputs. Equivalent unconstrained declarations do not introduce a breaking finding; exact numeric representation changes for dictionary values are still checked.

Adding a success status is breaking when it introduces an empty result where every previous result had a body, a body where all results were empty, or a provably incompatible simple result shape. A matching existing result shape retains a review finding for its HTTP semantics unless it introduces incompatible PHP classes as described below. The comparison includes declared 302/307 redirects, 304 and default responses in the result possibilities. PDF bytes, SSE streams and redirect location objects count as returned values even without a JSON schema. PDF results are byte arrays in Node and strings in PHP, so their compatibility depends on the selected targets. Inclusion between distinct result unions, composed schemas, recursive schemas, and schemas with typeless fields at any depth can still require manual review.

Older compiled snapshots that omitted non-JSON result guarantees remain readable. Comparisons that depend on those missing guarantees require review; the generator does not reinterpret them as empty results or replace the historical snapshot with a newly compiled contract.

Added response shapes are compared using decoded SDK values: textual formats remain strings, and exact numeric values are also strings in both SDKs. For example, adding a UUID-formatted string or an exact numeric response alongside an existing string response does not widen the result type and retains a review finding. This comparison also applies to nested fields, array items and dictionary values. Changes to the representation of an existing response or input retain their wire compatibility checks.

The added-response comparison follows public response fields: `readOnly` does not change their output type, and `writeOnly` fields and their requiredness are excluded. Object responses tolerate unknown fields even when `additionalProperties` is `false`. Adding such a result alongside a typed dictionary can widen its values to `unknown` and is reported as breaking. Removing a guaranteed response field or widening a field's public type still requires a breaking release.

Pure dictionaries (a schema-valued `additionalProperties` with no declared properties) emit `Record<string, T>` in TypeScript. Runtime validation enforces their `required` keys, but this type does not declare those keys. The comparison checks both TypeScript declarations and runtime presence guarantees, including nested dictionaries. Adding a dictionary result that drops a previously required key is breaking even if the TypeScript type stays the same. Adding a dictionary result alongside an object with an explicitly required property is also breaking, even if the dictionary schema requires the same key. Declare the property in `properties` to retain its public field guarantee.

PHP object and tagged response classes include the response status in their public names. Adding a success or default response can therefore widen the PHP return type even when its JSON schema matches an existing response: `Response201` does not satisfy a consumer expecting `Response200`. This is reported as breaking when PHP remains a selected target, unless the previous return type already includes a broad `mixed` or `object` alternative. Node-only matching shapes retain a review finding. Existing PHP class names are preserved; update class-based consumers when making the corresponding major upgrade.

PHP tagged response classes use the positions of their `oneOf` branches in their public names. Reordering or inserting branches can reassign an existing class to another tag; this is now reported as breaking when PHP is a selected target. Preserve existing branch positions and append new alternatives to avoid that reassignment, or make a major upgrade and update class-based consumer dispatch. Node-only branch reordering does not introduce this PHP-specific finding.

## Version policy

Set `release.policy` in the SDK configuration:

- `review` (default): report compatibility findings in the preview, release plan and migration notes without enforcing a version increase.
- `semver`: when a prior package version is recorded, release preparation requires a newer version. Breaking findings require a new major version, or a new minor version before 1.0; additive findings require a new minor version unless the major version increases. A prior prerelease requires a newer version but can evolve before stabilization. Findings marked `review` still require provider judgment.

The generator compares against its recorded previous interface; preserve the private generation record across upgrades. On a fresh output directory, there is no earlier version to compare. A package-version bump does not change the API contract or pinned request version header.

Archive preparation checks generated file integrity and recomputes compatibility with the current generator. It combines fresh and recorded findings for version-policy checks, the release plan, and migration notes, even when generated files are unchanged. Keep private provenance records, API definitions and signing secrets out of distribution repositories. npm's explicit file allowlist includes `custom/`; review custom contents before publishing. No local test suite certifies a real provider's backend. Publication to multiple registries cannot be one atomic transaction; document any partial publication and recovery.

## Known compatibility limitations

Added-result checks compare public types and runtime guarantees separately. Mixed objects retain schema-valued additional-field guarantees even when TypeScript exposes those values as `unknown`. Losing a nested required key is breaking, as are incompatible dictionary declarations, body absence/null changes, and new PHP classes outside the previous return type. Proven breaking findings survive uncertainty elsewhere.

Returned-value inclusion covers single explicit scalar/object/array types, pure and mixed dictionaries, and nested forms. Recursive references, compositions, typeless schemas, nullable type unions, and arbitrary prior-result unions retain review findings where inclusion cannot be proved. Their generation and execution support is unchanged.

The private generation record saves compiled contracts and runtime identities alongside source provenance and the original comparison baseline. Regeneration preserves that baseline even if a generator-only change affects compatibility without changing generated files. Older records remain usable and retain explicit historical review findings; recompiling their schemas does not establish what an older runtime guaranteed. Malformed or unrecognized records fail with diagnostics. Runtime implementation changes retain review even when compiled value guarantees are equal.

Changes inside `allOf`, `anyOf`, and `not` receive a generic `review` finding; the comparison does not recursively classify every nested constraint change. Other comparisons may still identify a breaking change, but a `review` finding alone does not block a patch release under `release.policy: "semver"` or require an explicit acknowledgment.

For example, with `validation: "schema"`, adding `minLength: 3` to a string input property inside an otherwise unchanged `allOf` branch can reject a previously valid one-character value while producing only a `review` finding. Review the nested constraints and choose the appropriate version increase manually before release. Successful release preparation does not establish that these changes are compatible.

## Explicit npm publication

After reviewing the prepared artifacts and supplying registry authentication through your own npm configuration, run:

```sh
sdk-generator publish PATH_TO_RELEASE --confirm-version 1.0.0
```

This command uploads the npm package. It verifies the exact reviewed version and all artifact checksums, including documentation, ignores arbitrary command strings in the plan, disables package scripts, and publishes the prepared npm archive to the configured HTTPS registry. It records a local publication receipt on success. A failure may have an uncertain registry outcome; check registry state before retrying. No publication is performed by generation, validation, preview or archive preparation.

Configure `npm.registry` and `npm.access` (`public` or `restricted`) for a provider's destination. Credentials must stay in the provider's npm authentication configuration, not the SDK config or generated metadata.

## Coordinated Composer and documentation distribution

Set `release.baseUrl` to the URL where the distribution site will be served, for example `https://sdk.example.com/`. HTTPS is required except for loopback integration tests. If omitted, Composer archive URLs are relative to the host root; configure a base URL for subdirectory hosting.

`release` prepares `site/packages.json`, immutable `site/versions/VERSION/` archives, browsable reference/guide pages, examples, changelog and migrations. Every file is checksummed. The Composer repository uses standard package metadata and ZIP distributions as specified in the [Composer repository documentation](https://getcomposer.org/doc/05-repositories.md#composer).

```sh
sdk-generator publish-site release/1.2.0 /path/to/sdk-web-root --confirm-version 1.2.0
```

The destination is a dedicated provider-owned web root or hosting checkout. Deployment stages a complete tree and preserves previous versions and Composer package entries. It rejects unrelated directories, edited published versions, symlinks and tampered artifacts. Repeating the same reviewed publication is safe. HTTP serving and authentication belong to the provider's hosting environment; no cloud account is required by the generator. A hosting checkout still needs the provider's normal deployment step before it is publicly served.

Consumers add `{ "type": "composer", "url": "https://sdk.example.com/" }` to their Composer repositories and install the generated package normally. The test suite installs from a generated repository served locally over HTTP.

Publish npm and the site as separate reviewed steps. `publication.json` and `site-publication.json` record the respective outcomes. If one destination succeeds and the other fails, preserve the successful immutable version and retry only the failed step after checking its state; do not rebuild different contents under an already published version. The two destinations cannot be committed atomically.

## Retry defaults migration

Regenerated Node and PHP SDKs retry GET/HEAD/OPTIONS without per-operation configuration: up to three attempts for transport failures and HTTP 408, 429, 500, 502, 503 and 504, with Retry-After and exponential jitter from a 100 ms base. Explicit policies replace defaults. Set client or request `maxAttempts: 1` to retain single-attempt behavior. Request budgets override client budgets, and valid budgets above an operation limit are capped instead of rejected.

Mutations with optional missing keys now send once instead of failing because retries were declared. Required keys remain required; a key alone does not enable an undeclared mutation retry policy. Persist and reuse keys across application resubmissions. Automatic key generation remains opt-in and covers one SDK call.

TypeScript method options now reject `idempotencyKey` on unsupported operations. Wrappers forwarding a broad `RequestOptions` variable must narrow or omit its key property before forwarding to those methods. Authentication restrictions remain in effect. PHP retains its shared options constructor and runtime capability checks. Generated examples use the effective retry policy instead of disabling retries. Compatibility reports identify the type narrowing and flag changed retry behavior for review in both targets.

## Modular generated packages

Generated Node packages now include resource subpaths and split declaration files. Existing root imports, constructors, factories and method signatures remain supported. PHP emits individual class files and uses class-based Composer autoloading; direct includes of the historical `src/Runtime.php` and `src/Client.php` entry points retain a compatibility loader.

Heavy descriptors are decoded and validated on first use and shared across clients independently of credentials and transports. The first call can pay a dependency-loading cost. Package validation checks all descriptor groups before release. The PHP `contract.json` implementation artifact is replaced by descriptor groups; callers needing the complete plan can continue using `SchemaRegistry::contract()`.

Regenerate packages as a complete unit and refresh Composer autoload metadata on installation. Do not copy individual generated files between versions. Normal regeneration removes obsolete owned files and preserves handwritten helpers. Compiled compatibility snapshots retain their previous semantic representation.

## Migrating PHP entity representations

PHP response models now expose declared nested objects as generated entities. Lists contain typed entities and dictionaries are PHP arrays. For example, replace `$result->data->getData()->id` with `$result->data->getData()->getId()` for explicit typed access, and replace `$payment->getMetadata()->label` with `$payment->getMetadata()['label']`. Declared magic properties remain available and carry PHPDoc types.

Accessor names now split wire words: `getRequest_id()` and `hasRequest_id()` become `getRequestId()` and `hasRequestId()`. Numbered webhook classes such as `WebhookEvent0` are replaced by names derived from their configured event keys, such as `WebhookEventPaymentIntentSucceeded`. There are no deprecated naming aliases. Update imports and class-based dispatch using the regenerated package's class inventory; event insertion order no longer determines class identity.

`toArray()` and `jsonSerialize()` preserve raw normalized values instead of hydrated entities; `toInputArray()` and `toInputValue()` also preserve exact numeric kinds for reuse in requests. JSON dictionaries remain objects in model raw exports, including empty dictionaries. Explicit null and omitted fields remain distinct.

Regeneration records PHP representation changes and removed methods/classes as compatibility findings. Follow the existing breaking-release version policy; do not publish these changes as a compatible patch. Node wire behavior is unchanged.
