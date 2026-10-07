import { CONFIG_VERSION, type CompiledConfig, type RelationConfig } from '../src/config/types.js';

/** `posts.createdBy`: flat snapshot of a user, with a rename and a frozen field. */
export const postsCreatedBy: RelationConfig = {
  id: 'posts.createdBy',
  source: 'users',
  target: 'posts',
  path: 'createdBy',
  array: false,
  fields: [
    { from: 'name', to: 'name', sync: true },
    { from: 'avatar', to: 'photo', sync: true },
    { from: 'role', to: 'role', sync: false },
  ],
  onDelete: 'markDeleted',
  mode: 'stream',
};

/** `posts.comments[].author`: snapshot of a user inside each array element. */
export const postsCommentsAuthor: RelationConfig = {
  id: 'posts.comments.author',
  source: 'users',
  target: 'posts',
  path: 'comments[].author',
  array: true,
  fields: [
    { from: 'name', to: 'name', sync: true },
    { from: 'avatar', to: 'avatar', sync: true },
  ],
  onDelete: 'markDeleted',
  mode: 'stream',
};

export function usersPostsConfig(): CompiledConfig {
  return structuredClone({
    version: CONFIG_VERSION,
    sources: {
      users: { expose: ['name', 'avatar', 'role'] },
    },
    relations: [postsCreatedBy, postsCommentsAuthor],
  });
}

/** Builds a config from relations; every source mentioned exposes what its relations ask for. */
export function configWith(...relations: RelationConfig[]): CompiledConfig {
  const sources: Record<string, { expose: string[] }> = {};
  for (const relation of relations) {
    const expose = (sources[relation.source] ??= { expose: [] }).expose;
    for (const field of relation.fields) {
      if (!expose.includes(field.from)) expose.push(field.from);
    }
  }
  return structuredClone({ version: CONFIG_VERSION, sources, relations });
}

export function relation(
  overrides: Partial<RelationConfig> & Pick<RelationConfig, 'id'>,
): RelationConfig {
  return {
    source: 'users',
    target: 'posts',
    path: 'createdBy',
    array: false,
    fields: [{ from: 'name', to: 'name', sync: true }],
    onDelete: 'markDeleted',
    mode: 'stream',
    ...overrides,
  };
}
