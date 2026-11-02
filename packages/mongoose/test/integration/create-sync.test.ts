import { DenormoConfigError, DenormoRuntimeError } from '@denormo/core';
import mongoose from 'mongoose';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { waitFor } from '../../../../test/integration/wait-for.js';
import { createSync, type MongooseSync } from '../../src/create-sync.js';
import { Snapshot } from '../../src/snapshot-type.js';
import { snapshotSource } from '../../src/source-plugin.js';
import { useConnection } from './connection.js';

const ctx = useConnection();
const syncs: MongooseSync[] = [];

interface UserDoc {
  name: string;
  avatar?: string;
  role?: string;
  passwordHash?: string;
}
interface SnapshotDoc {
  _id: mongoose.Types.ObjectId;
  name?: string;
  photo?: string;
  role?: string;
  _v?: mongoose.mongo.Timestamp;
}
interface PostDoc {
  title: string;
  createdBy?: SnapshotDoc;
  meta?: { editor?: SnapshotDoc };
  comments: { text: string; author?: SnapshotDoc }[];
  likedBy: SnapshotDoc[];
}

let User: mongoose.Model<UserDoc>;
let Post: mongoose.Model<PostDoc>;

beforeAll(() => {
  const userSchema = new mongoose.Schema<UserDoc>({
    name: String,
    avatar: String,
    role: String,
    passwordHash: String,
  });
  userSchema.plugin(snapshotSource, { expose: ['name', 'avatar', 'role'] });
  User = ctx.connection.model<UserDoc>('User', userSchema);
  Post = ctx.connection.model<PostDoc>(
    'Post',
    new mongoose.Schema<PostDoc>({
      title: String,
      createdBy: {
        type: Snapshot,
        ref: 'User',
        fields: {
          name: { sync: true },
          avatar: { sync: true, as: 'photo' },
          role: { sync: false },
        },
      },
      comments: [
        { text: String, author: { type: Snapshot, ref: 'User', fields: { name: { sync: true } } } },
      ],
      meta: { editor: { type: Snapshot, ref: 'User', fields: { name: { sync: true } } } },
      likedBy: [{ type: Snapshot, ref: 'User', fields: { name: { sync: true } } }],
    }),
  );
});

beforeEach(async () => {
  await Promise.all([User.deleteMany({}), Post.deleteMany({})]);
});

afterEach(async () => {
  await Promise.all(syncs.splice(0).map((sync) => sync.stop()));
});

async function startSync() {
  const errors: DenormoRuntimeError[] = [];
  const sync = await createSync({
    connection: ctx.connection,
    onError: (error) => errors.push(error),
    onWarning: () => undefined,
  });
  syncs.push(sync);
  await sync.start();
  return { sync, errors };
}

async function seed() {
  const ada = await User.create({
    name: 'Ada',
    avatar: 'a.png',
    role: 'admin',
    passwordHash: 'secret',
  });
  const post = await Post.create({
    title: 'Hello',
    createdBy: ada,
    comments: [{ text: 'First', author: ada }],
    likedBy: [ada],
  });
  return { ada, post };
}

async function reload(id: unknown) {
  return Post.findById(id).lean<PostDoc>();
}

