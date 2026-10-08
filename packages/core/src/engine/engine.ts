import { type ChangeStream, type Db, type Document, Timestamp } from 'mongodb';
import { buildReverseMap } from '../config/reverse-map.js';
import type { CompiledConfig } from '../config/types.js';
import { assertValidConfig, type ValidateOptions } from '../config/validate.js';
import { DenormoRuntimeError } from '../errors.js';
import { planUpdates } from '../planner/plan.js';
import { createCursorStore, type StreamPosition } from '../state/cursors.js';
import { executeOperations } from '../stream/execute.js';
import { normalizeChangeEvent } from '../stream/normalize.js';
import { assertReplicaSet, ensureSnapshotIndexes } from './preflight.js';

export const DEFAULT_STATE_PREFIX = '_denormo_';

/** How often a quiet source saves its position (wall clock is used only for this throttle). */
const QUIET_SAVE_INTERVAL_MS = 10_000;

/** Deletes are wired in Phase 4; inserts never affect existing snapshots. */
const PIPELINE: Document[] = [{ $match: { operationType: { $in: ['update', 'replace'] } } }];

export interface SyncEngineOptions {
  readonly db: Db;
  /** The compiled config; validated before anything starts. */
  readonly config: CompiledConfig;
  readonly validate?: ValidateOptions;
  /** Prefix of the engine's own collections. Default `_denormo_`. */
  readonly statePrefix?: string;
  /** Create missing `<path>._id` indexes instead of warning. Default false. */
  readonly autoIndex?: boolean;
  /** A source's stream stopped (it resumes on the next `start()`). Default: `console.error`. */
  readonly onError?: (error: DenormoRuntimeError) => void;
  /** Non-fatal startup findings, such as missing indexes. Default: `console.warn`. */
  readonly onWarning?: (message: string) => void;
}

export interface SyncEngine {
  /**
   * Opens a change stream for every source that is not running: all of them on first start, or
   * the ones that stopped after an error. Rejects with `ALREADY_STARTED` when all are running.
   */
  start(): Promise<void>;
  /** Closes the streams after the event in flight (if any) is done. */
  stop(): Promise<void>;
}

interface RunningSource {
  readonly stream: ChangeStream;
  readonly done: Promise<void>;
}

/** Validates config and deployment, then returns an engine ready to `start()`. */
export async function createSyncEngine(options: SyncEngineOptions): Promise<SyncEngine> {
  const { db, config } = options;
  const onError =
    options.onError ??
    ((error: DenormoRuntimeError) => {
      console.error(error);
    });
  const onWarning =
    options.onWarning ??
    ((message: string) => {
      console.warn(`[denormo] ${message}`);
    });

  assertValidConfig(config, options.validate);
  await assertReplicaSet(db);
  await ensureSnapshotIndexes(db, config, { autoIndex: options.autoIndex ?? false, onWarning });

  const reverseMap = buildReverseMap(config);
  const cursors = createCursorStore(db, options.statePrefix ?? DEFAULT_STATE_PREFIX);
  const sources = [
    ...new Set(config.relations.filter((r) => r.mode === 'stream').map((r) => r.source)),
  ];
  const running = new Map<string, RunningSource>();
  let stopping = false;
  // start() and stop() run one at a time, in call order.
  let lifecycle: Promise<unknown> = Promise.resolve();
  function serialized(task: () => Promise<void>): Promise<void> {
    const result = lifecycle.then(task, task);
    lifecycle = result.catch(() => undefined);
    return result;
  }

  async function streamPosition(source: string): Promise<StreamPosition> {
    const stored = await cursors.load(source);
    if (stored) return stored;
    // First start: begin just after "now" (startAtOperationTime is inclusive, and "now" is the
    // last write's time), and save that point at once so a restart before any event resumes here.
    const fresh = { startAtOperationTime: nextTimestamp(await currentClusterTime(db)) };
    await cursors.save(source, fresh);
    return fresh;
  }

  async function consume(source: string, stream: ChangeStream): Promise<void> {
    const syncedFields = [...(reverseMap.get(source)?.keys() ?? [])];
    let lastQuietSave = Number.NEGATIVE_INFINITY;
    try {
      for (;;) {
        const change = await stream.tryNext();
        if (change) {
          const event = normalizeChangeEvent(change, syncedFields);
          if (event) await executeOperations(db, planUpdates(config, reverseMap, event));
          // Only after the writes: a crash before this line replays the event, harmlessly.
          await cursors.save(source, { resumeAfter: stream.resumeToken });
          continue;
        }
        if (stream.closed) return;
        // Quiet source: keep the stored position fresh so it never ages out of the oplog.
        if (Date.now() - lastQuietSave >= QUIET_SAVE_INTERVAL_MS) {
          await cursors.save(source, { resumeAfter: stream.resumeToken });
          lastQuietSave = Date.now();
        }
      }
    } catch (error) {
      if (stopping) return;
      running.delete(source);
      onError(
        new DenormoRuntimeError(`Sync for source "${source}" stopped: ${errorMessage(error)}`, {
          code: 'SOURCE_STOPPED',
          source,
          cause: error,
        }),
      );
      await stream.close().catch(() => undefined);
    }
  }

  async function close(names: readonly string[]): Promise<void> {
    const closing = names.flatMap((name) => {
      const source = running.get(name);
      running.delete(name);
      return source ? [source] : [];
    });
    stopping = true;
    try {
      await Promise.allSettled(closing.map(({ stream }) => stream.close()));
      await Promise.allSettled(closing.map(({ done }) => done));
    } finally {
      stopping = false;
    }
  }

  return {
    start: () =>
      serialized(async () => {
        const stopped = sources.filter((source) => !running.has(source));
        if (sources.length > 0 && stopped.length === 0) {
          throw new DenormoRuntimeError('The sync engine is already running.', {
            code: 'ALREADY_STARTED',
          });
        }
        const opened: string[] = [];
        try {
          for (const source of stopped) {
            const stream = db.collection(source).watch(PIPELINE, {
              fullDocument: 'updateLookup',
              ...(await streamPosition(source)),
            });
            running.set(source, { stream, done: consume(source, stream) });
            opened.push(source);
          }
        } catch (error) {
          await close(opened);
          throw error;
        }
      }),
    stop: () => serialized(() => close([...running.keys()])),
  };
}

async function currentClusterTime(db: Db): Promise<Timestamp> {
  const reply = await db.admin().command({ ping: 1 });
  const operationTime = reply.operationTime as Timestamp | undefined;
  if (!operationTime) {
    throw new DenormoRuntimeError('The server did not report an operationTime.', {
      code: 'NO_OPERATION_TIME',
    });
  }
  return operationTime;
}

/** The smallest cluster time after `time`. */
function nextTimestamp(time: Timestamp): Timestamp {
  const MAX_INCREMENT = 0xffff_ffff;
  const { t, i } = time;
  return i < MAX_INCREMENT ? new Timestamp({ t, i: i + 1 }) : new Timestamp({ t: t + 1, i: 0 });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
