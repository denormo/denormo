# Phase 1a: Core Sync Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `createSyncEngine({ db, config })` watches every source collection with a change stream and propagates synced field changes to target snapshots, resuming from a stored token after restarts.

**Architecture:** One change stream per source collection. Each change event is mapped to the planner's `NormalizedChangeEvent` (pure), planned with the existing `planUpdates` (pure), executed as guarded `updateMany` calls, and only then is the stream's resume token saved to `_denormo_cursors`. Processing is at-least-once; the version guard makes replays harmless. Startup validates the config, checks for a replica set, and checks the `<path>._id` indexes.

**Tech Stack:** TypeScript (strict, ESM), `mongodb` driver 7.x (peer `^6.20 || ^7`), Vitest 5 with an `integration` project, `mongodb-memory-server` 11 in replica-set mode.

**Spec:** `docs/HLD.md` (sections "Sync engine", "State storage", "Failure handling", "Roadmap" Phase 1) and `CLAUDE.md` hard rules.

## Phase 1 breakdown

Phase 1 in the HLD covers three independent subsystems. Each gets its own plan:

- **1a (this plan): core sync engine.** Change-stream runner, resume tokens, single worker, small jobs. Meets the Phase 1 exit criterion ("rename propagates end to end on a replica set in integration tests") with the plain driver.
- **1b: Mongoose adapter.** `Snapshot` schema type, `snapshotSource` plugin, schema walker emitting the compiled config, `createSync({ mode: 'stream' })` wrapping this engine.
- **1c: inline mode.** Mongoose hooks feeding the same planner, with the version from `session.operationTime`.

## Decisions in this plan (review these)

1. **No `_denormo_jobs` collection yet.** The runner executes planned operations directly, then saves the resume token. Crash between the two replays the event, which the version guard makes harmless. The durable job queue arrives in Phase 2 together with batching, where large fan-outs must not block the stream.
2. **Deletes and inserts are skipped by the runner.** The planner already plans deletes, but wiring delete events is Phase 4 in the roadmap ("delete-event handling in the stream runner"). The `$match` keeps only `update` and `replace` events.
3. **The resume token is saved after every event**, including skipped ones. Batching token writes is a Phase 2 optimisation.
4. **A failed target write stops that source's stream.** The error goes to `onError` with code `SOURCE_STOPPED`; the token is not advanced, so the next `start()` replays the event. Retry with backoff is Phase 2.
5. **First start without a stored token begins at the current cluster time** (`startAtOperationTime`), so writes right after `start()` resolves are never missed. Existing drift is out of scope (reconcile, Phase 3).
6. **`fullDocument: 'updateLookup'`** as the HLD specifies; the runner uses it only for truncated arrays.
7. **Reporting via `onError` / `onWarning` callbacks** (default: `console.error` / `console.warn`). The HLD's event names (`job:failed`, `stream:restarted`, …) belong to jobs and restarts that arrive in Phases 2 and 3.
8. **Cursor documents use `_id: <source collection>`** with `resumeToken` and `updatedAt`. `ownerId` is added with leases in Phase 2.
9. **A resume token that fell off the oplog is not recovered automatically yet.** The source reports `SOURCE_STOPPED` on every start until its cursor document is deleted. The HLD's "restart from now and schedule a reconcile" needs reconcile (Phase 3), so it lands there.

## Global Constraints

- Node.js 22+; `"engines": { "node": ">=22.12" }`.
- `packages/core` must never import `mongoose` (ESLint enforced).
- The compiled config types in `packages/core/src/config/types.ts` must not change.
- The planner stays pure: no I/O, no driver calls, no clocks in `packages/core/src/planner`.
- Every sync update carries the version guard `<path>._v: { $not: { $gte: version } }` and no value conditions.
- Versions are BSON Timestamps from change-event `clusterTime`; never `Date` or wall-clock time for ordering.
- Test-first for core logic: write the failing test, run it, then implement.
- Named exports only; no default exports in `packages/*/src`.
- Errors: `DenormoConfigError` (validation) or `DenormoRuntimeError` (engine), each with a `code`.
- Field paths in dot notation; array segments use the named `$[elem]` identifier, never positional `$`.
- Public API changes are reflected in `docs/HLD.md` ("Public API surface") in the same change.
- Commits: Conventional Commits, ending with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. Stage files explicitly; never `git add -A` (a Kilo Code worktree lives under `.kilo/`).
- Integration tests must pass on MongoDB 6.0, 7.0 and 8.0 (HLD "Decisions").

## Review Focus

1. **A write made immediately after `start()` resolves is synced.** A lazily opened change stream would miss it. Pinned in Task 6 ("propagates a rename made right after start").
2. **Restarting resumes where the engine stopped, and a first start does not replay old history.** Pinned in Task 6 ("resumes after a restart" and "starts from the current cluster time").
3. **Changing an unsynced field (`lastLoginAt`) writes nothing to targets but still advances the token.** Pinned in Task 6.
4. **A target write that fails is reported, not lost: the token stays put and the next start replays it.** Pinned in Task 6 with a collection validator that rejects the update.
5. **Snapshots inserted without `_v`, and target collections that do not exist yet at startup, work.** Pinned in Task 3 (real-database guard tests) and Task 5 (missing collection only warns).

---

## File structure

```text
test/integration/global-setup.ts           (create) starts one replica set for the integration project
vitest.config.ts                           (modify) integration project: globalSetup + timeouts
tsconfig.json                              (modify) include root test/
package.json                               (modify) test:integration script, mongodb-memory-server
pnpm-workspace.yaml                        (modify) allowBuilds for mongodb-memory-server
.github/workflows/ci.yml                   (modify) integration job on MongoDB 6.0 / 7.0 / 8.0

packages/core/src/errors.ts                (modify) DenormoRuntimeError
packages/core/src/config/paths.ts          (modify) getPath (moved from the planner)
packages/core/src/planner/plan.ts          (modify) use getPath
packages/core/src/stream/normalize.ts      (create) driver change event → NormalizedChangeEvent
packages/core/src/stream/execute.ts        (create) run PlannedOperations as updateMany
packages/core/src/state/cursors.ts         (create) resume token store (_denormo_cursors)
packages/core/src/engine/preflight.ts      (create) replica-set check, snapshot index check
packages/core/src/engine/engine.ts         (create) createSyncEngine: start/stop, stream loops
packages/core/src/index.ts                 (modify) public exports

packages/core/test/integration/mongo.ts    (create) per-file database + waitFor helper
packages/core/test/integration/*.test.ts   (create) integration tests per module
```

Unit tests sit next to the source (`src/**/*.test.ts`); integration tests live in `packages/core/test/integration/` and run only in the `integration` Vitest project.

---

### Task 1: Integration test infrastructure

**Files:**
- Create: `test/integration/global-setup.ts`
- Create: `packages/core/test/integration/mongo.ts`
- Create: `packages/core/test/integration/replica-set.test.ts`
- Modify: `vitest.config.ts`, `tsconfig.json`, `package.json`, `pnpm-workspace.yaml`, `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: nothing.
- Produces: Vitest provided value `mongoUri: string`; `useDatabase(): { client: MongoClient; db: Db }` (fields populated in `beforeAll`); `waitFor(check: () => Promise<boolean>, timeoutMs?: number): Promise<void>`; root script `pnpm test:integration`.

- [ ] **Step 0: Branch from an up-to-date main**

```bash
git checkout main && git pull --ff-only && git checkout -b feat/phase-1a-core-sync-engine
```

- [ ] **Step 1: Allow the dependency without running its download script, then install it**

Edit `pnpm-workspace.yaml` to:

```yaml
packages:
  - packages/*
allowBuilds:
  esbuild: true
  # Downloads mongod lazily on first use instead of at install time.
  mongodb-memory-server: false
```

Run: `pnpm add -Dw mongodb-memory-server@^11.3.0`
Expected: `devDependencies: + mongodb-memory-server 11.3.0`, no `ERR_PNPM_IGNORED_BUILDS`.

- [ ] **Step 2: Write the global setup**

Create `test/integration/global-setup.ts`:

```ts
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { TestProject } from 'vitest/node';

/** MongoDB version for integration tests; CI overrides it per matrix entry. */
const MONGODB_VERSION = process.env.MONGOMS_VERSION ?? '8.0.32';

