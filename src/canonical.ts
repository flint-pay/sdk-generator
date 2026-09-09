export const stable = (value: unknown): string =>
  JSON.stringify(
    value,
    (_k, v: unknown) =>
      v && typeof v === 'object' && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b, 'en')))
        : v,
    2,
  ) + '\n';
