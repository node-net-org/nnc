/**
 * nnc without Node.js (docs/cli.md §2.6): the CLI, run on a host that
 * supplies its terminal, files, transports and environment. Nothing here
 * imports a Node built-in; the `nnc` command (main.ts) runs it on the Node
 * host in src/node, and a browser page can run it on its own host, reaching
 * simulated devices through `simTransports`.
 */

export { runNnc, type NncRun } from './run.js';
export { MORE_PROMPT } from './repl.js';
export { Cli, type CliIo, type CliOptions } from './cli.js';
export { createRegistry } from './commands/index.js';
export { EXIT, type ExitCode } from './errors.js';
export { simTransports, type SimDevices } from './sim.js';
export type {
  Completer,
  HistoryStore,
  HostDirEntry,
  HostFiles,
  HostLog,
  LineEditor,
  LineEditorOptions,
  NncHost,
  NncTerminal,
  SecretPrompt,
  Transports,
} from './host.js';
