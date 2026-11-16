/**
 * Bytes without Node's Buffer, so nnc's raw sessions and trace run in any
 * JavaScript runtime: UTF-8 in and out, latin1, hex, concatenation, search.
 */

const ENCODER = new TextEncoder();
// ignoreBOM: a BOM in received bytes is shown as received, as Buffer.toString showed it.
const DECODER = new TextDecoder('utf-8', { ignoreBOM: true });

export function utf8(text: string): Uint8Array {
  return ENCODER.encode(text);
}

/** UTF-8 bytes as text; invalid sequences become U+FFFD, as with Buffer. */
export function fromUtf8(bytes: Uint8Array): string {
  return DECODER.decode(bytes);
}

/** The UTF-8 length of a string, in bytes. */
export function byteLength(text: string): number {
  return ENCODER.encode(text).length;
}

/** Bytes 0-255 as the characters with those codes. */
export function latin1(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return out;
}

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const p of parts) length += p.length;
  const out = new Uint8Array(length);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Where `needle` first occurs in `bytes` at or after `from`, or -1. */
export function indexOf(bytes: Uint8Array, needle: Uint8Array, from = 0): number {
  if (needle.length === 0) return from <= bytes.length ? from : -1;
  const last = bytes.length - needle.length;
  for (let i = bytes.indexOf(needle[0]!, from); i !== -1 && i <= last; i = bytes.indexOf(needle[0]!, i + 1)) {
    let k = 1;
    while (k < needle.length && bytes[i + k] === needle[k]) k++;
    if (k === needle.length) return i;
  }
  return -1;
}

/** Hex digits (an even number of them, no separators) as bytes. */
export function fromHex(digits: string): Uint8Array {
  const out = new Uint8Array(digits.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(digits.slice(i * 2, i * 2 + 2), 16);
  return out;
}
