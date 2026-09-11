import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

// Public examples stay HTTPS-only. Test copies opt in to our local HTTP server.
export function localExampleSource(source, target) {
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
