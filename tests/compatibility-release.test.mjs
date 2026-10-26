import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  loadContract,
  generate,
  preview,
  prepareRelease,
  setCompatibilityBaseline,
  compare,
} from '../dist/index.js';
import { compareSchemas, dedupeCompatibility } from '../dist/compatibility.js';
import { restoreCompiledSnapshot } from '../dist/compiled-record.js';

function fixture(t, targets = ['node', 'php']) {
  const dir = mkdtempSync(join(tmpdir(), 'compat-release-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const api = join(dir, 'api.json'),
    config = join(dir, 'sdk.json'),
    output = join(dir, 'sdk');
  const doc = {
    openapi: '3.1.0',
    info: { title: 'Compatibility', version: '1' },
    components: {
      schemas: {
        Value: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      },
    },
    paths: Object.fromEntries(
      ['one', 'two', 'three'].map((name) => [
        `/${name}`,
        {
          get: {
            operationId: name,
            responses: {
              200: {
                description: 'OK',
                content: { 'application/json': { schema: { $ref: '#/components/schemas/Value' } } },
              },
            },
          },
        },
      ]),
    ),
  };
  const cfg = {
    version: '1.0.0',
    targets,
    requests: { style: 'object' },
    responses: { return: 'result' },
    npm: { name: 'compatibility-example' },
    composer: { name: 'example/compatibility', namespace: 'CompatibilityExample' },
    release: { policy: 'semver' },
  };
  const load = () => {
    writeFileSync(api, JSON.stringify(doc));
    writeFileSync(config, JSON.stringify(cfg));
    return loadContract(api, config);
  };
  return { dir, api, config, output, doc, cfg, load };
}

test('drafts have no comparison until the first prepared release, regardless of version bumps', (t) => {
  const f = fixture(t, ['node']);
  f.cfg.version = '0.1.0';
  generate(f.load(), f.output);
  delete f.doc.paths['/one'];
  assert.deepEqual(preview(f.load(), f.output).compatibility, []);
  generate(f.load(), f.output);
  f.cfg.version = '1.0.0';
  delete f.doc.paths['/two'];
  generate(f.load(), f.output);
  const first = prepareRelease(f.output, join(f.dir, 'first'));
  assert.deepEqual(first.compatibility, []);
  assert.equal(first.previousVersion, null);
  for (const file of ['CHANGELOG.md', 'MIGRATION.md'])
    assert.doesNotMatch(readFileSync(join(f.dir, 'first', file), 'utf8'), /breaking:/);
  f.cfg.version = '1.1.0';
  f.doc.paths['/three'].get.operationId = 'renamed';
  const next = generate(f.load(), f.output);
  assert(next.compatibility.some((c) => c.severity === 'breaking'));
  assert.throws(() => prepareRelease(f.output, join(f.dir, 'invalid')), /major/);
  assert.equal(existsSync(join(f.dir, 'invalid')), false);
});

test('optional response model fields permit a stable minor release in both targets', async (t) => {
  const f = fixture(t);
  const before = f.load();
  generate(before, f.output);
  setCompatibilityBaseline(f.output, 'released');
  f.doc.components.schemas.Value.properties.label = { type: 'string' };
  f.cfg.version = '1.1.0';
  const after = f.load();
  const findings = compare(before, after);
  assert(!findings.some((c) => c.severity === 'breaking'), JSON.stringify(findings));
  assert.equal(findings.filter((c) => c.severity === 'review').length, 1);
  assert(findings.some((c) => c.severity === 'additive' && c.subject.endsWith('.label')));
  generate(after, f.output);
  const plan = prepareRelease(f.output, join(f.dir, 'minor'));
  assert.equal(plan.previousVersion, '1.0.0');
  assert(!plan.compatibility.some((c) => c.severity === 'breaking'));
  // Public factories and PHP getters preserve an existing consumer's omitted field.
  const node = await import(new URL('file://' + join(f.output, 'node/index.js')));
  assert.deepEqual(JSON.parse(JSON.stringify(node.makeValue({ id: 'v' }))), { id: 'v' });
  assert.deepEqual(JSON.parse(JSON.stringify(node.makeValue({ id: 'v', label: 'new' }))), {
    id: 'v',
    label: 'new',
  });
  const php = spawnSync(
    'php',
    [
      '-r',
      String.raw`require $argv[1].'/src/Runtime.php'; $old = new CompatibilityExample\ApiOneResponse200(['id'=>'v']); $new = new CompatibilityExample\ApiOneResponse200(['id'=>'v','label'=>'new']); echo json_encode([$old->getId(),$old->hasLabel(),$new->getLabel()]);`,
      join(f.output, 'php'),
    ],
    { encoding: 'utf8' },
  );
  assert.equal(php.status, 0, php.stderr);
  assert.deepEqual(JSON.parse(php.stdout), ['v', false, 'new']);
});

test('a shared response model is compared once rather than at every response use site', (t) => {
  const f = fixture(t);
  const before = f.load();
  f.doc.components.schemas.Value.properties.id = { type: 'integer' };
  const findings = compare(before, f.load());
  const repeated = findings.filter((c) => /response types changed/.test(c.message));
  assert.equal(repeated.length, 1, JSON.stringify(findings));
  assert.equal(repeated[0].subject, 'models.Value.response.id');
  assert.equal(findings.filter((c) => c.message.includes('previous string guarantee')).length, 1);
  assert(findings.some((c) => c.severity === 'breaking'));
});

test('nested request model narrowing stays breaking when grouped with response model additions', async (t) => {
  const f = fixture(t);
  f.doc.components.schemas.Envelope = {
    type: 'object',
    properties: { value: { $ref: '#/components/schemas/Value' } },
    required: ['value'],
  };
  f.doc.paths['/submit'] = {
    post: {
      operationId: 'submit',
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Envelope' } } },
      },
      responses: { 204: { description: 'Saved' } },
    },
  };
  const before = f.load();
  assert.equal(before.config.schemaSharing, 'named');
  generate(before, f.output);
  setCompatibilityBaseline(f.output, 'released');
  let sent = 0;
  const options = {
    baseUrl: 'https://example.invalid',
    transport: async (_url, init) => {
      sent++;
      assert.deepEqual(JSON.parse(init.body), { value: { id: 'v', label: 123 } });
      return new Response(null, { status: 204 });
    },
  };
  const phpRequest = () => {
    const result = spawnSync(
      'php',
      [
        '-r',
        String.raw`require $argv[1].'/src/Runtime.php'; require $argv[1].'/src/Client.php'; $sent=0; $client=new CompatibilityExample\Client(new CompatibilityExample\ClientOptions('https://example.invalid',transport:function($request)use(&$sent){$sent++;if(json_decode($request['body'],true)!==['value'=>['id'=>'v','label'=>123]])throw new Exception('request changed');return ['status'=>204,'headers'=>[],'body'=>''];})); try{$client->api->submit(['body'=>['value'=>['id'=>'v','label'=>123]]]);echo json_encode(['sent'=>$sent]);}catch(CompatibilityExample\SdkError $e){echo json_encode(['sent'=>$sent,'kind'=>$e->kind]);}`,
        join(f.output, 'php'),
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const oldSdk = await import(new URL('file://' + join(f.output, 'node/index.js')));
  await new oldSdk.Client(options).api.submit({ body: { value: { id: 'v', label: 123 } } });
  assert.deepEqual(phpRequest(), { sent: 1 });

  f.doc.components.schemas.Value.properties.label = { type: 'string' };
  f.cfg.version = '1.1.0';
  const after = f.load();
  const findings = compare(before, after);
  const narrowed = findings.filter(
    (c) => c.subject === 'models.Value.input.label' && /field added/.test(c.message),
  );
  assert.equal(narrowed.length, 1, JSON.stringify(findings));
  assert.equal(narrowed[0].severity, 'breaking');
  assert(
    findings.some((c) => c.subject === 'models.Value.response.label' && c.severity === 'additive'),
  );
  generate(after, f.output);
  const newSdk = await import(new URL('file://' + join(f.output, 'node/index.js') + '?after'));
  await assert.rejects(
    new newSdk.Client(options).api.submit({ body: { value: { id: 'v', label: 123 } } }),
    { kind: 'validation' },
  );
  assert.equal(sent, 1);
  assert.deepEqual(phpRequest(), { sent: 0, kind: 'validation' });
  assert.throws(() => prepareRelease(f.output, join(f.dir, 'minor')), /major/);
});

test('nested named response models retain required keys without property declarations', async (t) => {
  for (const target of ['node', 'php'])
    await t.test(target, async (t) => {
      const f = fixture(t, [target]);
      f.doc.components.schemas.Value = { type: 'object', required: ['id'] };
      f.doc.components.schemas.Envelope = {
        type: 'object',
        properties: { value: { $ref: '#/components/schemas/Value' } },
        required: ['value'],
      };
      for (const path of Object.values(f.doc.paths))
        path.get.responses[200].content['application/json'].schema = {
          $ref: '#/components/schemas/Envelope',
        };
      const before = f.load();
      generate(before, f.output);
      setCompatibilityBaseline(f.output, 'released');
      const phpResponse = () => {
        const result = spawnSync(
          'php',
          [
            '-r',
            String.raw`require $argv[1].'/src/Runtime.php'; require $argv[1].'/src/Client.php'; $client=new CompatibilityExample\Client(new CompatibilityExample\ClientOptions('https://example.invalid',transport:fn($request)=>['status'=>200,'headers'=>[],'body'=>'{"value":{}}'])); try{$client->api->one();echo 'accepted';}catch(CompatibilityExample\SdkError $e){echo $e->kind;}`,
            join(f.output, 'php'),
          ],
          { encoding: 'utf8' },
        );
        assert.equal(result.status, 0, result.stderr);
        return result.stdout;
      };
      const options = {
        baseUrl: 'https://example.invalid',
        transport: async () => new Response('{"value":{}}'),
      };
      if (target === 'node') {
        const oldSdk = await import(new URL('file://' + join(f.output, 'node/index.js')));
        await assert.rejects(new oldSdk.Client(options).api.one(), { kind: 'protocol' });
      } else assert.equal(phpResponse(), 'protocol');

      f.doc.components.schemas.Value = { type: 'object', properties: { id: { type: 'string' } } };
      f.cfg.version = '1.1.0';
      const after = f.load();
      const findings = compare(before, after);
      const lost = findings.filter(
        (c) => c.subject === 'models.Value.response.id' && /now optional/.test(c.message),
      );
      assert.equal(lost.length, 1, JSON.stringify(findings));
      assert.equal(lost[0].severity, 'breaking');
      generate(after, f.output);
      if (target === 'node') {
        const newSdk = await import(
          new URL('file://' + join(f.output, 'node/index.js') + '?after')
        );
        await new newSdk.Client(options).api.one();
      } else assert.equal(phpResponse(), 'accepted');
      assert.throws(() => prepareRelease(f.output, join(f.dir, 'minor')), /major/);
    });
});

test('requiredness changes are independent of property additions and removals', () => {
  for (const direction of ['input', 'response'])
    for (const properties of [undefined, { id: { type: 'string' } }]) {
      const before = { type: 'object', required: ['id'], ...(properties ? { properties } : {}) };
      const after = {
        type: 'object',
        ...(properties ? {} : { properties: { id: { type: 'string' } } }),
      };
      for (const [old, next, required] of [
        [before, after, false],
        [after, before, true],
      ]) {
        const findings = compareSchemas(old, next, 'value', direction).filter((c) =>
          /field is now/.test(c.message),
        );
        assert.equal(findings.length, 1);
        assert.equal(
          findings[0].severity,
          (direction === 'input' ? required : !required) ? 'breaking' : 'additive',
        );
      }
    }
});

test('deduplicating compatibility findings keeps the maximum severity in any order', () => {
  const findings = ['additive', 'breaking', 'review'].map((severity) => ({
    severity,
    subject: 'models.Value.input.label',
    message: 'Input guarantee changed.',
  }));
  for (const order of [findings, [...findings].reverse()])
    assert.deepEqual(dedupeCompatibility(order), [{ ...findings[0], severity: 'breaking' }]);
});

test('enum addition describes newly accepted inputs, while removal explains migration', () => {
  const a = { type: 'string', enum: ['one'] },
    b = { type: 'string', enum: ['one', 'two'] };
  const added = compareSchemas(a, b, 'state', 'input');
  assert(added.some((c) => c.severity === 'additive' && /additional input values/.test(c.message)));
  assert(!added.some((c) => /replace removed/.test(c.message)));
  assert(
    compareSchemas(b, a, 'state', 'input').some(
      (c) => c.severity === 'breaking' && /replace removed/.test(c.message),
    ),
  );
});

test('reset and rebaseline retain ownership and saved compiled snapshots', (t) => {
  const f = fixture(t, ['node']);
  generate(f.load(), f.output);
  setCompatibilityBaseline(f.output, 'released');
  delete f.doc.paths['/one'];
  generate(f.load(), f.output);
  assert(preview(f.load(), f.output).compatibility.some((c) => c.severity === 'breaking'));
  const path = join(f.output, '.sdk-generator.json');
  const before = JSON.parse(readFileSync(path));
  setCompatibilityBaseline(f.output, 'draft');
  const reset = JSON.parse(readFileSync(path));
  assert.deepEqual(reset.files, before.files);
  assert.deepEqual(reset.compiled, before.compiled);
  assert.deepEqual(preview(f.load(), f.output).compatibility, []);
  setCompatibilityBaseline(f.output, 'released');
  const adopted = JSON.parse(readFileSync(path));
  assert.deepEqual(adopted.baseline.compiled, before.compiled);
  delete f.doc.paths['/two'];
  assert(preview(f.load(), f.output).compatibility.some((c) => c.severity === 'breaking'));
});

test('preview --fail-on chooses CI exit status and preserves the report without writes', (t) => {
  const f = fixture(t, ['node']);
  f.cfg.$schema = 'https://example.invalid/sdk-config.schema.json';
  f.cfg.operations = Object.fromEntries(
    ['one', 'two', 'three'].map((name) => [name, { resource: 'api', method: name }]),
  );
  generate(f.load(), f.output);
  setCompatibilityBaseline(f.output, 'released');
  f.doc.components.schemas.Value.properties.label = { type: 'string' };
  f.load();
  const record = readFileSync(join(f.output, '.sdk-generator.json'), 'utf8');
  const cli = (...flags) =>
    spawnSync(
      process.execPath,
      [resolve('dist/cli.js'), 'preview', f.api, f.config, f.output, ...flags],
      { encoding: 'utf8' },
    );
  for (const json of [[], ['--json']]) {
    assert.equal(cli(...json).status, 0);
    assert.equal(cli(...json, '--fail-on', 'none').status, 0);
    assert.equal(cli(...json, '--fail-on', 'breaking').status, 0);
    const failed = cli(...json, '--fail-on', 'additive');
    assert.equal(failed.status, 1, failed.stderr);
    assert.equal(failed.stderr, '');
    const withDiff = cli(...json, '--diff', '--fail-on', 'additive');
    assert.equal(withDiff.status, 1, withDiff.stderr);
    if (json.length) {
      const report = JSON.parse(failed.stdout);
      const diffReport = JSON.parse(withDiff.stdout);
      assert(report.compatibility.length);
      assert.equal(Object.hasOwn(report, 'diffs'), false);
      assert(diffReport.diffs.length);
      assert.deepEqual(diffReport.compatibility, report.compatibility);
      assert.deepEqual(diffReport.changes, report.changes);
    }
  }
  // An uncertain lifecycle change fails the review threshold but not breaking.
  delete f.doc.components.schemas.Value.properties.label;
  f.cfg.operations.one.deprecated = 'Use the replacement operation.';
  f.load();
  assert.equal(cli('--fail-on', 'review').status, 1);
  assert.equal(cli('--fail-on', 'breaking').status, 0);
  const bad = cli('--fail-on', 'typo');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /--fail-on must be/);
  delete f.cfg.operations.one;
  delete f.doc.paths['/one'];
  f.load();
  assert.equal(cli('--fail-on', 'breaking').status, 1);
  assert.equal(cli('--fail-on', 'review').status, 1);
  assert.equal(readFileSync(join(f.output, '.sdk-generator.json'), 'utf8'), record);
});

test('baseline updates refuse edited output and existing locks without changing history', (t) => {
  const f = fixture(t, ['node']);
  generate(f.load(), f.output);
  const path = join(f.output, '.sdk-generator.json');
  const original = readFileSync(path, 'utf8');
  const lock = f.output + '.sdk-generator.lock';
  writeFileSync(lock, 'synthetic lock');
  assert.throws(() => setCompatibilityBaseline(f.output, 'released'), /another generation/);
  assert.equal(readFileSync(path, 'utf8'), original);
  rmSync(lock);
  writeFileSync(join(f.output, 'node/index.js'), '// edited');
  assert.throws(() => setCompatibilityBaseline(f.output, 'draft'), /generated file was edited/);
  assert.equal(readFileSync(path, 'utf8'), original);
  assert.equal(existsSync(lock), false);
});

test('released baseline compiled records are validated without rewriting corrupt history', (t) => {
  const f = fixture(t, ['node']);
  generate(f.load(), f.output);
  setCompatibilityBaseline(f.output, 'released');
  const path = join(f.output, '.sdk-generator.json');
  const record = JSON.parse(readFileSync(path));
  record.baseline.compiled = structuredClone(restoreCompiledSnapshot(record.baseline.compiled));
  record.baseline.compiled.plan.format = 99;
  writeFileSync(path, JSON.stringify(record));
  const original = readFileSync(path, 'utf8');
  assert.throws(() => preview(f.load(), f.output), /Unsupported compiled contract format/);
  assert.equal(readFileSync(path, 'utf8'), original);
});

test('explicitly open response models allow optional additions while required fields and operation inputs still break', (t) => {
  const f = fixture(t);
  const model = f.doc.components.schemas.Value;
  model.additionalProperties = true;
  const before = f.load();
  model.properties.label = { type: 'string' };
  assert(!compare(before, f.load()).some((c) => c.severity === 'breaking'));
  model.required.push('label');
  assert(
    compare(before, f.load()).some(
      (c) => c.severity === 'breaking' && c.subject === 'models.Value.input.label',
    ),
  );
  assert(
    compareSchemas(
      { type: 'object' },
      { type: 'object', properties: { label: { type: 'string' } } },
      'request',
      'input',
    ).some((c) => c.severity === 'breaking'),
  );
});
