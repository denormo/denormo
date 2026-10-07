import type { Document, Timestamp } from 'mongodb';

export type ChangeOperation = 'update' | 'replace' | 'delete';

/**
 * Driver-agnostic change event the planner consumes. The stream runner (change streams) and inline
 * hooks each map their own events into this shape.
 */
export interface NormalizedChangeEvent {
  readonly op: ChangeOperation;
  /** Source collection name. */
  readonly source: string;
  /** `_id` of the changed source document. */
  readonly srcId: unknown;
  /** Cluster time of the write: change-event `clusterTime` or `session.operationTime`. */
  readonly version: Timestamp;
  /**
   * New values keyed by dot-notation path: `updateDescription.updatedFields` for updates, the
   * replacement document's fields for replaces. Ignored for deletes.
   */
  readonly changed: Readonly<Record<string, unknown>>;
  /** Removed dot-notation paths (`updateDescription.removedFields`). Ignored for deletes. */
  readonly removed: readonly string[];
}

/** One guarded `updateMany` against a target collection. */
export interface PlannedOperation {
  readonly relationId: string;
  /** Target collection name. */
  readonly collection: string;
  readonly filter: Document;
  readonly update: Document;
  /** Present for array relations; the snapshot element is bound to the `elem` identifier. */
  readonly arrayFilters?: readonly Document[];
}
