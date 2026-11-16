/**
 * SCRIPT-01: Run one-off commands from the shell with -c.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Fixture } from './support/fixture.js';
import { runNnc } from './support/nnc.js';
import { RPC, scriptFixture, sentNames } from './support/script.js';

const ESC = '\x1b[';

describe('SCRIPT-01 -c one-liners', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await scriptFixture();
  });
  afterAll(() => f.close());

  it("AC1: nnc router1 -c 'get-config running' connects, runs it, prints the result, disconnects and exits", async () => {
    const r = await runNnc(['router1', '-c', 'get-config running'], { home: f.home });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('<hostname>router1</hostname>');
    expect(sentNames(f)).toEqual(['get-config']);
    expect(f.server.last()!.requests.at(-1)!.elements[0]!.name).toBe('close-session');
    expect(f.server.clients()).toHaveLength(0);
  });

  it('AC2: -c may be repeated; the commands run in order in one session', async () => {
    const r = await runNnc(['router1', '-c', RPC.ok, '-c', 'get-config running', '-c', 'status'], { home: f.home });
    expect(r.code).toBe(0);
    // Both requests reached the same (the last) session.
    expect(sentNames(f)).toEqual(['ping', 'get-config']);
    expect(r.stderr.match(/^connected to /gm)).toHaveLength(1);
    expect(r.stdout.indexOf('ok\n')).toBeLessThan(r.stdout.indexOf('<hostname>'));
    expect(r.stdout.indexOf('<hostname>')).toBeLessThan(r.stdout.indexOf('session-id'));
  });

  it('AC3: --read-only, --framed and --raw after the target apply to the connection as for connect', async () => {
    const ro = await runNnc(['router1', '--read-only', '-c', 'rpc <commit/>', '-c', 'status'], { home: f.home });
    expect(ro.code).toBe(4);
    expect(ro.stderr).toContain('read-only');
    expect(sentNames(f)).toEqual([]);

    // The target's connect opens the session kind asked for, as `connect --framed` does.
    const framed = await runNnc(['router1', '--framed', '-c', 'status'], { home: f.home });
    expect(framed.code).toBe(0);
    expect(framed.stderr).toContain('opened a framed session to router1');
    expect(framed.stdout).toMatch(/^kind\s+framed$/m);
    const raw = await runNnc(['router1', '--raw', '-c', 'status'], { home: f.home });
    expect(raw.code).toBe(0);
    expect(raw.stderr).toContain('opened a raw session to router1');
    expect(raw.stdout).toMatch(/^kind\s+raw$/m);
    // A read-only target refuses them first, as connect does.
    const before = f.server.authAttempts.length;
    const roFramed = await runNnc(['ro', '--framed', '-c', 'status'], { home: f.home });
    expect(roFramed.code).toBe(4);
    expect(f.server.authAttempts.length).toBe(before);

    const noTarget = await runNnc(['--framed', '-c', 'status'], { home: f.home });
    expect(noTarget.code).toBe(2);
    expect(noTarget.stderr).toContain('--framed applies to a target');
  });

  it("AC4: nnc -c 'targets' runs without connecting", async () => {
    const before = f.server.authAttempts.length;
    const r = await runNnc(['-c', 'targets'], { home: f.home });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^router1 /m);
    expect(f.server.authAttempts.length).toBe(before);
  });

  it("AC5: no prompt or colour when output isn't a terminal (paging is LANG-07's)", async () => {
    const env = { NO_COLOR: undefined, FORCE_COLOR: undefined };
    const r = await runNnc(['router1', '-c', 'trace xml', '-c', 'get-config running'], { home: f.home, env });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('<get-config>');
    expect(r.stdout + r.stderr).not.toContain(ESC);
    expect(r.stdout + r.stderr).not.toContain('nnc>');
    // The check is real: forced colour turns it on.
    const forced = await runNnc(['router1', '-c', 'trace xml', '-c', 'get-config running'], { home: f.home, env: { ...env, FORCE_COLOR: '1' } });
    expect(forced.stderr).toContain(ESC);
    // FORCE_COLOR forces it everywhere, results included.
    expect(forced.stdout).toContain(ESC);
  });
});
