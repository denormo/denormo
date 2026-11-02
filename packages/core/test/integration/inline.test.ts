import { ObjectId, Timestamp } from 'mongodb';
import { beforeEach, describe, expect, it } from 'vitest';
import { DenormoConfigError } from '../../src/errors.js';
import { createInlineSync, DEFAULT_INLINE_MAX_TARGETS } from '../../src/inline/inline.js';
import type { NormalizedChangeEvent } from '../../src/planner/types.js';
import { relation, usersPostsConfig } from '../fixtures.js';
import { type PostDoc, useDatabase } from './mongo.js';

const ctx = useDatabase();
const ada = new ObjectId();
const T5 = new Timestamp({ t: 5, i: 1 });
const posts = () => ctx.db.collection<PostDoc>('posts');

function rename(name: string): NormalizedChangeEvent {
  return { op: 'update', source: 'users', srcId: ada, version: T5, changed: { name }, removed: [] };
}

beforeEach(async () => {
  await posts().deleteMany({});
  await posts().insertMany([
    {
      _id: 'p1',
      createdBy: { _id: ada, name: 'Ada' },
      comments: [{ _id: 'c1', author: { _id: ada, name: 'Ada' } }],
    },
    { _id: 'p2', createdBy: { _id: ada, name: 'Ada' } },
  ]);
});

describe('createInlineSync', () => {
  it('applies every relation an event affects', async () => {
    const inline = await createInlineSync({ db: ctx.db, config: usersPostsConfig() });
    const result = await inline.apply(rename('Ada Lovelace'));

    expect(result).toEqual({ applied: ['posts.createdBy', 'posts.comments.author'], skipped: [] });
    const p1 = await posts().findOne({ _id: 'p1' });
    expect(p1?.createdBy).toMatchObject({ name: 'Ada Lovelace', _v: T5 });
    expect(p1?.comments?.[0]?.author.name).toBe('Ada Lovelace');
  });

  it('skips a relation with more copies than maxTargets and warns', async () => {
    const warnings: string[] = [];
    const inline = await createInlineSync({
      db: ctx.db,
      config: usersPostsConfig(),
      maxTargets: 1,
      onWarning: (message) => warnings.push(message),
    });
    const result = await inline.apply(rename('Too many'));

    expect(result).toEqual({ applied: ['posts.comments.author'], skipped: ['posts.createdBy'] });
    expect(warnings).toEqual([expect.stringContaining('posts.createdBy')]);
    expect((await posts().findOne({ _id: 'p2' }))?.createdBy?.name).toBe('Ada');
  });

  it('writes in the caller’s transaction, so an abort leaves the copies untouched', async () => {
    const inline = await createInlineSync({ db: ctx.db, config: usersPostsConfig() });
    const session = ctx.client.startSession();
    try {
      session.startTransaction();
      await inline.apply(rename('Rolled back'), { session });
      await session.abortTransaction();
    } finally {
      await session.endSession();
    }
    expect((await posts().findOne({ _id: 'p1' }))?.createdBy?.name).toBe('Ada');
  });

  it('writes in the caller’s transaction, so a commit applies the copies', async () => {
    const inline = await createInlineSync({ db: ctx.db, config: usersPostsConfig() });
    const session = ctx.client.startSession();
    try {
      await session.withTransaction(async () => {
        await inline.apply(rename('Committed'), { session });
      });
    } finally {
      await session.endSession();
    }
    expect((await posts().findOne({ _id: 'p1' }))?.createdBy?.name).toBe('Committed');
  });

  it('lists the synced fields of a source', async () => {
    const inline = await createInlineSync({ db: ctx.db, config: usersPostsConfig() });
    expect([...inline.syncedFields('users')].sort()).toEqual(['avatar', 'name']);
    expect(inline.syncedFields('orgs')).toEqual([]);
  });

  it('validates the config', async () => {
    const broken = { ...usersPostsConfig(), relations: [relation({ id: 'r', path: 'a..b' })] };
    await expect(createInlineSync({ db: ctx.db, config: broken })).rejects.toBeInstanceOf(
      DenormoConfigError,
    );
  });

  it('defaults maxTargets to 1,000', () => {
    expect(DEFAULT_INLINE_MAX_TARGETS).toBe(1000);
  });
});
