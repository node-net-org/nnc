// The CLI's lint rules: the library's (../eslint.config.js), applied to cli/.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        project: ['./tsconfig.check.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: { reportUnusedDisableDirectives: true },
    rules: {
      eqeqeq: ['error', 'always'],
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-console': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': ['error', { considerDefaultExhaustiveForUnions: true }],
      'no-restricted-syntax': [
        'error',
        {
          // A listener-less 'error' event crashes Node. Never emit one.
          selector: "CallExpression[callee.property.name='emit'][arguments.0.value='error']",
          message: "Do not emit 'error' events; report failures through promises or results.",
        },
      ],
    },
  },
  {
    // Portable nnc (@node-net/nnc/core): everything but the Node host. Kept in step with .dependency-cruiser.cjs.
    files: ['src/**/*.ts'],
    ignores: ['src/main.ts', 'src/node/**'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            { regex: '^node:', message: 'Portable nnc must not import Node built-ins; ask the host (src/host.ts).' },
            { regex: '^@node-net/netconf$', allowTypeImports: true, message: 'Portable nnc imports @node-net/netconf/core; the root entry needs Node.' },
            { regex: '^(ssh2|@node-net/yang)$', allowTypeImports: true, message: 'Portable nnc must not load ssh2 or the Node entry of @node-net/yang.' },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        ...['Buffer', 'process', 'require', '__dirname', '__filename', 'setImmediate', 'clearImmediate', 'global'].map((name) => ({
          name,
          message: 'Portable nnc must not use Node-only globals; ask the host (src/host.ts).',
        })),
      ],
    },
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },
  {
    files: ['**/*.js', '**/*.cjs', '**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // Build and check scripts report on the console.
    files: ['scripts/**/*.mjs'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs' },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
);
