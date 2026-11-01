<?php
declare(strict_types=1);
namespace Aws\Credentials {
    final class Credentials
    {
        public function __construct($key, $secret, $token) {}
    }
}
namespace Aws\Sts {
    if (getenv('SYNTHETIC_AWS_AVAILABLE') === '1') {
        final class StsClient
        {
            public function __construct(private array $config) {}
            public function getWebIdentityToken(array $input): array
            {
                if (
                    $input !== [
                        'Audience' => ['https://example.invalid'],
                        'SigningAlgorithm' => 'ES384',
                    ] ||
                    ($this->config['http']['proxy'] ?? null) !== '' ||
                    ($this->config['http']['allow_redirects'] ?? null) !== false
                ) {
                    throw new \RuntimeException('Invalid STS invocation');
                }
                file_put_contents(getenv('SYNTHETIC_AWS_LOG'), "sts\n", FILE_APPEND);
                if (getenv('SYNTHETIC_AWS_FAILURE')) {
                    throw new \RuntimeException(getenv('SYNTHETIC_AWS_TOKEN'));
                }
                return ['WebIdentityToken' => getenv('SYNTHETIC_AWS_TOKEN')];
            }
        }
    }
}
namespace {
    require $argv[1] . '/src/autoload.php';
    $c = json_decode(getenv('SYNTHETIC_CASE'), true);
    $exchanges = 0;
    $apiCalls = 0;
    $options = [
        'transport' => static function ($r) use (&$exchanges, &$apiCalls, $c): array {
            if (str_ends_with($r['url'], '/v1/oauth/token')) {
                $exchanges++;
                parse_str($r['body'], $form);
                if ($form['subject_token'] !== getenv('SYNTHETIC_AWS_TOKEN')) {
                    throw new \RuntimeException('Invalid subject');
                }
                return [
                    'status' => 200,
                    'headers' => [],
                    'body' => json_encode([
                        'access_token' => 'synthetic-aws-access',
                        'token_type' => 'Bearer',
                        'issued_token_type' => 'urn:ietf:params:oauth:token-type:access_token',
                        'expires_in' => 3600,
                    ]),
                ];
            }
            $apiCalls++;
            return [
                'status' => ($c['cliAPI401'] ?? false) && $apiCalls === 1 ? 401 : 204,
                'headers' => [],
                'body' => '',
            ];
        },
    ];
    if ($c['explicit'] ?? false) {
        $options['apiKey'] = \Example\Discovery\workloadIdentityCredentials([
            'workloadIdentityId' => getenv('EXAMPLE_WORKLOAD_IDENTITY_ID'),
            'source' => 'aws',
        ]);
    }
    if ($c['ambientDisabled'] ?? false) {
        $options['ambientCredentials'] = false;
    }
    try {
        $client = new \Example\Discovery\Client(new \Example\Discovery\ClientOptions(...$options));
        for ($i = 0; $i < ($c['noExpiry'] ?? false ? 2 : 100); $i++) {
            $client->api->read();
        }
        echo json_encode(['result' => 'ok', 'exchanges' => $exchanges]);
    } catch (\Example\Discovery\SdkError $e) {
        $debug = $e->getMessage() . json_encode($e);
        foreach (['SYNTHETIC_AWS_TOKEN', 'SYNTHETIC_CLI_TOKEN'] as $key) {
            if (getenv($key) && str_contains($debug, getenv($key))) {
                exit(2);
            }
        }
        echo json_encode([
            'result' => $e->workloadIdentity['reason'] ?? $e->code,
            'exchanges' => $exchanges,
        ]);
    }
}
