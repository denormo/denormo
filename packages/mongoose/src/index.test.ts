import { DenormoConfigError, DenormoRuntimeError } from '@denormo/core';
import { describe, expect, it } from 'vitest';
import * as adapter from './index.js';

describe('@denormo/mongoose public API', () => {
  it('exports the runtime surface', () => {
    expect(Object.keys(adapter).sort()).toEqual([
      'DenormoConfigError',
      'DenormoRuntimeError',
      'Snapshot',
      'compileConfig',
      'createSync',
      'getExposedFields',
      'snapshotSource',
    ]);
  });

  it("re-exports core's error classes, so apps can check errors without importing core", () => {
    expect(adapter.DenormoConfigError).toBe(DenormoConfigError);
    expect(adapter.DenormoRuntimeError).toBe(DenormoRuntimeError);
  });
});
