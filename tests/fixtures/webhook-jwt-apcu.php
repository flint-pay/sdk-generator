<?php
// Without a PSR-16 cache, enabled APCu shares JWKS state between PHP-FPM workers. Workers are
// simulated by clearing the runtime's static state. When the extension is absent, global stubs
// stand in for it; the test runs PHP with apc.enable_cli=1 so a real extension is used if present.
$stubbed = !function_exists('apcu_fetch');
if ($stubbed) {
    $GLOBALS['apcu'] = ['enabled' => true, 'values' => [], 'ttls' => []];
    function apcu_enabled(): bool
    {
        return $GLOBALS['apcu']['enabled'];
    }
    function apcu_fetch($key, &$success = null): mixed
    {
        $success = array_key_exists($key, $GLOBALS['apcu']['values']);
        return $success ? $GLOBALS['apcu']['values'][$key] : false;
    }
    function apcu_store($key, $value = null, int $ttl = 0): bool
    {
        $GLOBALS['apcu']['values'][$key] = $value;
        $GLOBALS['apcu']['ttls'][$key] = $ttl;
        return true;
    }
} else {
    apcu_clear_cache();
}
$states = (new ReflectionClass(Example\Jwt\Runtime::class))->getProperty('webhookKeyStates');
$url = $input['issuer'] . '/.well-known/jwks.json';
$key = hash('sha256', 'webhook-jwks:' . $url);
$count = 0;
$failure = false;
$transport = function ($request) use (&$count, &$failure, $input) {
    $count++;
    if ($failure) {
        throw new RuntimeException('Synthetic outage');
    }
    return ['status' => 200, 'headers' => [], 'body' => json_encode($input['jwks'])];
};
$options = ['endpoint_ids' => 'whep_fixture', 'now_seconds' => $input['now']];
$headers = ['authorization' => $input['authorization']];
$verify = function (array $extra = []) use ($input, $headers, $options, $transport): string {
    $client = new Client(new ClientOptions(baseUrl: $input['issuer'], transport: $transport));
    try {
        return $client->verifyWebhookDelivery($input['body'], $headers, $options + $extra)[
            'signing_method'
        ];
    } catch (SdkError $e) {
        return $e->code;
    }
};
$newWorker = fn() => $states->setValue(null, []);
$shared = fn(array $changes) => apcu_store($key, array_merge(apcu_fetch($key), $changes), 86400);
$rows = [];
$rows[] = $verify() === 'jwt' && $count === 1;
$entry = apcu_fetch($key);
$rows[] = is_array($entry) && is_string($entry['jwks']) && !isset($entry['keys']);
// A new worker reuses the shared document without HTTP.
$newWorker();
$rows[] = $verify() === 'jwt' && $count === 1;
// The unknown-kid refresh limit is shared: a forged kid cannot make each worker refetch.
$shared(['jwks' => '{"keys":[]}', 'fetchedAt' => microtime(true)]);
$newWorker();
$rows[] = $verify() === 'webhook_unknown_key' && $count === 1;
// Stale-on-failure and its retry delay are shared too.
$shared(['jwks' => json_encode($input['jwks']), 'fetchedAt' => microtime(true) - 901]);
$shared(['expiresAt' => microtime(true) - 1, 'attempt' => microtime(true) - 61]);
$failure = true;
$newWorker();
$rows[] = $verify() === 'jwt' && $count === 2;
$newWorker();
$rows[] = $verify() === 'jwt' && $count === 2 && apcu_fetch($key)['retryAfter'] > microtime(true);
// A supplied PSR-16 cache takes precedence over APCu.
require $input['autoload'];
$cache = new class implements Psr\SimpleCache\CacheInterface {
    public array $values = [];
    public function get(string $key, mixed $default = null): mixed
    {
        return $this->values[$key] ?? $default;
    }
    public function set(string $key, mixed $value, null|int|DateInterval $ttl = null): bool
    {
        $this->values[$key] = $value;
        return true;
    }
    public function delete(string $key): bool
    {
        unset($this->values[$key]);
        return true;
    }
    public function clear(): bool
    {
        $this->values = [];
        return true;
    }
    public function getMultiple(iterable $keys, mixed $default = null): iterable
    {
        return [];
    }
    public function setMultiple(iterable $values, null|int|DateInterval $ttl = null): bool
    {
        return true;
    }
    public function deleteMultiple(iterable $keys): bool
    {
        return true;
    }
    public function has(string $key): bool
    {
        return isset($this->values[$key]);
    }
};
$failure = false;
$newWorker();
$before = apcu_fetch($key);
$rows[] = $verify(['cache' => $cache]) === 'jwt' && isset($cache->values[$key]) && $count === 3;
$rows[] = apcu_fetch($key) === $before;
// Disabled APCu falls back to the in-process cache.
if ($stubbed) {
    $GLOBALS['apcu']['enabled'] = false;
    $GLOBALS['apcu']['values'] = [];
    $newWorker();
    $count = 0;
    $rows[] = $verify() === 'jwt' && $count === 1 && $GLOBALS['apcu']['values'] === [];
    $rows[] = $verify() === 'jwt' && $count === 1;
}
echo json_encode($rows, JSON_THROW_ON_ERROR);
