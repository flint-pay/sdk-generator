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

Large amounts and future status values probe serialization and response compatibility. They do not assert transaction eligibility or a successful server mutation. Schema checks do not replace provider business validation, and these fixtures do not cover every Flint endpoint or payment method.
