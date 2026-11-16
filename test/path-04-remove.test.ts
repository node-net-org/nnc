/**
 * PATH-04: Remove configuration by path.
 */
import { serializeXml } from '@node-net/netconf';
import type { RpcHandler } from '@node-net/netconf/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runNnc } from './support/nnc.js';
import { IF_NS, handler, pathFixture, type PathFixture } from './support/path.js';

const ETH9 = '/ietf-interfaces:interfaces/interface[name="eth9"]';

describe('PATH-04 remove', () => {
  let f: PathFixture;
  beforeAll(async () => {
    f = await pathFixture();
  });
  afterAll(() => f.close());

  it("AC1: remove deletes the node by following the profile's workflow", async () => {
    const r = await runNnc(['lab1', '-c', `remove ${ETH9}`], { home: f.home });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('ok\n');
    expect(f.sent().map((op) => op.name)).toEqual(['lock', 'lock', 'discard-changes', 'edit-config', 'validate', 'commit', 'unlock', 'unlock']);
    expect(serializeXml(f.sent()[3]!.child('config')!.elements[0]!)).toBe(
      `<interfaces xmlns="${IF_NS}"><interface xmlns:nc="urn:ietf:params:xml:ns:netconf:base:1.0" nc:operation="remove"><name>eth9</name></interface></interfaces>`,
    );
  });

  it("AC2: removing a node that doesn't exist succeeds", async () => {
    // eth9 isn't in the device's configuration; remove (not delete) makes that no error.
    const r = await runNnc(['lab1', '-c', `remove ${ETH9}`], { home: f.home });
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain('rpc-error');
  });

  it('AC3: if a step fails, changes are discarded and locks released', async () => {
    const failing: RpcHandler = (rpc, ctx) =>
      ctx.operation?.name === 'validate' ? { errors: [{ type: 'application', tag: 'invalid-value', message: 'eth9 is in use' }] } : handler(rpc, ctx);
    const bad = await pathFixture({ handler: failing });
    try {
      const r = await runNnc(['lab1', '-c', `remove ${ETH9}`], { home: bad.home });
      expect(r.code).toBe(1);
      expect(bad.sent().map((op) => op.name)).toEqual(['lock', 'lock', 'discard-changes', 'edit-config', 'validate', 'discard-changes', 'unlock', 'unlock']);
      expect(r.stderr).toContain('remove: failed at validate; the changes were discarded and the locks released\nrpc-error: invalid-value');
    } finally {
      await bad.close();
    }
  });

  it('AC4: on a read-only target remove is refused before sending', async () => {
    const r = await runNnc(['router1', '-c', `remove ${ETH9}`], { home: f.home });
    expect(r.code).toBe(4);
    expect(r.stderr).toContain('remove: refused: router1 is read-only and remove changes device state; nothing was sent');
    expect(f.rpcsSent()).toBe(0);
  });
});
