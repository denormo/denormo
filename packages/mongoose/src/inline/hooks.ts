import { DenormoRuntimeError, type NormalizedChangeEvent } from '@denormo/core';
import type {
  ClientSession,
  Connection,
  mongo,
  MongooseQueryMiddleware,
  Query,
  Schema,
} from 'mongoose';
import { readPath } from '../paths.js';
import { activeInline, type InlineHandler } from './registry.js';
import { affectedFields, touchedPaths } from './touched.js';

const QUERY_WRITES: MongooseQueryMiddleware[] = [
  'updateOne',
  'findOneAndUpdate',
  'replaceOne',
  'findOneAndReplace',
];
const REPLACEMENTS = new Set<string>(['replaceOne', 'findOneAndReplace']);
/** These return the document, so its `_id` comes from the result and the write is never pinned. */
const RETURNS_DOCUMENT = new Set<string>(['findOneAndUpdate', 'findOneAndReplace']);

/** A source write in flight whose copies the post hook will update. */
interface PendingWrite {
  readonly handler: InlineHandler;
  readonly source: string;
  readonly fields: readonly string[];
  /** Known before the write (exact `_id` filter or lookup); otherwise taken from the result. */
  readonly srcId: unknown;
  /** A cluster time read just before the write: never later than the write itself. */
  readonly version: mongo.Timestamp;
  /** The caller's session, if the write ran in one; the copies join it (and its transaction). */
  readonly session: ClientSession | undefined;
}

/** Keyed by the document or query running the write. */
const pending = new WeakMap<object, PendingWrite>();

/** Minimal shape of a hydrated document, as the hooks use it. */
interface SourceDocument {
  readonly isNew: boolean;
  readonly db: Connection;
  readonly collection: { readonly collectionName: string };
  readonly _id: unknown;
  directModifiedPaths(): string[];
  $session(): ClientSession | null;
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
    // A failed earlier save never reached its post hook; drop what it left behind.
    pending.delete(document);
    if (document.isNew) return;
    const handler = activeInline(document.db);
    if (!handler) return;
    const source = document.collection.collectionName;
    const fields = affectedFields(
      document.directModifiedPaths(),
      handler.sync.syncedFields(source),
    );
    if (fields.length === 0) return;

    pending.set(document, {
      handler,
      source,
      fields,
      srcId: document._id,
      version: await clusterTimeBeforeWrite(document.db, source),
      session: document.$session() ?? asyncLocalSession(document.db),
    });
  });

  schema.post('save', async function () {
    const document = this as unknown as SourceDocument;
    const write = take(document);
    if (!write) return;
    await applyWrite(write, () =>
      Promise.resolve(document.toObject({ getters: false, virtuals: false, depopulate: true })),
    );
  });

  schema.pre(QUERY_WRITES, async function () {
    const query = this as unknown as Query<unknown, unknown>;
    const model = query.model;
    const handler = activeInline(model.db);
    if (!handler) return;
    const source = model.collection.collectionName;
    const touched = REPLACEMENTS.has(queryOp(query)) ? 'all' : touchedPaths(query.getUpdate());
    const fields = affectedFields(touched, handler.sync.syncedFields(source));
    if (fields.length === 0) return;

    const options = query.getOptions();
    const session = options.session ?? asyncLocalSession(model.db);
    let srcId: unknown;
    if (!RETURNS_DOCUMENT.has(queryOp(query))) {
      const filter = query.getFilter() as Record<string, unknown>;
      srcId = exactId(query, filter._id);
      if (srcId === undefined) {
        srcId = await lookUpId(query, filter, session);
        if (srcId === undefined) return; // Nothing matches, so nothing changes.
        // Pin the write to the document found here, so the post hook syncs the one that changed.
        // Not for upserts: if that document vanished meanwhile, a pinned upsert would re-create
        // it under its old _id.
        if (options.upsert !== true) query.where({ _id: srcId });
      }
    }
    pending.set(query, {
      handler,
      source,
      fields,
      srcId,
      version: await clusterTimeBeforeWrite(model.db, source),
      session,
    });
  });

  schema.post(QUERY_WRITES, async function (result: unknown) {
    const query = this as unknown as Query<unknown, unknown>;
    const write = take(query);
    if (!write || !wroteSomething(result)) return;
    const srcId = write.srcId ?? idOfResult(result);
    if (srcId === undefined) return;
    await applyWrite({ ...write, srcId }, () =>
      query.model.collection.findOne(
        { _id: srcId as never },
        { readPreference: 'primary', ...(write.session ? { session: write.session } : {}) },
      ),
    );
  });
}

