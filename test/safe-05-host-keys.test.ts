/**
 * SAFE-05: Verify device host keys.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRegistry } from '../src/commands/index.js';
import { fixture, type Fixture } from './support/fixture.js';
import { knownHostsLine, runNnc } from './support/nnc.js';
import { keyLine, generateKey } from './support/ssh-server.js';

describe('SAFE-05 host-key verification', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await fixture();
  });
  afterAll(() => f.close());

  it('AC1: by default the key is checked against ~/.ssh/known_hosts and a mismatch or missing entry fails before authentication', async () => {
    f.home.knownHosts([knownHostsLine(f.server.port, keyLine(generateKey().private).line)]);
    const mismatch = await runNnc(['-c', 'connect router1'], { home: f.home });
    expect(mismatch.code).toBe(3);
    expect(mismatch.stderr).toContain(`does not match ${f.home.knownHostsFile}`);
    f.home.knownHosts([]);
    const missing = await runNnc(['-c', 'connect router1'], { home: f.home });
    expect(missing.code).toBe(3);
    expect(missing.stderr).toContain(`is not in ${f.home.knownHostsFile}`);
    expect(f.server.authAttempts).toHaveLength(0);
    f.home.knownHosts([knownHostsLine(f.server.port, f.server.publicKeyLine)]);
    expect((await runNnc(['-c', 'connect router1'], { home: f.home })).code).toBe(0);
  });

  it("AC2: a target's knownHosts names a different known_hosts file", async () => {
    f.home.knownHosts([]);
    const other = f.home.file('lab_known_hosts', `${knownHostsLine(f.server.port, f.server.publicKeyLine)}\n`);
    f.home.targets({ router1: f.target({ knownHosts: other }) });
    const r = await runNnc(['-c', 'connect router1'], { home: f.home });
    expect(r.code).toBe(0);
    f.home.knownHosts([knownHostsLine(f.server.port, f.server.publicKeyLine)]);
    f.home.targets({ router1: f.target() });
  });

  it('AC3: hostKey insecure-accept-any accepts any key, and the connect line warns and shows the fingerprint', async () => {
    f.home.knownHosts([]);
    f.home.targets({ router1: f.target({ hostKey: 'insecure-accept-any' }) });
    const r = await runNnc(['-c', 'connect router1'], { home: f.home });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    const [warning, connected] = r.stderr.split('\n');
    expect(warning).toBe(
      `warning: the host key of 127.0.0.1:${f.server.port} was not verified (hostKey is insecure-accept-any); received fingerprint ${f.server.fingerprint}`,
    );
    expect(connected).toMatch(/ · insecure$/);
  });

  it('AC4: while such a session is open, the prompt shows [insecure]', async () => {
    f.home.targets({ router1: f.target({ hostKey: 'insecure-accept-any' }) });
    const r = await runNnc(['-i'], { home: f.home, stdin: 'connect router1\ndisconnect\n' });
    expect(r.stdout).toContain('nnc router1 [insecure]> ');
    expect(r.stdout).toMatch(/disconnected from router1\nnnc> $/);
    f.home.targets({ router1: f.target() });
    f.home.knownHosts([knownHostsLine(f.server.port, f.server.publicKeyLine)]);
  });

  it('AC5: accepting any key is never the default and no command turns it on', async () => {
    const names = createRegistry().names();
    for (const name of names) {
      const cmd = createRegistry().get(name)!;
      expect(Object.keys(cmd.options).filter((o) => /insecure|host-?key|accept/i.test(o))).toEqual([]);
    }
    f.home.knownHosts([]);
    const r = await runNnc(['-c', 'connect router1'], { home: f.home });
    expect(r.code).toBe(3);
    f.home.knownHosts([knownHostsLine(f.server.port, f.server.publicKeyLine)]);
  });

  it('AC6: hostKey may pin the key: a fingerprint, a key line, or a list with one matching entry connects, and status shows (pinned)', async () => {
    // known_hosts has nothing for the device: the pin alone must be enough.
    f.home.knownHosts([]);
    const other = keyLine(generateKey().private).line;
    for (const pin of [f.server.fingerprint, f.server.publicKeyLine, [other, f.server.fingerprint]]) {
      f.home.targets({ router1: f.target({ hostKey: pin }) });
      const r = await runNnc(['router1', '-c', 'status'], { home: f.home });
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(new RegExp(`^host key\\s+${f.server.fingerprint.replace(/[+/]/g, '\\$&')} \\(pinned\\)$`, 'm'));
      expect(r.stderr).not.toContain('insecure');
    }
    f.home.targets({ router1: f.target() });
    f.home.knownHosts([knownHostsLine(f.server.port, f.server.publicKeyLine)]);
  });

  it('AC6: a pin that does not match is refused before authentication, naming the targets file to update', async () => {
    // Even with a matching known_hosts entry: the pin is the only key accepted.
    const before = f.server.authAttempts.length;
    f.home.targets({ router1: f.target({ hostKey: keyLine(generateKey().private).line }) });
    const r = await runNnc(['-c', 'connect router1'], { home: f.home });
    expect(r.code).toBe(3);
    expect(r.stderr).toBe(
      `not connected: host key for 127.0.0.1:${f.server.port} does not match the target's pinned hostKey\n` +
        `  received fingerprint ${f.server.fingerprint}\n` +
        `  if the key changed legitimately, update hostKey for router1 in ${f.home.targetsFile}\n`,
    );
    expect(f.server.authAttempts.length).toBe(before);
    f.home.targets({ router1: f.target() });
  });
});
