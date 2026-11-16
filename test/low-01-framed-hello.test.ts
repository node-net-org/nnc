/**
 * LOW-01: Open a framed session and drive the hello myself.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fixture, type Fixture } from './support/fixture.js';
import { NS, drive, rpc } from './support/low.js';

const BASE_10 = 'urn:ietf:params:netconf:base:1.0';
const BASE_11 = 'urn:ietf:params:netconf:base:1.1';
const PROMPT = /nnc router1 \[framed eom\]> $/;

describe('LOW-01 framed session, hello by hand', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await fixture();
  });
  afterAll(() => f.close());

  it('AC1: connect --framed opens the subsystem with EOM framing, sends nothing, and the prompt and message say so', async () => {
    const d = drive([], f.home);
    d.line('connect router1 --framed');
    const opened = await d.until('stdout', PROMPT);
    expect(opened).toMatch(/opened a framed session to router1 \(127\.0\.0\.1:\d+\) · end-of-message framing · nothing sent: you send the hello/);
    await d.until('stderr', /message 1 · hello/);
    d.line('status');
    await d.until('stdout', PROMPT);
    await d.finish();
    expect(f.server.lastBytes().length).toBe(0);
  });

  it("AC2: the server's hello is printed as a received message when it arrives", async () => {
    const d = drive(['router1', '--framed'], f.home);
    const notice = await d.until('stderr', /<\/hello>/);
    expect(notice).toMatch(/message 1 · hello · \d+ B\n<hello xmlns="urn:ietf:params:xml:ns:netconf:base:1\.0">\n {2}<capabilities>/);
    expect(notice).toContain(`<capability>${BASE_11}</capability>`);
    await d.finish();
  });

  it("AC3: server-hello prints the server's hello once it has arrived, and says it hasn't otherwise", async () => {
    const silent = await fixture({ fake: { hello: false } });
    try {
      const d = drive(['router1', '--framed'], silent.home);
      await d.until('stdout', PROMPT);
      d.line('server-hello');
      await d.until('stdout', /the server's hello hasn't arrived/);
      await d.finish();
    } finally {
      await silent.close();
    }
    const d = drive(['router1', '--framed'], f.home);
    await d.until('stderr', /message 1 · hello/);
    d.line('server-hello');
    expect(await d.until('stdout', /<\/hello>\n/)).toMatch(/<hello[^\n]*>\n {2}<capabilities>[\s\S]*<session-id>1<\/session-id>/);
    d.line('server-hello --raw');
    expect(await d.until('stdout', /<\/hello>\n/)).toMatch(/(^|> )<\?xml version="1\.0" encoding="UTF-8"\?><hello/);
    await d.finish();
  });

  it('AC4: hello advertises base:1.0 and base:1.1; --base 1.0 or --base 1.1 advertises only that one', async () => {
    const sentHello = async (line: string): Promise<string> => {
      const d = drive(['router1', '--framed'], f.home);
      await d.until('stderr', /message 1 · hello/);
      d.line(line);
      await d.until('stdout', /sent \d+ bytes \(framed, eom\)/);
      await vi.waitFor(() => expect(f.server.lastBytes().toString()).toContain(']]>]]>'));
      await d.finish();
      return f.server.lastBytes().toString();
    };
    const both = await sentHello('hello');
    expect(both).toContain(`<capability>${BASE_10}</capability>`);
    expect(both).toContain(`<capability>${BASE_11}</capability>`);
    expect(both.endsWith('</hello>\n]]>]]>')).toBe(true);
    const only10 = await sentHello('hello --base 1.0');
    expect(only10).toContain(BASE_10);
    expect(only10).not.toContain(BASE_11);
    const only11 = await sentHello('hello --base 1.1');
    expect(only11).toContain(BASE_11);
    expect(only11).not.toContain(BASE_10 + '<');
  });

  it('AC5: send <hello>...</hello> sends a hello written by hand instead', async () => {
    const hello = `<hello xmlns="${NS}"><capabilities><capability>${BASE_10}</capability></capabilities></hello>`;
    const d = drive(['router1', '--framed'], f.home);
    await d.until('stderr', /message 1 · hello/);
    d.line(`send ${hello}`);
    await d.until('stdout', /sent \d+ bytes \(framed, eom\)/);
    await vi.waitFor(() => expect(f.server.last()!.version).toBe('1.0'));
    await d.finish();
    expect(f.server.lastBytes().toString()).toBe(`${hello}\n]]>]]>`);
  });

  it('AC6: nothing switches to chunked framing automatically, even when both hellos advertise base:1.1', async () => {
    const d = drive(['router1', '--framed'], f.home);
    await d.until('stderr', /message 1 · hello/);
    d.line('hello');
    await d.until('stdout', /sent \d+ bytes \(framed, eom\)/);
    await vi.waitFor(() => expect(f.server.last()!.version).toBe('1.1'));
    d.line('framing');
    // Not anchored at the start: on a slow machine the prompt can still be
    // arriving when the command is sent, and then precedes the answer on its line.
    await d.until('stdout', /eom \(end-of-message, \]\]>\]\]>\)$/m);
    d.line(`send ${rpc('1')}`);
    await d.until('stdout', /sent \d+ bytes \(framed, eom\)/);
    await d.finish();
    const bytes = f.server.lastBytes().toString();
    expect(bytes.endsWith(`${rpc('1')}\n]]>]]>`)).toBe(true);
    expect(bytes).not.toContain('\n#');
  });
});
