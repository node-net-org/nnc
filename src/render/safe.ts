/**
 * Keeping device data from controlling the terminal (docs/cli.md §6.6, LANG-13).
 *
 * Well-formed XML can carry DEL, C1 controls (U+0080 to U+009F, among them
 * U+009B, which many terminals treat as the start of an escape sequence) and
 * bidirectional-text controls that make text read differently from what it
 * is. The XML and JSON forms escape them losslessly, so what is shown or
 * saved still parses to the device's values; exact forms are escaped only on
 * a terminal; and everything written to a terminal passes a last check that
 * lets through only nnc's own colour codes.
 */

/* eslint-disable no-control-regex -- matching control characters is the point of this module */

/** DEL, C1 and bidirectional controls: legal in XML text and JSON strings, unsafe on a terminal. */
const DATA_UNSAFE = /[\u007f-\u009f‪-‮⁦-⁩]/g;
/** Every character shown as an escape on a terminal: C0 but tab and newline, plus the above. */
const TERMINAL_UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;
/** One of nnc's colour codes: ESC [ digits and semicolons m. */
const COLOUR = /^\u001b\[[0-9;]*m/;

const hex = (c: string): string => c.charCodeAt(0).toString(16).padStart(2, '0');

/** Serialised XML with DEL, C1 and bidi controls as character references; none of them can be in a name. */
export function xmlSafe(xml: string): string {
  return xml.replace(DATA_UNSAFE, (c) => `&#x${hex(c)};`);
}

/** JSON.stringify, with DEL, C1 and bidi controls as \u escapes (the rest of C0 is escaped already). */
export function toJson(value: unknown, indent?: number): string {
  return JSON.stringify(value, null, indent).replace(DATA_UNSAFE, (c) => `\\u${hex(c).padStart(4, '0')}`);
}

/**
 * Text for a terminal: control characters as `\xHH` (bidi controls as `\uHHHH`, a carriage return
 * not followed by a newline as `\r`). With `allowColour`, an ESC that starts a colour code is kept,
 * for text nnc has coloured itself.
 */
export function escapeTerminal(text: string, options: { readonly allowColour?: boolean } = {}): string {
  return text.replace(TERMINAL_UNSAFE, (c, offset: number) => {
    if (c === '\u001b' && options.allowColour === true && COLOUR.test(text.slice(offset))) return c;
    if (c === '\r') return text[offset + 1] === '\n' ? c : '\\r';
    const code = c.charCodeAt(0);
    return code > 0xff ? `\\u${code.toString(16).padStart(4, '0')}` : `\\x${hex(c)}`;
  });
}

/**
 * Device text for a one-line human view (compare's diff, the origins view):
 * control characters as visible escapes (LANG-13). Text that would not read
 * as itself on one line (empty, padded, with line breaks or tabs, which could
 * forge lines, or with runs of spaces, which could forge columns) is quoted,
 * with its whitespace escaped: `""`, `"v "`, `"a\\nb"`, `"up   learned"`.
 */
export function shownValue(text: string): string {
  return text === '' || /^\s|\s$|[\n\r\t]| {2}/.test(text) ? escapeTerminal(JSON.stringify(text)) : escapeTerminal(text);
}
