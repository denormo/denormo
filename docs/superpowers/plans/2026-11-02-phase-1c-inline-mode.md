# Phase 1c: Inline Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `createSync({ connection, mode: 'inline' })` updates snapshot copies inside the same request as the Mongoose write that changed the source, using the same planner and version guard as stream mode.

**Architecture:** The `snapshotSource` plugin registers dormant hooks on source schemas (Mongoose ignores hooks added after a model is compiled). While an inline sync is active on the connection, a hook on `save`, `updateOne`, `findOneAndUpdate`, `replaceOne` and `findOneAndReplace` works out which synced fields the write may change, runs the write in a session (the caller's, or its own), reads the new values back, and hands a `NormalizedChangeEvent` versioned with `session.operationTime` to core's new `createInlineSync().apply()`. That plans the guarded updates, skips relations with more copies than `inlineMaxTargets`, and executes the rest in the same session.

**Tech Stack:** TypeScript (strict, ESM), Mongoose 8/9, `@denormo/core`, Vitest 5, `mongodb-memory-server` replica set.

**Spec:** `docs/HLD.md` ("Sync modes", "Inline mode details") and `CLAUDE.md`. Previous plans: `docs/superpowers/plans/2026-10-08-phase-1a-core-sync-engine.md`, `docs/superpowers/plans/2026-10-09-phase-1b-mongoose-adapter.md`.

## Prototype findings (Docker replica set, Mongoose 9, 2026-11-02)

- A hook added to a schema after `model()` compiled it never fires. Hooks must be registered when the schema is defined, so the `snapshotSource` plugin registers them.
- With a session attached in a pre-hook (`doc.$session(s)` / `query.setOptions({ session: s })`), `session.operationTime` after the write equals the change event's `clusterTime` for `save`, `updateOne` and `findOneAndUpdate` (12/12 and 6/6 samples).
- Inside a transaction, `operationTime` before commit is slightly older than the commit `clusterTime`. Safe: the document is write-locked until commit, so no other change to it can fall in between, and the stream later re-applies the same values with the commit time.

## Decisions (user, 2026-11-02)

1. **Copies join the caller's session or transaction.** If the app writes with a session (inside a transaction or not), the copies are written in that session, so they commit or roll back with the app's transaction. The HLD's `transactional: true` flag (denormo wrapping every source write in its own transaction) is deferred to a later plan.

## Decisions in this plan (review these)

2. **Hooks live in the `snapshotSource` plugin** and do nothing unless an inline sync is active on the document's or query's connection.
3. **Writes covered:** `save()` of an existing document, `updateOne`, `findOneAndUpdate`, `replaceOne`, `findOneAndReplace`. Not covered (blind spots, listed in a warning when inline sync starts): `updateMany`, `bulkWrite`, `insertMany`/inserts (no copies exist yet), deletes (Phase 4), raw driver writes, other services, and cascades (copies of copies), since denormo's own copy writes do not go through Mongoose.
4. **New values are read back after the write**, in the same session, instead of being computed from the update document. This handles every operator (`$inc`, `$push`, `$rename`, pipelines) with one extra read of a single document by `_id`. Writes that touch no synced field skip all of it: no session, no read, no copy writes.
5. **`updateOne`/`replaceOne` with a filter that is not `{ _id: value }`** first read the matching `_id` and then pin the write to it (`query.where({ _id })`), so the hook syncs exactly the document that changed.
6. **Inline mode needs a replica set or sharded cluster**, like stream mode. The HLD table says "None beyond Mongoose", but standalone servers report no `operationTime`, so there is no version for the guard. `createSync({ mode: 'inline' })` checks this at startup. HLD updated.
7. **More copies than `inlineMaxTargets` (default 1,000) for one relation:** that relation is skipped and `onWarning` names it. Handing it to the job queue arrives with the queue in Phase 2; a stream worker running alongside syncs it anyway.
8. **A failed copy write does not fail the app's write** (the source write already succeeded): it is reported through `onError` with code `INLINE_SYNC_FAILED`. Inside the caller's transaction it is rethrown instead, so the transaction can abort.
9. **Core gets `createInlineSync`** (async: validates the config and checks for a replica set), and `executeOperations` gains a `session` option. Inside a transaction the copy writes carry no write concern (MongoDB rejects one there).

## Global Constraints

- Node.js 22+. `packages/core` never imports `mongoose`, and imports only types from `mongodb` (ESLint enforced).
- Compiled config types unchanged. The planner stays pure.
- Every sync update carries `<path>._v: { $not: { $gt: version } }` and no value conditions.
- Inline versions come from `session.operationTime`; never `Date` or wall-clock time.
- Test-first. Named exports only. Errors: `DenormoConfigError` / `DenormoRuntimeError` with a `code` (and relation id when relevant).
- Public API changes reflected in `docs/HLD.md` in the same change.
- Commits: Conventional Commits, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Stage files explicitly; never `git add -A`.
- Adapter tests must pass on Mongoose 8 and 9 (CI job `integration-mongoose-8`).

## Review Focus

1. **The inline `_v` equals the stream's `clusterTime` for the same write**, so running both modes together is harmless. Pinned in Task 3 ("versions the copy with the write's cluster time").
2. **An `updateOne` with a non-`_id` filter syncs the document that actually changed**, never another one. Pinned in Task 3.
3. **A write inside the caller's transaction that aborts leaves the copies untouched.** Pinned in Task 4.
4. **A write that touches no synced field costs nothing extra and changes no copy.** Pinned in Task 3.
5. **Hooks are inert when no inline sync is running or after `stop()`.** Pinned in Task 4.

---

## File structure

```text
packages/core/src/stream/execute.ts                (modify) session option; no write concern inside a transaction
packages/core/src/inline/inline.ts                 (create) createInlineSync
packages/core/src/index.ts, index.test.ts          (modify) exports
packages/core/test/integration/inline.test.ts      (create)

packages/mongoose/src/paths.ts                     (create) readPath/setPath (moved from snapshot-type.ts)
packages/mongoose/src/snapshot-type.ts             (modify) import from paths.ts
packages/mongoose/src/inline/touched.ts            (create) touchedPaths, affectedFields
packages/mongoose/src/inline/touched.test.ts       (create)
packages/mongoose/src/inline/registry.ts           (create) active inline sync per connection
packages/mongoose/src/inline/hooks.ts              (create) registerInlineHooks
packages/mongoose/src/source-plugin.ts             (modify) register the hooks
packages/mongoose/src/create-sync.ts               (modify) mode 'inline', inlineMaxTargets
packages/mongoose/test/integration/inline.test.ts  (create)
docs/HLD.md, README.md                             (modify)
```

---

### Task 1: Core `createInlineSync`

**Files:**
- Modify: `packages/core/src/stream/execute.ts`
- Create: `packages/core/src/inline/inline.ts`, `packages/core/test/integration/inline.test.ts`
- Modify: `packages/core/src/index.ts`, `packages/core/src/index.test.ts`

**Interfaces:**
- Consumes: `planUpdates`, `buildReverseMap`, `assertValidConfig`, `assertReplicaSet` (engine/preflight.ts), `executeOperations`.
- Produces:

```ts
export const DEFAULT_INLINE_MAX_TARGETS = 1000;
export interface InlineSyncOptions {
  readonly db: Db;
  readonly config: CompiledConfig;
  readonly validate?: ValidateOptions;
  /** Most copies one relation may update inline. Default 1,000. */
  readonly maxTargets?: number;
  readonly onWarning?: (message: string) => void;
}
export interface InlineApplyResult {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
}
export interface InlineSync {
  syncedFields(source: string): readonly string[];
  apply(event: NormalizedChangeEvent, options?: { readonly session?: ClientSession }): Promise<InlineApplyResult>;
}
export function createInlineSync(options: InlineSyncOptions): Promise<InlineSync>;
// execute.ts
export function executeOperations(db: Db, operations: readonly PlannedOperation[], options?: { readonly session?: ClientSession }): Promise<void>;
```

- [ ] **Step 0: Commit the plan on the branch**

The branch `feat/phase-1c-inline-mode` exists (created during planning).

```bash
git checkout feat/phase-1c-inline-mode && git status --short
git add docs/superpowers/plans/2026-11-02-phase-1c-inline-mode.md
git commit -m "docs: add Phase 1c inline mode implementation plan

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 1: Write the failing integration tests**

Create `packages/core/test/integration/inline.test.ts`:

```ts
import { ObjectId, Timestamp } from 'mongodb';
import { beforeEach, describe, expect, it } from 'vitest';
import { DenormoConfigError } from '../../src/errors.js';
import { createInlineSync, DEFAULT_INLINE_MAX_TARGETS } from '../../src/inline/inline.js';
import type { NormalizedChangeEvent } from '../../src/planner/types.js';
import { relation, usersPostsConfig } from '../fixtures.js';
import { type PostDoc, useDatabase } from './mongo.js';

const ctx = useDatabase();
const ada = new ObjectId();
const T5 = new Timestamp({ t: 5, i: 1 });
const posts = () => ctx.db.collection<PostDoc>('posts');

function rename(name: string): NormalizedChangeEvent {
  return { op: 'update', source: 'users', srcId: ada, version: T5, changed: { name }, removed: [] };
}

beforeEach(async () => {
  await posts().deleteMany({});
  await posts().insertMany([
    { _id: 'p1', createdBy: { _id: ada, name: 'Ada' }, comments: [{ _id: 'c1', author: { _id: ada, name: 'Ada' } }] },
    { _id: 'p2', createdBy: { _id: ada, name: 'Ada' } },
  ]);
});

describe('createInlineSync', () => {
  it('applies every relation an event affects', async () => {
    const inline = await createInlineSync({ db: ctx.db, config: usersPostsConfig() });
    const result = await inline.apply(rename('Ada Lovelace'));

    expect(result).toEqual({ applied: ['posts.createdBy', 'posts.comments.author'], skipped: [] });
    const p1 = await posts().findOne({ _id: 'p1' });
    expect(p1?.createdBy).toMatchObject({ name: 'Ada Lovelace', _v: T5 });
    expect(p1?.comments?.[0]?.author.name).toBe('Ada Lovelace');
  });

  it('skips a relation with more copies than maxTargets and warns', async () => {
    const warnings: string[] = [];
    const inline = await createInlineSync({
      db: ctx.db,
      config: usersPostsConfig(),
      maxTargets: 1,
      onWarning: (message) => warnings.push(message),
    });
    const result = await inline.apply(rename('Too many'));

    expect(result).toEqual({ applied: ['posts.comments.author'], skipped: ['posts.createdBy'] });
    expect(warnings).toEqual([expect.stringContaining('posts.createdBy')]);
    expect((await posts().findOne({ _id: 'p2' }))?.createdBy?.name).toBe('Ada');
  });

  it('writes in the caller’s transaction, so an abort leaves the copies untouched', async () => {
    const inline = await createInlineSync({ db: ctx.db, config: usersPostsConfig() });
    const session = ctx.client.startSession();
    try {
      session.startTransaction();
      await inline.apply(rename('Rolled back'), { session });
      await session.abortTransaction();
    } finally {
      await session.endSession();
    }
    expect((await posts().findOne({ _id: 'p1' }))?.createdBy?.name).toBe('Ada');
  });

  it('writes in the caller’s transaction, so a commit applies the copies', async () => {
    const inline = await createInlineSync({ db: ctx.db, config: usersPostsConfig() });
    const session = ctx.client.startSession();
    try {
      await session.withTransaction(async () => {
        await inline.apply(rename('Committed'), { session });
      });
    } finally {
      await session.endSession();
    }
    expect((await posts().findOne({ _id: 'p1' }))?.createdBy?.name).toBe('Committed');
  });

  it('lists the synced fields of a source', async () => {
    const inline = await createInlineSync({ db: ctx.db, config: usersPostsConfig() });
    expect([...inline.syncedFields('users')].sort()).toEqual(['avatar', 'name']);
    expect(inline.syncedFields('orgs')).toEqual([]);
  });

  it('validates the config', async () => {
    const broken = { ...usersPostsConfig(), relations: [relation({ id: 'r', path: 'a..b' })] };
    await expect(createInlineSync({ db: ctx.db, config: broken })).rejects.toBeInstanceOf(
      DenormoConfigError,
    );
  });

  it('defaults maxTargets to 1,000', () => {
    expect(DEFAULT_INLINE_MAX_TARGETS).toBe(1000);
  });
});
```

Run: `pnpm vitest run --project integration packages/core/test/integration/inline.test.ts`
Expected: FAIL, `Cannot find module '../../src/inline/inline.js'`.

- [ ] **Step 2: Add the session option to executeOperations**

Replace `packages/core/src/stream/execute.ts`:

```ts
import type { ClientSession, Db } from 'mongodb';
import type { PlannedOperation } from '../planner/types.js';

export interface ExecuteOptions {
  /** Run the writes in this session (and its transaction, if one is active). */
  readonly session?: ClientSession;
}

/**
 * Runs planned operations in order, one `updateMany` each. Outside a transaction they use
 * majority write concern; inside one MongoDB rejects a per-operation write concern, so none is set.
 */
export async function executeOperations(
  db: Db,
  operations: readonly PlannedOperation[],
  options: ExecuteOptions = {},
): Promise<void> {
  const { session } = options;
  const inTransaction = session?.inTransaction() ?? false;
  for (const operation of operations) {
    await db.collection(operation.collection).updateMany(operation.filter, operation.update, {
      ...(operation.arrayFilters ? { arrayFilters: [...operation.arrayFilters] } : {}),
      ...(session ? { session } : {}),
      ...(inTransaction ? {} : { writeConcern: { w: 'majority' } }),
    });
  }
}
```

- [ ] **Step 3: Implement createInlineSync**

Create `packages/core/src/inline/inline.ts`:

```ts
import type { ClientSession, Db } from 'mongodb';
import { buildReverseMap } from '../config/reverse-map.js';
import type { CompiledConfig } from '../config/types.js';
import { assertValidConfig, type ValidateOptions } from '../config/validate.js';
import { assertReplicaSet } from '../engine/preflight.js';
import { planUpdates } from '../planner/plan.js';
import type { NormalizedChangeEvent } from '../planner/types.js';
import { executeOperations } from '../stream/execute.js';

export const DEFAULT_INLINE_MAX_TARGETS = 1000;

export interface InlineSyncOptions {
  readonly db: Db;
  readonly config: CompiledConfig;
  readonly validate?: ValidateOptions;
  /** Most copies one relation may update inline; above it the relation is skipped. Default 1,000. */
  readonly maxTargets?: number;
  /** A relation was skipped. Default: `console.warn`. */
  readonly onWarning?: (message: string) => void;
}

export interface InlineApplyResult {
  /** Relation ids whose copies were updated. */
  readonly applied: readonly string[];
  /** Relation ids skipped because they had more copies than `maxTargets`. */
  readonly skipped: readonly string[];
}

export interface InlineSync {
  /** Synced field paths of a source collection. */
  syncedFields(source: string): readonly string[];
  /** Plans and writes the copies for one source change, in `session` when given. */
  apply(
    event: NormalizedChangeEvent,
    options?: { readonly session?: ClientSession },
  ): Promise<InlineApplyResult>;
}

/**
 * Applies source changes to their copies immediately (inline mode), with the same planner and
 * version guard as the stream engine. Validates the config and requires a replica set (inline
 * versions come from `session.operationTime`, which standalone servers do not report).
 */
export async function createInlineSync(options: InlineSyncOptions): Promise<InlineSync> {
  const { db, config } = options;
  assertValidConfig(config, options.validate);
  await assertReplicaSet(db);

  const reverseMap = buildReverseMap(config);
  const maxTargets = options.maxTargets ?? DEFAULT_INLINE_MAX_TARGETS;
  const onWarning =
    options.onWarning ??
    ((message: string) => {
      console.warn(`[denormo] ${message}`);
    });

  return {
    syncedFields: (source) => [...(reverseMap.get(source)?.keys() ?? [])],
    async apply(event, { session } = {}) {
      const applied: string[] = [];
      const skipped: string[] = [];
      for (const operation of planUpdates(config, reverseMap, event)) {
        const copies = await db
          .collection(operation.collection)
          .countDocuments(operation.filter, { limit: maxTargets + 1, ...(session ? { session } : {}) });
        if (copies > maxTargets) {
          skipped.push(operation.relationId);
          onWarning(
            `Relation "${operation.relationId}": more than ${String(maxTargets)} copies to update for ${String(event.srcId)}; skipped inline. Stream mode or reconcile will sync them.`,
          );
          continue;
        }
        await executeOperations(db, [operation], session ? { session } : {});
        applied.push(operation.relationId);
      }
      return { applied, skipped };
    },
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run --project integration packages/core/test/integration/inline.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Export, update the export test, run all checks, commit**

In `packages/core/src/index.ts` add:

```ts
export {
  createInlineSync,
  DEFAULT_INLINE_MAX_TARGETS,
  type InlineApplyResult,
  type InlineSync,
  type InlineSyncOptions,
} from './inline/inline.js';
```

In `packages/core/src/index.test.ts`, add `'DEFAULT_INLINE_MAX_TARGETS'` after `'DEFAULT_MAX_CASCADE_DEPTH'` and `'createInlineSync'` after `'buildReverseMap'` in the expected list; rename the test to `'exports the Phase 1 runtime surface (stream and inline)'`. Run it first and watch it fail, then with the export in place watch it pass.

Run: `pnpm lint && pnpm typecheck && pnpm test:unit && pnpm test:integration`
Expected: all pass.

```bash
git add packages/core/src/stream/execute.ts packages/core/src/inline/inline.ts packages/core/test/integration/inline.test.ts \
  packages/core/src/index.ts packages/core/src/index.test.ts
git commit -m "feat(core): add createInlineSync for applying copies in the writer's session

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Which synced fields a write touches

**Files:**
- Create: `packages/mongoose/src/paths.ts`
- Modify: `packages/mongoose/src/snapshot-type.ts`
- Create: `packages/mongoose/src/inline/touched.ts`, `packages/mongoose/src/inline/touched.test.ts`

**Interfaces:**
- Produces: `readPath(value: unknown, path: string): { exists: boolean; value?: unknown }` and `setPath(target, path, value)` in `src/paths.ts`; `touchedPaths(update: unknown): readonly string[] | 'all'`; `affectedFields(touched: readonly string[] | 'all', synced: readonly string[]): string[]`.

- [ ] **Step 1: Move the path helpers**

Create `packages/mongoose/src/paths.ts` containing the `readPath` and `setPath` functions cut from `snapshot-type.ts`, both `export`ed, unchanged otherwise. In `snapshot-type.ts` add `import { readPath, setPath } from './paths.js';`.

Run: `pnpm vitest run --project unit packages/mongoose`
Expected: PASS (unchanged behaviour).

- [ ] **Step 2: Write the failing tests**

Create `packages/mongoose/src/inline/touched.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { affectedFields, touchedPaths } from './touched.js';

describe('touchedPaths', () => {
  it('collects the fields of every update operator', () => {
    expect(
      touchedPaths({
        $set: { name: 'Ada', 'profile.city': 'Oslo' },
        $unset: { avatar: '' },
        $inc: { score: 1 },
        $push: { tags: 'x' },
      }),
    ).toEqual(['name', 'profile.city', 'avatar', 'score', 'tags']);
  });

  it('counts both sides of $rename', () => {
    expect(touchedPaths({ $rename: { nick: 'name' } })).toEqual(['nick', 'name']);
  });

  it('counts top-level fields of an update without operators', () => {
    expect(touchedPaths({ name: 'Ada' })).toEqual(['name']);
  });

  it('cuts paths at positional segments', () => {
    expect(touchedPaths({ $set: { 'comments.$.text': 'x', 'tags.$[].v': 1, 'a.$[elem].b': 2 } })).toEqual([
      'comments',
      'tags',
      'a',
    ]);
  });

  it('treats an aggregation pipeline as touching everything', () => {
    expect(touchedPaths([{ $set: { name: 'Ada' } }])).toBe('all');
  });

  it('returns nothing for an empty update', () => {
    expect(touchedPaths(undefined)).toEqual([]);
    expect(touchedPaths(null)).toEqual([]);
  });
});

describe('affectedFields', () => {
  const synced = ['name', 'avatar', 'profile.city'];

  it('keeps synced fields equal to, inside or containing a touched path', () => {
    expect(affectedFields(['name'], synced)).toEqual(['name']);
    expect(affectedFields(['profile'], synced)).toEqual(['profile.city']);
    expect(affectedFields(['profile.city.zip'], synced)).toEqual(['profile.city']);
  });

  it('ignores unrelated and prefix-sharing paths', () => {
    expect(affectedFields(['lastLoginAt', 'names', 'profiles'], synced)).toEqual([]);
  });

  it('returns every synced field when everything is touched', () => {
    expect(affectedFields('all', synced)).toEqual(synced);
  });
});
```

Run: `pnpm vitest run --project unit packages/mongoose/src/inline/touched.test.ts`
Expected: FAIL, `Cannot find module './touched.js'`.

- [ ] **Step 3: Implement**

Create `packages/mongoose/src/inline/touched.ts`:

```ts
/** `$`, `$[]` or `$[identifier]`. */
const POSITIONAL = /^\$(\[[^\]]*\])?$/;

/**
 * Field paths an update document writes, or `'all'` for an aggregation pipeline. Operator
 * arguments count by key (`$rename` by both names); top-level keys without `$` count as fields;
 * paths are cut at their first positional segment (`comments.$.text` → `comments`).
 */
export function touchedPaths(update: unknown): readonly string[] | 'all' {
  if (Array.isArray(update)) return 'all';
  if (typeof update !== 'object' || update === null) return [];
  const paths: string[] = [];
  for (const [key, argument] of Object.entries(update)) {
    if (!key.startsWith('$')) {
      paths.push(key);
      continue;
    }
    if (typeof argument !== 'object' || argument === null) continue;
    for (const [path, value] of Object.entries(argument)) {
      paths.push(path);
      if (key === '$rename' && typeof value === 'string') paths.push(value);
    }
  }
  return paths.map(withoutPositional);
}

/** Synced source fields a write touching `touched` may have changed. */
export function affectedFields(
  touched: readonly string[] | 'all',
  synced: readonly string[],
): string[] {
  if (touched === 'all') return [...synced];
  return synced.filter((field) => touched.some((path) => overlaps(path, field)));
}

function withoutPositional(path: string): string {
  const segments = path.split('.');
  const index = segments.findIndex((segment) => POSITIONAL.test(segment));
  return index === -1 ? path : segments.slice(0, index).join('.');
}

function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);
}
```

- [ ] **Step 4: Run tests and checks, commit**

Run: `pnpm vitest run --project unit packages/mongoose/src/inline/touched.test.ts`
Expected: PASS (9 tests).

Run: `pnpm lint && pnpm typecheck && pnpm test:unit`
Expected: pass.

```bash
git add packages/mongoose/src/paths.ts packages/mongoose/src/snapshot-type.ts \
  packages/mongoose/src/inline/touched.ts packages/mongoose/src/inline/touched.test.ts
