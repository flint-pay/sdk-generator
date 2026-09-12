# Configuration and contract subset

The generator accepts OpenAPI **3.0/3.1 JSON**, not YAML or arbitrary JSON Schema. Keep upstream API semantics in the API document and SDK design/capabilities in a separate JSON file. Both inputs are local files. Relative local `$ref` files are resolved and hashed; vendor remote references before generation. Recursive object fields, array items and dictionary values resolve through named model definitions; nonproductive alias cycles are rejected. `$ref` siblings follow the version and object rules below. Validation bounds schema traversal at 256 steps and rejects cyclic caller objects before dispatch. Generated recursive graphs share named shapes to avoid repeated expansion.

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

Request bodies support `application/json` and `application/merge-patch+json`. When exactly one supported representation is declared, it is selected automatically, even if unsupported representations are also present. If both are available, set `operations.<operationId>.requestMediaType` explicitly. The selector must name a declared supported media type; only its schema controls request encoding. For example, select `application/json` for an OAuth operation that also offers form encoding.

GET/HEAD request bodies are rejected when Node is a selected target because its built-in fetch transport cannot send them.

HTTP parameters require an explicit non-null scalar type or a supported scalar array. References and conjunctive schemas may supply that type and add constraints. An empty schema or an enum without a type is insufficient for parameter encoding and fails diagnosis; declare the intended type. Typeless schemas remain supported in JSON bodies and models.

Package metadata is required only for selected targets. `targets` defaults to both. Namespace segments and public names are validated; collisions and reserved identifiers fail with source locations. `license` changes distribution metadata only and must accurately describe the provider's package; bundled Apache-2.0 code and notices remain included. PHP-compatible prerelease versions use `alpha`, `beta`, or `rc`, optionally with a numeric suffix, such as `1.2.0-beta.1`.

## Reference siblings

Both SDK targets use the same reference rules within the supported schema subset:

| Context                                                   | Sibling behavior                                                                                                                                                                          |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAPI 3.1 Schema Object                                 | Referenced and sibling constraints all apply, including existing `allOf`, `anyOf`, `oneOf` and `not` constraints.                                                                         |
| OpenAPI 3.0 Reference Object, including schema references | Siblings are ignored, including `description` and `nullable`. Ignored values do not load referenced files.                                                                                |
| OpenAPI 3.1 Reference Object outside schemas              | Local `summary` and `description` override referenced metadata where the target object type supports those fields. Other siblings are ignored.                                            |
| Path Item `$ref`, both versions                           | Nonoverlapping fields combine. A field present locally and in the referenced Path Item is a conflict, even if the values match. Operations and parameter lists are not implicitly merged. |

For example, in OpenAPI 3.1 this schema applies both the constraints of `Name` and a maximum length of 40:

```json
{
  "$ref": "#/components/schemas/Name",
  "description": "Name shown on the receipt",
  "maxLength": 40
}
```

A narrowing `type: "array"` sibling may use the item declaration supplied by its referenced `allOf` conjunct, including a conjunct that declares `items` without its own `type`. Generated TypeScript retains those element types and any permitted nullability. The element constraints remain in their original scope; a standalone array still requires `items`.

Sibling constraints cannot weaken the referenced schema. Adding properties does not open a referenced object with `additionalProperties: false`, and adding `null` to a sibling type does not make a non-null target nullable. Local descriptive metadata takes precedence for display. A true `readOnly`, `writeOnly` or `x-sensitive` flag on either side remains effective; contradictory read/write direction is rejected.

For OpenAPI 3.0, put annotations and nullable behavior on an explicit wrapper:

```json
{
  "description": "Optional name shown on the receipt",
  "nullable": true,
  "allOf": [{ "$ref": "#/components/schemas/Name" }]
}
```

Relative references inside sibling fields resolve from the file declaring those fields, including siblings of external references. References retain operation selection, model customization and source hashing. Alias cycles that never descend through a property, item or dictionary value still fail diagnosis.

## Configuration fields

Unknown configuration keys fail with a source location. Capability declarations belong under the relevant `operations` entry unless the table marks them as top-level.

