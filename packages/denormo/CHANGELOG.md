# denormo

## 0.1.0

### Minor Changes

- First public release (experimental). Mongoose adapter with the `Snapshot` schema type and `snapshotSource` plugin; stream mode (change streams, resumable, version-guarded updates, copies of copies) and inline mode (copies updated inside the request that wrote the source). `denormo` is the short name for `@denormo/mongoose`, which now also exports `DenormoConfigError` and `DenormoRuntimeError`. Deletes, backfill, reconcile, batching and multiple workers are not in this release yet.

### Patch Changes

- Updated dependencies
  - @denormo/mongoose@0.1.0
