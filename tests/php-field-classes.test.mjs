import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { loadContract, generate, render, validateFixtures } from '../dist/index.js';
import { compileSdkContract } from '../dist/target-plan.js';
import { phpRepresentations } from '../dist/php-representation.js';
import { compareCompiledContracts } from '../dist/compiled-compatibility.js';
import { restoreCompiledSnapshot } from '../dist/compiled-record.js';

const root = mkdtempSync(join(tmpdir(), 'sdk-php-field-classes-'));
after(() => rmSync(root, { recursive: true, force: true }));
const ref = (name, metadata = {}) => ({ $ref: '#/components/schemas/' + name, ...metadata });
const location = { type: 'object', required: ['id'], properties: { id: { type: 'string' } } };
const content = (schema) => ({ 'application/json': { schema } });
const settings = {
  version: '1.0.0',
  responses: { return: 'result' },
  requests: { style: 'object' },
  validation: 'schema',
  npm: { name: 'field-classes-sdk' },
  composer: { name: 'field-classes/sdk', namespace: 'FieldClasses\\Sdk' },
};
function fixture(
  fields = { location: ref('Location', { description: 'Mailing location' }) },
  pins,
  options = {},
) {
  const directory = mkdtempSync(join(root, 'case-'));
  const envelope = { type: 'object', required: ['data'], properties: { data: ref('Venue') } };
  const api = {
    openapi: '3.1.1',
    info: { title: 'Field classes', version: '1' },
    components: {
      schemas: {
        Location: structuredClone(location),
        Place: structuredClone(location),
        Venue: { type: 'object', required: Object.keys(fields), properties: fields },
        ...options.schemas,
      },
    },
    paths: {
      '/venues': {
        post: {
          operationId: 'sendValue',
          requestBody: {
            required: true,
            content: content({
              ...envelope,
              properties: {
                ...envelope.properties,
                catalog: ref('Place'),
                legacy: ref('Location'),
              },
            }),
          },
          responses: { 200: { description: 'Venue', content: content(envelope) } },
        },
      },
    },
    ...options.api,
  };
  const config = {
    ...settings,
    ...(pins === undefined ? {} : { phpFieldClasses: pins }),
    ...options.config,
  };
  const write = (file, value) => {
    mkdirSync(join(directory, file, '..'), { recursive: true });
    writeFileSync(join(directory, file), JSON.stringify(value));
  };
  write('api.json', api);
  write('sdk.json', config);
  for (const [file, value] of Object.entries(options.files ?? {})) write(file, value);
  return {
    directory,
    output: join(directory, 'output'),
    api,
    config,
    load: (opts) => loadContract(join(directory, 'api.json'), join(directory, 'sdk.json'), opts),
  };
}
function php(f, code, ...args) {
  const result = spawnSync(
    'php',
    [
      '-r',
      'declare(strict_types=1); require $argv[1]."/src/Client.php";' + code,
      join(f.output, 'php'),
      ...args,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.error?.message ?? result.stdout + result.stderr);
  return result.stdout;
}
function diagnostic(action, path, message) {
  assert.throws(action, (error) => {
    assert.equal(error.name, 'Diagnostic');
    assert.equal(error.location, path);
    if (message) assert.equal(error.detail, message);
    return true;
  });
}
const selected = (f) => compileSdkContract(f.load()).plan;
const pinPath = 'config/phpFieldClasses/Venue/location';
function phpstan(f, source) {
  const consumer = join(f.directory, 'consumer.php'),
    config = join(f.directory, 'phpstan.neon');
  writeFileSync(consumer, '<?php\n' + source);
  writeFileSync(
    config,
    `parameters:\n    level: max\n    phpVersion: 80200\n    tmpDir: ${JSON.stringify(join(f.directory, 'cache'))}\n    scanDirectories:\n        - ${JSON.stringify(join(f.output, 'php/src'))}\n`,
  );
  return spawnSync(
    'php',
    [
      resolve('.generated/phpstan-vendor/bin/phpstan'),
      'analyse',
      '--no-progress',
      '--error-format=raw',
      '-c',
      config,
      consumer,
    ],
    { encoding: 'utf8' },
  );
}

// Expected names below are independent consumer contracts, not refreshed snapshots.
test('PHP field pins retain exact concrete classes, isolate other refs, and leave Node and docs unchanged', async () => {
  const fields = {
    location: ref('Location', { description: 'Mailing location' }),
    other: ref('Location'),
    newlyDescribed: ref('Location', { description: 'New description' }),
  };
  const unpinned = fixture(fields),
    pinned = fixture(fields, { Venue: { location: 'Location' } });
  const before = render(unpinned.load()),
    after = render(pinned.load());
  assert.match(before.get('php/src/classes/Venue.php'), /getLocation\(\): Place/);
  assert.match(
    after.get('php/src/classes/Venue.php'),
    /@return Location[\s\S]*getLocation\(\): Location/,
  );
  assert.match(after.get('php/src/classes/Venue.php'), /getOther\(\): Place/);
  assert.match(after.get('php/src/classes/Venue.php'), /getNewlyDescribed\(\): Place/);
  assert.deepEqual(
    [...before].filter(([file]) => file.startsWith('node/')),
    [...after].filter(([file]) => file.startsWith('node/')),
  );
  for (const file of ['php/MODELS.md', 'php/src/schema-definitions.json'])
    assert.equal(after.get(file), before.get(file));
  generate(pinned.load(), pinned.output);
  const data = {
    data: { location: { id: 'pinned' }, other: { id: 'plain' }, newlyDescribed: { id: 'new' } },
  };
  const cases = [
    {
      name: 'pinned PHP identity does not change HTTP',
      operation: 'sendValue',
      input: { body: data },
      expected: { method: 'POST', path: '/v1/venues', body: JSON.stringify(data) },
      responses: [{ status: 200, body: JSON.stringify(data) }],
      data,
    },
  ];
  const file = join(pinned.directory, 'cases.json');
  writeFileSync(file, JSON.stringify(cases));
  assert.deepEqual(
    (await validateFixtures(pinned.output, file)).map((value) => value.scenarios),
    [1, 1],
  );
  assert.equal(
    php(
      pinned,
      String.raw`
    function oldConsumer(FieldClasses\Sdk\Location $value): string { return $value->getId(); }
    function catalogConsumer(FieldClasses\Sdk\Place $value): string { return $value->getId(); }
    $client=new FieldClasses\Sdk\Client(new FieldClasses\Sdk\ClientOptions('https://example.invalid', transport: fn() => ['status'=>200,'body'=>$argv[2],'headers'=>[]]));
    $venue=$client->api->sendValue(['body'=>json_decode($argv[2])])->data->getData();
    if(oldConsumer($venue->getLocation())!=='pinned'||catalogConsumer($venue->getOther())!=='plain'||catalogConsumer($venue->getNewlyDescribed())!=='new')exit(2);
    if(get_class($venue->getLocation())!==FieldClasses\Sdk\Location::class||get_class($venue->getOther())!==FieldClasses\Sdk\Place::class)exit(3);
    try { catalogConsumer($venue->getLocation()); exit(4); } catch(TypeError) {}
    try { oldConsumer($venue->getOther()); exit(5); } catch(TypeError) {}
    if(is_subclass_of(FieldClasses\Sdk\Location::class,FieldClasses\Sdk\Place::class)||is_subclass_of(FieldClasses\Sdk\Place::class,FieldClasses\Sdk\Location::class))exit(6);
    if($venue->get('location')->getId()!=='pinned'||$venue->location->getId()!=='pinned')exit(7);
    echo 'distinct public classes';
  `,
      JSON.stringify(data),
    ),
    'distinct public classes',
  );
  const { Client } = await import(pathToFileURL(join(pinned.output, 'node/index.js')).href);
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        (
          await new Client({
            baseUrl: 'https://example.invalid',
            transport: async () => new Response(JSON.stringify(data)),
          }).api.sendValue({ body: data })
        ).data,
      ),
    ),
    data,
  );
});

