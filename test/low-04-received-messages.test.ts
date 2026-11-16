/**
 * LOW-04: See each received message, numbered, and show it again.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixture, type Fixture } from './support/fixture.js';
import { drive, type Driver } from './support/low.js';

const REPLY = '<rpc-reply xmlns="urn:ietf:params:xml:ns:netconf:base:1.0" message-id="9"><data><name>a&lt;b</name></data></rpc-reply>';
const BROKEN = '<rpc-reply><ok></rpc-reply>';

/** A framed session that has received the server's hello and then `extra` messages sent raw by the server. */
async function withMessages(f: Fixture, ...extra: string[]): Promise<Driver> {
  const d = drive(['router1', '--framed'], f.home);
  await d.until('stderr', /message 1 · hello/);
  for (const [i, text] of extra.entries()) {
    f.server.last()!.sendRaw(`${text}]]>]]>`);
    await d.until('stderr', new RegExp(`message ${i + 2} · `));
  }
  return d;
}

describe('LOW-04 received messages', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await fixture();
  });
  afterAll(() => f.close());

  it('AC1: each received message is printed above the prompt as it arrives, numbered from 1, as indented XML', async () => {
    const d = await withMessages(f, REPLY);
    await d.until('stderr', /<\/rpc-reply>/);
    const shown = d.err();
    expect(shown).toMatch(/^message 1 · hello · \d+ B\n<hello/m);
    expect(shown).toMatch(/message 2 · rpc-reply · \d+ B\n<rpc-reply[^>]*message-id="9">\n {2}<data>\n {4}<name>a&lt;b<\/name>\n {2}<\/data>\n<\/rpc-reply>/);
    await d.finish();
  });

  it("AC2: a message that isn't well-formed XML is printed as text with the parse error, and the session stays open", async () => {
    const d = await withMessages(f, BROKEN);
    await d.until('stderr', /<\/rpc-reply>\n/);
    expect(d.err()).toMatch(/message 2 · 27 B · not well-formed XML: [^\n]+\n<rpc-reply><ok><\/rpc-reply>/);
    d.line('status');
    await d.until('stdout', /^kind\s+framed$/m);
    expect(d.out()).toContain('nnc router1 [framed eom]> ');
    await d.finish();
  });

  it('AC3: show N prints message N again; --raw prints it exactly as received; --raw > file saves it', async () => {
    const d = await withMessages(f, REPLY);
    d.line('show 2');
    await d.until('stdout', /<\/rpc-reply>\n/);
    expect(d.out()).toMatch(/<rpc-reply[^>]*>\n {2}<data>\n {4}<name>a&lt;b<\/name>/);
    d.line('show 2 --raw');
    await d.until('stdout', new RegExp(`${REPLY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\n`));
    d.line('show 2 --raw > reply.xml');
    await d.until('stdout', /wrote \d+ bytes to reply\.xml/);
    d.line('show 9');
    await d.until('stderr', /show: no message 9 \(1 to 2\)/);
    await d.finish();
    expect(readFileSync(join(f.home.dir, 'reply.xml'), 'utf8')).toBe(REPLY);
  });

  it('AC4: show with no number lists the messages: number, time, size and root element', async () => {
    const d = await withMessages(f, REPLY, BROKEN);
    d.line('show');
    const list = await d.until('stdout', /\n3 {2}[^\n]+\n/);
    expect(list).toMatch(/(?:^|> )1 {2}\d\d:\d\d:\d\d\.\d{3} {2}\d+ B {2}hello\n/m);
    expect(list).toMatch(/^2 {2}\d\d:\d\d:\d\d\.\d{3} {2}\d+ B {2}rpc-reply$/m);
    expect(list).toMatch(/^3 {2}\d\d:\d\d:\d\d\.\d{3}  +27 B {2}\(not well-formed XML\)$/m);
    await d.finish();
  });

  it('AC5: a framing error ends the session with a message describing it, and the prompt returns to nnc>', async () => {
    const d = await withMessages(f);
    d.line('framing chunked');
    await d.until('stdout', /switched/);
    f.server.last()!.sendRaw('<rpc-reply/>]]>]]>');
    const ended = await d.until('stderr', /framed session to router1 ended: [^\n]+\n/);
    expect(ended).toMatch(/framed session to router1 ended: framing error: /);
    await d.until('stdout', /nnc> $/);
    d.line('status');
    await d.until('stdout', /not connected/);
    await d.finish();
  });
});
