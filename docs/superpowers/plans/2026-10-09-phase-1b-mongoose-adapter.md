# Phase 1b: Mongoose Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mongoose apps declare snapshots with `type: Snapshot` and sources with the `snapshotSource` plugin, and `createSync({ connection })` compiles those schemas into the core config and runs the Phase 1a sync engine.

**Architecture:** `@denormo/mongoose` adds a custom Mongoose schema type (`Snapshot`) that stores a snapshot as a plain object and, when a source document is assigned, copies `_id` plus the declared fields. A schema walker finds every `Snapshot` path (flat, nested, inside document arrays, arrays of snapshots) and compiles it into core `RelationConfig`s; `snapshotSource` options become the core `sources`. `createSync` compiles, then delegates to core `createSyncEngine` with the connection's `Db`. Core is first made free of runtime `mongodb` imports, so it works with whichever driver copy Mongoose brings (driver 6 for Mongoose 8, driver 7 for Mongoose 9).

**Tech Stack:** TypeScript (strict, ESM), Mongoose 9 (dev) with peer `^8 || ^9`, `@denormo/core` (workspace), Vitest 5 unit + integration projects, `mongodb-memory-server` replica set.

**Spec:** `docs/HLD.md` ("Configuration contract", "Public API surface", Roadmap Phase 1) and `CLAUDE.md`. Phase 1a plan: `docs/superpowers/plans/2026-10-08-phase-1a-core-sync-engine.md`.

## Decisions (approved by the user on 2026-10-09)

1. **`type: Snapshot`** as in the HLD: a custom schema type storing the snapshot as a plain object (like `Mixed`). No field types to declare. Denormo writes copies with `$set`, so Mongoose's change tracking of inner fields is not needed.
2. **Assigning a source document copies the declared fields.** `post.createdBy = user` stores `_id` plus each declared field under its `as` name; everything else (for example `passwordHash`) is left out. Plain objects are stored as given. Assigning a document of a different model is a cast error.
3. **`onDelete` defaults to `keep`**; `mode` defaults to `stream`.
4. **CI tests the adapter against Mongoose 8 and 9.**

## Decisions in this plan (review these)

5. **Core gets no runtime `mongodb` imports** (type imports only), enforced by ESLint. Today core constructs one `Timestamp` and checks `instanceof MongoServerError`; with Mongoose 8 the app's driver uses BSON 6 while core may resolve a driver with BSON 7, and the driver rejects foreign BSON values. Core instead builds the next timestamp with the constructor of the timestamp the server returned, and recognises errors by `code`.
6. **The expose list is read from Mongoose's plugin registry** (`schema.plugins`), which survives `clone()`, `connection.model()` and discriminators. It is not in Mongoose's TypeScript types, so it is read through a narrow cast.
7. **Discriminator models are skipped by the walker.** They share their base model's collection and paths; walking both would duplicate relations. Snapshot paths that exist only on a discriminator schema are not supported in Phase 1b.
8. **`createSync` accepts `mode: 'stream'` only.** Inline mode is plan 1c; passing `'inline'` fails with `DenormoConfigError` code `UNSUPPORTED_MODE`. Options from later phases (`workerId`, `batchSize`, `throttle`) are not accepted yet.
9. **`createSync` requires a connected or connecting connection.** A connection that was never opened fails with `DenormoRuntimeError` code `NOT_CONNECTED` instead of waiting forever.
10. **Snapshot path checks stay in core validation.** The adapter reports adapter-specific problems itself (unknown `ref`, a referenced model without `snapshotSource`, malformed `fields`); everything else (unexposed fields, cycles, depth, reserved names) comes from `validateConfig` when the engine starts. Checking that exposed paths exist on the source schema is Phase 4 ("expose enforcement in the Mongoose adapter").

## Global Constraints

- Node.js 22+; `"engines": { "node": ">=22.12" }`.
- `packages/core` must never import `mongoose`; after Task 1 it must not import `mongodb` at runtime either (type imports only).
- The compiled config types in `packages/core/src/config/types.ts` must not change.
- The planner stays pure.
- Every sync update carries `<path>._v: { $not: { $gt: version } }` and no value conditions (unchanged in this plan).
- Versions are BSON Timestamps from change events; never wall-clock time for ordering.
- Test-first: write the failing test, run it, then implement.
- Named exports only in `packages/*/src`.
- Errors: `DenormoConfigError` (validation, compile) or `DenormoRuntimeError` (engine, connection), each with a `code` and the relation id when relevant.
- Public API changes are reflected in `docs/HLD.md` ("Public API surface") in the same change.
- Commits: Conventional Commits, ending with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. Stage files explicitly; never `git add -A`.
- Adapter peer range stays `mongoose: ^8 || ^9`.

## Review Focus

1. **The same app code works with Mongoose 8 (driver 6) and Mongoose 9 (driver 7).** A foreign BSON value or a failed `instanceof` would break only one of them. Pinned by Task 1 (lint rule plus unit tests) and the Mongoose 8 CI job in Task 6.
2. **A rename made through Mongoose (`updateOne`, `save()`) reaches flat, nested, document-array and array-of-snapshot copies.** Pinned in Task 5.
3. **Assigning a full source document never leaks undeclared fields** such as `passwordHash` into a snapshot. Pinned in Task 2.
4. **A schema that references a model without `snapshotSource`, or an unknown model, fails at `createSync` with a message naming the relation**, not later at runtime. Pinned in Task 4.
5. **Models registered on a separate connection (`mongoose.createConnection`) and custom collection names** compile to the right collection names. Pinned in Task 4 (unit) and Task 5 (integration uses `createConnection`).

---

## File structure

```text
eslint.config.js                                     (modify) core: no runtime mongodb imports
packages/core/src/engine/cluster-time.ts             (create) nextClusterTime (from engine.ts)
packages/core/src/engine/cluster-time.test.ts        (create)
packages/core/src/engine/engine.ts                   (modify) use nextClusterTime, type-only mongodb import
packages/core/src/engine/preflight.ts                (modify) recognise NamespaceNotFound by code
packages/core/src/engine/preflight.test.ts           (modify)

packages/mongoose/src/snapshot-type.ts               (create) Snapshot schema type + option types
packages/mongoose/src/snapshot-type.test.ts          (create)
packages/mongoose/src/source-plugin.ts               (create) snapshotSource + getExposedFields
packages/mongoose/src/source-plugin.test.ts          (create)
packages/mongoose/src/compile.ts                     (create) compileConfig (schema walker)
packages/mongoose/src/compile.test.ts                (create)
packages/mongoose/src/create-sync.ts                 (create) createSync
packages/mongoose/src/index.ts                       (modify) public exports
packages/mongoose/src/index.test.ts                  (create)
packages/mongoose/test/integration/connection.ts     (create) per-file Mongoose connection helper
packages/mongoose/test/integration/create-sync.test.ts (create)
test/integration/wait-for.ts                         (create) shared waitFor
packages/core/test/integration/mongo.ts              (modify) re-export waitFor from the shared file
.github/workflows/ci.yml                             (modify) Mongoose 8 integration job
docs/HLD.md, README.md                               (modify)
```