test('pin-before-build emits the historical unused class only, with fresh autoload and exact constructor descriptor', () => {
  const f = fixture(undefined, { Venue: { location: 'Location' } });
  const plan = selected(f);
  assert.ok(plan.php.models.some((value) => value.name === 'Location'));
  assert.ok(!plan.php.models.some((value) => value.name === 'Place'));
  generate(f.load(), f.output);
  assert.ok(existsSync(join(f.output, 'php/src/classes/Location.php')));
  assert.ok(!existsSync(join(f.output, 'php/src/classes/Place.php')));
  const fallback = fixture({ location: { ...location, description: 'Inline legacy lookup' } });
  const legacy = render(fallback.load());
  assert.equal(
    readFileSync(join(f.output, 'php/src/classes/Location.php'), 'utf8'),
    legacy.get('php/src/classes/Location.php'),
  );
  assert.equal(
    php(
      f,
      String.raw`
    if(!class_exists('fieldclasses\\sdk\\LOCATION'))exit(2);
    if(class_exists(FieldClasses\Sdk\Place::class))exit(3);
    $location=new FieldClasses\Sdk\Location((object)['id'=>'fresh']);
    $venue=new FieldClasses\Sdk\Venue((object)['location'=>(object)['id'=>'nested']]);
    if(get_class($venue->getLocation())!==FieldClasses\Sdk\Location::class||$location->getId()!=='fresh')exit(4);
    echo 'deferred constructors';
  `,
    ),
    'deferred constructors',
  );
  const install = spawnSync('composer', ['install', '--no-interaction', '--no-progress'], {
    cwd: join(f.output, 'php'),
    encoding: 'utf8',
  });
  assert.equal(install.status, 0, install.stdout + install.stderr);
  const autoload = spawnSync(
    'php',
    [
      '-r',
      String.raw`
    require $argv[1].'/vendor/autoload.php';
    if(!class_exists(FieldClasses\Sdk\Location::class)||class_exists(FieldClasses\Sdk\Place::class))exit(2);
    if(!class_exists('fieldclasses\\sdk\\LOCATION'))exit(3);
    if((new FieldClasses\Sdk\Location((object)['id'=>'composer']))->getId()!=='composer')exit(4);
  `,
      join(f.output, 'php'),
    ],
    { encoding: 'utf8' },
  );
  assert.equal(autoload.status, 0, autoload.stdout + autoload.stderr);
  const record = JSON.parse(readFileSync(join(f.output, '.sdk-generator.json'), 'utf8'));
  const restored = restoreCompiledSnapshot(record.compiled);
  assert.equal(record.interface.config.phpFieldClasses.Venue.location, 'Location');
  assert.equal(
    restored.plan.php.models.find((value) => value.name === 'Venue').representation.fields.location
      .name,
    'Location',
  );
});

