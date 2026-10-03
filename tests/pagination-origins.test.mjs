import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { generate, loadContract } from '../dist/index.js';

const root = mkdtempSync(join(tmpdir(), 'sdk-pagination-origins-'));
after(() => rmSync(root, { recursive: true, force: true }));
const api = {
  openapi: '3.1.0',
  info: { title: 'Pagination origins', version: '1' },
  paths: {
    '/records': {
      get: {
        operationId: 'listRecords',
        responses: {
          200: {
            description: 'Page',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['items', 'next'],
                  properties: {
                    items: { type: 'array', items: { type: 'string' } },
                    next: { type: ['string', 'null'] },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};
const config = {
  version: '1.0.0',
  responses: { return: 'result' },
  npm: { name: '@example/pagination-origins' },
  composer: { name: 'example/pagination-origins', namespace: 'Example\\PaginationOrigins' },
  operations: {
    listRecords: { pagination: { kind: 'link', items: 'items', next: 'next' } },
  },
};
writeFileSync(join(root, 'api.json'), JSON.stringify(api));
writeFileSync(join(root, 'sdk.json'), JSON.stringify(config));
const out = join(root, 'generated');
generate(loadContract(join(root, 'api.json'), join(root, 'sdk.json')), out);
const { Client } = await import(pathToFileURL(join(out, 'node/index.js')).href);

// These permissions are independently authored: URL scheme/host case and default
// ports do not change an origin, while different nondefault ports still do.
const cases = [
  {
    name: 'uppercase HTTPS base',
    baseUrl: 'HTTPS://example.invalid:443',
    next: 'https://example.invalid/records?page=2',
  },
  {
    name: 'mixed HTTPS base',
    baseUrl: 'HtTpS://example.invalid:443',
    next: 'https://example.invalid/records?page=2',
  },
  {
    name: 'uppercase HTTPS link',
    baseUrl: 'https://example.invalid',
    next: 'HTTPS://EXAMPLE.INVALID:443/records?page=2',
  },
  {
    name: 'lowercase HTTPS default port',
    baseUrl: 'https://example.invalid:443',
    next: 'https://example.invalid/records?page=2',
  },
  {
    name: 'HTTPS without a port',
    baseUrl: 'https://example.invalid',
    next: 'https://example.invalid/records?page=2',
  },
  {
    name: 'explicit canonical HTTPS allowed origin',
    baseUrl: 'HTTPS://example.invalid:443',
    allowedOrigins: ['https://example.invalid'],
    next: 'https://example.invalid/records?page=2',
  },
  {
    name: 'uppercase HTTP base',
    baseUrl: 'HTTP://example.invalid:80',
    next: 'http://example.invalid/records?page=2',
  },
  {
    name: 'mixed HTTP base',
    baseUrl: 'hTtP://example.invalid:80',
    next: 'http://example.invalid/records?page=2',
  },
  {
    name: 'uppercase HTTP link',
    baseUrl: 'http://example.invalid',
    next: 'HTTP://EXAMPLE.INVALID:80/records?page=2',
  },
  {
    name: 'lowercase HTTP default port',
    baseUrl: 'http://example.invalid:80',
    next: 'http://example.invalid/records?page=2',
  },
  {
    name: 'HTTP without a port',
    baseUrl: 'http://example.invalid',
    next: 'http://example.invalid/records?page=2',
  },
  {
    name: 'explicit canonical HTTP allowed origin',
    baseUrl: 'HTTP://example.invalid:80',
    allowedOrigins: ['http://example.invalid'],
    next: 'http://example.invalid/records?page=2',
  },
  {
    name: 'same nondefault HTTPS port',
    baseUrl: 'HtTpS://example.invalid:8443',
    next: 'https://example.invalid:8443/records?page=2',
  },
  {
    name: 'same nondefault HTTP port',
    baseUrl: 'hTtP://example.invalid:8080',
    next: 'http://example.invalid:8080/records?page=2',
  },
  {
    name: 'HTTPS nondefault port rejected',
    baseUrl: 'HTTPS://example.invalid:443',
    next: 'https://example.invalid:8443/records?page=2',
    error: 'destination',
  },
  {
    name: 'HTTP nondefault port rejected',
    baseUrl: 'HTTP://example.invalid:80',
    next: 'http://example.invalid:8080/records?page=2',
    error: 'destination',
  },
  {
    name: 'HTTPS default port is not a nondefault origin',
    baseUrl: 'HTTPS://example.invalid:8443',
    next: 'https://example.invalid/records?page=2',
    error: 'destination',
  },
  {
    name: 'HTTP default port is not a nondefault origin',
    baseUrl: 'HTTP://example.invalid:8080',
    next: 'http://example.invalid/records?page=2',
    error: 'destination',
  },
];

test('Node link pagination compares canonical origins and retains nondefault port restrictions', async () => {
  for (const row of cases) {
    let sent = 0;
    const seen = [];
    const client = new Client({
      baseUrl: row.baseUrl,
      allowedOrigins: row.allowedOrigins,
      allowInsecureHttp: true,
      transport: async (url) => {
        assert.equal(url.pathname, '/records', row.name);
        assert.equal(url.search, sent ? '?page=2' : '', row.name);
        sent++;
        return Response.json({
          items: [sent === 1 ? 'first' : 'second'],
          next: sent === 1 ? row.next : null,
        });
      },
    });
    const consume = async () => {
      for await (const page of client.api.listRecordsPages()) seen.push(...page.data.items);
    };
    if (row.error)
      await assert.rejects(consume, { kind: row.error, outcome: 'not_sent' }, row.name);
    else await consume();
    assert.equal(sent, row.error ? 1 : 2, row.name);
    assert.deepEqual(seen, row.error ? ['first'] : ['first', 'second'], row.name);
  }
});

test('PHP link pagination compares canonical origins and retains nondefault port restrictions', () => {
  const file = join(root, 'cases.json');
  writeFileSync(file, JSON.stringify(cases));
  const script = String.raw`
require $argv[1].'/src/Runtime.php';
require $argv[1].'/src/Client.php';
use Example\PaginationOrigins\{Client,ClientOptions,SdkError};
foreach(json_decode(file_get_contents($argv[2]),true) as $case) {
    $sent=0;
    $seen=[];
    $client=new Client(new ClientOptions(
        baseUrl:$case['baseUrl'],
        allowedOrigins:$case['allowedOrigins']??null,
        allowInsecureHttp:true,
        transport:function($request)use(&$sent,$case){
            if(parse_url($request['url'],PHP_URL_PATH)!=='/records' ||
               (parse_url($request['url'],PHP_URL_QUERY)??'')!==($sent?'page=2':'')) {
                throw new Exception('wrong page URL: '.$case['name']);
            }
            $sent++;
            return ['status'=>200,'headers'=>[],'body'=>json_encode([
                'items'=>[$sent===1?'first':'second'],
                'next'=>$sent===1?$case['next']:null,
            ])];
        },
    ));
    $error=null;
    try {
        foreach($client->api->listRecordsPages() as $page) {
            $data=json_decode(json_encode($page->data),true);
            $seen=array_merge($seen,$data['items']);
        }
    } catch(SdkError $e) {
        $error=$e->kind;
        if($e->outcome!=='not_sent')throw $e;
    }
    if($error!==($case['error']??null) ||
       $sent!==($error?1:2) ||
       $seen!==($error?['first']:['first','second'])) {
        throw new Exception('wrong origin behavior: '.$case['name']);
    }
    $client->close();
}
echo 'ok';`;
  assert.equal(
    execFileSync('php', ['-r', script, join(out, 'php'), file], { encoding: 'utf8' }),
    'ok',
  );
});
