<?php
declare(strict_types=1);
require $argv[1] . '/src/Runtime.php';
require $argv[1] . '/src/Client.php';
require $argv[1] . '/examples/webhook-inbox.php';
use Example\Payments\{Client, ClientOptions, PaymentsRetrieveInput, SdkError};
use function Example\Payments\Examples\{
    openInbox,
    receiveWebhook,
    processInbox,
    enqueueEffect,
    deliverOutbox,
};
function check(bool $ok): void
{
    if (!$ok) {
        throw new RuntimeException('Workflow assertion failed');
    }
}
$events = [];
$attempt = 0;
$client = new Client(
    new ClientOptions(
        'https://example.invalid',
        token: 'secret',
        diagnostics: function ($event) use (&$events) {
            $events[] = $event;
        },
        transport: function ($request) use (&$attempt) {
            if (!$attempt++) {
                throw new RuntimeException('lost secret');
            }
            return [
                'status' => 422,
                'headers' => ['Trace-Id' => 'trace-123'],
                'body' => '{"error":{"reason":"bad_input","fields":{"title":"required"}}}',
            ];
        },
    ),
);
try {
    $client->payments->retrieve(new PaymentsRetrieveInput(['id' => 'p']));
    throw new RuntimeException('Expected API error');
} catch (SdkError $error) {
    check($error->errorCode === 'bad_input' && $error->meta['requestId'] === 'trace-123');
    check(($error->details->title ?? null) === 'required');
    check(str_contains($error->raw, 'bad_input'));
}
check(array_column($events, 'errorKind') === ['transport', 'validation']);
check(!str_contains(json_encode($events), 'secret'));
$db = openInbox($argv[2]);
$receive = function (string $id, string $status, string $type = 'payment.updated') use (
    $client,
    $db,
) {
    $body = json_encode(
        [
            'id' => $id,
            'type' => $type,
            'data' => ['id' => 'p', 'amount' => 100, 'status' => $status],
        ],
        JSON_THROW_ON_ERROR,
    );
    $timestamp = (string) time();
    return receiveWebhook(
        $client,
        $db,
        $body,
        [
            'x-timestamp' => $timestamp,
            'x-signature' => hash_hmac('sha256', $timestamp . '.' . $body, 'key'),
        ],
        ['key'],
        fn($event) => $event->id,
    );
};
$receive('evt-new', 'succeeded');
$receive('evt-old', 'pending');
$receive('evt-future', 'pending', 'future.event');
$loadCurrent = fn($event) => ['orderId' => 'order-1', 'status' => 'succeeded'];
$apply = function ($transaction, $event, $current) {
    if ($current['status'] === 'succeeded') {
        enqueueEffect($transaction, 'fulfill:' . $current['orderId'], [
            'orderId' => $current['orderId'],
        ]);
    }
};
try {
    processInbox($db, $loadCurrent, function (...$args) use ($apply) {
        $apply(...$args);
        throw new RuntimeException('crash');
    });
} catch (RuntimeException $e) {
    check($e->getMessage() === 'crash');
}
check((int) $db->query('SELECT COUNT(*) FROM outbox')->fetchColumn() === 0);
check((int) $db->query('SELECT SUM(processed) FROM inbox')->fetchColumn() === 0);
check(processInbox($db, $loadCurrent, $apply));
check(processInbox($db, $loadCurrent, $apply));
check(!processInbox($db, $loadCurrent, $apply));
check(!$receive('evt-new', 'succeeded')['queued']);
check((int) $db->query('SELECT COUNT(*) FROM outbox')->fetchColumn() === 1);
$fulfilled = [];
$identities = [];
$send = function ($identity, $payload) use (&$fulfilled, &$identities) {
    $fulfilled[$identity] = true;
    $identities[] = $identity;
};
try {
    deliverOutbox($db, function (...$args) use ($send) {
        $send(...$args);
        throw new RuntimeException('ack lost');
    });
} catch (RuntimeException $e) {
    check($e->getMessage() === 'ack lost');
}
unset($receive); // Release its connection reference, then simulate worker restart.
$db = null;
$db = openInbox($argv[2]);
check(deliverOutbox($db, $send));
check(!deliverOutbox($db, $send));
check(count($fulfilled) === 1 && $identities === ['fulfill:order-1', 'fulfill:order-1']);
$client->close();
echo 'ok';
