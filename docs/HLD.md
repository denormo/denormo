# denormo — High-Level Design

> Source of truth for architecture decisions. If code and this document disagree, stop and ask before changing either.

## Overview

denormo keeps denormalized snapshot fields in MongoDB eventually consistent with their source documents, using change streams and a declarative, opt-in sync contract. Example: when `users.name` changes, every `posts.createdBy.name` copy is updated within seconds, without application code.

**Problem.** Teams embed snapshots like `Post.createdBy = { _id, name, avatar }` for read speed. When the source changes, copies drift. Today each team hand-writes sync code in hooks, which misses bulk writes, raw driver writes, and writes from other services.

**Goals**

- Declarative, per-field opt-in: each embedded field is either synced or frozen.
- Catch every write to a source collection, regardless of which app or tool made it.
- Correct under retries, restarts and out-of-order events (idempotent, version-guarded).
- Handle large fan-out (one source doc referenced by millions of targets) without hurting the primary workload.
- Detect and repair drift with a reconcile command.
- Mongoose-first developer experience, with an ODM-agnostic core from day one.

**Non-goals (v1)**

- Strong (transactional) consistency between source and copies.
- Cross-database sync (MongoDB to Postgres, Elasticsearch, etc.).
- Sync across separate MongoDB clusters.
- Being a general CDC platform like Debezium.

## Architecture overview

A sync worker watches source collections, plans guarded updates, records them as durable jobs, and fans them out to target collections. All state lives in the same MongoDB deployment, so nothing else needs to be run.

```
 Mongoose schemas ──> Mongoose adapter ──> Compiled config (relations + reverse map)
                                                   │
 ┌─ Sync worker (one or more, coordinated by leases) ───────────────────────────┐
 │                                                 ▼                             │
 │  Stream listener ──> Filter + planner ──> Job queue ──> Fan-out executor      │
 │        ▲                                      ▲   ▲            │              │
 │        │                     Reconciler ──────┘   │            │              │
 └────────┼─────────────────────────┼───────────────┼────────────┼──────────────┘
          │ change events           │ reads both    │ jobs,      │ guarded
          │                         ▼ sides         ▼ tokens     ▼ updateMany
 ┌─ MongoDB replica set ────────────────────────────────────────────────────────┐
 │   users (source)               _denormo_* (state)         posts (targets)    │
 └──────────────────────────────────────────────────────────────────────────────┘
```

Writes from any app or tool land in source collections; the worker turns their change events into jobs and version-guarded updates, and the reconciler repairs anything the stream missed.

## Package layering

The core depends only on the official `mongodb` driver; Mongoose knowledge lives entirely in an adapter that compiles schemas into a plain config object.

| Package | Responsibility | Depends on |
| --- | --- | --- |
| `@denormo/core` | Config types and validation, reverse map, update planner, change-stream runner, fan-out executor, state store, reconcile, read-repair helpers | `mongodb` |
| `@denormo/mongoose` | `Snapshot` schema type, `snapshotSource` plugin, schema walker that emits core config, collection-name resolution | `@denormo/core`, `mongoose` (peer) |
| `@denormo/cli` | `sync start`, `reconcile`, `status`, `validate` commands | `@denormo/core` |
| `@denormo/native` (later) | Config builder for native-driver users | `@denormo/core` |

Rules that keep the core clean:

- Core never imports Mongoose; enforce with a lint rule and by not listing it as a dependency.
- Core speaks in collection names and field paths, never model names.
- Core tests run against plain config only.
- Monorepo from day one (pnpm workspaces), with versions released together.

## Configuration contract

Sources declare what may be copied; targets opt in to a subset and choose sync or frozen per field. At startup both sides compile into one plain, versioned config object, which is the real public API.

**Source side (Mongoose)**

```js
UserSchema.plugin(snapshotSource, {
  expose: ['name', 'avatar', 'role'],   // passwordHash can never be copied
  // versions come from change-event clusterTime, no source hooks needed
});
```

**Target side (Mongoose)**

```js
createdBy: {
  type: Snapshot,
  ref: 'User',
  fields: {
    name:   { sync: true },
    avatar: { sync: true, as: 'photo' },
    role:   { sync: false },              // frozen at write time
  },
  onDelete: 'markDeleted',                // 'markDeleted' | 'unset' | 'keep'
  mode: 'stream',                         // 'stream' | 'readRepair'
}
```

**Compiled config (core)**

```json
{
  "version": 1,
  "sources": {
    "users": { "expose": ["name", "avatar", "role"] }
  },
  "relations": [
    {
      "id": "posts.createdBy",
      "source": "users",
      "target": "posts",
      "path": "createdBy",
      "array": false,
      "fields": [
        { "from": "name", "to": "name", "sync": true },
        { "from": "avatar", "to": "photo", "sync": true },
        { "from": "role", "to": "role", "sync": false }
      ],
      "onDelete": "markDeleted",
      "mode": "stream"
    }
  ]
}
```

