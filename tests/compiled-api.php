<?php
declare(strict_types=1);
require $argv[1] . '/Runtime.php';
require $argv[1] . '/Client.php';
$api = [];
$generated = [];
foreach (glob($argv[1] . '/classes/*.php') as $file) {
    $source = file_get_contents($file);
    preg_match('/namespace ([^;]+);/', $source, $namespace);
    $short = basename($file, '.php');
    if (
        in_array(
            $short,
            [
                'SdkError',
                'Result',
                'Cancellation',
                'RequestOptions',
                'ClientOptions',
                'ByteStream',
                'CurlByteStream',
                'ServerSentEvent',
                'EventStream',
                'Model',
                'RawNumber',
                'ParsedNumber',
                'ExactNumber',
                'Codec',
                'Runtime',
                'SdkResponse',
            ],
            true,
        )
    ) {
        continue;
    }
    $name = $namespace[1] . '\\' . $short;
    class_exists($name);
    $generated[$name] = true;
}
foreach (get_declared_classes() as $name) {
    $class = new ReflectionClass($name);
    if (!isset($generated[$name])) {
        continue;
    }
    $methods = [];
    foreach ($class->getMethods(ReflectionMethod::IS_PUBLIC) as $method) {
        if ($method->getDeclaringClass()->name !== $name) {
            continue;
        }
        // Added internal accessor; the legacy definitions() remains inventoried.
        if (
            $class->getShortName() === 'SchemaRegistry' &&
            in_array($method->name, ['codecs', 'source'], true)
        ) {
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