/**
 * The server's cluster time right now, before the write: a lower bound of the write's own time.
 * The `operationTime` returned after a write can include later writes from other clients under
 * load, and a copy versioned too late would block a real newer change. A version that is too
 * early is harmless: the stream (or the next write) re-applies with a later one.
 */
async function clusterTimeBeforeWrite(connection: Connection, source: string) {
  const reply = await connection.db?.command({ ping: 1 });
  const operationTime = reply?.operationTime as mongo.Timestamp | undefined;
  if (!operationTime) {
    throw new DenormoRuntimeError(
      'The server reported no operationTime; inline mode needs a replica set.',
      { code: 'NO_OPERATION_TIME', source },
    );
  }
  return operationTime;
}

/** The operation a query runs (`updateOne`, ...); not in Mongoose's TypeScript types. */
function queryOp(query: Query<unknown, unknown>): string {
  return (query as unknown as { op?: string }).op ?? '';
}

function take(owner: object): PendingWrite | undefined {
  const write = pending.get(owner);
  pending.delete(owner);
  return write;
}

/**
 * A filter's `_id` when it names exactly one document, cast to the schema's `_id` type (a string
 * from a request becomes an ObjectId); `undefined` for operators, regexes and the like.
 */
function exactId(query: Query<unknown, unknown>, value: unknown): unknown {
  if (value === undefined || value === null || value instanceof RegExp) return undefined;
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return undefined; // An operator object such as { $in: [...] }.
  }
  try {
    return query.model.schema.path('_id').cast(value);
  } catch {
    return undefined;
  }
}

/** The `_id` the write will change, found the way the write finds it (sort, collation, hint). */
async function lookUpId(
  query: Query<unknown, unknown>,
  filter: Record<string, unknown>,
  session: ClientSession | undefined,
): Promise<unknown> {
  const { sort, collation, hint } = query.getOptions() as {
    sort?: unknown;
    collation?: unknown;
    hint?: unknown;
  };
  const lookup = query.model
    .findOne(filter)
    .select('_id')
    .read('primary')
    .session(session ?? null);
  if (sort !== undefined) lookup.sort(sort as never);
  if (collation !== undefined) lookup.collation(collation as never);
  if (hint !== undefined) lookup.hint(hint);
  const found = (await lookup.lean()) as { _id?: unknown } | null;
  return found?._id;
}

/** `_id` of the document a findOneAnd* call returned (plain or with result metadata). */
function idOfResult(result: unknown): unknown {
  const { _id, value } = result as { _id?: unknown; value?: { _id?: unknown } | null };
  return _id ?? value?._id;
}

/** A transaction session Mongoose supplies through async local storage, if one is active. */
function asyncLocalSession(connection: Connection): ClientSession | undefined {
  const { transactionAsyncLocalStorage } = connection.base as unknown as {
    transactionAsyncLocalStorage?: { getStore(): { session?: ClientSession } | undefined };
  };
  return transactionAsyncLocalStorage?.getStore()?.session;
}

/** False when the write matched nothing (update/replace result, or a null findOneAnd* result). */
function wroteSomething(result: unknown): boolean {
  if (result === null || result === undefined) return false;
  const { matchedCount, value } = result as { matchedCount?: unknown; value?: unknown };
  if (typeof matchedCount === 'number') return matchedCount > 0;
  return value !== null; // includeResultMetadata: { value: null } means nothing matched.
}

/**
 * Loads the written source document, turns it into an event and applies it to the copies. The
 * app's write already happened: failures go to `onError`, except inside the caller's
 * transaction, where they fail the write so the transaction can abort.
 */
async function applyWrite(write: PendingWrite, load: () => Promise<unknown>): Promise<void> {
  try {
    const document = await load();
    if (document === null || document === undefined) return;
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
      version: write.version,
      changed,
      removed,
    };
    await write.handler.sync.apply(event, write.session ? { session: write.session } : {});
  } catch (error) {
    if (write.session?.inTransaction()) throw error;
    write.handler.onError(
      new DenormoRuntimeError(`Inline sync of "${write.source}" failed.`, {
        code: 'INLINE_SYNC_FAILED',
        source: write.source,
        cause: error,
      }),
    );
  }
}