describe('createSync', () => {
  it('compiles the connection’s models into the core config', async () => {
    const { sync } = await startSync();
    expect(sync.config.relations.map((relation) => relation.id).sort()).toEqual([
      'posts.comments.author',
      'posts.createdBy',
      'posts.likedBy',
      'posts.meta.editor',
    ]);
    expect(sync.config.sources).toEqual({ users: { expose: ['name', 'avatar', 'role'] } });
  });

  it('propagates a rename made with updateOne to every kind of snapshot path', async () => {
    const { ada, post } = await seed();
    const { errors } = await startSync();

    await User.updateOne({ _id: ada._id }, { $set: { name: 'Ada Lovelace', avatar: 'b.png' } });

    await waitFor(async () => (await reload(post._id))?.likedBy[0]?.name === 'Ada Lovelace');
    const synced = await reload(post._id);
    expect(synced?.createdBy).toMatchObject({
      name: 'Ada Lovelace',
      photo: 'b.png',
      role: 'admin',
    });
    expect(synced?.comments[0]?.author?.name).toBe('Ada Lovelace');
    expect(synced?.createdBy?._v).toBeInstanceOf(mongoose.mongo.Timestamp);
    expect(errors).toEqual([]);
  });

  it('propagates a change saved through a document', async () => {
    const { ada, post } = await seed();
    await startSync();

    ada.name = 'Saved';
    await ada.save();

    await waitFor(async () => (await reload(post._id))?.createdBy?.name === 'Saved');
  });

  it('never syncs a frozen field', async () => {
    const { ada, post } = await seed();
    await startSync();

    await User.updateOne({ _id: ada._id }, { $set: { role: 'guest', name: 'Marker' } });

    await waitFor(async () => (await reload(post._id))?.createdBy?.name === 'Marker');
    expect((await reload(post._id))?.createdBy?.role).toBe('admin');
  });

  it('refuses a connection that was never opened', async () => {
    const closed = mongoose.createConnection();
    await expect(createSync({ connection: closed })).rejects.toBeInstanceOf(DenormoRuntimeError);
    await expect(createSync({ connection: closed })).rejects.toMatchObject({
      code: 'NOT_CONNECTED',
    });
  });

  it('refuses inline mode until it exists', async () => {
    const inline = { connection: ctx.connection, mode: 'inline' } as unknown as Parameters<
      typeof createSync
    >[0];
    await expect(createSync(inline)).rejects.toBeInstanceOf(DenormoConfigError);
    await expect(createSync(inline)).rejects.toMatchObject({ code: 'UNSUPPORTED_MODE' });
  });
});

describe('assigning a source document through any write', () => {
  /** Every snapshot stored in the post, read from the raw collection (no Mongoose casting). */
  async function storedSnapshots(id: unknown): Promise<unknown[]> {
    const raw = await ctx.connection.db
      ?.collection<PostDoc>('posts')
      .findOne({ _id: id as mongoose.Types.ObjectId });
    return [
      raw?.createdBy,
      raw?.meta?.editor,
      ...(raw?.comments ?? []).map((comment) => comment.author),
      ...(raw?.likedBy ?? []),
    ].filter((snapshot) => snapshot !== undefined);
  }

  it('never stores undeclared fields such as passwordHash or __v', async () => {
    const ada = await User.create({
      name: 'Ada',
      avatar: 'a.png',
      role: 'admin',
      passwordHash: 'secret',
    });
    const lean = await User.findById(ada._id).lean();
    const writes: [string, (id: mongoose.Types.ObjectId) => Promise<unknown>][] = [
      ['updateOne $set', (_id) => Post.updateOne({ _id }, { $set: { createdBy: ada } })],
      ['updateOne without operator', (_id) => Post.updateOne({ _id }, { createdBy: ada })],
      [
        'updateOne $set with a lean user',
        (_id) => Post.updateOne({ _id }, { $set: { createdBy: lean } }),
      ],
      ['$push into likedBy', (_id) => Post.updateOne({ _id }, { $push: { likedBy: ada } })],
      ['$addToSet into likedBy', (_id) => Post.updateOne({ _id }, { $addToSet: { likedBy: ada } })],
      [
        '$push a comment',
        (_id) => Post.updateOne({ _id }, { $push: { comments: { text: 'x', author: ada } } }),
      ],
      [
        'bulkWrite updateOne',
        (_id) =>
          Post.bulkWrite([
            { updateOne: { filter: { _id }, update: { $set: { createdBy: ada } } } },
          ]),
      ],
      [
        'findOneAndUpdate nested',
        (_id) => Post.findOneAndUpdate({ _id }, { $set: { 'meta.editor': ada } }),
      ],
      ['replaceOne', (_id) => Post.replaceOne({ _id }, { title: 'replaced', createdBy: ada })],
    ];

    for (const [label, write] of writes) {
      const post = await Post.create({ title: label });
      await write(post._id);
      const stored = await storedSnapshots(post._id);
      expect(stored, label).not.toEqual([]);
      expect(JSON.stringify(stored), label).not.toMatch(/passwordHash|secret|__v|avatar/);
    }
  });

  it('stores the declared fields under their snapshot names', async () => {
    const ada = await User.create({
      name: 'Ada',
      avatar: 'a.png',
      role: 'admin',
      passwordHash: 'secret',
    });
    const post = await Post.create({ title: 'x' });
    await Post.updateOne({ _id: post._id }, { $set: { createdBy: ada } });
    const [createdBy] = await storedSnapshots(post._id);
    expect(createdBy).toEqual({ _id: ada._id, name: 'Ada', photo: 'a.png', role: 'admin' });
  });
});
