import { DenormoRuntimeError } from '@denormo/core';
import mongoose from 'mongoose';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSync, type MongooseSync } from '../../src/create-sync.js';
import { Snapshot } from '../../src/snapshot-type.js';
import { snapshotSource } from '../../src/source-plugin.js';
import { waitFor } from '../../../../test/integration/wait-for.js';
import { useConnection } from './connection.js';

const ctx = useConnection();
const syncs: MongooseSync[] = [];

interface UserDoc {
  name: string;
  avatar?: string;
  role?: string;
  score?: number;
  lastLoginAt?: Date;
  tag?: string;
  rank?: number;
}
interface LabelDoc {
  _id: string;
  title: string;
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
  tagged?: { _id: string; title?: string };
}

let User: mongoose.Model<UserDoc>;
let Post: mongoose.Model<PostDoc>;
let Label: mongoose.Model<LabelDoc>;
/** Test-only switch: delete the matching user after denormo's pre hook, before the write. */
const race = { deleteBeforeWrite: false };

beforeAll(() => {
  const userSchema = new mongoose.Schema<UserDoc>({
    name: String,
    avatar: String,
    role: String,
    score: Number,
    lastLoginAt: Date,
    tag: String,
    rank: Number,
  });
  userSchema.plugin(snapshotSource, { expose: ['name', 'avatar', 'role', 'score'] });
  // Registered after the plugin, so it runs after denormo's pre hook.
  userSchema.pre('updateOne', async function () {
    if (race.deleteBeforeWrite) await User.collection.deleteOne({ name: 'Ghost' });
  });
  User = ctx.connection.model<UserDoc>('User', userSchema);
  const labelSchema = new mongoose.Schema<LabelDoc>({ _id: String, title: String });
  labelSchema.plugin(snapshotSource, { expose: ['title'] });
  Label = ctx.connection.model<LabelDoc>('Label', labelSchema);
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
      tagged: { type: Snapshot, ref: 'Label', fields: { title: { sync: true } } },
    }),
  );
});

