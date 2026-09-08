# Public SDK generator

Generate portable Node.js/TypeScript and PHP SDKs locally from an OpenAPI 3.0/3.1 JSON definition and a separate SDK configuration. The generator is a TypeScript CLI and library. Generated packages have no dependency on the generator or on a hosted service.

Generator version `0.1.0` supports the [contract subset in the support matrix](docs/support-matrix.md). Generated packages carry their own configured versions. Every command runs from a source checkout and does not require a published generator package.

## Generate your first SDK

Use Node.js 22+ and npm. To validate PHP output, also install PHP 8.2+ and Composer 2; preparing PHP release archives requires ZIP support. Generated PHP clients require the JSON and cURL extensions. The generator pins TypeScript 5.9.3, so a global TypeScript installation is unnecessary.

From the repository root:

```sh
npm ci
npm run build
node dist/cli.js diagnose examples/library.openapi.json examples/library.sdk.json
node dist/cli.js preview examples/library.openapi.json examples/library.sdk.json .generated/library
node dist/cli.js generate examples/library.openapi.json examples/library.sdk.json .generated/library
node dist/cli.js validate .generated/library
node dist/cli.js release .generated/library .generated/releases/library-1.0.0
```

The output contains an npm package under `node/`, a Composer package under `php/`, and a **private** `.sdk-generator.json` record at the output root. Each package includes a README, API reference and operation examples. Keep the private record for regeneration. Preview does not write; release prepares archives, a documentation site and a publication plan. Choose a new release directory for each preparation.

To use your own API, replace the two example input paths with your local OpenAPI JSON and [SDK configuration](docs/configuration.md). Set `targets` to `["node"]` or `["php"]` to generate only one language. Run `diagnose` first to identify unsupported constructs or missing declarations.

## Install and use the generated packages

For a local Node consumer, run these commands from the repository root:

```sh
mkdir -p .generated/library-node-consumer
cd .generated/library-node-consumer
npm init -y
npm install ../releases/library-1.0.0/example-library-1.0.0.tgz
```

Save this as `example.mjs`. Replace the base URL with an API implementing the example library contract before running `node example.mjs`; the repository does not provide a hosted library API.

```js
import { Client } from '@example/library';
const client = new Client({ baseUrl: 'https://your-api.example.com' });
const { data, meta } = await client.books.retrieve({ id: 'book/123' });
console.log(data.title, meta.requestId);
```

For a local PHP consumer, start again from the repository root:

```sh
mkdir -p .generated/library-php-consumer
cd .generated/library-php-consumer
composer init --name=example/library-consumer --no-interaction
composer config repositories.library path ../library/php
composer require example/library:1.0.0
```

Save this as `example.php`, set the API base URL, and run `php example.php`:

```php
<?php
require __DIR__ . '/vendor/autoload.php';

use Example\Library\{Client, ClientOptions, BooksRetrieveInput};
$client = new Client(new ClientOptions(baseUrl: 'https://your-api.example.com'));
$result = $client->books->retrieve(new BooksRetrieveInput(['id' => 'book/123']));
echo $result->data->getTitle();
$client->close();
```

The wire path escapes `book/123` as a single path parameter. Resource and method names are independent of the upstream operation ID and URL.

Generated Node packages support Node.js 22+, ESM JavaScript and TypeScript 5.9+. PHP packages require no framework. Optional SQLite webhook examples require Node.js 22.16+ or PHP's `pdo_sqlite` extension. See [using generated SDKs](docs/using-sdks.md) for request options, errors and recovery, and [releases](docs/releases.md) for publishing and hosted Composer installation.

## What you get

- Diagnostics that point at the contract or configuration location that needs attention. Local references, explicit semantic overrides, naming, audience and operation selection, and automatic inclusion of the models a selected operation needs.
- Typed interfaces and examples in both targets. Exact integer and decimal encoding, a distinction between an omitted field and an explicit null, and responses that keep unknown fields, enum values and tagged alternatives instead of failing on them.
- Explicit credential destinations, per-request headers, structured errors, request metadata, redacted diagnostics, injectable transports, cancellation, deadlines, and retries and idempotency bounded by what the contract declares.
- Declared cursor, offset and link pagination, conditional requests, bounded polling, HMAC webhook verification and optional money conversion.
- Deterministic regeneration that detects hand edits, previews without writing, reports structural compatibility, validates packages, and prepares release archives, reference documentation and migration notes.
- Provider narrative guides, npm publication, and coordinated deployment of versioned documentation and a Composer repository with artifact checksums and immutable releases.
- Shared HTTP conformance fixtures, local HTTP transport tests, npm and Composer installation tests, and durable duplicate-event examples.

The [support matrix](docs/support-matrix.md) lists the exact supported subset and what is outside it. Unsupported constructs fail generation instead of silently degrading. The bundled library and payment examples are synthetic; the test suite also exercises pinned provider contracts.

## Validate against your provider's expected wire behavior

From the repository root:

```sh
node dist/cli.js generate tests/fixtures/payment-api.json tests/fixtures/payment-sdk.json .generated/payments
node dist/cli.js validate .generated/payments --fixtures tests/fixtures/http-cases.json
npm test
```

Write fixtures that state the expected wire behavior independently of the schema, and have the provider review them. The bundled synthetic scenarios test the generator; they do not prove server correctness. `validate --fixtures` runs the same request and response scenarios through both generated public clients without network access. Installation and package tooling may consult configured registries.

## Documentation

| Task                                             | Guide                                                                 |
| ------------------------------------------------ | --------------------------------------------------------------------- |
| Run or automate the generator                    | [CLI and library reference](docs/cli.md)                              |
| Select operations and configure capabilities     | [Configuration](docs/configuration.md)                                |
| Integrate a generated Node or PHP package        | [Using generated SDKs](docs/using-sdks.md)                            |
| Check supported schemas and runtime requirements | [Support matrix](docs/support-matrix.md)                              |
| Prepare, publish and upgrade packages            | [Releases and compatibility](docs/releases.md)                        |
| Understand or extend the implementation          | [Architecture](docs/architecture.md), [contributing](CONTRIBUTING.md) |
| Report vulnerabilities                           | [Security reporting](SECURITY.md)                                     |

## License

Generator code and bundled runtime code are Apache-2.0. Generated runtime code retains that license. Provider-owned definitions, names, examples and custom helpers retain their owners' rights; package metadata does not relicense them. See [licensing](docs/licensing.md).