| Top-level field        | Purpose and default                                                                                                                             |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`              | Required generated package SemVer; independent of the generator version and API version.                                                        |
| `targets`              | `node`, `php`, or both; defaults to both.                                                                                                       |
| `npm`                  | `name` required for Node; optional `registry` and `access` control publication metadata.                                                        |
| `composer`             | `name` and `namespace` required for PHP.                                                                                                        |
| `license`              | Package license metadata; defaults to `Apache-2.0`. Bundled runtime license is retained.                                                        |
| `requests`             | Request argument style: `positional` (default) or `object`; see [request arguments](#request-arguments).                                        |
| `responses`            | Optional SDK-wide return mode (`result` by default, or `payload`) and payload path; see [payload returns](#optional-payload-returns).           |
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
| `documentation`        | Optional Markdown overview, named guides and featured example operation IDs.                                                                    |
| `release`              | Optional distribution `baseUrl` and compatibility `policy` (`review` by default or `semver`); see [release policy](releases.md#version-policy). |

See [CLI usage](cli.md) to diagnose or preview these inputs, and [using generated SDKs](using-sdks.md) for runtime client/request options. Credentials and runtime base URLs are supplied by consumers, not stored in the SDK configuration.

## SDK customization

`operations` keys are exact upstream `operationId` values. `resource` and `method` customize the public call while preserving HTTP method/path. `aliases` create deprecated methods invoking the same wire operation. Stale operation/model customization targets fail.

`deprecated` supplies a migration message for an operation. OpenAPI `deprecated: true` also produces a notice. Generated TypeScript declarations include operation descriptions, usage examples and deprecation annotations. Tagged operation responses export an `is<Resource><Method>ResponseKnown` guard: check it before switching on known discriminator values; unknown variants remain available unchanged.

A response union reached through `allOf`, including a resolved `$ref` with sibling constraints, also generates its known-variant guard. The guard checks the complete composed schema, including sibling required fields, bounds and `not` constraints, before narrowing. Tagged unions wrapped this way retain PHP variant classes; their constructors validate the selected branch together with the surrounding constraints and their getters include sibling fields. Normal response decoding and PHP response constructors retain the documented tolerance for business bounds and future fields.

Providers can supply `documentation.overview` as Markdown and `documentation.guides` as a map of lowercase guide slugs to Markdown. The overview appears near the top of each package README; use it to link to your public SDK documentation. Both packages and the release site include version-matched guidance. Detailed SDK behavior lives in the linked `RUNTIME.md` guide, included in both packages and the release site. READMEs embed one complete quickstart followed by up to two short recipes that reuse its client, prioritizing configured examples and covering a create operation, a read operation and another resource when available. Set `documentation.examples` to an ordered list of operation IDs to feature specific workflows (for example, `["createPaymentIntent", "getPaymentIntent", "createRefund"]`). Operations outside the selected profile are omitted and remaining slots use automatic selection. Supply `operations.OPERATION_ID.example` with realistic SDK inputs to improve these examples. Keep workflow assumptions and provider-specific recovery instructions here, alongside operation examples.

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

`allOf` validates every branch, `anyOf` requires at least one matching branch, and `oneOf` requires exactly one. Matching numeric branches merge equivalent values using exact decimal comparison, so spellings such as `1.0` and `1e0` remain valid for `anyOf` combining decimal and exact-integer schemas. Numeric merging preserves the original request token; it does not turn JSON strings into numbers or relax `oneOf` exclusivity. Field-choice rules can use `required` and `not` without repeating an object shape or declaring a discriminator. An optional discriminator requires disjoint required string enum tags. Composition retains sibling constraints and exact numeric encoding. If the shared numeric interpretation invalidates every branch that supplied a numeric conversion, the SDK rejects the value before dispatch. Unknown response tags and enum values remain unchanged; they are not converted to a known result. Unknown numeric response fields use numbers for safe integers and strings for larger/decimal tokens. Response fields required by known schemas must exist and known field shapes must be representable. Request enums and unknown-property restrictions are enforced. Ordinary schema defaults are documentation, never silently inserted into a request. Generated quickstart inputs are validated during rendering; if an inferred or configured example cannot satisfy the schema, generation identifies `config/operations/<id>/example` so the provider can supply a valid example. OpenAPI 3.0 `nullable` is normalized before generation, including reference wrappers. Required readOnly fields are response requirements; sending them is rejected. Required writeOnly fields are input requirements and are excluded from response declarations and ordinary inspection. Nullable and field-choice rules are checked through both generated public clients. Untagged object response alternatives preserve future objects through an unknown-object branch; the generated known-variant guard verifies shape and sibling requirements before narrowing.

Nested `x-sensitive: true` metadata affects model debug representations and parsed error details, not wire serialization. Explicit raw response/body access remains sensitive. Set top-level `"validation": "schema"` to check declared minimum/maximum, exclusive bounds, string lengths, patterns, array lengths, multipleOf, uniqueItems, contains and object property counts on requests and model factories. The default `"encoding"` policy retains required fields, declared types/enums, field choices, nullability, exact numeric representation and integer format ranges; business limits remain server checks. Alternative selection and known-variant guards use the full supported constraints so they never choose an incompatible wire representation. Responses retain values beyond these business constraints while still checking representable field shapes. Bounds and numeric enum membership use exact decimal comparisons without floating-point coercion of caller values. Numeric enums accept equivalent spellings such as `1`, `1.0` and `1e0`; generated TypeScript represents exact numeric enum inputs as strings and enforces membership at runtime, including single-element type arrays such as `type: ["number"]`. Integer formats int32/uint32/int64/uint64 enforce their request ranges; uint64 uses exact strings. String lengths count Unicode code points, not bytes or UTF-16 units. Patterns use a portable Unicode ECMAScript subset, translated for PHP: character classes, groups, alternation, anchors and quantifiers; lookarounds, backreferences, special groups and unsupported escapes receive diagnostics. Other textual formats are annotations. OpenAPI 3.0 exclusive booleans normalize with their associated bounds. Unsupported validation keywords, including minContains and maxContains, fail with diagnostics. Numeric bound literals must be finite, with integer literals in the safe range of the generator's JSON parser.

Numeric bounds and enums also apply when array items or dictionary values receive their type and constraints from separate `allOf` branches or `$ref` siblings. This includes named properties constrained by another branch's `additionalProperties` schema. Exact-number strings retain their numeric JSON meaning during those checks, including in nested collections; specializing a named field does not change the dictionary rule for other keys.

The same numeric interpretation applies to sibling constraints around `oneOf`/`anyOf` alternatives and recursive references. It follows the selected branch's declared representation: a numeric-looking value in a string branch remains a JSON string. Recursive field, item and dictionary constraints apply at every value depth. Known-response guards enforce those constraints for tagged and untagged unions, including when ordinary response decoding tolerates a value outside a business bound.

Mutually dependent unions can establish their numeric interpretation jointly. This search checks the original branch constraints and exclusivity before accepting a candidate. It is bounded at 256 combinations per value path in one codec execution; exceeding the bound produces a validation failure (a protocol error when decoding a response). A provider can reduce search complexity with an explicit discriminator or an equivalent schema that places each field's type and constraints together.

Portable patterns retain ECMAScript's ASCII meaning for `\d`, `\D`, `\w`, and `\W` in both targets, including inside character classes. For example, `^\w+$` rejects `é` and non-ASCII digits. Use explicit Unicode characters or ranges when those values should be accepted.

## Declared capabilities

Pagination and polling field types may come from multiple conjuncts, including properties constrained beside a response `$ref`. Every alternative must still provide the required field type, either itself or through a shared conjunct.

Pagination item declarations intersect all constraints on each element. Adding constraint-only `items` siblings, including `minLength`, preserves the referenced element type. Different response alternatives still produce a union of their item types.

- `retry`: all four fields are required. `maxAttempts` includes the initial attempt (1–10); caller/client overrides may lower it but cannot exceed the declared limit. HTTP method alone does not enable retries. Mutation retries require an idempotency declaration and a nonempty key. Neither 409 nor 412 can appear in blanket retry statuses; specific 409 error codes can be declared through `errors` on the retry policy. 412 is never retried. Transport replay applies only to fully encoded JSON bodies.
- `idempotency`: header name, retention and scope descriptions are mandatory. `auto` defaults false. An automatically generated key is stable only within one SDK call; persist a caller key for application resubmissions and recovery across restarts. Explicit keys supplied through operation header inputs, request headers, or `idempotencyKey` are preserved across retries; conflicting values fail before dispatch. Empty keys and keys with leading or trailing spaces or tabs are rejected before dispatch because HTTP transports can change their wire identity. Automatic keys are generated only when no explicit key was supplied. When the declared header is required, callers may supply it through `RequestOptions.idempotencyKey` or request headers instead of duplicating it in the input. Input types allow omission in that case, but runtime validation still rejects a missing required key before dispatch.
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

The default per-attempt `timeoutMs` is 10,000 and overall `deadlineMs` is 30,000. Both are durations in milliseconds; request values override client defaults. The overall deadline is checked again after response decoding and model construction. Synchronous decoding cannot be interrupted, but an overrun returns a deadline error with response metadata instead of a late success. Attempts default to the operation's declared policy, or one attempt when none is declared. The [consumer option reference](using-sdks.md#client-and-request-options) lists all options and language differences.

Privileged injected transports must honor timeout/cancellation and destination constraints, and must disable their own redirects/retries. Node uses the fetch signature. PHP receives `{url, method, headers, body, timeoutMs, cancellation}` and returns `{status, headers, body}`. The SDK does not close caller-owned transports. PHP's built-in reusable cURL handle is SDK-owned and released on close/destruction. Node uses the built-in fetch pool and does not own a separate pool to dispose.

## HTTP fixture format

`validate OUTPUT --fixtures FILE` accepts a nonempty JSON array like the [shared HTTP cases](../tests/fixtures/http-cases.json). Each case contains `name`, `operation`, `input`, optional request `options`, `expected` HTTP method/path/headers/body, a sequence of `responses`, and expected `data` or structured `error`. `attempts` includes the initial attempt and defaults to one. `transportError: true` models losing a response; no network is used. Optional per-scenario `baseUrl` selects the fixture API base; its default is `https://api.example.invalid/v1` and token is `test-token`. Header expectations use lowercase names. `empty: true` expects no response body. Use only synthetic credentials in fixtures.

