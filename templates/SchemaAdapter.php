<?php
declare(strict_types=1);
namespace SdkNamespace\Internal;

/** Compatibility boundary for schemas supplied by callers after SDK installation. */
final class SchemaAdapter
{
    private static function conjuncts(array $schema): array
    {
        $parts = [$schema];
        foreach ($schema['allOf'] ?? [] as $child) {
            $parts = array_merge($parts, self::conjuncts($child));
        }
        return $parts;
    }
    private static function discriminatorBindings(array $schema): ?array
    {
        $property = $schema['discriminator']['propertyName'] ?? null;
        if ($property === null || !isset($schema['oneOf'])) {
            return null;
        }
        $result = [];
        $siblings = $schema;
        unset($siblings['oneOf']);
        foreach ($schema['oneOf'] as $index => $branch) {
            $parts = array_merge(self::conjuncts($siblings), self::conjuncts($branch));
            $object = false;
            $required = false;
            $sets = [];
            foreach ($parts as $part) {
                $object = $object || ($part['type'] ?? null) === 'object';
                $required = $required || in_array($property, $part['required'] ?? [], true);
                foreach (
                    isset($part['properties'][$property])
                        ? self::conjuncts($part['properties'][$property])
                        : []
                    as $field
                ) {
                    if (array_key_exists('const', $field)) {
                        $sets[] = [$field['const']];
                    } elseif (isset($field['enum'])) {
                        $sets[] = $field['enum'];
                    }
                }
            }
            if (!$object || !$required || !$sets) {
                return null;
            }
            $tags = array_filter($sets[0], static function ($value) use ($sets) {
                foreach ($sets as $set) {
                    if (!in_array($value, $set, true)) {
                        return false;
                    }
                }
                return true;
            });
            if (!$tags) {
                return null;
            }
            foreach ($tags as $tag) {
                if (!is_string($tag) || array_key_exists($tag, $result)) {
                    return null;
                }
                $result[$tag] = $index;
            }
        }
        return $result;
    }
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
            if (isset($op['streamEventSchemas'])) {
                $op['streamEventCodecs'] = array_map($root, $op['streamEventSchemas']);
                unset($op['streamEventSchemas']);
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
        $contract['semantics'] = '3';
        if (isset($contract['incoming'])) {
            foreach ($contract['incoming'] as &$entry) {
                $entry['codec'] = $root($entry['schema']);
                unset($entry['schema']);
            }
            unset($entry);
        }
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
            foreach (['if', 'then', 'else'] as $key) {
                if (isset($s[$key])) {
                    $s[$key] = $project($s[$key]);
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
            ...($input['x-sdk-number-input'] ?? null) === 'explicit'
                ? ['numberInput' => 'explicit']
                : [],
            'value' => ['kind' => $kind] + ($kind === 'opaque' ? ['label' => $type] : []),
            'nullable' => !isset($input['type']) || in_array('null', $types, true),
            'modelObjectInput' =>
                (bool) array_filter(
                    self::conjuncts($input),
                    fn($part) => ($part['type'] ?? null) === 'object',
                ) ||
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
                    'multipleOf',
                    'minLength',
                    'maxLength',
                    'minItems',
                    'maxItems',
                    'minProperties',
                    'maxProperties',
                    'uniqueItems',
                    'pattern',
                ]),
            ),
        ];
        if (($input['type'] ?? null) === 'object') {
            $plan['objectOnlyAlternative'] = true;
        }
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
        if (array_key_exists('const', $input)) {
            $plan['literal'] = json_encode($input['const'], JSON_THROW_ON_ERROR);
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
        if (isset($input['contains'])) {
            $plan['includes'] = self::node($input['contains'], $input['contains'], $depth + 1);
        }
        if (isset($input['if'])) {
            $plan['when'] = ['test' => self::node($request['if'], $response['if'], $depth + 1)];
            foreach (['then', 'else'] as $key) {
                if (isset($request[$key])) {
                    $plan['when'][$key] = self::node(
                        $request[$key],
                        $response[$key] ?? $request[$key],
                        $depth + 1,
                    );
                }
            }
        }
        $bindings = self::discriminatorBindings($input);
        if (isset($input['discriminator']) && $bindings !== null) {
            $plan['tag'] = $input['discriminator']['propertyName'];
            foreach ($plan['exactlyOne'] as $index => &$branch) {
                $branch['tagValues'] = array_map(
                    strval(...),
                    array_keys(array_filter($bindings, fn($target) => $target === $index)),
                );
            }
            unset($branch);
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