---

### Task 1: Core without runtime `mongodb` imports

**Files:**
- Modify: `eslint.config.js`
- Create: `packages/core/src/engine/cluster-time.ts`, `packages/core/src/engine/cluster-time.test.ts`
- Modify: `packages/core/src/engine/engine.ts`, `packages/core/src/engine/preflight.ts`, `packages/core/src/engine/preflight.test.ts`

**Interfaces:**
- Consumes: existing engine and preflight code.
- Produces: `nextClusterTime(time: Timestamp): Timestamp` in `engine/cluster-time.ts`; `ensureSnapshotIndexes` behaviour unchanged except that it recognises a missing collection by error code.

- [ ] **Step 0: Branch**

The branch `feat/phase-1b-mongoose-adapter` already exists (it holds the `mongoose` dev dependency added during planning). Check it out and confirm the tree is clean:

```bash
git checkout feat/phase-1b-mongoose-adapter && git status --short
```

Expected: only `packages/mongoose/package.json` and `pnpm-lock.yaml` modified (the `mongoose@^9.11.0` dev dependency) plus this plan. Commit them first:

```bash
git add packages/mongoose/package.json pnpm-lock.yaml docs/superpowers/plans/2026-10-09-phase-1b-mongoose-adapter.md
git commit -m "chore(mongoose): add the Phase 1b plan and mongoose 9 as a dev dependency

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 1: Add the lint rule and watch it fail**

In `eslint.config.js`, add a block after the existing core `no-restricted-imports` block:

```js
  {
    // Core works with whichever driver copy the app brings (Mongoose 8 ships driver 6, Mongoose 9
    // driver 7). BSON values and error classes from another copy are rejected or fail instanceof,
    // so core may only import types from mongodb. Tests may construct values.
    files: ['packages/core/src/**/*.ts'],
    ignores: ['packages/core/src/**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'mongodb',
              allowTypeImports: true,
              message: 'Core may only import types from mongodb (see eslint.config.js).',
            },
          ],
        },
      ],
    },
  },
```

Run: `pnpm exec eslint packages/core/src/engine`
Expected: FAIL with two errors, `'mongodb' import is restricted` in `engine.ts` (line 1, `Timestamp`) and `preflight.ts` (line 1, `MongoServerError`).

Note: the existing core block uses the base `no-restricted-imports` rule for `mongoose`; both rules run side by side.

- [ ] **Step 2: Write the failing test for nextClusterTime**

Create `packages/core/src/engine/cluster-time.test.ts`:

```ts
import { Timestamp } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { nextClusterTime } from './cluster-time.js';

/** Stands in for a Timestamp class from another driver copy. */
class ForeignTimestamp extends Timestamp {}

describe('nextClusterTime', () => {
  it('returns the next increment in the same second', () => {
    const next = nextClusterTime(new Timestamp({ t: 5, i: 1 }));
    expect({ t: next.t, i: next.i }).toEqual({ t: 5, i: 2 });
  });

  it('rolls over to the next second after the largest increment', () => {
    const next = nextClusterTime(new Timestamp({ t: 5, i: 0xffff_ffff }));
    expect({ t: next.t, i: next.i }).toEqual({ t: 6, i: 0 });
  });

  it("builds the result with the input's own class, so it matches the app's driver", () => {
    const next = nextClusterTime(new ForeignTimestamp({ t: 5, i: 1 }));
    expect(next).toBeInstanceOf(ForeignTimestamp);
  });
});
```

Run: `pnpm vitest run --project unit packages/core/src/engine/cluster-time.test.ts`
Expected: FAIL, `Cannot find module './cluster-time.js'`.

- [ ] **Step 3: Implement it and use it in the engine**

Create `packages/core/src/engine/cluster-time.ts`:

```ts
import type { Timestamp } from 'mongodb';

const MAX_INCREMENT = 0xffff_ffff;

type TimestampClass = new (value: { t: number; i: number }) => Timestamp;

/**
 * The smallest cluster time after `time`. Built with `time`'s own constructor: the value goes back
 * to the server through the app's driver, which rejects BSON values from another driver copy.
 */
export function nextClusterTime(time: Timestamp): Timestamp {
  const Next = time.constructor as TimestampClass;
  const { t, i } = time;
  return i < MAX_INCREMENT ? new Next({ t, i: i + 1 }) : new Next({ t: t + 1, i: 0 });
}
```

In `packages/core/src/engine/engine.ts`:
- change line 1 to `import type { ChangeStream, Db, Document, Timestamp } from 'mongodb';`
- add `import { nextClusterTime } from './cluster-time.js';` after the `./preflight.js` import
- replace `nextTimestamp(await currentClusterTime(db))` with `nextClusterTime(await currentClusterTime(db))`
- delete the `nextTimestamp` function and its doc comment.

Run: `pnpm vitest run --project unit packages/core/src/engine/cluster-time.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 4: Write the failing test for the error-code check**

Append to `packages/core/src/engine/preflight.test.ts` (add `ensureSnapshotIndexes` to the import from `./preflight.js`, and `usersPostsConfig` to the import from `../../test/fixtures.js`):

```ts
describe('ensureSnapshotIndexes', () => {
  it('treats NamespaceNotFound from any driver copy as "no indexes yet"', async () => {
    // A plain object, not this package's MongoServerError: the app's driver may be another copy.
    const missing = Object.assign(new Error('ns does not exist'), {
      code: 26,
      codeName: 'NamespaceNotFound',
    });
    const db = {
      collection: () => ({ indexes: () => Promise.reject(missing) }),
    } as unknown as Db;
    const warnings: string[] = [];

    await ensureSnapshotIndexes(db, usersPostsConfig(), {
      autoIndex: false,
      onWarning: (message) => warnings.push(message),
    });

    expect(warnings).toHaveLength(2);
  });

  it('rethrows other errors', async () => {
    const db = {
      collection: () => ({ indexes: () => Promise.reject(new Error('auth failed')) }),
    } as unknown as Db;
    await expect(
      ensureSnapshotIndexes(db, usersPostsConfig(), { autoIndex: false, onWarning: () => undefined }),
    ).rejects.toThrow('auth failed');
  });
});
```

Run: `pnpm vitest run --project unit packages/core/src/engine/preflight.test.ts`
Expected: FAIL in "treats NamespaceNotFound…" (the error is rethrown because it is not a `MongoServerError`).

- [ ] **Step 5: Recognise the error by code**

In `packages/core/src/engine/preflight.ts`:
- change line 1 to `import type { Db, IndexDescriptionInfo } from 'mongodb';`
- replace the `if (error instanceof MongoServerError && …)` line with `if (isNamespaceNotFound(error)) return [];`
- append:

