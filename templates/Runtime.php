<?php
declare(strict_types=1);
namespace SdkNamespace;
require_once __DIR__ . '/SchemaAdapter.php';

final class SdkError extends \RuntimeException
{
    public function __construct(
        public readonly string $kind,
        string $message,
        public readonly string $outcome = 'not_sent',
        public readonly bool $retryAllowed = false,
        public readonly ?array $meta = null,
        public readonly ?string $errorCode = null,
        public readonly mixed $details = null,
        ?\Throwable $previous = null,
        public readonly ?string $raw = null,
    ) {
        parent::__construct($message, 0, $previous);
    }
    public function __debugInfo(): array
    {
        return [
            'kind' => $this->kind,
            'message' => $this->message,
            'outcome' => $this->outcome,
            'requestId' => $this->meta['requestId'] ?? null,
        ];
    }
}
/** @template T */
final class Result
{
    /** @param T $data */
    public function __construct(
        public readonly mixed $data,
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
            'data' => '[Use data explicitly]',
        ];
    }
}
final class Cancellation
{
    private bool $cancelled = false;
    public function cancel(): void
    {
        $this->cancelled = true;
    }
    public function isCancelled(): bool
    {
        return $this->cancelled;
    }
}
final class RequestOptions
{
    public function __construct(
        public readonly array $headers = [],
        public readonly ?string $idempotencyKey = null,
        public readonly ?string $ifMatch = null,
        public readonly ?int $timeoutMs = null,
        public readonly ?int $deadlineMs = null,
        public readonly ?int $maxAttempts = null,
        public readonly ?Cancellation $cancellation = null,
        public readonly ?int $maxPages = null,
        public readonly ?int $maxItems = null,
        public readonly ?string $authMode = null,
        public readonly ?array $credentials = null,
        public readonly ?int $streamIdleTimeoutMs = null,
        public readonly ?int $streamLifetimeMs = null,
    ) {
        /* AUTH_SHORTCUT_PARAMETERS */
    }
    public function __debugInfo(): array
    {
        return [
            'authMode' => $this->authMode,
            'credentials' => '[REDACTED]',
            'headers' => '[REDACTED]',
        ];
    }
    public function withDeadline(int $remaining): self
    {
        return new self(
            $this->headers,
            $this->idempotencyKey,
            $this->ifMatch,
            $this->timeoutMs,
            $remaining,
            $this->maxAttempts,
            $this->cancellation,
            $this->maxPages,
            $this->maxItems,
            $this->authMode,
            $this->credentials,
            $this->streamIdleTimeoutMs,
            $this->streamLifetimeMs,
            /* AUTH_SHORTCUT_FORWARD */
        );
    }
}
final class ClientOptions
{
    public function __construct(
        public readonly string $baseUrl,
        public readonly ?string $token = null,
        public readonly ?array $allowedOrigins = null,
        public readonly bool $allowInsecureHttp = false,
        public readonly int $timeoutMs = 10000,
        public readonly int $deadlineMs = 30000,
        public readonly ?int $maxAttempts = null,
        public readonly ?\Closure $transport = null,
        public readonly ?\Closure $diagnostics = null,
        public readonly array $redactFields = [],
        public readonly ?string $authMode = null,
        public readonly array $credentials = [],
    ) {
        /* AUTH_SHORTCUT_PARAMETERS */
    }
    public function __debugInfo(): array
    {
        return ['baseUrl' => $this->baseUrl, 'token' => '[REDACTED]'];
    }
}
/** Injected streaming transports return this interface in the response's stream field. */
interface ByteStream
{
    /** Return the next bounded byte chunk, or null at EOF. Honor cancellation while waiting. */
    public function read(): ?string;
    public function close(): void;
}

/** Owns one incremental connection; at most one cURL write chunk is queued. */
final class CurlByteStream implements ByteStream
{
    private ?\CurlHandle $handle = null;
    private ?\CurlMultiHandle $multi = null;
    private ?string $pending = null;
    private bool $paused = false;
    private bool $done = false;
    private bool $headersDone = false;
    private bool $streaming = false;
    private ?int $failure = null;
    public int $status = 0;
    public array $headers = [];
    private float $started;
    public function __construct(private readonly array $request)
    {
        $this->started = self::now();
        $this->handle = curl_init();
        $this->multi = curl_multi_init();
        curl_setopt_array($this->handle, [
            CURLOPT_URL => $request['url'],
            CURLOPT_CUSTOMREQUEST => $request['method'],
            CURLOPT_HTTPHEADER => array_map(
                fn($key, $value) => $value === '' ? "$key;" : "$key: $value",
                array_keys($request['headers']),
                $request['headers'],
            ),
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_ENCODING => '',
            CURLOPT_CONNECTTIMEOUT_MS => (int) $request['timeoutMs'],
            CURLOPT_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS,
            CURLOPT_SUPPRESS_CONNECT_HEADERS => true,
            CURLOPT_HEADERFUNCTION => function ($handle, string $line): int {
                if (preg_match('/^HTTP\/\S+\s+(\d+)/', $line, $matches)) {
                    $this->status = (int) $matches[1];
                    $this->headers = [];
                } elseif (trim($line) === '' && $this->status >= 200) {
                    $this->headersDone = true;
                } elseif (str_contains($line, ':')) {
                    [$key, $value] = explode(':', $line, 2);
                    $this->headers[strtolower(trim($key))] = trim($value);
                }
                return strlen($line);
            },
            CURLOPT_WRITEFUNCTION => function ($handle, string $chunk): int {
                if ($this->pending !== null) {
                    $this->paused = true;
                    return CURL_WRITEFUNC_PAUSE;
                }
                $this->pending = $chunk;
                return strlen($chunk);
            },
        ]);
        if ($request['body'] !== null) {
            curl_setopt($this->handle, CURLOPT_POSTFIELDS, $request['body']);
        }
        curl_multi_add_handle($this->multi, $this->handle);
        try {
            while (!$this->headersDone && !$this->done) {
                $this->pump($this->started, (int) $request['timeoutMs']);
            }
            $this->checkFailure();
        } catch (\Throwable $error) {
            $this->close();
            throw $error;
        }
    }
    private static function now(): float
    {
        return hrtime(true) / 1000000;
    }
    private function checkFailure(): void
    {
        if ($this->failure !== null && $this->failure !== CURLE_OK) {
            if (!$this->streaming) {
                // Before delivery, Runtime owns retry classification.
                throw new \RuntimeException('Streaming connection failed');
            }
            throw new SdkError('transport', 'Streaming transport failed', 'unknown');
        }
    }
    private function checkRequestTimeout(): void
    {
        if (!$this->streaming && self::now() - $this->started >= $this->request['timeoutMs']) {
            // Let Runtime classify the exhausted overall/per-attempt budget and
            // retain its normal transport retry policy for buffered responses.
            throw new \RuntimeException('Response exceeded the request timeout');
        }
    }
    /** Transfer connection ownership only after Runtime accepts an SSE response. */
    public function startStream(): void
    {
        try {
            $this->checkRequestTimeout();
            $this->streaming = true;
            $this->started = self::now();
        } catch (\Throwable $error) {
            $this->close();
            throw $error;
        }
    }
    private function pump(float $waitStart, int $timeout): void
    {
        $this->checkRequestTimeout();
        if (($this->request['cancellation'] ?? null)?->isCancelled()) {
            throw new SdkError('cancelled', 'Stream cancelled', 'response');
        }
        if ($this->streaming && self::now() - $waitStart >= $timeout) {
            throw new SdkError(
                'deadline',
                'Stream idle or connection timeout exceeded',
                'response',
            );
        }
        if (
            $this->streaming &&
            isset($this->request['streamLifetimeMs']) &&
            self::now() - $this->started >= $this->request['streamLifetimeMs']
        ) {
            throw new SdkError('deadline', 'Stream lifetime exceeded', 'response');
        }
        if ($this->multi === null) {
            return;
        }
        $code = curl_multi_exec($this->multi, $running);
        if ($code !== CURLM_OK) {
            if (!$this->streaming) {
                // Before delivery, Runtime owns retry classification.
                throw new \RuntimeException('Streaming connection failed');
            }
            throw new SdkError('transport', 'Streaming transport failed', 'unknown');
        }
        while ($info = curl_multi_info_read($this->multi)) {
            $this->done = true;
            $this->failure = $info['result'];
        }
        if (!$this->done && $this->pending === null) {
            $wait = $this->streaming
                ? 0.05
                : min(
                    0.05,
                    max(0, ($this->request['timeoutMs'] - (self::now() - $this->started)) / 1000),
                );
            if (curl_multi_select($this->multi, $wait) === -1) {
                usleep(1000);
            }
        }
    }
    public function read(): ?string
    {
        try {
            $waitStart = self::now();
            while ($this->handle !== null) {
                $this->checkRequestTimeout();
                if (($this->request['cancellation'] ?? null)?->isCancelled()) {
                    throw new SdkError('cancelled', 'Stream cancelled', 'response');
                }
                if ($this->pending !== null) {
                    $chunk = $this->pending;
                    $this->pending = null;
                    return $chunk;
                }
                if ($this->done) {
                    $this->checkFailure();
                    $this->close();
                    return null;
                }
                if ($this->paused) {
                    $this->paused = false;
                    curl_pause($this->handle, CURLPAUSE_CONT);
                }
                $this->pump($waitStart, $this->request['streamIdleTimeoutMs'] ?? 30000);
            }
            return null;
        } catch (\Throwable $error) {
            $this->close();
            throw $error;
        }
    }
    public function close(): void
    {
        if ($this->handle !== null && $this->multi !== null) {
            curl_multi_remove_handle($this->multi, $this->handle);
        }
        $this->handle = null;
        $this->multi = null;
        $this->pending = null;
    }
    public function __destruct()
    {
        $this->close();
    }
    public function __debugInfo(): array
    {
        return ['status' => $this->status];
    }
}

final class ServerSentEvent
{
    public function __construct(
        public readonly string $event,
        public readonly string $id,
        public readonly mixed $data,
        public readonly string $rawData,
        public readonly ?int $retry = null,
    ) {}
    public function __debugInfo(): array
    {
        return ['event' => $this->event];
    }
}

/** @implements \IteratorAggregate<int, ServerSentEvent> */
final class EventStream implements \IteratorAggregate
{
    private bool $closed = false;
    private bool $started = false;
    private float $created;
    public function __construct(
        private readonly ByteStream $source,
        public readonly array $meta,
        private readonly array $settings,
        private readonly \Closure $decode,
        private readonly \Closure $released,
    ) {
        $this->created = hrtime(true) / 1000000;
    }
    public function close(): void
    {
        if ($this->closed) {
            return;
        }
        $this->closed = true;
        $this->source->close();
        ($this->released)();
    }
    public function __debugInfo(): array
    {
        return [
            'meta' => array_intersect_key(
                $this->meta,
                array_flip(['status', 'requestId', 'attempts', 'durationMs']),
            ),
            'closed' => $this->closed,
        ];
    }
    public function getIterator(): \Traversable
    {
        if ($this->started) {
            throw new SdkError('validation', 'A stream can only be consumed once');
        }
        $this->started = true;
        $line = '';
        $data = '';
        $event = '';
        $id = '';
        $retry = null;
        $skipLF = false;
        $bytes = 0;
        $first = true;
        try {
            while (!$this->closed) {
                if (($this->settings['cancellation'] ?? null)?->isCancelled()) {
                    throw new SdkError(
                        'cancelled',
                        'Stream cancelled',
                        'response',
                        false,
                        $this->meta,
                    );
                }
                if (
                    isset($this->settings['lifetimeMs']) &&
                    hrtime(true) / 1000000 - $this->created >= $this->settings['lifetimeMs']
                ) {
                    throw new SdkError(
                        'deadline',
                        'Stream lifetime exceeded',
                        'response',
                        false,
                        $this->meta,
                    );
                }
                $wait = hrtime(true) / 1000000;
                $chunk = $this->source->read();
                if (($this->settings['cancellation'] ?? null)?->isCancelled()) {
                    throw new SdkError(
                        'cancelled',
                        'Stream cancelled',
                        'response',
                        false,
                        $this->meta,
                    );
                }
                if (hrtime(true) / 1000000 - $wait >= $this->settings['idleTimeoutMs']) {
                    throw new SdkError(
                        'deadline',
                        'Stream idle timeout exceeded',
                        'response',
                        false,
                        $this->meta,
                    );
                }
                if ($chunk === null) {
                    if (preg_match('//u', $line) !== 1) {
                        throw new SdkError(
                            'protocol',
                            'Invalid UTF-8 stream',
                            'response',
                            false,
                            $this->meta,
                        );
                    }
                    break;
                }
                for (
                    $index = 0, $length = strlen($chunk);
                    $index < $length && !$this->closed;
                    $index++
                ) {
                    if (($this->settings['cancellation'] ?? null)?->isCancelled()) {
                        throw new SdkError(
                            'cancelled',
                            'Stream cancelled',
                            'response',
                            false,
                            $this->meta,
                        );
                    }
                    if (
                        isset($this->settings['lifetimeMs']) &&
                        hrtime(true) / 1000000 - $this->created >= $this->settings['lifetimeMs']
                    ) {
                        throw new SdkError(
                            'deadline',
                            'Stream lifetime exceeded',
                            'response',
                            false,
                            $this->meta,
                        );
                    }
                    $character = $chunk[$index];
                    if ($skipLF) {
                        $skipLF = false;
                        if ($character === "\n") {
                            continue;
                        }
                    }
                    if (++$bytes > $this->settings['maxEventBytes']) {
                        throw new SdkError(
                            'protocol',
                            'SSE event exceeds configured size limit',
                            'response',
                            false,
                            $this->meta,
                        );
                    }
                    if ($character !== "\r" && $character !== "\n") {
                        $line .= $character;
                        continue;
                    }
                    $skipLF = $character === "\r";
                    if ($first) {
                        $first = false;
                        if (str_starts_with($line, "\xef\xbb\xbf")) {
                            $line = substr($line, 3);
                        }
                    }
                    if (preg_match('//u', $line) !== 1) {
                        throw new SdkError(
                            'protocol',
                            'Invalid UTF-8 stream',
                            'response',
                            false,
                            $this->meta,
                        );
                    }
                    if ($line === '') {
                        if ($data !== '') {
                            $raw = substr($data, 0, -1);
                            yield new ServerSentEvent(
                                $event === '' ? 'message' : $event,
                                $id,
                                ($this->decode)($event === '' ? 'message' : $event, $raw),
                                $raw,
                                $retry,
                            );
                        }
                        $data = '';
                        $event = '';
                        $bytes = 0;
                    } elseif ($line[0] !== ':') {
                        $parts = explode(':', $line, 2);
                        $field = $parts[0];
                        $value = $parts[1] ?? '';
                        if (str_starts_with($value, ' ')) {
                            $value = substr($value, 1);
                        }
                        if ($field === 'data') {
                            $data .= $value . "\n";
                        } elseif ($field === 'event') {
                            $event = $value;
                        } elseif ($field === 'id' && !str_contains($value, "\0")) {
                            $id = $value;
                        } elseif (
                            $field === 'retry' &&
                            preg_match('/^\d+$/D', $value) &&
                            (float) $value <= 9007199254740991
                        ) {
                            $retry = (int) $value;
                        }
                    }
                    $line = '';
                }
            }
        } catch (SdkError $error) {
            if ($error->kind !== 'validation') {
                throw $error;
            }
            throw new SdkError(
                'protocol',
                'Invalid SSE event payload',
                'response',
                false,
                $this->meta,
                previous: $error,
            );
        } catch (\Throwable $error) {
            throw new SdkError(
                'protocol',
                'Invalid or interrupted SSE stream',
                'response',
                false,
                $this->meta,
                previous: $error,
            );
        } finally {
            $this->close();
        }
    }
    public function __destruct()
    {
        $this->close();
    }
}

