import { DenormoConfigError } from '@denormo/core';
import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';
import { getExposedFields, snapshotSource } from './source-plugin.js';

function userSchema() {
  const schema = new mongoose.Schema({ name: String, avatar: String, passwordHash: String });
  schema.plugin(snapshotSource, { expose: ['name', 'avatar'] });
  return schema;
}

describe('snapshotSource', () => {
  it('records the exposed fields on the schema', () => {
    expect(getExposedFields(userSchema())).toEqual(['name', 'avatar']);
  });

  it('reports nothing for a schema without the plugin', () => {
    expect(getExposedFields(new mongoose.Schema({ name: String }))).toBeUndefined();
  });

  it('keeps the exposed fields through clone(), connection.model() and discriminators', () => {
    const schema = userSchema();
    expect(getExposedFields(schema.clone())).toEqual(['name', 'avatar']);

    const connection = mongoose.createConnection();
    const User = connection.model('User', schema);
    expect(getExposedFields(User.schema)).toEqual(['name', 'avatar']);

    const Admin = User.discriminator('Admin', new mongoose.Schema({ level: Number }));
    expect(getExposedFields(Admin.schema)).toEqual(['name', 'avatar']);
  });

  it('rejects options without an expose list', () => {
    const schema = new mongoose.Schema({ name: String });
    const bad = { exposed: ['name'] } as unknown as { expose: string[] };
    expect(() => schema.plugin(snapshotSource, bad)).toThrow(DenormoConfigError);
    expect(() => schema.plugin(snapshotSource, bad)).toThrow(
      expect.objectContaining({ code: 'INVALID_SNAPSHOT_SOURCE' }),
    );
  });
});
