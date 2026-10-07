import { describe, expect, it } from 'vitest';
import { configWith, postsCreatedBy, relation, usersPostsConfig } from '../../test/fixtures.js';
import { DenormoConfigError } from '../errors.js';
import type {
  CompiledConfig,
  CONFIG_VERSION,
  OnDeletePolicy,
  RelationConfig,
  RelationMode,
} from './types.js';
import { assertValidConfig, DEFAULT_MAX_CASCADE_DEPTH, validateConfig } from './validate.js';

function codes(config: CompiledConfig, options?: Parameters<typeof validateConfig>[1]) {
  return validateConfig(config, options).map((problem) => problem.code);
}

// Config values arrive from JSON or adapters, so validation must catch what the types forbid.
const badOnDelete = 'remove' as unknown as OnDeletePolicy;
const badMode = 'inline' as unknown as RelationMode;

describe('validateConfig', () => {
  it('accepts the users → posts fixture', () => {
    expect(validateConfig(usersPostsConfig())).toEqual([]);
  });

  it('rejects an unsupported config version', () => {
    const config = { ...usersPostsConfig(), version: 2 as unknown as typeof CONFIG_VERSION };
    expect(codes(config)).toEqual(['UNSUPPORTED_CONFIG_VERSION']);
  });

  describe('sources and exposed fields', () => {
    it('rejects a relation whose source is not declared', () => {
      const config = { ...usersPostsConfig(), sources: {} };
      const problems = validateConfig(config);
      expect(problems.map((p) => p.code)).toEqual(['UNKNOWN_SOURCE', 'UNKNOWN_SOURCE']);
      expect(problems[0]).toMatchObject({ relationId: 'posts.createdBy' });
      expect(problems[0]?.message).toContain('users');
    });

    it('rejects a synced field the source does not expose', () => {
      const config = { ...usersPostsConfig(), sources: { users: { expose: ['name', 'role'] } } };
      const problems = validateConfig(config);
      expect(problems).toEqual([
        expect.objectContaining({
          code: 'FIELD_NOT_EXPOSED',
          relationId: 'posts.createdBy',
          field: 'avatar',
        }),
        expect.objectContaining({
          code: 'FIELD_NOT_EXPOSED',
          relationId: 'posts.comments.author',
          field: 'avatar',
        }),
      ]);
    });

    it('rejects a frozen field the source does not expose', () => {
      const config = {
        ...usersPostsConfig(),
        sources: { users: { expose: ['name', 'avatar'] } },
      };
      expect(validateConfig(config)).toEqual([
        expect.objectContaining({
          code: 'FIELD_NOT_EXPOSED',
          relationId: 'posts.createdBy',
          field: 'role',
        }),
      ]);
    });
  });

  it('rejects duplicate relation ids', () => {
    const config = configWith(postsCreatedBy, { ...postsCreatedBy, path: 'updatedBy' });
    expect(validateConfig(config)).toEqual([
      expect.objectContaining({ code: 'DUPLICATE_RELATION_ID', relationId: 'posts.createdBy' }),
    ]);
  });

  it('rejects an invalid onDelete policy', () => {
    const config = configWith(relation({ id: 'r', onDelete: badOnDelete }));
    expect(validateConfig(config)).toEqual([
      expect.objectContaining({ code: 'INVALID_ON_DELETE', relationId: 'r' }),
    ]);
  });

  it('rejects an invalid mode', () => {
    const config = configWith(relation({ id: 'r', mode: badMode }));
    expect(validateConfig(config)).toEqual([
      expect.objectContaining({ code: 'INVALID_MODE', relationId: 'r' }),
    ]);
  });

  describe('paths and fields', () => {
    it.each<[string, boolean]>([
      ['comments.author', true],
      ['comments[].author', false],
      ['a[].b[].c', true],
      ['a..b', false],
      ['$where', false],
    ])('rejects path %j with array: %s', (path, array) => {
      const config = configWith(relation({ id: 'r', path, array }));
      expect(validateConfig(config)).toEqual([
        expect.objectContaining({ code: 'INVALID_PATH', relationId: 'r' }),
      ]);
    });

    it('accepts an array of snapshots (likedBy[])', () => {
      expect(codes(configWith(relation({ id: 'r', path: 'likedBy[]', array: true })))).toEqual([]);
    });

    it('rejects malformed from/to field paths', () => {
      const config = configWith(
        relation({
          id: 'r',
          fields: [
            { from: 'name', to: 'a[]', sync: true },
            { from: '', to: 'b', sync: true },
          ],
        }),
      );
      expect(codes(config)).toEqual(['INVALID_FIELD', 'INVALID_FIELD']);
    });

    it('rejects two fields writing the same or overlapping snapshot paths', () => {
      const config = configWith(
        relation({
          id: 'r',
          fields: [
            { from: 'name', to: 'label', sync: true },
            { from: 'nickname', to: 'label', sync: true },
            { from: 'profile', to: 'p', sync: true },
            { from: 'city', to: 'p.city', sync: false },
          ],
        }),
      );
      expect(validateConfig(config)).toEqual([
        expect.objectContaining({
          code: 'DUPLICATE_TARGET_FIELD',
          relationId: 'r',
          field: 'label',
        }),
        expect.objectContaining({
          code: 'DUPLICATE_TARGET_FIELD',
          relationId: 'r',
          field: 'p.city',
        }),
      ]);
    });

    it.each(['_id', '_v', 'deleted', '_v.t'])('rejects reserved snapshot field %j', (to) => {
      const config = configWith(relation({ id: 'r', fields: [{ from: 'name', to, sync: true }] }));
      expect(validateConfig(config)).toEqual([
        expect.objectContaining({ code: 'RESERVED_TARGET_FIELD', relationId: 'r', field: to }),
      ]);
    });
  });

  describe('cascade graph', () => {
    // users.profile → posts.createdBy.profile → users.profile.lastPost.author → ...
    const postsAuthorProfile = relation({
      id: 'posts.createdBy',
      fields: [{ from: 'profile', to: 'profile', sync: true }],
    });
    const usersLastPost = relation({
      id: 'users.profile.lastPost',
      source: 'posts',
      target: 'users',
      path: 'profile.lastPost',
      fields: [{ from: 'createdBy.profile', to: 'author', sync: true }],
    });

    it('rejects a cycle through synced copies', () => {
      const problems = validateConfig(configWith(postsAuthorProfile, usersLastPost));
      expect(problems).toEqual([expect.objectContaining({ code: 'CYCLE' })]);
      expect(problems[0]?.message).toContain('posts.createdBy');
      expect(problems[0]?.message).toContain('users.profile.lastPost');
    });

    it('does not count frozen fields as cascade edges', () => {
      const frozen = relation({
        ...usersLastPost,
        fields: [{ from: 'createdBy.profile', to: 'author', sync: false }],
      });
      expect(codes(configWith(postsAuthorProfile, frozen))).toEqual([]);
    });

    it('allows a self-referencing snapshot that does not feed itself', () => {
      const manager = relation({
        id: 'users.manager',
        source: 'users',
        target: 'users',
        path: 'manager',
      });
      expect(codes(configWith(manager))).toEqual([]);
    });

    it('rejects a self-referencing snapshot that copies its own output', () => {
      const selfFeeding = relation({
        id: 'users.manager',
        source: 'users',
        target: 'users',
        path: 'manager',
        fields: [{ from: 'manager', to: 'boss', sync: true }],
      });
      expect(codes(configWith(selfFeeding))).toEqual(['CYCLE']);
    });

    /** A chain of `length` relations, each copying the previous relation's synced copy. */
    function chain(length: number): RelationConfig[] {
      const collections = ['users', 'posts', 'feedItems', 'digests', 'archives', 'exports'];
      return collections.slice(1, length + 1).map((target, i) =>
        relation({
          id: `${target}.from`,
          source: collections[i] ?? '',
          target,
          path: 'from',
          fields: [{ from: i === 0 ? 'name' : 'from.name', to: 'name', sync: true }],
        }),
      );
    }

    it('defaults maxCascadeDepth to 3', () => {
      expect(DEFAULT_MAX_CASCADE_DEPTH).toBe(3);
    });

    it('accepts a chain of maxCascadeDepth relations', () => {
      expect(codes(configWith(...chain(3)))).toEqual([]);
    });

    it('rejects a chain deeper than maxCascadeDepth', () => {
      const problems = validateConfig(configWith(...chain(4)));
      expect(problems).toEqual([
        expect.objectContaining({ code: 'CASCADE_TOO_DEEP', relationId: 'posts.from' }),
      ]);
      expect(problems[0]?.message).toContain(
        'posts.from → feedItems.from → digests.from → archives.from',
      );
    });

    it('honours a custom maxCascadeDepth', () => {
      expect(codes(configWith(...chain(4)), { maxCascadeDepth: 4 })).toEqual([]);
      expect(codes(configWith(...chain(2)), { maxCascadeDepth: 1 })).toEqual(['CASCADE_TOO_DEEP']);
    });

    it('only links relations whose copies are read downstream', () => {
      // posts → feedItems copies posts.title, which no user change touches.
      const feedTitles = relation({
        id: 'feedItems.post',
        source: 'posts',
        target: 'feedItems',
        path: 'post',
        fields: [{ from: 'title', to: 'title', sync: true }],
      });
      const chained = chain(3).map((r) => (r.source === 'posts' ? feedTitles : r));
      expect(codes(configWith(...chained), { maxCascadeDepth: 1 })).toEqual([]);
    });

    describe('delete policies write to the snapshot', () => {
      // posts.createdBy syncs nothing, so only its delete policy can change what feedItems reads.
      const frozenCreatedBy = (onDelete: RelationConfig['onDelete']) =>
        relation({
          id: 'posts.createdBy',
          fields: [{ from: 'role', to: 'role', sync: false }],
          onDelete,
        });
      const feedAuthorRole = relation({
        id: 'feedItems.authorRole',
        source: 'posts',
        target: 'feedItems',
        path: 'author',
        fields: [{ from: 'createdBy.role', to: 'role', sync: true }],
      });
      const feedAuthorDeleted = relation({
        ...feedAuthorRole,
        id: 'feedItems.authorDeleted',
        fields: [{ from: 'createdBy.deleted', to: 'gone', sync: true }],
      });

      it('unset removes the whole snapshot', () => {
        const config = configWith(frozenCreatedBy('unset'), feedAuthorRole);
        expect(codes(config, { maxCascadeDepth: 1 })).toEqual(['CASCADE_TOO_DEEP']);
      });

      it('markDeleted writes the deleted flag', () => {
        expect(
          codes(configWith(frozenCreatedBy('markDeleted'), feedAuthorRole), { maxCascadeDepth: 1 }),
        ).toEqual([]);
        expect(
          codes(configWith(frozenCreatedBy('markDeleted'), feedAuthorDeleted), {
            maxCascadeDepth: 1,
          }),
        ).toEqual(['CASCADE_TOO_DEEP']);
      });

      it('keep writes nothing', () => {
        const config = configWith(frozenCreatedBy('keep'), feedAuthorRole);
        expect(codes(config, { maxCascadeDepth: 1 })).toEqual([]);
      });
    });
  });
});

describe('assertValidConfig', () => {
  it('returns quietly for a valid config', () => {
    expect(() => {
      assertValidConfig(usersPostsConfig());
    }).not.toThrow();
  });

  it('throws a DenormoConfigError listing every problem', () => {
    const config = configWith(
      relation({ id: 'r', onDelete: badOnDelete }),
      relation({ id: 's', mode: badMode }),
    );
    let thrown: unknown;
    try {
      assertValidConfig(config);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DenormoConfigError);
    const error = thrown as DenormoConfigError;
    expect(error.code).toBe('INVALID_ON_DELETE');
    expect(error.relationId).toBe('r');
    expect(error.problems.map((p) => p.code)).toEqual(['INVALID_ON_DELETE', 'INVALID_MODE']);
    expect(error.message).toContain('2 problems');
  });
});
