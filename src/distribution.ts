import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  lstatSync,
  existsSync,
  cpSync,
  renameSync,
  rmSync,
  openSync,
  closeSync,
} from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Diagnostic, stable, type Contract } from './contract.js';
import MarkdownIt from 'markdown-it';
import { compareVersions } from './version.js';

export function artifactHashes(directory: string, prefix = ''): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const name of readdirSync(join(directory, prefix)).sort()) {
    const relative = prefix + name;
    const path = join(directory, relative);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink())
      throw new Diagnostic(path, 'distribution artifacts cannot be symlinks');
    if (stat.isDirectory()) Object.assign(hashes, artifactHashes(directory, relative + '/'));
    else if (stat.isFile())
      hashes[relative] = createHash('sha256').update(readFileSync(path)).digest('hex');
    else throw new Diagnostic(path, 'expected a regular distribution file');
  }
  return hashes;
}

export function verifyRelease(directory: string, confirmedVersion: string) {
  directory = resolve(directory);
  const plan = JSON.parse(readFileSync(join(directory, 'release-plan.json'), 'utf8'));
  if (
    !confirmedVersion ||
    confirmedVersion !== plan.version ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(confirmedVersion)
  )
    throw new Diagnostic(directory, 'confirm the exact reviewed version with --confirm-version');
  const entries = Object.entries(plan.checksums ?? {}) as [string, string][];
  if (!entries.length) throw new Diagnostic(directory, 'release has no checksummed artifacts');
  for (const [name, expected] of entries) {
    if (
      !/^[A-Za-z0-9_.\/-]+$/.test(name) ||
      name.split('/').some((p) => !p || p === '.' || p === '..') ||
      !/^[a-f0-9]{64}$/.test(expected)
    )
      throw new Diagnostic(directory, 'invalid release artifact record');
    let path = directory;
    for (const part of name.split('/')) {
      path = join(path, part);
      if (lstatSync(path).isSymbolicLink())
        throw new Diagnostic(path, 'release artifacts cannot be symlinks');
    }
    if (createHash('sha256').update(readFileSync(path)).digest('hex') !== expected)
      throw new Diagnostic(path, 'release archive changed after review; prepare a new release');
  }
  return plan;
}

