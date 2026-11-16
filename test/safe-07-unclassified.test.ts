/**
 * SAFE-07: Treat unclassified operations and unknown RPCs as writes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { x } from '@node-net/netconf';
import { fixture, type Fixture } from './support/fixture.js';
import { runNnc } from './support/nnc.js';

const LAB = 'urn:example:lab';

const PROFILE = {
  id: 'lab-test',
  match: { anyModule: ['lab-mod'] },
  operations: {
    show: {
      description: 'Run a show command',
      mutates: false,
      params: { command: 'string' },
      request: `<show-cmd xmlns="${LAB}"><cmd>{{command}}</cmd></show-cmd>`,
    },
    reboot: {
      description: 'Reboot the device',
      request: `<reboot xmlns="${LAB}"/>`,
    },
  },
};

describe('SAFE-07 unclassified operations and unknown RPCs count as writes', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await fixture({
      fake: {
        capabilities: ['urn:ietf:params:netconf:base:1.1', `${LAB}?module=lab-mod`],
        handler: (_rpc, ctx) => (ctx.operation?.name === 'show-cmd' ? { data: x('output', { xmlns: LAB }, 'version 1') } : 'ok'),
      },
    });
    const dir = f.profile(PROFILE);
    f.home.targets({
      router1: f.target({ readOnly: true, profilesDir: dir }),
      router2: f.target({ readOnly: true, profilesDir: dir, allowRpcs: ['get-schema'] }),
      lab1: f.target({ profilesDir: dir }),
    });
  });
  afterAll(() => f.close());

  it('AC1: a profile operation runs on a read-only target only when the profile marks it mutates: false', async () => {
    const show = await runNnc(['router1', '-c', 'device show --command "show version"'], { home: f.home });
    expect(show.stderr).toMatch(/^connected to router1 /);
    expect(show.code).toBe(0);
    expect(show.stdout).toContain('version 1');
    const sent = f.server.last()!.requests.map((r) => r.elements[0]!);
    expect(sent[0]!.name).toBe('show-cmd');
    expect(sent[0]!.textContent()).toBe('show version');

    const reboot = await runNnc(['router1', '-c', 'device reboot'], { home: f.home });
    expect(reboot.code).toBe(4);
    expect(f.rpcsSent()).toBe(0);

    const writable = await runNnc(['lab1', '-c', 'device reboot'], { home: f.home });
    expect(writable.code).toBe(0);
    expect(f.rpcsSent()).toBe(1);
  });

  it('AC2: rpc is allowed when the root element is a known operation that does not change state', async () => {
    const r = await runNnc(['router1', '-c', 'rpc <get-config><source><running/></source></get-config>'], { home: f.home });
    expect(r.code).toBe(0);
    expect(f.rpcsSent()).toBe(1);
  });

  it('AC3: rpc with an unknown root element is refused, unless the target lists it in allowRpcs', async () => {
    const unknown = await runNnc(['router1', '-c', `rpc <get-schema xmlns="${LAB}"><identifier>x</identifier></get-schema>`], { home: f.home });
    expect(unknown.code).toBe(4);
    expect(f.rpcsSent()).toBe(0);

    const allowed = await runNnc(['router2', '-c', `rpc <get-schema xmlns="${LAB}"><identifier>x</identifier></get-schema>`], { home: f.home });
    expect(allowed.code).toBe(0);
    expect(f.rpcsSent()).toBe(1);

    // A known operation name in another namespace isn't the known operation.
    const disguised = await runNnc(['router1', '-c', `rpc <get-config xmlns="${LAB}"/>`], { home: f.home });
    expect(disguised.code).toBe(4);
    expect(f.rpcsSent()).toBe(0);
  });

  it('AC4: the refusal says the operation is not known to be read-only and how to allow it', async () => {
    const rpc = await runNnc(['router1', '-c', `rpc <reboot xmlns="${LAB}"/>`], { home: f.home });
    expect(rpc.stderr).toContain(
      `rpc <reboot>: refused: router1 is read-only and <reboot> (${LAB}) isn't known to be read-only. ` +
        'To allow it, describe it in the device profile with "mutates": false, or add "reboot" to the target\'s allowRpcs; nothing was sent',
    );
    const device = await runNnc(['router1', '-c', 'device reboot'], { home: f.home });
    expect(device.stderr).toContain(
      "device reboot: refused: router1 is read-only, and profile lab-test doesn't mark reboot as read-only. " +
        'If it doesn\'t change state, mark it "mutates": false in the profile; nothing was sent',
    );
  });

  it('device and profile list the profile operations and mark those that change state', async () => {
    const view = await runNnc(['router1', '-c', 'profile'], { home: f.home });
    expect(view.stdout).toMatch(/^profile\s+lab-test\n/);
    expect(view.stdout).toMatch(/^operations \(\* changes state\):$/m);
    const r = await runNnc(['router1', '-c', 'device'], { home: f.home });
    expect(r.stdout).toMatch(/^operations of profile lab-test \(\* changes state\):$/m);
    expect(r.stdout).toMatch(/^\s+reboot \*\s+Reboot the device$/m);
    expect(r.stdout).toMatch(/^\s+show\s+Run a show command$/m);
  });
});
