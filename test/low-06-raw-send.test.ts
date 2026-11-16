/**
 * LOW-06: Send text, hex or file bytes in a raw session.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fixture, type Fixture } from './support/fixture.js';
import { drive, type Driver } from './support/low.js';

async function raw(f: Fixture): Promise<Driver> {
  const d = drive(['router1', '--raw'], f.home);
  await d.until('stderr', /\]\]>\]\]>/);
  return d;
}

describe('LOW-06 raw send', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await fixture();
  });
  afterAll(() => f.close());

  it('AC1: send writes the text as UTF-8 bytes, with no newline added', async () => {
    const d = await raw(f);
    d.line('send héllo  # not a comment');
    await d.until('stdout', /sent \d+ bytes \(raw\)/);
    await d.finish();
    expect(f.server.lastBytes()).toEqual(Buffer.from('héllo  # not a comment', 'utf8'));
  });

  it('AC2: the escapes \\n \\r \\t \\\\ and \\xHH give their bytes, so send \\n#4\\nabcd\\n##\\n sends one valid chunk', async () => {
    const d = await raw(f);
    d.line('send \\n#4\\nabcd\\n##\\n');
    await d.until('stdout', /sent 12 bytes \(raw\)/);
    d.line('send \\r\\t\\\\\\x00\\xFF');
    await d.until('stdout', /sent 5 bytes \(raw\)/);
    await d.finish();
    expect(f.server.lastBytes()).toEqual(Buffer.concat([Buffer.from('\n#4\nabcd\n##\n'), Buffer.from([0x0d, 0x09, 0x5c, 0x00, 0xff])]));
  });

  it('AC3: an invalid escape fails before sending, showing where it is', async () => {
    const d = await raw(f);
    d.line('send ab\\xZZcd');
    const err = await d.until('stderr', /\^\n/);
    expect(err).toContain('send: invalid escape "\\\\xZZ" at column 3 (use \\n \\r \\t \\\\ or \\xHH); nothing was sent\n  ab\\xZZcd\n    ^\n');
    d.line('send \\q');
    await d.until('stderr', /invalid escape "\\\\q" at column 1/);
    await d.finish();
    expect(f.server.lastBytes().length).toBe(0);
  });

  it('AC4: send-hex writes the bytes given in hex, spaces optional; odd digits or non-hex fail before sending', async () => {
    const d = await raw(f);
    d.line('send-hex 3c 68 65');
    await d.until('stdout', /sent 3 bytes \(raw\)/);
    d.line('send-hex 6C6c6f');
    await d.until('stdout', /sent 3 bytes \(raw\)/);
    d.line('send-hex 3c6');
    await d.until('stderr', /send-hex: an odd number of hex digits \(3\); give two per byte; nothing was sent/);
    d.line('send-hex 3c zz');
    await d.until('stderr', /send-hex: "z" is not a hex digit; nothing was sent/);
    await d.finish();
    expect(f.server.lastBytes().toString()).toBe('<hello');
  });

  it("AC5: send-file writes the file's bytes unchanged", async () => {
    const all = Buffer.from(Array.from({ length: 256 }, (_v, i) => i));
    writeFileSync(join(f.home.dir, 'reply.bin'), all);
    const d = await raw(f);
    d.line('send-file reply.bin');
    await d.until('stdout', /sent 256 bytes \(raw\)/);
    d.line('send-file missing.bin');
    await d.until('stderr', /send-file: cannot read missing\.bin: ENOENT; nothing was sent/);
    await vi.waitFor(() => expect(f.server.lastBytes().length).toBe(256));
    await d.finish();
    expect(f.server.lastBytes()).toEqual(all);
  });

  it('AC6: each command prints the number of bytes written', async () => {
    writeFileSync(join(f.home.dir, 'one.bin'), 'x');
    const d = await raw(f);
    d.line('send abc');
    await d.until('stdout', /(?:^|> )sent 3 bytes \(raw\)$/m);
    d.line('send-hex 00');
    await d.until('stdout', /(?:^|> )sent 1 byte \(raw\)$/m);
    d.line('send-file one.bin');
    await d.until('stdout', /(?:^|> )sent 1 byte \(raw\)$/m);
    await d.finish();
  });
});