const html = (text: string) =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
const markdown = new MarkdownIt({ html: false });
markdown.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
  const token = tokens[index]!;
  const href = token.attrGet('href');
  if (typeof href === 'string' && !/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href))
    token.attrSet(
      'href',
      href.replace(/\.md(?=[?#]|$)/, '.md.html').replace(/\.(php|mjs|ts)(?=[?#]|$)/, '.$1.txt'),
    );
  return renderer.renderToken(tokens, index, options);
};
function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${html(title)}</title><style>:root{color-scheme:light dark}body{max-width:90ch;margin:3rem auto;padding:0 1.5rem;font:16px/1.65 system-ui}nav{margin-bottom:2rem}h1,h2,h3{line-height:1.25}h2{margin-top:2.5rem}a{color:light-dark(#1550a4,#85b7ff)}pre{padding:1rem;overflow:auto;border:1px solid #8886;border-radius:.4rem}code{font-size:.9em}table{border-collapse:collapse;display:block;overflow:auto}th,td{padding:.6rem;text-align:left;border:1px solid #8886}img{max-width:100%}</style></head><body><main>${body}</main></body></html>\n`;
}

/** Static Composer repository and matching documentation, deployable without a service account. */
export function prepareSite(
  output: string,
  destination: string,
  contract: Contract,
  owned: string[],
) {
  const site = join(destination, 'site');
  const version = contract.config.version;
  const versionPath = `versions/${version}`;
  const put = (path: string, data: string | Buffer) => {
    mkdirSync(dirname(join(site, path)), { recursive: true });
    writeFileSync(join(site, path), data);
  };
  for (const path of owned.filter((p) =>
    /^(node|php)\/(README\.md|REFERENCE\.md|RUNTIME\.md|guides\/|examples\/)/.test(p),
  ))
    put(
      `${versionPath}/${path}${/\.(php|mjs|ts)$/.test(path) ? '.txt' : ''}`,
      readFileSync(join(output, path)),
    );
  for (const name of ['CHANGELOG.md', 'MIGRATION.md'])
    put(`${versionPath}/${name}`, readFileSync(join(destination, name)));
  const archives = readdirSync(destination).filter((p) => p.endsWith('.tgz') || p.endsWith('.zip'));
  for (const archive of archives)
    put(`${versionPath}/${archive}`, readFileSync(join(destination, archive)));
  const packages: Record<string, Record<string, unknown>> = {};
  const zip = archives.find((name) => name.endsWith('.zip'));
  if (zip) {
    const metadata = JSON.parse(readFileSync(join(output, 'php/composer.json'), 'utf8'));
    const distPath = `${versionPath}/${zip}`;
    metadata.dist = {
      type: 'zip',
      url: contract.config.release?.baseUrl
        ? new URL(distPath, contract.config.release.baseUrl.replace(/\/?$/, '/')).href
        : '/' + distPath,
      shasum: createHash('sha1')
        .update(readFileSync(join(destination, zip)))
        .digest('hex'),
    };
    packages[metadata.name] = { [version]: metadata };
  }
  put('packages.json', stable({ packages }));
  const documents = Object.keys(artifactHashes(site)).filter((p) => p.endsWith('.md'));
  for (const path of documents) {
    const text = readFileSync(join(site, path), 'utf8');
    put(
      path + '.html',
      page(
        `${contract.title} ${version}`,
        `<nav><a href="${'../'.repeat(path.split('/').length - 1)}index.html">All versions</a> / <a href="${'../'.repeat(path.split('/').length - 3)}index.html">Version ${html(version)}</a></nav>${markdown.render(text)}`,
      ),
    );
  }
  put(
    `${versionPath}/index.html`,
    page(
      `${contract.title} ${version}`,
      `<nav><a href="../../index.html">All versions</a></nav><h1>${html(contract.title)} ${html(version)}</h1><ul>${documents.map((p) => `<li><a href="${p.slice(versionPath.length + 1)}.html">${html(p.slice(versionPath.length + 1))}</a></li>`).join('')}</ul>`,
    ),
  );
  put(
    'index.html',
    page(
      `${contract.title} releases`,
      `<h1>${html(contract.title)} releases</h1><a href="${versionPath}/index.html">${html(version)}</a>`,
    ),
  );
  return { directory: 'site', versionPath, baseUrl: contract.config.release?.baseUrl ?? null };
}

/** Deploy to a provider-owned web root or hosting checkout, preserving prior immutable versions. */
export function publishSite(directory: string, destination: string, confirmedVersion: string) {
  directory = resolve(directory);
  destination = resolve(destination);
  const plan = verifyRelease(directory, confirmedVersion);
  if (!plan.site || !Object.keys(plan.checksums).some((p) => p.startsWith('site/')))
    throw new Diagnostic(directory, 'release does not contain a reviewed site');
  if (
    destination === dirname(destination) ||
    destination === directory ||
    destination.startsWith(directory + '/') ||
    directory.startsWith(destination + '/')
  )
    throw new Diagnostic(destination, 'choose a web root separate from release artifacts');
  const files = Object.entries(plan.checksums).filter(([p]) => p.startsWith('site/')) as [
    string,
    string,
  ][];
  mkdirSync(dirname(destination), { recursive: true });
  const lock = destination + '.sdk-site.lock';
  const fd = openSync(lock, 'wx');
  const stage = destination + '.stage-' + randomUUID(),
    backup = destination + '.backup-' + randomUUID();
  let moved = false;
  try {
    const existingHashes = existsSync(destination) ? artifactHashes(destination) : {};
    if (existsSync(destination) && !existsSync(join(destination, '.sdk-site.json')))
      throw new Diagnostic(
        destination,
        'destination is not an SDK distribution site; choose a new directory',
      );
    const previous = existsSync(join(destination, '.sdk-site.json'))
      ? JSON.parse(readFileSync(join(destination, '.sdk-site.json'), 'utf8'))
      : { versions: {}, packages: {} };
    const packageIdentity = stable(plan.packages ?? {});
    if (previous.identity && previous.identity !== packageIdentity)
      throw new Diagnostic(destination, 'site belongs to a different SDK');
    const versionHashes = Object.fromEntries(
      files
        .filter(([p]) => p.startsWith(`site/versions/${confirmedVersion}/`))
        .map(([p, h]) => [p.slice(5), h]),
    );
    if (
      previous.versions[confirmedVersion] &&
      stable(previous.versions[confirmedVersion].files) !== stable(versionHashes)
    )
      throw new Diagnostic(destination, 'published versions are immutable; choose a new version');
    for (const prior of Object.values(previous.versions) as { files: Record<string, string> }[])
      for (const [path, expected] of Object.entries(prior.files))
        if (existingHashes[path] !== expected)
          throw new Diagnostic(
            path,
            'published version was modified; restore it before publishing',
          );
    for (const [path, expected] of files) {
      const target = path.slice(5);
      if (
        target.startsWith(`versions/${confirmedVersion}/`) &&
        existingHashes[target] &&
        existingHashes[target] !== expected
      )
        throw new Diagnostic(target, 'published versions are immutable; choose a new version');
    }
    if (existsSync(destination)) cpSync(destination, stage, { recursive: true });
    else mkdirSync(stage);
    for (const [path] of files) {
      const target = join(stage, path.slice(5));
      mkdirSync(dirname(target), { recursive: true });
      cpSync(join(directory, path), target);
    }
    const packages = previous.packages;
    const incoming = JSON.parse(readFileSync(join(stage, 'packages.json'), 'utf8')).packages;
    for (const [name, versions] of Object.entries(incoming))
      packages[name] = { ...(packages[name] ?? {}), ...(versions as object) };
    previous.versions[confirmedVersion] = { contractHash: plan.contractHash, files: versionHashes };
    writeFileSync(join(stage, 'packages.json'), stable({ packages }));
    writeFileSync(
      join(stage, '.sdk-site.json'),
      stable({ ...previous, packages, identity: packageIdentity }),
    );
    writeFileSync(
      join(stage, 'index.html'),
      page(
        'SDK releases',
        `<h1>SDK releases</h1><ul>${Object.keys(previous.versions)
          .sort((a, b) => compareVersions(b, a))
          .map((v) => `<li><a href="versions/${html(v)}/index.html">${html(v)}</a></li>`)
          .join('')}</ul>`,
      ),
    );
    if (existsSync(destination)) {
      renameSync(destination, backup);
      moved = true;
    }
    renameSync(stage, destination);
    rmSync(backup, { recursive: true, force: true });
    const receipt = {
      version: confirmedVersion,
      sitePublished: true,
      destination,
      baseUrl: plan.site.baseUrl,
    };
    writeFileSync(join(directory, 'site-publication.json'), stable(receipt));
    return receipt;
  } catch (error) {
    if (moved && !existsSync(destination)) renameSync(backup, destination);
    throw error;
  } finally {
    rmSync(stage, { recursive: true, force: true });
    closeSync(fd);
    rmSync(lock, { force: true });
  }
}
