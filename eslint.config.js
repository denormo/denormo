import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores(['**/dist/', '**/coverage/', '.kilo/']),
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: { allowDefaultProject: ['eslint.config.js'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    // Named exports only (CLAUDE.md conventions).
    files: ['packages/*/src/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ExportDefaultDeclaration',
          message: 'Use named exports only.',
        },
      ],
    },
  },
  {
    // Hard rule 1: core is ODM-agnostic and must never import mongoose.
    files: ['packages/core/**/*.{ts,js,mts,cts,mjs,cjs}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'mongoose',
              message:
                '@denormo/core must not import mongoose. Mongoose code belongs in @denormo/mongoose.',
            },
          ],
          patterns: [
            {
              group: ['mongoose/*'],
              message:
                '@denormo/core must not import mongoose. Mongoose code belongs in @denormo/mongoose.',
            },
          ],
        },
      ],
    },
  },
  prettier,
);