```ts
/** By code, not `instanceof`: the error may come from the app's own driver copy. */
function isNamespaceNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, codeName } = error as { code?: unknown; codeName?: unknown };
  return code === NAMESPACE_NOT_FOUND || codeName === 'NamespaceNotFound';
}
```

Run: `pnpm vitest run --project unit packages/core/src/engine/preflight.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Run all checks and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test:unit && pnpm test:integration`
Expected: all pass; `pnpm exec eslint packages/core/src/engine` reports nothing.

```bash
git add eslint.config.js packages/core/src/engine/cluster-time.ts packages/core/src/engine/cluster-time.test.ts \
  packages/core/src/engine/engine.ts packages/core/src/engine/preflight.ts packages/core/src/engine/preflight.test.ts
git commit -m "fix(core): import only types from mongodb

Mongoose 8 ships driver 6 (BSON 6) while core may resolve a driver with
BSON 7; the app's driver rejects BSON values from another copy, and
instanceof fails across copies. Core now builds the next cluster time
with the constructor of the timestamp the server returned, recognises
NamespaceNotFound by code, and an ESLint rule keeps runtime mongodb
imports out of packages/core/src.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: The `Snapshot` schema type

**Files:**
- Create: `packages/mongoose/src/snapshot-type.ts`, `packages/mongoose/src/snapshot-type.test.ts`

**Interfaces:**
- Consumes: `mongoose` (peer).
- Produces:

```ts
export type SnapshotOnDelete = 'markDeleted' | 'unset' | 'keep';
export type SnapshotMode = 'stream' | 'readRepair';
export interface SnapshotFieldOptions { readonly sync: boolean; readonly as?: string }
export interface SnapshotOptions {
  readonly ref: string;
  readonly fields: Readonly<Record<string, SnapshotFieldOptions>>;
  readonly onDelete?: SnapshotOnDelete;
  readonly mode?: SnapshotMode;
}
export class Snapshot extends mongoose.SchemaType { static schemaName: 'Snapshot'; cast(value: unknown): unknown }
```

- [ ] **Step 1: Write the failing tests**

Create `packages/mongoose/src/snapshot-type.test.ts`:

```ts
import mongoose from 'mongoose';
import { beforeEach, describe, expect, it } from 'vitest';
import { Snapshot } from './snapshot-type.js';

const fields = {
  name: { sync: true },
  avatar: { sync: true, as: 'photo' },
  role: { sync: false },
};

let connection: mongoose.Connection;

beforeEach(() => {
  // No URI: models can be built and validated without a database.
  connection = mongoose.createConnection();
});

function models() {
  const User = connection.model(
    'User',
    new mongoose.Schema({ name: String, avatar: String, role: String, passwordHash: String }),
  );
  const Org = connection.model('Org', new mongoose.Schema({ name: String }));
  const Post = connection.model(
    'Post',
    new mongoose.Schema({
      title: String,
      createdBy: { type: Snapshot, ref: 'User', fields },
      comments: [{ text: String, author: { type: Snapshot, ref: 'User', fields: { name: { sync: true } } } }],
      likedBy: [{ type: Snapshot, ref: 'User', fields: { name: { sync: true } } }],
    }),
  );
  return { User, Org, Post };
}

describe('Snapshot schema type', () => {
  it('copies _id and the declared fields (renamed) when a source document is assigned', () => {
    const { User, Post } = models();
    const ada = new User({ name: 'Ada', avatar: 'a.png', role: 'admin', passwordHash: 'secret' });
    const post = new Post({ title: 'Hi', createdBy: ada });

    expect(post.toObject().createdBy).toEqual({
      _id: ada._id,
      name: 'Ada',
      photo: 'a.png',
      role: 'admin',
    });
  });

  it('never copies undeclared fields such as passwordHash', () => {
    const { User, Post } = models();
    const ada = new User({ name: 'Ada', passwordHash: 'secret' });
    const post = new Post({ createdBy: ada, comments: [{ text: 'x', author: ada }], likedBy: [ada] });
    const stored = JSON.stringify(post.toObject());

    expect(stored).not.toContain('secret');
    expect(stored).not.toContain('passwordHash');
  });

  it('works inside document arrays and as array elements', () => {
    const { User, Post } = models();
    const ada = new User({ name: 'Ada', avatar: 'a.png' });
    const post = new Post({ comments: [{ text: 'x', author: ada }], likedBy: [ada] });
    const plain = post.toObject();

    expect(plain.comments?.[0]?.author).toEqual({ _id: ada._id, name: 'Ada' });
    expect(plain.likedBy?.[0]).toEqual({ _id: ada._id, name: 'Ada' });
  });

  it('stores a plain object with _id as given', () => {
    const { Post } = models();
    const snapshot = { _id: new mongoose.Types.ObjectId(), name: 'Ada', photo: 'a.png' };
    expect(new Post({ createdBy: snapshot }).toObject().createdBy).toEqual(snapshot);
  });

  it('allows null and undefined', () => {
    const { Post } = models();
    expect(new Post({ createdBy: null }).validateSync()).toBeUndefined();
    expect(new Post({}).validateSync()).toBeUndefined();
  });

  it('rejects a document of another model', () => {
    const { Org, Post } = models();
    const post = new Post({ createdBy: new Org({ name: 'Acme' }) });
    expect(post.validateSync()?.errors.createdBy).toBeDefined();
  });

  it('rejects values that are not snapshots', () => {
    const { Post } = models();
    expect(new Post({ createdBy: 'Ada' }).validateSync()?.errors.createdBy).toBeDefined();
    expect(new Post({ createdBy: { name: 'no id' } }).validateSync()?.errors.createdBy).toBeDefined();
  });
});
```

Run: `pnpm vitest run --project unit packages/mongoose/src/snapshot-type.test.ts`
Expected: FAIL, `Cannot find module './snapshot-type.js'`.

- [ ] **Step 2: Implement the schema type**

Create `packages/mongoose/src/snapshot-type.ts`:

```ts
import mongoose from 'mongoose';

export type SnapshotOnDelete = 'markDeleted' | 'unset' | 'keep';
export type SnapshotMode = 'stream' | 'readRepair';

export interface SnapshotFieldOptions {
  /** `true` keeps the copy in sync; `false` freezes it at write time. */
  readonly sync: boolean;
  /** Name inside the snapshot, when it differs from the source field. */
  readonly as?: string;
}

/** Options of a `{ type: Snapshot, ... }` schema path. */
export interface SnapshotOptions {
  /** Name of the source model. */
  readonly ref: string;
  /** Source field → how it is copied. */
  readonly fields: Readonly<Record<string, SnapshotFieldOptions>>;
  /** What happens to the copy when the source is deleted. Default `keep`. */
  readonly onDelete?: SnapshotOnDelete;
  /** Default `stream`. */
  readonly mode?: SnapshotMode;
}

/**
 * Schema type for a denormalized copy of another model's document, stored as a plain object.
 * Assigning a document of the `ref` model copies its `_id` and the declared fields (renamed by
 * `as`); plain objects with an `_id` are stored as given.
 */
