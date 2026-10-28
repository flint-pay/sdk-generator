<?php
// Exercise optional integrations against real PSR interfaces, with synthetic HTTP responses.
require $input['autoload'];
$cache = new class implements Psr\SimpleCache\CacheInterface {
    public array $values = [];
    public array $ttls = [];
    public function get(string $key, mixed $default = null): mixed
    {
        if (strlen($key) > 64) {
            throw new InvalidArgumentException('Cache key exceeds PSR-16 portability limit');
        }
        return $this->values[$key] ?? $default;
    }
    public function set(string $key, mixed $value, null|int|DateInterval $ttl = null): bool
    {
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
$sets = (new ReflectionClass(Example\Jwt\Runtime::class))->getProperty('webhookKeySets');
$rows = [];
$rows[] = Webhooks::verifyDelivery($input['body'], $headers, $options)['signing_method'] === 'jwt';
$rows[] = $http->requests === 1;
$rows[] = in_array(86400, $cache->ttls, true) && in_array(60, $cache->ttls, true);
// A new worker can restore the public set from PSR-16 without HTTP.
$sets->setValue(null, []);
$rows[] =
    Webhooks::verifyDelivery($input['body'], $headers, $options)['known'] && $http->requests === 1;
// The recorded refresh throttle also survives a worker restart.
foreach ($cache->values as $key => &$entry) {
    if (is_array($entry) && isset($entry['keys'])) {
        $entry['keys'] = [];
    }
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
echo json_encode($rows, JSON_THROW_ON_ERROR);
