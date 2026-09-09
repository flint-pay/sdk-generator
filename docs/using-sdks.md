# Using generated SDKs

Generate and install a package using the [README quickstart](../README.md#install-and-use-the-generated-packages). Each package contains its own `README.md`, `REFERENCE.md`, typed interfaces and operation examples. Public resource and method names come from the SDK configuration; these examples use the bundled library contract.

## Calls, inputs and results

Node.js and TypeScript share one ESM package. Use a `.mjs` file or a project with `"type": "module"`. TypeScript consumers use the included declarations with TypeScript 5.9+ and NodeNext module resolution. Generated npm packages install the pinned `@types/node` dependency required by their declarations.

```js
import { Client, SdkError } from '@example/library';

const client = new Client({
  baseUrl: 'https://your-api.example.com',
  timeoutMs: 10_000,
  deadlineMs: 30_000,
});

try {
  const result = await client.books.retrieve(
    { id: 'book/123' },
    { headers: { 'X-Tenant': 'tenant-example' }, maxAttempts: 1 },
  );
  console.log(result.data.title, result.meta.requestId);
} catch (error) {
  if (!(error instanceof SdkError)) throw error;
  console.error(error.kind, error.code, error.meta?.requestId, error.outcome);
}
```

PHP uses presence-aware input classes and a reusable client. Save this in a consumer with the generated Composer package installed:

```php
<?php
require __DIR__ . '/vendor/autoload.php';

use Example\Library\{Client, ClientOptions, RequestOptions, BooksRetrieveInput, SdkError};

$client = new Client(new ClientOptions(baseUrl: 'https://your-api.example.com'));
try {
  $result = $client->books->retrieve(
    new BooksRetrieveInput(['id' => 'book/123']),
    new RequestOptions(headers: ['X-Tenant' => 'tenant-example'], maxAttempts: 1),
  );
  echo $result->data->getTitle();
} catch (SdkError $error) {
  error_log($error->kind . ': ' . ($error->meta['requestId'] ?? 'no request ID'));
} finally {
  $client->close();
}
```

Set `baseUrl` to your API's base URL; these examples do not point to a hosted service. Its path prefix is retained when operation paths are appended, so avoid duplicating `/v1` if it is already present in the generated operation paths. Provide `token` through your application's credential source when the selected contract requires authentication. The SDK itself does not read environment variables or discover credentials.

Path, query and header parameters are properties of the operation input; a JSON request body is under `body`. Optional fields may be omitted. Explicit null is accepted only where nullable; it does not automatically mean the server will clear a value. PHP inputs use omitted array keys for omission and `['field' => null]` for explicit null. PHP models provide `has()` and `get()`; typed getters unwrap nested model values and throw for missing optional fields. In object/array alternatives, PHP lists (including `[]`) represent JSON arrays; use `(object) []` for an empty JSON object. Exact numeric enums accept equivalent spellings such as `1.0` and `1e0` for the value `1`, with membership checked at runtime.

An OpenAPI 3.1 schema with `properties` or `required` but no `type` does not by itself require an object. Generated TypeScript types preserve the permitted nonobject values; narrow such responses before accessing their fields. An enclosing object constraint in an `allOf` composition still applies to the same value.

PHP response classes include the response status in their names; tagged alternatives also include the branch position. Follow the package's migration notes when upgrading code that dispatches by class: adding a status can introduce a new return class even with an identical JSON shape, and reassigning an existing branch position requires a breaking release. Dispatching by the discriminator value also requires explicit handling of unknown tags.

`Result` contains `data`, `meta` and explicit raw response text in `raw`. Node accesses metadata with properties; PHP uses array keys. Metadata includes HTTP status, response headers, attempt count, duration and an optional provider request ID. Inspect unknown response enums or variants explicitly before treating them as a known successful business state.

Use strings for exact int64/uint64 and JSON `number` values, including decimals: `"9007199254740993"`, for example. The schema determines whether the string becomes an unquoted number token on the wire. Ordinary safe integers use native numbers/integers. Do not convert an exact amount to a floating-point number before handing it to the SDK.

Integer responses accept integral decimal and exponent notation: `1.0` becomes `1`, and `1e3` becomes `1000`. int64/uint64 results remain exact strings. Fractional values are rejected rather than rounded, and decimal fields retain their original precision. Node request arrays must contain an explicit value at every index; sparse arrays fail validation before dispatch.

## Schema-taking helpers

Generated methods and model factories use the codecs included in the package. Applications can also supply schemas directly to the existing helpers:

```js
import { serialize, Model, redact } from '@example/library';

const wire = serialize('9007199254740993', { type: 'integer', format: 'int64' });
// wire is the unquoted JSON token 9007199254740993.

const schema = {
  type: 'object',
  properties: { value: { type: 'string', 'x-sensitive': true } },
};
const model = new Model({ value: 'private value' }, schema);
console.log(redact(model.toJSON(), schema)); // { value: '[REDACTED]' }
```

These helpers run locally and use the package's value execution rules. PHP retains the schema-taking base `Model` constructor, `Codec::normalize` and `Codec::redact`. `Codec::encode` writes normalized values as JSON. No generator installation or schema registry service is required by either package.

For a null-only schema, use `type: 'null'`. The existing Node behavior for `type: ['null']` also permits non-null values; PHP rejects them. Nullable forms such as `type: ['string', 'null']` retain their declared non-null type in both targets.

## Client and request options

Pass client defaults to `new Client({...})` in Node or `new Client(new ClientOptions(...))` in PHP. Pass request overrides as the second method argument: a plain object in Node or `new RequestOptions(...)` in PHP.

| Option                    | Where             | Default and behavior                                                                                                               |
| ------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `baseUrl`                 | Client            | Required. HTTPS API base, without credentials, query or fragment.                                                                  |
| `token`                   | Client            | Absent. Used for the contract's selected bearer or header API-key scheme.                                                          |
| `allowedOrigins`          | Client            | Only the base URL origin. Applies to every destination, including pagination links.                                                |
| `allowInsecureHttp`       | Client            | `false`; enable only for deliberate local HTTP tests.                                                                              |
| `timeoutMs`               | Client or request | `10000`; positive duration per attempt, including response body consumption.                                                       |
| `deadlineMs`              | Client or request | `30000`; positive overall duration, not an absolute timestamp. Includes retry waits; pagination and polling share it across calls. |
| `maxAttempts`             | Client or request | The operation's declared limit, or `1` without a retry declaration. Overrides must be within the declared limit.                   |
| `transport`               | Client            | Native fetch in Node, reusable cURL in PHP. Injected transports are caller-owned.                                                  |
| `diagnostics`             | Client            | Optional callback receiving operation, attempt, status, request ID, timing and error kind, without bodies or credentials.          |
| `redactFields`            | Client            | Additional field names to redact in model inspection and parsed error details. Does not change response data.                      |
| `headers`                 | Request           | Request-local header map; includes tenant context and optional User-Agent override. A configured API-version pin takes precedence. |
| `idempotencyKey`          | Request           | Caller-owned stable key for a declared idempotent operation. Persist across retries and process restarts.                          |
| `ifMatch`                 | Request           | Value for the declared conditional header, including when that header is `If-None-Match`.                                          |
| `signal` / `cancellation` | Request           | Node `AbortSignal` / PHP `Cancellation` token. Stops local work, not a remote mutation.                                            |
| `maxPages`, `maxItems`    | Request           | Optional positive limits for generated iterators; the overall deadline always applies.                                             |

Request timeout, deadline and attempt settings take precedence over client defaults. Increasing `maxAttempts` cannot enable an undeclared retry policy. Avoid setting a client-wide retry count greater than the limit of any operation you call. No mutable client-wide tenant headers are shared between calls.

Node clients can serve concurrent calls within an event loop. PHP clients support sequential calls within one execution context; do not share a client concurrently across threads or fibers. Close PHP clients to release their owned cURL handle. Injected transports must honor cancellation/timeouts and disable their own redirects and retries; they receive credentials and bodies. Node clients expose no `close()` method: the default fetch pool belongs to the runtime, and a custom transport's cleanup belongs to its caller.

## Errors and recovery

Both targets expose `SdkError`. Node uses `code`, `cause` and `meta?.requestId`; PHP uses `errorCode`, `getPrevious()` and `$error->meta['requestId']`. Shared `kind` values are `transport`, `authentication`, `validation`, `rate_limit`, `api`, `conflict`, `protocol`, `cancelled`, `deadline` and `destination`. <!-- copy-ok: `cancelled` is the literal SdkError kind -->

| `outcome`  | Meaning for recovery                                                                                                                                      |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `not_sent` | The failing operation stopped before dispatch. Correct local input, authentication or destination settings as appropriate.                                |
| `response` | A response was received. Inspect status and provider error code; a response alone does not establish a successful business effect.                        |
| `unknown`  | The remote effect is uncertain. Reconcile with the provider, or recover using the same persisted idempotency key within its declared retention and scope. |

The SDK applies only declared bounded retries. `retryAllowed` reports retry eligibility; it does not grant permission to create a new business operation or exceed the provider policy. A lost response must not cause a fresh mutation with a different key. Automatic idempotency keys last for one SDK call; application resubmission requires a persisted caller key. Conflicting keys across operation headers, request headers and `idempotencyKey` fail before dispatch.

Ordinary error inspection and diagnostics omit sensitive bodies and credentials. `raw`, response headers, arbitrary `data` logging and injected transports require application-level handling of sensitive information.

## Optional capabilities

Only declared capabilities generate convenience methods. An operation named `list` with pagination exposes `listPages(input, options)` and `listItems(input, options)` on its resource. Node uses `for await ... of`; PHP uses `foreach`. Pages yield results with metadata; items yield individual values. Pagination is lazy, bounded by deadline and caller limits, and does not promise a stable snapshot.

A polling operation named `get` exposes `getWait(input, options)`. Unknown states keep waiting until a declared terminal state or deadline; canceling the waiter does not cancel the remote job. Conditional calls retain the declared header and surface conflicts without silently retrying an unconditional write.

When webhook verification is declared, use the generated `verifyWebhook` with original body bytes, signed headers and active rotation secrets. Verification alone does not deduplicate an event. The optional SQLite inbox/outbox examples demonstrate durable acknowledgement, transactional effects, current-state reconciliation and downstream idempotency. Applications supply the database, processing callbacks and retention policy. See [webhook configuration](configuration.md#declared-capabilities) and the generated examples for the selected signing format.

Keep handwritten domain helpers in the generated package's `custom/` directory so regeneration preserves them. See [architecture](architecture.md#extending-the-project) for imports and Composer autoloading.
