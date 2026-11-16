/**
 * SESS-07: See why a connection failed.
 */
import { createServer, type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { fixture, type Fixture } from './support/fixture.js';
import { knownHostsLine, runNnc } from './support/nnc.js';
import { keyLine, startSshServer, generateKey } from './support/ssh-server.js';

describe('SESS-07 connection failure messages', () => {
  let f: Fixture | undefined;
  afterEach(async () => {
    await f?.close();
    f = undefined;
  });

  it('AC1: an unreachable host names the host, port and network error', async () => {
    f = await fixture();
    const closed = await startSshServer();
    const port = closed.port;
    await closed.close();
    f.home.targets({ router1: f.target({ port }) });
    const r = await runNnc(['-c', 'connect router1'], { home: f.home });
    expect(r.code).toBe(3);
    expect(r.stderr).toBe(`cannot reach 127.0.0.1:${port}: connection refused\n`);
  });

  it('AC1: "cannot reach" is kept for network failures; a server that answers but not with SSH is "connection to … failed"', async () => {
    f = await fixture();
    const web = createServer((sock) => sock.end('HTTP/1.1 400 Bad Request\r\n\r\n', () => sock.destroy()));
    await new Promise<void>((resolve) => web.listen(0, '127.0.0.1', resolve));
    const port = (web.address() as AddressInfo).port;
    try {
      f.home.targets({ router1: f.target({ port, hostKey: 'insecure-accept-any' }) });
      const r = await runNnc(['-c', 'connect router1'], { home: f.home });
      expect(r.code).toBe(3);
      expect(r.stderr).toMatch(new RegExp(`^connection to 127\\.0\\.0\\.1:${port} failed: SSH connection to 127\\.0\\.0\\.1:${port} `));
      expect(r.stderr).not.toContain('cannot reach');
    } finally {
      await new Promise<void>((resolve) => web.close(() => resolve()));
    }
  });

  it('AC2: an authentication failure says so and names the user, without the password', async () => {
    f = await fixture();
    const wrong = f.home.file('wrong.pass', 'not-the-password-xyz\n');
    f.home.targets({ router1: f.target({ password: { file: wrong } }) });
    const r = await runNnc(['-c', 'connect router1'], { home: f.home });
    expect(r.code).toBe(3);
    expect(r.stderr).toBe(`authentication failed for user admin at 127.0.0.1:${f.server.port}\n`);
    expect(r.stderr + r.stdout).not.toContain('not-the-password-xyz');
  });

  it('AC3: a host key that does not match known_hosts shows the received fingerprint and the file; no session opens', async () => {
    f = await fixture();
    const other = keyLine(generateKey().private);
    f.home.knownHosts([knownHostsLine(f.server.port, other.line)]);
    const r = await runNnc(['-c', 'connect router1'], { home: f.home });
    expect(r.code).toBe(3);
    expect(r.stderr).toContain(`not connected: host key for 127.0.0.1:${f.server.port} does not match ${f.home.knownHostsFile}`);
    expect(r.stderr).toContain(`received fingerprint ${f.server.fingerprint}`);
    expect(f.server.authAttempts).toHaveLength(0);
    expect(f.server.last()).toBeUndefined();
  });

  it('AC4: a host not in known_hosts shows the fingerprint and how to add it; no session opens', async () => {
    f = await fixture();
    f.home.knownHosts([]);
    const r = await runNnc(['-c', 'connect router1'], { home: f.home });
    expect(r.code).toBe(3);
    expect(r.stderr).toContain(`not connected: host key for 127.0.0.1:${f.server.port} is not in ${f.home.knownHostsFile}`);
    expect(r.stderr).toContain(`received fingerprint ${f.server.fingerprint}`);
    expect(r.stderr).toContain(`ssh-keyscan -p ${f.server.port} 127.0.0.1 >> ${f.home.knownHostsFile}`);
    expect(f.server.last()).toBeUndefined();
  });

  it('AC4: behind a jump host, the hint scans the device from the jump host; a jump host key is scanned directly', async () => {
    f = await fixture();
    const jump = await startSshServer({ username: 'jumper', password: 'jump-pw', allowForwarding: true });
    try {
      const jumpPass = f.home.file('jump.pass', 'jump-pw\n');
      f.home.targets({
        router1: f.target({ jumpHost: { host: '127.0.0.1', port: jump.port, username: 'jumper', password: { file: jumpPass } } }),
      });
      f.home.knownHosts([knownHostsLine(jump.port, jump.publicKeyLine)]);
      const device = await runNnc(['-c', 'connect router1'], { home: f.home });
      expect(device.code).toBe(3);
      expect(device.stderr).toContain(
        `add it with: ssh -p ${jump.port} jumper@127.0.0.1 ssh-keyscan -p ${f.server.port} 127.0.0.1 >> ${f.home.knownHostsFile}`,
      );

      f.home.knownHosts([knownHostsLine(f.server.port, f.server.publicKeyLine)]);
      const atJump = await runNnc(['-c', 'connect router1'], { home: f.home });
      expect(atJump.code).toBe(3);
      expect(atJump.stderr).toContain(`add it with: ssh-keyscan -p ${jump.port} 127.0.0.1 >> ${f.home.knownHostsFile}`);
    } finally {
      await jump.close();
    }
  });

  it('AC5: a jump host failure says it happened at the jump host and names it', async () => {
    f = await fixture();
    const jump = await startSshServer({ username: 'jumper', password: 'jump-pw', allowForwarding: true });
    try {
      const wrong = f.home.file('jump.pass', 'bad\n');
      f.home.knownHosts([knownHostsLine(f.server.port, f.server.publicKeyLine), knownHostsLine(jump.port, jump.publicKeyLine)]);
      f.home.targets({
        router1: f.target({ jumpHost: { host: '127.0.0.1', port: jump.port, username: 'jumper', password: { file: wrong } } }),
      });
      const r = await runNnc(['-c', 'connect router1'], { home: f.home });
      expect(r.code).toBe(3);
      expect(r.stderr).toBe(`authentication failed at jump host 127.0.0.1:${jump.port} for user jumper\n`);

      const closedJump = await startSshServer();
      const deadPort = closedJump.port;
      await closedJump.close();
      f.home.targets({ router1: f.target({ jumpHost: { host: '127.0.0.1', port: deadPort, username: 'jumper', password: { file: wrong } } }) });
      const dead = await runNnc(['-c', 'connect router1'], { home: f.home });
      expect(dead.code).toBe(3);
      expect(dead.stderr).toBe(`failed at jump host 127.0.0.1:${deadPort}: connection refused\n`);

      // The jump host is fine but can't reach the device: one sentence, naming each once.
      const good = f.home.file('jump-good.pass', 'jump-pw\n');
      f.home.targets({
        router1: f.target({ port: deadPort, jumpHost: { host: '127.0.0.1', port: jump.port, username: 'jumper', password: { file: good } } }),
      });
      const unreachable = await runNnc(['-c', 'connect router1'], { home: f.home });
      expect(unreachable.code).toBe(3);
      expect(unreachable.stderr).toMatch(
        new RegExp(`^failed at jump host 127\\.0\\.0\\.1:${jump.port}: it could not reach 127\\.0\\.0\\.1:${deadPort}( \\([a-z][^)]*\\))?\\n$`),
      );
    } finally {
      await jump.close();
    }
  });

  it('AC6: hello failures say which: no common base version, malformed hello, hello timeout', async () => {
    f = await fixture({ fake: { capabilities: ['urn:ietf:params:netconf:base:2.0'] } });
    const noBase = await runNnc(['-c', 'connect router1'], { home: f.home });
    expect(noBase.code).toBe(3);
    expect(noBase.stderr).toMatch(/^hello exchange failed with 127\.0\.0\.1:\d+: .*base/i);
    await f.close();

    f = await fixture({ fake: { hello: '<hello xmlns="urn:ietf:params:xml:ns:netconf:base:1.0"><capabilities></hello>' } });
    const malformed = await runNnc(['-c', 'connect router1'], { home: f.home });
    expect(malformed.code).toBe(3);
    expect(malformed.stderr).toMatch(/^hello exchange failed with 127\.0\.0\.1:\d+: /);
    await f.close();

    f = await fixture({ fake: { hello: false } }, { timeouts: { hello: 300 } });
    const timeout = await runNnc(['-c', 'connect router1'], { home: f.home });
    expect(timeout.code).toBe(3);
    expect(timeout.stderr).toMatch(/^hello exchange failed: no hello from 127\.0\.0\.1:\d+ \(hello timed out after 300 ms\)/);
  });

  it('AC7: after a failure the prompt stays at nnc> with no session open', async () => {
    f = await fixture();
    f.home.knownHosts([]);
    const r = await runNnc(['-i'], { home: f.home, stdin: 'connect router1\nstatus\n' });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('nnc> nnc> not connected\nnnc> ');
  });
});
