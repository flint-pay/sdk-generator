# Public SDK generator

Generate Node.js/TypeScript and PHP SDKs from an OpenAPI 3.0/3.1 JSON document and an SDK configuration file. Generated packages have no dependency on the generator or a hosted service.

## Install

Requirements:

- Node.js 22.16+ and npm for the generator. Generated SDK requirements are listed below.
- To generate and validate PHP output: PHP 8.2+ and Composer 2. Release archives also need PHP's ZIP support.

```sh
git clone https://github.com/flint-pay/sdk-generator.git
cd sdk-generator
npm ci
npm run build
```

Run every command from the repository root as `node dist/cli.js`. No published generator package or global TypeScript is needed; the generator pins TypeScript 5.9.3.

## Quickstart

```sh
node dist/cli.js diagnose examples/library.openapi.json examples/library.sdk.json
node dist/cli.js generate examples/library.openapi.json examples/library.sdk.json .generated/library
node dist/cli.js validate .generated/library
```

| Command    | Result                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------ |
| `diagnose` | Reports unsupported constructs and missing declarations. Writes nothing.                         |
| `generate` | Writes an npm package to `node/`, a Composer package to `php/`, and a private generation record. |
| `validate` | Checks package syntax, examples and metadata for each generated target.                          |

Commands print readable summaries by default. Automation that parses output must pass `--json`; JSON shapes are unchanged, and `effective` always prints JSON. Use `preview --diff` to review modified-file diffs. See [CLI output](docs/cli.md#output) for examples, streams and exit status.

The bundled example targets Node and PHP, so `validate` needs PHP and Composer. For Node only, copy `examples/library.sdk.json`, add `"targets": ["node"]`, and pass the copy to `generate`.

Keep `.generated/library/.sdk-generator.json`. It is private; regeneration and compatibility checks use it.

Start from your own OpenAPI JSON with `init`, then replace the placeholder names in the [SDK configuration](docs/configuration.md#minimal-configuration):

```sh
node dist/cli.js init openapi.json sdk.json
```

## Use the generated SDK

Node (Node.js 22+, ESM):

```sh
mkdir -p .generated/library-node-consumer
cd .generated/library-node-consumer
npm init -y
npm install ../library/node
```

Save as `example.mjs` and run `node example.mjs`:

```js
import { Client } from '@example/library';

const client = new Client({ baseUrl: 'https://api.example.com' }); // Your API server.
const book = await client.books.retrieve('book/123');
console.log(book.title);
```

PHP (PHP 8.2+ with the JSON and cURL extensions), starting from the repository root:

```sh
mkdir -p .generated/library-php-consumer
cd .generated/library-php-consumer
composer init --name=example/library-consumer --no-interaction
composer config repositories.library path ../library/php
composer require example/library:1.0.0
```

Save as `example.php` and run `php example.php`:

```php
<?php
require __DIR__ . '/vendor/autoload.php';

use Example\Library\{Client, ClientOptions};
$client = new Client(new ClientOptions(baseUrl: 'https://api.example.com'));
$result = $client->books->retrieve('book/123');
echo $result->getTitle();
$client->close();
```

The example API has no hosted server; set `baseUrl` to a server that implements it. `book/123` is sent as one escaped path segment. `books.retrieve` comes from the SDK configuration, not the operation ID or URL.

## Next steps

| Task                                                  | Guide                                                                 |
| ----------------------------------------------------- | --------------------------------------------------------------------- |
| Configure your own API, operations and capabilities   | [Configuration](docs/configuration.md)                                |
| Call, authenticate, handle errors, verify webhooks    | [Using generated SDKs](docs/using-sdks.md)                            |
| Run every command, or call the generator as a library | [CLI and library reference](docs/cli.md)                              |
| Test against expected HTTP behavior                   | [HTTP fixture format](docs/configuration.md#http-fixture-format)      |
| Check supported schemas and runtimes                  | [Support matrix](docs/support-matrix.md)                              |
| Prepare, publish and version packages                 | [Releases and compatibility](docs/releases.md)                        |
| See generator changes                                 | [Changelog](CHANGELOG.md)                                             |
| Understand or extend the implementation               | [Architecture](docs/architecture.md), [contributing](CONTRIBUTING.md) |
| Propose a change or decide whether to fork            | [Scope and maintenance](CONTRIBUTING.md#scope-and-maintenance)        |
| Report a vulnerability                                | [Security reporting](SECURITY.md)                                     |

## What you get

- Diagnostics that point at the contract or configuration location to fix. Unsupported constructs fail generation instead of degrading silently.
- Typed Node and PHP clients with exact integers and decimals, omitted-versus-null distinction, and tolerant decoding of unknown fields, enums and variants.
- Structured errors, deadlines, cancellation, bounded retries, idempotency, pagination, polling and HMAC webhook verification, each from explicit declarations.
- Deterministic regeneration, no-write previews, compatibility checks against the previous version, and release archives with documentation and a Composer repository.

Generator version `0.1.0` supports the subset in the [support matrix](docs/support-matrix.md). Generated packages carry their own configured versions. The bundled library and payment examples are synthetic; the test suite also runs pinned provider contracts.

## License

Generator code and bundled runtime code are Apache-2.0. Generated runtime code retains that license. Provider-owned definitions, names, examples and custom helpers retain their owners' rights; package metadata does not relicense them. See [licensing](docs/licensing.md).
