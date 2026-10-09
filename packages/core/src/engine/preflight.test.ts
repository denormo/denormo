import type { Db } from 'mongodb';
import { describe, expect, it } from 'vitest';
import {
  postsCommentsAuthor,
  postsCreatedBy,
  relation,
  usersPostsConfig,
} from '../../test/fixtures.js';
import { DenormoRuntimeError } from '../errors.js';
import { assertReplicaSet, ensureSnapshotIndexes, snapshotIdIndexKey } from './preflight.js';

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

describe('ensureSnapshotIndexes', () => {
  it('treats NamespaceNotFound from any driver copy as "no indexes yet"', async () => {
    // A plain object, not this package's MongoServerError: the app's driver may be another copy.
    const missing = Object.assign(new Error('ns does not exist'), {
      code: 26,
      codeName: 'NamespaceNotFound',
    });
    const db = {
      collection: () => ({ indexes: () => Promise.reject(missing) }),
    } as unknown as Db;
    const warnings: string[] = [];

    await ensureSnapshotIndexes(db, usersPostsConfig(), {
      autoIndex: false,
      onWarning: (message) => warnings.push(message),
    });

    expect(warnings).toHaveLength(2);
  });

  it('rethrows other errors', async () => {
    const db = {
      collection: () => ({ indexes: () => Promise.reject(new Error('auth failed')) }),
    } as unknown as Db;
    await expect(
      ensureSnapshotIndexes(db, usersPostsConfig(), {
        autoIndex: false,
        onWarning: () => undefined,
      }),
    ).rejects.toThrow('auth failed');
  });
});
