/**
 * LANG-13: Device data can't control my terminal.
 */
/* eslint-disable no-control-regex -- these tests look for control characters on purpose */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseXml, x } from '@node-net/netconf';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixture, type Fixture } from './support/fixture.js';
import { drive } from './support/low.js';
import { runNnc } from './support/nnc.js';
import { HAS_PTY, runPty } from './support/pty.js';

const LAB = 'urn:example:lab';
// DEL, C1 (U+009B is the 8-bit CSI) and a bidi override, in text and in an attribute.
const NASTY = 'x\u007fy\u009b31mz\u202eq';
const NOTE = 'a\u009bb';
// Ordinary text that must come through unchanged.
const PLAIN = 'C:\\path\tcafé ✓';
const DATA = x('system', { xmlns: LAB }, x('descr', { note: NOTE }, NASTY), x('plain', PLAIN));
const UNSAFE = /[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
/** An ESC that doesn't start a colour code. */
const STRAY_ESC = /\u001b(?!\[[0-9;]*m)/;
/** The prompt's own line editing (readline moving the cursor and clearing the line), which isn't output. */
const withoutLineEditing = (text: string): string => text.replace(/\u001b\[\d*[GJK]/g, '');
const PROMPT = /nnc router1> $/;

describe('LANG-13 device data and the terminal', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await fixture({ fake: { handler: () => ({ data: [DATA] }) } });
  });
  afterAll(() => f.close());

  it('AC1: in XML results, DEL, C1 and bidi controls are character references, on screen and in files, and keep their values', async () => {
    const r = await runNnc(['router1', '-c', 'get-config running', '-c', 'get-config running > config.xml'], { home: f.home });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('<descr note="a&#x9b;b">x&#x7f;y&#x9b;31mz&#x202e;q</descr>');
    expect(r.stdout).not.toMatch(UNSAFE);
    const saved = readFileSync(join(f.home.dir, 'config.xml'), 'utf8');
    expect(saved).not.toMatch(UNSAFE);
    // Still valid XML with the device's values.
    const descr = parseXml(saved).child('descr')!;
    expect(descr.text()).toBe(NASTY);
    expect(descr.attr('note')).toBe(NOTE);

    // A framed session's received messages are XML results too.
    const d = drive(['router1', '--framed'], f.home);
    await d.until('stderr', /message 1 · hello/);
    f.server.last()!.sendRaw(`<data xmlns="${LAB}"><descr>${NASTY}</descr></data>]]>]]>`);
    const shown = await d.until('stderr', /<\/data>\n/);
    expect(shown).toContain('<descr>x&#x7f;y&#x9b;31mz&#x202e;q</descr>');
    await d.finish();
  });

  it('AC2: in JSON results they are \\u escapes, and the JSON keeps the values', async () => {
    const r = await runNnc(['router1', '-c', 'get-config running --json'], { home: f.home });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('x\\u007fy\\u009b31mz\\u202eq');
    expect(r.stdout).not.toMatch(UNSAFE);
    expect(JSON.stringify(JSON.parse(r.stdout))).toContain(JSON.stringify(NASTY).slice(1, -1));
  });

  it.skipIf(!HAS_PTY)('AC3: exact forms show control characters as escapes on a terminal and stay unchanged in files and pipes', async () => {
    const out = await runPty(['router1'], [
      { wait: PROMPT, send: 'get-config running --raw\r' },
      { wait: /<\/rpc-reply>[^\n]*\n[\s\S]*nnc router1> $/, send: 'exit\r' },
    ], { home: f.home });
    expect(out).toContain('x\\x7fy\\x9b31mz\\u202eq');
    expect(out).not.toMatch(UNSAFE);

    const piped = await runNnc(['router1', '-c', 'get-config running --raw', '-c', 'show-last --raw > reply.xml'], { home: f.home });
    expect(piped.stdout).toContain(`>${NASTY}</descr>`);
    expect(readFileSync(join(f.home.dir, 'reply.xml'), 'utf8')).toContain(`>${NASTY}</descr>`);

    // In a framed session, a message that isn't XML can carry ESC itself; show --raw escapes it on a terminal.
    const framed = await runPty(['router1', '--framed'], [
      { wait: /message 1 · hello[\s\S]*\[framed eom\]> $/, then: () => f.server.last()!.sendRaw('<a>\u001b[2J\u009bgone</a>]]>]]>') },
      { wait: /message 2 ·[\s\S]*\[framed eom\]> $/, send: 'show 2 --raw\r' },
      { wait: /gone<\/a>[^\n]*\n[\s\S]*\[framed eom\]> $/, send: 'exit\r' },
    ], { home: f.home });
    expect(framed).toContain('<a>\\x1b[2J\\x9bgone</a>');
    expect(withoutLineEditing(framed)).not.toMatch(STRAY_ESC);
    expect(framed).not.toMatch(UNSAFE);
  });

  it.skipIf(!HAS_PTY)('AC4: trace entries go to the trace file exactly and show escapes on a terminal', async () => {
    const out = await runPty(['router1'], [
      { wait: PROMPT, send: 'trace frames --file frames.log\r' },
      { wait: /frames\.log[\s\S]*nnc router1> $/, send: 'get-config running --no-page\r' },
      { wait: /<\/descr>[\s\S]*nnc router1> $/, send: 'exit\r' },
    ], { home: f.home });
    expect(out).toMatch(/<< [^\n]* frames \d+ B chunked\n[^\n]*x\\x7fy\\x9b31mz\\u202eq/);
    expect(out).not.toMatch(UNSAFE);
    expect(readFileSync(join(f.home.dir, 'frames.log'), 'utf8')).toContain(`>${NASTY}</descr>`);
  });

  it.skipIf(!HAS_PTY)("AC5: nothing printed to a terminal carries a control sequence other than nnc's own colours", async () => {
    const out = await runPty(['router1'], [
      { wait: PROMPT, then: () => f.server.last()!.notify(x('link-down', { xmlns: LAB }), `2026-11-07T10:00:00Z\u009b2J\u202e`) },
      { wait: /notification 1 ·[^\n]*\n[\s\S]*nnc router1> $/, send: 'get-config running --no-page\r' },
      { wait: /<\/descr>[\s\S]*nnc router1> $/, send: 'exit\r' },
    ], { home: f.home, env: { NO_COLOR: undefined } });
    // The notification's event time came from the device: it reaches the screen escaped.
    expect(out).toContain('notification 1 · 2026-11-07T10:00:00Z\\x9b2J\\u202e · link-down');
    // nnc's own colours are still there, and nothing else is.
    expect(out).toContain('\u001b[36m<descr');
    expect(out).not.toMatch(UNSAFE);
    expect(withoutLineEditing(out)).not.toMatch(STRAY_ESC);
  });

  it("AC6: ordinary text, tabs, newlines and other Unicode are unchanged, and backslashes aren't escaped", async () => {
    const r = await runNnc(['router1', '-c', 'get-config running', '-c', 'get-config running --json'], { home: f.home });
    expect(r.stdout).toContain(`<plain>${PLAIN}</plain>`);
    expect(r.stdout).toContain('"plain": "C:\\\\path\\tcafé ✓"');
    expect(r.stdout).toMatch(/<system[^>]*>\n {2}<descr/);
  });
});
