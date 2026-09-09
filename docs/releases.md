# Releases and compatibility

Generator releases and generated SDK package versions are independent. Generator 0.1.0 supports the subset in the [support matrix](support-matrix.md). Node and PHP outputs use the configured package version; API `info.version` and an optional pinned version header are separately documented. Preview versions use a SemVer prerelease suffix and npm's `next` tag in the release plan.

Release commands use the installed `sdk-generator` executable. From a source checkout, substitute `node dist/cli.js` after running `npm ci` and `npm run build`. See the [CLI reference](cli.md) for complete positional arguments. Package preparation and tests do not establish that a version has been published.

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

Adding a success status is breaking when it introduces an empty result where every previous result had a body, a body where all results were empty, or a provably incompatible simple result shape. A matching existing result shape retains a review finding for its HTTP semantics unless it introduces incompatible PHP classes as described below. The comparison includes declared 304 and default responses in the result possibilities. Inclusion between distinct result unions, composed schemas, recursive schemas, and schemas with typeless fields at any depth can still require manual review.

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

Version 2 private generation records save compiled contracts and runtime identities alongside source provenance and the original comparison baseline. Repeated compiled subtrees use validated shared references to keep large records bounded; this storage encoding preserves the complete logical plans. Regeneration preserves that baseline even if a generator-only change affects compatibility without changing generated files. Older records remain usable and retain explicit historical review findings; recompiling their schemas does not establish what an older runtime guaranteed. Unknown compiled formats or malformed records fail with diagnostics. Runtime implementation changes retain review even when compiled value guarantees are equal. Review findings retain the existing acknowledgment policy.

Changes inside `allOf`, `anyOf`, and `not` receive a generic `review` finding; the comparison does not recursively classify every nested constraint change. Other comparisons may still identify a breaking change, but a `review` finding alone does not block a patch release under `release.policy: "semver"` or require an explicit acknowledgment.

For example, with `validation: "schema"`, adding `minLength: 3` to a string input property inside an otherwise unchanged `allOf` branch can reject a previously valid one-character value while producing only a `review` finding. Review the nested constraints and choose the appropriate version increase manually before release. Successful release preparation does not establish that these changes are compatible.

Deferred improvements:

- Compare straightforward changes within otherwise unchanged `allOf` branches and classify provable input narrowing as breaking, accounting for the surrounding constraints.
- Retain `review` for reorganized branches, overlapping constraints, and alternatives whose compatibility cannot be determined safely.
- Consider requiring explicit acknowledgment of unresolved `review` findings during release preparation under the `semver` policy.

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
