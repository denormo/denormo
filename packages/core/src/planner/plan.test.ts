import { ObjectId, Timestamp } from 'mongodb';
import { describe, expect, it } from 'vitest';
import {
  configWith,
  postsCommentsAuthor,
  postsCreatedBy,
  relation,
  usersPostsConfig,
} from '../../test/fixtures.js';
import { buildReverseMap } from '../config/reverse-map.js';
import type { CompiledConfig, RelationConfig } from '../config/types.js';
import { planUpdates } from './plan.js';
import type { NormalizedChangeEvent, PlannedOperation } from './types.js';

const userId = new ObjectId('64b7f0c2a1b2c3d4e5f60718');
const T1 = new Timestamp({ t: 1_760_000_000, i: 1 });
const T2 = new Timestamp({ t: 1_760_000_000, i: 2 });

function event(overrides: Partial<NormalizedChangeEvent> = {}): NormalizedChangeEvent {
  return {
    op: 'update',
    source: 'users',
    srcId: userId,
    version: T1,
    changed: {},
    removed: [],
    ...overrides,
  };
}

function plan(e: NormalizedChangeEvent, config: CompiledConfig = usersPostsConfig()) {
  const ops = planUpdates(config, buildReverseMap(config), e);
  ops.forEach(expectGuarded);
  return ops;
}

function planFor(e: NormalizedChangeEvent, ...relations: RelationConfig[]) {
  return plan(e, configWith(...relations));
}

function only(ops: PlannedOperation[]): PlannedOperation {
  expect(ops).toHaveLength(1);
  return ops[0] as PlannedOperation;
}

/** Every key in the update document's operators, e.g. `createdBy.name`. */
function updatedPaths(op: PlannedOperation): string[] {
  return Object.values(op.update).flatMap((fields) => Object.keys(fields as object));
}

