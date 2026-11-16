/**
 * SESS-02: Disconnect and close the session cleanly.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { fixture, type Fixture } from './support/fixture.js';
import { collect, runNnc, startNnc, waitFor } from './support/nnc.js';

describe('SESS-02 disconnect', () => {
  let f: Fixture;
  afterEach(() => f.close());

  const closeSessions = (fx: Fixture): number =>
    (fx.server.last()?.requests ?? []).filter((r) => r.elements[0]?.name === 'close-session').length;

  it('AC1: sends <close-session>, closes the connection and prints "disconnected from router1"', async () => {
    f = await fixture();
    const r = await runNnc(['-c', 'connect router1', '-c', 'disconnect'], { home: f.home });
    expect(r.code).toBe(0);
    expect(r.stderr.trim().split('\n').at(-1)).toBe('disconnected from router1');
    expect(closeSessions(f)).toBe(1);
    expect(f.server.clients()).toHaveLength(0);
  });

  it('AC2: without a close-session reply in time, the connection is closed anyway and the message says so', async () => {
    f = await fixture({ dropCloseSession: true }, { timeouts: { close: 300 } });
    const r = await runNnc(['-c', 'connect router1', '-c', 'disconnect'], { home: f.home });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('disconnected from router1 (no reply to <close-session> in time; the connection was closed anyway)');
  });

  it('AC3: after disconnecting, the prompt returns to nnc>', async () => {
    f = await fixture();
    const r = await runNnc(['-i'], { home: f.home, stdin: 'connect router1\ndisconnect\n' });
    expect(r.stdout).toContain('nnc router1> disconnected from router1\nnnc> ');
  });

  it('AC4: disconnect with no session prints "not connected" and changes nothing', async () => {
    f = await fixture();
    const r = await runNnc(['-c', 'disconnect'], { home: f.home });
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('not connected\n');
    expect(f.server.authAttempts).toHaveLength(0);
  });

  it('AC5: exit and Ctrl-D (end of input) disconnect the open session first', async () => {
    f = await fixture();
    const viaExit = await runNnc(['-i'], { home: f.home, stdin: 'connect router1\nexit\n' });
    expect(viaExit.code).toBe(0);
    expect(viaExit.stdout).toContain('disconnected from router1');
    expect(closeSessions(f)).toBe(1);

    const viaEof = await runNnc(['-i'], { home: f.home, stdin: 'connect router1\n' });
    expect(viaEof.code).toBe(0);
    expect(viaEof.stdout).toContain('disconnected from router1');
    expect(closeSessions(f)).toBe(1);
  });

  it('AC6: when the server closes the session, a message is printed and the prompt returns to nnc>', async () => {
    f = await fixture();
    const child = startNnc(['-i'], { home: f.home });
    const done = collect(child, undefined);
    child.stdin.write('connect router1\n');
    await waitFor(child, 'stdout', /nnc router1> /);
    f.server.last()!.destroy();
    await waitFor(child, 'stderr', /server closed the session to router1/);
    child.stdin.end('status\n');
    const r = await done;
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/nnc> not connected\n/);
  });
});