let replSet: MongoMemoryReplSet | undefined;

export async function setup(project: TestProject): Promise<void> {
  replSet = await MongoMemoryReplSet.create({
    binary: { version: MONGODB_VERSION },
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  project.provide('mongoUri', replSet.getUri());
}

export async function teardown(): Promise<void> {
  await replSet?.stop();
}

declare module 'vitest' {
  export interface ProvidedContext {
    mongoUri: string;
  }
}
```

- [ ] **Step 3: Wire it into the integration project and the root tsconfig**

Replace the integration project in `vitest.config.ts`:

```ts
      {
        test: {
          name: 'integration',
          include: ['packages/*/test/integration/**/*.test.ts'],
          globalSetup: ['./test/integration/global-setup.ts'],
          // The first run downloads mongod.
          hookTimeout: 120_000,
          testTimeout: 30_000,
        },
      },
```

Replace `tsconfig.json`:

```json
{
  "extends": "./tsconfig.base.json",
  "include": ["*.config.ts", "test"]
}
```

Add to the root `package.json` scripts, after `test:unit`:

```json
    "test:integration": "vitest run --project integration",
```

- [ ] **Step 4: Write the per-file database helper**

Create `packages/core/test/integration/mongo.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { type Db, MongoClient, type ObjectId, type ResumeToken, type Timestamp } from 'mongodb';
import { afterAll, beforeAll, inject } from 'vitest';

/** Document shapes used by the integration tests (typed so strict lint rules see no `any`). */
export interface SnapshotDoc {
  _id: ObjectId;
  name?: string;
  photo?: string;
  avatar?: string;
  role?: string;
  deleted?: boolean;
  _v?: Timestamp;
}
export interface PostDoc {
  _id: string;
  createdBy?: SnapshotDoc;
  comments?: { _id: string; author: SnapshotDoc }[];
  likedBy?: SnapshotDoc[];
}
export interface UserDoc {
  _id: ObjectId;
  name?: string;
  avatar?: string;
  role?: string;
  lastLoginAt?: number;
}
export interface CursorDoc {
  _id: string;
  resumeToken?: ResumeToken;
}

export interface TestDatabase {
  client: MongoClient;
  db: Db;
}

/** Connects once per test file to a fresh database, dropped after the file's tests. */
export function useDatabase(): TestDatabase {
  const state = {} as TestDatabase;
  beforeAll(async () => {
    state.client = await MongoClient.connect(inject('mongoUri'));
    state.db = state.client.db(`denormo_${randomUUID().slice(0, 8)}`);
  });
  afterAll(async () => {
    await state.db.dropDatabase();
    await state.client.close();
  });
  return state;
}

/** Polls `check` until it returns true; fails after `timeoutMs`. */
export async function waitFor(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Condition not met within ${String(timeoutMs)} ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

declare module 'vitest' {
  export interface ProvidedContext {
    mongoUri: string;
  }
}
```

- [ ] **Step 5: Write a smoke test**

Create `packages/core/test/integration/replica-set.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { useDatabase } from './mongo.js';

const ctx = useDatabase();

describe('integration environment', () => {
  it('runs against a replica set', async () => {
    const hello = await ctx.db.admin().command({ hello: 1 });
    expect(hello.setName).toEqual(expect.any(String));
  });
});
```

- [ ] **Step 6: Run it**

Run: `pnpm test:integration`
Expected: `Tests  1 passed (1)` (first run downloads mongod 8.0.32, which can take a minute).

- [ ] **Step 7: Add the CI job**

Append to `.github/workflows/ci.yml` under `jobs:`:

```yaml
  integration:
    name: Integration tests (MongoDB ${{ matrix.mongodb }})
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        mongodb: ['6.0.29', '7.0.43', '8.0.32']
    env:
      MONGOMS_VERSION: ${{ matrix.mongodb }}
    steps:
      - uses: actions/checkout@v7
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v7
        with:
          node-version: 22
          cache: pnpm
      - uses: actions/cache@v6
        with:
          path: ~/.cache/mongodb-binaries
          key: mongodb-${{ runner.os }}-${{ matrix.mongodb }}
      - run: pnpm install --frozen-lockfile
      - run: pnpm test:integration
```

If the 6.0 entry fails on `ubuntu-latest` because no binary exists for that Ubuntu release, set `runs-on: ubuntu-22.04` for the job.

- [ ] **Step 8: Run all checks and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test:unit && pnpm test:integration`
Expected: all pass.

```bash
git add pnpm-workspace.yaml package.json pnpm-lock.yaml vitest.config.ts tsconfig.json \
  test/integration/global-setup.ts packages/core/test/integration/mongo.ts \
  packages/core/test/integration/replica-set.test.ts .github/workflows/ci.yml
git commit -m "test: run integration tests against an in-memory replica set

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Normalize driver change events

**Files:**
- Modify: `packages/core/src/errors.ts`, `packages/core/src/errors.test.ts`
- Modify: `packages/core/src/config/paths.ts`, `packages/core/src/config/paths.test.ts`
- Modify: `packages/core/src/planner/plan.ts`
- Create: `packages/core/src/stream/normalize.ts`, `packages/core/src/stream/normalize.test.ts`

**Interfaces:**
- Consumes: `NormalizedChangeEvent` from `planner/types.ts`; `pathsOverlap`, `childPath` from `config/paths.ts`.
- Produces:
  - `class DenormoRuntimeError extends Error { code: string; relationId: string | undefined; source: string | undefined }`, constructor `(message: string, options: { code: string; relationId?: string; source?: string; cause?: unknown })`.
  - `getPath(value: unknown, path: string): { exists: true; value: unknown } | { exists: false }` in `config/paths.ts`.
  - `normalizeChangeEvent(change: ChangeStreamDocument, syncedFields: readonly string[]): NormalizedChangeEvent | null`.

- [ ] **Step 1: Write the failing test for DenormoRuntimeError**

Append to `packages/core/src/errors.test.ts` (and add `DenormoRuntimeError` to its import from `./errors.js`):

```ts
describe('DenormoRuntimeError', () => {
  it('carries a code, the source collection and the cause', () => {
    const cause = new Error('write failed');
    const error = new DenormoRuntimeError('sync stopped', {
      code: 'SOURCE_STOPPED',
      source: 'users',
      cause,
    });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('DenormoRuntimeError');
    expect(error.code).toBe('SOURCE_STOPPED');
    expect(error.source).toBe('users');
    expect(error.relationId).toBeUndefined();
    expect(error.cause).toBe(cause);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run --project unit packages/core/src/errors.test.ts`
Expected: FAIL, `DenormoRuntimeError` is not exported.

- [ ] **Step 3: Implement it**

Append to `packages/core/src/errors.ts`:

```ts
export interface DenormoRuntimeErrorOptions {
  readonly code: string;
  readonly relationId?: string;
  /** Source collection the error concerns, when there is one. */
  readonly source?: string;
  readonly cause?: unknown;
}

/** Thrown or reported by the running engine (streams, writes, startup checks). */
export class DenormoRuntimeError extends Error {
  override readonly name = 'DenormoRuntimeError';
  readonly code: string;
  readonly relationId: string | undefined;
  readonly source: string | undefined;

  constructor(message: string, options: DenormoRuntimeErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = options.code;
    this.relationId = options.relationId;
    this.source = options.source;
  }
}
```

Run: `pnpm vitest run --project unit packages/core/src/errors.test.ts`
Expected: PASS.

- [ ] **Step 4: Write the failing test for getPath**

Append to `packages/core/src/config/paths.test.ts` (add `getPath` to the import from `./paths.js`):

```ts
describe('getPath', () => {
  const doc = { name: 'Ada', profile: { city: 'Oslo', zip: null }, tags: ['a', 'b'] };

  it('returns the value at a dot-notation path', () => {
    expect(getPath(doc, 'profile.city')).toEqual({ exists: true, value: 'Oslo' });
    expect(getPath(doc, 'tags.1')).toEqual({ exists: true, value: 'b' });
  });

  it('returns the whole value for an empty path', () => {
    expect(getPath(doc, '')).toEqual({ exists: true, value: doc });
  });

  it('distinguishes a null value from a missing field', () => {
    expect(getPath(doc, 'profile.zip')).toEqual({ exists: true, value: null });
    expect(getPath(doc, 'profile.street')).toEqual({ exists: false });
    expect(getPath(doc, 'name.first')).toEqual({ exists: false });
    expect(getPath(undefined, 'name')).toEqual({ exists: false });
  });
});
```

Run: `pnpm vitest run --project unit packages/core/src/config/paths.test.ts`
Expected: FAIL, `getPath` is not exported.

- [ ] **Step 5: Move the planner's lookup into paths.ts**

Append to `packages/core/src/config/paths.ts`:

```ts
export type PathLookup = { readonly exists: true; readonly value: unknown } | { readonly exists: false };

/** Reads a dot-notation path from a value; `exists: false` when any segment is missing. */
export function getPath(value: unknown, path: string): PathLookup {
  let current = value;
  for (const segment of path === '' ? [] : path.split('.')) {
    if (typeof current !== 'object' || current === null || !Object.hasOwn(current, segment)) {
      return { exists: false };
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return { exists: true, value: current };
}
```

In `packages/core/src/planner/plan.ts`: delete the private `lookup` function, change the import to
`import { childPath, getPath, joinPath, parseSnapshotPath, type SnapshotLocation } from '../config/paths.js';`
and replace `const found = lookup(value, within);` with `const found = getPath(value, within);`.

Run: `pnpm test:unit`
Expected: all unit tests pass (planner behaviour unchanged).

- [ ] **Step 6: Write the failing tests for normalizeChangeEvent**

Create `packages/core/src/stream/normalize.test.ts`:

```ts
import { type ChangeStreamDocument, ObjectId, Timestamp } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { DenormoRuntimeError } from '../errors.js';
import { normalizeChangeEvent } from './normalize.js';

const ada = new ObjectId('64b7f0c2a1b2c3d4e5f60718');
const T5 = new Timestamp({ t: 5, i: 1 });
const SYNCED = ['name', 'avatar', 'profile.city', 'tags'];

/** Builds a driver change event; only the fields the normalizer reads matter. */
function change(fields: Record<string, unknown>): ChangeStreamDocument {
  return {
    _id: { _data: 'token' },
    ns: { db: 'app', coll: 'users' },
    documentKey: { _id: ada },
    clusterTime: T5,
    ...fields,
  } as unknown as ChangeStreamDocument;
}

describe('normalizeChangeEvent', () => {
  it('maps an update to changed and removed fields', () => {
    const event = normalizeChangeEvent(
      change({
        operationType: 'update',
        updateDescription: { updatedFields: { name: 'Ada' }, removedFields: ['avatar'] },
      }),
      SYNCED,
    );
    expect(event).toEqual({
      op: 'update',
      source: 'users',
      srcId: ada,
      version: T5,
      changed: { name: 'Ada' },
      removed: ['avatar'],
    });
  });

  it('defaults missing update description parts to empty', () => {
    const event = normalizeChangeEvent(
      change({ operationType: 'update', updateDescription: {} }),
      SYNCED,
    );
    expect(event).toMatchObject({ changed: {}, removed: [] });
  });

  it('maps a replace to the replacement fields and removes synced fields it dropped', () => {
    const event = normalizeChangeEvent(
      change({
        operationType: 'replace',
        fullDocument: { _id: ada, name: 'Ada', profile: { zip: '0150' } },
      }),
      SYNCED,
    );
    expect(event).toEqual({
      op: 'replace',
      source: 'users',
      srcId: ada,
      version: T5,
      changed: { _id: ada, name: 'Ada', profile: { zip: '0150' } },
      removed: ['avatar', 'profile.city', 'tags'],
    });
  });

  it('reads a truncated synced array from the full document', () => {
    const event = normalizeChangeEvent(
      change({
        operationType: 'update',
        updateDescription: {
          updatedFields: { 'tags.0': 'x', nickname: 'A' },
          removedFields: [],
          truncatedArrays: [{ field: 'tags', newSize: 1 }],
        },
        fullDocument: { _id: ada, tags: ['x'], nickname: 'A' },
      }),
      SYNCED,
    );
    // `tags.0` is dropped: `tags` carries the whole array, and both would conflict in one update.
    expect(event?.changed).toEqual({ tags: ['x'], nickname: 'A' });
  });

  it('ignores truncated arrays that are not synced, or whose document is gone', () => {
    const unsynced = normalizeChangeEvent(
      change({
        operationType: 'update',
        updateDescription: { truncatedArrays: [{ field: 'history', newSize: 0 }] },
        fullDocument: { _id: ada, history: [] },
      }),
      SYNCED,
    );
    expect(unsynced?.changed).toEqual({});

    const deleted = normalizeChangeEvent(
      change({
        operationType: 'update',
        updateDescription: { truncatedArrays: [{ field: 'tags', newSize: 0 }] },
        fullDocument: null,
      }),
      SYNCED,
    );
    expect(deleted?.changed).toEqual({});
  });

  it.each(['insert', 'delete', 'drop', 'invalidate'])('skips %s events', (operationType) => {
    expect(normalizeChangeEvent(change({ operationType }), SYNCED)).toBeNull();
  });

  it('throws a DenormoRuntimeError when the event has no clusterTime', () => {
    const noTime = change({ operationType: 'update', updateDescription: {}, clusterTime: undefined });
    expect(() => normalizeChangeEvent(noTime, SYNCED)).toThrow(DenormoRuntimeError);
    expect(() => normalizeChangeEvent(noTime, SYNCED)).toThrow(
      expect.objectContaining({ code: 'MISSING_CLUSTER_TIME', source: 'users' }),
    );
  });
});
```

- [ ] **Step 7: Run them to verify they fail**

Run: `pnpm vitest run --project unit packages/core/src/stream/normalize.test.ts`
Expected: FAIL, `Cannot find module './normalize.js'`.

- [ ] **Step 8: Implement normalizeChangeEvent**

Create `packages/core/src/stream/normalize.ts`:

```ts
import type { ChangeStreamDocument } from 'mongodb';
import { childPath, getPath, pathsOverlap } from '../config/paths.js';
import { DenormoRuntimeError } from '../errors.js';
import type { NormalizedChangeEvent } from '../planner/types.js';

/**
 * Maps a driver change event to the planner's event shape, or returns `null` for events the
 * runner does not sync in Phase 1 (inserts, deletes, and anything other than update/replace).
 *
 * @param syncedFields the source's synced field paths (its reverse-map keys); a replace that drops
 *   one of them reports it as removed, so the copies are unset rather than left stale.
 */
export function normalizeChangeEvent(
  change: ChangeStreamDocument,
  syncedFields: readonly string[],
): NormalizedChangeEvent | null {
  if (change.operationType !== 'update' && change.operationType !== 'replace') return null;

  const source = change.ns.coll;
  const version = change.clusterTime;
  if (!version) {
    throw new DenormoRuntimeError(`Change event on "${source}" has no clusterTime.`, {
      code: 'MISSING_CLUSTER_TIME',
      source,
    });
  }
  const base = { source, srcId: change.documentKey._id as unknown, version };

  if (change.operationType === 'replace') {
    const document = change.fullDocument;
    return {
      ...base,
      op: 'replace',
      changed: { ...document },
      removed: syncedFields.filter((field) => !getPath(document, field).exists),
    };
  }

  const { updatedFields = {}, removedFields = [], truncatedArrays = [] } = change.updateDescription;
  const changed: Record<string, unknown> = { ...updatedFields };
  for (const { field } of truncatedArrays) {
    if (!syncedFields.some((synced) => pathsOverlap(synced, field))) continue;
    const found = getPath(change.fullDocument, field);
    if (!found.exists) continue;
    // The whole array replaces any element updates inside it, which would otherwise conflict.
    for (const path of Object.keys(changed)) {
      if (childPath(field, path)) delete changed[path];
    }
    changed[field] = found.value;
  }
  return { ...base, op: 'update', changed, removed: [...removedFields] };
}
```

- [ ] **Step 9: Run the tests and all checks**

Run: `pnpm vitest run --project unit packages/core/src/stream/normalize.test.ts`
Expected: PASS (10 tests).

Run: `pnpm lint && pnpm typecheck && pnpm test:unit`
Expected: all pass.

- [ ] **Step 10: Commit**

```bash
git add packages/core/src/errors.ts packages/core/src/errors.test.ts \
  packages/core/src/config/paths.ts packages/core/src/config/paths.test.ts \
  packages/core/src/planner/plan.ts packages/core/src/stream/normalize.ts \
  packages/core/src/stream/normalize.test.ts
git commit -m "feat(core): normalize driver change events for the planner

Adds DenormoRuntimeError and moves the path lookup helper to paths.ts.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Execute planned operations

**Files:**
- Create: `packages/core/src/stream/execute.ts`
- Create: `packages/core/test/integration/execute.test.ts`

**Interfaces:**
- Consumes: `PlannedOperation` (`planner/types.ts`), `planUpdates`, `buildReverseMap`, fixtures `usersPostsConfig`, `postsCreatedBy`, `postsCommentsAuthor`, `relation`, `configWith` from `packages/core/test/fixtures.ts`; `useDatabase` from Task 1.
- Produces: `executeOperations(db: Db, operations: readonly PlannedOperation[]): Promise<void>`.

- [ ] **Step 1: Write the failing integration tests**

Create `packages/core/test/integration/execute.test.ts`:

```ts
import { ObjectId, Timestamp } from 'mongodb';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildReverseMap } from '../../src/config/reverse-map.js';
import type { CompiledConfig } from '../../src/config/types.js';
import { planUpdates } from '../../src/planner/plan.js';
import type { NormalizedChangeEvent } from '../../src/planner/types.js';
import { executeOperations } from '../../src/stream/execute.js';
import { configWith, postsCreatedBy, relation, usersPostsConfig } from '../fixtures.js';
import { type PostDoc, useDatabase } from './mongo.js';

const ctx = useDatabase();
const posts = () => ctx.db.collection<PostDoc>('posts');
const ada = new ObjectId();
const bob = new ObjectId();
const T = (t: number) => new Timestamp({ t, i: 1 });

async function run(event: Partial<NormalizedChangeEvent>, config: CompiledConfig = usersPostsConfig()) {
  const full: NormalizedChangeEvent = {
    op: 'update',
    source: 'users',
    srcId: ada,
    version: T(5),
    changed: {},
    removed: [],
    ...event,
  };
  await executeOperations(ctx.db, planUpdates(config, buildReverseMap(config), full));
}

beforeEach(async () => {
  await posts().deleteMany({});
});

describe('executeOperations', () => {
  it('updates flat snapshots that are older or have no _v, and leaves newer ones', async () => {
    await posts().insertMany([
      { _id: 'older', createdBy: { _id: ada, name: 'Ada', _v: T(1) } },
      { _id: 'none', createdBy: { _id: ada, name: 'Ada' } },
      { _id: 'newer', createdBy: { _id: ada, name: 'Newer', _v: T(9) } },
      { _id: 'other', createdBy: { _id: bob, name: 'Bob', _v: T(1) } },
    ]);

    await run({ changed: { name: 'Ada Lovelace' } });

    const byId = new Map((await posts().find().toArray()).map((post) => [post._id, post.createdBy]));
    expect(byId.get('older')).toEqual({ _id: ada, name: 'Ada Lovelace', _v: T(5) });
    expect(byId.get('none')).toEqual({ _id: ada, name: 'Ada Lovelace', _v: T(5) });
    expect(byId.get('newer')).toEqual({ _id: ada, name: 'Newer', _v: T(9) });
    expect(byId.get('other')).toEqual({ _id: bob, name: 'Bob', _v: T(1) });
  });

  it('updates matching array elements, including ones without _v', async () => {
    await posts().insertOne({
      _id: 'thread',
      comments: [
        { _id: 'c1', author: { _id: ada, name: 'Ada', _v: T(1) } },
        { _id: 'c2', author: { _id: ada, name: 'Ada' } },
        { _id: 'c3', author: { _id: ada, name: 'Newer', _v: T(9) } },
        { _id: 'c4', author: { _id: bob, name: 'Bob' } },
      ],
    });

    await run({ changed: { name: 'Ada Lovelace' } });

    const thread = await posts().findOne({ _id: 'thread' });
    expect(thread?.comments?.map((comment) => comment.author)).toEqual([
      { _id: ada, name: 'Ada Lovelace', _v: T(5) },
      { _id: ada, name: 'Ada Lovelace', _v: T(5) },
      { _id: ada, name: 'Newer', _v: T(9) },
      { _id: bob, name: 'Bob' },
    ]);
  });

  it('is a no-op when the same event is applied twice', async () => {
    await posts().insertOne({ _id: 'p', createdBy: { _id: ada, name: 'Ada' } });
    await run({ changed: { name: 'Ada Lovelace' } });
    const once = await posts().findOne({ _id: 'p' });
    await run({ changed: { name: 'Ada Lovelace' } });
    expect(await posts().findOne({ _id: 'p' })).toEqual(once);
  });

  it('unsets removed fields and leaves frozen ones', async () => {
    await posts().insertOne({
      _id: 'p',
      createdBy: { _id: ada, name: 'Ada', photo: 'a.png', role: 'admin' },
    });
    await run({ removed: ['avatar', 'role'] }, configWith(postsCreatedBy));
    expect((await posts().findOne({ _id: 'p' }))?.createdBy).toEqual({
      _id: ada,
      name: 'Ada',
      role: 'admin',
      _v: T(5),
    });
  });

  it('applies delete policies: markDeleted, and $pull for arrays of snapshots', async () => {
    const likedBy = relation({ id: 'posts.likedBy', path: 'likedBy[]', array: true, onDelete: 'unset' });
    await posts().insertOne({
      _id: 'p',
      createdBy: { _id: ada, name: 'Ada' },
      likedBy: [{ _id: ada, name: 'Ada' }, { _id: bob, name: 'Bob' }],
    });

    await run({ op: 'delete' }, configWith(postsCreatedBy, likedBy));

    const post = await posts().findOne({ _id: 'p' });
    expect(post?.createdBy).toEqual({ _id: ada, name: 'Ada', deleted: true, _v: T(5) });
    expect(post?.likedBy).toEqual([{ _id: bob, name: 'Bob' }]);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run --project integration packages/core/test/integration/execute.test.ts`
Expected: FAIL, `Cannot find module '../../src/stream/execute.js'`.

- [ ] **Step 3: Implement executeOperations**

Create `packages/core/src/stream/execute.ts`:

```ts
import type { Db } from 'mongodb';
import type { PlannedOperation } from '../planner/types.js';

/**
 * Runs planned operations in order, one `updateMany` each, with majority write concern.
 * Phase 1 runs every operation as a single small job; batching arrives in Phase 2.
 */
export async function executeOperations(
  db: Db,
  operations: readonly PlannedOperation[],
): Promise<void> {
  for (const operation of operations) {
    await db.collection(operation.collection).updateMany(operation.filter, operation.update, {
      ...(operation.arrayFilters ? { arrayFilters: [...operation.arrayFilters] } : {}),
      writeConcern: { w: 'majority' },
    });
  }
}
```

- [ ] **Step 4: Run the tests and all checks**

Run: `pnpm vitest run --project integration packages/core/test/integration/execute.test.ts`
Expected: PASS (5 tests).

Run: `pnpm lint && pnpm typecheck && pnpm test:unit`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/stream/execute.ts packages/core/test/integration/execute.test.ts
git commit -m "feat(core): execute planned operations as guarded updateMany calls

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Resume token store

**Files:**
- Create: `packages/core/src/state/cursors.ts`
- Create: `packages/core/test/integration/cursors.test.ts`

**Interfaces:**
- Consumes: `useDatabase` from Task 1.
- Produces: `interface CursorStore { load(source: string): Promise<ResumeToken | undefined>; save(source: string, resumeToken: ResumeToken): Promise<void> }`; `createCursorStore(db: Db, prefix: string): CursorStore`. Collection name: `` `${prefix}cursors` ``.

- [ ] **Step 1: Write the failing integration tests**

Create `packages/core/test/integration/cursors.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createCursorStore } from '../../src/state/cursors.js';
import { useDatabase } from './mongo.js';

const ctx = useDatabase();

describe('createCursorStore', () => {
  it('has no token for a source it has never seen', async () => {
    expect(await createCursorStore(ctx.db, '_t1_').load('users')).toBeUndefined();
  });

  it('saves and loads a token per source, replacing older ones', async () => {
    const store = createCursorStore(ctx.db, '_t2_');
    await store.save('users', { _data: 'first' });
    await store.save('users', { _data: 'second' });
    await store.save('orgs', { _data: 'org' });

    expect(await store.load('users')).toEqual({ _data: 'second' });
    expect(await store.load('orgs')).toEqual({ _data: 'org' });
  });

  it('keeps one document per source in <prefix>cursors', async () => {
    const store = createCursorStore(ctx.db, '_t3_');
    await store.save('users', { _data: 'a' });
    await store.save('users', { _data: 'b' });

    const docs = await ctx.db.collection('_t3_cursors').find().toArray();
    expect(docs).toEqual([
      { _id: 'users', resumeToken: { _data: 'b' }, updatedAt: expect.any(Date) },
    ]);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run --project integration packages/core/test/integration/cursors.test.ts`
Expected: FAIL, `Cannot find module '../../src/state/cursors.js'`.

- [ ] **Step 3: Implement the store**

Create `packages/core/src/state/cursors.ts`:

```ts
import type { Db, ResumeToken } from 'mongodb';

/** Stored change-stream position per source collection (`_denormo_cursors`). */
export interface CursorStore {
  load(source: string): Promise<ResumeToken | undefined>;
  save(source: string, resumeToken: ResumeToken): Promise<void>;
}

interface CursorDocument {
  _id: string;
  resumeToken: ResumeToken;
  /** For observability only; ordering never uses wall-clock time. */
  updatedAt: Date;
}

export function createCursorStore(db: Db, prefix: string): CursorStore {
  const cursors = db.collection<CursorDocument>(`${prefix}cursors`);
  return {
    async load(source) {
      const cursor = await cursors.findOne({ _id: source });
      return cursor?.resumeToken;
    },
    async save(source, resumeToken) {
      await cursors.updateOne(
        { _id: source },
        { $set: { resumeToken, updatedAt: new Date() } },
        { upsert: true, writeConcern: { w: 'majority' } },
      );
    },
  };
}
```

- [ ] **Step 4: Run the tests and all checks**

Run: `pnpm vitest run --project integration packages/core/test/integration/cursors.test.ts`
Expected: PASS (3 tests).

Run: `pnpm lint && pnpm typecheck`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/state/cursors.ts packages/core/test/integration/cursors.test.ts
git commit -m "feat(core): store change-stream resume tokens per source

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Startup checks (replica set, snapshot indexes)

**Files:**
- Create: `packages/core/src/engine/preflight.ts`
- Create: `packages/core/src/engine/preflight.test.ts` (unit)
- Create: `packages/core/test/integration/preflight.test.ts`

**Interfaces:**
- Consumes: `DenormoRuntimeError` (Task 2), `stripArrayMarker` from `config/paths.ts`, `CompiledConfig`, `RelationConfig`.
- Produces:
  - `assertReplicaSet(db: Db): Promise<void>`, throws `DenormoRuntimeError` code `NOT_REPLICA_SET`.
  - `snapshotIdIndexKey(relation: RelationConfig): string`, e.g. `createdBy._id`, `comments.author._id`, `likedBy._id`.
  - `ensureSnapshotIndexes(db: Db, config: CompiledConfig, options: { autoIndex: boolean; onWarning: (message: string) => void }): Promise<void>`.

- [ ] **Step 1: Write the failing unit tests**

Create `packages/core/src/engine/preflight.test.ts`:

```ts
import type { Db } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { postsCommentsAuthor, postsCreatedBy, relation } from '../../test/fixtures.js';
import { DenormoRuntimeError } from '../errors.js';
import { assertReplicaSet, snapshotIdIndexKey } from './preflight.js';

/** A Db whose admin `hello` returns `reply`; nothing else is called. */
function dbReplying(reply: Record<string, unknown>): Db {
  return { admin: () => ({ command: () => Promise.resolve(reply) }) } as unknown as Db;
}

describe('assertReplicaSet', () => {
  it('accepts a replica set member', async () => {
    await expect(assertReplicaSet(dbReplying({ setName: 'rs0' }))).resolves.toBeUndefined();
  });

  it('accepts a mongos', async () => {
    await expect(assertReplicaSet(dbReplying({ msg: 'isdbgrid' }))).resolves.toBeUndefined();
  });

  it('rejects a standalone server', async () => {
    const standalone = assertReplicaSet(dbReplying({ isWritablePrimary: true }));
    await expect(standalone).rejects.toBeInstanceOf(DenormoRuntimeError);
    await expect(assertReplicaSet(dbReplying({}))).rejects.toMatchObject({
      code: 'NOT_REPLICA_SET',
    });
  });
});

describe('snapshotIdIndexKey', () => {
  it('points at the snapshot _id for flat and array paths', () => {
    expect(snapshotIdIndexKey(postsCreatedBy)).toBe('createdBy._id');
    expect(snapshotIdIndexKey(postsCommentsAuthor)).toBe('comments.author._id');
    expect(snapshotIdIndexKey(relation({ id: 'l', path: 'likedBy[]', array: true }))).toBe(
      'likedBy._id',
    );
  });
});
```

Run: `pnpm vitest run --project unit packages/core/src/engine/preflight.test.ts`
Expected: FAIL, `Cannot find module './preflight.js'`.

- [ ] **Step 2: Write the failing integration tests**

Create `packages/core/test/integration/preflight.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { assertReplicaSet, ensureSnapshotIndexes } from '../../src/engine/preflight.js';
import { usersPostsConfig } from '../fixtures.js';
import { useDatabase } from './mongo.js';

const ctx = useDatabase();

async function indexKeys(collection: string): Promise<string[]> {
  const indexes = await ctx.db.collection(collection).listIndexes().toArray();
  return indexes.map((index) => Object.keys(index.key as object).join(','));
}

beforeEach(async () => {
  await ctx.db.collection('posts').drop().catch(() => undefined);
});

describe('preflight against a replica set', () => {
  it('accepts the test replica set', async () => {
    await expect(assertReplicaSet(ctx.db)).resolves.toBeUndefined();
  });

  it('warns about each missing snapshot index, even when the target collection does not exist', async () => {
    const warnings: string[] = [];
    await ensureSnapshotIndexes(ctx.db, usersPostsConfig(), {
      autoIndex: false,
      onWarning: (message) => warnings.push(message),
    });
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('posts.createdBy._id');
    expect(warnings[1]).toContain('posts.comments.author._id');
  });

  it('creates the indexes when autoIndex is on', async () => {
    const warnings: string[] = [];
    await ensureSnapshotIndexes(ctx.db, usersPostsConfig(), {
      autoIndex: true,
      onWarning: (message) => warnings.push(message),
    });
    expect(warnings).toEqual([]);
    expect(await indexKeys('posts')).toEqual(
      expect.arrayContaining(['createdBy._id', 'comments.author._id']),
    );
  });

  it('accepts an existing compound index that starts with the snapshot _id', async () => {
    await ctx.db.collection('posts').createIndex({ 'createdBy._id': 1, createdAt: -1 });
    await ctx.db.collection('posts').createIndex({ 'comments.author._id': 1 });
    const warnings: string[] = [];
    await ensureSnapshotIndexes(ctx.db, usersPostsConfig(), {
      autoIndex: false,
      onWarning: (message) => warnings.push(message),
    });
    expect(warnings).toEqual([]);
  });
});
```

Run: `pnpm vitest run --project integration packages/core/test/integration/preflight.test.ts`
Expected: FAIL, `Cannot find module '../../src/engine/preflight.js'`.

- [ ] **Step 3: Implement the checks**

Create `packages/core/src/engine/preflight.ts`:

```ts
import { type Db, type IndexDescriptionInfo, MongoServerError } from 'mongodb';
import { stripArrayMarker } from '../config/paths.js';
import type { CompiledConfig, RelationConfig } from '../config/types.js';
import { DenormoRuntimeError } from '../errors.js';

/** MongoDB error code for a collection that does not exist. */
const NAMESPACE_NOT_FOUND = 26;

/** Change streams need a replica set or a sharded cluster. */
export async function assertReplicaSet(db: Db): Promise<void> {
  const hello = await db.admin().command({ hello: 1 });
  if (typeof hello.setName === 'string' || hello.msg === 'isdbgrid') return;
  throw new DenormoRuntimeError(
    'denormo needs a replica set or sharded cluster (change streams); this server is standalone.',
    { code: 'NOT_REPLICA_SET' },
  );
}

/** The index every sync update filters on: `<path>._id` with the array marker removed. */
export function snapshotIdIndexKey(relation: RelationConfig): string {
  return `${stripArrayMarker(relation.path)}._id`;
}

export interface SnapshotIndexOptions {
  readonly autoIndex: boolean;
  readonly onWarning: (message: string) => void;
}

/** Warns about (or, with `autoIndex`, creates) a missing `<path>._id` index per relation. */
export async function ensureSnapshotIndexes(
  db: Db,
  config: CompiledConfig,
  options: SnapshotIndexOptions,
): Promise<void> {
  const checked = new Set<string>();
  for (const relation of config.relations) {
    const key = snapshotIdIndexKey(relation);
    if (checked.has(`${relation.target}\0${key}`)) continue;
    checked.add(`${relation.target}\0${key}`);

    const indexes = await listIndexes(db, relation.target);
    if (indexes.some((index) => Object.keys(index.key)[0] === key)) continue;

    if (options.autoIndex) {
      await db.collection(relation.target).createIndex({ [key]: 1 });
    } else {
      options.onWarning(
        `Relation "${relation.id}": no index on ${relation.target}.${key}, so sync updates scan the collection. Create it, or pass autoIndex: true.`,
      );
    }
  }
}

async function listIndexes(db: Db, collection: string): Promise<IndexDescriptionInfo[]> {
  try {
    return await db.collection(collection).listIndexes().toArray();
  } catch (error) {
    if (error instanceof MongoServerError && error.code === NAMESPACE_NOT_FOUND) return [];
    throw error;
  }
}
```

- [ ] **Step 4: Run the tests and all checks**

Run: `pnpm vitest run --project unit packages/core/src/engine/preflight.test.ts`
Expected: PASS (4 tests).

Run: `pnpm vitest run --project integration packages/core/test/integration/preflight.test.ts`
Expected: PASS (4 tests).

Run: `pnpm lint && pnpm typecheck`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/engine/preflight.ts packages/core/src/engine/preflight.test.ts \
  packages/core/test/integration/preflight.test.ts
git commit -m "feat(core): check for a replica set and snapshot indexes at startup

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: createSyncEngine

**Files:**
- Create: `packages/core/src/engine/engine.ts`
- Create: `packages/core/test/integration/engine.test.ts`

**Interfaces:**
- Consumes: `assertValidConfig`, `ValidateOptions` (`config/validate.ts`); `buildReverseMap`; `planUpdates`; `normalizeChangeEvent` (Task 2); `executeOperations` (Task 3); `createCursorStore` (Task 4); `assertReplicaSet`, `ensureSnapshotIndexes` (Task 5); `DenormoRuntimeError`.
- Produces:

```ts
export const DEFAULT_STATE_PREFIX = '_denormo_';
export interface SyncEngineOptions {
  readonly db: Db;
  readonly config: CompiledConfig;
  readonly validate?: ValidateOptions;
  readonly statePrefix?: string;
  readonly autoIndex?: boolean;
  readonly onError?: (error: DenormoRuntimeError) => void;
  readonly onWarning?: (message: string) => void;
}
export interface SyncEngine {
  start(): Promise<void>;
  stop(): Promise<void>;
}
export function createSyncEngine(options: SyncEngineOptions): Promise<SyncEngine>;
```

- [ ] **Step 1: Write the failing integration tests**

Create `packages/core/test/integration/engine.test.ts`:

```ts
import { ObjectId, Timestamp } from 'mongodb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DenormoConfigError, DenormoRuntimeError } from '../../src/errors.js';
import {
  createSyncEngine,
  type SyncEngine,
  type SyncEngineOptions,
} from '../../src/engine/engine.js';
import { relation, usersPostsConfig } from '../fixtures.js';
import { type CursorDoc, type PostDoc, type UserDoc, useDatabase, waitFor } from './mongo.js';

const ctx = useDatabase();
const ada = new ObjectId();
const bob = new ObjectId();
const engines: SyncEngine[] = [];

const users = () => ctx.db.collection<UserDoc>('users');
const posts = () => ctx.db.collection<PostDoc>('posts');
const cursors = () => ctx.db.collection<CursorDoc>('_denormo_cursors');

async function startEngine(options: Partial<SyncEngineOptions> = {}) {
  const errors: DenormoRuntimeError[] = [];
  const engine = await createSyncEngine({
    db: ctx.db,
    config: usersPostsConfig(),
    onError: (error) => errors.push(error),
    onWarning: () => undefined,
    ...options,
  });
  engines.push(engine);
  await engine.start();
  return { engine, errors };
}

async function postSnapshot() {
  return (await posts().findOne({ _id: 'p1' }))?.createdBy;
}

/** Resolves once the engine has saved a resume token newer than `previous`. */
async function tokenAdvancedFrom(previous: unknown) {
  await waitFor(async () => {
    const cursor = await cursors().findOne({ _id: 'users' });
    const token = cursor?.resumeToken;
    return token !== undefined && JSON.stringify(token) !== JSON.stringify(previous);
  });
}

async function currentToken(): Promise<unknown> {
  return (await cursors().findOne({ _id: 'users' }))?.resumeToken;
}

beforeEach(async () => {
  await users().insertOne({ _id: ada, name: 'Ada', avatar: 'a.png', role: 'admin', lastLoginAt: 0 });
  await posts().insertOne({
    _id: 'p1',
    createdBy: { _id: ada, name: 'Ada', photo: 'a.png', role: 'admin' },
    comments: [
      { _id: 'c1', author: { _id: ada, name: 'Ada', avatar: 'a.png' } },
      { _id: 'c2', author: { _id: bob, name: 'Bob' } },
    ],
  });
});

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.stop()));
  await ctx.db.dropDatabase();
});

describe('createSyncEngine', () => {
  it('propagates a rename made right after start to flat and array snapshots', async () => {
    const { errors } = await startEngine();
    await users().updateOne({ _id: ada }, { $set: { name: 'Ada Lovelace' } });

    await waitFor(async () => (await postSnapshot())?.name === 'Ada Lovelace');
    const post = await posts().findOne({ _id: 'p1' });
    expect(post?.createdBy).toEqual({
      _id: ada,
      name: 'Ada Lovelace',
      photo: 'a.png',
      role: 'admin',
      _v: expect.any(Timestamp),
    });
    expect(post?.comments?.[0]?.author).toMatchObject({
      name: 'Ada Lovelace',
      _v: expect.any(Timestamp),
    });
    expect(post?.comments?.[1]?.author).toEqual({ _id: bob, name: 'Bob' });
    expect(errors).toEqual([]);
  });

  it('writes nothing for an unsynced field change but still advances the resume token', async () => {
    await startEngine();
    await users().updateOne({ _id: ada }, { $set: { lastLoginAt: 1 } });

    await tokenAdvancedFrom(undefined);
    expect(await postSnapshot()).toEqual({ _id: ada, name: 'Ada', photo: 'a.png', role: 'admin' });
  });

  it('unsets a removed synced field and never touches frozen fields', async () => {
    await startEngine();
    await users().updateOne({ _id: ada }, { $unset: { avatar: '' }, $set: { role: 'guest' } });

    await waitFor(async () => (await postSnapshot())?.photo === undefined);
    expect(await postSnapshot()).toMatchObject({ name: 'Ada', role: 'admin' });
  });

  it('syncs a replace, unsetting synced fields the replacement dropped', async () => {
    await startEngine();
    await users().replaceOne({ _id: ada }, { name: 'Replaced', role: 'guest' });

    await waitFor(async () => (await postSnapshot())?.name === 'Replaced');
    const snapshot = await postSnapshot();
    expect(snapshot).not.toHaveProperty('photo');
    expect(snapshot?.role).toBe('admin');
  });

  it('resumes after a restart from the saved resume token', async () => {
    const first = await startEngine();
    await users().updateOne({ _id: ada }, { $set: { name: 'First' } });
    await waitFor(async () => (await postSnapshot())?.name === 'First');
    const saved = await currentToken();
    await first.engine.stop();

    await users().updateOne({ _id: ada }, { $set: { name: 'While stopped' } });
    await startEngine();

    await waitFor(async () => (await postSnapshot())?.name === 'While stopped');
    await tokenAdvancedFrom(saved);
  });

  it('starts from the current cluster time on first start, without replaying older changes', async () => {
    await users().updateOne({ _id: ada }, { $set: { name: 'Before any engine' } });
    await startEngine();
    await users().updateOne({ _id: ada }, { $set: { lastLoginAt: 2 } });

    await tokenAdvancedFrom(undefined);
    expect((await postSnapshot())?.name).toBe('Ada');
  });

  it('reports a failed target write, keeps the token, and replays the event after restart', async () => {
    await ctx.db.command({
      collMod: 'posts',
      validator: { 'createdBy.name': { $ne: 'Forbidden' } },
      validationAction: 'error',
    });
    const first = await startEngine();
    await users().updateOne({ _id: ada }, { $set: { lastLoginAt: 3 } });
    await tokenAdvancedFrom(undefined);
    const beforeFailure = await currentToken();

    await users().updateOne({ _id: ada }, { $set: { name: 'Forbidden' } });
    await waitFor(() => Promise.resolve(first.errors.length > 0));
    expect(first.errors[0]).toBeInstanceOf(DenormoRuntimeError);
    expect(first.errors[0]).toMatchObject({ code: 'SOURCE_STOPPED', source: 'users' });
    expect(await currentToken()).toEqual(beforeFailure);
    await first.engine.stop();

    await ctx.db.command({ collMod: 'posts', validator: {}, validationLevel: 'off' });
    await startEngine();
    await waitFor(async () => (await postSnapshot())?.name === 'Forbidden');
  });

  it('stops cleanly while an event is in flight', async () => {
    const { engine, errors } = await startEngine();
    await users().updateOne({ _id: ada }, { $set: { name: 'In flight' } });
    await engine.stop();
    expect(errors).toEqual([]);
  });

  it('refuses to start twice', async () => {
    const { engine } = await startEngine();
    await expect(engine.start()).rejects.toMatchObject({ code: 'ALREADY_STARTED' });
  });

  it('refuses an invalid config before opening any stream', async () => {
    const broken = { ...usersPostsConfig(), relations: [relation({ id: 'r', mode: 'stream', path: 'a..b' })] };
    await expect(
      createSyncEngine({ db: ctx.db, config: broken, onWarning: () => undefined }),
    ).rejects.toBeInstanceOf(DenormoConfigError);
  });

  it('does not open a stream for sources whose relations are all readRepair', async () => {
    const config = usersPostsConfig();
    const readRepairOnly = {
      ...config,
      relations: config.relations.map((r) => ({ ...r, mode: 'readRepair' as const })),
    };
    const { errors } = await startEngine({ config: readRepairOnly });
    await users().updateOne({ _id: ada }, { $set: { name: 'Ignored' } });
    await users().updateOne({ _id: ada }, { $set: { lastLoginAt: 4 } });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await currentToken()).toBeUndefined();
    expect((await postSnapshot())?.name).toBe('Ada');
    expect(errors).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run --project integration packages/core/test/integration/engine.test.ts`
Expected: FAIL, `Cannot find module '../../src/engine/engine.js'`.

- [ ] **Step 3: Implement the engine**

Create `packages/core/src/engine/engine.ts`:

```ts
import type { ChangeStream, Db, Document, Timestamp } from 'mongodb';
import { buildReverseMap } from '../config/reverse-map.js';
import type { CompiledConfig } from '../config/types.js';
import { assertValidConfig, type ValidateOptions } from '../config/validate.js';
import { DenormoRuntimeError } from '../errors.js';
import { planUpdates } from '../planner/plan.js';
import { createCursorStore } from '../state/cursors.js';
import { executeOperations } from '../stream/execute.js';
import { normalizeChangeEvent } from '../stream/normalize.js';
import { assertReplicaSet, ensureSnapshotIndexes } from './preflight.js';

export const DEFAULT_STATE_PREFIX = '_denormo_';

/** Deletes are wired in Phase 4; inserts never affect existing snapshots. */
const PIPELINE: Document[] = [{ $match: { operationType: { $in: ['update', 'replace'] } } }];

export interface SyncEngineOptions {
  readonly db: Db;
  /** The compiled config; validated before anything starts. */
  readonly config: CompiledConfig;
  readonly validate?: ValidateOptions;
  /** Prefix of the engine's own collections. Default `_denormo_`. */
  readonly statePrefix?: string;
  /** Create missing `<path>._id` indexes instead of warning. Default false. */
  readonly autoIndex?: boolean;
  /** A source's stream stopped (it resumes on the next `start()`). Default: `console.error`. */
  readonly onError?: (error: DenormoRuntimeError) => void;
  /** Non-fatal startup findings, such as missing indexes. Default: `console.warn`. */
  readonly onWarning?: (message: string) => void;
}

export interface SyncEngine {
  /** Opens one change stream per source; resolves once they are positioned. */
  start(): Promise<void>;
  /** Closes the streams after the event in flight (if any) is done. */
  stop(): Promise<void>;
}

interface RunningSource {
  readonly stream: ChangeStream;
  readonly done: Promise<void>;
}

/** Validates config and deployment, then returns an engine ready to `start()`. */
export async function createSyncEngine(options: SyncEngineOptions): Promise<SyncEngine> {
  const { db, config } = options;
  const onError =
    options.onError ??
    ((error: DenormoRuntimeError) => {
      console.error(error);
    });
  const onWarning =
    options.onWarning ??
    ((message: string) => {
      console.warn(`[denormo] ${message}`);
    });

  assertValidConfig(config, options.validate);
  await assertReplicaSet(db);
  await ensureSnapshotIndexes(db, config, { autoIndex: options.autoIndex ?? false, onWarning });

  const reverseMap = buildReverseMap(config);
  const cursors = createCursorStore(db, options.statePrefix ?? DEFAULT_STATE_PREFIX);
  const sources = [
    ...new Set(config.relations.filter((r) => r.mode === 'stream').map((r) => r.source)),
  ];
  const running = new Map<string, RunningSource>();
  let stopping = false;

  async function openStream(source: string): Promise<ChangeStream> {
    const resumeToken = await cursors.load(source);
    // Without a token, pin the start to "now" so writes after start() are never missed.
    const position =
      resumeToken === undefined
        ? { startAtOperationTime: await currentClusterTime(db) }
        : { resumeAfter: resumeToken };
    return db.collection(source).watch(PIPELINE, { fullDocument: 'updateLookup', ...position });
  }

  async function consume(source: string, stream: ChangeStream): Promise<void> {
    const syncedFields = [...(reverseMap.get(source)?.keys() ?? [])];
    try {
      for await (const change of stream) {
        const event = normalizeChangeEvent(change, syncedFields);
        if (event) await executeOperations(db, planUpdates(config, reverseMap, event));
        // Only after the writes: a crash before this line replays the event, harmlessly.
        await cursors.save(source, stream.resumeToken);
      }
    } catch (error) {
      if (stopping) return;
      onError(
        new DenormoRuntimeError(`Sync for source "${source}" stopped: ${errorMessage(error)}`, {
          code: 'SOURCE_STOPPED',
          source,
          cause: error,
        }),
      );
      await stream.close().catch(() => undefined);
    }
  }

  return {
    async start() {
      if (running.size > 0) {
        throw new DenormoRuntimeError('The sync engine is already running.', {
          code: 'ALREADY_STARTED',
        });
      }
      stopping = false;
      for (const source of sources) {
        const stream = await openStream(source);
        running.set(source, { stream, done: consume(source, stream) });
      }
    },
    async stop() {
      stopping = true;
      const stopped = [...running.values()];
      running.clear();
      await Promise.all(stopped.map(({ stream }) => stream.close()));
      await Promise.all(stopped.map(({ done }) => done));
    },
  };
}

async function currentClusterTime(db: Db): Promise<Timestamp> {
  const reply = await db.admin().command({ ping: 1 });
  const operationTime = reply.operationTime as Timestamp | undefined;
  if (!operationTime) {
    throw new DenormoRuntimeError('The server did not report an operationTime.', {
      code: 'NO_OPERATION_TIME',
    });
  }
  return operationTime;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
```

- [ ] **Step 4: Run the engine tests**

Run: `pnpm vitest run --project integration packages/core/test/integration/engine.test.ts`
Expected: PASS (11 tests).

If "stops cleanly while an event is in flight" reports an error, the driver threw from the closed iterator before `stopping` was observed; confirm `stopping = true` is set before `stream.close()` (it is in `stop()` above).

- [ ] **Step 5: Run the full suite and checks**

Run: `pnpm lint && pnpm typecheck && pnpm test:unit && pnpm test:integration`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/engine/engine.ts packages/core/test/integration/engine.test.ts
git commit -m "feat(core): add createSyncEngine with change streams and resume tokens

One change stream per source collection; events are normalized, planned,
executed as guarded updateMany calls, and only then is the resume token
saved. A failed write stops that source and leaves the token, so the
next start replays the event.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Public API and docs

**Files:**
- Modify: `packages/core/src/index.ts`, `packages/core/src/index.test.ts`
- Modify: `docs/HLD.md` ("Sync engine", "State storage", "Public API surface")

**Interfaces:**
- Consumes: everything above.
- Produces: `@denormo/core` exports `createSyncEngine`, `DEFAULT_STATE_PREFIX`, `DenormoRuntimeError`, and types `SyncEngine`, `SyncEngineOptions`, `DenormoRuntimeErrorOptions`.

- [ ] **Step 1: Update the export test**

In `packages/core/src/index.test.ts`, replace the expected list with:

```ts
    expect(Object.keys(core).sort()).toEqual([
      'CONFIG_VERSION',
      'DEFAULT_MAX_CASCADE_DEPTH',
      'DEFAULT_STATE_PREFIX',
      'DenormoConfigError',
      'DenormoRuntimeError',
      'assertValidConfig',
      'buildReverseMap',
      'createSyncEngine',
      'planUpdates',
      'validateConfig',
    ]);
```

and rename the test to `'exports the Phase 1 runtime surface'`.

Run: `pnpm vitest run --project unit packages/core/src/index.test.ts`
Expected: FAIL, missing `DEFAULT_STATE_PREFIX`, `DenormoRuntimeError`, `createSyncEngine`.

- [ ] **Step 2: Export them**

In `packages/core/src/index.ts`, replace the `errors.js` export block with:

```ts
export {
  DenormoConfigError,
  DenormoRuntimeError,
  type ConfigProblem,
  type DenormoConfigErrorOptions,
  type DenormoRuntimeErrorOptions,
} from './errors.js';
export {
  createSyncEngine,
  DEFAULT_STATE_PREFIX,
  type SyncEngine,
  type SyncEngineOptions,
} from './engine/engine.js';
```

Run: `pnpm vitest run --project unit packages/core/src/index.test.ts`
Expected: PASS.

- [ ] **Step 3: Update the HLD**

In `docs/HLD.md`, "Public API surface", replace the `createSyncEngine` block with:

```js
import { createSyncEngine } from '@denormo/core';
const engine = await createSyncEngine({
  db,                                // a connected mongodb Db
  config,                            // compiled config; validated here
  autoIndex: false,                  // create missing <path>._id indexes instead of warning
  statePrefix: '_denormo_',          // prefix of the engine's own collections
  onError: (error) => {},            // a source's stream stopped (DenormoRuntimeError, code SOURCE_STOPPED)
  onWarning: (message) => {},        // e.g. a missing index
});
await engine.start();                // one change stream per source; resolves once positioned
await engine.stop();                 // finishes the event in flight, then closes the streams
```

In "Sync engine", after the "Per-event flow" list, add:

```markdown
**Phase 1 runner.** Until the job queue lands with batching in Phase 2, the runner executes the planned updates directly (step 6 without step 5) and saves the resume token afterwards. A crash in between replays the event, which the version guard makes harmless. A failed write stops that source's stream without advancing its token and reports `SOURCE_STOPPED`; the next `start()` replays it. On first start without a token the stream begins at the current cluster time. Delete events are wired in Phase 4.
```

In "State storage", in the `_denormo_cursors` row, change the key fields to `` `_id` (source), `resumeToken`, `updatedAt`, `ownerId` (Phase 2) ``.

- [ ] **Step 4: Run all checks and build**

Run: `pnpm lint && pnpm typecheck && pnpm test:unit && pnpm test:integration && pnpm build`
Expected: all pass; `packages/core/dist/index.js` and `index.cjs` build.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/index.ts packages/core/src/index.test.ts docs/HLD.md
git commit -m "feat(core): export createSyncEngine and DenormoRuntimeError

Document the engine options and the Phase 1 runner behaviour in the HLD.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 6: Open the pull request**

Write the PR body to `pr-body.md` in the session scratchpad (not the repo). It contains: a "Summary" of what Tasks 1 to 7 added, the "Decisions in this plan" list copied from the top of this plan, a "Test plan" checklist with the unit and integration test counts and "CI green", and the final line `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

```bash
git push -u origin feat/phase-1a-core-sync-engine
gh pr create --repo denormo/denormo --base main --head feat/phase-1a-core-sync-engine \
  --title "feat(core): Phase 1a core sync engine" --body-file "$SCRATCHPAD/pr-body.md"
gh pr checks --repo denormo/denormo --watch
```

Expected: unit jobs (Node 22, 24) and integration jobs (MongoDB 6.0.29, 7.0.43, 8.0.32) pass.
