/**
 * SCRIPT-02: Run a script of commands from a file or standard input.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Fixture } from './support/fixture.js';
import { runNnc } from './support/nnc.js';
import { LAB, RPC, scriptFixture, sentNames } from './support/script.js';

describe('SCRIPT-02 --script', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await scriptFixture();
  });
  afterAll(() => f.close());

  it('AC1: nnc router1 --script checks.nnc connects and runs each command in the file in order', async () => {
    const script = f.home.file('checks.nnc', `${RPC.ok}\nget-config running\nstatus\n`);
    const r = await runNnc(['router1', '--script', script], { home: f.home });
    expect(r.code).toBe(0);
    expect(sentNames(f)).toEqual(['ping', 'get-config']);
    expect(r.stdout).toMatch(/^ok\n[\s\S]*<hostname>router1<\/hostname>[\s\S]*session-id/);
  });

  it('AC2: nnc --script session.nnc runs without connecting first; the script connects and disconnects', async () => {
    const script = f.home.file('session.nnc', 'status\nconnect router1\nget-config running\ndisconnect\nstatus\n');
    const r = await runNnc(['--script', script], { home: f.home });
    expect(r.code).toBe(0);
    expect(sentNames(f)).toEqual(['get-config']);
    expect(r.stdout).toMatch(/^not connected\n[\s\S]*<hostname>router1<\/hostname>[\s\S]*not connected\n$/);
    expect(r.stderr).toMatch(/^connected to router1 [^\n]*\ndisconnected from router1\n$/);
  });

  it('AC3: --script - reads the script from standard input', async () => {
    const r = await runNnc(['router1', '--script', '-'], { home: f.home, stdin: `${RPC.ok}\nget-config running\n` });
    expect(r.code).toBe(0);
    expect(sentNames(f)).toEqual(['ping', 'get-config']);
    expect(r.stdout).not.toContain('nnc>');
    const short = await runNnc(['router1', '-s', '-'], { home: f.home, stdin: `${RPC.ok}\n` });
    expect(short.code).toBe(0);
  });

  it('AC4: scripts use the prompt language: comments, blank lines and inline XML (multi-line XML is LANG-02)', async () => {
    const script = f.home.file(
      'lang.nnc',
      ['# check the lab', '', '   ', 'get-config running   # the whole configuration', `rpc <ping xmlns="${LAB}"># not a comment</ping>`].join('\n'),
    );
    const r = await runNnc(['router1', '--script', script], { home: f.home });
    expect(r.stderr).toMatch(/^connected to router1 [^\n]*\n$/);
    expect(r.code).toBe(0);
    expect(sentNames(f)).toEqual(['get-config', 'ping']);
    expect(f.sent()[1]!.textContent()).toBe('# not a comment');
  });

  it('AC5: a missing script file fails with a message naming it, before any connection is made', async () => {
    const before = f.server.authAttempts.length;
    const r = await runNnc(['router1', '--script', 'no/such/checks.nnc'], { home: f.home });
    expect(r.code).toBe(2);
    expect(r.stderr).toBe('nnc: cannot read script no/such/checks.nnc: ENOENT\n');
    expect(f.server.authAttempts.length).toBe(before);
  });

  it('AC6: error messages from a script include the script name and line number of the failing command', async () => {
    const script = f.home.file('broken.nnc', `get-config running\n\n${RPC.fail}\n`);
    const r = await runNnc(['router1', '--script', script], { home: f.home });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`${script}:3: rpc-error: operation-failed\n  type      application\n  severity  error\n  message   nope\n`);
    const piped = await runNnc(['router1'], { home: f.home, stdin: 'status\nbogus\n' });
    expect(piped.code).toBe(2);
    expect(piped.stderr).toContain('<stdin>:2: unknown command: bogus');
  });
});