class Model implements \JsonSerializable
{
    protected readonly mixed $values;
    private readonly mixed $inputValues;
    private readonly array $codec;
    protected readonly array $schema;
    protected readonly array $redactFields;
    public function __construct(
        mixed $values,
        array $schema,
        bool $response = false,
        array $redactFields = [],
        ?array $compiled = null,
    ) {
        $this->schema = $schema;
        $codec = $compiled ?? \SdkNamespace\Internal\SchemaAdapter::compile($schema);
        $this->codec = $codec;
        $this->redactFields = $redactFields;
        if (is_array($values) && $codec['modelObjectInput']) {
            $values = (object) $values;
        }
        $normalized = Codec::execute($values, $codec, [
            'mode' => $response ? 'response' : 'request',
        ]);
        // Store public values: unwrap nested models and exact wire-number wrappers,
        // while retaining the normalized distinction between objects and lists.
        $unwrap = function (mixed $value, int $depth = 0) use (&$unwrap): mixed {
            if ($depth > 256) {
                Codec::fail(
                    'value',
                    'value exceeds the supported nesting depth or contains a cycle',
                );
            }
            if ($value instanceof Model) {
                return $unwrap($value->jsonSerialize(), $depth + 1);
            }
            if ($value instanceof RawNumber) {
                return $value->value;
            }
            if (is_array($value)) {
                return array_map(fn($v) => $unwrap($v, $depth + 1), $value);
            }
            if (is_object($value)) {
                $out = new \stdClass();
                foreach ((array) $value as $key => $child) {
                    $out->{$key} = $unwrap($child, $depth + 1);
                }
                return $out;
            }
            return $value;
        };
        $preserveNumbers = function (mixed $value, int $depth = 0) use (&$preserveNumbers): mixed {
            if ($depth > 256) {
                Codec::fail('value', 'value exceeds supported nesting depth or contains a cycle');
            }
            if ($value instanceof RawNumber) {
                return new ExactNumber($value->value);
            }
            if (is_array($value)) {
                return array_map(fn($child) => $preserveNumbers($child, $depth + 1), $value);
            }
            if (is_object($value)) {
                $out = new \stdClass();
                foreach ((array) $value as $key => $child) {
                    $out->{$key} = $preserveNumbers($child, $depth + 1);
                }
                return $out;
            }
            return $value;
        };
        $this->inputValues = $preserveNumbers($normalized);
        $this->values = $unwrap($normalized);
    }
    /** Copy normalized trees without losing immutable exact-number tokens. */
    private static function copyValue(mixed $value): mixed
    {
        if (is_array($value)) {
            return array_map(self::copyValue(...), $value);
        }
        if ($value instanceof \stdClass) {
            $out = new \stdClass();
            foreach ((array) $value as $key => $child) {
                $out->{$key} = self::copyValue($child);
            }
            return $out;
        }
        return $value;
    }
    public function has(string $field): bool
    {
        return is_object($this->values)
            ? property_exists($this->values, $field)
            : is_array($this->values) && array_key_exists($field, $this->values);
    }
    public function get(string $field): mixed
    {
        if (!$this->has($field)) {
            throw new SdkError(
                'validation',
                'Field ' .
                    $field .
                    ' was omitted; use has() or valueOrDefault() for optional fields.',
            );
        }
        return self::copyValue(
            is_object($this->values) ? $this->values->{$field} : $this->values[$field],
        );
    }
    /** Return the fallback only for omission; an explicit null remains null. */
    public function valueOrDefault(string $field, mixed $default = null): mixed
    {
        return $this->has($field) ? $this->get($field) : self::copyValue($default);
    }
    public function __get(string $field): mixed
    {
        return $this->get($field);
    }
    public function __isset(string $field): bool
    {
        return $this->has($field) && $this->get($field) !== null;
    }
    /** Preserve the interpreted numeric kind when generated inputs are encoded again. */
    public function toInputArray(): array
    {
        return (array) self::copyValue($this->inputValues);
    }
    public function toInputValue(): mixed
    {
        return self::copyValue($this->inputValues);
    }
    public function toArray(): array
    {
        if (!is_object($this->values) && !is_array($this->values)) {
            throw new SdkError(
                'validation',
                'This model contains a scalar; use jsonSerialize() to access its value',
            );
        }
        return (array) self::copyValue($this->values);
    }
    public function jsonSerialize(): mixed
    {
        return self::copyValue($this->values);
    }
    public function __debugInfo(): array
    {
        $redacted = Codec::redactPlan($this->values, $this->codec, $this->redactFields);
        return is_array($redacted) || is_object($redacted)
            ? (array) $redacted
            : ['value' => $redacted];
    }
}
final class RawNumber
{
    public function __construct(public readonly string $value) {}
}
/** JSON numeric meaning, established by the parser or a positive codec declaration. */
class ParsedNumber
{
    public function __construct(public readonly string $value) {}
}
final class ExactNumber extends ParsedNumber
{
    public function __construct(string $value)
    {
        if (!preg_match('/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/D', $value)) {
            Codec::fail('ExactNumber', 'expected a JSON number token');
        }
        parent::__construct($value);
    }
}

