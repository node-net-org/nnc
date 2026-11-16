/**
 * PATH-10: Apply a transaction through the device's workflow.
 */
import { serializeXml } from '@node-net/netconf';
import type { RpcHandler } from '@node-net/netconf/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runNnc } from './support/nnc.js';
import { IF_NS, handler, pathFixture, type PathFixture } from './support/path.js';

const ETH9 = '/ietf-interfaces:interfaces/interface[name="eth9"]';
const steps = (stderr: string): string[] => stderr.split('\n').filter((l) => /^[a-z-]+ (running|candidate): ok$/.test(l));

describe('PATH-10 apply', () => {
  let f: PathFixture;
  beforeAll(async () => {
    f = await pathFixture();
  });
  afterAll(() => f.close());

  it("AC1: apply sends every queued change in one edit-config through the profile's workflow, printing each step", async () => {
    const r = await runNnc(['lab1', '-c', 'begin', '-c', 'set @systemName r2', '-c', `remove ${ETH9}`, '-c', 'apply'], { home: f.home });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('ok\n');
    expect(f.sent().map((op) => op.name)).toEqual(['lock', 'lock', 'discard-changes', 'edit-config', 'validate', 'commit', 'unlock', 'unlock']);
    expect(steps(r.stderr)).toHaveLength(8);
  });

  it('AC2: changes to the same list are merged into one tree; removes carry the remove operation', async () => {
    await runNnc(
      ['lab1', '-c', 'begin', '-c', 'set /ietf-interfaces:interfaces/interface[name="eth7"]/description up', '-c', `remove ${ETH9}`, '-c', 'apply'],
      { home: f.home },
    );
    const config = f.sent().find((op) => op.name === 'edit-config')!.child('config')!;
    expect(config.elements).toHaveLength(1);
    expect(serializeXml(config.elements[0]!)).toBe(
      `<interfaces xmlns="${IF_NS}"><interface><name>eth7</name><description>up</description></interface>` +
        `<interface xmlns:nc="urn:ietf:params:xml:ns:netconf:base:1.0" nc:operation="remove"><name>eth9</name></interface></interfaces>`,
    );
  });

  it('AC3: a failed step discards and unlocks, shows the step and rpc-error, and keeps the transaction open', async () => {
    let fail = true;
    const flaky: RpcHandler = (rpc, ctx) =>
      fail && ctx.operation?.name === 'commit' ? { errors: [{ type: 'application', tag: 'operation-failed', message: 'commit refused' }] } : handler(rpc, ctx);
    const bad = await pathFixture({ handler: flaky });
    try {
      const r = await runNnc(['lab1', '-i'], { home: bad.home, stdin: 'begin\nset @systemName r2\napply\nchanges\n' });
      expect(r.stderr).toContain('apply: failed at commit; the changes were discarded and the locks released\nrpc-error: operation-failed');
      expect(bad.sent().map((op) => op.name)).toEqual(['lock', 'lock', 'discard-changes', 'edit-config', 'validate', 'commit', 'discard-changes', 'unlock', 'unlock']);
      // Still open, with its change: the prompt still shows it, and changes lists it.
      expect(r.stdout).toContain('nnc lab1 [tx 1]> ');
      expect(r.stdout).toMatch(/ {2}1 {2}set {5}@systemName {2}"r2"\n/);
    } finally {
      fail = false;
      await bad.close();
    }
  });

  it('AC4: apply with nothing queued sends nothing and ends the transaction', async () => {
    const r = await runNnc(['lab1', '-i'], { home: f.home, stdin: 'begin\napply\nstatus\n' });
    expect(r.stdout).toContain('transaction closed: no changes were queued, so nothing was sent');
    expect(r.stdout).toMatch(/nnc lab1> disconnected from lab1\n$/);
    expect(f.rpcsSent()).toBe(0);
  });

  it('AC5: after a successful apply the transaction is closed and the marker goes', async () => {
    const r = await runNnc(['lab1', '-i'], { home: f.home, stdin: 'begin\nset @systemName r2\napply\nstatus\n' });
    expect(r.stdout).toContain('nnc lab1 [tx 1]> ');
    expect(r.stdout).toMatch(/nnc lab1> disconnected from lab1\n$/);
    expect(r.stdout).not.toMatch(/^transaction\s/m);
  });
});
