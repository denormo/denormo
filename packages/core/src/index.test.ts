import { describe, expect, it } from 'vitest';
import * as core from './index.js';

describe('@denormo/core public API', () => {
  it('exports the Phase 1 runtime surface (stream and inline)', () => {
    expect(Object.keys(core).sort()).toEqual([
      'CONFIG_VERSION',
      'DEFAULT_INLINE_MAX_TARGETS',
      'DEFAULT_MAX_CASCADE_DEPTH',
      'DEFAULT_STATE_PREFIX',
      'DenormoConfigError',
      'DenormoRuntimeError',
      'assertValidConfig',
      'buildReverseMap',
      'createInlineSync',
      'createSyncEngine',
      'planUpdates',
      'validateConfig',
    ]);
  });
});
