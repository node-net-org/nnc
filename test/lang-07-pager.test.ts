/**
 * LANG-07: Page through long results.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Fixture } from './support/fixture.js';
import { runNnc } from './support/nnc.js';
import { RPC, outputFixture } from './support/output.js';
import { HAS_PTY, plain, recordingPager, runPty } from './support/pty.js';

const PROMPT = /nnc router1> $/;

describe.skipIf(!HAS_PTY)('LANG-07 paging', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await outputFixture();
  });
  afterAll(() => f.close());

  it('AC1: on a terminal a result taller than it goes through $PAGER, or less -R when unset', async () => {
    const pager = recordingPager(f.home);
    const steps = [{ wait: PROMPT, send: `${RPC.big}\r` }, { wait: PROMPT, send: 'get-config running\r' }, { wait: PROMPT, send: 'exit\r' }];
    const out = plain(await runPty(['router1'], steps, { home: f.home, rows: 10, env: { PAGER: pager.command } }));
    expect(out).toContain('[paged 122 lines]');
    // A short result isn't paged.
    expect(out).toContain('<hostname>router1</hostname>');
    const runs = pager.saw().trim().split('\n').map((l) => JSON.parse(l) as { args: string[]; text: string });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.text).toContain('<name>eth39</name>');

    // With PAGER unset: less -R (here a recording less first on PATH).
    const unset = recordingPager(f.home);
    await runPty(['router1'], steps, { home: f.home, rows: 10, env: { PAGER: undefined, PATH: `${unset.binDir}:${process.env['PATH']!}` } });
    const last = unset.saw().trim().split('\n').at(-1)!;
    expect((JSON.parse(last) as { args: string[] }).args).toEqual(['-R']);

    // A pager that can't be run doesn't lose the result.
    const missing = plain(await runPty(['router1'], steps, { home: f.home, rows: 10, env: { PAGER: 'no-such-pager-here' } }));
    expect(missing).toContain('<name>eth39</name>');
  });

  it('AC2: quitting the pager returns to the prompt with the session unchanged', async () => {
    const pager = recordingPager(f.home);
    const steps = [{ wait: PROMPT, send: `${RPC.big}\r` }, { wait: /\[paged \d+ lines\][\s\S]*nnc router1> $/, send: 'status\r' }, { wait: PROMPT, send: 'exit\r' }];
    const out = plain(await runPty(['router1'], steps, { home: f.home, rows: 10, env: { PAGER: pager.command } }));
    expect(out).toMatch(/session-id\s+1/);
    expect(out).toMatch(/disconnected from router1/);
  });

  it('AC3: --no-page shows the result without the pager', async () => {
    const pager = recordingPager(f.home);
    const steps = [{ wait: PROMPT, send: `${RPC.big} --no-page\r` }, { wait: PROMPT, send: 'exit\r' }];
    const out = plain(await runPty(['router1'], steps, { home: f.home, rows: 10, env: { PAGER: pager.command } }));
    expect(out).toContain('<name>eth39</name>');
    expect(pager.saw()).toBe('');
  });

  it('AC4: output --no-page turns paging off for the session, and output --page back on', async () => {
    const pager = recordingPager(f.home);
    const steps = [
      { wait: PROMPT, send: 'output --no-page\r' },
      { wait: PROMPT, send: `${RPC.big}\r` },
      { wait: PROMPT, send: 'output --page\r' },
      { wait: PROMPT, send: `${RPC.big}\r` },
      { wait: PROMPT, send: 'exit\r' },
    ];
    const out = plain(await runPty(['router1'], steps, { home: f.home, rows: 10, env: { PAGER: pager.command } }));
    expect(out).toContain('<name>eth39</name>');
    expect(pager.saw().trim().split('\n')).toHaveLength(1);
  });

  it("AC5: when output isn't a terminal (redirected or in a script) there is no paging", async () => {
    const pager = recordingPager(f.home);
    const r = await runNnc(['router1', '-c', RPC.big], { home: f.home, env: { PAGER: pager.command } });
    expect(r.stdout).toContain('<name>eth39</name>');
    const prompt = await runNnc(['router1', '-i'], { home: f.home, stdin: `${RPC.big}\n`, env: { PAGER: pager.command } });
    expect(prompt.stdout).toContain('<name>eth39</name>');
    expect(pager.saw()).toBe('');
  });
});
