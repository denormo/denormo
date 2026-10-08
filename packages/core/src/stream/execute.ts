import type { Db } from 'mongodb';
import type { PlannedOperation } from '../planner/types.js';

/**
 * Runs planned operations in order, one `updateMany` each, with majority write concern.
 * Phase 1 runs every operation as a single small job; batching arrives in Phase 2.
 */
export async function executeOperations(
  db: Db,
  operations: readonly PlannedOperation[],
): Promise<void> {
  for (const operation of operations) {
    await db.collection(operation.collection).updateMany(operation.filter, operation.update, {
      ...(operation.arrayFilters ? { arrayFilters: [...operation.arrayFilters] } : {}),
      writeConcern: { w: 'majority' },
    });
  }
}
