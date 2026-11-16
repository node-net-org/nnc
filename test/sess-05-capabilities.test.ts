/**
 * SESS-05: List the server's capabilities (its YANG modules: PATH-15, modules).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixture, type Fixture } from './support/fixture.js';
import { runNnc } from './support/nnc.js';

const BASE10 = 'urn:ietf:params:netconf:base:1.0';
const BASE11 = 'urn:ietf:params:netconf:base:1.1';
const STARTUP = 'urn:ietf:params:netconf:capability:startup:1.0';
const ADDED = 'urn:example:capability:added:1.0';
const MOD = 'urn:example:lab-mod?module=lab-mod&revision=2024-01-01&features=f1,f2&deviations=lab-dev';
const MOD2 = 'urn:example:other?module=other-mod';

describe('SESS-05 capabilities', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await fixture({ fake: { capabilities: [BASE10, BASE11, STARTUP, MOD, MOD2] } });
    const dir = f.profile({ id: 'lab-test', match: { anyModule: ['lab-mod'] }, capabilities: { add: [ADDED], remove: [STARTUP] } });
    f.home.targets({ router1: f.target({ profilesDir: dir }) });
  });
  afterAll(() => f.close());

  it('AC1: lists every capability the session uses, one per line, after profile corrections', async () => {
    const r = await runNnc(['router1', '-c', 'capabilities'], { home: f.home });
    expect(r.code).toBe(0);
    const lines = r.stdout.trim().split('\n');
    for (const uri of [BASE10, BASE11, MOD, MOD2]) expect(lines).toContain(uri);
    expect(lines).toContain(`${ADDED}  [added by profile]`);
  });

  it('AC2: capabilities added or removed by the profile are marked', async () => {
    const r = await runNnc(['router1', '-c', 'capabilities'], { home: f.home });
    expect(r.stdout).toContain(`${ADDED}  [added by profile]`);
    expect(r.stdout).toContain(`${STARTUP}  [removed by profile]`);
    expect(r.stdout).not.toMatch(new RegExp(`^${BASE10}  \\[`, 'm'));
  });

  it('AC3: lists capability URIs only: --modules is a usage error, and help points to modules', async () => {
    const r = await runNnc(['router1', '-c', 'capabilities --modules'], { home: f.home });
    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/modules/);
    const help = await runNnc(['router1', '-c', 'help capabilities'], { home: f.home });
    expect(help.stdout).toMatch(/YANG modules and features: modules/);
  });

  it('AC4: --json prints the same information as JSON', async () => {
    const caps = await runNnc(['router1', '-c', 'capabilities --json'], { home: f.home });
    const list = JSON.parse(caps.stdout) as { uri: string; origin: string }[];
    expect(list).toContainEqual({ uri: ADDED, origin: 'added by profile' });
    expect(list).toContainEqual({ uri: STARTUP, origin: 'removed by profile' });
    expect(list).toContainEqual({ uri: BASE10, origin: 'device' });
  });

  it('AC5: capabilities sends nothing to the device', async () => {
    await runNnc(['router1', '-c', 'capabilities', '-c', 'capabilities --json'], { home: f.home });
    expect(f.rpcsSent()).toBe(0);
  });
});
