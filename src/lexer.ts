/**
 * Split a command into words (docs/cli.md §6.1).
 *
 * - Words are separated by whitespace.
 * - `'…'` quotes literally; `"…"` quotes with `\` escapes; `\` outside quotes escapes the next character.
 * - Inside `[…]` in a word, quotes are kept as they are, so a YANG path or XPath predicate needs
 *   no extra quoting: `read /ietf-interfaces:interfaces/interface[name="eth0"]`.
 * - A `(…)` in a word that closes on the same line is kept as it is, quotes and spaces included,
 *   so a named path's arguments need no extra quoting: `read @route(0.0.0.0/0, "192.0.2.254")`.
 * - `#` at the start of a word starts a comment that runs to the end of the line.
 * - An unquoted word starting with `<` is inline XML. It runs until its elements balance, and may
 *   span lines; elements separated only by spaces stay one word (`<a/> <b/>`). Quotes, `#` and `>`
 *   inside it are XML. What follows it is lexed as usual, so options and `> path` may come after.
 * - An unquoted word starting with `{` is inline RFC 7951 JSON. It runs until its braces balance
 *   (outside JSON strings), and may span lines. Quotes, `#`, `[` and `>` inside it are JSON.
 * - A trailing unquoted `> path` writes the result to that path; `>> path` appends.
 *
 * A command whose XML or JSON hasn't balanced by the end of the text is `incomplete()`: the prompt and
 * scripts read more lines until it is. With no more input, the XML runs to the end of the text and
 * the command's parser reports the problem.
 */

import { CliError, usageError } from './errors.js';

export interface Word {
  readonly text: string;
  /** True if any part of the word was quoted or escaped, or it is XML, so it is never read as an option or `>`. */
  readonly literal: boolean;
}

export interface Redirect {
  readonly path: string;
  /** `>>`: append rather than replace. */
  readonly append: boolean;
}

export interface Lexed {
  readonly words: readonly Word[];
  /** The path after a trailing `>` or `>>`, if any. */
  readonly redirect: Redirect | undefined;
}

/** Just past the `)` closing the `(` at `start` on the same line, skipping quoted text; undefined if it doesn't close. */
function parenEnd(text: string, start: number): number | undefined {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (c === '\n') return undefined;
    if (c === '"' || c === "'") {
      const end = text.indexOf(c, i + 1);
      if (end === -1 || text.slice(i + 1, end).includes('\n')) return undefined;
      i = end;
    } else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i + 1;
  }
  return undefined;
}

/** Where inline XML starting at `start` ends, or undefined while it is still open at the end of the text. */
function scanXml(text: string, start: number): number | undefined {
  const n = text.length;
  let depth = 0;
  let i = start;
  for (;;) {
    if (i >= n) return depth === 0 && i > start ? i : undefined;
    if (text[i] !== '<') {
      // Character data inside an element.
      i++;
      continue;
    }
    const until = (close: string, from: number): number | undefined => {
      const k = text.indexOf(close, from);
      return k === -1 ? undefined : k + close.length;
    };
    let next: number | undefined;
    if (text.startsWith('<!--', i)) next = until('-->', i + 4);
    else if (text.startsWith('<![CDATA[', i)) next = until(']]>', i + 9);
    else if (text.startsWith('<?', i)) next = until('?>', i + 2);
    else if (text.startsWith('<!', i)) next = declarationEnd(text, i + 2);
    else if (text[i + 1] === '/') {
      next = until('>', i + 2);
      if (next !== undefined) depth = Math.max(0, depth - 1);
    } else {
      const end = tagEnd(text, i + 1);
      if (end !== undefined) {
        if (text[end - 2] !== '/') depth++;
        next = end;
      }
    }
    if (next === undefined) return undefined;
    i = next;
    if (depth > 0) continue;
    // Balanced: another element may follow after spaces on the same line; anything else ends the word.
    let j = i;
    while (j < n && (text[j] === ' ' || text[j] === '\t')) j++;
    if (text[j] !== '<') return i;
    i = j;
  }
}

/** Where inline JSON starting at `start` (a `{`) ends, or undefined while it is still open at the end of the text. */
function scanJson(text: string, start: number): number | undefined {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      // A JSON string: skip to its closing quote, past escapes.
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
      if (i >= text.length) return undefined;
    } else if (c === '{' || c === '[') depth++;
    else if ((c === '}' || c === ']') && --depth === 0) return i + 1;
  }
  return undefined;
}

/** The index after the `>` closing a start tag, skipping quoted attribute values. */
function tagEnd(text: string, from: number): number | undefined {
  let quote: string | undefined;
  for (let k = from; k < text.length; k++) {
    const c = text[k]!;
    if (quote !== undefined) {
      if (c === quote) quote = undefined;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '>') return k + 1;
  }
  return undefined;
}