These checks invoke generated public clients in the selected targets, including their input and response models. Fixture execution does not review the provider's expectations or run against a sandbox. Do both separately.

## Running operation examples

Generated scripts read `API_BASE_URL` and optional `API_TOKEN` explicitly for legacy authentication. Named-mode examples read `API_MODE_SCHEME` variables, with the mode and scheme converted to uppercase and punctuation replaced by underscores; client construction itself does not read environment variables. Run Node examples from the generated `node/` package with `node examples/RESOURCE-METHOD.mjs`. For PHP, run `composer install` inside the generated `php/` package first, then `php examples/RESOURCE-METHOD.php`. When copying a PHP example into an application, update its `require` path to the application's `vendor/autoload.php`.

Generated examples use HTTPS. The `allowInsecureHttp` client option is available for explicit local test setups; it is omitted from public examples. TypeScript examples are normally compiled with TypeScript; Node 22 test execution can use `--experimental-strip-types`.

## Nested models and ambiguous representations

Named model factories can be nested in TypeScript client inputs through `InputValue<T>`. For models that also permit nonobjects, passing an object preserves its declared object branch in the factory return type so it can be used in object-constrained fields, including recursive references. Factories normalize nested wrappers into plain typed values, and request serialization revalidates them. PHP wrappers unwrap nested models into plain values for typed getters and preserve object/array/scalar/null shapes; `toArray()` applies only to array or object models. In object/array alternatives, PHP lists (including `[]`) represent JSON arrays, associative arrays represent JSON objects, and `(object) []` explicitly represents an empty JSON object. A directly declared object input still accepts `[]` as an empty object. Responses retain the object/array distinction from JSON decoding. Cyclic values, including opaque additional fields, fail before HTTP dispatch.

