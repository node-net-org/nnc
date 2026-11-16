/**
 * The CLI's state and dispatcher, shared by the prompt and one-shot mode
 * (docs/cli.md §11: commands don't know which mode they're in).
 */

import { remaining } from './commands/transaction.js';
import { CliError, EXIT, type ExitCode } from './errors.js';
import { incomplete, lex, type Redirect } from './lexer.js';
import { BASE_OPERATIONS, TimeoutError } from '@node-net/netconf/core';
import { byteLength } from './bytes.js';
import type { NncHost } from './host.js';
import { expandHome } from './paths.js';
import { operationCommand, operationsOf } from './commands/descriptor.js';
import { OUTPUT_OPTIONS } from './commands/results.js';
import { closest, parseArgs, type Command, type CommandResult, type ParsedArgs, type Registry, type ResultForms, type SessionKind } from './commands/registry.js';
import type { ActiveSession } from './sessions/active.js';
import type { LowSession } from './sessions/low.js';
import { escapeTerminal } from './render/safe.js';
import { colourXml } from './trace/format.js';
import { TraceSettings } from './trace/settings.js';

export interface CliIo {
  /** Results. */
  out(text: string): void;
  /**
   * What happened, such as connected or disconnected: shown like a result at the prompt,
   * on standard error without one (docs/cli.md §10). Defaults to `out`.
   */
  message?(text: string): void;
  /** Errors and warnings. */
  err(text: string): void;
  /** A message that arrives on its own (e.g. the server closed the session), shown above the prompt. */
  notice(text: string): void;
  /** A trace entry: shown as it happens, even while a command runs. Defaults to `notice`. */
  trace?(text: string): void;
  /** Ask for a secret without echoing it. Resolves to undefined when input has ended. */
  secret(prompt: string): Promise<string | undefined>;
  /**
   * Let the user edit `text` (`--edit`); `name` names it. Resolves to the
   * saved text, or undefined if the edit was abandoned. Absent where there is
   * no editor.
   */
  edit?(text: string, name: string): Promise<string | undefined>;
  /**
   * Show a result through the pager if it needs one (a terminal, at the prompt,
   * taller than the screen). Resolves to true if it was paged; otherwise the
   * caller prints it.
   */
  page?(text: string): Promise<boolean>;
}

export interface CliOptions {
  /** What nnc runs on: its files, transports, environment and terminal (docs/cli.md §2.6). */
  readonly host: NncHost;
  /** `--targets <path>` from the command line, if given. */
  readonly targetsPath?: string;
  /** Standard error is a colour terminal (trace entries are coloured). */
  readonly colour?: boolean;
  /** Standard output is a colour terminal (results and the prompt's markers are coloured). */
  readonly colourOut?: boolean;
  /** Standard output is a terminal: exact forms show control characters as escapes there (LANG-13). */
  readonly terminalOut?: boolean;
  /** Standard error is a terminal: exact trace bodies show control characters as escapes there. */
  readonly terminalErr?: boolean;
}

/** What a script or a run of -c commands does after a failed command (`set on-error`). */
export type OnError = 'stop' | 'continue';

export type OutputFormat = 'xml' | 'json' | 'raw';

/** How a raw session shows received bytes (docs/cli.md §6.5). */
export type BytesView = 'text' | 'hex';

/** What `show-last` shows again: the last result, or the last rpc-error (docs/cli.md §6.6). */
export type Last =
  | { readonly kind: 'result'; readonly result: Exclude<CommandResult, undefined> }
  | { readonly kind: 'error'; readonly message: string; readonly raw: string | undefined };

export interface Outcome {
  readonly exitCode: ExitCode;
}

const paint = (code: string, text: string): string => `\u001b[${code}m${text}\u001b[0m`;

export class Cli {
  /** The open client session (docs/cli.md §11). At most one of `session` and `low` is open. */
  session: ActiveSession | undefined;
  /** The open framed or raw session. */
  low: LowSession | undefined;
  /** Set by `exit`. */
  exitRequested = false;
  /** Set by `set on-error`; read by scripts and -c, never by the prompt (docs/cli.md §10). */
  onError: OnError = 'stop';
  /** Set by `output`: the default format and whether long results are paged (docs/cli.md §6.6). */
  output: { format: OutputFormat; page: boolean; bytes: BytesView } = { format: 'xml', page: true, bytes: 'text' };
  /** The last result or rpc-error, for `show-last`. */
  last: Last | undefined;
  /** True while the running command's result goes to a file (`> path`) rather than standard output. */
  redirecting = false;
  /** Trace settings, kept from one session to the next (docs/cli.md §5). */
  readonly trace: TraceSettings;
  /** The XML each command last sent this session, which `--edit` starts from (docs/cli.md §6.1). */
  readonly lastXml = new Map<string, string>();

