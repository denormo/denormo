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

/** Keys the sync engine writes into every snapshot; kept when a stored snapshot is cast. */
const ENGINE_KEYS = ['_v', 'deleted'] as const;

/**
 * Schema type for a denormalized copy of another model's document, stored as a plain object.
 * Whatever is assigned (a document of the `ref` model, a lean or `toObject()` copy, or a stored
 * snapshot), only `_id`, the engine's `_v` and `deleted`, and the declared fields (under their
 * `as` names) are kept. Update calls hand Mongoose a plain copy of the source document, so a
 * pass-through for plain objects would leak fields such as `passwordHash`.
 */
export class Snapshot extends mongoose.SchemaType {
  static schemaName = 'Snapshot' as const;

  constructor(path: string, options?: Record<string, unknown>) {
    super(path, options, 'Snapshot');
  }

  override cast(value: unknown): unknown {
    if (value === null || value === undefined) return value;
    const options = this.options as Partial<SnapshotOptions>;
    const fields = options.fields ?? {};
    if (value instanceof mongoose.Document) {
      const { modelName, baseModelName } = value.constructor as {
        modelName?: unknown;
        baseModelName?: unknown;
      };
      if (modelName !== options.ref && baseModelName !== options.ref) {
        throw new Error(
          `Snapshot "${this.path}" copies ${String(options.ref)} documents, got ${String(modelName)}.`,
        );
      }
      // Raw values (no getters), cloned so the snapshot shares no arrays with the source.
      const source = value.toObject({
        getters: false,
        virtuals: false,
        depopulate: true,
      }) as Record<string, unknown>;
      return pickFields(source, fields, 'source');
    }
    if (typeof value === 'object' && '_id' in value) return pickFields(value, fields, 'either');
    throw new Error(
      `Snapshot "${this.path}" must be a ${String(options.ref)} document or an object with _id.`,
    );
  }
}

/**
 * Builds a snapshot from `value`, keeping only `_id`, the engine keys and the declared fields.
 * `names: 'source'` reads each field under its source name (a source document); `'either'` prefers
 * the snapshot name and falls back to the source name (a stored snapshot or a plain source copy).
 */
function pickFields(
  value: object,
  fields: Readonly<Record<string, SnapshotFieldOptions>>,
  names: 'source' | 'either',
): Record<string, unknown> {
  const snapshot: Record<string, unknown> = { _id: readPath(value, '_id').value };
  for (const key of ENGINE_KEYS) {
    const found = readPath(value, key);
    if (found.exists) snapshot[key] = found.value;
  }
  for (const [from, field] of Object.entries(fields)) {
    const to = field.as ?? from;
    const asStored = names === 'either' ? readPath(value, to) : { exists: false as const };
    const found = asStored.exists ? asStored : readPath(value, from);
    if (found.exists && found.value !== undefined) setPath(snapshot, to, found.value);
  }
  return snapshot;
}

function readPath(value: unknown, path: string): { exists: boolean; value?: unknown } {
  let current = value;
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null || !(segment in current)) {
      return { exists: false };
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return { exists: true, value: current };
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
