/** Reads a dot-notation path; `exists: false` when any segment is missing. */
export function readPath(value: unknown, path: string): { exists: boolean; value?: unknown } {
  let current = value;
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null || !(segment in current)) {
      return { exists: false };
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return { exists: true, value: current };
}

/** Writes a dot-notation path, creating intermediate objects. */
export function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.');
  const last = segments.pop() ?? path;
  let current = target;
  for (const segment of segments) {
    const next = current[segment];
    if (typeof next !== 'object' || next === null) current[segment] = {};
    current = current[segment] as Record<string, unknown>;
  }
  current[last] = value;
}
