import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { loadContract, render, generate } from '../dist/index.js';

const keys = ['__proto__', 'constructor', 'hasOwnProperty', 'toString', 'ordinary'];
const entry = (key, value) => Object.fromEntries([[key, value]]);
const ref = (name) => ({ $ref: '#/components/schemas/' + name });
const content = (schema) => ({ 'application/json': { schema } });
const settings = {
  version: '1.0.0',
  requests: { style: 'object' },
  responses: { return: 'result' },
  npm: { name: 'profile-merge-sdk' },
  composer: { name: 'profile-merge/sdk', namespace: 'ProfileMerge' },
};
const shape = { type: 'object', properties: { id: { type: 'string' } } };
const api = {
  openapi: '3.1.1',
  info: { title: 'Profile merge', version: '1' },
  components: {
    schemas: {
      Location: shape,
      Place: shape,
      Owner: {
        type: 'object',
        properties: Object.fromEntries([...keys, 'other'].map((key) => [key, ref('Place')])),
      },
      ...Object.fromEntries(keys.map((key) => [key, { type: 'string' }])),
    },
  },
  paths: {
    '/record': {
      post: {
        operationId: 'sendRecord',
        requestBody: {
          content: content({
            type: 'object',
            properties: { legacy: ref('Location') },
            additionalProperties: true,
          }),
        },
        responses: {
          200: {
            description: 'OK',
            content: content({ type: 'object', properties: { data: ref('Owner') } }),
          },
        },
      },
    },
  },
};
function fixture(t, first, second, flat) {
  const directory = mkdtempSync(join(tmpdir(), 'sdk-profile-merge-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const files = {
    'api.json': api,
    'first.json': first,
    'second.json': second,
    'nested.json': { profiles: ['first.json', 'second.json'] },
    'sdk.json': { ...settings, profiles: ['nested.json'] },
    'flat.json': { ...settings, ...flat },
  };
  for (const [file, value] of Object.entries(files))
    writeFileSync(join(directory, file), JSON.stringify(value));
  const before = Object.fromEntries(
    Object.keys(files).map((file) => [file, readFileSync(join(directory, file), 'utf8')]),
  );
  return {
    output: join(directory, 'output'),
    load: (file = 'sdk.json') => loadContract(join(directory, 'api.json'), join(directory, file)),
    unchanged: () => {
      for (const [file, value] of Object.entries(before))
        assert.equal(readFileSync(join(directory, file), 'utf8'), value);
      assert.deepEqual(
        Object.fromEntries(
          Object.entries(files).map(([file, value]) => [file, JSON.stringify(value)]),
        ),
        before,
      );
    },
  };
}
function ownData(object, key, value) {
  assert.equal(Object.getPrototypeOf(object), Object.prototype);
  assert.deepEqual(Object.getOwnPropertyDescriptor(object, key), {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}
function conflict(action, location) {
  assert.throws(action, (error) => {
    assert.equal(error.name, 'Diagnostic');
    assert.equal(error.location, location);
    assert.equal(error.detail, 'conflicting SDK profile settings');
    return true;
  });
}

for (const key of keys) {
  test(`disjoint and matching profile field pins preserve literal ${key} and flat rendering`, (t) => {
    const special = entry(key, 'Location');
    for (const [first, second, expectedOrder] of [
      [{ other: 'Place' }, special, ['other', key]],
      [special, { other: 'Place' }, [key, 'other']],
      [{ other: 'Place', ...special }, special, ['other', key]],
    ]) {
      const pins = { ...first, ...second };
      const f = fixture(
        t,
        { phpFieldClasses: { Owner: first } },
        { phpFieldClasses: { Owner: second } },
        { phpFieldClasses: { Owner: pins } },
      );
      const contract = f.load();
      const originalConfig = structuredClone(contract.config);
      ownData(contract.config.phpFieldClasses.Owner, key, 'Location');
      assert.equal(Object.getPrototypeOf(contract.config.phpFieldClasses), Object.prototype);
      assert.deepEqual(Object.keys(contract.config.phpFieldClasses.Owner), expectedOrder);
      const output = render(contract);
      assert.match(output.get('php/src/classes/Owner.php'), /getOther\(\): Place/);
      const getter = key === '__proto__' ? 'Proto' : key[0].toUpperCase() + key.slice(1);
      assert.match(
        output.get('php/src/classes/Owner.php'),
        new RegExp(`get${getter}\\(\\): Location`),
      );
      assert.deepEqual(output, render(f.load('flat.json')));
      assert.deepEqual(output, render(f.load()));
      assert.deepEqual(contract.config, originalConfig);
      f.unchanged();
    }
  });

  test(`conflicting profile field pin ${key} retains its exact diagnostic`, (t) => {
    const f = fixture(
      t,
      { phpFieldClasses: { Owner: entry(key, 'Place') } },
      { phpFieldClasses: { Owner: entry(key, 'Location') } },
      {},
    );
    conflict(() => f.load(), 'config/phpFieldClasses/Owner/' + key);
    f.unchanged();
  });

  test(`other profile dictionaries and nested object values preserve ${key}`, (t) => {
    const nested = entry(key, { before: 'first' });
    const addition = entry(key, { after: 'second', ...entry(key, { literal: true }) });
    const expected = entry(key, {
      before: 'first',
      after: 'second',
      ...entry(key, { literal: true }),
    });
    const model = entry(key, 'MappedValue');
    const f = fixture(
      t,
      {
        models: { Location: 'Location' },
        operations: { sendRecord: { example: { body: nested } } },
      },
      { models: model, operations: { sendRecord: { example: { body: addition } } } },
      {
        models: { Location: 'Location', ...model },
        operations: { sendRecord: { example: { body: expected } } },
      },
    );
    const contract = f.load();
    ownData(contract.config.models, key, 'MappedValue');
    const value = contract.config.operations.sendRecord.example.body;
    ownData(value, key, expected[key]);
    ownData(value[key], key, { literal: true });
    assert.deepEqual(Object.keys(value[key]), ['before', 'after', key]);
    assert.deepEqual(render(contract), render(f.load('flat.json')));
    assert.deepEqual(render(contract), render(f.load()));
    f.unchanged();

    const conflicting = fixture(
      t,
      { operations: { sendRecord: { example: entry(key, entry(key, 'first')) } } },
      { operations: { sendRecord: { example: entry(key, entry(key, 'second')) } } },
      {},
    );
    conflict(() => conflicting.load(), `config/operations/sendRecord/example/${key}/${key}`);
    conflicting.unchanged();
  });
}

test('composed prototype-named pins hydrate literal fields in both generated clients', async (t) => {
  const prototypeBefore = Object.getOwnPropertyDescriptors(Object.prototype);
  const pins = Object.fromEntries(keys.map((key) => [key, 'Location']));
  const f = fixture(
    t,
    { phpFieldClasses: { Owner: { other: 'Place' } } },
    { phpFieldClasses: { Owner: pins } },
    { phpFieldClasses: { Owner: { other: 'Place', ...pins } } },
  );
  const contract = f.load();
  generate(contract, f.output);
  const fields = Object.fromEntries([...keys, 'other'].map((key) => [key, { id: key }]));
  const body = JSON.stringify({ data: fields });
  const { Client } = await import(pathToFileURL(join(f.output, 'node/index.js')).href);
  const result = await new Client({
    baseUrl: 'https://example.invalid',
    transport: async (url, options) => {
      assert.equal(String(url), 'https://example.invalid/record');
      assert.deepEqual(JSON.parse(options.body), { legacy: { id: 'input' } });
      return new Response(body);
    },
  }).api.sendRecord({ body: { legacy: { id: 'input' } } });
  assert.deepEqual(JSON.parse(JSON.stringify(result.data.data)), fields);
  for (const key of keys) assert.ok(Object.hasOwn(result.data.data, key));
  const php = spawnSync(
    'php',
    [
      '-r',
      String.raw`
      declare(strict_types=1);
      require $argv[1].'/src/Client.php';
      $client = new ProfileMerge\Client(new ProfileMerge\ClientOptions('https://example.invalid', transport: function($request) use ($argv) {
        if($request['url']!=='https://example.invalid/record'||$request['body']!=='{"legacy":{"id":"input"}}')exit(2);
        return ['status'=>200,'body'=>$argv[2],'headers'=>[]];
      }));
      $owner=$client->api->sendRecord(['body'=>['legacy'=>['id'=>'input']]])->data->getData();
      foreach(['__proto__'=>'getProto','constructor'=>'getConstructor','hasOwnProperty'=>'getHasOwnProperty','toString'=>'getToString','ordinary'=>'getOrdinary'] as $key=>$getter) {
        if(get_class($owner->$getter())!==ProfileMerge\Location::class||$owner->$getter()->getId()!==$key)exit(3);
      }
      if(get_class($owner->getOther())!==ProfileMerge\Place::class||$owner->getOther()->getId()!=='other')exit(4);
      echo 'literal fields hydrated';`,
      join(f.output, 'php'),
      body,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(php.status, 0, php.error?.message ?? php.stdout + php.stderr);
  assert.equal(php.stdout, 'literal fields hydrated');
  assert.deepEqual(Object.getOwnPropertyDescriptors(Object.prototype), prototypeBefore);
  f.unchanged();
});