final class Codec
{
    private const ANY_CODEC = [
        'value' => ['kind' => 'dynamic'],
        'nullable' => true,
        'modelObjectInput' => false,
        'requiredInput' => [],
        'requiredOutput' => [],
        'rejectInput' => false,
        'hiddenOutput' => false,
        'sensitive' => false,
        'checks' => [],
    ];
    public static function assertPlan(mixed $value, string $path = 'codec', int $depth = 0): void
    {
        $invalid = static fn($reason) => throw new \InvalidArgumentException(
            "$path: invalid compiled codec ($reason)",
        );
        if ($depth > 256 || !is_array($value)) {
            $invalid('shape or nesting limit');
        }
        if (isset($value['numberInput']) && $value['numberInput'] !== 'explicit') {
            $invalid('number input representation');
        }
        if (
            isset($value['numberInput']) &&
            !in_array($value['value']['kind'] ?? null, ['decimal', 'exact-integer'], true)
        ) {
            $invalid('number input requires an exact numeric instruction');
        }
        if (!is_array($value['value'] ?? null)) {
            $invalid('missing value instruction');
        }
        if (
            ($value['value']['kind'] ?? null) === 'opaque' &&
            !is_string($value['value']['label'] ?? null)
        ) {
            $invalid('missing opaque label');
        }
        self::wireKind($value['value']);
        foreach (
            ['nullable', 'modelObjectInput', 'rejectInput', 'hiddenOutput', 'sensitive']
            as $key
        ) {
            if (!is_bool($value[$key] ?? null)) {
                $invalid('missing boolean ' . $key);
            }
        }
        foreach (['requiredInput', 'requiredOutput'] as $key) {
            if (!is_array($value[$key] ?? null)) {
                $invalid('invalid required keys');
            }
            foreach ($value[$key] as $name) {
                if (!is_string($name)) {
                    $invalid('invalid required key');
                }
            }
        }
        if (!is_array($value['checks'] ?? null)) {
            $invalid('missing checks');
        }
        foreach ($value['checks'] as $key => $item) {
            if ($key === 'uniqueItems') {
                if (!is_bool($item)) {
                    $invalid('invalid uniqueness constraint');
                }
                continue;
            }
            if ($key === 'multipleOf' && ((!is_int($item) && !is_float($item)) || $item <= 0)) {
                $invalid('invalid positive divisor');
            }
            if (
                in_array($key, ['minProperties', 'maxProperties'], true) &&
                (!is_int($item) || $item < 0 || $item > 9007199254740991)
            ) {
                $invalid('invalid property bound');
            }
            if (
                $key === 'pattern'
                    ? !is_string($item)
                    : !in_array(
                            $key,
                            [
                                'minimum',
                                'maximum',
                                'exclusiveMinimum',
                                'exclusiveMaximum',
                                'multipleOf',
                                'minLength',
                                'maxLength',
                                'minItems',
                                'maxItems',
                                'minProperties',
                                'maxProperties',
                            ],
                            true,
                        ) ||
                        (!is_int($item) && !is_float($item)) ||
                        !is_finite((float) $item)
            ) {
                $invalid('invalid constraint');
            }
        }
        foreach (['reference', 'tag', 'phpPattern'] as $key) {
            if (isset($value[$key]) && !is_string($value[$key])) {
                $invalid('invalid ' . $key);
            }
        }
        if (isset($value['literal'])) {
            if (!is_string($value['literal'])) {
                $invalid('invalid literal');
            }
            try {
                json_decode($value['literal'], false, 512, JSON_THROW_ON_ERROR);
            } catch (\JsonException) {
                $invalid('invalid literal JSON');
            }
        }
        if (isset($value['constraints']) && !is_bool($value['constraints'])) {
            $invalid('invalid policy');
        }
        if (isset($value['objectOnlyAlternative']) && !is_bool($value['objectOnlyAlternative'])) {
            $invalid('invalid alternative policy');
        }
        if (isset($value['range'])) {
            if (!is_array($value['range']) || count($value['range']) !== 2) {
                $invalid('invalid range');
            }
            foreach ($value['range'] as $bound) {
                if (!is_string($bound) || !preg_match('/^-?\d+$/', $bound)) {
                    $invalid('invalid range bound');
                }
            }
        }
        if (isset($value['members']) && !is_array($value['members'])) {
            $invalid('invalid members');
        }
        if (
            isset($value['tagValues']) &&
            (!is_array($value['tagValues']) ||
                array_filter($value['tagValues'], fn($tag) => !is_string($tag)))
        ) {
            $invalid('invalid discriminator values');
        }
        foreach (['fields', 'definitions', 'every', 'some', 'exactlyOne'] as $key) {
            if (!isset($value[$key])) {
                continue;
            }
            if (!is_array($value[$key])) {
                $invalid('invalid ' . $key);
            }
            foreach ($value[$key] as $name => $child) {
                self::assertPlan($child, "$path.$key.$name", $depth + 1);
            }
        }
        foreach (['element', 'exclude', 'includes'] as $key) {
            if (isset($value[$key])) {
                self::assertPlan($value[$key], "$path.$key", $depth + 1);
            }
        }
        if (isset($value['when'])) {
            if (!is_array($value['when'])) {
                $invalid('invalid conditional');
            }
            self::assertPlan($value['when']['test'] ?? null, "$path.when.test", $depth + 1);
            foreach (['then', 'else'] as $key) {
                if (isset($value['when'][$key])) {
                    self::assertPlan($value['when'][$key], "$path.when.$key", $depth + 1);
                }
            }
        }
        if (isset($value['extra']) && !is_bool($value['extra'])) {
            self::assertPlan($value['extra'], "$path.extra", $depth + 1);
        }
    }
    public static function fail(string $path, string $reason): never
    {
        throw new SdkError('validation', "$path: $reason");
    }
    public static function parse(string $text, bool $preserveNumbers = false): mixed
    {
        // This tree supplies token kinds only; rounded values are never returned.
        $original = json_decode($text, false, 512, JSON_THROW_ON_ERROR);
        $encoded = '';
        $quoted = false;
        $escaped = false;
        $length = strlen($text);
        for ($i = 0; $i < $length; ) {
            $c = $text[$i];
            if ($quoted) {
                $encoded .= $c;
                $i++;
                if ($escaped) {
                    $escaped = false;
                } elseif ($c === '\\') {
                    $escaped = true;
                } elseif ($c === '"') {
                    $quoted = false;
                }
                continue;
            }
            if ($c === '"') {
                $quoted = true;
                $encoded .= $c;
                $i++;
                continue;
            }
            if ($c === '-' || ctype_digit($c)) {
                preg_match(
                    '/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/',
                    substr($text, $i),
                    $matches,
                );
                $token = $matches[0];
                $safe =
                    preg_match('/^-?(?:0|[1-9]\d*)$/', $token) &&
                    abs((float) $token) <= 9007199254740991;
                $encoded .= $safe ? $token : json_encode($token, JSON_THROW_ON_ERROR);
                $i += strlen($token);
                continue;
            }
            $encoded .= $c;
            $i++;
        }
        $parsed = json_decode($encoded, false, 512, JSON_THROW_ON_ERROR | JSON_BIGINT_AS_STRING);
        return $preserveNumbers ? self::markNumbers($parsed, $original) : $parsed;
    }
    private static function markNumbers(mixed $value, mixed $original): mixed
    {
        if ((is_int($original) || is_float($original)) && is_string($value)) {
            return new ParsedNumber($value);
        }
        if (is_array($value)) {
            foreach ($value as $key => $child) {
                $value[$key] = self::markNumbers($child, $original[$key]);
            }
        } elseif (is_object($value)) {
            foreach ($value as $key => $child) {
                $value->{$key} = self::markNumbers($child, $original->{$key});
            }
        }
        return $value;
    }
    public static function plainNumbers(mixed $value): mixed
    {
        if ($value instanceof ParsedNumber) {
            return $value->value;
        }
        if (is_array($value)) {
            foreach ($value as $key => $child) {
                $value[$key] = self::plainNumbers($child);
            }
        } elseif (is_object($value)) {
            foreach ($value as $key => $child) {
                $value->{$key} = self::plainNumbers($child);
            }
        }
        return $value;
    }
    private static function integerToken(string $token, string $path): string
    {
        if (preg_match('/^-?(?:0|[1-9]\d*)$/', $token)) {
            return $token;
        }
        [$coefficient, $exponent] = array_pad(explode('e', strtolower($token)), 2, '0');
        $fraction = strlen(explode('.', $coefficient)[1] ?? '');
        $digits = ltrim(str_replace('.', '', ltrim($coefficient, '-')), '0');
        if ($digits === '') {
            return '0';
        }
        $shift = (float) $exponent - $fraction;
        if ($shift < 0) {
            if (
                -$shift >= strlen($digits) ||
                preg_match('/[1-9]/', substr($digits, (int) $shift))
            ) {
                self::fail($path, 'expected an integral JSON number');
            }
            $digits = substr($digits, 0, (int) $shift);
        } else {
            if ($shift > 10000) {
                self::fail($path, 'integer exponent expansion exceeds 10000 digits');
            }
            $digits .= str_repeat('0', (int) $shift);
        }
        return (str_starts_with($token, '-') ? '-' : '') . $digits;
    }
    private static function combine(mixed $left, mixed $right, string $path, mixed $source): mixed
    {
        if ($left instanceof ParsedNumber || $right instanceof ParsedNumber) {
            $token = $left instanceof ParsedNumber ? $left : $right;
            $other = $left instanceof ParsedNumber ? $right : $left;
            $text =
                $other instanceof ParsedNumber || $other instanceof RawNumber
                    ? $other->value
                    : (is_scalar($other)
                        ? (string) $other
                        : '');
            if (
                !preg_match('/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/', $text) ||
                self::compareDecimal($token->value, $text) !== 0
            ) {
                self::fail($path, 'alternatives have incompatible numeric representations');
            }
            return $other instanceof RawNumber ? new RawNumber($token->value) : $other;
        }
        if ($left instanceof RawNumber || $right instanceof RawNumber) {
            $token = $left instanceof RawNumber ? $left : $right;
            $other = $left instanceof RawNumber ? $right : $left;
            $text =
                $other instanceof RawNumber
                    ? $other->value
                    : (is_scalar($other)
                        ? (string) $other
                        : '');
            if (
                !preg_match('/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/', $text) ||
                self::compareDecimal($token->value, $text) !== 0
            ) {
                self::fail($path, 'alternatives have incompatible numeric representations');
            }
            return $token;
        }
        // The shared source view retains JSON numeric identity after branches
        // have decoded their tokens into public SDK strings.
        if (
            $source instanceof ParsedNumber &&
            is_string($left) &&
            is_string($right) &&
            $left !== $right
        ) {
            $pattern = '/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/';
            if (
                !preg_match($pattern, $left) ||
                !preg_match($pattern, $right) ||
                self::compareDecimal($source->value, $left) !== 0 ||
                self::compareDecimal($source->value, $right) !== 0
            ) {
                self::fail($path, 'alternatives have incompatible numeric representations');
            }
            return $source->value;
        }
        if ((is_array($left) || is_object($left)) && (is_array($right) || is_object($right))) {
            $a = (array) $left;
            $b = (array) $right;
            $out = [];
            $original = is_array($source) || is_object($source) ? (array) $source : [];
            foreach (array_unique(array_merge(array_keys($a), array_keys($b))) as $key) {
                $out[$key] =
                    array_key_exists($key, $a) && array_key_exists($key, $b)
                        ? self::combine($a[$key], $b[$key], "$path.$key", $original[$key] ?? null)
                        : (array_key_exists($key, $a)
                            ? $a[$key]
                            : $b[$key]);
            }
            return is_object($left) || is_object($right) ? (object) $out : $out;
        }
        if ($left === $right) {
            return $right;
        }
        if (is_int($left) && is_string($right) && (string) $left === $right) {
            return $right;
        }
        if (is_int($right) && is_string($left) && (string) $right === $left) {
            return $left;
        }
        self::fail($path, 'alternatives have incompatible representations');
    }
    private static function compareDecimal(string $left, string $right): int
    {
        $parts = static function (string $value): array {
            $tokens = explode('e', strtolower($value));
            $negative = str_starts_with($tokens[0], '-');
            $unsigned = ltrim($tokens[0], '-');
            $fraction = strlen(explode('.', $unsigned)[1] ?? '');
            $digits = ltrim(str_replace('.', '', $unsigned), '0');
            $exponent = max(-1000000000, min(1000000000, (float) ($tokens[1] ?? '0')));
            return [
                $digits === '' ? 0 : ($negative ? -1 : 1),
                $digits,
                (int) $exponent - $fraction + strlen($digits),
            ];
        };
        [$as, $ad, $ap] = $parts($left);
        [$bs, $bd, $bp] = $parts($right);
        if ($as !== $bs) {
            return $as <=> $bs;
        }
        if ($as === 0) {
            return 0;
        }
        if ($ap !== $bp) {
            return $as * ($ap <=> $bp);
        }
        $size = max(strlen($ad), strlen($bd));
        return $as * (strcmp(str_pad($ad, $size, '0'), str_pad($bd, $size, '0')) <=> 0);
    }
    private static function shiftedExponent(string $exponent, int $offset): string
    {
        $negative = str_starts_with($exponent, '-');
        $digits = ltrim($exponent, '+-0');
        if (strlen($digits) < 15) {
            return (string) ((int) $exponent + $offset);
        }
        $carry = $negative ? -$offset : $offset;
        for ($i = strlen($digits) - 1; $i >= 0 && $carry !== 0; $i--) {
            $sum = (int) $digits[$i] + $carry;
            $digit = (($sum % 10) + 10) % 10;
            $digits[$i] = (string) $digit;
            $carry = intdiv($sum - $digit, 10);
        }
        if ($carry > 0) {
            $digits = (string) $carry . $digits;
        }
        return ($negative ? '-' : '') . ltrim($digits, '0');
    }
    private static function jsonIdentity(mixed $value, int $depth = 0): string
    {
        if ($depth > 256) {
            self::fail('value', 'JSON equality exceeds nesting limit or contains a cycle');
        }
        if (
            $value instanceof ParsedNumber ||
            $value instanceof RawNumber ||
            is_int($value) ||
            is_float($value)
        ) {
            $text = is_object($value) ? $value->value : json_encode($value, JSON_THROW_ON_ERROR);
            $parts = explode('e', strtolower($text));
            $coefficient = $parts[0];
            $fraction = strlen(explode('.', $coefficient)[1] ?? '');
            $digits = ltrim(str_replace(['-', '.'], '', $coefficient), '0');
            $trimmed = rtrim($digits, '0');
            if ($trimmed === '') {
                return '["number","0"]';
            }
            return json_encode(
                [
                    'number',
                    (str_starts_with($coefficient, '-') ? '-' : '') . $trimmed,
                    self::shiftedExponent(
                        $parts[1] ?? '0',
                        -$fraction + strlen($digits) - strlen($trimmed),
                    ),
                ],
                JSON_THROW_ON_ERROR,
            );
        }
        if (is_array($value) && array_is_list($value)) {
            return json_encode(
                ['array', array_map(fn($child) => self::jsonIdentity($child, $depth + 1), $value)],
                JSON_THROW_ON_ERROR,
            );
        }
        if (is_object($value) || is_array($value)) {
            $fields = (array) $value;
            ksort($fields, SORT_STRING);
            $entries = [];
            foreach ($fields as $key => $child) {
                $entries[] = [(string) $key, self::jsonIdentity($child, $depth + 1)];
            }
            return json_encode(['object', $entries], JSON_THROW_ON_ERROR);
        }
        return json_encode([gettype($value), $value], JSON_THROW_ON_ERROR);
    }
    private static function decimalMultiple(string $token, string $divisor, string $path): bool
    {
        $parts = static function (string $text): array {
            $pieces = explode('e', strtolower($text));
            $coefficient = $pieces[0];
            $fraction = strlen(explode('.', $coefficient)[1] ?? '');
            $digits = ltrim(str_replace(['-', '.'], '', $coefficient), '0');
            $trimmed = rtrim($digits, '0');
            $power = max(-1000000000, min(1000000000, (float) ($pieces[1] ?? '0')));
            return [$trimmed, (int) $power - $fraction + strlen($digits) - strlen($trimmed)];
        };
        [$a, $ap] = $parts($token);
        [$b, $bp] = $parts($divisor);
        if ($a === '') {
            return true;
        }
        $shift = $ap - $bp;
        if ($shift < 0) {
            return false;
        }
        if ($b === '1') {
            return true;
        }
        if ($shift > 10000) {
            self::fail($path, 'multipleOf exponent expansion exceeds 10000 digits');
        }
        // Decimal long division avoids float, platform integer limits and extensions.
        $remainder = '';
        $input = $a . str_repeat('0', $shift);
        for ($i = 0; $i < strlen($input); $i++) {
            $remainder = ltrim($remainder . $input[$i], '0');
            while (
                strlen($remainder) > strlen($b) ||
                (strlen($remainder) === strlen($b) && strcmp($remainder, $b) >= 0)
            ) {
                $borrow = 0;
                $result = '';
                $offset = strlen($remainder) - strlen($b);
                for ($j = strlen($remainder) - 1; $j >= 0; $j--) {
                    $digit =
                        (int) $remainder[$j] -
                        ($j >= $offset ? (int) $b[$j - $offset] : 0) -
                        $borrow;
                    $borrow = $digit < 0 ? 1 : 0;
                    $result = (string) ($digit + 10 * $borrow) . $result;
                }
                $remainder = ltrim($result, '0');
            }
        }
        return $remainder === '';
    }
    private static function numericConstraints(
        string $token,
        array $s,
        string $path,
        bool $full = true,
    ): void {
        $range = $s['range'] ?? null;
        if (
            $range &&
            (self::compareDecimal($token, $range[0]) < 0 ||
                self::compareDecimal($token, $range[1]) > 0)
        ) {
            self::fail($path, 'value is outside the declared integer format range');
        }
        if (!$full) {
            return;
        }
        if (
            isset($s['checks']['multipleOf']) &&
            !self::decimalMultiple(
                $token,
                json_encode($s['checks']['multipleOf'], JSON_THROW_ON_ERROR),
                $path,
            )
        ) {
            self::fail($path, 'value violates multipleOf');
        }
        foreach (['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'] as $keyword) {
            if (!isset($s['checks'][$keyword])) {
                continue;
            }
            $order = self::compareDecimal(
                $token,
                json_encode($s['checks'][$keyword], JSON_THROW_ON_ERROR),
            );
            if (
                ($keyword === 'minimum' && $order < 0) ||
                ($keyword === 'maximum' && $order > 0) ||
                ($keyword === 'exclusiveMinimum' && $order <= 0) ||
                ($keyword === 'exclusiveMaximum' && $order >= 0)
            ) {
                self::fail($path, 'value violates ' . $keyword);
            }
        }
    }
    public static function normalize(
        mixed $value,
        array $s,
        string $path = 'input',
        bool $response = false,
        bool $matching = false,
        array $definitions = [],
        int $depth = 0,
        bool $validateConstraints = true,
        bool $allowUnknownResponseFields = false,
    ): mixed {
        if ($definitions && !isset($s['x-sdk-definitions'])) {
            $s['x-sdk-definitions'] = $definitions;
        }
        return self::executeValue(
            $value,
            \SdkNamespace\Internal\SchemaAdapter::compile($s),
            $path,
            $response,
            $matching,
            [],
            $depth,
            $validateConstraints,
            $allowUnknownResponseFields,
        );
    }
    public static function execute(mixed $value, array $plan, array $context = []): mixed
    {
        $mode = $context['mode'] ?? 'request';
        if (!in_array($mode, ['request', 'response', 'match'], true)) {
            throw new \InvalidArgumentException('Unknown codec execution mode');
        }
        return self::executeValue(
            $value,
            $plan,
            $context['path'] ?? 'input',
            ($context['direction'] ?? $mode) === 'response',
            $mode === 'match',
            $context['definitions'] ?? [],
            $context['depth'] ?? 0,
            $context['validateConstraints'] ?? true,
            $context['allowUnknownResponseFields'] ?? false,
        );
    }
    public static function wireKind(array $instruction): ?string
    {
        return match ($instruction['kind'] ?? null) {
            'dynamic' => null,
            'null-array' => 'null',
            'null', 'boolean', 'string', 'object', 'array' => $instruction['kind'],
            'safe-integer', 'exact-integer' => 'integer',
            'decimal' => 'number',
            'opaque' => $instruction['label'],
            default => throw new \InvalidArgumentException('Unknown codec instruction'),
        };
    }
    private static function exactValue(array $instruction): bool
    {
        return in_array($instruction['kind'], ['exact-integer', 'decimal'], true);
    }
    /** Shared selection policy for numeric interpretation and validation. */
    private static function selectAlternatives(
        mixed $value,
        array $s,
        string $keyword,
        string $path,
        bool $response,
        bool $matching,
        bool $allowUnknownResponseFields,
        callable $matches,
    ): array {
        $tolerateUnknownFields = $allowUnknownResponseFields;
        if ($keyword === 'exactlyOne' && isset($s['tag'])) {
            $tag = $s['tag'];
            $data = (array) $value;
            if (
                (!is_object($value) && !is_array($value)) ||
                !array_key_exists($tag, $data) ||
                !is_string($data[$tag])
            ) {
                self::fail($path, 'expected a string discriminator');
            }
            $selected = array_filter(
                $s[$keyword],
                fn($branch) => in_array(
                    $data[$tag],
                    $branch['tagValues'] ?? ($branch['fields'][$tag]['members'] ?? []),
                    true,
                ),
            );
        } else {
            // The closed anyOf set would be discarded by compatible selection.
            $selected =
                $keyword === 'some' && $response && (!$matching || $allowUnknownResponseFields)
                    ? []
                    : array_filter(
                        $s[$keyword],
                        fn($branch, $index) => $matches($branch, false, $index),
                        ARRAY_FILTER_USE_BOTH,
                    );
            // Prefer exact closed exactlyOne alternatives, then a unique
            // compatible branch. some retains every compatible branch.
            if (
                ($keyword === 'some' || !$selected) &&
                $response &&
                (!$matching || $allowUnknownResponseFields)
            ) {
                $compatible = array_filter(
                    $s[$keyword],
                    fn($branch, $index) => $matches($branch, true, $index),
                    ARRAY_FILTER_USE_BOTH,
                );
                if ($keyword === 'some' || count($compatible) === 1) {
                    $selected = $compatible;
                    $tolerateUnknownFields = true;
                }
            }
        }
        if (!$selected && $response && !$matching) {
            if (
                count(
                    array_filter(
                        $s[$keyword],
                        fn($branch) => $branch['objectOnlyAlternative'] ?? false,
                    ),
                ) === count($s[$keyword]) &&
                !is_object($value)
            ) {
                self::fail($path, 'expected an object response alternative');
            }
        } elseif (!$selected || ($keyword === 'exactlyOne' && count($selected) !== 1)) {
            self::fail(
                $path,
                $keyword === 'exactlyOne'
                    ? 'value must match exactly one alternative'
                    : 'value must match at least one alternative',
            );
        }
        return [$selected, $tolerateUnknownFields];
    }
    /** Search jointly only after independent union selection stalls. Numeric
     * declarations must belong to branches selected by the original unions.
     */
    private static function jointNumericView(
        mixed $value,
        array $unions,
        string $path,
        bool $response,
        bool $matching,
        int $depth,
        bool $allowUnknownResponseFields,
        \stdClass $budget,
    ): ?array {
        if (count($unions) < 2) {
            return null;
        }
        $convertible = function (mixed $child, int $level = 0) use (&$convertible, $path): bool {
            if ($level > 256) {
                self::fail($path, 'value exceeds supported nesting depth or contains a cycle');
            }
            if (is_string($child)) {
                return preg_match('/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/D', $child) === 1;
            }
            if ($child instanceof ParsedNumber || $child instanceof RawNumber) {
                return false;
            }
            if ($child instanceof Model) {
                $child = $child->toInputValue();
            }
            if (is_array($child) || is_object($child)) {
                foreach ((array) $child as $value) {
                    if ($convertible($value, $level + 1)) {
                        return true;
                    }
                }
            }
            return false;
        };
        if (!$convertible($value)) {
            return null;
        }
        // String-valued fields cannot change under a numeric hypothesis.
        $choices = [];
        foreach ($unions as [$codec, $definitions, $keyword]) {
            $choices[] = array_filter($codec[$keyword], function (array $branch) use (
                $value,
                $codec,
                $keyword,
                $definitions,
                $path,
                $response,
                $depth,
            ): bool {
                if (
                    ($keyword === 'exactlyOne' && isset($codec['tag'])) ||
                    (!is_object($value) && !is_array($value))
                ) {
                    return true;
                }
                $data = (array) $value;
                try {
                    foreach ($branch['fields'] ?? [] as $key => $field) {
                        if ($field['value']['kind'] === 'string' && array_key_exists($key, $data)) {
                            self::executeNode(
                                $data[$key],
                                $field,
                                "$path.$key",
                                $response,
                                true,
                                $branch['definitions'] ?? ($codec['definitions'] ?? $definitions),
                                $depth + 1,
                            );
                        }
                    }
                    return true;
                } catch (SdkError $e) {
                    if ($e->kind === 'validation') {
                        return false;
                    }
                    throw $e;
                }
            });
        }
        $groups = function (
            array $branches,
            bool $multiple,
            int $start = 0,
            array $prefix = [],
        ) use (&$groups): \Generator {
            $indices = array_keys($branches);
            for ($i = $start; $i < count($indices); $i++) {
                $key = $indices[$i];
                $selected = $prefix + [$key => $branches[$key]];
                yield $selected;
                if ($multiple) {
                    yield from $groups($branches, true, $i + 1, $selected);
                }
            }
        };
        $chosen = [];
        $search = function (int $index) use (
            &$search,
            &$chosen,
            $groups,
            $value,
            $unions,
            $choices,
            $path,
            $response,
            $matching,
            $depth,
            $allowUnknownResponseFields,
            $budget,
        ): ?array {
            if (isset($unions[$index])) {
                [$codec, $definitions, $keyword] = $unions[$index];
                foreach ($groups($choices[$index], $keyword === 'some') as $branches) {
                    $chosen[] = [$unions[$index], $branches];
                    $found = $search($index + 1);
                    array_pop($chosen);
                    if ($found !== null) {
                        return $found;
                    }
                }
                return null;
            }
            $remaining = $budget->remaining[$path] ?? 256;
            $budget->remaining[$path] = $remaining - 1;
            if ($remaining <= 0) {
                $budget->exhausted = true;
                self::fail($path, 'numeric interpretation exceeds 256 alternative combinations');
            }
            try {
                $scopes = [];
                foreach ($chosen as [[$codec, $definitions], $branches]) {
                    foreach ($branches as $branch) {
                        $scopes[] = [$branch, $definitions];
                    }
                }
                $candidate = self::numericView(
                    $value,
                    $scopes,
                    $path,
                    $response,
                    $matching,
                    $depth + 1,
                    $allowUnknownResponseFields,
                    $budget,
                );
                if (!self::numericViewChanged($value, $candidate)) {
                    return null;
                }
                foreach ($chosen as [[$codec, $definitions, $keyword], $branches]) {
                    $matches = function (array $branch, bool $allowUnknownFields) use (
                        $candidate,
                        $path,
                        $response,
                        $definitions,
                        $depth,
                    ): bool {
                        try {
                            self::executeNode(
                                $candidate,
                                $branch,
                                $path,
                                $response,
                                true,
                                $definitions,
                                $depth + 1,
                                true,
                                $allowUnknownFields,
                            );
                            return true;
                        } catch (SdkError $e) {
                            if ($e->kind === 'validation') {
                                return false;
                            }
                            throw $e;
                        }
                    };
                    [$selected] = self::selectAlternatives(
                        $candidate,
                        $codec,
                        $keyword,
                        $path,
                        $response,
                        $matching,
                        $allowUnknownResponseFields,
                        $matches,
                    );
                    if (array_diff_key($branches, $selected)) {
                        return null;
                    }
                    // Untagged branches were fully matched. Tagged branches
                    // leave other constraints to the caller's validation mode.
                }
                return ['value' => $candidate];
            } catch (SdkError $e) {
                if ($budget->exhausted || $e->kind !== 'validation') {
                    throw $e;
                }
                return null;
            }
        };
        return $search(0);
    }
    /** Detect newly established numeric meaning without walking unchanged subtrees. */
    private static function numericViewChanged(mixed $before, mixed $after, int $depth = 0): bool
    {
        if ($depth > 256 || (!is_array($before) && $before === $after)) {
            return false;
        }
        if ($after instanceof ParsedNumber) {
            return !($before instanceof ParsedNumber);
        }
        if (
            (!is_object($before) && !is_array($before)) ||
            (!is_object($after) && !is_array($after))
        ) {
            return false;
        }
        $previous = (array) $before;
        foreach ((array) $after as $key => $child) {
            if (self::numericViewChanged($previous[$key] ?? null, $child, $depth + 1)) {
                return true;
            }
        }
        return false;
    }
    /** Merge established numeric meaning without reinterpreting either branch. */
    private static function mergeNumericViews(mixed $left, mixed $right, int $depth = 0): mixed
    {
        if ($depth > 256) {
            self::fail(
                'value',
                'value exceeds the supported nesting depth (256) or contains a cycle',
            );
        }
        if ((!is_array($left) && $left === $right) || $left instanceof ParsedNumber) {
            return $left;
        }
        if ($right instanceof ParsedNumber) {
            return $right;
        }
        if ($left instanceof Model) {
            $left = $left->jsonSerialize();
        }
        if ($right instanceof Model) {
            $right = $right->jsonSerialize();
        }
        if ((!is_object($left) && !is_array($left)) || (!is_object($right) && !is_array($right))) {
            return $left;
        }
        $out = (array) $left;
        $other = (array) $right;
        foreach ($out as $key => $child) {
            $out[$key] = self::mergeNumericViews($child, $other[$key] ?? null, $depth + 1);
        }
        return is_object($left) ? (object) $out : $out;
    }
    /** Follow same-instance declarations with their reference registries. */
    private static function codecShapes(
        array $scopes,
        string $path,
        int $depth,
        ?callable $alternatives = null,
    ): array {
        $shapes = [];
        $collect = function (array $codec, array $definitions, int $level) use (
            &$collect,
            &$shapes,
            $path,
            $alternatives,
        ): void {
            if ($level > 256) {
                self::fail(
                    $path,
                    'value exceeds the supported nesting depth (256) or contains a cycle',
                );
            }
            $definitions = $codec['definitions'] ?? $definitions;
            if (isset($codec['reference'])) {
                $target = $definitions[$codec['reference']] ?? null;
                if ($target === null) {
                    self::fail($path, 'unresolved recursive model ' . $codec['reference']);
                }
                $collect($target, $definitions, $level + 1);
            } else {
                $shapes[] = [$codec, $definitions];
                foreach (
                    array_merge(
                        $codec['every'] ?? [],
                        $alternatives ? $alternatives($codec, $definitions) : [],
                    )
                    as $child
                ) {
                    $collect($child, $definitions, $level + 1);
                }
            }
        };
        foreach ($scopes as [$codec, $definitions]) {
            $collect($codec, $definitions, $depth);
        }
        return $shapes;
    }
    /** Reject numeric contributions from branches that no longer match. */
    private static function assertNumericSources(
        mixed $source,
        mixed $value,
        array $scopes,
        string $path,
        bool $response,
        bool $matching,
        int $depth,
        bool $allowUnknownResponseFields,
    ): void {
        if ($source instanceof Model) {
            $source = $source->jsonSerialize();
        }
        if (!self::numericViewChanged($source, $value)) {
            return;
        }
        $shapes = self::codecShapes($scopes, $path, $depth, function (
            array $codec,
            array $definitions,
        ) use ($value, $path, $response, $matching, $depth, $allowUnknownResponseFields): array {
            $branch = self::conditionalBranch(
                $value,
                $codec,
                $definitions,
                $path,
                $response,
                $depth,
            );
            $active = $branch === null ? [] : [$branch];
            foreach (['exactlyOne', 'some'] as $keyword) {
                if (!isset($codec[$keyword])) {
                    continue;
                }
                [$selected] = self::selectAlternatives(
                    $value,
                    $codec,
                    $keyword,
                    $path,
                    $response,
                    $matching,
                    $allowUnknownResponseFields,
                    function (array $branch, bool $allowUnknownFields) use (
                        $value,
                        $path,
                        $response,
                        $definitions,
                        $depth,
                    ): bool {
                        try {
                            self::executeNode(
                                $value,
                                $branch,
                                $path,
                                $response,
                                true,
                                $definitions,
                                $depth + 1,
                                true,
                                $allowUnknownFields,
                            );
                            return true;
                        } catch (SdkError $e) {
                            if ($e->kind === 'validation') {
                                return false;
                            }
                            throw $e;
                        }
                    },
                );
                array_push($active, ...array_values($selected));
            }
            return $active;
        });
        if ($value instanceof ParsedNumber) {
            foreach ($shapes as [$codec]) {
                if (self::exactValue($codec['value'])) {
                    return;
                }
            }
            self::fail($path, 'numeric interpretation depends on an unmatched alternative');
        }
        if (!is_array($value) && !is_object($value)) {
            return;
        }
        $original = is_array($source) || is_object($source) ? (array) $source : [];
        $list = is_array($value) && array_is_list($value);
        foreach ((array) $value as $key => $child) {
            $children = [];
            foreach ($shapes as [$codec, $definitions]) {
                $field = $list
                    ? $codec['element'] ?? null
                    : $codec['fields'][$key] ??
                        (is_array($codec['extra'] ?? null) ? $codec['extra'] : null);
                if ($field !== null) {
                    $children[] = [$field, $definitions];
                }
            }
            self::assertNumericSources(
                $original[$key] ?? null,
                $child,
                $children,
                $list ? $path . '[' . $key . ']' : "$path.$key",
                $response,
                $matching,
                $depth + 1,
                $allowUnknownResponseFields,
            );
        }
    }
    /** Resolve exact SDK strings to JSON numbers before applying any conjunct.
     * Named schemas are followed along the finite value, never expanded globally.
     * Each scope carries its own registry, including during alternative matching.
     */
    private static function numericView(
        mixed $value,
        array $scopes,
        string $path,
        bool $response,
        bool $matching,
        int $depth,
        bool $allowUnknownResponseFields,
        \stdClass $budget,
        ?array $previous = null,
    ): mixed {
        if (!$scopes) {
            return $value;
        }
        // A previously matched view can be reused wherever numeric meaning did
        // not change. Keep the same scopes and direction policy on refinement.
        if ($previous !== null && !self::numericViewChanged($previous['value'], $value)) {
            return $value;
        }
        $previousChildren =
            $previous !== null && (is_object($previous['value']) || is_array($previous['value']))
                ? (array) $previous['value']
                : null;
        if ($budget->exhausted) {
            self::fail($path, 'numeric interpretation exceeds 256 alternative combinations');
        }
        if ($depth > 256) {
            self::fail(
                $path,
                'value exceeds the supported nesting depth (256) or contains a cycle',
            );
        }
        if ($value instanceof Model) {
            $value = $value->toInputValue();
        }
        $shapes = self::codecShapes($scopes, $path, $depth);
        if (is_string($value)) {
            foreach ($shapes as [$codec]) {
                $pattern =
                    $codec['value']['kind'] === 'exact-integer'
                        ? '/^-?(?:0|[1-9]\d*)$/'
                        : '/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/';
                if (
                    self::exactValue($codec['value']) &&
                    ($codec['numberInput'] ?? null) !== 'explicit' &&
                    preg_match($pattern, $value)
                ) {
                    $value = new ParsedNumber($value);
                    break;
                }
            }
        }
        if (is_array($value) && array_is_list($value)) {
            $children = [];
            foreach ($shapes as [$codec, $definitions]) {
                if (isset($codec['element'])) {
                    $children[] = [$codec['element'], $definitions];
                }
            }
            if ($children) {
                $value = array_map(
                    fn($child, $index) => self::numericView(
                        $child,
                        $children,
                        $path . '[' . $index . ']',
                        $response,
                        $matching,
                        $depth + 1,
                        $allowUnknownResponseFields,
                        $budget,
                        $previousChildren !== null
                            ? ['value' => $previousChildren[$index] ?? null]
                            : null,
                    ),
                    $value,
                    array_keys($value),
                );
            }
        } elseif ((is_object($value) && !($value instanceof ParsedNumber)) || is_array($value)) {
            $out = [];
            foreach ((array) $value as $key => $child) {
                $children = [];
                foreach ($shapes as [$codec, $definitions]) {
                    $field =
                        $codec['fields'][$key] ??
                        (is_array($codec['extra'] ?? null) ? $codec['extra'] : null);
                    if ($field !== null) {
                        $children[] = [$field, $definitions];
                    }
                }
                $out[$key] = self::numericView(
                    $child,
                    $children,
                    "$path.$key",
                    $response,
                    $matching,
                    $depth + 1,
                    $allowUnknownResponseFields,
                    $budget,
                    $previousChildren !== null
                        ? ['value' => $previousChildren[$key] ?? null]
                        : null,
                );
            }
            $value = is_object($value) ? (object) $out : $out;
        }
        $unions = [];
        foreach ($shapes as [$codec, $definitions]) {
            foreach (['exactlyOne', 'some'] as $keyword) {
                if (isset($codec[$keyword])) {
                    $unions[] = [$codec, $definitions, $keyword];
                }
            }
        }
        $pending = $unions;
        // Constraint-only unions may depend on numeric declarations in later
        // conjuncts. Productive passes remove selections; if none can progress,
        // retain the failure instead of returning a partially interpreted value.
        while ($pending) {
            $before = $value;
            $deferred = [];
            $failure = null;
            foreach ($pending as $scope) {
                [$codec, $definitions, $keyword] = $scope;
                try {
                    $candidates = [];
                    $matches = function (array $branch, bool $allowUnknownFields, int $index) use (
                        &$candidates,
                        $value,
                        $definitions,
                        $path,
                        $response,
                        $depth,
                        $budget,
                    ): bool {
                        try {
                            $candidate = self::numericView(
                                $value,
                                [[$branch, $definitions]],
                                $path,
                                $response,
                                true,
                                $depth + 1,
                                $allowUnknownFields,
                                $budget,
                            );
                            self::executeNode(
                                $candidate,
                                $branch,
                                $path,
                                $response,
                                true,
                                $definitions,
                                $depth + 1,
                                true,
                                $allowUnknownFields,
                            );
                            $candidates[$index] = $candidate;
                            return true;
                        } catch (SdkError $e) {
                            if ($e->kind === 'validation') {
                                return false;
                            }
                            throw $e;
                        }
                    };
                    [$selected, $tolerateUnknownFields] = self::selectAlternatives(
                        $value,
                        $codec,
                        $keyword,
                        $path,
                        $response,
                        $matching,
                        $allowUnknownResponseFields,
                        $matches,
                    );
                    if (!$selected) {
                        $deferred[] = $scope;
                        continue;
                    }
                    // Reuse all matched views, refining only the subtrees where
                    // another branch supplied additional numeric meaning.
                    if (!array_diff_key($selected, $candidates)) {
                        foreach ($selected as $index => $branch) {
                            $value = self::mergeNumericViews($value, $candidates[$index]);
                        }
                        do {
                            $beforeRefinement = $value;
                            foreach ($selected as $index => $branch) {
                                $candidate = $candidates[$index];
                                if (!self::numericViewChanged($candidate, $value)) {
                                    continue;
                                }
                                $refined = self::numericView(
                                    $value,
                                    [[$branch, $definitions]],
                                    $path,
                                    $response,
                                    true,
                                    $depth + 1,
                                    $tolerateUnknownFields,
                                    $budget,
                                    ['value' => $candidate],
                                );
                                $candidates[$index] = $refined;
                                $value = self::mergeNumericViews($value, $refined);
                            }
                        } while (self::numericViewChanged($beforeRefinement, $value));
                    } else {
                        $value = self::numericView(
                            $value,
                            array_map(fn($branch) => [$branch, $definitions], $selected),
                            $path,
                            $response,
                            $matching,
                            $depth + 1,
                            $tolerateUnknownFields,
                            $budget,
                        );
                    }
                } catch (SdkError $e) {
                    if ($e->kind !== 'validation') {
                        throw $e;
                    }
                    $failure ??= $e;
                    $deferred[] = $scope;
                }
            }
            // Later conjuncts can make additional branches of an earlier anyOf
            // compatible. Revisit selections only when numeric meaning changes.
            if (count($unions) > 1 && self::numericViewChanged($before, $value)) {
                $pending = $unions;
                continue;
            }
            if (count($deferred) === count($pending)) {
                $joint = self::jointNumericView(
                    $value,
                    $unions,
                    $path,
                    $response,
                    $matching,
                    $depth,
                    $allowUnknownResponseFields,
                    $budget,
                );
                if ($joint !== null) {
                    $value = $joint['value'];
                    $pending = $unions;
                    continue;
                }
                if ($failure !== null) {
                    throw $failure;
                }
                break;
            }
            $pending = $deferred;
        }
        if ($budget->exhausted) {
            self::fail($path, 'numeric interpretation exceeds 256 alternative combinations');
        }
        foreach ($shapes as [$codec, $definitions]) {
            $branch = self::conditionalBranch(
                $value,
                $codec,
                $definitions,
                $path,
                $response,
                $depth,
            );
            if ($branch !== null) {
                $value = self::numericView(
                    $value,
                    [[$branch, $definitions]],
                    $path,
                    $response,
                    $matching,
                    $depth + 1,
                    $allowUnknownResponseFields,
                    $budget,
                );
            }
        }
        return $value;
    }
    private static function conditionalBranch(
        mixed $value,
        array $codec,
        array $definitions,
        string $path,
        bool $response,
        int $depth,
    ): ?array {
        if (!isset($codec['when'])) {
            return null;
        }
        try {
            self::executeNode(
                $value,
                $codec['when']['test'],
                $path,
                $response,
                true,
                $definitions,
                $depth + 1,
                true,
                false,
            );
            return $codec['when']['then'] ?? null;
        } catch (SdkError $error) {
            if ($error->kind !== 'validation') {
                throw $error;
            }
            return $codec['when']['else'] ?? null;
        }
    }
    private static function executeValue(
        mixed $value,
        array $s,
        string $path = 'input',
        bool $response = false,
        bool $matching = false,
        array $definitions = [],
        int $depth = 0,
        bool $validateConstraints = true,
        bool $allowUnknownResponseFields = false,
    ): mixed {
        $scopes = [[$s, $definitions]];
        $interpreted = self::numericView(
            $value,
            $scopes,
            $path,
            $response,
            $matching,
            $depth,
            $allowUnknownResponseFields,
            (object) ['remaining' => [], 'exhausted' => false],
        );
        self::assertNumericSources(
            $value,
            $interpreted,
            $scopes,
            $path,
            $response,
            $matching,
            $depth,
            $allowUnknownResponseFields,
        );
        return self::executeNode(
            $interpreted,
            $s,
            $path,
            $response,
            $matching,
            $definitions,
            $depth,
            $validateConstraints,
            $allowUnknownResponseFields,
        );
    }
    private static function executeNode(
        mixed $value,
        array $s,
        string $path = 'input',
        bool $response = false,
        bool $matching = false,
        array $definitions = [],
        int $depth = 0,
        bool $validateConstraints = true,
        bool $allowUnknownResponseFields = false,
    ): mixed {
        if ($depth > 256) {
            self::fail(
                $path,
                'value exceeds the supported nesting depth (256) or contains a cycle',
            );
        }
        $validateConstraints = isset($s['constraints']) ? $s['constraints'] : $validateConstraints;
        if (
            (!$response || $matching) &&
            isset($s['literal']) &&
            self::jsonIdentity($value) !== self::jsonIdentity(self::parse($s['literal'], true))
        ) {
            self::fail($path, 'value is outside the declared const');
        }
        $definitions = $s['definitions'] ?? $definitions;
        if (isset($s['reference'])) {
            $target = $definitions[$s['reference']] ?? null;
            if ($target === null) {
                self::fail($path, 'unresolved recursive model ' . $s['reference']);
            }
            return self::executeNode(
                $value,
                $target,
                $path,
                $response,
                $matching,
                $definitions,
                $depth + 1,
                $validateConstraints,
                $allowUnknownResponseFields,
            );
        }
        if ($value instanceof Model) {
            $value = $value->toInputValue();
        }
        self::wireKind($s['value']);
        if (
            isset($s['every']) ||
            isset($s['some']) ||
            isset($s['exactlyOne']) ||
            isset($s['exclude']) ||
            isset($s['when'])
        ) {
            $base = array_diff_key(
                $s,
                array_flip(['every', 'some', 'exactlyOne', 'exclude', 'tag', 'when']),
            );
            $result = self::executeNode(
                $value,
                $base,
                $path,
                $response,
                $matching,
                $definitions,
                $depth + 1,
                $validateConstraints,
                $allowUnknownResponseFields,
            );
            // A successful match already executed the complete branch. Reuse
            // it only in matching mode, with the same unknown-field policy.
            $matched = [];
            $matches = function ($branch, bool $allowUnknownFields) use (
                &$matched,
                $value,
                $path,
                $response,
                $definitions,
                $depth,
                $validateConstraints,
            ) {
                try {
                    $result = self::executeNode(
                        $value,
                        $branch,
                        $path,
                        $response,
                        true,
                        $definitions,
                        $depth + 1,
                        $validateConstraints,
                        $allowUnknownFields,
                    );
                    $matched[] = [$branch, $allowUnknownFields, $result];
                    return true;
                } catch (SdkError $e) {
                    if ($e->kind === 'validation') {
                        return false;
                    }
                    throw $e;
                }
            };
            if (isset($s['exclude']) && $matches($s['exclude'], false)) {
                self::fail($path, 'value matches a forbidden combination');
            }
            $conditional = self::conditionalBranch(
                $value,
                $s,
                $definitions,
                $path,
                $response,
                $depth,
            );
            foreach (
                array_merge($s['every'] ?? [], $conditional === null ? [] : [$conditional])
                as $branch
            ) {
                $result = self::combine(
                    $result,
                    self::executeNode(
                        $value,
                        $branch,
                        $path,
                        $response,
                        $matching,
                        $definitions,
                        $depth + 1,
                        $validateConstraints,
                        $allowUnknownResponseFields,
                    ),
                    $path,
                    $value,
                );
            }
            foreach (['exactlyOne', 'some'] as $keyword) {
                if (!isset($s[$keyword])) {
                    continue;
                }
                [$selected, $tolerateUnknownFields] = self::selectAlternatives(
                    $value,
                    $s,
                    $keyword,
                    $path,
                    $response,
                    $matching,
                    $allowUnknownResponseFields,
                    $matches,
                );
                foreach ($selected as $branch) {
                    $reused = false;
                    if ($matching) {
                        foreach ($matched as [$candidate, $allowUnknownFields, $candidateResult]) {
                            if (
                                $candidate === $branch &&
                                $allowUnknownFields === $tolerateUnknownFields
                            ) {
                                $branchResult = $candidateResult;
                                $reused = true;
                                break;
                            }
                        }
                    }
                    if (!$reused) {
                        $branchResult = self::executeNode(
                            $value,
                            $branch,
                            $path,
                            $response,
                            $matching,
                            $definitions,
                            $depth + 1,
                            $validateConstraints,
                            $tolerateUnknownFields,
                        );
                    }
                    $result = self::combine($result, $branchResult, $path, $value);
                }
            }
            return $result;
        }
        $type = self::wireKind($s['value']);
        if ($value === null) {
            if (
                (!$response || $matching) &&
                isset($s['members']) &&
                !in_array(null, $s['members'], true)
            ) {
                self::fail($path, 'null is outside the declared enum');
            }
            if ($s['nullable']) {
                return null;
            }
            self::fail($path, 'null is not permitted');
        }
        // Positive declarations establish numeric meaning before matching.
        // A negative branch must not reinterpret remaining JSON strings.
        if (
            ($matching || (!$response && ($s['numberInput'] ?? null) === 'explicit')) &&
            self::exactValue($s['value']) &&
            is_string($value)
        ) {
            self::fail($path, "expected $type; received a JSON string");
        }
        if ($value instanceof ParsedNumber) {
            if ($type === null) {
                if (
                    (!$response || $matching) &&
                    isset($s['members']) &&
                    !array_filter(
                        $s['members'],
                        fn($v) => is_int($v) &&
                            self::compareDecimal($value->value, (string) $v) === 0,
                    )
                ) {
                    self::fail($path, 'value is outside the declared enum');
                }
                if (!$response || $matching) {
                    self::numericConstraints(
                        $value->value,
                        $s,
                        $path,
                        $validateConstraints || $matching,
                    );
                }
                return $response ? $value : new RawNumber($value->value);
            }
            if ($type === 'integer') {
                $token = self::integerToken($value->value, $path);
                $value = self::exactValue($s['value']) ? $token : (int) $token;
            } elseif ($type === 'number') {
                $value = $value->value;
            } else {
                self::fail($path, "expected $type; received a JSON number");
            }
        }
        $exactEnum = self::exactValue($s['value']);
        if (
            (!$response || $matching) &&
            isset($s['members']) &&
            !($exactEnum
                ? (is_string($value) || is_int($value)) &&
                    preg_match(
                        '/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/',
                        (string) $value,
                    ) &&
                    array_filter(
                        $s['members'],
                        fn($member) => is_int($member) &&
                            self::compareDecimal((string) $value, (string) $member) === 0,
                    )
                : in_array($value, $s['members'], true))
        ) {
            self::fail($path, 'value is outside the declared enum');
        }
        if ($type === 'integer' || $type === 'number') {
            if (self::exactValue($s['value'])) {
                $token = is_int($value) ? (string) $value : $value;
                $pattern =
                    $type === 'integer'
                        ? '/^-?(?:0|[1-9]\d*)$/'
                        : '/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/';
                if (!is_string($token) || !preg_match($pattern, $token)) {
                    self::fail($path, 'expected an exact numeric string');
                }
                if (!$response || $matching) {
                    self::numericConstraints($token, $s, $path, $validateConstraints || $matching);
                }
                return $response ? $token : new RawNumber($token);
            }
            if (!is_int($value) || abs($value) > 9007199254740991) {
                self::fail($path, 'expected a safe integer; declare int64 for larger values');
            }
            if (!$response || $matching) {
                self::numericConstraints(
                    (string) $value,
                    $s,
                    $path,
                    $validateConstraints || $matching,
                );
            }
            return $value;
        }
        if ($type === 'null') {
            self::fail($path, 'expected null');
        }
        if (
            $type === 'object' ||
            ($type === null &&
                (is_object($value) ||
                    (is_array($value) &&
                        (!array_is_list($value) || (!$value && $s['modelObjectInput'])))))
        ) {
            if (
                !is_object($value) &&
                (!is_array($value) ||
                    $response ||
                    (array_is_list($value) && ($value !== [] || $matching)))
            ) {
                self::fail($path, 'expected an object');
            }
            $data = (array) $value;
            foreach ($response ? $s['requiredOutput'] : $s['requiredInput'] as $key) {
                if (!array_key_exists($key, $data)) {
                    self::fail("$path.$key", 'required field is missing');
                }
            }
            $out = new \stdClass();
            foreach ($data as $key => $v) {
                if (isset($s['fields'][$key])) {
                    if (!$response && ($s['fields'][$key]['rejectInput'] ?? false)) {
                        self::fail("$path.$key", 'readOnly fields cannot be sent');
                    }
                    $out->{$key} = self::executeNode(
                        $v,
                        $s['fields'][$key],
                        "$path.$key",
                        $response,
                        $matching,
                        $definitions,
                        $depth + 1,
                        $validateConstraints,
                        $allowUnknownResponseFields,
                    );
                } elseif (
                    (!$response || ($matching && !$allowUnknownResponseFields)) &&
                    ($s['extra'] ?? true) === false
                ) {
                    self::fail("$path.$key", 'unknown request field');
                } elseif (is_array($s['extra'] ?? null)) {
                    $out->{$key} = self::executeNode(
                        $v,
                        $s['extra'],
                        "$path.$key",
                        $response,
                        $matching,
                        $definitions,
                        $depth + 1,
                        $validateConstraints,
                        $allowUnknownResponseFields,
                    );
                } else {
                    $out->{$key} = $v;
                }
            }
            if ((!$response || $matching) && ($validateConstraints || $matching)) {
                $count = count((array) $out);
                if (
                    isset($s['checks']['minProperties']) &&
                    $count < $s['checks']['minProperties']
                ) {
                    self::fail($path, 'object violates minProperties');
                }
                if (
                    isset($s['checks']['maxProperties']) &&
                    $count > $s['checks']['maxProperties']
                ) {
                    self::fail($path, 'object violates maxProperties');
                }
            }
            return $out;
        }
        if ($type === 'array' || ($type === null && is_array($value) && array_is_list($value))) {
            if (!is_array($value) || !array_is_list($value)) {
                self::fail($path, 'expected an array');
            }
            if ((!$response || $matching) && ($validateConstraints || $matching)) {
                if (isset($s['checks']['minItems']) && count($value) < $s['checks']['minItems']) {
                    self::fail($path, 'array violates minItems');
                }
                if (isset($s['checks']['maxItems']) && count($value) > $s['checks']['maxItems']) {
                    self::fail($path, 'array violates maxItems');
                }
                if ($s['checks']['uniqueItems'] ?? false) {
                    $seen = [];
                    foreach ($value as $item) {
                        $key = self::jsonIdentity($item);
                        if (isset($seen[$key])) {
                            self::fail($path, 'array violates uniqueItems');
                        }
                        $seen[$key] = true;
                    }
                }
                if (isset($s['includes'])) {
                    $found = false;
                    foreach ($value as $index => $child) {
                        try {
                            self::executeNode(
                                $child,
                                $s['includes'],
                                "$path.$index",
                                $response,
                                true,
                                $definitions,
                                $depth + 1,
                                true,
                                false,
                            );
                            $found = true;
                            break;
                        } catch (SdkError $error) {
                            if ($error->kind !== 'validation') {
                                throw $error;
                            }
                        }
                    }
                    if (!$found) {
                        self::fail($path, 'array violates contains');
                    }
                }
            }
            return array_map(
                fn($v) => self::executeNode(
                    $v,
                    $s['element'] ?? self::ANY_CODEC,
                    "{$path}[]",
                    $response,
                    $matching,
                    $definitions,
                    $depth + 1,
                    $validateConstraints,
                    $allowUnknownResponseFields,
                ),
                $value,
            );
        }
        if ($type === 'string' && !is_string($value)) {
            self::fail($path, 'expected a string');
        }
        if (is_string($value) && (!$response || $matching)) {
            $length = preg_match_all('/./us', $value);
            if ($length === false) {
                self::fail($path, 'expected well-formed Unicode');
            }
            if ($validateConstraints || $matching) {
                if (isset($s['checks']['minLength']) && $length < $s['checks']['minLength']) {
                    self::fail($path, 'string violates minLength');
                }
                if (isset($s['checks']['maxLength']) && $length > $s['checks']['maxLength']) {
                    self::fail($path, 'string violates maxLength');
                }
                if (isset($s['checks']['pattern'])) {
                    $pattern = $s['phpPattern'];
                    if (preg_match($pattern, $value) !== 1) {
                        self::fail($path, 'string violates pattern');
                    }
                }
            }
        }
        if ($type === null && is_int($value) && (!$response || $matching)) {
            self::numericConstraints((string) $value, $s, $path, $validateConstraints || $matching);
        }
        if ($type === 'boolean' && !is_bool($value)) {
            self::fail($path, 'expected a boolean');
        }
        return $value;
    }
    public static function encode(mixed $value, int $depth = 0): string
    {
        if ($depth > 256) {
            self::fail('value', 'value exceeds the supported nesting depth or contains a cycle');
        }
        if ($value instanceof RawNumber) {
            return $value->value;
        }
        if ($value instanceof Model) {
            $value = $value->toInputValue();
        }
        if (is_float($value) || (is_int($value) && abs($value) > 9007199254740991)) {
            self::fail('value', 'use exact numeric strings with a declared schema');
        }
        if (is_array($value) && array_is_list($value)) {
            return '[' .
                implode(',', array_map(fn($v) => self::encode($v, $depth + 1), $value)) .
                ']';
        }
        if (is_object($value) || is_array($value)) {
            $pairs = [];
            foreach ((array) $value as $k => $v) {
                $pairs[] =
                    json_encode(
                        (string) $k,
                        JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES,
                    ) .
                    ':' .
                    self::encode($v, $depth + 1);
            }
            return '{' . implode(',', $pairs) . '}';
        }
        return json_encode(
            $value,
            JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES,
        );
    }
    public static function redact(
        mixed $value,
        array $schema = [],
        array $fields = [],
        array $definitions = [],
        int $depth = 0,
    ): mixed {
        if ($definitions && !isset($schema['x-sdk-definitions'])) {
            $schema['x-sdk-definitions'] = $definitions;
        }
        return self::redactPlan(
            $value,
            \SdkNamespace\Internal\SchemaAdapter::compile($schema),
            $fields,
            [],
            $depth,
        );
    }
    public static function redactPlan(
        mixed $value,
        array $schema = [],
        array $fields = [],
        array $definitions = [],
        int $depth = 0,
    ): mixed {
        if ($depth > 256) {
            return '[Nesting limit]';
        }
        $definitions = $schema['definitions'] ?? $definitions;
        $shapes = function ($s) use (&$shapes, $definitions) {
            if (isset($s['reference'])) {
                return isset($definitions[$s['reference']])
                    ? $shapes($definitions[$s['reference']])
                    : [];
            }
            $out = [$s];
            foreach (['then', 'else'] as $key) {
                if (isset($s['when'][$key])) {
                    $out = array_merge($out, $shapes($s['when'][$key]));
                }
            }
            foreach (['every', 'exactlyOne', 'some'] as $key) {
                foreach ($s[$key] ?? [] as $branch) {
                    $out = array_merge($out, $shapes($branch));
                }
            }
            return $out;
        };
        $schemas = $shapes($schema);
        foreach ($schemas as $shape) {
            if ($shape['sensitive'] ?? false) {
                return '[REDACTED]';
            }
        }
        if (is_array($value) && array_is_list($value)) {
            $items = array_values(
                array_filter(
                    array_map(fn($s) => $s['element'] ?? null, $schemas),
                    fn($s) => $s !== null,
                ),
            );
            return array_map(
                fn($v) => self::redactPlan(
                    $v,
                    ['every' => $items],
                    $fields,
                    $definitions,
                    $depth + 1,
                ),
                $value,
            );
        }
        if (is_object($value) || is_array($value)) {
            $out = new \stdClass();
            foreach ((array) $value as $k => $v) {
                $out->{$k} =
                    in_array((string) $k, $fields, true) ||
                    preg_match('/authorization|token|secret|password|api.?key/i', (string) $k)
                        ? '[REDACTED]'
                        : self::redactPlan(
                            $v,
                            [
                                'every' => array_values(
                                    array_filter(
                                        array_map(
                                            fn($s) => $s['fields'][$k] ??
                                                (is_array($s['extra'] ?? null)
                                                    ? $s['extra']
                                                    : null),
                                            $schemas,
                                        ),
                                        fn($s) => $s !== null,
                                    ),
                                ),
                            ],
                            $fields,
                            $definitions,
                            $depth + 1,
                        );
            }
            return $out;
        }
        return $value;
    }
}
class Runtime
{
    private array $allowed;
    protected readonly array $contract;
    private mixed $curl = null;
    private array $streams = [];
    public function __construct(
        array $contract,
        private readonly ClientOptions $options,
        bool $compiled = false,
    ) {
        if (
            parse_url($options->baseUrl, PHP_URL_QUERY) !== null ||
            preg_match('/[\\\\\r\n]/', $options->baseUrl)
        ) {
            Codec::fail('baseUrl', 'base URL must not contain a query or backslash');
        }
        $this->contract = $compiled
            ? $contract
            : \SdkNamespace\Internal\SchemaAdapter::runtimePlan($contract);
        if (
            ($this->contract['format'] ?? null) !== 1 ||
            !is_string($this->contract['semantics'] ?? null)
        ) {
            throw new \InvalidArgumentException('Unsupported compiled runtime format');
        }
        if (!is_array($this->contract['operations'] ?? null)) {
            throw new \InvalidArgumentException('Missing compiled operations');
        }
        foreach ($this->contract['authShortcuts'] ?? [] as $name => $shortcut) {
            $schemes = $this->contract['authentication'][$shortcut['mode'] ?? '']['schemes'] ?? [];
            if (
                !preg_match('/^[a-z][a-zA-Z0-9]*$/', $name) ||
                count($schemes) !== 1 ||
                ($schemes[0]['name'] ?? null) !== ($shortcut['scheme'] ?? null)
            ) {
                throw new \InvalidArgumentException('Invalid authentication shortcut');
            }
        }
        if (isset($this->contract['authentication'])) {
            if (!is_array($this->contract['authentication'])) {
                throw new \InvalidArgumentException('Invalid authentication modes');
            }
            foreach ($this->contract['authentication'] as $mode) {
                if (!is_array($mode['schemes'] ?? null) || !$mode['schemes']) {
                    throw new \InvalidArgumentException('Invalid authentication mode');
                }
                $destinations = [];
                foreach ($mode['schemes'] as $scheme) {
                    if (
                        !is_string($scheme['name'] ?? null) ||
                        !is_string($scheme['header'] ?? null) ||
                        !in_array($scheme['type'] ?? null, ['bearer', 'apiKey'], true)
                    ) {
                        throw new \InvalidArgumentException('Invalid authentication scheme');
                    }
                    $header = strtolower($scheme['header']);
                    if (isset($destinations[$header])) {
                        throw new \InvalidArgumentException(
                            'Conflicting authentication destinations',
                        );
                    }
                    $destinations[$header] = true;
                }
            }
        }
        if (isset($this->contract['incoming'])) {
            if (!is_array($this->contract['incoming'])) {
                throw new \InvalidArgumentException('Invalid incoming contracts');
            }
            foreach ($this->contract['incoming'] as $entry) {
                foreach (['name', 'method', 'pointer', 'model'] as $key) {
                    if (!is_string($entry[$key] ?? null)) {
                        throw new \InvalidArgumentException('Invalid incoming ' . $key);
                    }
                }
                if (isset($entry['schema'])) {
                    throw new \InvalidArgumentException('Raw schema in incoming contract');
                }
                Codec::assertPlan($entry['codec'] ?? null, 'incoming.' . $entry['name']);
            }
        }
        foreach ($this->contract['operations'] as $op) {
            if (isset($op['authModes'])) {
                if (!is_array($op['authModes'])) {
                    throw new \InvalidArgumentException('Invalid operation authentication modes');
                }
                foreach ($op['authModes'] as $name) {
                    if (!is_string($name) || !isset($this->contract['authentication'][$name])) {
                        throw new \InvalidArgumentException(
                            'Invalid operation authentication mode',
                        );
                    }
                }
            }
            if (
                !is_array($op) ||
                !is_string($op['id'] ?? null) ||
                !is_string($op['path'] ?? null) ||
                !is_string($op['verb'] ?? null) ||
                !is_array($op['parameters'] ?? null) ||
                !is_array($op['responses'] ?? null)
            ) {
                throw new \InvalidArgumentException('Invalid compiled operation');
            }
            foreach ($op['parameters'] as $parameter) {
                Codec::assertPlan($parameter['codec'], $op['id'] . '.parameter');
            }
            if (isset($op['body'])) {
                Codec::assertPlan($op['body'], $op['id'] . '.body');
            }
            if (isset($op['streamEventSchemas'])) {
                throw new \InvalidArgumentException('Raw stream schemas');
            }
            foreach ($op['streamEventCodecs'] ?? [] as $event => $codec) {
                Codec::assertPlan($codec, 'stream.' . $event);
            }
            foreach (['idleTimeoutMs', 'maxEventBytes'] as $key) {
                if (
                    isset($op['stream'][$key]) &&
                    (!is_int($op['stream'][$key]) || $op['stream'][$key] <= 0)
                ) {
                    throw new \InvalidArgumentException('Invalid stream limits');
                }
            }
            foreach ($op['responses'] as $status => $response) {
                if (
                    ($response['bodyKind'] ?? null) === 'sse' &&
                    (isset($response['codec']) ||
                        ($response['mediaType'] ?? null) !== 'text/event-stream')
                ) {
                    throw new \InvalidArgumentException('Invalid SSE descriptor');
                }
                if (
                    isset($response['bodyKind']) &&
                    !in_array($response['bodyKind'], ['empty', 'json', 'binary', 'sse'], true)
                ) {
                    throw new \InvalidArgumentException('Unsupported response body kind');
                }
                if (
                    isset($response['classification']) &&
                    !in_array($response['classification'], ['success', 'error', 'redirect'], true)
                ) {
                    throw new \InvalidArgumentException('Unsupported response classification');
                }
                if (
                    ($response['classification'] ?? null) === 'redirect' &&
                    !in_array((string) $status, ['302', '307'], true)
                ) {
                    throw new \InvalidArgumentException('Invalid redirect status');
                }
                if (
                    isset($response['locationRequired']) &&
                    !is_bool($response['locationRequired'])
                ) {
                    throw new \InvalidArgumentException('Invalid Location requirement');
                }
                if (($response['bodyKind'] ?? null) === 'json' && !isset($response['codec'])) {
                    throw new \InvalidArgumentException('Missing JSON response codec');
                }
                if (
                    ($response['bodyKind'] ?? null) === 'binary' &&
                    (isset($response['codec']) ||
                        ($response['mediaType'] ?? null) !== 'application/pdf')
                ) {
                    throw new \InvalidArgumentException('Invalid binary response descriptor');
                }
                if (isset($response['schema'])) {
                    throw new \InvalidArgumentException('Raw schema in compiled response');
                }
                if (isset($response['codec'])) {
                    Codec::assertPlan($response['codec'], $op['id'] . '.response.' . $status);
                }
            }
        }
        foreach ($this->contract['definitions'] ?? [] as $name => $codec) {
            Codec::assertPlan($codec, 'definitions.' . $name);
        }
        foreach ($this->contract['webhook']['events'] ?? [] as $name => $codec) {
            Codec::assertPlan($codec, 'events.' . $name);
        }
        $this->allowed = $options->allowedOrigins ?? [self::origin($options->baseUrl)];
        $this->checkUrl($options->baseUrl);
        if ($options->timeoutMs <= 0 || $options->deadlineMs <= 0) {
            Codec::fail('options', 'timeouts must be positive');
        }
    }
    private function decode(mixed $value, array $codec, array $context = []): mixed
    {
        return Codec::execute(
            $value,
            $codec,
            $context + ['definitions' => $this->contract['definitions'] ?? []],
        );
    }
    private static function now(): int
    {
        return (int) floor(hrtime(true) / 1000000);
    }
    private static function origin(string $url): string
    {
        $p = parse_url($url);
        return strtolower(($p['scheme'] ?? '') . '://' . ($p['host'] ?? '')) .
            (isset($p['port']) &&
            !(
                ($p['scheme'] === 'https' && $p['port'] === 443) ||
                ($p['scheme'] === 'http' && $p['port'] === 80)
            )
                ? ':' . $p['port']
                : '');
    }
    private function checkUrl(string $url): void
    {
        $p = parse_url($url);
        if (
            !$p ||
            preg_match('/[\\\\\x00-\x20]/', $url) ||
            isset($p['user']) ||
            isset($p['pass']) ||
            isset($p['fragment']) ||
            !in_array(
                $p['scheme'] ?? '',
                $this->options->allowInsecureHttp ? ['https', 'http'] : ['https'],
                true,
            ) ||
            !in_array(self::origin($url), $this->allowed, true)
        ) {
            throw new SdkError(
                'destination',
                'Destination is outside the explicit credential policy',
            );
        }
    }
    private static function checkCancel(?Cancellation $c, string $outcome = 'unknown'): void
    {
        if ($c?->isCancelled()) {
            throw new SdkError(
                'cancelled',
                'Local waiting cancelled; this does not cancel the remote operation',
                $outcome,
            );
        }
    }
    private static function pause(int $ms, ?Cancellation $c): void
    {
        $end = self::now() + $ms;
        do {
            self::checkCancel($c);
            $left = $end - self::now();
            if ($left > 0) {
                usleep(min(10000, $left * 1000));
            }
        } while (self::now() < $end);
    }
    private function operation(string $id): array
    {
        foreach ($this->contract['operations'] as $op) {
            if ($op['id'] === $id) {
                return $op;
            }
        }
        Codec::fail('operation', 'operation is not included in this SDK');
    }
    public function request(
        string $id,
        array $input = [],
        ?RequestOptions $options = null,
        ?string $continuation = null,
    ): Result {
        $o = $options ?? new RequestOptions();
        $op = $this->operation($id);
        foreach (['streamIdleTimeoutMs', 'streamLifetimeMs'] as $key) {
            if ($o->{$key} !== null && $o->{$key} <= 0) {
                Codec::fail($key, 'must be positive');
            }
        }
        $start = self::now();
        $timeout = $o->timeoutMs ?? $this->options->timeoutMs;
        $duration = $o->deadlineMs ?? $this->options->deadlineMs;
        if ($timeout <= 0 || $duration <= 0) {
            Codec::fail('options', 'timeouts must be positive');
        }
        $deadline = $start + $duration;
        $policy = $op['retry'] ?? [
            'maxAttempts' => 1,
            'statuses' => [],
            'transport' => false,
            'baseDelayMs' => 100,
        ];
        $attempts = $o->maxAttempts ?? ($this->options->maxAttempts ?? $policy['maxAttempts']);
        if ($attempts < 1 || $attempts > $policy['maxAttempts']) {
            Codec::fail('maxAttempts', 'must be within the provider-declared retry limit');
        }
        $headers = [
            'accept' =>
                implode(
                    ', ',
                    array_unique(
                        array_filter(
                            array_map(
                                fn($response) => ($response['classification'] ?? null) === 'success'
                                    ? $response['mediaType'] ?? null
                                    : null,
                                $op['responses'],
                            ),
                        ),
                    ),
                ) ?:
                'application/json',
            'user-agent' => $this->contract['userAgent'] ?? 'PublicSDK (PHP)',
        ];
        $set = function (string $name, string $value) use (&$headers, $op): void {
            if (
                !preg_match('/^[!#$%&\x27*+.^_`|~0-9A-Za-z-]+$/', $name) ||
                preg_match('/[\r\n]/', $value)
            ) {
                Codec::fail('headers', 'invalid HTTP header');
            }
            $existing = $headers[strtolower($name)] ?? null;
            if (
                strtolower($op['idempotency']['header'] ?? '') === strtolower($name) &&
                $existing !== null &&
                $existing !== $value
            ) {
                Codec::fail(
                    'idempotencyKey',
                    'conflicting keys were supplied through input headers or request options',
                );
            }
            $headers[strtolower($name)] = $value;
        };
        $path = $op['path'];
        $query = [];
        foreach ($op['parameters'] as $p) {
            if (!array_key_exists($p['name'], $input)) {
                if ($p['required'] ?? false) {
                    Codec::fail($p['name'], 'required parameter is missing');
                }
                continue;
            }
            $v = $this->decode($input[$p['name']], $p['codec'], ['path' => $p['name']]);
            $scalar = fn($v) => $v instanceof RawNumber
                ? $v->value
                : (is_bool($v)
                    ? ($v
                        ? 'true'
                        : 'false')
                    : (string) $v);
            $values = array_map($scalar, is_array($v) ? $v : [$v]);
            if ($p['in'] === 'path') {
                if (array_intersect($values, ['.', '..'])) {
                    Codec::fail($p['name'], 'dot path segments are unsupported');
                }
                $path = str_replace(
                    '{' . $p['name'] . '}',
                    implode(',', array_map('rawurlencode', $values)),
                    $path,
                );
            }
            if ($p['in'] === 'query') {
                if (is_array($v) && ($p['explode'] ?? true)) {
                    foreach ($values as $value) {
                        $query[] = rawurlencode($p['name']) . '=' . rawurlencode($value);
                    }
                } else {
                    $query[] =
                        rawurlencode($p['name']) .
                        '=' .
                        implode(',', array_map('rawurlencode', $values));
                }
            }
            if ($p['in'] === 'header') {
                $set($p['name'], implode(',', $values));
            }
        }
        $url =
            rtrim($this->options->baseUrl, '/') .
            $path .
            ($query ? '?' . implode('&', $query) : '');
        if ($continuation !== null) {
            if (str_starts_with($continuation, '//')) {
                $url =
                    (parse_url($this->options->baseUrl, PHP_URL_SCHEME) ?: 'https') .
                    ':' .
                    $continuation;
            } elseif (preg_match('/^[a-z][a-z0-9+.-]*:/i', $continuation)) {
                $url = $continuation;
            } elseif (str_starts_with($continuation, '/')) {
                $url = self::origin($this->options->baseUrl) . $continuation;
            } else {
                $url = rtrim($this->options->baseUrl, '/') . '/' . $continuation;
            }
        }
        $this->checkUrl($url);
        foreach ($o->headers as $k => $v) {
            $set($k, $v);
        }
        if (isset($this->contract['authentication'])) {
            $permitted = $op['authModes'] ?? [];
            $shortcutAuth = function ($options) {
                $supplied = [];
                foreach ($this->contract['authShortcuts'] ?? [] as $key => $shortcut) {
                    if (($options->$key ?? null) !== null) {
                        $supplied[] = [
                            'mode' => $shortcut['mode'],
                            'credentials' => [$shortcut['scheme'] => $options->$key],
                        ];
                    }
                }
                if (
                    count($supplied) > 1 ||
                    ($supplied &&
                        ($options->authMode !== null ||
                            ($options->credentials !== null &&
                                ($options instanceof RequestOptions ||
                                    $options->credentials !== []))))
                ) {
                    throw new SdkError(
                        'authentication',
                        'Use one authentication shortcut or explicit authMode/credentials, not both',
                    );
                }
                return $supplied[0] ?? null;
            };
            $clientShortcut = $shortcutAuth($this->options);
            $requestShortcut = $shortcutAuth($o);
            $defaultMode = $this->options->authMode ?? ($clientShortcut['mode'] ?? null);
            $modeName =
                $requestShortcut['mode'] ?? ($o->authMode ?? ($permitted ? $defaultMode : null));
            if ($modeName === null && $op['authenticated'] && count($permitted) === 1) {
                $modeName = $permitted[0];
            }
            if ($modeName === null && $op['authenticated']) {
                throw new SdkError(
                    'authentication',
                    'Select an explicit authentication mode for ' .
                        $op['id'] .
                        '; permitted modes: ' .
                        implode(', ', $permitted),
                );
            }
            $selected =
                $modeName === null ? null : $this->contract['authentication'][$modeName] ?? null;
            if (
                $modeName !== null &&
                ($selected === null || !in_array($modeName, $permitted, true))
            ) {
                throw new SdkError(
                    'authentication',
                    'Authentication mode is not permitted for ' .
                        $op['id'] .
                        '; permitted modes: ' .
                        implode(', ', $permitted),
                );
            }
            $expected = [];
            if ($selected !== null) {
                $credentials =
                    $requestShortcut['credentials'] ??
                    ($o->credentials ??
                        (($clientShortcut['mode'] ?? null) === $modeName
                            ? $clientShortcut['credentials']
                            : $this->options->credentials[$modeName] ?? []));
                foreach ($selected['schemes'] as $scheme) {
                    $credential = $credentials[$scheme['name']] ?? null;
                    if (
                        !is_string($credential) ||
                        $credential === '' ||
                        preg_match('/[\r\n]/', $credential)
                    ) {
                        throw new SdkError(
                            'authentication',
                            'Missing or invalid credential ' .
                                $scheme['name'] .
                                ' for authentication mode ' .
                                $modeName,
                        );
                    }
                    $expected[strtolower($scheme['header'])] =
                        $scheme['type'] === 'bearer' ? 'Bearer ' . $credential : $credential;
                }
            }
            foreach ($this->contract['authentication'] as $mode) {
                foreach ($mode['schemes'] as $scheme) {
                    $name = strtolower($scheme['header']);
                    if (isset($headers[$name]) && $headers[$name] !== ($expected[$name] ?? null)) {
                        throw new SdkError(
                            'authentication',
                            'Request headers conflict with the selected authentication mode',
                        );
                    }
                }
            }
            foreach ($expected as $name => $value) {
                $set($name, $value);
            }
        } elseif (
            $op['authenticated'] ||
            (($op['optionalAuthentication'] ?? false) && $this->options->token)
        ) {
            $auth = $this->contract['auth'] ?? null;
            if (!$auth || !$this->options->token) {
                throw new SdkError('authentication', 'Explicit API credentials are required');
            }
            $set(
                $auth['header'],
                $auth['type'] === 'bearer'
                    ? 'Bearer ' . $this->options->token
                    : $this->options->token,
            );
        }
        if (isset($this->contract['apiVersion'])) {
            $set($this->contract['apiVersion']['header'], $this->contract['apiVersion']['value']);
        }
        if ($o->ifMatch !== null) {
            if (!isset($op['conditional'])) {
                Codec::fail('ifMatch', 'operation does not declare conditional requests');
            }
            $set($op['conditional']['header'], $o->ifMatch);
        }
        $key =
            $o->idempotencyKey ??
            ($headers[strtolower($op['idempotency']['header'] ?? '')] ??
                (null ?? ($op['idempotency']['auto'] ?? false ? bin2hex(random_bytes(16)) : null)));
        if ($key !== null) {
            if (!isset($op['idempotency']) || $key === '') {
                Codec::fail(
                    'idempotencyKey',
                    'a nonempty key and declared capability are required',
                );
            }
            if (preg_match('/^[ \t]|[ \t]$/D', $key)) {
                Codec::fail(
                    'idempotencyKey',
                    'leading or trailing HTTP whitespace would change the key on the wire',
                );
            }
            $set($op['idempotency']['header'], $key);
        }
        $safe =
            in_array($op['verb'], ['GET', 'HEAD', 'OPTIONS'], true) ||
            isset($headers[strtolower($op['idempotency']['header'] ?? '')]);
        if ($attempts > 1 && !$safe) {
            Codec::fail(
                'idempotencyKey',
                'persist and supply a key before enabling mutation retries',
            );
        }
        $body = null;
        if (array_key_exists('body', $input)) {
            if (!isset($op['body'])) {
                Codec::fail('body', 'operation does not accept a body');
            }
            $body = Codec::encode($this->decode($input['body'], $op['body']));
            $set('content-type', $op['mediaType']);
        } elseif ($op['bodyRequired']) {
            Codec::fail('body', 'required body is missing');
        }
        foreach (array_keys($input) as $key) {
            if ($key !== 'body' && !in_array($key, array_column($op['parameters'], 'name'), true)) {
                Codec::fail((string) $key, 'unknown input parameter');
            }
        }
        for ($attempt = 1; $attempt <= $attempts; $attempt++) {
            self::checkCancel($o->cancellation, $attempt === 1 ? 'not_sent' : 'unknown');
            $remaining = $deadline - self::now();
            if ($remaining <= 0) {
                throw new SdkError(
                    'deadline',
                    'Overall deadline exceeded',
                    $attempt === 1 ? 'not_sent' : 'unknown',
                );
            }
            $retryAfter = 0;
            $meta = null;
            $diagnosticError = null;
            try {
                $request = [
                    'url' => $url,
                    'method' => $op['verb'],
                    'headers' => $headers,
                    'body' => $body,
                    'timeoutMs' => min($timeout, $remaining),
                    'cancellation' => $o->cancellation,
                    'stream' =>
                        count(
                            array_filter(
                                $op['responses'],
                                fn($response) => ($response['bodyKind'] ?? null) === 'sse',
                            ),
                        ) > 0,
                    'streamIdleTimeoutMs' =>
                        $o->streamIdleTimeoutMs ?? ($op['stream']['idleTimeoutMs'] ?? 30000),
                    'streamLifetimeMs' => $o->streamLifetimeMs,
                ];
                $response = $this->options->transport
                    ? ($this->options->transport)($request)
                    : $this->send($request);
                $status = $response['status'];
                $rh = array_change_key_case($response['headers'], CASE_LOWER);
                $raw = $response['body'] ?? '';
                $declaredResponse =
                    $op['responses'][(string) $status] ?? ($op['responses']['default'] ?? null);
                $redirect =
                    ($op['responses'][(string) $status]['classification'] ?? null) === 'redirect';
                $binary =
                    $status >= 200 &&
                    $status < 300 &&
                    ($declaredResponse['bodyKind'] ?? null) === 'binary';
                $meta = [
                    'status' => $status,
                    'headers' => $rh,
                    'attempts' => $attempt,
                    'durationMs' => self::now() - $start,
                    'url' => $url,
                ];
                $requestIdHeader = strtolower(
                    $this->contract['errors']['requestIdHeader'] ?? 'x-request-id',
                );
                if (isset($rh[$requestIdHeader])) {
                    $meta['requestId'] = $rh[$requestIdHeader];
                }
                if (isset($response['failureCode'])) {
                    throw new \RuntimeException(
                        'HTTP transport failed with code ' . $response['failureCode'],
                    );
                }
                if (
                    $status >= 200 &&
                    $status < 300 &&
                    ($declaredResponse['bodyKind'] ?? null) === 'sse'
                ) {
                    $source = $response['stream'] ?? null;
                    if (
                        !($source instanceof ByteStream) ||
                        strtolower(trim(explode(';', $rh['content-type'] ?? '')[0])) !==
                            'text/event-stream'
                    ) {
                        if ($source instanceof ByteStream) {
                            $source->close();
                        }
                        throw new SdkError(
                            'protocol',
                            'Expected an SSE response stream',
                            'response',
                            false,
                            $meta,
                        );
                    }
                    if ($source instanceof CurlByteStream) {
                        $source->startStream();
                    }
                    $key = spl_object_id($source);
                    $stream = new EventStream(
                        $source,
                        $meta,
                        [
                            'idleTimeoutMs' => $request['streamIdleTimeoutMs'],
                            'maxEventBytes' => $op['stream']['maxEventBytes'] ?? 1048576,
                            'lifetimeMs' => $o->streamLifetimeMs,
                            'cancellation' => $o->cancellation,
                        ],
                        function (string $event, string $raw) use ($op): mixed {
                            $codec = $op['streamEventCodecs'][$event] ?? null;
                            return $codec
                                ? Codec::plainNumbers(
                                    $this->decode(Codec::parse($raw, true), $codec, [
                                        'mode' => 'response',
                                    ]),
                                )
                                : $raw;
                        },
                        function () use ($key): void {
                            unset($this->streams[$key]);
                        },
                    );
                    $this->streams[$key] = $stream;
                    return new Result($stream, $meta, '');
                }
                if (($response['stream'] ?? null) instanceof ByteStream) {
                    try {
                        while (($chunk = $response['stream']->read()) !== null) {
                            $raw .= $chunk;
                        }
                    } finally {
                        $response['stream']->close();
                    }
                }
                $data = null;
                try {
                    if ($raw !== '' && !$binary && !$redirect) {
                        $data = Codec::parse(
                            $raw,
                            ($status >= 200 && $status < 300) || $status === 304,
                        );
                    }
                } catch (\Throwable $cause) {
                    if ($status >= 200 && $status < 300) {
                        throw new SdkError(
                            'protocol',
                            'Invalid JSON success response',
                            'response',
                            false,
                            $meta,
                            previous: $cause,
                            raw: $raw,
                        );
                    }
                }
                if ($status >= 300 && $status < 400 && $status !== 304 && !$redirect) {
                    throw new SdkError(
                        'destination',
                        'Redirects are not followed; explicitly configure an approved endpoint',
                        'response',
                        false,
                        $meta,
                    );
                }
                if (($status >= 200 && $status < 300) || $status === 304 || $redirect) {
                    $declared =
                        $op['responses'][(string) $status] ?? ($op['responses']['default'] ?? null);
                    if ($declared === null) {
                        throw new SdkError(
                            'protocol',
                            'Undeclared success status',
                            'response',
                            false,
                            $meta,
                        );
                    }
                    try {
                        if ($binary) {
                            $contentType = strtolower(
                                trim(explode(';', $rh['content-type'] ?? '')[0]),
                            );
                            if ($contentType !== $declared['mediaType']) {
                                throw new \RuntimeException(
                                    'Unexpected binary response media type',
                                );
                            }
                            $data = $raw;
                        } elseif ($redirect) {
                            $location = $rh['location'] ?? null;
                            if (($declared['locationRequired'] ?? false) && !$location) {
                                throw new \RuntimeException('Missing Location header');
                            }
                            if (
                                $location !== null &&
                                preg_match('/[\\x00-\\x1f\\x7f]/', $location)
                            ) {
                                throw new \RuntimeException('Invalid Location header');
                            }
                            $data =
                                $location === null
                                    ? new \stdClass()
                                    : (object) ['location' => $location];
                        } elseif (isset($declared['codec'])) {
                            if ($raw === '') {
                                throw new \RuntimeException('Missing body');
                            }
                            $data = Codec::plainNumbers(
                                $this->decode($data, $declared['codec'], [
                                    'mode' => 'response',
                                    'path' => 'response',
                                ]),
                            );
                        } elseif ($raw !== '') {
                            throw new \RuntimeException('Unexpected body for an empty response');
                        }
                    } catch (\Throwable $cause) {
                        throw new SdkError(
                            'protocol',
                            'Response cannot be represented by the declared schema',
                            'response',
                            false,
                            $meta,
                            previous: $cause,
                            raw: $raw,
                        );
                    }
                    $model = $declared['model'] ?? null;
                    if (isset($declared['variants']) && is_object($data)) {
                        $codec = $declared['codec'];
                        $definitions = $this->contract['definitions'] ?? [];
                        for ($depth = 0; isset($codec['reference']); $depth++) {
                            if ($depth > 256) {
                                Codec::fail('response', 'codec reference exceeds nesting limit');
                            }
                            $definitions = $codec['definitions'] ?? $definitions;
                            $codec =
                                $definitions[$codec['reference']] ??
                                throw new \LogicException('Unresolved response codec');
                        }
                        $tag = $codec['tag'] ?? null;
                        $model =
                            $tag === null
                                ? null
                                : $declared['variants'][$data->{$tag} ?? ''] ?? null;
                    }
                    if ($model !== null && is_object($data)) {
                        $class = __NAMESPACE__ . '\\' . $model;
                        $data = new $class((array) $data, $this->options->redactFields);
                    }
                    // Decoding and model construction are synchronous; transport
                    // timeouts cannot interrupt them. Include them in the deadline.
                    $meta['durationMs'] = self::now() - $start;
                    if (self::now() >= $deadline) {
                        throw new SdkError(
                            'deadline',
                            'Response decoding exceeded the overall deadline',
                            'response',
                            false,
                            $meta,
                        );
                    }
                    return new Result($data, $meta, $raw);
                }
                $kind = match (true) {
                    in_array($status, [401, 403], true) => 'authentication',
                    $status === 429 => 'rate_limit',
                    in_array($status, [400, 422], true) => 'validation',
                    in_array($status, [409, 412], true) => 'conflict',
                    default => 'api',
                };
                $code = self::field($data, $this->contract['errors']['codePath'] ?? 'code');
                $details = Codec::redactPlan(
                    $data,
                    $op['responses'][(string) $status]['codec'] ??
                        ($op['responses']['default']['codec'] ?? []),
                    $this->options->redactFields,
                    $this->contract['definitions'] ?? [],
                );
                if (isset($this->contract['errors']['detailsPath'])) {
                    $details = self::field($details, $this->contract['errors']['detailsPath']);
                }
                $diagnosticError = $kind;
                $error = new SdkError(
                    $kind,
                    "API returned HTTP $status",
                    'response',
                    $safe &&
                        (in_array($status, $policy['statuses'], true) ||
                            (is_string($code) &&
                                count(
                                    array_filter(
                                        $policy['errors'] ?? [],
                                        fn($rule) => $rule['status'] === $status &&
                                            in_array($code, $rule['codes'], true),
                                    ),
                                ) > 0)),
                    $meta,
                    is_string($code) ? $code : null,
                    $details,
                    raw: $raw,
                );
                if (isset($rh['retry-after'])) {
                    $retryAfter = max(
                        0,
                        is_numeric($rh['retry-after'])
                            ? (int) ((float) $rh['retry-after'] * 1000)
                            : ((strtotime($rh['retry-after']) ?: time()) - time()) * 1000,
                    );
                }
            } catch (SdkError $error) {
                $diagnosticError = $error->kind;
                throw $error;
            } catch (\Throwable $cause) {
                $diagnosticError = $o->cancellation?->isCancelled()
                    ? 'cancelled'
                    : (self::now() >= $deadline
                        ? 'deadline'
                        : 'transport');
                $error = new SdkError(
                    $diagnosticError,
                    'Request did not produce a usable response; remote outcome is unknown',
                    'unknown',
                    $diagnosticError === 'transport' && $safe && $policy['transport'],
                    $meta,
                    previous: $cause,
                );
            } finally {
                try {
                    if ($this->options->diagnostics) {
                        $event = array_intersect_key(
                            $meta ?? [],
                            array_flip(['status', 'requestId']),
                        ) + [
                            'operation' => $id,
                            'attempt' => $attempt,
                            'durationMs' => self::now() - $start,
                        ];
                        if ($diagnosticError !== null) {
                            $event['errorKind'] = $diagnosticError;
                        }
                        ($this->options->diagnostics)($event);
                    }
                } catch (\Throwable) {
                    /* Hooks must not alter request outcomes. */
                }
            }
            if (!$error->retryAllowed || $attempt >= $attempts || self::now() >= $deadline) {
                throw $error;
            }
            $wait = max(
                $retryAfter,
                random_int(0, (int) ($policy['baseDelayMs'] * 2 ** ($attempt - 1))),
            );
            if (self::now() + $wait >= $deadline) {
                throw new SdkError(
                    'deadline',
                    'Retry wait would exceed the overall deadline',
                    $error->outcome,
                    $error->retryAllowed,
                    $meta,
                );
            }
            self::pause($wait, $o->cancellation);
        }
        throw new \LogicException('Unreachable retry state');
    }
    private function send(array $r): array
    {
        if ($r['stream'] ?? false) {
            $stream = new CurlByteStream($r);
            return [
                'status' => $stream->status,
                'headers' => $stream->headers,
                'stream' => $stream,
            ];
        }
        if (!extension_loaded('curl')) {
            throw new \RuntimeException('ext-curl is required for the default transport');
        }
        $this->curl ??= curl_init();
        $ch = $this->curl;
        curl_reset($ch);
        $headers = [];
        curl_setopt_array($ch, [
            CURLOPT_URL => $r['url'],
            CURLOPT_CUSTOMREQUEST => $r['method'],
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_ENCODING => '',
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_TIMEOUT_MS => $r['timeoutMs'],
            CURLOPT_CONNECTTIMEOUT_MS => $r['timeoutMs'],
            CURLOPT_HTTPHEADER => array_map(
                // cURL treats "name:" as suppression; "name;" sends an empty value.
                fn($k, $v) => $v === '' ? "$k;" : "$k: $v",
                array_keys($r['headers']),
                array_values($r['headers']),
            ),
            CURLOPT_NOPROGRESS => false,
            CURLOPT_XFERINFOFUNCTION => static fn() => $r['cancellation']?->isCancelled() ?? false
                ? 1
                : 0,
            CURLOPT_HEADERFUNCTION => static function ($ch, string $line) use (&$headers): int {
                if (str_starts_with($line, 'HTTP/')) {
                    $headers = [];
                } elseif (str_contains($line, ':')) {
                    [$k, $v] = explode(':', $line, 2);
                    $headers[strtolower(trim($k))] = trim($v);
                }
                return strlen($line);
            },
        ]);
        if ($r['body'] !== null) {
            curl_setopt($ch, CURLOPT_POSTFIELDS, $r['body']);
        }
        if ($r['method'] === 'HEAD') {
            curl_setopt($ch, CURLOPT_NOBODY, true);
        }
        $body = curl_exec($ch);
        return [
            'status' => curl_getinfo($ch, CURLINFO_RESPONSE_CODE),
            'headers' => $headers,
            'body' => $body === false ? '' : $body,
            'failureCode' => $body === false ? curl_errno($ch) : null,
        ];
    }
    public function close(): void
    {
        foreach ($this->streams as $stream) {
            $stream->close();
        }
        $this->curl = null;
    }
    public function __destruct()
    {
        $this->close();
    }
    private static function field(mixed $value, string $path): mixed
    {
        foreach (explode('.', $path) as $key) {
            $value = is_array($value) ? $value[$key] ?? null : $value->{$key} ?? null;
        }
        return $value;
    }
    private static function resolveLink(string $link, string $base): string
    {
        if (preg_match('/^[a-z][a-z0-9+.-]*:/i', $link)) {
            return $link;
        }
        $parsed = parse_url($base);
        if (str_starts_with($link, '//')) {
            return $parsed['scheme'] . ':' . $link;
        }
        $origin = self::origin($base);
        if (str_starts_with($link, '?')) {
            return $origin . ($parsed['path'] ?? '/') . $link;
        }
        if (str_starts_with($link, '#')) {
            return $base . $link;
        }
        $parts = parse_url($link);
        if ($parts === false) {
            throw new SdkError('destination', 'Invalid continuation URL');
        }
        $path = str_starts_with($link, '/')
            ? $parts['path'] ?? '/'
            : preg_replace('~/[^/]*$~', '/', $parsed['path'] ?? '/') . ($parts['path'] ?? '');
        $segments = [];
        foreach (explode('/', $path) as $segment) {
            $dot = strtolower(rawurldecode($segment));
            if ($dot === '..') {
                array_pop($segments);
            } elseif ($dot !== '.') {
                $segments[] = $segment;
            }
        }
        return $origin .
            '/' .
            ltrim(implode('/', $segments), '/') .
            (isset($parts['query']) ? '?' . $parts['query'] : '') .
            (isset($parts['fragment']) ? '#' . $parts['fragment'] : '');
    }
    public function pages(
        string $id,
        array $input = [],
        ?RequestOptions $options = null,
    ): \Generator {
        $o = $options ?? new RequestOptions();
        $p = $this->operation($id)['pagination'] ?? null;
        if (!$p) {
            Codec::fail('pagination', 'capability is not declared');
        }
        $deadline = self::now() + ($o->deadlineMs ?? $this->options->deadlineMs);
        $next = null;
        $limit = $o->maxPages ?? PHP_INT_MAX;
        if ($limit < 1) {
            Codec::fail('maxPages', 'must be positive');
        }
        for ($i = 0; $i < $limit; $i++) {
            self::checkCancel($o->cancellation);
            $remaining = $deadline - self::now();
            if ($remaining <= 0) {
                throw new SdkError('deadline', 'Pagination deadline exceeded', 'unknown');
            }
            $result = $this->request(
                $id,
                $input,
                $o->withDeadline($remaining),
                $p['kind'] === 'link' ? $next : null,
            );
            yield $result;
            $previous = $p['kind'] === 'link' ? $next : $input[$p['parameter']] ?? null;
            if ($previous instanceof ParsedNumber) {
                $previous = $previous->value;
            }
            $next = self::field($result->data, $p['next']);
            if ($next === null || $next === '') {
                return;
            }
            if ($p['kind'] === 'link' && !is_string($next)) {
                throw new SdkError('protocol', 'Expected a pagination URL', 'response');
            }
            if ($p['kind'] === 'link') {
                $next = self::resolveLink($next, $result->meta['url']);
            }
            if (
                $next === $previous ||
                ($p['kind'] === 'offset' &&
                    $previous !== null &&
                    (string) $next === (string) $previous) ||
                ($p['kind'] === 'link' && $next === $result->meta['url'])
            ) {
                throw new SdkError(
                    'protocol',
                    'Pagination returned a non-advancing continuation',
                    'response',
                );
            }
            if ($p['kind'] !== 'link') {
                $input[$p['parameter']] = $next;
            }
        }
    }
    public function items(
        string $id,
        array $input = [],
        ?RequestOptions $options = null,
    ): \Generator {
        $p = $this->operation($id)['pagination'] ?? null;
        if (!$p) {
            Codec::fail('pagination', 'capability is not declared');
        }
        $count = 0;
        $limit = $options?->maxItems ?? PHP_INT_MAX;
        if ($limit < 1) {
            Codec::fail('maxItems', 'must be positive');
        }
        foreach ($this->pages($id, $input, $options) as $page) {
            $items = self::field($page->data, $p['items']);
            if (!is_array($items)) {
                throw new SdkError(
                    'protocol',
                    'Pagination items field is not an array',
                    'response',
                );
            }
            foreach ($items as $item) {
                self::checkCancel($options?->cancellation);
                yield $item;
                if (++$count >= $limit) {
                    return;
                }
            }
        }
    }
    public function wait(string $id, array $input, ?RequestOptions $options = null): Result
    {
        $o = $options ?? new RequestOptions();
        $p = $this->operation($id)['polling'] ?? null;
        if (!$p) {
            Codec::fail('polling', 'capability is not declared');
        }
        $deadline = self::now() + ($o->deadlineMs ?? $this->options->deadlineMs);
        $interval = $p['intervalMs'];
        while (true) {
            $remaining = $deadline - self::now();
            if ($remaining <= 0) {
                throw new SdkError(
                    'deadline',
                    'Polling deadline exceeded; remote operation may still be running',
                    'unknown',
                );
            }
            $result = $this->request($id, $input, $o->withDeadline($remaining));
            $state = self::field($result->data, $p['state']);
            if (in_array($state, $p['success'], true)) {
                return $result;
            }
            if (in_array($state, $p['failure'], true)) {
                throw new SdkError(
                    'api',
                    'Operation reached a declared failure state',
                    'response',
                    false,
                    $result->meta,
                );
            }
            self::pause(min((int) $interval, max(0, $deadline - self::now())), $o->cancellation);
            $interval = min($interval * 1.5, 10000);
        }
    }
    public function verifyWebhook(
        string $rawBody,
        array $headers,
        array $secrets,
        ?int $nowSeconds = null,
    ): array {
        $w = $this->contract['webhook'] ?? null;
        if (!$w) {
            Codec::fail('webhook', 'capability is not declared');
        }
        $headers = array_change_key_case($headers, CASE_LOWER);
        $timestamp = $headers[strtolower($w['timestampHeader'] ?? '')] ?? '';
        $signature = $headers[strtolower($w['header'])] ?? '';
        $format = $w['format'] ?? 'hex';
        $candidates = [$signature];
        $prefix = '';
        if ($format === 'timestamped-hex') {
            $parts = array_map('trim', explode(',', $signature));
            $timestamps = array_values(
                array_filter($parts, fn($part) => str_starts_with($part, 't=')),
            );
            $timestamp = count($timestamps) === 1 ? substr($timestamps[0], 2) : '';
            $candidates = array_map(
                fn($part) => substr($part, 3),
                array_filter($parts, fn($part) => str_starts_with($part, 'v1=')),
            );
        } elseif ($format === 'standard-webhooks') {
            $id = trim($headers[strtolower($w['idHeader'])] ?? '');
            if ($id === '') {
                throw new SdkError('authentication', 'Invalid webhook signature or timestamp');
            }
            $prefix = $id . '.';
            $candidates = array_map(
                fn($part) => substr($part, 3),
                array_filter(
                    preg_split('/\s+/', trim($signature)),
                    fn($part) => str_starts_with($part, 'v1,'),
                ),
            );
        }
        if (
            !preg_match('/^\d+$/', $timestamp) ||
            (float) $timestamp > 9007199254740991 ||
            abs(($nowSeconds ?? time()) - (float) $timestamp) > $w['toleranceSeconds'] ||
            !$secrets
        ) {
            throw new SdkError('authentication', 'Invalid webhook signature or timestamp');
        }
        $valid = false;
        foreach ($secrets as $secret) {
            if ($secret === '') {
                continue;
            }
            $key = $secret;
            if ($format === 'standard-webhooks') {
                if (!preg_match('/^whsec_[A-Za-z0-9+\/]{43}=$/D', $secret)) {
                    continue;
                }
                $key = base64_decode(substr($secret, 6), true);
                if (
                    $key === false ||
                    strlen($key) !== 32 ||
                    base64_encode($key) !== substr($secret, 6)
                ) {
                    continue;
                }
            }
            $digest = hash_hmac(
                'sha256',
                $prefix . $timestamp . $w['separator'] . $rawBody,
                $key,
                true,
            );
            $expected = $format === 'standard-webhooks' ? base64_encode($digest) : bin2hex($digest);
            foreach ($candidates as $candidate) {
                $valid =
                    hash_equals(
                        $expected,
                        $format === 'standard-webhooks' ? $candidate : strtolower($candidate),
                    ) || $valid;
            }
        }
        if (!$valid) {
            throw new SdkError('authentication', 'Invalid webhook signature or timestamp');
        }
        try {
            $event = Codec::parse($rawBody, true);
        } catch (\Throwable $cause) {
            throw new SdkError('protocol', 'Invalid webhook JSON', 'response', previous: $cause);
        }
        $eventType = self::field($event, $w['typeField']);
        $schema = is_string($eventType) ? $w['events'][$eventType] ?? null : null;
        if ($schema) {
            $event = $this->decode($event, $schema, ['mode' => 'response', 'path' => 'event']);
        }
        $event = Codec::plainNumbers($event);
        if (is_string($eventType) && isset($w['eventModels'][$eventType]) && is_object($event)) {
            $class = __NAMESPACE__ . '\\' . $w['eventModels'][$eventType];
            $event = new $class((array) $event, $this->options->redactFields);
        }
        return [
            'event' => $event,
            'known' => $schema !== null,
        ];
    }
    public function money(string $currency, string $major): array
    {
        $digits = $this->contract['money']['currencies'][$currency] ?? null;
        if ($digits === null) {
            Codec::fail('currency', 'currency is not declared by this provider');
        }
        if (!preg_match('/^-?(0|[1-9]\d*)(\.\d+)?$/D', $major)) {
            Codec::fail('amount', 'expected an exact decimal string');
        }
        $negative = str_starts_with($major, '-');
        [$whole, $fraction] = array_pad(explode('.', ltrim($major, '-')), 2, '');
        if (strlen($fraction) > $digits) {
            Codec::fail(
                'amount',
                'unsupported precision; rounding must be explicit in application code',
            );
        }
        $amount = ltrim($whole . str_pad($fraction, $digits, '0'), '0');
        $amount = $amount === '' ? '0' : $amount;
        return [
            'currency' => $currency,
            'amount' => ($negative && $amount !== '0' ? '-' : '') . $amount,
        ];
    }
}
