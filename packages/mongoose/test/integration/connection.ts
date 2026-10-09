import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { afterAll, beforeAll, inject } from 'vitest';

export interface TestConnection {
  connection: mongoose.Connection;
}

/** One Mongoose connection per test file, to a fresh database dropped afterwards. */
export function useConnection(): TestConnection {
  const state = {} as TestConnection;
  beforeAll(async () => {
    state.connection = await mongoose
      .createConnection(inject('mongoUri'), { dbName: `denormo_${randomUUID().slice(0, 8)}` })
      .asPromise();
  });
  afterAll(async () => {
    await state.connection.dropDatabase();
    await state.connection.close();
  });
  return state;
}

declare module 'vitest' {
  export interface ProvidedContext {
    mongoUri: string;
  }
}
