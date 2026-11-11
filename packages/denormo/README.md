# denormo

Keep denormalized copies in MongoDB in sync with their source, declaratively, with Mongoose. `denormo` is the short name of [`@denormo/mongoose`](https://www.npmjs.com/package/@denormo/mongoose): same code, shorter install.

> **Experimental (0.x).** The API may change between minor versions. Deletes are not handled yet, there is no backfill, and stream mode runs in one process. Read the [status notes](https://github.com/denormo/denormo#readme) before using it in production.

**[Full guide](https://github.com/denormo/denormo#readme)**: sources, snapshots, copies of copies, stream and inline modes, options, every error code, and running in production.

## Install

```sh
npm install denormo mongoose
```

Needs Node.js 22.12+, Mongoose 8 or 9, and MongoDB 6.0+ as a replica set (a single node is fine). `@denormo/core` is installed with it.

## Quick start

```js
import mongoose from 'mongoose';
import { Snapshot, snapshotSource, createSync } from 'denormo';

// The source lists the fields other collections may copy.
const userSchema = new mongoose.Schema({ name: String, avatar: String, passwordHash: String });
userSchema.plugin(snapshotSource, { expose: ['name', 'avatar'] });

// The copy names its source and the fields it keeps.
const postSchema = new mongoose.Schema({
  title: String,
  createdBy: {
    type: Snapshot,
    ref: 'User',
    fields: { name: { sync: true }, avatar: { sync: true } },
  },
});
postSchema.index({ 'createdBy._id': 1 });

const User = mongoose.model('User', userSchema);
const Post = mongoose.model('Post', postSchema);
await mongoose.connect(process.env.MONGODB_URI);

const sync = await createSync({ connection: mongoose.connection });
await sync.start();

const ada = await User.create({ name: 'Ada', avatar: 'a.png', passwordHash: 'secret' });
await Post.create({ title: 'Hello', createdBy: ada }); // stores { _id, name, avatar } only

await User.updateOne({ _id: ada._id }, { $set: { name: 'Ada Lovelace' } });
// Every post's createdBy.name follows shortly after.
```

Pass `mode: 'inline'` to update copies inside the request that writes the source instead; see the [guide](https://github.com/denormo/denormo#sync-modes-stream-and-inline).

## License

MIT
