<?php
declare(strict_types=1);
require $argv[1] . '/src/Runtime.php';
require $argv[1] . '/src/Client.php';

use Example\Credentials\{
    Client,
    ClientOptions,
    RequestOptions,
    CredentialProvider,
    Credential,
    SdkError,
};

function same(mixed $actual, mixed $expected, string $name): void
{
    if ($actual !== $expected) {
        throw new RuntimeException($name . ': ' . json_encode([$actual, $expected]));
    }
}
class Provider implements CredentialProvider
{
    public int $calls = 0;
    public int $invalidations = 0;
    public function __construct(public array $scenario) {}
    public function value(): mixed
    {
        $this->calls++;
        if ($this->scenario['failure'] ?? false) {
            throw new RuntimeException('test-token-private');
        }
        return $this->scenario['value'] ?? 'test-token-' . $this->calls;
    }
    public function getCredential(): Credential
    {
        return new Credential($this->value(), new DateTimeImmutable('2100-01-01'));
    }
}
final class RefreshingProvider extends Provider
{
    public function invalidate(): void
    {
        $this->invalidations++;
        if ($this->scenario['invalidateFailure'] ?? false) {
            throw new RuntimeException('test-token-private');
        }
    }
}
$cases = json_decode(file_get_contents($argv[2]), true, flags: JSON_THROW_ON_ERROR);
$surface = $argv[3];
$defaultBaseUrl = $argv[4] ?? null;
foreach (['provider', 'closureString', 'closureCredential'] as $form) {
    foreach ($cases as $c) {
        if ($form !== 'provider' && $c['invalidations'] > 0) {
            continue;
        }
        $provider = $c['invalidate'] ?? true ? new RefreshingProvider($c) : new Provider($c);
        $credential = match ($form) {
            'provider' => $provider,
            'closureString' => fn() => $provider->value(),
            'closureCredential' => fn() => $provider->getCredential(),
        };
        if (($c['kind'] ?? null) === 'string') {
            $credential = $c['value'] ?? 'test-token';
        }
        $seen = $keys = $events = [];
        $clientOptions = [
            'baseUrl' => $defaultBaseUrl ?? 'https://example.invalid',
            'diagnostics' => function ($event) use (&$events) {
                $events[] = $event;
            },
            'transport' => function ($request) use (&$seen, &$keys, $c) {
                $seen[] = isset($request['headers']['authorization'])
                    ? preg_replace('/^Bearer /', '', $request['headers']['authorization'])
                    : null;
                $keys[] = $request['headers']['idempotency-key'] ?? null;
                $status =
                    $c['statuses'][count($seen) - 1] ??
                    throw new RuntimeException('Unexpected attempt');
                if ($status === 0) {
                    throw new RuntimeException('synthetic connection failure');
                }
                return [
                    'status' => $status,
                    'headers' => [],
                    'body' => '',
                    'failureCode' => in_array(count($seen) - 1, $c['bodyFailures'] ?? [], true)
                        ? 18
                        : null,
                ];
            },
        ];
        if ($defaultBaseUrl !== null) {
            unset($clientOptions['transport']);
            $clientOptions['allowInsecureHttp'] = true;
        }
        $options = isset($c['maxAttempts']) ? ['maxAttempts' => $c['maxAttempts']] : [];
        switch ($surface) {
            case 'token':
                $clientOptions['token'] = $credential;
                break;
            case 'clientShortcut':
                $clientOptions['apiKey'] = $credential;
                break;
            case 'requestShortcut':
                $options['apiKey'] = $credential;
                break;
            case 'clientMap':
                $clientOptions['authMode'] = 'service';
                $clientOptions['credentials'] = ['service' => ['Bearer' => $credential]];
                break;
            case 'requestMap':
                $options['authMode'] = 'service';
                $options['credentials'] = ['Bearer' => $credential];
                break;
        }
        if (($c['operation'] ?? null) === 'anonymous') {
            unset($options['apiKey'], $options['authMode'], $options['credentials']);
        }
        $clientSettings = new ClientOptions(...$clientOptions);
        $client = new Client($clientSettings);
        same($provider->calls, 0, 'construction resolves no credentials');
        $error = null;
        $op = $c['operation'] ?? 'keyed';
        if ($op === 'keyed') {
            $options['idempotencyKey'] = 'synthetic-key';
        }
        $requestSettings = new RequestOptions(...$options);
        for ($i = 0; $i < ($c['requests'] ?? 1); $i++) {
            try {
                $result = $client->api->$op(options: $requestSettings->withDeadline(30000));
                same(
                    $result->meta['attempts'],
                    isset($c['requests']) ? 1 : count($c['headers']),
                    $c['name'],
                );
            } catch (SdkError $e) {
                $error = $e;
                break;
            }
        }
        same(
            $error !== null ? substr(strrchr(get_class($error), chr(92)), 1) : null,
            $surface === 'token' ? $c['legacyError'] ?? ($c['error'] ?? null) : $c['error'] ?? null,
            $c['name'],
        );
        if (isset($c['bodyFailures']) && $error !== null) {
            same($error->status, 401, $c['name']);
            same($error->outcome, 'response', $c['name']);
        }
        if (isset($c['message'])) {
            same($error->getMessage(), $c['message'], $c['name']);
        }
        if (isset($c['error'])) {
            same($error->retryAllowed, false, $c['name']);
        }
        if ($defaultBaseUrl === null) {
            same($seen, $c['headers'], $c['name']);
        }
        same($provider->calls, $c['calls'], $c['name']);
        same($provider->invalidations, $c['invalidations'], $c['name']);
        if ($op === 'keyed') {
            foreach ($keys as $key) {
                same($key, 'synthetic-key', 'key preserved');
            }
        }
        if ($op === 'auto') {
            same((bool) preg_match('/^[0-9a-f-]{36}$/D', $keys[0]), true, 'auto key');
            same(count(array_unique($keys)), 1, 'auto key preserved');
        }
        ob_start();
        var_dump(
            $clientSettings,
            $requestSettings,
            $client,
            $error,
            $events,
            new Credential('test-token-private'),
        );
        $debug = ob_get_clean();
        same(
            str_contains($debug . json_encode([$error, $events]), 'test-token'),
            false,
            'debug redaction',
        );
        same($error?->getPrevious(), null, 'no provider cause retained');
        $client->close();
    }
}
echo 'ok';
