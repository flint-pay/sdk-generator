<?php
declare(strict_types=1);
require $argv[1] . '/src/Runtime.php';
putenv('EXAMPLE_WORKLOAD_IDENTITY_ID=wid_synthetic_http');
putenv('EXAMPLE_OIDC_TOKEN=' . $argv[3]);
$cache = new class {
    public array $values = [];
    public int $gets = 0;
    public int $sets = 0;
    public int $deletes = 0;
    public function get(string $key, mixed $default = null): mixed
    {
        $this->gets++;
        return $this->values[$key] ?? $default;
    }
    public function set(string $key, mixed $value, mixed $ttl = null): bool
    {
        $this->sets++;
        $this->values[$key] = $value;
        return true;
    }
    public function delete(string $key): bool
    {
        $this->deletes++;
        unset($this->values[$key]);
        return true;
    }
};
for ($i = 0; $i < 100; $i++) {
    $client = new Example\Discovery\Client(
        new Example\Discovery\ClientOptions(
            baseUrl: $argv[2],
            allowInsecureHttp: true,
            credentialCache: $cache,
        ),
    );
    $client->api->read();
    $client->close();
}
if ($cache->sets !== 2 || $cache->deletes !== 1) {
    throw new RuntimeException('PSR-16 cache not updated on exchange and 401');
}
echo 'ok';
