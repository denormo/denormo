/**
 * The compiled config: the plain, versioned object that adapters emit and the engine consumes.
 * This is denormo's public contract (see docs/HLD.md, "Configuration contract").
 * Changing these types is a breaking change.
 */

export const CONFIG_VERSION = 1;

/** What a target snapshot does when its source document is deleted. */
export type OnDeletePolicy = 'markDeleted' | 'unset' | 'keep';

/** How a relation is delivered: write-time fan-out, or version records plus repair on read. */
export type RelationMode = 'stream' | 'readRepair';

export interface SourceConfig {
  /** Source field paths (dot notation) that targets may copy. */
  readonly expose: readonly string[];
}

export interface FieldMapping {
  /** Field path in the source document. */
  readonly from: string;
  /** Field path inside the snapshot, relative to the relation's `path`. */
  readonly to: string;
  /** `true` keeps the copy in sync; `false` freezes it at write time. */
  readonly sync: boolean;
}

export interface RelationConfig {
  /** Unique id, conventionally `<target>.<path without []>`, e.g. `posts.comments.author`. */
  readonly id: string;
  /** Source collection name. */
  readonly source: string;
  /** Target collection name. */
  readonly target: string;
  /**
   * Snapshot location in the target document, in dot notation. Array relations mark the array
   * segment with `[]`: `comments[].author` (snapshot inside each element) or `likedBy[]`
   * (each element is a snapshot). Exactly one `[]` is allowed, and only when `array` is true.
   */
  readonly path: string;
  readonly array: boolean;
  readonly fields: readonly FieldMapping[];
  readonly onDelete: OnDeletePolicy;
  readonly mode: RelationMode;
}

export interface CompiledConfig {
  readonly version: typeof CONFIG_VERSION;
  /** Keyed by source collection name. */
  readonly sources: Readonly<Record<string, SourceConfig>>;
  readonly relations: readonly RelationConfig[];
}
