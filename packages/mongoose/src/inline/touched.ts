/** `$`, `$[]` or `$[identifier]`. */
const POSITIONAL = /^\$(\[[^\]]*\])?$/;

/**
 * Field paths an update document writes, or `'all'` for an aggregation pipeline. Operator
 * arguments count by key (`$rename` by both names); top-level keys without `$` count as fields;
 * paths are cut at their first positional segment (`comments.$.text` → `comments`).
 */
export function touchedPaths(update: unknown): readonly string[] | 'all' {
  if (Array.isArray(update)) return 'all';
  if (typeof update !== 'object' || update === null) return [];
  const paths: string[] = [];
  for (const [key, argument] of Object.entries(update as Record<string, unknown>)) {
    if (!key.startsWith('$')) {
      paths.push(key);
      continue;
    }
    if (typeof argument !== 'object' || argument === null) continue;
    for (const [path, value] of Object.entries(argument as Record<string, unknown>)) {
      paths.push(path);
      if (key === '$rename' && typeof value === 'string') paths.push(value);
    }
  }
  return paths.map(withoutPositional);
}

/** Synced source fields a write touching `touched` may have changed. */
export function affectedFields(
  touched: readonly string[] | 'all',
  synced: readonly string[],
): string[] {
  if (touched === 'all') return [...synced];
  return synced.filter((field) => touched.some((path) => overlaps(path, field)));
}

function withoutPositional(path: string): string {
  const segments = path.split('.');
  const index = segments.findIndex((segment) => POSITIONAL.test(segment));
  return index === -1 ? path : segments.slice(0, index).join('.');
}

function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);
}
