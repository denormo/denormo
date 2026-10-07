import { describe, expect, it } from 'vitest';
import {
  configWith,
  postsCommentsAuthor,
  postsCreatedBy,
  relation,
  usersPostsConfig,
} from '../../test/fixtures.js';
import { buildReverseMap } from './reverse-map.js';

function targetsOf(map: ReturnType<typeof buildReverseMap>, source: string, field: string) {
  return (map.get(source)?.get(field) ?? []).map(
    (entry) => `${entry.relation.id}:${entry.field.to}`,
  );
}

describe('buildReverseMap', () => {
  const map = buildReverseMap(usersPostsConfig());

  it('lists every relation that syncs a source field', () => {
    expect(targetsOf(map, 'users', 'name')).toEqual([
      'posts.createdBy:name',
      'posts.comments.author:name',
    ]);
  });

  it('records the snapshot field a rename maps to', () => {
    expect(targetsOf(map, 'users', 'avatar')).toEqual([
      'posts.createdBy:photo',
      'posts.comments.author:avatar',
    ]);
  });

  it('points entries at the config relation and field', () => {
    const config = usersPostsConfig();
    const [entry] = buildReverseMap(config).get('users')?.get('avatar') ?? [];
    expect(entry?.relation).toBe(config.relations[0]);
    expect(entry?.field).toBe(config.relations[0]?.fields[1]);
  });

  it('leaves out frozen fields', () => {
    expect(map.get('users')?.has('role')).toBe(false);
  });

  it('keys entries by source collection', () => {
    const titles = relation({
      id: 'feedItems.post',
      source: 'posts',
      target: 'feedItems',
      path: 'post',
      fields: [{ from: 'title', to: 'title', sync: true }],
    });
    const multi = buildReverseMap(configWith(postsCreatedBy, titles));
    expect([...multi.keys()]).toEqual(['users', 'posts']);
    expect(targetsOf(multi, 'posts', 'title')).toEqual(['feedItems.post:title']);
    expect(multi.get('users')?.has('title')).toBe(false);
  });

  it('omits sources whose relations sync nothing', () => {
    const frozenOnly = relation({
      id: 'posts.createdBy',
      fields: [{ from: 'role', to: 'role', sync: false }],
    });
    expect(buildReverseMap(configWith(frozenOnly)).has('users')).toBe(false);
  });

  it('includes readRepair relations, which still need to see source changes', () => {
    const readRepair = { ...postsCommentsAuthor, mode: 'readRepair' as const };
    expect(targetsOf(buildReverseMap(configWith(readRepair)), 'users', 'name')).toEqual([
      'posts.comments.author:name',
    ]);
  });
});
