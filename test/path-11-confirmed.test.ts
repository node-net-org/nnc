/**
 * PATH-11: Apply with a confirmed commit, then confirm or revert.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runNnc, startNnc, waitFor } from './support/nnc.js';
import { CAPS, pathFixture, type PathFixture } from './support/path.js';

const CONFIRMING = [...CAPS, 'urn:ietf:params:netconf:capability:confirmed-commit:1.1'];
const TX = (...extra: string[]): string => ['begin', 'set @systemName r2', ...extra].join('\n') + '\n';

describe('PATH-11 confirmed commits', () => {
  let f: PathFixture;
  beforeAll(async () => {
    f = await pathFixture({ caps: CONFIRMING });
  });
  afterAll(() => f.close());

  it('AC1: apply --confirmed makes a confirmed commit, and fails before sending without candidate or confirmed-commit', async () => {
    const r = await runNnc(['lab1', '-i'], { home: f.home, stdin: TX('apply --confirmed --confirm-timeout 120 --persist p1', 'confirm') });
    const commit = f.sent().find((op) => op.name === 'commit')!;
    expect(commit.child('confirmed')).toBeDefined();
    expect(commit.child('confirm-timeout')?.text()).toBe('120');
    expect(commit.child('persist')?.text()).toBe('p1');
    expect(r.stdout).toContain('ok\n');

    const plain = await pathFixture();
    try {
      const no = await runNnc(['lab1', '-c', 'begin', '-c', 'set @systemName r2', '-c', 'apply --confirmed'], { home: plain.home });
      expect(no.stderr).toMatch(/:confirmed-commit/);
      expect(plain.rpcsSent()).toBe(0);
    } finally {
      await plain.close();
    }
    const usage = await runNnc(['lab1', '-c', 'begin', '-c', 'set @systemName r2', '-c', 'apply --confirm-timeout 60'], { home: f.home });
    expect(usage.stderr).toContain('apply: --confirm-timeout and --persist go with --confirmed');
  });

  it('AC2: while pending the prompt shows [confirm m:ss] and status shows when it rolls back', async () => {
    const r = await runNnc(['lab1', '-i'], { home: f.home, stdin: TX('apply --confirmed --confirm-timeout 120', 'status', 'confirm') });
    expect(r.stdout).toMatch(/nnc lab1 \[confirm (2:00|1:59)\]> /);
    expect(r.stdout).toMatch(/^confirmed commit\s+pending: rolls back at .* unless confirmed$/m);
  });

  it('AC3: confirm makes it permanent and revert rolls it back; both fail with nothing pending', async () => {
    const confirmed = await runNnc(['lab1', '-i'], { home: f.home, stdin: TX('apply --confirmed', 'confirm') });
    expect(f.sent().map((op) => op.name).slice(-2)).toEqual(['commit', 'unlock']);
    expect(confirmed.stdout).toMatch(/ok\n(.|\n)*ok\n/);
    await runNnc(['lab1', '-i'], { home: f.home, stdin: TX('apply --confirmed', 'revert') });
    expect(f.sent().map((op) => op.name)).toContain('cancel-commit');
    for (const cmd of ['confirm', 'revert']) {
      const none = await runNnc(['lab1', '-c', cmd], { home: f.home });
      expect(none.stderr, cmd).toContain(`${cmd}: no confirmed commit is pending (apply --confirmed makes one)`);
    }
    // The base commit settles it too: nothing is left pending, and no rollback message follows.
    const base = await runNnc(['lab1', '-i'], { home: f.home, stdin: TX('apply --confirmed --confirm-timeout 1', 'commit', 'status') });
    expect(base.stdout).not.toMatch(/^confirmed commit\s+pending: rolls back/m);
    expect(base.stderr).not.toContain('rolled the change back');
    // A plain apply while one is pending would confirm it, so it is refused.
    const again = await runNnc(['lab1', '-i'], { home: f.home, stdin: TX('apply --confirmed', 'begin', 'set @systemName r3', 'apply', 'revert') });
    expect(again.stderr).toContain('apply: a confirmed commit is pending; confirm or revert it first');
  });

  it('AC4: a confirm too close to the rollback time is refused', async () => {
    const r = await runNnc(['lab1', '-i'], { home: f.home, stdin: TX('apply --confirmed --confirm-timeout 1', 'confirm') });
    expect(r.stderr).toContain('confirm: refused: the confirmed commit is about to roll back, or already has; the change may already have been rolled back');
  });

  it('AC5: when the timeout passes without confirm, a message says the device rolled the change back', async () => {
    const child = startNnc(['lab1', '-i'], { home: f.home });
    child.stdin.write(TX('apply --confirmed --confirm-timeout 1'));
    await waitFor(child, 'stderr', /the confirmed commit was not confirmed in time: the device rolled the change back/, 8000);
    child.stdin.end('status\n');
    await new Promise((resolve) => child.on('close', resolve));
  });

  it('AC6: disconnecting while pending warns about the rollback and how to confirm a persisted one', async () => {
    const plainCommit = await runNnc(['lab1', '-i'], { home: f.home, stdin: TX('apply --confirmed', 'disconnect') });
    expect(plainCommit.stdout).toContain('the pending confirmed commit is rolled back by the device now that the session has closed');
    const persisted = await runNnc(['lab1', '-i'], { home: f.home, stdin: TX('apply --confirmed --persist p9', 'disconnect') });
    expect(persisted.stdout).toMatch(/the pending confirmed commit \(persist id p9\) rolls back at \S+ unless confirmed from another session with commit --persist-id p9/);
  });
});
