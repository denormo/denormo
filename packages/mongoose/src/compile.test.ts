import { DenormoConfigError, validateConfig } from '@denormo/core';
import mongoose from 'mongoose';
import { beforeEach, describe, expect, it } from 'vitest';
import { compileConfig } from './compile.js';
import { Snapshot } from './snapshot-type.js';
import { snapshotSource } from './source-plugin.js';

let connection: mongoose.Connection;

beforeEach(() => {
  connection = mongoose.createConnection();
});

function userModel(collection?: string) {
  const schema = new mongoose.Schema({ name: String, avatar: String, role: String });
  schema.plugin(snapshotSource, { expose: ['name', 'avatar', 'role'] });
  return connection.model('User', schema, collection);
}

function postModel() {
  return connection.model(
    'Post',
    new mongoose.Schema({
      createdBy: {
        type: Snapshot,
        ref: 'User',
        fields: {
          name: { sync: true },
          avatar: { sync: true, as: 'photo' },
          role: { sync: false },
        },
        onDelete: 'markDeleted',
      },
      meta: { editor: { type: Snapshot, ref: 'User', fields: { name: { sync: true } } } },
      comments: [
        { text: String, author: { type: Snapshot, ref: 'User', fields: { name: { sync: true } } } },
      ],
      likedBy: [{ type: Snapshot, ref: 'User', fields: { name: { sync: true } } }],
    }),
  );
}

describe('compileConfig', () => {
  it('compiles every snapshot path into a relation', () => {
    const config = compileConfig([userModel(), postModel()]);
    const byId = new Map(config.relations.map((relation) => [relation.id, relation]));

    expect([...byId.keys()].sort()).toEqual([
      'posts.comments.author',
      'posts.createdBy',
      'posts.likedBy',
      'posts.meta.editor',
    ]);
    expect(byId.get('posts.createdBy')).toEqual({
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
    });
    expect(byId.get('posts.meta.editor')).toMatchObject({ path: 'meta.editor', array: false });
    expect(byId.get('posts.comments.author')).toMatchObject({
      path: 'comments[].author',
      array: true,
    });
    expect(byId.get('posts.likedBy')).toMatchObject({ path: 'likedBy[]', array: true });
  });

  it('defaults onDelete to keep and mode to stream', () => {
    const config = compileConfig([userModel(), postModel()]);
    const editor = config.relations.find((relation) => relation.id === 'posts.meta.editor');
    expect(editor).toMatchObject({ onDelete: 'keep', mode: 'stream' });
  });

  it('takes sources from snapshotSource, keyed by collection name', () => {
    const config = compileConfig([userModel('people'), postModel()]);
    expect(config.sources).toEqual({ people: { expose: ['name', 'avatar', 'role'] } });
    expect(new Set(config.relations.map((relation) => relation.source))).toEqual(
      new Set(['people']),
    );
  });

  it('produces a config that core validation accepts', () => {
    expect(validateConfig(compileConfig([userModel(), postModel()]))).toEqual([]);
  });

  it('only walks the models it is given, but resolves refs on their connection', () => {
    userModel();
    const config = compileConfig([postModel()]);
    expect(config.relations).toHaveLength(4);
    expect(Object.keys(config.sources)).toEqual(['users']);
  });

  it('fails when the referenced model has no snapshotSource plugin', () => {
    connection.model('User', new mongoose.Schema({ name: String }));
    expect(() => compileConfig([postModel()])).toThrow(
      expect.objectContaining({
        name: 'DenormoConfigError',
        code: 'SOURCE_NOT_DECLARED',
        relationId: 'posts.createdBy',
      }),
    );
  });

  it('fails when the referenced model does not exist', () => {
    expect(() => compileConfig([postModel()])).toThrow(
      expect.objectContaining({ code: 'UNKNOWN_REF', relationId: 'posts.createdBy' }),
    );
  });

  it('fails when a field is not declared as { sync: boolean }', () => {
    userModel();
    const Bad = connection.model(
      'Bad',
      new mongoose.Schema({ createdBy: { type: Snapshot, ref: 'User', fields: { name: true } } }),
    );
    expect(() => compileConfig([Bad])).toThrow(DenormoConfigError);
    expect(() => compileConfig([Bad])).toThrow(
      expect.objectContaining({ code: 'INVALID_SNAPSHOT_FIELD', relationId: 'bads.createdBy' }),
    );
  });

  it('skips discriminator models, which share their base model', () => {
    const User = userModel();
    const Post = postModel();
    const Pinned = Post.discriminator('PinnedPost', new mongoose.Schema({ pinnedAt: Date }));
    expect(compileConfig([User, Post, Pinned]).relations).toHaveLength(4);
  });
});
