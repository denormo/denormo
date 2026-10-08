import type { Document } from 'mongodb';
import { childPath, joinPath, parseSnapshotPath, type SnapshotLocation } from '../config/paths.js';
import type { ReverseMap } from '../config/reverse-map.js';
import type { CompiledConfig, RelationConfig } from '../config/types.js';
import { DenormoConfigError } from '../errors.js';
import type { NormalizedChangeEvent, PlannedOperation } from './types.js';

/** `arrayFilters` identifier bound to the array element holding the snapshot. */
const ELEMENT = 'elem';

/** Snapshot changes for one relation, keyed by path relative to the snapshot. */
interface SnapshotChanges {
  readonly set: Map<string, unknown>;
  readonly unset: Set<string>;
}

/**
 * Turns one change event into guarded update operations, one per affected relation.
 * Pure: no I/O and no clocks. Assumes `config` passed `validateConfig`.
 */
export function planUpdates(
  config: CompiledConfig,
  reverseMap: ReverseMap,
  event: NormalizedChangeEvent,
): PlannedOperation[] {
  // readRepair relations record versions instead of fanning out (HLD, "Read-repair mode").
  const relations = config.relations.filter(
    (relation) => relation.source === event.source && relation.mode === 'stream',
  );

  if (event.op === 'delete') {
    return relations.flatMap((relation) => planDelete(relation, event));
  }

  const changes = collectChanges(reverseMap, event);
  return relations.flatMap((relation) => {
    const relationChanges = changes.get(relation);
    return relationChanges ? [planSync(relation, event, relationChanges)] : [];
  });
}

/** Maps changed and removed source paths onto the snapshot fields of every relation copying them. */
function collectChanges(
  reverseMap: ReverseMap,
  event: NormalizedChangeEvent,
): Map<RelationConfig, SnapshotChanges> {
  const changes = new Map<RelationConfig, SnapshotChanges>();
  for (const [from, entries] of reverseMap.get(event.source) ?? []) {
    const { set, unset } = sourceFieldChanges(from, event);
    if (set.length === 0 && unset.length === 0) continue;

    for (const { relation, field } of entries) {
      let relationChanges = changes.get(relation);
      if (!relationChanges) {
        relationChanges = { set: new Map(), unset: new Set() };
        changes.set(relation, relationChanges);
      }
      for (const [rest, value] of set) relationChanges.set.set(joinPath(field.to, rest), value);
      for (const rest of unset) relationChanges.unset.add(joinPath(field.to, rest));
    }
  }
  return changes;
}

/**
 * How one synced source field changed, as paths relative to that field ('' is the field itself).
 * Event paths may be the field, a parent of it (`profile` for `profile.city`) or inside it
 * (`address.zip` for `address`).
 */
function sourceFieldChanges(from: string, event: NormalizedChangeEvent) {
  const set: [string, unknown][] = [];
  const unset: string[] = [];

  for (const [path, value] of Object.entries(event.changed)) {
    const within = childPath(path, from);
    if (within !== null) {
      const found = lookup(value, within);
      if (found.exists) set.push(['', found.value]);
      else unset.push('');
      continue;
    }
    const below = childPath(from, path);
    if (below) set.push([below, value]);
  }

  for (const path of event.removed) {
    if (childPath(path, from) !== null) {
      unset.push('');
      continue;
    }
    const below = childPath(from, path);
    if (below) unset.push(below);
  }

  return { set, unset };
}

function lookup(
  value: unknown,
  path: string,
): { exists: true; value: unknown } | { exists: false } {
  let current = value;
  for (const segment of path === '' ? [] : path.split('.')) {
    if (typeof current !== 'object' || current === null || !Object.hasOwn(current, segment)) {
      return { exists: false };
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return { exists: true, value: current };
}

function planSync(
  relation: RelationConfig,
  event: NormalizedChangeEvent,
  changes: SnapshotChanges,
): PlannedOperation {
  const scope = snapshotScope(relation);
  const sets: [string, unknown][] = [
    ...[...changes.set].map(([path, value]): [string, unknown] => [scope.updatePath(path), value]),
    [scope.updatePath('_v'), event.version],
  ];
  const update: Document = { $set: Object.fromEntries(sets) };
  if (changes.unset.size > 0) {
    update.$unset = Object.fromEntries(
      [...changes.unset].map((path) => [scope.updatePath(path), '']),
    );
  }

  return {
    relationId: relation.id,
    collection: relation.target,
    ...scope.match(guard(event)),
    update,
  };
}

function planDelete(relation: RelationConfig, event: NormalizedChangeEvent): PlannedOperation[] {
  const scope = snapshotScope(relation);
  const operation = { relationId: relation.id, collection: relation.target };

  switch (relation.onDelete) {
    case 'markDeleted':
      return [
        {
          ...operation,
          ...scope.match(guard(event)),
          update: {
            $set: { [scope.updatePath('deleted')]: true, [scope.updatePath('_v')]: event.version },
          },
        },
      ];
    case 'unset': {
      const { location } = scope;
      if (location.arrayField !== null && location.inner === '') {
        // Each element is a snapshot: unsetting it would leave null in the array, so pull it.
        const conditions = guard(event);
        return [
          {
            ...operation,
            filter: { [location.arrayField]: { $elemMatch: conditions } },
            update: { $pull: { [location.arrayField]: conditions } },
          },
        ];
      }
      return [
        {
          ...operation,
          ...scope.match(guard(event)),
          update: { $unset: { [scope.updatePath('')]: '' } },
        },
      ];
    }
    case 'keep':
      return [];
  }
}

/**
 * Version guard, with keys relative to the snapshot: match snapshots older than this event.
 * `$not: { $gte }` rather than `$lt` so a snapshot with no `_v` (written by the app or any other
 * client) counts as older than every event; `$lt` never matches a missing field.
 * There are deliberately no value conditions: a snapshot that already holds the new values must
 * still get the newer `_v`, or a late older event could overwrite it later. Loops are prevented
 * by rejecting cascade cycles in validation.
 */
function guard(event: NormalizedChangeEvent): Document {
  return { _id: event.srcId, _v: { $not: { $gte: event.version } } };
}

/** Renders snapshot-relative paths and conditions for a relation's flat or array location. */
function snapshotScope(relation: RelationConfig) {
  const location: SnapshotLocation | null = parseSnapshotPath(relation.path, relation.array);
  if (!location) {
    throw new DenormoConfigError(
      `Relation "${relation.id}" has an invalid path "${relation.path}"; validate the config first.`,
      { code: 'INVALID_PATH', relationId: relation.id, problems: [] },
    );
  }
  const { arrayField, inner } = location;

  return {
    location,
    updatePath(path: string): string {
      return arrayField === null
        ? joinPath(inner, path)
        : joinPath(arrayField, `$[${ELEMENT}]`, inner, path);
    },
    match(conditions: Document): Pick<PlannedOperation, 'filter' | 'arrayFilters'> {
      if (arrayField === null) return { filter: prefixKeys(conditions, inner) };
      return {
        filter: { [arrayField]: { $elemMatch: prefixKeys(conditions, inner) } },
        arrayFilters: [prefixKeys(conditions, joinPath(ELEMENT, inner))],
      };
    },
  };
}

/** Prefixes every field path in a condition document. */
function prefixKeys(conditions: Document, prefix: string): Document {
  return Object.fromEntries(
    Object.entries(conditions).map(([key, value]) => [joinPath(prefix, key), value]),
  );
}
