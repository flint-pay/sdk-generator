import { compileDocumentation, factParts, factShape } from './documentation-plan.js';
import { factNotes } from './documentation-format.js';
import { schemaLiteral, type EnumLinks } from './schema-documentation.js';
import {
  DocumentationFragments,
  modelFieldReference,
  modelDocumentationConventions,
  modelDescriptions,
} from './sdk-documentation.js';
import MarkdownIt from 'markdown-it';
import { posix } from 'node:path';
import type { Contract, Operation } from './contract.js';

export const docAnchor = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_\s-]/gu, '')
    .replace(/\s/g, '-');
export const resourceFile = (resource: string) => `reference/${resource}.md`;

/** Relocate package-local links when a section moves into a subdirectory. */
export function relocateDocument(
  source: string,
  models: ReadonlyMap<string, string>,
  nested = false,
): string {
  return source.replace(
    /(?<block>^(?<fence>`{3,}|~{3,})[^\n]*\n[\s\S]*?^\k<fence>[ \t]*(?:\n|$))|(?<inline>(?<ticks>`+)[^\n]*?\k<ticks>)|(?<siteLink>\[(?<siteLabel>[^\]]+)\]\(\/(?!\/)[^)]+\))|\]\((?<destination>[^)]+)\)/gm,
    (
      match: string,
      _block: string | undefined,
      _fence: string | undefined,
      _inline: string | undefined,
      _ticks: string | undefined,
      _siteLink: string | undefined,
      siteLabel: string | undefined,
      destination: string | undefined,
    ) => {
      // A source site's root-relative prose link has no origin in an installed
      // package. Retain its label instead of inventing a package-local target.
      if (siteLabel !== undefined) return siteLabel;
      if (!destination || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(destination)) return match;
      const model = destination.match(/^MODELS\.md#(.+)$/)?.[1];
      const resolved = model ? (models.get(model) ?? destination) : destination;
      return `](${nested && !resolved.startsWith('#') ? '../' : ''}${resolved})`;
    },
  );
}

