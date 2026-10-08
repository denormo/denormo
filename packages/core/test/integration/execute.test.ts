import { ObjectId, Timestamp } from 'mongodb';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildReverseMap } from '../../src/config/reverse-map.js';
import type { CompiledConfig } from '../../src/config/types.js';
import { planUpdates } from '../../src/planner/plan.js';
import type { NormalizedChangeEvent } from '../../src/planner/types.js';
import { executeOperations } from '../../src/stream/execute.js';
import { configWith, postsCreatedBy, relation, usersPostsConfig } from '../fixtures.js';
import { type PostDoc, useDatabase } from './mongo.js';

const ctx = useDatabase();
const posts = () => ctx.db.collection<PostDoc>('posts');
const ada = new ObjectId();
const bob = new ObjectId();
const T = (t: number) => new Timestamp({ t, i: 1 });

async function run(
  event: Partial<NormalizedChangeEvent>,
  config: CompiledConfig = usersPostsConfig(),
) {
  const full: NormalizedChangeEvent = {
    op: 'update',
    source: 'users',
    srcId: ada,
    version: T(5),
    changed: {},
    removed: [],
    ...event,
  };
  await executeOperations(ctx.db, planUpdates(config, buildReverseMap(config), full));
}

beforeEach(async () => {
  await posts().deleteMany({});
});

describe('executeOperations', () => {
  it('updates flat snapshots that are older or have no _v, and leaves newer ones', async () => {
    await posts().insertMany([
      { _id: 'older', createdBy: { _id: ada, name: 'Ada', _v: T(1) } },
      { _id: 'none', createdBy: { _id: ada, name: 'Ada' } },
      { _id: 'newer', createdBy: { _id: ada, name: 'Newer', _v: T(9) } },
      { _id: 'other', createdBy: { _id: bob, name: 'Bob', _v: T(1) } },
    ]);

    await run({ changed: { name: 'Ada Lovelace' } });

    const byId = new Map(
      (await posts().find().toArray()).map((post) => [post._id, post.createdBy]),
    );
    expect(byId.get('older')).toEqual({ _id: ada, name: 'Ada Lovelace', _v: T(5) });
    expect(byId.get('none')).toEqual({ _id: ada, name: 'Ada Lovelace', _v: T(5) });
    expect(byId.get('newer')).toEqual({ _id: ada, name: 'Newer', _v: T(9) });
    expect(byId.get('other')).toEqual({ _id: bob, name: 'Bob', _v: T(1) });
  });

  it('updates matching array elements, including ones without _v', async () => {
    await posts().insertOne({
      _id: 'thread',
      comments: [
        { _id: 'c1', author: { _id: ada, name: 'Ada', _v: T(1) } },
        { _id: 'c2', author: { _id: ada, name: 'Ada' } },
        { _id: 'c3', author: { _id: ada, name: 'Newer', _v: T(9) } },
        { _id: 'c4', author: { _id: bob, name: 'Bob' } },
      ],
    });

    await run({ changed: { name: 'Ada Lovelace' } });

    const thread = await posts().findOne({ _id: 'thread' });
    expect(thread?.comments?.map((comment) => comment.author)).toEqual([
      { _id: ada, name: 'Ada Lovelace', _v: T(5) },
      { _id: ada, name: 'Ada Lovelace', _v: T(5) },
      { _id: ada, name: 'Newer', _v: T(9) },
      { _id: bob, name: 'Bob' },
    ]);
  });

  it('is a no-op when the same event is applied twice', async () => {
    await posts().insertOne({ _id: 'p', createdBy: { _id: ada, name: 'Ada' } });
    await run({ changed: { name: 'Ada Lovelace' } });
    const once = await posts().findOne({ _id: 'p' });
    await run({ changed: { name: 'Ada Lovelace' } });
    expect(await posts().findOne({ _id: 'p' })).toEqual(once);
  });

  it('unsets removed fields and leaves frozen ones', async () => {
    await posts().insertOne({
      _id: 'p',
      createdBy: { _id: ada, name: 'Ada', photo: 'a.png', role: 'admin' },
    });
    await run({ removed: ['avatar', 'role'] }, configWith(postsCreatedBy));
    expect((await posts().findOne({ _id: 'p' }))?.createdBy).toEqual({
      _id: ada,
      name: 'Ada',
      role: 'admin',
      _v: T(5),
    });
  });

  it('applies delete policies: markDeleted, and $pull for arrays of snapshots', async () => {
    const likedBy = relation({
      id: 'posts.likedBy',
      path: 'likedBy[]',
      array: true,
      onDelete: 'unset',
    });
    await posts().insertOne({
      _id: 'p',
      createdBy: { _id: ada, name: 'Ada' },
      likedBy: [
        { _id: ada, name: 'Ada' },
        { _id: bob, name: 'Bob' },
      ],
    });

    await run({ op: 'delete' }, configWith(postsCreatedBy, likedBy));

    const post = await posts().findOne({ _id: 'p' });
    expect(post?.createdBy).toEqual({ _id: ada, name: 'Ada', deleted: true, _v: T(5) });
    expect(post?.likedBy).toEqual([{ _id: bob, name: 'Bob' }]);
  });
});
