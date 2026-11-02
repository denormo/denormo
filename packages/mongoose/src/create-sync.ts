import {
  type CompiledConfig,
  createInlineSync,
  createSyncEngine,
  DenormoConfigError,
  DenormoRuntimeError,
  type SyncEngine,
  type SyncEngineOptions,
} from '@denormo/core';
import mongoose, { type Connection } from 'mongoose';
import { type AnyModel, compileConfig } from './compile.js';
import { activateInline, deactivateInline, type InlineHandler } from './inline/registry.js';

const INLINE_BLIND_SPOTS =
  'Inline mode only sees save(), updateOne, findOneAndUpdate, replaceOne and findOneAndReplace on source models. Not synced: updateMany, bulkWrite, deletes, raw driver writes, other services, and copies of copies. Run stream mode or reconcile to cover them.';

/** Engine options (validate, autoIndex, statePrefix, onError, onWarning) plus the Mongoose parts. */
export interface CreateSyncOptions extends Omit<SyncEngineOptions, 'db' | 'config'> {
  /** A connected (or connecting) Mongoose connection. */
  readonly connection: Connection;
  /** Models to compile. Default: every model registered on the connection. */
  readonly models?: readonly AnyModel[];
  /**
   * `stream` (default): a change-stream worker syncs every write. `inline`: hooks update the
   * copies inside the request that wrote the source (Mongoose writes only; see HLD "Sync modes").
   */
  readonly mode?: 'stream' | 'inline';
  /** Inline only: most copies one relation may update inline. Default 1,000. */
  readonly inlineMaxTargets?: number;
}

export interface MongooseSync extends SyncEngine {
  /** The compiled config the engine runs. */
  readonly config: CompiledConfig;
}

/** Compiles the connection's Mongoose schemas and returns a sync engine ready to `start()`. */
export async function createSync(options: CreateSyncOptions): Promise<MongooseSync> {
  const { connection, models, mode = 'stream', inlineMaxTargets, ...engineOptions } = options;
  if ((mode as string) !== 'stream' && (mode as string) !== 'inline') {
    throw new DenormoConfigError(`Sync mode "${mode}" is not supported yet.`, {
      code: 'UNSUPPORTED_MODE',
      problems: [],
    });
  }

  const { ConnectionStates } = mongoose;
  if (connection.readyState === ConnectionStates.connecting) await connection.asPromise();
  const db = connection.readyState === ConnectionStates.disconnected ? undefined : connection.db;
  if (!db) {
    throw new DenormoRuntimeError(
      'The Mongoose connection is not open; connect it before createSync().',
      {
        code: 'NOT_CONNECTED',
      },
    );
  }

  const config = compileConfig(models ?? Object.values(connection.models));

  if (mode === 'inline') {
    const sync = await createInlineSync({
      db,
      config,
      ...(engineOptions.validate ? { validate: engineOptions.validate } : {}),
      ...(inlineMaxTargets === undefined ? {} : { maxTargets: inlineMaxTargets }),
      ...(engineOptions.onWarning ? { onWarning: engineOptions.onWarning } : {}),
    });
    const onError =
      engineOptions.onError ??
      ((error: DenormoRuntimeError) => {
        console.error(error);
      });
    const onWarning =
      engineOptions.onWarning ??
      ((message: string) => {
        console.warn(`[denormo] ${message}`);
      });
    const handler: InlineHandler = { sync, onError };
    return {
      config,
      // Run inside the promise, so a failure (e.g. ALREADY_STARTED) rejects instead of throwing.
      start: () =>
        Promise.resolve().then(() => {
          activateInline(connection, handler);
          onWarning(INLINE_BLIND_SPOTS);
        }),
      stop: () =>
        Promise.resolve().then(() => {
          deactivateInline(connection, handler);
        }),
    };
  }

  const engine = await createSyncEngine({ ...engineOptions, db, config });
  return { config, start: () => engine.start(), stop: () => engine.stop() };
}
