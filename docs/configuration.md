# Configuration and contract subset

The generator accepts OpenAPI **3.0/3.1 JSON**, not YAML or arbitrary JSON Schema. Keep upstream API semantics in the API document and SDK design/capabilities in a separate JSON file. Both inputs are local files. Relative local `$ref` files are resolved and hashed; vendor remote references before generation. Recursive object fields, array items and dictionary values resolve through named model definitions; nonproductive alias cycles and `$ref` siblings are rejected. Validation bounds schema traversal at 256 steps and rejects cyclic caller objects before dispatch. Generated recursive graphs share named shapes to avoid repeated expansion.

Generation compiles the resolved definition and configuration into public declarations, codecs and operation settings. The configuration format and defaults are the same for both targets. Credentials and request options remain client inputs.

```json
{
  "version": "1.0.0",
  "targets": ["node", "php"],
  "npm": { "name": "@acme/service" },
  "composer": { "name": "acme/service", "namespace": "Acme\\Service" },
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

GET/HEAD request bodies are rejected when Node is a selected target because its built-in fetch transport cannot send them.

HTTP parameters require an explicit non-null scalar type or a supported scalar array. An empty schema or an enum without a type is insufficient for parameter encoding and fails diagnosis; declare the intended type. Typeless schemas remain supported in JSON bodies and models.

Package metadata is required only for selected targets. `targets` defaults to both. Namespace segments and public names are validated; collisions and reserved identifiers fail with source locations. `license` changes distribution metadata only and must accurately describe the provider's package; bundled Apache-2.0 code and notices remain included. PHP-compatible prerelease versions use `alpha`, `beta`, or `rc`, optionally with a numeric suffix, such as `1.2.0-beta.1`.

## Configuration fields

Unknown configuration keys fail with a source location. Capability declarations belong under the relevant `operations` entry unless the table marks them as top-level.

| Top-level field        | Purpose and default                                                                                                                             |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`              | Required generated package SemVer; independent of the generator version and API version.                                                        |
| `targets`              | `node`, `php`, or both; defaults to both.                                                                                                       |
| `npm`                  | `name` required for Node; optional `registry` and `access` control publication metadata.                                                        |
| `composer`             | `name` and `namespace` required for PHP.                                                                                                        |
| `license`              | Package license metadata; defaults to `Apache-2.0`. Bundled runtime license is retained.                                                        |
| `operations`           | Public naming, aliases, examples and declared operation capabilities. Defaults to resource `api` and method equal to `operationId`.             |
| `include`, `audiences` | Optional operation filters; operation `hidden: true` excludes that operation.                                                                   |
| `models`               | Optional component-to-public-model name mapping.                                                                                                |
| `overrides`            | Explicit root-document JSON Pointer replacements before reference resolution.                                                                   |
| `validation`           | `encoding` by default; `schema` adds supported request bounds, lengths and patterns.                                                            |
| `auth`                 | Optional explicit security scheme selection. Required when multiple declared schemes need disambiguation.                                       |
| `errors`               | Optional provider error code/details paths and request-ID header.                                                                               |
| `apiVersion`           | Optional pinned request header and value.                                                                                                       |
| `webhook`              | Optional signing format and event schemas.                                                                                                      |
| `money`                | Optional explicit currency precision table.                                                                                                     |
| `documentation`        | Optional Markdown overview and named guides.                                                                                                    |
| `release`              | Optional distribution `baseUrl` and compatibility `policy` (`review` by default or `semver`); see [release policy](releases.md#version-policy). |

See [CLI usage](cli.md) to diagnose or preview these inputs, and [using generated SDKs](using-sdks.md) for runtime client/request options. Credentials and runtime base URLs are supplied by consumers, not stored in the SDK configuration.

## SDK customization

`operations` keys are exact upstream `operationId` values. `resource` and `method` customize the public call while preserving HTTP method/path. `aliases` create deprecated methods invoking the same wire operation. Stale operation/model customization targets fail.

`deprecated` supplies a migration message for an operation. OpenAPI `deprecated: true` also produces a notice. Generated TypeScript declarations include operation descriptions, usage examples and deprecation annotations. Tagged operation responses export an `is<Resource><Method>ResponseKnown` guard: check it before switching on known discriminator values; unknown variants remain available unchanged.

Providers can supply `documentation.overview` as Markdown and `documentation.guides` as a map of lowercase guide slugs to Markdown. Both packages and the release site include version-matched guidance. Keep workflow assumptions and provider-specific recovery instructions here, alongside operation examples.

`errors` maps provider conventions: `codePath` and `detailsPath` are dot-separated fields in JSON error bodies; `requestIdHeader` selects the response header. Defaults are `code`, the whole redacted error body, and `x-request-id`. Malformed or non-JSON errors retain status, metadata and explicit `raw` response access. `ClientOptions.redactFields` adds field names to recursive inspection/error-detail redaction without altering response data.

`include` selects operation IDs. `audiences` selects operations whose declared `audiences` intersect it. `hidden: true` excludes an operation. Selection never confers server authorization. Only models needed by selected operations/events are exported; the private generation record retains the resolved selected contract and source hashes. Unselected unsupported schema components do not prevent a supported slice from generating.

`models` maps component schema names to SDK names. Public request and response types are compiled separately to preserve response extensibility. The same compilation produces the codecs bundled with each package. Node creates `Name`, `NameInput`, and `makeName` model helpers. PHP emits presence-aware `NameInput` classes plus operation input/response classes, PHPDoc shapes and native typed field accessors. Object inputs use `new OperationInput(['field' => null])`; scalar, array and nullable named model constructors accept their corresponding values and expose them with `jsonSerialize()`; omitted keys remain omitted. `has()` and `get()` distinguish a missing key from null. Getters for omitted optional fields throw, rather than inventing a value. TypeScript models field-absence constraints where possible; value-specific `not` constraints retain a broader input type and are enforced at runtime.

Optional TypeScript fields named like inherited `Object` members (for example `toString`) include the inherited signature in their type so callers can omit the own field. Explicit own values still undergo runtime validation; functions are never serialized as strings. Required fields retain their declared types. The runtime reads only own request properties.

`example`, `examples`, `default`, `enum`, and custom extension payloads retain literal JSON data, including fields named `$ref`. Internal `x-sdk-*` extensions are reserved and cannot be supplied in source definitions.

`overrides` maps exact JSON Pointers in the root input document to replacement JSON values, for example:

```json
{
  "overrides": {
    "/components/schemas/Update/properties/description": {
      "type": ["string", "null"]
    }
  }
}
```

Overrides replace the addressed value and apply before reference resolution. They are explicit provider corrections to API semantics and affect both targets. Pointers to missing values fail. To correct a local referenced schema, override its `$ref` occurrence or maintain a corrected vendored file. `effective` prints the resolved contract, customization results, source hashes and selected operations. Treat that output as private.

## Schema representations

| Contract                              | Node/TypeScript            | PHP                                   | JSON wire              |
| ------------------------------------- | -------------------------- | ------------------------------------- | ---------------------- |
| `integer` (without int64/uint64)      | Safe integer `number`      | Safe-range `int`                      | Integer token          |
| `integer`, `format: int64/uint64`     | Exact `string`             | Exact `string`                        | Unquoted integer token |
| `number`, `format: decimal`           | Exact `string`             | Exact `string`                        | Unquoted decimal token |
| `string`, including decimal/date/time | `string`                   | `string`                              | JSON string            |
| Optional field                        | Omitted/undefined property | Omitted array key                     | Absent                 |
| Nullable field                        | `T \| null`                | Null value                            | Explicit null          |
| Object/array                          | Object/array               | Typed response model, object or array | Object/array           |

JSON `number` values, including plain numbers and float/double formats, use exact strings in SDK inputs and outputs. Unsafe JS numeric inputs fail before transmission. The safe integer range shared by both runtimes is ±9,007,199,254,740,991. Exact numeric strings may be larger. Currency support is optional and never inferred from a property name.

`allOf` validates every branch, `anyOf` requires at least one matching branch, and `oneOf` requires exactly one. Field-choice rules can use `required` and `not` without repeating an object shape or declaring a discriminator. An optional discriminator requires disjoint required string enum tags. Composition retains sibling constraints and exact numeric encoding. Unknown response tags and enum values remain unchanged; they are not converted to a known result. Unknown numeric response fields use numbers for safe integers and strings for larger/decimal tokens. Response fields required by known schemas must exist and known field shapes must be representable. Request enums and unknown-property restrictions are enforced. Ordinary schema defaults are documentation, never silently inserted into a request. Generated quickstart inputs are validated during rendering; if an inferred or configured example cannot satisfy the schema, generation identifies `config/operations/<id>/example` so the provider can supply a valid example. OpenAPI 3.0 `nullable` is normalized before generation, including reference wrappers. Required readOnly fields are response requirements; sending them is rejected. Required writeOnly fields are input requirements and are excluded from response declarations and ordinary inspection. Nullable and field-choice rules are checked through both generated public clients. Untagged object response alternatives preserve future objects through an unknown-object branch; the generated known-variant guard verifies shape and sibling requirements before narrowing.

Nested `x-sensitive: true` metadata affects model debug representations and parsed error details, not wire serialization. Explicit raw response/body access remains sensitive. Set top-level `"validation": "schema"` to check declared minimum/maximum, exclusive bounds, string lengths, patterns and array lengths on requests and model factories. The default `"encoding"` policy retains required fields, declared types/enums, field choices, nullability, exact numeric representation and integer format ranges; business limits remain server checks. Alternative selection and known-variant guards use the full supported constraints so they never choose an incompatible wire representation. Responses retain values beyond these business constraints while still checking representable field shapes. Bounds and numeric enum membership use exact decimal comparisons without floating-point coercion of caller values. Numeric enums accept equivalent spellings such as `1`, `1.0` and `1e0`; generated TypeScript represents exact numeric enum inputs as strings and enforces membership at runtime, including single-element type arrays such as `type: ["number"]`. Integer formats int32/uint32/int64/uint64 enforce their request ranges; uint64 uses exact strings. String lengths count Unicode code points, not bytes or UTF-16 units. Patterns use a portable Unicode ECMAScript subset, translated for PHP: character classes, groups, alternation, anchors and quantifiers; lookarounds, backreferences, special groups and unsupported escapes receive diagnostics. Other textual formats are annotations. OpenAPI 3.0 exclusive booleans normalize with their associated bounds. Unsupported validation keywords, including multipleOf, fail with diagnostics. Numeric bound literals must be finite, with integer literals in the safe range of the generator's JSON parser.

Portable patterns retain ECMAScript's ASCII meaning for `\d`, `\D`, `\w`, and `\W` in both targets, including inside character classes. For example, `^\w+$` rejects `é` and non-ASCII digits. Use explicit Unicode characters or ranges when those values should be accepted.

## Declared capabilities

- `retry`: all four fields are required. `maxAttempts` includes the initial attempt (1–10); caller/client overrides may lower it but cannot exceed the declared limit. HTTP method alone does not enable retries. Mutation retries require an idempotency declaration and a nonempty key. Neither 409 nor 412 can appear in blanket retry statuses; specific 409 error codes can be declared through `errors` on the retry policy. 412 is never retried. Transport replay applies only to fully encoded JSON bodies.
- `idempotency`: header name, retention and scope descriptions are mandatory. `auto` defaults false. An automatically generated key is stable only within one SDK call; persist a caller key for application resubmissions and recovery across restarts. Explicit keys supplied through operation header inputs, request headers, or `idempotencyKey` are preserved across retries; conflicting values fail before dispatch. Empty keys and keys with leading or trailing spaces or tabs are rejected before dispatch because HTTP transports can change their wire identity. Automatic keys are generated only when no explicit key was supplied.
- `pagination`: `{ "kind": "cursor", "items": "data.items", "next": "data.next", "parameter": "cursor" }`. Offset pagination uses the same form with `kind: offset` and a provider response field containing the next offset; the SDK never invents offset arithmetic. Link pagination uses `kind: link`, an explicit next-URL response field, and no query parameter. Links are resolved relative to the URL of the page that supplied them. GET only. Cursor parameters must be scalar strings; offset parameters must be scalar integers. An int64/uint64 continuation requires an int64/uint64 query parameter because it decodes to an exact string; incompatible declarations fail diagnosis. Ordinary integer continuations can feed either ordinary or exact integer parameters. Items/pages are lazy and bounded by overall deadline and optional caller limits.
- `polling`: `{ "state": "status", "success": ["done"], "failure": ["failed"], "intervalMs": 100 }`. GET only; unknown states continue waiting within the deadline. Backoff caps at 10 seconds. Canceling a waiter does not cancel a remote job.
- `conditional`: `{ "header": "If-Match" }` or `If-None-Match`. Callers use `ifMatch` to supply the declared precondition. Declare 304 when conditional reads can return it. Conflicts never silently drop the precondition.
- `apiVersion` (top level): `{ "header": "X-Api-Version", "value": "2026-09" }`. Pins a version header on every request, taking precedence over per-request headers. Generated documentation reports this value as the API version, falling back to the schema's `info.version` when no pin is configured. Package versions remain independent semver versions. Generate from a spec for the same API version; setting a header does not transform the spec or generated types. This setting is optional and provider-specific; the generator has no global API version pin.
- `money` (top level): `{ "currencies": { "USD": 2, "JPY": 0 } }`. Conversion accepts an exact major-unit decimal string and produces an exact minor-unit string. Whitespace, including trailing newlines, and excess precision are rejected; implicit rounding and guessed currency tables are absent.
- `webhook` (top level): an HMAC-SHA256 signing format and event schemas. Other signing protocols fail with a diagnostic naming the unsupported protocol.

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

The default format (`hex`) is a plain hex HMAC-SHA256 signature over `timestamp + separator + raw request body bytes`, with timestamp in a separate header. Select a format explicitly for a provider; a plain hex signature is not interchangeable with a structured signature header. Verification checks all supplied rotation secrets, timestamp tolerance and payload parsing. Unknown event types return `known: false`.

Generated `examples/webhook-inbox.*` implement a durable SQLite inbox and outbox. `receiveWebhook` verifies and commits before acknowledgement; `processInbox` fetches current state through a supplied callback and atomically applies synchronous database effects with the processed marker. Unknown event types remain pending for review. `enqueueEffect` deduplicates a stable business-action identity across multiple event IDs. `deliverOutbox` retries the same identity after failures/restarts; the downstream service must honor that idempotency contract. The application supplies provider-specific state/version checks and owns acknowledgement, retention and connections. These examples are optional dependencies, not part of the default SDK transport. Existing example databases predating the `known` column need an explicit application migration; do not reinterpret unknown stored events as verified known events.

Additional formats use `separator: "."`:

- `standard-webhooks`: set `header: "webhook-signature"`, `timestampHeader: "webhook-timestamp"`, and `idHeader: "webhook-id"`. Verifies space-separated `v1,<base64>` signatures over `id.timestamp.rawBody`, using the 32-byte key decoded from a canonical `whsec_` secret. The supported key profile requires exactly 32 decoded bytes.
- `timestamped-hex`: set `header` to the provider's signature header (for example `"X-Signature"`) and omit `timestampHeader`. Verifies `t=<timestamp>,v1=<hex>`, allowing multiple signatures for rotation, over `timestamp.rawBody` using the complete UTF-8 secret. Duplicate timestamp fields are rejected.

Retry policies can declare `errors: [{ "status": 409, "codes": ["IDEMPOTENCY_KEY_IN_PROGRESS"] }]` alongside `statuses`. Use the provider's own error code and configure the top-level `errors.codePath` (for example `error.code` for nested errors). These exact matches are subject to the same attempt, deadline and idempotency limits. Other 409 codes remain conflicts without retry. A 409 rule requires declared idempotency and cannot be used for conditional updates; 412 is never eligible.

## Authentication and client options

Supported credentials are HTTP bearer or a header API key. When the definition declares multiple schemes, select one using `"auth": { "scheme": "BearerAuth" }`. Every protected selected operation must offer that scheme as a complete standalone security alternative. Selecting one part of an AND requirement is rejected. `security: []` is anonymous; an anonymous alternative alongside the selected scheme sends authentication only when the caller supplies a token. Cookie authentication, combined credentials, OAuth refresh and implicit credential discovery remain unsupported.

Every client requires an explicit `baseUrl`. Credentials come from `token`; the generator never takes a credential in configuration. `allowedOrigins` defaults to the base URL's origin (scheme, host, port). Configure additional credential destinations deliberately. HTTPS is required unless `allowInsecureHttp` is explicitly enabled for local tests. Redirects are rejected. Per-request headers allow tenant context without shared mutable state. Node options are plain objects; PHP uses `ClientOptions` and `RequestOptions` value objects.

The default per-attempt `timeoutMs` is 10,000 and overall `deadlineMs` is 30,000. Both are durations in milliseconds; request values override client defaults. Attempts default to the operation's declared policy, or one attempt when none is declared. The [consumer option reference](using-sdks.md#client-and-request-options) lists all options and language differences.

Privileged injected transports must honor timeout/cancellation and destination constraints, and must disable their own redirects/retries. Node uses the fetch signature. PHP receives `{url, method, headers, body, timeoutMs, cancellation}` and returns `{status, headers, body}`. The SDK does not close caller-owned transports. PHP's built-in reusable cURL handle is SDK-owned and released on close/destruction. Node uses the built-in fetch pool and does not own a separate pool to dispose.

## HTTP fixture format

`validate OUTPUT --fixtures FILE` accepts a nonempty JSON array like the [shared HTTP cases](../tests/fixtures/http-cases.json). Each case contains `name`, `operation`, `input`, optional request `options`, `expected` HTTP method/path/headers/body, a sequence of `responses`, and expected `data` or structured `error`. `attempts` includes the initial attempt and defaults to one. `transportError: true` models losing a response; no network is used. Optional per-scenario `baseUrl` selects the fixture API base; its default is `https://api.example.invalid/v1` and token is `test-token`. Header expectations use lowercase names. `empty: true` expects no response body. Use only synthetic credentials in fixtures.

These checks invoke generated public clients in the selected targets, including their input and response models. Fixture execution does not review the provider's expectations or run against a sandbox. Do both separately.

## Running operation examples

Generated scripts read `API_BASE_URL` and optional `API_TOKEN` explicitly; client construction itself does not read environment variables. Run Node examples from the generated `node/` package with `node examples/RESOURCE-METHOD.mjs`. For PHP, run `composer install` inside the generated `php/` package first, then `php examples/RESOURCE-METHOD.php`. When copying a PHP example into an application, update its `require` path to the application's `vendor/autoload.php`.

Operation examples also accept `API_ALLOW_INSECURE_HTTP=1` for deliberate local HTTP testing. This is disabled by default. Do not set it for a normal HTTPS integration. TypeScript examples are normally compiled with TypeScript; Node 22 test execution can use `--experimental-strip-types`.

## Nested models and ambiguous representations

Named model factories can be nested in TypeScript client inputs through `InputValue<T>`. For models that also permit nonobjects, passing an object preserves its declared object branch in the factory return type so it can be used in object-constrained fields, including recursive references. Factories normalize nested wrappers into plain typed values, and request serialization revalidates them. PHP wrappers unwrap nested models into plain values for typed getters and preserve object/array/scalar/null shapes; `toArray()` applies only to array or object models. In object/array alternatives, PHP lists (including `[]`) represent JSON arrays, associative arrays represent JSON objects, and `(object) []` explicitly represents an empty JSON object. A directly declared object input still accepts `[]` as an empty object. Responses retain the object/array distinction from JSON decoding. Cyclic values, including opaque additional fields, fail before HTTP dispatch.

Alternatives mixing strings with exact-number strings, including corresponding nested object properties, array items and dictionary values, fail with a source diagnostic when the branches cannot be distinguished. Distinct required tags can separate object alternatives and preserve their wire representations. Numeric intersections requiring different SDK representations also fail. Safe-integer/string alternatives remain distinct and supported. Use a provider correction only when it preserves the upstream wire contract; do not silently rewrite ambiguous values.

## Request identification

Generated clients send a User-Agent containing the provider-selected package name, package version and runtime. This identifies the installed SDK without machine identifiers or credentials. Per-request `headers` can override it. Both targets have this default; it is independent of provider-specific profiles.

## Publication metadata

`npm.registry` optionally selects an HTTPS registry URL without embedded credentials, query or fragment. `npm.access` optionally selects `public` or `restricted`; npm requires a scoped package for restricted access. Defaults are the public npm registry and public access. These settings appear in package publishConfig and the reviewable release plan. Publishing requires a separate explicit command and version acknowledgement; credentials are supplied by the caller's npm configuration. See [release policy](releases.md#version-policy) for `release.policy` and [distribution](releases.md#coordinated-composer-and-documentation-distribution) for `release.baseUrl`.
