<?php
declare(strict_types=1);
namespace SdkNamespace;
require_once __DIR__ . '/SchemaAdapter.php';

class SdkError extends \RuntimeException implements \JsonSerializable
{
    public const OUTCOME_NOT_SENT = 'not_sent';
    public const OUTCOME_RESPONSE = 'response';
    public const OUTCOME_UNKNOWN = 'unknown';
    /** @var string */
    public $code = '';
    /** @var \WeakMap<SdkError, string>|null */
    private static ?\WeakMap $kinds = null;
    /** @param list<string> $requestIds
     * @param array<string, string> $headers
     */
    public function __construct(
        string $message,
        string $code = '',
        public ?string $operation = null,
        public string $outcome = 'not_sent',
        public bool $retryAllowed = false,
        public ?int $status = null,
        public ?string $requestId = null,
        public array $requestIds = [],
        public ?string $idempotencyKey = null,
        public int $attempts = 0,
        public ?float $durationMs = null,
        public int|float|null $retryAfterMs = null,
        public array $headers = [],
        public readonly ?string $raw = null,
        ?\Throwable $previous = null,
        mixed $details = null,
        public ?string $param = null,
    ) {
        parent::__construct($message, 0, $previous);
        $this->code = $code;
        if ($requestIds === [] && $requestId !== null) {
            $this->requestIds = [$requestId];
        }
        if ($this instanceof Errors\ApiError) {
            $this->details = $details;
        }
    }
    /** Internal migration adapter; removed when call sites migrate.
     * @param array<string, mixed>|null $meta
     */
    public static function create(
        string $kind,
        string $message,
        string $outcome = 'not_sent',
        bool $retryAllowed = false,
        ?array $meta = null,
        ?string $errorCode = null,
        mixed $details = null,
        ?\Throwable $previous = null,
        ?string $raw = null,
    ): self {
        $status = $meta['status'] ?? null;
        $class =
            $status >= 400 &&
            $status < 600 &&
            !in_array($kind, ['transport', 'timeout', 'deadline', 'cancelled'], true)
                ? match (true) {
                    $status === 400 || $status === 422 => Errors\InvalidRequestError::class,
                    $status === 401 => Errors\AuthenticationError::class,
                    $status === 403 => Errors\PermissionError::class,
                    $status === 404 => Errors\NotFoundError::class,
                    $status === 409 || $status === 412 => Errors\ConflictError::class,
                    $status === 429 => Errors\RateLimitError::class,
                    $status >= 500 => Errors\ServerError::class,
                    default => Errors\ApiError::class,
                }
                : match (true) {
                    $kind === 'webhook' => Errors\WebhookVerificationError::class,
                    $kind === 'transport' => Errors\ConnectionError::class,
                    $kind === 'timeout' || $kind === 'deadline' => Errors\TimeoutError::class,
                    $kind === 'cancelled' => Errors\CancelledError::class,
                    $kind === 'protocol' ||
                        $kind === 'api' ||
                        ($kind === 'destination' && $meta !== null)
                        => Errors\UnexpectedResponseError::class,
                    $kind === 'authentication' || $kind === 'destination'
                        => Errors\ConfigurationError::class,
                    default => Errors\InvalidInputError::class,
                };
        if (!class_exists($class)) {
            $class = self::class;
        }
        $error = new $class(
            $message,
            code: $errorCode ?? '',
            outcome: $outcome,
            retryAllowed: $retryAllowed,
            status: $status,
            requestId: $meta['requestId'] ?? null,
            requestIds: $meta['requestIds'] ?? [],
            idempotencyKey: $meta['idempotencyKey'] ?? null,
            attempts: $meta['attempts'] ?? 0,
            durationMs: $meta['durationMs'] ?? null,
            headers: $meta['headers'] ?? [],
            details: $details,
            previous: $previous,
            raw: $raw,
        );
        if ($error instanceof Errors\ConfigurationError && is_array($details)) {
            $identity = $details;
            if (array_key_exists('error_description', $identity)) {
                $identity['errorDescription'] = $identity['error_description'];
                unset($identity['error_description']);
            }
            $error->workloadIdentity = $identity;
        }
        if (
            $error instanceof Errors\UnexpectedResponseError &&
            is_array($details) &&
            isset($details['eventId'], $details['position'])
        ) {
            $error->event = ['id' => $details['eventId'], 'position' => $details['position']];
        }
        self::$kinds ??= new \WeakMap();
        self::$kinds[$error] = $kind;
        $caller = debug_backtrace(DEBUG_BACKTRACE_IGNORE_ARGS, 2)[0];
        $error->file = $caller['file'] ?? $error->file;
        $error->line = $caller['line'] ?? $error->line;
        return $error;
    }
    /** @internal */
    public static function internalKind(self $error): ?string
    {
        return self::$kinds[$error] ??
            ($error instanceof Errors\InvalidInputError ? 'validation' : null);
    }
    public function jsonSerialize(): array
    {
        return $this->__debugInfo();
    }
    public function __toString(): string
    {
        // Exception rendering otherwise includes previous exceptions and trace arguments.
        $frames = array_map(
            fn($frame) => ($frame['file'] ?? '[internal]') .
                ':' .
                ($frame['line'] ?? 0) .
                ' ' .
                ($frame['class'] ?? '') .
                ($frame['type'] ?? '') .
                $frame['function'],
            $this->getTrace(),
        );
        return static::class .
            ': ' .
            $this->message .
            ($this->status !== null
                ? ' [HTTP ' .
                    $this->status .
                    ', ' .
                    $this->code .
                    ($this->requestId !== null ? ', ' . $this->requestId : '') .
                    ']'
                : '') .
            ' in ' .
            $this->getFile() .
            ':' .
            $this->getLine() .
            "\nStack trace:\n" .
            implode("\n", $frames);
    }
    public function __debugInfo(): array
    {
        $previous = $this->getPrevious();
        return [
            'name' => substr(strrchr(static::class, '\\') ?: static::class, 1),
            'message' => $this->message,
            'code' => $this->code,
            ...$this->param !== null ? ['param' => $this->param] : [],
            'operation' => $this->operation,
            'outcome' => $this->outcome,
            'retryAllowed' => $this->retryAllowed,
            'status' => $this->status,
            'requestId' => $this->requestId,
            'requestIds' => $this->requestIds,
            'idempotencyKey' => $this->idempotencyKey,
            'attempts' => $this->attempts,
            'retryAfterMs' => $this->retryAfterMs,
            ...$this instanceof Errors\ApiError ? ['details' => $this->details] : [],
            'cause' =>
                $previous !== null
                    ? [
                        'name' => $previous instanceof \TypeError ? 'TypeError' : 'Error',
                        'code' => $previous->getCode(),
                    ]
                    : null,
            // Trace arguments can contain raw response bodies and credentials.
            'stack' => array_map(
                fn($frame) => array_intersect_key(
                    $frame,
                    array_flip(['file', 'line', 'class', 'type', 'function']),
                ),
                $this->getTrace(),
            ),
        ];
    }
}
/** @template T */
final class Result
{
    /** @param T $data
     * @param array{status: int, requestId?: string|null, attempts: int, durationMs: float, ...} $meta
     */
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
interface CredentialProvider
{
    public function getCredential(): Credential;
}
final class Credential
{
    public function __construct(
        #[\SensitiveParameter] public readonly string $value,
        public readonly ?\DateTimeInterface $expiresAt = null,
    ) {}
    public function __debugInfo(): array
    {
        return ['value' => '[REDACTED]', 'expiresAt' => $this->expiresAt];
    }
}
/** Lazy built-in provider. Transport injection is privileged and sees exchange credentials. */
final class AmbientCredentialProvider implements CredentialProvider
{
    private static array $tokens = [];
    private static array $active = [];
    private ?Credential $lastCredential = null;
    private ?\WeakMap $invalidations = null;
    public function __construct(
        private readonly array $config,
        private readonly ?array $identity = null,
        private readonly ?string $baseUrl = null,
    ) {}
    public function __debugInfo(): array
    {
        return ['credentials' => '[REDACTED]'];
    }
    public function canInvalidate(?Credential $credential = null): bool
    {
        $credential ??= $this->lastCredential;
        return $credential !== null && isset($this->invalidations[$credential]);
    }
    public function invalidate(?Credential $credential = null): void
    {
        $credential ??= $this->lastCredential;
        if ($credential !== null && isset($this->invalidations[$credential])) {
            $this->invalidations[$credential]();
        }
    }
    public function getCredential(): Credential
    {
        return $this->resolve([]);
    }
    public function resolve(#[\SensitiveParameter] array $context): Credential
    {
        $prefix = $this->config['workloadIdentity']['envPrefix'];
        $read = static function (string $suffix) use ($prefix): ?string {
            $value = getenv($prefix . '_' . $suffix);
            return $value === false || $value === '' ? null : $value;
        };
        $id = $this->identity['workloadIdentityId'] ?? $read('WORKLOAD_IDENTITY_ID');
        $source = $this->identity['source'] ?? ($read('OIDC_SOURCE') ?? 'auto');
        $subject = '';
        $responseTokens = [];
        $claims = [];
        $environment = $this->config['environment'];
        $clean = static function (#[\SensitiveParameter] $value) use (
            &$subject,
            &$responseTokens,
            $environment,
        ): string {
            $text = is_string($value)
                ? $value
                : (json_encode($value, JSON_INVALID_UTF8_SUBSTITUTE) ?:
                '');
            foreach (
                [
                    $subject,
                    ...$responseTokens,
                    getenv($environment['apiKey']),
                    getenv($environment['token']),
                    getenv('ACTIONS_ID_TOKEN_REQUEST_TOKEN'),
                ]
                as $secret
            ) {
                if (is_string($secret) && $secret !== '') {
                    $text = str_replace([$secret, rawurlencode($secret)], '[REDACTED]', $text);
                }
            }
            return substr(
                preg_replace(
                    '/eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/',
                    '[REDACTED]',
                    $text,
                ),
                0,
                2048,
            );
        };
        $fail = static function (
            string $reason,
            #[\SensitiveParameter] string $description = '',
        ) use (&$source, $id, &$claims, $clean): never {
            $details = [
                'reason' => $reason,
                'source' => $clean($source),
                'workloadIdentityId' => $clean($id ?? ''),
                'iss' => $clean($claims['iss'] ?? null),
                'sub' => $clean($claims['sub'] ?? null),
                'aud' => $clean($claims['aud'] ?? null),
                'error_description' => $clean($description),
            ];
            throw SdkError::create(
                'authentication',
                $clean(json_encode($details)),
                'not_sent',
                false,
                null,
                $reason,
                $details,
            );
        };
        if ($this->identity === null) {
            $apiKey = getenv($environment['apiKey']);
            $token = getenv($environment['token']);
            if ($apiKey !== false && $apiKey !== '' && $token !== false && $token !== '') {
                $fail(
                    'ambiguous_credentials',
                    'Set only one of ' . $environment['apiKey'] . ' and ' . $environment['token'],
                );
            }
            if ($apiKey !== false && $apiKey !== '') {
                $this->lastCredential = null;
                return new Credential($apiKey);
            }
            if ($token !== false && $token !== '') {
                $this->lastCredential = null;
                return new Credential($token);
            }
            if ($id === null || $id === '') {
                $fail(
                    'no_credentials',
                    'Set ' .
                        $environment['apiKey'] .
                        ', ' .
                        $environment['token'] .
                        ', or ' .
                        $prefix .
                        '_WORKLOAD_IDENTITY_ID with ' .
                        $prefix .
                        '_OIDC_TOKEN or ' .
                        $prefix .
                        '_OIDC_TOKEN_FILE, or GitHub Actions permissions: id-token: write',
                );
            }
        }
        if (!is_string($id) || $id === '' || preg_match('/[\r\n]/', $id)) {
            $fail('source_unavailable', 'A workload identity ID is required');
        }
        $base = $context['baseUrl'] ?? $this->baseUrl;
        if (!$base) {
            $fail('source_unavailable', 'Pass this provider to a client with a base URL');
        }
        $parts = parse_url($base);
        $scheme = strtolower($parts['scheme'] ?? '');
        $host = strtolower($parts['host'] ?? '');
        if (
            $scheme !== 'https' &&
            !($scheme === 'http' && in_array($host, ['localhost', '127.0.0.1', '[::1]'], true))
        ) {
            $fail('exchange_unavailable', 'Token exchange requires HTTPS or loopback');
        }
        $port = $parts['port'] ?? null;
        $origin =
            $scheme .
            '://' .
            $host .
            ($port !== null &&
            !(($scheme === 'http' && $port === 80) || ($scheme === 'https' && $port === 443))
                ? ':' . $port
                : '');
        $audience = $this->identity['audience'] ?? ($read('OIDC_AUDIENCE') ?? $origin);
        $scope = $this->identity['scope'] ?? $read('OIDC_SCOPE');
        $file = $read('OIDC_TOKEN_FILE');
        if ($source === 'auto') {
            $source = $read('OIDC_TOKEN')
                ? 'token'
                : ($file
                    ? 'token_file'
                    : (getenv('GITHUB_ACTIONS') === 'true'
                        ? 'github_actions'
                        : 'none'));
        }
        if (!in_array($source, ['token', 'token_file', 'github_actions'], true)) {
            $fail('source_unavailable', 'Supported sources: token, token_file, github_actions');
        }
        $githubUrl = getenv('ACTIONS_ID_TOKEN_REQUEST_URL');
        $githubToken = getenv('ACTIONS_ID_TOKEN_REQUEST_TOKEN');
        if ($source === 'github_actions' && (!$githubUrl || !$githubToken)) {
            $fail('source_unavailable', 'GitHub Actions requires permissions: id-token: write');
        }
        $sourceKey =
            $source === 'token'
                ? hash('sha256', $read('OIDC_TOKEN') ?? '')
                : ($source === 'github_actions'
                    ? hash('sha256', json_encode([$githubUrl, $githubToken]))
                    : $file);
        $key = hash(
            'sha256',
            json_encode([
                $origin,
                $this->config['workloadIdentity']['tokenPath'],
                $this->config['workloadIdentity']['credentialParameter'],
                $prefix,
                $id,
                $audience,
                $scope ?? '',
                $source,
                $sourceKey,
            ]),
        );
        $cache = $context['credentialCache'] ?? null;
        $cached = self::$tokens[$key] ?? $cache?->get($key);
        if (
            !is_array($cached) ||
            !is_string($cached['value'] ?? null) ||
            !is_numeric($cached['expiresAt'] ?? null) ||
            !is_numeric($cached['lifetime'] ?? null)
        ) {
            $cached = null;
        }
        // Each resolution retains its own partition and rejected-token comparison.
        $credential = function (array $entry) use ($key, $cache): Credential {
            $result = new Credential(
                $entry['value'],
                new \DateTimeImmutable('@' . (int) $entry['expiresAt']),
            );
            $this->invalidations ??= new \WeakMap();
            $this->invalidations[$result] = static function () use ($key, $cache, $entry): void {
                if ((self::$tokens[$key]['value'] ?? null) === $entry['value']) {
                    unset(self::$tokens[$key]);
                    $cache?->delete($key);
                }
            };
            return $this->lastCredential = $result;
        };
        $remaining = $cached ? $cached['expiresAt'] - microtime(true) : 0;
        if ($cached && $remaining > 30 && $remaining >= max(60, $cached['lifetime'] * 0.2)) {
            self::$tokens[$key] = $cached;
            return $credential($cached);
        }
        // Yield each waiter's own wake conditions so schedulers can resume it independently.
        $deadline = $context['deadline'] ?? hrtime(true) / 1e6 + 30000;
        $checkWaiter = static function () use ($context, $deadline): void {
            if (($context['cancellation'] ?? null)?->isCancelled()) {
                throw SdkError::create('cancelled', 'Request cancelled', 'not_sent');
            }
            if (hrtime(true) / 1e6 >= $deadline) {
                throw SdkError::create('deadline', 'Overall deadline exceeded', 'not_sent');
            }
        };
        if (isset(self::$active[$key])) {
            $flight = self::$active[$key];
            if (\Fiber::getCurrent() === null) {
                $fail('exchange_unavailable', 'Reentrant token exchange without a Fiber scheduler');
            }
            while (true) {
                $checkWaiter();
                if ($flight->done) {
                    break;
                }
                \Fiber::suspend([
                    'deadline' => $deadline,
                    'cancellation' => $context['cancellation'] ?? null,
                ]);
            }
            if ($flight->error !== null) {
                throw $flight->error;
            }
            return $credential($flight->result);
        }
        $flight = (object) ['done' => false, 'result' => null, 'error' => null];
        self::$active[$key] = $flight;
        try {
            if ($source === 'github_actions') {
                $endpoint = parse_url($githubUrl);
                if (
                    $endpoint === false ||
                    isset($endpoint['user']) ||
                    isset($endpoint['pass']) ||
                    isset($endpoint['fragment']) ||
                    !(
                        ($endpoint['scheme'] ?? '') === 'https' ||
                        (($endpoint['scheme'] ?? '') === 'http' &&
                            in_array(
                                $endpoint['host'] ?? '',
                                ['localhost', '127.0.0.1', '[::1]'],
                                true,
                            ))
                    )
                ) {
                    $fail(
                        'source_unavailable',
                        'GitHub Actions identity endpoint requires HTTPS or loopback',
                    );
                }
                parse_str($endpoint['query'] ?? '', $query);
                $query['audience'] = $audience;
                $endpointUrl =
                    explode('?', $githubUrl, 2)[0] .
                    '?' .
                    http_build_query($query, '', '&', PHP_QUERY_RFC3986);
                $remaining = $deadline - hrtime(true) / 1e6;
                if ($remaining <= 0 || ($context['cancellation'] ?? null)?->isCancelled()) {
                    $fail(
                        'subject_token_request_failed',
                        'GitHub Actions identity request deadline exceeded or cancelled',
                    );
                }
                $request = [
                    'url' => $endpointUrl,
                    'method' => 'GET',
                    'headers' => [
                        'authorization' => 'Bearer ' . $githubToken,
                        'accept' => 'application/json',
                    ],
                    'body' => '',
                    'timeoutMs' => max(1, (int) ceil($remaining)),
                    'cancellation' => $context['cancellation'] ?? null,
                ];
                try {
                    $response = isset($context['transport'])
                        ? $context['transport']($request)
                        : self::send($request);
                } catch (\Throwable) {
                    $fail('subject_token_request_failed', 'GitHub Actions identity request failed');
                }
                if (($response['failureCode'] ?? null) || $response['status'] !== 200) {
                    $fail(
                        'subject_token_request_failed',
                        'GitHub Actions identity request failed; check permissions: id-token: write',
                    );
                }
                $payload = json_decode($response['body'] ?? '', true);
                if (!is_array($payload) || !is_string($payload['value'] ?? null)) {
                    $fail(
                        'subject_token_request_failed',
                        'Invalid GitHub Actions identity response',
                    );
                }
                $subject = $payload['value'];
            } elseif ($source === 'token') {
                $subject = $read('OIDC_TOKEN') ?? '';
            } else {
                $value = $file ? @file_get_contents($file) : '';
                if ($value === false) {
                    $fail('subject_token_request_failed', 'Cannot read the configured token file');
                }
                $subject = trim($value);
            }
            if ($subject === '') {
                $fail('source_unavailable', 'The selected token source is empty');
            }
            $jwt = explode('.', $subject);
            if (
                count($jwt) !== 3 ||
                count(
                    array_filter($jwt, static fn($p) => preg_match('/^[A-Za-z0-9_-]+$/D', $p)),
                ) !== 3
            ) {
                $fail('audience_mismatch', 'Subject token must be a JWT with aud and exp');
            }
            $payload = base64_decode(strtr($jwt[1], '-_', '+/'), true);
            $claims = $payload === false ? null : json_decode($payload, true);
            if (!is_array($claims)) {
                $claims = [];
                $fail('audience_mismatch', 'Subject token must be a JWT with aud and exp');
            }
            $aud = $claims['aud'] ?? null;
            $exp = $claims['exp'] ?? null;
            if (
                !($aud === $audience || (is_array($aud) && in_array($audience, $aud, true))) ||
                !(is_int($exp) || is_float($exp)) ||
                !is_finite((float) $exp) ||
                $exp <= microtime(true)
            ) {
                $fail('audience_mismatch', 'Subject token audience differs or expiry has passed');
            }
            $form = [
                'grant_type' => 'urn:ietf:params:oauth:grant-type:token-exchange',
                'subject_token' => $subject,
                'subject_token_type' => 'urn:ietf:params:oauth:token-type:jwt',
                'requested_token_type' => 'urn:ietf:params:oauth:token-type:access_token',
                $this->config['workloadIdentity']['credentialParameter'] => $id,
            ];
            if ($scope !== null) {
                $form['scope'] = $scope;
            }
            for ($attempt = 0; $attempt < 3; $attempt++) {
                $remaining = $deadline - hrtime(true) / 1e6;
                if ($remaining <= 0 || ($context['cancellation'] ?? null)?->isCancelled()) {
                    $fail('exchange_unavailable', 'Exchange deadline exceeded or cancelled');
                }
                $request = [
                    'url' => $origin . $this->config['workloadIdentity']['tokenPath'],
                    'method' => 'POST',
                    'headers' => [
                        'content-type' => 'application/x-www-form-urlencoded',
                        'accept' => 'application/json',
                    ],
                    'body' => http_build_query($form, '', '&', PHP_QUERY_RFC3986),
                    'timeoutMs' => max(1, (int) ceil($remaining)),
                    'cancellation' => $context['cancellation'] ?? null,
                ];
                try {
                    $response = isset($context['transport'])
                        ? $context['transport']($request)
                        : self::send($request);
                } catch (\Throwable) {
                    $fail('exchange_unavailable', 'Token exchange transport failed');
                }
                if ($response['failureCode'] ?? null) {
                    $fail('exchange_unavailable', 'Token exchange transport failed');
                }
                $status = $response['status'];
                $body = json_decode($response['body'] ?? '', true);
                foreach (is_array($body) ? $body : [] as $name => $value) {
                    if (
                        ($name === 'token' || str_ends_with((string) $name, '_token')) &&
                        is_string($value) &&
                        $value !== ''
                    ) {
                        $responseTokens[] = $value;
                    }
                }
                $description =
                    is_array($body) && is_string($body['error_description'] ?? null)
                        ? $body['error_description']
                        : '';
                if ($status === 429 || $status >= 500) {
                    $headers = array_change_key_case($response['headers'] ?? [], CASE_LOWER);
                    $instruction = $headers['retry-after'] ?? null;
                    $wait =
                        $instruction !== null
                            ? (is_numeric($instruction)
                                ? (float) $instruction * 1000
                                : ((strtotime($instruction) ?: 0) - microtime(true)) * 1000)
                            : 100 * 2 ** $attempt;
                    $wait = max(0, $wait);
                    if ($attempt === 2 || hrtime(true) / 1e6 + $wait >= $deadline) {
                        $fail('exchange_unavailable', $description);
                    }
                    $until = hrtime(true) / 1e6 + $wait;
                    do {
                        if (($context['cancellation'] ?? null)?->isCancelled()) {
                            $fail('exchange_unavailable', 'Exchange cancelled');
                        }
                        $left = $until - hrtime(true) / 1e6;
                        if ($left > 0) {
                            usleep((int) min(50000, ceil($left * 1000)));
                        }
                    } while ($left > 0);
                    continue;
                }
                if ($status !== 200) {
                    $fail('exchange_rejected', $description);
                }
                if (
                    !is_array($body) ||
                    !is_string($body['access_token'] ?? null) ||
                    $body['access_token'] === '' ||
                    preg_match('/[\r\n]/', $body['access_token']) ||
                    ($body['token_type'] ?? null) !== 'Bearer' ||
                    ($body['issued_token_type'] ?? null) !==
                        'urn:ietf:params:oauth:token-type:access_token' ||
                    !(
                        is_int($body['expires_in'] ?? null) || is_float($body['expires_in'] ?? null)
                    ) ||
                    !is_finite((float) $body['expires_in']) ||
                    $body['expires_in'] <= 30 ||
                    (isset($body['scope']) && !is_string($body['scope']))
                ) {
                    $fail('exchange_rejected', 'Invalid token exchange response');
                }
                $lifetime = min($body['expires_in'], $exp - microtime(true));
                if ($lifetime <= 30) {
                    $fail('exchange_rejected', 'Exchanged token has at most 30 seconds remaining');
                }
                $entry = [
                    'value' => $body['access_token'],
                    'expiresAt' => microtime(true) + $lifetime,
                    'lifetime' => $lifetime,
                ];
                self::$tokens[$key] = $entry;
                $cache?->set($key, $entry, max(1, (int) floor($lifetime - 30)));
                $flight->result = $entry;
                return $credential($entry);
            }
            $fail('exchange_unavailable');
        } catch (\Throwable $caught) {
            $error =
                $caught instanceof SdkError
                    ? $caught
                    : SdkError::create(
                        'authentication',
                        'Token exchange failed',
                        'not_sent',
                        false,
                        null,
                        'exchange_unavailable',
                    );
            if (
                $cached &&
                $cached['expiresAt'] - microtime(true) > 30 &&
                $error->code === 'exchange_unavailable'
            ) {
                $flight->result = $cached;
                return $credential($cached);
            }
            $flight->error = $error;
            throw $error;
        } finally {
            $flight->done = true;
            unset(self::$active[$key]);
        }
    }
    private static function send(#[\SensitiveParameter] array $request): array
    {
        $ch = curl_init();
        $headers = [];
        try {
            curl_setopt_array($ch, [
                CURLOPT_URL => $request['url'],
                CURLOPT_CUSTOMREQUEST => $request['method'],
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_FOLLOWLOCATION => false,
                CURLOPT_TIMEOUT_MS => $request['timeoutMs'],
                CURLOPT_HTTPHEADER => array_map(
                    static fn($name, $value) => $name . ': ' . $value,
                    array_keys($request['headers']),
                    $request['headers'],
                ),
                CURLOPT_NOPROGRESS => false,
                CURLOPT_XFERINFOFUNCTION => static fn() => $request['cancellation']?->isCancelled()
                    ? 1
                    : 0,
                CURLOPT_HEADERFUNCTION => static function ($ch, string $line) use (&$headers): int {
                    if (str_starts_with($line, 'HTTP/')) {
                        $headers = [];
                    } elseif (str_contains($line, ':')) {
                        [$name, $value] = explode(':', $line, 2);
                        $headers[strtolower(trim($name))] = trim($value);
                    }
                    return strlen($line);
                },
            ]);
            if ($request['method'] === 'GET') {
                curl_setopt($ch, CURLOPT_PROXY, '');
            }
            if ($request['method'] === 'POST') {
                curl_setopt($ch, CURLOPT_POSTFIELDS, $request['body']);
            }
            $body = curl_exec($ch);
            return [
                'status' => curl_getinfo($ch, CURLINFO_RESPONSE_CODE),
                'headers' => $headers,
                'body' => $body === false ? '' : $body,
                'failureCode' => $body === false ? curl_errno($ch) : null,
            ];
        } finally {
            curl_close($ch);
        }
    }
}

/** @internal Default marker distinguishes omitted named arguments from explicit null. */
enum Omitted
{
    case Value;
}

/** Per-call overrides, passed as the final argument. See RUNTIME.md#requestoptions. */
final class RequestOptions
{
    public function __construct(
        public readonly array $headers = [],
        public readonly ?string $idempotencyKey = null,
        public readonly ?string $ifMatch = null,
        public readonly ?int $timeoutMs = null,
        public readonly ?int $deadlineMs = null,
        // Keep fractions intact in weak-mode PHP so request validation can reject them.
        public readonly int|float|null $maxAttempts = null,
        public readonly ?Cancellation $cancellation = null,
        public readonly ?int $maxPages = null,
        public readonly ?int $maxItems = null,
        public readonly ?string $authMode = null,
        public readonly array|string|Omitted|null $credentials = Omitted::Value,
        public readonly ?int $streamIdleTimeoutMs = null,
        public readonly ?int $streamLifetimeMs = null,
    ) {
        /* AUTH_SHORTCUT_REQUEST_PARAMETERS */
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
            /* REQUEST_OPTION_FORWARD */
        );
    }
}
/** Client environment, credentials and transport defaults. See RUNTIME.md#clientoptions. */
final class ClientOptions
{
    public function __construct(
        public readonly ?string $baseUrl = null,
        public readonly string|CredentialProvider|\Closure|Omitted|null $token = Omitted::Value,
        public readonly ?array $allowedOrigins = null,
        public readonly bool $allowInsecureHttp = false,
        public readonly ?int $timeoutMs = null,
        public readonly ?int $deadlineMs = null,
        // Keep fractions intact in weak-mode PHP so request validation can reject them.
        public readonly int|float|null $maxAttempts = null,
        public readonly ?\Closure $transport = null,
        public readonly ?\Closure $diagnostics = null,
        public readonly array $redactFields = [],
        public readonly ?string $authMode = null,
        public readonly array|string|Omitted|null $credentials = Omitted::Value,
        public readonly bool $ambientCredentials = true,
        public readonly ?object $credentialCache = null,
    ) {
        /* AUTH_SHORTCUT_CLIENT_PARAMETERS */
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
            // Preserve received headers so Runtime can classify a failed response.
            if (!$this->headersDone) {
                $this->checkFailure();
            }
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
                throw new \RuntimeException(curl_strerror($this->failure), $this->failure);
            }
            throw SdkError::create(
                $this->failure === CURLE_OPERATION_TIMEDOUT ? 'timeout' : 'transport',
                'Streaming transport failed: ' . curl_strerror($this->failure),
                'response',
                false,
                details: [
                    'curlCode' => $this->failure,
                    'curlError' => curl_strerror($this->failure),
                ],
            );
        }
    }
    private function checkRequestTimeout(): void
    {
        if (!$this->streaming && self::now() - $this->started >= $this->request['timeoutMs']) {
            // Let Runtime classify the exhausted overall/per-attempt budget and
            // retain its normal transport retry policy for buffered responses.
            throw new \RuntimeException(
                curl_strerror(CURLE_OPERATION_TIMEDOUT),
                CURLE_OPERATION_TIMEDOUT,
            );
        }
    }
    /** Transfer connection ownership only after Runtime accepts an SSE response. */
    public function startStream(): void
    {
        try {
            $this->checkFailure();
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
            throw SdkError::create('cancelled', 'Stream cancelled', 'response');
        }
        if ($this->streaming && self::now() - $waitStart >= $timeout) {
            throw SdkError::create(
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
            throw SdkError::create('deadline', 'Stream lifetime exceeded', 'response');
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
            throw SdkError::create('transport', 'Streaming transport failed', 'unknown');
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
                    throw SdkError::create('cancelled', 'Stream cancelled', 'response');
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
            throw SdkError::create('validation', 'A stream can only be consumed once');
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
        $position = 0;
        try {
            while (!$this->closed) {
                if (($this->settings['cancellation'] ?? null)?->isCancelled()) {
                    throw SdkError::create(
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
                    throw SdkError::create(
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
                    throw SdkError::create(
                        'cancelled',
                        'Stream cancelled',
                        'response',
                        false,
                        $this->meta,
                    );
                }
                if (hrtime(true) / 1000000 - $wait >= $this->settings['idleTimeoutMs']) {
                    throw SdkError::create(
                        'deadline',
                        'Stream idle timeout exceeded',
                        'response',
                        false,
                        $this->meta,
                    );
                }
                if ($chunk === null) {
                    if (preg_match('//u', $line) !== 1) {
                        throw SdkError::create(
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
                        throw SdkError::create(
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
                        throw SdkError::create(
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
                        throw SdkError::create(
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
                        throw SdkError::create(
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
                            $position++;
                            try {
                                $decoded = ($this->decode)(
                                    $event === '' ? 'message' : $event,
                                    $raw,
                                );
                            } catch (\Throwable $cause) {
                                throw SdkError::create(
                                    'protocol',
                                    'Invalid SSE event payload at event ' .
                                        $position .
                                        '; inspect details.eventId and details.position',
                                    'response',
                                    false,
                                    $this->meta,
                                    'sse_invalid_event',
                                    ['eventId' => $id, 'position' => $position],
                                    previous: $cause,
                                );
                            }
                            yield new ServerSentEvent(
                                $event === '' ? 'message' : $event,
                                $id,
                                $decoded,
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
            if (SdkError::internalKind($error) !== 'validation') {
                throw $error;
            }
            throw SdkError::create(
                'protocol',
                'Invalid SSE event payload',
                'response',
                false,
                $this->meta,
                previous: $error,
            );
        } catch (\Throwable $error) {
            throw SdkError::create(
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
    private array $hydrated = [];
    private array $copyOnRead = [];
    private readonly bool $response;
    protected readonly mixed $values;
    private readonly mixed $inputValues;
    private readonly array $codec;
    private readonly ?array $representation;
    protected readonly array $schema;
    protected readonly array $redactFields;
    public function __construct(
        mixed $values,
        array $schema,
        bool $response = false,
        array $redactFields = [],
        ?array $compiled = null,
    ) {
        $this->response = $response;
        $this->schema = $schema;
        $codec = $compiled ?? \SdkNamespace\Internal\SchemaAdapter::compile($schema);
        $this->codec = $codec;
        $representation = $compiled['phpRepresentation'] ?? null;
        if ($representation !== null) {
            self::assertRepresentation($representation);
        }
        $this->representation = $representation;
        $this->redactFields = $redactFields;
        if (is_array($values) && $codec['modelObjectInput']) {
            $values = (object) $values;
        }
        $normalized = Codec::execute($values, $codec, [
            'mode' => $response ? 'response' : 'request',
        ]);
        // Store public values: unwrap nested models and exact wire-number wrappers,
        // while retaining the normalized distinction between objects and lists.
        $hasWireNumbers = false;
        $unwrap = function (mixed $value, int $depth = 0) use (&$unwrap, &$hasWireNumbers): mixed {
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
                $hasWireNumbers = true;
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
        $this->values = $unwrap($normalized);
        // Most response trees have identical public and input representations.
        // Share the privately owned tree unless exact wire numbers need wrappers.
        $this->inputValues = $hasWireNumbers ? $preserveNumbers($normalized) : $this->values;
    }
    /** @internal Validate the serialized public-value graph without invoking schema adapters. */
    public static function assertRepresentation(mixed $plan, int $depth = 0): void
    {
        if (!is_array($plan) || $depth > 256) {
            throw new \InvalidArgumentException('Invalid PHP representation');
        }
        switch ($plan['kind'] ?? null) {
            case 'value':
                if (
                    in_array(
                        $plan['type'] ?? null,
                        [
                            'mixed',
                            'null',
                            'string',
                            'int',
                            'float',
                            'bool',
                            '\\stdClass',
                            'array|object',
                        ],
                        true,
                    )
                ) {
                    return;
                }
                break;
            case 'entity':
                if (
                    is_string($plan['name'] ?? null) &&
                    preg_match('/^[A-Za-z][A-Za-z0-9_]*$/D', $plan['name'])
                ) {
                    return;
                }
                break;
            case 'nullable':
            case 'list':
            case 'map':
                self::assertRepresentation($plan['value'] ?? null, $depth + 1);
                return;
            case 'record':
            case 'tagged':
                $fields = $plan[$plan['kind'] === 'record' ? 'fields' : 'variants'] ?? null;
                if (
                    !is_array($fields) ||
                    ($plan['kind'] === 'tagged' && !is_string($plan['field'] ?? null))
                ) {
                    break;
                }
                foreach ($fields as $field) {
                    self::assertRepresentation($field, $depth + 1);
                }
                if (isset($plan['extra'])) {
                    self::assertRepresentation($plan['extra'], $depth + 1);
                }
                return;
        }
        throw new \InvalidArgumentException('Invalid PHP representation');
    }
    /** @internal Execute an already validated public representation after codec normalization. */
    public static function hydrate(
        mixed $value,
        array $plan,
        array $redactFields = [],
        int $depth = 0,
    ): mixed {
        if ($depth > 256) {
            throw new \InvalidArgumentException('PHP representation nesting limit');
        }
        switch ($plan['kind']) {
            case 'value':
                return self::copyValue($value);
            case 'nullable':
                return $value === null
                    ? null
                    : self::hydrate($value, $plan['value'], $redactFields, $depth + 1);
            case 'entity':
                if ($value instanceof Model) {
                    return $value;
                }
                $class = __NAMESPACE__ . '\\' . $plan['name'];
                return new $class($value, $redactFields);
            case 'list':
            case 'map':
                $out = [];
                foreach ((array) $value as $key => $child) {
                    $out[$key] = self::hydrate($child, $plan['value'], $redactFields, $depth + 1);
                }
                return $out;
            case 'tagged':
                $tag = is_object($value) ? $value->{$plan['field']} ?? null : null;
                return is_string($tag) && isset($plan['variants'][$tag])
                    ? self::hydrate($value, $plan['variants'][$tag], $redactFields, $depth + 1)
                    : self::copyValue($value);
            case 'record':
                $out = new \stdClass();
                foreach ((array) $value as $key => $child) {
                    $field = $plan['fields'][$key] ?? ($plan['extra'] ?? null);
                    $out->{$key} =
                        $field === null
                            ? self::copyValue($child)
                            : self::hydrate($child, $field, $redactFields, $depth + 1);
                }
                return $out;
        }
        throw new \InvalidArgumentException('Invalid PHP representation kind');
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
    private static function declaresField(
        array $codec,
        string $field,
        array $definitions = [],
        int $depth = 0,
    ): bool {
        if ($depth > 256) {
            throw new \InvalidArgumentException('Codec nesting limit');
        }
        $definitions = $codec['definitions'] ?? $definitions;
        if (isset($codec['fields'][$field])) {
            return true;
        }
        if (isset($codec['reference'])) {
            return self::declaresField(
                $definitions[$codec['reference']],
                $field,
                $definitions,
                $depth + 1,
            );
        }
        foreach (['every', 'some', 'exactlyOne'] as $group) {
            foreach ($codec[$group] ?? [] as $branch) {
                if (self::declaresField($branch, $field, $definitions, $depth + 1)) {
                    return true;
                }
            }
        }
        return false;
    }
    private static function containsMutableObject(mixed $value): bool
    {
        if ($value instanceof \stdClass) {
            return true;
        }
        if (is_array($value)) {
            foreach ($value as $child) {
                if (self::containsMutableObject($child)) {
                    return true;
                }
            }
        }
        return false;
    }
    public function get(string $field): mixed
    {
        if (!$this->has($field)) {
            if (!self::declaresField($this->codec, $field)) {
                throw SdkError::create('validation', 'Unknown model property ' . $field);
            }
            if ($this->response) {
                return null;
            }
            throw SdkError::create(
                'validation',
                'Field ' .
                    $field .
                    ' was omitted; use has() or valueOrDefault() for optional fields.',
            );
        }
        if (!array_key_exists($field, $this->hydrated)) {
            $value = is_object($this->values) ? $this->values->{$field} : $this->values[$field];
            $plan =
                $this->representation['fields'][$field] ?? ($this->representation['extra'] ?? null);
            $this->hydrated[$field] =
                $plan === null
                    ? self::copyValue($value)
                    : self::hydrate($value, $plan, $this->redactFields);
            $this->copyOnRead[$field] = self::containsMutableObject($this->hydrated[$field]);
        }
        // PHP arrays use copy-on-write; immutable model children can be shared.
        // Untyped objects remain defensive copies so callers cannot mutate the cache.
        return $this->copyOnRead[$field]
            ? self::copyValue($this->hydrated[$field])
            : $this->hydrated[$field];
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
    public function __set(string $field, mixed $value): void
    {
        throw SdkError::create(
            'validation',
            'Model properties are read-only; construct a new model with the updated values',
        );
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
            throw SdkError::create(
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
        if (array_key_exists('nullableAlternative', $value)) {
            $branches = $value['exactlyOne'] ?? ($value['some'] ?? null);
            $index = $value['nullableAlternative'];
            if (
                !is_int($index) ||
                !in_array($index, [0, 1], true) ||
                !is_array($branches) ||
                count($branches) !== 2 ||
                isset($value['exactlyOne'], $value['some']) ||
                ($branches[1 - $index]['value']['kind'] ?? null) !== 'null'
            ) {
                $invalid('invalid nullable alternative policy');
            }
            $concrete = $branches[$index];
            if (
                !isset($concrete['reference']) &&
                (($concrete['nullable'] ?? null) !== false ||
                    in_array(
                        $concrete['value']['kind'] ?? null,
                        ['dynamic', 'null', 'null-array', 'opaque'],
                        true,
                    ) ||
                    isset($concrete['some']) ||
                    isset($concrete['exactlyOne']))
            ) {
                $invalid('invalid concrete nullable alternative');
            }
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
        foreach (['element', 'propertyNames', 'exclude', 'includes'] as $key) {
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
    private static ?\WeakMap $validationFailures = null;

    /** @internal Only codec-authored diagnostics may be promoted into response errors. */
    public static function validationFailureMessage(\Throwable $error): ?string
    {
        return self::$validationFailures[$error] ?? null;
    }

    public static function fail(string $path, string $reason): never
    {
        $message = "$path: $reason";
        $error = SdkError::create('validation', $message);
        self::$validationFailures ??= new \WeakMap();
        self::$validationFailures[$error] = $message;
        throw $error;
    }
    public static function parse(string $text, bool $preserveNumbers = false): mixed
    {
        // Validate the original bytes before rewriting numeric tokens. Discard
        // that temporary tree before decoding the exact representation.
        if (!function_exists('json_validate') || !json_validate($text)) {
            json_decode($text, false, 512, JSON_THROW_ON_ERROR);
        }
        // Scan validated JSON in linear time. Skip string contents, including
        // escaped quotes/backslashes, without depending on PCRE resource limits.
        // Copy unchanged spans only when a token actually needs rewriting.
        $encoded = '';
        $copied = 0;
        $offset = 0;
        $length = strlen($text);
        while ($offset < $length) {
            $offset += strcspn($text, '"-0123456789', $offset);
            if ($offset === $length) {
                break;
            }
            $start = $offset;
            if ($text[$offset] === '"') {
                ++$offset;
                // Escape genuine strings beginning with our private marker.
                if (substr_compare($text, '\u0000', $offset, 6) === 0) {
                    $encoded .= substr($text, $copied, $offset - $copied) . '\u0000';
                    $copied = $offset;
                }
                do {
                    $offset += strcspn($text, "\"\\", $offset);
                    $escaped = $text[$offset] === '\\';
                    $offset += $escaped ? 2 : 1;
                } while ($escaped);
                continue;
            }
            $offset += strspn($text, '0123456789.eE+-', $offset);
            $token = substr($text, $start, $offset - $start);
            $safe =
                strcspn($token, '.eE') === strlen($token) &&
                abs((float) $token) <= 9007199254740991;
            if (!$safe) {
                $encoded .= substr($text, $copied, $start - $copied) . '"\u0000' . $token . '"';
                $copied = $offset;
            }
        }
        $encoded .= substr($text, $copied);
        $parsed = json_decode($encoded, false, 512, JSON_THROW_ON_ERROR);
        self::restoreNumbers($parsed, $preserveNumbers);
        return $parsed;
    }
    private static function restoreNumbers(mixed &$value, bool $preserveNumbers): void
    {
        if (is_string($value) && str_starts_with($value, "\0")) {
            $token = substr($value, 1);
            $value =
                str_starts_with($token, "\0") || !$preserveNumbers
                    ? $token
                    : new ParsedNumber($token);
        } elseif (is_array($value) || $value instanceof \stdClass) {
            foreach ($value as &$child) {
                self::restoreNumbers($child, $preserveNumbers);
            }
            unset($child);
        }
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
            if (
                (is_int($other) || is_float($other)) &&
                is_finite((float) $other) &&
                (float) $other === (float) $token->value
            ) {
                return $other;
            }
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
            if (
                $source instanceof ParsedNumber &&
                $token->value === $source->value &&
                (is_int($other) || is_float($other)) &&
                is_finite((float) $other) &&
                (float) $other === (float) $source->value
            ) {
                return $token;
            }
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
        // Prefer the exact projection when both branches validated the same token.
        if ($source instanceof ParsedNumber) {
            $exact = is_string($left) ? $left : (is_string($right) ? $right : null);
            $native =
                is_int($left) || is_float($left)
                    ? $left
                    : (is_int($right) || is_float($right)
                        ? $right
                        : null);
            if (
                $exact !== null &&
                $native !== null &&
                is_finite((float) $native) &&
                preg_match('/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/', $exact) &&
                self::compareDecimal($source->value, $exact) === 0 &&
                (float) $native === (float) $source->value
            ) {
                return $exact;
            }
        }
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
        if (
            (is_int($left) || is_float($left)) &&
            (is_int($right) || is_float($right)) &&
            self::compareDecimal(self::numberText($left), self::numberText($right)) === 0
        ) {
            return is_float($left) ? $left : $right;
        }
        foreach ([[$left, $right], [$right, $left]] as [$number, $text]) {
            if (
                (is_int($number) || is_float($number)) &&
                is_string($text) &&
                preg_match('/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/', $text) &&
                self::compareDecimal(self::numberText($number), $text) === 0
            ) {
                return $text;
            }
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
            'decimal', 'native-number' => 'number',
            'date-time' => 'string',
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
        if (isset($s['nullableAlternative']) && $response && !$matching) {
            $index = $value === null ? 1 - $s['nullableAlternative'] : $s['nullableAlternative'];
            return [[$index => $s[$keyword][$index]], true];
        }
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
                    if (SdkError::internalKind($e) === 'validation') {
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
                            if (SdkError::internalKind($e) === 'validation') {
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
                if ($budget->exhausted || SdkError::internalKind($e) !== 'validation') {
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
        if ($left instanceof \DateTimeInterface && is_string($right)) {
            return $right;
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
                            if (SdkError::internalKind($e) === 'validation') {
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
                if (
                    self::exactValue($codec['value']) ||
                    ($codec['value']['kind'] === 'native-number' &&
                        (is_int($source) || is_float($source)))
                ) {
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
        if ($value instanceof \DateTimeInterface && !$response) {
            foreach ($shapes as [$codec]) {
                if ($codec['value']['kind'] === 'date-time') {
                    $value = \DateTimeImmutable::createFromInterface($value)
                        ->setTimezone(new \DateTimeZone('UTC'))
                        ->format('Y-m-d\\TH:i:s.v\\Z');
                    break;
                }
            }
        }
        if (is_string($value)) {
            foreach ($shapes as [$codec]) {
                $pattern =
                    $codec['value']['kind'] === 'exact-integer'
                        ? '/^-?(?:0|[1-9]\d*)$/D'
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
        } elseif (
            (is_object($value) &&
                !($value instanceof ParsedNumber) &&
                !($value instanceof \DateTimeInterface)) ||
            is_array($value)
        ) {
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
                            if (SdkError::internalKind($e) === 'validation') {
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
                    if (SdkError::internalKind($e) !== 'validation') {
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
            if (SdkError::internalKind($error) !== 'validation') {
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
                    if (SdkError::internalKind($e) === 'validation') {
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
        if (
            !$response &&
            $type === 'integer' &&
            $value instanceof ExactNumber &&
            !preg_match('/^-?(?:0|[1-9]\d*)$/D', $value->value)
        ) {
            self::fail($path, 'expected an integer string');
        }
        $numberToken = $value instanceof ParsedNumber ? $value->value : null;
        if ($value instanceof ParsedNumber) {
            if ($type === null) {
                if (
                    (!$response || $matching) &&
                    isset($s['members']) &&
                    !array_filter(
                        $s['members'],
                        fn($v) => (is_int($v) || is_float($v)) &&
                            self::compareDecimal($value->value, self::numberText($v)) === 0,
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
                $value = self::exactValue($s['value']) ? $value->value : (float) $value->value;
            } else {
                self::fail($path, "expected $type; received a JSON number");
            }
        }
        $exactEnum = self::exactValue($s['value']) || $s['value']['kind'] === 'native-number';
        if (
            (!$response || $matching) &&
            isset($s['members']) &&
            !($exactEnum
                ? (is_string($value) || is_int($value) || is_float($value)) &&
                    preg_match(
                        '/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/',
                        (string) $value,
                    ) &&
                    array_filter(
                        $s['members'],
                        fn($member) => (is_int($member) || is_float($member)) &&
                            self::compareDecimal(
                                $numberToken ?? self::numberText($value),
                                self::numberText($member),
                            ) === 0,
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
                        ? '/^-?(?:0|[1-9]\d*)$/D'
                        : '/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/';
                if (!is_string($token) || !preg_match($pattern, $token)) {
                    self::fail(
                        $path,
                        $type === 'integer'
                            ? 'expected an integer string'
                            : 'expected an exact numeric string',
                    );
                }
                if (!$response || $matching) {
                    self::numericConstraints($token, $s, $path, $validateConstraints || $matching);
                }
                return $response ? $token : new RawNumber($token);
            }
            if ($s['value']['kind'] === 'native-number') {
                if ((!is_int($value) && !is_float($value)) || !is_finite((float) $value)) {
                    self::fail($path, 'expected a finite number');
                }
                if (!$response || $matching) {
                    self::numericConstraints(
                        $numberToken ?? self::numberText($value),
                        $s,
                        $path,
                        $validateConstraints || $matching,
                    );
                }
                return $response ? (float) $value : $value;
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
                if (isset($s['propertyNames'])) {
                    self::executeNode(
                        (string) $key,
                        $s['propertyNames'],
                        $path .
                            '[' .
                            json_encode(
                                (string) $key,
                                JSON_UNESCAPED_UNICODE |
                                    JSON_UNESCAPED_SLASHES |
                                    JSON_UNESCAPED_LINE_TERMINATORS |
                                    JSON_INVALID_UTF8_SUBSTITUTE,
                            ) .
                            ']',
                        true,
                        true,
                        $definitions,
                        $depth + 1,
                        true,
                    );
                }
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
                            if (SdkError::internalKind($error) !== 'validation') {
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
                fn($v, $index) => self::executeNode(
                    $v,
                    $s['element'] ?? self::ANY_CODEC,
                    "{$path}[$index]",
                    $response,
                    $matching,
                    $definitions,
                    $depth + 1,
                    $validateConstraints,
                    $allowUnknownResponseFields,
                ),
                $value,
                array_keys($value),
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
        if ($type === null && (is_int($value) || is_float($value)) && (!$response || $matching)) {
            if (!is_finite((float) $value)) {
                self::fail($path, 'expected a finite number');
            }
            self::numericConstraints(
                self::numberText($value),
                $s,
                $path,
                $validateConstraints || $matching,
            );
        }
        if ($type === 'boolean' && !is_bool($value)) {
            self::fail($path, 'expected a boolean');
        }
        return $value;
    }
    private static function numberText(string|int|float $value): string
    {
        return is_float($value) ? json_encode($value, JSON_THROW_ON_ERROR) : (string) $value;
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
        if (is_float($value) && !is_finite($value)) {
            self::fail('value', 'expected a finite number');
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
                return array_merge(
                    [$s],
                    isset($definitions[$s['reference']])
                        ? $shapes($definitions[$s['reference']])
                        : [],
                );
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
    private readonly string $baseUrl;
    protected readonly array $contract;
    private readonly ?Internal\DescriptorSource $descriptors;
    private mixed $curl = null;
    private array $streams = [];
    public function __construct(
        array|Internal\DescriptorSource $contract,
        private readonly ClientOptions $options,
        bool $compiled = false,
    ) {
        $this->descriptors = $contract instanceof Internal\DescriptorSource ? $contract : null;
        $this->contract = $this->descriptors
            ? $this->descriptors->settings()
            : ($compiled
                ? $contract
                : \SdkNamespace\Internal\SchemaAdapter::runtimePlan($contract));
        if (!$this->descriptors) {
            self::assertCompiledPlan($this->contract);
        }
        $this->credentialOptionsPassed($options);
        $baseUrl = $options->baseUrl ?? ($this->contract['defaultBaseUrl'] ?? null);
        if ($baseUrl === null) {
            Codec::fail('baseUrl', 'required: pass baseUrl because this SDK has no default server');
        }
        if (!self::validBaseUrl($baseUrl)) {
            Codec::fail(
                'baseUrl',
                'expected an absolute URL without credentials, whitespace, backslash, query or fragment',
            );
        }
        $this->baseUrl = $baseUrl;
        if (
            isset($this->contract['authentication']) &&
            $options->token !== Omitted::Value &&
            !isset($this->contract['authShortcuts']['token'])
        ) {
            $shortcuts = array_keys($this->contract['authShortcuts'] ?? []);
            sort($shortcuts);
            throw SdkError::create(
                'authentication',
                'token is not configured for this SDK; use ' .
                    ($shortcuts ? implode(', ', $shortcuts) : 'authMode and credentials'),
            );
        }
        $this->allowed = $options->allowedOrigins ?? [self::origin($this->baseUrl)];
        $this->checkUrl($this->baseUrl);
        if (
            ($options->timeoutMs !== null && $options->timeoutMs <= 0) ||
            ($options->deadlineMs !== null && $options->deadlineMs <= 0)
        ) {
            Codec::fail('options', 'timeouts must be positive');
        }
    }
    /** Validate presence without resolving a provider or reading the environment. */
    private function credentialOptionsPassed(ClientOptions|RequestOptions $options): bool
    {
        $validate = static function (mixed $value, string $param): void {
            if (
                $value === null ||
                (is_string($value) && preg_match('/^[\s\x{FEFF}]*$/uD', $value) === 1)
            ) {
                $state = $value === null ? 'null' : 'empty or blank';
                $kind = $param === 'apiKey' ? 'API key' : 'credential';
                throw new Errors\ConfigurationError(
                    $param .
                        ' was passed but is ' .
                        $state .
                        '. Pass a nonempty ' .
                        $kind .
                        '; default credentials are used only when no credential option is passed.',
                    code: 'credential_missing',
                    param: $param,
                );
            }
        };
        $passed = false;
        foreach (
            array_unique(['token', ...array_keys($this->contract['authShortcuts'] ?? [])])
            as $key
        ) {
            if (!property_exists($options, $key) || $options->$key === Omitted::Value) {
                continue;
            }
            $passed = true;
            $validate($options->$key, $key);
        }
        if ($options->credentials !== Omitted::Value) {
            $passed = true;
            $validate($options->credentials, 'credentials');
            foreach (
                is_array($options->credentials) ? $options->credentials : []
                as $key => $value
            ) {
                $param = 'credentials.' . $key;
                $validate($value, $param);
                if ($options instanceof ClientOptions && is_array($value)) {
                    foreach ($value as $scheme => $source) {
                        $validate($source, $param . '.' . $scheme);
                    }
                }
            }
        }
        return $passed;
    }
    public static function assertCompiledPlan(array $contract): void
    {
        if (
            ($contract['format'] ?? null) !== 1 ||
            !is_string($contract['semantics'] ?? null) ||
            ($contract['retrySemantics'] ?? null) !== 'budgets-2'
        ) {
            throw new \InvalidArgumentException('Unsupported compiled runtime format');
        }
        if (!is_array($contract['operations'] ?? null)) {
            throw new \InvalidArgumentException('Missing compiled operations');
        }
        if (array_key_exists('errors', $contract) && !is_array($contract['errors'])) {
            throw new \InvalidArgumentException('Invalid compiled error settings');
        }
        if (array_key_exists('inProgressCodes', $contract['errors'] ?? [])) {
            $codes = $contract['errors']['inProgressCodes'];
            if (
                !is_array($codes) ||
                !array_is_list($codes) ||
                count(array_filter($codes, fn($code) => !is_string($code) || trim($code) === '')) >
                    0
            ) {
                throw new \InvalidArgumentException('Invalid compiled in-progress codes');
            }
        }
        if (array_key_exists('retry', $contract['errors'] ?? [])) {
            $signal = $contract['errors']['retry'];
            if (
                !is_array($signal) ||
                !is_string($contract['errors']['codePath'] ?? null) ||
                $contract['errors']['codePath'] === '' ||
                !is_string($signal['path'] ?? null) ||
                !preg_match('/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/D', $signal['path']) ||
                !is_array($signal['retryValues'] ?? null) ||
                !array_is_list($signal['retryValues']) ||
                !$signal['retryValues'] ||
                count(
                    array_filter(
                        $signal['retryValues'],
                        fn($value) => !is_string($value) || trim($value) === '',
                    ),
                ) > 0
            ) {
                throw new \InvalidArgumentException('Invalid compiled error retry signal');
            }
        }
        if (array_key_exists('defaultBaseUrl', $contract)) {
            $default = $contract['defaultBaseUrl'];
            if (
                !is_string($default) ||
                !self::validBaseUrl($default) ||
                !in_array(
                    strtolower(parse_url($default, PHP_URL_SCHEME) ?? ''),
                    ['http', 'https'],
                    true,
                )
            ) {
                throw new \InvalidArgumentException('Invalid defaultBaseUrl in compiled runtime');
            }
        }
        if (array_key_exists('defaultCredentials', $contract)) {
            $d = $contract['defaultCredentials'];
            if (
                !is_array($d) ||
                !is_string($d['mode'] ?? null) ||
                !is_string($d['scheme'] ?? null) ||
                !is_array($d['environment'] ?? null) ||
                !is_array($d['workloadIdentity'] ?? null)
            ) {
                throw new \InvalidArgumentException('Invalid defaultCredentials declaration');
            }
            $schemes = $contract['authentication'][$d['mode']]['schemes'] ?? [];
            $env = $d['environment'];
            $identity = $d['workloadIdentity'];
            if (
                count($schemes) !== 1 ||
                ($schemes[0]['name'] ?? null) !== $d['scheme'] ||
                ($schemes[0]['type'] ?? null) !== 'bearer' ||
                array_diff(array_keys($d), ['mode', 'scheme', 'environment', 'workloadIdentity']) ||
                array_diff(array_keys($env), ['apiKey', 'token']) ||
                array_diff(array_keys($identity), ['tokenPath', 'credentialParameter', 'envPrefix'])
            ) {
                throw new \InvalidArgumentException('Invalid defaultCredentials mode or fields');
            }
            foreach (
                [$env['apiKey'] ?? null, $env['token'] ?? null, $identity['envPrefix'] ?? null]
                as $name
            ) {
                if (!is_string($name) || !preg_match('/^[A-Z_][A-Z0-9_]*$/D', $name)) {
                    throw new \InvalidArgumentException('Invalid defaultCredentials environment');
                }
            }
            if (
                $env['apiKey'] === $env['token'] ||
                !is_string($identity['tokenPath'] ?? null) ||
                !preg_match('~^/(?!/)[A-Za-z0-9/_-]+$~D', $identity['tokenPath']) ||
                !is_string($identity['credentialParameter'] ?? null) ||
                !preg_match('/^[a-z][a-z0-9_]*$/D', $identity['credentialParameter']) ||
                in_array(
                    $identity['credentialParameter'],
                    [
                        'grant_type',
                        'subject_token',
                        'subject_token_type',
                        'requested_token_type',
                        'scope',
                        'client_id',
                        'client_secret',
                        'audience',
                        'resource',
                        'actor_token',
                    ],
                    true,
                )
            ) {
                throw new \InvalidArgumentException('Invalid defaultCredentials exchange settings');
            }
        }
        foreach ($contract['authShortcuts'] ?? [] as $name => $shortcut) {
            $schemes = $contract['authentication'][$shortcut['mode'] ?? '']['schemes'] ?? [];
            if (
                !preg_match('/^[a-z][a-zA-Z0-9]*$/', $name) ||
                ($name !== 'token' &&
                    in_array(strtolower($name), /* AUTH_SHORTCUT_RESERVED */ [], true)) ||
                count($schemes) !== 1 ||
                ($schemes[0]['name'] ?? null) !== ($shortcut['scheme'] ?? null)
            ) {
                throw new \InvalidArgumentException('Invalid authentication shortcut');
            }
        }
        if (isset($contract['authentication'])) {
            if (!is_array($contract['authentication'])) {
                throw new \InvalidArgumentException('Invalid authentication modes');
            }
            foreach ($contract['authentication'] as $mode) {
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
        if (isset($contract['incoming'])) {
            if (!is_array($contract['incoming'])) {
                throw new \InvalidArgumentException('Invalid incoming contracts');
            }
            foreach ($contract['incoming'] as $entry) {
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
        foreach ($contract['operations'] as $op) {
            if (isset($op['authModes'])) {
                if (!is_array($op['authModes'])) {
                    throw new \InvalidArgumentException('Invalid operation authentication modes');
                }
                foreach ($op['authModes'] as $name) {
                    if (!is_string($name) || !isset($contract['authentication'][$name])) {
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
            if (array_key_exists('defaults', $op)) {
                if (!is_array($op['defaults']) || !$op['defaults']) {
                    throw new \InvalidArgumentException('Invalid compiled operation defaults');
                }
                foreach ($op['defaults'] as $name => $value) {
                    if (
                        !in_array($name, ['timeoutMs', 'deadlineMs'], true) ||
                        !is_int($value) ||
                        $value < 1 ||
                        $value > 9007199254740991
                    ) {
                        throw new \InvalidArgumentException('Invalid compiled operation defaults');
                    }
                }
            }
            if (array_key_exists('autoKeyPrefix', $op['idempotency'] ?? [])) {
                $prefix = $op['idempotency']['autoKeyPrefix'];
                if (!is_string($prefix) || preg_match('/[^\x20-\x7e]|^ /', $prefix)) {
                    throw new \InvalidArgumentException('Invalid compiled automatic key prefix');
                }
            }
            $policy = $op['retry'] ?? null;
            if (
                !is_array($policy) ||
                !in_array($op['replay'] ?? null, ['safe', 'idempotency'], true) ||
                !is_int($policy['maxAttempts'] ?? null) ||
                $policy['maxAttempts'] < 1 ||
                $policy['maxAttempts'] > 10 ||
                !is_array($policy['statuses'] ?? null) ||
                !array_is_list($policy['statuses']) ||
                !is_bool($policy['transport'] ?? null) ||
                (!is_int($policy['baseDelayMs'] ?? null) &&
                    !is_float($policy['baseDelayMs'] ?? null)) ||
                !is_finite((float) $policy['baseDelayMs']) ||
                $policy['baseDelayMs'] < 0 ||
                (array_key_exists('maxDelayMs', $policy) &&
                    ((!is_int($policy['maxDelayMs']) && !is_float($policy['maxDelayMs'])) ||
                        !is_finite((float) $policy['maxDelayMs']) ||
                        $policy['maxDelayMs'] < 0)) ||
                ($op['replay'] === 'idempotency' &&
                    $policy['maxAttempts'] > 1 &&
                    !isset($op['idempotency']))
            ) {
                throw new \InvalidArgumentException('Invalid compiled retry policy');
            }
            foreach ($policy['statuses'] as $status) {
                if (
                    !is_int($status) ||
                    $status < 400 ||
                    $status > 599 ||
                    in_array($status, [409, 412], true)
                ) {
                    throw new \InvalidArgumentException('Invalid compiled retry status');
                }
            }
            if (array_key_exists('errors', $policy)) {
                if (!is_array($policy['errors']) || !array_is_list($policy['errors'])) {
                    throw new \InvalidArgumentException('Invalid compiled retry errors');
                }
                foreach ($policy['errors'] as $rule) {
                    if (
                        !is_array($rule) ||
                        !is_int($rule['status'] ?? null) ||
                        $rule['status'] < 400 ||
                        $rule['status'] > 599 ||
                        $rule['status'] === 412 ||
                        !is_array($rule['codes'] ?? null) ||
                        !array_is_list($rule['codes']) ||
                        !$rule['codes'] ||
                        ($rule['status'] === 409 &&
                            (!isset($op['idempotency']) || isset($op['conditional'])))
                    ) {
                        throw new \InvalidArgumentException('Invalid compiled retry errors');
                    }
                    foreach ($rule['codes'] as $code) {
                        if (!is_string($code) || trim($code) === '') {
                            throw new \InvalidArgumentException('Invalid compiled retry code');
                        }
                    }
                }
            }
            foreach ($op['parameters'] as $parameter) {
                if (
                    array_key_exists('source', $parameter) &&
                    (!in_array($parameter['source'], ['authentication', 'request-option'], true) ||
                        ($parameter['in'] ?? null) !== 'header')
                ) {
                    throw new \InvalidArgumentException('Invalid compiled parameter source');
                }
                if (($parameter['source'] ?? null) === 'request-option') {
                    $plans = json_decode(
                        /* REQUEST_OPTION_PLANS */ '{}',
                        true,
                        512,
                        JSON_THROW_ON_ERROR,
                    );
                    $option = $plans[$parameter['x-flint-request-option'] ?? ''] ?? null;
                    if (
                        !$option ||
                        ($parameter['required'] ?? false) ||
                        ($parameter['requestOption'] ?? null) !== [
                            'node' => $option['node'],
                            'php' => $option['php'],
                        ] ||
                        $parameter['codec'] != $option['codec']
                    ) {
                        throw new \InvalidArgumentException('Invalid compiled request option');
                    }
                } elseif (
                    isset($parameter['requestOption']) ||
                    isset($parameter['x-flint-request-option'])
                ) {
                    throw new \InvalidArgumentException('Missing compiled request-option source');
                }
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
            if (array_key_exists('successJsonFallback', $op)) {
                $candidates = array_keys(
                    array_filter(
                        $op['responses'],
                        fn($response, $status) => preg_match('/^2[0-9]{2}$/D', (string) $status) &&
                            ($response['bodyKind'] ?? null) === 'json',
                        ARRAY_FILTER_USE_BOTH,
                    ),
                );
                if (
                    count($candidates) !== 1 ||
                    (string) $candidates[0] !== $op['successJsonFallback']
                ) {
                    throw new \InvalidArgumentException('Invalid JSON success fallback');
                }
            }
            foreach ($op['responses'] as $status => $response) {
                if (isset($response['phpRepresentation'])) {
                    Model::assertRepresentation($response['phpRepresentation']);
                }
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
        foreach ($contract['definitions'] ?? [] as $name => $codec) {
            Codec::assertPlan($codec, 'definitions.' . $name);
        }
        if (array_key_exists('jwt', $contract['webhook'] ?? [])) {
            $j = $contract['webhook']['jwt'];
            if (
                !is_array($j) ||
                ($j['algorithm'] ?? null) !== 'ES256' ||
                ($j['scheme'] ?? null) !== 'Bearer' ||
                ($j['bodyHashEncoding'] ?? null) !== 'base64url' ||
                !is_int($j['lifetimeSeconds'] ?? null) ||
                $j['lifetimeSeconds'] < 1 ||
                $j['lifetimeSeconds'] > 3600 ||
                !is_int($j['leewaySeconds'] ?? null) ||
                $j['leewaySeconds'] < 0 ||
                $j['leewaySeconds'] > 60
            ) {
                throw new \InvalidArgumentException('Invalid compiled webhook JWT settings');
            }
            foreach (['header', 'typ', 'issuer', 'jwksPath', 'bodyHashClaim'] as $name) {
                if (
                    !is_string($j[$name] ?? null) ||
                    $j[$name] === '' ||
                    preg_match('/[\s\x00-\x1f\x7f]/', $j[$name])
                ) {
                    throw new \InvalidArgumentException('Invalid compiled webhook JWT ' . $name);
                }
            }
            if (
                !preg_match("/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/D", $j['header']) ||
                ($j['issuer'] !== 'baseUrl' &&
                    (!self::validBaseUrl($j['issuer']) ||
                        !preg_match('/^https:/i', $j['issuer']))) ||
                !preg_match('~^/(?!/)[A-Za-z0-9/._\x7e-]+$~D', $j['jwksPath']) ||
                array_intersect(explode('/', $j['jwksPath']), ['.', '..'])
            ) {
                throw new \InvalidArgumentException('Invalid compiled webhook JWT location');
            }
        }
        foreach ($contract['webhook']['events'] ?? [] as $name => $codec) {
            Codec::assertPlan($codec, 'events.' . $name);
        }
    }
    private function definitions(): array
    {
        return $this->descriptors?->definitions() ?? ($this->contract['definitions'] ?? []);
    }
    private function decode(mixed $value, array $codec, array $context = []): mixed
    {
        return Codec::execute($value, $codec, $context + ['definitions' => $this->definitions()]);
    }
    private function validateHeaderValue(string $value, array $codec, string $path): void
    {
        // Simple headers carry scalars or comma-separated scalar arrays. Keep
        // their spelling and exact numeric tokens while the request codec
        // validates the possible wire interpretations.
        $parseScalar = static fn(string $text): mixed => $text === 'true' || $text === 'false'
            ? $text === 'true'
            : (preg_match('/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/D', $text)
                ? new ParsedNumber($text)
                : $text);
        $parts = explode(',', $value);
        $failure = null;
        foreach (
            [$value, $parseScalar($value), $parts, array_map($parseScalar, $parts)]
            as $candidate
        ) {
            try {
                $this->decode($candidate, $codec, ['path' => $path]);
                return;
            } catch (SdkError $error) {
                if (SdkError::internalKind($error) !== 'validation') {
                    throw $error;
                }
                $failure ??= $error;
            }
        }
        if ($failure !== null) {
            throw $failure;
        }
        throw new \LogicException('Header validation did not evaluate a value');
    }
    private static function now(): int
    {
        return (int) floor(hrtime(true) / 1000000);
    }
    private static function origin(string $url): string
    {
        $p = parse_url($url);
        $scheme = strtolower($p['scheme'] ?? '');
        return $scheme .
            '://' .
            strtolower($p['host'] ?? '') .
            (isset($p['port']) &&
            !(
                ($scheme === 'https' && $p['port'] === 443) ||
                ($scheme === 'http' && $p['port'] === 80)
            )
                ? ':' . $p['port']
                : '');
    }
    private static function validBaseUrl(string $url): bool
    {
        $p = parse_url($url);
        return $p !== false &&
            !empty($p['host']) &&
            !empty($p['scheme']) &&
            preg_match('~^[a-z][a-z0-9+.-]*://~i', $url) &&
            preg_match('/[\\\\\s\x00-\x1f\x7f{}?#]/u', $url) === 0 &&
            !isset($p['user']) &&
            !isset($p['pass']);
    }
    private function checkUrl(string $url): void
    {
        $p = parse_url($url);
        if (
            !$p ||
            empty($p['host']) ||
            preg_match('/[\\\\\x00-\x20]/', $url) ||
            isset($p['user']) ||
            isset($p['pass']) ||
            isset($p['fragment'])
        ) {
            throw SdkError::create(
                'destination',
                'Invalid destination: embedded credentials and fragments are not allowed',
            );
        }
        $scheme = strtolower($p['scheme'] ?? '');
        if (!in_array($scheme, ['https', 'http'], true)) {
            throw SdkError::create('destination', 'Unsupported destination protocol; use HTTPS');
        }
        if ($scheme === 'http' && !$this->options->allowInsecureHttp) {
            throw SdkError::create(
                'destination',
                'HTTP is disabled; set allowInsecureHttp: true for deliberate local testing',
            );
        }
        if (!in_array(self::origin($url), $this->allowed, true)) {
            throw SdkError::create('destination', 'Destination origin is not in allowedOrigins');
        }
    }
    private static function settleCallError(SdkError $error, array $context): void
    {
        $observations = $context['observations'];
        $last = $observations ? $observations[array_key_last($observations)] : null;
        if ($error instanceof Errors\ApiError && ($last['state'] ?? null) === 'answered') {
            $error->outcome =
                $last['inProgress'] || $last['uncertainWrite'] ? 'unknown' : 'response';
            $error->retryAllowed =
                ($context['replaySafe'] ?? false) &&
                !in_array($error->status, [401, 412], true) &&
                ($error->outcome === 'unknown' || $last['retryAllowed']);
        } elseif (
            $error instanceof Errors\ConnectionError ||
            $error instanceof Errors\CancelledError ||
            ($last !== null && $last['state'] !== 'answered')
        ) {
            $mayHaveRun =
                count(
                    array_filter(
                        $observations,
                        fn($attempt) => $attempt['state'] === 'no_answer' ||
                            ($attempt['state'] === 'answered' &&
                                (($attempt['status'] >= 500 && $attempt['status'] < 600) ||
                                    $attempt['inProgress'])),
                    ),
                ) > 0;
            $error->outcome = $mayHaveRun ? 'unknown' : 'not_sent';
            $error->retryAllowed =
                ($error instanceof Errors\ConnectionError ||
                    $error instanceof Errors\CancelledError) &&
                ($context['replaySafe'] ?? false) &&
                !in_array($error->status, [401, 412], true);
        }
    }
    private static function checkCancel(?Cancellation $c, string $outcome = 'unknown'): void
    {
        if ($c?->isCancelled()) {
            throw SdkError::create(
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
        if ($this->descriptors) {
            return $this->descriptors->operation($id);
        }
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
        $op = $this->operation($id);
        $header = strtolower($op['idempotency']['header'] ?? '');
        $key = $header !== '' ? $options?->idempotencyKey : null;
        if ($header !== '' && $key === null) {
            if ($op['idempotency']['auto'] ?? false) {
                $bytes = random_bytes(16);
                $bytes[6] = chr((ord($bytes[6]) & 0x0f) | 0x40);
                $bytes[8] = chr((ord($bytes[8]) & 0x3f) | 0x80);
                $hex = bin2hex($bytes);
                $key =
                    ($op['idempotency']['autoKeyPrefix'] ?? '') .
                    substr($hex, 0, 8) .
                    '-' .
                    substr($hex, 8, 4) .
                    '-' .
                    substr($hex, 12, 4) .
                    '-' .
                    substr($hex, 16, 4) .
                    '-' .
                    substr($hex, 20);
            }
        }
        $context = ['attempts' => 0, 'requestIds' => [], 'observations' => []];
        $callStart = self::now();
        try {
            $effective = $options;
            if (is_string($key)) {
                $effective = new RequestOptions(
                    ...array_replace(get_object_vars($options ?? new RequestOptions()), [
                        'idempotencyKey' => $key,
                    ]),
                );
            }
            return $this->executeRequest($id, $input, $effective, $continuation, $context);
        } catch (SdkError $error) {
            $error->attempts = $context['attempts'];
            $error->requestIds = $context['requestIds'];
            $error->durationMs = self::now() - $callStart;
            if (isset($context['lastResponse'])) {
                $error->status = $context['lastResponse']['status'];
                $error->headers = $context['lastResponse']['headers'];
                $error->requestId = $context['lastResponse']['requestId'] ?? null;
                $error->retryAfterMs = $context['retryAfterMs'] ?? null;
            }
            self::settleCallError($error, $context);
            $error->operation = isset($op['resource'], $op['method'])
                ? $op['resource'] . '.' . $op['method']
                : $id;
            if (is_string($key)) {
                $error->idempotencyKey = $key;
            }
            throw $error;
        }
    }
    private function executeRequest(
        string $id,
        array $input = [],
        ?RequestOptions $options = null,
        ?string $continuation = null,
        array &$context = [],
    ): Result {
        $o = $options ?? new RequestOptions();
        $requestCredentialsPassed = $this->credentialOptionsPassed($o);
        $clientCredentialsPassed = $this->credentialOptionsPassed($this->options);
        $op = $this->operation($id);
        foreach (['streamIdleTimeoutMs', 'streamLifetimeMs'] as $key) {
            if ($o->{$key} !== null && $o->{$key} <= 0) {
                Codec::fail($key, 'must be positive');
            }
        }
        $start = self::now();
        $timeout =
            $o->timeoutMs ?? ($this->options->timeoutMs ?? ($op['defaults']['timeoutMs'] ?? 10000));
        $duration =
            $o->deadlineMs ??
            ($this->options->deadlineMs ?? ($op['defaults']['deadlineMs'] ?? 30000));
        if ($timeout <= 0 || $duration <= 0) {
            Codec::fail('options', 'timeouts must be positive');
        }
        $deadline = $start + $duration;
        $policy = $op['retry'];
        $budget = $o->maxAttempts ?? ($this->options->maxAttempts ?? $policy['maxAttempts']);
        if (
            !is_finite((float) $budget) ||
            $budget < 1 ||
            $budget > 9007199254740991 ||
            floor($budget) != $budget
        ) {
            Codec::fail('maxAttempts', 'must be a positive safe integer');
        }
        $attempts = min((int) $budget, $policy['maxAttempts']);
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
        $set = function (mixed $name, mixed $value) use (&$headers): void {
            if (
                !is_string($name) ||
                !is_string($value) ||
                !preg_match('/^[!#$%&\x27*+.^_`|~0-9A-Za-z-]+$/', $name) ||
                preg_match('/[\r\n]/', $value)
            ) {
                Codec::fail('headers', 'invalid HTTP header');
            }
            $headers[strtolower($name)] = $value;
        };
        foreach ($o->headers as $name => $value) {
            if (strtolower($op['idempotency']['header'] ?? '') === strtolower((string) $name)) {
                Codec::fail((string) $name, 'supply this header through options.idempotencyKey');
            }
            $set($name, $value);
        }
        $basePath = rtrim(parse_url($this->baseUrl, PHP_URL_PATH) ?? '', '/');
        if (
            $continuation === null &&
            $basePath !== '' &&
            ($op['path'] === $basePath || str_starts_with($op['path'], $basePath . '/'))
        ) {
            Codec::fail(
                'baseUrl',
                'already includes the operation base path; remove that path from baseUrl',
            );
        }
        $path = $op['path'];
        $query = [];
        foreach ($op['parameters'] as $p) {
            if (($p['source'] ?? null) === 'authentication') {
                if (array_key_exists($p['name'], $input)) {
                    Codec::fail($p['name'], 'supply this header through authentication options');
                }
                continue;
            }
            if (($p['source'] ?? null) === 'request-option') {
                if (array_key_exists($p['name'], $input)) {
                    Codec::fail($p['name'], 'supply this header through request options');
                }
                continue;
            }
            $present = array_key_exists($p['name'], $input);
            $value = $present ? $input[$p['name']] : null;
            if (
                $p['in'] === 'header' &&
                strtolower($op['idempotency']['header'] ?? '') === strtolower($p['name'])
            ) {
                if ($present) {
                    Codec::fail($p['name'], 'supply this header through options.idempotencyKey');
                }
                $value = $o->idempotencyKey;
                $present = $value !== null;
            }
            if (
                $p['in'] === 'header' &&
                strtolower($this->contract['apiVersion']['header'] ?? '') ===
                    strtolower($p['name']) &&
                $present
            ) {
                Codec::fail($p['name'], 'API version is managed by the SDK');
            }
            if (
                $p['in'] === 'header' &&
                in_array(
                    strtolower($p['name']),
                    [
                        strtolower($op['conditional']['header'] ?? ''),
                        strtolower($this->contract['apiVersion']['header'] ?? ''),
                    ],
                    true,
                )
            ) {
                // Match final header precedence before validating the wire value.
                foreach ($o->headers as $name => $headerValue) {
                    if (strtolower($name) === strtolower($p['name'])) {
                        $value = $headerValue;
                        $present = true;
                    }
                }
                if (
                    strtolower($this->contract['apiVersion']['header'] ?? '') ===
                    strtolower($p['name'])
                ) {
                    $value = $this->contract['apiVersion']['value'];
                    $present = true;
                }
                if (
                    strtolower($op['conditional']['header'] ?? '') === strtolower($p['name']) &&
                    $o->ifMatch !== null
                ) {
                    $value = $o->ifMatch;
                    $present = true;
                }
            }
            if (!$present) {
                if ($p['required'] ?? false) {
                    Codec::fail(
                        $p['name'],
                        strtolower($op['idempotency']['header'] ?? '') === strtolower($p['name'])
                            ? $op['resource'] .
                                '.' .
                                $op['method'] .
                                ' requires idempotencyKey; save and reuse the key on retry'
                            : 'required parameter is missing',
                    );
                }
                continue;
            }
            $v = $this->decode($value, $p['codec'], ['path' => $p['name']]);
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
        $url = rtrim($this->baseUrl, '/') . $path . ($query ? '?' . implode('&', $query) : '');
        if ($continuation !== null) {
            if (str_starts_with($continuation, '//')) {
                $url = (parse_url($this->baseUrl, PHP_URL_SCHEME) ?: 'https') . ':' . $continuation;
            } elseif (preg_match('/^[a-z][a-z0-9+.-]*:/i', $continuation)) {
                $url = $continuation;
            } elseif (str_starts_with($continuation, '/')) {
                $url = self::origin($this->baseUrl) . $continuation;
            } else {
                $url = rtrim($this->baseUrl, '/') . '/' . $continuation;
            }
        }
        $this->checkUrl($url);
        foreach ($o->headers as $k => $v) {
            $set($k, $v);
        }
        foreach ($op['parameters'] as $p) {
            if (($p['source'] ?? null) !== 'request-option') {
                continue;
            }
            $name = $p['requestOption']['php'];
            $value = $o->{$name};
            $supplied = $headers[strtolower($p['name'])] ?? null;
            if ($value !== null && $supplied !== null && $value !== $supplied) {
                Codec::fail($name, 'conflicting request option and header values');
            }
            $effective = $value ?? $supplied;
            if ($effective !== null) {
                $normalized = $this->decode($effective, $p['codec'], ['path' => $name]);
                $set($p['name'], $normalized);
            }
        }
        $suppliedHeaders = $headers;
        $ambient = $this->contract['defaultCredentials'] ?? null;
        $ambientProvider =
            $ambient &&
            $this->options->ambientCredentials &&
            !$requestCredentialsPassed &&
            !$clientCredentialsPassed
                ? new AmbientCredentialProvider($ambient, null, $this->baseUrl)
                : null;
        $credentialContext = [
            'baseUrl' => $this->baseUrl,
            'deadline' => $deadline,
            'transport' => $this->options->transport,
            'credentialCache' => $this->options->credentialCache,
            'cancellation' => $o->cancellation,
        ];
        $providers = [];
        $resolveCredential = function (
            #[\SensitiveParameter] $source,
            string $message,
            bool $rejectNewlines = true,
        ) use (&$providers, $credentialContext): string {
            $value = $source;
            if ($source instanceof CredentialProvider || $source instanceof \Closure) {
                try {
                    $credential =
                        $source instanceof CredentialProvider
                            ? ($source instanceof AmbientCredentialProvider
                                ? $source->resolve($credentialContext)
                                : $source->getCredential())
                            : $source();
                    $value = $credential instanceof Credential ? $credential->value : $credential;
                } catch (\Throwable $error) {
                    if (
                        $source instanceof AmbientCredentialProvider &&
                        $error instanceof SdkError
                    ) {
                        throw $error;
                    }
                    // Do not retain provider exceptions, which may include secret values.
                    throw SdkError::create('authentication', 'Credential provider failed');
                }
                if (
                    $source instanceof CredentialProvider &&
                    is_callable([$source, 'invalidate']) &&
                    (!($source instanceof AmbientCredentialProvider) ||
                        $source->canInvalidate($credential))
                ) {
                    $providers[spl_object_id($source)] =
                        $source instanceof AmbientCredentialProvider
                            ? static fn() => $source->invalidate($credential)
                            : static fn() => $source->invalidate();
                }
            }
            if (
                !is_string($value) ||
                $value === '' ||
                ($rejectNewlines && preg_match('/[\r\n]/', $value))
            ) {
                throw SdkError::create('authentication', $message);
            }
            return $value;
        };
        $authenticate = function () use (
            $op,
            $o,
            $set,
            &$headers,
            $suppliedHeaders,
            $resolveCredential,
            &$providers,
            $ambient,
            $ambientProvider,
        ): void {
            $providers = [];
            if (isset($this->contract['authentication'])) {
                $permitted = $op['authModes'] ?? [];
                $shortcutAuth = function ($options) {
                    $supplied = [];
                    foreach ($this->contract['authShortcuts'] ?? [] as $key => $shortcut) {
                        if (property_exists($options, $key) && $options->$key !== Omitted::Value) {
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
                                $options->credentials !== Omitted::Value))
                    ) {
                        throw SdkError::create(
                            'authentication',
                            'Use one authentication shortcut or explicit authMode/credentials, not both',
                        );
                    }
                    return $supplied[0] ?? null;
                };
                $authHint = function (array $modes, ?string $scheme = null): string {
                    $shortcuts = [];
                    foreach ($this->contract['authShortcuts'] ?? [] as $name => $value) {
                        if (
                            in_array($value['mode'], $modes, true) &&
                            ($scheme === null || $value['scheme'] === $scheme)
                        ) {
                            $shortcuts[] = $name;
                        }
                    }
                    return $shortcuts
                        ? 'pass ' .
                                implode(' or ', $shortcuts) .
                                ' in ClientOptions or RequestOptions'
                        : ($scheme !== null
                            ? 'pass credentials[' .
                                $modes[0] .
                                '][' .
                                $scheme .
                                '] in ClientOptions or credentials[' .
                                $scheme .
                                '] in RequestOptions, with authMode ' .
                                $modes[0]
                            : 'pass authMode (' .
                                implode(', ', $modes) .
                                ') and credentials in ClientOptions or RequestOptions');
                };
                $clientShortcut = $shortcutAuth($this->options);
                $requestShortcut = $shortcutAuth($o);
                $defaultMode =
                    $this->options->authMode ??
                    ($clientShortcut['mode'] ??
                        ($ambientProvider && in_array($ambient['mode'], $permitted, true)
                            ? $ambient['mode']
                            : null));
                $modeName =
                    $requestShortcut['mode'] ??
                    ($o->authMode ?? ($permitted ? $defaultMode : null));
                if ($modeName === null && $op['authenticated'] && count($permitted) === 1) {
                    $modeName = $permitted[0];
                }
                if ($modeName === null && $op['authenticated']) {
                    throw SdkError::create(
                        'authentication',
                        'Authentication is required; ' . $authHint($permitted),
                    );
                }
                $selected =
                    $modeName === null
                        ? null
                        : $this->contract['authentication'][$modeName] ?? null;
                if (
                    $modeName !== null &&
                    ($selected === null || !in_array($modeName, $permitted, true))
                ) {
                    throw SdkError::create(
                        'authentication',
                        'Authentication mode is not permitted; ' . $authHint($permitted),
                    );
                }
                $expected = [];
                if ($selected !== null) {
                    $credentials =
                        $requestShortcut['credentials'] ??
                        ($o->credentials !== Omitted::Value
                            ? $o->credentials
                            : (($clientShortcut['mode'] ?? null) === $modeName
                                ? $clientShortcut['credentials']
                                : (is_array($this->options->credentials)
                                    ? $this->options->credentials[$modeName] ?? null
                                    : null)));
                    foreach ($selected['schemes'] as $scheme) {
                        $source =
                            $credentials[$scheme['name']] ??
                            ($credentials === null &&
                            $modeName === ($ambient['mode'] ?? null) &&
                            $scheme['name'] === $ambient['scheme']
                                ? $ambientProvider
                                : null);
                        $credential = $resolveCredential(
                            $source,
                            'Missing or invalid credentials; ' .
                                $authHint([$modeName], $scheme['name']),
                        );
                        $expected[strtolower($scheme['header'])] =
                            $scheme['type'] === 'bearer' ? 'Bearer ' . $credential : $credential;
                    }
                }
                foreach ($this->contract['authentication'] as $mode) {
                    foreach ($mode['schemes'] as $scheme) {
                        $name = strtolower($scheme['header']);
                        if (
                            isset($suppliedHeaders[$name]) &&
                            $suppliedHeaders[$name] !== ($expected[$name] ?? null)
                        ) {
                            throw SdkError::create(
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
                (($op['optionalAuthentication'] ?? false) &&
                    $this->options->token !== Omitted::Value)
            ) {
                $auth = $this->contract['auth'] ?? null;
                if (!$auth || $this->options->token === Omitted::Value) {
                    throw SdkError::create(
                        'authentication',
                        'Explicit API credentials are required',
                    );
                }
                $credential = $resolveCredential(
                    $this->options->token,
                    'Explicit API credentials are required',
                    false, // Legacy header validation owns newline rejection.
                );
                $set(
                    $auth['header'],
                    $auth['type'] === 'bearer' ? 'Bearer ' . $credential : $credential,
                );
            }
            if (isset($this->contract['apiVersion'])) {
                $set(
                    $this->contract['apiVersion']['header'],
                    $this->contract['apiVersion']['value'],
                );
            }
            foreach ($op['parameters'] as $p) {
                if (($p['source'] ?? null) !== 'authentication') {
                    continue;
                }
                $value = $headers[strtolower($p['name'])] ?? null;
                if ($value === null) {
                    if ($p['required'] ?? false) {
                        Codec::fail(
                            $p['name'],
                            strtolower($op['idempotency']['header'] ?? '') ===
                            strtolower($p['name'])
                                ? $op['resource'] .
                                    '.' .
                                    $op['method'] .
                                    ' requires idempotencyKey; save and reuse the key on retry'
                                : 'required parameter is missing',
                        );
                    }
                } else {
                    $this->validateHeaderValue($value, $p['codec'], $p['name']);
                }
            }
        };
        if ($o->ifMatch !== null) {
            if (!isset($op['conditional'])) {
                Codec::fail('ifMatch', 'operation does not declare conditional requests');
            }
            $set($op['conditional']['header'], $o->ifMatch);
        }
        $key = $o->idempotencyKey;
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
            $op['replay'] === 'safe' ||
            isset($headers[strtolower($op['idempotency']['header'] ?? '')]);
        $context['replaySafe'] =
            in_array($op['verb'], ['GET', 'HEAD'], true) ||
            (isset($op['idempotency']) && $key !== null);
        if (!$safe) {
            $attempts = 1;
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
        $requestIds = &$context['requestIds'];
        $credentialRetries = 0;
        for ($attempt = 1; $attempt <= $attempts; $attempt++) {
            self::checkCancel($o->cancellation, $attempt === 1 ? 'not_sent' : 'unknown');
            $remaining = $deadline - self::now();
            if ($remaining <= 0) {
                throw SdkError::create(
                    'deadline',
                    'Overall deadline exceeded',
                    $attempt === 1 ? 'not_sent' : 'unknown',
                );
            }
            $retryAfter = null;
            $meta = null;
            $response = null;
            $diagnosticError = null;
            try {
                $context['attempts'] = $attempt;
                $context['observations'][$attempt - 1] = ['state' => 'not_sent'];
                $authenticate();
                self::checkCancel($o->cancellation);
                $remaining = $deadline - self::now();
                if ($remaining <= 0) {
                    throw SdkError::create('deadline', 'Overall deadline exceeded');
                }
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
                $context['observations'][$attempt - 1] = ['state' => 'no_answer'];
                $response = $this->options->transport
                    ? ($this->options->transport)($request)
                    : $this->send($request);
                $status = $response['status'];
                $rh = array_change_key_case($response['headers'], CASE_LOWER);
                $raw = $response['body'] ?? '';
                $declaredResponse =
                    $op['responses'][(string) $status] ??
                    ($op['responses']['default'] ??
                        ($status >= 200 && $status < 300 && isset($op['successJsonFallback'])
                            ? $op['responses'][$op['successJsonFallback']]
                            : null));
                $redirect =
                    ($op['responses'][(string) $status]['classification'] ?? null) === 'redirect';
                $binary =
                    $status >= 200 &&
                    $status < 300 &&
                    ($declaredResponse['bodyKind'] ?? null) === 'binary';
                $meta = [
                    ...$o->idempotencyKey !== null ? ['idempotencyKey' => $o->idempotencyKey] : [],
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
                if (isset($meta['requestId'])) {
                    $requestIds[] = $meta['requestId'];
                }
                $meta['requestIds'] = $requestIds;
                if (isset($rh['retry-after'])) {
                    $retryAfter = self::parseRetryAfter($rh['retry-after']);
                }
                if ($status > 0) {
                    $context['lastResponse'] = $meta;
                    $context['retryAfterMs'] = $retryAfter;
                }
                // Successful buffered transports and bodyless responses are already complete.
                if (
                    $status > 0 &&
                    !isset($response['failureCode']) &&
                    ($op['verb'] === 'HEAD' ||
                        !(($response['stream'] ?? null) instanceof ByteStream))
                ) {
                    $context['observations'][$attempt - 1] = [
                        'state' => 'answered',
                        'status' => $status,
                        'inProgress' => false,
                        'uncertainWrite' => false,
                        'retryAllowed' => false,
                    ];
                }
                if ($status === 401 && $safe && $credentialRetries === 0 && $providers) {
                    $diagnosticError = 'authentication';
                    if (($response['stream'] ?? null) instanceof ByteStream) {
                        try {
                            $response['stream']->close();
                        } catch (\Throwable) {
                            // Cleanup does not establish completion of an unread body.
                        }
                    }
                    try {
                        foreach ($providers as $invalidate) {
                            $invalidate();
                        }
                    } catch (\Throwable) {
                        throw SdkError::create(
                            'authentication',
                            'Credential provider invalidation failed',
                            'response',
                            false,
                            $meta,
                        );
                    }
                    $credentialRetries++;
                    $attempts++;
                    continue;
                }
                if (isset($response['failureCode'])) {
                    throw new \RuntimeException(
                        curl_strerror($response['failureCode']),
                        $response['failureCode'],
                    );
                }
                $sse =
                    $status >= 200 &&
                    $status < 300 &&
                    ($declaredResponse['bodyKind'] ?? null) === 'sse';
                $source = $response['stream'] ?? null;
                if (
                    $sse &&
                    $source instanceof ByteStream &&
                    strtolower(trim(explode(';', $rh['content-type'] ?? '')[0])) ===
                        'text/event-stream'
                ) {
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
                // Invalid stream handshakes also need a complete body before they settle the call.
                if (($response['stream'] ?? null) instanceof ByteStream) {
                    try {
                        while (($chunk = $response['stream']->read()) !== null) {
                            $raw .= $chunk;
                        }
                    } finally {
                        $response['stream']->close();
                    }
                }
                $context['observations'][$attempt - 1] = [
                    'state' => 'answered',
                    'status' => $status,
                    'inProgress' => false,
                    'uncertainWrite' => false,
                    'retryAllowed' => false,
                ];
                if ($sse) {
                    throw SdkError::create(
                        'protocol',
                        'Expected an SSE response stream',
                        'response',
                        false,
                        $meta,
                    );
                }
                $data = null;
                try {
                    if ($raw !== '' && !$binary && !$redirect) {
                        $data = Codec::parse($raw, true);
                    }
                } catch (\Throwable $cause) {
                    if ($status >= 200 && $status < 300) {
                        throw SdkError::create(
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
                    throw SdkError::create(
                        'destination',
                        'Redirects are not followed; explicitly configure an approved endpoint',
                        'response',
                        false,
                        $meta,
                    );
                }
                if (($status >= 200 && $status < 300) || $status === 304 || $redirect) {
                    $declared = $declaredResponse;
                    if ($declared === null) {
                        throw SdkError::create(
                            'protocol',
                            'Undeclared success status',
                            'response',
                            false,
                            $meta,
                            raw: $raw,
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
                        if (isset($declared['phpRepresentation'])) {
                            $data = Model::hydrate(
                                $data,
                                $declared['phpRepresentation'],
                                $this->options->redactFields,
                            );
                        } else {
                            $model = $declared['model'] ?? null;
                            if (isset($declared['variants']) && is_object($data)) {
                                $codec = $declared['codec'];
                                $definitions = $this->definitions();
                                for ($depth = 0; isset($codec['reference']); $depth++) {
                                    if ($depth > 256) {
                                        Codec::fail(
                                            'response',
                                            'codec reference exceeds nesting limit',
                                        );
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
                        }
                    } catch (\Throwable $cause) {
                        throw SdkError::create(
                            'protocol',
                            'Response cannot be represented by the declared schema' .
                                (($reason = Codec::validationFailureMessage($cause)) !== null
                                    ? ': ' . $reason
                                    : ''),
                            'response',
                            false,
                            $meta,
                            previous: $cause,
                            raw: $raw,
                        );
                    }
                    $meta['durationMs'] = self::now() - $start;
                    return new Result($data, $meta, $raw);
                }
                $kind = match (true) {
                    in_array($status, [401, 403], true) => 'authentication',
                    $status === 429 => 'rate_limit',
                    in_array($status, [400, 422], true) => 'validation',
                    in_array($status, [409, 412], true) => 'conflict',
                    $status === 404 => 'not_found',
                    $status >= 500 && $status < 600 => 'server',
                    default => 'api',
                };
                $code = self::field($data, $this->contract['errors']['codePath'] ?? 'code');
                $originalMessage = self::field(
                    $data,
                    $this->contract['errors']['messagePath'] ?? 'message',
                );
                // Text fields use their wire kinds; public details keep exact numeric tokens as strings.
                $details = Codec::redactPlan(
                    Codec::plainNumbers($data),
                    $op['responses'][(string) $status]['codec'] ??
                        ($op['responses']['default']['codec'] ?? []),
                    $this->options->redactFields,
                    $this->definitions(),
                );
                $message = self::field(
                    $details,
                    $this->contract['errors']['messagePath'] ?? 'message',
                );
                $publicCode = self::field(
                    $details,
                    $this->contract['errors']['codePath'] ?? 'code',
                );
                if (isset($this->contract['errors']['detailsPath'])) {
                    $details = self::field($details, $this->contract['errors']['detailsPath']);
                }
                $signal = $this->contract['errors']['retry'] ?? null;
                $retryValue = $signal !== null ? self::field($data, $signal['path']) : null;
                $diagnosticError = $kind;
                $error = SdkError::create(
                    $kind,
                    // Match JavaScript trim's Unicode whitespace without changing the message.
                    is_string($message) &&
                    is_string($originalMessage) &&
                    preg_match('/[^\p{Z}\x{0009}-\x{000D}\x{FEFF}]/u', $originalMessage)
                        ? $message
                        : "API returned HTTP $status",
                    'response',
                    $safe &&
                        $status !== 401 &&
                        $status !== 412 &&
                        ($signal !== null
                            ? (is_string($retryValue)
                                ? in_array($retryValue, $signal['retryValues'], true)
                                : in_array($status, $policy['statuses'], true))
                            : in_array($status, $policy['statuses'], true) ||
                                (is_string($code) &&
                                    count(
                                        array_filter(
                                            $policy['errors'] ?? [],
                                            fn($rule) => $rule['status'] === $status &&
                                                in_array($code, $rule['codes'], true),
                                        ),
                                    ) > 0)),
                    $meta,
                    is_string($code) && is_string($publicCode) ? $publicCode : null,
                    $details,
                    raw: $raw,
                );
                $codePath = $this->contract['errors']['codePath'] ?? 'code';
                $parent = str_contains($codePath, '.')
                    ? substr($codePath, 0, strrpos($codePath, '.'))
                    : '';
                $envelope = $parent !== '' ? self::field($data, $parent) : $data;
                $reasons = self::field($envelope, 'details');
                $inProgress =
                    is_string($code) &&
                    in_array($code, $this->contract['errors']['inProgressCodes'] ?? [], true);
                $uncertainWrite =
                    !in_array($op['verb'], ['GET', 'HEAD'], true) &&
                    (($status >= 500 && $status < 600) ||
                        $code === 'IDEMPOTENCY_RECOVERY_REQUIRED' ||
                        self::field($envelope, 'reason') === 'outcome_unknown' ||
                        (is_array($reasons) &&
                            count(
                                array_filter(
                                    $reasons,
                                    fn($detail) => self::field($detail, 'reason') ===
                                        'outcome_unknown',
                                ),
                            ) > 0));
                $hasEnvelope = is_object($envelope) && !($envelope instanceof ParsedNumber);
                $retryAllowed =
                    $signal !== null
                        ? (is_string($retryValue) &&
                                in_array($retryValue, $signal['retryValues'], true)) ||
                            (!$hasEnvelope && in_array($status, $policy['statuses'], true))
                        : $error->retryAllowed;
                $context['observations'][$attempt - 1] = [
                    'state' => 'answered',
                    'status' => $status,
                    'inProgress' => $inProgress,
                    'uncertainWrite' => $uncertainWrite,
                    'retryAllowed' => $retryAllowed,
                ];
                $error->retryAfterMs = $retryAfter;
            } catch (SdkError $error) {
                $diagnosticError = SdkError::internalKind($error);
                throw $error;
            } catch (\Throwable $cause) {
                if (($meta['status'] ?? null) === 401) {
                    $diagnosticError = 'authentication';
                    throw SdkError::create(
                        'authentication',
                        'API returned HTTP 401',
                        'response',
                        false,
                        $meta,
                    );
                }
                $curlCode = isset($response['failureCode'])
                    ? (int) $response['failureCode']
                    : ($this->options->transport === null &&
                    $cause instanceof \RuntimeException &&
                    is_int($cause->getCode())
                        ? $cause->getCode()
                        : 0);
                $expired = self::now() >= $deadline;
                $timedOut = $curlCode === CURLE_OPERATION_TIMEDOUT;
                $notSent =
                    ($context['observations'][$attempt - 1]['state'] ?? 'not_sent') ===
                        'not_sent' ||
                    (!($meta['status'] ?? null) &&
                        in_array(
                            $curlCode,
                            [
                                CURLE_COULDNT_CONNECT,
                                CURLE_COULDNT_RESOLVE_HOST,
                                CURLE_COULDNT_RESOLVE_PROXY,
                            ],
                            true,
                        ));
                if ($notSent) {
                    $context['observations'][$attempt - 1] = ['state' => 'not_sent'];
                }
                $diagnosticError = $o->cancellation?->isCancelled()
                    ? 'cancelled'
                    : ($expired
                        ? 'deadline'
                        : ($timedOut
                            ? 'timeout'
                            : 'transport'));
                $meta ??= [
                    'status' => null,
                    'headers' => [],
                    'attempts' => $attempt,
                    'durationMs' => self::now() - $start,
                ];
                if (($meta['status'] ?? 0) === 0) {
                    $meta['status'] = null;
                }
                $message = match ($diagnosticError) {
                    'cancelled' => 'Request cancelled; remote outcome is unknown',
                    'deadline' => 'Overall request deadline exceeded; remote outcome is unknown',
                    'timeout' => 'Request attempt timed out; remote outcome is unknown',
                    default => $notSent && $curlCode === CURLE_COULDNT_CONNECT
                        ? 'Connection refused or unavailable; request was not sent'
                        : ($notSent &&
                        in_array(
                            $curlCode,
                            [CURLE_COULDNT_RESOLVE_HOST, CURLE_COULDNT_RESOLVE_PROXY],
                            true,
                        )
                            ? 'DNS lookup failed; request was not sent'
                            : 'Transport failed before a usable response; remote outcome is unknown'),
                };
                $code = match ($diagnosticError) {
                    'deadline' => 'deadline_exceeded',
                    'timeout' => 'request_timeout',
                    default => match ($curlCode) {
                        CURLE_COULDNT_CONNECT => 'ECONNREFUSED',
                        CURLE_COULDNT_RESOLVE_HOST => 'ENOTFOUND',
                        CURLE_COULDNT_RESOLVE_PROXY => 'ENOTFOUND',
                        default => 'transport_failure',
                    },
                };
                $error = SdkError::create(
                    $diagnosticError,
                    $message,
                    $notSent ? 'not_sent' : 'unknown',
                    in_array($diagnosticError, ['transport', 'timeout'], true) &&
                        $safe &&
                        ($meta['status'] ?? null) !== 412 &&
                        $policy['transport'],
                    $meta,
                    $code,
                    [
                        'curlCode' => $curlCode ?: null,
                        'curlError' =>
                            $curlCode > 0 && $curlCode < 100 ? curl_strerror($curlCode) : null,
                    ],
                    previous: $cause,
                );
                $error->retryAfterMs = $retryAfter;
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
            $d = min(
                $policy['baseDelayMs'] * 2 ** ($attempt - $credentialRetries - 1),
                $policy['maxDelayMs'] ?? PHP_FLOAT_MAX,
            );
            $wait = max($retryAfter ?? 0, $d / 2 + ((random_int(0, 1000000) / 1000000) * $d) / 2);
            if (self::now() + $wait >= $deadline) {
                throw $error;
            }
            self::pause((int) ceil($wait), $o->cancellation);
        }
        throw new \LogicException('Unreachable retry state');
    }
    private static function parseRetryAfter(string $instruction): ?float
    {
        $value = trim($instruction, " \t");
        if (preg_match('/^\d+(?:\.\d+)?$/D', $value)) {
            $ms = (float) $value * 1000;
            return is_finite($ms) ? $ms : null;
        }
        if (
            !preg_match(
                '/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [1-9]\d{3} \d{2}:\d{2}:\d{2} GMT$/D',
                $value,
            )
        ) {
            return null;
        }
        $date = \DateTimeImmutable::createFromFormat(
            '!D, d M Y H:i:s \G\M\T',
            $value,
            new \DateTimeZone('UTC'),
        );
        return $date !== false && $date->format('D, d M Y H:i:s \G\M\T') === $value
            ? max(0, $date->getTimestamp() * 1000 - microtime(true) * 1000)
            : null;
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
        $boundedBody = '';
        if (isset($r['maxResponseBytes'])) {
            curl_setopt($ch, CURLOPT_WRITEFUNCTION, static function ($ch, string $chunk) use (
                &$boundedBody,
                $r,
            ): int {
                if (strlen($boundedBody) + strlen($chunk) > $r['maxResponseBytes']) {
                    return 0;
                }
                $boundedBody .= $chunk;
                return strlen($chunk);
            });
        }
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
            'body' => $body === false ? '' : (isset($r['maxResponseBytes']) ? $boundedBody : $body),
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
            if ($value instanceof ParsedNumber) {
                return null;
            }
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
            throw SdkError::create('destination', 'Invalid continuation URL');
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
        $next = null;
        $limit = $o->maxPages ?? 1000;
        $seen = [];
        $emptyPages = 0;
        if ($limit < 1) {
            Codec::fail('maxPages', 'must be positive');
        }
        for ($i = 0; $i < $limit; $i++) {
            self::checkCancel($o->cancellation);
            // Each page owns its request deadline; time spent consuming yields is unbounded.
            $result = $this->request($id, $input, $o, $p['kind'] === 'link' ? $next : null);
            yield $result;
            $previous =
                $p['kind'] === 'link'
                    ? $next ?? $result->meta['url']
                    : $input[$p['parameter']] ?? null;
            if ($previous instanceof ParsedNumber) {
                $previous = $previous->value;
            }
            $next = self::field($result->data, $p['next']);
            if ($next === null || $next === '') {
                return;
            }
            $values = self::field($result->data, $p['items']);
            $emptyPages = is_array($values) && count($values) === 0 ? $emptyPages + 1 : 0;
            if ($emptyPages >= 2) {
                throw SdkError::create(
                    'protocol',
                    'Pagination returned consecutive empty pages with continuations',
                    'response',
                    false,
                    $result->meta,
                    'pagination_empty_pages',
                );
            }
            if ($p['kind'] === 'link' && !is_string($next)) {
                throw SdkError::create('protocol', 'Expected a pagination URL', 'response');
            }
            if ($p['kind'] === 'link') {
                $next = self::resolveLink($next, $result->meta['url']);
            }
            if (
                isset($seen[(string) $next]) ||
                $next === $previous ||
                ($p['kind'] === 'offset' &&
                    $previous !== null &&
                    (string) $next === (string) $previous) ||
                ($p['kind'] === 'link' && $next === $result->meta['url'])
            ) {
                throw SdkError::create(
                    'protocol',
                    'Pagination returned a repeated continuation (cursor cycle)',
                    'response',
                );
            }
            if ($previous !== null) {
                $seen[(string) $previous] = true;
            }
            $seen[(string) $next] = true;
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
                throw SdkError::create(
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
        $op = $this->operation($id);
        $p = $op['polling'] ?? null;
        if (!$p) {
            Codec::fail('polling', 'capability is not declared');
        }
        $deadline =
            self::now() +
            ($o->deadlineMs ??
                ($this->options->deadlineMs ?? ($op['defaults']['deadlineMs'] ?? 30000)));
        $interval = $p['intervalMs'];
        while (true) {
            $remaining = $deadline - self::now();
            if ($remaining <= 0) {
                throw SdkError::create(
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
                throw SdkError::create(
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
    private static function webhookError(string $kind, string $code, string $message): never
    {
        throw SdkError::create('webhook', $message, errorCode: 'webhook_' . $code);
    }
    private static function webhookHeaderValues(
        array $headers,
        string $name,
        bool $optional = false,
    ): array {
        $values = [];
        foreach ($headers as $key => $value) {
            if (!is_string($key) || strtolower($key) !== strtolower($name)) {
                continue;
            }
            $parts = is_array($value) ? $value : [$value];
            if (!array_is_list($parts)) {
                self::webhookError(
                    'validation',
                    'invalid_input',
                    'Webhook signing header values must be strings',
                );
            }
            foreach ($parts as $part) {
                if (!is_string($part)) {
                    self::webhookError(
                        'validation',
                        'invalid_input',
                        'Webhook signing header values must be strings',
                    );
                }
                $values[] = $part;
            }
        }
        if (!$values || !array_filter($values, fn($value) => trim($value) !== '')) {
            if ($optional) {
                return [];
            }
            self::webhookError(
                'authentication',
                'missing_header',
                'Missing webhook signing header: ' . $name,
            );
        }
        return $values;
    }
    private static function webhookScalarHeader(
        array $headers,
        string $name,
        bool $timestamp = false,
    ): string {
        $values = self::webhookHeaderValues($headers, $name);
        if (count($values) !== 1 || str_contains($values[0], ',')) {
            self::webhookError(
                'authentication',
                $timestamp ? 'invalid_timestamp' : 'invalid_signature',
                'Webhook signing header must have exactly one value: ' . $name,
            );
        }
        return trim($values[0]);
    }
    /** Per-URL JWKS state: jwks document, parsed keys, fetchedAt, expiresAt, attempt, retryAfter. */
    private static array $webhookKeyStates = [];
    private static array $webhookKeyFlights = [];

    private static function webhookBase64url(mixed $value): ?string
    {
        if (!is_string($value) || !preg_match('/^[A-Za-z0-9_-]+$/D', $value)) {
            return null;
        }
        $decoded = base64_decode(strtr($value, '-_', '+/'), true);
        return $decoded !== false &&
            rtrim(strtr(base64_encode($decoded), '+/', '-_'), '=') === $value
            ? $decoded
            : null;
    }
    /** Index just past the JSON string literal starting at $start in already-valid JSON. */
    private static function webhookJsonStringEnd(string $text, int $start): int
    {
        $index = $start + 1;
        while ($text[$index] !== '"') {
            $index += $text[$index] === '\\' ? 2 : 1;
        }
        return $index + 1;
    }
    /** @return list<string> Raw direct members or elements of already-valid JSON's outer container. */
    private static function webhookJsonItems(string $text): array
    {
        $items = [];
        $depth = 0;
        $start = 0;
        for ($index = 0, $length = strlen($text); $index < $length; $index++) {
            $char = $text[$index];
            if ($char === '"') {
                $index = self::webhookJsonStringEnd($text, $index) - 1;
            } elseif ($char === '{' || $char === '[') {
                if ($depth++ === 0) {
                    $start = $index + 1;
                }
            } elseif (
                ($char === ',' && $depth === 1) ||
                (($char === '}' || $char === ']') && --$depth === 0)
            ) {
                $item = trim(substr($text, $start, $index - $start));
                if ($item !== '') {
                    $items[] = $item;
                }
                $start = $index + 1;
            }
        }
        return $items;
    }
    /**
     * One JSON object with unique direct member names, mapped to raw member text.
     * json_decode() otherwise accepts duplicate members and keeps the last value.
     * @return ?array<string, string>
     */
    private static function webhookJsonObject(string $text): ?array
    {
        try {
            if (!(json_decode($text, false, 512, JSON_THROW_ON_ERROR) instanceof \stdClass)) {
                return null;
            }
        } catch (\JsonException) {
            return null;
        }
        $members = [];
        foreach (self::webhookJsonItems($text) as $item) {
            $end = self::webhookJsonStringEnd($item, 0);
            $name = (string) json_decode(substr($item, 0, $end), false, 512, JSON_THROW_ON_ERROR);
            if (array_key_exists($name, $members)) {
                return null;
            }
            $members[$name] = ltrim(substr($item, strpos($item, ':', $end) + 1));
        }
        return $members;
    }
    private static function webhookJsonString(?array $members, string $name): ?string
    {
        $raw = $members[$name] ?? null;
        if (!is_string($raw) || !str_starts_with($raw, '"')) {
            return null;
        }
        $value = json_decode($raw, false, 512, JSON_THROW_ON_ERROR);
        return is_string($value) ? $value : null;
    }
    private static function webhookJsonInteger(?array $members, string $name): ?int
    {
        $raw = $members[$name] ?? null;
        if (!is_string($raw) || !preg_match('/^-?(?:0|[1-9][0-9]*)$/D', $raw)) {
            return null;
        }
        $value = json_decode($raw, false, 512, JSON_THROW_ON_ERROR);
        return is_int($value) && abs($value) <= 9007199254740991 ? $value : null;
    }
    /**
     * Validate a JWKS document's shape: unique members, a keys array, and a string kid per key.
     * @return list<array{kid: string, members: array<string, string>}>
     */
    private static function webhookJwks(string $document): array
    {
        $keys = self::webhookJsonObject($document)['keys'] ?? null;
        if (!is_string($keys) || !str_starts_with($keys, '[')) {
            throw new \RuntimeException('Invalid JWKS');
        }
        $result = [];
        foreach (self::webhookJsonItems($keys) as $item) {
            $members = self::webhookJsonObject($item);
            $kid = self::webhookJsonString($members, 'kid');
            if ($members === null || $kid === null) {
                throw new \RuntimeException('Invalid JWK');
            }
            $result[] = ['kid' => $kid, 'members' => $members];
        }
        return $result;
    }
    /**
     * Select the PEM key for kid, ignoring other keys including unsupported key types. A duplicate
     * kid makes the trusted set ambiguous; a unique but unusable key fails only the token naming it.
     * @return array{0: 'key'|'unknown'|'duplicate'|'unusable', 1: ?string}
     */
    private static function webhookSelectKey(array $keys, string $kid): array
    {
        $matches = array_values(array_filter($keys, fn($key) => $key['kid'] === $kid));
        if (!$matches) {
            return ['unknown', null];
        }
        if (count($matches) !== 1) {
            return ['duplicate', null];
        }
        $key = $matches[0]['members'];
        $x = self::webhookBase64url(self::webhookJsonString($key, 'x'));
        $y = self::webhookBase64url(self::webhookJsonString($key, 'y'));
        if (
            $x === null ||
            $y === null ||
            strlen($x) !== 32 ||
            strlen($y) !== 32 ||
            self::webhookJsonString($key, 'kty') !== 'EC' ||
            self::webhookJsonString($key, 'crv') !== 'P-256' ||
            (array_key_exists('alg', $key) && self::webhookJsonString($key, 'alg') !== 'ES256') ||
            (array_key_exists('use', $key) && self::webhookJsonString($key, 'use') !== 'sig')
        ) {
            return ['unusable', null];
        }
        $pem =
            "-----BEGIN PUBLIC KEY-----\n" .
            chunk_split(
                base64_encode(
                    hex2bin('3059301306072a8648ce3d020106082a8648ce3d03010703420004') . $x . $y,
                ),
                64,
                "\n",
            ) .
            "-----END PUBLIC KEY-----\n";
        return openssl_pkey_get_public($pem) === false ? ['unusable', null] : ['key', $pem];
    }
    private static function webhookApcu(): bool
    {
        return function_exists('apcu_fetch') && function_exists('apcu_enabled') && \apcu_enabled();
    }
    /**
     * Read the shared JWKS state, ignoring implausible values that could pin a key set or block
     * refreshes: fetchedAt over 60 seconds ahead, more than a 24-hour TTL, or throttles more than
     * two minutes ahead.
     */
    private static function webhookSharedKeyState(?object $cache, string $key): array
    {
        $shared =
            $cache !== null ? $cache->get($key) : (self::webhookApcu() ? \apcu_fetch($key) : null);
        if (!is_array($shared)) {
            return [];
        }
        $now = microtime(true);
        $state = [];
        if (
            is_string($shared['jwks'] ?? null) &&
            is_numeric($shared['fetchedAt'] ?? null) &&
            is_numeric($shared['expiresAt'] ?? null) &&
            $shared['fetchedAt'] <= $now + 60 &&
            $shared['expiresAt'] <= $shared['fetchedAt'] + 86400
        ) {
            $state = [
                'jwks' => $shared['jwks'],
                'fetchedAt' => (float) $shared['fetchedAt'],
                'expiresAt' => (float) $shared['expiresAt'],
            ];
        }
        foreach (['attempt', 'retryAfter'] as $name) {
            if (is_numeric($shared[$name] ?? null) && $shared[$name] <= $now + 120) {
                $state[$name] = (float) $shared[$name];
            }
        }
        return $state;
    }
    /** Shared state uses the PSR-16 cache when supplied, else APCu when enabled, else this process. */
    private static function webhookKeyState(?object $cache, string $url): array
    {
        $state = self::$webhookKeyStates[$url] ?? [];
        try {
            $shared = self::webhookSharedKeyState($cache, hash('sha256', 'webhook-jwks:' . $url));
            if (isset($shared['jwks']) && $shared['fetchedAt'] > ($state['fetchedAt'] ?? 0)) {
                $state =
                    ['keys' => self::webhookJwks($shared['jwks'])] +
                    array_intersect_key($shared, [
                        'jwks' => 0,
                        'fetchedAt' => 0,
                        'expiresAt' => 0,
                    ]) +
                    $state;
            }
            foreach (['attempt', 'retryAfter'] as $name) {
                if (isset($shared[$name])) {
                    $state[$name] = max($shared[$name], $state[$name] ?? 0);
                }
            }
        } catch (\Exception) {
            /* Ignore a malformed or unavailable optional shared cache entry. */
        }
        return self::$webhookKeyStates[$url] = $state;
    }
    private static function webhookStoreKeyState(?object $cache, string $url, array $state): void
    {
        self::$webhookKeyStates[$url] = $state;
        unset($state['keys']);
        $key = hash('sha256', 'webhook-jwks:' . $url);
        try {
            if ($cache === null && !self::webhookApcu()) {
                return;
            }
            // Another worker may have stored a newer set since this one read it; keep that set.
            $shared = self::webhookSharedKeyState($cache, $key);
            if (isset($shared['jwks']) && $shared['fetchedAt'] > ($state['fetchedAt'] ?? 0)) {
                foreach (['attempt', 'retryAfter'] as $name) {
                    $shared[$name] = max($shared[$name] ?? 0, $state[$name] ?? 0);
                }
                $state = $shared;
            }
            if ($cache !== null) {
                $cache->set($key, $state, 86400);
            } else {
                \apcu_store($key, $state, 86400);
            }
        } catch (\Exception) {
            /* A cache outage must not prevent trusted HTTP key retrieval. */
        }
    }
    private static function webhookFetchKeys(string $url, array $options, \Closure $send): array
    {
        if (isset(self::$webhookKeyFlights[$url])) {
            $flight = self::$webhookKeyFlights[$url];
            if (\Fiber::getCurrent() === null) {
                self::webhookError(
                    'transport',
                    'jwks_unavailable',
                    'Reentrant JWKS fetch requires a Fiber scheduler',
                );
            }
            // Like credential exchange waiters, yield a monotonic deadline in milliseconds.
            $deadline = hrtime(true) / 1e6 + 5000;
            while (!$flight->done) {
                if (hrtime(true) / 1e6 >= $deadline) {
                    self::webhookError(
                        'transport',
                        'jwks_unavailable',
                        'Webhook JWKS wait timed out',
                    );
                }
                \Fiber::suspend(['deadline' => $deadline, 'cancellation' => null]);
            }
            if ($flight->error !== null) {
                throw $flight->error;
            }
            return $flight->result;
        }
        $flight = (object) ['done' => false, 'result' => null, 'error' => null];
        self::$webhookKeyFlights[$url] = $flight;
        $cache = $options['cache'] ?? null;
        try {
            // Inside the try, so even an \Error from a cache clears this flight.
            $state = self::webhookKeyState($cache, $url);
            $state['attempt'] = microtime(true);
            self::webhookStoreKeyState($cache, $url, $state);
            $deadline = hrtime(true) / 1e6 + 5000;
            if (isset($options['http_client'])) {
                $request = $options['request_factory']
                    ->createRequest('GET', $url)
                    ->withHeader('Accept', 'application/json');
                $response = $options['http_client']->sendRequest($request);
                $stream = $response->getBody();
                $body = '';
                try {
                    while (true) {
                        if (hrtime(true) / 1e6 >= $deadline) {
                            throw new \RuntimeException('JWKS timeout');
                        }
                        $chunk = $stream->read(min(8192, 256 * 1024 + 1 - strlen($body)));
                        if ($chunk === '') {
                            if ($stream->eof()) {
                                break;
                            }
                            throw new \RuntimeException('JWKS stream stalled');
                        }
                        $body .= $chunk;
                        if (strlen($body) > 256 * 1024) {
                            throw new \RuntimeException('JWKS response too large');
                        }
                    }
                } finally {
                    $stream->close();
                }
                $result = [
                    'status' => $response->getStatusCode(),
                    'headers' => ['cache-control' => $response->getHeaderLine('Cache-Control')],
                    'body' => $body,
                ];
            } else {
                $result = $send([
                    'url' => $url,
                    'method' => 'GET',
                    'headers' => ['accept' => 'application/json'],
                    'body' => null,
                    'timeoutMs' => 5000,
                    'maxResponseBytes' => 256 * 1024,
                    'cancellation' => null,
                ]);
            }
            if (
                hrtime(true) / 1e6 >= $deadline ||
                ($result['status'] ?? null) !== 200 ||
                !empty($result['failureCode']) ||
                !is_string($result['body'] ?? null) ||
                strlen($result['body']) > 256 * 1024
            ) {
                throw new \RuntimeException('JWKS HTTP failure');
            }
            $keys = self::webhookJwks($result['body']);
            $control = '';
            foreach ($result['headers'] ?? [] as $name => $value) {
                if (strtolower($name) === 'cache-control') {
                    $control = is_array($value) ? implode(',', $value) : $value;
                }
            }
            $ttl = preg_match(
                '/(?:^|,)\s*max-age\s*=\s*"?(\d+)"?(?=\s*(?:,|$))/i',
                $control,
                $match,
            )
                ? min(86400, max(300, (float) $match[1]))
                : 900;
            $now = microtime(true);
            $state = [
                'jwks' => $result['body'],
                'keys' => $keys,
                'fetchedAt' => $now,
                'expiresAt' => $now + $ttl,
                'attempt' => $state['attempt'],
                'retryAfter' => 0,
            ];
            self::webhookStoreKeyState($cache, $url, $state);
            return $flight->result = $state;
        } catch (\Exception | \Psr\Http\Client\ClientExceptionInterface) {
            // Serve the last successful set for 24 hours, retrying at most once a minute.
            $state = self::webhookKeyState($cache, $url);
            $now = microtime(true);
            if (isset($state['keys']) && $now - $state['fetchedAt'] <= 86400) {
                $state['retryAfter'] = $now + 60;
                self::webhookStoreKeyState($cache, $url, $state);
                return $flight->result = $state;
            }
            $flight->error = SdkError::create(
                'webhook',
                'Webhook JWKS unavailable; respond with 5xx so delivery can retry',
                errorCode: 'webhook_jwks_unavailable',
            );
            throw $flight->error;
        } catch (\Throwable $error) {
            // Programming errors propagate unchanged, to Fiber waiters as well.
            throw ($flight->error = $error);
        } finally {
            $flight->done = true;
            unset(self::$webhookKeyFlights[$url]);
        }
    }
    private static function webhookJwtKey(
        string $url,
        string $kid,
        array $options,
        \Closure $send,
    ): string {
        if (array_key_exists('jwks', $options)) {
            try {
                [$status, $pem] = self::webhookSelectKey(
                    self::webhookJwks(json_encode($options['jwks'], JSON_THROW_ON_ERROR)),
                    $kid,
                );
            } catch (\Exception) {
                [$status, $pem] = ['duplicate', null];
            }
            if ($status === 'duplicate') {
                self::webhookError(
                    'validation',
                    'invalid_input',
                    'Webhook jwks must be a JWKS object with a string kid on every key and unique key IDs',
                );
            }
        } else {
            $cache = $options['cache'] ?? null;
            $state = self::webhookKeyState($cache, $url);
            $now = microtime(true);
            if (
                isset(self::$webhookKeyFlights[$url]) ||
                !isset($state['keys']) ||
                ($state['expiresAt'] <= $now &&
                    ($now >= ($state['retryAfter'] ?? 0) || $now - $state['fetchedAt'] > 86400))
            ) {
                $state = self::webhookFetchKeys($url, $options, $send);
            }
            if (
                !array_filter($state['keys'], fn($key) => $key['kid'] === $kid) &&
                microtime(true) - ($state['attempt'] ?? 0) >= 60
            ) {
                $state = self::webhookFetchKeys($url, $options, $send);
            }
            [$status, $pem] = self::webhookSelectKey($state['keys'], $kid);
            // Like a malformed trusted set, a duplicate kid is a provider fault and retryable.
            if ($status === 'duplicate') {
                self::webhookError(
                    'transport',
                    'jwks_unavailable',
                    'Webhook JWKS unavailable; respond with 5xx so delivery can retry',
                );
            }
        }
        // A token naming an unusable key is invalid, never an outage, so forged tokens cannot cause 5xx.
        if ($status === 'unusable' || $pem === null) {
            self::webhookError(
                'authentication',
                $status === 'unknown' ? 'unknown_key' : 'invalid_token',
                $status === 'unknown' ? 'Webhook signing key is unknown' : 'Invalid webhook JWT',
            );
        }
        return $pem;
    }
    /** @param array<string, mixed> $options @return array<string, mixed> */
    public function verifyWebhookDelivery(mixed $rawBody, mixed $headers, array $options): array
    {
        return self::verifyWebhookDeliveryFromPlan(
            $this->descriptors ?? $this->contract,
            $rawBody,
            $headers,
            $options + ['base_url' => $this->baseUrl],
            $this->options->redactFields,
            fn(array $request): array => $this->options->transport
                ? ($this->options->transport)($request)
                : $this->send($request),
        );
    }
    /** @param array<string, mixed> $options @return array<string, mixed> */
    public static function verifyWebhookDeliveryFromPlan(
        array|Internal\DescriptorSource $source,
        mixed $rawBody,
        mixed $headers,
        array $options,
        array $redactFields = [],
        ?\Closure $send = null,
    ): array {
        $w =
            $source instanceof Internal\DescriptorSource
                ? $source->webhook()
                : $source['webhook'] ?? null;
        if (!$w) {
            Codec::fail('webhook', 'capability is not declared');
        }
        if (
            array_diff(array_keys($options), [
                'endpoint_ids',
                'secrets',
                'jwks',
                'base_url',
                'now_seconds',
                'cache',
                'http_client',
                'request_factory',
            ])
        ) {
            self::webhookError(
                'validation',
                'invalid_input',
                'Unknown webhook verification option',
            );
        }
        $strings = static function (mixed $value): array {
            $values = is_string($value) ? [$value] : $value;
            if (!is_array($values) || !array_is_list($values) || !$values) {
                self::webhookError(
                    'validation',
                    'invalid_input',
                    'Supply a nonempty string or list of strings',
                );
            }
            foreach ($values as $item) {
                if (!is_string($item) || $item === '') {
                    self::webhookError('validation', 'invalid_input', 'Supply nonempty strings');
                }
            }
            return $values;
        };
        $endpointIds = array_key_exists('endpoint_ids', $options)
            ? $strings($options['endpoint_ids'])
            : null;
        if (array_key_exists('secrets', $options)) {
            $strings($options['secrets']);
        }
        if (!$endpointIds && !array_key_exists('secrets', $options)) {
            self::webhookError('validation', 'invalid_input', 'Supply endpoint_ids or secrets');
        }
        foreach (
            [
                'cache' => 'Psr\\SimpleCache\\CacheInterface',
                'http_client' => 'Psr\\Http\\Client\\ClientInterface',
                'request_factory' => 'Psr\\Http\\Message\\RequestFactoryInterface',
            ]
            as $option => $interface
        ) {
            if (
                array_key_exists($option, $options) &&
                (!interface_exists($interface) ||
                    (!is_object($options[$option]) || !is_a($options[$option], $interface)))
            ) {
                self::webhookError(
                    'validation',
                    'invalid_input',
                    'Supply an installed PSR interface implementation for ' . $option,
                );
            }
        }
        if (isset($options['http_client']) !== isset($options['request_factory'])) {
            self::webhookError(
                'validation',
                'invalid_input',
                'Supply http_client with request_factory',
            );
        }
        $now = $options['now_seconds'] ?? time();
        if (
            !is_int($now) ||
            abs($now) >= 100000000000 ||
            (array_key_exists('now_seconds', $options) && $options['now_seconds'] === null)
        ) {
            self::webhookError(
                'validation',
                'invalid_input',
                'Webhook now_seconds must be integer Unix seconds, not milliseconds',
            );
        }
        if (!is_string($rawBody) || !is_array($headers)) {
            self::webhookError(
                'validation',
                'invalid_input',
                'Supply original body bytes and a header map',
            );
        }
        $authorization = self::webhookHeaderValues(
            $headers,
            $w['jwt']['header'] ?? 'authorization',
            true,
        );
        $bearer = array_filter(
            $authorization,
            fn($value) => preg_match('/(?:^|,)[ \t]*Bearer(?:[ \t]|$)/i', trim($value)),
        );
        if (!$bearer || !$endpointIds) {
            if (
                isset($options['secrets']) &&
                ($w['algorithm'] ?? null) === 'hmac-sha256' &&
                self::webhookHeaderValues($headers, $w['header'], true) &&
                (($w['format'] ?? '') === 'timestamped-hex' ||
                    self::webhookHeaderValues($headers, $w['timestampHeader'], true)) &&
                (($w['format'] ?? '') !== 'standard-webhooks' ||
                    self::webhookHeaderValues($headers, $w['idHeader'], true))
            ) {
                return self::verifyWebhookFromPlan(
                    $source,
                    $rawBody,
                    $headers,
                    $options['secrets'],
                    $now,
                    $redactFields,
                ) + ['signing_method' => 'hmac'];
            }
            self::webhookError(
                'authentication',
                'missing_header',
                'Missing webhook signing headers',
            );
        }
        $j = $w['jwt'] ?? null;
        if (!$j) {
            self::webhookError(
                'validation',
                'invalid_input',
                'JWT webhook verification is not declared',
            );
        }
        if (!extension_loaded('openssl')) {
            self::webhookError(
                'validation',
                'invalid_input',
                'ES256 verification requires ext-openssl',
            );
        }
        $issuer = $j['issuer'];
        if ($issuer === 'baseUrl') {
            if (
                !is_string($options['base_url'] ?? null) ||
                (!self::validBaseUrl($options['base_url']) ||
                    !preg_match('/^https?:/i', $options['base_url']))
            ) {
                self::webhookError(
                    'validation',
                    'invalid_input',
                    'Supply a trusted API base_url for JWT verification',
                );
            }
            $issuer = self::origin($options['base_url']);
        }
        $invalid = static fn() => self::webhookError(
            'authentication',
            'invalid_token',
            'Invalid webhook JWT',
        );
        if (
            count($authorization) !== 1 ||
            strlen($authorization[0]) > 16400 ||
            !preg_match(
                '/^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/iD',
                trim($authorization[0]),
                $parts,
            )
        ) {
            $invalid();
        }
        $jsonPart = static function (string $part): ?array {
            $text = self::webhookBase64url($part);
            return $text === null ? null : self::webhookJsonObject($text);
        };
        $jose = $jsonPart($parts[1]);
        $claims = $jsonPart($parts[2]);
        $signature = self::webhookBase64url($parts[3]);
        $kid = self::webhookJsonString($jose, 'kid');
        // Header members are exactly alg, kid and typ; claims are typed as in Flint's reference verifier.
        $jti = self::webhookJsonString($claims, 'jti');
        $aud = self::webhookJsonString($claims, 'aud');
        $iat = self::webhookJsonInteger($claims, 'iat');
        $exp = self::webhookJsonInteger($claims, 'exp');
        $bodyHash = self::webhookJsonString($claims, $j['bodyHashClaim']);
        if (
            $jose === null ||
            count($jose) !== 3 ||
            self::webhookJsonString($jose, 'alg') !== 'ES256' ||
            self::webhookJsonString($jose, 'typ') !== $j['typ'] ||
            $kid === null ||
            $kid === '' ||
            $signature === null ||
            strlen($signature) !== 64 ||
            $claims === null ||
            self::webhookJsonString($claims, 'iss') !== $issuer ||
            $aud === null ||
            $iat === null ||
            $exp === null ||
            $jti === null ||
            trim($jti) === '' ||
            $bodyHash === null ||
            array_key_exists('sub', $claims)
        ) {
            $invalid();
        }
        $send ??= static function (array $request) use ($source, $issuer): array {
            $runtime = new self(
                $source,
                new ClientOptions(
                    baseUrl: $issuer,
                    allowInsecureHttp: str_starts_with($issuer, 'http://'),
                ),
                true,
            );
            try {
                return $runtime->send($request);
            } finally {
                $runtime->close();
            }
        };
        $key = self::webhookJwtKey(rtrim($issuer, '/') . $j['jwksPath'], $kid, $options, $send);
        // JOSE uses fixed-width r||s; OpenSSL expects two signed DER INTEGERs.
        $integers = '';
        foreach ([substr($signature, 0, 32), substr($signature, 32)] as $integer) {
            $integer = ltrim($integer, "\0");
            if ($integer === '' || ord($integer[0]) >= 128) {
                $integer = "\0" . $integer;
            }
            $integers .= "\x02" . chr(strlen($integer)) . $integer;
        }
        $der = "\x30" . chr(strlen($integers)) . $integers;
        if (openssl_verify($parts[1] . '.' . $parts[2], $der, $key, OPENSSL_ALGO_SHA256) !== 1) {
            $invalid();
        }
        if (!in_array($aud, $endpointIds, true)) {
            self::webhookError(
                'authentication',
                'invalid_audience',
                'Webhook JWT audience does not match this endpoint',
            );
        }
        if (
            $iat <= 0 ||
            $exp <= $iat ||
            $exp - $iat > min(300, $j['lifetimeSeconds']) ||
            $iat > $now + $j['leewaySeconds'] ||
            $now >= $exp + $j['leewaySeconds']
        ) {
            self::webhookError(
                'authentication',
                'token_expired',
                'Webhook JWT timestamps are outside the permitted lifetime or leeway',
            );
        }
        $actualHash = self::webhookBase64url($bodyHash);
        if ($actualHash === null || !hash_equals(hash('sha256', $rawBody, true), $actualHash)) {
            self::webhookError(
                'authentication',
                'body_mismatch',
                'Webhook JWT does not match the original body bytes',
            );
        }
        return self::decodeWebhookFromPlan($source, $rawBody, $redactFields) + [
            'signing_method' => 'jwt',
        ];
    }
    /** @param string $rawBody Original request bytes.
     * @param array<string, string|list<string>> $headers
     * @param string|array<array-key, string> $secrets
     * @param int|null $nowSeconds
     */
    public function verifyWebhook(
        mixed $rawBody,
        mixed $headers,
        mixed $secrets,
        mixed $nowSeconds = null,
    ): array {
        return self::verifyWebhookFromPlan(
            $this->descriptors ?? $this->contract,
            $rawBody,
            $headers,
            $secrets,
            $nowSeconds,
            $this->options->redactFields,
        );
    }
    /** Verify compiled webhook descriptors without constructing an HTTP runtime. */
    public static function verifyWebhookFromPlan(
        array|Internal\DescriptorSource $source,
        mixed $rawBody,
        mixed $headers,
        mixed $secrets,
        mixed $nowSeconds = null,
        array $redactFields = [],
    ): array {
        $w =
            $source instanceof Internal\DescriptorSource
                ? $source->webhook()
                : $source['webhook'] ?? null;
        if (!$w || ($w['algorithm'] ?? null) !== 'hmac-sha256') {
            Codec::fail('webhook', 'HMAC capability is not declared');
        }
        if (!is_string($rawBody)) {
            self::webhookError(
                'validation',
                'invalid_input',
                'Webhook body must be original request bytes; capture it before JSON parsing',
            );
        }
        if (!is_array($headers)) {
            self::webhookError(
                'validation',
                'invalid_input',
                'Webhook headers must be a header map',
            );
        }
        if ((is_int($nowSeconds) || is_float($nowSeconds)) && abs($nowSeconds) >= 100000000000) {
            return self::webhookError(
                'validation',
                'invalid_input',
                'Webhook nowSeconds appears to be milliseconds; divide by 1000 to pass Unix seconds',
            );
        }
        if ($nowSeconds !== null && !is_int($nowSeconds)) {
            self::webhookError(
                'validation',
                'invalid_input',
                'Webhook nowSeconds must be an integer Unix timestamp in seconds',
            );
        }
        $supplied = is_string($secrets) ? [$secrets] : $secrets;
        if (!is_array($supplied) || !$supplied) {
            self::webhookError(
                'validation',
                'invalid_secret',
                'Webhook secrets must be a nonempty string or array of strings',
            );
        }
        $format = $w['format'] ?? 'hex';
        $keys = [];
        foreach ($supplied as $secret) {
            if (!is_string($secret)) {
                self::webhookError(
                    'validation',
                    'invalid_secret',
                    'Webhook secrets must be a nonempty string or array of strings',
                );
            }
            if ($secret === '') {
                continue;
            }
            if ($format !== 'standard-webhooks') {
                $keys[] = $secret;
            } elseif (preg_match('/^whsec_[A-Za-z0-9+\/]{43}=$/D', $secret)) {
                $key = base64_decode(substr($secret, 6), true);
                if (
                    $key !== false &&
                    strlen($key) === 32 &&
                    base64_encode($key) === substr($secret, 6)
                ) {
                    $keys[] = $key;
                }
            }
        }
        if (!$keys) {
            self::webhookError(
                'validation',
                'invalid_secret',
                $format === 'standard-webhooks'
                    ? 'Webhook secret must be whsec_ followed by canonical base64 encoding of 32 bytes'
                    : 'Provide at least one nonempty webhook signing secret',
            );
        }
        $signatures = self::webhookHeaderValues($headers, $w['header']);
        $timestamp = '';
        $candidates = [];
        $prefix = '';
        if ($format === 'timestamped-hex') {
            $parts = [];
            foreach ($signatures as $signature) {
                $parts = array_merge($parts, array_map('trim', explode(',', $signature)));
            }
            $timestamps = array_values(
                array_filter($parts, fn($part) => str_starts_with($part, 't=')),
            );
            if (count($timestamps) !== 1) {
                self::webhookError(
                    'authentication',
                    'invalid_timestamp',
                    'Webhook signature must contain exactly one t= timestamp',
                );
            }
            $timestamp = substr($timestamps[0], 2);
            $candidates = array_map(
                fn($part) => substr($part, 3),
                array_filter($parts, fn($part) => str_starts_with($part, 'v1=')),
            );
        } else {
            $timestamp = self::webhookScalarHeader($headers, $w['timestampHeader'], true);
            if ($format === 'standard-webhooks') {
                $prefix = self::webhookScalarHeader($headers, $w['idHeader']) . '.';
                foreach ($signatures as $signature) {
                    foreach (preg_split('/(?:\s+|,\s*(?=v\d+,))/', trim($signature)) as $part) {
                        if (str_starts_with($part, 'v1,')) {
                            $candidates[] = substr($part, 3);
                        }
                    }
                }
            } else {
                foreach ($signatures as $signature) {
                    $candidates = array_merge(
                        $candidates,
                        array_map('trim', explode(',', $signature)),
                    );
                }
            }
        }
        if (!preg_match('/^\d+$/D', $timestamp) || (float) $timestamp > 9007199254740991) {
            self::webhookError(
                'authentication',
                'invalid_timestamp',
                'Webhook timestamp must be an integer Unix timestamp in seconds',
            );
        }
        if (abs(($nowSeconds ?? time()) - (float) $timestamp) > $w['toleranceSeconds']) {
            self::webhookError(
                'authentication',
                'timestamp_out_of_tolerance',
                'Webhook timestamp is outside the allowed tolerance; check the server clock and delivery age',
            );
        }
        $valid = false;
        foreach ($keys as $key) {
            $digest = hash_hmac(
                'sha256',
                $prefix . $timestamp . $w['separator'] . $rawBody,
                $key,
                true,
            );
            foreach ($candidates as $candidate) {
                if ($format === 'standard-webhooks') {
                    if (!preg_match('/^[A-Za-z0-9+\/]{43}=$/D', $candidate)) {
                        continue;
                    }
                    $actual = base64_decode($candidate, true);
                    if ($actual === false || base64_encode($actual) !== $candidate) {
                        continue;
                    }
                } else {
                    if (!preg_match('/^[a-fA-F0-9]{64}$/D', $candidate)) {
                        continue;
                    }
                    $actual = hex2bin($candidate);
                }
                $valid = hash_equals($digest, $actual) || $valid;
            }
        }
        if (!$valid) {
            self::webhookError(
                'authentication',
                'invalid_signature',
                'Invalid webhook signature; check the signing secret and preserve the original request body bytes without reserializing JSON',
            );
        }
        return self::decodeWebhookFromPlan($source, $rawBody, $redactFields);
    }
    private static function decodeWebhookFromPlan(
        array|Internal\DescriptorSource $source,
        string $rawBody,
        array $redactFields,
    ): array {
        $w =
            $source instanceof Internal\DescriptorSource
                ? $source->webhook()
                : $source['webhook'] ?? null;
        $decode = static fn(mixed $value, array $codec, array $context): mixed => Codec::execute(
            $value,
            $codec,
            $context + [
                'definitions' =>
                    $source instanceof Internal\DescriptorSource
                        ? $source->definitions()
                        : $source['definitions'] ?? [],
            ],
        );
        try {
            $event = Codec::parse($rawBody, true);
        } catch (\Throwable $cause) {
            throw SdkError::create(
                'webhook',
                'Invalid webhook JSON',
                'response',
                errorCode: 'webhook_invalid_json',
                previous: $cause,
            );
        }
        $eventType = self::field($event, $w['typeField']);
        $schema = is_string($eventType) ? $w['events'][$eventType] ?? null : null;
        $known = false;
        if ($schema) {
            try {
                $decoded = $decode($event, $schema, [
                    'mode' => 'response',
                    'path' => 'event',
                ]);
            } catch (SdkError $cause) {
                if (SdkError::internalKind($cause) !== 'validation') {
                    throw $cause;
                }
                throw SdkError::create(
                    'webhook',
                    'Invalid webhook payload' .
                        (($reason = Codec::validationFailureMessage($cause)) !== null
                            ? ': ' . $reason
                            : ''),
                    'response',
                    previous: $cause,
                );
            }
            try {
                $decode($event, $schema, [
                    'mode' => 'match',
                    'direction' => 'response',
                    'path' => 'event',
                    'allowUnknownResponseFields' => true,
                ]);
                $known = true;
            } catch (SdkError $error) {
                if (SdkError::internalKind($error) !== 'validation') {
                    throw $error;
                }
            }
            $event = $decoded;
        }
        $event = Codec::plainNumbers($event);
        if (
            $known &&
            is_string($eventType) &&
            isset($w['eventModels'][$eventType]) &&
            is_object($event)
        ) {
            $class = __NAMESPACE__ . '\\' . $w['eventModels'][$eventType];
            $event = new $class((array) $event, $redactFields);
        }
        return [
            'event' => $event,
            'known' => $known,
            ...$known ? [] : ['reason' => $schema ? 'unmatched_envelope' : 'unknown_event'],
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
