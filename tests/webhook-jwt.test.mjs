import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { createHash, createHmac, generateKeyPairSync, sign } from 'node:crypto';
import { generate, loadContract } from '../dist/index.js';
import { compileRuntimePlan, assertRuntimePlan } from '../dist/runtime-plan.js';

const vectors = JSON.parse(readFileSync('tests/fixtures/jwt_vectors.json', 'utf8'));
const root = mkdtempSync(join(tmpdir(), 'sdk-jwt-'));
after(() => rmSync(root, { recursive: true, force: true }));
const jwt = {
  header: 'authorization',
  scheme: 'Bearer',
  algorithm: 'ES256',
  typ: 'flint-webhook+jwt',
  issuer: 'baseUrl',
  jwksPath: '/.well-known/jwks.json',
  bodyHashClaim: 'body_sha256',
  bodyHashEncoding: 'base64url',
  lifetimeSeconds: 300,
  leewaySeconds: 60,
};
const hmac = {
  algorithm: 'hmac-sha256',
  header: 'X-Signature',
  timestampHeader: 'X-Timestamp',
  separator: '.',
  toleranceSeconds: 300,
};
const config = {
  version: '1.0.0',
  npm: { name: '@example/jwt' },
  composer: { name: 'example/jwt', namespace: 'Example\\Jwt' },
  webhook: {
    ...hmac,
    jwt,
    typeField: 'type',
    events: {
      'synthetic.updated': {
        type: 'object',
        properties: {
          type: { type: 'string', const: 'synthetic.updated' },
          id: { type: 'string' },
        },
        required: ['type', 'id'],
      },
    },
  },
};
const api = join(root, 'api.json');
writeFileSync(
  api,
  JSON.stringify({
    openapi: '3.1.0',
    info: { title: 'JWT fixture', version: '1' },
    paths: {
      '/health': { get: { operationId: 'health', responses: { 204: { description: 'OK' } } } },
    },
  }),
);
function build(name, value = config) {
  const profile = join(root, name + '.json');
  writeFileSync(profile, JSON.stringify(value));
  const out = join(root, name);
  generate(loadContract(api, profile), out);
  return out;
}
let out, sdk, subpath;
before(async () => {
  out = build('both');
  sdk = await import(pathToFileURL(join(out, 'node/index.js')));
  subpath = await import(pathToFileURL(join(out, 'node/webhooks.js')));
});
function php(script, input = {}, phpArgs = []) {
  const program = join(root, 'run-' + Math.random().toString(36).slice(2) + '.php');
  writeFileSync(
    program,
    `<?php\nrequire $argv[1].'/src/Runtime.php'; require $argv[1].'/src/Client.php';\nuse Example\\Jwt\\Client; use Example\\Jwt\\ClientOptions; use Example\\Jwt\\Webhooks; use Example\\Jwt\\SdkError;\n$input=json_decode(file_get_contents($argv[2]),true,512,JSON_THROW_ON_ERROR);\n${script}`,
  );
  const data = program + '.json';
  writeFileSync(data, JSON.stringify(input));
  const r = spawnSync('php', [...phpArgs, program, join(out, 'php'), data], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return JSON.parse(r.stdout);
}
const codes = {
  alg_none: 'invalid_token',
  hs256_confusion: 'invalid_token',
  wrong_typ: 'invalid_token',
  wrong_aud: 'invalid_audience',
  expired: 'token_expired',
  future_iat: 'token_expired',
  lifetime_over_300: 'token_expired',
  changed_body: 'body_mismatch',
  unknown_kid: 'unknown_key',
};
test('all upstream synthetic cross-language JWT vectors pass through root, subpath, client and PHP', async () => {
  const options = {
    endpointIds: vectors.endpoint_ids,
    jwks: vectors.jwks,
    baseUrl: vectors.issuer,
    nowSeconds: vectors.now,
  };
  const client = new sdk.Client({ baseUrl: vectors.issuer + '/api/' });
  for (const vector of vectors.vectors) {
    for (const verify of [
      sdk.verifyWebhookAsync,
      subpath.verifyWebhookAsync,
      client.verifyWebhookAsync.bind(client),
    ]) {
      const result = verify(
        Buffer.from(vector.body_base64, 'base64'),
        { Authorization: vector.authorization },
        options,
      );
      if (vector.expected_valid) assert.equal((await result).signingMethod, 'jwt', vector.name);
      else
        await assert.rejects(
          result,
          { kind: 'authentication', code: 'webhook_' + codes[vector.name] },
          vector.name,
        );
    }
  }
  const result = php(
    `$results=[]; foreach($input['vectors'] as $v){foreach(['standalone','client'] as $mode){try{ $options=['endpoint_ids'=>$input['endpoint_ids'],'jwks'=>$input['jwks'],'base_url'=>$input['issuer'],'now_seconds'=>$input['now']]; $body=base64_decode($v['body_base64']); $headers=['Authorization'=>[$v['authorization']]]; $r=$mode==='standalone'?Webhooks::verifyDelivery($body,$headers,$options):(new Client(new ClientOptions(baseUrl:$input['issuer'])))->verifyWebhookDelivery($body,$headers,$options); $results[]=$r['signing_method']; }catch(SdkError $e){$results[]=$e->errorCode;}}} echo json_encode($results);`,
    vectors,
  );
  assert.deepEqual(
    result,
    vectors.vectors.flatMap((v) =>
      Array(2).fill(v.expected_valid ? 'jwt' : 'webhook_' + codes[v.name]),
    ),
  );
});

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const exported = publicKey.export({ format: 'jwk' });
const kid = createHash('sha256')
  .update(JSON.stringify({ crv: exported.crv, kty: exported.kty, x: exported.x, y: exported.y }))
  .digest('base64url');
const jwks = { keys: [{ ...exported, kid, alg: 'ES256', use: 'sig' }] };
const body = Buffer.from('{"type":"synthetic.updated","id":"wh_fixture"}\n');
const claims = {
  iss: 'https://issuer.example',
  aud: 'whep_fixture',
  iat: vectors.now,
  exp: vectors.now + 300,
  jti: 'delivery_fixture',
  body_sha256: createHash('sha256').update(body).digest('base64url'),
};
/** Sign exact header and claims JSON text, so tests can express duplicate members and floats. */
function signedToken(headerText, claimsText) {
  const head = Buffer.from(headerText).toString('base64url');
  const payload = Buffer.from(claimsText).toString('base64url');
  return (
    head +
    '.' +
    payload +
    '.' +
    sign('sha256', Buffer.from(head + '.' + payload), {
      key: privateKey,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url')
  );
}
function token(overrides = {}, headers = {}) {
  return signedToken(
    JSON.stringify({ alg: 'ES256', typ: jwt.typ, kid, ...headers }),
    JSON.stringify({ ...claims, ...overrides }),
  );
}
const options = { endpointIds: 'whep_fixture', jwks, baseUrl: claims.iss, nowSeconds: vectors.now };

/**
 * Tokens Flint's Go VerifyFlintWebhookJWT rejects (or accepts) because of JSON shape: duplicate
 * members, header members other than alg/kid/typ, sub, non-string aud and non-integer times.
 */
function strictParsingCases() {
  const head = JSON.stringify({ alg: 'ES256', typ: jwt.typ, kid });
  const payload = JSON.stringify(claims);
  const claimsWith = (text) => payload.slice(0, -1) + ',' + text + '}';
  const headerWith = (text) => head.slice(0, -1) + ',' + text + '}';
  const invalid = 'invalid_token';
  return [
    { head: headerWith('"kid":' + JSON.stringify(kid)), code: invalid },
    { head: headerWith('"\\u0061lg":"ES256"'), code: invalid },
    { head: '{"alg":"none",' + head.slice(1), code: invalid },
    { head: headerWith('"cty":"JWT"'), code: invalid },
    { head: headerWith('"b64":true'), code: invalid },
    { head: JSON.stringify({ alg: 'ES256', typ: jwt.typ }), code: invalid },
    { head: JSON.stringify({ alg: 'ES256', typ: jwt.typ, kid: 1 }), code: invalid },
    { head: JSON.stringify({ alg: 'ES256', typ: jwt.typ, kid: '' }), code: invalid },
    { head: '[' + head + ']', code: invalid },
    // Go's encoding/json rejects a byte order mark; TextDecoder strips it unless told not to.
    { head: '\uFEFF' + head, code: invalid },
    { claims: '\uFEFF' + payload, code: invalid },
    { claims: claimsWith('"aud":"other"'), code: invalid },
    { claims: '{"aud":"other",' + payload.slice(1), code: invalid },
    { claims: claimsWith('"jti":"replayed"'), code: invalid },
    { claims: claimsWith('"sub":"merchant_fixture"'), code: invalid },
    { claims: claimsWith('"sub":null'), code: invalid },
    { claims: JSON.stringify({ ...claims, aud: [claims.aud] }), code: invalid },
    { claims: JSON.stringify({ ...claims, aud: null }), code: invalid },
    { claims: JSON.stringify({ ...claims, iat: claims.iat + 0.5 }), code: invalid },
    { claims: payload.replace('"iat":' + claims.iat, '"iat":' + claims.iat + '.0'), code: invalid },
    {
      claims: payload.replace('"exp":' + claims.exp, '"exp":' + claims.exp / 100 + 'e2'),
      code: invalid,
    },
    { claims: JSON.stringify({ ...claims, iat: String(claims.iat) }), code: invalid },
    { claims: JSON.stringify({ ...claims, exp: null }), code: invalid },
    { claims: JSON.stringify({ ...claims, jti: ' \t' }), code: invalid },
    { claims: JSON.stringify({ ...claims, body_sha256: 1 }), code: invalid },
    // Unknown claims, including nested duplicate members, are ignored as in Go.
    { claims: claimsWith('"nbf":1,"extra":{"a":1,"a":2}') },
    // Whitespace around the first brace and a colon is still the same JSON.
    { claims: '{ ' + payload.slice(1).replaceAll('"iss":', '"iss" :') },
  ].map((c) => ({
    ...c,
    authorization: 'Bearer ' + signedToken(c.head ?? head, c.claims ?? payload),
  }));
}
const headers = { Authorization: 'Bearer ' + token() };
const secret = 'synthetic-hmac-secret';
const hmacHeaders = {
  'X-Timestamp': String(vectors.now),
  'X-Signature': createHmac('sha256', secret)
    .update(vectors.now + '.')
    .update(body)
    .digest('hex'),
};
test('JWT is decisive; HMAC remains available with secrets and its complete headers', async () => {
  const cases = [
    {
      headers: { ...headers, ...hmacHeaders },
      options: { ...options, secrets: secret },
      method: 'jwt',
    },
    {
      headers: { ...headers, ...hmacHeaders },
      options: { secrets: secret, nowSeconds: vectors.now },
      method: 'hmac',
    },
    { headers: hmacHeaders, options: { ...options, secrets: secret }, method: 'hmac' },
    {
      headers: { ...hmacHeaders, Authorization: 'Bearer malformed' },
      options: { ...options, secrets: secret },
      code: 'invalid_token',
    },
    {
      headers: { ...hmacHeaders, Authorization: 'Bearer ' + token({ aud: 'other' }) },
      options: { ...options, secrets: secret },
      code: 'invalid_audience',
    },
    {
      headers: { ...hmacHeaders, Authorization: 'Basic synthetic, ' + headers.Authorization },
      options: { ...options, secrets: secret },
      code: 'invalid_token',
    },
    {
      headers: { ...hmacHeaders, Authorization: ['Basic synthetic', headers.Authorization] },
      options: { ...options, secrets: secret },
      code: 'invalid_token',
    },
    { headers: headers, options: { secrets: secret }, code: 'missing_header' },
    {
      headers: { 'X-Signature': hmacHeaders['X-Signature'] },
      options: { secrets: secret },
      code: 'missing_header',
    },
    { headers: {}, options, code: 'missing_header' },
  ];
  for (const c of cases) {
    const result = sdk.verifyWebhookAsync(body, c.headers, c.options);
    if (c.code) await assert.rejects(result, { code: 'webhook_' + c.code });
    else {
      const verified = await result;
      assert.equal(verified.signingMethod, c.method);
      assert.equal(verified.known, true);
    }
  }
  assert.equal(sdk.verifyWebhook(body, hmacHeaders, secret, vectors.now).signingMethod, undefined);
  assert.deepEqual(
    php(
      `$rows=[]; foreach($input['cases'] as $c){$o=$c['options'];$renames=['endpointIds'=>'endpoint_ids','baseUrl'=>'base_url','nowSeconds'=>'now_seconds'];foreach($renames as $a=>$b)if(array_key_exists($a,$o)){$o[$b]=$o[$a];unset($o[$a]);}try{$r=Webhooks::verifyDelivery($input['body'],$c['headers'],$o);$rows[]=$r['signing_method'];}catch(SdkError $e){$rows[]=$e->errorCode;}}echo json_encode($rows);`,
      { cases, body: body.toString() },
    ),
    cases.map((c) => (c.code ? 'webhook_' + c.code : c.method)),
  );
});

test('signed claims, JOSE restrictions, time boundaries, exact bytes and decoding agree', async () => {
  const cases = [
    { claims: { iss: 'https://untrusted.example' }, code: 'invalid_token' },
    { claims: { jti: '' }, code: 'invalid_token' },
    ...['crit', 'jku', 'x5u', 'jwk', 'x5c'].map((name) => ({
      jose: { [name]: name === 'crit' ? [] : 'untrusted' },
      code: 'invalid_token',
    })),
    { claims: { aud: 'other' }, code: 'invalid_audience' },
    { claims: { iat: vectors.now + 60, exp: vectors.now + 360 } },
    { claims: { iat: vectors.now + 61, exp: vectors.now + 361 }, code: 'token_expired' },
    { claims: { iat: vectors.now - 359, exp: vectors.now - 59 } },
    { claims: { iat: vectors.now - 360, exp: vectors.now - 60 }, code: 'token_expired' },
    { claims: { exp: vectors.now + 301 }, code: 'token_expired' },
    { claims: { exp: vectors.now }, code: 'token_expired' },
    { claims: { iat: 0, exp: 300 }, code: 'token_expired' },
    { claims: { body_sha256: claims.body_sha256 + '=' }, code: 'body_mismatch' },
    { raw: body.toString() + ' ', code: 'body_mismatch' },
    {
      raw: '{',
      claims: { body_sha256: createHash('sha256').update('{').digest('base64url') },
      code: 'invalid_json',
      kind: 'protocol',
    },
  ].map((c) => ({ ...c, authorization: 'Bearer ' + token(c.claims, c.jose) }));
  cases.push(...strictParsingCases());
  for (const c of cases) {
    const result = sdk.verifyWebhookAsync(
      Buffer.from(c.raw ?? body),
      { authorization: c.authorization },
      options,
    );
    if (c.code)
      await assert.rejects(result, { code: 'webhook_' + c.code, kind: c.kind ?? 'authentication' });
    else assert.equal((await result).known, true);
  }
  assert.deepEqual(
    php(
      `$rows=[];foreach($input['cases'] as $c){try{$r=Webhooks::verifyDelivery($c['raw']??$input['body'],['authorization'=>$c['authorization']],$input['options']);$rows[]=$r['known'];}catch(SdkError $e){$rows[]=$e->kind.':'.$e->errorCode;}}echo json_encode($rows);`,
      {
        cases,
        body: body.toString(),
        options: { endpoint_ids: claims.aud, base_url: claims.iss, now_seconds: vectors.now, jwks },
      },
    ),
    cases.map((c) => (c.code ? (c.kind ?? 'authentication') + ':webhook_' + c.code : true)),
  );
});

test('JWT-only providers, client defaults, literal issuers and public consumer declarations', async () => {
  const jwtOnly = { ...config, webhook: { jwt, typeField: 'type', events: config.webhook.events } };
  const onlyOut = build('only', jwtOnly);
  const onlySdk = await import(pathToFileURL(join(onlyOut, 'node/index.js')));
  const client = new onlySdk.Client({
    baseUrl: claims.iss + '/v1/',
    transport: async (url) => {
      assert.equal(url, claims.iss + jwt.jwksPath);
      return Response.json(jwks);
    },
  });
  assert.equal(
    (
      await client.verifyWebhookAsync(body, headers, {
        endpointIds: claims.aud,
        nowSeconds: vectors.now,
      })
    ).signingMethod,
    'jwt',
  );
  const literal = build('literal', {
    ...jwtOnly,
    webhook: { ...jwtOnly.webhook, jwt: { ...jwt, issuer: claims.iss } },
  });
  const literalSdk = await import(pathToFileURL(join(literal, 'node/index.js')));
  assert.equal(
    (
      await literalSdk.verifyWebhookAsync(body, headers, {
        endpointIds: claims.aud,
        nowSeconds: vectors.now,
        jwks,
      })
    ).known,
    true,
  );
  const ts = join(root, 'consumer.mts');
  writeFileSync(
    ts,
    `import {Client,verifyWebhookAsync,type WebhookVerificationOptions,type VerifiedWebhook} from './only/node/index.js';\nimport {verifyWebhookAsync as verify} from './only/node/webhooks.js';\nconst options:WebhookVerificationOptions={endpointIds:['whep_fixture'],jwks:{keys:[]},fetch};\nconst client=new Client({baseUrl:'https://issuer.example'});\nfor(const result of [verifyWebhookAsync(new Uint8Array(),{},options),verify(new ArrayBuffer(0),new Headers(),options),client.verifyWebhookAsync(new Uint8Array(),{},options)]){const r:VerifiedWebhook & {signingMethod:'jwt'|'hmac'}=await result;if(r.known){const id:string=r.event.id;void id;}}`,
  );
  const tsc = spawnSync(
    process.execPath,
    [
      resolve('node_modules/typescript/bin/tsc'),
      '--noEmit',
      '--strict',
      '--skipLibCheck',
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      ts,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(tsc.status, 0, tsc.stdout + tsc.stderr);
});

test('bad verifier options use validation errors in both targets', async () => {
  for (const bad of [
    {},
    { endpointIds: [] },
    { endpointIds: 1 },
    { secrets: [] },
    { ...options, nowSeconds: 1700000000000 },
    { ...options, nowSeconds: null },
    { ...options, jwks: { keys: [{ kty: 'RSA' }] } },
    { ...options, jwks: { keys: [jwks.keys[0], jwks.keys[0]] } },
    { ...options, extra: true },
    { ...options, fetch: 'bad' },
  ])
    await assert.rejects(sdk.verifyWebhookAsync(body, headers, bad), {
      kind: 'validation',
      code: 'webhook_invalid_input',
    });
  assert.deepEqual(
    php(
      `$rows=[];foreach([[],['endpoint_ids'=>[]],['secrets'=>[]],['endpoint_ids'=>1],['cache'=>new stdClass()],['http_client'=>new stdClass()],['now_seconds'=>1700000000000,'endpoint_ids'=>'fixture'],['endpoint_ids'=>'fixture','jwks'=>['keys'=>[['kty'=>'RSA']]],'base_url'=>$input['issuer'],'now_seconds'=>$input['now']]] as $o){try{Webhooks::verifyDelivery($input['body'],['authorization'=>$input['authorization']],$o);$rows[]='accepted';}catch(SdkError $e){$rows[]=$e->kind.':'.$e->errorCode;}}echo json_encode($rows);`,
      {
        issuer: claims.iss,
        now: vectors.now,
        body: body.toString(),
        authorization: headers.Authorization,
      },
    ),
    Array(8).fill('validation:webhook_invalid_input'),
  );
});

test('JWKS selection ignores unrelated keys; unusable selected keys fail only the token', async () => {
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({
    format: 'jwk',
  });
  const okp = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' });
  const ec = { kty: 'EC', crv: 'P-256', x: exported.x, y: exported.y };
  const selected = jwks.keys[0];
  const unrelated = [
    { ...rsa, kid: 'rsa-key', alg: 'RS256', use: 'sig' },
    { ...okp, kid: 'okp-key', alg: 'EdDSA' },
    { ...ec, kid: 'enc-key', use: 'enc' },
    { ...ec, kid: 'p384-key', crv: 'P-384', alg: 'ES384' },
    { kty: 'oct', kid: 'oct-key' },
  ];
  const keyText = (keys) => JSON.stringify({ keys });
  const cases = [
    { jwks: keyText([...unrelated, selected]) },
    { jwks: keyText([{ ...ec, kid }]) },
    { jwks: keyText([{ ...selected, d: 'AAAA', key_ops: ['sign'] }]) },
    { jwks: keyText([...unrelated]), code: 'unknown_key' },
    { jwks: keyText([selected, { ...rsa, kid: 'repeated' }, { ...okp, kid: 'repeated' }]) },
    { jwks: keyText([{ kty: 'EC', crv: 'P-256', kid }]), code: 'unusable' },
    { jwks: keyText([{ ...selected, use: 'enc' }]), code: 'unusable' },
    { jwks: keyText([{ ...selected, use: null }]), code: 'unusable' },
    { jwks: keyText([{ ...selected, alg: 'ES384' }]), code: 'unusable' },
    { jwks: keyText([{ ...rsa, kid }]), code: 'unusable' },
    { jwks: keyText([{ ...selected, crv: 'P-384' }]), code: 'unusable' },
    { jwks: keyText([{ ...selected, x: selected.x + '=' }]), code: 'unusable' },
    { jwks: keyText([{ ...selected, y: selected.x }]), code: 'unusable' },
    { jwks: keyText([selected, { ...rsa, kid }]), code: 'invalid' },
    { jwks: keyText([selected, selected]), code: 'invalid' },
    { jwks: keyText([selected, { ...rsa }]), code: 'invalid' },
    { jwks: keyText([selected, { ...okp, kid: 7 }]), code: 'invalid' },
    { jwks: keyText([selected, 'not a key']), code: 'invalid' },
    { jwks: JSON.stringify({ keys: null }), code: 'invalid' },
    { jwks: '[' + keyText([selected]) + ']', code: 'invalid' },
    { jwks: '\uFEFF' + keyText([selected]), code: 'invalid', fetchedOnly: true },
    // Duplicate members cannot be expressed by a caller's JWKS object, only by a fetched document.
    { jwks: '{"keys":[],' + keyText([selected]).slice(1), code: 'invalid', fetchedOnly: true },
    {
      jwks: keyText([selected, { ...rsa, kid: 'rsa-key' }]).replace('"e":', '"e":"AQAB","e":'),
      code: 'invalid',
      fetchedOnly: true,
    },
    {
      jwks: keyText([selected]).replace('"kty":"EC"', '"kty":"RSA","kty":"EC"'),
      code: 'invalid',
      fetchedOnly: true,
    },
  ];
  const outcome = (c, fetched) =>
    c.code === undefined
      ? 'jwt'
      : c.code === 'unknown_key'
        ? 'authentication:webhook_unknown_key'
        : // A unique but unusable selected key fails the token, never as a retryable outage.
          c.code === 'unusable'
          ? 'authentication:webhook_invalid_token'
          : fetched
            ? 'transport:webhook_jwks_unavailable'
            : 'validation:webhook_invalid_input';
  const issuer = (index) => 'https://selection' + index + '.example';
  const rows = cases.map((c, index) => ({
    ...c,
    issuer: issuer(index),
    authorization: 'Bearer ' + token({ iss: issuer(index) }),
  }));
  const node = [];
  for (const c of rows) {
    for (const fetched of [false, true]) {
      if (!fetched && c.fetchedOnly) continue;
      const settle = async () => {
        try {
          return (
            await sdk.verifyWebhookAsync(
              body,
              { authorization: c.authorization },
              {
                endpointIds: claims.aud,
                baseUrl: c.issuer,
                nowSeconds: vectors.now,
                ...(fetched
                  ? { fetch: async () => new Response(c.jwks) }
                  : { jwks: JSON.parse(c.jwks) }),
              },
            )
          ).signingMethod;
        } catch (error) {
          return error.kind + ':' + error.code;
        }
      };
      node.push(await settle());
    }
  }
  const expected = rows.flatMap((c) =>
    c.fetchedOnly ? [outcome(c, true)] : [outcome(c, false), outcome(c, true)],
  );
  assert.deepEqual(node, expected);
  assert.deepEqual(
    php(
      `$rows=[];foreach($input['rows'] as $c){foreach([false,true] as $fetched){if(!$fetched&&!empty($c['fetchedOnly']))continue;$o=['endpoint_ids'=>$input['aud'],'base_url'=>$c['issuer'],'now_seconds'=>$input['now']];if(!$fetched)$o['jwks']=json_decode($c['jwks'],true);$client=new Client(new ClientOptions(baseUrl:$c['issuer'],transport:fn($r)=>['status'=>200,'headers'=>[],'body'=>$c['jwks']]));try{$rows[]=$client->verifyWebhookDelivery($input['body'],['authorization'=>$c['authorization']],$o)['signing_method'];}catch(SdkError $e){$rows[]=$e->kind.':'.$e->errorCode;}}}echo json_encode($rows);`,
      { rows, aud: claims.aud, now: vectors.now, body: body.toString() },
    ),
    expected,
  );
});

test('JWT config bounds, incomplete HMAC and reserved names fail with specific diagnostics', () => {
  for (const [field, value] of [
    ['algorithm', 'RS256'],
    ['algorithm', 'HS256'],
    ['bodyHashEncoding', 'hex'],
    ['leewaySeconds', 61],
    ['leewaySeconds', -1],
    ['lifetimeSeconds', 0],
    ['lifetimeSeconds', 3601],
    ['issuer', 'https://user@example.com'],
    ['jwksPath', '//untrusted.example/jwks'],
    ['scheme', 'Basic'],
  ]) {
    const profile = join(root, 'invalid.json');
    writeFileSync(
      profile,
      JSON.stringify({
        ...config,
        webhook: { ...config.webhook, jwt: { ...jwt, [field]: value } },
      }),
    );
    assert.throws(
      () => loadContract(api, profile),
      new RegExp(field + (field === 'algorithm' ? '.*' + value : '')),
    );
  }
  for (const name of [
    'verifyWebhookAsync',
    'verifyWebhookDelivery',
    'WebhookVerificationOptions',
  ]) {
    const schemaApi = join(root, 'collision.json');
    writeFileSync(
      schemaApi,
      JSON.stringify({
        openapi: '3.1.0',
        info: { title: 'Collision', version: '1' },
        paths: {
          '/health': {
            get: {
              operationId: 'health',
              responses: {
                200: {
                  description: 'OK',
                  content: {
                    'application/json': { schema: { $ref: '#/components/schemas/' + name } },
                  },
                },
              },
            },
          },
        },
        components: {
          schemas: { [name]: { type: 'object', properties: { id: { type: 'string' } } } },
        },
      }),
    );
    const profile = join(root, 'collision-config.json');
    writeFileSync(profile, JSON.stringify(config));
    assert.throws(
      () => generate(loadContract(schemaApi, profile), join(root, 'collision-output')),
      /collision|reserved/i,
    );
  }
});

test('Node JWKS cache single-flight, TTL clamps, rotation throttle and stale-on-error', async (t) => {
  let clock = 2000000000;
  t.mock.method(Date, 'now', () => clock * 1000);
  let serial = 0;
  const prepare = (cacheControl = 'max-age=900') => {
    const issuer = 'https://cache' + serial++ + '.example';
    const auth = { authorization: 'Bearer ' + token({ iss: issuer }) };
    let count = 0,
      failure = false,
      keys = jwks;
    const fetch = async () => {
      count++;
      await Promise.resolve();
      if (failure) throw new Error('synthetic outage');
      return Response.json(keys, {
        headers: cacheControl === null ? {} : { 'Cache-Control': cacheControl },
      });
    };
    const opts = { endpointIds: claims.aud, baseUrl: issuer, nowSeconds: vectors.now, fetch };
    return {
      issuer,
      auth,
      opts,
      count: () => count,
      fail: () => {
        failure = true;
      },
      recover: () => {
        failure = false;
      },
      keys: (value) => {
        keys = value;
      },
    };
  };
  const concurrent = prepare();
  await Promise.all(
    Array.from({ length: 40 }, () =>
      sdk.verifyWebhookAsync(body, concurrent.auth, concurrent.opts),
    ),
  );
  assert.equal(concurrent.count(), 1);
  for (const [directive, ttl] of [
    ['max-age=1', 300],
    ['max-age=99999999', 86400],
    [null, 900],
  ]) {
    const c = prepare(directive);
    await sdk.verifyWebhookAsync(body, c.auth, c.opts);
    clock += ttl - 1;
    await sdk.verifyWebhookAsync(body, c.auth, c.opts);
    assert.equal(c.count(), 1);
    clock++;
    await sdk.verifyWebhookAsync(body, c.auth, c.opts);
    assert.equal(c.count(), 2);
  }
  const rotation = prepare();
  rotation.keys({ keys: [] });
  await assert.rejects(sdk.verifyWebhookAsync(body, rotation.auth, rotation.opts), {
    code: 'webhook_unknown_key',
  });
  await Promise.all(
    Array.from({ length: 20 }, () =>
      assert.rejects(sdk.verifyWebhookAsync(body, rotation.auth, rotation.opts), {
        code: 'webhook_unknown_key',
      }),
    ),
  );
  assert.equal(rotation.count(), 1);
  clock += 60;
  rotation.keys(jwks);
  await Promise.all(
    Array.from({ length: 20 }, () => sdk.verifyWebhookAsync(body, rotation.auth, rotation.opts)),
  );
  assert.equal(rotation.count(), 2);
  const stale = prepare();
  await sdk.verifyWebhookAsync(body, stale.auth, stale.opts);
  clock += 901;
  stale.fail();
  const staleResults = await Promise.all(
    Array.from({ length: 40 }, () => sdk.verifyWebhookAsync(body, stale.auth, stale.opts)),
  );
  assert.ok(staleResults.every((result) => result.signingMethod === 'jwt'));
  assert.equal(stale.count(), 2, 'all stale callers share the failed refresh');
  await sdk.verifyWebhookAsync(body, stale.auth, stale.opts);
  clock += 59;
  await sdk.verifyWebhookAsync(body, stale.auth, stale.opts);
  assert.equal(stale.count(), 2, 'a failed refresh is retried only after 60 seconds');
  clock += 1;
  await sdk.verifyWebhookAsync(body, stale.auth, stale.opts);
  assert.equal(stale.count(), 3);
  clock += 60;
  stale.recover();
  await sdk.verifyWebhookAsync(body, stale.auth, stale.opts);
  await sdk.verifyWebhookAsync(body, stale.auth, stale.opts);
  assert.equal(stale.count(), 4, 'a successful refresh clears the retry delay');
  clock += 901;
  stale.fail();
  await sdk.verifyWebhookAsync(body, stale.auth, stale.opts);
  clock += 86400;
  await assert.rejects(sdk.verifyWebhookAsync(body, stale.auth, stale.opts), {
    kind: 'transport',
    code: 'webhook_jwks_unavailable',
  });
  const explicit = prepare();
  explicit.fail();
  assert.equal(
    (await sdk.verifyWebhookAsync(body, explicit.auth, { ...explicit.opts, jwks })).known,
    true,
  );
  assert.equal(explicit.count(), 0);
  for (const response of [
    Response.json({ keys: [{ kty: 'RSA' }] }),
    new Response('x'.repeat(256 * 1024 + 1)),
    new Response('{}', { status: 503 }),
    new Response('not JSON'),
  ]) {
    const c = prepare();
    await assert.rejects(
      sdk.verifyWebhookAsync(body, c.auth, { ...c.opts, fetch: async () => response }),
      { code: 'webhook_jwks_unavailable' },
    );
  }
});

test('PHP process-wide JWKS cache, Fiber single-flight, TTL clamps, rotation and bounded stale use', () => {
  const program = readFileSync('tests/fixtures/webhook-jwt-cache.php', 'utf8').replace(
    /^<\?php\s*/,
    '',
  );
  const rows = php(program, {
    issuer: claims.iss,
    authorization: headers.Authorization,
    jwks,
    body: body.toString(),
    now: vectors.now,
  });
  assert.equal(rows.length, 24);
  assert.ok(rows.every(Boolean), JSON.stringify(rows));
});

test('PHP optional PSR-16/18/17 integrations use real interfaces without generated hard dependencies', () => {
  const program = readFileSync('tests/fixtures/webhook-jwt-psr.php', 'utf8').replace(
    /^<\?php\s*/,
    '',
  );
  const rows = php(program, {
    issuer: claims.iss,
    authorization: headers.Authorization,
    jwks,
    body: body.toString(),
    now: vectors.now,
    autoload: resolve('.generated/phpstan-vendor/autoload.php'),
  });
  assert.deepEqual(rows, Array(14).fill(true));
  const composer = JSON.parse(readFileSync(join(out, 'php/composer.json'), 'utf8'));
  assert.equal(
    Object.keys(composer.require).some((name) => name.startsWith('psr/')),
    false,
  );
  for (const name of ['psr/simple-cache', 'psr/http-client', 'psr/http-factory', 'ext-openssl'])
    assert.ok(composer.suggest[name]);
});

test('PHP shares JWKS state through APCu when no PSR-16 cache is supplied', () => {
  const program = readFileSync('tests/fixtures/webhook-jwt-apcu.php', 'utf8').replace(
    /^<\?php\s*/,
    '',
  );
  const rows = php(
    program,
    {
      issuer: 'https://apcu.example',
      authorization: 'Bearer ' + token({ iss: 'https://apcu.example' }),
      jwks,
      body: body.toString(),
      now: vectors.now,
      autoload: resolve('.generated/phpstan-vendor/autoload.php'),
    },
    ['-d', 'apc.enable_cli=1'],
  );
  assert.ok(rows.length >= 8, JSON.stringify(rows));
  assert.ok(rows.every(Boolean), JSON.stringify(rows));
});

test('JWKS timeout remains bounded even when an injected Node fetch ignores cancellation', async () => {
  let signal;
  const issuer = 'https://timeout.example';
  await assert.rejects(
    sdk.verifyWebhookAsync(
      body,
      { authorization: 'Bearer ' + token({ iss: issuer }) },
      {
        endpointIds: claims.aud,
        nowSeconds: vectors.now,
        baseUrl: issuer,
        fetch: (_url, init) => {
          signal = init.signal;
          return new Promise(() => {});
        },
      },
    ),
    { kind: 'transport', code: 'webhook_jwks_unavailable' },
  );
  assert.equal(signal.aborted, true);
});

test('default Node and PHP HTTP transports fetch trusted keys and enforce the body cap', async (t) => {
  let oversized = false,
    requests = 0;
  const server = createServer((req, res) => {
    assert.equal(req.url, jwt.jwksPath);
    assert.equal(req.headers.authorization, undefined);
    requests++;
    res.setHeader('Cache-Control', 'public, max-age=900');
    res.end(oversized ? ' '.repeat(256 * 1024 + 1) : JSON.stringify(jwks));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const issuer = `http://127.0.0.1:${server.address().port}`;
  const authorization = 'Bearer ' + token({ iss: issuer });
  const result = await sdk.verifyWebhookAsync(
    body,
    { authorization },
    { endpointIds: claims.aud, baseUrl: issuer, nowSeconds: vectors.now },
  );
  assert.equal(result.signingMethod, 'jwt');
  const script = join(root, 'default-http.php');
  writeFileSync(
    script,
    `<?php require $argv[1].'/src/Runtime.php';require $argv[1].'/src/Client.php';$i=json_decode(file_get_contents($argv[2]),true);try{$r=Example\\Jwt\\Webhooks::verifyDelivery($i['body'],['authorization'=>$i['authorization']],['endpoint_ids'=>'whep_fixture','base_url'=>$i['issuer'],'now_seconds'=>$i['now']]);echo json_encode($r['signing_method']);}catch(Example\\Jwt\\SdkError $e){echo json_encode($e->errorCode);}`,
  );
  const input = script + '.json';
  writeFileSync(
    input,
    JSON.stringify({ issuer, authorization, body: body.toString(), now: vectors.now }),
  );
  const run = async () =>
    JSON.parse((await promisify(execFile)('php', [script, join(out, 'php'), input])).stdout);
  assert.equal(await run(), 'jwt');
  assert.equal(requests, 2);
  oversized = true;
  assert.equal(await run(), 'webhook_jwks_unavailable');
});

test('merged JWT profiles retain completeness diagnostics and restored descriptors reject malformed settings', () => {
  const partial = structuredClone(config);
  delete partial.webhook.jwt.algorithm;
  writeFileSync(join(root, 'jwt-base.json'), JSON.stringify(partial));
  writeFileSync(
    join(root, 'jwt-signing.json'),
    JSON.stringify({ webhook: { jwt: { algorithm: 'ES256' } } }),
  );
  writeFileSync(
    join(root, 'jwt-merged.json'),
    JSON.stringify({ profiles: ['./jwt-base.json', './jwt-signing.json'] }),
  );
  assert.equal(
    loadContract(api, join(root, 'jwt-merged.json')).config.webhook.jwt.algorithm,
    'ES256',
  );
  for (const field of Object.keys(jwt)) {
    const incomplete = structuredClone(config);
    delete incomplete.webhook.jwt[field];
    const profile = join(root, 'missing-jwt-field.json');
    writeFileSync(profile, JSON.stringify(incomplete));
    assert.throws(() => loadContract(api, profile), new RegExp('jwt/' + field));
  }
  const incompleteHmac = {
    ...config,
    webhook: {
      jwt,
      algorithm: 'hmac-sha256',
      separator: '.',
      toleranceSeconds: 300,
      events: {},
      typeField: 'type',
    },
  };
  const profile = join(root, 'missing-hmac-field.json');
  writeFileSync(profile, JSON.stringify(incompleteHmac));
  assert.throws(() => loadContract(api, profile), /webhook\/header/);
  const plan = compileRuntimePlan({ operations: [], webhook: config.webhook });
  const invalid = [
    ['algorithm', 'HS256'],
    ['scheme', 'Basic'],
    ['leewaySeconds', 61],
    ['lifetimeSeconds', 0],
    ['bodyHashEncoding', 'hex'],
    ['issuer', 'http://untrusted.example'],
    ['jwksPath', '//untrusted.example/keys'],
  ];
  for (const [field, value] of invalid) {
    const restored = JSON.parse(JSON.stringify(plan));
    restored.webhook.jwt[field] = value;
    assert.throws(() => assertRuntimePlan(restored), /webhook.jwt/);
  }
  const results = php(
    `$rows=[];foreach($input['invalid'] as [$field,$value]){$plan=$input['plan'];$plan['webhook']['jwt'][$field]=$value;try{Example\\Jwt\\Runtime::assertCompiledPlan($plan);$rows[]=false;}catch(InvalidArgumentException $e){$rows[]=true;}}echo json_encode($rows);`,
    { plan, invalid },
  );
  assert.deepEqual(
    results,
    invalid.map(() => true),
  );
});

test('the Flint wire lifetime stays bounded to 300 seconds even with a larger declaration', async () => {
  const wide = structuredClone(config);
  wide.webhook.jwt.lifetimeSeconds = 3600;
  const profile = join(root, 'wide-lifetime.json');
  writeFileSync(profile, JSON.stringify(wide));
  assert.equal(loadContract(api, profile).config.webhook.jwt.lifetimeSeconds, 3600);
  const plan = compileRuntimePlan({ operations: [], webhook: wide.webhook });
  const { verifyWebhookAsyncFromPlan } = await import('../dist/runtime.js');
  const authorization = 'Bearer ' + token({ exp: vectors.now + 301 });
  await assert.rejects(verifyWebhookAsyncFromPlan(plan, body, { authorization }, options), {
    code: 'webhook_token_expired',
  });
  assert.equal(
    php(
      `try{Example\\Jwt\\Runtime::verifyWebhookDeliveryFromPlan($input['plan'],$input['body'],['authorization'=>$input['authorization']],$input['options']);echo json_encode('accepted');}catch(SdkError $e){echo json_encode($e->errorCode);}`,
      {
        plan,
        body: body.toString(),
        authorization,
        options: { endpoint_ids: claims.aud, jwks, base_url: claims.iss, now_seconds: vectors.now },
      },
    ),
    'webhook_token_expired',
  );
});

test('JWT-enabled generated inbox examples authenticate before durable insertion', async () => {
  const inbox = await import(pathToFileURL(join(out, 'node/examples/webhook-inbox.mjs')));
  const db = inbox.openInbox(':memory:');
  try {
    const result = await inbox.receiveWebhook(
      new sdk.Client({ baseUrl: claims.iss }),
      db,
      body,
      headers,
      options,
      (event) => event.id,
    );
    assert.deepEqual(result, { queued: true, known: true });
    await assert.rejects(
      inbox.receiveWebhook(
        new sdk.Client({ baseUrl: claims.iss }),
        db,
        Buffer.concat([body, Buffer.from(' ')]),
        headers,
        options,
        (event) => event.id,
      ),
      { code: 'webhook_body_mismatch' },
    );
    assert.equal(db.prepare('SELECT count(*) AS n FROM inbox').get().n, 1);
  } finally {
    db.close();
  }
  assert.deepEqual(
    php(
      `require $argv[1].'/examples/webhook-inbox.php';$db=Example\\Jwt\\Examples\\openInbox(':memory:');$client=new Client(new ClientOptions(baseUrl:$input['issuer']));$r=Example\\Jwt\\Examples\\receiveWebhook($client,$db,$input['body'],['authorization'=>$input['authorization']],$input['options'],fn($event)=>$event->getId());echo json_encode($r);`,
      {
        issuer: claims.iss,
        authorization: headers.Authorization,
        body: body.toString(),
        options: { endpoint_ids: claims.aud, jwks, now_seconds: vectors.now },
      },
    ),
    { queued: true, known: true },
  );
});

test('Node publishes a JWKS flight before a caller-owned fetch can reenter verification', async () => {
  const issuer = 'https://reentrant.example';
  const auth = { authorization: 'Bearer ' + token({ iss: issuer }) };
  let nested,
    started = false,
    requests = 0;
  const opts = {
    endpointIds: claims.aud,
    baseUrl: issuer,
    nowSeconds: vectors.now,
    fetch: async () => {
      requests++;
      if (!started) {
        started = true;
        nested = sdk.verifyWebhookAsync(body, auth, opts);
      }
      return Response.json(jwks);
    },
  };
  assert.equal((await sdk.verifyWebhookAsync(body, auth, opts)).known, true);
  assert.equal((await nested).known, true);
  assert.equal(requests, 1);
});
