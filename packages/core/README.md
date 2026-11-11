# @denormo/core

The ODM-agnostic engine behind [denormo](https://github.com/denormo/denormo): it keeps denormalized MongoDB snapshot fields in sync with their sources, driven by a plain config object. It depends only on the `mongodb` driver (`^6.20 || ^7`, a peer dependency).

> **Using Mongoose? Install [`denormo`](https://www.npmjs.com/package/denormo) instead.** It builds the config from your schemas and installs this package for you.

> **Experimental (0.x).** The API may change between minor versions. See the [status notes](https://github.com/denormo/denormo#readme).

Use this package directly only to build an adapter for another ODM or the plain driver. It exports:

- `createSyncEngine({ db, config, ... })`: the change-stream engine (`start()` / `stop()`).
- `createInlineSync({ db, config, ... })`: applies a source change to its copies immediately.
- `validateConfig`, `assertValidConfig`, `buildReverseMap`, `planUpdates`: the pure building blocks.
- `DenormoConfigError`, `DenormoRuntimeError`, and the config types (`CompiledConfig`, `RelationConfig`, ...).

The config format is described in the [design document](https://github.com/denormo/denormo/blob/main/docs/HLD.md#configuration-contract). A plain-driver config builder is planned (Phase 6).

## License

MIT
