// Independent raw-schema publication rule: annotations embedding sensitive,
// write-only or password values are intentionally absent from public docs.
// Reference/composition locations constrain the same value. Align their named
// children before propagating sensitivity down and embedded-value protection up.
export function protectedAnnotations(document) {
  const definitions = document.components?.schemas ?? {},
    nodes = new WeakMap(),
    all = [],
    queue = [];
  const visit = (s) => {
    if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
    if (nodes.has(s)) return nodes.get(s);
    const n = {
      schema: s,
      parent: null,
      children: new Map(),
      sensitive: !!(s['x-sensitive'] || s.writeOnly || s.format === 'password'),
    };
    n.parent = n;
    nodes.set(s, n);
    all.push(n);
    for (const [field, value] of Object.entries(s.properties ?? {}))
      n.children.set('field:' + field, visit(value));
    for (const key of ['items', 'additionalProperties', 'propertyNames', 'contains'])
      if (typeof s[key] === 'object')
        n.children.set(key === 'contains' ? 'items' : key, visit(s[key]));
    for (const key of ['allOf', 'anyOf', 'oneOf'])
      for (const part of s[key] ?? []) queue.push([n, visit(part)]);
    for (const key of ['not', 'if', 'then', 'else']) if (s[key]) queue.push([n, visit(s[key])]);
    if (s.$ref?.startsWith('#/components/schemas/'))
      queue.push([
        n,
        visit(definitions[s.$ref.slice(21).replaceAll('~1', '/').replaceAll('~0', '~')]),
      ]);
    return n;
  };
  for (const s of Object.values(definitions)) visit(s);
  const scan = (value) => {
    if (!value || typeof value !== 'object') return;
    for (const [k, v] of Object.entries(value)) {
      if (k === 'schema') visit(v);
      else if (!['example', 'examples', 'default'].includes(k)) scan(v);
    }
  };
  scan(document.paths);
  scan(document.webhooks);
  const stable = (v) =>
    Array.isArray(v)
      ? v.map(stable)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, stable(v[k])]),
          )
        : v;
  const named = new Map(
    Object.values(definitions).map((s) => [JSON.stringify(stable(s)), nodes.get(s)]),
  );
  for (const n of all) {
    const alias = named.get(JSON.stringify(stable(n.schema)));
    if (alias && alias !== n) queue.push([n, alias]);
  }
  const root = (n) => {
    if (n.parent !== n) n.parent = root(n.parent);
    return n.parent;
  };
  for (let i = 0; i < queue.length; i++) {
    let [a, b] = queue[i];
    if (!a || !b) continue;
    a = root(a);
    b = root(b);
    if (a === b) continue;
    if (a.children.size < b.children.size) [a, b] = [b, a];
    b.parent = a;
    a.sensitive ||= b.sensitive;
    for (const [key, value] of b.children) {
      if (a.children.has(key)) queue.push([a.children.get(key), value]);
      else a.children.set(key, value);
    }
  }
  const groups = [...new Set(all.map(root))],
    protectedValues = new Set(),
    pending = groups.filter((n) => n.sensitive);
  for (let i = 0; i < pending.length; i++) {
    const n = root(pending[i]);
    if (protectedValues.has(n)) continue;
    protectedValues.add(n);
    for (const c of n.children.values()) if (c) pending.push(c);
  }
  const parents = new Map();
  for (const n of groups)
    for (const c of n.children.values())
      if (c) {
        const key = root(c);
        const owners = parents.get(key) ?? [];
        owners.push(n);
        parents.set(key, owners);
      }
  const omitted = new Set(protectedValues),
    up = [...omitted];
  for (let i = 0; i < up.length; i++)
    for (const p of parents.get(up[i]) ?? [])
      if (!omitted.has(p)) {
        omitted.add(p);
        up.push(p);
      }
  return new WeakSet(all.filter((n) => omitted.has(root(n))).map((n) => n.schema));
}
