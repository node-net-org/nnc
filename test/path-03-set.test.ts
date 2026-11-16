/**
 * PATH-03: Set a value by path through the device's workflow.
 */
import { serializeXml } from '@node-net/netconf';
import type { RpcHandler } from '@node-net/netconf/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runNnc } from './support/nnc.js';
import { IF_NS, RUNNING_CAPS, handler, pathFixture, type PathFixture } from './support/path.js';

const CANDIDATE_STEPS = [
  'lock running: ok',
  'lock candidate: ok',
  'discard-changes candidate: ok',
  'edit-config candidate: ok',
  'validate candidate: ok',
  'commit candidate: ok',
  'unlock candidate: ok',
  'unlock running: ok',
];

/** Fail the named operation with an rpc-error. */
const failing = (name: string): RpcHandler => (rpc, ctx) =>
  ctx.operation?.name === name ? { errors: [{ type: 'application', tag: 'operation-failed', message: `${name} refused` }] } : handler(rpc, ctx);

const stepLines = (stderr: string): string[] => stderr.split('\n').filter((l) => /^[a-z-]+ (running|candidate): ok$/.test(l));

describe('PATH-03 set', () => {
  let f: PathFixture;
  beforeAll(async () => {
    f = await pathFixture();
  });
  afterAll(() => f.close());

  it("AC1: set follows the profile's workflow: candidate devices, and running-only devices", async () => {
    const r = await runNnc(['lab1', '-c', 'set @systemName router1-new'], { home: f.home });
    expect(r.code).toBe(0);
    expect(f.sent().map((op) => op.name)).toEqual(['lock', 'lock', 'discard-changes', 'edit-config', 'validate', 'commit', 'unlock', 'unlock']);
    expect(serializeXml(f.sent()[3]!.child('config')!.elements[0]!)).toBe('<system xmlns="urn:example:lab"><name>router1-new</name></system>');

    const running = await pathFixture({ caps: RUNNING_CAPS });
    try {
      const rr = await runNnc(['lab1', '-c', 'set @systemName router1-new'], { home: running.home });
      expect(rr.code).toBe(0);
      expect(running.sent().map((op) => op.name)).toEqual(['lock', 'edit-config', 'unlock']);
      expect(stepLines(rr.stderr)).toEqual(['lock running: ok', 'edit-config running: ok', 'unlock running: ok']);
    } finally {
      await running.close();
    }
  });

  it('AC2: each step is printed as it completes, and the command ends with ok', async () => {
    const r = await runNnc(['lab1', '-c', 'set @systemName router1-new'], { home: f.home });
    expect(stepLines(r.stderr)).toEqual(CANDIDATE_STEPS);
    expect(r.stdout).toBe('ok\n');
  });

  it('AC3: a failed step discards the changes, releases the locks, and shows the step and its rpc-error', async () => {
    const bad = await pathFixture({ handler: failing('commit') });
    try {
      const r = await runNnc(['lab1', '-c', 'set @systemName router1-new'], { home: bad.home });
      expect(r.code).toBe(1);
      expect(r.stdout).toBe('');
      expect(bad.sent().map((op) => op.name)).toEqual(['lock', 'lock', 'discard-changes', 'edit-config', 'validate', 'commit', 'discard-changes', 'unlock', 'unlock']);
      expect(r.stderr).toContain('set: failed at commit; the changes were discarded and the locks released\nrpc-error: operation-failed');
      expect(r.stderr).toMatch(/^ {2}message +commit refused$/m);
    } finally {
      await bad.close();
    }
    // On a running-only device, a failed edit names edit-config and still unlocks.
    const running = await pathFixture({ caps: RUNNING_CAPS, handler: failing('edit-config') });
    try {
      const r = await runNnc(['lab1', '-c', 'set @systemName router1-new'], { home: running.home });
      expect(r.code).toBe(1);
      expect(running.sent().map((op) => op.name)).toEqual(['lock', 'edit-config', 'unlock']);
      expect(r.stderr).toContain('set: failed at edit-config; the lock was released\nrpc-error: operation-failed');
    } finally {
      await running.close();
    }
  });

  it("AC4: list keys in the path create the entry if it doesn't exist", async () => {
    const r = await runNnc(['lab1', '-c', 'set /ietf-interfaces:interfaces/interface[name="eth7"]/description "new port"'], { home: f.home });
    expect(r.code).toBe(0);
    const edit = f.sent().find((op) => op.name === 'edit-config')!;
    expect(serializeXml(edit.child('config')!.elements[0]!)).toBe(
      `<interfaces xmlns="${IF_NS}"><interface><name>eth7</name><description>new port</description></interface></interfaces>`,
    );
  });

  it('AC5: on a read-only target set is refused before sending', async () => {
    const r = await runNnc(['router1', '-c', 'set @systemName router1-new'], { home: f.home });
    expect(r.code).toBe(4);
    expect(r.stderr).toContain('set: refused: router1 is read-only and set changes device state; nothing was sent');
    expect(f.rpcsSent()).toBe(0);
    // set on-error is still the setting, on any target.
    const setting = await runNnc(['router1', '-c', 'set on-error continue', '-c', 'set'], { home: f.home });
    expect(setting.code).toBe(0);
    expect(setting.stdout).toBe('on-error continue\n');
  });
});