git commit -m "feat(mongoose): work out which synced fields a write touches

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Inline hooks and `createSync({ mode: 'inline' })`

**Files:**
- Create: `packages/mongoose/src/inline/registry.ts`, `packages/mongoose/src/inline/hooks.ts`
- Modify: `packages/mongoose/src/source-plugin.ts`, `packages/mongoose/src/create-sync.ts`
- Create: `packages/mongoose/test/integration/inline.test.ts`

**Interfaces:**
- Consumes: `createInlineSync`, `InlineSync`, `NormalizedChangeEvent`, `DenormoRuntimeError` from `@denormo/core`; `touchedPaths`, `affectedFields`, `readPath` (Task 2).
- Produces:

```ts
// registry.ts
export interface InlineHandler { readonly sync: InlineSync; readonly onError: (error: DenormoRuntimeError) => void }
export function activateInline(connection: Connection, handler: InlineHandler): void;   // ALREADY_STARTED if one is active
export function deactivateInline(connection: Connection, handler: InlineHandler): void;
export function activeInline(connection: Connection): InlineHandler | undefined;
// hooks.ts
export function registerInlineHooks(schema: Schema): void;
// create-sync.ts: CreateSyncOptions gains `mode?: 'stream' | 'inline'` and `inlineMaxTargets?: number`
```

