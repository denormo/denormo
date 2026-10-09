# denormo

> **Status: in development.** Not ready for use; APIs will change without notice.

denormo keeps denormalized snapshot fields in MongoDB eventually consistent with their sources, using change streams and a declarative sync contract. When `users.name` changes, every `posts.createdBy.name` copy follows, without hand-written sync code.

See [`docs/HLD.md`](docs/HLD.md) for the design.

## Packages

| Package             | Description                                           |
| ------------------- | ----------------------------------------------------- |
| `@denormo/core`     | ODM-agnostic engine; depends only on `mongodb`        |
| `@denormo/mongoose` | Mongoose adapter that compiles schemas to core config |

## Usage (Mongoose)

```js
import { Snapshot, snapshotSource, createSync } from '@denormo/mongoose';

UserSchema.plugin(snapshotSource, { expose: ['name', 'avatar'] });
PostSchema.add({
  createdBy: {
    type: Snapshot,
    ref: 'User',
    fields: { name: { sync: true }, avatar: { sync: true } },
  },
});

const sync = await createSync({ connection: mongoose.connection });
await sync.start();
```

Requires a MongoDB replica set or sharded cluster (change streams).

## Development

Requires Node.js 22+ and pnpm.

```sh
pnpm install
pnpm build
pnpm test
pnpm lint
pnpm typecheck
```

## License

[MIT](LICENSE)
