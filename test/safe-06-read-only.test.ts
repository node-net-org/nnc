/**
 * SAFE-06: Refuse state-changing commands on read-only targets.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRegistry } from '../src/commands/index.js';
import { fixture, type Fixture } from './support/fixture.js';
import { runNnc } from './support/nnc.js';
import { sentEntries } from './support/trace.js';

const CAPS = [
  'urn:ietf:params:netconf:base:1.0',
  'urn:ietf:params:netconf:base:1.1',
  'urn:ietf:params:netconf:capability:candidate:1.0',
  'urn:ietf:params:netconf:capability:validate:1.1',
  'urn:ietf:params:netconf:capability:confirmed-commit:1.1',
  'urn:ietf:params:netconf:capability:startup:1.0',
  'urn:example:lab?module=lab&revision=2024-01-01',
];

/** Each state-changing base operation, as an rpc body. */
const WRITES: Record<string, string> = {
  'edit-config': '<edit-config><target><running/></target><config/></edit-config>',
  'copy-config': '<copy-config><target><startup/></target><source><running/></source></copy-config>',
  'delete-config': '<delete-config><target><startup/></target></delete-config>',
  lock: '<lock><target><running/></target></lock>',
  unlock: '<unlock><target><running/></target></unlock>',
  commit: '<commit/>',
  'cancel-commit': '<cancel-commit/>',
  'discard-changes': '<discard-changes/>',
  'kill-session': '<kill-session><session-id>4</session-id></kill-session>',
};

