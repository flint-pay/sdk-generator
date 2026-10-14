# Using generated SDKs

Each generated package contains:

- `README.md`: a quickstart and short recipes.
- `REFERENCE.md`: operations grouped by resource, with pagination and polling recipes.
- `MODELS.md`: models with descriptions, units, constraints and examples. TypeScript field comments carry the same information.
- `RUNTIME.md`: options, errors, retries, pagination, webhooks and the authentication table for this SDK.
- `examples/`: a runnable script for every operation.

Resource and method names come from the SDK configuration, or from matching OpenAPI tags and operation IDs. Examples below use the bundled library contract; see the [README](../README.md#use-the-generated-sdk) to generate and install it.

## Install

Node (one ESM package with TypeScript declarations):

- Node.js 22+ for ESM imports. Use a `.mjs` file or a project with `"type": "module"`.
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
- The SDK never reads environment variables or discovers credentials. Pass them from your application's configuration.

All client and request settings are listed under [client and request options](#client-and-request-options).

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

## Make a call

### Arguments

The default argument order is the same in Node and PHP:

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

Credential headers and the configured API-version header are not input fields; pass credentials through [authentication](#authenticate) options. Declared idempotency, conditional and request-ID headers remain optional input fields.

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
- PHP models provide `has()`, presence methods such as `hasDescription()`, and `get()`. Getters, `get()` and magic properties throw a field-specific error for a missing optional field.
- PHP `valueOrDefault('description', 'fallback')` returns the fallback only when the field is omitted; explicit null stays null. Its name avoids the `getField()` namespace, so a wire field such as `orDefault` keeps its `getOrDefault()` getter.
- With `validation: "schema"`, object property bounds count encoded keys, including explicit nulls and additional properties, but not omitted optional fields. Response decoding stays tolerant of these business bounds.

## Errors and retries

```js
import { SdkError } from '@example/library';

try {
  const result = await client.books.retrieveWithResponse('book/123');
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

```php
try {
  echo $client->books->retrieve('book/123')->getTitle();
} catch (SdkError $error) {
  error_log(
    $error->getMessage() .
      ' status=' .
      ($error->status ?? 'none') .
      ' request=' .
      ($error->meta['requestId'] ?? 'no request ID'),
  );
}
```

| Field         | Node                    | PHP                         |
| ------------- | ----------------------- | --------------------------- |
| Provider code | `code`                  | `errorCode`                 |
| Cause         | `cause`                 | `getPrevious()`             |
| Request ID    | `meta?.requestId`       | `$error->meta['requestId']` |
| HTTP status   | `status` or `undefined` | `status` or `null`          |

Shared `kind` values: `transport`, `authentication`, `validation`, `rate_limit`, `not_found` (HTTP 404), `server` (HTTP 500–599), `api`, `conflict`, `protocol`, `cancelled`, `deadline` and `destination`. <!-- copy-ok: `cancelled` is the literal SdkError kind -->

Messages and codes:

- The message is the nonempty JSON string at the configured `errors.messagePath` (default `message`), after redaction. Absent, blank or non-string values fall back to `API returned HTTP <status>`.
- Error paths traverse JSON objects and array indices; scalar values have no child fields.
- Messages and provider codes must be JSON strings. Numeric tokens, including decimal, exponent and large-integer values, never become messages or codes and never match string retry codes. Parsed details keep their exact numeric representation.
- Public codes are redacted; code-based retry matching uses the original string at `errors.codePath`.
- Malformed or non-JSON error bodies keep status, metadata and explicit `raw` access.
- Provider `details` are `unknown` in TypeScript. Read the message, status and code without narrowing them.

| `outcome`  | Meaning for recovery                                                                                                                                      |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `not_sent` | The operation stopped before dispatch. Correct local input, authentication or destination settings.                                                       |
| `response` | A response was received. Inspect status and provider code; a response alone does not establish a successful business effect.                              |
| `unknown`  | The remote effect is uncertain. Reconcile with the provider, or recover using the same persisted idempotency key within its declared retention and scope. |

Retries:

- Without an operation policy, GET/HEAD/OPTIONS make up to three attempts for transport failures and HTTP 408, 429, 500, 502, 503 and 504, with exponential jitter from a 100 ms base and `Retry-After` support. Other methods send once.
- Explicit provider policies replace these defaults.
- Mutations retry only with declared retry and idempotency support and a valid key. Without an optional key they send once; required keys stay required.
- TypeScript exposes `idempotencyKey` only on supported operations. PHP's shared `RequestOptions` rejects unsupported keys at runtime.
- Conflicting keys across operation headers, request headers and `idempotencyKey` fail before dispatch.
- Automatic idempotency keys last for one SDK call. Persist a caller key for application resubmission. After a lost response, never send a fresh mutation with a different key.
- `retryAllowed` reports retry eligibility. It does not authorize a new business operation or exceed the provider policy.

Sensitive data:

- Error inspection shows the message, status, provider code, redacted details and stack frames. Messages, codes and details apply schema and `redactFields` redaction.
- PHP debug traces omit call arguments.
- Diagnostics callbacks get status and kind, without messages, details or stack traces.
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

- Iteration is lazy. Bound it with `maxPages`, `maxItems` or cancellation.
- Each page request gets a fresh `deadlineMs` budget for its retries and decoding. Time spent processing yielded values doesn't count, and there is no overall iterator deadline.
- Pagination does not promise a stable snapshot.

For a polling operation named `get`, `getWait(input, options)` returns the same payload as `get` (a full `Result` in result mode). Payload-mode `getWaitWithResponse` returns the complete body and HTTP metadata.

- Both evaluate states against the original provider body.
- Unknown states keep waiting until a declared terminal state or the deadline, which covers the whole wait.
- Canceling the waiter does not cancel the remote job.

Conditional calls send the declared precondition header and surface conflicts without retrying an unconditional write.

## Webhook verification

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
const verified = client.verifyWebhook(rawBody, headers, [currentSecret, previousSecret]);
if (verified.known) {
  const event = verified.event; // Declared event union.
  // Switch on event.event_type for this provider's individual event payloads.
} else {
  const event = verified.event; // unknown: validate before accessing fields.
}
```

- Authenticated unknown names and unmatched envelopes return `known: false`. Keep them for review.
- Malformed declared payloads produce a `protocol` error.
- `known` does not make future nested enums or variants statically known.

Secret and header rules:

- Standard Webhooks secrets start with `whsec_` and contain canonical base64 for exactly 32 bytes.
- Invalid or empty entries are skipped while another correctly formatted string remains. Non-string entries, or no usable secret, are validation errors.
- Repeated signatures are supported. Timestamp and event ID headers must each have one value.
- The generated `RUNTIME.md` lists the configured header names, format and tolerance.

Failures throw `SdkError`, with the code in `code` (Node) or `errorCode` (PHP):

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

Verification does not deduplicate delivery. Commit a unique event ID and durable work before acknowledging, process effects idempotently, and leave unknown names or unmatched envelopes pending for review. The optional generated [SQLite inbox/outbox examples](configuration.md#webhook-inbox-examples) demonstrate this flow.

## Client and request options

Pass client defaults to `new Client({...})` in Node or `new Client(new ClientOptions(...))` in PHP. Pass request overrides as the last method argument.

| Option                    | Where             | Default and behavior                                                                                                                                                |
| ------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `baseUrl`                 | Client            | First declared server, if present; otherwise required. Explicit values override the default. No credentials, query or fragment.                                     |
| `token`                   | Client            | Absent. See [authenticate](#authenticate) for when it is available.                                                                                                 |
| `allowedOrigins`          | Client            | Only the base URL origin. Applies to every destination, including pagination links.                                                                                 |
| `allowInsecureHttp`       | Client            | `false`; enable only for deliberate local HTTP tests.                                                                                                               |
| `timeoutMs`               | Client or request | `10000`; positive duration per attempt, including response body consumption.                                                                                        |
| `deadlineMs`              | Client or request | `30000`; positive overall duration, not an absolute timestamp. Includes retry waits. Iterator and polling scope: [pagination and polling](#pagination-and-polling). |
| `maxAttempts`             | Client or request | A positive safe integer budget capped at the operation limit. Defaults follow [retries](#errors-and-retries).                                                       |
| `transport`               | Client            | Native fetch in Node, reusable cURL in PHP. Injected transports are caller-owned.                                                                                   |
| `diagnostics`             | Client            | Optional callback receiving operation, attempt, status, request ID, timing and error kind, without bodies or credentials.                                           |
| `redactFields`            | Client            | Additional field names to redact in model inspection, error messages and parsed error details. Does not change response data.                                       |
| `headers`                 | Request           | Request-local header map; includes tenant context and optional User-Agent override. A configured API-version pin takes precedence.                                  |
| `idempotencyKey`          | Request           | Caller-owned stable key for a declared idempotent operation. Persist across retries and process restarts.                                                           |
| `ifMatch`                 | Request           | Value for the declared conditional header, including when that header is `If-None-Match`.                                                                           |
| `signal` / `cancellation` | Request           | Node `AbortSignal` / PHP `Cancellation` token. Stops local work, not a remote mutation.                                                                             |
| `maxPages`, `maxItems`    | Request           | Optional positive limits for generated iterators.                                                                                                                   |

Precedence and budgets:

- Request timeout, deadline and attempt settings override client defaults.
- The deadline is rechecked after response decoding and model construction, so an overrun returns a `deadline` error with response metadata instead of a late success.
- `maxAttempts` budgets are capped at each operation's limit, so one client budget is safe across operations. Set `maxAttempts: 1` to disable retries. A budget cannot enable undeclared mutation retries.
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

Inputs and outputs follow the [schema representations](configuration.md#schema-representations) table. int64/uint64 and decimal fields use exact strings, such as `"9007199254740993"`; date-time inputs also accept JavaScript `Date` or PHP `DateTimeInterface`.

- The schema decides whether an exact string becomes an unquoted number token on the wire. Don't convert an exact amount to a floating-point number before passing it.
- Plain numbers use floating-point precision and reject non-finite values.
- Native dates serialize as UTC ISO 8601 with milliseconds, without changing the supplied object. Invalid JavaScript dates fail validation. String inputs keep their spelling.
- Integer responses accept integral decimal and exponent notation: `1.0` becomes `1`, and `1e3` becomes `1000`. Fractional values are rejected, not rounded.
- Exact numeric enums accept equivalent spellings such as `1.0` and `1e0` for `1`; membership is checked at runtime. Numeric `anyOf` branches also accept equivalent decimal and integer spellings and preserve the request token; `oneOf` still rejects a value matching multiple branches.
- API responses and verified webhooks use the same rules. Each schema decides: a plain `integer` is a native safe integer even where another schema declares the same field `int64`. The SDK never infers a format from a field name.
- Node request arrays need a value at every index; sparse arrays fail validation before dispatch.
- When configured, `money(currency, major)` converts an exact major-unit string to minor units. It rejects whitespace, including trailing newlines, and excess precision.

### TypeScript object types

Response types keep the component name their source schema references, even when another component has an identical shape. All exported component names remain available.

- Fresh object literals with undeclared properties, and misspelled response fields, are type errors. Explicitly open objects and dictionaries accept arbitrary keys.
- Structural typing can still accept extra keys through existing variables; runtime request rules follow the schema.
- Unknown response fields stay present. Read them with an explicit dictionary assertion or narrowing.
- Unknown response object variants need a generated known-variant guard before you read declared fields.
- `Object.keys()` and `Object.values()` can include undeclared fields. Validate values when iterating preserved extras.
- Optional fields named like inherited `Object` members (such as `toString`) include the inherited signature, so you can omit them. Explicit own values are validated, functions are never serialized as strings, and the runtime reads only own request properties.
- An OpenAPI 3.1 schema with `properties` or `required` but no `type` does not require an object. Its type keeps the permitted nonobject values; narrow before reading fields. An enclosing object constraint in an `allOf` still applies.
- A nullable wrapper with one explicitly typed non-null branch and one plain `type: "null"` branch exposes the known value or null. Unknown fields and enum members are preserved; malformed known values fail decoding. Genuinely polymorphic alternatives keep their unknown-variant fallback.

### PHP models

Response getters return generated entities for declared nested objects, lists of entities, and PHP arrays for dictionaries.

- Nested entities use configured component names, such as `Payment`. Inline entities are named from the owning model and property path. Nullable wrappers hydrate the existing named entity or an inline entity.
- A typed envelope reads as `$result->data->getData()->getId()`. Dictionaries use array access, such as `$payment->getMetadata()['label']`, and their values can be entities. Numeric-string dictionary keys follow PHP array-key conversion.
- Wire names are unchanged. Accessors use word boundaries: `request_id` becomes `getRequestId()` and `hasRequestId()`.
- Webhook classes use event names, such as `WebhookEventPaymentIntentSucceeded`, and stay stable when events are added or reordered.
- Response class names include the response status; tagged alternatives also include the branch position. When dispatching by class, a new status can add a return class even with an identical JSON shape. When dispatching by discriminator value, handle unknown tags.
- Unknown or ambiguous alternatives keep their raw fallback representation. Check discriminator values before using a known variant.
- `toArray()` and `jsonSerialize()` return normalized JSON objects and lists, including empty objects.
- In object/array alternatives, PHP lists (including `[]`) are JSON arrays; use `(object) []` for an empty JSON object.
- Accessors (`get()`, magic and typed getters, `toArray()`, `jsonSerialize()`, `toInputArray()`, `toInputValue()`) return defensive copies; editing them does not change the model. To change an input, edit a `toInputArray()` or `toInputValue()` copy and construct a new model. These input exports preserve exact numeric kinds in ambiguous unions.

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
- Node `Model.toJSON()` returns a defensive copy in which exact numbers are strings. Where a field allows both exact numbers and strings, a model rebuilt from that copy treats those strings as JSON strings. To edit an input, keep the original values, including `ExactNumber` instances, and build a new model; or restore `ExactNumber` explicitly at fields meant to be JSON numbers.
- For a null-only schema, use `type: 'null'`. In Node, `type: ['null']` also permits non-null values; PHP rejects them. Nullable forms such as `type: ['string', 'null']` keep their non-null type in both targets.

### SDK loading and selective Node imports

Import a scoped client from `package-name/resources/<resource>` when an application uses one resource:

```js
import { Client } from 'package-name/resources/paymentIntents';

const client = new Client({ token: process.env.API_TOKEN });
const result = await client.paymentIntents.get({ payment_intent_id: 'pi_example' });
```

This example assumes an SDK with a declared server, a `token` shortcut and object-style requests.

- A scoped client exposes only its resource, with the same argument and return types. Its subpath also exports related input and response types and reachable model factories.
- Webhook verification stays on the root client. Package-root and `custom/` helper imports keep working.
- Resource imports let ESM bundlers drop unrelated descriptors; use them for the largest bundle-size reduction. Root clients keep the complete surface.
- Both forms decode descriptors on first use by a request, model factory, predicate or webhook verification, so a first call costs more than later ones. Reused clients reuse their transports; credentials and request state are never stored in shared descriptor caches.
- Split files add packaging overhead, so npm and Composer archives can grow while startup memory falls.
- Node packages bundle their transitive runtime and declaration dependencies, including the shared descriptor validator's `php-value-plan` module. That module is JavaScript and requires no PHP installation.
- PHP classes live in individual files for autoloading and editor indexing. Descriptors load on demand; the tested full public fixture needs no increased memory limit. `SchemaRegistry::contract()` and `codecs()` materialize the complete plan and are unnecessary for normal calls.

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

### Custom helpers

Keep handwritten domain helpers in the generated package's `custom/` directory; regeneration preserves them. See [architecture](architecture.md#extending-the-project) for imports and Composer autoloading.

### Generated examples

Each package's `examples/` directory has a runnable script for every operation, linked from the API reference.

- Scripts read `API_BASE_URL`, `API_TOKEN`, `API_KEY` or the configured shortcut's uppercase snake-case variable explicitly. A script without a compiled default server requires `API_BASE_URL` and explains how to set it.
- Replace sample IDs with values from your account before running.
- Scripts generate random idempotency keys only when the declared header schema permits that format and length. Otherwise set `API_IDEMPOTENCY_KEY` to a schema-compatible key. Use a new key for each new business action, and reuse a saved key only for the same action.
- See [running operation examples](configuration.md#running-operation-examples) for commands.