export class Snapshot extends mongoose.SchemaType {
  static schemaName = 'Snapshot' as const;

  constructor(path: string, options?: Record<string, unknown>) {
    super(path, options, 'Snapshot');
  }

  override cast(value: unknown): unknown {
    if (value === null || value === undefined) return value;
    const options = this.options as Partial<SnapshotOptions>;
    if (value instanceof mongoose.Document) {
      const modelName = (value.constructor as { modelName?: unknown }).modelName;
      if (modelName !== options.ref) {
        throw new Error(
          `Snapshot "${this.path}" copies ${String(options.ref)} documents, got ${String(modelName)}.`,
        );
      }
      return copyFields(value, options.fields ?? {});
    }
    if (typeof value === 'object' && '_id' in value) return value;
    throw new Error(`Snapshot "${this.path}" must be a ${String(options.ref)} document or an object with _id.`);
  }
}

function copyFields(
  document: mongoose.Document,
  fields: Readonly<Record<string, SnapshotFieldOptions>>,
): Record<string, unknown> {
  const snapshot: Record<string, unknown> = { _id: document._id as unknown };
  for (const [from, field] of Object.entries(fields)) {
    const value: unknown = document.get(from);
    if (value !== undefined) setPath(snapshot, field.as ?? from, value);
  }
  return snapshot;
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.');
  const last = segments.pop() ?? path;
  let current = target;
  for (const segment of segments) {
    const next = current[segment];
    if (typeof next !== 'object' || next === null) current[segment] = {};
    current = current[segment] as Record<string, unknown>;
  }
  current[last] = value;
}

// Mongoose resolves `type: Snapshot` by its schemaName in Schema.Types.
(mongoose.Schema.Types as unknown as Record<string, unknown>).Snapshot = Snapshot;
```

- [ ] **Step 3: Run the tests and checks**

Run: `pnpm vitest run --project unit packages/mongoose/src/snapshot-type.test.ts`
Expected: PASS (7 tests).

Run: `pnpm lint && pnpm typecheck`
Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add packages/mongoose/src/snapshot-type.ts packages/mongoose/src/snapshot-type.test.ts
git commit -m "feat(mongoose): add the Snapshot schema type

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The `snapshotSource` plugin

**Files:**
- Create: `packages/mongoose/src/source-plugin.ts`, `packages/mongoose/src/source-plugin.test.ts`

**Interfaces:**
- Consumes: `DenormoConfigError` from `@denormo/core`.
- Produces: `interface SnapshotSourceOptions { readonly expose: readonly string[] }`; `snapshotSource(schema: Schema, options: SnapshotSourceOptions): void`; `getExposedFields(schema: Schema): readonly string[] | undefined`.

- [ ] **Step 1: Write the failing tests**

Create `packages/mongoose/src/source-plugin.test.ts`:

```ts
import { DenormoConfigError } from '@denormo/core';
import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';
import { getExposedFields, snapshotSource } from './source-plugin.js';

function userSchema() {
  const schema = new mongoose.Schema({ name: String, avatar: String, passwordHash: String });
  schema.plugin(snapshotSource, { expose: ['name', 'avatar'] });
  return schema;
}

describe('snapshotSource', () => {
  it('records the exposed fields on the schema', () => {
    expect(getExposedFields(userSchema())).toEqual(['name', 'avatar']);
  });

  it('reports nothing for a schema without the plugin', () => {
    expect(getExposedFields(new mongoose.Schema({ name: String }))).toBeUndefined();
  });

  it('keeps the exposed fields through clone(), connection.model() and discriminators', () => {
    const schema = userSchema();
    expect(getExposedFields(schema.clone())).toEqual(['name', 'avatar']);

    const connection = mongoose.createConnection();
    const User = connection.model('User', schema);
    expect(getExposedFields(User.schema)).toEqual(['name', 'avatar']);

    const Admin = User.discriminator('Admin', new mongoose.Schema({ level: Number }));
    expect(getExposedFields(Admin.schema)).toEqual(['name', 'avatar']);
  });

  it('rejects options without an expose list', () => {
    const schema = new mongoose.Schema({ name: String });
    const bad = { exposed: ['name'] } as unknown as { expose: string[] };
    expect(() => schema.plugin(snapshotSource, bad)).toThrow(DenormoConfigError);
    expect(() => schema.plugin(snapshotSource, bad)).toThrow(
      expect.objectContaining({ code: 'INVALID_SNAPSHOT_SOURCE' }),
    );
  });
});
```

Run: `pnpm vitest run --project unit packages/mongoose/src/source-plugin.test.ts`
Expected: FAIL, `Cannot find module './source-plugin.js'`.

- [ ] **Step 2: Implement the plugin**

Create `packages/mongoose/src/source-plugin.ts`:

```ts
import { DenormoConfigError } from '@denormo/core';
import type { Schema } from 'mongoose';

export interface SnapshotSourceOptions {
  /** Source field paths (dot notation) that snapshots may copy. */
  readonly expose: readonly string[];
}

/** Marks a schema as a snapshot source. Fields not listed in `expose` can never be copied. */
export function snapshotSource(_schema: Schema, options: SnapshotSourceOptions): void {
  const expose: unknown = (options as Partial<SnapshotSourceOptions> | undefined)?.expose;
  if (!Array.isArray(expose) || !expose.every((field) => typeof field === 'string')) {
    throw new DenormoConfigError('snapshotSource needs { expose: string[] }.', {
      code: 'INVALID_SNAPSHOT_SOURCE',
      problems: [],
    });
  }
  // Nothing to store: Mongoose keeps plugins and their options on the schema (see below).
}

interface RegisteredPlugin {
  readonly fn: unknown;
  readonly opts?: unknown;
}

/**
 * The `expose` list a schema registered with `snapshotSource`, read from Mongoose's plugin
 * registry (`schema.plugins`), which survives `clone()`, `connection.model()` and discriminators.
 * It is not in Mongoose's TypeScript types.
 */
export function getExposedFields(schema: Schema): readonly string[] | undefined {
  const plugins = (schema as unknown as { plugins?: readonly RegisteredPlugin[] }).plugins ?? [];
  const registration = plugins.find((plugin) => plugin.fn === snapshotSource);
  return (registration?.opts as SnapshotSourceOptions | undefined)?.expose;
}
```

- [ ] **Step 3: Run the tests and checks**

Run: `pnpm vitest run --project unit packages/mongoose/src/source-plugin.test.ts`
Expected: PASS (4 tests).

Run: `pnpm lint && pnpm typecheck`
Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add packages/mongoose/src/source-plugin.ts packages/mongoose/src/source-plugin.test.ts
git commit -m "feat(mongoose): add the snapshotSource plugin

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Compile Mongoose models into the core config

**Files:**
- Create: `packages/mongoose/src/compile.ts`, `packages/mongoose/src/compile.test.ts`

**Interfaces:**
- Consumes: `Snapshot`, `SnapshotOptions` (Task 2); `getExposedFields` (Task 3); `CONFIG_VERSION`, `DenormoConfigError`, `validateConfig`, types `CompiledConfig`, `RelationConfig`, `SourceConfig` from `@denormo/core`.
- Produces: `type AnyModel` (any Mongoose model); `compileConfig(models: readonly AnyModel[]): CompiledConfig`.

- [ ] **Step 1: Write the failing tests**

Create `packages/mongoose/src/compile.test.ts`:

```ts
import { DenormoConfigError, validateConfig } from '@denormo/core';
import mongoose from 'mongoose';
import { beforeEach, describe, expect, it } from 'vitest';
import { compileConfig } from './compile.js';
import { Snapshot } from './snapshot-type.js';
import { snapshotSource } from './source-plugin.js';

