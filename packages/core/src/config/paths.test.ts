import { describe, expect, it } from 'vitest';
import { childPath, parseSnapshotPath, pathsOverlap } from './paths.js';

describe('parseSnapshotPath', () => {
  it('parses a flat path', () => {
    expect(parseSnapshotPath('createdBy', false)).toEqual({ arrayField: null, inner: 'createdBy' });
    expect(parseSnapshotPath('meta.createdBy', false)).toEqual({
      arrayField: null,
      inner: 'meta.createdBy',
    });
  });

  it('splits an array path at the [] marker', () => {
    expect(parseSnapshotPath('comments[].author', true)).toEqual({
      arrayField: 'comments',
      inner: 'author',
    });
    expect(parseSnapshotPath('thread.comments[].meta.author', true)).toEqual({
      arrayField: 'thread.comments',
      inner: 'meta.author',
    });
  });

  it('gives an empty inner path when each element is the snapshot', () => {
    expect(parseSnapshotPath('likedBy[]', true)).toEqual({ arrayField: 'likedBy', inner: '' });
  });

  it.each([
    ['comments.author', true, 'array relation without []'],
    ['comments[].author', false, '[] on a non-array relation'],
    ['a[].b[].c', true, 'nested arrays'],
    ['comm[]ents.author', true, '[] inside a segment'],
    ['', false, 'empty path'],
    ['a..b', false, 'empty segment'],
    ['a.$b', false, '$-prefixed segment'],
    ['[].author', true, 'nameless array segment'],
  ])('rejects %j (array: %s): %s', (path, array) => {
    expect(parseSnapshotPath(path, array)).toBeNull();
  });
});

describe('pathsOverlap', () => {
  it.each([
    ['name', 'name', true],
    ['profile', 'profile.city', true],
    ['profile.city', 'profile', true],
    ['profile', 'profiles', false],
    ['profile.city', 'profile.zip', false],
  ])('%s vs %s → %s', (a, b, expected) => {
    expect(pathsOverlap(a, b)).toBe(expected);
  });
});

describe('childPath', () => {
  it('returns the remainder of a descendant path', () => {
    expect(childPath('profile', 'profile.city.zip')).toBe('city.zip');
  });

  it('returns an empty string for the same path', () => {
    expect(childPath('profile', 'profile')).toBe('');
  });

  it('returns null when the path is not inside the ancestor', () => {
    expect(childPath('profile', 'profiles.city')).toBeNull();
    expect(childPath('profile.city', 'profile')).toBeNull();
  });
});
