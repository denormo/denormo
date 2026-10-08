import { ObjectId, Timestamp } from 'mongodb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DenormoConfigError, DenormoRuntimeError } from '../../src/errors.js';
import {
  createSyncEngine,
  type SyncEngine,
  type SyncEngineOptions,
} from '../../src/engine/engine.js';
import { relation, usersPostsConfig } from '../fixtures.js';
import { type CursorDoc, type PostDoc, type UserDoc, useDatabase, waitFor } from './mongo.js';

const ctx = useDatabase();
const ada = new ObjectId();
const bob = new ObjectId();
const engines: SyncEngine[] = [];

const users = () => ctx.db.collection<UserDoc>('users');
const posts = () => ctx.db.collection<PostDoc>('posts');
const cursors = () => ctx.db.collection<CursorDoc>('_denormo_cursors');

async function startEngine(options: Partial<SyncEngineOptions> = {}) {
  const errors: DenormoRuntimeError[] = [];
  const engine = await createSyncEngine({
    db: ctx.db,
    config: usersPostsConfig(),
    onError: (error) => errors.push(error),
    onWarning: () => undefined,
    ...options,
  });
  engines.push(engine);
  await engine.start();
  return { engine, errors };
}

async function postSnapshot() {
  return (await posts().findOne({ _id: 'p1' }))?.createdBy;
}

/** Resolves once the engine has saved a resume token newer than `previous`. */
async function tokenAdvancedFrom(previous: unknown) {
  await waitFor(async () => {
    const cursor = await cursors().findOne({ _id: 'users' });
    const token = cursor?.resumeToken;
    return token !== undefined && JSON.stringify(token) !== JSON.stringify(previous);
  });
}

async function currentToken(): Promise<unknown> {
  return (await cursors().findOne({ _id: 'users' }))?.resumeToken;
}

/** Waits for the engine's first saved resume token (it saves one while the source is quiet). */
async function firstSavedToken(): Promise<unknown> {
  await waitFor(async () => (await currentToken()) !== undefined);
  return currentToken();
}

async function forbidName(name: string) {
  await ctx.db.command({
    collMod: 'posts',
    validator: { 'createdBy.name': { $ne: name } },
    validationAction: 'error',
  });
}

async function allowAllNames() {
  await ctx.db.command({ collMod: 'posts', validator: {}, validationLevel: 'off' });
}

beforeEach(async () => {
  await users().insertOne({
    _id: ada,
    name: 'Ada',
    avatar: 'a.png',
    role: 'admin',
    lastLoginAt: 0,
  });
  await posts().insertOne({
    _id: 'p1',
    createdBy: { _id: ada, name: 'Ada', photo: 'a.png', role: 'admin' },
    comments: [
      { _id: 'c1', author: { _id: ada, name: 'Ada', avatar: 'a.png' } },
      { _id: 'c2', author: { _id: bob, name: 'Bob' } },
    ],
  });
});

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.stop()));
  await ctx.db.dropDatabase();
});

