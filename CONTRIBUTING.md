# Contributing

Use Node.js 22+, PHP 8.2+ with curl/json/pdo_sqlite/zip, and Composer 2. The SQLite Node example tests require Node.js 22.16+.

```sh
npm ci
npm run check
npm test
```

Start with the [architecture](docs/architecture.md) and [support matrix](docs/support-matrix.md). The [CLI reference](docs/cli.md) describes source-checkout commands and library exports. `npm run build` produces the ignored `dist/` directory; `npm test` builds automatically. Generated package runtimes do not depend on a globally installed generator or TypeScript.

Tests generate packages in temporary directories, typecheck JS/TS consumer examples, install npm/Composer packages, exercise shared provider-style fixtures, verify signatures and durable duplicate handling, and call both default transports against a local HTTP server. They do not call a live payments provider. PHP and Composer are required; a missing target runtime is a test failure, not a skipped parity check.

When changing shared semantics, update both language runtimes and their common fixtures. Review expected HTTP values independently of generator output. New capabilities require diagnostics for incomplete declarations, documentation and negative scenarios. Keep generated output readable and deterministic. Do not check generated artifacts, real credentials or private provider definitions into this repository.

For bug reports, include generator/package/runtime versions, a minimal sanitized API/configuration example, the expected and observed wire behavior, and a request ID when safe. Explain whether the reproduction uses local fixtures, a sandbox or a live provider. Redact credentials and sensitive bodies.

The generator is pre-1.0 and has no paid support SLA. Support covers the published capability and runtime matrix. Record deprecations and breaking changes in release notes, with the effect on both targets described. A new language or provider capability starts from a concrete contract and its tests.

## Documentation and package checks

Update the [configuration guide](docs/configuration.md), [consumer guide](docs/using-sdks.md) and support matrix whenever public behavior changes. Package README/reference text is emitted from `src/generate.ts`; update that text too when the change affects generated consumers. Keep working notes, provider acceptance logs and local investigation artifacts out of public documentation and package contents.

```sh
npx prettier --check README.md CONTRIBUTING.md SECURITY.md docs tests/providers/flint/README.md
npm pack --dry-run
```

Use `npm run format` to format repository source and documentation, or target only the changed paths with Prettier. `npm pack --dry-run` builds and reports the generator's distribution contents. Its explicit allowlist includes runtime files, user documentation and generic examples; provider regression fixtures and local working directories are excluded.

Provider regression inputs live under `tests/providers/` in a source checkout. The Flint fixtures retain source provenance, explicit schema corrections, synthetic signing vectors and a manifest of schema/profile/HTTP-case hashes. Follow `tests/providers/flint/README.md` when updating them: independently verify expected behavior before refreshing hashes. Normal `npm test` uses bundled inputs and does not require Go, provider credentials or a provider checkout. These fixtures exercise shared behavior; provider-specific declarations stay in test profiles.

## Minimum-runtime container checks

For an isolated Node.js 22.16 / PHP 8.2 / Composer environment:

```sh
docker build -f tests/Dockerfile -t sdk-generator-minimum-test .
docker run --rm sdk-generator-minimum-test
```

The image copies the workspace inputs and runs the same suite, including generated package installs, HTTP fixtures, workflow recovery and local Composer repository publication. It does not mount or change your local dependencies. PHP 8.2 patch versions follow Debian's security updates; npm dependencies remain locked.