Without `numericUnions: "explicit"`, alternatives mixing strings with exact-number strings, including corresponding nested object properties, array items and dictionary values, fail with a source diagnostic when the branches cannot be distinguished. Distinct required tags can separate object alternatives and preserve their wire representations. Numeric intersections requiring different SDK representations also fail, including intersections hidden inside `anyOf`/`oneOf` branches. Safe-integer/string alternatives remain distinct and supported. Use a provider correction only when it preserves the upstream wire contract; do not silently rewrite ambiguous values.

## Request identification

Generated clients send a User-Agent containing the provider-selected package name, package version and runtime. This identifies the installed SDK without machine identifiers or credentials. Per-request `headers` can override it. Both targets have this default; it is independent of provider-specific profiles.

## Publication metadata

`npm.registry` optionally selects an HTTPS registry URL without embedded credentials, query or fragment. `npm.access` optionally selects `public` or `restricted`; npm requires a scoped package for restricted access. Defaults are the public npm registry and public access. These settings appear in package publishConfig and the reviewable release plan. Publishing requires a separate explicit command and version acknowledgement; credentials are supplied by the caller's npm configuration. See [release policy](releases.md#version-policy) for `release.policy` and [distribution](releases.md#coordinated-composer-and-documentation-distribution) for `release.baseUrl`.

