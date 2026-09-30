# Using generated SDKs

Generate and install a package using the [README quickstart](../README.md#install-and-use-the-generated-packages). Each package contains its own `README.md`, `REFERENCE.md`, `MODELS.md`, `RUNTIME.md`, typed interfaces and operation examples. The reference groups operations by resource and includes pagination and polling recipes. The model reference and TypeScript field comments preserve descriptions, units, constraints and examples. Public resource and method names come from explicit SDK configuration or matching OpenAPI tags and operation IDs; these examples use the bundled library contract.

## Calls, inputs and results

New SDK methods return the decoded body directly: `const payment = await client.paymentIntents.create(input)` yields the configured payload with no SDK `data` wrapper. Use the `WithResponse` companion when you need the full decoded `body`, HTTP `meta` or the `raw` response, as in the Node example below; each invocation sends its own request, so choose one form per action. Providers may explicitly select a nested payload path or retain `Result` returns, per SDK or per operation; check the generated reference for the selected mode and follow provider migration notes when it changes. `Pages` and `Wait` follow that return mode. Payload-mode `PagesWithResponse` and `WaitWithResponse` retain complete bodies and HTTP metadata. `Items` yields individual items.

Node.js and TypeScript share one ESM package. ESM imports require Node.js 22+; use a `.mjs` file or a project with `"type": "module"`. On Node.js 22.12+, CommonJS consumers can use `const { Client } = require('@example/library')`, including resource subpaths such as `require('@example/library/resources/books')`.

TypeScript consumers use the included declarations with TypeScript 5.9+ and NodeNext module resolution. Install a compatible `@types/node` version (22.16.0+) as a development dependency matching your Node runtime, for example `npm install --save-dev @types/node@22`. Generated packages declare Node types as an optional peer dependency, so consumers choose the version and JavaScript installations do not install type packages.

```js
import { Client, SdkError } from '@example/library';

const client = new Client({
  baseUrl: 'https://your-api.example.com',
  timeoutMs: 10_000,
  deadlineMs: 30_000,
});

try {
  const result = await client.books.retrieveWithResponse('book/123', {
    headers: { 'X-Tenant': 'tenant-example' },
  });
  console.log(result.body.title, result.meta.requestId);
} catch (error) {
  if (!(error instanceof SdkError)) throw error;
  console.error(
    error.message,
    error.status,
    error.kind,
    error.code,
    error.meta?.requestId,
    error.outcome,
  );
}
```

PHP uses the same argument order: path values, a flat params array when needed, then RequestOptions. Save this in a consumer with the generated Composer package installed:

```php
<?php
require __DIR__ . '/vendor/autoload.php';

use Example\Library\{Client, ClientOptions, RequestOptions, SdkError};

$client = new Client(new ClientOptions(baseUrl: 'https://your-api.example.com'));
try {
  $result = $client->books->retrieve(
    'book/123',
    new RequestOptions(headers: ['X-Tenant' => 'tenant-example']),
  );
  echo $result->getTitle();
} catch (SdkError $error) {
  error_log(
    $error->getMessage() .
      ' status=' .
      ($error->status ?? 'none') .
      ' request=' .
      ($error->meta['requestId'] ?? 'no request ID'),
  );
} finally {
  $client->close();
}
```

Generated clients default to the first top-level server declared by the API, when present. Pass `baseUrl` to choose another environment; it is required when the API declares no server. The generic examples above use an explicit placeholder URL. Its path prefix is retained when operation paths are appended, so avoid duplicating `/v1` if it is already present in the generated operation paths. Provide `token` through your application's credential source when the selected contract requires authentication. The SDK itself does not read environment variables or discover credentials.

By default, path values are positional arguments in URL order. Body fields and query/header parameters share the next params object or array, with request options last. There is no `body` wrapper. If the operation has no body or query/header parameters, omit the params argument entirely. Set `requests.style: "object"` to use a single input object containing path/query/header parameters and a `body` field. Optional fields may be omitted. Explicit null is accepted only where nullable; it does not automatically mean the server will clear a value. PHP inputs use omitted array keys for omission and `['field' => null]` for explicit null. PHP models provide `has()`, generated presence methods such as `hasDescription()`, and `get()`. Use `valueOrDefault('description', 'fallback')` to supply a fallback only when omitted; an explicit null stays null. Response getters return generated entities for declared nested objects, lists of entities, and PHP arrays for dictionaries. Generated getters, `get()`, and magic properties return the same public values and throw a field-specific error for missing optional fields. Raw exports (`toArray()` and `jsonSerialize()`) retain normalized JSON objects and lists, including empty objects. In object/array alternatives, PHP lists (including `[]`) represent JSON arrays; use `(object) []` for an empty JSON object. Exact numeric enums accept equivalent spellings such as `1.0` and `1e0` for the value `1`, with membership checked at runtime. Numeric `anyOf` branches also accept equivalent decimal/integer spellings and preserve the request token; `oneOf` still rejects a value matching multiple branches.

An OpenAPI 3.1 schema with `properties` or `required` but no `type` does not by itself require an object. Generated TypeScript types preserve the permitted nonobject values; narrow such responses before accessing their fields. An enclosing object constraint in an `allOf` composition still applies to the same value.

Generated PHPDoc types target PHPStan 2.2 or newer; PHPStan is development tooling and is not required at runtime.

Nested response entities use configured component names, such as `Payment`; inline entities use their owning model and property path. A typed envelope supports `$result->data->getData()->getId()`. Dictionaries use array access, for example `$payment->getMetadata()['label']`, and dictionary values can themselves be entities. PHP numeric-string dictionary keys follow normal PHP array-key conversion.

Wire names stay unchanged. Accessors use word boundaries: `request_id` becomes `getRequestId()` and `hasRequestId()`. Webhook classes use event names, for example `WebhookEventPaymentIntentSucceeded`, and stay stable when unrelated events are inserted or reordered. Unknown or ambiguous alternatives retain their raw fallback representation; check discriminator values before using a known variant.

PHP response classes include the response status in their names; tagged alternatives also include the branch position. Follow the package's migration notes when upgrading code that dispatches by class: adding a status can introduce a new return class even with an identical JSON shape, and reassigning an existing branch position requires a breaking release. Dispatching by the discriminator value also requires explicit handling of unknown tags.

For operations explicitly configured for result mode, `Result` contains `data`, `meta` and explicit raw response text in `raw`. `data` is the complete decoded API response body. If the provider wraps its payload in another `data` field, use `result.data.data` (PHP: `$result->data->data`). Endpoint-specific nesting stays intact; follow the operation example rather than assuming every endpoint has the same envelope. Node accesses metadata with properties; PHP uses array keys. Metadata includes HTTP status, response headers, attempt count, duration and an optional provider request ID. Inspect unknown response enums or variants explicitly before treating them as a known successful business state.

Use strings for exact int64/uint64 and `number` fields with `format: "decimal"`: `"9007199254740993"`, for example. The schema determines whether the string becomes an unquoted number token on the wire. Plain `number`, float and double fields use native numbers (PHP accepts integers or floats and returns floats). They use ordinary floating-point precision and reject non-finite values. Ordinary safe integers use native numbers/integers. Do not convert an exact amount to a floating-point number before handing it to the SDK. When configured, `money(currency, major)` converts an exact major-unit string to minor units and rejects whitespace, including trailing newlines, and excess precision.

Date-time inputs accept strings or JavaScript `Date` / PHP `DateTimeInterface` objects. Native dates serialize as UTC ISO 8601 with millisecond precision without changing the supplied object; invalid JavaScript dates fail validation. String inputs retain their spelling, and date-time responses remain strings. Date-only fields still use strings.

TypeScript catches undeclared properties on fresh shaped object literals and misspelled response field access. Explicitly open objects and dictionaries still accept arbitrary keys. Structural typing can accept additional keys through existing variables; runtime request rules continue to follow the schema. Unknown response fields remain present, but inspecting them requires an explicit dictionary assertion or narrowing. Unknown response object variants require a generated known-variant guard before accessing their declared fields. Closed declarations do not guarantee that `Object.keys()` or `Object.values()` enumerates only declared fields; validate values when iterating preserved response extras.

Simple nullable wrappers with one explicitly typed non-null branch and one plain `type: "null"` branch retain that branch’s fields: TypeScript exposes the known value or null, and PHP response getters hydrate the existing named entity or an inline entity. Unknown fields and enum members remain preserved; malformed known values fail response decoding. Genuinely polymorphic alternatives retain their unknown-variant fallback.

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

Node `Model.toJSON()` returns a defensive copy of the public JSON representation. Exact numbers become strings in this copy. When a field allows both exact numbers and strings, rebuilding a model from the copy treats those strings as JSON strings. To edit an input, retain the original input values, including `ExactNumber` instances, and construct a new model from the updated input. If you use a `toJSON()` copy instead, explicitly restore `ExactNumber` at fields intended to be JSON numbers in ambiguous alternatives. Editing a copy does not change the original model or its transmitted numeric kinds.

PHP model accessors (`get()`, magic and typed getters, `toArray()`, `jsonSerialize()`, `toInputArray()`, and `toInputValue()`) also return defensive copies. Editing a returned object or nested value does not modify the model. To change an input, edit a `toInputArray()` or `toInputValue()` copy and construct a new model from it; these input exports preserve exact numeric kinds in ambiguous unions.

These helpers run locally and use the package's value execution rules. PHP retains the schema-taking base `Model` constructor, `Codec::normalize` and `Codec::redact`. `Codec::encode` writes normalized values as JSON. No generator installation or schema registry service is required by either package.

For a null-only schema, use `type: 'null'`. The existing Node behavior for `type: ['null']` also permits non-null values; PHP rejects them. Nullable forms such as `type: ['string', 'null']` retain their declared non-null type in both targets.

## Client and request options

Pass client defaults to `new Client({...})` in Node or `new Client(new ClientOptions(...))` in PHP. Pass request overrides as the last method argument: a plain object in Node or `new RequestOptions(...)` in PHP.

| Option                    | Where             | Default and behavior                                                                                                                                                |
| ------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `baseUrl`                 | Client            | First declared server, if present; otherwise required. Explicit values override the default. No credentials, query or fragment.                                     |
| `token`                   | Client            | Absent. Legacy selected scheme, or an explicitly configured composed-client shortcut; otherwise rejected on composed clients.                                       |
| `allowedOrigins`          | Client            | Only the base URL origin. Applies to every destination, including pagination links.                                                                                 |
| `allowInsecureHttp`       | Client            | `false`; enable only for deliberate local HTTP tests.                                                                                                               |
| `timeoutMs`               | Client or request | `10000`; positive duration per attempt, including response body consumption.                                                                                        |
| `deadlineMs`              | Client or request | `30000`; positive overall duration, not an absolute timestamp. Includes retry waits; applies separately to each pagination page and across the entire polling wait. |
| `maxAttempts`             | Client or request | A positive safe integer budget capped at the operation limit. Defaults: 3 for GET/HEAD/OPTIONS, 1 for other methods; explicit policies replace these defaults.      |
| `transport`               | Client            | Native fetch in Node, reusable cURL in PHP. Injected transports are caller-owned.                                                                                   |
| `diagnostics`             | Client            | Optional callback receiving operation, attempt, status, request ID, timing and error kind, without bodies or credentials.                                           |
| `redactFields`            | Client            | Additional field names to redact in model inspection, error messages and parsed error details. Does not change response data.                                       |
| `headers`                 | Request           | Request-local header map; includes tenant context and optional User-Agent override. A configured API-version pin takes precedence.                                  |
| `idempotencyKey`          | Request           | Caller-owned stable key for a declared idempotent operation. Persist across retries and process restarts.                                                           |
| `ifMatch`                 | Request           | Value for the declared conditional header, including when that header is `If-None-Match`.                                                                           |
| `signal` / `cancellation` | Request           | Node `AbortSignal` / PHP `Cancellation` token. Stops local work, not a remote mutation.                                                                             |
| `maxPages`, `maxItems`    | Request           | Optional positive limits for generated iterators; each page request has its own deadline.                                                                           |

Required conditional headers can be supplied through `ifMatch` or request headers; configured API-version pins also satisfy required headers without duplicate input fields. Effective managed values are validated before dispatch. With `idempotency.auto: true`, required idempotency headers receive an automatic key when none is supplied; provide an explicit compatible key when the generated format fails the declared schema.

Request timeout, deadline and attempt settings take precedence over client defaults. Client and request `maxAttempts` budgets are capped at the operation limit, so a shared client budget is safe across operations. A request budget overrides the client budget. Set `maxAttempts: 1` to disable retries. A budget cannot enable undeclared mutation retries. No mutable client-wide tenant headers are shared between calls.

Node clients can serve concurrent calls within an event loop. PHP clients support sequential calls within one execution context; do not share a client concurrently across threads or fibers. Close PHP clients to release their owned cURL handle. Injected transports must honor cancellation/timeouts and disable their own redirects and retries; they receive credentials and bodies. Node clients with streaming operations expose `close()` to release owned streams. Non-streaming Node clients need no cleanup and do not expose `close()`. The default fetch pool belongs to the runtime, and a custom transport's cleanup belongs to its caller.

## Errors and recovery

Both targets expose `SdkError`. Node uses `code`, `cause` and `meta?.requestId`; PHP uses `errorCode`, `getPrevious()` and `$error->meta['requestId']`. Shared `kind` values are `transport`, `authentication`, `validation`, `rate_limit`, `not_found`, `server`, `api`, `conflict`, `protocol`, `cancelled`, `deadline` and `destination`. <!-- copy-ok: `cancelled` is the literal SdkError kind -->

The exception message contains the server explanation selected by `errors.messagePath` (default `message`), with `API returned HTTP <status>` as the fallback. Both targets expose `status` directly (`undefined` in Node or `null` in PHP when no response is available). HTTP 404 maps to `not_found`; HTTP 500–599 maps to `server`. Other existing classifications and retry policies are unchanged. Provider-specific `details` remain `unknown` in TypeScript; the message, status and code can be read without narrowing that payload.

| `outcome`  | Meaning for recovery                                                                                                                                      |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `not_sent` | The failing operation stopped before dispatch. Correct local input, authentication or destination settings as appropriate.                                |
| `response` | A response was received. Inspect status and provider error code; a response alone does not establish a successful business effect.                        |
| `unknown`  | The remote effect is uncertain. Reconcile with the provider, or recover using the same persisted idempotency key within its declared retention and scope. |

Without an explicit operation policy, GET/HEAD/OPTIONS retry transport failures and HTTP 408, 429, 500, 502, 503 and 504, with three total attempts and exponential jitter starting at a 100 ms base. Explicit policies replace these defaults. Mutations require declared retry and idempotency support and a valid key to retry. Without an optional key they send once; required keys remain required. TypeScript exposes `idempotencyKey` only on supported method options; PHP retains shared `RequestOptions` and rejects unsupported keys at runtime. `retryAllowed` reports retry eligibility; it does not grant permission to create a new business operation or exceed the provider policy. A lost response must not cause a fresh mutation with a different key. Automatic idempotency keys last for one SDK call; application resubmission requires a persisted caller key. Conflicting keys across operation headers, request headers and `idempotencyKey` fail before dispatch.

Ordinary error inspection includes the message, status, provider code, redacted details and stack frames. Message extraction, provider codes and details apply schema and `redactFields` redaction. PHP debug traces omit call arguments. Diagnostics report status and kind without messages, details or stack traces. `raw`, response headers, arbitrary `data` logging and injected transports require application-level handling of sensitive information.

### Successful HTTP responses and schema drift

Exact HTTP status declarations take precedence, followed by a declared `default`. If neither exists for an actual 2xx response, the SDK reuses the sole declared JSON 2xx response, including its codec and PHP model class. Metadata retains the actual status. Multiple JSON success declarations remain ambiguous, even when their schemas match; binary, streaming, empty and redirect responses are never inferred.

Required fields and value types remain enforced. Schema failures are non-retryable `protocol` errors with `outcome: response`; the top-level message includes codec diagnostics such as `response.payment.id: required field is missing`, and the original cause remains available. The server may already have created the payment. Buffered JSON response failures and payload-extraction errors retain `raw` for explicit recovery; raw bodies are omitted from ordinary error inspection and diagnostics.

Inside a catch block, a synthetic create response with a top-level string `id` can be recovered as below. Use the actual endpoint's ID path and reconcile its state before continuing. This parses an unvalidated body only to recover the ID; it does not restore the SDK's typed guarantees or justify resubmitting the mutation.

```js
if (
  error instanceof SdkError &&
  error.kind === 'protocol' &&
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
  $error->kind === 'protocol' &&
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

## Optional capabilities

Only declared capabilities generate convenience methods. An operation named `list` with pagination exposes `listPages(input, options)` and `listItems(input, options)` on its resource. Node uses `for await ... of`; PHP uses `foreach`. Pages yield the same payload shape as `list`, or full `Result` values in result mode; items yield individual values. Payload-mode `listPagesWithResponse` yields complete `SdkResponse` pages with `body`, `meta`, and `raw`. For a list payload containing `data`, access `page.data`; the response companion exposes that same field as `page.body.data` (PHP: `$page->body->data`). Pagination is lazy and bounded by optional caller limits. Each page request gets a fresh `deadlineMs` budget, including its retries and decoding; time spent processing yielded pages or items does not consume it. There is no overall iterator deadline. Use cancellation or `maxPages`/`maxItems` to bound a backfill. Pagination does not promise a stable snapshot. Providers must configure compatible continuation and query representations; generation rejects an exact integer continuation paired with an ordinary integer query parameter.

A polling operation named `get` exposes `getWait(input, options)`, returning the same payload as `get`, or a full `Result` in result mode. Payload-mode `getWaitWithResponse` returns the complete successful body and HTTP metadata. Both forms evaluate states against the original provider body. Unknown states keep waiting until a declared terminal state or deadline; canceling the waiter does not cancel the remote job. Conditional calls retain the declared header and surface conflicts without silently retrying an unconditional write.

When webhook verification is declared, use the generated `verifyWebhook` with original body bytes, signed headers and active rotation secrets. Verification alone does not deduplicate an event. The optional SQLite inbox/outbox examples demonstrate durable acknowledgement, transactional effects, current-state reconciliation and downstream idempotency. Applications supply the database, processing callbacks and retention policy. See [webhook configuration](configuration.md#declared-capabilities) and the generated examples for the selected signing format.

Keep handwritten domain helpers in the generated package's `custom/` directory so regeneration preserves them. See [architecture](architecture.md#extending-the-project) for imports and Composer autoloading.

With schema validation enabled, object property bounds count the encoded keys, including explicit null fields and additional properties; omitted optional fields do not count. Ordinary response decoding remains tolerant of these business bounds.

## Webhook verification

When the provider declares signing, the client exposes `verifyWebhook(rawBody, headers, secrets, nowSeconds?)`. The last argument is a Unix timestamp override for deterministic tests; normally omit it. Use a separate webhook signing secret from application configuration. One string and an array of active rotation secrets are both accepted.

Node accepts `Buffer`/`Uint8Array`, Express/Node `req.headers`, and Fetch `Headers`. Preserve the original bytes before JSON parsing. For a Fetch request:

```js
const rawBody = new Uint8Array(await request.arrayBuffer());
const verified = client.verifyWebhook(rawBody, request.headers, webhookSecret);
```

Register an Express webhook route **before** JSON middleware. `receiveVerified` below represents your application's durable ingestion handler:

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

Pass rotation secrets as `[currentSecret, previousSecret]` in Node or `[$currentSecret, $previousSecret]` in PHP. For Standard Webhooks, each usable secret must start with `whsec_` and contain canonical base64 encoding of exactly 32 bytes. Invalid/empty entries are skipped when another correctly formatted string remains usable; non-string entries and lists with no usable secret are validation errors. Header names are case insensitive. Repeated signatures are supported, but timestamp and event ID headers must each have one value. The generated runtime guide lists the configured header names, format, and tolerance.

`known` requires a registered event name and a matching declared envelope. Checking it narrows the Node event type; checking the event-name field then selects the relevant payload. For an illustrative provider using `event_type`:

```ts
const verified = client.verifyWebhook(rawBody, headers, [currentSecret, previousSecret]);
if (verified.known) {
  const event = verified.event; // Declared event union.
  // Switch on event.event_type for this provider's individual event payloads.
} else {
  const event = verified.event; // unknown: validate before accessing fields.
}
```

Authenticated unknown names and unmatched envelope variants return `known: false` and remain available for review. Malformed declared payloads produce a `protocol` error. Nested response types retain their documented uncertainty; `known` does not make every future nested enum or variant statically known.

Never reconstruct the input with `JSON.stringify` or `json_encode`: whitespace, property ordering and numeric spelling affect the signature. A parsed JSON object produces an SDK validation error. Reserialization can change the bytes and cause a signature mismatch. A mismatch cannot identify whether the secret or body bytes are wrong.

Import `SdkError` from the generated package. Its `code` in Node and `errorCode` in PHP distinguish these failures:

| Kind             | Code                                 | Action                                                        |
| ---------------- | ------------------------------------ | ------------------------------------------------------------- |
| `validation`     | `webhook_invalid_input`              | Supply original body bytes and supported headers/time values. |
| `validation`     | `webhook_invalid_secret`             | Supply at least one correctly formatted nonempty secret.      |
| `authentication` | `webhook_missing_header`             | Forward the configured signing headers.                       |
| `authentication` | `webhook_invalid_timestamp`          | Supply one integer timestamp in seconds.                      |
| `authentication` | `webhook_timestamp_out_of_tolerance` | Check the server clock and delivery age.                      |
| `authentication` | `webhook_invalid_signature`          | Check the signing secret and original request bytes.          |
| `protocol`       | `webhook_invalid_json`               | The authenticated bytes are not valid UTF-8 JSON.             |

```js
try {
  const verified = client.verifyWebhook(rawBody, headers, webhookSecret);
} catch (error) {
  if (!(error instanceof SdkError)) throw error;
  // Record error.kind and error.code without logging bodies or secrets.
  throw error; // Let the HTTP adapter choose the failure response.
}
```

Verification does not deduplicate delivery. Commit a unique event ID and durable work before acknowledging, process effects idempotently, and leave unknown names or unmatched envelopes pending for review. The optional generated SQLite inbox/outbox examples demonstrate this flow.

## Authentication modes

For a composed client, prefer its configured credential shortcuts. Explicit `credentials` keyed by mode and security scheme remain available; select `authMode` on the client or request. Per-request `credentials` contains only that mode's scheme keys. Credentials and headers stay request-local.

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

When the provider configures an `apiKey` shortcut, you can use:

```ts
const client = new Client({ baseUrl, apiKey: 'default-key' });
await client.orders.get(input, { apiKey: 'request-key' });
```

PHP accepts the same configured name as a named argument: `new ClientOptions(baseUrl: $baseUrl, apiKey: $key)` or `new RequestOptions(apiKey: $key)`. The shortcut selects its configured mode and credential. Request overrides do not mutate the client. Explicit request authentication remains available for other modes; do not mix a shortcut and explicit authentication in the same options object.

Generated TypeScript `AuthMode` and `Credentials` declarations list the actual modes and required scheme keys. Each operation limits request options to its permitted modes. The generated runtime guide includes the complete mode/key table. Missing-credential errors name the scheme and mode without printing secret values.

The full Flint profiles expose `token` (merchant bearer), `apiKey` (merchant API-key header), `customerToken`, `onboardingToken`, and `invoiceToken`. Checkout still requires its complete ID/secret credential map. For example:

```js
const flint = new Client({ token: merchantToken });
// Flint's first declared server is production. Select sandbox explicitly:
const sandbox = new Client({
  baseUrl: 'https://api.staging.withflintpay.com',
  token: sandboxToken,
});
```

```php
$flint = new Client(new ClientOptions(token: $merchantToken));
$sandbox = new Client(
  new ClientOptions(baseUrl: 'https://api.staging.withflintpay.com', token: $sandboxToken),
);
```

The SDK never reads environment variables. Generated example scripts read `API_BASE_URL`, `API_TOKEN`, `API_KEY`, or the other shortcut’s uppercase snake-case variable explicitly. A script without a compiled default requires `API_BASE_URL` and explains how to set it. Missing or malformed URLs fail with a structured `baseUrl` validation error. HTTP, including `http://localhost` on anonymous APIs, requires `allowInsecureHttp: true`; origin restrictions still apply through `allowedOrigins`.

PHP uses the same associative maps in `ClientOptions` and `RequestOptions`. Constructor additions are optional named arguments; legacy token-based clients continue to work.

## PDF downloads and declared redirects

PDF methods return `Uint8Array` in Node and binary-safe strings in PHP by default. The `WithResponse` companion exposes the bytes in `body` and `raw`, preserving every byte, including zero and non-UTF-8 bytes. JSON error responses retain ordinary SDK error decoding. Do not convert binary results to UTF-8 text before saving them. Generated PDF operation examples and runtime-guide recipes save those bytes directly; set `API_DOWNLOAD_PATH` to choose their output file.

Explicit `302` and `307` results expose an optional `location`; their `WithResponse` companions expose status and headers in `meta` and the location in `body.location`. Required Location headers are checked. Relative and cross-origin locations are returned without following them. Following a returned location is a separate application decision. Undeclared redirects still fail. Generated redirect examples inspect the response status and returned Location; they do not make a second request or forward API credentials to that location.

## Consuming server-sent events

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

Debug inspection of binary/stream results omits headers and URLs; event inspection omits payloads. Raw fields remain available through explicit property access.

Events expose `event`, `id`, `data`, `rawData`, and optional `retry` milliseconds. The parser handles comments, multiline data, split UTF-8 and CR/LF/CRLF. Incomplete final events are discarded. Invalid UTF-8, malformed configured JSON payloads, and oversized events close the stream with a protocol error. Breaking iteration closes the iterator's connection. Explicit close also handles streams that were never iterated. Client close releases owned streams.

Iteration provides backpressure. PHP's default cURL multi transport queues at most one write chunk and pauses further writes until consumed. PHP cancellation and lifetime checks are cooperative while reading/iterating; synchronous injected transports must honor cancellation while blocked. Node uses AbortSignal, including during an idle read. A PHP injected transport returns a `ByteStream` in `response['stream']`; `read(): ?string` returns bounded chunks or null at EOF and `close(): void` releases resources. The injected request includes stream limits and cancellation. Connection retries can occur only before a stream result is returned, under the operation's declared retry policy. There is no automatic reconnect or delivery guarantee.

Each package's `examples/` directory contains a runnable script for every operation, linked from the API reference. Set the environment variables shown in an example and replace sample IDs with values from your account before running it.

Generated examples use random idempotency keys only when the declared header schema permits their format and length. For patterns, enums, or other constraints that cannot guarantee that format, set `API_IDEMPOTENCY_KEY` to a schema-compatible key before running an example. Create a new key for a new business action and reuse the saved key only for the same action.

PHP `valueOrDefault(field, fallback)` avoids the `getField()` accessor namespace, so wire fields such as `orDefault` retain their existing `getOrDefault()` getter.

Authentication option types are part of the compiled public contract. Migrating from older unrestricted options to named modes, or narrowing an operation’s accepted modes, is reported as breaking and requires a major version under the semver policy. Update shared wrappers to use the mode-specific `RequestOptions<'merchant'>` type when necessary.

## SDK loading and selective Node imports

The ordinary package import and `Client` API remain available. Applications using one resource can import a scoped client from `package-name/resources/paymentIntents` (replace the resource name with one generated by your SDK):

```js
import { Client } from 'package-name/resources/paymentIntents';

const client = new Client({ token: process.env.API_TOKEN });
const result = await client.paymentIntents.get({ payment_intent_id: 'pi_example' });
```

The example uses an SDK with a declared server, a token shortcut and object-style requests. The scoped client keeps the resource's existing argument and return types; it exposes only that resource. Its subpath also exports the related input/response types and reachable model factories. Webhook verification remains on the root client. Existing package-root imports and custom helper imports continue working.

Resource imports allow ESM bundlers to exclude unrelated descriptors. Root clients retain the complete public surface. Both forms defer descriptor decoding until a request, model factory, predicate or webhook verification needs it. A first call can therefore cost more than a subsequent call. Reusing clients also reuses their transports; credentials and mutable request state are never stored in shared descriptor caches.

Splitting adds per-file packaging overhead, so npm and Composer archives can grow even as startup memory falls. Root bundles retain every resource; use resource imports for the strongest bundle-size reduction.

PHP consumers should load `vendor/autoload.php`. Composer no longer eagerly includes the SDK implementation. Public namespaces, model classes and typed resource properties remain unchanged. Classes are split into individual files for autoloading and editor indexing. Heavy descriptors load on demand; no increased PHP memory limit is required for the tested full public fixture. Explicit `SchemaRegistry::contract()` or `codecs()` calls materialize the complete plan for compatibility and are unnecessary for normal generated calls.
