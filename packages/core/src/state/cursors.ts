import type { Db, ResumeToken, Timestamp } from 'mongodb';

/** Where a source's change stream continues from. */
export type StreamPosition =
  | { readonly resumeAfter: ResumeToken }
  /** Saved on a source's first start, so a restart before any event resumes from that point. */
  | { readonly startAtOperationTime: Timestamp };

/** Stored change-stream position per source collection (`_denormo_cursors`). */
export interface CursorStore {
  load(source: string): Promise<StreamPosition | undefined>;
  save(source: string, position: StreamPosition): Promise<void>;
}

interface CursorDocument {
  _id: string;
  resumeToken?: ResumeToken;
  startAtOperationTime?: Timestamp;
  /** For observability only; ordering never uses wall-clock time. */
  updatedAt: Date;
}

export function createCursorStore(db: Db, prefix: string): CursorStore {
  const cursors = db.collection<CursorDocument>(`${prefix}cursors`);
  return {
    async load(source) {
      const cursor = await cursors.findOne({ _id: source });
      if (cursor?.resumeToken !== undefined) return { resumeAfter: cursor.resumeToken };
      if (cursor?.startAtOperationTime)
        return { startAtOperationTime: cursor.startAtOperationTime };
      return undefined;
    },
    async save(source, position) {
      const update =
        'resumeAfter' in position
          ? {
              $set: { resumeToken: position.resumeAfter, updatedAt: new Date() },
              $unset: { startAtOperationTime: '' as const },
            }
          : {
              $set: { startAtOperationTime: position.startAtOperationTime, updatedAt: new Date() },
              $unset: { resumeToken: '' as const },
            };
      await cursors.updateOne({ _id: source }, update, {
        upsert: true,
        writeConcern: { w: 'majority' },
      });
    },
  };
}
