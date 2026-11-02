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

  it('never versions a copy later than its write, even under concurrent load', async () => {
    // A later _v would block a real newer change; the stream later fixes an earlier one.
    const { user, post } = await seed();
    await startInline();
    const noise = ctx.connection.collection('noise');
    const quiet = new AbortController();
    const load = (async () => {
      while (!quiet.signal.aborted)
        await noise.insertMany(Array.from({ length: 20 }, (_, n) => ({ n })));
    })();
    const stream = User.collection.watch([{ $match: { operationType: 'update' } }]);
    try {
      await stream.tryNext();
      for (let n = 0; n < 15; n++) {
        await User.updateOne({ _id: user._id }, { $set: { name: `Timed ${String(n)}` } });
        let event = await stream.tryNext();
        while (!event) event = await stream.tryNext();
        const version = (await copyOf(post._id))?._v;
        const writeTime = event.clusterTime as mongoose.mongo.Timestamp;
        expect(version?.greaterThan(writeTime), `write ${String(n)}`).toBe(false);
      }
    } finally {
      quiet.abort();
      await load;
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

describe('inline mode: sessions, limits and lifecycle', () => {
  it('joins the caller’s transaction: an abort leaves the copies untouched', async () => {
    const { user, post } = await seed();
    await startInline();
    const session = await ctx.connection.startSession();
    try {
      await expect(
        session.withTransaction(async () => {
          await User.updateOne({ _id: user._id }, { $set: { name: 'Rolled back' } }, { session });
          throw new Error('abort');
        }),
      ).rejects.toThrow('abort');
    } finally {
      await session.endSession();
    }
    expect((await copyOf(post._id))?.name).toBe('Ada');
  });

  it('joins the caller’s transaction: a commit applies the copies', async () => {
    const { user, post } = await seed();
    await startInline();
    const session = await ctx.connection.startSession();
    try {
      await session.withTransaction(async () => {
        await User.updateOne({ _id: user._id }, { $set: { name: 'Committed' } }, { session });
      });
    } finally {
      await session.endSession();
    }
    expect((await copyOf(post._id))?.name).toBe('Committed');
  });

  it('skips a relation with more copies than inlineMaxTargets and warns', async () => {
    const { user, post } = await seed();
    await Post.create({ title: 'second', createdBy: user });
    const { warnings } = await startInline({ inlineMaxTargets: 1 });

    await User.updateOne({ _id: user._id }, { $set: { name: 'Too many' } });

    expect((await copyOf(post._id))?.name).toBe('Ada');
    expect(warnings).toContainEqual(expect.stringContaining('posts.createdBy'));
  });

  it('does nothing before start() and after stop()', async () => {
    const { user, post } = await seed();
    await User.updateOne({ _id: user._id }, { $set: { name: 'Before start' } });
    expect((await copyOf(post._id))?.name).toBe('Ada');

    const { sync } = await startInline();
    await sync.stop();
    await User.updateOne({ _id: user._id }, { $set: { name: 'After stop' } });
    expect((await copyOf(post._id))?.name).toBe('Ada');
  });

  it('warns about its blind spots on start, and does not see updateMany', async () => {
    const { user, post } = await seed();
    const { warnings } = await startInline();

    await User.updateMany({ _id: user._id }, { $set: { name: 'Bulk' } });

    expect(warnings[0]).toContain('updateMany');
    expect((await copyOf(post._id))?.name).toBe('Ada');
  });

  it('refuses a second inline sync on the same connection', async () => {
    await startInline();
    const second = await createSync({
      connection: ctx.connection,
      mode: 'inline',
      onWarning: () => undefined,
    });
    await expect(second.start()).rejects.toMatchObject({ code: 'ALREADY_STARTED' });
  });

  it('reports a failed copy write without failing the app’s write', async () => {
    const { user, post } = await seed();
    await ctx.connection.db?.command({
      collMod: 'posts',
      validator: { 'createdBy.name': { $ne: 'Forbidden' } },
      validationAction: 'error',
    });
    const { errors } = await startInline();
    try {
      await User.updateOne({ _id: user._id }, { $set: { name: 'Forbidden' } });

      expect((await User.findById(user._id))?.name).toBe('Forbidden');
      expect((await copyOf(post._id))?.name).toBe('Ada');
      expect(errors).toEqual([
        expect.objectContaining({ code: 'INLINE_SYNC_FAILED', source: 'users' }),
      ]);
    } finally {
      await ctx.connection.db?.command({ collMod: 'posts', validator: {}, validationLevel: 'off' });
    }
  });

  it('keeps working after a source write fails', async () => {
    const { user, post } = await seed();
    await startInline();

    await expect(
      User.updateOne({ _id: user._id }, { $set: { score: 'not a number' } }),
    ).rejects.toThrow();
    await User.updateOne({ _id: user._id }, { $set: { name: 'Recovered' } });

    expect((await copyOf(post._id))?.name).toBe('Recovered');
  });
});
