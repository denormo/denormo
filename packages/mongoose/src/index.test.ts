import { describe, expect, it } from 'vitest';
import * as adapter from './index.js';

describe('@denormo/mongoose public API', () => {
  it('exports the Phase 1b runtime surface', () => {
    expect(Object.keys(adapter).sort()).toEqual([
      'Snapshot',
      'compileConfig',
      'createSync',
      'getExposedFields',
      'snapshotSource',
    ]);
  });
});
