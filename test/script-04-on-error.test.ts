/**
 * SCRIPT-04: Choose whether a script stops at its first failure.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Fixture } from './support/fixture.js';
import { runNnc } from './support/nnc.js';
import { RPC, scriptFixture, sentNames } from './support/script.js';

describe('SCRIPT-04 set on-error', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await scriptFixture();
  });
  afterAll(() => f.close());

  const closed = (): boolean => f.server.last()!.requests.at(-1)!.elements[0]!.name === 'close-session';

  it('AC1: by default a script or -c sequence stops at the first failure, disconnects and exits with its code', async () => {
    const c = await runNnc(['router1', '-c', RPC.ok, '-c', RPC.fail, '-c', 'get-config running'], { home: f.home });
    expect(c.code).toBe(1);
    expect(sentNames(f)).toEqual(['ping', 'fail-please']);
    expect(closed()).toBe(true);

    const script = f.home.file('stop.nnc', `${RPC.ok}\nbogus\nget-config running\n`);
    const s = await runNnc(['router1', '--script', script], { home: f.home });
    expect(s.code).toBe(2);
    expect(sentNames(f)).toEqual(['ping']);
    expect(closed()).toBe(true);
  });

  it('AC2: set on-error continue runs the rest after a failure; the exit code is that of the first failure', async () => {
    const script = f.home.file('continue.nnc', `set on-error continue\nbogus\n${RPC.fail}\nget-config running\n`);
    const r = await runNnc(['router1', '--script', script], { home: f.home });
    expect(r.code).toBe(2);
    expect(sentNames(f)).toEqual(['fail-please', 'get-config']);
    expect(r.stdout).toContain('<hostname>router1</hostname>');
    const c = await runNnc(['router1', '-c', 'set on-error continue', '-c', RPC.fail, '-c', 'bogus', '-c', RPC.ok], { home: f.home });
    expect(c.code).toBe(1);
    expect(sentNames(f)).toEqual(['fail-please', 'ping']);
  });

  it('AC3: set on-error stop restores the default', async () => {
    const script = f.home.file('restore.nnc', `set on-error continue\n${RPC.fail}\nset on-error stop\n${RPC.fail}\nget-config running\n`);
    const r = await runNnc(['router1', '--script', script], { home: f.home });
    expect(r.code).toBe(1);
    expect(sentNames(f)).toEqual(['fail-please', 'fail-please']);
    const shown = await runNnc(['-c', 'set on-error', '-c', 'set on-error continue', '-c', 'set'], { home: f.home });
    expect(shown.stdout).toBe('on-error stop\non-error continue\n');
    const bad = await runNnc(['-c', 'set on-error sometimes'], { home: f.home });
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('set on-error: use continue or stop');
  });

  it('AC4: a read-only refusal counts as a failure', async () => {
    const r = await runNnc(['ro', '-c', 'rpc <commit/>', '-c', 'get-config running'], { home: f.home });
    expect(r.code).toBe(4);
    expect(sentNames(f)).toEqual([]);
  });

  it('AC5: at the prompt a failed command never ends the session', async () => {
    const r = await runNnc(['router1', '-i'], { home: f.home, stdin: `${RPC.fail}\nbogus\nset on-error stop\n${RPC.fail}\nget-config running\nstatus\n` });
    expect(r.code).toBe(0);
    expect(sentNames(f)).toEqual(['fail-please', 'fail-please', 'get-config']);
    expect(r.stdout).toContain('nnc router1> ');
  });
});