test('PHPStan understands pinned and catalog classes and diagnoses a strict wrong-class consumer', () => {
  const f = fixture(
    { location: ref('Location', { description: 'Pinned' }), other: ref('Location') },
    { Venue: { location: 'Location' } },
  );
  generate(f.load(), f.output);
  const checked = phpstan(
    f,
    String.raw`
use FieldClasses\Sdk\Venue;
use FieldClasses\Sdk\Location;
use FieldClasses\Sdk\Place;
use FieldClasses\Sdk\PlaceInput;
use FieldClasses\Sdk\VenueInput;
function historical(Venue $venue): Location { return $venue->getLocation(); }
function catalog(Venue $venue): Place { return $venue->getOther(); }
/** @return PlaceInput|array<array-key, mixed>|\stdClass */
function inputValue(VenueInput $venue): array|object { return $venue->getLocation(); }
`,
  );
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  const wrong = phpstan(
    f,
    String.raw`
function wrong(\FieldClasses\Sdk\Venue $venue): \FieldClasses\Sdk\Place { return $venue->getLocation(); }
`,
  );
  assert.notEqual(wrong.status, 0);
  assert.match(
    wrong.stdout + wrong.stderr,
    /should return FieldClasses\\Sdk\\Place but returns FieldClasses\\Sdk\\Location/,
  );
});