describe('createSyncEngine', () => {
  it('propagates a rename made right after start to flat and array snapshots', async () => {
    const { errors } = await startEngine();
    await users().updateOne({ _id: ada }, { $set: { name: 'Ada Lovelace' } });

    await waitFor(async () => (await postSnapshot())?.name === 'Ada Lovelace');
    const post = await posts().findOne({ _id: 'p1' });
    const { _v: flatVersion, ...flat } = post?.createdBy ?? {};
    expect(flat).toEqual({ _id: ada, name: 'Ada Lovelace', photo: 'a.png', role: 'admin' });
    expect(flatVersion).toBeInstanceOf(Timestamp);
    expect(post?.comments?.[0]?.author.name).toBe('Ada Lovelace');
    expect(post?.comments?.[0]?.author._v).toBeInstanceOf(Timestamp);
    expect(post?.comments?.[1]?.author).toEqual({ _id: bob, name: 'Bob' });
    expect(errors).toEqual([]);
  });

  it('writes nothing for an unsynced field change but still advances the resume token', async () => {
    await startEngine();
    const quiet = await firstSavedToken();
    await users().updateOne({ _id: ada }, { $set: { lastLoginAt: 1 } });

    await tokenAdvancedFrom(quiet);
    expect(await postSnapshot()).toEqual({ _id: ada, name: 'Ada', photo: 'a.png', role: 'admin' });
  });

  it('unsets a removed synced field and never touches frozen fields', async () => {
    await startEngine();
    await users().updateOne({ _id: ada }, { $unset: { avatar: '' }, $set: { role: 'guest' } });

    await waitFor(async () => (await postSnapshot())?.photo === undefined);
    expect(await postSnapshot()).toMatchObject({ name: 'Ada', role: 'admin' });
  });

  it('syncs a replace, unsetting synced fields the replacement dropped', async () => {
    await startEngine();
    await users().replaceOne({ _id: ada }, { name: 'Replaced', role: 'guest' });

    await waitFor(async () => (await postSnapshot())?.name === 'Replaced');
    const snapshot = await postSnapshot();
    expect(snapshot).not.toHaveProperty('photo');
    expect(snapshot?.role).toBe('admin');
  });

  it('applies every update a transaction makes to one source document', async () => {
    await startEngine();
    const session = ctx.client.startSession();
    try {
      await session.withTransaction(async () => {
        await users().updateOne({ _id: ada }, { $set: { name: 'Ada L.' } }, { session });
        await users().updateOne({ _id: ada }, { $set: { avatar: 'b.png' } }, { session });
      });
    } finally {
      await session.endSession();
    }

    await waitFor(async () => (await postSnapshot())?.photo === 'b.png');
    expect((await postSnapshot())?.name).toBe('Ada L.');
  });

  it('resumes after a restart from the saved resume token', async () => {
    const first = await startEngine();
    await users().updateOne({ _id: ada }, { $set: { name: 'First' } });
    await waitFor(async () => (await postSnapshot())?.name === 'First');
    const saved = await currentToken();
    await first.engine.stop();

    await users().updateOne({ _id: ada }, { $set: { name: 'While stopped' } });
    await startEngine();

    await waitFor(async () => (await postSnapshot())?.name === 'While stopped');
    await tokenAdvancedFrom(saved);
  });

  it('starts from the current cluster time on first start, without replaying older changes', async () => {
    await users().updateOne({ _id: ada }, { $set: { name: 'Before any engine' } });
    await startEngine();
    const quiet = await firstSavedToken();
    await users().updateOne({ _id: ada }, { $set: { lastLoginAt: 2 } });

    await tokenAdvancedFrom(quiet);
    expect((await postSnapshot())?.name).toBe('Ada');
  });

  it('reports a failed target write, keeps the token, and replays the event after restart', async () => {
    await forbidName('Forbidden');
    const first = await startEngine();
    const quiet = await firstSavedToken();
    await users().updateOne({ _id: ada }, { $set: { lastLoginAt: 3 } });
    await tokenAdvancedFrom(quiet);
    const beforeFailure = await currentToken();

    await users().updateOne({ _id: ada }, { $set: { name: 'Forbidden' } });
    await waitFor(() => Promise.resolve(first.errors.length > 0));
    expect(first.errors[0]).toBeInstanceOf(DenormoRuntimeError);
    expect(first.errors[0]).toMatchObject({ code: 'SOURCE_STOPPED', source: 'users' });
    expect(await currentToken()).toEqual(beforeFailure);
    await first.engine.stop();

    await allowAllNames();
    await startEngine();
    await waitFor(async () => (await postSnapshot())?.name === 'Forbidden');
  });

  it('keeps its start position when stopped before any event', async () => {
    const first = await startEngine();
    await first.engine.stop();
    await users().updateOne({ _id: ada }, { $set: { name: 'While stopped' } });

    await startEngine();
    await waitFor(async () => (await postSnapshot())?.name === 'While stopped');
  });

  it('replays a failed first event after a restart', async () => {
    await forbidName('Forbidden');
    const first = await startEngine();
    await users().updateOne({ _id: ada }, { $set: { name: 'Forbidden' } });
    await waitFor(() => Promise.resolve(first.errors.length > 0));
    await first.engine.stop();

    await allowAllNames();
    await startEngine();
    await waitFor(async () => (await postSnapshot())?.name === 'Forbidden');
  });

  it('saves its position while the source is quiet', async () => {
    await startEngine();
    expect(await firstSavedToken()).toEqual(expect.anything());
  });

  it('restarts a failed source when start() is called again on the same engine', async () => {
    await forbidName('Forbidden');
    const { engine, errors } = await startEngine();
    await users().updateOne({ _id: ada }, { $set: { name: 'Forbidden' } });
    await waitFor(() => Promise.resolve(errors.length > 0));

    await allowAllNames();
    await engine.start();
    await waitFor(async () => (await postSnapshot())?.name === 'Forbidden');
  });

  it('can be started again on the same engine after stop()', async () => {
    const { engine } = await startEngine();
    await engine.stop();
    await users().updateOne({ _id: ada }, { $set: { name: 'Restarted' } });

    await engine.start();
    await waitFor(async () => (await postSnapshot())?.name === 'Restarted');
  });

  it('lets stop() win over a pending start(), leaving the engine startable', async () => {
    const engine = await createSyncEngine({
      db: ctx.db,
      config: usersPostsConfig(),
      onWarning: () => undefined,
    });
    engines.push(engine);
    const starting = engine.start();
    await engine.stop();
    await starting;

    await expect(engine.start()).resolves.toBeUndefined();
  });

  it('opens each source once when start() is called concurrently', async () => {
    const engine = await createSyncEngine({
      db: ctx.db,
      config: usersPostsConfig(),
      onWarning: () => undefined,
    });
    engines.push(engine);
    const results = await Promise.allSettled([engine.start(), engine.start()]);

    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.reason).toMatchObject({ code: 'ALREADY_STARTED' });
  });

  it('stops cleanly while an event is in flight', async () => {
    const { engine, errors } = await startEngine();
    await users().updateOne({ _id: ada }, { $set: { name: 'In flight' } });
    await engine.stop();
    expect(errors).toEqual([]);
  });

  it('refuses to start twice', async () => {
    const { engine } = await startEngine();
    await expect(engine.start()).rejects.toMatchObject({ code: 'ALREADY_STARTED' });
  });

  it('refuses an invalid config before opening any stream', async () => {
    const broken = {
      ...usersPostsConfig(),
      relations: [relation({ id: 'r', mode: 'stream', path: 'a..b' })],
    };
    await expect(
      createSyncEngine({ db: ctx.db, config: broken, onWarning: () => undefined }),
    ).rejects.toBeInstanceOf(DenormoConfigError);
  });

  it('does not open a stream for sources whose relations are all readRepair', async () => {
    const config = usersPostsConfig();
    const readRepairOnly = {
      ...config,
      relations: config.relations.map((r) => ({ ...r, mode: 'readRepair' as const })),
    };
    const { errors } = await startEngine({ config: readRepairOnly });
    await users().updateOne({ _id: ada }, { $set: { name: 'Ignored' } });
    await users().updateOne({ _id: ada }, { $set: { lastLoginAt: 4 } });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await currentToken()).toBeUndefined();
    expect((await postSnapshot())?.name).toBe('Ada');
    expect(errors).toEqual([]);
  });
});
