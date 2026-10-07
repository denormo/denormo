/** Where a relation's snapshot lives in a target document. */
export interface SnapshotLocation {
  /** Path of the array holding the snapshots, or `null` for a flat relation. */
  readonly arrayField: string | null;
  /** Path of the snapshot: from the document root (flat) or from each element (array; may be ''). */
  readonly inner: string;
}

const ARRAY_MARKER = '[]';

/** A plain dot-notation path: non-empty segments, none `$`-prefixed or containing brackets. */
export function isPlainPath(path: string): boolean {
  return path.split('.').every(isPlainSegment);
}

function isPlainSegment(segment: string): boolean {
  return segment.length > 0 && !segment.startsWith('$') && !/[[\]]/.test(segment);
}

/** Parses a relation `path`, or returns `null` if it is malformed for the given `array` flag. */
export function parseSnapshotPath(path: string, array: boolean): SnapshotLocation | null {
  if (!array) return isPlainPath(path) ? { arrayField: null, inner: path } : null;

  const segments = path.split('.');
  const index = segments.findIndex((segment) => segment.endsWith(ARRAY_MARKER));
  const marked = segments[index];
  if (marked === undefined) return null;

  const arraySegments = [...segments.slice(0, index), marked.slice(0, -ARRAY_MARKER.length)];
  const innerSegments = segments.slice(index + 1);
  if (![...arraySegments, ...innerSegments].every(isPlainSegment)) return null;

  return { arrayField: arraySegments.join('.'), inner: innerSegments.join('.') };
}

/** `path` with the `[]` array marker removed, as a plain dot-notation path. */
export function stripArrayMarker(path: string): string {
  return path.replace(ARRAY_MARKER, '');
}

/** True when one path equals the other or contains it. */
export function pathsOverlap(a: string, b: string): boolean {
  return childPath(a, b) !== null || childPath(b, a) !== null;
}

/** The part of `path` below `ancestor` ('' when equal), or `null` if `path` is not inside it. */
export function childPath(ancestor: string, path: string): string | null {
  if (path === ancestor) return '';
  return path.startsWith(`${ancestor}.`) ? path.slice(ancestor.length + 1) : null;
}

/** Joins non-empty dot-notation parts. */
export function joinPath(...parts: string[]): string {
  return parts.filter((part) => part.length > 0).join('.');
}
