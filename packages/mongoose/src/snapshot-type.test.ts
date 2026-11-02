import mongoose from 'mongoose';
import { beforeEach, describe, expect, it } from 'vitest';
import { Snapshot } from './snapshot-type.js';

const fields = {
  name: { sync: true },
  avatar: { sync: true, as: 'photo' },
  role: { sync: false },
};

let connection: mongoose.Connection;

beforeEach(() => {
  // No URI: models can be built and validated without a database.
  connection = mongoose.createConnection();
});

/** Paths that fail validation (empty when the document is valid). */
async function invalidPaths(document: mongoose.Document): Promise<string[]> {
  try {
    await document.validate();
    return [];
  } catch (error) {
    if (error instanceof mongoose.Error.ValidationError) return Object.keys(error.errors);
    throw error;
  }
}

function models() {
  const User = connection.model(
    'User',
    new mongoose.Schema({ name: String, avatar: String, role: String, passwordHash: String }),
  );
  const Org = connection.model('Org', new mongoose.Schema({ name: String }));
  const Post = connection.model(
    'Post',
    new mongoose.Schema({
      title: String,
      createdBy: { type: Snapshot, ref: 'User', fields },
      comments: [
        { text: String, author: { type: Snapshot, ref: 'User', fields: { name: { sync: true } } } },
      ],
      likedBy: [{ type: Snapshot, ref: 'User', fields: { name: { sync: true } } }],
    }),
  );
  return { User, Org, Post };
}

describe('Snapshot schema type', () => {
  it('copies _id and the declared fields (renamed) when a source document is assigned', () => {
    const { User, Post } = models();
    const ada = new User({ name: 'Ada', avatar: 'a.png', role: 'admin', passwordHash: 'secret' });
    const post = new Post({ title: 'Hi', createdBy: ada });

    expect(post.toObject().createdBy).toEqual({
      _id: ada._id,
      name: 'Ada',
      photo: 'a.png',
      role: 'admin',
    });
  });

  it('never copies undeclared fields such as passwordHash', () => {
    const { User, Post } = models();
    const ada = new User({ name: 'Ada', passwordHash: 'secret' });
    const post = new Post({
      createdBy: ada,
      comments: [{ text: 'x', author: ada }],
      likedBy: [ada],
    });
    const stored = JSON.stringify(post.toObject());

    expect(stored).not.toContain('secret');
    expect(stored).not.toContain('passwordHash');
  });

  it('works inside document arrays and as array elements', () => {
    const { User, Post } = models();
    const ada = new User({ name: 'Ada', avatar: 'a.png' });
    const post = new Post({ comments: [{ text: 'x', author: ada }], likedBy: [ada] });
    const plain = post.toObject() as { comments: { author: unknown }[]; likedBy: unknown[] };

    expect(plain.comments[0]?.author).toEqual({ _id: ada._id, name: 'Ada' });
    expect(plain.likedBy[0]).toEqual({ _id: ada._id, name: 'Ada' });
  });

  it('stores a plain snapshot object unchanged', () => {
    const { Post } = models();
    const snapshot = { _id: new mongoose.Types.ObjectId(), name: 'Ada', photo: 'a.png' };
    expect(new Post({ createdBy: snapshot }).toObject().createdBy).toEqual(snapshot);
  });

  it('keeps only _id, the engine keys and the declared fields of a plain object', () => {
    const { Post } = models();
    const _id = new mongoose.Types.ObjectId();
    const version = new mongoose.mongo.Timestamp({ t: 5, i: 1 });
    const post = new Post({
      createdBy: {
        _id,
        name: 'Ada',
        photo: 'a.png',
        role: 'admin',
        passwordHash: 'secret',
        __v: 0,
        _v: version,
        deleted: true,
      },
    });
    expect(post.toObject().createdBy).toEqual({
      _id,
      name: 'Ada',
      photo: 'a.png',
      role: 'admin',
      _v: version,
      deleted: true,
    });
  });

  it('moves source field names in a plain object to their snapshot names', () => {
    // What update calls and lean() hand over: a plain copy of the source document.
    const { Post } = models();
    const _id = new mongoose.Types.ObjectId();
    const leanUser = { _id, name: 'Ada', avatar: 'a.png', passwordHash: 'secret', __v: 0 };
    expect(new Post({ createdBy: leanUser }).toObject().createdBy).toEqual({
      _id,
      name: 'Ada',
      photo: 'a.png',
    });
  });

  it('accepts a document of a discriminator of the ref model', async () => {
    const { User, Post } = models();
    const Admin = User.discriminator('Admin', new mongoose.Schema({ level: Number }));
    const admin = new Admin({ name: 'Root', level: 9 });
    const post = new Post({ createdBy: admin });
    expect(await invalidPaths(post)).toEqual([]);
    expect(post.toObject().createdBy).toEqual({ _id: admin._id, name: 'Root' });
  });

  it('copies raw values, not getter output, and does not share arrays with the source', () => {
    const Source = connection.model(
      'Profile',
      new mongoose.Schema({
        avatar: { type: String, get: (v: string) => `https://cdn/${v}` },
        tags: [String],
      }),
    );
    const Card = connection.model(
      'Card',
      new mongoose.Schema({
        owner: {
          type: Snapshot,
          ref: 'Profile',
          fields: { avatar: { sync: true }, tags: { sync: true } },
        },
      }),
    );
    const profile = new Source({ avatar: 'a.png', tags: ['x'] });
    const card = new Card({ owner: profile });
    profile.tags.push('y');

    expect(card.toObject().owner).toEqual({ _id: profile._id, avatar: 'a.png', tags: ['x'] });
  });

  it('allows null and undefined', async () => {
    const { Post } = models();
    expect(await invalidPaths(new Post({ createdBy: null }))).toEqual([]);
    expect(await invalidPaths(new Post({}))).toEqual([]);
  });

  it('rejects a document of another model', async () => {
    const { Org, Post } = models();
    const post = new Post({ createdBy: new Org({ name: 'Acme' }) });
    expect(await invalidPaths(post)).toEqual(['createdBy']);
  });

  it('rejects values that are not snapshots', async () => {
    const { Post } = models();
    expect(await invalidPaths(new Post({ createdBy: 'Ada' }))).toEqual(['createdBy']);
    expect(await invalidPaths(new Post({ createdBy: { name: 'no id' } }))).toEqual(['createdBy']);
  });
});
