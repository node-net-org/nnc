/**
 * How trace entries look (docs/cli.md §5): direction, time, level and size on
 * a header line; bytes escaped onto that line; messages below it.
 */

import { fromUtf8 } from '../bytes.js';

/** `HH:MM:SS.mmm`, local time. */
export function timestamp(date: Date): string {
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}.${String(date.getMilliseconds()).padStart(3, '0')}`;
}

const hex = (b: number): string => `\\x${b.toString(16).padStart(2, '0')}`;

/** Length of the valid UTF-8 sequence starting at `i`, or 0 if there isn't one. */
function utf8Length(bytes: Uint8Array, i: number): number {
  const b = bytes[i]!;
  let n: number;
  let min: number;
  if (b >= 0xc2 && b <= 0xdf) [n, min] = [2, 0x80];
  else if (b >= 0xe0 && b <= 0xef) [n, min] = [3, 0x800];
  else if (b >= 0xf0 && b <= 0xf4) [n, min] = [4, 0x10000];
  else return 0;
  if (i + n > bytes.length) return 0;
  let cp = b & (0xff >> (n + 1));
  for (let k = 1; k < n; k++) {
    const c = bytes[i + k]!;
    if ((c & 0xc0) !== 0x80) return 0;
    cp = (cp << 6) | (c & 0x3f);
  }
  if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return 0;
  return n;
}

/**
 * Bytes as one line of text: `\n`, `\r`, `\t` and `\\` escaped, other control
 * bytes and bytes that aren't valid UTF-8 as `\xHH`.
 */
export function escapeBytes(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i]!;
    if (b < 0x80) {
      if (b === 0x0a) out += '\\n';
      else if (b === 0x0d) out += '\\r';
      else if (b === 0x09) out += '\\t';
      else if (b === 0x5c) out += '\\\\';
      else if (b < 0x20 || b === 0x7f) out += hex(b);
      else out += String.fromCharCode(b);
      i++;
      continue;
    }
    const n = utf8Length(bytes, i);
    if (n === 0) {
      out += hex(b);
      i++;
    } else {
      const text = fromUtf8(bytes.subarray(i, i + n));
      // C1 controls are control characters too.
      const cp = text.codePointAt(0)!;
      out += cp >= 0x80 && cp <= 0x9f ? [...bytes.subarray(i, i + n)].map(hex).join('') : text;
      i += n;
    }
  }
  return out;
}

const ESC = '\u001b[';
const paint = (code: string, text: string): string => `${ESC}${code}m${text}${ESC}0m`;

/**
 * Minimal XML colour for a terminal (the minimum of LANG-06): tag names cyan,
 * attribute names yellow, attribute values green. Works on the pretty-printed
 * text, so it never changes what is shown, only how.
 */
export function colourXml(xml: string): string {
  return xml.replace(/<(\/?)([^\s/>!?]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)(\s*\/?)>/g, (_m, slash: string, name: string, attrs: string, end: string) => {
    const coloured = attrs.replace(/(\s+)([^\s=]+)(\s*=\s*)("[^"]*"|'[^']*')/g, (_a, sp: string, an: string, eq: string, v: string) => `${sp}${paint('33', an)}${eq}${paint('32', v)}`);
    return `${paint('36', `<${slash}${name}`)}${coloured}${paint('36', `${end}>`)}`;
  });
}
