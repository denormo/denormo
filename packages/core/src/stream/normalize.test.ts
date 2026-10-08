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

  describe('array element updates inside a synced field', () => {
    it('copies the whole synced array instead of writing by index ($push)', () => {
      const event = normalizeChangeEvent(
        change({
          operationType: 'update',
          updateDescription: { updatedFields: { 'tags.3': 'd' }, removedFields: [] },
          fullDocument: { _id: ada, tags: ['a', 'b', 'c', 'd'] },
        }),
        SYNCED,
      );
      expect(event?.changed).toEqual({ tags: ['a', 'b', 'c', 'd'] });
    });

    it('copies the whole synced object when an array inside it changes by index', () => {
      const event = normalizeChangeEvent(
        change({
          operationType: 'update',
          updateDescription: { updatedFields: { 'address.lines.2': 'Flat 4' }, removedFields: [] },
          fullDocument: { _id: ada, address: { zip: '0150', lines: ['a', 'b', 'Flat 4'] } },
        }),
        ['address'],
      );
      expect(event?.changed).toEqual({ address: { zip: '0150', lines: ['a', 'b', 'Flat 4'] } });
    });

    it('keeps non-index paths inside a synced field as they are', () => {
      const event = normalizeChangeEvent(
        change({
          operationType: 'update',
          updateDescription: { updatedFields: { 'address.zip': '0151' }, removedFields: [] },
          fullDocument: { _id: ada, address: { zip: '0151' } },
        }),
        ['address'],
      );
      expect(event?.changed).toEqual({ 'address.zip': '0151' });
    });

    it('drops the index path when the document is gone', () => {
      const event = normalizeChangeEvent(
        change({
          operationType: 'update',
          updateDescription: { updatedFields: { 'tags.3': 'd' }, removedFields: [] },
          fullDocument: null,
        }),
        SYNCED,
      );
      expect(event?.changed).toEqual({});
    });
  });

  it.each(['insert', 'delete', 'drop', 'invalidate'])('skips %s events', (operationType) => {
    expect(normalizeChangeEvent(change({ operationType }), SYNCED)).toBeNull();
  });

  it('throws a DenormoRuntimeError when the event has no clusterTime', () => {
    const noTime = change({
      operationType: 'update',
      updateDescription: {},
      clusterTime: undefined,
    });
    expect(() => normalizeChangeEvent(noTime, SYNCED)).toThrow(DenormoRuntimeError);
    expect(() => normalizeChangeEvent(noTime, SYNCED)).toThrow(
      expect.objectContaining({ code: 'MISSING_CLUSTER_TIME', source: 'users' }),
    );
  });
});
