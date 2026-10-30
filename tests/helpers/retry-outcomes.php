<?php
// Namespace functions replace only time, sleep and jitter for this test process.
namespace RetryOutcomes;
function hrtime(bool $asNumber = false): int|array
{
    if ($GLOBALS['afterDecode'] ?? false) {
        $GLOBALS['clock'] += 2000;
        $GLOBALS['afterDecode'] = false;
    }
    return $asNumber ? (int) ($GLOBALS['clock'] * 1000000) : [0, 0];
}
function random_int(int $min, int $max): int
{
    return $min;
}
function usleep(int $microseconds): void
{
    $GLOBALS['clock'] += $microseconds / 1000;
    if ($GLOBALS['cancelWait']) {
        $GLOBALS['token']->cancel();
    }
    if ($GLOBALS['overrunWait']) {
        $GLOBALS['clock'] += 2000;
        $GLOBALS['overrunWait'] = false;
    }
}
require $argv[1] . '/src/Runtime.php';
require $argv[1] . '/src/Client.php';

final class OutcomeBody implements ByteStream
{
    private bool $done = false;
    public function __construct(
        private string $body,
        private array $step,
        private int $timeoutMs,
    ) {}
    public function read(): ?string
    {
        if ($this->step['bodyFailure'] ?? false) {
            throw new \RuntimeException('Synthetic incomplete body');
        }
        if ($this->step['bodyTimeout'] ?? false) {
            $GLOBALS['clock'] += $this->timeoutMs;
            throw new \RuntimeException('Synthetic stalled body', CURLE_OPERATION_TIMEDOUT);
        }
        if ($this->step['cancelBody'] ?? false) {
            $GLOBALS['clock'] += 10;
            $GLOBALS['token']->cancel();
            // Match a stream checking cancellation before it has response metadata.
            throw SdkError::create('cancelled', 'Synthetic body cancellation');
        }
        if (!$this->done) {
            $this->done = true;
            return $this->body;
        }
        if ($this->step['lateRead'] ?? false) {
            $GLOBALS['clock'] += 2000;
        }
        // The next time observation is after synchronous decoding and hydration.
        if ($this->step['lateDecode'] ?? false) {
            $GLOBALS['afterDecode'] = true;
        }
        if ($this->step['cancelRead'] ?? false) {
            $GLOBALS['token']->cancel();
        }
        return null;
    }
    public function close(): void {}
}

$rows = json_decode(file_get_contents($argv[2]), true, 512, JSON_THROW_ON_ERROR);
$results = [];
foreach ($rows as $row) {
    $GLOBALS['clock'] = 0;
    $GLOBALS['afterDecode'] = false;
    $GLOBALS['cancelWait'] = $row['cancelWait'] ?? false;
    $GLOBALS['overrunWait'] = $row['overrunWait'] ?? false;
    $token = new Cancellation();
    $GLOBALS['token'] = $token;
    if ($row['cancelBefore'] ?? false) {
        $token->cancel();
    }
    $calls = [];
    $transport = function (array $request) use (&$calls, $row): array {
        $step =
            $row['chain'][count($calls)] ??
            throw new \Exception('Unexpected dispatch: ' . $row['name']);
        $calls[] = $request['headers']['idempotency-key'] ?? null;
        if (isset($step['failure'])) {
            if ($step['failure'] === 'timeout') {
                $GLOBALS['clock'] += $request['timeoutMs'];
            }
            return [
                'status' => 0,
                'headers' => [],
                'body' => '',
                'failureCode' =>
                    $step['failure'] === 'timeout'
                        ? CURLE_OPERATION_TIMEDOUT
                        : CURLE_COULDNT_CONNECT,
            ];
        }
        $GLOBALS['clock'] += $step['delayMs'] ?? 0;
        $raw =
            $step['raw'] ??
            ($step['status'] === 200
                ? '{"value":"settled"}'
                : json_encode([
                    'error' => [
                        'code' => $step['code'],
                        'message' => 'Synthetic answer',
                        'remediation' => ['retry' => $step['retry']],
                        ...isset($step['reason'])
                            ? ['details' => [['reason' => $step['reason']]]]
                            : [],
                    ],
                ]));
        if (($row['op'] ?? null) === 'binary') {
            $raw = '%PDF-synthetic';
        }
        $headers = [
            'content-type' =>
                ($row['op'] ?? null) === 'binary' ? 'application/pdf' : 'application/json',
            'x-request-id' => 'req_' . count($calls),
        ];
        if (isset($step['retryAfter'])) {
            $headers['retry-after'] = $step['retryAfter'];
        }
        if ($step['buffered'] ?? false) {
            return [
                'status' => $step['status'],
                'headers' => $headers,
                'body' => $raw,
                'failureCode' => $step['bodyFailure'] ?? false ? CURLE_PARTIAL_FILE : null,
            ];
        }
        return [
            'status' => $step['status'],
            'headers' => $headers,
            'body' => '',
            'stream' => new OutcomeBody($raw, $step, $request['timeoutMs']),
        ];
    };
    $credentialCalls = 0;
    $credential = function () use (&$credentialCalls, $row): string {
        if (++$credentialCalls === ($row['authFailAt'] ?? null)) {
            throw new \RuntimeException('Synthetic provider failure');
        }
        return 'synthetic-token';
    };
    if ($row['refresh'] ?? false) {
        $credential = new class ($credential, $row) implements CredentialProvider {
            public int $invalidations = 0;
            public function __construct(private \Closure $resolve, private array $row) {}
            public function getCredential(): Credential
            {
                return new Credential(($this->resolve)());
            }
            public function invalidate(?Credential $credential = null): void
            {
                $this->invalidations++;
                if ($this->row['invalidateFailure'] ?? false) {
                    throw new \RuntimeException('Synthetic invalidation failure');
                }
            }
        };
    }
    $clientOptions = new ClientOptions(
        ...array_merge(['baseUrl' => 'https://example.invalid'], $row['client'] ?? [], [
            'token' => $credential,
            'transport' => $transport,
        ]),
    );
    $client = new Client($clientOptions);
    $options = new RequestOptions(
        ...array_merge(
            $row['defaults'] ?? false ? [] : ['timeoutMs' => 100, 'deadlineMs' => 1000],
            $row['options'] ?? [],
            ['cancellation' => $token],
        ),
    );
    try {
        $result =
            $row['dynamic'] ?? false
                ? (new Runtime(
                    json_decode(file_get_contents(dirname($argv[2]) . '/raw.json'), true),
                    $clientOptions,
                ))->request($row['op'] ?? 'write', [], $options)
                : $client->api->{$row['op'] ?? 'write'}([], $options);
        $actual = ['result' => true, 'raw' => $result->raw, ...$result->meta];
    } catch (SdkError $error) {
        $actual = [
            'error' => substr(strrchr(get_class($error), chr(92)), 1),
            'status' => $error->status,
            'code' => $error->code,
            'outcome' => $error->outcome,
            'retryAllowed' => $error->retryAllowed,
            'retryAfterMs' => $error->retryAfterMs,
            'requestIds' => $error->requestIds,
            'attempts' => $error->attempts,
            'key' => $error->idempotencyKey,
            'message' => $error->getMessage(),
        ];
    }
    $results[] = $actual + [
        'calls' => $calls,
        'credentialCalls' => $credentialCalls,
        'invalidations' =>
            $credential instanceof CredentialProvider ? $credential->invalidations : 0,
        'elapsed' => $GLOBALS['clock'],
    ];
}
echo json_encode($results, JSON_THROW_ON_ERROR);