- [ ] **Step 1: Write the failing integration tests**

Create `packages/mongoose/test/integration/inline.test.ts`:

```ts
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
    ['findOneAndUpdate', (id: unknown) => User.findOneAndUpdate({ _id: id }, { $set: { name: 'Q' } })],
    ['replaceOne', (id: unknown) => User.replaceOne({ _id: id }, { name: 'Q', avatar: 'a.png', role: 'admin', score: 1 })],
    ['findOneAndReplace', (id: unknown) => User.findOneAndReplace({ _id: id }, { name: 'Q', avatar: 'a.png', role: 'admin', score: 1 })],
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
```

Run: `pnpm vitest run --project integration packages/mongoose/test/integration/inline.test.ts`
Expected: FAIL. `createSync` rejects `mode: 'inline'` with `UNSUPPORTED_MODE`.

- [ ] **Step 2: The registry**

Create `packages/mongoose/src/inline/registry.ts`:

```ts
import { DenormoRuntimeError, type InlineSync } from '@denormo/core';
import type { Connection } from 'mongoose';

/** What the hooks call while an inline sync is running on a connection. */
export interface InlineHandler {
  readonly sync: InlineSync;
  readonly onError: (error: DenormoRuntimeError) => void;
}

const active = new WeakMap<Connection, InlineHandler>();

export function activateInline(connection: Connection, handler: InlineHandler): void {
  if (active.has(connection)) {
    throw new DenormoRuntimeError('An inline sync is already running on this connection.', {
      code: 'ALREADY_STARTED',
    });
  }
  active.set(connection, handler);
}

export function deactivateInline(connection: Connection, handler: InlineHandler): void {
  if (active.get(connection) === handler) active.delete(connection);
}

export function activeInline(connection: Connection): InlineHandler | undefined {
  return active.get(connection);
}
```

