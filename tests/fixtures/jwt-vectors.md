# Webhook JWT conformance vectors

`jwt_vectors.json` is copied byte for byte from
[Flint's shared signing vectors](https://github.com/flint-pay/flint/blob/68daf496aad4a71ac2bef1299476ee4e9be14fb0/shared/webhooksigning/testdata/jwt_vectors.json).
It contains only a synthetic public verification key, synthetic bodies and test tokens.
Both generated targets run every vector in `tests/webhook-jwt.test.mjs`.

Source commit: `68daf496aad4a71ac2bef1299476ee4e9be14fb0`.
SHA-256: `6a08ff570359ea5f2e60765922eccfc637bc872168f856a70ce60cd32b20f270`.

Fetch updates with:

```sh
gh api repos/flint-pay/flint/contents/shared/webhooksigning/testdata/jwt_vectors.json \
  -H 'Accept: application/vnd.github.raw' > tests/fixtures/jwt_vectors.json
```

Review changes and update this provenance before refreshing the fixture.
