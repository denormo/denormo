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
      return copyFields(value as SourceDocument, options.fields ?? {});
    }
    if (typeof value === 'object' && '_id' in value) return value;
    throw new Error(
      `Snapshot "${this.path}" must be a ${String(options.ref)} document or an object with _id.`,
    );
  }
}

/** The parts of a Mongoose document the copy reads. */
interface SourceDocument {
  readonly _id: unknown;
  get(path: string): unknown;
}

function copyFields(
  document: SourceDocument,
  fields: Readonly<Record<string, SnapshotFieldOptions>>,
): Record<string, unknown> {
  const snapshot: Record<string, unknown> = { _id: document._id };
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
