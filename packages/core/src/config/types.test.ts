import { describe, expect, expectTypeOf, it } from 'vitest';
import { usersPostsConfig } from '../../test/fixtures.js';
import {
  CONFIG_VERSION,
  type CompiledConfig,
  type OnDeletePolicy,
  type RelationMode,
} from './types.js';

describe('compiled config types', () => {
  it('pins the config contract version to 1', () => {
    expect(CONFIG_VERSION).toBe(1);
  });

  it('accepts the HLD example shape', () => {
    const config = usersPostsConfig();
    expectTypeOf(config).toEqualTypeOf<CompiledConfig>();
    expect(config.version).toBe(CONFIG_VERSION);
  });

  it('limits onDelete and mode to the documented values', () => {
    expectTypeOf<OnDeletePolicy>().toEqualTypeOf<'markDeleted' | 'unset' | 'keep'>();
    expectTypeOf<RelationMode>().toEqualTypeOf<'stream' | 'readRepair'>();
  });
});
