/**
 * LOW-07: View received bytes as text or hex and end the stream.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixture, type Fixture } from './support/fixture.js';
import { drive, type Driver } from './support/low.js';

async function raw(f: Fixture): Promise<Driver> {
  const d = drive(['router1', '--raw'], f.home);
  await d.until('stderr', /\]\]>\]\]>/);
  return d;
}

describe('LOW-07 raw view and eof', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await fixture({ eofReply: 'bye\n' });
  });
  afterAll(() => f.close());

  it('AC1: by default received bytes are text, with control and non-UTF-8 bytes as \\xHH', async () => {
    const d = await raw(f);
    f.server.last()!.sendRaw(Buffer.from([0x68, 0x69, 0x09, 0x1b, 0xc3, 0x28]));
    const shown = await d.until('stderr', /<< 6 bytes\n[^\n]*\n/);
    expect(shown).toContain('<< 6 bytes\nhi\\t\\x1b\\xc3(\n');
    await d.finish();
  });

  it('AC2: output hex shows a hex dump with offsets and a text column; output text switches back', async () => {
    const d = await raw(f);
    d.line('output hex');
    d.line('output');
    await d.until('stdout', /received bytes as hex/);
    f.server.last()!.sendRaw('<rpc-reply/>');
    const dump = await d.until('stderr', /<< 12 bytes\n[^\n]*\n/);
    expect(dump).toMatch(/<< 12 bytes\n[0-9a-f]{8} {2}3c 72 70 63 2d 72 65 70 {2}6c 79 2f 3e {14}\|<rpc-reply\/>\|\n/);
    d.line('output text');
    d.line('output');
    await d.until('stdout', /received bytes as text/);
    f.server.last()!.sendRaw('ok');
    await d.until('stderr', /<< 2 bytes\nok\n/);
    // Formats for replies belong to client sessions, and say so here.
    d.line('output json');
    await d.until('stderr', /output: in this raw session, use text or hex \(json is for replies in client sessions; got "json"\)/);
    await d.finish();
  });

  it('AC3: received shows everything received in the session; received > file saves the bytes unchanged', async () => {
    const tail = Buffer.from([0x00, 0xff, 0x0d, 0x0a]);
    const d = await raw(f);
    f.server.last()!.sendRaw(tail);
    await d.until('stderr', /<< 4 bytes/);
    d.line('received');
    const shown = await d.until('stdout', /\\x00\\xff\\r\\n\n/);
    expect(shown).toContain('<?xml version="1.0" encoding="UTF-8"?><hello');
    d.line('received > dump.bin');
    await d.until('stdout', /wrote \d+ bytes to dump\.bin/);
    d.line('status');
    const status = await d.until('stdout', /^received\s+\d+ bytes$/m);
    await d.finish();
    const saved = readFileSync(join(f.home.dir, 'dump.bin'));
    expect(saved.subarray(0, 5).toString()).toBe('<?xml');
    expect(saved.subarray(-4)).toEqual(tail);
    expect(saved.includes(']]>]]>')).toBe(true);
    expect(String(saved.length)).toBe(/^received\s+(\d+) bytes$/m.exec(status)![1]);
  });

  it('AC4: eof ends the sending side; received bytes are still shown until the server closes', async () => {
    const d = await raw(f);
    d.line('eof');
    await d.until('stdout', /ended the sending side of the stream \(eof\); received bytes are still shown until the server closes/);
    await d.until('stderr', /<< 4 bytes\nbye\\n\n/);
    await d.until('stderr', /raw session to router1 ended: the server closed the stream/);
    await d.until('stdout', /nnc> $/);
    await d.finish();
  });

  it('AC5: after eof, send, send-hex and send-file fail, saying the stream has been ended', async () => {
    const g = await fixture();
    try {
      writeFileSync(join(g.home.dir, 'x.bin'), 'x');
      const d = await raw(g);
      d.line('eof');
      await d.until('stdout', /\[raw eof\]> $/);
      d.line('send abc');
      await d.until('stderr', /send: the stream has been ended \(eof\); nothing was sent/);
      d.line('send-hex 41');
      await d.until('stderr', /send-hex: the stream has been ended \(eof\); nothing was sent/);
      d.line('send-file x.bin');
      await d.until('stderr', /send-file: the stream has been ended \(eof\); nothing was sent/);
      await d.finish();
      expect(g.server.lastBytes().length).toBe(0);
    } finally {
      await g.close();
    }
  });
});
