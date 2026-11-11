import * as adapter from '@denormo/mongoose';
import { describe, expect, it } from 'vitest';
import * as denormo from './index.js';

describe('denormo', () => {
  it('is the Mongoose adapter under a short name', () => {
    expect(Object.keys(denormo).sort()).toEqual(Object.keys(adapter).sort());
    for (const [name, value] of Object.entries(adapter)) {
      expect((denormo as Record<string, unknown>)[name]).toBe(value);
    }
  });
});
