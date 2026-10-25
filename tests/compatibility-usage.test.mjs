import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadContract, generate, compare, prepareRelease } from '../dist/index.js';

const ref = () => ({ $ref: '#/components/schemas/Leaf' });
const value = { code: 'ok', tag: 42 };
const positions = {
  allOf: { schema: () => ({ allOf: [ref(), { type: 'object' }] }), input: value },
  oneOf: { schema: () => ({ oneOf: [ref(), { type: 'string' }] }), input: value },
  anyOf: { schema: () => ({ anyOf: [ref(), { type: 'string' }] }), input: value },
  items: { schema: () => ({ type: 'array', items: ref() }), input: [value] },
  additionalProperties: {
    schema: () => ({ type: 'object', additionalProperties: ref() }),
    input: { first: value },
  },
  requestAndResponse: { schema: ref, input: value },
};

function fixture(t, target, body) {
  const dir = mkdtempSync(join(tmpdir(), 'compat-usage-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const api = join(dir, 'api.json'),
    profile = join(dir, 'sdk.json'),
    output = join(dir, 'sdk');
  const doc = {
    openapi: '3.1.0',
    info: { title: 'Usage', version: '1' },
    components: {
      schemas: {
        Leaf: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
      },
    },
    paths: {
      '/submit': {
        post: {
          operationId: 'submit',
          ...(body
            ? { requestBody: { required: true, content: { 'application/json': { schema: body } } } }
            : {}),
          responses: {
            200: { description: 'OK', content: { 'application/json': { schema: ref() } } },
          },
        },
      },
    },
  };
  const cfg = {
    version: '1.0.0',
    targets: [target],
    requests: { style: 'object' },
    responses: { return: 'result' },
    npm: { name: 'compatibility-usage-example' },
    composer: { name: 'example/usage', namespace: 'UsageExample' },
    release: { policy: 'semver' },
  };
  const load = () => {
    writeFileSync(api, JSON.stringify(doc));
    writeFileSync(profile, JSON.stringify(cfg));
    return loadContract(api, profile);
  };
  const call = async (input, revision) => {
    if (target === 'node') {
      const { Client } = await import(
        pathToFileURL(join(output, 'node/index.js')).href + '?' + revision
      );
      let sent = 0;
      try {
        await new Client({
          baseUrl: 'https://example.invalid',
          transport: async (_url, init) => {
            sent++;
            assert.deepEqual(JSON.parse(init.body), input);
            return new Response('{"code":"ok"}');
          },
        }).api.submit({ body: input });
        return { sent };
      } catch (error) {
        if (!error.kind) throw error;
        return { sent, kind: error.kind };
      }
    }
    const result = spawnSync(
      'php',
      [
        '-r',
        String.raw`require $argv[1].'/src/Runtime.php'; require $argv[1].'/src/Client.php'; $input=json_decode($argv[2],true); $sent=0; $client=new UsageExample\Client(new UsageExample\ClientOptions('https://example.invalid',transport:function($request)use(&$sent,$input){$sent++;if(json_decode($request['body'],true)!==$input)throw new Exception('request changed');return ['status'=>200,'headers'=>[],'body'=>'{"code":"ok"}'];}));try{$client->api->submit(['body'=>$input]);echo json_encode(['sent'=>$sent]);}catch(UsageExample\SdkError $e){echo json_encode(['sent'=>$sent,'kind'=>$e->kind]);}`,
        join(output, 'php'),
        JSON.stringify(input),
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  return { dir, output, doc, cfg, load, call };
}

for (const [position, { schema, input }] of Object.entries(positions))
  for (const target of ['node', 'php'])
    test(`${target}: ${position} request provenance requires a major release for optional typed fields`, async (t) => {
      const f = fixture(t, target, schema());
      const before = f.load();
      generate(before, f.output);
      prepareRelease(f.output, join(f.dir, 'first'));
      assert.deepEqual(await f.call(input, 'before'), { sent: 1 });
      f.doc.components.schemas.Leaf.properties.tag = { type: 'string' };
      f.cfg.version = '1.1.0';
      const after = f.load();
      const findings = compare(before, after);
      assert(
        findings.some(
          (finding) =>
            finding.subject === 'models.Leaf.input.tag' && finding.severity === 'breaking',
        ),
        JSON.stringify(findings),
      );
      generate(after, f.output);
      assert.deepEqual(await f.call(input, 'after'), { sent: 0, kind: 'validation' });
      assert.throws(() => prepareRelease(f.output, join(f.dir, 'minor')), /major/);
      f.cfg.version = '2.0.0';
      generate(f.load(), f.output);
      assert.equal(prepareRelease(f.output, join(f.dir, 'major')).version, '2.0.0');
    });

for (const target of ['node', 'php'])
  test(`${target}: positively proven response-only models permit optional additions beside query inputs`, (t) => {
    const f = fixture(t, target);
    f.doc.paths['/submit'].post.parameters = [
      { name: 'cursor', in: 'query', schema: { type: 'string' } },
    ];
    const before = f.load();
    assert(before.schemaUsage.responseOnlyModels.includes('Leaf'));
    generate(before, f.output);
    prepareRelease(f.output, join(f.dir, 'first'));
    f.doc.components.schemas.Leaf.properties.tag = { type: 'string' };
    f.cfg.version = '1.1.0';
    const after = f.load();
    assert(!compare(before, after).some((finding) => finding.severity === 'breaking'));
    generate(after, f.output);
    assert.equal(prepareRelease(f.output, join(f.dir, 'minor')).version, '1.1.0');
  });

for (const provenance of ['missing', 'stale'])
  test(`${provenance} source provenance keeps full model input rules`, (t) => {
    const f = fixture(t, 'node');
    const before = f.load();
    let after;
    if (provenance === 'missing') {
      f.doc.components.schemas.Leaf.properties.tag = { type: 'string' };
      after = f.load();
      delete before.schemaUsage;
      delete after.schemaUsage;
    } else {
      after = structuredClone(before);
      after.models.Leaf.properties.tag = { type: 'string' };
    }
    assert(
      compare(before, after).some(
        (finding) => finding.subject === 'models.Leaf.input.tag' && finding.severity === 'breaking',
      ),
    );
  });

test('source proof survives composition inlining but excludes shared request aliases and webhook inputs', (t) => {
  const f = fixture(t, 'node', { allOf: [ref(), { type: 'object' }] });
  const composed = f.load();
  assert(!composed.schemaUsage.responseOnlyModels.includes('Leaf'));
  assert.equal(composed.operations[0].body['x-sdk-ref'], undefined);

  f.doc.paths['/submit'].post.requestBody.content['application/json'].schema = {
    type: 'object',
    properties: { code: { type: 'string' } },
    required: ['code'],
  };
  const inline = f.load();
  assert(!inline.schemaUsage.responseOnlyModels.includes('Leaf'));

  f.doc.components.schemas.RequestLeaf = structuredClone(f.doc.components.schemas.Leaf);
  f.doc.paths['/submit'].post.requestBody.content['application/json'].schema = {
    $ref: '#/components/schemas/RequestLeaf',
  };
  const alias = f.load();
  assert(!alias.schemaUsage.responseOnlyModels.includes('Leaf'));
  assert(!alias.schemaUsage.responseOnlyModels.includes('RequestLeaf'));

  f.doc.components.schemas.Leaf.properties.kind = { type: 'string', enum: ['leaf'] };
  f.doc.components.schemas.Leaf.required.push('kind');
  f.doc.paths['/submit'].post.requestBody.content['application/json'].schema = {
    oneOf: [
      ref(),
      {
        type: 'object',
        properties: { kind: { type: 'string', enum: ['other'] } },
        required: ['kind'],
      },
    ],
    discriminator: { propertyName: 'kind', mapping: { leaf: '#/components/schemas/Leaf' } },
  };
  assert(!f.load().schemaUsage.responseOnlyModels.includes('Leaf'));

  delete f.doc.paths['/submit'].post.requestBody;
  f.doc.webhooks = {
    received: {
      post: {
        requestBody: {
          content: { 'application/json': { schema: { allOf: [ref(), { type: 'object' }] } } },
        },
        responses: { 204: { description: 'OK' } },
      },
    },
  };
  assert(!f.load().schemaUsage.responseOnlyModels.includes('Leaf'));
});
