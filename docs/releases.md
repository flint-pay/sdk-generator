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

## Version policy

Set `release.policy` in the SDK configuration:

- `review` (default): report compatibility findings in the preview, release plan and migration notes without enforcing a version increase.
- `semver`: when a prior package version is recorded, release preparation requires a newer version. Breaking findings require a new major version, or a new minor version before 1.0; additive findings require a new minor version unless the major version increases. A prior prerelease requires a newer version but can evolve before stabilization. Findings marked `review` still require provider judgment.

The generator compares against its recorded previous interface; preserve the private generation record across upgrades. On a fresh output directory, there is no earlier version to compare. A package-version bump does not change the API contract or pinned request version header.

Archive preparation checks generated file integrity. Keep private provenance records, API definitions and signing secrets out of distribution repositories. npm's explicit file allowlist includes `custom/`; review custom contents before publishing. No local test suite certifies a real provider's backend. Publication to multiple registries cannot be one atomic transaction; document any partial publication and recovery.

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