/** The index after a `<!DOCTYPE …>`-style declaration, allowing an internal subset in `[…]`. */
function declarationEnd(text: string, from: number): number | undefined {
  let brackets = 0;
  for (let k = from; k < text.length; k++) {
    const c = text[k];
    if (c === '[') brackets++;
    else if (c === ']') brackets--;
    else if (c === '>' && brackets <= 0) return k + 1;
  }
  return undefined;
}

/** "column 7", or "line 2, column 7" when the command spans lines. */
function position(text: string, index: number): string {
  const before = text.slice(0, index);
  const line = before.split('\n').length;
  const column = index - before.lastIndexOf('\n');
  return text.includes('\n') ? `line ${line}, column ${column}` : `column ${column}`;
}

/** True when the command's inline XML or JSON is still open at the end of the text, so more lines belong to it. */
export function incomplete(text: string): boolean {
  try {
    lex(text, { more: true });
    return false;
  } catch (err) {
    return err instanceof XmlNotClosed;
  }
}

/** The command ended inside inline XML or JSON while more input may still come. */
class XmlNotClosed extends CliError {}

export interface LexOptions {
  /**
   * More lines may follow: open inline XML throws (see `incomplete`). Otherwise
   * the XML runs to the end of the text, and the command's XML parser reports
   * what is wrong with it, with its position.
   */
  readonly more?: boolean;
}

export function lex(text: string, options: LexOptions = {}): Lexed {
  const words: Word[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '#') {
      // A comment runs to the end of the line.
      const eol = text.indexOf('\n', i);
      i = eol === -1 ? n : eol;
      continue;
    }
    if (c === '{') {
      const end = scanJson(text, i);
      if (end === undefined) {
        if (options.more === true) throw new XmlNotClosed(`the JSON starting at ${position(text, i)} isn't closed`);
        words.push({ text: text.slice(i).trimEnd(), literal: true });
        break;
      }
      words.push({ text: text.slice(i, end), literal: true });
      i = end;
      continue;
    }
    if (c === '<') {
      const end = scanXml(text, i);
      if (end === undefined) {
        if (options.more === true) throw new XmlNotClosed(`the XML starting at ${position(text, i)} isn't closed`);
        words.push({ text: text.slice(i).trimEnd(), literal: true });
        break;
      }
      words.push({ text: text.slice(i, end).trimEnd(), literal: true });
      i = end;
      continue;
    }
    let word = '';
    let literal = false;
    // Inside [...] (a YANG path or XPath predicate), quotes are part of the word: [name="eth0"].
    let brackets = 0;
    while (i < n && !/\s/.test(text[i]!)) {
      const ch = text[i]!;
      if (brackets > 0 && (ch === '"' || ch === "'")) {
        const end = text.indexOf(ch, i + 1);
        if (end === -1 || text.slice(i + 1, end).includes('\n')) throw usageError(`unterminated ${ch} starting at ${position(text, i)}`);
        word += text.slice(i, end + 1);
        i = end + 1;
      } else if (ch === '(' && brackets === 0 && parenEnd(text, i) !== undefined) {
        const end = parenEnd(text, i)!;
        word += text.slice(i, end);
        i = end;
      } else if (ch === '[' || (ch === ']' && brackets > 0)) {
        brackets += ch === '[' ? 1 : -1;
        word += ch;
        i++;
      } else if (ch === "'") {
        const end = text.indexOf("'", i + 1);
        if (end === -1 || text.slice(i + 1, end).includes('\n')) throw usageError(`unterminated ' starting at ${position(text, i)}`);
        word += text.slice(i + 1, end);
        literal = true;
        i = end + 1;
      } else if (ch === '"') {
        const startAt = i;
        i++;
        let closed = false;
        while (i < n && text[i] !== '\n') {
          const q = text[i]!;
          if (q === '"') {
            closed = true;
            i++;
            break;
          }
          if (q === '\\' && i + 1 < n) {
            word += text[i + 1];
            i += 2;
          } else {
            word += q;
            i++;
          }
        }
        if (!closed) throw usageError(`unterminated " starting at ${position(text, startAt)}`);
        literal = true;
      } else if (ch === '\\') {
        if (i + 1 >= n || text[i + 1] === '\n') throw usageError('nothing after \\ at the end of the line');
        word += text[i + 1];
        literal = true;
        i += 2;
      } else {
        word += ch;
        i++;
      }
    }
    words.push({ text: word, literal });
  }

  const isRedirect = (w: Word): boolean => !w.literal && (w.text === '>' || w.text === '>>');
  const at = words.findIndex(isRedirect);
  if (at === -1) {
    const glued = words.find((w) => !w.literal && w.text.startsWith('>'));
    if (glued !== undefined) throw usageError(`put a space after ${glued.text.startsWith('>>') ? '>>' : '>'} (found ${glued.text})`);
    return { words, redirect: undefined };
  }
  const op = words[at]!.text;
  if (at !== words.length - 2) throw usageError(`${op} must be followed by exactly one path, at the end of the line`);
  return { words: words.slice(0, at), redirect: { path: words[at + 1]!.text, append: op === '>>' } };
}
