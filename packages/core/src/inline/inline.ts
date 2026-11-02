import type { ClientSession, Db } from 'mongodb';
import { buildReverseMap } from '../config/reverse-map.js';
import type { CompiledConfig } from '../config/types.js';
import { assertValidConfig, type ValidateOptions } from '../config/validate.js';
import { assertReplicaSet } from '../engine/preflight.js';
import { planUpdates } from '../planner/plan.js';
import type { NormalizedChangeEvent } from '../planner/types.js';
import { executeOperations } from '../stream/execute.js';

export const DEFAULT_INLINE_MAX_TARGETS = 1000;

export interface InlineSyncOptions {
  readonly db: Db;
  readonly config: CompiledConfig;
  readonly validate?: ValidateOptions;
  /** Most copies one relation may update inline; above it the relation is skipped. Default 1,000. */
  readonly maxTargets?: number;
  /** A relation was skipped. Default: `console.warn`. */
  readonly onWarning?: (message: string) => void;
}

export interface InlineApplyResult {
  /** Relation ids whose copies were updated. */
  readonly applied: readonly string[];
  /** Relation ids skipped because they had more copies than `maxTargets`. */
  readonly skipped: readonly string[];
}

export interface InlineSync {
  /** Synced field paths of a source collection. */
  syncedFields(source: string): readonly string[];
  /** Plans and writes the copies for one source change, in `session` when given. */
  apply(
    event: NormalizedChangeEvent,
    options?: { readonly session?: ClientSession },
  ): Promise<InlineApplyResult>;
}

/**
 * Applies source changes to their copies immediately (inline mode), with the same planner and
 * version guard as the stream engine. Validates the config and requires a replica set (inline
 * versions come from the cluster time, which standalone servers do not report).
 */
export async function createInlineSync(options: InlineSyncOptions): Promise<InlineSync> {
  const { db, config } = options;
  assertValidConfig(config, options.validate);
  await assertReplicaSet(db);

  const reverseMap = buildReverseMap(config);
  const maxTargets = options.maxTargets ?? DEFAULT_INLINE_MAX_TARGETS;
  const onWarning =
    options.onWarning ??
    ((message: string) => {
      console.warn(`[denormo] ${message}`);
    });

  return {
    syncedFields: (source) => [...(reverseMap.get(source)?.keys() ?? [])],
    async apply(event, { session } = {}) {
      const applied: string[] = [];
      const skipped: string[] = [];
      for (const operation of planUpdates(config, reverseMap, event)) {
        const copies = await db.collection(operation.collection).countDocuments(operation.filter, {
          limit: maxTargets + 1,
          ...(session ? { session } : {}),
        });
        if (copies > maxTargets) {
          skipped.push(operation.relationId);
          onWarning(
            `Relation "${operation.relationId}": more than ${String(maxTargets)} copies to update for ${String(event.srcId)}; skipped inline. Stream mode or reconcile will sync them.`,
          );
          continue;
        }
        await executeOperations(db, [operation], session ? { session } : {});
        applied.push(operation.relationId);
      }
      return { applied, skipped };
    },
  };
}
