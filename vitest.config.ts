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
        },
      },
    ],
  },
});
