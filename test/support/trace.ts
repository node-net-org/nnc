/**
 * Helpers for the TRACE tests: hand-framed replies, so a test controls exactly
 * how a message is split on the wire.
 */
import type { FakeServer } from '@node-net/netconf/testing';

/** Chunked framing of `parts`, one chunk per part (RFC 6242 §4.2). */
export function chunked(parts: readonly string[]): string {
  return `${parts.map((p) => `\n#${Buffer.byteLength(p)}\n${p}`).join('')}\n##\n`;
}

/** Write each piece separately, a little apart, so each arrives as its own read. */
export async function sendPieces(server: FakeServer, pieces: readonly (string | Buffer)[], gapMs = 30): Promise<void> {
  for (const piece of pieces) {
    server.sendRaw(piece);
    await new Promise((r) => setTimeout(r, gapMs));
  }
}

/** The trace entries' header lines in `stderr`. */
export function entryHeads(stderr: string): string[] {
  return stderr.split('\n').filter((l) => /^(>>|<<) \d\d:\d\d:\d\d\.\d{3} /.test(l));
}

/** Outgoing trace entries, apart from the <close-session> nnc sends as a run ends. */
export function sentEntries(stderr: string): string[] {
  return entryHeads(stderr).filter((h) => h.startsWith('>>') && !h.includes('<close-session/>'));
}

export const reply = (id: string | undefined, body: string): string =>
  `<rpc-reply xmlns="urn:ietf:params:xml:ns:netconf:base:1.0" message-id="${id ?? ''}">${body}</rpc-reply>`;
