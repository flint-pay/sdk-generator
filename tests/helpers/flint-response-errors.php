<?php
declare(strict_types=1);
// A separate process lets the mutation control preload a modified generated
// runtime without changing the package used by any normal client or codec check.
if (isset($argv[3])) {
    require $argv[3];
}
require $argv[1] . '/php/src/Client.php';
use Example\FlintFull\Client;
use Example\FlintFull\ClientOptions;
use Example\FlintFull\RequestOptions;
use Example\FlintFull\SdkError;

function canonicalJson(mixed $value): mixed
{
    if (is_object($value)) {
        $fields = get_object_vars($value);
        ksort($fields);
        return ['object', array_map('canonicalJson', $fields)];
    }
    if (is_array($value)) {
        return ['array', array_map('canonicalJson', $value)];
    }
    return [get_debug_type($value), $value];
}

$audit = json_decode(file_get_contents($argv[2]), true, 512, JSON_THROW_ON_ERROR);
$requests = 0;
$client = new Client(
    new ClientOptions(
        maxAttempts: 1,
        transport: function (array $request) use ($audit, &$requests): array {
            $example = $audit['examples'][(int) $request['headers']['x-response-example']];
            $group = $audit['groups'][$example['operation']];
            if (
                parse_url($request['url'], PHP_URL_PATH) !== $group['path'] ||
                $request['method'] !== $group['verb']
            ) {
                throw new RuntimeException($example['location'] . ': unexpected request');
            }
            $requests++;
            $body = json_decode($example['json'], true, 512, JSON_THROW_ON_ERROR);
            $headers = ['content-type' => $example['media']];
            if (isset($body['error']['request_id'])) {
                $headers['x-request-id'] = $body['error']['request_id'];
            }
            return [
                'status' => (int) $example['status'],
                'headers' => $headers,
                'body' => $example['json'],
            ];
        },
    ),
);
try {
    $examples = isset($argv[3]) ? array_slice($audit['examples'], 0, 1) : $audit['examples'];
    foreach ($examples as $index => $example) {
        $group = $audit['groups'][$example['operation']];
        // Preserve nested JSON objects (including empty maps) in SDK inputs.
        $input = (array) json_decode($group['inputJson'], false, 512, JSON_THROW_ON_ERROR);
        $options = new RequestOptions(
            ...array_replace($group['options'], [
                'maxAttempts' => 1,
                'headers' => ['x-response-example' => (string) $index],
            ]),
        );
        $body = json_decode($example['json'], false, 512, JSON_THROW_ON_ERROR);
        [$kind, $errorClass] = $example['expectedError'];
        $class = 'Example\\FlintFull\\Errors\\' . $errorClass;
        try {
            $client->{$group['resource']}->{$group['method']}($input, $options);
            throw new RuntimeException($example['location'] . ': error response succeeded');
        } catch (SdkError $error) {
            $check = static function (bool $valid, string $field) use ($example): void {
                if (!$valid) {
                    throw new RuntimeException($example['location'] . ': ' . $field);
                }
            };
            $check($error instanceof $class, 'error class');
            $check($error->kind === $kind, 'kind');
            $check($error->status === (int) $example['status'], 'status');
            $check($error->outcome === 'response', 'outcome');
            $check($error->errorCode === $body->error->code, 'code');
            // PHP exposes mixed error details with exact raw numeric tokens;
            // Node additionally certifies schema-directed typed details.
            $expectedDetails = json_decode(
                $example['expectedPhpDetailsJson'],
                false,
                512,
                JSON_THROW_ON_ERROR,
            );
            $check(
                canonicalJson($error->details) === canonicalJson($expectedDetails),
                'public error details',
            );
            $check(
                ($error->meta['requestId'] ?? null) === ($body->error->request_id ?? null),
                'requestId',
            );
            $check(($error->meta['attempts'] ?? null) === 1, 'attempts');
        }
    }
    if ($requests !== count($examples)) {
        throw new RuntimeException('Every error must reach the transport once');
    }
} finally {
    $client->close();
}
echo json_encode(['errorThroughClient' => count($examples)], JSON_THROW_ON_ERROR);
