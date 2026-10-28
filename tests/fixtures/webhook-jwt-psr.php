<?php
// Exercise optional integrations against real PSR interfaces, with synthetic HTTP responses.
require $input['autoload'];
$cache = new class implements Psr\SimpleCache\CacheInterface {
    public array $values = [];
    public array $ttls = [];
    public bool $brokenSet = false;
    public function get(string $key, mixed $default = null): mixed
    {
        if (strlen($key) > 64) {
            throw new InvalidArgumentException('Cache key exceeds PSR-16 portability limit');
        }
        return $this->values[$key] ?? $default;
    }
    public function set(string $key, mixed $value, null|int|DateInterval $ttl = null): bool
    {
        if ($this->brokenSet) {
            throw new TypeError('Synthetic programming error in a cache');
        }
        if (strlen($key) > 64) {
            throw new InvalidArgumentException('Cache key exceeds PSR-16 portability limit');
        }
        $this->values[$key] = $value;
        $this->ttls[$key] = $ttl;
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
        foreach ($keys as $key) {
            yield $key => $this->get($key, $default);
        }
    }
    public function setMultiple(iterable $values, null|int|DateInterval $ttl = null): bool
    {
        foreach ($values as $key => $value) {
            $this->set($key, $value, $ttl);
        }
        return true;
    }
    public function deleteMultiple(iterable $keys): bool
    {
        foreach ($keys as $key) {
            $this->delete($key);
        }
        return true;
    }
    public function has(string $key): bool
    {
        return array_key_exists($key, $this->values);
    }
};
$http = new class ($input) implements Psr\Http\Client\ClientInterface {
    public int $requests = 0;
    public function __construct(private array $input) {}
    public function sendRequest(
        Psr\Http\Message\RequestInterface $request,
    ): Psr\Http\Message\ResponseInterface {
        $this->requests++;
        if (
            (string) $request->getUri() !== $this->input['issuer'] . '/.well-known/jwks.json' ||
            $request->hasHeader('Authorization')
        ) {
            throw new RuntimeException('Incorrect trusted JWKS request');
        }
        return new Nyholm\Psr7\Response(
            200,
            ['Cache-Control' => 'max-age=900'],
            json_encode($this->input['jwks']),
        );
    }
};
$options = [
    'endpoint_ids' => 'whep_fixture',
    'base_url' => $input['issuer'],
    'now_seconds' => $input['now'],
    'cache' => $cache,
    'http_client' => $http,
    'request_factory' => new Nyholm\Psr7\Factory\Psr17Factory(),
];
$headers = ['authorization' => $input['authorization']];
$sets = (new ReflectionClass(Example\Jwt\Runtime::class))->getProperty('webhookKeyStates');
$rows = [];
$rows[] = Webhooks::verifyDelivery($input['body'], $headers, $options)['signing_method'] === 'jwt';
$rows[] = $http->requests === 1;
// One 64-character key holds the document and refresh times; the PSR-16 cache is a trust store.
$rows[] =
    array_values($cache->ttls) === [86400] &&
    strlen(array_key_first($cache->values)) === 64 &&
    is_string(reset($cache->values)['jwks']) &&
    !isset(reset($cache->values)['keys']);
// A new worker can restore the public set from PSR-16 without HTTP.
$sets->setValue(null, []);
$rows[] =
    Webhooks::verifyDelivery($input['body'], $headers, $options)['known'] && $http->requests === 1;
// The recorded refresh throttle also survives a worker restart.
foreach ($cache->values as $key => &$entry) {
    $entry['jwks'] = '{"keys":[]}';
    $entry['fetchedAt'] += 1;
}
unset($entry);
$sets->setValue(null, []);
try {
    Webhooks::verifyDelivery($input['body'], $headers, $options);
    $rows[] = false;
} catch (SdkError $e) {
    $rows[] = $e->errorCode === 'webhook_unknown_key' && $http->requests === 1;
}
$withoutFactory = $options;
unset($withoutFactory['request_factory']);
try {
    Webhooks::verifyDelivery($input['body'], $headers, $withoutFactory);
    $rows[] = false;
} catch (SdkError $e) {
    $rows[] = $e->errorCode === 'webhook_invalid_input';
}
// Non-array cache values are ignored, and an Error from the cache clears the in-flight fetch.
$runtime = new ReflectionClass(Example\Jwt\Runtime::class);
$flights = $runtime->getProperty('webhookKeyFlights');
$key = hash('sha256', 'webhook-jwks:' . $input['issuer'] . '/.well-known/jwks.json');
$verify = static function () use ($input, $headers, $options): string {
    try {
        return Webhooks::verifyDelivery($input['body'], $headers, $options)['signing_method'];
    } catch (SdkError $e) {
        return $e->errorCode;
    }
};
$fetches = function (callable $call) use ($http): array {
    $before = $http->requests;
    return [$call(), $http->requests - $before];
};
$cache->values = [$key => new stdClass()];
$sets->setValue(null, []);
$rows[] = $fetches($verify) === ['jwt', 1];
$cache->values = [];
$cache->brokenSet = true;
$sets->setValue(null, []);
try {
    $verify();
    $rows[] = false;
} catch (TypeError) {
    $rows[] = $flights->getValue() === [];
}
$cache->brokenSet = false;
$sets->setValue(null, []);
$rows[] = $fetches($verify) === ['jwt', 1];
// Implausible shared times cannot pin a key set or block refreshes.
$now = microtime(true);
$empty = '{"keys":[]}';
$good = json_encode($input['jwks']);
foreach (
    [
        ['jwks' => $empty, 'fetchedAt' => $now + 3600, 'expiresAt' => $now + 4500],
        ['jwks' => $empty, 'fetchedAt' => $now, 'expiresAt' => $now + 10 * 86400],
        [
            'jwks' => $empty,
            'fetchedAt' => $now,
            'expiresAt' => $now + 900,
            'attempt' => $now + 3600,
        ],
        [
            'jwks' => $good,
            'fetchedAt' => $now - 901,
            'expiresAt' => $now - 1,
            'retryAfter' => $now + 3600,
        ],
    ]
    as $shared
) {
    $cache->values = [$key => $shared];
    $sets->setValue(null, []);
    $rows[] = $fetches($verify) === ['jwt', 1];
}
// A worker holding an older set does not overwrite a newer shared one, but shares its throttle.
$store = $runtime->getMethod('webhookStoreKeyState');
$cache->values = [$key => ['jwks' => $good, 'fetchedAt' => $now, 'expiresAt' => $now + 900]];
$store->invoke(null, $cache, $input['issuer'] . '/.well-known/jwks.json', [
    'jwks' => $empty,
    'fetchedAt' => $now - 100,
    'expiresAt' => $now + 800,
    'attempt' => $now,
]);
$rows[] =
    $cache->values[$key]['jwks'] === $good &&
    $cache->values[$key]['fetchedAt'] === $now &&
    $cache->values[$key]['attempt'] === $now;
echo json_encode($rows, JSON_THROW_ON_ERROR);