let connection: mongoose.Connection;

beforeEach(() => {
  connection = mongoose.createConnection();
});

function userModel(collection?: string) {
  const schema = new mongoose.Schema({ name: String, avatar: String, role: String });
  schema.plugin(snapshotSource, { expose: ['name', 'avatar', 'role'] });
  return connection.model('User', schema, collection);
}

function postModel() {
  return connection.model(
    'Post',
    new mongoose.Schema({
      createdBy: {
        type: Snapshot,
        ref: 'User',
        fields: { name: { sync: true }, avatar: { sync: true, as: 'photo' }, role: { sync: false } },
        onDelete: 'markDeleted',
      },
      meta: { editor: { type: Snapshot, ref: 'User', fields: { name: { sync: true } } } },
      comments: [{ text: String, author: { type: Snapshot, ref: 'User', fields: { name: { sync: true } } } }],
      likedBy: [{ type: Snapshot, ref: 'User', fields: { name: { sync: true } } }],
    }),
  );
}

describe('compileConfig', () => {
  it('compiles every snapshot path into a relation', () => {
    const config = compileConfig([userModel(), postModel()]);
    const byId = new Map(config.relations.map((relation) => [relation.id, relation]));

    expect([...byId.keys()].sort()).toEqual([
      'posts.comments.author',
      'posts.createdBy',
      'posts.likedBy',
      'posts.meta.editor',
    ]);
    expect(byId.get('posts.createdBy')).toEqual({
      id: 'posts.createdBy',
      source: 'users',
      target: 'posts',
      path: 'createdBy',
      array: false,
      fields: [
        { from: 'name', to: 'name', sync: true },
        { from: 'avatar', to: 'photo', sync: true },
        { from: 'role', to: 'role', sync: false },
      ],
      onDelete: 'markDeleted',
      mode: 'stream',
    });
    expect(byId.get('posts.meta.editor')).toMatchObject({ path: 'meta.editor', array: false });
    expect(byId.get('posts.comments.author')).toMatchObject({ path: 'comments[].author', array: true });
    expect(byId.get('posts.likedBy')).toMatchObject({ path: 'likedBy[]', array: true });
  });

  it('defaults onDelete to keep and mode to stream', () => {
    const config = compileConfig([userModel(), postModel()]);
    const editor = config.relations.find((relation) => relation.id === 'posts.meta.editor');
    expect(editor).toMatchObject({ onDelete: 'keep', mode: 'stream' });
  });

  it('takes sources from snapshotSource, keyed by collection name', () => {
    const config = compileConfig([userModel('people'), postModel()]);
    expect(config.sources).toEqual({ people: { expose: ['name', 'avatar', 'role'] } });
    expect(new Set(config.relations.map((relation) => relation.source))).toEqual(new Set(['people']));
  });

  it('produces a config that core validation accepts', () => {
    expect(validateConfig(compileConfig([userModel(), postModel()]))).toEqual([]);
  });

  it('only walks the models it is given, but resolves refs on their connection', () => {
    userModel();
    const config = compileConfig([postModel()]);
    expect(config.relations).toHaveLength(4);
    expect(Object.keys(config.sources)).toEqual(['users']);
  });

  it('fails when the referenced model has no snapshotSource plugin', () => {
    connection.model('User', new mongoose.Schema({ name: String }));
    expect(() => compileConfig([postModel()])).toThrow(
      expect.objectContaining({
        name: 'DenormoConfigError',
        code: 'SOURCE_NOT_DECLARED',
        relationId: 'posts.createdBy',
      }),
    );
  });

  it('fails when the referenced model does not exist', () => {
    expect(() => compileConfig([postModel()])).toThrow(
      expect.objectContaining({ code: 'UNKNOWN_REF', relationId: 'posts.createdBy' }),
    );
  });

  it('fails when a field is not declared as { sync: boolean }', () => {
    userModel();
    const Bad = connection.model(
      'Bad',
      new mongoose.Schema({ createdBy: { type: Snapshot, ref: 'User', fields: { name: true } } }),
    );
    expect(() => compileConfig([Bad])).toThrow(DenormoConfigError);
    expect(() => compileConfig([Bad])).toThrow(
      expect.objectContaining({ code: 'INVALID_SNAPSHOT_FIELD', relationId: 'bads.createdBy' }),
    );
  });

  it('skips discriminator models, which share their base model', () => {
    const User = userModel();
    const Post = postModel();
    const Pinned = Post.discriminator('PinnedPost', new mongoose.Schema({ pinnedAt: Date }));
    expect(compileConfig([User, Post, Pinned]).relations).toHaveLength(4);
  });
});
```

Run: `pnpm vitest run --project unit packages/mongoose/src/compile.test.ts`
Expected: FAIL, `Cannot find module './compile.js'`.

- [ ] **Step 2: Implement the walker**

Create `packages/mongoose/src/compile.ts`:

```ts
import {
  CONFIG_VERSION,
  type CompiledConfig,
  DenormoConfigError,
  type RelationConfig,
  type SourceConfig,
} from '@denormo/core';
import mongoose, { type Model, type Schema } from 'mongoose';
import { Snapshot, type SnapshotOptions } from './snapshot-type.js';
import { getExposedFields } from './source-plugin.js';

/** Any Mongoose model, whatever its document type. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- models of every document type
export type AnyModel = Model<any>;

interface FoundSnapshot {
  /** Core relation path, with `[]` marking array segments. */
  readonly path: string;
  readonly options: Partial<SnapshotOptions>;
}

/**
 * Compiles the snapshot paths of `models` into the core config. Referenced models are looked up
 * on each model's own connection, so they need not be in `models`.
 */
