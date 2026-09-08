<?php
declare(strict_types=1);
require $argv[1] . '/src/Runtime.php';
require $argv[1] . '/src/Client.php';
$clientClass = $argv[4] . '\\Client';
$clientOptionsClass = $argv[4] . '\\ClientOptions';
$requestOptionsClass = $argv[4] . '\\RequestOptions';
$errorClass = $argv[4] . '\\SdkError';
$contract = json_decode(file_get_contents($argv[2]), true, 512, JSON_THROW_ON_ERROR);
$cases = json_decode(file_get_contents($argv[3]), true, 512, JSON_THROW_ON_ERROR);
$objectCases = json_decode(file_get_contents($argv[3]), false, 512, JSON_THROW_ON_ERROR);
function check(bool $condition, string $message): void
{
    if (!$condition) {
        throw new RuntimeException($message);
    }
}
$report = [];
foreach ($cases as $index => $case) {
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
            'body' => $response['body'] ?? '',
        ];
    };
    $client = new $clientClass(
        new $clientOptionsClass(
            baseUrl: $case['baseUrl'] ?? 'https://api.example.invalid/v1',
            token: 'test-token',
            transport: $transport,
        ),
    );
    $o = $case['options'] ?? [];
    try {
        // Decode body objects as objects, preserving empty {} independently from [].
        $input = $case['input'];
        if (array_key_exists('body', $input)) {
            $input['body'] = $objectCases[$index]->input->body;
        }
        $operation = null;
        foreach ($contract['operations'] as $candidate) {
            if ($candidate['id'] === $case['operation']) {
                $operation = $candidate;
            }
        }
        if ($operation === null) {
            throw new RuntimeException('Operation is not included');
        }
        $inputClass =
            $argv[4] .
            '\\' .
            ucfirst($operation['resource']) .
            ucfirst($operation['method']) .
            'Input';
        $result = $client->{$operation['resource']}->{$operation['method']}(
            new $inputClass($input),
            new $requestOptionsClass(
                idempotencyKey: $o['idempotencyKey'] ?? null,
                ifMatch: $o['ifMatch'] ?? null,
                maxAttempts: $o['maxAttempts'] ?? null,
                deadlineMs: $o['deadlineMs'] ?? null,
                timeoutMs: $o['timeoutMs'] ?? null,
                headers: $o['headers'] ?? [],
            ),
        );
        check(!isset($case['error']), $case['name'] . ': expected error');
        if (array_key_exists('data', $case)) {
            check(
                json_decode(json_encode($result->data), true) === $case['data'],
                $case['name'] . ': data',
            );
        }
        if ($case['empty'] ?? false) {
            check($result->data === null, $case['name'] . ': empty');
        }
        $report[] = ['name' => $case['name'], 'ok' => true];
    } catch (\Throwable $e) {
        if (!($e instanceof $errorClass)) {
            throw $e;
        }
        check(
            isset($case['error']),
            $case['name'] . ': unexpected ' . $e->kind . ': ' . $e->getMessage(),
        );
        foreach ($case['error'] as $k => $v) {
            $actual = match ($k) {
                'status', 'requestId' => $e->meta[$k] ?? null,
                'code' => $e->errorCode,
                'details' => json_decode(
                    json_encode($e->details, JSON_THROW_ON_ERROR),
                    true,
                    512,
                    JSON_THROW_ON_ERROR,
                ),
                default => $e->{$k},
            };
            check($actual === $v, $case['name'] . ': error ' . $k);
        }
        $report[] = ['name' => $case['name'], 'ok' => true];
    } finally {
        $client->close();
    }
    check($attempt === ($case['attempts'] ?? 1), $case['name'] . ': attempts ' . $attempt);
}
echo json_encode($report, JSON_THROW_ON_ERROR);
