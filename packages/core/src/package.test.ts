import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const STANDARD_CONDITIONS = new Set(['import', 'require', 'types', 'default', 'node']);

describe('@denormo/core package.json', () => {
  it('namespaces its development-only export condition', () => {
    // The "source" condition points at src/, which is not published. A generic name would send
    // consumers whose tools use the same condition to a missing file.
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { exports: Record<string, Record<string, unknown> | string> };
    const root = manifest.exports['.'];
    const custom = Object.keys(typeof root === 'object' ? root : {}).filter(
      (condition) => !STANDARD_CONDITIONS.has(condition),
    );

    expect(custom).toEqual(['@denormo/source']);
  });
});
