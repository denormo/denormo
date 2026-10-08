import { describe, expect, it } from 'vitest';
import { useDatabase } from './mongo.js';

const ctx = useDatabase();

describe('integration environment', () => {
  it('runs against a replica set', async () => {
    const hello = await ctx.db.admin().command({ hello: 1 });
    expect(hello.setName).toEqual(expect.any(String));
  });
});
