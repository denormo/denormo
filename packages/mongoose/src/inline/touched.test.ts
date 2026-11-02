import { describe, expect, it } from 'vitest';
import { affectedFields, touchedPaths } from './touched.js';

describe('touchedPaths', () => {
  it('collects the fields of every update operator', () => {
    expect(
      touchedPaths({
        $set: { name: 'Ada', 'profile.city': 'Oslo' },
        $unset: { avatar: '' },
        $inc: { score: 1 },
        $push: { tags: 'x' },
      }),
    ).toEqual(['name', 'profile.city', 'avatar', 'score', 'tags']);
  });

  it('counts both sides of $rename', () => {
    expect(touchedPaths({ $rename: { nick: 'name' } })).toEqual(['nick', 'name']);
  });

  it('counts top-level fields of an update without operators', () => {
    expect(touchedPaths({ name: 'Ada' })).toEqual(['name']);
  });

  it('cuts paths at positional segments', () => {
    expect(
      touchedPaths({ $set: { 'comments.$.text': 'x', 'tags.$[].v': 1, 'a.$[elem].b': 2 } }),
    ).toEqual(['comments', 'tags', 'a']);
  });

  it('treats an aggregation pipeline as touching everything', () => {
    expect(touchedPaths([{ $set: { name: 'Ada' } }])).toBe('all');
  });

  it('returns nothing for an empty update', () => {
    expect(touchedPaths(undefined)).toEqual([]);
    expect(touchedPaths(null)).toEqual([]);
  });
});

describe('affectedFields', () => {
  const synced = ['name', 'avatar', 'profile.city'];

  it('keeps synced fields equal to, inside or containing a touched path', () => {
    expect(affectedFields(['name'], synced)).toEqual(['name']);
    expect(affectedFields(['profile'], synced)).toEqual(['profile.city']);
    expect(affectedFields(['profile.city.zip'], synced)).toEqual(['profile.city']);
  });

  it('ignores unrelated and prefix-sharing paths', () => {
    expect(affectedFields(['lastLoginAt', 'names', 'profiles'], synced)).toEqual([]);
  });

  it('returns every synced field when everything is touched', () => {
    expect(affectedFields('all', synced)).toEqual(synced);
  });
});
