# Configuration

The generator reads two local files:

| Input             | Format and purpose                                                                                       |
| ----------------- | -------------------------------------------------------------------------------------------------------- |
| API definition    | OpenAPI 3.0/3.1 **JSON** (not YAML or arbitrary JSON Schema). Holds the upstream API semantics.          |
| SDK configuration | JSON. Holds SDK design and declared capabilities. The format and defaults are the same for both targets. |

Credentials, runtime base URLs and request options are consumer inputs; they never go in the configuration.

## Minimal configuration

`node dist/cli.js init openapi.json sdk.json --targets node` produces a minimal configuration with an `@example/<slug>` package name derived from `info.title`. Replace the placeholder vendor before generating. Omit `--targets` to include both Node and PHP metadata; see [`init`](cli.md#commands).

```json
{
  "version": "0.1.0",
  "targets": ["node"],
  "npm": { "name": "@acme/widgets" }
}
```

```sh
node dist/cli.js diagnose openapi.json sdk.json
node dist/cli.js generate openapi.json sdk.json .generated/widgets
node dist/cli.js validate .generated/widgets
```

- `version` is the generated package's SemVer version, independent of the generator and API versions.
- `targets` defaults to `["node", "php"]`. Package metadata is required only for selected targets: `npm.name` for Node; `composer.name` and `composer.namespace` for PHP.
- Every operation is generated unless you [select operations](#select-operations).
- Names come from tags and operation IDs. With operations `createWidget` and `getWidget` tagged `widgets`, the SDK exposes `client.widgets.create()` and `client.widgets.get()`. See [names](#names).
- Run `diagnose` first. It reports unsupported constructs and missing declarations with their source locations.

## Editor schema

The npm package includes [sdk-config.schema.json](../sdk-config.schema.json), also exported as `@public-sdk/generator/sdk-config.schema.json`. Add a top-level `$schema` key for editor completion and structural validation:

```json
{
  "$schema": "./node_modules/@public-sdk/generator/sdk-config.schema.json",
  "version": "1.0.0",
  "targets": ["node"],
  "npm": { "name": "@acme/widgets" }
}
```

A source checkout can use `./sdk-config.schema.json`. Profiles may carry the same metadata. The schema checks shape and value types in each file, allowing nested declarations to be split across profiles. Run `diagnose` to check completeness after profile merging and declarations against the API; an editor schema cannot establish wire support or validate header names against a separate specification.

## Configuration fields

Unknown configuration keys fail with a source location. Capability declarations go under the relevant `operations` entry unless marked top-level below.

| Top-level field        | Purpose and default                                                                                                                                             |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `$schema`              | Optional editor schema URI; generation stays local and never fetches it.                                                                                        |
| `defaults`             | Shared idempotency, retry and pagination fields; see [capability defaults](#capability-defaults).                                                               |
| `version`              | Required generated package SemVer; independent of the generator version and API version.                                                                        |
| `targets`              | `node`, `php`, or both; defaults to both.                                                                                                                       |
| `npm`                  | `name` required for Node; optional `registry`, `access`, `homepage` and `repository`; see [publication metadata](#publication-metadata).                        |
| `composer`             | `name` and `namespace` required for PHP.                                                                                                                        |
| `license`              | Package license metadata; defaults to `Apache-2.0`. Bundled runtime license is retained.                                                                        |
| `requests`             | Request argument style: `positional` (default) or `object`; see [request arguments](#request-arguments).                                                        |
| `responses`            | Optional SDK-wide return mode (`payload` by default, or `result`) and payload path; see [payload returns](#payload-returns).                                    |
| `operations`           | Public naming, aliases, examples and declared operation capabilities. Matching resource tags and operation IDs supply names; otherwise `api` and `operationId`. |
| `include`, `audiences` | Optional operation filters; operation `hidden: true` excludes that operation.                                                                                   |
| `models`               | Optional component-to-public-model name mapping.                                                                                                                |
| `phpFieldClasses`      | Optional PHP response field class pins among structurally identical models; see [PHP response entity names](#php-response-entity-names).                        |
| `overrides`            | Explicit root-document JSON Pointer replacements before reference resolution; see [overrides](#overrides).                                                      |
| `validation`           | `encoding` by default; `schema` adds supported request bounds, lengths and patterns; see [validation](#validation).                                             |
| `auth`                 | Optional security scheme selection or named modes. Required when multiple declared schemes need disambiguation; see [authentication](#authentication).          |
| `errors`               | Optional provider error code/message/details paths and request-ID header; see [errors](#errors).                                                                |
| `apiVersion`           | Optional pinned request header and value; see [API version pin](#api-version-pin).                                                                              |
| `webhook`              | Optional signing format and event schemas; see [webhooks](#webhooks).                                                                                           |
| `money`                | Optional explicit currency precision table; see [money](#money).                                                                                                |
| `documentation`        | Optional Markdown overview, named guides and featured example operation IDs; see [documentation](#documentation-and-examples).                                  |
| `release`              | Optional distribution `baseUrl` and compatibility `policy` (`review` by default or `semver`); see [release policy](releases.md#version-policy).                 |
| `profiles`             | Optional local JSON profiles merged into this configuration; see [profiles](#profiles).                                                                         |

Other validation rules:

- Namespace segments and public names are validated. Collisions and reserved identifiers fail with source locations.
- `npm.name` must be at most 214 characters, including any scope and separator. `init` shortens derived package slugs to fit and prefixes digit-leading PHP namespace segments with `Sdk`.
- `license` changes distribution metadata only and must accurately describe the provider's package. Bundled Apache-2.0 code and notices stay included.
- PHP-compatible prerelease versions use `alpha`, `beta` or `rc`, optionally with a numeric suffix, such as `1.2.0-beta.1`.

See [CLI usage](cli.md) to diagnose or preview inputs, and [using generated SDKs](using-sdks.md) for client and request options.

## Operations

`operations` keys are exact upstream `operationId` values. A full entry:

```json
{
  "operations": {
    "createWidget": {
      "resource": "widgets",
      "method": "create",
      "aliases": ["createWidget"],
      "audiences": ["public"],
      "idempotency": {
        "header": "Idempotency-Key",
        "retention": "24 hours, as documented by this API",
        "scope": "account and operation",
        "auto": false
      },
      "retry": {
        "maxAttempts": 3,
        "statuses": [429, 503],
        "transport": true,
        "baseDelayMs": 100
      },
      "example": { "body": { "name": "Example" } }
    }
  }
}
```

Stale operation and model customization targets fail diagnosis.

### Names

- `resource` and `method` set the public call; the HTTP method and path are unchanged. Explicit names always take precedence over inferred ones.
- Without them, a uniquely matching operation tag supplies the resource: `createPaymentIntent` tagged `payment_intents` becomes `paymentIntents.create`.
  - Tags are normalized from camelCase, snake_case or words. Singular and plural resource words are matched against the operation ID and removed from the method name.
  - Acronyms become camelCase: `createAPIKey` tagged `api_keys` becomes `apiKeys.create`.
  - Missing, unrelated, ambiguous or reserved tag-derived names fall back to resource `api` and the unchanged operation ID. Diagnosis reports the reason and the `operations.<id>.resource` / `method` settings to edit. The portable method names `list` and `delete` are allowed; model and resource reserved-word checks still apply. Paths are never used to guess names.
- Public name collisions fail diagnosis; resolve them with explicit names.
- `models` maps component schema names to SDK names. Resolved names apply consistently to recursive references and dependencies.
- Upstream model names ending in `Input` default to `Request` (`PaymentInput` becomes `PaymentRequest`), keeping the generated `PaymentRequestInput` helper distinct. Existing names and explicit mappings are reserved first; inferred collisions use `RequestModel`, then numbered suffixes.
- Pin names explicitly when upgrading an existing SDK to keep its public interface.

### Capability defaults

`defaults` applies idempotency, retry and pagination field defaults to every selected operation. An operation object overrides individual fields; arrays replace the complete default array. Set a capability to `false` to omit that configured capability, or set an individual field to `null` to remove an inherited field. Removing a required field fails diagnosis.

```json
{
  "defaults": {
    "idempotency": {
      "header": "Idempotency-Key",
      "retention": "24 hours, per the provider contract",
      "scope": "account and operation",
      "auto": true
    },
    "retry": {
      "maxAttempts": 3,
      "statuses": [429, 503],
      "transport": true,
      "baseDelayMs": 100
    }
  },
  "operations": {
    "createWidget": { "retry": { "maxAttempts": 2 } },
    "listWidgets": { "idempotency": false, "retry": false }
  }
}
```

Use defaults only for capabilities the provider supports. Opt out every operation that does not share the contract, especially mutation retries and pagination helpers. `retry: false` removes the configured policy; ordinary bounded GET/HEAD/OPTIONS retries still apply. Set `retry.maxAttempts: 1` with the other required retry fields (or inherited defaults) to ensure a single attempt. Profiles use their existing conflict rules before capability defaults are resolved.

### Aliases and deprecation

- `aliases` create deprecated methods that call the same wire operation.
- `deprecated` supplies a migration message for an operation. OpenAPI `deprecated: true` also produces a notice.
- TypeScript declarations include operation descriptions, usage examples and deprecation annotations.

### Select operations

- `include` selects operation IDs.
- With `include`, operations without a nonempty `operationId` are skipped. Without it, add IDs to the source before generating. Declared IDs must be unique, including on unselected operations.
- `audiences` selects operations whose declared `audiences` intersect it.
- `hidden: true` excludes an operation.
- `hidden` and operation audience declarations are keyed by `operationId`; they cannot address an unnamed operation. Use `include` to select named operations from such a document.
- Only models needed by selected operations and events are exported. Unselected unsupported components do not block a supported slice.
- Selection never confers server authorization. The private generation record keeps the resolved selected contract and source hashes.

### Request bodies and parameters

- Request bodies support `application/json` and `application/merge-patch+json`. When exactly one supported type is declared, it is selected, even beside unsupported types. When both are declared, set `operations.<operationId>.requestMediaType` to a declared supported type; only its schema controls encoding. For example, select `application/json` for an OAuth operation that also offers form encoding.
- If no declared request media type is supported, selecting `requestMediaType` cannot enable it. Exclude the operation with `include` or `operations.<operationId>.hidden: true`.
- GET/HEAD request bodies are rejected when Node is a selected target; its built-in fetch transport cannot send them.
- HTTP parameters need an explicit non-null scalar type, a supported scalar array, or a union of a scalar with its array. References and conjunctive schemas may supply the type and add constraints. An empty schema or an untyped enum fails diagnosis; declare the type. Typeless schemas remain supported in JSON bodies and models.

## Request arguments

The default is `requests.style: "positional"` for both Node/TypeScript and PHP: path values in URL placeholder order, then flat params, then request options.

```ts
await client.paymentIntents.get(paymentIntentId);
await client.orders.update(orderId, { metadata: { source: 'store' } }, { idempotencyKey });
await client.customers.list({ page_size: 100, page_token: nextPageToken });
```

- PHP uses the same order, with associative arrays for params and `new RequestOptions(...)` for options. Nested model values are supported.
- Operations without a body or query/header parameters have no params argument: a path-only method takes `(id, options)`.
- Other operations keep the params slot. Pass `undefined` (Node) or `null` (PHP) to omit optional params while supplying options.
- Required request bodies need a params object, including `{}` / `[]` for an empty object. An omitted optional body sends no body; an explicitly empty params object sends `{}`.
- With both an optional body and query/header parameters, params containing only those parameters send no body. Use object style to distinguish an empty body in that case.
- Declared query/header names are reserved for those destinations; remaining params fields go into the body.
- Positional style requires a non-null object body. Nonobject bodies and body fields colliding with declared query/header parameters fail diagnosis.
- Typed additional-property dictionaries combined with query/header parameters require object style, because their TypeScript index signatures cannot exclude the parameter keys.
- Aliases, `WithResponse`, `Pages`, `Items`, `Wait`, `PagesWithResponse` and `WaitWithResponse` use the primary method's argument order. The schema still controls path, query, header and body encoding.

Use object style for the whole SDK or one operation:

```json
{
  "requests": { "style": "positional" },
  "operations": {
    "replaceRawDocument": { "request": { "style": "object" } }
  }
}
```

Object style takes `(input, options)`, with path/query/header fields on `input` and the body under `input.body`. It also accepts the generated PHP operation input classes.

Configuration `example` values, HTTP fixtures and exported operation `Input` shapes always use the canonical `{ pathField, queryField, body }` structure; generated runnable examples translate them to the selected call style. Changing styles or positional path order is a breaking change in compatibility checks. Profiles merge request styles under the usual conflict rules.

## Payload returns

New SDKs return the complete decoded body directly (`responses.return: "payload"`). Select `responses.return: "result"` for the `Result` envelope with `data`, `meta` and `raw`. Declare envelope paths explicitly; a field named `data` is never unwrapped automatically.

```json
{
  "responses": { "return": "payload" },
  "operations": {
    "createPaymentIntent": { "response": { "payloadPath": "data" } },
    "getPaymentIntent": { "response": { "payloadPath": "payment_intent" } },
    "getReport": { "response": { "return": "result" } }
  }
}
```

- Settings merge at the SDK and operation levels. You may set an SDK-wide `responses.payloadPath`; an operation's `response.payloadPath: null` clears it, and `response.return: "result"` opts the operation out.
- A dot-separated `payloadPath` must name required, declared properties through non-null objects in every successful JSON response. References and compositions are checked. Optional paths, array traversal and paths through empty, binary or streaming responses fail diagnosis. A nullable payload itself is allowed. Use whole-body or result mode for endpoints with incompatible shapes.
- Unknown union variants keep conservative output types; consumers narrow them before assuming a payload shape.
- Each payload-mode method and alias gets a `WithResponse` companion with identical inputs and options, returning `SdkResponse` with the full `body`, HTTP `meta` and `raw`. PHP uses the same names and properties. Each call makes its own request.
- `Pages` and `Wait` follow the base method's mode. Payload-mode operations also get `PagesWithResponse` and `WaitWithResponse`. `Items` yields individual items. Companion names take part in collision checks.
- Pagination and polling paths always address the original response body, so projection never loses continuation or state. HTTP fixtures assert the complete wire body, through `WithResponse` for payload-mode operations.
- Return settings and payload types are recorded in the compiled contract. Enabling or disabling payload mode, or changing a payload path, is breaking under `semver`.
- Regenerating an SDK that previously used `Result` returns with no `responses.return` produces a diagnostic. Set `"result"` to keep its API or `"payload"` to migrate. Operation-level explicit return choices also count.
- Undeclared 2xx statuses need no configuration; see [response drift and recovery](using-sdks.md#successful-http-responses-and-schema-drift).

## Declared capabilities

Only declared capabilities generate helpers. Pagination and polling fields may take their type from any conjunct, including a property constrained beside a response `$ref`, but every response alternative must supply that type. Item declarations intersect all constraints on an element, so a constraint-only `items` sibling keeps the referenced element type; different response alternatives produce a union of item types.

### Retry

All four fields (`maxAttempts`, `statuses`, `transport`, `baseDelayMs`) are required. Optional `maxDelayMs` caps exponential backoff; both delays must be finite nonnegative numbers. The wait is uniform in `[d/2, d]`, where `d = min(baseDelayMs * 2^(attempt - 1), maxDelayMs)` (uncapped when omitted). A valid `Retry-After` is a minimum wait. If that wait would reach the call deadline, the last error is thrown unchanged with `retryAfterMs` when supplied by the server.

- `maxAttempts` includes the initial attempt (1–10). Client and request budgets are capped at it.
- A policy replaces the defaults completely. Use `maxAttempts: 1` to disable ordinary retries; [credential providers](using-sdks.md#credential-providers) can still add one HTTP 401 retry.
- Without a policy, GET/HEAD/OPTIONS use the [default read retries](using-sdks.md#errors-and-retries) and other methods send once.
- Mutation retries need retry and idempotency declarations and a nonempty key. A missing optional key reduces the call to one attempt; required keys stay required.
- 409 and 412 cannot appear in `statuses`. 412 is never retried.
- Transport replay applies only to fully encoded JSON bodies.

For a body-driven retry decision, configure top-level `errors.retry` together with `errors.codePath`:

```json
{
  "errors": {
    "codePath": "error.code",
    "retry": {
      "path": "error.remediation.retry",
      "retryValues": ["same_request"]
    }
  }
}
```

On a replay-safe call, a string at this path overrides both status and code rules: only a value in `retryValues` retries, including HTTP 409. Other strings, such as `after_refresh` and `none`, veto retries regardless of status. Without a string there, only configured `statuses` apply. HTTP 412 never retries. Non-GET mutation retries still require idempotency support and a key; the signal does not make an unkeyed write safe. Paths use dot-separated fields and `retryValues` must contain nonempty strings. No client-side provider code table is needed.

Without `errors.retry`, retry specific 409 error codes by adding `errors` to the policy:

```json
{
  "retry": {
    "maxAttempts": 3,
    "statuses": [503],
    "transport": true,
    "baseDelayMs": 100,
    "errors": [{ "status": 409, "codes": ["IDEMPOTENCY_KEY_IN_PROGRESS"] }]
  }
}
```

Use the provider's code and set top-level `errors.codePath` (for example `error.code`). These matches obey the same attempt, deadline and idempotency limits. Other 409 codes stay conflicts. A 409 rule requires declared idempotency and cannot be used for conditional updates.

### Idempotency

`header`, `retention` and `scope` are required; `auto` defaults to `false`. Optional `autoKeyPrefix` prefixes the generated UUID v4, for example `flint-sdk-`. The prefix plus UUID must be a valid HTTP header value; generated keys also pass the declared header schema before dispatch.

- Automatic keys are generated only when no explicit key was supplied, including for required headers. They pass the same header validation as explicit keys.
- Explicit keys from operation header inputs, request headers or `idempotencyKey` are preserved across retries. See [errors and retries](using-sdks.md#errors-and-retries) for key lifetime and conflicts.
- Empty keys and keys with leading or trailing spaces or tabs fail before dispatch, because transports can change their wire identity.
- With `auto` off and a required header, TypeScript requires the last options argument with `idempotencyKey: string`. Save this key with the action before the first attempt and reuse it on retry. PHP accepts keys through `RequestOptions.idempotencyKey`, input headers or request headers, and rejects a missing key before dispatch with a message naming the method and `idempotencyKey`. Every error after key resolution exposes the key, including `not_sent` errors; result metadata exposes `idempotencyKey` too.

### Pagination

```json
{
  "pagination": {
    "kind": "cursor",
    "items": "data.items",
    "next": "data.next",
    "parameter": "cursor"
  }
}
```

| `kind`   | `next` field                          | `parameter`                |
| -------- | ------------------------------------- | -------------------------- |
| `cursor` | Next cursor                           | Scalar string query param  |
| `offset` | Next offset, supplied by the provider | Scalar integer query param |
| `link`   | Next URL                              | None                       |

- GET only. The SDK never computes offsets.
- Links resolve relative to the URL of the page that supplied them.
- An int64/uint64 continuation decodes to an exact string, so it needs an int64/uint64 query parameter; incompatible declarations fail diagnosis. Ordinary integer continuations can feed ordinary or exact integer parameters.
- Consumer behavior, limits and deadlines: [pagination and polling](using-sdks.md#pagination-and-polling).

### Polling

```json
{ "polling": { "state": "status", "success": ["done"], "failure": ["failed"], "intervalMs": 100 } }
```

GET only. Unknown states keep waiting within the deadline. Backoff caps at 10 seconds. Canceling a waiter does not cancel the remote job.

### Conditional requests

`{ "conditional": { "header": "If-Match" } }`, or `If-None-Match`.

- Callers supply the precondition through `ifMatch` or request headers, even when the OpenAPI header parameter is required; it need not be duplicated in the input. A missing required precondition fails before dispatch.
- The effective value is validated against the declared header schema.
- Declare 304 when conditional reads can return it. Conflicts never drop the precondition silently.

### API version pin

Top level: `{ "apiVersion": { "header": "X-Api-Version", "value": "2026-09" } }`.

- Sends the header on every request, overriding per-request headers.
- Satisfies a required OpenAPI header parameter without a duplicate input field, and is validated against that header's schema. Headers supplied by an operation's permitted authentication modes are likewise omitted from its inputs and validated by their wire representation after credentials are attached. Anonymous operations and operations whose modes never supply a declared header retain that input field.
- Generated documentation reports this value as the API version, or the schema's `info.version` without a pin. Package versions stay independent.
- Generate from a spec for the same API version; the header does not transform the spec or types. The generator has no global version pin.

### Money

Top level: `{ "money": { "currencies": { "USD": 2, "JPY": 0 } } }`.

Conversion takes an exact major-unit decimal string and returns an exact minor-unit string. Whitespace, including trailing newlines, and excess precision are rejected. There is no implicit rounding or guessed currency table, and currency support is never inferred from a property name.

## Webhooks

Top level `webhook`: an HMAC-SHA256 signing format and event schemas. Other signing protocols fail with a diagnostic naming the protocol.

```json
{
  "webhook": {
    "algorithm": "hmac-sha256",
    "header": "X-Signature",
    "timestampHeader": "X-Timestamp",
    "separator": ".",
    "toleranceSeconds": 300,
    "typeField": "type",
    "events": {
      "widget.changed": {
        "type": "object",
        "required": ["id", "type"],
        "properties": {
          "id": { "type": "string" },
          "type": { "type": "string" }
        }
      }
    }
  }
}
```

| `format`            | Settings                                                                                                          | Signature                                                                                                                                                   |
| ------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hex` (default)     | `header`, `timestampHeader`, `separator`                                                                          | Plain hex HMAC-SHA256 over `timestamp + separator + raw body bytes`.                                                                                        |
| `standard-webhooks` | `header: "webhook-signature"`, `timestampHeader: "webhook-timestamp"`, `idHeader: "webhook-id"`, `separator: "."` | Space-separated `v1,<base64>` over `id.timestamp.rawBody`, keyed by the 32 bytes decoded from a canonical `whsec_` secret.                                  |
| `timestamped-hex`   | `header` (for example `"X-Signature"`), no `timestampHeader`, `separator: "."`                                    | `t=<timestamp>,v1=<hex>` over `timestamp.rawBody` using the full UTF-8 secret. Multiple signatures allow rotation; duplicate timestamp fields are rejected. |

- Required: `algorithm: "hmac-sha256"`, `header`, `separator`, `toleranceSeconds`, `typeField` and `events`.
- Select the provider's format with `format`; a plain hex signature is not interchangeable with a structured signature header.
- Verification checks every supplied rotation secret, timestamp tolerance and payload parsing.
- Top-level OpenAPI `webhooks` are incoming contracts and never generate client methods. Effective literal event types bind incoming payload schemas to the verifier; incompatible explicit bindings fail diagnosis.

Consumer usage, `known` event matching and error codes: [webhook verification](using-sdks.md#webhook-verification).

Each event gets a Node type named `WebhookEvent` plus its PascalCase words, using the same rule as PHP event classes: `payment_intent.succeeded` becomes `WebhookEventPaymentIntentSucceeded`. CamelCase, acronyms and punctuation-separated words normalize consistently. Event names must contain at least one ASCII letter or digit. Two event names producing the same type name (case insensitive), such as `a.b` and `a_b`, fail diagnosis at the escaped `config/webhook/events/<event>` path for every target selection.

When `webhook` is configured, `KnownWebhookEvent`, `VerifiedWebhook`, `verifyWebhook` and every per-event type name are reserved alongside other generated symbols. A clash with a model, resource or operation helper fails diagnosis, including for PHP-only generation. Customize the conflicting model/resource/method name or change the event declaration.

Declared verification also emits a Node root `verifyWebhook(rawBody, headers, secrets, nowSeconds?)` function and PHP `Webhooks::verify($rawBody, $headers, $secrets, $nowSeconds = null)` method, usable without client configuration. If a generated model uses the `Webhooks` class name (case insensitive), it keeps its name and PHP omits the standalone verifier class; use `Client::verifyWebhook` instead. Node's standalone verifier remains available. The exact Node root identifier `errors` is reserved; models named `Errors`, `ValidationError` and `ApiError` retain their names in both targets. Both targets return `reason: 'unknown_event' | 'unmatched_envelope'` when `known` is false; known deliveries have no reason. See [webhook verification](using-sdks.md#webhook-verification).

### Webhook inbox examples

Generated `examples/webhook-inbox.*` implement an optional durable SQLite inbox and outbox, outside the default SDK transport:

- `receiveWebhook` verifies and commits before acknowledgement.
- `processInbox` fetches current state through a supplied callback and applies synchronous database effects atomically with the processed marker. Unknown names and unmatched envelopes stay pending for review.
- `enqueueEffect` deduplicates a stable business-action identity across event IDs. `deliverOutbox` retries that identity after failures and restarts; the downstream service must honor it.
- The application supplies provider-specific state and version checks and owns acknowledgement, retention and connections.
- Databases created before the `known` column need an explicit application migration. Never reinterpret stored unknown events as verified known events.

## Event stream configuration

A declared successful `text/event-stream` response produces a closeable event stream. Optional operation settings add limits and event payload schemas:

```json
{
  "operations": {
    "watchEvents": {
      "stream": {
        "idleTimeoutMs": 30000,
        "maxEventBytes": 1048576,
        "events": { "ready": "#/components/schemas/ReadyEvent" }
      }
    }
  }
}
```

- Defaults: 30 seconds of idle reading and 1 MiB per event.
- Only configured event names get JSON payload decoding; others keep raw strings. The media schema is not a per-event contract.
- Request options `streamIdleTimeoutMs` and `streamLifetimeMs` control idle reading and optional total lifetime.
- Connection setup uses the usual timeout and deadline; the stream owns its connection after the method returns.
- Resume uses the operation's declared last-event-ID input. Reconnection is caller-controlled; nothing is replayed automatically.

## Authentication

Supported credentials: HTTP bearer and header API keys. Cookie authentication and built-in OAuth refresh are unsupported. Credential discovery requires an explicit `auth.defaultCredentials` declaration. Consumers pass nonempty strings or credential providers through `token`, shortcuts or `credentials`; the configuration never holds a secret. Providers are resolved for each request attempt, including retries. Node providers implement `getCredential(): Promise<{ value: string; expiresAt?: Date }>` and optional `invalidate(): void`. PHP accepts a `CredentialProvider` implementing `getCredential(): Credential`, or a `Closure` returning a string or `Credential`. See [credential providers](using-sdks.md#credential-providers).

### Single scheme

With one declared scheme, clients take `token`. With several, select one: `"auth": { "scheme": "BearerAuth" }`.

- Every protected selected operation must offer that scheme as a complete standalone security alternative. Selecting one part of an AND requirement is rejected.
- `security: []` is anonymous. An anonymous alternative beside the selected scheme sends authentication only when the caller supplies a token.
- Combined credentials need named modes.

### Named modes and shortcuts

`auth.modes` names complete OpenAPI security alternatives. Each mode has `schemes` and optional `operations` bindings. One mode supplies the complete credential set for a request.

```json
{
  "auth": {
    "modes": {
      "merchant": { "schemes": ["BearerAuth"] },
      "checkout": { "schemes": ["CheckoutId", "CheckoutSecret"] }
    },
    "shortcuts": {
      "apiKey": { "mode": "merchant", "scheme": "BearerAuth" }
    }
  }
}
```

- Put combined credentials, such as a checkout ID and secret, in one mode's scheme list.
- Modes sharing a bearer destination can represent different roles; bind each to its allowed operation IDs.
- `shortcuts` generate client and request options in Node and PHP (`apiKey` above; rename it to match your product, such as `apiToken`). Each targets the sole scheme of a mode; combined credentials use explicit mode options.
- Shortcut names start with a lowercase ASCII letter, contain only ASCII letters and digits, and avoid existing option names, except `token`.
- A `token` shortcut reuses the client `token` field, adds a request option, and must map to a single-scheme mode. Without it, composed clients reject `token`; they never guess between modes.
- A request shortcut overrides client authentication for that call, and an explicit request mode overrides a client shortcut. One shortcut per options object, never combined with `authMode` or `credentials` there.
- Endpoint mode restrictions apply. Anonymous operations omit client credentials and take no default mode unless the operation permits it.
- An ambiguous request needs an explicit mode. Incomplete scheme sets, contradictory header overrides and inapplicable modes fail before dispatch.
- Profiles merge shortcut mappings and reject conflicting targets.

### Servers

- The first top-level `servers` URL becomes the client's default `baseUrl`; a client value overrides it. Without `servers`, callers must supply `baseUrl`.
- Server URLs must be absolute HTTP/HTTPS URLs without credentials, query, fragment or template variables. Relative URLs, server variables and path or operation server overrides fail diagnosis.
- HTTP defaults still require the consumer's `allowInsecureHttp: true`.

Client and request options, origins, deadlines and transports are in the [consumer guide](using-sdks.md#client-and-request-options).

An optional OpenAPI header parameter can declare `"x-flint-request-option": "client_request_id"`.
The shared compiler routes it to per-call options, `clientRequestId` in Node and
`client_request_id` in PHP, and excludes it from object inputs and positional arguments.
The extension value selects the behavior; the parameter name selects the wire header
(`X-Request-Id` for Flint). Unsupported values, non-header locations and required
parameters fail generation. Values must contain 1 to 128 visible ASCII characters
(0x21 to 0x7E), even with `validation: "encoding"`.

```json
{
  "in": "header",
  "name": "X-Request-Id",
  "required": false,
  "schema": { "type": "string" },
  "x-flint-request-option": "client_request_id"
}
```

Keep `errors.requestIdHeader: "x-request-id"` for Flint responses. The caller's
correlation value and the server's request ID have separate meanings.

### Default credentials and workload identity

Declare discovery alongside named authentication modes. The selected mode must contain exactly one bearer scheme. All environment names and exchange routing belong to provider configuration, never generator code. For example:

```json
{
  "auth": {
    "modes": { "service": { "schemes": ["BearerAuth"] } },
    "shortcuts": { "apiKey": { "mode": "service", "scheme": "BearerAuth" } },
    "defaultCredentials": {
      "mode": "service",
      "scheme": "BearerAuth",
      "environment": { "apiKey": "EXAMPLE_API_KEY", "token": "EXAMPLE_ACCESS_TOKEN" },
      "workloadIdentity": {
        "tokenPath": "/v1/oauth/token",
        "credentialParameter": "workload_identity_id",
        "envPrefix": "EXAMPLE"
      }
    }
  }
}
```

Every field is required. Environment names and the prefix use uppercase letters, digits and underscores; API key and token variables must differ. `tokenPath` is an absolute path on the base URL's origin, without query or fragment. `credentialParameter` is a distinct form parameter, excluding reserved OAuth parameters. Incomplete or incompatible declarations produce diagnostics.

Discovery is lazy and applies only where the configured mode is permitted. Explicit credentials take precedence, including an explicitly supplied empty credential map (which fails rather than falling back). Otherwise the configured API key or access token variable supplies the bearer credential; setting both produces `ambiguous_credentials`. Federation is considered only when `EXAMPLE_WORKLOAD_IDENTITY_ID` is set. `ambientCredentials: false` disables automatic discovery; explicitly supplied discovery providers still run.

The prefix defines `_WORKLOAD_IDENTITY_ID`, `_OIDC_SOURCE`, `_OIDC_AUDIENCE`, `_OIDC_SCOPE`, `_OIDC_TOKEN`, and `_OIDC_TOKEN_FILE` suffixes. Sources are `auto` (token, then token file), `none` (disable federation), `token`, and `token_file`. Files are reread on every exchange, including retries after HTTP 401. Cloud, CI and CLI-process sources are not implemented. The audience defaults to the base URL's origin. JWT payload audience and expiry checks run before exchange; these checks do not verify signatures or replace server verification.

Exchange uses HTTPS or loopback only, never follows redirects, and sends an RFC 8693 form with the configured credential parameter and optional scope. The response is flat: `access_token`, `issued_token_type`, `token_type: Bearer`, numeric `expires_in`, optional `scope`, and provider identity fields. No refresh token is used. Renew by exchanging again. See [consumer behavior](using-sdks.md#default-credentials).

## Errors

`errors` maps provider error conventions:

| Field             | Default                       | Meaning                              |
| ----------------- | ----------------------------- | ------------------------------------ |
| `codePath`        | `code`                        | Dot path to the provider error code. |
| `messagePath`     | `message`                     | Dot path to the server message.      |
| `detailsPath`     | The whole redacted error body | Dot path to error details.           |
| `requestIdHeader` | `x-request-id`                | Response header with the request ID. |

For nested errors: `{"codePath":"error.code","messagePath":"error.message","detailsPath":"error"}`. Paths traverse JSON objects and array indices. See [errors and retries](using-sdks.md#errors-and-retries) for how messages, codes and details are read and redacted.

## Documentation and examples

- `documentation.overview`: Markdown shown near the top of each package README. Use it to link to your public SDK documentation.
- `documentation.guides`: a map of lowercase guide slugs to Markdown, included in both packages and the release site.
- `documentation.examples`: an ordered list of operation IDs to feature, such as `["createPaymentIntent", "getPaymentIntent", "createRefund"]`. Operations outside the selected profile are skipped; remaining slots are chosen automatically.
- `documentation.authShortcut`: an `auth.shortcuts` name that README and operation examples use wherever the operation permits its mode, such as `"apiKey"`. Without it, examples prefer `token`, then other shortcuts by name, then the operation's first permitted mode. Diagnosis checks the name against the merged configuration, so set it in a profile or configuration that also declares or includes that shortcut, not in a shared base profile used alone by profiles without it.
- `operations.<operationId>.example`: realistic SDK inputs for that operation's examples. Generated quickstart inputs are validated during rendering; an invalid inferred or configured example fails generation at `config/operations/<id>/example`.

Schema `example`, `examples`, and `default` values are never published at or below a location marked `x-sensitive: true`, `writeOnly: true`, or `format: password`. This applies to declarations, documentation, runnable samples, and compiled descriptors in both targets. Descriptions remain available. Container examples that could embed a protected descendant are omitted too.

Protection is computed from resolved source references before normalization. A protected use of a component protects its separately published model and other uses. Protection flows into the protected value's properties, array elements, dictionary values, and reference targets, and across compositions and conditionals describing the same value, including bridges between components. Matching fields in composed schemas share protection. If any `additionalProperties`, `patternProperties`, `items`, `prefixItems`, or `contains` constraint is protected, every property, dictionary value and array-element location of that same value is protected across all equivalent schemas. This deliberately permits broader protection within one value. A protected property does not protect its parent or the parent's other children; only the parent's potentially embedding annotations are omitted. Equal inline schema shapes alone do not share protection. Unsupported schema keywords still fail diagnosis; publication protection does not add schema support.

Generated sample inputs use placeholders at protected locations. If constraints prevent a valid placeholder, supply a safe `operations.<operationId>.example`; explicit configuration examples remain publishable inputs and must never contain credentials. Private generation records retain source annotations and publication metadata so regeneration and release rendering agree after restoring a saved record. The `effective` command and compatibility snapshots omit that publication metadata. Adding provenance alone creates no compatibility finding; removing previously published examples or defaults requires `review`, without changing request validation or wire values. Rendering, generation, and release preparation require reloading source inputs with `loadContract` for older contracts that lack publication provenance. Historical compatibility comparison remains available.

For unprotected locations, sample selection follows the schema: schema `example` values (including annotation references and finite recursive examples) and enums retain their precedence. Schema `examples` arrays and defaults remain metadata and do not supply missing inputs. Explicit SDK configuration examples retain the highest precedence.

When the existing sampler would emit a placeholder for an included path or query parameter, it may instead use a parameter-level `example`, or the first named `examples` entry's `value` (in normalized name order), only when all these conditions hold:

- The parameter name does not match `Authorization`, `Cookie`, or the name of any declared `apiKey` security scheme, case-insensitively. Every scheme counts, regardless of its location or whether it is selected for authentication.
- After lowercasing the name and removing all non-alphanumeric characters, it contains none of these substrings: `password`, `passwd`, `secret`, `token`, `apikey`, `clientsecret`, `privatekey`, `accesskey`, `authorization`, `credential`, `signature`, `cookie`, `session`.
- No part of the parameter schema has `x-sensitive: true`, `writeOnly: true`, or `format: password`. This includes reference targets, `items`, `prefixItems`, `contains`, `additionalProperties`, `properties`, and every composition or conditional branch.
- The value validates against the parameter schema.

Otherwise the existing sampler's value is retained. Optional fields that the existing sampler omits stay omitted. Header parameter examples are excluded. Rejected credential or sensitive parameter `example`/`examples` metadata is removed during loading so it cannot reach generated files. Schema annotations are subject to the publication protection above; enum handling is unchanged.

Request-body and media examples are not copied. Exact int64/uint64/decimal parameter examples retain numeric-string tokens; parsed numeric literals fall back rather than copying a potentially rounded value. Invalid parameter examples fall back to the existing sampler. UUID, URI, hostname, IPv4 and IPv6 placeholders replace the literal `"example"` only when they satisfy the full schema, including length, pattern and enum constraints; otherwise the existing sampler's value is preserved. Existing date-time, date and email placeholders are preserved. No internal example annotations are added to contracts or records. Explicit SDK configuration examples must use safe, publishable values. If constraints prevent generating a valid placeholder, supply `operations.<operationId>.example`.

Each target's `REFERENCE.md` is a resource index linking to `reference/<resource>.md`. Operation sections show signatures, request fields, response fields and return-model links, declared error statuses and a minimal example. Shared behavior and the complete error/options references live in target-specific `RUNTIME.md`; `llms.txt` points agents at these entry points. `MODELS.md` includes an index and splits into `models/<name>.md` when it exceeds 100 KB. Request body tables show presence, types, descriptions, enum values and model links, with separate tables for inline `oneOf`/`anyOf` variants. Each variant table combines parent field declarations with the branch's properties, required fields and constraints. These tables omit schema examples. Existing schema metadata and declaration/model documentation are otherwise preserved; this sample policy does not sanitize the source contract or application-owned schemas.

Generated examples require `API_BASE_URL` to select a sandbox or local mock explicitly; they never fall back to a production server. They enable insecure HTTP for localhost/127.0.0.1 mock URLs. Supply the credential environment variables shown in each script and replace placeholder IDs with IDs from that environment.

READMEs start with the install command and one complete quickstart, then up to two short recipes reusing its client, preferring configured examples and covering a create operation, a read operation and another resource when available. Short errors, pagination and webhook sections follow; pagination and webhooks appear only when declared. Detailed behavior is in each package's `RUNTIME.md`, also on the release site. Keep workflow assumptions and provider-specific recovery instructions in the overview and guides.

`example`, `examples`, `default`, `enum` and custom extension payloads keep literal JSON, including fields named `$ref`. Internal `x-sdk-*` extensions are reserved and cannot appear in source definitions.

## Overrides

`overrides` maps exact JSON Pointers in the root input document to replacement JSON values:

```json
{
  "overrides": {
    "/components/schemas/Update/properties/description": {
      "type": ["string", "null"]
    }
  }
}
```

- Overrides replace the addressed value before reference resolution. They are explicit provider corrections and affect both targets.
- Overrides replace existing values only; pointers to missing values fail. They cannot add an absent property such as `operationId`; add it to the source document instead.
- To correct a referenced local schema, override its `$ref` occurrence or vendor a corrected file.
- `effective` prints the resolved contract, customization results, source hashes and selected operations. Treat that output as private.

`effective` omits package metadata for unselected targets. Resolved library contracts and private generation records retain placeholder metadata when that target's settings were omitted: saved-record comparison treats removing it as a package identity change. These placeholders do not select a target or produce a package.

## Profiles

`profiles` lists local JSON profiles, relative to the configuration file.

- Compatible settings merge. Operation selections and mode bindings form unions. Conflicting scalar settings fail diagnosis.
- A profile without `include` contributes the full operation selection. The final configuration may set its own selection.
- Profile cycles fail diagnosis.

## Validation

`"validation": "encoding"` (default) checks required fields, declared types and enums, field choices, nullability, exact numeric representation and integer format ranges. Business limits stay server checks.

`"validation": "schema"` also checks, on requests and model factories:

- `minimum`/`maximum`, exclusive bounds and `multipleOf`.
- String lengths, counted in Unicode code points (not bytes or UTF-16 units).
- Patterns (see [patterns](#patterns)).
- Array lengths, `uniqueItems` and `contains`.
- Object property counts.

Rules for both policies:

- Alternative selection and known-variant guards use the full supported constraints, so they never choose an incompatible wire representation.
- Responses keep values beyond business constraints but still check representable field shapes.
- String `propertyNames` constraints (length, pattern, enum and const) check every object key under both policies and in strict responses. Other key-schema keywords fail loading; see the [supported subset](support-matrix.md#exact-openapi-subset).
- Bounds and numeric enum membership use exact decimal comparison without floating-point coercion.
- Integer formats int32/uint32/int64/uint64 enforce their request ranges; uint64 uses exact strings.
- OpenAPI 3.0 exclusive booleans are normalized with their bounds.
- Unsupported validation keywords, including `minContains` and `maxContains`, fail diagnosis.
- Other textual formats (including IPv4/IPv6) are runtime annotations. New parameter-level example selection checks their format; this does not add format validation to SDK calls.

## Publication metadata

| Field            | Default             | Rules                                                                                             |
| ---------------- | ------------------- | ------------------------------------------------------------------------------------------------- |
| `npm.registry`   | Public npm registry | HTTPS URL without embedded credentials, query or fragment.                                        |
| `npm.access`     | `public`            | `public` or `restricted`; npm requires a scoped package for `restricted`.                         |
| `npm.homepage`   | Omitted             | HTTPS URL of the SDK's public documentation. Never inferred from the generator's repository.      |
| `npm.repository` | Omitted             | `{ "type": "git", "url": "…", "directory": "…" }` with an HTTPS or git+HTTPS URL. Never inferred. |

```json
{
  "npm": {
    "name": "@example/library",
    "homepage": "https://sdk.example.com/library/",
    "repository": {
      "type": "git",
      "url": "git+https://github.com/example/library-sdk.git",
      "directory": "packages/node"
    }
  }
}
```

- No URL may contain embedded credentials.
- `directory` is the package's relative path in a monorepo, with forward slashes and no leading or trailing slashes or `.`/`..` segments. Omit it for a repository-root package.
- Registry and access appear in package `publishConfig` and the release plan. Publishing is a separate command with a version acknowledgement, using the caller's npm credentials. See [release policy](releases.md#version-policy) for `release.policy` and [Composer distribution](releases.md#publish-the-composer-repository-and-documentation) for `release.baseUrl`.
- Generated README links stay relative. For working links on npm, commit the README and its referenced documentation together at the configured package location; a homepage alone does not resolve them.

## HTTP fixture format

Fixtures state expected wire behavior independently of the schema, and should be reviewed by the provider. Run them through the generated public clients without network access:

```sh
node dist/cli.js generate tests/fixtures/payment-api.json tests/fixtures/payment-sdk.json .generated/payments
node dist/cli.js validate .generated/payments --fixtures tests/fixtures/http-cases.json
```

`validate OUTPUT --fixtures FILE` accepts a nonempty JSON array like the [shared HTTP cases](../tests/fixtures/http-cases.json). Each case contains:

| Field            | Meaning                                                                                             |
| ---------------- | --------------------------------------------------------------------------------------------------- |
| `name`           | Scenario name.                                                                                      |
| `operation`      | Operation to call.                                                                                  |
| `input`          | Canonical operation input.                                                                          |
| `options`        | Optional request options.                                                                           |
| `expected`       | Expected HTTP method, path, headers (lowercase names) and body.                                     |
| `responses`      | Sequence of responses to return.                                                                    |
| `data` / `error` | Expected decoded data or structured error.                                                          |
| `attempts`       | Expected attempts, including the first. Defaults to 1.                                              |
| `transportError` | `true` models a lost response.                                                                      |
| `empty`          | `true` expects no response body.                                                                    |
| `baseUrl`        | Optional fixture API base. Defaults to `https://api.example.invalid/v1`; the token is `test-token`. |

- Fixtures exercise generated clients in the selected targets, including input and response models.
- The bundled synthetic scenarios test the generator; they do not prove server correctness. Fixture execution doesn't review the provider's expectations or run against a sandbox; do both separately.
- Use only synthetic credentials. Installation and package tooling may consult configured registries.

## Running operation examples

- Run Node examples from the generated `node/` package: `node examples/RESOURCE-METHOD.mjs`. Each operation emits one JavaScript file, checked against the public declarations with TypeScript `checkJs`.
- For PHP, run `composer install` in the generated `php/` package, then `php examples/RESOURCE-METHOD.php`. Examples locate the application's Composer autoloader when run from an installed package under `vendor/` or copied into the application.
- Single-scheme examples read `API_BASE_URL` and `API_TOKEN`. Named-mode examples read `API_MODE_SCHEME` variables, with mode and scheme uppercased and punctuation replaced by underscores. Shortcut examples read the shortcut's uppercase snake-case variable, such as `API_KEY`. Examples stop with a `Set VARIABLE` error when a required credential variable is unset or empty. For operations that also allow anonymous access, examples send credentials only when all of the mode's variables are set. Client construction itself never reads environment variables.
- Examples never enable insecure HTTP. Add `allowInsecureHttp` deliberately for local HTTP setups.

## Reference

### Input files and references

- Inputs are local files. Relative local `$ref` files are resolved and hashed; vendor remote references before generation.
- Relative references inside sibling fields resolve from the file declaring those fields, including siblings of external references. References keep operation selection, model customization and source hashing.
- Recursive object fields, array items and dictionary values resolve through named model definitions. Nonproductive alias cycles, which never descend through a property, item or dictionary value, fail diagnosis. Generated recursive graphs share named shapes.
- Validation bounds schema traversal at 256 steps and rejects cyclic caller objects before dispatch.
- Generation compiles the resolved definition and configuration into public declarations, codecs and operation settings.

### Reference siblings

Both targets use the same `$ref` sibling rules:

| Context                                                   | Sibling behavior                                                                                                                                                                          |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAPI 3.1 Schema Object                                 | Referenced and sibling constraints all apply, including existing `allOf`, `anyOf`, `oneOf` and `not` constraints.                                                                         |
| OpenAPI 3.0 Reference Object, including schema references | Siblings are ignored, including `description` and `nullable`. Ignored values do not load referenced files.                                                                                |
| OpenAPI 3.1 Reference Object outside schemas              | Local `summary` and `description` override referenced metadata where the target object type supports those fields. Other siblings are ignored.                                            |
| Path Item `$ref`, both versions                           | Nonoverlapping fields combine. A field present locally and in the referenced Path Item is a conflict, even if the values match. Operations and parameter lists are not implicitly merged. |

In OpenAPI 3.1 this schema applies the constraints of `Name` and a maximum length of 40:

```json
{
  "$ref": "#/components/schemas/Name",
  "description": "Name shown on the receipt",
  "maxLength": 40
}
```

- Siblings cannot weaken the referenced schema. Adding properties does not open a referenced object with `additionalProperties: false`, and adding `null` to a sibling type does not make a non-null target nullable.
- Local descriptive metadata takes precedence for display. A true `readOnly`, `writeOnly` or `x-sensitive` on either side stays effective; contradictory read/write direction is rejected.
- A narrowing `type: "array"` sibling may use the `items` of its referenced `allOf` conjunct, even when that conjunct has no `type`. TypeScript keeps those element types and permitted nullability; element constraints stay in their original scope. A standalone array still requires `items`.

For OpenAPI 3.0, put annotations and nullability on an explicit wrapper:

```json
{
  "description": "Optional name shown on the receipt",
  "nullable": true,
  "allOf": [{ "$ref": "#/components/schemas/Name" }]
}
```

### Schema representations

| Contract                          | Node/TypeScript                                 | PHP                                                | JSON wire              |
| --------------------------------- | ----------------------------------------------- | -------------------------------------------------- | ---------------------- |
| `integer` (without int64/uint64)  | Safe integer `number`                           | Safe-range `int`                                   | Integer token          |
| `integer`, `format: int64/uint64` | `${bigint}` output; `${bigint} \| bigint` input | Exact `string`                                     | Unquoted integer token |
| `number`, `format: decimal`       | Exact `string`                                  | Exact `string`                                     | Unquoted decimal token |
| `number`, plain/float/double      | `number`                                        | `int\|float` input, `float` output                 | Number token           |
| `string`, `format: date-time`     | `string\|Date` input, `string` output           | `string\|DateTimeInterface` input, `string` output | JSON string            |
| Other `string` formats            | `string`                                        | `string`                                           | JSON string            |
| Optional field                    | Omitted/undefined property                      | Omitted array key                                  | Absent                 |
| Nullable field                    | `T \| null`                                     | Null value                                         | Explicit null          |
| Object/array                      | Object/array                                    | Typed response model, object or array              | Object/array           |

- Plain numbers must be finite; ordinary floating-point rounding applies.
- Other integers use the shared safe range ±9,007,199,254,740,991. Exact numeric strings may be larger.
- Unknown numeric response fields use numbers for safe integers and strings for larger or decimal tokens.
- OpenAPI 3.0 `nullable` is normalized before generation, including reference wrappers.
- Required `readOnly` fields are response requirements; sending them is rejected. Required `writeOnly` fields are input requirements, excluded from response declarations and ordinary inspection.
- Nested `x-sensitive: true` affects model debug output and parsed error details, not wire serialization. Explicit raw response and body access stays sensitive.
- Schema defaults are documentation and are never inserted into requests.

### Compositions and unions

- `allOf` validates every branch, `anyOf` requires at least one match, and `oneOf` requires exactly one.
- Matching numeric branches merge equivalent values by exact decimal comparison, so `1.0` and `1e0` stay valid for an `anyOf` combining decimal and exact-integer schemas. Merging preserves the request token, never turns JSON strings into numbers, and doesn't relax `oneOf` exclusivity. If the shared numeric interpretation invalidates every branch that supplied a numeric conversion, the value is rejected before dispatch.
- Field-choice rules can use `required` and `not` without repeating an object shape or declaring a discriminator. An optional discriminator needs disjoint required string enum tags.
- Composition keeps sibling constraints and exact numeric encoding.
- Unknown response tags and enum values stay unchanged and are never converted to a known result. Required fields of known schemas must exist and known field shapes must be representable. Request enums and unknown-property restrictions are enforced.
- Untagged object response alternatives keep future objects through an unknown-object branch.
- Tagged operation responses export an `is<Resource><Method>ResponseKnown` guard. Check it before switching on known discriminator values; unknown variants stay available.
- A response union reached through `allOf`, including a `$ref` with sibling constraints, also gets a guard:
  - The guard checks the complete composed schema, including sibling required fields, bounds and `not`, before narrowing.
  - Tagged unions wrapped this way keep PHP variant classes. Their constructors validate the branch with the surrounding constraints, and their getters include sibling fields.
  - Normal decoding and PHP response constructors stay tolerant of business bounds and future fields.
- A nullable wrapper with one explicitly typed non-null branch and one plain `type: "null"` branch keeps that branch's fields; see [TypeScript object types](using-sdks.md#typescript-object-types) and [PHP models](using-sdks.md#php-models).
- Constraints apply at every depth: array items, dictionary values, recursive fields, and types or bounds from another `allOf` branch or `$ref` sibling. A named property can take constraints from another branch's `additionalProperties`; specializing a named property doesn't change the dictionary rule for other keys.
- Numeric interpretation follows the selected branch's representation: a numeric-looking value in a string branch stays a JSON string, and exact-number strings keep their numeric meaning.
- Mutually dependent unions, where one branch's numeric interpretation depends on another's, are matched jointly under a bounded search. An unusually ambiguous schema can exhaust it and fail validation. Give each field's type and constraints together, or declare a discriminator.

### Numeric literals and enums

- Numeric enums accept equivalent spellings such as `1`, `1.0` and `1e0`. TypeScript represents exact numeric enum inputs as strings and checks membership at runtime, including single-element type arrays such as `type: ["number"], format: "decimal"`. Native-number enums use numeric literals.
- Numeric bound literals must be finite, with integer literals in the safe range of the generator's JSON parser.
- Source numeric constraints must keep their decimal value through that parser:
  - `0.1000` and `1e-1` are accepted. `0.10000000000000001`, which would become `0.1`, fails at the constraint location.
  - The check covers bounds, `multipleOf`, numeric enums, numbers inside `const`, and numeric values in configuration and profiles.
  - Ignored OpenAPI examples and excluded operations are not checked.
  - Use an override to replace a problematic constraint.
  - Exact numeric strings passed to generated SDKs are unaffected.

### Patterns

- Patterns use a portable Unicode ECMAScript subset, translated for PHP: character classes, groups, alternation, anchors and quantifiers. Lookarounds, backreferences, special groups and unsupported escapes fail diagnosis.
- `\d`, `\D`, `\w` and `\W` keep ECMAScript's ASCII meaning in both targets, including inside classes: `^\w+$` rejects `é` and non-ASCII digits. Use explicit Unicode characters or ranges to accept them.
- Diagnosis rejects simple nested unbounded repetition such as `(a+)+`, `(.*)*` and `([a-z]+){2,}`: repeated groups made of a single unbounded repetition. Delimited patterns such as `(?:[.-][a-z0-9]+)*` are accepted. This is a limited safeguard against expensive matching, applied during generation only, not to schemas passed to runtime helpers.

### Nested models and ambiguous representations

- Node emits a canonical response name for identical declarations, retaining distinct effective shapes. `NameInput` and `makeName` helpers are emitted only for models reachable from operation inputs. Request-body names follow source component references; anonymous bodies stay within the owning operation input. PHP emits presence-aware `NameInput` classes, operation input and response classes, PHPDoc shapes and typed field accessors. Request and response types are compiled separately to keep responses extensible.
- PHP object inputs use `new OperationInput(['field' => null])`. Scalar, array and nullable named model constructors accept their values and expose them with `jsonSerialize()`. Omitted keys stay omitted; `has()` distinguishes missing from null. Omitted optional response fields read as null through nullable getters; omitted input fields still throw on access. Required response fields fail during decode, and unknown property names fail loudly.
- TypeScript models field-absence constraints where possible; value-specific `not` constraints keep a broader input type and are enforced at runtime.
- Named model factories nest in TypeScript inputs through `InputValue<T>`. For models that also permit nonobjects, passing an object keeps the object branch in the factory return type, so it fits object-constrained fields, including recursive references. Factories normalize nested wrappers into plain values, and serialization revalidates them.
- PHP wrappers unwrap nested models into plain values and keep object/array/scalar/null shapes; `toArray()` applies only to array or object models. In object/array alternatives, PHP lists (including `[]`) are JSON arrays, associative arrays are objects, and `(object) []` is an empty object. A directly declared object input still accepts `[]`. Responses keep the JSON object/array distinction.
- Cyclic values, including opaque additional fields, fail before dispatch.
- Exact-number/string alternatives use `ExactNumber` at ambiguous input paths, including inside objects, arrays and dictionaries: plain strings stay JSON strings, and `new ExactNumber("1.2500")` selects a JSON number. Other exact numeric inputs stay strings; distinct required tags can separate alternatives without wrappers. Numeric intersections needing inconsistent representations fail diagnosis. Safe-integer/string alternatives are supported.

### TypeScript declarations

Shaped objects, including responses, have no implicit index signature. `additionalProperties: true` or an additional-property schema keeps a declaration open, and unstructured objects stay dictionaries. Consumer effects: [TypeScript object types](using-sdks.md#typescript-object-types).

### PHP response entity names

- Configured component model names also name reusable PHP response entities. Inline response objects are named from the owning model and property path.
- Accessor and webhook class naming: [PHP models](using-sdks.md#php-models).
- Names are checked case-insensitively; collisions fail with both fields or events identified.
- These names and hydrated dictionary representations are part of the package's compatibility contract.

Structurally identical component schemas can share one PHP class, so a field can return a class other than the one its `$ref` names. Annotations beside a `$ref`, such as `description` or `readOnly`, never change the class. To keep the class an existing PHP SDK returns, pin it with `phpFieldClasses`. Here `Location` and `Place` are identical, and the pin keeps `Venue::getMailingAddress()` returning `Location`:

```json
{
  "phpFieldClasses": {
    "Venue": { "mailing_address": "Location" }
  }
}
```

- Owner keys are generated PHP response class names without a namespace: component model, operation response, variant and webhook event classes. `Input` classes cannot be owners.
- Field keys are serialized JSON property names, not accessor names. `writeOnly` fields are not response fields.
- Values are generated public model names after `models` mapping.
- The field must hold a single response entity, directly or nullable. Lists, dictionaries, other unions and scalars cannot be pinned.
- The pinned model must be structurally identical to the default. Root-level `description`, `title`, `deprecated`, `readOnly` and `writeOnly` are ignored; any other difference, including nested fields, `required`, constraints, enums and `x-sensitive`, fails diagnosis. A pin matching the default is allowed and validated.
- Pins apply before default classes are built, so output doesn't depend on build order, and an unused default class is not generated.
- Pins change only PHP response getter types and hydrated classes. Input classes, Node declarations, schema definitions and wire serialization are unchanged.
- Generation fails when `targets` excludes `php`, the owner isn't a generated PHP response class, the owner has no such response field, or the value isn't a generated, structurally identical model.
- Profiles merge matching pins; different classes for the same owner and field conflict. Pins are keyed by PHP class, so the same source field reached through another class needs its own entry.
- Regeneration reports changed PHP field classes as [compatibility findings](releases.md#migrating-php-entity-representations); use them to find fields to pin.

### Generated package loading

Descriptor grouping and deferred loading are automatic. Node packages also export `resources/<resource>` scoped clients; PHP packages use class-based Composer autoloading. See [SDK loading](using-sdks.md#sdk-loading-and-selective-node-imports).

### Request identification

Generated clients send a User-Agent with the configured package name, package version and runtime, without machine identifiers or credentials. Per-request `headers` can override it.

### Library schemas and large exports

- Named payload dependencies are kept as local compiled references. Library consumers inspecting `loadContract` schemas follow `x-sdk-ref` through `contract.definitions`.
- When passing such a schema to standalone runtime helpers, supply its definitions: `serialize(value, { ...schema, "x-sdk-definitions": contract.definitions })` or `redact(value, schema, [], contract.definitions)`. Generated clients and model helpers do this automatically. Shared references bound repeated schema expansion without removing operations or constraints.
- Large exports can need a larger generator heap, for example `node --max-old-space-size=3072 dist/cli.js generate API.json SDK.json OUTPUT`. Installed clients don't.

### Deprecated settings

`numericUnions: "explicit"` and `schemaSharing: "named"` are deprecated aliases for automatic behavior; omit them. They are still accepted, invalid values fail diagnosis, and the CLI prints a deprecation warning on stderr. Library callers receive warnings through `loadContract(..., { onWarning })`.
