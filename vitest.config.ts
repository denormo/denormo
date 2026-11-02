import { defineConfig } from 'vitest/config';

// Workspace packages resolve to their TypeScript source (the "@denormo/source" export
// condition), so tests never run against a stale or missing build.
const resolve = { conditions: ['@denormo/source'] };

export default defineConfig({
  resolve,
  ssr: { resolve },
  test: {
    passWithNoTests: true,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['packages/*/src/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['packages/*/test/integration/**/*.test.ts'],
          globalSetup: ['./test/integration/global-setup.ts'],
          // The first run downloads mongod.
          hookTimeout: 120_000,
          testTimeout: 30_000,
        },
      },
    ],
  },
});
