/**
 * What is traced, and where entries go (TRACE-04, TRACE-06). One instance
 * lives for the whole nnc process, so settings carry over from one session to
 * the next until they are changed.
 */

import type { HostFiles, HostLog } from '../host.js';
import { escapeTerminal } from '../render/safe.js';
import { CliError } from '../errors.js';
import { timestamp } from './format.js';

export type TraceLevel = 'bytes' | 'frames' | 'xml';
export const TRACE_LEVELS: readonly TraceLevel[] = ['bytes', 'frames', 'xml'];

export interface TraceEntry {
  readonly direction: 'sent' | 'received';
  readonly at: Date;
  readonly level: TraceLevel;
  /** What follows the level on the header line (size, framing, message-id, a one-line bytes entry). */
  readonly header: string;
  /** Lines below the header, if any. */
  readonly body?: string;
  /** The body as shown on a colour terminal. */
  readonly colouredBody?: string;
  /** The body is text exactly as received: on a terminal its control characters are shown as escapes (LANG-13). */
  readonly exact?: boolean;
}

export class TraceSettings {
  private readonly on = new Set<TraceLevel>();
  /** Secrets are replaced with *** (on by default). */
  redact = true;
  /** Entries go only to the file. */
  quiet = false;
  private file: HostLog | undefined;

  /**
   * @param show writes an entry to standard error (above the prompt)
   * @param colour standard error is a colour terminal
   * @param terminal standard error is a terminal (exact bodies are escaped there; the file gets them as they are)
   */
  constructor(
    private readonly show: (text: string) => void,
    private readonly colour: boolean,
    private readonly terminal = false,
  ) {}

  has(level: TraceLevel): boolean {
    return this.on.has(level);
  }

  get active(): boolean {
    return this.on.size > 0;
  }

  setLevels(levels: Iterable<TraceLevel>): void {
    this.on.clear();
    for (const l of levels) this.on.add(l);
  }

  get filePath(): string | undefined {
    return this.file?.path;
  }

  /** Open a trace file for appending, without changing anything yet. Fails naming the file. */
  static openFile(files: HostFiles, path: string): HostLog {
    try {
      return files.openLog(path);
    } catch (err) {
      // The host's error names the file as it resolved it, where it can.
      const e = err as { code?: string; path?: string; message: string };
      throw new CliError(`trace: cannot open trace file ${e.path ?? path}: ${e.code ?? e.message}`);
    }
  }

  /** Start writing to `file` (closing any other), with a header line for the session, if there is one. */
  useFile(file: HostLog, session: string | undefined): void {
    this.closeFile();
    this.file = file;
    this.writeFile(`# nnc trace · ${session ?? 'no session'} · ${new Date().toISOString()}`);
  }

  /** A session is starting: mark it in the file. */
  sessionStarted(name: string): void {
    if (this.file !== undefined) this.writeFile(`# nnc trace · ${name} · ${new Date().toISOString()}`);
  }

  closeFile(): void {
    if (this.file === undefined) return;
    try {
      this.file.close();
    } catch {
      // Already gone; nothing to do.
    }
    this.file = undefined;
    this.quiet = false;
  }

  /** `trace off`: no levels, no file. Redaction is a setting of its own and stays as it is. */
  off(): void {
    this.on.clear();
    this.closeFile();
  }

  describe(): string {
    const levels = TRACE_LEVELS.filter((l) => this.on.has(l));
    const parts = [
      levels.length === 0 ? 'off' : levels.join(', '),
      `redaction ${this.redact ? 'on' : 'off'}`,
      ...(this.file !== undefined ? [`file ${this.file.path}${this.quiet ? ' (quiet)' : ''}`] : []),
    ];
    return `trace: ${parts.join(' · ')}`;
  }

  emit(entry: TraceEntry): void {
    if (!this.on.has(entry.level)) return;
    const head = `${entry.direction === 'sent' ? '>>' : '<<'} ${timestamp(entry.at)} ${entry.level} ${entry.header}`;
    const plain = entry.body === undefined ? head : `${head}\n${entry.body}`;
    if (this.file !== undefined) this.writeFile(plain);
    if (!this.quiet) {
      const shown = entry.exact === true && this.terminal && entry.body !== undefined ? escapeTerminal(entry.body) : entry.body;
      const body = this.colour ? (entry.colouredBody ?? shown) : shown;
      this.show(body === undefined ? head : `${head}\n${body}`);
    }
  }

  private writeFile(text: string): void {
    if (this.file === undefined) return;
    try {
      this.file.write(text);
    } catch (err) {
      const path = this.file.path;
      this.closeFile();
      this.show(`trace: stopped writing ${path}: ${(err as { code?: string }).code ?? (err as Error).message}`);
    }
  }
}
