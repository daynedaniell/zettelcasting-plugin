import obsidianmd from 'eslint-plugin-obsidianmd';
import tseslint from 'typescript-eslint';

/**
 * Lint against Obsidian's own plugin-review rules.
 *
 * `eslint-plugin-obsidianmd` is the ruleset the Obsidian team runs when
 * reviewing a community plugin submission, so `npm run lint` reproduces that
 * review locally. It brings typescript-eslint with it; the type-aware rules
 * (floating promises, unsafe `any`, needless assertions) need a TypeScript
 * program, which `projectService` supplies.
 *
 * `package.json` is in scope deliberately — some rules, such as the check for
 * dependencies with a built-in replacement, read the manifest rather than the
 * source.
 */
export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      '.test-build/**',
      // Generated bundle.
      'main.js',
    ],
  },
  ...obsidianmd.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // The build and release scripts run in Node, outside the plugin sandbox.
    files: ['*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // The test doubles stand in for Obsidian's own classes, which the stub
    // cannot type without pulling in the API it exists to replace. `any` is
    // the point there, so the rules that police it are off for tests only —
    // shipped code in src/ is still held to the full ruleset.
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      'eslint-comments/no-restricted-disable': 'off',
    },
  }
);