  constructor(
    readonly registry: Registry,
    readonly io: CliIo,
    readonly options: CliOptions,
  ) {
    this.trace = new TraceSettings(
      (text) => (io.trace !== undefined ? io.trace(text) : io.notice(text)),
      options.colour === true,
      options.terminalErr === true,
    );
  }

  get host(): NncHost {
    return this.options.host;
  }

  get kind(): SessionKind {
    return this.session?.kind ?? this.low?.kind ?? 'none';
  }

  /** The open session of any kind: its name and kind, for messages. */
  get open(): { readonly name: string; readonly kind: SessionKind } | undefined {
    return this.session ?? this.low;
  }

  /** The command a line starts with, if it takes the rest of the line verbatim in this session kind. */
  private rawLineCommand(line: string): { cmd: Command; rest: string } | undefined {
    const m = /^\s*(\S+)(?: ([\s\S]*))?$/.exec(line);
    if (m === null) return undefined;
    const cmd = this.registry.get(m[1]!);
    if (cmd?.rawLineIn?.includes(this.kind) !== true) return undefined;
    return { cmd, rest: m[2] ?? '' };
  }

  /** The command's XML is still open, so the next line continues it (never for a verbatim line). */
  incomplete(text: string): boolean {
    return this.rawLineCommand(text) === undefined && incomplete(text);
  }

  /**
   * The prompt: `nnc> `, or `nnc <target> [marks]> ` while a session is open (docs/cli.md §6.2):
   * the kind and its state for low-level sessions (`[framed eom]`, `[framed chunked]`, `[raw]`, `[raw eof]`),
   * `[ro]` when read-only, `[insecure]` when the host key wasn't verified, `[no-redact]` while traces
   * show secrets, `[tx N]` while a transaction is open and `[confirm m:ss]` while a confirmed commit
   * is pending. Marks are coloured on a colour terminal.
   */
  promptText(): string {
    const colour = this.options.colourOut === true;
    const mark = (text: string, code: string): string => (colour ? paint(code, text) : text);
    const noRedact = this.trace.redact ? [] : [mark('[no-redact]', '31')];
    const low = this.low;
    if (low !== undefined) {
      const state = low.kind === 'framed' ? `framed ${low.channel?.framing ?? 'eom'}` : low.eof ? 'raw eof' : 'raw';
      const marks = [mark(`[${state}]`, low.kind === 'framed' ? '36' : '35'), ...(low.insecure ? [mark('[insecure]', '31')] : []), ...noRedact];
      return `nnc ${[low.name, ...marks].join(' ')}> `;
    }
    const s = this.session;
    if (s === undefined) return noRedact.length === 0 ? 'nnc> ' : `nnc ${noRedact.join(' ')}> `;
    const pending = s.confirmedCommit !== undefined && s.confirmedCommit.rollbackAt.getTime() > Date.now() ? s.confirmedCommit : undefined;
    const marks = [
      ...(s.readOnly ? [mark('[ro]', '33')] : []),
      ...(s.insecure ? [mark('[insecure]', '31')] : []),
      ...noRedact,
      ...(s.transaction !== undefined ? [mark(`[tx ${s.transaction.changes.length}]`, '36')] : []),
      ...(pending !== undefined ? [mark(`[confirm ${remaining(pending.rollbackAt)}]`, '33')] : []),
    ];
    return `nnc ${[s.name, ...marks].join(' ')}> `;
  }

  /** Run one command line. Errors are reported to `io.err`; the outcome carries the exit code. */
  async execute(line: string, signal: AbortSignal = new AbortController().signal): Promise<Outcome> {
    try {
      const result = await this.dispatch(line, signal);
      return { exitCode: result };
    } catch (err) {
      // Whatever the command was doing when Ctrl-C arrived, it was cancelled.
      if (signal.aborted || (err instanceof CliError && err.exitCode === EXIT.cancelled)) {
        this.io.err('cancelled');
        return { exitCode: EXIT.cancelled };
      }
      if (err instanceof CliError) {
        this.io.err(err.message);
        return { exitCode: err.exitCode };
      }
      const message = err instanceof Error ? err.message : String(err);
      this.io.err(`error: ${message}`);
      return { exitCode: EXIT.protocol };
    }
  }