## Full contracts, authentication modes, and profile composition

`profiles` lists local JSON profiles relative to the configuration file. Compatible settings merge, operation selections and mode bindings form unions, and conflicting scalar settings fail diagnosis. A referenced profile without `include` contributes the full operation selection. The final configuration may supply its own explicit selection. Profile cycles fail diagnosis.

Use `auth.modes` to name complete OpenAPI security alternatives. Each mode has `schemes` and optional `operations` bindings. A checkout ID and secret belong in the same scheme list. Modes sharing a bearer destination may represent different roles; bind those roles to their allowed operation IDs. One selected mode supplies the complete credential set for a request.

```json
{
  "auth": {
    "modes": {
      "merchant": { "schemes": ["BearerAuth"] },
      "checkout": { "schemes": ["CheckoutId", "CheckoutSecret"] }
    }
  }
}
```

Configure public credential shortcuts alongside the modes:

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

This generates `apiKey` on client and request options in Node and PHP. Rename it to `apiToken` if that matches your product terminology. Each shortcut must target the sole scheme of a declared mode; combined credentials still use explicit mode options. Names must start with a lowercase ASCII letter, contain only ASCII letters/digits, and avoid existing option names. Profiles merge shortcut mappings and reject conflicting targets.

A request shortcut overrides client authentication for that call. An explicit request mode also overrides a client shortcut. Only one shortcut may be supplied per options object, and it cannot be combined with explicit `authMode` or `credentials` there. Endpoint mode restrictions still apply; anonymous endpoints omit client credentials. Generated examples use shortcuts when available and read their uppercase snake-case environment variable (such as `API_KEY`) explicitly.

Legacy `auth: { "scheme": "BearerAuth" }` and `token` remain supported. An ambiguous request needs an explicit mode. An incomplete scheme set, contradictory header override, or inapplicable mode fails before dispatch. Anonymous operations do not acquire a client default credential mode unless the operation permits it.

`numericUnions: "explicit"` enables exact-number/string alternatives without changing their JSON schemas. At ambiguous input paths, strings remain JSON strings and `new ExactNumber("1.2500")` selects an exact JSON number in either target. Other exact numeric inputs retain their existing string representation. Numeric intersections with inconsistent representations remain unsupported.

`schemaSharing: "named"` retains named payload dependencies as local compiled references. This bounds repeated schema expansion for large exports; it does not remove operations or constraints. Large exports can require a larger generator heap, for example `node --max-old-space-size=3072 dist/cli.js generate API.json SDK.json OUTPUT`. The full 497-operation fixture tests this setting within a 4-GiB process budget; installed clients do not need the generator heap setting. Top-level OpenAPI `webhooks` are incoming contracts and never generate outbound client methods. When HMAC verification is configured, effective literal event types bind the incoming payload schemas to the verifier. Incompatible explicit bindings fail diagnosis.

## Event stream configuration

A declared successful `text/event-stream` response produces a closeable event stream. Optional operation configuration supplies limits and explicit event payload schemas:

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

Only configured event names have JSON payload decoding. Unknown event names retain raw strings. The media schema is not interpreted as a per-event JSON contract. Default limits are 30 seconds of idle reading and 1 MiB per event. Request options `streamIdleTimeoutMs` and `streamLifetimeMs` control idle reading and optional total lifetime. Connection setup uses the usual timeout/deadline; the stream owns its connection after the method returns. Resume uses the operation's declared last-event-ID input. Reconnection is caller-controlled; no event is automatically replayed.

## Optional payload returns

