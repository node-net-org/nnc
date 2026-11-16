/**
 * The CLI uses @node-net/netconf only through its public API (docs/cli.md §2.2).
 *
 * Importing the package by name goes through the library's exports map, which
 * blocks deep imports. A relative import out of the repository (for example
 * ../netconf/src/transport/channel.js) would bypass that, so it is forbidden here.
 *
 * nnc runs on a host (docs/cli.md §2.3). Only main.ts and src/node/ are the
 * Node host; everything else in src is portable (@node-net/nnc/core) and
 * runs in any JavaScript runtime. Kept in step with eslint.config.js.
 */
const NODE_ONLY = ['^src/main\\.ts$', '^src/node/'];

module.exports = {
  forbidden: [
    {
      name: 'portable-cli-no-node-builtins',
      comment: 'Portable nnc modules import no Node built-in: the host gives them files, terminal and transports.',
      severity: 'error',
      from: { path: '^src/', pathNot: NODE_ONLY },
      to: { dependencyTypes: ['core'], dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'portable-cli-no-node-host',
      comment: 'Portable nnc modules never load the Node host (types are fine).',
      severity: 'error',
      from: { path: '^src/', pathNot: NODE_ONLY },
      to: { path: NODE_ONLY, dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'portable-cli-uses-library-core',
      comment: 'Portable nnc modules use @node-net/netconf/core (and its operation subpaths), never the Node entry of @node-net/netconf, ssh2 or @node-net/yang.',
      severity: 'error',
      from: { path: '^src/', pathNot: NODE_ONLY },
      to: {
        path: ['(^|/)@node-net/netconf/dist/index\\.js$', '(^|/)node_modules/ssh2/', '(^|/)@node-net/yang/dist/index\\.js$'],
        dependencyTypesNot: ['type-only'],
      },
    },
    {
      name: 'cli-uses-public-api',
      comment:
        'Import the library as @node-net/netconf, never by a relative path out of the repository. ' +
        "Relative specifiers are 'local'; the package import resolves through node_modules and is not.",
      severity: 'error',
      from: { path: '^src/' },
      to: { dependencyTypes: ['local'], path: '^\\.\\./' },
    },
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.js'],
    },
  },
};