describe('SAFE-06 read-only guard', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await fixture({ fake: { capabilities: CAPS } });
    f.home.targets({ router1: f.target({ readOnly: true }), lab1: f.target() });
  });
  afterAll(() => f.close());

  it('AC1: a readOnly target, or any session opened with --read-only, is read-only for the session', async () => {
    const byTarget = await runNnc(['router1', '-c', `rpc ${WRITES['lock']!}`], { home: f.home });
    expect(byTarget.code).toBe(4);
    const byFlag = await runNnc(['lab1', '--read-only', '-c', `rpc ${WRITES['lock']!}`], { home: f.home });
    expect(byFlag.code).toBe(4);
    const inline = await runNnc(['-c', 'connect lab1 --read-only', '-c', `rpc ${WRITES['lock']!}`], { home: f.home });
    expect(inline.code).toBe(4);
    expect(f.rpcsSent()).toBe(0);

    // The same command on a session that isn't read-only is sent.
    const writable = await runNnc(['lab1', '-c', `rpc ${WRITES['lock']!}`], { home: f.home });
    expect(writable.code).toBe(0);
    expect(writable.stdout).toBe('ok\n');
    expect(f.rpcsSent()).toBe(1);
  });

  it('AC2: edit-config, copy-config, delete-config, lock, unlock, commit, cancel-commit, discard-changes and kill-session are refused', async () => {
    for (const [name, body] of Object.entries(WRITES)) {
      const r = await runNnc(['router1', '-c', `rpc ${body}`], { home: f.home });
      expect(r.code, name).toBe(4);
      expect(r.stderr, name).toContain(`rpc <${name}>: refused: router1 is read-only and ${name} changes device state; nothing was sent`);
      expect(f.rpcsSent(), name).toBe(0);
    }
  });

  it('AC2: a quoted body, or a comment before the operation, does not get past the guard', async () => {
    for (const line of [`rpc '${WRITES['lock']!}'`, `rpc <!-- harmless --> ${WRITES['lock']!}`]) {
      const r = await runNnc(['router1', '-c', line], { home: f.home });
      expect(r.code === 4 || r.code === 2, line).toBe(true);
      expect(f.rpcsSent(), line).toBe(0);
    }
  });

  it('AC2: set, remove, begin, apply, confirm and revert are refused', async () => {
    for (const line of ['set /lab:system/name router1-new', 'set @systemName x', 'remove /lab:system/location', 'begin', 'apply', 'confirm', 'revert']) {
      const r = await runNnc(['router1', '-c', line], { home: f.home });
      const cmd = line.split(' ')[0]!;
      expect(r.code, line).toBe(4);
      expect(r.stderr, line).toContain(`${cmd}: refused: router1 is read-only and ${cmd} changes device state; nothing was sent`);
      expect(f.rpcsSent(), line).toBe(0);
    }
  });

  it('AC3: get, get-config, validate, hello and capabilities are allowed', async () => {
    for (const body of ['<get/>', '<get-config><source><running/></source></get-config>', '<validate><source><running/></source></validate>']) {
      const r = await runNnc(['router1', '-c', `rpc ${body}`], { home: f.home });
      expect(r.code, body).toBe(0);
      expect(f.rpcsSent(), body).toBe(1);
    }
    const r = await runNnc(['router1', '-c', 'hello', '-c', 'capabilities'], { home: f.home });
    expect(r.code).toBe(0);
  });

  it('AC3: notifications is allowed', async () => {
    const r = await runNnc(['router1', '-c', 'notifications'], { home: f.home });
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain('refused');
  });

  it('AC3: read, value and resolve are allowed', async () => {
    for (const line of ['read /lab:system', 'value /lab:system/name', 'resolve /lab:system/name']) {
      const r = await runNnc(['router1', '-c', line], { home: f.home });
      expect(r.code, line).toBe(0);
      expect(r.stderr, line).not.toContain('refused');
    }
  });

  it('AC4: a refusal names the command, says the target is read-only, and nothing is sent', async () => {
    const r = await runNnc(['router1', '-c', `rpc ${WRITES['edit-config']!}`], { home: f.home });
    expect(r.code).toBe(4);
    expect(r.stdout).toBe('');
    expect(r.stderr.split('\n').at(-2)).toMatch(/^rpc <edit-config>: refused: router1 is read-only .*; nothing was sent$/);
    expect(f.rpcsSent()).toBe(0);
  });

  it('AC4: a byte trace shows that nothing was sent for a refused command', async () => {
    const r = await runNnc(['router1', '-c', 'trace bytes', '-c', `rpc ${WRITES['edit-config']!}`], { home: f.home });
    expect(r.code).toBe(4);
    expect(sentEntries(r.stderr)).toEqual([]);
    // The trace is really on: an allowed command shows its outgoing bytes.
    const control = await runNnc(['router1', '-c', 'trace bytes', '-c', 'rpc <get/>'], { home: f.home });
    expect(control.code).toBe(0);
    expect(sentEntries(control.stderr).length).toBeGreaterThan(0);
  });

  it('AC5: no command turns read-only off during a session', async () => {
    const registry = createRegistry();
    for (const name of registry.names()) {
      const cmd = registry.get(name)!;
      expect(Object.keys(cmd.options).filter((o) => /read-?write|writable|no-read-only/i.test(o)), name).toEqual([]);
    }
    expect(registry.names().filter((n) => /writ|read-?(only|write)/i.test(n))).toEqual([]);
    const r = await runNnc(['-i'], { home: f.home, stdin: `connect router1\nconnect router1 --read-only\nrpc ${WRITES['commit']!}\nstatus\n` });
    expect(r.stderr).toContain('rpc <commit>: refused');
    expect(r.stdout).toMatch(/read-only\s+yes/);
    expect(f.rpcsSent()).toBe(0);
  });

  it('AC6: help marks commands that change state, and status and the connect line show read-only', async () => {
    const r = await runNnc(['-c', 'connect router1', '-c', 'help', '-c', 'status'], { home: f.home });
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/ · read-only\n/);
    expect(r.stdout).toContain('* changes state; refused on read-only targets.');
    expect(r.stdout).toMatch(/^\s+edit-config \*\s/m);
    expect(r.stdout).toMatch(/^\s+get-config\s{2,}/m);
    expect(r.stdout).toMatch(/^\s+set \*\s/m);
    expect(r.stdout).toContain('router1 is read-only: commands marked * are refused.');
    expect(r.stdout).toMatch(/^read-only\s+yes$/m);
  });
});