- [ ] **Step 3: The hooks**

Create `packages/mongoose/src/inline/hooks.ts`:

```ts
import { DenormoRuntimeError, type NormalizedChangeEvent } from '@denormo/core';
import type { ClientSession, Connection, Query, Schema } from 'mongoose';
import { readPath } from '../paths.js';
import { activeInline, type InlineHandler } from './registry.js';
import { affectedFields, touchedPaths } from './touched.js';

const QUERY_WRITES = ['updateOne', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace'] as const;
const REPLACEMENTS = new Set<string>(['replaceOne', 'findOneAndReplace']);

/** A source write in flight whose copies the post hook will update. */
interface PendingWrite {
  readonly handler: InlineHandler;
  readonly source: string;
  readonly fields: readonly string[];
  readonly srcId: unknown;
  readonly session: ClientSession;
  readonly ownsSession: boolean;
}

/** Keyed by the document or query running the write. */
const pending = new WeakMap<object, PendingWrite>();

/** Minimal shapes of a hydrated document and a query, as the hooks use them. */
interface SourceDocument {
  readonly isNew: boolean;
  readonly db: Connection;
  readonly collection: { readonly collectionName: string };
  readonly _id: unknown;
  directModifiedPaths(): string[];
  $session(session?: ClientSession | null): ClientSession | null;
  toObject(options: Record<string, unknown>): unknown;
}

/**
 * Registers the inline-mode hooks on a source schema. They do nothing unless an inline sync is
 * running on the connection (see registry.ts); Mongoose only applies hooks registered before
 * the model is compiled, so the snapshotSource plugin calls this.
 */
export function registerInlineHooks(schema: Schema): void {
  schema.pre('save', async function () {
    const document = this as unknown as SourceDocument;
    if (document.isNew) return;
    const handler = activeInline(document.db);
    if (!handler) return;
    const source = document.collection.collectionName;
    const fields = affectedFields(document.directModifiedPaths(), handler.sync.syncedFields(source));
    if (fields.length === 0) return;

    const existing = document.$session();
    const session = existing ?? (await document.db.startSession());
    if (!existing) document.$session(session);
    pending.set(document, {
      handler,
      source,
      fields,
      srcId: document._id,
      session,
      ownsSession: !existing,
    });
  });

  schema.post('save', async function () {
    const document = this as unknown as SourceDocument;
    const write = take(document);
    if (!write) return;
    try {
      await applyWrite(write, document.toObject({ getters: false, virtuals: false, depopulate: true }));
    } finally {
      await release(write, () => document.$session(null));
    }
  });

  schema.pre(QUERY_WRITES, async function () {
    const query = this as unknown as Query<unknown, unknown>;
    const model = query.model;
    const handler = activeInline(model.db);
    if (!handler) return;
    const source = model.collection.collectionName;
    const touched = REPLACEMENTS.has(query.op ?? '') ? 'all' : touchedPaths(query.getUpdate());
    const fields = affectedFields(touched, handler.sync.syncedFields(source));
    if (fields.length === 0) return;

    const existing = (query.getOptions().session ?? undefined) as ClientSession | undefined;
    const srcId = await targetId(query, existing);
    if (srcId === undefined) return; // Nothing matches, so nothing changes.
    const session = existing ?? (await model.db.startSession());
    if (!existing) query.setOptions({ session });
    // Pin the write to the document found here, so the post hook syncs the one that changed.
    query.where({ _id: srcId });
    pending.set(query, { handler, source, fields, srcId, session, ownsSession: !existing });
  });

  schema.post(QUERY_WRITES, async function (result: unknown) {
    const query = this as unknown as Query<unknown, unknown>;
    const write = take(query);
    if (!write) return;
    try {
      if (!wroteSomething(result)) return;
      const current = await query.model.collection.findOne(
        { _id: write.srcId as never },
        { session: write.session },
      );
      await applyWrite(write, current);
    } finally {
      await release(write, () => query.setOptions({ session: undefined }));
    }
  });
}

function take(owner: object): PendingWrite | undefined {
  const write = pending.get(owner);
  pending.delete(owner);
  return write;
}

/** The `_id` the write will change: from an `{ _id: value }` filter, or read in `session`. */
async function targetId(query: Query<unknown, unknown>, session: ClientSession | undefined) {
  const filter = query.getFilter() as Record<string, unknown>;
  if (isPlainValue(filter._id)) return filter._id;
  const found = (await query.model
    .findOne(filter)
    .select('_id')
    .session(session ?? null)
    .lean()) as { _id?: unknown } | null;
  return found?._id;
}

/** A concrete `_id` value rather than an operator object such as `{ $in: [...] }`. */
function isPlainValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  return typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype;
}

/** False when the write matched nothing (update/replace result, or a null findOneAnd* result). */
function wroteSomething(result: unknown): boolean {
  if (result === null || result === undefined) return false;
  const { matchedCount } = result as { matchedCount?: unknown };
  return typeof matchedCount === 'number' ? matchedCount > 0 : true;
}

/** Turns the written source document into an event and applies it to the copies. */
async function applyWrite(write: PendingWrite, document: unknown): Promise<void> {
  if (document === null || document === undefined) return;
  try {
    const version = write.session.operationTime;
    if (!version) {
      throw new DenormoRuntimeError('The write reported no operationTime; inline mode needs a replica set.', {
        code: 'NO_OPERATION_TIME',
        source: write.source,
      });
    }
    const changed: Record<string, unknown> = {};
    const removed: string[] = [];
    for (const field of write.fields) {
      const found = readPath(document, field);
      if (found.exists) changed[field] = found.value;
      else removed.push(field);
    }
    const event: NormalizedChangeEvent = {
      op: 'update',
      source: write.source,
      srcId: write.srcId,
      version,
      changed,
      removed,
    };
    await write.handler.sync.apply(event, { session: write.session });
  } catch (error) {
    // Inside the caller's transaction, fail the write so the transaction can abort.
    if (write.session.inTransaction()) throw error;
    write.handler.onError(
      error instanceof DenormoRuntimeError
        ? error
        : new DenormoRuntimeError(`Inline sync of "${write.source}" failed.`, {
            code: 'INLINE_SYNC_FAILED',
            source: write.source,
            cause: error,
          }),
    );
  }
}

async function release(write: PendingWrite, detach: () => unknown): Promise<void> {
  if (!write.ownsSession) return;
  detach();
  await write.session.endSession();
}
```

