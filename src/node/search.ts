/**
 * Ctrl-R: reverse incremental search of the command history, as in bash
 * (docs/cli.md §6.1, LANG-10).
 *
 * readline has no search, so this runs in front of its key handling: LineInput
 * offers each key here first, and a key that isn't used goes on to readline.
 * The search line is drawn with readline's own prompt and line, so it wraps and
 * redraws as any line does.
 */

import type { Interface } from 'node:readline';

/** A key as `emitKeypressEvents` reports it. */
export interface Key {
  readonly name?: string;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly shift?: boolean;
  readonly sequence?: string;
}

/** The first entry at or after `from` that contains `query` (history is newest first), or -1. */
export function findOlder(history: readonly string[], query: string, from: number): number {
  if (query === '') return -1;
  for (let i = Math.max(from, 0); i < history.length; i++) if (history[i]!.includes(query)) return i;
  return -1;
}

interface Search {
  query: string;
  /** The match shown, as an index into the history; -1 for none yet. */
  index: number;
  /** The query has no match; the last match stays on show. */
  failed: boolean;
  /** The line, cursor and prompt from before Ctrl-R, for Ctrl-G and Ctrl-C. */
  readonly line: string;
  readonly cursor: number;
  prompt: string;
}

/** readline's line and history: `line` and `cursor` are documented, `history` is newest first. */
type Line = Interface & { line: string; cursor: number; history?: string[] };

export class ReverseSearch {
  private search: Search | undefined;
  /** The query of the last search, reused by Ctrl-R Ctrl-R, as bash does. */
  private lastQuery = '';

  constructor(private readonly rl: Interface) {}

  get active(): boolean {
    return this.search !== undefined;
  }

  /** Offer a key. True when the search used it, so readline mustn't see it. */
  handle(s: string | undefined, key: Key | undefined): boolean {
    const ctrl = key?.ctrl === true && key.meta !== true;
    const search = this.search;
    if (search === undefined) {
      if (!ctrl || key?.name !== 'r') return false;
      this.start();
      return true;
    }
    if (ctrl && key?.name === 'r') {
      this.older(search);
    } else if (ctrl && (key?.name === 'g' || key?.name === 'c')) {
      this.end(false);
    } else if (key?.name === 'backspace') {
      this.shorten(search);
    } else if (key?.name === 'escape') {
      this.end(true);
    } else if (s !== undefined && s.length === 1 && s >= ' ' && s !== '\u007f' && !ctrl && key?.meta !== true) {
      this.extend(search, s);
    } else {
      // Enter, arrows, Home, End, Ctrl-A, Ctrl-E, Tab…: leave the match on the line, then readline acts on the key.
      this.end(true);
      return false;
    }
    return true;
  }

  /** The prompt changed (a notice, a new command's prompt) while searching: keep it for when the search ends, and redraw. */
  redraw(prompt: string): void {
    if (this.search === undefined) return;
    this.search.prompt = prompt;
    this.draw();
  }

  /** Leave the search, restoring the line from before Ctrl-R. */
  cancel(): void {
    if (this.search !== undefined) this.end(false);
  }

  private get history(): readonly string[] {
    return (this.rl as Line).history ?? [];
  }

  private start(): void {
    const rl = this.rl as Line;
    this.search = { query: '', index: -1, failed: false, line: rl.line, cursor: rl.cursor, prompt: rl.getPrompt() };
    this.draw();
  }

  private extend(search: Search, char: string): void {
    search.query += char;
    // The match shown stays while it still contains the query.
    this.seek(search, search.index === -1 ? 0 : search.index);
  }

  private older(search: Search): void {
    if (search.query === '') {
      if (this.lastQuery === '') return;
      search.query = this.lastQuery;
      this.seek(search, 0);
      return;
    }
    this.seek(search, search.index + 1);
  }

  private shorten(search: Search): void {
    if (search.query === '') return;
    search.query = search.query.slice(0, -1);
    if (search.query === '') {
      search.index = -1;
      search.failed = false;
      this.draw();
      return;
    }
    this.seek(search, 0);
  }

  private seek(search: Search, from: number): void {
    const found = findOlder(this.history, search.query, from);
    search.failed = found === -1;
    if (found !== -1) search.index = found;
    this.draw();
  }

  private draw(): void {
    const search = this.search!;
    const rl = this.rl as Line;
    const match = search.index === -1 ? '' : (this.history[search.index] ?? '');
    rl.setPrompt(`(${search.failed ? 'failed ' : ''}reverse-i-search)\`${search.query}': `);
    rl.line = match;
    rl.cursor = Math.max(match.indexOf(search.query), 0);
    rl.prompt(true);
  }

  /** End the search with the match on the line (`keep`) or the line from before. */
  private end(keep: boolean): void {
    const search = this.search!;
    this.search = undefined;
    if (search.query !== '') this.lastQuery = search.query;
    const rl = this.rl as Line;
    const match = search.index === -1 ? undefined : this.history[search.index];
    rl.setPrompt(search.prompt);
    if (keep && match !== undefined) {
      rl.line = match;
      rl.cursor = Math.max(match.indexOf(search.query), 0);
    } else {
      rl.line = search.line;
      rl.cursor = search.cursor;
    }
    rl.prompt(true);
  }
}
