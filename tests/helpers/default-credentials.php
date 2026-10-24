<?php
declare(strict_types=1);
namespace Example\Discovery {
    function microtime(bool $asFloat = false): float
    {
        return $GLOBALS['fixtureNow'];
    }
}
namespace {
    require $argv[1] . '/src/Runtime.php';
    use Example\Discovery\{Client, ClientOptions, RequestOptions};
    function check(bool $ok, string $message): void
    {
        if (!$ok) {
            throw new RuntimeException($message);
        }
    }
    function jwt(array $claims, float $now): string
    {
        $encode = static fn($s) => rtrim(strtr(base64_encode($s), '+/', '-_'), '=');
        return $encode('{}') .
            '.' .
            $encode(
                json_encode(
                    array_merge(
                        [
                            'iss' => 'synthetic-issuer',
                            'sub' => 'synthetic-subject',
                            'aud' => 'https://example.invalid',
                            'exp' => $now + ($claims['expOffset'] ?? 3600),
                        ],
                        $claims,
                    ),
                ),
            ) .
            '.synthetic-signature';
    }
    $cases = json_decode(file_get_contents($argv[2]), true, flags: JSON_THROW_ON_ERROR);
    foreach ($cases as $index => $c) {
        foreach (
            [
                'API_KEY',
                'ACCESS_TOKEN',
                'WORKLOAD_IDENTITY_ID',
                'OIDC_SOURCE',
                'OIDC_TOKEN',
                'OIDC_TOKEN_FILE',
                'OIDC_AUDIENCE',
                'OIDC_SCOPE',
            ]
            as $key
        ) {
            putenv('EXAMPLE_' . $key);
        }
        $GLOBALS['fixtureNow'] = 1900000000.0;
        $id = 'wid_synthetic_' . $index;
        foreach ($c['environment'] ?? [] as $key => $value) {
            putenv('EXAMPLE_' . $key . '=' . $value);
        }
        if ($c['identity'] ?? false) {
            putenv('EXAMPLE_WORKLOAD_IDENTITY_ID=' . $id);
        }
        $subject =
            $c['rawToken'] ?? (isset($c['token']) ? jwt($c['token'], $GLOBALS['fixtureNow']) : '');
        if ($subject) {
            putenv('EXAMPLE_OIDC_TOKEN=' . $subject);
        }
        $file = $argv[3] . '/php_' . $id . '.jwt';
        if (
            array_key_exists('file', $c) ||
            isset($c['fileToken']) ||
            ($c['missingFile'] ?? false)
        ) {
            putenv('EXAMPLE_OIDC_TOKEN_FILE=' . $file);
            if (!($c['missingFile'] ?? false)) {
                file_put_contents(
                    $file,
                    isset($c['fileToken'])
                        ? jwt($c['fileToken'], $GLOBALS['fixtureNow'])
                        : $c['file'],
                );
            }
        }
        $exchanges = 0;
        $seen = [];
        $subjects = [];
        $events = [];
        $transport = function ($r) use ($c, $id, $file, $subject, &$exchanges, &$seen, &$subjects) {
            if (parse_url($r['url'], PHP_URL_PATH) === '/v1/oauth/token') {
                $status = $c['exchanges'][$exchanges++] ?? null;
                check($status !== null, $c['name'] . ' unexpected exchange');
                check($r['method'] === 'POST', 'exchange method');
                check(
                    $r['headers']['content-type'] === 'application/x-www-form-urlencoded',
                    'exchange media',
                );
                $expectedSubject =
                    getenv('EXAMPLE_OIDC_SOURCE') === 'token_file' || !$subject
                        ? trim(file_get_contents($file))
                        : $subject;
                parse_str($r['body'], $form);
                $expected = [
                    'grant_type' => 'urn:ietf:params:oauth:grant-type:token-exchange',
                    'subject_token' => $expectedSubject,
                    'subject_token_type' => 'urn:ietf:params:oauth:token-type:jwt',
                    'requested_token_type' => 'urn:ietf:params:oauth:token-type:access_token',
                    'workload_identity_id' => $id,
                ];
                if (isset($c['environment']['OIDC_SCOPE'])) {
                    $expected['scope'] = $c['environment']['OIDC_SCOPE'];
                }
                check($form === $expected, $c['name'] . ' wrong exchange form');
                $subjects[] = $expectedSubject;
                if (!$status) {
                    throw new RuntimeException('synthetic-sensitive ' . $expectedSubject);
                }
                $body =
                    $c['response'] ??
                    ($status === 200
                        ? [
                            'access_token' => 'synthetic-exchanged-' . $exchanges,
                            'issued_token_type' => 'urn:ietf:params:oauth:token-type:access_token',
                            'token_type' => 'Bearer',
                            'expires_in' => $c['lifetime'] ?? 3600,
                            'scope' => 'records.read',
                            'workload_identity_id' => $id,
                            'merchant_id' => 'merchant_synthetic',
                            'mode' => 'test',
                            'sandbox_id' => 'sandbox_synthetic',
                        ]
                        : [
                            'error' => 'invalid_grant',
                            'error_description' =>
                                $c['echoToken'] ?? false
                                    ? 'Rejected ' . $expectedSubject
                                    : 'Synthetic server description',
                        ]);
                return [
                    'status' => $status,
                    'headers' => ['retry-after' => $c['retryAfter'] ?? '0'],
                    'body' => json_encode($body),
                ];
            }
            $seen[] = isset($r['headers']['authorization'])
                ? preg_replace('/^Bearer /', '', $r['headers']['authorization'])
                : $r['headers']['x-partner-key'] ?? null;
            return [
                'status' => $c['apiStatuses'][count($seen) - 1] ?? 204,
                'headers' => [],
                'body' => '',
            ];
        };
        $options = [
            'transport' => $transport,
            'diagnostics' => function ($event) use (&$events) {
                $events[] = $event;
            },
        ];
        if ($c['disabled'] ?? false) {
            $options['ambientCredentials'] = false;
        }
        if (isset($c['explicit'])) {
            $options['apiKey'] = $c['explicit'];
        }
        if (isset($c['explicitMap']) || ($c['emptyMap'] ?? false)) {
            $options['credentials'] = [
                'service' => $c['emptyMap'] ?? false ? [] : ['Bearer' => $c['explicitMap']],
            ];
        }
        if (isset($c['partnerCredential'])) {
            $options['credentials'] = ['partner' => ['Partner' => $c['partnerCredential']]];
        }
        if (isset($c['provider'])) {
            $options['apiKey'] =
                $c['provider'] === 'identity'
                    ? \Example\Discovery\workloadIdentityCredentials([
                        'workloadIdentityId' => $id,
                        'source' => 'token',
                    ])
                    : \Example\Discovery\defaultCredentials();
        }
        $client = new Client(new ClientOptions(...$options));
        check($exchanges === 0, 'construction must be lazy');
        $error = null;
        foreach ($c['calls'] ?? [0] as $advance) {
            $GLOBALS['fixtureNow'] += $advance;
            if ($advance && ($c['rotateFile'] ?? false)) {
                file_put_contents($file, jwt(['sub' => 'rotated-subject'], $GLOBALS['fixtureNow']));
            }
            try {
                $method = $c['method'] ?? ($c['anonymous'] ?? false ? 'anonymous' : 'read');
                $client->api->$method(
                    [],
                    isset($c['requestCredential'])
                        ? new RequestOptions(credentials: ['Bearer' => $c['requestCredential']])
                        : new RequestOptions(),
                );
            } catch (\Throwable $e) {
                $error = $e;
                break;
            }
        }
        check(
            ($error?->errorCode ?? null) === ($c['reason'] ?? null),
            $c['name'] . ' reason: ' . ($error?->getMessage() ?? 'none'),
        );
        check(
            ($error?->kind ?? null) ===
                (isset($c['reason']) || ($c['authenticationError'] ?? false)
                    ? 'authentication'
                    : null),
            $c['name'] . ' error kind',
        );
        check($seen === ($c['headers'] ?? []), $c['name'] . ' headers');
        check($exchanges === count($c['exchanges'] ?? []), $c['name'] . ' exchange count');
        if ($c['rotateFile'] ?? false) {
            check($subjects[0] !== $subjects[1], 'file not reread');
        }
        if ($c['echoToken'] ?? false) {
            check(
                $error->details['iss'] === 'synthetic-issuer' &&
                    $error->details['sub'] === 'synthetic-subject',
                'claims missing',
            );
            check(
                $error->details['error_description'] === 'Rejected [REDACTED]',
                'description not redacted',
            );
        }
        ob_start();
        var_dump([$client, $options['apiKey'] ?? null, $error, $events]);
        $debug = ob_get_clean() . json_encode([$error, $events]);
        foreach ($c['redactedTokens'] ?? [] as $token) {
            foreach ([$token, rawurlencode($token)] as $value) {
                foreach (
                    [
                        $error->getMessage(),
                        json_encode($error->details),
                        json_encode($error->__debugInfo()),
                        $debug,
                    ]
                    as $surface
                ) {
                    check(!str_contains($surface, $value), $c['name'] . ' response token leaked');
                }
            }
            check(
                str_contains($error->details['error_description'], '[REDACTED]'),
                'redaction missing',
            );
        }
        if ($subject) {
            check(!str_contains($debug, $subject), $c['name'] . ' subject leaked');
        }
        check(
            !preg_match('/synthetic-exchanged-|synthetic-api-key|synthetic-access-token/', $debug),
            $c['name'] . ' token leaked',
        );
        $client->close();
    }
    $variants = json_decode(
        file_get_contents(dirname($argv[2]) . '/default-credentials-cache.json'),
        true,
        flags: JSON_THROW_ON_ERROR,
    );
    foreach (['API_KEY', 'ACCESS_TOKEN'] as $key) {
        putenv('EXAMPLE_' . $key);
    }
    $subject = jwt(
        ['aud' => ['https://example.invalid', 'custom-audience']],
        $GLOBALS['fixtureNow'],
    );
    $file = $argv[3] . '/php-cache-partition.jwt';
    file_put_contents($file, $subject);
    putenv('EXAMPLE_OIDC_TOKEN=' . $subject);
    putenv('EXAMPLE_OIDC_TOKEN_FILE=' . $file);
    $exchanges = 0;
    foreach ($variants as $v) {
        foreach (
            [
                'WORKLOAD_IDENTITY_ID' => $v['id'],
                'OIDC_AUDIENCE' => $v['audience'],
                'OIDC_SCOPE' => $v['scope'],
                'OIDC_SOURCE' => $v['source'],
            ]
            as $key => $value
        ) {
            putenv('EXAMPLE_' . $key . '=' . $value);
        }
        $client = new Client(
            new ClientOptions(
                baseUrl: $v['baseUrl'],
                transport: function ($r) use (&$exchanges, $v) {
                    if (str_ends_with($r['url'], '/token')) {
                        $exchanges++;
                        parse_str($r['body'], $form);
                        check($form['scope'] === $v['scope'], 'partition scope');
                        return [
                            'status' => 200,
                            'headers' => [],
                            'body' => json_encode([
                                'access_token' => 'synthetic-partition-' . $exchanges,
                                'token_type' => 'Bearer',
                                'issued_token_type' =>
                                    'urn:ietf:params:oauth:token-type:access_token',
                                'expires_in' => 3600,
                            ]),
                        ];
                    }
                    return ['status' => 204, 'headers' => [], 'body' => ''];
                },
            ),
        );
        $client->api->read();
        check($exchanges === $v['exchanges'], 'PHP cache partition');
    }
    // A cooperative scheduler starts 100 callers before allowing the exchange to finish.
    foreach (
        ['API_KEY', 'ACCESS_TOKEN', 'OIDC_TOKEN_FILE', 'OIDC_SOURCE', 'OIDC_SCOPE', 'OIDC_AUDIENCE']
        as $key
    ) {
        putenv('EXAMPLE_' . $key);
    }
    putenv('EXAMPLE_WORKLOAD_IDENTITY_ID=wid_synthetic_fibers');
    putenv('EXAMPLE_OIDC_TOKEN=' . jwt([], $GLOBALS['fixtureNow']));
    $exchanges = 0;
    $requests = 0;
    $transport = function ($r) use (&$exchanges, &$requests) {
        if (str_ends_with($r['url'], '/token')) {
            $exchanges++;
            \Fiber::suspend();
            return [
                'status' => 200,
                'headers' => [],
                'body' => json_encode([
                    'access_token' => 'synthetic-fiber',
                    'token_type' => 'Bearer',
                    'issued_token_type' => 'urn:ietf:params:oauth:token-type:access_token',
                    'expires_in' => 3600,
                ]),
            ];
        }
        $requests++;
        return ['status' => 204, 'headers' => [], 'body' => ''];
    };
    $fibers = [];
    for ($i = 0; $i < 100; $i++) {
        $fibers[] = new \Fiber(function () use ($transport) {
            $client = new Client(new ClientOptions(transport: $transport));
            $client->api->read();
        });
        $fibers[$i]->start();
    }
    check(
        $exchanges === 1 && $requests === 0,
        'PHP concurrent callers did not share the in-flight exchange',
    );
    foreach ($fibers as $fiber) {
        $fiber->resume();
        check($fiber->isTerminated(), 'Fiber did not finish');
    }
    check($exchanges === 1 && $requests === 100, 'PHP single-flight failed');
    $scenarios = json_decode(
        file_get_contents(dirname($argv[2]) . '/default-credentials-concurrency.json'),
        true,
        flags: JSON_THROW_ON_ERROR,
    );
    foreach ($scenarios as $index => $c) {
        foreach (
            [
                'API_KEY',
                'ACCESS_TOKEN',
                'OIDC_TOKEN_FILE',
                'OIDC_SOURCE',
                'OIDC_SCOPE',
                'OIDC_AUDIENCE',
            ]
            as $key
        ) {
            putenv('EXAMPLE_' . $key);
        }
        putenv(
            'EXAMPLE_OIDC_TOKEN=' .
                jwt(
                    ['aud' => ['https://example.invalid', 'https://other.invalid']],
                    $GLOBALS['fixtureNow'],
                ),
        );
        $provider = \Example\Discovery\workloadIdentityCredentials([
            'workloadIdentityId' => 'wid_concurrency_' . $index,
        ]);
        $exchanges = [];
        $seen = [];
        $transport = function ($r) use ($c, &$exchanges, &$seen) {
            $origin = 'https://' . parse_url($r['url'], PHP_URL_HOST);
            if (str_ends_with($r['url'], '/token')) {
                $exchanges[] = $origin;
                if ($c['kind'] === 'waiter') {
                    \Fiber::suspend();
                }
                return [
                    'status' => 200,
                    'headers' => [],
                    'body' => json_encode([
                        'access_token' => 'synthetic-shared-' . count($exchanges),
                        'token_type' => 'Bearer',
                        'issued_token_type' => 'urn:ietf:params:oauth:token-type:access_token',
                        'expires_in' => 3600,
                    ]),
                ];
            }
            $seen[] = preg_replace('/^Bearer /', '', $r['headers']['authorization']);
            $call = count($seen);
            if ($c['kind'] === 'invalidation' && $call === 1) {
                \Fiber::suspend();
                return ['status' => 401, 'headers' => [], 'body' => ''];
            }
            return [
                'status' => $c['kind'] === 'invalidation' && $call === 2 ? $c['secondStatus'] : 204,
                'headers' => [],
                'body' => '',
            ];
        };
        $client = static fn($baseUrl) => new Client(
            new ClientOptions(apiKey: $provider, baseUrl: $baseUrl, transport: $transport),
        );
        if ($c['kind'] === 'invalidation') {
            $first = new \Fiber(static fn() => $client($c['origins'][0])->api->read());
            $first->start();
            $second = $client($c['origins'][1]);
            $second->api->read();
            $first->resume();
            check($first->isTerminated(), $c['name'] . ' first request incomplete');
            $second->api->read();
            check($exchanges === $c['exchangeOrigins'], $c['name'] . ' exchange origins');
            check($seen === $c['headers'], $c['name'] . ' headers');
        } else {
            $owner = new \Fiber(static fn() => $client('https://example.invalid')->api->read());
            $owner->start();
            $cancellation = new \Example\Discovery\Cancellation();
            $waiter = new \Fiber(static function () use ($client, $c, $cancellation) {
                try {
                    return $client('https://example.invalid')->api->read(
                        [],
                        new RequestOptions(
                            deadlineMs: $c['deadlineMs'],
                            cancellation: $cancellation,
                        ),
                    );
                } catch (\Example\Discovery\SdkError $error) {
                    return $error;
                }
            });
            $wake = $waiter->start();
            check(
                is_array($wake) &&
                    is_numeric($wake['deadline'] ?? null) &&
                    $wake['cancellation'] === $cancellation,
                $c['name'] . ' missing scheduler wake conditions',
            );
            // A scheduler can resume a waiter before the owner finishes, without completing it.
            $waiter->resume();
            check($waiter->isSuspended(), $c['name'] . ' waiter finished early');
            if ($c['stop'] === 'cancelled') {
                $cancellation->cancel();
            } else {
                // Sleep until this waiter's advertised deadline, independently of its owner.
                usleep((int) max(0, ceil(($wake['deadline'] - hrtime(true) / 1e6 + 5) * 1000)));
            }
            if ($c['ownerFirst']) {
                $owner->resume();
            }
            $waiter->resume();
            check($waiter->isTerminated(), $c['name'] . ' waiter did not stop');
            $error = $waiter->getReturn();
            check(
                $error instanceof \Example\Discovery\SdkError && $error->kind === $c['stop'],
                $c['name'] . ' wrong error',
            );
            if (!$c['ownerFirst']) {
                check(
                    $owner->isSuspended() && count($seen) === 0,
                    $c['name'] . ' owner must still be waiting',
                );
                $owner->resume();
            }
            check($owner->isTerminated(), $c['name'] . ' owner did not finish');
            $client('https://example.invalid')->api->read();
            check(
                count($exchanges) === 1 && $seen === ['synthetic-shared-1', 'synthetic-shared-1'],
                $c['name'] . ' owner exchange not preserved',
            );
        }
    }
    echo 'ok';
}
