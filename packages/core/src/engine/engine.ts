import { type ChangeStream, type Db, type Document, Timestamp } from 'mongodb';
import { buildReverseMap } from '../config/reverse-map.js';
import type { CompiledConfig } from '../config/types.js';
import { assertValidConfig, type ValidateOptions } from '../config/validate.js';
import { DenormoRuntimeError } from '../errors.js';
import { planUpdates } from '../planner/plan.js';
import { createCursorStore } from '../state/cursors.js';
import { executeOperations } from '../stream/execute.js';
import { normalizeChangeEvent } from '../stream/normalize.js';
import { assertReplicaSet, ensureSnapshotIndexes } from './preflight.js';

export const DEFAULT_STATE_PREFIX = '_denormo_';

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
  /** Opens one change stream per source; resolves once they are positioned. */
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

  async function openStream(source: string): Promise<ChangeStream> {
    const resumeToken = await cursors.load(source);
    // Without a token, pin the start to "now" so writes after start() are never missed.
    // startAtOperationTime is inclusive and "now" is the last write's time, so start just after it.
    const position =
      resumeToken === undefined
        ? { startAtOperationTime: nextTimestamp(await currentClusterTime(db)) }
        : { resumeAfter: resumeToken };
    return db.collection(source).watch(PIPELINE, { fullDocument: 'updateLookup', ...position });
  }

  async function consume(source: string, stream: ChangeStream): Promise<void> {
    const syncedFields = [...(reverseMap.get(source)?.keys() ?? [])];
    try {
      for await (const change of stream) {
        const event = normalizeChangeEvent(change, syncedFields);
        if (event) await executeOperations(db, planUpdates(config, reverseMap, event));
        // Only after the writes: a crash before this line replays the event, harmlessly.
        await cursors.save(source, stream.resumeToken);
      }
    } catch (error) {
      if (stopping) return;
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

  return {
    async start() {
      if (running.size > 0) {
        throw new DenormoRuntimeError('The sync engine is already running.', {
          code: 'ALREADY_STARTED',
        });
      }
      stopping = false;
      for (const source of sources) {
        const stream = await openStream(source);
        running.set(source, { stream, done: consume(source, stream) });
      }
    },
    async stop() {
      stopping = true;
      const stopped = [...running.values()];
      running.clear();
      await Promise.all(stopped.map(({ stream }) => stream.close()));
      await Promise.all(stopped.map(({ done }) => done));
    },
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