export function compileConfig(models: readonly AnyModel[]): CompiledConfig {
  const sources: Record<string, SourceConfig> = {};
  const relations: RelationConfig[] = [];

  for (const model of models) {
    // Discriminators share their base model's collection and paths.
    if (model.baseModelName !== undefined) continue;
    const target = model.collection.collectionName;

    for (const found of findSnapshots(model.schema, '')) {
      const id = `${target}.${found.path.replaceAll('[]', '')}`;
      const ref = found.options.ref;
      const source = typeof ref === 'string' ? model.db.models[ref] : undefined;
      if (!source) {
        throw new DenormoConfigError(
          `Relation "${id}": ref ${JSON.stringify(ref)} is not a model on this connection.`,
          { code: 'UNKNOWN_REF', relationId: id, problems: [] },
        );
      }
      const expose = getExposedFields(source.schema);
      if (!expose) {
        throw new DenormoConfigError(
          `Relation "${id}": model "${source.modelName}" has no snapshotSource plugin, so it exposes nothing.`,
          { code: 'SOURCE_NOT_DECLARED', relationId: id, problems: [] },
        );
      }
      const sourceCollection = source.collection.collectionName;
      sources[sourceCollection] = { expose: [...expose] };
      relations.push({
        id,
        source: sourceCollection,
        target,
        path: found.path,
        array: found.path.includes('[]'),
        fields: toFieldMappings(id, found.options.fields),
        onDelete: found.options.onDelete ?? 'keep',
        mode: found.options.mode ?? 'stream',
      });
    }
  }

  return { version: CONFIG_VERSION, sources, relations };
}

/** Every `Snapshot` path in a schema, including nested paths and array elements. */
function findSnapshots(schema: Schema, prefix: string): FoundSnapshot[] {
  const found: FoundSnapshot[] = [];
  schema.eachPath((path, type) => {
    if (type instanceof Snapshot) {
      found.push({ path: `${prefix}${path}`, options: type.options as Partial<SnapshotOptions> });
    } else if (type instanceof mongoose.Schema.Types.DocumentArray) {
      found.push(...findSnapshots(type.schema, `${prefix}${path}[].`));
    } else if (type instanceof mongoose.Schema.Types.Subdocument) {
      found.push(...findSnapshots(type.schema, `${prefix}${path}.`));
    } else if (
      type instanceof mongoose.Schema.Types.Array &&
      type.embeddedSchemaType instanceof Snapshot
    ) {
      found.push({
        path: `${prefix}${path}[]`,
        options: type.embeddedSchemaType.options as Partial<SnapshotOptions>,
      });
    }
  });
  return found;
}

function toFieldMappings(id: string, fields: SnapshotOptions['fields'] | undefined) {
  return Object.entries(fields ?? {}).map(([from, field]) => {
    // Schemas are untyped at runtime: `field` may be anything, e.g. `true`.
    const spec: unknown = field;
    const { sync, as } = (typeof spec === 'object' && spec !== null ? spec : {}) as Partial<{
      sync: unknown;
      as: unknown;
    }>;
    if (typeof sync !== 'boolean' || (as !== undefined && typeof as !== 'string')) {
      throw new DenormoConfigError(
        `Relation "${id}": field "${from}" must be { sync: boolean, as?: string }.`,
        { code: 'INVALID_SNAPSHOT_FIELD', relationId: id, problems: [] },
      );
    }
    return { from, to: as ?? from, sync };
  });
}
```

- [ ] **Step 3: Run the tests and checks**

Run: `pnpm vitest run --project unit packages/mongoose/src/compile.test.ts`
Expected: PASS (9 tests).

Run: `pnpm lint && pnpm typecheck`
Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add packages/mongoose/src/compile.ts packages/mongoose/src/compile.test.ts
git commit -m "feat(mongoose): compile Mongoose schemas into the core config

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `createSync` end to end

**Files:**
- Create: `test/integration/wait-for.ts`
- Modify: `packages/core/test/integration/mongo.ts` (re-export `waitFor`)
- Create: `packages/mongoose/test/integration/connection.ts`
- Create: `packages/mongoose/src/create-sync.ts`
- Create: `packages/mongoose/test/integration/create-sync.test.ts`

**Interfaces:**
- Consumes: `compileConfig`, `AnyModel` (Task 4); `createSyncEngine`, `CompiledConfig`, `DenormoConfigError`, `DenormoRuntimeError`, `SyncEngine`, `SyncEngineOptions` from `@denormo/core`.
- Produces:

```ts
export interface CreateSyncOptions {
  readonly connection: Connection;
  readonly models?: readonly AnyModel[];
  readonly mode?: 'stream';
  readonly validate?: SyncEngineOptions['validate'];
  readonly autoIndex?: boolean;
  readonly statePrefix?: string;
  readonly onError?: (error: DenormoRuntimeError) => void;
  readonly onWarning?: (message: string) => void;
}
export interface MongooseSync extends SyncEngine { readonly config: CompiledConfig }
export function createSync(options: CreateSyncOptions): Promise<MongooseSync>;
```

- [ ] **Step 1: Share waitFor**

Create `test/integration/wait-for.ts`:

```ts
/** Polls `check` until it returns true; fails after `timeoutMs`. */
export async function waitFor(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Condition not met within ${String(timeoutMs)} ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
```

In `packages/core/test/integration/mongo.ts`, delete the `waitFor` function and add at the end of the imports:

```ts
export { waitFor } from '../../../../test/integration/wait-for.js';
```

Run: `pnpm test:integration`
Expected: all core integration tests still pass (33).

- [ ] **Step 2: Write the connection helper**

Create `packages/mongoose/test/integration/connection.ts`:

```ts
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { afterAll, beforeAll, inject } from 'vitest';

export interface TestConnection {
  connection: mongoose.Connection;
}

/** One Mongoose connection per test file, to a fresh database dropped afterwards. */
export function useConnection(): TestConnection {
  const state = {} as TestConnection;
  beforeAll(async () => {
    state.connection = await mongoose
      .createConnection(inject('mongoUri'), { dbName: `denormo_${randomUUID().slice(0, 8)}` })
      .asPromise();
  });
  afterAll(async () => {
    await state.connection.dropDatabase();
    await state.connection.close();
  });
  return state;
}

declare module 'vitest' {
  export interface ProvidedContext {
    mongoUri: string;
  }
}
```

- [ ] **Step 3: Write the failing integration tests**

Create `packages/mongoose/test/integration/create-sync.test.ts`:

```ts
import { DenormoConfigError, DenormoRuntimeError } from '@denormo/core';
import mongoose from 'mongoose';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { waitFor } from '../../../../test/integration/wait-for.js';
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
  passwordHash?: string;
}
interface SnapshotDoc {
  _id: mongoose.Types.ObjectId;
  name?: string;
  photo?: string;
  role?: string;
  _v?: mongoose.mongo.Timestamp;
}
interface PostDoc {
  title: string;
  createdBy?: SnapshotDoc;
  comments: { text: string; author?: SnapshotDoc }[];
  likedBy: SnapshotDoc[];
}

let User: mongoose.Model<UserDoc>;
let Post: mongoose.Model<PostDoc>;

