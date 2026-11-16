/**
 * One run of nnc on a host (docs/cli.md §2.6, §10): connect first if a
 * target was given, then the prompt, or the commands of -c or a script.
 * The command line itself is parsed by the host's entry point (main.ts for
 * the `nnc` command), which hands over what it asked for.
 */

import { Cli, type CliIo } from './cli.js';
import { disconnect } from './commands/common.js';
import { createRegistry } from './commands/index.js';
import { EXIT, type ExitCode } from './errors.js';
import type { LineEditor, NncHost } from './host.js';
import { Interrupt } from './interrupt.js';
import { nextCommand } from './reader.js';
import { completer, runRepl } from './repl.js';
import { escapeTerminal } from './render/safe.js';

export interface NncRun {
  /** Connect to this target first (a name from the targets file, or user@host[:port]). */
  readonly target?: string;
  /** Options for that connect: --read-only, --framed, --raw. */
  readonly connectOptions?: readonly ('read-only' | 'framed' | 'raw')[];
  /** `--targets <path>`, if given. */
  readonly targetsPath?: string;
  /**
   * Where commands come from: the prompt; -c commands; a script's lines,
   * named in errors by `label`; or a script read from the input.
   */
  readonly source:
    | { readonly kind: 'prompt' }
    | { readonly kind: 'commands'; readonly commands: readonly string[] }
    | { readonly kind: 'script'; readonly label: string; readonly lines: readonly string[] }
    | { readonly kind: 'input' };
}

