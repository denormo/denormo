import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/*/src/**/*.test.ts'],
        },
      },
      {
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
