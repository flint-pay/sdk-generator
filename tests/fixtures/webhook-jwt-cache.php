<?php
// Synthetic transport and reflection-controlled cache ages avoid sleeps and live services.
$runtime = new ReflectionClass(Example\Jwt\Runtime::class);
$states = $runtime->getProperty('webhookKeyStates');
$url = $input['issuer'] . '/.well-known/jwks.json';
$options = ['endpoint_ids' => 'whep_fixture', 'now_seconds' => $input['now']];
$headers = ['authorization' => $input['authorization']];
$count = 0;
$failure = false;
$keys = $input['jwks'];
$control = 'max-age=900';
$transport = function ($request) use (&$count, &$failure, &$keys, &$control, $url) {
    $count++;
    if (
        $request['url'] !== $url ||
        $request['timeoutMs'] !== 5000 ||
        $request['maxResponseBytes'] !== 256 * 1024 ||
        !array_key_exists('cancellation', $request) ||
        isset($request['headers']['authorization'])
    ) {
        throw new RuntimeException('Incorrect JWKS request');
    }
    if ($failure) {
        throw new RuntimeException('Synthetic outage');
    }
    return [
        'status' => 200,
        'headers' => $control === null ? [] : ['Cache-Control' => $control],
        'body' => json_encode($keys),
    ];
};
$client = new Client(new ClientOptions(baseUrl: $input['issuer'], transport: $transport));
$verify = fn() => $client->verifyWebhookDelivery($input['body'], $headers, $options);
$error = static function ($call, $code): bool {
    try {
        $call();
    } catch (SdkError $e) {
        return $e->errorCode === $code;
    }
    return false;
};
// Move the cached state's clock without sleeping.
$age = static function (array $changes) use ($states, $url): void {
    $state = $states->getValue()[$url];
    foreach ($changes as $name => $seconds) {
        $state[$name] = microtime(true) + $seconds;
    }
    $states->setValue(null, [$url => $state]);
};
$rows = [];
foreach ([['max-age=1', 300], ['max-age=99999999', 86400], [null, 900]] as [$directive, $ttl]) {
    $states->setValue(null, []);
    $control = $directive;
    $before = $count;
    $verify();
    $entry = $states->getValue()[$url];
    $rows[] = abs($entry['expiresAt'] - $entry['fetchedAt'] - $ttl) < 0.01;
    (new Client(
        new ClientOptions(baseUrl: $input['issuer'], transport: $transport),
    ))->verifyWebhookDelivery($input['body'], $headers, $options);
    $rows[] = $count === $before + 1;
    $age(['expiresAt' => -1]);
    $verify();
    $rows[] = $count === $before + 2;
}
// Single flight with independently scheduled PHP Fibers; waiters yield millisecond deadlines.
$states->setValue(null, []);
$before = $count;
$fiberTransport = function ($request) use ($transport) {
    Fiber::suspend('fetch');
    return $transport($request);
};
$fiberClient = new Client(new ClientOptions(baseUrl: $input['issuer'], transport: $fiberTransport));
$first = new Fiber(fn() => $fiberClient->verifyWebhookDelivery($input['body'], $headers, $options));
$second = new Fiber(
    fn() => $fiberClient->verifyWebhookDelivery($input['body'], $headers, $options),
);
$first->start();
$waiting = $second->start();
$remaining = ($waiting['deadline'] ?? 0) - hrtime(true) / 1e6;
$rows[] =
    is_array($waiting) &&
    array_key_exists('cancellation', $waiting) &&
    $remaining > 4000 &&
    $remaining <= 5000;
$first->resume();
$second->resume();
$rows[] =
    $count === $before + 1 &&
    $first->getReturn()['signing_method'] === 'jwt' &&
    $second->getReturn()['signing_method'] === 'jwt';
// Unknown IDs trigger at most one request per minute, including concurrent callers.
$states->setValue(null, []);
$keys = ['keys' => []];
$before = $count;
$rows[] = $error($verify, 'webhook_unknown_key');
$rows[] = $error($verify, 'webhook_unknown_key') && $count === $before + 1;
$age(['attempt' => -61]);
$keys = $input['jwks'];
$rows[] = $verify()['signing_method'] === 'jwt' && $count === $before + 2;
// Expired cache entries remain useful during an outage for at most 24 hours, and a failed
// refresh is retried at most once a minute instead of blocking every delivery.
$age(['expiresAt' => -1, 'fetchedAt' => -901]);
$failure = true;
$before = $count;
$rows[] = $verify()['signing_method'] === 'jwt' && $count === $before + 1;
$rows[] = $verify()['signing_method'] === 'jwt' && $count === $before + 1;
$age(['retryAfter' => -1]);
$rows[] = $verify()['signing_method'] === 'jwt' && $count === $before + 2;
$failure = false;
$age(['retryAfter' => -1]);
$rows[] =
    $verify()['signing_method'] === 'jwt' &&
    $count === $before + 3 &&
    $states->getValue()[$url]['retryAfter'] === 0;
$failure = true;
$age(['expiresAt' => -1, 'fetchedAt' => -86401]);
$rows[] = $error($verify, 'webhook_jwks_unavailable');
// Explicit key sets bypass every transport, even during an outage.
$before = $count;
$rows[] =
    $client->verifyWebhookDelivery($input['body'], $headers, $options + ['jwks' => $input['jwks']])[
        'signing_method'
    ] === 'jwt' && $count === $before;
foreach (['not JSON', str_repeat(' ', 256 * 1024 + 1), '{"keys":[{"kty":"RSA"}]}'] as $invalid) {
    $states->setValue(null, []);
    $bad = new Client(
        new ClientOptions(
            baseUrl: $input['issuer'],
            transport: fn($r) => ['status' => 200, 'body' => $invalid],
        ),
    );
    $rows[] = $error(
        fn() => $bad->verifyWebhookDelivery($input['body'], $headers, $options),
        'webhook_jwks_unavailable',
    );
}
// Programming errors in a transport propagate instead of becoming an outage code.
$states->setValue(null, []);
$broken = new Client(
    new ClientOptions(
        baseUrl: $input['issuer'],
        transport: fn($r) => throw new TypeError('Synthetic programming error'),
    ),
);
try {
    $broken->verifyWebhookDelivery($input['body'], $headers, $options);
    $rows[] = false;
} catch (TypeError $e) {
    $rows[] = $e->getMessage() === 'Synthetic programming error';
} catch (Throwable) {
    $rows[] = false;
}
echo json_encode($rows, JSON_THROW_ON_ERROR);
