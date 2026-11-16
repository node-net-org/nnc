/**
 * PATH-07: See the device profile in use (profile).
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runNnc } from './support/nnc.js';
import { pathFixture, type PathFixture } from './support/path.js';

describe('PATH-07 profile', () => {
  let f: PathFixture;
  beforeAll(async () => {
    f = await pathFixture();
  });
  afterAll(() => f.close());

  it("AC1: profile shows the profile's name and where it came from", async () => {
    const r = await runNnc(['lab1', '-c', 'profile'], { home: f.home });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^profile {3}lab-test \(unverified\)$/m);
    expect(r.stdout).toMatch(new RegExp(`^source {4}${f.profilesDir}/lab-test\\.json$`, 'm'));
    // A built-in profile says so.
    f.home.targets({ ...(JSON.parse(readFileSync(f.home.targetsFile, 'utf8')) as object), sros1: f.target({ profile: 'nokia-sros-md' }) });
    const builtin = await runNnc(['sros1', '-c', 'profile'], { home: f.home });
    expect(builtin.stdout).toMatch(/^profile {3}nokia-sros-md/m);
    expect(builtin.stdout).toMatch(/^source {4}built in$/m);
  });

  it('AC2: it shows how the profile was chosen: named by the target, or auto-detected with the rule that matched', async () => {
    const named = await runNnc(['lab1', '-c', 'profile'], { home: f.home });
    expect(named.stdout).toMatch(/^chosen {4}named by target lab1$/m);
    const detected = await runNnc(['auto1', '-c', 'profile'], { home: f.home });
    expect(detected.stdout).toMatch(/^chosen {4}auto-detected \(match: anyModule lab\)$/m);
  });

  it('AC3: it lists the quirks, the configure workflow, the named paths, and the operations with whether each changes state', async () => {
    const r = await runNnc(['lab1', '-c', 'profile'], { home: f.home });
    expect(r.stdout).toMatch(/^quirks {4}maxInFlight 2$/m);
    expect(r.stdout).toMatch(/^workflow {2}lock true \(the rest: library defaults\)$/m);
    expect(r.stdout).toMatch(/^named paths:\n {2}@systemName +\/lab:system\/name\n {2}@interfaces +\/ietf-interfaces:interfaces\/interface$/m);
    expect(r.stdout).toMatch(/^operations \(\* changes state\):\n {2}show +Run a show command\n {2}reboot \* +Reboot the device$/m);
  });

  it('AC4: with no profile, profile says so and lists the profiles auto-detection considered', async () => {
    const r = await runNnc(['plain1', '-c', 'profile'], { home: f.home });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('no device profile is in use in this session');
    expect(r.stderr).toMatch(/auto-detection considered .*nokia-sros-md.*sysrepo-netopeer2.*; none matched the device's hello/);
  });

  it('AC5: profile --json prints the same as JSON, plus the effective definition', async () => {
    const r = await runNnc(['auto1', '-c', 'profile --json'], { home: f.home });
    expect(r.code).toBe(0);
    const json = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(json).toMatchObject({
      profile: 'lab-test',
      source: { type: 'file', file: `${f.profilesDir}/lab-test.json` },
      chosen: { by: 'auto-detection', match: { anyModule: ['lab'] } },
      status: 'unverified',
      quirks: { maxInFlight: 2 },
      workflow: { lock: true },
      paths: { systemName: '/lab:system/name' },
      operations: [
        { name: 'show', description: 'Run a show command', mutates: false },
        { name: 'reboot', description: 'Reboot the device', mutates: true },
      ],
    });
    // The effective definition: the profile file as loaded, operations with their templates.
    const definition = json['definition'] as { id: string; operations: Record<string, { request: string }> };
    expect(definition.id).toBe('lab-test');
    expect(definition.operations['show']!.request).toBe('<show xmlns="urn:example:lab"><command>{{command}}</command></show>');
    expect(definition).not.toHaveProperty('$schema');
    const none = await runNnc(['plain1', '-c', 'profile --json'], { home: f.home });
    expect(JSON.parse(none.stdout)).toMatchObject({ profile: null });
  });

  it('AC6: profile sends nothing to the device, and works on read-only targets', async () => {
    const r = await runNnc(['router1', '-c', 'profile', '-c', 'profile --json'], { home: f.home });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^profile {3}lab-test/m);
    expect(f.rpcsSent()).toBe(0);
  });
});
