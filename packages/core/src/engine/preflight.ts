import { type Db, type IndexDescriptionInfo, MongoServerError } from 'mongodb';
import { stripArrayMarker } from '../config/paths.js';
import type { CompiledConfig, RelationConfig } from '../config/types.js';
import { DenormoRuntimeError } from '../errors.js';

/** MongoDB error code for a collection that does not exist. */
const NAMESPACE_NOT_FOUND = 26;

/** Change streams need a replica set or a sharded cluster. */
export async function assertReplicaSet(db: Db): Promise<void> {
  const hello = await db.admin().command({ hello: 1 });
  if (typeof hello.setName === 'string' || hello.msg === 'isdbgrid') return;
  throw new DenormoRuntimeError(
    'denormo needs a replica set or sharded cluster (change streams); this server is standalone.',
    { code: 'NOT_REPLICA_SET' },
  );
}

/** The index every sync update filters on: `<path>._id` with the array marker removed. */
export function snapshotIdIndexKey(relation: RelationConfig): string {
  return `${stripArrayMarker(relation.path)}._id`;
}

export interface SnapshotIndexOptions {
  readonly autoIndex: boolean;
  readonly onWarning: (message: string) => void;
}

/** Warns about (or, with `autoIndex`, creates) a missing `<path>._id` index per relation. */
export async function ensureSnapshotIndexes(
  db: Db,
  config: CompiledConfig,
  options: SnapshotIndexOptions,
): Promise<void> {
  const checked = new Set<string>();
  for (const relation of config.relations) {
    const key = snapshotIdIndexKey(relation);
    if (checked.has(`${relation.target}\0${key}`)) continue;
    checked.add(`${relation.target}\0${key}`);

    const indexes = await listIndexes(db, relation.target);
    if (indexes.some((index) => Object.keys(index.key)[0] === key)) continue;

    if (options.autoIndex) {
      await db.collection(relation.target).createIndex({ [key]: 1 });
    } else {
      options.onWarning(
        `Relation "${relation.id}": no index on ${relation.target}.${key}, so sync updates scan the collection. Create it, or pass autoIndex: true.`,
      );
    }
  }
}

async function listIndexes(db: Db, collection: string): Promise<IndexDescriptionInfo[]> {
  try {
    return await db.collection(collection).indexes();
  } catch (error) {
    if (error instanceof MongoServerError && error.code === NAMESPACE_NOT_FOUND) return [];
    throw error;
  }
}
