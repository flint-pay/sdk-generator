# Flint regression fixtures

These fixtures exercise the generic generator against Flint's OpenAPI contract. They are development test inputs, excluded from the npm distribution. No Flint-specific behavior belongs in the shared generator or runtime.

| Files                                                        | Purpose                                                                                                                             |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `openapi.json`, `sdk.json`, `http-cases.json`                | Seven payment/refund operations, 100 transitive schemas and seventeen synthetic HTTP scenarios.                                     |
| `risk-openapi.json`, `risk-sdk.json`, `risk-http-cases.json` | Plural risk-list values, with all four legacy `value`/`values` combinations and 52 transitive schemas.                              |
| `signing-vector.json`                                        | Deterministic signatures for Standard Webhooks and timestamped hex verification, with source hashes. The included key is synthetic. |
| `provenance.json`                                            | Upstream revisions, source/slice hashes, selected operations and reasons for explicit profile corrections.                          |
| `fixture-manifest.json`                                      | Content hashes binding the schema, profile, inventory, expected-failure and HTTP-case files to the pinned contract.                 |

The schemas come from revision `dcd2401490dadf0be5733b2322e37056013dcb11` of `flint-pay/flint`. The profiles use package version `0.2.0` and pin `Flint-Version: 2026-09-07`. All slices, behavior evidence and signing sources use the same revision, recorded in provenance. Raw exports retain their original semantics. The new source correctly declares nullable payment read fields and plural risk-list values, so their old profile corrections have been removed.

Run from the repository root:

```sh
npm run build
node --test tests/flint.test.mjs
node dist/cli.js generate tests/providers/flint/openapi.json tests/providers/flint/sdk.json .generated/flint
node dist/cli.js validate .generated/flint --fixtures tests/providers/flint/http-cases.json
node dist/cli.js generate tests/providers/flint/risk-openapi.json tests/providers/flint/risk-sdk.json .generated/flint-risk
node dist/cli.js validate .generated/flint-risk --fixtures tests/providers/flint/risk-http-cases.json
```

`npm test` includes these cases, package installation and the shared signing-vector checks. Tests require the documented Node/PHP/Composer tools, but no Flint checkout, Go toolchain, credentials or live provider calls. Package installation can consult configured registries.

When updating the fixture set, obtain a matching versioned source export, retain the original schemas, and record any required corrections in the profiles with a source-backed reason. Keep the API date, header pin and generated types aligned. Verify expected HTTP behavior independently of generator output before updating hashes; the manifest is an integrity check, not proof of provider acceptance.

The small payment slice retains the exact published `payment_intent.succeeded` incoming declaration and its four additional envelope/event schemas. Generic incoming bindings replace the old hand-written event shape, enforce required fields, and use `data.object` for merchant and installed-merchants deliveries. The operation selection is unchanged.

Synthetic HTTP response request IDs use `req_` plus 26 Crockford base32 characters. The pinned source exports retain their historical annotations.

Large amounts and future status values probe serialization and response compatibility. They do not assert transaction eligibility or a successful server mutation. Schema checks do not replace provider business validation. The slice wire cases cover selected behavior; the full export suite below checks every outbound operation and incoming declaration.

## Full public export

`full-openapi.json` pins the unmodified public export at revision `dcd2401490dadf0be5733b2322e37056013dcb11`, API version `2026-09-07`. Its deterministic inventory contains 612 outbound operations, 245 incoming webhook declarations, 76 discriminator mappings, four PDF downloads, two redirect operations and one event stream. Incoming declarations never become outbound methods.

Generate the complete packages with:

```sh
node --max-old-space-size=3072 dist/cli.js generate tests/providers/flint/full-openapi.json tests/providers/flint/full-sdk.json output/full
node --max-old-space-size=3072 dist/cli.js validate output/full --fixtures tests/providers/flint/full-http-cases.json
```

