import js from '@eslint/js';
import globals from 'globals';

const rules = {
  ...js.configs.recommended.rules,
  'no-empty': ['error', { allowEmptyCatch: true }],
  'no-unused-vars': ['error', { caughtErrors: 'none' }],
};

export default [
  {
    files: ['app/**/*.mjs', 'scripts/**/*.mjs', 'test/**/*.mjs', 'tools/**/*.mjs', '*.mjs'],
    languageOptions: { globals: globals.node },
    rules,
  },
  {
    files: ['app/public/**/*.js'],
    languageOptions: { globals: globals.browser },
    rules,
  },
  {
    files: ['test/ui.mjs'],
    languageOptions: { globals: globals.browser },
  },
];
