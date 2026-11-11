# denormo

Keep denormalized copies in MongoDB in sync with their source, declaratively.

You embed a small copy of a user in every post (`post.createdBy = { _id, name, avatar }`) so reads need no `$lookup`. Then the user renames themselves, and every copy is stale. denormo keeps those copies up to date for you: you declare which fields a copy holds, and denormo watches the source and rewrites the copies when it changes. No hand-written sync code, no forgotten `updateMany`.

```js
// users: { _id: 1, name: 'Ada', avatar: 'a.png', passwordHash: '…' }
// posts: { title: 'Hello', createdBy: { _id: 1, name: 'Ada', avatar: 'a.png' } }

await User.updateOne({ _id: 1 }, { $set: { name: 'Ada Lovelace' } });

// moments later, every post by Ada:
// posts: { title: 'Hello', createdBy: { _id: 1, name: 'Ada Lovelace', avatar: 'a.png', _v: Timestamp(…) } }
```

> [!WARNING]
> **Experimental (0.x).** The API may change between minor versions. What works today: copies at any depth, copies of copies, stream and inline sync, resume after restart, transactions. **Not yet:**
>
> - **Deletes are ignored.** Deleting a source leaves its copies as they are, whatever `onDelete` says (Phase 4).
> - **No backfill or repair.** Copies that were already stale before denormo started, or before a field was added to a snapshot, are not fixed (Phase 3).
> - **One stream worker.** Run stream mode in a single process (see [Running in production](#running-in-production)); several workers sharing the load comes in Phase 2.
> - **`expose` is checked at `createSync`, not when copies are written.** See [Sources](#sources-what-may-be-copied) (Phase 4).
> - **Large bursts are slow.** Changes are applied one at a time. A burst of hundreds of source changes that each touch many copies can take a minute or more to settle (batching is Phase 2).
>
> See the [roadmap](#roadmap).

## Contents

- [Requirements](#requirements)
- [Install](#install)
- [Quick start](#quick-start)
- [Sources: what may be copied](#sources-what-may-be-copied)
- [Snapshots: the copies](#snapshots-the-copies)
- [Copies of copies](#copies-of-copies)
- [Sync modes: stream and inline](#sync-modes-stream-and-inline)
- [`createSync` options](#createsync-options)
- [Errors and warnings](#errors-and-warnings)
- [How it works](#how-it-works)
- [Running in production](#running-in-production)
- [Packages](#packages)
- [Roadmap](#roadmap)
- [Contributing](#contributing)

## Requirements

- Node.js 22.12 or later
- MongoDB 6.0 or later, as a **replica set** or sharded cluster. Change streams and cluster times need one; a single-node replica set is fine for development (`mongod --replSet rs0`, then `rs.initiate()`).
- Mongoose 8 or 9

## Install

```sh
npm install denormo mongoose
```

`denormo` is the short name of `@denormo/mongoose`; both install the same code (and `@denormo/core` with it). Use whichever name you like, but use one name throughout an app.

## Quick start

```js
import mongoose from 'mongoose';
import { Snapshot, snapshotSource, createSync } from 'denormo';

// 1. The source: list the fields other collections may copy.
const userSchema = new mongoose.Schema({ name: String, avatar: String, passwordHash: String });
userSchema.plugin(snapshotSource, { expose: ['name', 'avatar'] });

// 2. The copy: a Snapshot path names its source and the fields it keeps.
const postSchema = new mongoose.Schema({
  title: String,
  createdBy: {
    type: Snapshot,
    ref: 'User',
    fields: { name: { sync: true }, avatar: { sync: true } },
  },
});

const User = mongoose.model('User', userSchema);
const Post = mongoose.model('Post', postSchema);

await mongoose.connect('mongodb://localhost:27017/app?replicaSet=rs0');

// 3. Start syncing. Define every model first: createSync reads the models on the connection.
const sync = await createSync({ connection: mongoose.connection });
await sync.start();

// Assigning a document stores only _id and the declared fields.
const ada = await User.create({ name: 'Ada', avatar: 'a.png', passwordHash: 'secret' });
await Post.create({ title: 'Hello', createdBy: ada }); // createdBy: { _id, name, avatar }

await User.updateOne({ _id: ada._id }, { $set: { name: 'Ada Lovelace' } });
// The post's createdBy.name becomes 'Ada Lovelace' shortly after.

// On shutdown:
await sync.stop();
```

Add an index on each copy's `_id` (here `posts.createdBy._id`), or every sync update scans the collection (in stream mode, `createSync` warns about it). See [Indexes](#indexes).

## Sources: what may be copied

A model whose fields are copied elsewhere is a **source**. Mark it with the `snapshotSource` plugin and list the fields that may be copied:

```js
userSchema.plugin(snapshotSource, { expose: ['name', 'avatar', 'role'] });
```

- A snapshot that asks for a field the source does not expose (`passwordHash`) fails at `createSync` with `FIELD_NOT_EXPOSED`.
- **Not checked when copies are written (yet).** Assigning a document stores every field the snapshot declares, exposed or not. A process that writes copies without calling `createSync` (for example a web tier that leaves syncing to a worker) does not see the error. Enforcement at write time is Phase 4; until then, keep the snapshot declarations and `expose` lists in sync and run `createSync` in your tests.
- Add the plugin before the model is compiled (`mongoose.model(...)`). Mongoose ignores hooks added later, and inline mode needs the plugin's hooks.
- A model referenced by a `Snapshot` path must have the plugin, or `createSync` fails with `SOURCE_NOT_DECLARED`.
- Nested fields use dot notation: `expose: ['profile.displayName']`.

## Snapshots: the copies

A **snapshot** is a schema path of type `Snapshot`: an embedded object holding the source's `_id` and the fields you choose.

```js
createdBy: {
  type: Snapshot,
  ref: 'User',                          // source model name
  fields: {
    name:   { sync: true },             // kept up to date
    avatar: { sync: true, as: 'photo' },// stored as createdBy.photo
    role:   { sync: false },            // frozen: the value at write time, never updated
  },
  onDelete: 'markDeleted',              // stored for Phase 4; deletes are not handled yet
}
```

| Option     | Meaning                                                                                                                                                         |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ref`      | Name of the source model. Must be a model on the same connection (`UNKNOWN_REF` otherwise).                                                                     |
| `fields`   | Source field → `{ sync, as? }`. `sync: true` keeps the copy current; `sync: false` keeps the value from when the copy was written. `as` renames it in the copy. |
| `onDelete` | `'keep'` (default), `'markDeleted'` (set `deleted: true`) or `'unset'` (remove the copy). **Not applied yet**: deletes are ignored until Phase 4.               |
| `mode`     | `'stream'` (default). `'readRepair'` is reserved for Phase 5; a relation in that mode is **not synced** today, so leave it out.                                 |

### Writing copies

Assign the source document (or any object with its `_id` and fields) and denormo keeps only what the snapshot declares:

```js
post.createdBy = user; // stores { _id, name, photo, role }; passwordHash and the rest are dropped
await Post.updateOne({ _id }, { $set: { createdBy: user } }); // same rule in update calls
await Post.updateOne({ _id }, { $push: { likedBy: user } }); // and in array operators
```

The same filtering applies to `lean()` results, plain objects, `$set`, `$push`, `bulkWrite` and discriminator documents of the `ref` model. Source names are stored under their `as` names. Values are copied raw (getters are not applied). You never write `_v` yourself: a copy without `_v` is filled in by the first sync.

Writes made outside Mongoose (the raw driver, another service) are not filtered, but sync updates still only touch declared fields.

### Where snapshots can live

```js
const postSchema = new mongoose.Schema({
  createdBy: { type: Snapshot, ref: 'User', fields: { name: { sync: true } } }, // top level
  meta: { lastEditor: { type: Snapshot, ref: 'User', fields: { name: { sync: true } } } }, // nested
  comments: [
    { text: String, author: { type: Snapshot, ref: 'User', fields: { name: { sync: true } } } },
  ], // inside each element of a document array
  likedBy: [{ type: Snapshot, ref: 'User', fields: { name: { sync: true } } }], // array of snapshots
});
```

One array level per path is supported. A snapshot inside a document array inside another document array fails with `INVALID_PATH`; an array of arrays of snapshots (`[[{ type: Snapshot }]]`) is ignored, with no error and no sync. In arrays, every element that copies the changed source is updated.

## Copies of copies

A collection that holds copies can itself be a source. Expose the copied path, and another collection can copy from it:

```js
postSchema.plugin(snapshotSource, { expose: ['title', 'createdBy.name'] });

const feedSchema = new mongoose.Schema({
  post: {
    type: Snapshot,
    ref: 'Post',
    fields: { title: { sync: true }, 'createdBy.name': { sync: true, as: 'authorName' } },
  },
});
```

A user rename updates `posts.createdBy.name`; that change is itself a post change, so the feed items' `post.authorName` follows. Each level adds one round of processing.

- **Depth limit.** A change may flow through at most 3 relations by default (`validate: { maxCascadeDepth }` changes it). Deeper chains fail with `CASCADE_TOO_DEEP`.
- **No cycles.** If copies would feed back into their own source (A copies from B, B copies from A on overlapping fields), `createSync` fails with `CYCLE`. There is no override: a cycle would update forever.
- Copies of copies are updated by **stream mode only**; inline mode updates one level.

## Sync modes: stream and inline

|                  | `stream` (default, recommended)                                      | `inline`                                                                                   |
| ---------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| How              | A change stream on each source collection, in your process           | Mongoose hooks on source models, in the request that writes the source                     |
| Freshness        | Eventual: usually well under a second, longer under heavy bursts     | Immediate: copies are updated before your write call resolves                              |
| Sees             | Every write, from any client or service                              | Only Mongoose `save()`, `updateOne`, `findOneAndUpdate`, `replaceOne`, `findOneAndReplace` |
| Copies of copies | Yes                                                                  | No                                                                                         |
| Transactions     | Applies changes after they commit                                    | Copies join your session and commit or roll back with it                                   |
| Runs             | In one process (see [Running in production](#running-in-production)) | In every app process                                                                       |

### Stream mode

```js
const sync = await createSync({ connection: mongoose.connection }); // mode: 'stream'
await sync.start();
```

- `start()` opens one change stream per source collection. Each stream's position is saved in MongoDB, so after a restart (or `stop()` then `start()`) it continues where it left off; changes made while it was down are applied on the next start.
- The **first** start begins from "now". Changes made before denormo ever ran are not synced (no backfill yet).
- If applying a change fails (for example a write error), that source's stream stops and `onError` receives a `SOURCE_STOPPED` error. Call `start()` again to restart the stopped sources; they resume from the change that failed. The other sources keep running.
- `stop()` waits for the change in flight, then closes the streams.

### Inline mode

```js
const sync = await createSync({ connection: mongoose.connection, mode: 'inline' });
await sync.start();

await User.updateOne({ _id }, { $set: { name: 'Ada Lovelace' } });
// Every post's createdBy.name is already updated here.
```

- Covered writes: `doc.save()` on an existing document, `updateOne`, `findOneAndUpdate` (and `findByIdAndUpdate`), `replaceOne`, `findOneAndReplace`. Writes that touch no synced field cost nothing extra.
- **Not seen:** `updateMany`, `bulkWrite`, deletes, raw driver writes, other services, and copies of copies. `start()` logs a warning listing these. Run stream mode as well if any of them happen in your app.
- **Transactions:** when the write runs in a session (`{ session }` or Mongoose's `transactionAsyncLocalStorage`), the copies are written in that session and commit or roll back with your transaction.
- **Failures:** a failed copy update after your write is reported through `onError` (`INLINE_SYNC_FAILED`) and your write still succeeds. Inside a transaction, the error is thrown so the transaction can abort. Work that runs **before** your write (the cluster-time read, and the `_id` lookup described below) fails your write if it fails.
- **Big fan-outs are skipped:** if more than `inlineMaxTargets` documents (default 1,000) hold copies to update for one relation, that relation is skipped with a warning. Stream mode syncs those. The limit counts documents, not copies: one post with many matching `comments` counts once.
- Each write that touches a synced field costs extra round trips: a cluster-time read before the write; for `updateOne` and `replaceOne` whose filter is not an exact `_id`, an `_id` lookup before it; a read-back of the source after it (not for `save()`, which uses the document in memory); and a count and an `updateMany` per affected snapshot path.
- Needs a replica set too (versions come from the cluster time).

### Both together

Inline for read-your-own-writes in the request, stream for everything inline cannot see:

```js
const inline = await createSync({ connection, mode: 'inline' });
const stream = await createSync({ connection, mode: 'stream' });
await inline.start();
await stream.start();
```

Every update carries a version check, so a copy written by both modes, in any order, ends at the newest value.

## `createSync` options

```js
const sync = await createSync({
  connection: mongoose.connection, // required; connected or connecting
  models: [User, Post], // default: every model on the connection
  mode: 'stream', // 'stream' (default) or 'inline'
  inlineMaxTargets: 1000, // inline: most documents one relation may update per write
  validate: { maxCascadeDepth: 3 }, // longest chain of copies of copies
  autoIndex: false, // stream: create missing <path>._id indexes instead of warning
  statePrefix: '_denormo_', // prefix of denormo's own collections
  onError: (error) => console.error(error), // runtime errors (default shown)
  onWarning: (message) => console.warn(`[denormo] ${message}`), // default shown
});

sync.config; // the compiled config: every source and relation denormo found
await sync.start();
await sync.stop();
```

`createSync` reads your schemas, checks the whole configuration and the deployment, and throws before anything starts if something is wrong. `start()` rejects with `ALREADY_STARTED` if everything is already running.

## Errors and warnings

Errors denormo raises itself are `DenormoConfigError` (the configuration is wrong; thrown by `createSync` or `snapshotSource`) or `DenormoRuntimeError` (something failed while running). Both have a `code`, and a `relationId` such as `posts.createdBy` when one relation is at fault. For errors found while validating the whole config, `DenormoConfigError` lists every problem in `problems` (empty for errors the Mongoose adapter raises while reading schemas); `error.message` always describes them. `DenormoRuntimeError` has the `source` collection and the original error as `cause` when relevant. Errors from the MongoDB driver or Mongoose (a lost connection, a failed cast) pass through unchanged.

```js
import { DenormoConfigError } from 'denormo';

try {
  await createSync({ connection });
} catch (error) {
  if (error instanceof DenormoConfigError) console.error(error.code, error.message);
  throw error;
}
```

**Configuration errors**

| Code                      | Meaning and fix                                                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `INVALID_SNAPSHOT_SOURCE` | `snapshotSource` was called without `{ expose: string[] }`.                                                                        |
| `UNKNOWN_REF`             | A snapshot's `ref` is not a model on this connection. Check the name; define the model before `createSync`.                        |
| `SOURCE_NOT_DECLARED`     | The `ref` model has no `snapshotSource` plugin. Add it, with the fields to expose.                                                 |
| `FIELD_NOT_EXPOSED`       | A snapshot asks for a field its source does not expose. Expose it, or remove it from the snapshot.                                 |
| `INVALID_SNAPSHOT_FIELD`  | A `fields` entry is not `{ sync: boolean, as?: string }`.                                                                          |
| `INVALID_FIELD`           | A field name or `as` is not plain dot notation (empty, or with `$` or `[...]`).                                                    |
| `DUPLICATE_TARGET_FIELD`  | Two fields of one snapshot are stored under the same name. Use `as` to tell them apart.                                            |
| `RESERVED_TARGET_FIELD`   | A field would be stored as `_id`, `_v` or `deleted`, which denormo writes itself. Rename it with `as`.                             |
| `INVALID_PATH`            | A snapshot path is not supported, for example inside two levels of document arrays.                                                |
| `DUPLICATE_RELATION_ID`   | Two models share one collection and both declare the same snapshot path. Give them separate collections or remove one declaration. |
| `INVALID_ON_DELETE`       | `onDelete` is not `'keep'`, `'markDeleted'` or `'unset'`.                                                                          |
| `INVALID_MODE`            | A snapshot's `mode` is not `'stream'` or `'readRepair'`.                                                                           |
| `CYCLE`                   | Copies would feed back into their own source. Break the loop; see [Copies of copies](#copies-of-copies).                           |
| `CASCADE_TOO_DEEP`        | A chain of copies of copies is longer than `maxCascadeDepth`. Shorten it or raise the limit.                                       |
| `UNSUPPORTED_MODE`        | `createSync` got a `mode` other than `'stream'` or `'inline'`.                                                                     |

`UNKNOWN_SOURCE` and `UNSUPPORTED_CONFIG_VERSION` only occur when you build a config by hand with `@denormo/core`.

**Runtime errors**

| Code                   | Meaning and fix                                                                                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `NOT_CONNECTED`        | The connection was closed when `createSync` ran. Connect first.                                                                                                                                  |
| `NOT_REPLICA_SET`      | The server is a standalone `mongod`. Run a replica set (a single node is fine).                                                                                                                  |
| `ALREADY_STARTED`      | `start()` was called while everything was running, or a second inline sync was started on the same connection.                                                                                   |
| `SOURCE_STOPPED`       | Sent to `onError`: one source's stream stopped (see `cause`). Fix the cause and call `start()` again; it resumes from the change that failed.                                                    |
| `INLINE_SYNC_FAILED`   | Sent to `onError`: copies of one inline write were not updated (see `cause`). Stream mode, if running, catches up.                                                                               |
| `NO_OPERATION_TIME`    | The server did not report a cluster time, which replica sets always do. Check that you are connected to a replica set and not through an unusual proxy. In inline mode it fails the app's write. |
| `MISSING_CLUSTER_TIME` | A change event had no cluster time. Arrives as the `cause` of `SOURCE_STOPPED`, not on its own.                                                                                                  |

**Warnings** go to `onWarning`:

- a missing index on a copy's `_id` (see [Indexes](#indexes));
- inline mode's list of writes it cannot see, at start;
- an inline write skipped because one relation had more than `inlineMaxTargets` copies.

## How it works

1. `createSync` turns your Mongoose schemas into a plain config: the sources, and one **relation** per snapshot path (`posts.createdBy` copies `name` and `avatar` from `users`). It validates the config and checks that the server is a replica set and that indexes exist.
2. In stream mode, a change to a source document arrives as a change event. denormo finds the relations that copy the changed fields and updates every copy with one `updateMany` per relation, for example `updateMany({ 'createdBy._id': userId, … }, { $set: { 'createdBy.name': 'Ada Lovelace', 'createdBy._v': version } })`.
3. In inline mode, the same planner runs inside the Mongoose hook, right after your write.

### Versions

Each copy stores `_v`: the source version it reflects, a MongoDB cluster timestamp (the change's `clusterTime` in stream mode, the cluster time just before the write in inline mode). Every update only applies to copies whose `_v` is not newer than the change. So:

- replaying a change, or applying it from both modes, is harmless;
- an older change that arrives late never overwrites a newer value;
- a copy without `_v` (just written by your app) counts as oldest and is filled in by the first sync.

Copies of copies work the same way: the write to `posts` is itself a change to `posts`, and its own version drives the `feeditems` update.

### What denormo stores

- `_v` on every copy (and, in Phase 4, `deleted` for `onDelete: 'markDeleted'`). Leave both alone.
- `_denormo_cursors`: one document per source collection with the stream's saved position. Deleting a source's document makes its next start begin from "now" (changes in between are skipped).

### Indexes

Sync updates find copies by the source `_id`, so each snapshot path needs an index on its `_id`:

```js
postSchema.index({ 'createdBy._id': 1 });
postSchema.index({ 'comments.author._id': 1 });
postSchema.index({ 'likedBy._id': 1 });
```

Without them every sync update scans the whole collection. In stream mode, `createSync` warns about each missing one, and `autoIndex: true` creates them instead; inline mode does not check.

## Running in production

- **Run stream mode in one process.** Every process that calls `start()` in stream mode opens its own streams and does all the work again. The result is still correct, but the work is duplicated and the processes overwrite each other's saved positions. Pick one: a dedicated worker, or one app instance chosen by an environment variable:

  ```js
  if (process.env.DENORMO_WORKER === 'true') await sync.start();
  ```

  Inline mode is fine in every process.

- **Handle `onError`.** Send `SOURCE_STOPPED` to your alerting and call `sync.start()` again (for example after a delay) to resume the stopped sources.
- **Oplog window.** A stopped worker resumes from its saved position only while that position is still in the oplog. Keep the oplog window longer than your longest expected outage. If the position is gone, the source cannot resume: delete its document in `_denormo_cursors` to start from now. Copies changed in the gap stay stale until reconcile arrives (Phase 3).
- **Stop cleanly** on shutdown (`await sync.stop()`), so the change in flight finishes.
- **Bursts.** A copy that depends on another copy can lag behind during bursts of source writes (each change is applied one at a time). Batching arrives in Phase 2.
- Serverless functions are not supported: the stream needs a long-running process.

## Packages

| Package                                                                | Use it when                                                                           |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| [`denormo`](https://www.npmjs.com/package/denormo)                     | You use Mongoose. Same as `@denormo/mongoose`, shorter name.                          |
| [`@denormo/mongoose`](https://www.npmjs.com/package/@denormo/mongoose) | You use Mongoose and prefer the scoped name.                                          |
| [`@denormo/core`](https://www.npmjs.com/package/@denormo/core)         | You build your own adapter: the ODM-agnostic engine, driven by a plain config object. |

All packages are released together with the same version.

## Roadmap

| Phase              | Adds                                                                               | Status   |
| ------------------ | ---------------------------------------------------------------------------------- | -------- |
| 0–1 Core and MVP   | Config, validation, planner, Mongoose adapter, stream and inline modes             | Released |
| 2 Scale            | Job queue, batched and throttled fan-out, several workers with leases              | Next     |
| 3 Safety net       | Reconcile (find and fix stale copies), backfill, dry run, metrics, CLI             | Planned  |
| 4 Source contracts | Delete handling (`onDelete`), copies inserted later, more end-to-end cascade tests | Planned  |
| 5 Read-repair      | `mode: 'readRepair'`: fresh values on read with no fan-out writes                  | Planned  |
| 6 Other ODMs       | A config builder for the plain driver and other ODMs                               | Planned  |

The design is in [`docs/HLD.md`](docs/HLD.md).

## Contributing

Requires Node.js 22.12+ and pnpm. Integration tests download a MongoDB binary on first run.

```sh
pnpm install
pnpm build
pnpm test          # unit + integration
pnpm test:unit     # fast, no database
pnpm lint
pnpm typecheck
```

Changes to published packages need a changeset (`pnpm changeset`). Releases are described in [`docs/RELEASING.md`](docs/RELEASING.md).

## License

[MIT](LICENSE)
