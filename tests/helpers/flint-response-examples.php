<?php
declare(strict_types=1);
require $argv[1] . '/php/src/Client.php';
use Example\FlintFull\Codec;
use Example\FlintFull\Internal\DescriptorSource;

$source = new DescriptorSource($argv[1] . '/php/src/descriptors', true);
$audit = json_decode(file_get_contents($argv[2]), true, 512, JSON_THROW_ON_ERROR);
$failures = [];
$key = static fn(array $example): string => json_encode(
    [
        $example['operation'] ?? null,
        $example['status'] ?? null,
        $example['media'] ?? null,
        $example['exampleName'] ?? null,
    ],
    JSON_THROW_ON_ERROR,
);
$expected = [];
foreach ($audit['expectedFailures'] as $example) {
    if (isset($expected[$key($example)])) {
        throw new RuntimeException('Duplicate expected failure');
    }
    $expected[$key($example)] = $example;
}
$observed = [];
$decode = function (array $example, array $codec, array $definitions) use (
    &$failures,
    $key,
    $expected,
    &$observed,
): void {
    $failure = null;
    try {
        Codec::execute(Codec::parse($example['json'], true), $codec, [
            'mode' => 'response',
            'path' => 'response',
            'definitions' => $definitions,
        ]);
    } catch (Throwable $error) {
        $failure = $error->getMessage();
    }
    $id = $key($example);
    if (isset($expected[$id])) {
        $observed[$id] = true;
        if ($failure !== $expected[$id]['error']) {
            throw new RuntimeException(
                $id .
                    ': expected upstream defect changed or now passes; review and remove its entry: ' .
                    ($failure ?? 'PASS'),
            );
        }
    } elseif ($failure !== null) {
        $failures[] = $example['location'] . ': ' . $failure;
    }
};
foreach ($audit['routes'] as $example) {
    $operation = $source->operation($example['operation']);
    $codec = $operation['responses'][$example['status']]['codec'] ?? null;
    if ($codec === null) {
        throw new RuntimeException('Missing codec: ' . $example['location']);
    }
    $decode($example, $codec, $source->definitions());
}
foreach ($audit['schemas'] as $example) {
    $decode($example, $example['codec'], $audit['definitions']);
}
if (array_diff_key($expected, $observed)) {
    throw new RuntimeException('Expected defect example disappeared');
}
if ($failures) {
    throw new RuntimeException(implode("\n", $failures));
}
$operation = $source->operation('getPaymentIntent');
try {
    Codec::execute((object) ['data' => (object) []], $operation['responses']['200']['codec'], [
        'mode' => 'response',
        'definitions' => $source->definitions(),
    ]);
    throw new RuntimeException('Strict decoder accepted missing required fields');
} catch (Example\FlintFull\SdkError $error) {
    if (!str_contains($error->getMessage(), 'required field is missing')) {
        throw $error;
    }
}
echo json_encode(
    [
        'inspected' => count($audit['routes']) + count($audit['schemas']),
        'expectedFailures' => count($expected),
    ],
    JSON_THROW_ON_ERROR,
);
