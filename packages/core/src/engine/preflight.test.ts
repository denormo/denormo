import type { Db } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { postsCommentsAuthor, postsCreatedBy, relation } from '../../test/fixtures.js';
import { DenormoRuntimeError } from '../errors.js';
import { assertReplicaSet, snapshotIdIndexKey } from './preflight.js';

/** A Db whose admin `hello` returns `reply`; nothing else is called. */
function dbReplying(reply: Record<string, unknown>): Db {
  return { admin: () => ({ command: () => Promise.resolve(reply) }) } as unknown as Db;
}

describe('assertReplicaSet', () => {
  it('accepts a replica set member', async () => {
    await expect(assertReplicaSet(dbReplying({ setName: 'rs0' }))).resolves.toBeUndefined();
  });

  it('accepts a mongos', async () => {
    await expect(assertReplicaSet(dbReplying({ msg: 'isdbgrid' }))).resolves.toBeUndefined();
  });

  it('rejects a standalone server', async () => {
    const standalone = assertReplicaSet(dbReplying({ isWritablePrimary: true }));
    await expect(standalone).rejects.toBeInstanceOf(DenormoRuntimeError);
    await expect(assertReplicaSet(dbReplying({}))).rejects.toMatchObject({
      code: 'NOT_REPLICA_SET',
    });
  });
});

describe('snapshotIdIndexKey', () => {
  it('points at the snapshot _id for flat and array paths', () => {
    expect(snapshotIdIndexKey(postsCreatedBy)).toBe('createdBy._id');
    expect(snapshotIdIndexKey(postsCommentsAuthor)).toBe('comments.author._id');
    expect(snapshotIdIndexKey(relation({ id: 'l', path: 'likedBy[]', array: true }))).toBe(
      'likedBy._id',
    );
  });
});
