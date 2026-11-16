/**
 * PATH-05: See how a path resolves without sending anything.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runNnc } from './support/nnc.js';
import { IF_NS, LAB_NS, PROFILE, pathFixture, type PathFixture } from './support/path.js';

describe('PATH-05 resolve', () => {
  let f: PathFixture;
  beforeAll(async () => {
    f = await pathFixture();
  });
  afterAll(() => f.close());

  it('AC1: resolve @name shows the full path, then each step with its module, namespace and keys', async () => {
    const r = await runNnc(['lab1', '-c', 'resolve @systemName'], { home: f.home });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^path {2}\/lab:system\/name {2}\(@systemName\)\n/);
    expect(r.stdout).toContain(`step 1  system\n  module     lab\n  namespace  ${LAB_NS}\n`);
    expect(r.stdout).toContain(`step 2  name\n  module     lab\n  namespace  ${LAB_NS}\n`);
    const keyed = await runNnc(['lab1', '-c', 'resolve /ietf-interfaces:interfaces/interface[name="eth0"]/mtu --json'], { home: f.home });
    const json = JSON.parse(keyed.stdout) as { steps: { name: string; namespace: string; keys: object }[] };
    expect(json.steps[1]).toEqual({ name: 'interface', module: 'ietf-interfaces', namespace: IF_NS, keys: { name: 'eth0' } });
  });

  it('AC2: resolve also shows the subtree filter a read would send', async () => {
    const r = await runNnc(['lab1', '-c', 'resolve /ietf-interfaces:interfaces/interface[name="eth0"]'], { home: f.home });
    expect(r.stdout).toContain(`filter a read sends:\n  <interfaces xmlns="${IF_NS}">\n    <interface>\n      <name>eth0</name>\n    </interface>\n  </interfaces>`);
    const nofilter = await pathFixture({ profile: { ...PROFILE, id: 'nofilter', quirks: { subtreeFilter: 'unsupported' } } });
    try {
      const n = await runNnc(['lab1', '-c', 'resolve @systemName'], { home: nofilter.home });
      expect(n.stdout).toContain("filter a read sends:\n  none: the profile's subtreeFilter quirk");
    } finally {
      await nofilter.close();
    }
  });

  it('AC3: an unknown module or a syntax error fails with the message read would give', async () => {
    for (const path of ['/acme-system:system', '/ietf-interfaces:interfaces/interface[name=eth0]', '@nope']) {
      const read = await runNnc(['lab1', '-c', `read ${path}`], { home: f.home });
      const resolve = await runNnc(['lab1', '-c', `resolve ${path}`], { home: f.home });
      expect(resolve.code, path).toBe(2);
      const message = (r: { stderr: string }, cmd: string): string => r.stderr.split('\n').find((l) => l.startsWith(`${cmd}: `))!.slice(cmd.length + 2);
      expect(message(resolve, 'resolve'), path).toBe(message(read, 'read'));
    }
  });

  it('AC4: resolve sends nothing, and works on read-only targets', async () => {
    const r = await runNnc(['router1', '-c', 'resolve @systemName'], { home: f.home });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('path  /lab:system/name');
    expect(f.rpcsSent()).toBe(0);
  });
});
