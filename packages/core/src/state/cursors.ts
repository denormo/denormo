import type { Db, ResumeToken } from 'mongodb';

/** Stored change-stream position per source collection (`_denormo_cursors`). */
export interface CursorStore {
  /** Resolves to `undefined` when the source has no stored position. */
  load(source: string): Promise<ResumeToken>;
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
