import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { loadContract, generate } from '../dist/index.js';
const dir = mkdtempSync(join(tmpdir(), 'sdk-models-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const schemas = {
  Title: { type: 'string', minLength: 1 },
  Tags: { type: 'array', items: { type: 'string' } },
  Note: { type: ['object', 'null'], properties: { text: { type: 'string' } }, required: ['text'] },
  Payload: {
    type: 'object',
    properties: {
      title: { $ref: '#/components/schemas/Title' },
      tags: { $ref: '#/components/schemas/Tags' },
      note: { $ref: '#/components/schemas/Note' },
    },
    required: ['title', 'tags', 'note'],
  },
};
const doc = {
  openapi: '3.1.0',
  info: { title: 'Models', version: 'v1' },
  components: { schemas },
  paths: {
    '/values': {
      post: {
        operationId: 'save',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Payload' } } },
        },
        responses: { 204: { description: 'empty' } },
      },
    },
  },
};
const cfg = {
  validation: 'schema',
  version: '1.0.0',
  npm: { name: '@example/models' },
  composer: { name: 'example/models', namespace: 'Example\\Models' },
};
writeFileSync(join(dir, 'api.json'), JSON.stringify(doc));
writeFileSync(join(dir, 'sdk.json'), JSON.stringify(cfg));
const out = join(dir, 'output');
generate(loadContract(join(dir, 'api.json'), join(dir, 'sdk.json')), out);
const sdk = await import(pathToFileURL(join(out, 'node/index.js')).href);
test('scalar, array, nullable and nested model factories serialize through both public clients', async () => {
  const payload = sdk.makePayload({
    title: sdk.makeTitle('hello'),
    tags: sdk.makeTags(['one']),
    note: sdk.makeNote(null),
  });
  assert.deepEqual(JSON.parse(JSON.stringify(payload.toJSON())), {
    title: 'hello',
    tags: ['one'],
    note: null,
  });
  let wire;
  const client = new sdk.Client({
    baseUrl: 'https://example.invalid',
    transport: async (_url, init) => {
      wire = init.body;
      return new Response(null, { status: 204 });
    },
  });
  await client.api.save({ body: payload });
  assert.equal(wire, '{"title":"hello","tags":["one"],"note":null}');
  const php = String.raw`require $argv[1].'/src/Runtime.php';require $argv[1].'/src/Client.php';$title=new Example\Models\TitleInput('hello');$tags=new Example\Models\TagsInput(['one']);$note=new Example\Models\NoteInput(null);$p=new Example\Models\PayloadInput(['title'=>$title,'tags'=>$tags,'note'=>$note]);$client=new Example\Models\Client(new Example\Models\ClientOptions('https://example.invalid',transport:function($r){echo $r['body'];return ['status'=>204,'headers'=>[],'body'=>''];}));$client->api->save(new Example\Models\ApiSaveInput(['body'=>$p]));if($tags->jsonSerialize()!==['one']||$note->jsonSerialize()!==null)exit(2);try{new Example\Models\TitleInput('');exit(3);}catch(Example\Models\SdkError $e){if($e->kind!=='validation')exit(4);}`;
  const r = spawnSync('php', ['-r', php, join(out, 'php')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, wire);
});
test('TypeScript factory inputs accept nested models without weakening field requirements', () => {
  const path = join(out, 'node/consumer.ts');
  writeFileSync(
    path,
    `import {Client,makePayload,makeTitle,makeTags,makeNote} from './index.js';
 const c=new Client({baseUrl:'https://example.invalid'});
 c.api.save({body:makePayload({title:makeTitle('hello'),tags:makeTags(['one']),note:makeNote(null)})});
 c.api.save({body:{title:makeTitle('hello'),tags:['one'],note:{text:'note'}}});
 // @ts-expect-error missing required title
 makePayload({tags:[],note:null});
 // @ts-expect-error arrays contain strings
 makeTags([1]);
 // @ts-expect-error non-null notes require text
 makeNote({});
 `,
  );
  const r = spawnSync(
    process.execPath,
    [
      resolve('node_modules/typescript/bin/tsc'),
      '--strict',
      '--noEmit',
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--typeRoots',
      resolve('node_modules/@types'),
      path,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
test('cyclic opaque additional values fail before either client sends a request', async () => {
  const body = { title: 'hello', tags: [], note: null };
  const extra = [];
  extra.push(extra);
  body.extra = extra;
  let calls = 0;
  const c = new sdk.Client({
    baseUrl: 'https://example.invalid',
    transport: async () => {
      calls++;
      throw Error('sent');
    },
  });
  await assert.rejects(c.api.save({ body }), (e) => e.kind === 'validation');
  assert.equal(calls, 0);
  const php = String.raw`require $argv[1].'/src/Runtime.php';require $argv[1].'/src/Client.php';$extra=[];$extra[]=&$extra;$client=new Example\Models\Client(new Example\Models\ClientOptions('https://example.invalid',transport:function(){exit(2);}));try{$client->api->save(new Example\Models\ApiSaveInput(['body'=>['title'=>'hello','tags'=>[],'note'=>null,'extra'=>$extra]]));exit(3);}catch(Example\Models\SdkError $e){echo $e->kind;}`;
  const r = spawnSync('php', ['-r', php, join(out, 'php')], { encoding: 'utf8', timeout: 5000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'validation');
});
