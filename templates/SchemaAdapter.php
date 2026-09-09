<?php
declare(strict_types=1);
namespace SdkNamespace\Internal;

/** Compatibility boundary for schemas supplied by callers after SDK installation. */
final class SchemaAdapter
{
    public static function compile(array $schema): array
    {
        return self::node($schema, $schema, 0);
    }
    public static function runtimePlan(array $contract): array
    {
        $root = fn($schema) => self::compile(
            $schema + ['x-sdk-validation' => $contract['validation'] ?? 'schema'],
        );
        foreach ($contract['operations'] as &$op) {
            foreach ($op['parameters'] as &$parameter) {
                $parameter['codec'] = $root($parameter['schema']);
                unset($parameter['schema']);
            }
            unset($parameter);
            if (isset($op['body'])) {
                $op['body'] = $root($op['body']);
            }
            foreach ($op['responses'] as &$response) {
                if (isset($response['schema'])) {
                    $response['codec'] = $root($response['schema']);
                    unset($response['schema']);
                }
            }
            unset($response);
        }
        unset($op);
        if (isset($contract['definitions'])) {
            $contract['definitions'] = array_map(self::compile(...), $contract['definitions']);
        }
        if (isset($contract['webhook'])) {
            $contract['webhook']['events'] = array_map($root, $contract['webhook']['events']);
        }
        $contract['format'] = 1;
        $contract['semantics'] = '1';
        return $contract;
    }
    private static function directional(array $schema, bool $response): array
    {
        $omitted = [];
        $collect = function ($s) use (&$collect, &$omitted, $response) {
            foreach ($s['properties'] ?? [] as $key => $child) {
                if ($response ? $child['writeOnly'] ?? false : $child['readOnly'] ?? false) {
                    $omitted[$key] = true;
                }
            }
            foreach ($s['allOf'] ?? [] as $branch) {
                $collect($branch);
            }
        };
        $collect($schema);
        if (!$omitted) {
            return $schema;
        }
        $project = function ($s) use (&$project, $omitted) {
            if (isset($s['required'])) {
                $s['required'] = array_values(
                    array_filter($s['required'], fn($key) => !isset($omitted[$key])),
                );
            }
            foreach (['allOf', 'anyOf', 'oneOf'] as $key) {
                if (isset($s[$key])) {
                    $s[$key] = array_map($project, $s[$key]);
                }
            }
            return $s;
        };
        return $project($schema);
    }
    private static function node(array $input, array $output, int $depth): array
    {
        if ($depth > 256) {
            throw new \InvalidArgumentException(
                'Schema exceeds the supported compilation depth (256)',
            );
        }
        $request = self::directional($input, false);
        $response = self::directional($output, true);
        $types = (array) ($input['type'] ?? []);
        $type =
            array_values(array_filter($types, fn($v) => $v !== 'null'))[0] ??
            (isset($input['type']) ? 'null' : null);
        $format = $input['format'] ?? '';
        $kind = match ($type) {
            null => 'dynamic',
            'null', 'boolean', 'string', 'object', 'array' => $type,
            'integer' => in_array($format, ['int64', 'uint64'], true)
                ? 'exact-integer'
                : 'safe-integer',
            'number' => 'decimal',
            default => 'opaque',
        };
        if (
            is_array($input['type'] ?? null) &&
            !array_filter($types, fn($value) => $value !== 'null')
        ) {
            $kind = 'null-array';
        }
        $plan = [
            'value' => ['kind' => $kind] + ($kind === 'opaque' ? ['label' => $type] : []),
            'nullable' => !isset($input['type']) || in_array('null', $types, true),
            'modelObjectInput' =>
                in_array('object', $types, true) ||
                (!isset($input['type']) &&
                    (isset($input['properties']) || isset($input['required']))),
            'requiredInput' => array_values(
                array_filter(
                    $request['required'] ?? [],
                    fn($key) => !($request['properties'][$key]['readOnly'] ?? false),
                ),
            ),
            'requiredOutput' => array_values(
                array_filter(
                    $response['required'] ?? [],
                    fn($key) => !($response['properties'][$key]['writeOnly'] ?? false),
                ),
            ),
            'rejectInput' => (bool) ($input['readOnly'] ?? false),
            'hiddenOutput' => (bool) ($input['writeOnly'] ?? false),
            'sensitive' =>
                (bool) (($input['x-sensitive'] ?? false) || ($input['writeOnly'] ?? false)),
            'checks' => array_intersect_key(
                $input,
                array_flip([
                    'minimum',
                    'maximum',
                    'exclusiveMinimum',
                    'exclusiveMaximum',
                    'minLength',
                    'maxLength',
                    'minItems',
                    'maxItems',
                    'pattern',
                ]),
            ),
        ];
        $ranges = [
            'int32' => ['-2147483648', '2147483647'],
            'uint32' => ['0', '4294967295'],
            'int64' => ['-9223372036854775808', '9223372036854775807'],
            'uint64' => ['0', '18446744073709551615'],
        ];
        if (isset($ranges[$format])) {
            $plan['range'] = $ranges[$format];
        }
        if (isset($input['properties'])) {
            $plan['fields'] = [];
            foreach ($input['properties'] as $key => $child) {
                $plan['fields'][$key] = self::node($child, $child, $depth + 1);
            }
        }
        if (isset($input['items'])) {
            $plan['element'] = self::node($input['items'], $input['items'], $depth + 1);
        }
        if (array_key_exists('additionalProperties', $input)) {
            $extra = $input['additionalProperties'];
            $plan['extra'] = is_array($extra) ? self::node($extra, $extra, $depth + 1) : $extra;
        }
        if (isset($input['enum'])) {
            $plan['members'] = $input['enum'];
        }
        if (isset($input['pattern'])) {
            $plan['phpPattern'] =
                $input['x-sdk-pattern-php'] ??
                '~' . str_replace('~', '\\~', $input['pattern']) . '~uD';
        }
        if (isset($input['x-sdk-validation'])) {
            $plan['constraints'] = $input['x-sdk-validation'] === 'schema';
        }
        foreach (
            ['allOf' => 'every', 'anyOf' => 'some', 'oneOf' => 'exactlyOne']
            as $key => $compiled
        ) {
            if (isset($request[$key])) {
                $plan[$compiled] = [];
                foreach ($request[$key] as $index => $child) {
                    $plan[$compiled][] = self::node(
                        $child,
                        $response[$key][$index] ?? $child,
                        $depth + 1,
                    );
                }
            }
        }
        if (isset($input['not'])) {
            $plan['exclude'] = self::node($input['not'], $input['not'], $depth + 1);
        }
        if (isset($input['discriminator'])) {
            $plan['tag'] = $input['discriminator']['propertyName'];
        }
        if (isset($input['x-sdk-ref'])) {
            $plan['reference'] = $input['x-sdk-ref'];
        }
        if (isset($input['x-sdk-definitions'])) {
            $plan['definitions'] = [];
            foreach ($input['x-sdk-definitions'] as $name => $s) {
                $plan['definitions'][$name] = self::node($s, $s, $depth + 1);
            }
        }
        return $plan;
    }
}
