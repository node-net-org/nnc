/**
 * LANG-09: See messages that arrive while I'm typing without losing my input.
 */
import { x } from '@node-net/netconf';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Fixture } from './support/fixture.js';
import { runNnc } from './support/nnc.js';
import { LAB, RPC, outputFixture } from './support/output.js';
import { HAS_PTY, plain, runPty } from './support/pty.js';

const PROMPT = /nnc router1> $/;
const linkDown = (ifName: string) => x('link-down', { xmlns: LAB }, x('interface', ifName));

describe('LANG-09 asynchronous messages', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await outputFixture();
  });
  afterAll(() => f.close());

  it.skipIf(!HAS_PTY)('AC1: a notification, warning or server-closed message arriving at the prompt is printed above it', async () => {
    const steps = [
      { wait: PROMPT, then: () => f.server.last()!.notify(linkDown('eth1'), '2026-11-07T10:00:00Z') },
      { wait: /link-down[\s\S]*nnc router1> $/, then: () => f.server.last()!.destroy() },
      { wait: /server closed the session[\s\S]*nnc> $/, send: 'exit\r' },
    ];
    const out = plain(await runPty(['router1'], steps, { home: f.home }));
    expect(out).toMatch(/notification 1 · 2026-11-07T10:00:00Z · link-down[^\n]*\nnnc router1> /);
    expect(out).toMatch(/server closed the session to router1[^\n]*\nnnc> /);
  });

  it.skipIf(!HAS_PTY)('AC2: the prompt and a partly typed command are redrawn underneath, with the cursor where it was', async () => {
    const steps = [
      { wait: PROMPT, send: 'get-con' },
      { pause: 200, then: () => f.server.last()!.notify(linkDown('eth2'), '2026-11-07T10:00:00Z') },
      { wait: /link-down[\s\S]*nnc router1> get-con$/, send: 'fig running\r' },
      { wait: PROMPT, send: 'exit\r' },
    ];
    const out = plain(await runPty(['router1'], steps, { home: f.home }));
    expect(out).toMatch(/link-down[^\n]*\nnnc router1> get-con/);
    expect(out).toContain('<hostname>router1</hostname>');
    expect(f.sent().map((op) => op.name)).toContain('get-config');
  });

  it.skipIf(!HAS_PTY)("AC3: while a command's result is shown, such messages are held and printed when it finishes", async () => {
    const steps = [{ wait: PROMPT, send: `${RPC.notify}\r` }, { wait: /link-down[\s\S]*nnc router1> $/, send: 'exit\r' }];
    const out = plain(await runPty(['router1'], steps, { home: f.home }));
    const ok = out.indexOf('\nok\n');
    const notice = out.indexOf('notification 1 ·');
    expect(ok).toBeGreaterThan(-1);
    expect(notice).toBeGreaterThan(ok);
  });

  it('AC4: in script mode they go to standard error in the order they arrived', async () => {
    const r = await runNnc(['router1', '-c', RPC.notify, '-c', RPC.notify, '-c', 'notifications'], { home: f.home });
    expect(r.code).toBe(0);
    const first = r.stderr.indexOf('notification 1 ·');
    const second = r.stderr.indexOf('notification 2 ·');
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
    expect(r.stdout.startsWith('ok\nok\n')).toBe(true);
  });
});
