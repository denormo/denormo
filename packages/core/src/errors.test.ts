import { describe, expect, it } from 'vitest';
import { DenormoConfigError, DenormoRuntimeError } from './errors.js';

describe('DenormoConfigError', () => {
  it('carries a code, the relation id and the problems', () => {
    const problems = [
      { code: 'UNKNOWN_SOURCE', message: 'unknown source "people"', relationId: 'posts.createdBy' },
    ] as const;
    const error = new DenormoConfigError('invalid config', {
      code: 'UNKNOWN_SOURCE',
      relationId: 'posts.createdBy',
      problems,
    });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('DenormoConfigError');
    expect(error.message).toBe('invalid config');
    expect(error.code).toBe('UNKNOWN_SOURCE');
    expect(error.relationId).toBe('posts.createdBy');
    expect(error.problems).toEqual(problems);
  });

  it('omits the relation id when none applies', () => {
    const error = new DenormoConfigError('bad version', {
      code: 'UNSUPPORTED_CONFIG_VERSION',
      problems: [],
    });
    expect(error.relationId).toBeUndefined();
  });
});

describe('DenormoRuntimeError', () => {
  it('carries a code, the source collection and the cause', () => {
    const cause = new Error('write failed');
    const error = new DenormoRuntimeError('sync stopped', {
      code: 'SOURCE_STOPPED',
      source: 'users',
      cause,
    });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('DenormoRuntimeError');
    expect(error.code).toBe('SOURCE_STOPPED');
    expect(error.source).toBe('users');
    expect(error.relationId).toBeUndefined();
    expect(error.cause).toBe(cause);
  });
});
