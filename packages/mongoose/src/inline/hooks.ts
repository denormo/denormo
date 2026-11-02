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

/** A source write in flight whose copies the post hook will update. */
interface PendingWrite {
  readonly handler: InlineHandler;
  readonly source: string;
  readonly fields: readonly string[];
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
      session: document.$session() ?? undefined,
    });
  });

  schema.post('save', async function () {
    const document = this as unknown as SourceDocument;
    const write = take(document);
    if (!write) return;
    await applyWrite(
      write,
      document.toObject({ getters: false, virtuals: false, depopulate: true }),
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

    const session = query.getOptions().session ?? undefined;
    const srcId = await targetId(query, session);
    if (srcId === undefined) return; // Nothing matches, so nothing changes.
    // Pin the write to the document found here, so the post hook syncs the one that changed.
    query.where({ _id: srcId });
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
    const current = await query.model.collection.findOne(
      { _id: write.srcId as never },
      write.session ? { session: write.session } : {},
    );
    await applyWrite(write, current);
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
  try {
    await write.handler.sync.apply(event, write.session ? { session: write.session } : {});
  } catch (error) {
    // Inside the caller's transaction, fail the write so the transaction can abort.
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
