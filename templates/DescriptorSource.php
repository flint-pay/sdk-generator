<?php
declare(strict_types=1);
namespace SdkNamespace\Internal;

/** Package-owned descriptors; PHP arrays returned to callers use copy-on-write. */
final class DescriptorSource
{
    private array $settings;
    private array $routes;
    private array $operations = [];
    private array $definitions = [];
    private array $loaded = [];
    private array $models = [];
    private ?array $webhook = null;
    private bool $webhookLoaded = false;
    public function __construct(
        private readonly string $directory,
        private readonly bool $hasWebhook,
    ) {
        $this->settings = $this->read('settings');
        \SdkNamespace\Runtime::assertCompiledPlan($this->settings);
        $this->routes = $this->read('routes');
    }
    private function read(string $path): array
    {
        $text = file_get_contents($this->directory . '/' . $path . '.json');
        if ($text === false) {
            throw new \RuntimeException('Missing SDK descriptor ' . $path);
        }
        $value = json_decode($text, true, 512, JSON_THROW_ON_ERROR);
        if (!is_array($value)) {
            throw new \InvalidArgumentException('Invalid SDK descriptor ' . $path);
        }
        return $value;
    }
    private function dependencies(array $names): array
    {
        $out = [];
        foreach ($names as $name) {
            if (!is_string($name)) {
                throw new \InvalidArgumentException('Invalid codec dependency');
            }
            if (!isset($this->definitions[$name])) {
                $codec = $this->read('codecs/' . hash('sha256', $name));
                \SdkNamespace\Codec::assertPlan($codec, 'definitions.' . $name);
                $this->definitions[$name] = $codec;
            }
            $out[$name] = $this->definitions[$name];
        }
        self::references($out, $out);
        return $out;
    }
    private static function references(mixed $value, array $definitions): void
    {
        if (!is_array($value)) {
            return;
        }
        if (isset($value['value']['kind']) && is_bool($value['nullable'] ?? null)) {
            if (
                isset($value['reference']) &&
                !array_key_exists($value['reference'], $definitions)
            ) {
                throw new \InvalidArgumentException(
                    'Missing compiled codec ' . $value['reference'],
                );
            }
            foreach (
                [
                    'fields',
                    'element',
                    'extra',
                    'every',
                    'some',
                    'exactlyOne',
                    'exclude',
                    'includes',
                    'when',
                    'definitions',
                ]
                as $key
            ) {
                if (isset($value[$key])) {
                    self::references($value[$key], $definitions);
                }
            }
            return;
        }
        foreach ($value as $child) {
            self::references($child, $definitions);
        }
    }
    /** Legacy complete-plan access is deliberately opt-in. */
    public function contract(): array
    {
        $metadata = $this->read('compatibility');
        $plan = $this->settings;
        foreach (array_keys($this->routes) as $id) {
            $plan['operations'][] = array_replace(
                $this->operation((string) $id),
                $metadata['operations'][$id],
            );
        }
        if ($metadata['includeDefinitions']) {
            $plan['definitions'] = $this->dependencies($metadata['definitions']);
        }
        if (isset($metadata['incoming'])) {
            $plan['incoming'] = $metadata['incoming'];
        }
        if ($this->webhook() !== null) {
            $plan['webhook'] = $this->webhook();
        }
        return $plan;
    }
    public function validateAll(): void
    {
        foreach (array_keys($this->routes) as $id) {
            $this->operation((string) $id);
        }
        foreach ($this->read('models') as $name) {
            $this->model($name);
        }
        $this->webhook();
    }
    public function settings(): array
    {
        return $this->settings;
    }
    public function definitions(): array
    {
        return $this->definitions;
    }
    public function operation(string $id): array
    {
        $resource = $this->routes[$id] ?? null;
        if (!is_string($resource)) {
            \SdkNamespace\Codec::fail('operation', 'operation is not included in this SDK');
        }
        if (!isset($this->loaded[$resource])) {
            $group = $this->read('resources/' . rawurlencode($resource));
            $definitions = $this->dependencies($group['dependencies']);
            self::references($group['operations'], $definitions);
            $plan = array_replace($this->settings, ['operations' => $group['operations']]);
            \SdkNamespace\Runtime::assertCompiledPlan($plan);
            $operations = [];
            foreach ($plan['operations'] as $op) {
                if (isset($operations[$op['id']])) {
                    throw new \InvalidArgumentException(
                        'Duplicate compiled operation ' . $op['id'],
                    );
                }
                if (
                    ($this->routes[$op['id']] ?? null) !== $resource ||
                    $op['resource'] !== $resource
                ) {
                    throw new \InvalidArgumentException(
                        'Unexpected compiled operation ' . $op['id'],
                    );
                }
                $operations[$op['id']] = $op;
            }
            foreach ($operations as $key => $operation) {
                $this->operations[$key] = $operation;
            }
            $this->loaded[$resource] = true;
        }
        return $this->operations[$id] ??
            throw new \InvalidArgumentException('Missing compiled operation ' . $id);
    }
    public function model(string $name): array
    {
        if (!isset($this->models[$name])) {
            $model = $this->read('models/' . rawurlencode($name));
            if (
                array_key_exists('shared', $model) === array_key_exists('codec', $model) ||
                (isset($model['shared']) && !is_string($model['shared']))
            ) {
                throw new \InvalidArgumentException('Invalid model descriptor ' . $name);
            }
            $definitions = $this->dependencies($model['dependencies']);
            $codec = isset($model['shared'])
                ? $definitions[$model['shared']] ?? null
                : $model['codec'] ?? null;
            \SdkNamespace\Codec::assertPlan($codec);
            self::references($codec, $definitions);
            $this->models[$name] = $codec + ['definitions' => $definitions];
        }
        return $this->models[$name];
    }
    public function webhook(): ?array
    {
        if (!$this->webhookLoaded) {
            if ($this->hasWebhook) {
                $group = $this->read('webhook');
                $definitions = $this->dependencies($group['dependencies']);
                self::references($group['webhook'], $definitions);
                \SdkNamespace\Runtime::assertCompiledPlan(
                    array_replace($this->settings, ['webhook' => $group['webhook']]),
                );
                $this->webhook = $group['webhook'];
            }
            $this->webhookLoaded = true;
        }
        return $this->webhook;
    }
}
