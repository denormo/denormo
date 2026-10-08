import type { ChangeStreamDocument } from 'mongodb';
import { childPath, getPath, pathsOverlap } from '../config/paths.js';
import { DenormoRuntimeError } from '../errors.js';
import type { NormalizedChangeEvent } from '../planner/types.js';

/**
 * Maps a driver change event to the planner's event shape, or returns `null` for events the
 * runner does not sync in Phase 1 (inserts, deletes, and anything other than update/replace).
 *
 * @param syncedFields the source's synced field paths (its reverse-map keys); a replace that drops
 *   one of them reports it as removed, so the copies are unset rather than left stale.
 */
export function normalizeChangeEvent(
  change: ChangeStreamDocument,
  syncedFields: readonly string[],
): NormalizedChangeEvent | null {
  if (change.operationType !== 'update' && change.operationType !== 'replace') return null;

  const source = change.ns.coll;
  const version = change.clusterTime;
  if (!version) {
    throw new DenormoRuntimeError(`Change event on "${source}" has no clusterTime.`, {
      code: 'MISSING_CLUSTER_TIME',
      source,
    });
  }
  const base = { source, srcId: change.documentKey._id as unknown, version };

  if (change.operationType === 'replace') {
    const document = change.fullDocument;
    return {
      ...base,
      op: 'replace',
      changed: { ...document },
      removed: syncedFields.filter((field) => !getPath(document, field).exists),
    };
  }

  const { updatedFields = {}, removedFields = [], truncatedArrays = [] } = change.updateDescription;
  // Synced fields to copy whole from the current document instead of path by path.
  const wholeFields = new Set<string>();
  for (const { field } of truncatedArrays) {
    if (syncedFields.some((synced) => pathsOverlap(synced, field))) wholeFields.add(field);
  }
  // An index path under a synced field ($push, `$set: { 'tags.3': … }`) would write by position
  // into the copy, which may be shorter or missing the array; copy the whole field instead.
  for (const path of Object.keys(updatedFields)) {
    const field = syncedFields.find((synced) => hasIndexSegment(childPath(synced, path)));
    if (field !== undefined) wholeFields.add(field);
  }

  let changed: Record<string, unknown> = { ...updatedFields };
  for (const field of wholeFields) {
    // The whole value replaces any updates inside it, which would otherwise conflict.
    changed = Object.fromEntries(
      Object.entries(changed).filter(([path]) => !childPath(field, path)),
    );
    const found = getPath(change.fullDocument, field);
    if (found.exists) changed[field] = found.value;
  }
  return { ...base, op: 'update', changed, removed: [...removedFields] };
}

/** True when a relative path has an array index segment, e.g. `3` or `lines.2`. */
function hasIndexSegment(path: string | null): boolean {
  return path !== null && path !== '' && path.split('.').some((segment) => /^\d+$/.test(segment));
}
