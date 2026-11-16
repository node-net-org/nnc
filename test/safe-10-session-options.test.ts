/**
 * SAFE-10: Tune a target's session limits and checks.
 */
import { x } from '@node-net/netconf';
import type { RpcHandler } from '@node-net/netconf/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BARE } from './support/caps.js';
import { fixture, type Fixture } from './support/fixture.js';
import { runNnc } from './support/nnc.js';

/** Big data for <get>, deep data for <deep/>, and a small configuration for get-config. */
const handler: RpcHandler = (_rpc, ctx) => {
  const name = ctx.operation?.name;
  if (name === 'get') return { data: x('blob', { xmlns: 'urn:example:lab' }, 'x'.repeat(20_000)) };
  if (name === 'deep') return { data: x('a', { xmlns: 'urn:example:lab' }, x('b', x('c', x('d', x('e', x('f', 'deep')))))) };
  if (name === 'get-config') return { data: x('system', { xmlns: 'urn:acme:system' }, x('hostname', 'r1')) };
  return 'ok';
};

describe('SAFE-10 session options', () => {
  let f: Fixture;
  const targets = (extra: Record<string, object>): void => f.home.targets(Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, f.target(v)])));
  beforeAll(async () => {
    f = await fixture({ fake: { capabilities: BARE, handler } });
  });
  afterAll(() => f.close());

  it('AC1: a target may set maxInFlight, maxMessageBytes, parseLimits, capabilityCheck and namespaces', async () => {
    targets({ lab1: { maxInFlight: 2, maxMessageBytes: 1_000_000, parseLimits: { maxDepth: 64, maxNodes: 10_000 }, capabilityCheck: 'warn', namespaces: { 'acme-system': 'urn:acme:system' } } });
    const r = await runNnc(['lab1', '-c', 'read /acme-system:system/hostname'], { home: f.home });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('r1');
    // TLS targets take the same fields.
    f.home.targets({ tls1: { transport: 'tls', host: '127.0.0.1', cert: 'c.pem', key: 'k.pem', insecure: 'insecure-accept-any', maxInFlight: 0 } });
    const tls = await runNnc(['-c', 'targets'], { home: f.home });
    expect(tls.stderr).toContain('"tls1"');
    expect(tls.stderr).toContain('field "maxInFlight" must be a positive whole number');
  });

  it('AC2: a bad value fails naming the file, target and field, and nothing is connected', async () => {
    const cases: [object, RegExp][] = [
      [{ maxMessageBytes: -1 }, /field "maxMessageBytes" must be a positive whole number/],
      [{ parseLimits: { maxDepth: 100_000 } }, /field "parseLimits\.maxDepth" must be at most \d+/],
      [{ parseLimits: { depth: 3 } }, /"parseLimits\.depth"/],
      [{ capabilityCheck: 'loose' }, /field "capabilityCheck" must be "strict", "warn" or "off"/],
      [{ namespaces: { acme: '' } }, /field "namespaces" must be an object of YANG module names to namespaces/],
    ];
    for (const [extra, message] of cases) {
      targets({ lab1: extra });
      const r = await runNnc(['lab1', '-c', 'status'], { home: f.home });
      expect(r.code, JSON.stringify(extra)).toBe(2);
      expect(r.stderr, JSON.stringify(extra)).toContain(f.home.targetsFile);
      expect(r.stderr, JSON.stringify(extra)).toContain('"lab1"');
      expect(r.stderr, JSON.stringify(extra)).toMatch(message);
      expect(r.stderr, JSON.stringify(extra)).not.toContain('connected to');
    }
  });

  it('AC3: status lists the options the target sets', async () => {
    targets({ lab1: { maxInFlight: 1, parseLimits: { maxNodes: 5000 }, capabilityCheck: 'off', namespaces: { acme: 'urn:acme' } } });
    const r = await runNnc(['lab1', '-c', 'status'], { home: f.home });
    expect(r.stdout).toMatch(/^session options\s+maxInFlight 1, parseLimits\.maxNodes 5000, capabilityCheck off, namespaces acme=urn:acme$/m);
    targets({ lab1: {} });
    const plain = await runNnc(['lab1', '-c', 'status'], { home: f.home });
    expect(plain.stdout).not.toMatch(/^session options/m);
  });

  it('AC4: capabilityCheck off sends an unadvertised operation; warn sends it with a warning; strict refuses it', async () => {
    // The device advertises no :candidate.
    targets({ strict1: {}, warn1: { capabilityCheck: 'warn' }, off1: { capabilityCheck: 'off' } });
    const strict = await runNnc(['strict1', '-c', 'lock candidate'], { home: f.home });
    expect(strict.code).not.toBe(0);
    expect(strict.stderr).toContain(':candidate');
    expect(f.rpcsSent()).toBe(0);

    const warn = await runNnc(['warn1', '-c', 'lock candidate'], { home: f.home });
    expect(warn.code).toBe(0);
    expect(warn.stderr).toMatch(/^warning: .*:candidate/m);
    expect(f.sent().map((op) => op.name)).toEqual(['lock']);

    const off = await runNnc(['off1', '-c', 'lock candidate'], { home: f.home });
    expect(off.code).toBe(0);
    expect(off.stdout).toBe('ok\n');
    expect(off.stderr).not.toContain('warning');
    expect(f.sent().map((op) => op.name)).toEqual(['lock']);
  });

  it('AC5: a reply over maxMessageBytes or parseLimits closes the session, naming the limit', async () => {
    targets({ small: { maxMessageBytes: 5000 }, shallow: { parseLimits: { maxDepth: 5 } } });
    const big = await runNnc(['small', '-c', 'get'], { home: f.home });
    expect(big.code).not.toBe(0);
    expect(big.stderr).toContain('maxMessageBytes (5000)');
    const deep = await runNnc(['shallow', '-c', 'rpc <deep xmlns="urn:example:lab"/>'], { home: f.home });
    expect(deep.code).not.toBe(0);
    expect(deep.stderr).toContain('maxDepth (5)');
  });

  it("AC6: namespaces lets paths use a module the device doesn't advertise", async () => {
    targets({ plain1: {}, ns1: { namespaces: { 'acme-system': 'urn:acme:system' } } });
    const without = await runNnc(['plain1', '-c', 'resolve /acme-system:system/hostname'], { home: f.home });
    expect(without.stderr).toContain('Unknown YANG module "acme-system"');
    const withNs = await runNnc(['ns1', '-c', 'resolve /acme-system:system/hostname'], { home: f.home });
    expect(withNs.code).toBe(0);
    expect(withNs.stdout).toContain('namespace  urn:acme:system');
  });
});
