<?php
declare(strict_types=1);
namespace SdkNamespace;

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
    ) {}
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
    ) {}
    public function __debugInfo(): array
    {
        return ['baseUrl' => $this->baseUrl, 'token' => '[REDACTED]'];
    }
}
class Model implements \JsonSerializable
{
    protected readonly mixed $values;
    public function __construct(
        mixed $values,
        protected readonly array $schema,
        bool $response = false,
        protected readonly array $redactFields = [],
    ) {
        $types = is_array($schema['type'] ?? null) ? $schema['type'] : [$schema['type'] ?? null];
        if (
            is_array($values) &&
            (in_array('object', $types, true) ||
                (!isset($schema['type']) &&
                    (isset($schema['properties']) || isset($schema['required']))))
        ) {
            $values = (object) $values;
        }
        $normalized = Codec::normalize($values, $schema, response: $response);
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
        $this->values = $unwrap($normalized);
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
            throw new SdkError('validation', 'Field was omitted');
        }
        return is_object($this->values) ? $this->values->{$field} : $this->values[$field];
    }
    public function __get(string $field): mixed
    {
        return $this->get($field);
    }
    public function __isset(string $field): bool
    {
        return $this->has($field) && $this->get($field) !== null;
    }
    public function toArray(): array
    {
        if (!is_object($this->values) && !is_array($this->values)) {
            throw new SdkError(
                'validation',
                'This model contains a scalar; use jsonSerialize() to access its value',
            );
        }
        return (array) $this->values;
    }
    public function jsonSerialize(): mixed
    {
        return $this->values;
    }
    public function __debugInfo(): array
    {
        $redacted = Codec::redact($this->values, $this->schema, $this->redactFields);
        return is_array($redacted) || is_object($redacted)
            ? (array) $redacted
            : ['value' => $redacted];
    }
}
final class RawNumber
{
    public function __construct(public readonly string $value) {}
}
final class ParsedNumber
{
    public function __construct(public readonly string $value) {}
}
final class Codec
{
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
    private static function combine(mixed $left, mixed $right, string $path): mixed
    {
        if ($left instanceof ParsedNumber || $right instanceof ParsedNumber) {
            $token = $left instanceof ParsedNumber ? $left : $right;
            $other = $left instanceof ParsedNumber ? $right : $left;
            $text =
                $other instanceof ParsedNumber
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
            return $other;
        }
        if ($left instanceof RawNumber || $right instanceof RawNumber) {
            $token = $left instanceof RawNumber ? $left : $right;
            $other = $left instanceof RawNumber ? $right : $left;
            if ((string) ($other instanceof RawNumber ? $other->value : $other) !== $token->value) {
                self::fail($path, 'alternatives have incompatible numeric representations');
            }
            return $token;
        }
        if ((is_array($left) || is_object($left)) && (is_array($right) || is_object($right))) {
            $a = (array) $left;
            $b = (array) $right;
            $out = [];
            foreach (array_unique(array_merge(array_keys($a), array_keys($b))) as $key) {
                $out[$key] =
                    array_key_exists($key, $a) && array_key_exists($key, $b)
                        ? self::combine($a[$key], $b[$key], "$path.$key")
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
    private static function numericConstraints(
        string $token,
        array $s,
        string $path,
        bool $full = true,
    ): void {
        $ranges = [
            'int32' => ['-2147483648', '2147483647'],
            'uint32' => ['0', '4294967295'],
            'int64' => ['-9223372036854775808', '9223372036854775807'],
            'uint64' => ['0', '18446744073709551615'],
        ];
        $range = $ranges[$s['format'] ?? ''] ?? null;
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
        foreach (['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'] as $keyword) {
            if (!isset($s[$keyword])) {
                continue;
            }
            $order = self::compareDecimal($token, json_encode($s[$keyword], JSON_THROW_ON_ERROR));
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
        if ($depth > 256) {
            self::fail(
                $path,
                'value exceeds the supported nesting depth (256) or contains a cycle',
            );
        }
        $validateConstraints = isset($s['x-sdk-validation'])
            ? $s['x-sdk-validation'] === 'schema'
            : $validateConstraints;
        $definitions = $s['x-sdk-definitions'] ?? $definitions;
        if (isset($s['x-sdk-ref'])) {
            $target = $definitions[$s['x-sdk-ref']] ?? null;
            if ($target === null) {
                self::fail($path, 'unresolved recursive model ' . $s['x-sdk-ref']);
            }
            return self::normalize(
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
            $value = $value->jsonSerialize();
        }
        $omitted = [];
        $collect = function ($schema) use (&$collect, &$omitted, $response) {
            foreach ($schema['properties'] ?? [] as $key => $child) {
                if ($response ? $child['writeOnly'] ?? false : $child['readOnly'] ?? false) {
                    $omitted[$key] = true;
                }
            }
            foreach ($schema['allOf'] ?? [] as $branch) {
                $collect($branch);
            }
        };
        $collect($s);
        if ($omitted) {
            $project = function ($schema) use (&$project, $omitted) {
                if (isset($schema['required'])) {
                    $schema['required'] = array_values(
                        array_filter($schema['required'], fn($key) => !isset($omitted[$key])),
                    );
                }
                foreach (['allOf', 'anyOf', 'oneOf'] as $keyword) {
                    if (isset($schema[$keyword])) {
                        $schema[$keyword] = array_map($project, $schema[$keyword]);
                    }
                }
                return $schema;
            };
            $s = $project($s);
        }
        if (isset($s['allOf']) || isset($s['anyOf']) || isset($s['oneOf']) || isset($s['not'])) {
            $base = array_diff_key(
                $s,
                array_flip(['allOf', 'anyOf', 'oneOf', 'not', 'discriminator']),
            );
            $result = self::normalize(
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
            $matches = function ($branch, bool $allowUnknownFields) use (
                $value,
                $path,
                $response,
                $definitions,
                $depth,
                $validateConstraints,
            ) {
                try {
                    self::normalize(
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
                    return true;
                } catch (SdkError $e) {
                    if ($e->kind === 'validation') {
                        return false;
                    }
                    throw $e;
                }
            };
            if (isset($s['not']) && $matches($s['not'], false)) {
                self::fail($path, 'value matches a forbidden combination');
            }
            foreach ($s['allOf'] ?? [] as $branch) {
                $result = self::combine(
                    $result,
                    self::normalize(
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
                );
            }
            foreach (['oneOf', 'anyOf'] as $keyword) {
                if (!isset($s[$keyword])) {
                    continue;
                }
                $tolerateUnknownFields = $allowUnknownResponseFields;
                if ($keyword === 'oneOf' && isset($s['discriminator'])) {
                    $tag = $s['discriminator']['propertyName'];
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
                            $branch['properties'][$tag]['enum'] ?? [],
                            true,
                        ),
                    );
                } else {
                    $selected = array_filter($s[$keyword], fn($branch) => $matches($branch, false));
                    // Prefer exact closed oneOf alternatives, then a unique
                    // compatible branch. anyOf retains every compatible branch.
                    if (
                        ($keyword === 'anyOf' || !$selected) &&
                        $response &&
                        (!$matching || $allowUnknownResponseFields)
                    ) {
                        $compatible = array_filter(
                            $s[$keyword],
                            fn($branch) => $matches($branch, true),
                        );
                        if ($keyword === 'anyOf' || count($compatible) === 1) {
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
                                fn($branch) => ($branch['type'] ?? null) === 'object',
                            ),
                        ) === count($s[$keyword]) &&
                        !is_object($value)
                    ) {
                        self::fail($path, 'expected an object response alternative');
                    }
                    continue;
                }
                if (!$selected || ($keyword === 'oneOf' && count($selected) !== 1)) {
                    self::fail(
                        $path,
                        $keyword === 'oneOf'
                            ? 'value must match exactly one alternative'
                            : 'value must match at least one alternative',
                    );
                }
                foreach ($selected as $branch) {
                    $result = self::combine(
                        $result,
                        self::normalize(
                            $value,
                            $branch,
                            $path,
                            $response,
                            $matching,
                            $definitions,
                            $depth + 1,
                            $validateConstraints,
                            $tolerateUnknownFields,
                        ),
                        $path,
                    );
                }
            }
            return $result;
        }
        $types = (array) ($s['type'] ?? []);
        $type =
            array_values(array_filter($types, fn($t) => $t !== 'null'))[0] ??
            (isset($s['type']) ? 'null' : null);
        if ($value === null) {
            if (
                (!$response || $matching) &&
                isset($s['enum']) &&
                !in_array(null, $s['enum'], true)
            ) {
                self::fail($path, 'null is outside the declared enum');
            }
            if (!isset($s['type']) || in_array('null', $types, true)) {
                return null;
            }
            self::fail($path, 'null is not permitted');
        }
        if ($value instanceof ParsedNumber) {
            if ($type === null) {
                if (
                    $matching &&
                    isset($s['enum']) &&
                    !array_filter(
                        $s['enum'],
                        fn($v) => is_int($v) &&
                            self::compareDecimal($value->value, (string) $v) === 0,
                    )
                ) {
                    self::fail($path, 'value is outside the declared enum');
                }
                if ($matching) {
                    self::numericConstraints($value->value, $s, $path);
                }
                return $value;
            }
            if ($type === 'integer') {
                $token = self::integerToken($value->value, $path);
                $value = in_array($s['format'] ?? '', ['int64', 'uint64'], true)
                    ? $token
                    : (int) $token;
            } elseif ($type === 'number') {
                $value = $value->value;
            } else {
                self::fail($path, "expected $type; received a JSON number");
            }
        }
        $exactEnum =
            $type === 'number' ||
            ($type === 'integer' && in_array($s['format'] ?? '', ['int64', 'uint64'], true));
        if (
            (!$response || $matching) &&
            isset($s['enum']) &&
            !($exactEnum
                ? (is_string($value) || is_int($value)) &&
                    preg_match(
                        '/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/',
                        (string) $value,
                    ) &&
                    array_filter(
                        $s['enum'],
                        fn($member) => is_int($member) &&
                            self::compareDecimal((string) $value, (string) $member) === 0,
                    )
                : in_array($value, $s['enum'], true))
        ) {
            self::fail($path, 'value is outside the declared enum');
        }
        if ($type === 'integer' || $type === 'number') {
            if ($type === 'number' || in_array($s['format'] ?? '', ['int64', 'uint64'], true)) {
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
                        (!array_is_list($value) ||
                            (!$value && (isset($s['required']) || isset($s['properties'])))))))
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
            foreach ($s['required'] ?? [] as $key) {
                if (
                    $response
                        ? $s['properties'][$key]['writeOnly'] ?? false
                        : $s['properties'][$key]['readOnly'] ?? false
                ) {
                    continue;
                }
                if (!array_key_exists($key, $data)) {
                    self::fail("$path.$key", 'required field is missing');
                }
            }
            $out = new \stdClass();
            foreach ($data as $key => $v) {
                if (isset($s['properties'][$key])) {
                    if (!$response && ($s['properties'][$key]['readOnly'] ?? false)) {
                        self::fail("$path.$key", 'readOnly fields cannot be sent');
                    }
                    $out->{$key} = self::normalize(
                        $v,
                        $s['properties'][$key],
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
                    ($s['additionalProperties'] ?? true) === false
                ) {
                    self::fail("$path.$key", 'unknown request field');
                } elseif (is_array($s['additionalProperties'] ?? null)) {
                    $out->{$key} = self::normalize(
                        $v,
                        $s['additionalProperties'],
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
            return $out;
        }
        if ($type === 'array' || ($type === null && is_array($value) && array_is_list($value))) {
            if (!is_array($value) || !array_is_list($value)) {
                self::fail($path, 'expected an array');
            }
            if ((!$response || $matching) && ($validateConstraints || $matching)) {
                if (isset($s['minItems']) && count($value) < $s['minItems']) {
                    self::fail($path, 'array violates minItems');
                }
                if (isset($s['maxItems']) && count($value) > $s['maxItems']) {
                    self::fail($path, 'array violates maxItems');
                }
            }
            return array_map(
                fn($v) => self::normalize(
                    $v,
                    $s['items'] ?? [],
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
                if (isset($s['minLength']) && $length < $s['minLength']) {
                    self::fail($path, 'string violates minLength');
                }
                if (isset($s['maxLength']) && $length > $s['maxLength']) {
                    self::fail($path, 'string violates maxLength');
                }
                if (isset($s['pattern'])) {
                    $pattern =
                        $s['x-sdk-pattern-php'] ??
                        '~' . str_replace('~', '\\~', $s['pattern']) . '~uD';
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
            $value = $value->jsonSerialize();
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
        if ($depth > 256) {
            return '[Nesting limit]';
        }
        $definitions = $schema['x-sdk-definitions'] ?? $definitions;
        $shapes = function ($s) use (&$shapes, $definitions) {
            if (isset($s['x-sdk-ref'])) {
                return isset($definitions[$s['x-sdk-ref']])
                    ? $shapes($definitions[$s['x-sdk-ref']])
                    : [];
            }
            $out = [$s];
            foreach (['allOf', 'oneOf', 'anyOf'] as $key) {
                foreach ($s[$key] ?? [] as $branch) {
                    $out = array_merge($out, $shapes($branch));
                }
            }
            return $out;
        };
        $schemas = $shapes($schema);
        foreach ($schemas as $shape) {
            if (($shape['x-sensitive'] ?? false) || ($shape['writeOnly'] ?? false)) {
                return '[REDACTED]';
            }
        }
        if (is_array($value) && array_is_list($value)) {
            $items = array_values(
                array_filter(
                    array_map(fn($s) => $s['items'] ?? null, $schemas),
                    fn($s) => $s !== null,
                ),
            );
            return array_map(
                fn($v) => self::redact($v, ['allOf' => $items], $fields, $definitions, $depth + 1),
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
                        : self::redact(
                            $v,
                            [
                                'allOf' => array_values(
                                    array_filter(
                                        array_map(
                                            fn($s) => $s['properties'][$k] ??
                                                (is_array($s['additionalProperties'] ?? null)
                                                    ? $s['additionalProperties']
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
    public function __construct(array $contract, private readonly ClientOptions $options)
    {
        if (
            parse_url($options->baseUrl, PHP_URL_QUERY) !== null ||
            preg_match('/[\\\\\r\n]/', $options->baseUrl)
        ) {
            Codec::fail('baseUrl', 'base URL must not contain a query or backslash');
        }
        $attach = fn($schema) => $schema + [
                'x-sdk-validation' => $contract['validation'] ?? 'schema',
            ] +
            (isset($contract['definitions'])
                ? ['x-sdk-definitions' => $contract['definitions']]
                : []);
        foreach ($contract['operations'] as &$operation) {
            foreach ($operation['parameters'] as &$parameter) {
                $parameter['schema'] = $attach($parameter['schema']);
            }
            unset($parameter);
            if (isset($operation['body'])) {
                $operation['body'] = $attach($operation['body']);
            }
            foreach ($operation['responses'] as &$response) {
                if (isset($response['schema'])) {
                    $response['schema'] = $attach($response['schema']);
                }
            }
            unset($response);
        }
        unset($operation);
        if (isset($contract['webhook'])) {
            foreach ($contract['webhook']['events'] as &$event) {
                $event = $attach($event);
            }
        }
        unset($event);
        $this->contract = $contract;
        $this->allowed = $options->allowedOrigins ?? [self::origin($options->baseUrl)];
        $this->checkUrl($options->baseUrl);
        if ($options->timeoutMs <= 0 || $options->deadlineMs <= 0) {
            Codec::fail('options', 'timeouts must be positive');
        }
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
            'accept' => 'application/json',
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
            $v = Codec::normalize($input[$p['name']], $p['schema'], $p['name']);
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
        if (
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
            $body = Codec::encode(Codec::normalize($input['body'], $op['body']));
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
                ];
                $response = $this->options->transport
                    ? ($this->options->transport)($request)
                    : $this->send($request);
                $status = $response['status'];
                $rh = array_change_key_case($response['headers'], CASE_LOWER);
                $raw = $response['body'];
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
                $data = null;
                try {
                    if ($raw !== '') {
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
                if ($status >= 300 && $status < 400 && $status !== 304) {
                    throw new SdkError(
                        'destination',
                        'Redirects are not followed; explicitly configure an approved endpoint',
                        'response',
                        false,
                        $meta,
                    );
                }
                if (($status >= 200 && $status < 300) || $status === 304) {
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
                        if (isset($declared['schema'])) {
                            if ($raw === '') {
                                throw new \RuntimeException('Missing body');
                            }
                            $data = Codec::plainNumbers(
                                Codec::normalize($data, $declared['schema'], 'response', true),
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
                        $tag = $declared['schema']['discriminator']['propertyName'];
                        $model = $declared['variants'][$data->{$tag} ?? ''] ?? null;
                    }
                    if ($model !== null && is_object($data)) {
                        $class = __NAMESPACE__ . '\\' . $model;
                        $data = new $class((array) $data, $this->options->redactFields);
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
                $details = Codec::redact(
                    $data,
                    $op['responses'][(string) $status]['schema'] ??
                        ($op['responses']['default']['schema'] ?? []),
                    $this->options->redactFields,
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
            $event = Codec::normalize($event, $schema, 'event', true);
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
        if (!preg_match('/^-?(0|[1-9]\d*)(\.\d+)?$/', $major)) {
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
