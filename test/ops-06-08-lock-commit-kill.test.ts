/**
 * OPS-06: Lock and unlock a datastore.
 * OPS-07: Validate, commit, confirm and discard candidate changes.
 * OPS-08: Kill another NETCONF session.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NETCONF_NS, serializeXml, x } from '@node-net/netconf';
import type { RpcHandler } from '@node-net/netconf/testing';
import { BASE10, BASE11, FULL, LAB_MODULE, VALIDATE11 } from './support/caps.js';
import { fixture, type Fixture } from './support/fixture.js';
import { runNnc } from './support/nnc.js';

const NC = NETCONF_NS;

/** Locks on running are held by session 7. */
const handler: RpcHandler = (_rpc, ctx) => {
  const target = ctx.operation?.elements[0]?.elements[0]?.name;
  if (ctx.operation?.name === 'lock' && target === 'running') {
    return {
      errors: [{ type: 'protocol', tag: 'lock-denied', message: 'Lock failed, lock is already held', info: [x('session-id', { xmlns: NC }, '7')] }],
    };
  }
  return 'ok';
};

describe('OPS-06 locks, OPS-07 candidate workflow, OPS-08 kill-session', () => {
  let f: Fixture;
  let noCandidate: Fixture;
  beforeAll(async () => {
    f = await fixture({ fake: { capabilities: FULL, handler, sessionId: 12 } });
    f.home.targets({ router1: f.target(), ro: f.target({ readOnly: true }) });
    noCandidate = await fixture({ fake: { capabilities: [BASE10, BASE11, VALIDATE11, LAB_MODULE] } });
  });
  afterAll(async () => {
    await f.close();
    await noCandidate.close();
  });

  const sentXml = (fx: Fixture, i = 0): string => serializeXml(fx.sent()[i]!);

  it('OPS-06 AC1/AC2: lock candidate and unlock candidate print ok', async () => {
    const r = await runNnc(['router1', '-c', 'lock candidate', '-c', 'unlock candidate'], { home: f.home });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('ok\nok\n');
    expect(sentXml(f, 0)).toBe(`<lock xmlns="${NC}"><target><candidate/></target></lock>`);
    expect(sentXml(f, 1)).toBe(`<unlock xmlns="${NC}"><target><candidate/></target></unlock>`);
  });

  it('OPS-06 AC3: a lock held by another session shows lock-denied and the holder\'s session-id', async () => {
    const r = await runNnc(['router1', '-c', 'lock running'], { home: f.home });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('rpc-error: lock-denied\n  type      protocol\n  severity  error\n  message   Lock failed, lock is already held\n  info      session-id 7\n');
  });

  it('OPS-06 AC4/AC5: status lists the locks held, and disconnect lists the locks released', async () => {
    const r = await runNnc(['router1', '-c', 'lock candidate', '-c', 'lock startup', '-c', 'status', '-c', 'disconnect'], { home: f.home });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^locks\s+candidate, startup$/m);
    expect(r.stderr).toContain('disconnected from router1 (locks on candidate, startup released as the session closed)');
    const after = await runNnc(['router1', '-c', 'lock candidate', '-c', 'unlock candidate', '-c', 'status'], { home: f.home });
    expect(after.stdout).toMatch(/^locks\s+\(none\)$/m);
  });

  it('OPS-06 AC6 / OPS-07 AC8 / OPS-08 AC4: read-only targets refuse lock, unlock, commit, cancel-commit, discard-changes and kill-session, and allow validate', async () => {
    for (const line of ['lock candidate', 'unlock candidate', 'commit', 'cancel-commit', 'discard-changes', 'kill-session 42']) {
      const r = await runNnc(['ro', '-c', line], { home: f.home });
      expect(r.code, line).toBe(4);
      expect(f.rpcsSent(), line).toBe(0);
    }
    const v = await runNnc(['ro', '-c', 'validate candidate'], { home: f.home });
    expect(v.code).toBe(0);
  });

  it('OPS-07 AC1: validate candidate sends a validate and prints ok; it fails before sending without :validate', async () => {
    const r = await runNnc(['router1', '-c', 'validate candidate'], { home: f.home });
    expect(r.stdout).toBe('ok\n');
    expect(sentXml(f)).toBe(`<validate xmlns="${NC}"><source><candidate/></source></validate>`);
    const bare = await fixture({ fake: { capabilities: FULL.filter((c) => !c.includes(':validate:')) } });
    try {
      const no = await runNnc(['router1', '-c', 'validate candidate'], { home: bare.home });
      expect(no.code).toBe(2);
      expect(no.stderr).toContain(':validate');
      expect(bare.rpcsSent()).toBe(0);
    } finally {
      await bare.close();
    }
  });

  it('OPS-07 AC2: commit commits the candidate and prints ok', async () => {
    const r = await runNnc(['router1', '-c', 'commit'], { home: f.home });
    expect(r.stdout).toBe('ok\n');
    expect(sentXml(f)).toBe(`<commit xmlns="${NC}"/>`);
  });

  it('OPS-07 AC3: commit --confirmed, --confirm-timeout and --persist are sent', async () => {
    const r = await runNnc(['router1', '-c', 'commit --confirmed --confirm-timeout 120 --persist abc'], { home: f.home });
    expect(r.code).toBe(0);
    expect(sentXml(f)).toBe(`<commit xmlns="${NC}"><confirmed/><confirm-timeout>120</confirm-timeout><persist>abc</persist></commit>`);
  });

  it('OPS-07 AC4: after a confirmed commit, status shows it is pending and when it rolls back', async () => {
    const r = await runNnc(['router1', '-c', 'commit --confirmed --confirm-timeout 120', '-c', 'status', '-c', 'commit', '-c', 'status'], { home: f.home });
    const [first, second] = r.stdout.split(/^target\s/m).slice(1);
    expect(first).toMatch(/^confirmed commit\s+pending: rolls back at \d{4}-\d\d-\d\dT[\d:.]+Z \(in (1m 5\ds|2m 0s)\) unless confirmed$/m);
    expect(second).not.toContain('confirmed commit');
  });

  it('OPS-07 AC5: cancel-commit cancels; --persist-id names one started with a persist id', async () => {
    const r = await runNnc(['router1', '-c', 'cancel-commit', '-c', 'cancel-commit --persist-id abc'], { home: f.home });
    expect(r.code).toBe(0);
    expect(sentXml(f, 0)).toBe(`<cancel-commit xmlns="${NC}"/>`);
    expect(sentXml(f, 1)).toBe(`<cancel-commit xmlns="${NC}"><persist-id>abc</persist-id></cancel-commit>`);
  });

  it('OPS-07 AC6: discard-changes reverts the candidate and prints ok', async () => {
    const r = await runNnc(['router1', '-c', 'discard-changes'], { home: f.home });
    expect(r.stdout).toBe('ok\n');
    expect(sentXml(f)).toBe(`<discard-changes xmlns="${NC}"/>`);
  });

  it('OPS-07 AC7: without candidate, the candidate commands fail before sending, naming the missing capability', async () => {
    for (const [line, cap] of [
      ['validate candidate', ':candidate'],
      ['commit', ':candidate'],
      ['commit --confirmed', ':candidate'],
      ['cancel-commit', ':confirmed-commit:1.1'],
      ['discard-changes', ':candidate'],
    ] as const) {
      const r = await runNnc(['router1', '-c', line], { home: noCandidate.home });
      expect(r.code, line).toBe(2);
      expect(r.stderr, line).toContain(cap);
      expect(noCandidate.rpcsSent(), line).toBe(0);
    }
  });

  it('OPS-08 AC1: kill-session 42 sends a kill-session and prints ok', async () => {
    const r = await runNnc(['router1', '-c', 'kill-session 42'], { home: f.home });
    expect(r.stdout).toBe('ok\n');
    expect(sentXml(f)).toBe(`<kill-session xmlns="${NC}"><session-id>42</session-id></kill-session>`);
  });

  it("OPS-08 AC2: kill-session with this session's own id fails, saying to use disconnect", async () => {
    const r = await runNnc(['router1', '-c', 'kill-session 12'], { home: f.home });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('kill-session: 12 is this session; use disconnect to close it');
    expect(f.rpcsSent()).toBe(0);
  });

  it('OPS-08 AC3: a session-id that is not a positive whole number fails with a usage message', async () => {
    for (const id of ['abc', '-1', '1.5', '0']) {
      const r = await runNnc(['router1', '-c', `kill-session ${id}`], { home: f.home });
      expect(r.code, id).toBe(2);
      expect(r.stderr, id).toMatch(/must be (a number|an integer from 1 to 4294967295)/);
      expect(f.rpcsSent(), id).toBe(0);
    }
  });
});