**Array relations.** `path` marks the array segment with `[]`, and `array` is `true`: `"path": "comments[].author"` puts a snapshot inside each `comments` element, `"path": "likedBy[]"` makes each element a snapshot. Exactly one `[]` is allowed; nested arrays are not supported.

**Startup validation** fails fast when a target asks for a field the source does not expose, a path does not exist, the deployment is not a replica set (change streams require one), or the index on `<path>._id` is missing (warn, or create when `autoIndex` is on).

**Reverse map.** The engine indexes relations by source field: `users.name → [posts.createdBy.name, posts.comments.$[c].author.name]`. A change event is matched against this map so only affected relations run.

**Embedded shape.** Every snapshot stores `_id`, the copied fields, and `_v` (the source version it reflects, a BSON Timestamp). `_v` drives ordering, idempotency and read-repair. Snapshots written by the application at insert must carry a `_v` too: the guard's `$lt` never matches a missing field, so a snapshot without `_v` would never sync. The adapter sets it (Phase 1). Which value to use is open: `Timestamp(0, 0)` lets an older in-flight event overwrite a fresh copy, while the insert's `operationTime` can skip events between the app's read and its insert (the known race below).

## Sync engine

One change stream per source collection feeds a planner that turns each relevant event into guarded, idempotent `updateMany` jobs. The version guard uses the event's `clusterTime`, so ordering is correct even when events are retried or processed late, and sources need no cooperating code.

**Per-event flow**

1. **Watch.** `db.collection('users').watch(pipeline, { fullDocument: 'updateLookup', resumeAfter })`, with a `$match` that keeps only `update`, `replace` and `delete` events touching exposed fields.
2. **Filter.** For updates, intersect `updateDescription.updatedFields` and `removedFields` with the source's synced fields. No overlap means the event is acknowledged and skipped (for example a `lastLoginAt` change).
3. **Plan.** Look up affected relations in the reverse map. For each, build one update: filter `{ '<path>._id': srcId, '<path>._v': { $lt: clusterTime } }`, `$set` the changed synced fields plus `<path>._v`.
4. **Arrays.** For array paths, use `arrayFilters`: `$set: { 'comments.$[c].author.name': v }` with `arrayFilters: [{ 'c.author._id': srcId, 'c.author._v': { $lt: clusterTime } }]`.
5. **Enqueue.** Write a job to the `_denormo_jobs` collection, then advance the resume token. The token only moves after the job is durably recorded.
6. **Execute.** The fan-out executor runs the job in batches and marks it done.

**Why this is correct**

- **Out-of-order.** `$lt: clusterTime` means an older event can never overwrite a newer value. Updates have no value conditions, so a snapshot that already holds the new values still gets the newer `_v`; otherwise a value that returns to an earlier state (A → B → A) could be overwritten by a late B event.
- **Idempotent.** Replaying an event matches zero documents the second time.
- **Deletes.** A `delete` event applies `onDelete`: `markDeleted` sets `<path>.deleted: true`, `unset` removes the embed, `keep` does nothing.
- **Replace events.** Treated as an update of every synced field, using `fullDocument`. Synced fields missing from the replacement are passed to the planner as `removed`, so their copies are unset rather than left stale.

**Known race.** An app reads a user, the user is renamed and synced, then the app inserts a post with the old name. That post was not in scope when the event ran. Mitigations: an optional target-insert watcher that verifies fresh snapshots, plus periodic reconcile.

## Nested snapshots

Nested snapshots work by cascading: when a synced copy is itself a source for another relation, the sync write produces its own change event, which the engine handles like any other.

**Example.** `posts.createdBy` copies from `users`, and `feedItems.post` copies `title` and `createdBy.name` from `posts`. A user rename updates posts first; those post updates emit events that then update feed items.

**Safeguards**

- **Cycle detection.** At startup the engine builds a graph of relations, linking A to B when a path A writes overlaps a field B syncs, and refuses configs with cycles. There is no opt-out: sync updates always advance `_v`, so they always write, and a cycle would loop.
- **Termination.** Without cycles, every cascade ends after at most `maxCascadeDepth` levels. Replaying an event writes nothing, because the version guard no longer matches.
- **Depth limit.** `maxCascadeDepth` (default 3) caps how far a change can travel; deeper chains fail validation.
- **Latency.** Each level adds one round of stream processing. Reconcile processes relations in dependency order, upstream first.

## Sync modes

Two delivery modes share one planner, so filters, version guards and array handling behave identically. `stream` is recommended for production; `inline` is a convenience for development, tests and small apps.

