/**
 * SAFE-03: Connect ad hoc to a device that isn't in the targets file.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseAdHoc } from '../src/targets.js';
import { startAgent, type TestAgent } from './support/agent.js';
import { fixture, type Fixture } from './support/fixture.js';
import { generateKey } from './support/ssh-server.js';
import { runNnc } from './support/nnc.js';

const CLIENT_KEY = generateKey();

describe('SAFE-03 ad hoc user@host connections', () => {
  let f: Fixture;
  let agent: TestAgent;
  let addr: string;

  beforeAll(async () => {
    f = await fixture({
      clientPublicKey: CLIENT_KEY.public,
      // The built-in sysrepo-netopeer2 profile matches this module.
      fake: { capabilities: ['urn:ietf:params:netconf:base:1.1', 'urn:sysrepo:plugind?module=sysrepo-plugind'] },
    });
    f.home.targets({});
    agent = await startAgent(f.home.dir, CLIENT_KEY.private);
    addr = `admin@127.0.0.1:${f.server.port}`;
  });
  afterAll(async () => {
    await agent.close();
    await f.close();
  });

  it('AC1: user@host uses port 830, and user@host:port the given port', async () => {
    expect(parseAdHoc('admin@192.0.2.1')).toMatchObject({ host: '192.0.2.1', port: 830, username: 'admin' });
    expect(parseAdHoc('admin@192.0.2.1:2830')).toMatchObject({ host: '192.0.2.1', port: 2830, username: 'admin' });
    const r = await runNnc(['-c', `connect ${addr}`], { home: f.home, stdin: 'secret\n' });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain(`connected to 127.0.0.1 (127.0.0.1:${f.server.port})`);
  });

  it('AC2: with an agent key the device accepts, no password is asked for; otherwise it is prompted for', async () => {
    const viaAgent = await runNnc(['-c', `connect ${addr}`], { home: f.home, env: { SSH_AUTH_SOCK: agent.socket } });
    expect(viaAgent.code).toBe(0);
    expect(viaAgent.stderr).not.toContain('Password');
    expect(agent.signs()).toBeGreaterThan(0);

    const prompted = await runNnc(['-c', `connect ${addr}`], { home: f.home, stdin: 'secret\n' });
    expect(prompted.code).toBe(0);
    expect(prompted.stderr).toContain(`Password for admin@127.0.0.1: `);
    expect(prompted.stdout + prompted.stderr).not.toContain('secret');
  });

  it("AC2: when the agent's key is refused, the password is prompted for and the connection retried", async () => {
    const otherKey = generateKey();
    const other = await startAgent(f.home.dir, otherKey.private);
    try {
      const r = await runNnc(['-c', `connect ${addr}`], { home: f.home, env: { SSH_AUTH_SOCK: other.socket }, stdin: 'secret\n' });
      expect(r.code).toBe(0);
      expect(r.stderr).toContain('Password for admin@127.0.0.1: ');
    } finally {
      await other.close();
    }
  });

  it('AC3: the profile is chosen by auto-detection', async () => {
    const r = await runNnc(['-c', `connect ${addr}`], { home: f.home, stdin: 'secret\n' });
    expect(r.stderr).toContain('profile sysrepo-netopeer2');
  });

  it('AC4: an ad hoc session is read-only only when --read-only is given', async () => {
    const plain = await runNnc([addr, '-c', 'status'], { home: f.home, stdin: 'secret\n' });
    expect(plain.stdout).toMatch(/^read-only\s+no$/m);
    const ro = await runNnc([addr, '--read-only', '-c', 'status'], { home: f.home, stdin: 'secret\n' });
    expect(ro.stdout).toMatch(/^read-only\s+yes$/m);
    const inline = await runNnc(['-c', `connect ${addr} --read-only`], { home: f.home, stdin: 'secret\n' });
    expect(inline.stderr).toMatch(/ · read-only$/m);
  });

  it('AC5: host keys are verified against known_hosts', async () => {
    const saved = f.home.knownHostsFile;
    f.home.knownHosts([]);
    const r = await runNnc(['-c', `connect ${addr}`], { home: f.home, stdin: 'secret\n' });
    expect(r.code).toBe(3);
    expect(r.stderr).toContain(`is not in ${saved}`);
    f.home.knownHosts([`[127.0.0.1]:${f.server.port} ${f.server.publicKeyLine}`]);
  });
});
