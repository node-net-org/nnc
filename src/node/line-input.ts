/**
 * Lines from standard input, in order, for the prompt and for secrets.
 *
 * readline emits lines as fast as they arrive, which for piped input is well
 * before earlier commands have finished. They are queued here so commands run
 * strictly in order and a password prompt takes the next line typed, not one
 * meant as a command.
 */

import { clearLine, createInterface, cursorTo, type Interface } from 'node:readline';
import type { LineEditor, LineEditorOptions } from '../host.js';
import { ReverseSearch, type Key } from './search.js';

/**
 * Ctrl-Backspace as readline's Ctrl-W, deleting the word before the cursor.
 * Terminals send it as ^H (Backspace itself is ^?), which readline takes for
 * a plain Backspace. Not on Windows, whose console sends ^H for Backspace.
 * Ctrl-H is the same byte, so it deletes a word too, as in the web terminal.
 */
export function wordBackspace(
  s: string | undefined,
  key: Key | undefined,
  platform: NodeJS.Platform = process.platform,
): [string | undefined, Key | undefined] {
  if (platform === 'win32' || key?.sequence !== '\b') return [s, key];
  return ['\u0017', { sequence: '\u0017', name: 'w', ctrl: true, meta: false, shift: false }];
}

/** The Node host's line editor: readline on standard input and output, with Ctrl-R search in front of it. */
export class LineInput implements LineEditor {
  private readonly rl: Interface;
  readonly terminal: boolean;
  private readonly queue: string[] = [];
  private readonly waiters: ((line: string | undefined) => void)[] = [];
  private ended = false;
  private muted = false;
  private readonly search: ReverseSearch;

  constructor(options: LineEditorOptions) {
    this.terminal = options.terminal;
    const before = new Set(process.stdin.listeners('keypress'));
    this.rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: options.terminal,
      historySize: 1000,
      // readline wants newest first.
      history: [...(options.history ?? [])].reverse(),
      removeHistoryDuplicates: true,
      ...(options.completer !== undefined ? { completer: options.completer } : {}),
    });
    // Hide what is typed while a secret is being read.
    const rl = this.rl as unknown as { _writeToOutput(text: string): void };
    const write = rl._writeToOutput.bind(rl);
    rl._writeToOutput = (text: string) => {
      if (!this.muted) write(text);
    };
    this.search = new ReverseSearch(this.rl);
    if (options.terminal) this.searchKeys(before);
    this.rl.on('line', (line) => {
      const waiter = this.waiters.shift();
      if (waiter !== undefined) waiter(line);
      else this.queue.push(line);
    });
    this.rl.on('close', () => {
      this.ended = true;
      for (const w of this.waiters.splice(0)) w(undefined);
    });
  }

  /**
   * Put Ctrl-R search in front of readline's key handling: take readline's keypress
   * listener off standard input and pass it only the keys the search doesn't use.
   */
  private searchKeys(before: ReadonlySet<unknown>): void {
    type Listener = (s: string | undefined, key: Key | undefined) => void;
    const readline = process.stdin.listeners('keypress').filter((l) => !before.has(l)) as Listener[];
    if (readline.length === 0) return;
    for (const l of readline) process.stdin.off('keypress', l);
    const dispatch: Listener = (s, key) => {
      if (!this.muted && this.search.handle(s, key)) return;
      [s, key] = wordBackspace(s, key);
      for (const l of readline) l.call(process.stdin, s, key);
    };
    process.stdin.on('keypress', dispatch);
    this.rl.on('close', () => process.stdin.off('keypress', dispatch));
  }

  /** The next line, or undefined once input has ended (Ctrl-D, or the end of piped input). */
  next(): Promise<string | undefined> {
    const line = this.queue.shift();
    if (line !== undefined) return Promise.resolve(line);
    if (this.ended) return Promise.resolve(undefined);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  prompt(text: string): void {
    // Piped input may end while queued lines still run; readline is closed by then.
    if (this.ended) {
      process.stdout.write(text);
      return;
    }
    // Ctrl-R pressed while a command ran: the search carries on at the new prompt.
    if (this.search.active) {
      this.search.redraw(text);
      return;
    }
    this.rl.setPrompt(text);
    this.rl.prompt();
  }

  /** Ask for a secret on standard error, without echo, and keep it out of the line history. */
  async secret(question: string): Promise<string | undefined> {
    this.search.cancel();
    process.stderr.write(question);
    if (!this.ended) this.rl.setPrompt('');
    this.muted = this.terminal;
    // Standard input is a terminal but readline isn't driving it (standard output is redirected):
    // stop the terminal echoing what is typed. Raw mode ends the line with \r, which readline accepts.
    const raw = !this.terminal && process.stdin.isTTY && !this.ended;
    if (raw) process.stdin.setRawMode(true);
    try {
      const line = await this.next();
      if (line !== undefined && this.terminal) {
        const history = (this.rl as unknown as { history: string[] }).history;
        if (history[0] === line) history.shift();
      }
      return line;
    } finally {
      this.muted = false;
      if (raw) process.stdin.setRawMode(false);
      if (this.terminal || raw) process.stderr.write('\n');
    }
  }

  /** Print a message that arrived on its own above the prompt, and redraw what was being typed. */
  notice(text: string, prompt: string | undefined): void {
    if (prompt === undefined || this.ended) {
      process.stderr.write(`${text}\n`);
      return;
    }
    if (!this.terminal) {
      process.stderr.write(`${text}\n`);
      this.prompt(prompt);
      return;
    }
    clearLine(process.stdout, 0);
    cursorTo(process.stdout, 0);
    process.stderr.write(`${text}\n`);
    if (this.search.active) {
      this.search.redraw(prompt);
      return;
    }
    this.rl.setPrompt(prompt);
    this.rl.prompt(true);
  }

  /** What is typed now (readline keeps it in a field its typings don't show). */
  line(): string {
    return (this.rl as unknown as { line?: string }).line ?? '';
  }

  /** Clear the typed line, as Ctrl-U does. */
  clearLine(): void {
    this.rl.write(null, { ctrl: true, name: 'u' });
  }

  /** Ctrl-C typed at the prompt (readline's own SIGINT event, not the process's). */
  onInterrupt(handler: () => void): () => void {
    this.rl.on('SIGINT', handler);
    return () => this.rl.off('SIGINT', handler);
  }

  suspend(): void {
    this.rl.pause();
  }

  resume(): void {
    this.rl.resume();
  }

  close(): void {
    if (!this.ended) this.rl.close();
  }
}
