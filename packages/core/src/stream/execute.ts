import type { ClientSession, Db } from 'mongodb';
import type { PlannedOperation } from '../planner/types.js';

export interface ExecuteOptions {
  /** Run the writes in this session (and its transaction, if one is active). */
  readonly session?: ClientSession;
}

/**
 * Runs planned operations in order, one `updateMany` each. Outside a transaction they use
 * majority write concern; inside one MongoDB rejects a per-operation write concern, so none is set.
 */
export async function executeOperations(
  db: Db,
  operations: readonly PlannedOperation[],
  options: ExecuteOptions = {},
): Promise<void> {
  const { session } = options;
  const inTransaction = session?.inTransaction() ?? false;
  for (const operation of operations) {
    await db.collection(operation.collection).updateMany(operation.filter, operation.update, {
      ...(operation.arrayFilters ? { arrayFilters: [...operation.arrayFilters] } : {}),
      ...(session ? { session } : {}),
      ...(inTransaction ? {} : { writeConcern: { w: 'majority' } }),
    });
  }
}
