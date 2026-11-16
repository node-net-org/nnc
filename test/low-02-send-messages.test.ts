/**
 * LOW-02: Send whole messages exactly as I write them.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fixture, type Fixture } from './support/fixture.js';
import { editor } from './support/lang.js';
import { drive, NS, rpc, type Driver } from './support/low.js';

/** A framed session whose hello exchange has settled on base:1.0 (so both sides stay in end-of-message framing). */
async function framed10(f: Fixture, env?: Readonly<Record<string, string | undefined>>): Promise<Driver> {
  const d = drive(['router1', '--framed'], f.home, env);
  await d.until('stderr', /message 1 · hello/);
  d.line('hello --base 1.0');
  await d.until('stdout', /sent \d+ bytes/);
  await vi.waitFor(() => expect(f.server.last()!.version).toBe('1.0'));
  return d;
}

/** What the client sent after its hello. */
function afterHello(f: Fixture): string {
  const bytes = f.server.lastBytes().toString();
  return bytes.slice(bytes.indexOf(']]>]]>') + 6);
}

describe('LOW-02 send messages as written', () => {
  let f: Fixture;
  beforeAll(async () => {
    // Replies wait until two requests are in, so a reply proves both were sent before it (AC3).
    f = await fixture({
      fake: {
        handler: async (_rpc, ctx) => {
          await vi.waitFor(() => expect(ctx.server.requests.length).toBeGreaterThanOrEqual(2), { timeout: 5000 });
          return 'ok' as const;
        },
      },
    });
  });
  afterAll(() => f.close());

  it('AC1: send frames the message in the current framing and sends it', async () => {
    const d = await framed10(f);
    d.line(`send ${rpc('7')}`);
    await d.until('stdout', /sent \d+ bytes \(framed, eom\)/);
    d.line(`send ${rpc('8')}`);
    const replies = await d.until('stderr', /message 3 · rpc-reply[\s\S]*<\/rpc-reply>/);
    expect(replies).toMatch(/message 2 · rpc-reply · \d+ B\n<rpc-reply[^>]*message-id="[78]"/);
    expect(replies).toContain('message-id="7"');
    await d.finish();
    expect(afterHello(f)).toBe(`${rpc('7')}\n]]>]]>${rpc('8')}\n]]>]]>`);
  });

  it("AC2: the message is sent as typed: not checked as XML, re-indented or given a message-id", async () => {
    const odd = `<rpc   xmlns="${NS}"  ><get/></rpc>`;
    const d = await framed10(f);
    d.line(`send ${odd}`);
    await d.until('stdout', /sent \d+ bytes/);
    d.line('send not XML at all');
    await d.until('stdout', /sent \d+ bytes/);
    await d.finish();
    expect(afterHello(f)).toBe(`${odd}\n]]>]]>not XML at all\n]]>]]>`);
  });

  it('AC3: several messages can be sent before any reply arrives', async () => {
    const d = await framed10(f);
    d.line(`send ${rpc('a')}`);
    d.line(`send ${rpc('b')}`);
    const replies = await d.until('stderr', /message 3 · rpc-reply[\s\S]*<\/rpc-reply>/);
    expect(replies).toContain('message-id="a"');
    expect(replies).toContain('message-id="b"');
    expect(d.out().match(/sent \d+ bytes \(framed, eom\)/g)).toHaveLength(3);
    await d.finish();
  });

  it('AC4: XML may come inline, from @file, or via --edit', async () => {
    f.home.file('get.xml', rpc('f'));
    const ed = editor(f, 'low-send', [rpc('e')]);
    const d = await framed10(f, { EDITOR: ed.command });
    d.line('send @get.xml');
    await d.until('stdout', /sent \d+ bytes/);
    d.line('send --edit');
    await d.until('stdout', /sent \d+ bytes/);
    await d.until('stderr', /message 3 · rpc-reply/);
    await d.finish();
    expect(afterHello(f)).toBe(`${rpc('f')}\n]]>]]>${rpc('e')}\n]]>]]>`);
  });

  it("AC5: in end-of-message framing, a message containing ]]>]]> fails before sending, saying it can't be framed", async () => {
    f.home.file('delim.xml', rpc('d', '<get><filter>]]>]]></filter></get>'));
    const d = await framed10(f);
    d.line('send @delim.xml');
    const err = await d.until('stderr', /nothing was sent/);
    expect(err).toContain("send: can't frame this message in end-of-message framing: it contains ]]>]]>; a raw session can send it");
    await d.finish();
    expect(afterHello(f)).toBe('');
  });
});