test('response field pins leave readOnly fields out of inputs and retain sensitive inspection and error redaction', async () => {
  const f = fixture(
    { location: ref('Location', { readOnly: true, 'x-sensitive': true }) },
    { Venue: { location: 'Location' } },
    { config: { errors: { detailsPath: 'details' } } },
  );
  f.api.paths['/venues'].post.responses[400] = {
    description: 'Error',
    content: content({ type: 'object', properties: { details: ref('Venue') } }),
  };
  writeFileSync(join(f.directory, 'api.json'), JSON.stringify(f.api));
  const files = render(f.load());
  assert.match(files.get('php/src/classes/Venue.php'), /getLocation\(\): Location/);
  assert.doesNotMatch(files.get('php/src/classes/VenueInput.php'), /getLocation/);
  generate(f.load(), f.output);
  php(
    f,
    String.raw`
    $venue=new FieldClasses\Sdk\Venue(json_decode('{"location":{"id":"synthetic-private-marker"}}'));
    ob_start();var_dump($venue);$debug=ob_get_clean();
    if(str_contains($debug,'synthetic-private-marker'))throw new Exception('sensitive pinned field leaked through inspection');
    $client=new FieldClasses\Sdk\Client(new FieldClasses\Sdk\ClientOptions('https://example.invalid', transport: fn() => ['status'=>400,'body'=>'{"details":{"location":{"id":"synthetic-private-marker"}}}','headers'=>[]]));
    try { $client->api->sendValue(['body'=>['data'=>new stdClass()]]);exit(3); } catch(FieldClasses\Sdk\SdkError $error) {
      if(str_contains(json_encode($error->details),'synthetic-private-marker'))throw new Exception('sensitive pinned field leaked through parsed error details');
    }
  `,
  );
  const { Client } = await import(pathToFileURL(join(f.output, 'node/index.js')).href);
  const client = new Client({
    baseUrl: 'https://example.invalid',
    transport: async () =>
      new Response('{"details":{"location":{"id":"synthetic-private-marker"}}}', { status: 400 }),
  });
  await assert.rejects(client.api.sendValue({ body: { data: {} } }), (error) => {
    assert.ok(!JSON.stringify(error.details).includes('synthetic-private-marker'));
    return true;
  });
});

test('PHP field pins unwrap simple nullable references and preserve null hydration', () => {
  for (const nullable of [
    { anyOf: [ref('Location', { description: 'Optional location' }), { type: 'null' }] },
    { oneOf: [ref('Location'), { type: 'null' }] },
  ]) {
    const f = fixture({ location: nullable }, { Venue: { location: 'Location' } });
    generate(f.load(), f.output);
    assert.match(
      readFileSync(join(f.output, 'php/src/classes/Venue.php'), 'utf8'),
      /getLocation\(\): Location\|null/,
    );
    php(
      f,
      String.raw`
      $venue=new FieldClasses\Sdk\Venue((object)['location'=>(object)['id'=>'nullable']]);
      if(get_class($venue->getLocation())!==FieldClasses\Sdk\Location::class)exit(2);
      if((new FieldClasses\Sdk\Venue((object)['location'=>null]))->getLocation()!==null)exit(3);
    `,
    );
  }
  const nullableLocation = { ...location, type: ['object', 'null'] };
  const f = fixture(
    undefined,
    { Venue: { location: 'Location' } },
    {
      schemas: { Location: nullableLocation, Place: nullableLocation },
    },
  );
  generate(f.load(), f.output);
  php(
    f,
    String.raw`
    $present=new FieldClasses\Sdk\Venue((object)['location'=>(object)['id'=>'typed']]);
    if(get_class($present->getLocation())!==FieldClasses\Sdk\Location::class)exit(2);
    if((new FieldClasses\Sdk\Venue((object)['location'=>null]))->getLocation()!==null)exit(3);
  `,
  );
});

