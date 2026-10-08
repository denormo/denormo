import { randomUUID } from 'node:crypto';
import { type Db, MongoClient, type ObjectId, type ResumeToken, type Timestamp } from 'mongodb';
import { afterAll, beforeAll, inject } from 'vitest';

/** Document shapes used by the integration tests (typed so strict lint rules see no `any`). */
export interface SnapshotDoc {
  _id: ObjectId;
  name?: string;
  photo?: string;
  avatar?: string;
  role?: string;
  deleted?: boolean;
  _v?: Timestamp;
}
export interface PostDoc {
  _id: string;
  createdBy?: SnapshotDoc;
  comments?: { _id: string; author: SnapshotDoc }[];
  likedBy?: SnapshotDoc[];
}
export interface UserDoc {
  _id: ObjectId;
  name?: string;
  avatar?: string;
  role?: string;
  lastLoginAt?: number;
}
export interface CursorDoc {
  _id: string;
  resumeToken?: ResumeToken;
}

export interface TestDatabase {
  client: MongoClient;
  db: Db;
}

/** Connects once per test file to a fresh database, dropped after the file's tests. */
export function useDatabase(): TestDatabase {
  const state = {} as TestDatabase;
  beforeAll(async () => {
    state.client = await MongoClient.connect(inject('mongoUri'));
    state.db = state.client.db(`denormo_${randomUUID().slice(0, 8)}`);
  });
  afterAll(async () => {
    await state.db.dropDatabase();
    await state.client.close();
  });
  return state;
}

/** Polls `check` until it returns true; fails after `timeoutMs`. */
export async function waitFor(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Condition not met within ${String(timeoutMs)} ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

declare module 'vitest' {
  export interface ProvidedContext {
    mongoUri: string;
  }
}