  private async dispatch(line: string, signal: AbortSignal): Promise<ExitCode> {
    const verbatim = this.rawLineCommand(line);
    if (verbatim !== undefined) return this.emit(await verbatim.cmd.run(this, { positional: [verbatim.rest], options: {} }, signal), undefined);
    const { words, redirect } = lex(line);
    const first = words[0];
    if (first === undefined) {
      if (redirect !== undefined) throw new CliError(`${redirect.append ? '>>' : '>'} needs a command before it`);
      return EXIT.ok;
    }
    const cmd = this.registry.get(first.text) ?? this.operation(first.text);
    if (cmd === undefined) throw new CliError(`unknown command: ${first.text} (${this.suggest(first.text) ?? 'type help for a list'})`);
    if (!cmd.kinds.includes(this.kind)) {
      if (this.kind === 'none') throw new CliError('not connected');
      throw new CliError(`${cmd.name} is available in ${kindList(cmd.kinds.filter((k) => k !== 'none'))}, not in this ${this.kind} session; nothing was sent`);
    }
    const args = parseArgs(cmd, words.slice(1));
    this.redirecting = redirect !== undefined;
    // The messages received so far, so the reply this command gets can be shown as received.
    const log = this.session?.received;
    const before = log?.count ?? 0;
    let result: CommandResult;
    try {
      result = await cmd.run(this, args, signal);
    } catch (err) {
      if (err instanceof TimeoutError && err.phase === 'rpc') {
        // The library stops waiting; the session carries on (a late reply is discarded).
        const ms = /after (\d+) ms/.exec(err.message)?.[1] ?? String(args.options['timeout'] ?? '?');
        throw new CliError(`${cmd.name}: no reply within ${ms} ms; the session is still open`, EXIT.protocol);
      }
      if (err instanceof CliError && err.exitCode === EXIT.rpcError) {
        this.last = { kind: 'error', message: err.message, raw: log?.lastReplySince(before) };
      }
      throw err;
    } finally {
      this.redirecting = false;
    }
    if (result !== undefined && 'forms' in result && result.forms !== undefined && log !== undefined) {
      const raw = log.lastReplySince(before);
      if (raw !== undefined) result = { ...result, forms: { ...result.forms, raw } };
    }
    if (result !== undefined && 'forms' in result && result.forms !== undefined) this.last = { kind: 'result', result };
    return this.emit(result, redirect, cmd, args);
  }

  /** `did you mean x?` for a mistyped command name, if one is close. */
  suggest(name: string): string | undefined {
    const ops = this.session !== undefined ? operationsOf(this.session) : this.low !== undefined ? [] : BASE_OPERATIONS;
    const near = closest(name, [...this.registry.names(), ...ops.map((d) => d.name)]);
    return near === undefined ? undefined : `did you mean ${near}?`;
  }

  /** Show text that reports what happened (see `CliIo.message`). */
  showMessage(text: string): void {
    if (this.io.message !== undefined) this.io.message(text);
    else this.io.out(text);
  }

  /** A command for an operation the open session describes, if there is one by that name. */
  private operation(name: string): Command | undefined {
    const s = this.session;
    if (s === undefined) {
      // Known operations exist only in a client session; say so rather than "unknown command".
      if (BASE_OPERATIONS.some((d) => d.name === name)) {
        if (this.low === undefined) throw new CliError('not connected');
        throw new CliError(`${name} is available in client sessions, not in this ${this.low.kind} session; nothing was sent`);
      }
      return undefined;
    }
    const d = operationsOf(s).find((o) => o.name === name);
    return d === undefined ? undefined : operationCommand(d);
  }

  /**
   * The format a result is shown in: --xml, --json or --raw on the command
   * (when they are the CLI's output options, not an operation's own), else
   * the session's `output` format.
   */
  private formatFor(cmd: Command, args: ParsedArgs): OutputFormat | 'default' {
    for (const f of ['raw', 'json', 'xml'] as const) {
      if (cmd.options[f] === OUTPUT_OPTIONS[f] && args.options[f] === true) return f;
    }
    return this.settingFormat();
  }

  /** The `output` setting's format: the xml setting (the default) lets a result show its own view; --xml asks for XML itself. */
  private settingFormat(): OutputFormat | 'default' {
    return this.output.format === 'xml' ? 'default' : this.output.format;
  }