/** Hard rule 4: every planned update carries the version guard; never positional `$`. */
function expectGuarded(op: PlannedOperation) {
  const conditions = JSON.stringify([op.filter, op.arrayFilters ?? []]);
  expect(conditions).toMatch(/_v":\{"\$lt"/);
  expect(conditions).not.toContain('$lte');
  for (const path of updatedPaths(op)) expect(path.split('.')).not.toContain('$');
}

describe('planUpdates', () => {
  describe('skipping', () => {
    it('returns nothing when no synced field changed', () => {
      expect(plan(event({ changed: { lastLoginAt: new Date() } }))).toEqual([]);
    });

    it('returns nothing when only a frozen field changed', () => {
      expect(plan(event({ changed: { role: 'admin' }, removed: ['role'] }))).toEqual([]);
    });

    it('returns nothing for a source with no relations', () => {
      expect(plan(event({ source: 'orgs', changed: { name: 'Acme' } }))).toEqual([]);
    });

    it('skips readRepair relations, which never fan out', () => {
      const readRepair: RelationConfig = { ...postsCreatedBy, mode: 'readRepair' };
      expect(planFor(event({ changed: { name: 'Ada' } }), readRepair)).toEqual([]);
      expect(planFor(event({ op: 'delete' }), readRepair)).toEqual([]);
    });
  });

  describe('flat paths', () => {
    it('sets the changed field and _v behind the version guard and no-op filter', () => {
      expect(planFor(event({ changed: { name: 'Ada' } }), postsCreatedBy)).toEqual([
        {
          relationId: 'posts.createdBy',
          collection: 'posts',
          filter: {
            'createdBy._id': userId,
            'createdBy._v': { $lt: T1 },
            'createdBy.name': { $ne: 'Ada' },
          },
          update: { $set: { 'createdBy.name': 'Ada', 'createdBy._v': T1 } },
        },
      ]);
    });

    it('writes renamed fields to their target name', () => {
      const op = only(planFor(event({ changed: { avatar: 'a.png' } }), postsCreatedBy));
      expect(op.update).toEqual({ $set: { 'createdBy.photo': 'a.png', 'createdBy._v': T1 } });
      expect(op.filter).toMatchObject({ 'createdBy.photo': { $ne: 'a.png' } });
    });

    it('matches documents where any changed value differs', () => {
      const op = only(
        planFor(event({ changed: { name: 'Ada', avatar: 'a.png' } }), postsCreatedBy),
      );
      expect(op.filter).toEqual({
        'createdBy._id': userId,
        'createdBy._v': { $lt: T1 },
        $or: [{ 'createdBy.name': { $ne: 'Ada' } }, { 'createdBy.photo': { $ne: 'a.png' } }],
      });
      expect(op.update).toEqual({
        $set: { 'createdBy.name': 'Ada', 'createdBy.photo': 'a.png', 'createdBy._v': T1 },
      });
    });

    it('unsets the target field when a synced source field is removed', () => {
      const op = only(planFor(event({ removed: ['avatar'] }), postsCreatedBy));
      expect(op.filter).toEqual({
        'createdBy._id': userId,
        'createdBy._v': { $lt: T1 },
        'createdBy.photo': { $exists: true },
      });
      expect(op.update).toEqual({
        $set: { 'createdBy._v': T1 },
        $unset: { 'createdBy.photo': '' },
      });
    });

    it('combines sets and unsets from one event', () => {
      const op = only(
        planFor(event({ changed: { name: 'Ada' }, removed: ['avatar'] }), postsCreatedBy),
      );
      expect(op.filter.$or).toEqual([
        { 'createdBy.name': { $ne: 'Ada' } },
        { 'createdBy.photo': { $exists: true } },
      ]);
      expect(op.update).toEqual({
        $set: { 'createdBy.name': 'Ada', 'createdBy._v': T1 },
        $unset: { 'createdBy.photo': '' },
      });
    });

    it('supports nested snapshot paths', () => {
      const nested = relation({ id: 'posts.meta.createdBy', path: 'meta.createdBy' });
      const op = only(planFor(event({ changed: { name: 'Ada' } }), nested));
      expect(op.filter).toMatchObject({ 'meta.createdBy._id': userId });
      expect(op.update).toEqual({
        $set: { 'meta.createdBy.name': 'Ada', 'meta.createdBy._v': T1 },
      });
    });
  });

  describe('frozen fields', () => {
    it('never writes a frozen field, even when it changes alongside synced ones', () => {
      const ops = plan(event({ changed: { name: 'Ada', role: 'admin' }, removed: ['role'] }));
      expect(ops).toHaveLength(2);
      for (const op of ops) {
        expect(updatedPaths(op).some((path) => path.endsWith('.role'))).toBe(false);
        expect(JSON.stringify(op.filter)).not.toContain('role');
      }
    });

    it('never writes a frozen field on replace', () => {
      const op = only(
        planFor(
          event({ op: 'replace', changed: { _id: userId, name: 'Ada', role: 'admin' } }),
          postsCreatedBy,
        ),
      );
      expect(updatedPaths(op)).toEqual(['createdBy.name', 'createdBy._v']);
    });
  });

  describe('array paths', () => {
    it('targets matching elements through a named arrayFilters identifier', () => {
      expect(planFor(event({ changed: { name: 'Ada' } }), postsCommentsAuthor)).toEqual([
        {
          relationId: 'posts.comments.author',
          collection: 'posts',
          filter: {
            comments: {
              $elemMatch: {
                'author._id': userId,
                'author._v': { $lt: T1 },
                'author.name': { $ne: 'Ada' },
              },
            },
          },
          update: {
            $set: { 'comments.$[elem].author.name': 'Ada', 'comments.$[elem].author._v': T1 },
          },
          arrayFilters: [
            {
              'elem.author._id': userId,
              'elem.author._v': { $lt: T1 },
              'elem.author.name': { $ne: 'Ada' },
            },
          ],
        },
      ]);
    });

    it('uses $or for the no-op filter inside elements', () => {
      const op = only(
        planFor(event({ changed: { name: 'Ada' }, removed: ['avatar'] }), postsCommentsAuthor),
      );
      expect(op.update).toEqual({
        $set: { 'comments.$[elem].author.name': 'Ada', 'comments.$[elem].author._v': T1 },
        $unset: { 'comments.$[elem].author.avatar': '' },
      });
      expect(op.arrayFilters).toEqual([
        {
          'elem.author._id': userId,
          'elem.author._v': { $lt: T1 },
          $or: [
            { 'elem.author.name': { $ne: 'Ada' } },
            { 'elem.author.avatar': { $exists: true } },
          ],
        },
      ]);
      expect(op.filter).toEqual({
        comments: {
          $elemMatch: {
            'author._id': userId,
            'author._v': { $lt: T1 },
            $or: [{ 'author.name': { $ne: 'Ada' } }, { 'author.avatar': { $exists: true } }],
          },
        },
      });
    });

    it('handles arrays whose elements are the snapshots', () => {
      const likedBy = relation({ id: 'posts.likedBy', path: 'likedBy[]', array: true });
      const op = only(planFor(event({ changed: { name: 'Ada' } }), likedBy));
      expect(op.filter).toEqual({
        likedBy: { $elemMatch: { _id: userId, _v: { $lt: T1 }, name: { $ne: 'Ada' } } },
      });
      expect(op.update).toEqual({
        $set: { 'likedBy.$[elem].name': 'Ada', 'likedBy.$[elem]._v': T1 },
      });
      expect(op.arrayFilters).toEqual([
        { 'elem._id': userId, 'elem._v': { $lt: T1 }, 'elem.name': { $ne: 'Ada' } },
      ]);
    });
  });

  describe('delete events', () => {
    const del = () => event({ op: 'delete' });

    it('markDeleted sets the deleted flag on flat snapshots', () => {
      expect(planFor(del(), postsCreatedBy)).toEqual([
        {
          relationId: 'posts.createdBy',
          collection: 'posts',
          filter: {
            'createdBy._id': userId,
            'createdBy._v': { $lt: T1 },
            'createdBy.deleted': { $ne: true },
          },
          update: { $set: { 'createdBy.deleted': true, 'createdBy._v': T1 } },
        },
      ]);
    });

    it('markDeleted sets the deleted flag on array snapshots', () => {
      const op = only(planFor(del(), postsCommentsAuthor));
      expect(op.update).toEqual({
        $set: { 'comments.$[elem].author.deleted': true, 'comments.$[elem].author._v': T1 },
      });
      expect(op.arrayFilters).toEqual([
        {
          'elem.author._id': userId,
          'elem.author._v': { $lt: T1 },
          'elem.author.deleted': { $ne: true },
        },
      ]);
    });

    it('unset removes a flat snapshot', () => {
      const op = only(planFor(del(), { ...postsCreatedBy, onDelete: 'unset' }));
      expect(op.filter).toEqual({ 'createdBy._id': userId, 'createdBy._v': { $lt: T1 } });
      expect(op.update).toEqual({ $unset: { createdBy: '' } });
    });

    it('unset removes the snapshot inside array elements', () => {
      const op = only(planFor(del(), { ...postsCommentsAuthor, onDelete: 'unset' }));
      expect(op.update).toEqual({ $unset: { 'comments.$[elem].author': '' } });
      expect(op.arrayFilters).toEqual([
        { 'elem.author._id': userId, 'elem.author._v': { $lt: T1 } },
      ]);
    });

    it('unset pulls elements that are themselves snapshots', () => {
      const likedBy = relation({
        id: 'posts.likedBy',
        path: 'likedBy[]',
        array: true,
        onDelete: 'unset',
      });
      const op = only(planFor(del(), likedBy));
      expect(op.filter).toEqual({
        likedBy: { $elemMatch: { _id: userId, _v: { $lt: T1 } } },
      });
      expect(op.update).toEqual({ $pull: { likedBy: { _id: userId, _v: { $lt: T1 } } } });
      expect(op.arrayFilters).toBeUndefined();
    });

    it('keep plans nothing for that relation', () => {
      const ops = plan(
        del(),
        configWith({ ...postsCreatedBy, onDelete: 'keep' }, postsCommentsAuthor),
      );
      expect(ops.map((op) => op.relationId)).toEqual(['posts.comments.author']);
    });

    it('applies to relations that only hold frozen fields', () => {
      const frozenOnly = relation({
        id: 'posts.createdBy',
        fields: [{ from: 'role', to: 'role', sync: false }],
      });
      expect(planFor(del(), frozenOnly)).toHaveLength(1);
    });

    it('ignores changed and removed fields', () => {
      const op = only(planFor(event({ op: 'delete', changed: { name: 'x' } }), postsCreatedBy));
      expect(updatedPaths(op)).toEqual(['createdBy.deleted', 'createdBy._v']);
    });
  });

  describe('replace events', () => {
    it('treats every synced field present in the document as updated', () => {
      const replacement = {
        _id: userId,
        name: 'Ada',
        avatar: 'a.png',
        role: 'admin',
        passwordHash: 'secret',
      };
      const ops = plan(event({ op: 'replace', changed: replacement }));
      expect(ops.map((op) => op.update)).toEqual([
        { $set: { 'createdBy.name': 'Ada', 'createdBy.photo': 'a.png', 'createdBy._v': T1 } },
        {
          $set: {
            'comments.$[elem].author.name': 'Ada',
            'comments.$[elem].author.avatar': 'a.png',
            'comments.$[elem].author._v': T1,
          },
        },
      ]);
    });

    it('leaves synced fields missing from the document untouched', () => {
      const op = only(
        planFor(event({ op: 'replace', changed: { _id: userId, name: 'Ada' } }), postsCreatedBy),
      );
      expect(updatedPaths(op)).toEqual(['createdBy.name', 'createdBy._v']);
    });
  });

  describe('nested source fields', () => {
    const city = relation({
      id: 'posts.createdBy',
      fields: [
        { from: 'profile.city', to: 'city', sync: true },
        { from: 'address', to: 'addr', sync: true },
      ],
    });

    it('reads a synced field out of a changed parent object', () => {
      const op = only(planFor(event({ changed: { profile: { city: 'Oslo', bio: 'hi' } } }), city));
      expect(op.update).toEqual({ $set: { 'createdBy.city': 'Oslo', 'createdBy._v': T1 } });
    });

    it('unsets a synced field missing from a changed parent object', () => {
      const op = only(planFor(event({ changed: { profile: { bio: 'hi' } } }), city));
      expect(op.update).toEqual({ $set: { 'createdBy._v': T1 }, $unset: { 'createdBy.city': '' } });
    });

    it('unsets a synced field whose parent was removed', () => {
      const op = only(planFor(event({ removed: ['profile'] }), city));
      expect(op.update).toEqual({ $set: { 'createdBy._v': T1 }, $unset: { 'createdBy.city': '' } });
    });

    it('applies a change inside a synced object to the same place in the copy', () => {
      const op = only(
        planFor(event({ changed: { 'address.zip': '0150' }, removed: ['address.line2'] }), city),
      );
      expect(op.update).toEqual({
        $set: { 'createdBy.addr.zip': '0150', 'createdBy._v': T1 },
        $unset: { 'createdBy.addr.line2': '' },
      });
    });

    it('ignores siblings that only share a name prefix', () => {
      expect(planFor(event({ changed: { profileViews: 3, addresses: [] } }), city)).toEqual([]);
    });
  });

  describe('out-of-order safety', () => {
    it('guards each update with $lt on its own version, so an older event cannot win', () => {
      const newer = only(planFor(event({ version: T2, changed: { name: 'New' } }), postsCreatedBy));
      const older = only(planFor(event({ version: T1, changed: { name: 'Old' } }), postsCreatedBy));

      // After the newer event applies, the snapshot holds _v = T2. The older event only matches
      // snapshots with _v < T1, and T2 is not < T1, so it is a no-op.
      expect(newer.update).toMatchObject({ $set: { 'createdBy._v': T2 } });
      expect(older.filter['createdBy._v']).toEqual({ $lt: T1 });
      expect(T2.lessThan(T1)).toBe(false);
    });

    it('guards array elements with $lt as well', () => {
      const op = only(
        planFor(event({ version: T2, changed: { name: 'Ada' } }), postsCommentsAuthor),
      );
      expect(op.arrayFilters?.[0]).toMatchObject({ 'elem.author._v': { $lt: T2 } });
      expect(op.filter).toMatchObject({ comments: { $elemMatch: { 'author._v': { $lt: T2 } } } });
    });

    it('guards deletes', () => {
      const op = only(planFor(event({ op: 'delete', version: T2 }), postsCreatedBy));
      expect(op.filter).toMatchObject({ 'createdBy._v': { $lt: T2 } });
    });
  });

  it('throws a DenormoConfigError for a relation path validation would reject', () => {
    const broken = relation({ id: 'posts.broken', path: 'comments.author', array: true });
    expect(() => planFor(event({ changed: { name: 'Ada' } }), broken)).toThrow(
      expect.objectContaining({
        name: 'DenormoConfigError',
        code: 'INVALID_PATH',
        relationId: 'posts.broken',
      }),
    );
  });

  it('plans one operation per affected relation, in config order', () => {
    const ops = plan(event({ changed: { avatar: 'a.png' } }));
    expect(ops.map((op) => [op.relationId, op.collection])).toEqual([
      ['posts.createdBy', 'posts'],
      ['posts.comments.author', 'posts'],
    ]);
  });
});
