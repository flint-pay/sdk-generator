# Full public-spec support plan

Status: complete and verified on 2026-09-09. All 50 checklist items are implemented; repeated requirement scans found no remaining gaps.

Deliver one complete generated Node.js/TypeScript SDK and one complete PHP SDK for the public API, including merchant, customer, onboarding, and checkout-session authentication. Support the listed schema rules, downloads, event streaming, redirects, and incoming webhook declarations through the existing compiled-contract architecture.

The pinned, unmodified full export establishes 497 outbound operations, 189 incoming declarations and 189 unique event types. The earlier payment/refund and risk slices remain separate regression inputs. Exact IDs, JSON pointers and source provenance live in `tests/providers/flint/full-inventory.json` and `provenance.json`. Provider declarations remain in fixtures and SDK profiles; generator behavior is generic.

| Requirement                       | Public-spec case                                                         | Completion evidence                                                                     |
| --------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `multipleOf`                      | 17 percentage constraints, all `0.0001`                                  | Exact validation passes and fails at the declared precision in both targets.            |
| `const`                           | Delivery variants and webhook event types                                | Literal values inform types, validation, and variant selection.                         |
| `uniqueItems`                     | Delivery method IDs and other lists                                      | Duplicate JSON values fail request validation.                                          |
| `if` / `then` / `else`            | ACH transaction purpose and Affirm return URL                            | Every conditional branch has valid and invalid request cases.                           |
| `contains`                        | Payment options and return resolution types                              | Matching and nonmatching collections behave correctly.                                  |
| `minProperties` / `maxProperties` | Nonempty updates and explicitly empty objects                            | Object property counts are enforced without confusing `{}` with an absent body or `[]`. |
| Discriminator mappings            | Six mappings across checkout, fulfillment, package, and payment variants | Every mapping resolves and routes to the correct generated variant.                     |
| Existing discriminator handling   | `getBundle` fails even without a mapping                                 | A minimized regression identifies the cause and proves the fix.                         |
| PDF responses                     | Four public invoice/credit-note download operations                      | All four generate; both clients return unchanged PDF bytes.                             |
| SSE responses                     | Public webhook event streaming                                           | Both default transports yield events incrementally and release connections correctly.   |
| Redirect success responses        | Report downloads: `307`; OAuth authorization: `302`                      | Declared redirects return status and location as successful results.                    |
| Request media-type selection      | OAuth offers JSON and form encoding                                      | An explicit JSON selection generates and sends JSON.                                    |
| Authentication composition        | Merchant, customer, onboarding profiles                                  | Their complete operation union is available in one SDK per target.                      |
| Combined checkout credentials     | Checkout-session ID and secret headers                                   | Both headers form one complete authentication mode; merchant remains an alternative.    |
| OpenAPI webhook ingestion         | 189 incoming declarations                                                | All are ingested as incoming contracts, with zero generated outbound webhook methods.   |
| Full public-spec regression       | Existing fixtures miss these failures                                    | Full-spec generation, package validation, and representative behavior run in CI.        |

## Baseline implementation boundaries (before this work)

The initial repository inspection identified these extension points; the table records the baseline rather than current support:

