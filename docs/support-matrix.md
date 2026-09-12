# Support matrix (generator 0.1.0)

A capability must be declared to generate its public helper. Both targets implement the declared contract through bundled compiled codecs, with the target differences described below. A missing capability is not inferred from a payment resource name, HTTP verb, or field name.

| Capability                 | Node.js/TypeScript                                               | PHP                                                         |
| -------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------- |
| Runtime/package            | Node 22+, ESM; TypeScript 5.9+ for TypeScript consumers          | PHP 8.2+, Composer, ext-json/ext-curl                       |
| Authentication             | Named complete bearer/header API-key modes                       | Same                                                        |
| Credential destinations    | Allowed origins; return declared redirects; reject unsafe links  | Same                                                        |
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
| Schema-taking helpers      | `serialize`, `Model`, `redact`; bundled local schema adapter     | Base `Model` and `Codec` helpers; local schema adapter      |
| Custom runtime             | Caller-owned fetch-compatible function                           | Caller-owned Closure transport                              |
| Client lifetime            | Reusable per event loop; default fetch connection pool           | Reusable owned cURL handle; explicit close                  |
| Package/docs/examples      | npm, JS and TS examples/reference                                | Composer, PHP examples/reference                            |
| Validation                 | Typecheck, syntax, package, shared HTTP fixtures, install tests  | Syntax, Composer validation, shared fixtures, install tests |

## Exact OpenAPI subset

| Area           | Supported                                                                                                                                                                                                                               | Rejected or unsupported                                                                                                                         |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Input          | OpenAPI 3.0.x/3.1.x JSON; local `$ref` with version-aware siblings; JSON Pointer overrides                                                                                                                                              | YAML, remote refs, nonproductive reference cycles, overlapping Path Item reference fields                                                       |
| Operations     | GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS; unique operationId                                                                                                                                                                              | Callbacks, operation servers, other protocol methods                                                                                            |
| Parameters     | Required path parameters; explicitly typed non-null scalars and scalar arrays                                                                                                                                                           | Untyped/nullable parameters, cookies, object parameters, deepObject/matrix/label/spaceDelimited/pipeDelimited, allowReserved, parameter content |
| Serialization  | Path/header simple; query form with explode true/false; RFC3986 escaping                                                                                                                                                                | Custom parameter encodings and implicit object flattening                                                                                       |
| Request bodies | Selected application/json or application/merge-patch+json schema                                                                                                                                                                        | Multipart, form URL encoding, binary, ambiguous media selection, JSON Patch; GET/HEAD bodies when targeting Node                                |
| Responses      | Explicit numeric statuses or default; JSON, empty, PDF bytes, SSE; declared 302/307                                                                                                                                                     | Status wildcards, multiple response media types, other binary media                                                                             |
| Schemas        | Objects, arrays, scalars, exact numbers, recursive models, additionalProperties; const; allOf/anyOf/oneOf/not/contains/if/then/else; 3.1 schema `$ref` siblings                                                                         | Unlisted validation keywords, including contains count modifiers                                                                                |
| Alternatives   | Tagged and untagged oneOf; local discriminator mappings; anyOf field choices; sibling constraints                                                                                                                                       | Unresolved mapping targets; ambiguous numeric/string inputs without explicit wrapper mode; mixed numeric representations in intersections       |
| Nullability    | OpenAPI 3.0 nullable; 3.1 type plus null; nullable reference wrappers                                                                                                                                                                   | Unrelated multi-type arrays (use anyOf)                                                                                                         |
| Formats        | int32/uint32/int64/uint64, float/double/decimal, date-time, date, uuid, email, uri, password, hostname                                                                                                                                  | Binary, unknown formats; format-specific business validation                                                                                    |
| Constraints    | Explicit schema-validation profile for request bounds, Unicode lengths/patterns, array lengths, uniqueItems, multipleOf, contains and object property counts; integer ranges always checked; tolerant business constraints on responses | Arbitrary regex extensions and unlisted JSON Schema validation keywords                                                                         |
| Metadata       | Descriptions, examples, defaults (not applied), readOnly/writeOnly, deprecation, x-sensitive                                                                                                                                            | Custom x-annotations are preserved except reserved x-sdk-\* metadata; only declared semantics are enforced                                      |
| Security       | Named complete bearer/API-key alternatives and combined schemes; per-operation required/optional/anonymous security                                                                                                                     | OAuth refresh, challenge credentials, implicit discovery                                                                                        |

