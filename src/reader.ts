/**
 * Commands from lines (docs/cli.md §6.1): a command whose inline XML is still
 * open at the end of a line continues on the next, until the XML balances.
 * Scripts and standard input read commands this way; the prompt does the same
 * with a `...>` prompt between lines (repl.ts).
 */

import { incomplete } from './lexer.js';

export interface Line {
  readonly text: string;
  /** 1-based line number in its source. */
  readonly line: number;
}

/**
 * The next command and the line it starts on, or undefined at the end of input.
 * Input that ends inside XML yields what was read; lexing it then reports the open XML.
 */
export async function nextCommand(
  next: () => Promise<Line | undefined>,
  isIncomplete: (text: string) => boolean = incomplete,
): Promise<Line | undefined> {
  const first = await next();
  if (first === undefined) return undefined;
  let text = first.text;
  while (isIncomplete(text)) {
    const more = await next();
    if (more === undefined) break;
    text += `\n${more.text}`;
  }
  return { text, line: first.line };
}
