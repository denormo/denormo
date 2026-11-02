import { DenormoRuntimeError, type NormalizedChangeEvent } from '@denormo/core';
import type { ClientSession, Connection, MongooseQueryMiddleware, Query, Schema } from 'mongoose';
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
    const fields = affectedFields(
      document.directModifiedPaths(),
      handler.sync.syncedFields(source),
    );
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
      await applyWrite(
        write,
        document.toObject({ getters: false, virtuals: false, depopulate: true }),
      );
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
    const touched = REPLACEMENTS.has(queryOp(query)) ? 'all' : touchedPaths(query.getUpdate());
    const fields = affectedFields(touched, handler.sync.syncedFields(source));
    if (fields.length === 0) return;

    const existing = query.getOptions().session ?? undefined;
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
      await release(write, () => query.setOptions({ session: null }));
    }
  });
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
  try {
    const version = write.session.operationTime;
    if (!version) {
      throw new DenormoRuntimeError(
        'The write reported no operationTime; inline mode needs a replica set.',
        {
          code: 'NO_OPERATION_TIME',
          source: write.source,
        },
      );
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
