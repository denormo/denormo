import {
  type CompiledConfig,
  createSyncEngine,
  DenormoConfigError,
  DenormoRuntimeError,
  type SyncEngine,
  type SyncEngineOptions,
} from '@denormo/core';
import mongoose, { type Connection } from 'mongoose';
import { type AnyModel, compileConfig } from './compile.js';

/** Engine options (validate, autoIndex, statePrefix, onError, onWarning) plus the Mongoose parts. */
export interface CreateSyncOptions extends Omit<SyncEngineOptions, 'db' | 'config'> {
  /** A connected (or connecting) Mongoose connection. */
  readonly connection: Connection;
  /** Models to compile. Default: every model registered on the connection. */
  readonly models?: readonly AnyModel[];
  /** Only `stream` for now; `inline` arrives with plan 1c. */
  readonly mode?: 'stream';
}

export interface MongooseSync extends SyncEngine {
  /** The compiled config the engine runs. */
  readonly config: CompiledConfig;
}

/** Compiles the connection's Mongoose schemas and returns a sync engine ready to `start()`. */
export async function createSync(options: CreateSyncOptions): Promise<MongooseSync> {
  const { connection, models, mode = 'stream', ...engineOptions } = options;
  if ((mode as string) !== 'stream') {
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
  const engine = await createSyncEngine({ ...engineOptions, db, config });
  return { config, start: () => engine.start(), stop: () => engine.stop() };
}
