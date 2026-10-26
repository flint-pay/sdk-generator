import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

// Older examples need an explicit local HTTP opt-in; current examples select it from the URL.
export function localExampleSource(source, target) {
  if (source.includes('allowInsecureHttp:')) return source;
  return target === 'php'
    ? source.replace(
        /^(\$[A-Za-z_][\w]* = new Client\(new ClientOptions\()/gm,
        '$1allowInsecureHttp: true, ',
      )
    : source.replace(/^(const [A-Za-z_$][\w$]* = new Client\(\{)/gm, '$1 allowInsecureHttp: true,');
}

export function localExampleFile(file) {
  const copy = join(dirname(file), '.local-' + basename(file));
  writeFileSync(
    copy,
    localExampleSource(readFileSync(file, 'utf8'), file.endsWith('.php') ? 'php' : 'node'),
  );
  return copy;
}

// Inject test autoloaders around either a documentation snippet or standalone example.
export function replacePhpExampleAutoload(source, replacement) {
  return source.replace(
    /(?:\$autoload = __DIR__;[\s\S]*?require_once [^\n]+;|require __DIR__ \. '[^']*vendor\/autoload.php';)/,
    replacement,
  );
}