  /** The text of a result in a format; a form the result doesn't have falls back to its XML (or text) form. */
  private textOf(forms: ResultForms, format: OutputFormat | 'default', toTerminal: boolean): string {
    if (format === 'default' && forms.text !== undefined) return `${forms.text}\n`;
    if (format === 'json' && forms.json !== undefined) return `${forms.json}\n`;
    if (format === 'raw' && forms.raw !== undefined) return forms.raw.endsWith('\n') ? forms.raw : `${forms.raw}\n`;
    const xml = `${forms.xml}\n`;
    return toTerminal && this.options.colourOut === true ? colourXml(xml) : xml;
  }

  /**
   * Show the result, or write it to the redirect's file. A failed write shows it here instead and fails.
   * rpc-error warnings follow the result, on standard error.
   */
  async emit(result: CommandResult, redirect: Redirect | undefined, cmd?: Command, args?: ParsedArgs): Promise<ExitCode> {
    if (result === undefined) return EXIT.ok;
    if ('bytes' in result) return this.emitBytes(result, redirect);
    const forms = 'forms' in result ? result.forms : undefined;
    const format = cmd !== undefined && args !== undefined ? this.formatFor(cmd, args) : this.settingFormat();
    const plain = forms !== undefined ? this.textOf(forms, format, false) : 'raw' in result ? result.raw : `${result.text}\n`;
    const warnings = 'warnings' in result ? (result.warnings ?? []) : [];
    // Exact forms (a reply as received) are kept as they are, except that a terminal gets their control characters as escapes.
    const exact = 'raw' in result || (forms !== undefined && format === 'raw' && forms.raw !== undefined);
    if (redirect === undefined) {
      if ('message' in result && result.message === true) this.showMessage(plain);
      else {
        const formed = forms !== undefined ? this.textOf(forms, format, true) : plain;
        const shown = exact ? this.forTerminal(formed) : formed;
        const page = this.output.page && !(cmd?.options['page'] === OUTPUT_OPTIONS.page && args?.options['page'] === false);
        if (!(page && (await this.io.page?.(shown)) === true)) this.io.out(shown);
      }
      for (const w of warnings) this.io.err(w);
      return EXIT.ok;
    }
    const path = expandHome(redirect.path, this.host.homeDir);
    try {
      await this.host.files.write(path, plain, redirect.append);
    } catch (err) {
      const reason = (err as { code?: string }).code ?? (err as Error).message;
      this.io.err(`cannot write ${redirect.path}: ${reason}; the result follows`);
      this.io.out(exact ? this.forTerminal(plain) : plain);
      for (const w of warnings) this.io.err(w);
      return EXIT.usage;
    }
    this.wrote(redirect, byteLength(plain));
    for (const w of warnings) this.io.err(w);
    return EXIT.ok;
  }

  /** Exact text for standard output: control characters as escapes when it is a terminal. */
  private forTerminal(text: string): string {
    return this.options.terminalOut === true ? escapeTerminal(text) : text;
  }

  private wrote(redirect: Redirect, bytes: number): void {
    this.showMessage(`${redirect.append ? 'appended' : 'wrote'} ${bytes} byte${bytes === 1 ? '' : 's'} to ${redirect.path}\n`);
  }

  /** Received data: the screen form at the terminal, the bytes unchanged in a file. */
  private async emitBytes(result: { readonly bytes: Uint8Array; readonly screen: string }, redirect: Redirect | undefined): Promise<ExitCode> {
    const ended = result.screen.endsWith('\n') || result.screen === '' ? result.screen : `${result.screen}\n`;
    const screen = this.forTerminal(ended);
    if (redirect === undefined) {
      if (!(this.output.page && (await this.io.page?.(screen)) === true)) this.io.out(screen);
      return EXIT.ok;
    }
    const path = expandHome(redirect.path, this.host.homeDir);
    try {
      await this.host.files.write(path, result.bytes, redirect.append);
    } catch (err) {
      const reason = (err as { code?: string }).code ?? (err as Error).message;
      this.io.err(`cannot write ${redirect.path}: ${reason}; the result follows`);
      this.io.out(screen);
      return EXIT.usage;
    }
    this.wrote(redirect, result.bytes.length);
    return EXIT.ok;
  }
}

/** `client sessions`, `framed and raw sessions`, … */
function kindList(kinds: readonly SessionKind[]): string {
  const names = kinds.map(String);
  return `${names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)!}` : names[0]!} sessions`;
}
