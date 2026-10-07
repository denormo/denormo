# denormo

> **Status: in development.** Not ready for use; APIs will change without notice.

denormo keeps denormalized snapshot fields in MongoDB eventually consistent with their sources, using change streams and a declarative sync contract. When `users.name` changes, every `posts.createdBy.name` copy follows, without hand-written sync code.

See [`docs/HLD.md`](docs/HLD.md) for the design.

## Packages

| Package             | Description                                           |
| ------------------- | ----------------------------------------------------- |
| `@denormo/core`     | ODM-agnostic engine; depends only on `mongodb`        |
| `@denormo/mongoose` | Mongoose adapter that compiles schemas to core config |

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
