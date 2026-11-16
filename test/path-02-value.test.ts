/**
 * PATH-02: Read a single leaf value.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runNnc } from './support/nnc.js';
import { pathFixture, type PathFixture } from './support/path.js';

describe('PATH-02 value', () => {
  let f: PathFixture;
  beforeAll(async () => {
    f = await pathFixture();
  });
  afterAll(() => f.close());

  it("AC1: value @systemName prints the leaf's text alone on one line, with no XML", async () => {
    const r = await runNnc(['lab1', '-c', 'value @systemName'], { home: f.home });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('router1\n');
  });

  it('AC2: an absent leaf prints nothing on stdout, (not set) on stderr, and exits 0', async () => {
    const r = await runNnc(['lab1', '-c', 'value /lab:system/contact'], { home: f.home });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/^\(not set\)$/m);
  });

  it('AC3: a path matching more than one leaf fails, giving the number of matches', async () => {
    const r = await runNnc(['lab1', '-c', 'value /ietf-interfaces:interfaces/interface/description'], { home: f.home });
    expect(r.code).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('value: the path matches 2 nodes; value needs exactly one leaf');
  });

  it('AC4: --datastore and --state work as for read', async () => {
    await runNnc(['lab1', '-c', 'value @systemName --datastore candidate'], { home: f.home });
    expect(f.sent()[0]!.child('source')?.elements[0]?.name).toBe('candidate');
    const state = await runNnc(['lab1', '-c', 'value /lab:uptime --state'], { home: f.home });
    expect(f.sent()[0]!.name).toBe('get');
    expect(state.stdout).toBe('42\n');
  });
});