Note: if the source write itself throws, the post hook does not run and an owned session is never ended by us; the driver ends unreferenced implicit-style sessions when the client closes. Task 4 adds error middleware for this.

- [ ] **Step 4: Register the hooks in the plugin**

In `packages/mongoose/src/source-plugin.ts`:
- rename the first parameter `_schema` to `schema`
- add `import { registerInlineHooks } from './inline/hooks.js';`
- replace the comment `// Nothing to store: …` with:

```ts
  // The expose list stays in Mongoose's plugin registry (see getExposedFields). Inline-mode
  // hooks must be registered now: Mongoose ignores hooks added after the model is compiled.
  registerInlineHooks(schema);
```

- [ ] **Step 5: Inline mode in createSync**

In `packages/mongoose/src/create-sync.ts`:
- `mode?: 'stream' | 'inline'` (doc: `'inline'` updates copies inside the writing request; see HLD "Sync modes"),
- add `readonly inlineMaxTargets?: number;` (doc: inline only; default 1,000),
- import `createInlineSync` from `@denormo/core` and `activateInline`, `deactivateInline`, `type InlineHandler` from `./inline/registry.js`,
- change the mode check to reject anything other than `'stream'` and `'inline'`,
- destructure `inlineMaxTargets` out of the options (not passed to the engine),
- after `const config = compileConfig(...)`, add:

