<?php
declare(strict_types=1);
require $argv[1] . '/Runtime.php';
require $argv[1] . '/Client.php';
$api = [];
foreach (get_declared_classes() as $name) {
    $class = new ReflectionClass($name);
    if ($class->getFileName() !== realpath($argv[1] . '/Client.php')) {
        continue;
    }
    $methods = [];
    foreach ($class->getMethods(ReflectionMethod::IS_PUBLIC) as $method) {
        if ($method->getDeclaringClass()->name !== $name) {
            continue;
        }
        // Added internal accessor; the legacy definitions() remains inventoried.
        if ($class->getShortName() === 'SchemaRegistry' && $method->name === 'codecs') {
            continue;
        }
        $parameters = [];
        foreach ($method->getParameters() as $parameter) {
            $parameters[] = [
                $parameter->name,
                (string) $parameter->getType(),
                $parameter->isOptional(),
                $parameter->isDefaultValueAvailable() ? $parameter->getDefaultValue() : null,
            ];
        }
        $methods[$method->name] = [
            $method->isStatic(),
            (string) $method->getReturnType(),
            $parameters,
        ];
    }
    ksort($methods);
    $api[$name] = [($class->getParentClass() ?: null)?->name, $methods];
}
ksort($api);
echo json_encode($api, JSON_THROW_ON_ERROR);