The combined profile composes merchant bearer, merchant API-key, customer, onboarding, checkout-session and invoice-token profiles. Each profile's operation bindings come from complete OpenAPI security alternatives; checkout uses `CheckoutSessionBearer` in the Authorization header. Anonymous operations, including partner OAuth consent entry, are retained. The profiles select all 607 SDK operations. Five form operations (`authorizeCLIDevice`, `listCLIContexts`, `reauthorizeCLIDevice`, `revokeOAuthToken`, `exchangeOAuthToken`) are explicitly hidden because CLI device/OAuth form flows are outside this SDK surface. The raw export retains them, and their documented JSON responses remain in the strict example audit.

`full-common-sdk.json` uses shared capability defaults with explicit opt-outs and field overrides. It enables schema validation, version headers and the declared Standard Webhooks signing convention. Model renames distinguish provider request models from generated `Input` aliases and reserved runtime names. The raw source remains intact. No payment or risk schema overrides remain. `PaymentIntent` has nullable `last_payment_error` and optional nullable `risk`; `PaymentIntentWithCollection` remains a distinct extension. Payment options stay a non-nullable array: the current server serializer and regression test emit an empty array for legacy missing options. Open response enums accept the presenter's possible empty payment flow. `provenance.json` records the example corrections: the delivery-method creation example needs a name and minimum option lifetime, the update example must select an update field, and exact integer examples use SDK strings. Payment creation uses 5000 USD minor units because the provider rejects zero (and requires at least 50 for USD); report creation uses a one-day interval because the end must follow the start. These are synthetic documentation inputs, not live acceptance claims.

`full-http-cases.json` contains independently specified wire/error expectations covering downloads, redirects, selected discriminator branches, checkout credentials and ACH/Affirm conditions. `full-model-cases.json` covers current return-decision reason dependencies, nullable automatic resolution and return-policy release-timing conditional/containment branches. The full package suite diagnoses every profile, checks exact operation/event inventories, validates both complete packages, verifies deterministic preview/regeneration, installs npm and Composer consumers, and exercises compiled factories and signed webhooks with dynamic schema adapters disabled. Generation budgets are 180 seconds, 4 GiB peak RSS and 300 MiB total generated files including the private record. The private generation record has a 160-MiB limit. The larger export roughly doubles source bytes (8.6 to 16 MiB); reviewed consumer limits are 24 MiB of Node JavaScript, 22 MiB of declarations, 18 MiB of PHP descriptors, a 2.5-MiB webhook bundle and a 640-KiB largest PHP source file. These are repeatable regression limits, not claims of live provider transaction acceptance.

The complete export needs a 3-GiB Node heap during generator commands; the examples set `--max-old-space-size=3072` explicitly because Node 22 defaults to a smaller heap in constrained environments. This stays inside the tested 4-GiB process budget. The installed SDKs do not require that generator setting; PHP consumers run with the default 128-MiB memory limit.

## Resource-oriented full SDK

The full profiles name all 607 SDK operations in `full-common-sdk.json`, grouped by API resource. Calls read as `client.paymentIntents.create()`, `client.orders.createPaymentIntent()` or `client.refunds.create()`, and the generated reference lists every resource and method. Source operation IDs and wire requests are unchanged.

Payload-mode calls return the value inside the provider's `data` envelope. Payment-intent create results now return the resource directly, with a required `payment_collection` extension; reads return `PaymentIntentWithCollection` with an optional collection:

```js
const created = await client.paymentIntents.create(input, options);
const paymentIntent = created;
const retrieved = await client.paymentIntents.get({
  payment_intent_id: paymentIntent.payment_intent_id,
});
console.log(retrieved.status);
const response = await client.paymentIntents.getWithResponse({
  payment_intent_id: paymentIntent.payment_intent_id,
});
console.log(response.body.request_id, response.meta.requestId);
```

PHP returns typed response models, with paths such as `$created->getPaymentIntentId()` and `$retrieved->getStatus()`. `WithResponse` returns the complete provider body plus HTTP metadata and raw response access. The four PDF operations, event stream, partner authorization redirect, specification response and report-download redirect retain `Result` returns because they do not have a compatible JSON `data` envelope.