```ts
  if (mode === 'inline') {
    const sync = await createInlineSync({
      db,
      config,
      ...(engineOptions.validate ? { validate: engineOptions.validate } : {}),
      ...(inlineMaxTargets === undefined ? {} : { maxTargets: inlineMaxTargets }),
      ...(engineOptions.onWarning ? { onWarning: engineOptions.onWarning } : {}),
    });
    const onError =
      engineOptions.onError ??
      ((error: DenormoRuntimeError) => {
        console.error(error);
      });
    const onWarning =
      engineOptions.onWarning ??
      ((message: string) => {
        console.warn(`[denormo] ${message}`);
      });
    const handler: InlineHandler = { sync, onError };
    return {
      config,
      start: () => {
        activateInline(connection, handler);
        onWarning(INLINE_BLIND_SPOTS);
        return Promise.resolve();
      },
      stop: () => {
        deactivateInline(connection, handler);
        return Promise.resolve();
      },
    };
  }
```

and at module level:

```ts
const INLINE_BLIND_SPOTS =
  'Inline mode only sees save(), updateOne, findOneAndUpdate, replaceOne and findOneAndReplace on source models. Not synced: updateMany, bulkWrite, deletes, raw driver writes, other services, and copies of copies. Run stream mode or reconcile to cover them.';
```