OpenAPI 3.1 schema `$ref` siblings intersect with the referenced constraints. OpenAPI 3.0 Reference Object siblings are ignored; 3.1 Reference Objects outside schemas apply supported `summary`/`description` overrides and ignore other siblings. Path Item references combine nonoverlapping fields in both versions. See [reference siblings](configuration.md#reference-siblings) for examples and conflict rules.

Descriptions, examples and defaults are metadata, not evidence of server behavior. Declared exact formats determine serialization. Generated inputs preserve presence without inferring whether a null clears data on the server.

For null-only values, use `type: "null"`. The legacy `type: ["null"]` form permits non-null values in Node but rejects them in PHP; see [schema-taking helpers](using-sdks.md#schema-taking-helpers).

Exact numeric enum membership and numeric composition merging compare mathematical values, including equivalent decimal/exponent spellings. Exact numeric enum inputs use strings for `number`, `int64`, and `uint64`, including single-element type arrays. Mutually dependent unions are matched jointly under a bounded search; an unusually ambiguous schema can exhaust it and fail validation.

Integer response decoding accepts integral decimal/exponent tokens without floating-point rounding. Exponent expansion is limited to 10,000 appended zero digits to bound allocation; larger expansions produce a protocol error. Decimal precision and the public representation of unknown numeric fields are preserved. Sparse Node input arrays are rejected, including arrays in additional fields.

HTTP success bodies and verified webhook payloads must contain well-formed UTF-8 JSON without a byte-order mark or unpaired surrogate escapes. Malformed bodies produce a protocol error; decoding never repairs them by inserting replacement characters. HTTP error statuses remain available even when their bodies cannot be parsed.

Offset pagination requires compatible SDK representations: int64/uint64 continuations require int64/uint64 query parameters. Cursor parameters must be scalar strings, and offset parameters must be scalar integers. Incompatible declarations fail diagnosis.

## Compatibility analysis limitations

Compatibility checks compare public declarations and runtime guarantees separately. Losing required keys in mixed objects or nested dictionary values is breaking even where TypeScript exposes `unknown`. Added-result inclusion covers explicit scalar/object/array types, dictionaries, nesting, null and absent bodies. References, complex compositions, nullable type unions and arbitrary result unions retain review findings where inclusion cannot be proved; their execution support is unchanged.

Nested constraint changes in `allOf`, `anyOf`, and `not` can receive only a `review` finding even when they break existing inputs. The SemVer release policy relies on provider judgment for these findings. See [known compatibility limitations](releases.md#known-compatibility-limitations).

## Unsupported capabilities

- File uploads, multipart bodies, binary response media other than PDF, and download resume/checksum protocols. PDF downloads are buffered; general-purpose file streaming is outside the current contract.
- OAuth refresh and token cache coordination. Obtain the bearer token in your application and pass it as `token`.
- Bulk helpers, additional protocols and languages, adaptive throttling, caching and dirty tracking, framework packages, checkout UI, portals, forwarding and replay services, and time simulation.

The schema can still express per-item bulk results, resource relationships, next actions and exports as ordinary data. Automatic behavior requires a declared provider capability; a resource property alone never triggers network activity.

Undeclared optional capabilities produce no helper. Unsupported or incomplete capability declarations produce diagnostics. An operation with unsupported wire semantics fails generation rather than shipping as a working SDK.

`multipleOf` uses exact decimal divisibility. Work that requires more than 10,000 appended digits fails validation; power-of-ten divisors need no expansion. `const` and `uniqueItems` compare JSON values with exact numeric equality and order-independent object keys; array order remains significant. `contains` requires a matching element in schema validation and strict variant guards; `minContains` and `maxContains` remain unsupported. Constants are never inserted automatically.
