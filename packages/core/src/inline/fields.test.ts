import { describe, expect, it } from 'vitest';
import { configWith, relation } from '../../test/fixtures.js';
import { fieldsToWrite } from './fields.js';

const card = relation({
  id: 'cards.owner',
  target: 'cards',
  path: 'owner',
  fields: [
    { from: 'name', to: 'name', sync: true },
    { from: 'avatar', to: 'avatar', sync: true },
    { from: 'role', to: 'role', sync: false },
  ],
});
const like = relation({ id: 'likes.user', target: 'likes', path: 'user' });
const profile = relation({
  id: 'profiles.user',
  target: 'profiles',
  path: 'user',
  fields: [
    { from: 'name', to: 'name', sync: true },
    { from: 'bio', to: 'bio', sync: true },
  ],
});
const badge = relation({
  id: 'badges.user',
  target: 'badges',
  path: 'user',
  fields: [{ from: 'bio', to: 'bio', sync: true }],
});
const team = relation({
  id: 'teams.lead',
  target: 'teams',
  path: 'lead',
  fields: [{ from: 'email', to: 'email', sync: true }],
});

describe('fieldsToWrite', () => {
  it('adds every synced field of each relation a changed field belongs to', () => {
    // A copy's single _v covers all its fields: writing only avatar would mark a stale name as
    // current and block an older, still-queued change to name.
    expect([...fieldsToWrite(configWith(card), 'users', ['avatar'])].sort()).toEqual([
      'avatar',
      'name',
    ]);
  });

  it('keeps going through relations that share a field, until nothing new is added', () => {
    const config = configWith(card, like, profile, badge, team);
    expect([...fieldsToWrite(config, 'users', ['avatar'])].sort()).toEqual([
      'avatar',
      'bio',
      'name',
    ]);
  });

  it('leaves out relations that copy none of the fields, and frozen fields', () => {
    const config = configWith(card, team);
    expect([...fieldsToWrite(config, 'users', ['name'])].sort()).toEqual(['avatar', 'name']);
  });

  it('returns nothing when no synced field changed', () => {
    expect(fieldsToWrite(configWith(card), 'users', [])).toEqual([]);
    expect(fieldsToWrite(configWith(card), 'orgs', ['name'])).toEqual([]);
  });

  it('ignores readRepair relations, which inline mode never writes', () => {
    const readRepair = { ...profile, mode: 'readRepair' as const };
    expect([...fieldsToWrite(configWith(card, readRepair), 'users', ['avatar'])].sort()).toEqual([
      'avatar',
      'name',
    ]);
  });
});