| Area               | Current behavior                                                                                                                                                     | Primary implementation owners                                                                   |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Schema ingestion   | Keyword allowlist excludes the requested rules. Schema traversal recognizes existing composition keywords only.                                                      | `src/contract.ts`                                                                               |
| Discriminators     | Only `propertyName` is accepted; branches must directly declare an object, required tag, and string enum. The relationship to the `getBundle` failure is unverified. | `src/contract.ts`, `src/target-plan.ts`, `src/codec-plan.ts`                                    |
| Requests/responses | Requests require one supported JSON media type. Responses allow JSON or empty bodies and require an explicit `2xx`.                                                  | `src/contract.ts`, `src/runtime-plan.ts`, `src/target-plan.ts`                                  |
| HTTP execution     | Both runtimes reject redirects other than their existing `304` handling. Current result/fixture contracts assume response text.                                      | `src/runtime.ts`, `templates/Runtime.php`, `src/fixtures.ts`, `templates/fixtures.php`          |
| Authentication     | One selected bearer/header API-key scheme and one token; protected operations must offer it as a standalone alternative.                                             | `src/contract.ts`, `src/runtime-plan.ts`, both runtimes                                         |
| Webhooks           | A top-level `webhooks` object is rejected. Configured HMAC verification and event decoding already exist.                                                            | `src/contract.ts`, `src/runtime-plan.ts`, both runtimes                                         |
| Preservation       | Compiled records, declarations, runtime guarantees, and compatibility comparisons all participate in generation.                                                     | `src/compiled-record.ts`, `src/schema-policy.ts`, `src/response-plan.ts`, compatibility modules |

Follow the [architecture](../architecture.md) and [contributor rules](../../CONTRIBUTING.md). Resolve semantic decisions before rendering. Implement each runtime capability in both targets and retain the public dynamic-schema helpers through `templates/SchemaAdapter.php` and the Node codec compiler.

## 1. Establish the full-spec regression baseline

- [x] Add an unmodified, pinned full public export under `tests/providers/flint/`, alongside the existing slices. Record its upstream revision, API date, source hash, and source-backed profile corrections in provenance and the fixture manifest.
- [x] Add explicit merchant, customer, onboarding, checkout-session, and combined SDK fixture profiles. Set `validation: "schema"` for the complete profile so the requested business constraints are checked locally.
- [x] Build a deterministic inventory of outbound operation IDs, incoming webhook keys, schema keyword locations, discriminator mappings, security alternatives, request media types, and response statuses/media types. Record exact IDs and JSON pointers for every reported case.
- [x] Capture the current diagnostic for each blocker using minimal fixtures. Record the stage at which `getBundle` fails and retain its referenced schema graph. A removed mapping must be a diagnostic control, not a speculative fix.
- [x] Add a tracked failure inventory while support is incomplete. Newly discovered failures fail CI; each implemented capability removes its expected failure. Remove the temporary failure allowance before declaring full support.

Use separate counts for outbound operations, incoming declarations, and unique event types. Webhook declaration names need not equal event discriminators. Account for every public outbound operation without hiding unsupported endpoints through selection or schema deletion.

Acceptance: the baseline reproduces every listed blocker, confirms or corrects the reported counts with evidence, and preserves the existing slice tests. Tests use bundled inputs and synthetic credentials without a provider checkout or live provider calls.

## 2. Extend schema compilation and validation

Add typed schema fields, keyword validation, compiled instructions, descriptor validation, and executor support together. Extend reference resolution, dependency collection, schema traversal, direction handling, and example generation for every new subschema location. Literal `const` values must remain data, even if an object contains a key named `$ref`.

