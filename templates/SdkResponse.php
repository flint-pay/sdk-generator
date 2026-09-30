<?php
declare(strict_types=1);
namespace SdkNamespace;

/** @template T */
final class SdkResponse
{
    /** @param T $body
     * @param array{status: int, requestId?: string|null, attempts: int, durationMs: float, ...} $meta
     */
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
            } elseif (is_array($value) && array_key_exists($key, $value)) {
                $value = $value[$key];
            } elseif ($value instanceof \stdClass && property_exists($value, $key)) {
                $value = $value->{$key};
            } else {
                throw new SdkError(
                    'protocol',
                    'Missing configured response payload: ' . implode('.', $path),
                    'response',
                    false,
                    $result->meta,
                    raw: $result->raw,
                );
            }
        }
        return $value;
    }

    /** @internal */
    public static function payloadPages(\Generator $pages, array $path): \Generator
    {
        foreach ($pages as $key => $result) {
            yield $key => self::payload($result, $path);
        }
    }

    /** @internal */
    public static function responsePages(\Generator $pages): \Generator
    {
        foreach ($pages as $key => $result) {
            yield $key => new self($result->data, $result->meta, $result->raw);
        }
    }
}
