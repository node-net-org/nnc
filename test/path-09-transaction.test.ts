/**
 * PATH-09: Group several changes into one transaction.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runNnc } from './support/nnc.js';
import { pathFixture, type PathFixture } from './support/path.js';

const ETH7 = '/ietf-interfaces:interfaces/interface[name="eth7"]/description';
const ETH9 = '/ietf-interfaces:interfaces/interface[name="eth9"]';

describe('PATH-09 transactions', () => {
  let f: PathFixture;
  beforeAll(async () => {
    f = await pathFixture();
  });
  afterAll(() => f.close());

  it('AC1: after begin, set and remove queue their change, print queued (N changes), and send nothing', async () => {
    const r = await runNnc(['lab1', '-c', 'begin', '-c', 'set @systemName r2', '-c', `remove ${ETH9}`, '-c', `set ${ETH7} "new port"`, '-c', 'abandon'], { home: f.home });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('queued (1 change)\nqueued (2 changes)\nqueued (3 changes)\n');
    expect(f.rpcsSent()).toBe(0);
  });

  it("AC2: a path error, or a second change to the same node, fails at once and isn't queued", async () => {
    const r = await runNnc(['lab1', '-i'], { home: f.home, stdin: `begin\nset @systemName r2\nset @systemName r3\nset /acme:x 1\nset @nope 1\nchanges\nabandon\n` });
    expect(r.stderr).toContain('set: Two edits target the same node');
    expect(r.stderr).toContain('set: Unknown YANG module "acme"');
    expect(r.stderr).toMatch(/set: .*@nope/);
    expect(r.stdout).toMatch(/ {2}1 {2}set {5}@systemName {2}"r2"\n/);
    expect(r.stdout).not.toMatch(/ {2}2 {2}set/);
    expect(f.rpcsSent()).toBe(0);
  });

  it('AC3: changes lists the queued changes in order, with paths and values', async () => {
    const r = await runNnc(['lab1', '-c', 'begin', '-c', 'set @systemName r2', '-c', `remove ${ETH9}`, '-c', 'changes', '-c', 'abandon'], { home: f.home });
    expect(r.stdout).toBe(`  1  set     @systemName  "r2"\n  2  remove  ${ETH9}\n`);
  });

  it('AC4: while a transaction is open the prompt shows [tx N] and status shows the number queued', async () => {
    const r = await runNnc(['lab1', '-i'], { home: f.home, stdin: 'begin\nset @systemName r2\nset /lab:system/location rack9\nstatus\nabandon\nstatus\n' });
    expect(r.stdout).toContain('nnc lab1 [tx 0]> ');
    expect(r.stdout).toContain('nnc lab1 [tx 2]> ');
    expect(r.stdout).toMatch(/^transaction\s+open: 2 changes queued/m);
    expect(r.stdout).toMatch(/nnc lab1> disconnected from lab1\n$/);
  });

  it('AC5: abandon drops the queued changes and ends the transaction; nothing is sent', async () => {
    const r = await runNnc(['lab1', '-c', 'begin', '-c', 'set @systemName r2', '-c', 'abandon', '-c', 'set @systemName r3'], { home: f.home });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('transaction abandoned: 1 change dropped; nothing was sent');
    // After abandon, set sends again.
    expect(f.sent().map((op) => op.name)).toContain('edit-config');
    expect(f.sent().filter((op) => op.name === 'edit-config')).toHaveLength(1);
  });

  it('AC6: begin inside a transaction, or apply, abandon or changes outside one, fails saying so', async () => {
    const twice = await runNnc(['lab1', '-c', 'begin', '-c', 'begin'], { home: f.home });
    expect(twice.stderr).toContain('begin: a transaction is already open');
    for (const cmd of ['apply', 'abandon', 'changes']) {
      const r = await runNnc(['lab1', '-c', cmd], { home: f.home });
      expect(r.code, cmd).toBe(2);
      expect(r.stderr, cmd).toContain(`${cmd}: no transaction is open (begin starts one)`);
    }
  });

  it('AC7: disconnecting drops an open transaction and says so; a script ending inside one fails', async () => {
    const r = await runNnc(['lab1', '-i'], { home: f.home, stdin: 'begin\nset @systemName r2\ndisconnect\n' });
    expect(r.stdout).toContain('the open transaction was dropped: 1 queued change was not applied');
    const script = await runNnc(['lab1', '-c', 'begin', '-c', 'set @systemName r2'], { home: f.home });
    expect(script.code).toBe(2);
    expect(script.stderr).toContain('the script ended with a transaction open: its 1 queued change was not applied');
    expect(f.rpcsSent()).toBe(0);
  });

  it('AC8: on a read-only target begin is refused', async () => {
    const r = await runNnc(['router1', '-c', 'begin'], { home: f.home });
    expect(r.code).toBe(4);
    expect(r.stderr).toContain('begin: refused: router1 is read-only and begin changes device state; nothing was sent');
  });
});
