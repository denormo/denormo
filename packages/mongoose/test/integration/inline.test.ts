import { DenormoRuntimeError } from '@denormo/core';
import mongoose from 'mongoose';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
  score?: number;
  lastLoginAt?: Date;
}
interface SnapshotDoc {
  _id: mongoose.Types.ObjectId;
  name?: string;
  photo?: string;
  role?: string;
  score?: number;
  _v?: mongoose.mongo.Timestamp;
}
interface PostDoc {
  title: string;
  createdBy?: SnapshotDoc;
  comments: { text: string; author?: SnapshotDoc }[];
}

let User: mongoose.Model<UserDoc>;
let Post: mongoose.Model<PostDoc>;

beforeAll(() => {
  const userSchema = new mongoose.Schema<UserDoc>({
    name: String,
    avatar: String,
    role: String,
    score: Number,
    lastLoginAt: Date,
  });
  userSchema.plugin(snapshotSource, { expose: ['name', 'avatar', 'role', 'score'] });
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
          score: { sync: true },
        },
      },
      comments: [
        { text: String, author: { type: Snapshot, ref: 'User', fields: { name: { sync: true } } } },
      ],
    }),
  );
});

beforeEach(async () => {
  await Promise.all([User.deleteMany({}), Post.deleteMany({})]);
});

afterEach(async () => {
  await Promise.all(syncs.splice(0).map((sync) => sync.stop()));
});

async function startInline(options: { inlineMaxTargets?: number } = {}) {
  const errors: DenormoRuntimeError[] = [];
  const warnings: string[] = [];
  const sync = await createSync({
    connection: ctx.connection,
    mode: 'inline',
    onError: (error) => errors.push(error),
    onWarning: (message) => warnings.push(message),
    ...options,
  });
  syncs.push(sync);
  await sync.start();
  return { sync, errors, warnings };
}

async function seed(name = 'Ada') {
  const user = await User.create({ name, avatar: 'a.png', role: 'admin', score: 1 });
  const post = await Post.create({
    title: `by ${name}`,
    createdBy: user,
    comments: [{ text: 'hi', author: user }],
  });
  return { user, post };
}

const copyOf = async (id: unknown) => (await Post.findById(id).lean<PostDoc>())?.createdBy;

describe('inline mode: propagation', () => {
  it('updates copies before save() resolves', async () => {
    const { user, post } = await seed();
    const { errors } = await startInline();

    user.name = 'Saved';
    await user.save();

    const synced = await Post.findById(post._id).lean<PostDoc>();
    expect(synced?.createdBy?.name).toBe('Saved');
    expect(synced?.comments[0]?.author?.name).toBe('Saved');
    expect(errors).toEqual([]);
  });

  it.each([
    ['updateOne', (id: unknown) => User.updateOne({ _id: id }, { $set: { name: 'Q' } })],
    [
      'findOneAndUpdate',
      (id: unknown) => User.findOneAndUpdate({ _id: id }, { $set: { name: 'Q' } }),
    ],
    [
      'replaceOne',
      (id: unknown) =>
        User.replaceOne({ _id: id }, { name: 'Q', avatar: 'a.png', role: 'admin', score: 1 }),
    ],
    [
      'findOneAndReplace',
      (id: unknown) =>
        User.findOneAndReplace(
          { _id: id },
          { name: 'Q', avatar: 'a.png', role: 'admin', score: 1 },
        ),
    ],
  ])('updates copies before %s resolves', async (_label, write) => {
    const { user, post } = await seed();
    await startInline();
    await write(user._id);
    expect((await copyOf(post._id))?.name).toBe('Q');
  });

  it('reads back the result of any operator ($inc, $unset)', async () => {
    const { user, post } = await seed();
    await startInline();

    await User.updateOne({ _id: user._id }, { $inc: { score: 41 }, $unset: { avatar: '' } });

    const copy = await copyOf(post._id);
    expect(copy?.score).toBe(42);
    expect(copy).not.toHaveProperty('photo');
  });

  it('syncs the document a non-_id filter actually changed', async () => {
    const ada = await seed('Ada');
    const bob = await seed('Bob');
    await startInline();

    await User.updateOne({ name: 'Bob' }, { $set: { name: 'Robert' } });

    expect((await copyOf(bob.post._id))?.name).toBe('Robert');
    expect((await copyOf(ada.post._id))?.name).toBe('Ada');
  });

  it('versions the copy with the write’s cluster time, as the stream would', async () => {
    const { user, post } = await seed();
    await startInline();
    const stream = User.collection.watch([{ $match: { operationType: 'update' } }]);
    try {
      await stream.tryNext();
      await User.updateOne({ _id: user._id }, { $set: { name: 'Timed' } });
      let event = await stream.tryNext();
      while (!event) event = await stream.tryNext();

      const version = (await copyOf(post._id))?._v;
      expect(version?.equals(event.clusterTime as mongoose.mongo.Timestamp)).toBe(true);
    } finally {
      await stream.close();
    }
  });

  it('leaves copies alone when a write touches no synced field', async () => {
    const { user, post } = await seed();
    await startInline();

    await User.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });
    user.lastLoginAt = new Date();
    await user.save();

    expect(await copyOf(post._id)).not.toHaveProperty('_v');
  });

  it('never syncs a frozen field', async () => {
    const { user, post } = await seed();
    await startInline();

    await User.updateOne({ _id: user._id }, { $set: { role: 'guest', name: 'Marker' } });

    expect(await copyOf(post._id)).toMatchObject({ name: 'Marker', role: 'admin' });
  });
});
