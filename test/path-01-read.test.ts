/**
 * PATH-01: Read configuration or state by YANG path.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runNnc } from './support/nnc.js';
import { IF_NS, PROFILE, pathFixture, type PathFixture } from './support/path.js';

const ETH0 = '/ietf-interfaces:interfaces/interface[name="eth0"]';

describe('PATH-01 read', () => {
  let f: PathFixture;
  beforeAll(async () => {
    f = await pathFixture();
  });
  afterAll(() => f.close());

  it('AC1: read <path> prints the matching elements', async () => {
    const r = await runNnc(['lab1', '-c', `read ${ETH0}`], { home: f.home });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`<interface xmlns="${IF_NS}">\n  <name>eth0</name>\n  <description>uplink</description>\n  <enabled>true</enabled>\n</interface>\n`);
    // The request is a subtree filter built from the path.
    const sent = f.sent()[0]!;
    expect(sent.name).toBe('get-config');
    expect(sent.child('filter')?.elements[0]?.name).toBe('interfaces');
  });

  it('AC2: running by default; --datastore candidate and --state (get) change that', async () => {
    await runNnc(['lab1', '-c', `read ${ETH0}`], { home: f.home });
    expect(f.sent()[0]!.child('source')?.elements[0]?.name).toBe('running');
    await runNnc(['lab1', '-c', `read ${ETH0} --datastore candidate`], { home: f.home });
    expect(f.sent()[0]!.child('source')?.elements[0]?.name).toBe('candidate');
    const state = await runNnc(['lab1', '-c', 'read /lab:uptime --state'], { home: f.home });
    expect(f.sent()[0]!.name).toBe('get');
    expect(state.stdout).toContain('42');
    const both = await runNnc(['lab1', '-c', `read ${ETH0} --state --datastore running`], { home: f.home });
    expect(both.code).toBe(2);
    expect(both.stderr).toContain('read: give --state or --datastore, not both');
  });

  it('AC3: a named path from the profile can be used in place of a path', async () => {
    const r = await runNnc(['lab1', '-c', 'read @systemName'], { home: f.home });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('<name xmlns="urn:example:lab">router1</name>\n');
  });

  it('AC4: when nothing matches it prints (no data)', async () => {
    const r = await runNnc(['lab1', '-c', 'read /ietf-interfaces:interfaces/interface[name="eth9"]'], { home: f.home });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('(no data)\n');
    const json = await runNnc(['lab1', '-c', 'read /ietf-interfaces:interfaces/interface[name="eth9"] --json'], { home: f.home });
    expect(json.stdout).toBe('[]\n');
  });

  it("AC5: a module the device doesn't advertise fails before sending, naming the module", async () => {
    const r = await runNnc(['lab1', '-c', 'read /acme-system:system'], { home: f.home });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('read: Unknown YANG module "acme-system"');
    expect(r.stderr).toContain('nothing was sent');
    expect(f.rpcsSent()).toBe(0);
  });

  it("AC6: a path that can't be parsed fails before sending, showing the position", async () => {
    const r = await runNnc(['lab1', '-c', 'read /ietf-interfaces:interfaces/interface[name=eth0]'], { home: f.home });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/read: Invalid path ".*" at position \d+: .*; nothing was sent/);
    expect(f.rpcsSent()).toBe(0);
  });

  it("AC7: where the profile says filters aren't supported, only the matching data is returned", async () => {
    const nofilter = await pathFixture({ profile: { ...PROFILE, id: 'nofilter', quirks: { subtreeFilter: 'unsupported' } } });
    try {
      const r = await runNnc(['lab1', '-c', `read ${ETH0}/description`], { home: nofilter.home });
      expect(r.code).toBe(0);
      expect(r.stdout).toBe(`<description xmlns="${IF_NS}">uplink</description>\n`);
      // The whole datastore was fetched, with no filter.
      expect(nofilter.sent()[0]!.child('filter')).toBeUndefined();
    } finally {
      await nofilter.close();
    }
  });
});
