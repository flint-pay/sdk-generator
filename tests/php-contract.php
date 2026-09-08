<?php
declare(strict_types=1);
require $argv[1] . '/src/Runtime.php';
require $argv[1] . '/src/Client.php';
use Example\Payments\{
    Client,
    ClientOptions,
    RequestOptions,
    Runtime,
    SdkError,
    Cancellation,
    Codec,
};
$contract = json_decode(file_get_contents($argv[2]), true, 512, JSON_THROW_ON_ERROR);
$cases = json_decode(file_get_contents($argv[3]), true, 512, JSON_THROW_ON_ERROR);
function check(bool $condition, string $message): void
{
    if (!$condition) {
        throw new RuntimeException($message);
    }
}
$report = [];
foreach ($cases as $case) {
    $attempt = 0;
    $requests = [];
    $transport = function (array $r) use (&$attempt, &$requests, $case): array {
        $requests[] = $r;
        $expected = $case['expected'];
        $parsed = parse_url($r['url']);
        check($r['method'] === $expected['method'], $case['name'] . ': method');
        check(
            ($parsed['path'] ?? '') . (isset($parsed['query']) ? '?' . $parsed['query'] : '') ===
                $expected['path'],
            $case['name'] . ': path ' . $r['url'],
        );
        if (isset($expected['body'])) {
            check($r['body'] === $expected['body'], $case['name'] . ': body ' . $r['body']);
        }
        foreach ($expected['headers'] ?? [] as $k => $v) {
            check(($r['headers'][$k] ?? null) === $v, $case['name'] . ': header ' . $k);
        }
        $response =
            $case['responses'][$attempt++] ?? throw new RuntimeException('Too many attempts');
        if ($response['transportError'] ?? false) {
            throw new RuntimeException('Response lost');
        }
        return [
            'status' => $response['status'],
            'headers' => $response['headers'] ?? [],
            'body' => $response['body'],
        ];
    };
    $runtime = new Runtime(
        $contract,
        new ClientOptions(
            baseUrl: 'https://api.example.invalid/v1',
            token: 'test-token',
            transport: $transport,
        ),
    );
    $o = $case['options'] ?? [];
    try {
        // Decode body objects as objects, preserving empty {} independently from [].
        $input = $case['input'];
        if (array_key_exists('body', $input)) {
            $input['body'] = json_decode(
                json_encode((object) $input['body'], JSON_THROW_ON_ERROR),
                false,
                512,
                JSON_THROW_ON_ERROR,
            );
        }
        $result = $runtime->request(
            $case['operation'],
            $input,
            new RequestOptions(
                idempotencyKey: $o['idempotencyKey'] ?? null,
                ifMatch: $o['ifMatch'] ?? null,
                maxAttempts: $o['maxAttempts'] ?? null,
                deadlineMs: $o['deadlineMs'] ?? null,
            ),
        );
        check(!isset($case['error']), $case['name'] . ': expected error');
        if (isset($case['data'])) {
            check(
                json_decode(json_encode($result->data), true) === $case['data'],
                $case['name'] . ': data',
            );
        }
        $report[] = ['name' => $case['name'], 'ok' => true];
    } catch (SdkError $e) {
        check(
            isset($case['error']),
            $case['name'] . ': unexpected ' . $e->kind . ': ' . $e->getMessage(),
        );
        foreach ($case['error'] as $k => $v) {
            $actual = match ($k) {
                'status', 'requestId' => $e->meta[$k] ?? null,
                default => $e->{$k},
            };
            check($actual === $v, $case['name'] . ': error ' . $k);
        }
        $report[] = ['name' => $case['name'], 'ok' => true];
    }
    check($attempt === ($case['attempts'] ?? 1), $case['name'] . ': attempts ' . $attempt);
}
// Native presence-aware public input and public resource method.
$client = new Client(
    new ClientOptions(
        'https://api.example.invalid',
        token: 'test-token',
        transport: fn($r) => [
            'status' => 200,
            'headers' => [],
            'body' => '{"id":"p","amount":10,"status":"pending"}',
        ],
    ),
);
$input = new Example\Payments\PaymentsUpdateInput(['id' => 'p', 'body' => ['description' => null]]);
check($input->has('body') && !$input->has('missing'), 'presence API');
check($client->payments->update($input)->data->amount === '10', 'public method');
check($client->money('USD', '90071992547409.93')['amount'] === '9007199254740993', 'exact money');
$raw = '{"id":"e1","type":"payment.updated","data":{"id":"p","amount":100,"status":"pending"}}';
$signature = hash_hmac('sha256', '1000.' . $raw, 'new');
check(
    $client->verifyWebhook(
        $raw,
        ['x-timestamp' => '1000', 'x-signature' => $signature],
        ['old', 'new'],
        1000,
    )['known'],
    'overlapping secrets',
);
foreach (
    [[$raw . ' ', $signature, 1000], [$raw, $signature, 1400], [$raw, 'bad', 1000]]
    as [$body, $sig, $now]
) {
    try {
        $client->verifyWebhook(
            $body,
            ['X-Timestamp' => '1000', 'X-Signature' => $sig],
            ['new'],
            $now,
        );
        throw new RuntimeException('Expected signature rejection');
    } catch (SdkError $e) {
        check($e->kind === 'authentication', 'webhook rejection');
    }
}
$token = new Cancellation();
$token->cancel();
try {
    $client->payments->retrieve(
        new Example\Payments\PaymentsRetrieveInput(['id' => 'p']),
        new RequestOptions(cancellation: $token),
    );
    throw new RuntimeException('Expected cancellation');
} catch (SdkError $e) {
    check($e->kind === 'cancelled' && $e->outcome === 'not_sent', 'cancellation before dispatch');
}
$count = 0;
$paged = new Runtime(
    $contract,
    new ClientOptions(
        'https://api.example.invalid',
        token: 'test-token',
        transport: function ($r) use (&$count) {
            $count++;
            return [
                'status' => 200,
                'headers' => [],
                'body' => '{"items":[{"id":"p","amount":1,"status":"pending"}],"next":"next-page"}',
            ];
        },
    ),
);
foreach ($paged->items('listPayments', [], new RequestOptions(maxItems: 1)) as $item) {
    check($item->id === 'p', 'lazy item');
}
check($count === 1, 'bounded pagination');
$count = 0;
$unsafe = new Runtime(
    $contract,
    new ClientOptions(
        'https://api.example.invalid',
        token: 'test-token',
        transport: function ($r) use (&$count) {
            $count++;
            return [
                'status' => 200,
                'headers' => [],
                'body' => '{"items":[],"next":"https://evil.invalid/steal"}',
            ];
        },
    ),
);
try {
    iterator_to_array($unsafe->pages('listLinks'));
    throw new RuntimeException('Expected destination rejection');
} catch (SdkError $e) {
    check($e->kind === 'destination' && $count === 1, 'credential destination');
}
$client->close();
echo json_encode($report, JSON_THROW_ON_ERROR);
