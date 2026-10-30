<?php
declare(strict_types=1);
require $argv[1] . '/src/autoload.php';
use Example\Presence\{Client, ClientOptions, RequestOptions, Errors\ConfigurationError};

function check(bool $condition, string $name): void
{
    if (!$condition) {
        throw new \RuntimeException($name);
    }
}
function supplied(array $c): array
{
    $value = $c['value'] === 'undefined' ? null : $c['value'];
    return match ($c['key']) {
        'credentials.service.Bearer' => [
            'credentials' =>
                $c['level'] === 'client'
                    ? ['service' => ['Bearer' => $value]]
                    : ['Bearer' => $value],
        ],
        'credentials.service' => ['credentials' => ['service' => $value]],
        default => [$c['key'] => $value],
    };
}
foreach (json_decode(file_get_contents($argv[2]), true, flags: JSON_THROW_ON_ERROR) as $c) {
    putenv('FLINT_API_KEY=synthetic-platform');
    putenv('FLINT_ACCESS_TOKEN');
    if ($c['accessToken'] ?? false) {
        putenv('FLINT_API_KEY');
        putenv('FLINT_ACCESS_TOKEN=synthetic-access');
    }
    $seen = [];
    $args = [
        'transport' => static function ($request) use (&$seen): array {
            $seen[] = $request['headers']['authorization'] ?? null;
            return ['status' => 204, 'headers' => [], 'body' => ''];
        },
    ];
    if (array_key_exists('disabled', $c)) {
        $args['ambientCredentials'] = !$c['disabled'];
    }
    if (($c['level'] ?? '') === 'request' || isset($c['override'])) {
        $args['apiKey'] = 'synthetic-client';
    }
    if (($c['level'] ?? '') === 'client') {
        $args += supplied($c);
    }
    if ($c['otherMode'] ?? false) {
        $args['credentials'] = ['other' => ['Bearer' => 'synthetic-other']];
    }
    $error = null;
    $phase = 'construction';
    try {
        // transport/ambientCredentials come before apiKey in this named argument array.
        $client = new Client(new ClientOptions(...$args));
        $phase = 'request';
        $request =
            ($c['level'] ?? '') === 'request'
                ? supplied($c)
                : match ($c['override'] ?? '') {
                    'shortcut' => ['checkoutToken' => 'synthetic-tenant'],
                    'map' => ['credentials' => ['Bearer' => 'synthetic-tenant']],
                    'empty-map' => ['credentials' => []],
                    default => [],
                };
        // deadlineMs follows the shortcut parameters in a different position.
        $client->api->read([], new RequestOptions(...['deadlineMs' => 30000] + $request));
    } catch (\Throwable $e) {
        $error = $e;
    }
    $name = $c['name'];
    check($seen === (isset($c['header']) ? [$c['header']] : []), $name . ' transport');
    if (isset($c['level']) || ($c['missing'] ?? false)) {
        check(
            $error instanceof ConfigurationError,
            $name . ' class: ' . ($error?->getMessage() ?? 'no error'),
        );
        check($error->outcome === 'not_sent', $name . ' outcome');
        if (isset($c['level'])) {
            check($error->attempts === 0, $name . ' attempts');
            check(
                $phase === ($c['level'] === 'client' ? 'construction' : 'request'),
                $name . ' phase',
            );
            check(
                $error->code === 'credential_missing' && $error->param === $c['param'],
                $name . ' code/param',
            );
            check(
                !preg_match(
                    '/synthetic-platform|synthetic-client|FLINT_API_KEY/',
                    $error->getMessage(),
                ),
                $name . ' secret',
            );
        } else {
            check($error->code === '', $name . ' existing missing error');
        }
    } else {
        check($error === null, $name . ': ' . ($error?->getMessage() ?? ''));
    }
}
echo 'ok';