/** Keep small model references together; large ones use an index and one file per model. */
export function modelDocuments(
  source: string,
  fieldAliases: ReadonlyMap<string, string> = new Map(),
): {
  files: Map<string, string>;
  links: Map<string, string>;
  namedLinks: Map<string, string>;
  fieldLinks: Map<string, string>;
  namedFieldLinks: Map<string, string>;
} {
  const aliases = new Map(fieldAliases);
  const sections = [...source.matchAll(/^## (\w+)\n([\s\S]*?)(?=^## |$(?![\s\S]))/gm)];
  // Intern complete model field fragments before assigning files. Comparing
  // rendered facts preserves target types, direction, constraints and enums.
  const fragments = new Map<string, RegExpMatchArray>();
  const fragmentAliases = new Map<string, string>();
  const tableOwners = new Map<string, RegExpMatchArray>();
  for (const section of sections) {
    const table = section[0].match(/\| Field \|[^\n]*\n(?:\|[^\n]*\n)+/)?.[0];
    if (table && (tableOwners.get(table)?.[0].length ?? 0) < section[0].length)
      tableOwners.set(table, section);
  }
  for (const section of sections) {
    const start = section[0].indexOf('| Field |');
    if (start < 0) continue;
    const fields = section[0].slice(start);
    const table = fields.match(/^\| Field \|[^\n]*\n(?:\|[^\n]*\n)+/)?.[0];
    const owner = table && tableOwners.get(table);
    if (owner && owner !== section && fields.trim() === table.trim()) {
      aliases.set(section[1]!, owner[1]!);
      section[0] =
        section[0].slice(0, start) +
        `Fields, types, descriptions and enum values: [${owner[1]}](MODELS.md#${docAnchor(owner[1]!)}).\n\n`;
      continue;
    }
    const identity = fields
      .replace(
        /^(#{3,6} )(.+)$/gm,
        (_, prefix: string, heading: string) => prefix + heading.replace(section[1]!, '{model}'),
      )
      .replaceAll(`](#${docAnchor(section[1]!)}-`, '](#{model}-');
    const previous = fragments.get(identity);
    if (!previous) {
      fragments.set(identity, section);
      continue;
    }
    aliases.set(section[1]!, previous[1]!);
    for (const heading of fields.matchAll(/^#{3,6} (.+)$/gm))
      fragmentAliases.set(
        docAnchor(heading[1]!),
        docAnchor(heading[1]!.replaceAll(section[1]!, previous[1]!)),
      );
    section[0] =
      section[0].slice(0, start) +
      `Fields, types, descriptions and enum values: [${previous[1]}](MODELS.md#${docAnchor(previous[1]!)}).\n\n`;
  }
  const links = new Map<string, string>();
  const split = Buffer.byteLength(source) > 100_000;
  for (const section of sections)
    links.set(
      docAnchor(section[1]!),
      `${split ? `models/${section[1]}.md` : 'MODELS.md'}#${docAnchor(section[1]!)}`,
    );
  const modelAnchors = new Set(links.keys());
  for (const section of sections) {
    const headings = [...section[0].matchAll(/^#{3,6} (.+)$/gm)];
    for (const [index, heading] of headings.entries()) {
      const key = docAnchor(heading[1]!);
      const body = section[0]
        .slice(heading.index! + heading[0].length, headings[index + 1]?.index)
        .trim();
      // Dotted scopes can share a Markdown slug (Owner.data vs OwnerData).
      // Prefer the complete fragment over a later alias, which could otherwise
      // redirect its own canonical link back to the alias stub.
      if (modelAnchors.has(key) || (links.has(key) && body.startsWith('Declared alternatives:')))
        continue;
      links.set(key, `${split ? `models/${section[1]}.md` : 'MODELS.md'}#${key}`);
    }
  }
  for (const [from, to] of fragmentAliases) if (links.has(to)) links.set(from, links.get(to)!);
  const introduction = source.slice(0, sections[0]?.index ?? source.length);
  const files = new Map<string, string>();
  const list = (entries: typeof sections, prefix = '') =>
    entries
      .map(
        (section) =>
          `- [${section[1]}](${split ? `${prefix}${section[1]}.md` : links.get(docAnchor(section[1]!))})`,
      )
      .join('\n') + '\n\n';
  let toc = '## Index\n\n';
  if (split && sections.length > 200) {
    for (let start = 0; start < sections.length; start += 100) {
      const chunk = sections.slice(start, start + 100);
      const path = `models/index-${start / 100 + 1}.md`;
      const label = `${chunk[0]![1]} – ${chunk.at(-1)![1]}`;
      toc += `- [${label}](${path})\n`;
      files.set(path, `[Model index](../MODELS.md)\n\n# ${label}\n\n${list(chunk)}`);
    }
    toc += '\n';
  } else toc += list(sections, 'models/');
  if (split) {
    files.set('MODELS.md', introduction + toc);
    for (const section of sections)
      files.set(
        `models/${section[1]}.md`,
        relocateDocument(
          `[Model index](MODELS.md) · [Runtime guide](RUNTIME.md)\n\n${section[0]}`,
          links,
          true,
        ),
      );
  } else
    files.set(
      'MODELS.md',
      relocateDocument(introduction + toc + sections.map((s) => s[0]).join(''), links),
    );
  const namedLinks = new Map(
    sections.map((section) => [section[1]!, links.get(docAnchor(section[1]!))!]),
  );
  const namedFieldLinks = new Map(namedLinks);
  for (const [name, canonical] of aliases) {
    let destination = canonical;
    const seen = new Set([name]);
    while (aliases.has(destination) && !seen.has(destination)) {
      seen.add(destination);
      destination = aliases.get(destination)!;
    }
    if (namedLinks.has(destination)) namedFieldLinks.set(name, namedLinks.get(destination)!);
  }
  const fieldLinks = new Map([...namedFieldLinks].map(([name, link]) => [docAnchor(name), link]));
  return { files, links, namedLinks, fieldLinks, namedFieldLinks };
}

/** Share exact field-table nodes across the package, preferring model tables.
 * Conditions remain at each use; links point directly at the table's heading.
 */
export function internDocumentationTables(files: Map<string, string>, target: string): void {
  internEnumerationLists(files, target);
  // Table boundaries and heading lines need block tokens, not inline parsing
  // of every field description and example in the package.
  const markdown = new MarkdownIt().disable('inline');
  const tables: {
    path: string;
    start: number;
    end: number;
    text: string;
    heading: string;
    root: boolean;
  }[] = [];
  for (const [path, source] of files) {
    if (!path.startsWith(target + '/') || !path.endsWith('.md')) continue;
    const lines = source.split('\n');
    let heading = '',
      level = 0;
    const ids = new Set<string>();
    for (const token of markdown.parse(source, {})) {
      if (token.type === 'heading_open') {
        const label = lines[token.map![0]]!.replace(/^#+ /, '');
        const base = docAnchor(label);
        heading = base;
        for (let suffix = 1; ids.has(heading); suffix++) heading = base + '-' + suffix;
        ids.add(heading);
        level = Number(token.tag.slice(1));
      }
      if (token.type !== 'table_open') continue;
      const [start, end] = token.map!;
      const text = lines.slice(start, end).join('\n');
      if (!text.startsWith('| Field | Presence |') || Buffer.byteLength(text) < 256) continue;
      tables.push({
        path,
        start,
        end,
        text,
        heading,
        root: (path.includes('/models/') || path.endsWith('/MODELS.md')) && level === 2,
      });
    }
  }
  const canonical = new Map<string, (typeof tables)[number]>();
  // Named model tables win over nested and operation tables, independently of
  // traversal order. Exact content includes emitted target-specific type links.
  for (const table of [...tables].sort((a, b) => Number(b.root) - Number(a.root)))
    if (!canonical.has(table.text)) canonical.set(table.text, table);
  const edits = new Map<string, typeof tables>();
  const redirected = new Map<string, (typeof tables)[number]>();
  for (const table of tables) {
    const owner = canonical.get(table.text)!;
    if (owner === table) continue;
    if (table.root) redirected.set(table.path + '#' + table.heading, owner);
    const changes = edits.get(table.path) ?? [];
    changes.push(table);
    edits.set(table.path, changes);
  }
  for (const [path, changes] of edits) {
    const lines = files.get(path)!.split('\n');
    for (const table of changes.sort((a, b) => b.start - a.start)) {
      const owner = canonical.get(table.text)!;
      const destination =
        owner.path === path ? '' : posix.relative(posix.dirname(path), owner.path);
      // Keep model links directly visible when sharing an operation's parameter
      // table, so a named request body never gains an extra navigation hop.
      const models = table.path.includes('/reference/')
        ? [
            ...new Set(
              [...table.text.matchAll(/\[(\w+)\]\(([^)]+)\)/g)]
                .filter((match) => /(?:MODELS\.md|models\/\w+\.md)#/.test(match[2]!))
                .map((match) => match[0]),
            ),
          ]
        : [];
      lines.splice(
        table.start,
        table.end - table.start,
        `Field definitions: [shared fields](${destination}#${owner.heading}).${models.length ? ' Models: ' + models.join(', ') + '.' : ''}`,
      );
    }
    files.set(path, lines.join('\n'));
  }
  // Operations still reach the definitions table with one link. Keep a separate
  // link to the declaring model's conditions when its definitions are shared.
  for (const [path, source] of files) {
    if (!path.startsWith(target + '/reference/')) continue;
    files.set(
      path,
      source.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (link, label: string, href: string) => {
        const [file, fragment] = href.split('#');
        const original = posix.normalize(posix.join(posix.dirname(path), file!));
        const owner = redirected.get(original + '#' + fragment);
        if (!owner) return link;
        const destination = posix.relative(posix.dirname(path), owner.path) + '#' + owner.heading;
        return `[${label}](${destination}) ([declared conditions](${href}))`;
      }),
    );
  }
}

/** Enum sets have a canonical list just as object facts have a canonical table. */
function internEnumerationLists(files: Map<string, string>, target: string): void {
  const canonical = new Map<string, { path: string; heading: string }>();
  const redirects = new Map<string, { path: string; heading: string }>();
  for (const [path, source] of files) {
    if (!path.startsWith(target + '/') || !path.endsWith('.md')) continue;
    const headings = [...source.matchAll(/^#{2,6} (.+)\n/gm)];
    const edits: { start: number; end: number }[] = [];
    for (const [index, heading] of headings.entries()) {
      if (!heading[1]!.endsWith(' values')) continue;
      const end = headings[index + 1]?.index ?? source.length;
      const body = source.slice(heading.index! + heading[0].length, end).trim();
      if (Buffer.byteLength(body) < 256 || !body.split('\n').every((line) => /^- `/.test(line)))
        continue;
      const owner = canonical.get(body);
      const location = { path, heading: docAnchor(heading[1]!) };
      if (!owner) canonical.set(body, location);
      else {
        redirects.set(path + '#' + location.heading, owner);
        edits.push({ start: heading.index!, end });
      }
    }
    let result = source;
    for (const edit of edits.reverse())
      result = result.slice(0, edit.start) + result.slice(edit.end);
    files.set(path, result);
  }
  for (const [path, source] of files) {
    if (!path.startsWith(target + '/') || !path.endsWith('.md')) continue;
    files.set(
      path,
      source.replace(
        /(?<fence>^```[^\n]*\n[\s\S]*?^```[^\n]*(?:\n|$))|(?<inline>`+[^\n]*?`+)|\]\((?<href>[^)]+)\)/gm,
        (
          match,
          _fence: string | undefined,
          _inline: string | undefined,
          href: string | undefined,
        ) => {
          if (!href || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href)) return match;
          const [file, fragment] = href.split('#');
          const original = file ? posix.normalize(posix.join(posix.dirname(path), file)) : path;
          const owner = redirects.get(original + '#' + fragment);
          if (!owner) return match;
          const destination =
            owner.path === path ? '' : posix.relative(posix.dirname(path), owner.path);
          return `](${destination}#${owner.heading})`;
        },
      ),
    );
  }
}

const errorRows = [
  ['400, 422', 'validation', 'ValidationError', 'Fix the input; do not retry unchanged.'],
  ['401, 403', 'authentication', 'AuthenticationError', 'Fix credentials or permissions.'],
  ['404', 'not_found', 'NotFoundError', 'Check the identifier and environment.'],
  ['409, 412', 'conflict', 'ConflictError', 'Read current state and reconcile; 412 never retries.'],
  ['429', 'rate_limit', 'RateLimitError', 'Honor retryAfterMs within the retry budget.'],
  ['500–599', 'server', 'ServerError', 'Retry only when replay-safe; reconcile unknown mutations.'],
  ['Other HTTP errors', 'api', 'ApiError', 'Inspect the provider code and correct the request.'],
  [
    'No HTTP response',
    'transport',
    'ConnectionError',
    'Retry when allowed; reconcile unknown outcomes.',
  ],
  [
    'Attempt timeout',
    'timeout',
    'TimeoutError',
    'Retry only when replay-safe; reconcile unknown outcomes.',
  ],
  ['Overall deadline', 'deadline', 'DeadlineError', 'Reconcile before starting another call.'],
  [
    'Local cancellation',
    'cancelled',
    'CancelledError',
    'Remote work may continue; reconcile its state.',
  ],
  [
    'Invalid response',
    'protocol',
    'ProtocolError',
    'Inspect raw explicitly; do not blindly resubmit.',
  ],
  ['Rejected destination', 'destination', 'DestinationError', 'Fix baseUrl or allowedOrigins.'],
] as const;
export function operationErrors(op: Operation): string {
  const rows = Object.entries(op.responses)
    .filter(([status, response]) => response.classification === 'error' || status === 'default')
    .map(([status]) => {
      if (status === 'default')
        return '| Other error statuses (default) | Status-dependent (see error reference) | Status-dependent |';
      const code = Number(status);
      const row =
        errorRows.find(([statuses]) => statuses.split(', ').includes(status)) ??
        (code >= 500 && code < 600 ? errorRows[5]! : errorRows[6]!);
      return `| ${status} | ${row[2]} | ${row[1]} |`;
    });
  return `#### Errors\n\n${rows.length ? '| Status | Error class | Kind |\n| --- | --- | --- |\n' + rows.join('\n') + '\n\n' : 'No explicit HTTP error responses declared.\n\n'}Other failures: [runtime error reference](RUNTIME.md#error-reference).\n\n`;
}
export function errorReference(target: 'node' | 'php'): string {
  return `## Error reference\n\nEvery class below extends \`SdkError\`. ${target === 'node' ? 'Import subclasses through `errors`.' : 'Subclasses live in the `Errors` namespace.'}\n\n| Status or trigger | Kind | Class | Action |\n| --- | --- | --- | --- |\n${errorRows.map((r) => '| ' + r.join(' | ') + ' |').join('\n')}\n\n| Field | Meaning |\n| --- | --- |\n| ${target === 'node' ? 'code' : 'errorCode'} | Provider or stable local reason; distinct from HTTP status. |\n| details | Structured provider/runtime details when available. |\n| ${target === 'node' ? 'meta.requestId' : "meta['requestId']"} | Server request ID for support and correlation; may be absent. |\n| idempotencyKey | Resolved key; persist it with the action. |\n| retryAfterMs | Valid server Retry-After, in milliseconds. |\n| outcome | not_sent: no dispatch; response: an HTTP response; unknown: remote completion uncertain. |\n| status | HTTP status, or ${target === 'node' ? 'undefined' : 'null'} without a response. |\n| retryAllowed | Whether the failure permits another replay-safe attempt. |\n| raw | Original buffered body for explicit recovery; may contain sensitive data. |\n\nAn unknown outcome requires reconciliation using the original action and saved key before resubmission. An automatic key protects one SDK call only; persist an application key for recovery across calls.\n\n`;
}

type Option = readonly [string, string, string, string];
export function optionsReference(c: Contract, target: 'node' | 'php'): string {
  const node = target === 'node';
  const credential = node
    ? 'string or CredentialProvider'
    : 'string, CredentialProvider or Closure';
  const common: Option[] = [
    ['authMode', 'string', 'operation/client selection', 'Select a declared authentication mode.'],
    [
      'credentials',
      'credential map',
      'none',
      'Client: mode → scheme → credential. Request: scheme → credential.',
    ],
    [
      'timeoutMs',
      node ? 'number' : 'int',
      '10000',
      'Per-attempt timeout, including buffered body reads.',
    ],
    [
      'deadlineMs',
      node ? 'number' : 'int',
      '30000',
      'Overall duration across attempts and waits, not a timestamp.',
    ],
    [
      'maxAttempts',
      node ? 'number' : 'int',
      'operation policy',
      'Total attempts including the first; capped by the operation limit.',
    ],
  ];
  const client: Option[] = [
    [
      'baseUrl',
      'string',
      c.defaultBaseUrl ?? 'required',
      'API environment URL. Set explicitly for sandbox or local tests.',
    ],
    ...(!node || !c.authentication || c.authShortcuts?.token
      ? [
          [
            'token',
            credential,
            'none',
            'Legacy credential, or configured token shortcut only.',
          ] as const,
        ]
      : []),
    [
      'ambientCredentials',
      'boolean',
      'true',
      'Enable configured default credential discovery, when supported.',
    ],
    [
      'allowedOrigins',
      node ? 'string[]' : 'list<string>',
      'base URL origin',
      'Allowlisted canonical destination origins.',
    ],
    ['allowInsecureHttp', 'boolean', 'false', 'Permit HTTP for deliberate local tests.'],
    ...common,
    [
      'transport',
      node ? 'typeof fetch' : 'Closure',
      node ? 'fetch; native HTTP for SSE' : 'cURL',
      'Caller-owned transport; honor cancellation, disable redirects and retries.',
    ],
    [
      'diagnostics',
      node ? '(event: DiagnosticEvent) => void' : 'Closure',
      'none',
      'Per-attempt metadata callback. Exceptions are ignored; no bodies or credentials.',
    ],
    [
      'redactFields',
      node ? 'string[]' : 'list<string>',
      '[]',
      'Additional sensitive field names for SDK inspection.',
    ],
    ...(!node
      ? [
          [
            'credentialCache',
            'object (PSR-16)',
            'null',
            'Optional credential cache for configured discovery; protect as a credential store.',
          ] as const,
        ]
      : []),
  ];
  const request: Option[] = [
    ...common.map(([name, type, , meaning]): Option => [name, type, 'inherit client', meaning]),
    [
      'headers',
      node ? 'Record<string, string>' : 'array<string, string>',
      '{}',
      'Request-local headers; managed credential/version headers remain controlled.',
    ],
    [
      'idempotencyKey',
      'string',
      'operation policy',
      'Saved action key; supported only on declared operations.',
    ],
    ['ifMatch', 'string', 'none', 'Declared conditional request header.'],
    [
      node ? 'signal' : 'cancellation',
      node ? 'AbortSignal' : 'Cancellation',
      'none',
      'Stop local work; remote work may continue.',
    ],
    ['maxPages', node ? 'number' : 'int', '1000', 'Lazy pagination page cap.'],
    ['maxItems', node ? 'number' : 'int', 'unlimited', 'Lazy pagination item cap.'],
    [
      'streamIdleTimeoutMs',
      node ? 'number' : 'int',
      'operation policy or 30000',
      'Maximum idle duration while consuming SSE.',
    ],
    ['streamLifetimeMs', node ? 'number' : 'int', 'unlimited', 'Optional total SSE lifetime.'],
    [
      node ? 'clientRequestId' : 'client_request_id',
      'string',
      'none',
      'Caller correlation: 1–128 visible ASCII characters, no spaces. Forwarded only when the operation declares its request-ID header.',
    ],
  ];
  for (const name of Object.keys(c.authShortcuts ?? {})) {
    if (name !== 'token')
      client.push([
        name,
        credential,
        'none',
        'Configured authentication shortcut; see Authentication.',
      ]);
    request.push([name, credential, 'inherit client', 'Request-local authentication shortcut.']);
  }
  const table = (title: string, rows: Option[]) =>
    `### ${title}\n\n| Field | Type | Default | Meaning |\n| --- | --- | --- | --- |\n${rows.map((r) => '| ' + r.map((s) => s.replaceAll('|', '\\|')).join(' | ') + ' |').join('\n')}\n\n`;
  return table('ClientOptions', client) + table('RequestOptions', request);
}

/** Document PHP class identities from the same plan that emits their getters. */
export function phpModelReference(
  c: Contract,
  plans: readonly import('./target-plan.js').PhpModelPlan[],
  enumLinks?: EnumLinks,
  fieldAliases?: Map<string, string>,
): string {
  const selected = plans.filter(
    (plan) => plan.response || Object.hasOwn(c.models, plan.name.replace(/Input$/, '')),
  );
  const names = new Set(selected.map((plan) => plan.name));
  const modelNames = (response: boolean) =>
    Object.fromEntries(
      Object.keys(c.models).flatMap((name) =>
        response
          ? names.has(name)
            ? [[name, name]]
            : []
          : names.has(name + 'Input')
            ? [[name, name + 'Input']]
            : [],
      ),
    );
  const inputNames = modelNames(false),
    outputNames = {
      ...modelNames(true),
      ...Object.fromEntries(
        selected.filter((model) => model.response).map((model) => [model.name, model.name]),
      ),
    };
  const fragments = new DocumentationFragments();
  for (const plan of selected) {
    const schema =
      plan.documentationSchema ?? c.models[plan.name] ?? c.models[plan.name.replace(/Input$/, '')];
    if (schema) fragments.register(schema, plan.name, plan.response, c.definitions ?? c.models);
  }
  const shapes = new Map<string, string>();
  return (
    `# ${c.title} models\n\n[API reference](REFERENCE.md) · [Runtime guide](RUNTIME.md)\n\nThese classes expose presence-aware getters. Omitted optional response fields return null; has() distinguishes omission from present-null. Input classes omit read-only fields, and responses omit write-only fields. int64/uint64 values use integer strings; decimal fields preserve exact numeric strings.\n\n` +
    modelDocumentationConventions +
    selected
      .map((plan) => {
        const schema =
          plan.documentationSchema ??
          c.models[plan.name] ??
          c.models[plan.name.replace(/Input$/, '')];
        const definitions = c.definitions ?? c.models;
        const names = plan.response ? outputNames : inputNames;
        const context = schema
          ? compileDocumentation(schema, definitions, plan.response)
          : undefined;
        const { model, ...facts } = context?.root ?? {};
        const valueNotes =
          context && Object.keys(factShape(context.root, context.definitions).fields).length
            ? [
                ...new Set(
                  factParts(context.root, context.definitions)
                    .map((part) => {
                      const { description, ...value } = part;
                      return factNotes(value, { literal: schemaLiteral, examples: false });
                    })
                    .filter(Boolean),
                ),
              ].join(' ')
            : '';
        const identity = JSON.stringify([plan.response, facts]);
        const previous = shapes.get(identity);
        if (!previous) shapes.set(identity, plan.name);
        else fieldAliases?.set(plan.name, previous);
        const fieldReferences = new Map<string, Set<string>>();
        const fields =
          schema && !previous
            ? modelFieldReference(
                schema,
                definitions,
                plan.name,
                names,
                enumLinks,
                plan.response,
                true,
                new Set(),
                fragments,
                fieldReferences,
              )
            : '';
        return (
          `## ${plan.name}\n\n${schema ? modelDescriptions(schema, definitions, plan.response) : (plan.description ?? '')}${valueNotes ? '\n\n' + valueNotes : ''}\n\n${plan.response ? 'Response model.' : 'Request input.'}\n\n` +
          (previous
            ? `Fields, types, descriptions and enum values: [${previous}](MODELS.md#${docAnchor(previous)}).\n\n`
            : fields)
        );
      })
      .join('')
  );
}
