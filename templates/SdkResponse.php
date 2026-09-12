<?php
declare(strict_types=1);
namespace SdkNamespace;

/** @template T */
final class SdkResponse
{
    /** @param T $body */
    public function __construct(
        public readonly mixed $body,
        public readonly array $meta,
        public readonly string $raw,
    ) {}

    public function __debugInfo(): array
    {
        return [
            'meta' => array_intersect_key(
                $this->meta,
                array_flip(['status', 'requestId', 'attempts', 'durationMs']),
            ),
            'body' => '[Use body explicitly]',
        ];
    }

    /** @internal */
    public static function payload(Result $result, array $path): mixed
    {
        $value = $result->data;
        foreach ($path as $key) {
            if ($value instanceof Model && $value->has($key)) {
                $value = $value->get($key);
            } elseif ($value instanceof \stdClass && property_exists($value, $key)) {
                $value = $value->{$key};
            } else {
                throw new SdkError(
                    'protocol',
                    'Missing configured response payload: ' . implode('.', $path),
                    'response',
                    false,
                    $result->meta,
                );
            }
        }
        return $value;
    }
}
