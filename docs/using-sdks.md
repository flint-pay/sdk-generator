# Using generated SDKs

Each generated package contains:

- `README.md`: a quickstart and short recipes.
- `REFERENCE.md`: a resource index linking to operation files under `reference/`.
- `MODELS.md`: a model index with descriptions, enums, units and constraints; large references split into `models/` files. Named responses and shared named request bodies link here for their canonical field tables. Collection item and map value enums are listed, including nested collections. TypeScript field comments and PHP getters carry the same information.
- `RUNTIME.md`: calling conventions, options, errors, retries, idempotency policies, pagination, webhooks and the authentication table for this SDK.
- `ERRORS.md`, when present: declared provider error-code values, linked from the runtime and model references.
- `llms.txt`: a small agent-oriented index.
- `examples/`: a runnable script for every operation.

Resource and method names come from the SDK configuration, or from matching OpenAPI tags and operation IDs. Examples below use the bundled library contract; see the [README](../README.md#use-the-generated-sdk) to generate and install it.

## Install

Node (one ESM package with TypeScript declarations):

- Node.js 22.3+ for ESM imports. Use a `.mjs` file or a project with `"type": "module"`.
- Node.js 22.12+ for CommonJS: `const { Client } = require('@example/library')`, including resource subpaths such as `require('@example/library/resources/books')`.
- TypeScript 5.9+ with NodeNext module resolution. Install `@types/node` 22.16.0+ matching your runtime as a development dependency, for example `npm install --save-dev @types/node@22`; older declarations can fail with TypeScript 5.9. Node types are an optional peer dependency, so JavaScript installs need no type packages.

PHP:

- PHP 8.2+ with ext-json and ext-curl. No framework is required.
- Load `vendor/autoload.php`; Composer loads SDK classes on demand.
- PHPDoc types target PHPStan 2.2+. PHPStan is development tooling, not a runtime requirement.

## Create a client

```js
import { Client } from '@example/library';

const client = new Client({ baseUrl: 'https://api.example.com', timeoutMs: 10_000 });
```

```php
<?php
require __DIR__ . '/vendor/autoload.php';

use Example\Library\{Client, ClientOptions, RequestOptions, SdkError};

$client = new Client(new ClientOptions(baseUrl: 'https://api.example.com'));
// ... make calls ...
$client->close();
```

- `baseUrl` defaults to the first top-level server the API declares. Pass it to choose another environment; it is required when the API declares no server.
- The base URL's path prefix is kept when operation paths are appended. Don't repeat `/v1` if operation paths already include it.
- HTTP URLs require `allowInsecureHttp: true`. This includes `http://localhost`, even for anonymous APIs. `allowedOrigins` still applies.
- A missing or malformed URL fails with a structured `baseUrl` validation error. Destination errors distinguish protocol failures from allowed-origin failures.
- SDKs with `auth.defaultCredentials` discover credentials lazily. Other SDKs require explicit credentials from your application's configuration.

Common client and request settings are listed under [client and request options](#client-and-request-options).

## Authenticate

The provider's configuration decides which options exist. The generated `RUNTIME.md` lists every mode and required credential key.

| Configuration                                 | Client option                                    |
| --------------------------------------------- | ------------------------------------------------ |
| One scheme (declared alone, or `auth.scheme`) | `token`                                          |
| Credential shortcut (`auth.shortcuts`)        | The configured name, such as `apiKey` or `token` |
| Named modes (`auth.modes`) without a shortcut | `credentials` keyed by mode and scheme           |

A shortcut selects its configured mode and credential. Pass it on the client, or on a request to override the client for that call:

```ts
const client = new Client({ baseUrl, apiKey: 'default-key' });
await client.orders.get(input, { apiKey: 'request-key' });
```

PHP uses named arguments: `new ClientOptions(baseUrl: $baseUrl, apiKey: $key)` or `new RequestOptions(apiKey: $key)`.

Explicit credentials work for every mode. Select the mode with `authMode` on the client or the request:

```js
const client = new Client({
  baseUrl,
  credentials: {
    merchant: { BearerAuth: merchantToken },
    checkout: { CheckoutId: checkoutId, CheckoutSecret: checkoutSecret },
  },
});
const result = await client.orders.get(input, { authMode: 'merchant' });
```

PHP accepts the same associative maps in `ClientOptions` and `RequestOptions`.

Rules:

- Request credentials and headers are request-local; request overrides never mutate the client.
- Per-request `credentials` contains only the selected mode's scheme keys.
- Use one shortcut per options object, and don't combine it with `authMode` or `credentials` in the same object.
- Composed clients reject `token` unless the provider maps it as a shortcut.
- TypeScript `AuthMode` and `Credentials` list the actual modes and scheme keys, and each operation limits request options to its permitted modes.
- Missing-credential errors name the scheme and mode without printing secret values.

### Credential providers

Every credential position accepts a nonempty string or a provider. The SDK resolves providers on every request attempt, so your application can refresh credentials without rebuilding the client.

Node exports the `CredentialProvider` type:

```ts
import { Client, type CredentialProvider } from '@example/library';

const provider: CredentialProvider = {
  async getCredential() {
    return { value: await loadApplicationToken() };
  },
  invalidate() {
    clearApplicationTokenCache();
  },
};
const client = new Client({ baseUrl, token: provider });
```

`getCredential()` returns `{ value: string; expiresAt?: Date }`. PHP exports `CredentialProvider` with `getCredential(): Credential`; construct the result as `new Credential($value, $expiresAt)`, where expiry is an optional `DateTimeInterface`. PHP also accepts a `Closure` returning a string or `Credential`:

```php
$client = new Client(
  new ClientOptions(
    baseUrl: $baseUrl,
    token: fn(): Credential => new Credential(loadApplicationToken()),
  ),
);
```

Import `Client`, `ClientOptions` and `Credential` from your generated package namespace. The application owns token loading, caching and expiry handling; `expiresAt` is metadata and does not schedule SDK refreshes.

On HTTP 401, a replay-safe request using a provider with a public `invalidate(): void` method invalidates the provider and retries once with a newly resolved credential. This adds at most one attempt to the ordinary retry budget, including when `maxAttempts` is 1, and keeps the same idempotency key. Mutations still require a declared idempotency key to replay. String credentials, closures and providers without `invalidate` never trigger this refresh retry; further 401s are surfaced immediately. Provider failures surface as authentication errors with a fixed message and no original exception, to keep secret values out of errors. Empty and malformed values use the same validation errors as string credentials.

### Default credentials

When the provider declares `auth.defaultCredentials`, a client without explicit credentials tries the configured API key and access token environment variables (both set is `ambiguous_credentials`), then workload identity only when its configured ID variable is set. Discovery runs only when no credential option is passed on the client or request. Passing a shortcut or credential-map entry as `undefined` (Node), `null`, empty or blank throws `ConfigurationError` with code `credential_missing`, `outcome: "not_sent"` and `param` naming the option. Client options fail during construction; request options fail when the call starts. A request credential replaces the client credential for that call. Anonymous operations do not discover credentials. Use `ambientCredentials: false` for applications that must never use the process's identity implicitly.

```js
import { Client, defaultCredentials, workloadIdentityCredentials } from 'example-sdk';
const ambient = new Client();
const isolated = new Client({ apiKey: tenant.flintKey, ambientCredentials: false });
const explicit = new Client({
  apiKey: workloadIdentityCredentials({
    workloadIdentityId: 'wid_example',
    source: 'token_file',
    audience: 'https://api.example.com',
    scope: 'records.read',
  }),
});
// defaultCredentials() can also be passed wherever a credential provider is accepted.
```

```php
use Example\Sdk\{Client, ClientOptions};
use function Example\Sdk\{defaultCredentials, workloadIdentityCredentials};
$ambient = new Client(new ClientOptions());
$isolated = new Client(new ClientOptions(apiKey: $tenant->flintKey, ambientCredentials: false));
$explicit = new Client(
  new ClientOptions(
    apiKey: workloadIdentityCredentials([
      'workloadIdentityId' => 'wid_example',
      'source' => 'token_file',
      'audience' => 'https://api.example.com',
      'scope' => 'records.read',
    ]),
  ),
);
```

Option and namespace names in these snippets depend on the generated package. The explicit workload identity provider uses the configured token environment variable or file; its ID, source, audience and scope options override the corresponding environment values. `defaultCredentials()` uses the complete chain. Exported providers receive the client's actual base URL and transport, including per-request deadlines. Calling a provider directly uses the generated default base URL and default transport.

With `envPrefix: "EXAMPLE"`, set `EXAMPLE_WORKLOAD_IDENTITY_ID` plus `EXAMPLE_OIDC_TOKEN` or `EXAMPLE_OIDC_TOKEN_FILE`. Optional `EXAMPLE_OIDC_SOURCE` selects `auto`, `none`, `token`, `token_file`, or `github_actions`; `auto` prefers the token environment variable, then a configured token file, then GitHub Actions when `GITHUB_ACTIONS=true`. GitHub jobs need `permissions: id-token: write`; the SDK requests the configured audience from the GitHub identity endpoint. `EXAMPLE_OIDC_AUDIENCE` defaults to the base URL's origin, and `EXAMPLE_OIDC_SCOPE` narrows the requested permissions. Token files are reread on every exchange. No cloud metadata, other CI endpoint, other service's token file, or CLI session is consulted.

The SDK checks the unverified subject JWT's audience and expiry before sending it. The server verifies its signature and trust conditions. Token exchange uses the configured path on the base origin, HTTPS or loopback only, with redirects disabled. Transient HTTP 429 and 5xx responses retry up to three attempts, respecting Retry-After and the request deadline.

The process cache separates base origin, workload identity ID, audience, scope, and source. It refreshes when less than `max(60 seconds, 20% of lifetime)` remains and never uses a token with 30 seconds or less remaining. Subject expiry also caps the cached lifetime. A transient refresh failure can use the previous token only above that 30-second boundary. Node coalesces simultaneous exchanges across clients; PHP clients share a static process cache and in-flight state. A Fiber scheduler must resume waiting Fibers when the exchange finishes or their own deadline or cancellation is reached; each waiter yields its monotonic `deadline` in milliseconds and `cancellation` token to the scheduler. A stopped waiter leaves the owner's exchange running. A replay-safe HTTP 401 invalidates only the rejected token's cache partition and re-exchanges once, using the credential-provider retry policy above. A late 401 cannot invalidate a newer token.

PHP `ClientOptions(credentialCache: $cache)` accepts a PSR-16 compatible object implementing `get`, `set`, and `delete`. APCu-backed implementations can share tokens between requests; protect the cache as a credential store. The SDK's static cache coordinates one process; cross-process locking is the cache implementation's responsibility.

Failures are `ConfigurationError` with `code` in both targets: `no_credentials`, `ambiguous_credentials`, `source_unavailable`, `subject_token_request_failed`, `audience_mismatch`, `exchange_rejected`, or `exchange_unavailable`. Safe messages and `workloadIdentity` identify the source, workload identity ID, JWT issuer/subject/audience, and server error description when available. Subject and access token values are redacted. Injected transports are a privileged boundary and necessarily receive tokens; avoid logging their headers or bodies.

## Make a call

### Arguments

The generated reference records the selected calling convention. With `requests.style: "object"`, pass one object with path/query/header fields and a `body` member, followed by request options, for example `client.books.retrieve({ id: 'book_placeholder' }, options)`. The generator default remains positional unless the provider overrides it:

Positional argument order is the same in Node and PHP:

1. Path values, in URL order.
2. A params object (Node) or array (PHP) holding body fields and query/header parameters. There is no `body` wrapper. Omit this argument when the operation has no body and no query/header parameters.
3. Request options: a plain object in Node, `new RequestOptions(...)` in PHP.

```js
const book = await client.books.retrieve('book/123', { headers: { 'X-Tenant': 'tenant-example' } });
```

```php
$book = $client->books->retrieve(
  'book/123',
  new RequestOptions(headers: ['X-Tenant' => 'tenant-example']),
);
```

Headers supplied by an operation's permitted authentication modes and the configured API-version header are omitted from its inputs; pass credentials through [authentication](#authenticate) options. Anonymous operations and operations whose modes never supply a declared header retain that input field. Credential headers are validated by their wire representation before dispatch.

Declared idempotency, conditional and request-ID headers retain input fields and their declared requiredness is enforced before dispatch. Idempotency and conditional inputs may be omitted when their effective values come from request options or automatic idempotency keys. A required request-ID header remains a required input.

With `requests.style: "object"`, methods take one input object with path/query/header fields and a `body` field, then options. See [request arguments](configuration.md#request-arguments) for empty and optional bodies.

### Results

| Method                       | Returns                                                                |
| ---------------------------- | ---------------------------------------------------------------------- |
| `create(...)` (payload mode) | The decoded body, or the configured payload inside it. No SDK wrapper. |
| `createWithResponse(...)`    | `SdkResponse` with the full decoded `body`, HTTP `meta` and `raw`.     |
| Any method in result mode    | `Result` with `data` (full decoded body), `meta` and `raw`.            |

- Each invocation sends its own request. Choose one form per action.
- The provider selects payload paths and result mode, per SDK or per operation. Check the generated reference for each operation's mode, and follow the provider's migration notes when it changes.
- In result mode, a provider `data` envelope stays inside `data`: use `result.data.data` (PHP `$result->data->data`). Nesting is endpoint-specific; follow the operation example.
- `meta` holds the HTTP status, response headers, attempt count, duration and an optional provider request ID. Node reads it with properties, PHP with array keys.
- Check unknown response enums and variants before treating a result as a known successful business state.

### Omitted and null values

- Optional fields may be omitted.
- Explicit null is accepted only where the field is nullable. It does not mean the server clears a value.
- PHP inputs omit an array key for omission and use `['field' => null]` for explicit null.
- PHP models provide `has()`, presence methods such as `hasDescription()`, and `get()`. Response getters, `get()` and magic properties return null for an omitted optional field, with nullable accessor types. `has()` distinguishes omission from present-null. Missing required fields fail during response decoding with `UnexpectedResponseError`; unknown property names fail with a validation error. Omitted input fields still throw when read.
- PHP `valueOrDefault('description', 'fallback')` returns the fallback only when the field is omitted; explicit null stays null. Its name avoids the `getField()` namespace, so a wire field such as `orDefault` keeps its `getOrDefault()` getter.
- With `validation: "schema"`, object property bounds count encoded keys, including explicit nulls and additional properties, but not omitted optional fields. Response decoding stays tolerant of these business bounds.

## Errors and retries

PHP keeps `OUTCOME_NOT_SENT`, `OUTCOME_RESPONSE` and `OUTCOME_UNKNOWN`. Both `$e->code` and `$e->getCode()` return the string error code; `$e->status` carries the HTTP status. Messages are preserved verbatim; `__toString()` adds status, code and request ID for logs.

Every error after a call resolves an idempotency key exposes `error.idempotencyKey` (Node) or `$error->idempotencyKey` (PHP), including validation and cancellation before sending. `WithResponse` results expose `meta.idempotencyKey` (PHP: `$result->meta['idempotencyKey']`). Keys are included in error inspection. Persist your key across process restarts and application resubmissions; automatically generated UUID v4 keys, including any configured prefix, last for one SDK call and are reused on every attempt.

When an operation requires a header and has automatic keys disabled, TypeScript requires the options argument with `idempotencyKey: string`; PHP throws a `validation` error with `outcome: "not_sent"` before dispatch if the key is missing. Save the key with the action before the first attempt.

```ts
await client.refunds.create(params, { idempotencyKey: refundJob.idempotencyKey });
```

Providers may configure `errors.retry` to select a string in the error body, such as `error.remediation.retry`. A string signal overrides status and code rules; only configured retry values (for example `same_request`) retry. `after_refresh`, `none` and unknown strings stop immediately. Without a string signal, configured statuses apply; without body-driven configuration, existing status/code rules apply. HTTP 412 never retries. All retry signals still require a replay-safe operation and remain bounded by its attempt limit. Cancellation never retries, while per-attempt timeouts after sending may retry with the same key.

Backoff waits uniformly between half and all of the exponential delay, capped by optional `retry.maxDelayMs`. `Retry-After` is a minimum wait. If a wait would reach the overall call deadline, the last error comes back unchanged, including its class, code, status and details. Its optional `retryAfterMs` records the valid server wait in milliseconds. An attempt cut off mid-flight by the overall deadline still raises `TimeoutError`.

```js
import { SdkError, errors } from '@example/library';

try {
  const result = await client.books.retrieveWithResponse('book/123');
  console.log(result.body.title, result.meta.requestId);
} catch (error) {
  if (!(error instanceof SdkError)) throw error;
  if (error instanceof errors.NotFoundError) {
    console.error('The requested book was not found.');
  }
  console.error(
    error.message,
    error.status,
    error.name,
    error.code,
    error.requestId,
    error.outcome,
  );
}
```

```php
use Example\Library\SdkError;
use Example\Library\Errors\NotFoundError;

try {
  echo $client->books->retrieve('book/123')->getTitle();
} catch (NotFoundError $error) {
  error_log('The requested book was not found.');
} catch (SdkError $error) {
  error_log(
    $error->getMessage() .
      ' status=' .
      ($error->status ?? 'none') .
      ' request=' .
      ($error->requestId ?? 'no request ID'),
  );
}
```

| Field         | Node                    | PHP                 |
| ------------- | ----------------------- | ------------------- |
| Provider code | `code`                  | `code`              |
| Cause         | `cause`                 | `getPrevious()`     |
| Request ID    | `requestId`             | `$error->requestId` |
| HTTP status   | `status` or `undefined` | `status` or `null`  |

Node `SdkError.code` uses the schema’s known string codes plus an open string alternative. `errors.ApiError.details` uses the configured error schema plus runtime failure details; narrow the shape before reading a field. Projected details are validated against their declared shapes even when the envelope is a future alternative. Narrowed integer-string fields require canonical decimal spelling: `+1`, `01`, `-01` and trailing whitespace are rejected. Invalid success payloads raise a protocol error with `raw` retained. Malformed API details, or redacted details that no longer fit the schema, are `undefined`; explicit `raw` access remains available for recovery.

All errors extend `SdkError`. Node exports subclasses through `errors` at the package root and resource subpaths; PHP subclasses live in `Example\\Library\\Errors`. API subclasses extend `ApiError` and follow HTTP status alone, never the code. `TimeoutError` extends `ConnectionError`. Other local classes extend `SdkError` directly. Node names survive minification.

| Status or trigger                   | Class                      |
| ----------------------------------- | -------------------------- |
| 400, 422                            | `InvalidRequestError`      |
| 401                                 | `AuthenticationError`      |
| 403                                 | `PermissionError`          |
| 404                                 | `NotFoundError`            |
| 409, 412                            | `ConflictError`            |
| 429                                 | `RateLimitError`           |
| 500–599                             | `ServerError`              |
| Other 4xx                           | `ApiError`                 |
| No usable response                  | `ConnectionError`          |
| Attempt timeout or deadline         | `TimeoutError`             |
| Invalid input                       | `InvalidInputError`        |
| Options, credentials or destination | `ConfigurationError`       |
| Cancellation                        | `CancelledError`           |
| Unusable success                    | `UnexpectedResponseError`  |
| Webhook verification                | `WebhookVerificationError` |
| Pagination limit                    | `PaginationLimitError`     |

Construct errors with a message and an init object in Node, or named arguments in PHP. Request context is available directly as `operation`, `outcome`, `retryAllowed`, `status`, `requestId`, `requestIds`, `idempotencyKey`, `attempts`, `durationMs`, `retryAfterMs` and `headers`. Error `kind` and `meta` are removed. `headers` and `raw` stay out of inspection; use them explicitly with application redaction.

Messages and codes:

- The message is the nonempty JSON string at the configured `errors.messagePath` (default `message`), after redaction. Absent, blank or non-string values fall back to `API returned HTTP <status>`.
- Error paths traverse JSON objects and array indices; scalar values have no child fields.
- Messages and provider codes must be JSON strings. Numeric tokens, including decimal, exponent and large-integer values, never become messages or codes and never match string retry codes. Parsed details keep their exact numeric representation.
- Public codes are redacted; code-based retry matching uses the original string at `errors.codePath`.
- Malformed or non-JSON error bodies keep status, metadata and explicit `raw` access.
- Provider `details` use the declared schema type when available, otherwise `unknown` in TypeScript. Details are optional: incompatible fields, including collisions with other declared error or runtime-detail shapes, produce `undefined`; `raw` retains the body. Narrow details before reading their fields.

| `outcome`  | Meaning for recovery                                                                                                                                      |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `not_sent` | The operation stopped before dispatch. Correct local input, authentication or destination settings.                                                       |
| `response` | A response was received. Inspect status and provider code; a response alone does not establish a successful business effect.                              |
| `unknown`  | The remote effect is uncertain. Reconcile with the provider, or recover using the same persisted idempotency key within its declared retention and scope. |

Per-attempt timeouts use `timeout`; overall deadlines use `deadline` and never allow retries. Refused connections and DNS failures use `transport` with `outcome: "not_sent"`. Node exposes the native code in `details.transportCode`; PHP exposes a cURL number and safe description in `details['curlCode']` and `details['curlError']`. PHP transport failures without an HTTP response use `null` for both `status` and `meta['status']`.

Retries:

- Without an operation policy, GET/HEAD/OPTIONS make up to three attempts for transport failures and HTTP 408, 429, 500, 502, 503 and 504, with exponential jitter from a 100 ms base and `Retry-After` support. Other methods send once.
- Explicit provider policies replace these defaults.
- Mutations retry only with declared retry and idempotency support and a valid key. Without an optional key they send once; required keys stay required.
- TypeScript exposes `idempotencyKey` only on supported operations. PHP's shared `RequestOptions` rejects unsupported keys at runtime.
- Conflicting keys across operation headers, request headers and `idempotencyKey` fail before dispatch.
- Automatic idempotency keys last for one SDK call. Persist a caller key for application resubmission. After a lost response, never send a fresh mutation with a different key.
- `Retry-After` accepts nonnegative decimal seconds with optional surrounding spaces/tabs, or a canonical GMT HTTP date such as `Wed, 21 Oct 2015 07:28:00 GMT`. Signed numbers, exponent notation, relative dates and malformed dates are ignored in both targets.
- `retryAllowed` reports retry eligibility. It does not authorize a new business operation or exceed the provider policy.

Sensitive data:

- Error inspection shows the message, status, provider code, redacted details and stack frames. Messages, codes and details apply schema and `redactFields` redaction.
- Error JSON serialization and native crash rendering omit raw bodies, headers, URLs and unsanitized causes. Explicit `raw`, `meta` and cause access remain available. PHP debug and exception traces omit call arguments.
- Diagnostics callbacks get status and class, without messages, details or stack traces.
- `raw`, response headers, arbitrary `data` logging and injected transports need application-level handling of sensitive information.

For responses that fail schema decoding, see [schema drift](#successful-http-responses-and-schema-drift).

## Pagination and polling

Only declared capabilities generate these helpers. For a paginated operation named `list`:

| Helper                       | Yields                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------ |
| `listPages(input, options)`  | Pages with the same payload as `list`, or full `Result` values in result mode. |
| `listPagesWithResponse(...)` | Payload mode only: `SdkResponse` pages with `body`, `meta` and `raw`.          |
| `listItems(input, options)`  | Individual items.                                                              |

Use `for await ... of` in Node and `foreach` in PHP. For a list payload containing `data`, read `page.data`; the response form reads `page.body.data` (PHP `$page->body->data`).

- Iteration is lazy and defaults to at most 1,000 pages. Set `maxPages` to change that cap; reaching it ends iteration. `maxItems` and cancellation provide additional bounds.
- Repeated continuations, including longer cursor cycles, raise a protocol error. Two consecutive empty pages with continuations also raise a protocol error; isolated and terminal empty pages remain valid.
- Each page request gets a fresh `deadlineMs` budget for its retries and decoding. Time spent processing yielded values doesn't count, and there is no overall iterator deadline.
- Pagination does not promise a stable snapshot.

For a polling operation named `get`, `getWait(input, options)` returns the same payload as `get` (a full `Result` in result mode). Payload-mode `getWaitWithResponse` returns the complete body and HTTP metadata.

- Both evaluate states against the original provider body.
- Unknown states keep waiting until a declared terminal state or the deadline, which covers the whole wait.
- Canceling the waiter does not cancel the remote job.

Conditional calls send the declared precondition header and surface conflicts without retrying an unconditional write.

## Webhook verification

### JWT deliveries

Providers declaring `webhook.jwt` support per-delivery ES256 JWTs without a shared secret. In Node, use `verifyWebhookAsync(rawBody, headers, options)` from the package root or `webhooks` subpath, or `client.verifyWebhookAsync`. PHP provides `Webhooks::verifyDelivery($rawBody, $headers, $options)` and `$client->verifyWebhookDelivery`. Both return the existing verified result plus `signingMethod: 'jwt' | 'hmac'` in Node or `signing_method` in PHP.

Supply your receiving endpoint ID, such as `whep_example` or `dcb_example`. This is the webhook endpoint's ID, not the event ID. The trusted issuer comes from the declared literal issuer or the configured API base URL's origin, without a trailing slash. Never derive it from the token. Standalone verification with `issuer: "baseUrl"` requires `baseUrl` (PHP `base_url`); the client methods default it from their client. Node also defaults `fetch` from the client's `transport`.

Register Express raw middleware before JSON middleware. Persist the delivery before acknowledging it:

```js
import { verifyWebhookAsync } from '@example/payments/webhooks';

app.post('/webhooks', express.raw({ type: 'application/json' }), async (req, res, next) => {
  try {
    const verified = await verifyWebhookAsync(req.body, req.headers, {
      endpointIds: ['whep_example'],
      baseUrl: 'https://api.withflintpay.com',
    });
    await receiveVerified(verified, req, res, next);
  } catch (error) {
    next(error);
  }
});
app.use(express.json());
```

```php
use Example\Payments\Webhooks;

// $cache is your application's PSR-16 cache; see key caching below.
$verified = Webhooks::verifyDelivery(file_get_contents('php://input'), getallheaders(), [
  'endpoint_ids' => ['whep_example'],
  'base_url' => 'https://api.withflintpay.com',
  'cache' => $cache,
]);
// Persist the delivery and durable work before acknowledging it.
```

Apache does not pass the `Authorization` header to PHP-FPM or CGI by default. Enable `CGIPassAuth On` (Apache 2.4.13 and later) for the webhook route, or copy the header with `RewriteRule .* - [E=HTTP_AUTHORIZATION:%{HTTP:Authorization}]`. Without it, JWT deliveries fail with `webhook_missing_header`.

Node options are `endpointIds?: string | string[]`, `secrets?: string | string[]`, `jwks?: { keys: object[] }`, `baseUrl?: string`, `fetch?: typeof fetch`, and `nowSeconds?: number`. PHP uses `endpoint_ids`, `secrets`, `jwks`, `base_url`, and `now_seconds`, with optional `cache` (PSR-16), `http_client` (PSR-18), and `request_factory` (PSR-17). Supply at least one of endpoint IDs or secrets. PHP requires `ext-openssl` for JWT verification. PSR packages are optional Composer suggestions; supplying a PSR HTTP client also requires a request factory. Without one, PHP uses the SDK transport. The receiver owns injected transports and must configure PSR clients with a timeout of at most five seconds and redirects disabled; PSR-18 has no portable timeout or redirect setting.

If a bearer token is present and endpoint IDs are supplied, JWT alone decides. Invalid JWTs never fall back to HMAC. Otherwise, secrets and all declared HMAC headers select HMAC; missing headers produce `webhook_missing_header`. Existing synchronous `verifyWebhook` (PHP `Webhooks::verify`) remains HMAC-only. During migration, pass both endpoint IDs and secrets to the new verifier.

Verification matches Flint's reference verifier. The protected header must contain exactly `alg: "ES256"`, a nonempty `kid`, and the declared `typ`, so `crit`, token-supplied `jku`, `x5u`, `jwk`, and `x5c`, and every other header member are rejected. Header and claims must be JSON objects without duplicate member names. Claims require the exact declared issuer, a string `aud` matching a supplied endpoint ID, integer `iat` and `exp`, a `jti` that is not blank, and the body hash claim. A `sub` claim is rejected; other claims are ignored. Verification checks the signature and `iat`/`exp` with the declared lifetime and leeway, a hard maximum lifetime of 300 seconds, and at most 60 seconds leeway, and compares the SHA-256 of the exact body bytes in constant time. It parses the body as JSON only after authentication. Application storage still owns replay and duplicate handling.

Keys come from `<trusted issuer>/.well-known/jwks.json` (or the declared path). The JWKS must be a JSON object with a `keys` array whose entries are objects with a string `kid`. Keys with other IDs are ignored, whatever their type, so a shared key set can also publish RSA, OKP, or encryption keys. The key selected by `kid` must be unique and be an EC P-256 key whose `alg` is absent or `ES256` and whose `use` is absent or `sig`. A malformed fetched set, or one in which the token's `kid` names more than one key, produces `webhook_jwks_unavailable`; for an explicit `jwks`, these produce `webhook_invalid_input`. A `kid` naming exactly one unusable key produces `webhook_invalid_token`, never an outage code, so forged tokens cannot cause 5xx responses. An explicit `jwks` bypasses HTTP and caching entirely, useful for pinned keys and deterministic tests.

The key cache shares one in-flight fetch per URL; PHP Fiber waiters yield their monotonic `deadline` in milliseconds and a `cancellation` of `null`, and the application's scheduler must resume them. TTL follows `Cache-Control: max-age`, clamped to five minutes through 24 hours, with 15 minutes by default. Unknown keys trigger at most one refresh per minute per URL. When a refresh fails, verification uses the previously fetched set for up to 24 hours after its successful fetch and retries at most once a minute meanwhile. Requests have a five-second timeout and a 256 KiB response limit.

Node keeps one cache per process. PHP keeps its key cache in the supplied PSR-16 `cache`; without one, it uses APCu when the extension is loaded and enabled (`apcu_enabled()`), and otherwise a static cache that lasts only as long as the PHP process. Under PHP-FPM, pass `cache` or enable APCu: a per-process cache refetches keys in every worker and cannot enforce the refresh limits or stale-key reuse across requests, so forged tokens could push your server's address into the provider's JWKS rate limit. Treat the PSR-16 cache or APCu as a trust store. Anyone who can write to it can inject verification keys, so do not share it with untrusted code or tenants. APCu is shared by every pool under the same PHP-FPM master, so deployments hosting mutually untrusted applications under one master should pass their own `cache`. Shared entries with implausible future times are ignored. Single-flight is per process, since neither PSR-16 nor APCu entries supply an atomic locking operation here.

Answer **5xx** for `webhook_jwks_unavailable` so the provider retries. Do not acknowledge an unverified delivery during a key-service outage. Treat signature, audience, time and body failures as authentication failures; log only error kind and code.

### HMAC deliveries

Node verification accepts original `Buffer`, `Uint8Array` and `ArrayBuffer` bytes. Pass `nowSeconds` in seconds; millisecond-scale values raise an input error explaining the conversion.

Packages with webhook verification declared expose a standalone verifier through the `webhooks` subpath, which loads webhook codecs without operation descriptors. The root `verifyWebhook` export and client method remain available. It requires no client options, base URL or API credentials; the client method delegates to the same verification implementation.

```js
import { verifyWebhook } from '@example/payments/webhooks';
const verified = verifyWebhook(rawBody, headers, [currentSecret, previousSecret]);
if (!verified.known) console.log(verified.reason);
```

```php
use Example\Payments\Webhooks;

$verified = Webhooks::verify($rawBody, $headers, [$currentSecret, $previousSecret]);
if (!$verified['known']) {
  error_log($verified['reason']);
}
```

PHP's `Webhooks::verify(mixed $rawBody, mixed $headers, mixed $secrets, mixed $nowSeconds = null): array` validates argument types through the SDK guards. Invalid inputs throw `Errors\InvalidInputError`, signature failures throw `Errors\AuthenticationError`, and authenticated invalid JSON throws `Errors\UnexpectedResponseError`.

If a generated model is named `Webhooks` (case insensitive), PHP keeps the model name and omits the standalone verifier class. Use `$client->verifyWebhook($rawBody, $headers, $secrets)` in that package. Node's standalone `verifyWebhook` remains available.

When the provider declares signing, the client exposes `verifyWebhook(rawBody, headers, secrets, nowSeconds?)`.

- `rawBody`: the original request bytes, before JSON parsing.
- `headers`: the request headers. Names are case insensitive.
- `secrets`: one webhook signing secret, or an array of active rotation secrets such as `[currentSecret, previousSecret]`. Use a separate secret from application configuration.
- `nowSeconds`: a Unix timestamp override for deterministic tests. Normally omit it.

Node accepts `Buffer`/`Uint8Array` bodies, Express/Node `req.headers` and Fetch `Headers`. Plain strings and parsed objects are rejected. For a Fetch request:

```js
const rawBody = new Uint8Array(await request.arrayBuffer());
const verified = client.verifyWebhook(rawBody, request.headers, webhookSecret);
```

Register an Express webhook route **before** JSON middleware. `receiveVerified` represents your application's durable ingestion handler:

```js
app.post('/webhooks', express.raw({ type: 'application/json' }), (req, res, next) => {
  try {
    const verified = client.verifyWebhook(req.body, req.headers, webhookSecret);
    // Persist the event ID, event, and known flag before acknowledging delivery.
    receiveVerified(verified, req, res, next);
  } catch (error) {
    next(error);
  }
});
app.use(express.json());
```

PHP accepts binary-safe body strings and header maps with strings or PSR-7 string arrays:

```php
$verified = $client->verifyWebhook(
  (string) $request->getBody(),
  $request->getHeaders(),
  $webhookSecret,
);
// A native PHP handler can instead use file_get_contents('php://input') and getallheaders().
```

Never rebuild the body with `JSON.stringify` or `json_encode`. Whitespace, property order and numeric spelling change the bytes and cause a signature mismatch. A mismatch cannot tell whether the secret or the body is wrong.

`known` requires a registered event name and a matching declared envelope. Checking it narrows the Node event type; then switch on the event-name field. For an illustrative provider using `event_type`:

```ts
import type {
  VerifiedWebhook,
  KnownWebhookEvent,
  WebhookEventPaymentIntentSucceeded,
} from '@example/provider-sdk';

function handleSucceeded(event: WebhookEventPaymentIntentSucceeded): void {
  // Persist and process event.data idempotently.
}

const verified: VerifiedWebhook = client.verifyWebhook(rawBody, headers, [
  currentSecret,
  previousSecret,
]);
if (verified.known) {
  const event: KnownWebhookEvent = verified.event;
  if (event.event_type === 'payment_intent.succeeded') handleSucceeded(event);
} else {
  const event = verified.event; // unknown: validate before accessing fields.
}
```

Node exports `VerifiedWebhook`, `KnownWebhookEvent` and one `WebhookEvent<EventName>` type per declared event from the package root and the `webhooks` subpath. Per-event types use the PHP event naming rule: `payment_intent.succeeded` becomes `WebhookEventPaymentIntentSucceeded`. Names match where PHP emits an event class; multi-variant events have a named Node union without a corresponding PHP event class. These types are unavailable from `resources/*`; `KnownWebhookEvent` is `never` when no events are declared.

Use indexed access for payload annotations, for example `type SucceededPayload = WebhookEventPaymentIntentSucceeded['data']`. A top-level `typeField` supports exhaustive `switch` narrowing with a `never` default. For a dotted path such as `meta.name`, annotate a handler with the named event type or use `Extract<KnownWebhookEvent, { meta: { name: 'payment_intent.succeeded' } }>`.

- Authenticated unknown names return `known: false` with `reason: "unknown_event"`; declared names whose payload matches no envelope use `reason: "unmatched_envelope"`. PHP uses the same `reason` array key. Known deliveries have no `reason`. Keep unrecognized deliveries for review.
- Malformed declared payloads produce a `protocol` error.
- `known` does not make future nested enums or variants statically known.

Secret and header rules:

- Standard Webhooks secrets start with `whsec_` and contain canonical base64 for exactly 32 bytes.
- Invalid or empty entries are skipped while another correctly formatted string remains. Non-string entries, or no usable secret, are validation errors.
- Repeated signatures are supported. Timestamp and event ID headers must each have one value.
- The generated `RUNTIME.md` lists the configured header names, format and tolerance.

Failures throw `WebhookVerificationError`, with the code in `code` in both targets:

| Kind             | Code                                 | Action                                                                          |
| ---------------- | ------------------------------------ | ------------------------------------------------------------------------------- |
| `validation`     | `webhook_invalid_input`              | Supply original body bytes and supported options, headers and Unix seconds.     |
| `validation`     | `webhook_invalid_secret`             | Supply at least one correctly formatted nonempty secret.                        |
| `authentication` | `webhook_missing_header`             | Forward the configured signing headers.                                         |
| `authentication` | `webhook_invalid_timestamp`          | Supply one integer timestamp in seconds.                                        |
| `authentication` | `webhook_timestamp_out_of_tolerance` | Check the server clock and delivery age.                                        |
| `authentication` | `webhook_invalid_signature`          | Check the signing secret and original request bytes.                            |
| `authentication` | `webhook_invalid_token`              | Malformed JWT, bad alg/typ/issuer/signature, or kid naming an unusable key.     |
| `authentication` | `webhook_invalid_audience`           | Check the configured receiving endpoint IDs.                                    |
| `authentication` | `webhook_token_expired`              | Check JWT timestamps, lifetime, leeway and the server clock.                    |
| `authentication` | `webhook_body_mismatch`              | Preserve the exact original request bytes.                                      |
| `authentication` | `webhook_unknown_key`                | The trusted key set has no matching signing key.                                |
| `transport`      | `webhook_jwks_unavailable`           | Respond with 5xx so the provider retries; check key-service and key-set health. |
| `protocol`       | `webhook_invalid_json`               | The authenticated bytes are not valid UTF-8 JSON.                               |

```js
try {
  const verified = client.verifyWebhook(rawBody, headers, webhookSecret);
} catch (error) {
  if (!(error instanceof SdkError)) throw error;
  // Record error.name and error.code without logging bodies or secrets.
  throw error; // Let the HTTP adapter choose the failure response.
}
```

Verification does not deduplicate delivery. Commit a unique event ID and durable work before acknowledging, process effects idempotently, and leave unknown names or unmatched envelopes pending for review. The optional generated [SQLite inbox/outbox examples](configuration.md#webhook-inbox-examples) demonstrate this flow.

## Client and request options

Unknown JavaScript client option keys raise a validation error. For example, replace `maxRetries` with `maxAttempts`, which counts the first attempt. A `baseUrl` that repeats an operation path prefix is rejected before sending: use `https://example.invalid` for operation paths starting with `/v1`, rather than appending `/v1`.

Pass client defaults to `new Client({...})` in Node or `new Client(new ClientOptions(...))` in PHP. Pass request overrides as the last method argument. PHP request header names and values must be strings; invalid values raise `InvalidInputError` before dispatch.

| Option                                  | Where             | Default and behavior                                                                                                                                                |
| --------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `baseUrl`                               | Client            | First declared server, if present; otherwise required. Explicit values override the default. No credentials, query or fragment.                                     |
| `token`                                 | Client            | Absent. See [authenticate](#authenticate) for when it is available.                                                                                                 |
| `allowedOrigins`                        | Client            | Only the base URL origin. Applies to every destination, including pagination links.                                                                                 |
| `allowInsecureHttp`                     | Client            | `false`; enable only for deliberate local HTTP tests.                                                                                                               |
| `timeoutMs`                             | Client or request | `10000`; positive duration per attempt, including response body consumption.                                                                                        |
| `deadlineMs`                            | Client or request | `30000`; positive overall duration, not an absolute timestamp. Includes retry waits. Iterator and polling scope: [pagination and polling](#pagination-and-polling). |
| `maxAttempts`                           | Client or request | A positive safe integer budget capped at the operation limit. Defaults follow [retries](#errors-and-retries).                                                       |
| `transport`                             | Client            | Fetch for buffered Node calls, native HTTP/HTTPS for Node SSE, reusable cURL in PHP. Injected transports are caller-owned.                                          |
| `diagnostics`                           | Client            | Optional callback receiving operation, attempt, status, request ID, timing and error kind, without bodies or credentials.                                           |
| `redactFields`                          | Client            | Additional field names to redact in model inspection, error messages and parsed error details. Does not change response data.                                       |
| `headers`                               | Request           | Request-local header map; includes tenant context and optional User-Agent override. A configured API-version pin takes precedence.                                  |
| `idempotencyKey`                        | Request           | Caller-owned stable key for a declared idempotent operation. Persist across retries and process restarts.                                                           |
| `clientRequestId` / `client_request_id` | Request           | Node / PHP caller correlation value for a header marked `x-flint-request-option: client_request_id`. Omitted when unset.                                            |
| `ifMatch`                               | Request           | Value for the declared conditional header, including when that header is `If-None-Match`.                                                                           |
| `signal` / `cancellation`               | Request           | Node `AbortSignal` / PHP `Cancellation` token. Stops local work, not a remote mutation.                                                                             |
| `maxPages`, `maxItems`                  | Request           | Positive iterator limits; maxPages defaults to 1000 and maxItems has no practical default cap.                                                                      |

For operations declaring the client request ID option, pass `{ clientRequestId: 'order-123' }`
in Node or `new RequestOptions(client_request_id: 'order-123')` in PHP. Values must
contain 1 to 128 visible ASCII characters without spaces. Invalid values raise a
`validation` error with `outcome: "not_sent"` before transport, including when schema
validation is disabled. Conflicting option and header values also fail before transport.
Keep secrets and personal data out of correlation values.

Flint sends its own request ID in the response `X-Request-Id` header, such as
`req_01KWM6WAHG3N9Q8T2V5XRZ7C4D`. Results and errors expose that ID as
`meta.requestId`; it is independent of the caller's value.

Precedence and budgets:

- Request timeout, deadline and attempt settings override client defaults.
- The deadline is rechecked after response decoding and model construction, so an overrun returns a `deadline` error with response metadata instead of a late success.
- `maxAttempts` budgets are capped at each operation's limit, so one client budget is safe across operations. Set `maxAttempts: 1` to disable ordinary retries; [provider invalidation](#credential-providers) can still add one HTTP 401 retry. A budget cannot enable undeclared mutation retries.
- No mutable client-wide tenant headers are shared between calls.

Managed headers:

- Supply required conditional headers through `ifMatch` or request headers. Configured API-version pins satisfy required headers without duplicate input fields.
- Effective managed values are validated before dispatch.
- With `idempotency.auto: true`, a required idempotency header gets an automatic key when none is supplied. Provide a compatible explicit key if the generated format fails the declared schema.

Origins:

- Origin checks ignore scheme and host case and normalize default ports (`https:443`, `http:80`). Pagination links with those equivalent spellings are allowed; other ports need their own allowed origin.
- Write `allowedOrigins` entries as canonical origins without default ports, such as `https://example.invalid`.

Concurrency and cleanup:

- Node clients serve concurrent calls within an event loop. Non-streaming Node clients need no cleanup and have no `close()`; clients with streaming operations expose `close()` to release owned streams.
- PHP clients support sequential calls in one execution context. Don't share a client across threads or fibers. Call `close()` to release the owned cURL handle.
- The default fetch pool belongs to the runtime. PHP's built-in cURL handle is SDK-owned and released on close or destruction.
- Injected transports are privileged and caller-owned; the SDK never closes them. They receive credentials and bodies, must honor timeouts, cancellation and destination constraints, and must disable their own redirects and retries. Node uses the fetch signature. PHP receives `{url, method, headers, body, timeoutMs, cancellation}` and returns `{status, headers, body}`.

## Advanced

### Server-sent events

```js
const result = await client.events.watchWithResponse(input, { signal, streamIdleTimeoutMs: 30000 });
try {
  for await (const event of result.body) {
    console.log(event.event, event.id, event.data);
    // Persist a cursor only after your application's event work succeeds.
  }
} finally {
  await result.body.close();
}
await client.close();
```

PHP exposes the same result fields and closeable iteration:

```php
$result = $client->events->watchWithResponse(
  $input,
  new RequestOptions(streamIdleTimeoutMs: 30000),
);
try {
  foreach ($result->body as $event) {
    processEvent($event->event, $event->id, $event->data);
  }
} finally {
  $result->body->close();
}
$client->close();
```

- Events expose `event`, `id`, `data`, `rawData` and optional `retry` milliseconds.
- The parser handles comments, multiline data, split UTF-8 and CR/LF/CRLF. Incomplete final events are discarded.
- Invalid UTF-8, malformed configured JSON payloads and oversized events close the stream with a `protocol` error.
- Breaking out of iteration closes the connection. Explicit `close()` also handles streams that were never iterated. Closing the client releases owned streams.
- Malformed known SSE payloads raise `sse_invalid_event` with `details.eventId` and the one-based `details.position`, without including payload bytes in the message.
- Unconsumed default Node streams and their timers do not keep the process alive. Start iteration within `streamIdleTimeoutMs` or the stream closes; iteration retains the connection. Injected transports own their socket lifecycle.
- Iteration provides backpressure. PHP's default cURL multi transport queues at most one write chunk and pauses until it is consumed.
- Node cancels with `AbortSignal`, including during an idle read. PHP cancellation and lifetime checks are cooperative while reading; synchronous injected transports must honor cancellation while blocked.
- A PHP injected transport returns a `ByteStream` in `response['stream']`: `read(): ?string` returns bounded chunks or null at EOF, and `close(): void` releases resources. The injected request includes stream limits and cancellation.
- Connection retries happen only before a stream result is returned, under the operation's declared retry policy. There is no automatic reconnect or delivery guarantee.
- Debug inspection of binary and stream results omits headers and URLs; event inspection omits payloads. Raw fields remain available through explicit property access.

### PDF downloads and declared redirects

- PDF methods return `Uint8Array` in Node and binary-safe strings in PHP. `WithResponse` exposes the bytes in `body` and `raw`, preserving every byte. Don't convert them to UTF-8 text before saving.
- JSON error responses from PDF operations decode as ordinary SDK errors.
- Explicit `302` and `307` results expose an optional `location`. `WithResponse` exposes status and headers in `meta` and the location in `body.location`.
- Required Location headers are checked. Relative and cross-origin locations are returned without being followed; following one is an application decision. Undeclared redirects fail.
- Generated redirect examples inspect the status and Location without a second request or forwarding credentials. Generated PDF examples save the bytes; set `API_DOWNLOAD_PATH` to choose the output file.

### Numbers and dates

Inputs and outputs follow the [schema representations](configuration.md#schema-representations) table. int64/uint64 and decimal fields use exact strings, such as `"9007199254740993"`. TypeScript int64/uint64 outputs use `${bigint}`; inputs also accept `bigint`, including ambiguous integer/string unions. Decimal strings retain `string`: `${number}` admits spellings that are not valid exact decimals. Date-time inputs also accept JavaScript `Date` or PHP `DateTimeInterface`.

- The schema decides whether an exact string becomes an unquoted number token on the wire. Don't convert an exact amount to a floating-point number before passing it.
- Plain numbers use floating-point precision and reject non-finite values.
- Native dates serialize as UTC ISO 8601 with milliseconds, without changing the supplied object. Invalid JavaScript dates fail validation. String inputs keep their spelling.
- Integer responses accept integral decimal and exponent notation: `1.0` becomes `1`, and `1e3` becomes `1000`. Fractional values are rejected, not rounded.
- Exact numeric enums accept equivalent spellings such as `1.0` and `1e0` for `1`; membership is checked at runtime. Numeric `anyOf` branches also accept equivalent decimal and integer spellings and preserve the request token; `oneOf` still rejects a value matching multiple branches.
- API responses and verified webhooks use the same rules. Each schema decides: a plain `integer` is a native safe integer even where another schema declares the same field `int64`. The SDK never infers a format from a field name.
- Node request arrays need a value at every index; sparse arrays fail validation before dispatch.
- When configured, `money(currency, major)` converts an exact major-unit string to minor units. It rejects whitespace, including trailing newlines, and excess precision.

### TypeScript object types

Response types use the referenced component name, with structurally identical declarations sharing a canonical name (shortest name, then alphabetical order). Different effective shapes retain separate names, including differences introduced by schema profiles. Payload methods return concrete component types or unions; `WithResponse` keeps the envelope and HTTP metadata. A projected payload that matches no declared alternative raises a protocol error; `WithResponse` retains the complete forward-compatible envelope.

- Request enums are closed unions; response enums include future strings.
- Only models reachable from operation inputs have `NameInput` types and `makeName` factories. Request bodies use their referenced component input name; anonymous bodies stay within the owning operation input.
- Fresh object literals with undeclared properties, and misspelled response fields, are type errors. Explicitly open objects and dictionaries accept arbitrary keys.
- Structural typing can still accept extra keys through existing variables; runtime request rules follow the schema.
- Unknown response fields stay present. Read them with an explicit dictionary assertion or narrowing.
- Unknown response object variants retain `Record<string, unknown>` through property guards, including nested variants and `WithResponse` envelopes. Use a generated known-variant guard or validate individual values before reading declared fields. Successful payloads and pagination items that cannot satisfy their public types fail with a protocol error and retain `raw`.
- `Object.keys()` and `Object.values()` can include undeclared fields. Validate values when iterating preserved extras.
- Optional fields named like inherited `Object` members (such as `toString`) include the inherited signature, so you can omit them. Explicit own values are validated, functions are never serialized as strings, and the runtime reads only own request properties.
- An OpenAPI 3.1 schema with `properties` or `required` but no `type` does not require an object. Its type keeps the permitted nonobject values; narrow before reading fields. An enclosing object constraint in an `allOf` still applies.
- A nullable wrapper with one explicitly typed non-null branch and one plain `type: "null"` branch exposes the known value or null. Unknown fields and enum members are preserved; malformed known values fail decoding. Genuinely polymorphic alternatives keep their unknown-variant fallback.

### PHP models

Model properties are read-only. Assignment raises a `InvalidInputError`; construct a new model for updated values.

Response getters return generated entities for declared nested objects, lists of entities, and PHP arrays for dictionaries.

- Nested entities use configured component names, such as `Payment`. Inline entities are named from the owning model and property path. Nullable wrappers hydrate the existing named entity or an inline entity.
- A typed envelope reads as `$result->data->getData()->getId()`. Dictionaries use array access, such as `$payment->getMetadata()['label']`, and their values can be entities. Numeric-string dictionary keys follow PHP array-key conversion.
- Wire names are unchanged. Accessors use word boundaries: `request_id` becomes `getRequestId()` and `hasRequestId()`.
- Webhook classes use event names, such as `WebhookEventPaymentIntentSucceeded`, and stay stable when events are added or reordered.
- Response class names include the response status; tagged alternatives also include the branch position. When dispatching by class, a new status can add a return class even with an identical JSON shape. When dispatching by discriminator value, handle unknown tags.
- Unknown or ambiguous alternatives keep their raw fallback representation. Check discriminator values before using a known variant.
- `toArray()` and `jsonSerialize()` return normalized JSON objects and lists, including empty objects.
- In object/array alternatives, PHP lists (including `[]`) are JSON arrays; use `(object) []` for an empty JSON object.
- Getters memoize hydrated children: repeated entity reads return the same immutable instance, and lists/maps of entities use PHP copy-on-write arrays. Mutable untyped objects and raw exports (`toArray()`, `jsonSerialize()`, `toInputArray()`, `toInputValue()`) remain defensive copies; editing them does not change the model. To change an input, edit a `toInputArray()` or `toInputValue()` copy and construct a new model. These input exports preserve exact numeric kinds in ambiguous unions.

PHP integer input strings and `ExactNumber` tokens for integer fields must use integer spelling, such as `"5000"`; `"50.00"` and `"5e3"` are rejected with an “integer string” error. Decimal fields retain exact fractional/exponent spellings. Integral decimal/exponent tokens in integer responses still decode exactly. Client resource wrappers initialize on first access and remain read-only.

### Schema-taking helpers

Generated methods and model factories use the package's bundled codecs. Applications can also pass schemas to these helpers:

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

- PHP provides the schema-taking base `Model` constructor, `Codec::normalize` and `Codec::redact`. `Codec::encode` writes normalized values as JSON.
- Helpers run locally with the package's value rules. No generator installation or schema registry service is needed.
- String `propertyNames` constraints validate object keys, including declared fields. Key enum/const constraints remain closed in strict responses; dictionary key types remain strings.
- Generated declarations, docs, samples and compiled descriptors omit examples/defaults from sensitive, write-only and password locations, including shared reference targets and compositions. Samples use placeholders; replace them with your own values. Descriptions and wire behavior remain unchanged.
- Node `Model.toJSON()` returns a defensive copy in which exact numbers are strings. Where a field allows both exact numbers and strings, a model rebuilt from that copy treats those strings as JSON strings. To edit an input, keep the original values, including `ExactNumber` instances, and build a new model; or restore `ExactNumber` explicitly at fields meant to be JSON numbers.
- For a null-only schema passed directly to these helpers, use `type: 'null'`. In Node helpers, `type: ['null']` also permits non-null values; PHP rejects them. Nullable forms such as `type: ['string', 'null']` keep their non-null type in both targets. Contract loading normalizes OpenAPI 3.1 type arrays before generating SDKs; use explicit `anyOf` for mixed types passed directly to helpers.

### SDK loading and selective Node imports

Import a scoped client from `package-name/resources/<resource>` when an application uses one resource:

```js
import { Client } from 'package-name/resources/paymentIntents';

const client = new Client({ token: process.env.API_TOKEN });
const result = await client.paymentIntents.get({ payment_intent_id: 'pi_example' });
```

This example assumes an SDK with a declared server, a `token` shortcut and object-style requests.

- A scoped client exposes only its resource, with the same argument and return types. Its subpath also exports related input and response types and reachable model factories.
- Webhook verification is available on the root client and through `package-name/webhooks`. Package-root and `custom/` helper imports keep working.
- Resource imports load their descriptor chunks independently and let ESM bundlers drop unrelated descriptors; use them for the largest bundle-size reduction. Root clients keep the complete surface.
- Both forms decode descriptors on first use by a request, model factory, predicate or webhook verification, so a first call costs more than later ones. Reused clients reuse their transports; credentials and request state are never stored in shared descriptor caches.
- Large Node declaration graphs share chunks of up to 64 symbols, reducing files loaded by TypeScript without duplicating type definitions. Import from public package exports rather than internal declaration paths.
- Node packages bundle their transitive runtime and declaration dependencies, including the shared descriptor validator's `php-value-plan` module. That module is JavaScript and requires no PHP installation.
- PHP classes live in individual files for autoloading and editor indexing. Descriptors load on demand; the tested full public fixture needs no increased memory limit. `SchemaRegistry::contract()` and `codecs()` materialize the complete compiled plan and are unnecessary for normal calls. Raw schema definitions and `SchemaRegistry::definitions()` are no longer shipped; supply application-owned schemas to dynamic schema helpers.

### Successful HTTP responses and schema drift

The SDK picks the response declaration for a 2xx status in this order:

1. The exact status declaration.
2. A declared `default`.
3. The sole declared JSON 2xx response, including its codec and PHP model class. Metadata keeps the actual status.

Multiple JSON success declarations stay ambiguous, even with matching schemas. Binary, streaming, empty and redirect responses are never inferred.

Required fields and value types are enforced. A schema failure is a non-retryable `protocol` error with `outcome: response`:

- The message includes codec diagnostics such as `response.payment.id: required field is missing`; the original cause is available.
- The server may already have performed the action, such as creating a payment.
- Buffered JSON response failures and payload-extraction errors keep `raw` for explicit recovery. Raw bodies are omitted from ordinary error inspection and diagnostics.

Inside a catch block, recover a synthetic create response's top-level string `id` as below. Use the endpoint's real ID path and reconcile its state before continuing. This parses an unvalidated body only to recover the ID; it does not restore typed guarantees or justify resubmitting the mutation.

```js
if (
  error instanceof SdkError &&
  error.name === 'protocol' &&
  error.status >= 200 &&
  error.status < 300 &&
  error.raw
) {
  let body;
  try {
    body = JSON.parse(error.raw);
  } catch {
    throw error;
  }
  const paymentId = typeof body?.id === 'string' ? body.id : undefined;
  if (!paymentId) throw error;
  // Reconcile this payment ID with the provider; do not submit another create.
} else {
  throw error;
}
```

```php
if (
  $error instanceof SdkError &&
  $error instanceof \Example\Library\Errors\UnexpectedResponseError &&
  $error->status >= 200 &&
  $error->status < 300 &&
  $error->raw !== null
) {
  try {
    $body = json_decode($error->raw, true, 512, JSON_THROW_ON_ERROR | JSON_BIGINT_AS_STRING);
  } catch (\JsonException) {
    throw $error;
  }
  $paymentId = is_array($body) && is_string($body['id'] ?? null) ? $body['id'] : null;
  if ($paymentId === null) {
    throw $error;
  }
  // Reconcile this payment ID with the provider; do not submit another create.
} else {
  throw $error;
}
```

### Custom helpers

Keep handwritten domain helpers in the generated package's `custom/` directory; regeneration preserves them. See [architecture](architecture.md#extending-the-project) for imports and Composer autoloading.

### Generated examples

Each package's `examples/` directory has a runnable script for every operation, linked from the API reference. Node emits one `.mjs` file per operation and validates it with TypeScript's `checkJs`. PHP examples find Composer's autoloader from the application directory or their installed location under `vendor/`; copied examples work inside the application too.

- Scripts read `API_BASE_URL`, `API_TOKEN`, `API_KEY` or the configured shortcut's uppercase snake-case variable explicitly. A script without a compiled default server requires `API_BASE_URL`, and a script for an authenticated operation requires its credential variable; each explains how to set it.
- Replace sample IDs with values from your account before running.
- Scripts generate random idempotency keys only when the declared header schema permits that format and length. Otherwise set `API_IDEMPOTENCY_KEY` to a schema-compatible key. Use a new key for each new business action, and reuse a saved key only for the same action.
- See [running operation examples](configuration.md#running-operation-examples) for commands.

Operation names come from the SDK configuration. With `operationNames: "path"`, resources follow API paths and methods retain the operation verb, such as `invoices.void()` and `orders.close()`. Explicit exceptions require a documented naming reason in the profile.
