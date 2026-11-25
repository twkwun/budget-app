import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import vue from 'eslint-plugin-vue';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/dev-dist/**',
      '**/coverage/**',
      'apps/server/drizzle/**',
      'test-results/**',
      'playwright-report/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  ...vue.configs['flat/recommended'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: { parser: tseslint.parser, extraFileExtensions: ['.vue'] },
      globals: globals.browser,
    },
  },
  {
    files: ['apps/web/src/**/*.ts'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: [
      'apps/server/**/*.ts',
      'packages/**/*.ts',
      'e2e/**/*.ts',
      'apps/web/scripts/**/*.ts',
      '**/*.config.{ts,js}',
      '**/test/**/*.ts',
    ],
    languageOptions: { globals: globals.node },
  },
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'smart'],
    },
  },
  {
    // Binary format readers index into record structures they just validated.
    files: ['apps/server/src/importer/containers/**/*.ts'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
  {
    files: ['**/test/**/*.ts'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off', 'no-console': 'off' },
  },
  {
    files: ['apps/server/src/cli/**/*.ts', 'apps/server/src/logger.ts'],
    rules: { 'no-console': 'off' },
  },
  prettier,
);
