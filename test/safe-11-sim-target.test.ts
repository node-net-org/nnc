/**
 * SAFE-11: a `"transport": "sim"` target reaches a simulated device the host
 * provides, and nnc works on it as over SSH. Run in-process on an in-memory
 * host.
 */

import { rmSync } from 'node:fs';
import { x } from '@node-net/netconf/core';
import { describe, expect, it } from 'vitest';
import { runNnc } from '../src/run.js';
import { fakeDevice, memoryHost, TARGETS } from './support/memory-host.js';
import { makeHome, runNnc as runNncCommand } from './support/nnc.js';

const run = async (targets: unknown, commands: string[], sims = { router: fakeDevice() }) => {
  const m = memoryHost({ targets, sims });
  const exitCode = await runNnc(m.host, { source: { kind: 'commands', commands } });
  return { exitCode, out: m.out(), err: m.err(), files: m.files };
};

describe('SAFE-11 sim targets', () => {
  it('device names the simulated device and defaults to the target name', async () => {
    const named = await run({ lab: { transport: 'sim', device: 'router' } }, ['connect lab', 'status', 'disconnect']);
    expect(named.exitCode).toBe(0);
    expect(named.err).toContain('connected to lab (sim:router) · session-id 1');
    const byName = await run({ router: { transport: 'sim' } }, ['connect router', 'disconnect']);
    expect(byName.exitCode).toBe(0);
    expect(byName.err).toContain('connected to router (sim:router)');
  });

  it('refuses SSH- and TLS-only fields, naming the file, target and field', async () => {
    for (const field of ['host', 'port', 'username', 'cert']) {
      const r = await run({ lab: { transport: 'sim', [field]: field === 'port' ? 830 : 'x' } }, ['connect lab']);
      expect(r.exitCode).toBe(2);
      expect(r.err).toContain(`targets file ${TARGETS}: target "lab": field "${field}" is not used by "transport": "sim" targets`);
    }
  });

  it('a device the host does not provide fails naming it, and nothing else is tried', async () => {
    const r = await run({ lab: { transport: 'sim', device: 'switch' } }, ['connect lab']);
    expect(r.exitCode).toBe(3);
    expect(r.err).toContain('cannot reach lab: there is no simulated device "switch" here (devices: router)');
  });

  it('the nnc command has no simulated devices: connect names the device, listen refuses, and nothing is tried over SSH', async () => {
    const home = makeHome();
    try {
      home.targets({ lab: { transport: 'sim', device: 'router' } });
      const connect = await runNncCommand(['-c', 'connect lab'], { home });
      expect(connect.code).toBe(3);
      expect(connect.stderr).toContain('cannot reach lab: there is no simulated device "router" here');
      expect(connect.stderr).not.toMatch(/Password|host not found|:0/);
      const listen = await runNncCommand(['-c', 'listen lab'], { home });
      expect(listen.code).toBe(2);
      expect(listen.stderr).toContain("listen: lab is a simulated device, which can't call home; use connect");
    } finally {
      rmSync(home.dir, { recursive: true, force: true });
    }
  });

  it('status and targets show the target as sim:<device>', async () => {
    const r = await run({ lab: { transport: 'sim', device: 'router' } }, ['targets', 'connect lab', 'status', 'disconnect']);
    expect(r.exitCode).toBe(0);
    expect(r.out).toMatch(/lab\s+sim:router \(simulated\)/);
    expect(r.out).toMatch(/host\s+sim:router\n/);
    expect(r.out).toMatch(/transport\s+simulated device \(in memory\)/);
    expect(r.out).not.toContain('host key');
  });

  it('commands, read-only and hello capture work as over SSH', async () => {
    const r = await run({ lab: { transport: 'sim', device: 'router', readOnly: true } }, [
      'connect lab',
      'capabilities',
      'hello --raw',
      'get-config running',
      'set on-error continue',
      'edit-config running <config/>',
      'disconnect',
    ]);
    expect(r.out).toContain('urn:ietf:params:netconf:base:1.1');
    expect(r.out).toContain('<hello');
    expect(r.out).toContain('(no data)');
    expect(r.err).toMatch(/edit-config.*read-only/);
    expect(r.exitCode).toBe(4);
  });

  it('notifications from the simulated device are noticed and kept', async () => {
    const device = fakeDevice({
      handler: async (_rpc, ctx) => {
        if (ctx.operation?.name !== 'get') return 'ok';
        ctx.server.notify(x('link-down', { xmlns: 'urn:example:lab' }, x('interface', 'eth0')), '2026-11-07T10:00:00Z');
        await new Promise((r) => setTimeout(r, 50));
        return { data: [] };
      },
    });
    const r = await run({ lab: { transport: 'sim', device: 'router' } }, ['connect lab', 'get', 'notifications', 'disconnect'], { router: device });
    expect(r.exitCode).toBe(0);
    expect(r.out).toContain('notification 1 · 2026-11-07T10:00:00Z · link-down');
    expect(r.err).toContain('notification 1 · 2026-11-07T10:00:00Z · link-down');
  });

  it('trace bytes, frames and xml show the traffic', async () => {
    const r = await run({ lab: { transport: 'sim', device: 'router' } }, ['trace bytes frames xml', 'connect lab', 'get-config running', 'disconnect']);
    expect(r.exitCode).toBe(0);
    expect(r.err).toMatch(/>> \S+ bytes \d+ B: <\?xml/);
    expect(r.err).toMatch(/<< \S+ frames \d+ B chunked/);
    expect(r.err).toMatch(/<< \S+ xml .*rpc-reply/);
  });

  it('framed and raw sessions work on a sim target', async () => {
    const framed = await run({ lab: { transport: 'sim', device: 'router' } }, ['connect lab --framed', 'status', 'disconnect']);
    expect(framed.exitCode).toBe(0);
    expect(framed.out).toMatch(/kind\s+framed/);
    const raw = await run({ lab: { transport: 'sim', device: 'router' } }, ['connect lab --raw', 'status', 'disconnect']);
    expect(raw.exitCode).toBe(0);
    expect(raw.out).toMatch(/kind\s+raw/);
  });
});