/** Quote a word for the command language. */
function quote(word: string): string {
  return /^[\w@.:/~+-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

/** Where commands come from when there is no prompt. */
interface Source {
  /** Names the script in error messages (`checks.nnc:3: …`); undefined for -c. */
  readonly label: string | undefined;
  /** The next line and its number, or undefined at the end. */
  next(): Promise<{ readonly text: string; readonly line: number } | undefined>;
}

function fromList(lines: readonly string[], label: string | undefined): Source {
  let i = 0;
  return {
    label,
    next: () => Promise.resolve(i < lines.length ? { text: lines[i]!, line: ++i } : undefined),
  };
}

function fromInput(input: () => LineEditor): Source {
  let line = 0;
  return {
    label: '<stdin>',
    async next() {
      const text = await input().next();
      return text === undefined ? undefined : { text, line: ++line };
    },
  };
}

/** Run nnc on `host`, resolving to the exit code. */
export async function runNnc(host: NncHost, run: NncRun): Promise<ExitCode> {
  const { terminal } = host;
  const prompt = run.source.kind === 'prompt';
  const commands = run.source.kind === 'commands' ? run.source.commands : undefined;

  let input: LineEditor | undefined;
  const lines = (): LineEditor => {
    input ??= terminal.lineEditor({
      terminal: terminal.inIsTerminal && terminal.outIsTerminal,
      ...(prompt ? { history: host.history?.load() ?? [], completer: completer(cli) } : {}),
    });
    return input;
  };
  let commandRunning = false;
  const held: string[] = [];
  // The script line running now, which errors name; undefined at the prompt and for -c.
  let where: string | undefined;
  // The last check before a terminal (LANG-13): only nnc's own colour codes get through; files and pipes get text as it is.
  const toOut = (text: string): string => (terminal.outIsTerminal ? escapeTerminal(text, { allowColour: true }) : text);
  const toErr = (text: string): string => (terminal.errIsTerminal ? escapeTerminal(text, { allowColour: true }) : text);
  const page = terminal.page;
  const edit = terminal.edit;
  const io: CliIo = {
    out: (text) => terminal.out(toOut(text)),
    err: (text) => terminal.err(toErr(`${where === undefined ? '' : `${where}: `}${text}\n`)),
    // Without a prompt, standard output carries only results.
    message: (text) => (prompt ? terminal.out(toOut(text)) : terminal.err(toErr(text))),
    // At the prompt, messages that arrive while a command runs (or its result is paged) wait until it finishes.
    notice: (given) => {
      const text = toErr(given);
      if (input === undefined || !prompt) terminal.err(`${text}\n`);
      else if (commandRunning) held.push(text);
      else input.notice(text, cli.exitRequested ? undefined : cli.promptText());
    },
    // Trace entries show as they happen.
    trace: (given) => {
      const text = toErr(given);
      if (input === undefined || !prompt) terminal.err(`${text}\n`);
      else input.notice(text, commandRunning || cli.exitRequested ? undefined : cli.promptText());
    },
    ...(page !== undefined ? { page: (text: string) => (prompt ? page(toOut(text), input) : Promise.resolve(false)) } : {}),
    secret: (question) => lines().secret(question),
    ...(edit !== undefined ? { edit: (text: string, name: string) => edit(text, name, input) } : {}),
  };
  const cli = new Cli(createRegistry(), io, {
    host,
    ...(run.targetsPath !== undefined ? { targetsPath: run.targetsPath } : {}),
    colour: terminal.colourErr,
    colourOut: terminal.colourOut,
    terminalOut: terminal.outIsTerminal,
    terminalErr: terminal.errIsTerminal,
  });
  const interrupt = new Interrupt();

  try {
    if (run.target !== undefined) {
      const connectLine = [`connect ${quote(run.target)}`, ...(run.connectOptions ?? []).map((o) => `--${o}`)].join(' ');
      // Ctrl-C cancels the connect; at the prompt, nnc then carries on with no session.
      const stop = terminal.onInterrupt(() => void interrupt.trigger());
      let exitCode: ExitCode;
      try {
        ({ exitCode } = await interrupt.run((signal) => cli.execute(connectLine, signal)));
      } finally {
        stop();
      }
      // At the prompt, a failed connect has been shown; the prompt starts with no session.
      if (exitCode !== EXIT.ok && !prompt) return exitCode;
    }

    if (prompt) {
      const wrap = cli.execute.bind(cli);
      cli.execute = async (line, signal) => {
        commandRunning = true;
        try {
          return await wrap(line, signal);
        } finally {
          commandRunning = false;
          for (const text of held.splice(0)) terminal.err(`${text}\n`);
        }
      };
      await runRepl(cli, lines(), interrupt);
      return EXIT.ok;
    }

    const source =
      commands !== undefined
        ? fromList(commands, undefined)
        : run.source.kind === 'script'
          ? fromList(run.source.lines, run.source.label)
          : fromInput(lines);
    const stop = terminal.onInterrupt(() => {
      if (!interrupt.trigger()) terminal.exit(EXIT.cancelled);
    });
    try {
      let failed: ExitCode | undefined;
      // A script's XML may continue over lines; each -c is one whole command.
      const read =
        commands !== undefined
          ? (): ReturnType<Source['next']> => source.next()
          : (): ReturnType<Source['next']> => nextCommand(() => source.next(), (text) => cli.incomplete(text));
      for (let next = await read(); next !== undefined; next = await read()) {
        const { text, line } = next;
        where = source.label === undefined ? undefined : `${source.label}:${line}`;
        const { exitCode } = await interrupt.run((signal) => cli.execute(text, signal));
        where = undefined;
        if (exitCode !== EXIT.ok) {
          failed ??= exitCode;
          // Ctrl-C stops the run whatever on-error says.
          if (cli.onError === 'stop' || exitCode === EXIT.cancelled) break;
        }
        if (cli.exitRequested) break;
      }
      // A script that ends inside a transaction didn't apply it: say so, and fail.
      const open = cli.session?.transaction;
      if (open !== undefined) {
        io.err(
          `the script ended with a transaction open: its ${open.changes.length} queued change${open.changes.length === 1 ? ' was' : 's were'} not applied (end it with apply or abandon)`,
        );
        failed ??= EXIT.usage;
      }
      return failed ?? EXIT.ok;
    } finally {
      stop();
    }
  } finally {
    if (cli.open !== undefined) await disconnect(cli);
    // exit, the end of a script, Ctrl-D: the trace file is complete.
    cli.trace.closeFile();
    input?.close();
  }
}