beforeEach(async () => {
  await Promise.all([User.deleteMany({}), Post.deleteMany({}), Label.deleteMany({})]);
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
      validationLevel: 'strict',
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

describe('inline mode: review fixes', () => {
  it('syncs a write whose _id filter is a string', async () => {
    const { user, post } = await seed();
    await startInline();

    await User.updateOne({ _id: user._id.toString() }, { $set: { name: 'From string' } });
    expect((await copyOf(post._id))?.name).toBe('From string');

    await User.findByIdAndUpdate(user._id.toString(), { $set: { name: 'By id string' } });
    expect((await copyOf(post._id))?.name).toBe('By id string');
  });

  it('lets the query’s sort pick the document, as without inline mode', async () => {
    const low = await seed('Low');
    const high = await seed('High');
    await User.updateOne({ _id: low.user._id }, { $set: { tag: 'x', rank: 1 } });
    await User.updateOne({ _id: high.user._id }, { $set: { tag: 'x', rank: 2 } });
    await startInline();

    await User.findOneAndUpdate({ tag: 'x' }, { $set: { name: 'Top' } }, { sort: { rank: -1 } });

    expect((await User.findById(high.user._id))?.name).toBe('Top');
    expect((await User.findById(low.user._id))?.name).toBe('Low');
    expect((await copyOf(high.post._id))?.name).toBe('Top');
    expect((await copyOf(low.post._id))?.name).toBe('Low');
  });

  it('honours the query’s collation when finding the document', async () => {
    const { post } = await seed('Ada');
    await startInline();

    await User.updateOne(
      { name: 'ada' },
      { $set: { name: 'Collated' } },
      { collation: { locale: 'en', strength: 2 } },
    );

    expect((await copyOf(post._id))?.name).toBe('Collated');
  });

  it('joins a transaction started with connection.transaction() (async local storage)', async () => {
    const { user, post } = await seed();
    await startInline();
    mongoose.set('transactionAsyncLocalStorage', true);
    try {
      await ctx.connection.transaction(async () => {
        await User.updateOne({ _id: user._id }, { $set: { name: 'In transaction' } });
      });
    } finally {
      mongoose.set('transactionAsyncLocalStorage', false);
    }
    expect((await copyOf(post._id))?.name).toBe('In transaction');
  });

  it('never re-creates a vanished document under its old _id on upsert', async () => {
    const ghost = await User.create({ name: 'Ghost' });
    await startInline();
    race.deleteBeforeWrite = true;
    try {
      await User.updateOne({ name: 'Ghost' }, { $set: { score: 5 } }, { upsert: true });
    } finally {
      race.deleteBeforeWrite = false;
    }
    expect(await User.findById(ghost._id)).toBeNull();
    expect(await User.countDocuments({ name: 'Ghost' })).toBe(1);
  });

  it('reports a failed read-back without failing the app’s write', async () => {
    const { user, post } = await seed();
    const { errors } = await startInline();
    const collection = User.collection as unknown as { findOne: (...args: unknown[]) => unknown };
    const original = collection.findOne;
    collection.findOne = () => Promise.reject(new Error('network blip'));
    try {
      await User.updateOne({ _id: user._id }, { $set: { name: 'Written' } });
    } finally {
      collection.findOne = original;
    }
    expect((await User.findById(user._id))?.name).toBe('Written');
    expect((await copyOf(post._id))?.name).toBe('Ada');
    expect(errors).toEqual([expect.objectContaining({ code: 'INLINE_SYNC_FAILED' })]);
  });

  it('reads the written document back from the primary', async () => {
    const { user } = await seed();
    await startInline();
    const collection = User.collection as unknown as {
      findOne: (filter: unknown, options?: { readPreference?: unknown }) => unknown;
    };
    const original = collection.findOne.bind(collection);
    const seen: unknown[] = [];
    collection.findOne = (filter, options) => {
      seen.push(options?.readPreference);
      return original(filter, options);
    };
    try {
      await User.updateOne({ _id: user._id }, { $set: { name: 'Primary' } });
    } finally {
      collection.findOne = original;
    }
    expect(seen).toEqual(['primary']);
  });

  it('syncs only the document a regex _id filter actually changed', async () => {
    await Label.create([
      { _id: 'a1', title: 'One' },
      { _id: 'a2', title: 'Two' },
    ]);
    const one = await Post.create({ title: 'p1', tagged: { _id: 'a1', title: 'One' } });
    const two = await Post.create({ title: 'p2', tagged: { _id: 'a2', title: 'Two' } });
    await startInline();

    await Label.updateOne({ _id: /^a/ }, { $set: { title: 'Changed' } });

    const changed = (await Label.find({ title: 'Changed' }).lean()).map((label) => label._id);
    expect(changed).toHaveLength(1);
    const copies = [
      (await Post.findById(one._id).lean<PostDoc>())?.tagged,
      (await Post.findById(two._id).lean<PostDoc>())?.tagged,
    ];
    expect(copies.filter((copy) => copy?.title === 'Changed').map((copy) => copy?._id)).toEqual(
      changed,
    );
  });

  it('fails the app’s write when a copy fails inside its transaction', async () => {
    const { user } = await seed();
    await ctx.connection.db?.command({
      collMod: 'posts',
      validator: { 'createdBy.name': { $ne: 'Forbidden' } },
      validationLevel: 'strict',
      validationAction: 'error',
    });
    await startInline();
    const session = await ctx.connection.startSession();
    try {
      await expect(
        session.withTransaction(async () => {
          await User.updateOne({ _id: user._id }, { $set: { name: 'Forbidden' } }, { session });
        }),
      ).rejects.toThrow();
    } finally {
      await session.endSession();
      await ctx.connection.db?.command({ collMod: 'posts', validator: {}, validationLevel: 'off' });
    }
    expect((await User.findById(user._id))?.name).toBe('Ada');
  });

  it('joins the caller’s transaction on save()', async () => {
    const { user, post } = await seed();
    await startInline();
    const session = await ctx.connection.startSession();
    try {
      await expect(
        session.withTransaction(async () => {
          const loaded = await User.findById(user._id).session(session);
          if (!loaded) throw new Error('missing user');
          loaded.name = 'Saved then aborted';
          await loaded.save();
          throw new Error('abort');
        }),
      ).rejects.toThrow('abort');
    } finally {
      await session.endSession();
    }
    expect((await copyOf(post._id))?.name).toBe('Ada');
  });
});

describe('inline mode together with stream mode', () => {
  it('never lets an inline write of one field block an older queued change to another', async () => {
    const { user, post } = await seed();
    // The stream is behind: it saved its position and stopped.
    let stream = await createSync({ connection: ctx.connection, onWarning: () => undefined });
    syncs.push(stream);
    await stream.start();
    await stream.stop();

    // 1. A write only the stream sees (raw driver): a rename.
    await ctx.connection
      .collection('users')
      .updateOne({ _id: user._id }, { $set: { name: 'Renamed raw' } });
    // Any other write on the server in between, as a busy server always has.
    await ctx.connection.collection('noise').insertOne({ at: new Date() });
    // 2. An inline write of a different synced field, while the stream is still behind.
    await startInline();
    await User.updateOne({ _id: user._id }, { $set: { avatar: 'b.png' } });
    // 3. The stream catches up.
    stream = await createSync({ connection: ctx.connection, onWarning: () => undefined });
    syncs.push(stream);
    await stream.start();

    await waitFor(async () => (await copyOf(post._id))?.name === 'Renamed raw');
    expect(await copyOf(post._id)).toMatchObject({ name: 'Renamed raw', photo: 'b.png' });
  });
});
