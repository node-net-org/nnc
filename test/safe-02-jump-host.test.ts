/**
 * SAFE-02: Reach a device through a jump host.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixture, type Fixture } from './support/fixture.js';
import { knownHostsLine, runNnc } from './support/nnc.js';
import { startSshServer, type TestSshServer, generateKey } from './support/ssh-server.js';

describe('SAFE-02 jump host', () => {
  let f: Fixture;
  let jump: TestSshServer;
  let jumpTarget: object;

  beforeAll(async () => {
    f = await fixture();
    // The jump host has its own host key, user and password.
    jump = await startSshServer({ username: 'jumper', password: 'jump-pw', allowForwarding: true, hostKey: generateKey().private });
    const jumpPass = f.home.file('jump.pass', 'jump-pw\n');
    f.home.knownHosts([knownHostsLine(f.server.port, f.server.publicKeyLine), knownHostsLine(jump.port, jump.publicKeyLine)]);
    jumpTarget = f.target({ jumpHost: { host: '127.0.0.1', port: jump.port, username: 'jumper', password: { file: jumpPass } } });
    f.home.targets({ router1: jumpTarget });
  });
  afterAll(async () => {
    await jump.close();
    await f.close();
  });

  it('AC1: connects to the jump host first and opens the device connection through it', async () => {
    const r = await runNnc(['-c', 'connect router1'], { home: f.home });
    expect(r.stdout).toBe('');
    expect(r.code).toBe(0);
    expect(jump.forwards).toContain(`127.0.0.1:${f.server.port}`);
    expect(r.stderr).toContain(`connected to router1 (127.0.0.1:${f.server.port} via 127.0.0.1:${jump.port})`);
  });

  it('AC2: the jump host has its own username and authentication, separate from the device', async () => {
    await runNnc(['-c', 'connect router1'], { home: f.home });
    expect(jump.authAttempts).toContain('password:jumper');
    expect(jump.authAttempts).not.toContain('password:admin');
    expect(f.server.authAttempts).toContain('password:admin');
    expect(f.server.authAttempts).not.toContain('password:jumper');
  });

  it("AC3: the jump host's host key is verified like the device's", async () => {
    f.home.knownHosts([knownHostsLine(f.server.port, f.server.publicKeyLine)]);
    const before = jump.authAttempts.length;
    const r = await runNnc(['-c', 'connect router1'], { home: f.home });
    expect(r.code).toBe(3);
    expect(r.stderr).toContain(`failed at jump host 127.0.0.1:${jump.port}: host key for jump host 127.0.0.1:${jump.port} is not in`);
    expect(r.stderr).toContain(`received fingerprint ${jump.fingerprint}`);
    expect(jump.authAttempts.length).toBe(before);
    f.home.knownHosts([knownHostsLine(f.server.port, f.server.publicKeyLine), knownHostsLine(jump.port, jump.publicKeyLine)]);
  });

  it("AC3: a jump host's hostKey may be a pin, checked like the device's", async () => {
    const pass = f.home.file('jump.pass', 'jump-pw\n');
    const hop = (hostKey: unknown) => ({ host: '127.0.0.1', port: jump.port, username: 'jumper', password: { file: pass }, hostKey });
    // No known_hosts entry for the jump host: its pin alone lets it through.
    f.home.knownHosts([knownHostsLine(f.server.port, f.server.publicKeyLine)]);
    f.home.targets({ router1: f.target({ jumpHost: hop(jump.fingerprint) }) });
    expect((await runNnc(['-c', 'connect router1'], { home: f.home })).code).toBe(0);
    f.home.targets({ router1: f.target({ jumpHost: hop(f.server.fingerprint) }) });
    const before = jump.authAttempts.length;
    const r = await runNnc(['-c', 'connect router1'], { home: f.home });
    expect(r.code).toBe(3);
    expect(r.stderr).toBe(
      `failed at jump host 127.0.0.1:${jump.port}: host key for jump host 127.0.0.1:${jump.port} does not match its pinned hostKey\n` +
        `  received fingerprint ${jump.fingerprint}\n` +
        `  if the key changed legitimately, update hostKey of jump host 127.0.0.1:${jump.port} for router1 in ${f.home.targetsFile}\n`,
    );
    expect(jump.authAttempts.length).toBe(before);
    f.home.knownHosts([knownHostsLine(f.server.port, f.server.publicKeyLine), knownHostsLine(jump.port, jump.publicKeyLine)]);
    f.home.targets({ router1: jumpTarget });
  });

  it("AC4: status shows the jump host alongside the device's host and port", async () => {
    const r = await runNnc(['router1', '-c', 'status'], { home: f.home });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`^host\\s+127\\.0\\.0\\.1:${f.server.port} via jump host 127\\.0\\.0\\.1:${jump.port}$`, 'm'));
  });

  describe('chains', () => {
    let first: TestSshServer;
    let chain: object;
    let firstPass: string;
    beforeAll(async () => {
      // first (jumper1) → jump (jumper) → device: two hops, each with its own user, password and host key.
      first = await startSshServer({ username: 'jumper1', password: 'first-pw', allowForwarding: true, hostKey: generateKey().private });
      firstPass = f.home.file('first.pass', 'first-pw\n');
      const jumpPass = f.home.file('jump.pass', 'jump-pw\n');
      chain = f.target({
        jumpHost: [
          { host: '127.0.0.1', port: first.port, username: 'jumper1', password: { file: firstPass } },
          { host: '127.0.0.1', port: jump.port, username: 'jumper', password: { file: jumpPass } },
        ],
      });
    });
    afterAll(() => first.close());
    const allKeys = (): void =>
      f.home.knownHosts([
        knownHostsLine(f.server.port, f.server.publicKeyLine),
        knownHostsLine(jump.port, jump.publicKeyLine),
        knownHostsLine(first.port, first.publicKeyLine),
      ]);

    it('AC5: jumpHost may be a list, connected in order, each hop with its own credentials and host-key check', async () => {
      allKeys();
      f.home.targets({ router1: jumpTarget, chained: chain });
      const r = await runNnc(['-c', 'connect chained'], { home: f.home });
      expect(r.code).toBe(0);
      // first forwards to the second hop, which forwards to the device.
      expect(first.forwards).toContain(`127.0.0.1:${jump.port}`);
      expect(jump.forwards).toContain(`127.0.0.1:${f.server.port}`);
      expect(first.authAttempts).toContain('password:jumper1');
      expect(first.authAttempts).not.toContain('password:jumper');
      expect(jump.authAttempts).toContain('password:jumper');
      // A single object still works as before.
      const single = await runNnc(['-c', 'connect router1'], { home: f.home });
      expect(single.code).toBe(0);
    });

    it('AC6: the connect line, status and targets show every hop in order', async () => {
      allKeys();
      f.home.targets({ chained: chain });
      const r = await runNnc(['chained', '-c', 'status', '-c', 'targets'], { home: f.home });
      expect(r.stderr).toContain(`connected to chained (127.0.0.1:${f.server.port} via 127.0.0.1:${first.port} → 127.0.0.1:${jump.port})`);
      expect(r.stdout).toMatch(new RegExp(`^host\\s+127\\.0\\.0\\.1:${f.server.port} via jump hosts 127\\.0\\.0\\.1:${first.port} → 127\\.0\\.0\\.1:${jump.port}$`, 'm'));
      expect(r.stdout).toMatch(/^chained\s.*via 127\.0\.0\.1 → 127\.0\.0\.1/m);
    });

    it('AC7: a failure names the hop; an unknown key gets a scan through the hops before it; a bad field names the hop', async () => {
      f.home.targets({ chained: chain });
      // The second hop's key is unknown.
      f.home.knownHosts([knownHostsLine(f.server.port, f.server.publicKeyLine), knownHostsLine(first.port, first.publicKeyLine)]);
      const key = await runNnc(['-c', 'connect chained'], { home: f.home });
      expect(key.code).toBe(3);
      expect(key.stderr).toContain(`failed at jump host 127.0.0.1:${jump.port}: host key for jump host 127.0.0.1:${jump.port} is not in`);
      expect(key.stderr).toContain(`ssh -p ${first.port} jumper1@127.0.0.1 ssh-keyscan -p ${jump.port} 127.0.0.1`);

      // The device's key is unknown: the scan goes through both hops.
      f.home.knownHosts([knownHostsLine(first.port, first.publicKeyLine), knownHostsLine(jump.port, jump.publicKeyLine)]);
      const device = await runNnc(['-c', 'connect chained'], { home: f.home });
      expect(device.stderr).toContain(`ssh -J jumper1@127.0.0.1:${first.port} -p ${jump.port} jumper@127.0.0.1 ssh-keyscan -p ${f.server.port} 127.0.0.1`);

      // Authentication refused at the second hop names it and its user.
      allKeys();
      const wrong = f.home.file('wrong.pass', 'nope\n');
      f.home.targets({
        chained: f.target({
          jumpHost: [
            { host: '127.0.0.1', port: first.port, username: 'jumper1', password: { file: firstPass } },
            { host: '127.0.0.1', port: jump.port, username: 'jumper', password: { file: wrong } },
          ],
        }),
      });
      const auth = await runNnc(['-c', 'connect chained'], { home: f.home });
      expect(auth.stderr).toContain(`authentication failed at jump host 127.0.0.1:${jump.port} for user jumper`);

      // A mistake in a hop's fields names it.
      f.home.targets({ chained: f.target({ jumpHost: [{ host: 'jump1' }, { host: 'jump2', username: 7 }] }) });
      const bad = await runNnc(['-c', 'targets'], { home: f.home });
      expect(bad.stderr).toContain('"jumpHost[1].username"');
      f.home.targets({ chained: f.target({ jumpHost: [] }) });
      expect((await runNnc(['-c', 'targets'], { home: f.home })).stderr).toContain('"jumpHost" must be an object, or a non-empty list of them');
    });
  });
});
