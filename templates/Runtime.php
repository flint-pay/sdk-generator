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
final class ParsedNumber
{
    public function __construct(public readonly string $value) {}
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
                                'minLength',
                                'maxLength',
                                'minItems',
                                'maxItems',
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
        foreach (['element', 'exclude'] as $key) {
            if (isset($value[$key])) {
                self::assertPlan($value[$key], "$path.$key", $depth + 1);
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
                    $branch['fields'][$tag]['members'] ?? [],
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
            $value = $value->jsonSerialize();
        }
        $shapes = [];
        $collect = function (array $codec, array $definitions, int $level) use (
            &$collect,
            &$shapes,
            $path,
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
                foreach ($codec['every'] ?? [] as $child) {
                    $collect($child, $definitions, $level + 1);
                }
            }
        };
        foreach ($scopes as [$codec, $definitions]) {
            $collect($codec, $definitions, $depth);
        }
        if (is_string($value)) {
            foreach ($shapes as [$codec]) {
                $pattern =
                    $codec['value']['kind'] === 'exact-integer'
                        ? '/^-?(?:0|[1-9]\d*)$/'
                        : '/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/';
                if (self::exactValue($codec['value']) && preg_match($pattern, $value)) {
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
        return $value;
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
        return self::executeNode(
            self::numericView(
                $value,
                [[$s, $definitions]],
                $path,
                $response,
                $matching,
                $depth,
                $allowUnknownResponseFields,
                (object) ['remaining' => [], 'exhausted' => false],
            ),
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
            $value = $value->jsonSerialize();
        }
        self::wireKind($s['value']);
        if (
            isset($s['every']) ||
            isset($s['some']) ||
            isset($s['exactlyOne']) ||
            isset($s['exclude'])
        ) {
            $base = array_diff_key(
                $s,
                array_flip(['every', 'some', 'exactlyOne', 'exclude', 'tag']),
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
            foreach ($s['every'] ?? [] as $branch) {
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
        if ($matching && self::exactValue($s['value']) && is_string($value)) {
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
        foreach ($this->contract['operations'] as $op) {
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
            foreach ($op['responses'] as $status => $response) {
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
                        if (isset($declared['codec'])) {
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
                        $tag = $declared['codec']['tag'];
                        $model = $declared['variants'][$data->{$tag} ?? ''] ?? null;
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
