/**
 * LOW-03: Switch a framed session to chunked framing.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fixture, type Fixture } from './support/fixture.js';
import { drive, rpc, type Driver } from './support/low.js';

/** A framed session after a hello advertising base:1.1, so the server has switched to chunked framing. */
async function negotiated11(f: Fixture): Promise<Driver> {
  const d = drive(['router1', '--framed'], f.home);
  await d.until('stderr', /message 1 · hello/);
  d.line('hello');
  await d.until('stdout', /sent \d+ bytes \(framed, eom\)/);
  await vi.waitFor(() => expect(f.server.last()!.version).toBe('1.1'));
  return d;
}

describe('LOW-03 framing chunked', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await fixture();
  });
  afterAll(() => f.close());

  it('AC1: framing chunked switches both directions to chunked framing from the next message', async () => {
    const d = await negotiated11(f);
    d.line('framing chunked');
    await d.until('stdout', /switched to chunked framing in both directions, from the next message/);
    d.line(`send ${rpc('5')}`);
    await d.until('stdout', /sent \d+ bytes \(framed, chunked\)/);
    // The reply is chunked too, and arrives as a message.
    const reply = await d.until('stderr', /message 2 · rpc-reply[\s\S]*<\/rpc-reply>/);
    expect(reply).toContain('message-id="5"');
    await d.finish();
    const bytes = f.server.lastBytes().toString();
    const after = bytes.slice(bytes.indexOf(']]>]]>') + 6);
    expect(after).toBe(`\n#${Buffer.byteLength(rpc('5'))}\n${rpc('5')}\n##\n`);
  });

  it('AC2: framing with no argument shows the current framing', async () => {
    const d = drive(['router1', '--framed'], f.home);
    // Switching before the server's (end-of-message framed) hello has arrived would make it a framing error.
    await d.until('stderr', /message 1 · hello/);
    d.line('framing');
    await d.until('stdout', /(?:^|> )eom \(end-of-message, \]\]>\]\]>\)$/m);
    d.line('framing chunked');
    await d.until('stdout', /switched/);
    d.line('framing');
    await d.until('stdout', /(?:^|> )chunked$/m);
    await d.finish();
  });

  it("AC3: framing eom after switching to chunked fails, saying the switch can't be undone", async () => {
    const r = drive(['router1', '--framed'], f.home);
    await r.until('stderr', /message 1 · hello/);
    r.line('framing chunked');
    await r.until('stdout', /switched/);
    r.line('framing eom');
    const err = await r.until('stderr', /can't be undone/);
    expect(err).toContain("framing: can't switch back to end-of-message framing: the switch to chunked can't be undone");
    r.line('framing');
    await r.until('stdout', /(?:^|> )chunked$/m);
    await r.finish();
  });

  it('AC4: status and trace frames show the framing in use', async () => {
    const d = drive([], f.home);
    d.line('trace frames');
    await d.until('stdout', /frames/);
    d.line('connect router1 --framed');
    await d.until('stderr', /<<[^\n]*\d+ B eom/);
    d.line('hello');
    await d.until('stderr', />>[^\n]*\d+ B eom/);
    await vi.waitFor(() => expect(f.server.last()!.version).toBe('1.1'));
    d.line('status');
    await d.until('stdout', /^framing\s+eom$/m);
    d.line('framing chunked');
    await d.until('stdout', /switched/);
    d.line('status');
    await d.until('stdout', /^framing\s+chunked$/m);
    d.line(`send ${rpc('7')}`);
    // The trace follows the channel: the sent message and the reply are both chunked.
    await d.until('stderr', />>[^\n]*\d+ B chunked/);
    await d.until('stderr', /<<[^\n]*\d+ B chunked/);
    await d.finish();
  });
});