Use the [JSON Schema validation vocabulary](https://json-schema.org/draft/2020-12/json-schema-validation) for assertion semantics: `multipleOf` takes a positive number, `const` compares a JSON value, uniqueness compares array elements, and property bounds count object members.

| Capability                        | Implementation decisions                                                                                                                                                                                                                              | Required cases                                                                                                                                                |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `multipleOf`                      | Use exact decimal arithmetic shared with existing numeric handling; avoid floating-point remainder or epsilon comparisons. Preserve exact wire tokens and bound work for extreme exponents.                                                           | `0`, `0.0001`, `0.1234`, equivalent exponent/trailing-zero spellings, `0.12345`, negative multiples, invalid divisors, large exact values.                    |
| `const`                           | Add literal membership with deep JSON equality. Reuse singleton-enum behavior where equivalent, extending beyond the current scalar enum subset as needed. Emit precise literal types where representable; never insert missing values automatically. | String tags, `null`, booleans, numeric equivalence, arrays/objects, conflicting enum/type siblings, missing required constants, unknown response tags.        |
| `uniqueItems`                     | Compare the interpreted JSON value. Reuse exact numeric equality and order-independent object comparison; array order remains significant. Avoid collision-prone serialization shortcuts.                                                             | Duplicate IDs, reordered object keys, nested values, numerically equal tokens, JSON strings versus numbers, empty lists, `false`, and a large-list cost case. |
| `minProperties` / `maxProperties` | Count encoded own JSON properties, after request omission rules. Preserve required/readOnly/additional-property rules and PHP object/list distinctions.                                                                                               | Nonempty updates, exactly empty objects, boundary counts, omitted optional values, explicit null fields, additional keys, invalid bounds.                     |

Implement `if` / `then` / `else` and `contains` as compiled applicators. The condition selects the applicable branch; an absent branch imposes no additional restriction. `then` and `else` without `if` have no effect. `contains` without count modifiers requires at least one matching element. Follow the [JSON Schema applicator rules](https://json-schema.org/draft/2020-12/json-schema-core#section-10.2).

- [x] Evaluate conditional predicates and `contains` matches using full supported constraints on the shared interpreted JSON value. A failed predicate is a branch decision, not an independent request error.
- [x] Apply the selected branch's requiredness, types, and constraints together with all siblings. Cover absent discriminator fields explicitly: a `properties` predicate alone does not require a property to exist.
- [x] Include ACH and Affirm cases for condition true/false, missing dependent fields, valid dependent fields, and unrelated payment methods. Include nested conditions, references, composition siblings, and exact numeric values.
- [x] Cover `contains` with zero, one, and multiple matches; invalid nonmatching elements must still satisfy any declared `items`. Inventory `minContains` / `maxContains`; if present, include them in this workstream, otherwise keep their unsupported diagnostics explicit.

Preserve the existing validation modes. Requests always enforce representation, requiredness, and literal membership; `multipleOf`, uniqueness, and property-count business checks follow `validation: "schema"`. Condition selection uses full matching, and the chosen branch follows the request policy. Treat `contains` as a collection constraint in schema mode and always honor it during strict branch matching. Ordinary responses retain the documented business-constraint tolerance; known-variant guards use strict matching. Test both modes rather than changing the default silently.

Acceptance: independently expected cases pass through generated methods, model factories, dynamic helpers, and both runtimes. Invalid requests fail before transport dispatch. Type declarations and inferred/configured examples remain usable; unsupported type-level precision remains a runtime guarantee.

## 3. Repair and extend discriminators

- [x] Investigate `getBundle` independently of mapping support. Trace resolution, `allOf`/reference siblings, requiredness, enum/const tags, recursive references, PHP class routing, and example generation to locate the actual failure. Record the cause beside the minimized test.
- [x] Resolve effective branch information through the existing intersection/reference machinery. Avoid a second branch interpretation in each renderer and runtime.
- [x] Add explicit mapping resolution with source-relative local references, stable branch identities, and dependency tracking. Retain reference identity long enough to support implicit schema-name mappings. Remote fetching remains outside the local-input architecture.
- [x] Compile the discriminator property and resolved tag-to-branch bindings once for Node types/guards, PHP classes, and runtime dispatch. Permit multiple tag aliases for a branch when valid; report unresolved targets, conflicting tags, or unsupported layouts at their source pointers.
- [x] Cover every composition layout found in the full export, including referenced and intersected branches. A mapping must not manufacture a required field or literal constraint absent from the schema: OpenAPI states that discriminator hints do not change schema validation. [OpenAPI discriminator rules](https://spec.openapis.org/oas/v3.1.1.html#discriminator-object).
- [x] Preserve unknown response variants and strict known-variant guards. Keep request union validation authoritative when a tag cannot select a unique branch. Preserve PHP public class identities where possible and report compatibility changes where necessary.

Acceptance: `getBundle` generates and decodes a representative result in both targets with no mapping workaround; its reduced failure stays covered separately. All six reported mappings have request/response routing tests as applicable, including known aliases, unknown tags, sibling constraints, and a schema that remains ambiguous despite its mapping.

## 4. Model request media selection and response transport explicitly

Extend operation/response plans to record the selected request media type, response body kind (`empty`, `json`, `binary`, `sse`), and declared result classification. A response's HTTP status classification and body representation are separate decisions. Compile them once and consume them in runtime dispatch, public return types, examples, metadata, and compatibility checks. Replace scattered success-status filters with the compiled decision.

### Request media-type selection

- [x] Add a per-operation request media-type selector to SDK configuration; validate that it names a declared, supported representation. Preserve automatic selection when exactly one supported representation is available. Require explicit selection when multiple supported representations remain ambiguous.
- [x] Select `application/json` for the OAuth fixtures even when form encoding is also declared. Resolve and validate the selected schema and retain the original source unchanged.
- [x] Test different schemas for the two representations, correct `Content-Type` and JSON bytes, stable selection independent of object order, and diagnostics for missing/unsupported selections.

Form encoding, multipart uploads, and OAuth refresh are outside this plan's required scope.

### PDF responses

- [x] Decode `application/pdf` as bytes. Proposed public representation: `Uint8Array` in Node and a binary-safe PHP string, inside a typed result carrying normal metadata. Support the binary declaration shapes present in the pinned export, including a media type without a JSON schema.
- [x] Retain JSON error decoding for non-success responses on download operations. Document binary raw access separately from the current JSON result's raw text; prevent accidental text conversion or duplicate full-body buffers.
- [x] Extend shared fixtures to carry binary bodies and byte expectations, for example with base64 fixture fields. Test non-UTF-8 bytes, zero bytes, response headers, unexpected content types, cancellation, and deadlines through injected and default transports.

Acceptance: all four invoice/credit-note operations generate, and downloaded fixture bytes have identical hashes in Node and PHP. Buffered PDF download is the initial API; general-purpose file streaming can follow separately.

### Redirect success responses

- [x] Support explicitly declared `302` and `307` results, including operations with no `2xx` response. Compile their success policy and expose status, headers, and `Location` through a typed redirect result.
- [x] Return the redirect to the caller with transport redirect following disabled. Keep destination/authentication checks intact, preserve `304`, and retain errors for undeclared redirects.
- [x] Validate required redirect headers from the operation contract. Define behavior for optional/missing and relative `Location` values without initiating another request.
- [x] Cover OAuth `302`, report `307`, JSON errors, unexpected redirects, and a cross-origin location. A local server must observe exactly one request and no credential forwarding to the redirect target.

Acceptance: both public operations and their examples generate; both clients return declared redirects as successful results without following them.

### SSE responses

- [x] Add a dedicated stream result with response metadata, event iteration, and explicit close/cancel behavior. Proposed interfaces: an async iterable in Node and a closeable iterable in PHP. Keep existing JSON result signatures intact.
- [x] Implement incremental reading in both default transports and the injection interface. PHP requires a transport loop that can yield before EOF, such as a bounded cURL multi loop; the current fully buffered request path is insufficient.
- [x] Parse UTF-8 across chunk boundaries, CR/LF/CRLF lines, comments, multiline `data`, `event`, `id`, and `retry` fields. Dispatch at event boundaries and discard an incomplete final event. Use the [SSE parsing specification](https://html.spec.whatwg.org/multipage/server-sent-events.html#parsing-an-event-stream) as the behavioral reference.
- [x] Decode JSON event data only when the provider profile declares that payload contract. Reuse compiled event codecs where applicable; retain unknown event types and raw event data. Do not assume the media schema describes each event payload.
- [x] Separate connection/idle timeouts from an optional stream lifetime. Specify buffer limits, consumer backpressure, early iteration exit, cancellation while waiting, and cleanup on errors. Keep client close behavior consistent with owned stream resources.
- [x] Allow only declared bounded connection retries before yielding events. Initial scope uses caller-controlled reconnect/resume with an explicit last-event ID; automatic reconnect/replay and delivery guarantees are separate capabilities.
- [x] Add chunk-aware fixtures and local-server cases for first event before EOF, split multibyte characters, multiple frames per chunk, heartbeats, disconnects, malformed payloads, JSON HTTP errors, and bounded memory under a slow consumer.

Acceptance: the public webhook stream generates and delivers events incrementally in both clients. Tests prove cancellation/early close releases the connection and no automatic retry duplicates an already yielded event.

## 5. Compose authentication profiles and checkout credentials

OpenAPI security requirements express alternatives between requirement objects and combined schemes within one object. Preserve both relationships in the resolved and compiled contracts. [OpenAPI security requirement rules](https://spec.openapis.org/oas/v3.1.1.html#security-requirement-object).

- [x] Replace the single selected scheme internally with named authentication modes, each declaring a complete scheme set and credential destinations. Preserve existing `auth: { scheme }` configuration and `ClientOptions.token` behavior for existing single-scheme clients.
- [x] Add named credential sets and explicit client/request mode selection. If merchant/customer/onboarding profiles use the same bearer scheme, distinguish their credential roles through explicit profile operation bindings; the header name alone cannot identify the role.
- [x] Compose the profiles into one generation input with one public operation per ID. Merge compatible naming/capability settings, union applicable authentication modes, and diagnose conflicting overrides. Produce one npm package and one Composer package for the complete surface.
- [x] Compile each operation's permitted modes, required/optional/anonymous behavior, and complete credential requirements. Send only the chosen mode's headers. Resolve ambiguous choices explicitly and reject incomplete or inapplicable credentials before dispatch.
- [x] Declare checkout-session authentication as the ID header **and** secret header together. Preserve merchant authentication as a separate complete alternative. Reject header-destination conflicts and caller header overrides that contradict the selected mode.
- [x] Keep credentials request-local and sensitive in diagnostics, inspection, and examples. Cover concurrent Node calls with different modes and sequential PHP calls that must not retain prior credentials.

Acceptance: one client package per target can invoke merchant, customer, onboarding, and checkout operations with their appropriate modes. Tests cover individual legacy profiles, profile overlap/conflicts, anonymous operations, missing checkout ID, missing secret, the complete pair, merchant fallback, and incompatible mode selection. Full coverage must not depend on merchant credentials standing in for checkout-session support.

## 6. Ingest incoming OpenAPI webhooks

Treat top-level OpenAPI webhooks as incoming Path Item contracts and retain them separately from `paths` operations. Their request bodies describe incoming payloads. [OpenAPI webhook field](https://spec.openapis.org/oas/v3.1.1.html#openapi-object).

- [x] Replace the blanket `/webhooks` rejection with context-aware traversal, local Path Item/reference resolution, and payload dependency collection. Validate incoming contracts without imposing outbound operation success/authentication requirements on them.
- [x] Add a resolved/compiled incoming-event collection, with declaration provenance and generated payload models. Keep incoming declarations out of outbound resources, operation counts, request examples, and client methods.
- [x] Bind event schemas to the existing configured HMAC verifier using the declared type field and source-backed event constants/mappings. Define deterministic merging with explicit `config.webhook.events`; incompatible duplicate bindings produce diagnostics.
- [x] Preserve existing signature configuration, raw-byte verification before decoding, timestamp tolerance, key rotation, and unknown-event handling. OpenAPI ingestion supplies contracts; signing conventions still come from explicit provider configuration.
- [x] Cover all 189 declarations in ingestion/model coverage, plus representative signed event behavior and malformed signatures in both clients. Include referenced envelopes, exact numeric payloads, event-name collisions, and unknown future types.

Acceptance: the unmodified full export loads with all incoming declarations present, event types reach the existing verifier/model APIs, and no incoming declaration becomes an outbound method. Callback execution, generated webhook servers, and new signing algorithms are outside this workstream.

## 7. Preserve compatibility and close full-spec coverage

These checks accompany each workstream; the final phase integrates them.

- [x] Update `src/schema-policy.ts`, `src/response-plan.ts`, `src/value-guarantee.ts`, and the input/response/compiled compatibility modules for new guarantees and routing decisions. Report a review finding where inclusion cannot be proven. Never drop an unsupported comparison fact and report compatibility.
- [x] Version compiled format/semantics as required and validate every new serialized instruction in `src/compiled-record.ts`, `src/codec-plan.ts`, and `src/runtime-plan.ts`. Cover previous records, unknown descriptors, and immutable historical baselines.
- [x] Extend `tests/constraints.test.mjs`, `tests/composition.test.mjs`, `tests/authentication.test.mjs`, and compiled preservation/boundary suites. Add focused discriminator, response-media, SSE, webhook-ingestion, and full-public-spec suites where separate files improve ownership.
- [x] Keep independently authored wire/error expectations. Exercise dynamic helpers where relevant and generated public methods with schema adapters disabled. Typecheck Node consumers, validate PHP declarations, install both packages, and test their default transports against a local server.
- [x] Assert the generated outbound operation set equals the full public inventory. Check the combined profile and each individual profile, all six mappings, four PDFs, redirect operations, the stream, and all incoming declarations. Remove every temporary expected failure.
- [x] Measure generation time, peak memory, generated size, and recursive definition sharing on the full fixture. Establish repeatable regression budgets from the baseline; include long-lived SSE memory and large-list uniqueness costs.
- [x] Update the support matrix, configuration/consumer/architecture guides, generated README/reference/example text in `src/generate.ts`, and provider fixture documentation. Keep provider fixtures and this development plan outside the published generator allowlist.

Run the existing CI checks on both configured runtime combinations:

```sh
npm run check
npm test
npm pack --dry-run
```

Also run targeted Prettier checks for changed files and the documented minimum-runtime container checks when transport/runtime changes land. Full-spec CI must exercise `diagnose`, generation, deterministic regeneration/preview, validation, and package installation with synthetic data. This demonstrates SDK behavior against pinned contracts; provider acceptance of business transactions remains separate evidence.

## Delivery order and completion gate

| Milestone | Scope                                                                                      | Depends on                                                    |
| --------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| A         | Pin full export, inventory failures, minimize `getBundle`                                  | Available full public source export                           |
| B         | Exact equality, `const`, numeric/collection/object assertions, conditionals and `contains` | A                                                             |
| C         | Fix existing discriminator handling and add mappings                                       | A; B for const-tagged branches                                |
| D         | Explicit request media selection and response descriptors; PDFs and redirects              | A                                                             |
| E         | Authentication/profile composition and checkout credential pairs                           | A                                                             |
| F         | Incoming webhook ingestion and verifier event bindings                                     | B and C as required by event schemas                          |
| G         | Incremental SSE in both transports and event decoding                                      | D; E for protected streams; F where event bindings are shared |
| H         | Full combined-profile CI, compatibility review, package/docs validation                    | B–G                                                           |

Each milestone should land with its public/configuration contract, diagnostics, both-target behavior, and preservation tests. File/API names proposed here can be refined during implementation; the acceptance behavior is the requirement. Investigation may expose additional full-spec blockers, which must be recorded in the inventory and resolved before milestone H.

Completion requires an unmodified pinned full export plus explicit source-backed profiles to generate usable Node and PHP packages for the complete public operation set. Every listed feature must have positive and negative behavioral evidence, all incoming webhooks must remain incoming, and the regression suite must have no remaining expected generation failures.

## Implementation evidence and resolved blockers

| Area                                 | Repeatable evidence                                                                                                                                                                                                                                                                                                                |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source and exhaustive surface        | `tests/full-public-spec.test.mjs`; source hash, 497 exact operation IDs, 189 incoming keys, keyword pointers, all six mappings and special media operations.                                                                                                                                                                       |
| Full SDK packages                    | `tests/full-public-packages.test.mjs`; CLI diagnosis, generation, unchanged preview/regeneration, package validation, npm/Composer installation, all methods and incoming models, compiled-only execution and signed exact-number webhooks.                                                                                        |
| Source behavior                      | `full-http-cases.json`: 49 independently authored wire/error cases, including every mapped alias, four PDFs, redirects, complete checkout credentials and ACH/Affirm branches. `full-model-cases.json`: 19 return conditional/containment cases.                                                                                   |
| Schema rules and preservation        | `tests/constraints.test.mjs`, `composition.test.mjs`, `numeric-unions.test.mjs`, and the compiled boundary/contract/preservation suites. Dynamic helpers, generated methods and factories share the supported assertion semantics.                                                                                                 |
| Discriminators                       | `tests/discriminator-mapping.test.mjs` plus the original `getBundle` graph in `full-public-spec.test.mjs`; inherited tags, aliases, reference identity, unknown tags and mapping hints that cannot resolve a schema ambiguity.                                                                                                     |
| Authentication and incoming webhooks | `tests/authentication-modes.test.mjs`, `authentication.test.mjs`, `webhook-ingestion.test.mjs` and full installed consumers; complete AND requirements, alternatives, profile conflicts, request-local credentials and incoming-only models.                                                                                       |
| Downloads, redirects and streams     | `tests/request-media.test.mjs`, `response-media.test.mjs`, `sse.test.mjs`; both injected/default transports, exact bytes, no redirect following, incremental frames, strict configured payloads, cancellation/deadlines and connection release.                                                                                    |
| Cost bounds                          | Full generation with a documented 3-GiB Node heap: 180 seconds, 4 GiB peak RSS, 300 MiB generated output including the private record. Slow SSE consumers: 2,048 16-KiB frames with less than 24 MiB additional Node array-buffer memory and 8 MiB PHP managed memory. Uniqueness: 15,000 objects in under ten seconds per target. |

The original `getBundle` blocker occurred during discriminator ingestion. Its nested branches inherit object types and required literal tags through references and `allOf`; the old direct-object/direct-tag check rejected that layout. Effective branch bindings now compile once and serve both runtimes and declarations. The minimized diagnostic control retains the referenced graph and needs no mapping workaround.

The exhaustive scan also found blockers beyond the requested keyword list. Promotion-rule alternatives mix JSON strings with exact numbers, so an explicit `ExactNumber` input mode preserves both wire kinds. Provider names ending in `Input` collided with generated input aliases, and `Money`/`Return` collided with reserved names; explicit profile renames resolve them. Constraint-only arrays without `items` now retain their valid unconstrained items. Invalid or unrepresentable source examples have documented profile examples. Repeated expanded schemas required named schema and compiled-instruction sharing; temporary fingerprint caches are bounded to individual roots. All original source constraints remain intact.

No temporary expected-generation-failure allowance remains. A new unsupported operation, missing incoming model, changed inventory, malformed compiled instruction, nondeterministic artifact or failed behavior case fails the suite. Provider fixtures and this plan are excluded by the published generator package allowlist.

### Final verification

- Node 22.16.0 / PHP 8.2 minimum-runtime container: all 277 tests pass, with zero failures, skips or expected failures.
- Node 24.19.0 / PHP 8.5.10: regression coverage passes, including the complete installed-package rerun and focused stream, timeout, schema and preservation checks. PHP consumers retain the default 128-MiB memory limit.
- `npm run check`, targeted Prettier checks, `git diff --check`, and `npm pack --dry-run` pass. The package contains 94 files and excludes provider fixtures and this plan. `.prettierignore` protects the unmodified source export.
- Measured full generation: 135 seconds / 1.63 GiB peak RSS on the host; 93 seconds / 3.04 GiB on the minimum runtime; 158 MiB generated output including the private record. Both remain within the committed regression budgets.

The final scan checked every requirement against implementation, positive/negative behavior, public declarations, compiled preservation, source inventory, documentation and package boundaries. No unresolved implementation blocker remains.