- [ ] **Step 6: Run the tests, checks, commit**

Run: `pnpm vitest run --project integration packages/mongoose/test/integration/inline.test.ts`
Expected: PASS (10 tests).

Run: `pnpm lint && pnpm typecheck && pnpm test:unit && pnpm test:integration`
Expected: all pass (the stream-mode adapter tests are unaffected: no inline sync is active there).

```bash
git add packages/mongoose/src/inline/registry.ts packages/mongoose/src/inline/hooks.ts \
  packages/mongoose/src/source-plugin.ts packages/mongoose/src/create-sync.ts \
  packages/mongoose/test/integration/inline.test.ts
git commit -m "feat(mongoose): add inline mode, updating copies in the writing request

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Transactions, limits, lifecycle, failures

**Files:**
- Modify: `packages/mongoose/test/integration/inline.test.ts`, `packages/mongoose/src/inline/hooks.ts`

**Interfaces:**
- Consumes: everything from Task 3.
- Produces: error middleware ending owned sessions when the source write fails.

- [ ] **Step 1: Write the tests**

Append to `packages/mongoose/test/integration/inline.test.ts`:

```ts
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
    const second = await createSync({ connection: ctx.connection, mode: 'inline', onWarning: () => undefined });
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
      expect(errors).toEqual([expect.objectContaining({ code: 'INLINE_SYNC_FAILED', source: 'users' })]);
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
```

Run: `pnpm vitest run --project integration packages/mongoose/test/integration/inline.test.ts`
Expected: all pass except possibly "keeps working after a source write fails" if a leaked session interferes; record the actual result. If every test passes on the first run, still do Step 2: the owned session of a failed write is otherwise never ended (verify with the probe in Step 2).

- [ ] **Step 2: End owned sessions when the source write fails**

Add a test that observes the leak directly, at the end of the describe block:

```ts
  it('ends the session it started when the source write fails', async () => {
    const { user } = await seed();
    await startInline();
    const ended: unknown[] = [];
    const original = ctx.connection.startSession.bind(ctx.connection);
    const spy = async (...args: Parameters<typeof original>) => {
      const session = await original(...args);
      session.once('ended', () => ended.push(session));
      return session;
    };
    ctx.connection.startSession = spy as typeof original;
    try {
      await expect(
        User.updateOne({ _id: user._id }, { $set: { score: 'not a number', name: 'X' } }),
      ).rejects.toThrow();
    } finally {
      ctx.connection.startSession = original;
    }
    expect(ended).toHaveLength(1);
  });
