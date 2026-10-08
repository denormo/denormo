import { describe, expect, it } from 'vitest';
import { childPath, getPath, parseSnapshotPath, pathsOverlap } from './paths.js';

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

describe('getPath', () => {
  const doc = { name: 'Ada', profile: { city: 'Oslo', zip: null }, tags: ['a', 'b'] };

  it('returns the value at a dot-notation path', () => {
    expect(getPath(doc, 'profile.city')).toEqual({ exists: true, value: 'Oslo' });
    expect(getPath(doc, 'tags.1')).toEqual({ exists: true, value: 'b' });
  });

  it('returns the whole value for an empty path', () => {
    expect(getPath(doc, '')).toEqual({ exists: true, value: doc });
  });

  it('distinguishes a null value from a missing field', () => {
    expect(getPath(doc, 'profile.zip')).toEqual({ exists: true, value: null });
    expect(getPath(doc, 'profile.street')).toEqual({ exists: false });
    expect(getPath(doc, 'name.first')).toEqual({ exists: false });
    expect(getPath(undefined, 'name')).toEqual({ exists: false });
  });
});