```js
createSync({ mode: 'stream' })   // worker + change streams
createSync({ mode: 'inline' })   // hooks run the planned updates in the same request
```

| | `inline` | `stream` |
| --- | --- | --- |
| Trigger | Mongoose `post('save')`, `post('findOneAndUpdate')`, `post('updateOne')` hooks on source models | Change stream on each source collection |
| Freshness | Immediate, in the same request | Eventual, typically under a second |
| Catches | Only writes made through Mongoose document and single-doc query APIs | Every write, from any client |
| Fan-out | Single `updateMany`, capped by `inlineMaxTargets` (default 1,000); above it, handed to the queue if a worker runs, else logged as skipped | Batched, throttled, resumable |
| Atomicity | Optional: `transactional: true` runs source and copy writes in one transaction | None, eventually consistent |
| Requirements | None beyond Mongoose (transactions need a replica set) | Replica set or sharded cluster + worker process |

**Inline mode details**

- The hook reads the changed fields from the query or document diff and passes them to the same planner the stream uses. The version comes from the write's `session.operationTime`, the same cluster clock as the stream's `clusterTime`, so versions from both modes compare correctly.
- Writes the hooks cannot see (`updateMany`, `bulkWrite`, raw driver, other services) are not synced. Startup logs a warning listing these blind spots, and `validate` reports them.
- Running `reconcile` periodically closes the gap left by unseen writes.

**Switching modes.** Moving from `inline` to `stream` is a config change plus a one-off `reconcile`. Both modes can run together during migration: the version guard makes double application harmless.

## Fan-out, batching and throttling

Large jobs are split into `_id`-ordered batches so one popular source document can never lock up the cluster or block other syncs. Small jobs run as a single `updateMany`.

**Strategy**

1. Count or estimate matches with the relation's filter. Below `smallJobThreshold` (default 1,000), run one `updateMany`.
2. Above it, page through targets by `_id`: find the next `batchSize` ids (default 500) after a cursor, run `updateMany({ _id: { $in: ids }, ...guard })`, store the last `_id` on the job.
3. Between batches, sleep per the throttle policy.
4. A crash mid-job resumes from the stored cursor; the version guard makes re-running a batch harmless.

**Throttle policy:** fixed `maxDocsPerSecond` per worker; adaptive back-off on batch latency or replication lag; priority so small jobs jump ahead of large ones.

**Coalescing.** If a newer event for the same source document and relation arrives while a job is queued, the jobs merge using the latest values and `clusterTime`.

**Write concern.** Batches default to `w: 'majority'`.

## State storage

All engine state lives in MongoDB in internal collections (prefix configurable).

| Collection | Holds | Key fields |
| --- | --- | --- |
| `_denormo_cursors` | One resume token per watched source | `source`, `resumeToken`, `updatedAt`, `ownerId` |
| `_denormo_jobs` | Planned fan-out jobs and their progress | `relationId`, `srcId`, `values`, `clusterTime`, `status`, `lastId`, `attempts`, `error` |
| `_denormo_locks` | Leases for stream ownership and job claims | `name`, `ownerId`, `expiresAt` (TTL index) |
| `_denormo_versions` | Latest source versions for read-repair relations | `srcId`, `source`, `clusterTime`, `values` |

**Multiple workers.** Each source stream is owned by one worker at a time via a lease, renewed every few seconds. If the owner dies, the lease expires and another worker resumes from the stored token. Jobs are claimed with `findOneAndUpdate` on `status: 'pending'`.

**Lost resume token.** If the token has fallen off the oplog, the engine logs an error, starts a fresh stream from now, and schedules a reconcile for that source.

**Job retention.** Completed jobs get a TTL (default 7 days); failed jobs are kept until retried or cleared.

## Reconciliation and backfill

Reconcile scans a relation, compares each snapshot with its source, and repairs mismatches through the same guarded update path.

1. Aggregate distinct `<path>._id` values in the target collection, in pages.
2. Fetch the matching source documents in one `$in` query per page, projecting only synced fields.
3. For each source, issue a guarded `updateMany` where any synced field differs.
4. Record progress on a reconcile job, so it resumes after a crash.

Triggers: manual (`npx denormo reconcile --relation posts.createdBy`), after a lost resume token, when config adds a field to `sync`, or on a schedule. `--dry-run` reports mismatch counts without writing.

## Read-repair mode

For relations with huge fan-out and rare reads, `mode: 'readRepair'` replaces write-time fan-out with a version record plus repair on read.

1. The stream upserts `{ srcId, clusterTime, values }` into `_denormo_versions` instead of fanning out.
2. On read, a helper fetches versions for the snapshot `_id`s in the result set in one `$in` query.
3. Stale snapshots are patched in the returned objects immediately.
4. The patch is written back asynchronously with the version guard.

