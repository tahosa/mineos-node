import { FlatCompat } from '@eslint/eslintrc';
import pluginJs from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import eslintImport from 'eslint-plugin-import';
import globals from 'globals';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// For some reason eslint can't see this, but it works
// eslint-disable-next-line import/no-unresolved
import eslintTypescript from 'typescript-eslint';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname
})

const config = {
  rules: {
    '@typescript-eslint/no-explicit-any': 'off',
    quotes: ['error', 'single'],
    'block-spacing': 'off',
    '@typescript-eslint/block-spacing': 'error',
    '@typescript-eslint/ban-ts-comment': 'off',
    'import/no-unresolved': 'off',
    'no-case-declarations': 'off',
    'no-control-regex': 'off',
  },
};

export default [
  {
    files: ['**/*.ts'],
    ignores: ['html/**', 'dist/**', 'src/profiles.d/template.ts'],
    languageOptions: { globals: globals.browser }
  },
  pluginJs.configs.recommended,
  ...eslintTypescript.configs.recommended,
  eslintConfigPrettier,
  ...compat.config(eslintImport.configs.recommended),
  ...compat.config(eslintImport.configs.typescript),
  config,
];
