# Flint regression fixtures

These fixtures exercise the generic generator against Flint's OpenAPI contract. They are development test inputs, excluded from the npm distribution. No Flint-specific behavior belongs in the shared generator or runtime.

| Files                                                        | Purpose                                                                                                                             |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `openapi.json`, `sdk.json`, `http-cases.json`                | Seven payment/refund operations, 91 transitive schemas and fifteen synthetic HTTP scenarios.                                        |
| `risk-openapi.json`, `risk-sdk.json`, `risk-http-cases.json` | Exactly-one field choices, with all four `value`/`values` combinations.                                                             |
| `signing-vector.json`                                        | Deterministic signatures for Standard Webhooks and timestamped hex verification, with source hashes. The included key is synthetic. |
| `provenance.json`                                            | Upstream revisions, source/slice hashes, selected operations and reasons for explicit profile corrections.                          |
| `fixture-manifest.json`                                      | Content hashes binding the six schema, profile and HTTP-case files to the pinned contract.                                          |

The schemas come from revision `8be00f180602f15d6332e3c976f9960f835775ee` of `flint-pay/flint`. The profiles use package version `0.2.0` and pin `Flint-Version: 2026-09-07`. Earlier behavior and signing-vector sources are identified separately in provenance. Raw exports retain their original semantics; SDK profiles make explicit corrections for nullable read fields and the risk request's contradictory required list.

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

Large amounts and future status values probe serialization and response compatibility. They do not assert transaction eligibility or a successful server mutation. Schema checks do not replace provider business validation. The slice wire cases cover selected behavior; the full export suite below checks every outbound operation and incoming declaration.

## Full public export

`full-openapi.json` pins the unmodified public export at revision `039b96023179d960bdce89cb34eea1baf3faeb67`, API version `2026-09-07`. Its deterministic inventory contains 497 outbound operations, 189 incoming webhook declarations, six discriminator mappings, four PDF downloads, two redirect operations and one event stream. Incoming declarations never become outbound methods.

Generate the complete packages with:

```sh
node --max-old-space-size=3072 dist/cli.js generate tests/providers/flint/full-openapi.json tests/providers/flint/full-sdk.json output/full
node --max-old-space-size=3072 dist/cli.js validate output/full --fixtures tests/providers/flint/full-http-cases.json
```

The combined profile composes merchant bearer, merchant API-key, customer, onboarding, checkout-session and invoice-token profiles. Each profile's operation bindings come from complete OpenAPI security alternatives; the checkout mode requires both ID and secret headers. Anonymous operations are retained. All profile selections together equal the 497-operation inventory.

`full-common-sdk.json` enables schema validation, version headers and the declared Standard Webhooks signing convention. Model renames distinguish provider request models from generated `Input` aliases and reserved runtime names. The complete source and all its assertions remain intact. `provenance.json` records the example corrections: the delivery-method creation example needs a name and minimum option lifetime, the update example must select an update field, and exact integer examples use SDK strings.

`full-http-cases.json` contains independently specified wire/error expectations covering downloads, redirects, every discriminator alias, checkout credentials and ACH/Affirm conditions. `full-model-cases.json` covers the remaining return-policy conditional/containment branches. The full package suite diagnoses every profile, checks exact operation/event inventories, validates both complete packages, verifies deterministic preview/regeneration, installs npm and Composer consumers, and exercises compiled factories and signed webhooks with dynamic schema adapters disabled. Generation budgets are 180 seconds, 4 GiB peak RSS and 300 MiB total generated files including the private record. These are repeatable regression limits, not claims of live provider transaction acceptance.

The complete export needs a 3-GiB Node heap during generator commands; the examples set `--max-old-space-size=3072` explicitly because Node 22 defaults to a smaller heap in constrained environments. This stays inside the tested 4-GiB process budget. The installed SDKs do not require that generator setting; PHP consumers run with the default 128-MiB memory limit.

## Resource-oriented full SDK

The full profiles name all 497 operations in `full-common-sdk.json`, grouped by API resource. Calls read as `client.paymentIntents.create()`, `client.orders.createPaymentIntent()` or `client.refunds.create()`, and the generated reference lists every resource and method. Source operation IDs and wire requests are unchanged.

Flint preserves its endpoint-specific response bodies. Creating a payment intent returns `result.data.data.payment_intent`; retrieving one returns `result.data.data`. Give these values a local name to keep business code clear:

```js
const created = await client.paymentIntents.create(input, options);
const paymentIntent = created.data.data.payment_intent;
const retrieved = await client.paymentIntents.get({
  payment_intent_id: paymentIntent.payment_intent_id,
});
const refreshedPaymentIntent = retrieved.data.data;
```

In PHP the equivalent paths are `$created->data->data->payment_intent` and `$retrieved->data->data`. SDK `meta` is HTTP metadata; any metadata inside `data` belongs to the provider's JSON body.