All 127 supported list operations return their complete body, preserving `data` and any `next_page_token`. The 124 cursor-paginated operations declare `Pages`, `PagesWithResponse`, and `Items` helpers; balances, merchant billing balances and Flint wallet payment methods are complete, unpaginated lists and have none of these helpers. `Pages` yields the same list body as the base method: use `page.data` and `page.next_page_token` in Node, or `$page->getData()` and `$page->getNextPageToken()` in PHP. `PagesWithResponse` yields the complete body as `body`, plus HTTP `meta` and `raw`. The item-list methods are named `packages.listPackageItems()` and `riskLists.listRiskListItems()` to avoid colliding with the parent lists' generated `listItems()` helpers. Pagination and polling paths refer to the original provider body. `reports.getWait()` follows `data.status` until `succeeded` or `failed`, returning the report directly (`report.status` or `$report->getStatus()`). `reports.getWaitWithResponse()` retains the full provider body, metadata and raw response.

All 333 operations declaring an `Idempotency-Key` header generate a key before dispatch when the caller provides none. Explicit keys are preserved across retries, including the 34 operations requiring durable keys. Persist a caller key for recovery across SDK calls or process restarts. Retry policies allow three total attempts for transport errors, 429, 503, 504 and the exact 409 `IDEMPOTENCY_KEY_IN_PROGRESS` code. Other conflicts are not retried. Merchant-account session creation and refresh use one attempt because each completed retry can mint a fresh session. Mutations without a declared idempotency header retain single-attempt behavior.

The full profile uses package version `2.0.0` and the semver release policy. Payload returns and method renames are intentional breaking changes; the small payment and risk profiles remain pinned legacy-result regression controls at `0.2.0`. Package names retain the synthetic `@example`/`example` fixture namespaces. Replace them with production package names in release inputs.

## Client setup

The full profiles explicitly map `token` to `merchant/BearerAuth`, `apiKey` to `merchantKey/ApiKeyHeader`, `customerToken` to `customer/CustomerSessionBearer`, `onboardingToken` to `onboarding/OnboardingSessionBearer`, `checkoutToken` to `checkout/CheckoutSessionBearer`, and `invoiceToken` to `invoice/InvoiceAccessTokenBearer`. Each mapping supplies a complete single-scheme alternative already permitted by that profile’s operation bindings. `full-sdk.json` sets `documentation.authShortcut` to `apiKey` for generated READMEs and examples, because the source lists `ApiKeyHeader` first for the featured payment-intent and refund operations and describes it as the server-side secret key. Fixture hashes include these profile declarations.

The full export’s first server is production (`https://api.withflintpay.com`), which becomes the generated default. Use an explicit `baseUrl: 'https://api.staging.withflintpay.com'` for sandbox testing. Regression tests use synthetic transports and never call either server.

## Strict response-example audit

The full-package test inspects all 837 documented 2xx JSON examples: 428 media-level examples (including four from hidden form operations) and 409 distinct nested schema annotations reachable from success responses. Both actual generated strict executors decode the same source values; shared schema examples are checked once at their source location. Two `text/event-stream` examples are explicitly excluded as SSE wire text and remain covered by transport tests. Neither target uses a dynamic schema adapter for this audit.

[`response-example-failures.json`](response-example-failures.json) records one upstream example defect at the pinned revision: `createOrderPaymentIntent`, status `201`, media `application/json`, singleton `example`, omits required `data.supported_actions`. [The server field has no omitempty tag](https://github.com/flint-pay/flint/blob/dcd2401490dadf0be5733b2322e37056013dcb11/server/monolith/internal/publicapi/models.go#L2337), and [MarshalJSON converts a nil value into an empty array and includes the field](https://github.com/flint-pay/flint/blob/dcd2401490dadf0be5733b2322e37056013dcb11/server/monolith/internal/publicapi/models.go#L2467-L2490). Both Node and PHP must fail this exact example with `response.data.supported_actions: required field is missing`. A pass, changed error, missing example or any other failure fails the audit; remove the entry when Flint fixes its example. The export and response schema remain unchanged.

The repin adds 152 operation IDs and removes 47 relative to the previous full fixture, including 20 same-path ID renames recorded in provenance. See [migration notes](../../../docs/releases.md#flint-provider-fixture-repin) for changed SDK methods, response envelopes, checkout credentials and exact webhook amounts. Webhook delivery and resource bodies now carry their resource in `data.object`; all reachable amount declarations use int64, so both SDKs return exact integer strings.