Mongoose: opt-in `post('find')` / `post('findOne')` hooks. Native: `repair(docs, relationId)`. Use for display-only fields, not fields you filter or sort on.

## Failure handling, observability and deployment

| Failure | Behaviour |
| --- | --- |
| Transient write error or failover | Retry the batch with exponential backoff |
| Job fails `maxAttempts` times (default 5) | Mark `failed`, emit an event and metric, keep the stream moving |
| Stream error | Reopen from the stored resume token |
| Resume token lost | Restart stream from now and schedule a reconcile |
| Worker crash | Lease expires, another worker takes over; claimed jobs return to `pending` after timeout |
| Invalid config at startup | Refuse to start, naming the relation and field |

**Observability:** metrics hooks (stream lag, jobs pending/running/failed, docs updated per second, batch latency, reconcile mismatches); structured logs with `relationId`, `srcId`, `jobId`; events `job:done`, `job:failed`, `stream:restarted`, `drift:found`; `npx denormo status`.

**Deployment:** embedded (`startSync()` in the app process) is the default; a dedicated worker (`npx denormo sync start`) is recommended as load grows; serverless is not supported in v1.

**Requirements.** MongoDB 6.0+ replica set or sharded cluster, Node.js 22+, and an oplog window larger than the longest expected worker outage.

## Public API surface

```js
import { Snapshot, snapshotSource, createSync } from '@denormo/mongoose';

const sync = await createSync({
  connection: mongoose.connection,
  models: [User, Post, Comment],     // or omit to scan all registered models
  mode: 'stream',                    // 'stream' | 'inline'
  workerId: process.env.HOSTNAME,
  batchSize: 500,
  throttle: { maxDocsPerSecond: 5000 },
  autoIndex: false,
});

await sync.start();
sync.on('job:failed', (job) => alert(job));
await sync.reconcile({ relation: 'posts.createdBy', dryRun: true });
const status = await sync.status();
await sync.stop();                   // graceful: finish current batch, release leases
```

```js
import { createSyncEngine } from '@denormo/core';
const engine = await createSyncEngine({ db, config });   // config = compiled object
```

Pure building blocks exported by `@denormo/core` (Phase 0), shared by the stream runner and inline mode:

```js
import {
  CONFIG_VERSION,            // 1
  validateConfig,            // (config, { maxCascadeDepth }) => problems[]
  assertValidConfig,         // throws DenormoConfigError listing every problem
  buildReverseMap,           // config => source → field → [{ relation, field }]
  planUpdates,               // (config, reverseMap, event) => [{ relationId, collection, filter, update, arrayFilters? }]
  DenormoConfigError,
} from '@denormo/core';
```

`planUpdates` takes a driver-agnostic event `{ op: 'update' | 'replace' | 'delete', source, srcId, version, changed, removed }`, where `version` is a BSON Timestamp and `changed`/`removed` use dot-notation paths.

## Roadmap

Pure logic (validation rules, planning for every event type) lands in Phase 0 because it is cheap to test and shapes the planner. Later phases add the runtime pieces that exercise it.

| Phase | Scope | Exit criterion |
| --- | --- | --- |
| 0. Core skeleton | Config types, validation (expose checks, cycle detection, cascade-depth limit), reverse map, planner including onDelete policies (pure functions, fully unit-tested) | Planner produces correct updates for flat and array paths |
| 1. MVP | Mongoose adapter, change-stream runner, resume tokens, single worker, small jobs only, plus inline mode sharing the same planner | Rename propagates end to end on a replica set in integration tests |
| 2. Scale | Batched fan-out, throttling, coalescing, leases, multiple workers | 1M-target fan-out completes without blocking other relations |
| 3. Safety net | Reconcile, dry run, backfill on config change, metrics, CLI | Injected drift is detected and repaired |
| 4. Source contracts | `expose` enforcement in the Mongoose adapter, delete-event handling in the stream runner, target-insert watcher, end-to-end cascade tests | Deletes and multi-level cascades propagate end to end; unexposed field requests fail at startup |
| 5. Read-repair | Version records, read hooks, `repair()` helper | Reads return fresh values with zero fan-out writes |
| 6. Agnostic | `@denormo/native` config builder, docs for other ODMs | Same integration suite passes without Mongoose |

## Decisions

- **Name:** denormo, published under the `@denormo` scope.
- **Minimum MongoDB version:** 6.0. CI tests against 6.0, 7.0 and 8.0.
- **Default deployment:** embedded mode; dedicated worker recommended as load grows.
- **Nested snapshots:** supported in v1 through cascading, with cycle detection and a depth limit.
- **Licence:** MIT.