beforeAll(() => {
  const userSchema = new mongoose.Schema<UserDoc>({
    name: String,
    avatar: String,
    role: String,
    passwordHash: String,
  });
  userSchema.plugin(snapshotSource, { expose: ['name', 'avatar', 'role'] });
  User = ctx.connection.model<UserDoc>('User', userSchema);
  Post = ctx.connection.model<PostDoc>(
    'Post',
    new mongoose.Schema<PostDoc>({
      title: String,
      createdBy: {
        type: Snapshot,
        ref: 'User',
        fields: { name: { sync: true }, avatar: { sync: true, as: 'photo' }, role: { sync: false } },
      },
      comments: [{ text: String, author: { type: Snapshot, ref: 'User', fields: { name: { sync: true } } } }],
      likedBy: [{ type: Snapshot, ref: 'User', fields: { name: { sync: true } } }],
    }),
  );
});

beforeEach(async () => {
  await Promise.all([User.deleteMany({}), Post.deleteMany({})]);
});

afterEach(async () => {
  await Promise.all(syncs.splice(0).map((sync) => sync.stop()));
});

async function startSync() {
  const errors: DenormoRuntimeError[] = [];
  const sync = await createSync({
    connection: ctx.connection,
    onError: (error) => errors.push(error),
    onWarning: () => undefined,
  });
  syncs.push(sync);
  await sync.start();
  return { sync, errors };
}

async function seed() {
  const ada = await User.create({ name: 'Ada', avatar: 'a.png', role: 'admin', passwordHash: 'secret' });
  const post = await Post.create({
    title: 'Hello',
    createdBy: ada,
    comments: [{ text: 'First', author: ada }],
    likedBy: [ada],
  });
  return { ada, post };
}

async function reload(id: unknown) {
  return Post.findById(id).lean<PostDoc>();
}

describe('createSync', () => {
  it('compiles the connection’s models into the core config', async () => {
    const { sync } = await startSync();
    expect(sync.config.relations.map((relation) => relation.id).sort()).toEqual([
      'posts.comments.author',
      'posts.createdBy',
      'posts.likedBy',
    ]);
    expect(sync.config.sources).toEqual({ users: { expose: ['name', 'avatar', 'role'] } });
  });

  it('propagates a rename made with updateOne to every kind of snapshot path', async () => {
    const { ada, post } = await seed();
    const { errors } = await startSync();

    await User.updateOne({ _id: ada._id }, { $set: { name: 'Ada Lovelace', avatar: 'b.png' } });

    await waitFor(async () => (await reload(post._id))?.likedBy[0]?.name === 'Ada Lovelace');
    const synced = await reload(post._id);
    expect(synced?.createdBy).toMatchObject({ name: 'Ada Lovelace', photo: 'b.png', role: 'admin' });
    expect(synced?.comments[0]?.author?.name).toBe('Ada Lovelace');
    expect(synced?.createdBy?._v).toBeInstanceOf(mongoose.mongo.Timestamp);
    expect(errors).toEqual([]);
  });

  it('propagates a change saved through a document', async () => {
    const { ada, post } = await seed();
    await startSync();

    ada.name = 'Saved';
    await ada.save();

    await waitFor(async () => (await reload(post._id))?.createdBy?.name === 'Saved');
  });

  it('never syncs a frozen field', async () => {
    const { ada, post } = await seed();
    await startSync();

    await User.updateOne({ _id: ada._id }, { $set: { role: 'guest', name: 'Marker' } });

    await waitFor(async () => (await reload(post._id))?.createdBy?.name === 'Marker');
    expect((await reload(post._id))?.createdBy?.role).toBe('admin');
  });

  it('refuses a connection that was never opened', async () => {
    const closed = mongoose.createConnection();
    await expect(createSync({ connection: closed })).rejects.toBeInstanceOf(DenormoRuntimeError);
    await expect(createSync({ connection: closed })).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
  });

  it('refuses inline mode until it exists', async () => {
    const inline = { connection: ctx.connection, mode: 'inline' } as unknown as Parameters<
      typeof createSync
    >[0];
    await expect(createSync(inline)).rejects.toBeInstanceOf(DenormoConfigError);
    await expect(createSync(inline)).rejects.toMatchObject({ code: 'UNSUPPORTED_MODE' });
  });
});
```

Run: `pnpm vitest run --project integration packages/mongoose/test/integration/create-sync.test.ts`
Expected: FAIL, `Cannot find module '../../src/create-sync.js'`.

- [ ] **Step 4: Implement createSync**

Create `packages/mongoose/src/create-sync.ts`:

```ts
import {
  type CompiledConfig,
  createSyncEngine,
  DenormoConfigError,
  DenormoRuntimeError,
  type SyncEngine,
  type SyncEngineOptions,
} from '@denormo/core';
import type { Connection } from 'mongoose';
import { type AnyModel, compileConfig } from './compile.js';

export interface CreateSyncOptions {
  /** A connected (or connecting) Mongoose connection. */
  readonly connection: Connection;
  /** Models to compile. Default: every model registered on the connection. */
  readonly models?: readonly AnyModel[];
  /** Only `stream` for now; `inline` arrives with plan 1c. */
  readonly mode?: 'stream';
  readonly validate?: SyncEngineOptions['validate'];
  readonly autoIndex?: boolean;
  readonly statePrefix?: string;
  readonly onError?: (error: DenormoRuntimeError) => void;
  readonly onWarning?: (message: string) => void;
}

export interface MongooseSync extends SyncEngine {
  /** The compiled config the engine runs. */
  readonly config: CompiledConfig;
}

/** Mongoose `readyState` values. */
const DISCONNECTED = 0;
const CONNECTING = 2;

/** Compiles the connection's Mongoose schemas and returns a sync engine ready to `start()`. */
export async function createSync(options: CreateSyncOptions): Promise<MongooseSync> {
  const { connection, models, mode = 'stream', ...engineOptions } = options;
  if ((mode as string) !== 'stream') {
    throw new DenormoConfigError(`Sync mode "${String(mode)}" is not supported yet.`, {
      code: 'UNSUPPORTED_MODE',
      problems: [],
    });
  }

  if (connection.readyState === CONNECTING) await connection.asPromise();
  const db = connection.readyState === DISCONNECTED ? undefined : connection.db;
  if (!db) {
    throw new DenormoRuntimeError('The Mongoose connection is not open; connect it before createSync().', {
      code: 'NOT_CONNECTED',
    });
  }

  const config = compileConfig(models ?? Object.values(connection.models));
  const engine = await createSyncEngine({ ...engineOptions, db, config });
  return { config, start: () => engine.start(), stop: () => engine.stop() };
}
```

- [ ] **Step 5: Run the tests and checks**

Run: `pnpm vitest run --project integration packages/mongoose/test/integration/create-sync.test.ts`
Expected: PASS (6 tests).

Run: `pnpm lint && pnpm typecheck && pnpm test:unit && pnpm test:integration`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add test/integration/wait-for.ts packages/core/test/integration/mongo.ts \
  packages/mongoose/test/integration/connection.ts packages/mongoose/src/create-sync.ts \
  packages/mongoose/test/integration/create-sync.test.ts
git commit -m "feat(mongoose): add createSync running the core engine on Mongoose models

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Public API, Mongoose 8 CI job, docs

**Files:**
- Modify: `packages/mongoose/src/index.ts`
- Create: `packages/mongoose/src/index.test.ts`
- Modify: `.github/workflows/ci.yml`, `docs/HLD.md`, `README.md`

**Interfaces:**
- Consumes: Tasks 2 to 5.
- Produces: `@denormo/mongoose` exports `Snapshot`, `snapshotSource`, `getExposedFields`, `compileConfig`, `createSync`, and types `SnapshotOptions`, `SnapshotFieldOptions`, `SnapshotOnDelete`, `SnapshotMode`, `SnapshotSourceOptions`, `AnyModel`, `CreateSyncOptions`, `MongooseSync`.

- [ ] **Step 1: Write the failing export test**

Create `packages/mongoose/src/index.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import * as adapter from './index.js';

