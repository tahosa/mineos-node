import eslint from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

const config = {
  languageOptions: {
    parserOptions: {
      project: true,
      tsconfigRootDir: import.meta.dirname
    }
  },
  rules: {
    '@typescript-eslint/no-explicit-any': 'off',
    quotes: ['error', 'single'],
    'block-spacing': 'off',
    '@typescript-eslint/block-spacing': 'error',
    '@typescript-eslint/ban-ts-comment': 'off',
    'import/no-unresolved': 'off',
    'import/no-named-as-default-member': 'off',
    'no-case-declarations': 'off',
    'no-control-regex': 'off',
  },
};

export default [
  {
    files: ['**/*.ts'],
    ignores: ['coverage/**', 'html/**', 'dist/**', 'src/profiles.d/template.ts'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  config,
];
