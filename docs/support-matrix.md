# Support matrix (generator 0.1.0)

A capability must be declared to generate its public helper. Both targets have the same contract semantics. A missing capability is not inferred from a payment resource name, HTTP verb, or field name.

| Capability                 | Node.js/TypeScript                                               | PHP                                                         |
| -------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------- |
| Runtime/package            | Node 22+, ESM npm package, TypeScript 5.9+ declarations          | PHP 8.2+, Composer, ext-json/ext-curl                       |
| Authentication             | Explicit bearer/header API key                                   | Same                                                        |
| Credential destinations    | Allowed origins; reject redirects/unsafe pagination links        | Same                                                        |
| Per-request tenant headers | Concurrent calls with isolated options                           | Isolated sequential calls; no cross-thread sharing          |
| Exact integers/decimals    | Numeric strings, exact JSON token serializer/parser              | Same shared safe integer boundary                           |
| Omission/null              | Optional properties, nullable unions                             | Presence-aware input classes and typed accessors            |
| Structured errors          | Error kind/code/details/cause/outcome, metadata                  | Exception kind/errorCode/details/previous/outcome, metadata |
| Response compatibility     | Unknown fields/enums/tags preserved                              | Same, with typed object response accessors                  |
| Retries/idempotency        | Declared policies, jitter, Retry-After, stable key               | Same                                                        |
| Timeout/deadline           | Per attempt and overall; AbortSignal                             | cURL timeout/progress; Cancellation token                   |
| Pagination                 | Async page/item generators, limits                               | PHP generators, limits                                      |
| Polling                    | Declared states, deadline, local cancellation                    | Same                                                        |
| Conditional requests       | Declared precondition header; distinct 409/412, declared 304     | Same                                                        |
| HMAC webhook verification  | Raw bytes, timestamp tolerance, rotating secrets, unknown events | Same                                                        |
| Durable webhook example    | SQLite inbox/outbox workers, Node 22.16+                         | PDO SQLite inbox/outbox workers                             |
| Money helpers              | Optional explicit currency precision; no implicit rounding       | Same                                                        |
| Diagnostics                | Every HTTP attempt, including failures, no credentials/bodies    | Same                                                        |
| Custom runtime             | Caller-owned fetch-compatible function                           | Caller-owned Closure transport                              |
| Client lifetime            | Reusable per event loop; default fetch connection pool           | Reusable owned cURL handle; explicit close                  |
| Package/docs/examples      | npm, JS and TS examples/reference                                | Composer, PHP examples/reference                            |
| Validation                 | Typecheck, syntax, package, shared HTTP fixtures, install tests  | Syntax, Composer validation, shared fixtures, install tests |

## Exact OpenAPI subset

| Area           | Supported                                                                                                                                                                    | Rejected or unsupported                                                                                            |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Input          | OpenAPI 3.0.x/3.1.x JSON; local `$ref`; JSON Pointer overrides                                                                                                               | YAML, remote refs, nonproductive reference cycles, `$ref` siblings                                                 |
| Operations     | GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS; unique operationId                                                                                                                   | Callbacks, operation servers, other protocol methods                                                               |
| Parameters     | Required path parameters; query/header scalars and scalar arrays                                                                                                             | Cookies, object parameters, deepObject/matrix/label/spaceDelimited/pipeDelimited, allowReserved, parameter content |
| Serialization  | Path/header simple; query form with explode true/false; RFC3986 escaping                                                                                                     | Custom parameter encodings and implicit object flattening                                                          |
| Request bodies | One application/json or application/merge-patch+json schema                                                                                                                  | Multipart, form URL encoding, binary, multiple media types, JSON Patch; GET/HEAD bodies when targeting Node        |
| Responses      | Explicit numeric statuses or default; JSON or empty bodies                                                                                                                   | Status wildcards, multiple media types, binary/streaming responses                                                 |
| Schemas        | Objects, arrays, scalars, exact numbers, recursive models, additionalProperties; allOf/anyOf/oneOf/not                                                                       | Unlisted validation keywords, including multipleOf                                                                 |
| Alternatives   | Tagged and untagged oneOf; anyOf field choices; sibling constraints                                                                                                          | Discriminator mappings; ambiguous exact-number/string alternatives; mixed numeric representations in intersections |
| Nullability    | OpenAPI 3.0 nullable; 3.1 type plus null; nullable reference wrappers                                                                                                        | Unrelated multi-type arrays (use anyOf)                                                                            |
| Formats        | int32/uint32/int64/uint64, float/double/decimal, date-time, date, uuid, email, uri, password, hostname                                                                       | Binary, unknown formats; format-specific business validation                                                       |
| Constraints    | Explicit schema-validation profile for request bounds, Unicode lengths/patterns and array lengths; integer ranges always checked; tolerant business constraints on responses | multipleOf, arbitrary regex extensions, unlisted JSON Schema validation keywords                                   |
| Metadata       | Descriptions, examples, defaults (not applied), readOnly/writeOnly, deprecation, x-sensitive                                                                                 | Custom x-annotations are preserved except reserved x-sdk-\* metadata; only declared semantics are enforced         |
| Security       | Explicit bearer/API-key selection from alternatives; per-operation required/optional/anonymous security                                                                      | OAuth refresh, combined/challenge credentials, implicit discovery                                                  |

Descriptions, examples and defaults are metadata, not evidence of server behavior. Declared exact formats determine serialization. Generated inputs preserve presence without inferring whether a null clears data on the server.

Exact numeric enum membership compares mathematical values, including equivalent decimal/exponent spellings. PHP typed getters unwrap nested models, and object/array alternative matching distinguishes lists from objects.

Integer response decoding accepts integral decimal/exponent tokens without floating-point rounding. Exponent expansion is limited to 10,000 appended zero digits to bound allocation; larger expansions produce a protocol error. Decimal precision and the public representation of unknown numeric fields are preserved. Sparse Node input arrays are rejected, including arrays in additional fields.

HTTP success bodies and verified webhook payloads must contain well-formed UTF-8 JSON without a byte-order mark or unpaired surrogate escapes. Malformed bodies produce a protocol error; decoding never repairs them by inserting replacement characters. HTTP error statuses remain available even when their bodies cannot be parsed.

## Unsupported capabilities

- File upload and download, multipart streaming and resume/checksum protocols. Declaring binary media such as a PDF response fails generation. Exclude those operations from the selection, or handle them outside the SDK.
- OAuth refresh and token cache coordination. Obtain the bearer token in your application and pass it as `token`.
- Bulk helpers, additional protocols and languages, adaptive throttling, caching and dirty tracking, framework packages, checkout UI, portals, forwarding and replay services, and time simulation.

The schema can still express per-item bulk results, resource relationships, next actions and exports as ordinary data. Automatic behavior requires a declared provider capability; a resource property alone never triggers network activity.

A missing optional capability produces a diagnostic. An operation with unsupported wire semantics fails generation rather than shipping as a working SDK.