Existing configurations return `Result` with `data`, `meta` and `raw`. Opt into direct payload returns with `responses.return: "payload"`. Declare envelope paths explicitly; the generator never automatically unwraps a field because it is named `data`.

```json
{
  "responses": { "return": "payload" },
  "operations": {
    "createPaymentIntent": { "response": { "payloadPath": "data" } },
    "getPaymentIntent": { "response": { "payloadPath": "payment_intent" } },
    "getLegacyReport": { "response": { "return": "result" } }
  }
}
```

These settings merge at the SDK and operation levels. With payload mode and no `payloadPath`, methods return the complete decoded body directly. You may also set an SDK-wide `responses.payloadPath`. An operation's `response.payloadPath: null` clears that inherited path; `response.return: "result"` opts the operation out entirely.

A dot-separated `payloadPath` must identify required, declared properties through non-null objects in every successful JSON response. References and schema compositions are checked. Optional paths, array traversal, and paths through empty, binary or streaming responses receive diagnostics. A nullable payload itself is allowed. Use whole-body mode or a result-mode override for endpoints with incompatible response shapes. Unknown union variants retain conservative output types; consumers must narrow them before assuming a known payload shape.

Each payload-mode method and deprecated alias also gets a `WithResponse` companion accepting identical inputs/options. For example, `client.paymentIntents.create(input)` returns the payload, while `client.paymentIntents.createWithResponse(input)` returns `SdkResponse` with the full decoded `body`, HTTP `meta`, and `raw`. PHP exposes the same method names and properties. Each call makes its own request; choose one form for an action. These companions are generated only for payload-mode operations, and their names participate in collision checks.

`Pages` and `Wait` helpers continue returning full `Result` envelopes. `Items` helpers continue yielding individual items. Pagination and polling paths always address the original response body, so payload unwrapping does not discard continuation or state information needed by these helpers. Existing HTTP fixtures also assert the complete wire body, via `WithResponse` for opted-in operations.

Return settings and generated payload types are recorded in the compiled contract. Enabling or disabling payload mode, or changing a payload path, is a breaking SDK change under the semver release policy. Existing SDKs can keep their current defaults until ready to migrate. Generated documentation, examples and Node/PHP declarations reflect the selected mode.

## Request arguments

The default is `requests.style: "positional"` for both Node/TypeScript and PHP. Path values come first, in URL placeholder order, followed by flat params and request options:

```ts
await flint.paymentIntents.get(paymentIntentId);
await flint.orders.update(orderId, { metadata: { source: 'store' } }, { idempotencyKey });
await flint.customers.list({ page_size: 100, page_token: nextPageToken });
```

PHP follows the same order, using associative arrays for params and `new RequestOptions(...)` for options. Nested model values remain supported. Operations without a body or query/header parameters omit the params argument, so a path-only method accepts `(id, options)`. Other operations keep the params slot: use `undefined` in Node or `null` in PHP to omit optional params while supplying options. Required request bodies require a params object, including `{}` / `[]` for an empty object. An omitted optional body sends no body; an explicitly empty params object sends `{}`. For operations with both an optional body and query/header parameters, params containing only those parameters omit the body; use object style if you need to distinguish an empty body in that case.

Aliases, `WithResponse`, `Pages`, `Items`, and `Wait` use the same argument order as the primary method. The schema still controls path, query, header and body encoding.

Use the object style for an entire SDK or an individual operation:

```json
{
  "requests": { "style": "positional" },
  "operations": {
    "replaceRawDocument": { "request": { "style": "object" } }
  }
}
```

Object style accepts `(input, options)`, with path/query/header fields on `input` and the request body under `input.body`. It also supports the generated PHP operation input classes. Positional style requires a non-null object body; nonobject bodies and body fields colliding with declared query/header parameters receive diagnostics. Declared query/header names are reserved for those destinations; remaining params fields go into the body. Typed additional-property dictionaries combined with query/header parameters require object style because their TypeScript index signatures cannot exclude the parameter keys. Use the operation override for those contracts.

Configuration `example` values, HTTP fixtures, and exported operation `Input` shapes retain the canonical `{ pathField, queryField, body }` structure. Generated runnable examples translate those inputs into the selected public call style. Changing styles or positional path order is reported as a breaking SDK change by release compatibility checks. Profiles merge request styles using the usual conflict rules.