test('recursive pins retain reference docs and hydrate self and mutual recursion without class aliases', () => {
  const tree = {
    ...location,
    properties: {
      ...location.properties,
      child: ref('Place', { description: 'Recursive child' }),
      peer: ref('Peer'),
    },
  };
  const f = fixture(
    undefined,
    { Venue: { location: 'Location' }, Location: { child: 'Location' } },
    {
      schemas: {
        Location: tree,
        Place: tree,
        Peer: {
          type: 'object',
          properties: { parent: ref('Location', { description: 'Mutual parent' }) },
        },
      },
    },
  );
  const c = f.load();
  assert.equal(c.definitions.Location.properties.child['x-sdk-ref'], 'Place');
  assert.match(render(c).get('php/MODELS.md'), /\[Place\]\(MODELS.md#place\).*Recursive child/);
  generate(c, f.output);
  php(
    f,
    String.raw`
    $venue=new FieldClasses\Sdk\Venue(json_decode('{"location":{"id":"root","child":{"id":"child","child":{"id":"leaf"}},"peer":{"parent":{"id":"mutual"}}}}'));
    $tree=$venue->getLocation();
    foreach([$tree,$tree->getChild(),$tree->getChild()->getChild()] as $value)if(get_class($value)!==FieldClasses\Sdk\Location::class)exit(2);
    if(get_class($tree->getPeer()->getParent())!==FieldClasses\Sdk\Place::class)exit(3);
  `,
  );
  const mutual = fixture(
    undefined,
    {
      Venue: { location: 'Location' },
      Location: { child: 'Location' },
      Peer: { parent: 'Location' },
    },
    {
      schemas: {
        Location: tree,
        Place: tree,
        Peer: { type: 'object', properties: { parent: ref('Location') } },
      },
    },
  );
  generate(mutual.load(), mutual.output);
  php(
    mutual,
    String.raw`
    $venue=new FieldClasses\Sdk\Venue(json_decode('{"location":{"id":"root","peer":{"parent":{"id":"mutual","child":{"id":"leaf"}}}}}'));
    $parent=$venue->getLocation()->getPeer()->getParent();
    if(get_class($parent)!==FieldClasses\Sdk\Location::class||get_class($parent->getChild())!==FieldClasses\Sdk\Location::class)exit(2);
  `,
  );
});

test('field pins are independent of class build order, configured public mappings and repeated rendering', () => {
  const schema = { 'x-sdk-ref': 'Place' },
    defs = { Location: location, Place: location };
  const make = (early) => {
    const representations = phpRepresentations(defs, defs, { Venue: { location: 'Location' } });
    if (early) representations.compile({ 'x-sdk-ref': 'Location' }, 'Earlier');
    representations.model('Venue', { type: 'object', properties: { location: schema } });
    if (!early) representations.compile({ 'x-sdk-ref': 'Location' }, 'Later');
    representations.checkFieldClasses();
    return [...representations.entities].sort(([a], [b]) => a.localeCompare(b));
  };
  assert.deepEqual(make(true), make(false));
  const f = fixture(
    undefined,
    { Venue: { location: 'LegacyLocation' } },
    { config: { models: { Location: 'LegacyLocation' } } },
  );
  const c = f.load(),
    snapshot = JSON.stringify(c);
  assert.deepEqual([...render(c)], [...render(c)]);
  assert.equal(JSON.stringify(c), snapshot);
  generate(c, f.output);
  assert.match(
    readFileSync(join(f.output, 'php/src/classes/Venue.php'), 'utf8'),
    /getLocation\(\): LegacyLocation/,
  );
  const first = readFileSync(join(f.output, 'php/src/classes/LegacyLocation.php'), 'utf8');
  generate(c, f.output);
  assert.equal(readFileSync(join(f.output, 'php/src/classes/LegacyLocation.php'), 'utf8'), first);
});

test('load-time field pin syntax errors use exact paths and aggregate independent invalid settings', () => {
  for (const value of [null, [], 1, 'Location'])
    diagnostic(
      () => fixture(undefined, value).load(),
      'config/phpFieldClasses',
      'expected an object',
    );
  for (const value of [null, [], 1, 'Location'])
    diagnostic(
      () => fixture(undefined, { Venue: value }).load(),
      'config/phpFieldClasses/Venue',
      'expected an object',
    );
  for (const value of [null, 7, {}, 'FieldClasses\\Sdk\\Location', '\\Location', 'class'])
    diagnostic(
      () => fixture(undefined, { Venue: { location: value } }).load(),
      pinPath,
      'choose an identifier that is not a JavaScript/PHP reserved word or SDK runtime member',
    );
  diagnostic(
    () => fixture(undefined, {}, { config: { targets: ['node'] } }).load(),
    'config/phpFieldClasses',
    'requires the php target',
  );
  const f = fixture(undefined, { Broken: [], Venue: { location: 7, other: 'class' } });
  assert.throws(
    () => f.load({ collectDiagnostics: true }),
    (error) => {
      assert.deepEqual(
        error.findings.map((value) => value.location),
        ['config/phpFieldClasses/Broken', pinPath, 'config/phpFieldClasses/Venue/other'],
      );
      return true;
    },
  );
});

test('stale pin owners and absent or writeOnly fields fail after response entities are built', () => {
  for (const owner of ['Missing', 'VenueInput', 'venue', 'FieldClasses\\Sdk\\Venue']) {
    const f = fixture(undefined, { [owner]: { location: 'Location' } });
    diagnostic(
      () => selected(f),
      'config/phpFieldClasses/' + owner,
      `stale PHP field class customization: ${owner} is not a generated PHP response class`,
    );
  }
  const missing = fixture(undefined, { Venue: { missing: 'Location' } });
  diagnostic(
    () => selected(missing),
    'config/phpFieldClasses/Venue/missing',
    'stale PHP field class customization: Venue has no response field missing',
  );
  const diagnosed = spawnSync(
    process.execPath,
    [
      resolve('dist/cli.js'),
      'diagnose',
      join(missing.directory, 'api.json'),
      join(missing.directory, 'sdk.json'),
    ],
    { encoding: 'utf8' },
  );
  assert.equal(diagnosed.status, 1);
  assert.equal(
    JSON.parse(diagnosed.stderr).diagnostics[0].location,
    'config/phpFieldClasses/Venue/missing',
  );
  const hidden = fixture(
    { location: ref('Location', { writeOnly: true }) },
    { Venue: { location: 'Location' } },
  );
  diagnostic(
    () => selected(hidden),
    pinPath,
    'stale PHP field class customization: Venue has no response field location',
  );
});

test('non-entity fields and missing public model pin targets fail without default hydration fallbacks', () => {
  const shapes = [
    { type: 'string' },
    { type: ['string', 'null'] },
    { type: 'array', items: ref('Location') },
    { type: 'object', additionalProperties: ref('Location') },
    { anyOf: [ref('Location'), { type: 'string' }] },
    {
      oneOf: [
        {
          ...location,
          properties: { ...location.properties, kind: { const: 'a', type: 'string' } },
          required: ['id', 'kind'],
        },
        {
          ...location,
          properties: { ...location.properties, kind: { const: 'b', type: 'string' } },
          required: ['id', 'kind'],
        },
      ],
      discriminator: { propertyName: 'kind' },
    },
  ];
  for (const value of shapes)
    diagnostic(
      () => selected(fixture({ location: value }, { Venue: { location: 'Location' } })),
      pinPath,
      'Venue.location is not a single PHP response entity',
    );
  diagnostic(
    () => selected(fixture(undefined, { Venue: { location: 'Missing' } })),
    pinPath,
    'Missing is not a generated PHP model',
  );
  for (const name of ['location', 'hasOwnProperty'])
    diagnostic(
      () => selected(fixture(undefined, { Venue: { location: name } })),
      pinPath,
      name + ' is not a generated PHP model',
    );
});

test('pin equivalence rejects nested constraints, directions, sensitivity, property and conjunction differences', () => {
  const changes = [
    { ...location, properties: { id: { type: 'string', maxLength: 2 } } },
    { ...location, properties: { id: { type: 'string', readOnly: true } } },
    { ...location, 'x-sensitive': true },
    { ...location, properties: { ...location.properties, extra: { type: 'string' } } },
    { ...location, properties: { id: { type: 'string', enum: ['only'] } } },
    {
      type: 'object',
      properties: {
        child: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      },
    },
  ];
  for (const model of changes) {
    const f = fixture(
      undefined,
      { Venue: { location: 'Location' } },
      { schemas: { Location: model } },
    );
    // Use Place as the default; differing Location is the requested pin.
    f.api.components.schemas.Venue.properties.location = ref('Place', {
      description: 'Default location',
    });
    writeFileSync(join(f.directory, 'api.json'), JSON.stringify(f.api));
    diagnostic(() => selected(f), pinPath, 'Location is not structurally identical to Place');
  }
  const narrowed = fixture(
    { location: ref('Location', { required: ['extra'] }) },
    { Venue: { location: 'Location' } },
  );
  diagnostic(
    () => selected(narrowed),
    pinPath,
    'Location is not structurally identical to VenueLocation',
  );
  const unique = fixture(
    { location: { ...location, additionalProperties: false } },
    { Venue: { location: 'Location' } },
  );
  diagnostic(
    () => selected(unique),
    pinPath,
    'Location is not structurally identical to VenueLocation',
  );
  for (const metadata of [{ readOnly: true }, { writeOnly: true }, { 'x-sensitive': true }]) {
    const f = fixture(
      { location: ref('Place') },
      { Venue: { location: 'Location' } },
      {
        schemas: {
          Location: { type: 'object', properties: { child: ref('Leaf', metadata) } },
          Place: { type: 'object', properties: { child: ref('Leaf') } },
          Leaf: location,
        },
      },
    );
    diagnostic(() => selected(f), pinPath, 'Location is not structurally identical to Place');
  }
  const nested = fixture(
    { location: ref('Place') },
    { Venue: { location: 'Location' } },
    {
      schemas: {
        Location: { type: 'object', properties: { child: { ...location, required: [] } } },
        Place: { type: 'object', properties: { child: location } },
      },
    },
  );
  diagnostic(() => selected(nested), pinPath, 'Location is not structurally identical to Place');
});

test('matching profile pins merge, conflicting pins diagnose the exact field path, and a default-class pin is allowed', () => {
  const matching = fixture(undefined, undefined, {
    config: { profiles: ['first.json', 'second.json'] },
    files: {
      'first.json': { phpFieldClasses: { Venue: { location: 'Place' } } },
      'second.json': { phpFieldClasses: { Venue: { location: 'Place' } } },
    },
  });
  assert.equal(
    selected(matching).php.models.find((value) => value.name === 'Venue').representation.fields
      .location.name,
    'Place',
  );
  const conflicting = fixture(undefined, undefined, {
    config: { profiles: ['first.json', 'second.json'] },
    files: {
      'first.json': { phpFieldClasses: { Venue: { location: 'Place' } } },
      'second.json': { phpFieldClasses: { Venue: { location: 'Location' } } },
    },
  });
  diagnostic(() => conflicting.load(), pinPath, 'conflicting SDK profile settings');
});

test('signed webhook root pins are consumed before stale checks and operation-root pins keep their separate owners', () => {
  const event = {
    type: 'object',
    required: ['type', 'location'],
    properties: {
      type: { type: 'string', const: 'venue.created' },
      location: ref('Location', { description: 'Event location' }),
    },
  };
  const f = fixture(
    undefined,
    { WebhookEventVenueCreated: { location: 'Location' } },
    {
      api: {
        webhooks: { 'venue.created': { post: { requestBody: { content: content(event) } } } },
      },
      config: {
        webhook: {
          algorithm: 'hmac-sha256',
          format: 'timestamped-hex',
          header: 'X-Signature',
          separator: '.',
          toleranceSeconds: 300,
          typeField: 'type',
          events: {},
        },
      },
    },
  );
  generate(f.load(), f.output);
  const raw = '{"type":"venue.created","location":{"id":"signed"}}',
    timestamp = 1700000000,
    secret = 'synthetic-signing-key';
  const headers = {
    'X-Signature': `t=${timestamp},v1=${createHmac('sha256', secret)
      .update(timestamp + '.' + raw)
      .digest('hex')}`,
  };
  php(
    f,
    String.raw`
    $client=new FieldClasses\Sdk\Client(new FieldClasses\Sdk\ClientOptions('https://example.invalid'));
    $verified=$client->verifyWebhook($argv[2],json_decode($argv[3],true),[$argv[4]],(int)$argv[5]);
    if(!$verified['known']||get_class($verified['event'])!==FieldClasses\Sdk\WebhookEventVenueCreated::class)exit(2);
    if(get_class($verified['event']->getLocation())!==FieldClasses\Sdk\Location::class)exit(3);
  `,
    raw,
    JSON.stringify(headers),
    secret,
    String(timestamp),
  );
  const rootPin = fixture(undefined, { ApiSendValueResponse200: { data: 'Venue' } });
  assert.equal(
    selected(rootPin).php.models.find((value) => value.name === 'ApiSendValueResponse200')
      .representation.fields.data.name,
    'Venue',
  );
  const variants = fixture(undefined, {
    ApiSendValueResponse200Variant0: { location: 'Location' },
  });
  const branch = (tag) => ({
    type: 'object',
    required: ['kind', 'location'],
    properties: { kind: { type: 'string', const: tag }, location: ref('Location') },
  });
  variants.api.paths['/venues'].post.responses[200].content = content({
    oneOf: [branch('first'), branch('second')],
    discriminator: { propertyName: 'kind' },
  });
  writeFileSync(join(variants.directory, 'api.json'), JSON.stringify(variants.api));
  generate(variants.load(), variants.output);
  php(
    variants,
    String.raw`
    $first=new FieldClasses\Sdk\ApiSendValueResponse200Variant0((object)['kind'=>'first','location'=>(object)['id'=>'pinned']]);
    $second=new FieldClasses\Sdk\ApiSendValueResponse200Variant1((object)['kind'=>'second','location'=>(object)['id'=>'default']]);
    if(get_class($first->getLocation())!==FieldClasses\Sdk\Location::class||get_class($second->getLocation())!==FieldClasses\Sdk\Place::class)exit(2);
  `,
  );
});

test('existing compiled compatibility facts detect an unpinned nominal break and accept the configured unchanged contract', () => {
  const legacy = fixture({ location: { ...location, description: 'Historical inlining' } });
  const current = fixture(),
    pinned = fixture(undefined, { Venue: { location: 'Location' } });
  const previous = selected(legacy),
    next = selected(current),
    corrected = selected(pinned);
  assert.ok(
    compareCompiledContracts(previous, next).some(
      (value) =>
        value.severity === 'breaking' &&
        value.subject === 'models.Venue' &&
        value.message.includes('representation changed'),
    ),
  );
  assert.ok(
    compareCompiledContracts(previous, next).some(
      (value) =>
        value.severity === 'breaking' &&
        value.subject === 'models.Location' &&
        value.message.includes('class removed'),
    ),
  );
  assert.deepEqual(
    compareCompiledContracts(previous, corrected).filter(
      (value) =>
        value.severity === 'breaking' &&
        (value.message.includes('representation') || value.message.includes('class removed')),
    ),
    [],
  );
});
