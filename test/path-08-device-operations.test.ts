/**
 * PATH-08: Run the device profile's operations.
 */
import { x } from '@node-net/netconf';
import type { RpcHandler } from '@node-net/netconf/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runNnc } from './support/nnc.js';
import { LAB_NS, handler, pathFixture, type PathFixture } from './support/path.js';

const withShow: RpcHandler = (rpc, ctx) =>
  ctx.operation?.name === 'show' ? { body: [x('output', { xmlns: LAB_NS }, `ran ${ctx.operation.child('command')?.text() ?? ''}`)] } : handler(rpc, ctx);

describe('PATH-08 device operations', () => {
  let f: PathFixture;
  beforeAll(async () => {
    f = await pathFixture({ handler: withShow });
  });
  afterAll(() => f.close());

  it("AC1: device show --command runs the profile's operation with that parameter and prints its result", async () => {
    const r = await runNnc(['lab1', '-c', 'device show --command "show version"'], { home: f.home });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('ran show version\n');
    expect(f.sent()[0]!.child('command')?.text()).toBe('show version');
  });

  it("AC2: parameters are options named as in the profile, checked against their types before sending", async () => {
    const r = await runNnc(['lab1', '-c', 'device show --command'], { home: f.home });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('device show: --command needs a value');
    const unknown = await runNnc(['lab1', '-c', 'device show --cmd x'], { home: f.home });
    expect(unknown.stderr).toContain('device show: unknown option --cmd (options: --command)');
    expect(f.rpcsSent()).toBe(0);
  });

  it("AC3: a missing parameter or an unknown operation fails before sending, listing the profile's operations", async () => {
    const missing = await runNnc(['lab1', '-c', 'device show'], { home: f.home });
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("device show: missing --command; nothing was sent (the profile's operations: show, reboot)");
    const unknown = await runNnc(['lab1', '-c', 'device restart'], { home: f.home });
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain(`device: profile lab-test has no operation "restart" (the profile's operations: show, reboot)`);
    expect(f.rpcsSent()).toBe(0);
  });

  it('AC4: results are shown in the form the operation defines, and --raw shows the whole reply', async () => {
    const text = await runNnc(['lab1', '-c', 'device show --command uptime'], { home: f.home });
    expect(text.stdout).toBe('ran uptime\n');
    const raw = await runNnc(['lab1', '-c', 'device show --command uptime --raw'], { home: f.home });
    expect(raw.stdout).toMatch(/^(<\?xml[^>]*>)?<rpc-reply [^>]*message-id="\d+"[^>]*><output xmlns="urn:example:lab">ran uptime<\/output><\/rpc-reply>\n$/);
  });

  it("AC5: device with no operation lists the profile's operations, with descriptions, parameters and * for those that change state", async () => {
    const listing = 'operations of profile lab-test (* changes state):\n  show  Run a show command\n      --command <string>\n  reboot *  Reboot the device\n';
    const r = await runNnc(['lab1', '-c', 'device'], { home: f.home });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(listing);
    expect(f.rpcsSent()).toBe(0);
    // help device shows the same, and where to see one in full.
    const help = await runNnc(['lab1', '-c', 'help device'], { home: f.home });
    expect(help.stdout).toContain(listing);
    expect(help.stdout).toContain("profile <operation> shows one's full definition.");
    // --json
    const json = await runNnc(['lab1', '-c', 'device --json'], { home: f.home });
    expect(JSON.parse(json.stdout)).toEqual({
      profile: 'lab-test',
      operations: [
        { name: 'show', description: 'Run a show command', mutates: false, params: [{ name: 'command', type: 'string', required: true }] },
        { name: 'reboot', description: 'Reboot the device', mutates: true, params: [] },
      ],
    });
    // With no profile, it says there are none.
    const none = await runNnc(['plain1', '-c', 'device'], { home: f.home });
    expect(none.code).toBe(0);
    expect(none.stdout).toBe('');
    expect(none.stderr).toContain('no device profile is in use in this session, so it has no operations');
    const noneJson = await runNnc(['plain1', '-c', 'device --json'], { home: f.home });
    expect(JSON.parse(noneJson.stdout)).toEqual({ profile: null, operations: [] });
  });

  it('AC6: on a read-only target, operations not marked mutates: false are refused before sending', async () => {
    const reboot = await runNnc(['router1', '-c', 'device reboot'], { home: f.home });
    expect(reboot.code).toBe(4);
    expect(reboot.stderr).toContain("device reboot: refused: router1 is read-only, and profile lab-test doesn't mark reboot as read-only");
    expect(f.rpcsSent()).toBe(0);
    const show = await runNnc(['router1', '-c', 'device show --command uptime'], { home: f.home });
    expect(show.code).toBe(0);
    expect(f.rpcsSent()).toBe(1);
  });
});
