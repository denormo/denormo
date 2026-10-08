import { beforeEach, describe, expect, it } from 'vitest';
import { assertReplicaSet, ensureSnapshotIndexes } from '../../src/engine/preflight.js';
import { usersPostsConfig } from '../fixtures.js';
import { useDatabase } from './mongo.js';

const ctx = useDatabase();

async function indexKeys(collection: string): Promise<string[]> {
  const indexes = await ctx.db.collection(collection).indexes();
  return indexes.map((index) => Object.keys(index.key).join(','));
}

beforeEach(async () => {
  await ctx.db
    .collection('posts')
    .drop()
    .catch(() => undefined);
});

describe('preflight against a replica set', () => {
  it('accepts the test replica set', async () => {
    await expect(assertReplicaSet(ctx.db)).resolves.toBeUndefined();
  });

  it('warns about each missing snapshot index, even when the target collection does not exist', async () => {
    const warnings: string[] = [];
    await ensureSnapshotIndexes(ctx.db, usersPostsConfig(), {
      autoIndex: false,
      onWarning: (message) => warnings.push(message),
    });
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('posts.createdBy._id');
    expect(warnings[1]).toContain('posts.comments.author._id');
  });

  it('creates the indexes when autoIndex is on', async () => {
    const warnings: string[] = [];
    await ensureSnapshotIndexes(ctx.db, usersPostsConfig(), {
      autoIndex: true,
      onWarning: (message) => warnings.push(message),
    });
    expect(warnings).toEqual([]);
    expect(await indexKeys('posts')).toEqual(
      expect.arrayContaining(['createdBy._id', 'comments.author._id']),
    );
  });

  it('accepts an existing compound index that starts with the snapshot _id', async () => {
    await ctx.db.collection('posts').createIndex({ 'createdBy._id': 1, createdAt: -1 });
    await ctx.db.collection('posts').createIndex({ 'comments.author._id': 1 });
    const warnings: string[] = [];
    await ensureSnapshotIndexes(ctx.db, usersPostsConfig(), {
      autoIndex: false,
      onWarning: (message) => warnings.push(message),
    });
    expect(warnings).toEqual([]);
  });
});
