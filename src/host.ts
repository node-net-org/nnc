/**
 * Where nnc runs (docs/cli.md §2.6): everything it takes from its environment.
 *
 * nnc's command language, sessions, trace and output are portable. They reach
 * the terminal, files, environment and network only through an NncHost. The
 * `nnc` command is the Node.js host (src/node/host.ts); a browser terminal is
 * another (nnc-web). This file is types only.
 */

import type { connect, DeviceProfile } from '@node-net/netconf/core';
import type { ActiveSession } from './sessions/active.js';
import type { ListenRequest, Use } from './sessions/connect.js';
import type { Target } from './targets.js';

/** Asks for a secret without echoing it; undefined when input has ended. */
export type SecretPrompt = (prompt: string) => Promise<string | undefined>;

/** Tab completion: the candidates for a line, and the part of it they replace. */
export type Completer = (line: string) => [string[], string];

export interface NncHost {
  readonly terminal: NncTerminal;
  readonly files: HostFiles;
  /** How targets are reached. */
  readonly transports: Transports;
  /** Commands kept across runs, if the host keeps any. */
  readonly history?: HistoryStore;
  /** An environment variable, or undefined. */
  env(name: string): string | undefined;
  /** What `~` means at the start of a path, and where default files live. */
  readonly homeDir: string;
  /** The username for an SSH target that names none. */
  readonly username: string;
  /**
   * The library's connect() to open client sessions with. The Node host
   * gives the root entry's, which reads a target's YANG module directories;
   * absent, @node-net/netconf/core's is used, which has no files to read them from.
   */
  readonly connect?: typeof connect;
  /** Load the profiles in a directory (a target's profilesDir). Absent where there are no files. */
  loadProfiles?(dir: string): Promise<DeviceProfile[]>;
}

/** The terminal nnc talks to. */
export interface NncTerminal {
  /** Standard output: results. */
  out(text: string): void;
  /** Standard error: errors, warnings, notices and the trace. */
  err(text: string): void;
  readonly inIsTerminal: boolean;
  readonly outIsTerminal: boolean;
  readonly errIsTerminal: boolean;
  /** Colour on standard output (results, the prompt's markers). */
  readonly colourOut: boolean;
  /** Colour on standard error (trace entries). */
  readonly colourErr: boolean;
  /** The line editor for the prompt, secrets and notices. */
  lineEditor(options: LineEditorOptions): LineEditor;
  /** An interrupt sent to nnc from outside the line editor (SIGINT to the process). Returns a function that stops listening. */
  onInterrupt(handler: () => void): () => void;
  /** Leave at once with this exit code (a second Ctrl-C while nothing can be cancelled). */
  exit(code: number): void;
  /**
   * Show a result through a pager if it needs one (a terminal, taller than
   * the screen). Resolves to true if it was paged; otherwise the caller prints
   * it. Absent where there is no pager.
   */
  readonly page?: (text: string, editor: LineEditor | undefined) => Promise<boolean>;
  /**
   * Let the user edit `text` (`--edit`); `name` names it (such as the command).
   * Resolves to the saved text, or undefined if the edit was abandoned (the
   * editor failed, or nothing was saved). Absent where there is no editor.
   */
  readonly edit?: (text: string, name: string, editor: LineEditor | undefined) => Promise<string | undefined>;
}

export interface LineEditorOptions {
  /** Whether lines are edited on a terminal (prompt, history, completion), or read as they come. */
  readonly terminal: boolean;
  /** Earlier commands, oldest first. */
  readonly history?: readonly string[];
  readonly completer?: Completer;
}

/** Lines in, in order, for the prompt and for secrets; and notices shown above the prompt. */
export interface LineEditor {
  readonly terminal: boolean;
  /** The next line, or undefined once input has ended (Ctrl-D, or the end of piped input). */
  next(): Promise<string | undefined>;
  prompt(text: string): void;
  /** Ask for a secret without echo, and keep it out of the history. */
  secret(question: string): Promise<string | undefined>;
  /** Print a message that arrived on its own above the prompt, and redraw what was being typed. */
  notice(text: string, prompt: string | undefined): void;
  /** What is typed at the prompt now. */
  line(): string;
  /** Clear what is typed at the prompt. */
  clearLine(): void;
  /** Ctrl-C at the prompt. Returns a function that stops listening. */
  onInterrupt(handler: () => void): () => void;
  /** Stop reading while something else (an editor, a pager) owns the terminal, and start again. */
  suspend(): void;
  resume(): void;
  close(): void;
}

/** Files, by path. Errors carry a Node-style `code` (ENOENT, EACCES, …), which nnc puts in its messages. */
export interface HostFiles {
  readText(path: string): Promise<string>;
  readBytes(path: string): Promise<Uint8Array>;
  /** Synchronous, for Tab completion. */
  readTextSync(path: string): string;
  write(path: string, data: string | Uint8Array, append: boolean): Promise<void>;
  /** A directory's entries, synchronously (Tab completion). Throws if it can't be read. */
  list(dir: string): readonly HostDirEntry[];
  /** Open a file for appending log lines (the trace file). Throws, with a code, if it can't be opened. */
  openLog(path: string): HostLog;
}

export interface HostDirEntry {
  readonly name: string;
  readonly directory: boolean;
}

export interface HostLog {
  /** The file's full path, for messages. */
  readonly path: string;
  /** Append a line. Throws, with a code, if the write fails. */
  write(line: string): void;
  close(): void;
}

/** Commands kept across runs. Failing to keep one never fails the command. */
export interface HistoryStore {
  /** Earlier commands, oldest first. */
  load(): string[];
  append(line: string): void;
}

/** How a target is reached. */
export interface Transports {
  /**
   * Prepare the target's transport (credentials, host-key policy, and so on)
   * and hand it to `use`, which opens the connection. Failures are explained
   * by `use`'s `describe`.
   */
  reach<T>(target: Target, prompt: SecretPrompt, use: Use<T>): Promise<T>;
  /** Wait for the target to call home (RFC 8071). Absent where nnc can't listen. */
  listen?: (req: ListenRequest) => Promise<ActiveSession>;
  /** Check an SSH host-key pin from a targets file (a fingerprint or key line, or a list); throw if it isn't one. */
  checkHostKey?: (pin: string | readonly string[]) => void;
}
