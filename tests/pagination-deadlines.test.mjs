import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { generate, loadContract } from '../dist/index.js';

const root = mkdtempSync(join(tmpdir(), 'sdk-pagination-deadlines-'));
after(() => rmSync(root, { recursive: true, force: true }));
const fixture = resolve('tests/fixtures/pagination-deadlines.json');
const cases = JSON.parse(readFileSync(fixture, 'utf8'));
const out = join(root, 'sdk');
generate(loadContract('tests/fixtures/payment-api.json', 'tests/fixtures/payment-sdk.json'), out);
const { Client } = await import(pathToFileURL(join(out, 'node/index.js')).href);

// Advance monotonic clocks instead of waiting thirty seconds or relying on
// scheduling. Both generated clients receive the same independently authored cases.
for (const scenario of cases) {
  for (const helper of ['Pages', 'Items']) {
    test(`Node ${helper}: ${scenario.name}`, async (t) => {
      let now = 0;
      t.mock.method(performance, 'now', () => now);
      let calls = 0;
      const pages = scenario.pages ?? 3;
      const client = new Client({
        baseUrl: 'https://example.invalid',
        token: 'test',
        ...scenario.client,
        transport: async (url) => {
          assert.equal(url.pathname, '/payments');
          assert.equal(url.searchParams.get('cursor'), calls ? `cursor-${calls}` : null);
          calls++;
          now += scenario.pageMs;
          return Response.json({
            items: [{ id: `p-${calls}`, amount: 1, status: 'pending' }],
            next: calls < pages ? `cursor-${calls}` : null,
          });
        },
      });
      const iterator = client.payments[`listAll${helper}`]({}, scenario.request ?? {});
      assert.equal(calls, 0, 'iterator must stay lazy');
      const seen = [];
      const consume = async () => {
        for await (const value of iterator) {
          seen.push(helper === 'Pages' ? value.data.items[0].id : value.id);
          now += scenario.consumerMs;
        }
      };
      if (scenario.error) {
        await assert.rejects(consume, { kind: scenario.error });
        assert.equal(calls, 1);
        assert.deepEqual(seen, []);
      } else {
        await consume();
        assert.equal(calls, pages);
        assert.deepEqual(
          seen,
          Array.from({ length: pages }, (_, i) => `p-${i + 1}`),
        );
      }
    });
  }
}

test('PHP page and item deadlines follow the shared cases', () => {
  const script = join(root, 'pagination.php');
  writeFileSync(
    script,
    String.raw`<?php
namespace Example\Payments {
    function hrtime(bool $asNumber = false): int { return $GLOBALS['clockMs'] * 1000000; }
}
namespace {
require $argv[1].'/src/Runtime.php';
require $argv[1].'/src/Client.php';
function check(bool $condition, string $message): void {
    if (!$condition) throw new \Exception($message);
}
foreach (json_decode(file_get_contents($argv[2]), true) as $case) {
    foreach (['Pages', 'Items'] as $helper) {
        $GLOBALS['clockMs'] = 0;
        $calls = 0;
        $pages = $case['pages'] ?? 3;
        $settings = $case['client'] ?? [];
        $settings['transport'] = function($request) use (&$calls, $pages, $case) {
            check(parse_url($request['url'], PHP_URL_PATH) === '/payments', 'path');
            parse_str(parse_url($request['url'], PHP_URL_QUERY) ?? '', $query);
            check(($query['cursor'] ?? null) === ($calls ? 'cursor-'.$calls : null), 'cursor');
            $calls++;
            $GLOBALS['clockMs'] += $case['pageMs'];
            return ['status'=>200, 'headers'=>[], 'body'=>json_encode([
                'items'=>[['id'=>'p-'.$calls, 'amount'=>1, 'status'=>'pending']],
                'next'=>$calls < $pages ? 'cursor-'.$calls : null,
            ])];
        };
        $client = new \Example\Payments\Client(new \Example\Payments\ClientOptions(
            ...array_merge(['baseUrl'=>'https://example.invalid', 'token'=>'test'], $settings)
        ));
        $options = new \Example\Payments\RequestOptions(...($case['request'] ?? []));
        $iterator = $client->payments->{'listAll'.$helper}(options:$options);
        check($calls === 0, 'lazy iterator');
        $seen = [];
        $error = null;
        try {
            foreach ($iterator as $value) {
                $data = json_decode(json_encode($helper === 'Pages' ? $value->data : $value), true);
                $seen[] = $helper === 'Pages' ? $data['items'][0]['id'] : $data['id'];
                $GLOBALS['clockMs'] += $case['consumerMs'];
            }
        } catch (\Example\Payments\SdkError $e) { $error = $e->kind; }
        check($error === ($case['error'] ?? null), $case['name'].' '.$helper.': unexpected error '.($error ?? 'none'));
        if ($error !== null) {
            check($calls === 1 && $seen === [], 'slow page must fail before yielding');
        } else {
            check($calls === $pages, 'page count');
            check($seen === array_map(fn($i) => 'p-'.$i, range(1, $pages)), 'items');
        }
        $client->close();
    }
}
}
`,
  );
  const result = spawnSync('php', [script, join(out, 'php'), fixture], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
