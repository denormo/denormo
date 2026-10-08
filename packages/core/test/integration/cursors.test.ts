import { describe, expect, it } from 'vitest';
import { createCursorStore } from '../../src/state/cursors.js';
import { useDatabase } from './mongo.js';

const ctx = useDatabase();

describe('createCursorStore', () => {
  it('has no token for a source it has never seen', async () => {
    expect(await createCursorStore(ctx.db, '_t1_').load('users')).toBeUndefined();
  });

  it('saves and loads a token per source, replacing older ones', async () => {
    const store = createCursorStore(ctx.db, '_t2_');
    await store.save('users', { _data: 'first' });
    await store.save('users', { _data: 'second' });
    await store.save('orgs', { _data: 'org' });

    expect(await store.load('users')).toEqual({ _data: 'second' });
    expect(await store.load('orgs')).toEqual({ _data: 'org' });
  });

  it('keeps one document per source in <prefix>cursors', async () => {
    const store = createCursorStore(ctx.db, '_t3_');
    await store.save('users', { _data: 'a' });
    await store.save('users', { _data: 'b' });

    const docs = await ctx.db.collection('_t3_cursors').find().toArray();
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ _id: 'users', resumeToken: { _data: 'b' } });
    expect(docs[0]?.updatedAt).toBeInstanceOf(Date);
  });
});
