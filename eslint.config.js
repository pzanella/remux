import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'packages/remux-core', 'wasm/target', '**/*.d.ts', 'playwright-report', 'test-results'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.worker },
    },
  },
  {
    // React-specific rules only make sense for the app itself — applied
    // project-wide, react-hooks/rules-of-hooks false-positives on
    // Playwright's own `use(...)` fixture parameter in e2e/fixtures.ts
    // (any function literally named `use` reads as a hook to that rule,
    // regardless of what it actually does).
    files: ['src/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...reactRefresh.configs.vite.rules,
    },
  },
);