```

Run it and watch it FAIL (`ended` is empty).

Then add error middleware at the end of `registerInlineHooks` in `hooks.ts`:

```ts
  // Mongoose calls error middleware (three parameters) when the write itself fails.
  schema.post('save', function (error: unknown, _result: unknown, next: (error?: unknown) => void) {
    const document = this as unknown as SourceDocument;
    const write = take(document);
    if (!write) {
      next(error);
      return;
    }
    void release(write, () => document.$session(null)).finally(() => {
      next(error);
    });
  });
  schema.post(
    QUERY_WRITES,
    function (error: unknown, _result: unknown, next: (error?: unknown) => void) {
      const query = this as unknown as Query<unknown, unknown>;
      const write = take(query);
      if (!write) {
        next(error);
        return;
      }
      void release(write, () => query.setOptions({ session: undefined })).finally(() => {
        next(error);
      });
    },
  );
```

Run: `pnpm vitest run --project integration packages/mongoose/test/integration/inline.test.ts`
Expected: PASS (all tests, 19).

Note: a cast error (`score: 'not a number'`) is raised while Mongoose casts the update, which may happen before or after our pre hook. If the pre hook did not run, no session was started and `ended` stays empty for a different reason; in that case use a write that fails on the server instead (for example a `collMod` validator on `users` rejecting `name: 'X'`), and record the change as a ruling.

- [ ] **Step 3: Checks, Mongoose 8, commit**

Run: `pnpm lint && pnpm typecheck && pnpm test:unit && pnpm test:integration`
Expected: all pass.

Run the adapter tests on Mongoose 8 (then restore Mongoose 9 exactly as in plan 1b, Task 6 Step 3):

```bash
cp packages/mongoose/package.json pnpm-lock.yaml "$SCRATCHPAD"/
pnpm --filter @denormo/mongoose add -D mongoose@^8
pnpm vitest run --project unit packages/mongoose && pnpm vitest run --project integration packages/mongoose
cp "$SCRATCHPAD"/package.json packages/mongoose/package.json && cp "$SCRATCHPAD"/pnpm-lock.yaml pnpm-lock.yaml && pnpm install
```

Expected: all adapter tests pass on Mongoose 8; afterwards `git diff --stat packages/mongoose/package.json pnpm-lock.yaml` is empty.

```bash
git add packages/mongoose/src/inline/hooks.ts packages/mongoose/test/integration/inline.test.ts
git commit -m "feat(mongoose): inline copies join the caller's transaction; skip, report, clean up

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Docs

**Files:**
- Modify: `docs/HLD.md`, `README.md`

- [ ] **Step 1: Update the HLD**

In "Sync modes", in the table:
- "Requirements" row, `inline` column: `Replica set or sharded cluster (versions come from session.operationTime, which standalone servers do not report)`.
- "Atomicity" row, `inline` column: `Copies join the caller's session/transaction; a transactional: true flag (denormo wrapping each write) comes later`.
- "Fan-out" row, `inline` column: `Single updateMany per relation, capped by inlineMaxTargets (default 1,000); above it the relation is skipped with a warning (the job queue arrives in Phase 2)`.

Replace the "Inline mode details" list with:

```markdown
- The `snapshotSource` plugin registers the hooks when the schema is defined (Mongoose ignores hooks added after a model is compiled); they do nothing unless `createSync({ mode: 'inline' })` has started on that connection.
- Covered writes: `save()` of an existing document, `updateOne`, `findOneAndUpdate`, `replaceOne`, `findOneAndReplace`. Writes that touch no synced field cost nothing extra.
- The hook runs the write in a session (the caller's, or its own), reads the new values of the touched synced fields back by `_id`, and passes them to the same planner the stream uses. The version is the write's `session.operationTime`, the same cluster clock as the stream's `clusterTime`, so versions from both modes compare correctly. A filter that is not `{ _id: value }` is pinned to the `_id` read before the write.
- A failed copy write is reported through `onError` (`INLINE_SYNC_FAILED`) and does not fail the app's write; inside the caller's transaction it fails the write so the transaction can abort.
- Writes the hooks cannot see (`updateMany`, `bulkWrite`, deletes, raw driver, other services) and copies of copies are not synced. Starting inline mode logs a warning listing these blind spots, and `validate` reports them.
- Running `reconcile` periodically closes the gap left by unseen writes.
```

In "Public API surface", in the `createSync` example, change the `mode` comment to `// 'stream' | 'inline'` and add a line `inlineMaxTargets: 1000,             // inline only`.

- [ ] **Step 2: README**

In `README.md`, after the Mongoose usage block, add:

~~~markdown
Inline mode updates copies inside the request that wrote the source, without a worker:

```js
const sync = await createSync({ connection: mongoose.connection, mode: 'inline' });
await sync.start();
```

It only sees writes made through Mongoose (`save`, `updateOne`, `findOneAndUpdate`, `replaceOne`, `findOneAndReplace`); use stream mode to catch everything.
~~~

- [ ] **Step 3: Check, commit**

Run: `pnpm lint && pnpm test`
Expected: pass.

```bash
git add docs/HLD.md README.md
git commit -m "docs: describe inline mode

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Final review and PR**

Final whole-branch review (fresh reviewer), one fix pass, then push and open the PR against `main` with the decisions above, test counts, and CI (unit Node 22/24, integration MongoDB 6.0/7.0/8.0, integration Mongoose 8).
