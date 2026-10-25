/** Template edits must not silently disable generated runtime wiring. */
export function substituteTemplate(
  source: string,
  name: string,
  replacements: ReadonlyArray<readonly [string, string]>,
): string {
  for (const [marker, value] of replacements) {
    const count = source.split(marker).length - 1;
    if (count !== 1)
      throw new Error(
        `Template ${name}: expected exactly one ${JSON.stringify(marker)}, found ${count}`,
      );
    source = source.replace(marker, () => value);
  }
  return source;
}