describe('@denormo/mongoose public API', () => {
  it('exports the Phase 1b runtime surface', () => {
    expect(Object.keys(adapter).sort()).toEqual([
      'Snapshot',
      'compileConfig',
      'createSync',
      'getExposedFields',
      'snapshotSource',
    ]);
  });
});
```

Run: `pnpm vitest run --project unit packages/mongoose/src/index.test.ts`
Expected: FAIL (the stub exports nothing).

- [ ] **Step 2: Export them**

Replace `packages/mongoose/src/index.ts`:

```ts
export {
  Snapshot,
  type SnapshotFieldOptions,
  type SnapshotMode,
  type SnapshotOnDelete,
  type SnapshotOptions,
} from './snapshot-type.js';
export { getExposedFields, snapshotSource, type SnapshotSourceOptions } from './source-plugin.js';
export { type AnyModel, compileConfig } from './compile.js';
export { createSync, type CreateSyncOptions, type MongooseSync } from './create-sync.js';
```

Run: `pnpm vitest run --project unit packages/mongoose/src/index.test.ts`
Expected: PASS.

- [ ] **Step 3: Add the Mongoose 8 CI job**

Append to `.github/workflows/ci.yml` under `jobs:`:

```yaml
  integration-mongoose-8:
    name: Integration tests (Mongoose 8, MongoDB 8.0.32)
    runs-on: ubuntu-latest
    env:
      MONGOMS_VERSION: '8.0.32'
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
          key: mongodb-${{ runner.os }}-8.0.32
      - run: pnpm install --frozen-lockfile
      # Mongoose 8 brings driver 6 (BSON 6); core keeps its driver 7 dev copy, which proves core
      # works with whichever driver the app's Mongoose uses.
      - run: pnpm --filter @denormo/mongoose add -D mongoose@^8
      - run: pnpm vitest run --project integration packages/mongoose
```

Verify locally that the adapter tests pass on Mongoose 8, then restore Mongoose 9:

```bash
cp packages/mongoose/package.json pnpm-lock.yaml "$SCRATCHPAD"/
pnpm --filter @denormo/mongoose add -D mongoose@^8
pnpm vitest run --project integration packages/mongoose
cp "$SCRATCHPAD"/package.json packages/mongoose/package.json && cp "$SCRATCHPAD"/pnpm-lock.yaml pnpm-lock.yaml && pnpm install
```

Expected: `Tests  6 passed (6)` on Mongoose 8; afterwards `git diff --stat packages/mongoose/package.json pnpm-lock.yaml` shows no changes.

- [ ] **Step 4: Update the docs**

In `docs/HLD.md`, "Public API surface", replace the `@denormo/mongoose` block with:

```js
import mongoose from 'mongoose';
import { Snapshot, snapshotSource, createSync } from '@denormo/mongoose';

UserSchema.plugin(snapshotSource, { expose: ['name', 'avatar', 'role'] });
const PostSchema = new mongoose.Schema({
  createdBy: {
    type: Snapshot,
    ref: 'User',
    fields: { name: { sync: true }, avatar: { sync: true, as: 'photo' }, role: { sync: false } },
    onDelete: 'markDeleted',             // default 'keep'
  },
});
post.createdBy = user;                   // copies _id + declared fields; never passwordHash

const sync = await createSync({
  connection: mongoose.connection,       // connected (or connecting)
  models: [User, Post],                  // or omit to compile every model on the connection
  mode: 'stream',                        // 'inline' arrives in Phase 1c
  autoIndex: false,
  onError: (error) => {},
  onWarning: (message) => {},
});
await sync.start();
await sync.stop();
// Later phases add: workerId, batchSize, throttle, sync.on(...), reconcile(), status().
```

In "Configuration contract", after the "Target side (Mongoose)" block, add:

```markdown
Assigning a source document to a snapshot path (`post.createdBy = user`) stores `_id` plus the declared fields under their `as` names; nothing else is copied. Plain objects with an `_id` are stored as given. Snapshots may sit at any depth: nested objects (`meta.editor`), inside document arrays (`comments[].author`), or as array elements (`likedBy: [{ type: Snapshot, ... }]`). Discriminator models are not walked separately (Phase 1b).
```

In `README.md`, add after the packages table:

~~~markdown
## Usage (Mongoose)

```js
import { Snapshot, snapshotSource, createSync } from '@denormo/mongoose';

UserSchema.plugin(snapshotSource, { expose: ['name', 'avatar'] });
PostSchema.add({
  createdBy: { type: Snapshot, ref: 'User', fields: { name: { sync: true }, avatar: { sync: true } } },
});

const sync = await createSync({ connection: mongoose.connection });
await sync.start();
```

Requires a MongoDB replica set or sharded cluster (change streams).
~~~

- [ ] **Step 5: Run all checks, build, commit**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`
Expected: all pass; `packages/mongoose/dist/index.js` exists and imports `mongoose` and `@denormo/core` without bundling them (`grep -c 'from "mongoose"' packages/mongoose/dist/index.js` is at least 1).

```bash
git add packages/mongoose/src/index.ts packages/mongoose/src/index.test.ts .github/workflows/ci.yml docs/HLD.md README.md
git commit -m "feat(mongoose): export the adapter API and test it on Mongoose 8 in CI

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 6: Final review and PR**

After the final whole-branch review and its fixes, write the PR body to `pr-body.md` in the session scratchpad: a "Summary" of Tasks 1 to 6, the "Decisions" lists from the top of this plan, a "Test plan" checklist with the unit and integration test counts and CI status, ending with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

```bash
git push -u origin feat/phase-1b-mongoose-adapter
gh pr create --repo denormo/denormo --base main --head feat/phase-1b-mongoose-adapter \
  --title "feat(mongoose): Phase 1b Mongoose adapter" --body-file "$SCRATCHPAD/pr-body.md"
gh pr checks --repo denormo/denormo --watch
```

Expected: unit (Node 22, 24), integration (MongoDB 6.0.29, 7.0.43, 8.0.32) and integration (Mongoose 8) all pass.
