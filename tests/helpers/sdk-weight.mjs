import { npmPackResult } from '../../dist/distribution.js';
import { buildSync } from 'esbuild';
import { tmpdir } from 'node:os';
import { readdirSync, statSync, readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** Consumer measurements run in fresh processes, independently of generation. */
export function measureSdkWeight(output) {
  output = resolve(output);
  const files = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? (entry.name === 'vendor' ? [] : files(path)) : [path];
    });
  const sizes = {};
  for (const target of ['node', 'php']) {
    const paths = files(join(output, target));
    sizes[target] = Object.fromEntries(
      ['.js', '.d.ts', '.php', '.json'].map((suffix) => [
        suffix,
        paths.filter((p) => p.endsWith(suffix)).reduce((n, p) => n + statSync(p).size, 0),
      ]),
    );
    sizes[target].largestSource = Math.max(
      ...paths
        .filter((p) => p.endsWith(target === 'node' ? '.js' : '.php'))
        .map((p) => statSync(p).size),
    );
  }
  const run = (command, args, options = {}) => {
    const result = spawnSync(command, args, {
      encoding: 'utf8',
      timeout: 120000,
      maxBuffer: 16 * 1024 * 1024,
      ...options,
    });
    return result.status === 0
      ? JSON.parse(result.stdout)
      : { failed: true, error: result.error?.message ?? result.stderr.slice(-2000) };
  };
  const node = run(process.execPath, [
    '--input-type=module',
    '-e',
    `
    const start=performance.now(),rss=process.memoryUsage().rss;
    const {Client}=await import(${JSON.stringify(pathToFileURL(join(output, 'node/index.js')).href)});
    const imported=performance.now(),importRss=process.memoryUsage().rss;
    const options={baseUrl:'https://example.invalid',token:'synthetic',transport:async()=>new Response('%PDF synthetic',{status:200,headers:{'content-type':'application/pdf'}})};
    const client=new Client(options),first=performance.now();
    for(let i=0;i<25;i++)new Client(options);
    const repeatedClientMs=(performance.now()-first)/25;
    const requestStart=performance.now(); await client.invoices.getPDF({invoice_id:'inv_test'});
    console.log(JSON.stringify({version:process.version,importMs:imported-start,importRss:importRss-rss,firstClientMs:first-imported,repeatedClientMs,firstRequestMs:performance.now()-requestStart,rss:process.memoryUsage().rss-rss}));
  `,
  ]);
  const ns = JSON.parse(readFileSync(join(output, 'php/composer.json'), 'utf8')).autoload;
  // Namespace is available in the generated client in both package layouts.
  const clientSource = readFileSync(join(output, 'php/src/Client.php'), 'utf8');
  const namespace =
    clientSource.match(/namespace ([^;]+);/)?.[1] ??
    Object.keys(ns['psr-4'] ?? {})[0]?.replace(/\\$/, '');
  const cache = mkdtempSync(join(tmpdir(), 'sdk-opcache-'));
  const php = [0, 1, 1].map((opcache, index) => ({
    cache: index === 2 ? 'warm' : opcache ? 'cold' : 'off',
    ...run('php', [
      '-d',
      'memory_limit=128M',
      '-d',
      `opcache.enable_cli=${opcache}`,
      '-d',
      'opcache.file_update_protection=0',
      '-d',
      'opcache.file_cache=' + cache,
      '-r',
      `
    $root=$argv[1];$start=hrtime(true);$base=memory_get_usage(true);
    if(file_exists($root.'/vendor/autoload.php'))require $root.'/vendor/autoload.php';else{require $root.'/src/Runtime.php';require $root.'/src/Client.php';}
    $loaded=hrtime(true);$importMemory=memory_get_usage(true)-$base;
    $options=new \\${namespace}\\ClientOptions(baseUrl:'https://example.invalid',token:'synthetic',transport:fn($r)=>['status'=>200,'headers'=>['content-type'=>'application/pdf'],'body'=>'%PDF synthetic']);
    $client=new \\${namespace}\\Client($options);$first=hrtime(true);
    for($i=0;$i<25;$i++){ $c=new \\${namespace}\\Client($options);$c->close(); }
    $repeated=(hrtime(true)-$first)/25e6;$requestStart=hrtime(true);$client->invoices->getPDF(['invoice_id'=>'inv_test']);$firstRequest=(hrtime(true)-$requestStart)/1e6;
    echo json_encode(['firstRequestMs'=>$firstRequest,'version'=>PHP_VERSION,'opcache'=>${opcache},'autoloadMs'=>($loaded-$start)/1e6,'autoloadMemory'=>$importMemory,'firstClientMs'=>($first-$loaded)/1e6,'repeatedClientMs'=>$repeated,'peakMemory'=>memory_get_peak_usage(true)]);
  `,
      join(output, 'php'),
    ]),
  }));
  rmSync(cache, { recursive: true, force: true });
  const bundles = {};
  for (const entry of ['index', 'resources/invoices'])
    if (existsSync(join(output, 'node', entry + '.js'))) {
      const result = buildSync({
        stdin: {
          contents: `import {Client} from './${entry}.js'; export const call=()=>new Client({baseUrl:'https://example.invalid',token:'synthetic'}).invoices.getPDF({invoice_id:'inv_test'});`,
          resolveDir: join(output, 'node'),
        },
        bundle: true,
        platform: 'node',
        format: 'esm',
        minify: true,
        write: false,
      });
      bundles[entry] = result.outputFiles[0].contents.byteLength;
    }
  const packed = run('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], {
    cwd: join(output, 'node'),
  });
  const archiveDir = mkdtempSync(join(tmpdir(), 'sdk-size-'));
  const archive = spawnSync(
    'composer',
    ['archive', '--format=zip', '--dir=' + archiveDir, '--file=sdk'],
    { cwd: join(output, 'php'), encoding: 'utf8', timeout: 120000 },
  );
  const archives = {
    node: npmPackResult(JSON.stringify(packed)).size,
    php:
      archive.status === 0
        ? statSync(join(archiveDir, 'sdk.zip')).size
        : { failed: true, error: archive.stderr.slice(-2000) },
  };
  rmSync(archiveDir, { recursive: true, force: true });
  return { sizes, node, php, bundles, archives };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  console.log(JSON.stringify(measureSdkWeight(process.argv[2]), null, 2));
