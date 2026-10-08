import { Timestamp } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { createCursorStore } from '../../src/state/cursors.js';
import { useDatabase } from './mongo.js';

const ctx = useDatabase();
const T7 = new Timestamp({ t: 7, i: 1 });

describe('createCursorStore', () => {
  it('has no position for a source it has never seen', async () => {
    expect(await createCursorStore(ctx.db, '_t1_').load('users')).toBeUndefined();
  });

  it('saves and loads a resume token per source, replacing older ones', async () => {
    const store = createCursorStore(ctx.db, '_t2_');
    await store.save('users', { resumeAfter: { _data: 'first' } });
    await store.save('users', { resumeAfter: { _data: 'second' } });
    await store.save('orgs', { resumeAfter: { _data: 'org' } });

    expect(await store.load('users')).toEqual({ resumeAfter: { _data: 'second' } });
    expect(await store.load('orgs')).toEqual({ resumeAfter: { _data: 'org' } });
  });

  it('remembers a start time until the first resume token replaces it', async () => {
    const store = createCursorStore(ctx.db, '_t3_');
    await store.save('users', { startAtOperationTime: T7 });
    expect(await store.load('users')).toEqual({ startAtOperationTime: T7 });
    const stored = await ctx.db
      .collection<{ _id: string; startAtOperationTime?: Timestamp }>('_t3_cursors')
      .findOne({ _id: 'users' });
    expect(stored?.startAtOperationTime).toEqual(T7);
    expect(stored).not.toHaveProperty('resumeToken');

    await store.save('users', { resumeAfter: { _data: 'token' } });
    expect(await store.load('users')).toEqual({ resumeAfter: { _data: 'token' } });
  });

  it('keeps one document per source in <prefix>cursors', async () => {
    const store = createCursorStore(ctx.db, '_t4_');
    await store.save('users', { startAtOperationTime: T7 });
    await store.save('users', { resumeAfter: { _data: 'b' } });

    const docs = await ctx.db.collection('_t4_cursors').find().toArray();
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ _id: 'users', resumeToken: { _data: 'b' } });
    expect(docs[0]).not.toHaveProperty('startAtOperationTime');
    expect(docs[0]?.updatedAt).toBeInstanceOf(Date);
  });
});
