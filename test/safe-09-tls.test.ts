/**
 * SAFE-09: Connect to a device over NETCONF-over-TLS (RFC 7589).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeHome, runNnc, type Home } from './support/nnc.js';
import { startTlsServer, tlsFixture, type TestTlsServer } from './support/tls-server.js';

const cert = tlsFixture('client.pem');
const key = tlsFixture('client.key');
const ca = tlsFixture('ca.pem');

describe('SAFE-09 TLS connections', () => {
  let server: TestTlsServer;
  let untrusted: TestTlsServer;
  let silent: TestTlsServer;
  let home: Home;
  const target = (extra: object = {}): object => ({ transport: 'tls', host: 'localhost', port: server.port, cert, key, ca, ...extra });

  beforeAll(async () => {
    [server, untrusted, silent] = await Promise.all([
      startTlsServer(),
      startTlsServer({ untrusted: true }),
      startTlsServer({ closeAfterHandshake: true }),
    ]);
    home = makeHome();
  });
  afterAll(() => Promise.all([server.close(), untrusted.close(), silent.close()]));

  it('AC1: a "transport": "tls" target connects with its client certificate and shows TLS and the server certificate', async () => {
    home.targets({ router2: target({ readOnly: true }) });
    const r = await runNnc(['-c', 'connect router2', '-c', 'status', '-c', 'get-config running'], { home });
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(new RegExp(`^connected to router2 \\(localhost:${server.port} over TLS\\) · session-id 1 · base:1\\.1 · .* · read-only$`, 'm'));
    expect(r.stdout).toMatch(/^transport +TLS \(RFC 7589\)$/m);
    expect(r.stdout).toContain(`server certificate  ${server.fingerprint}`);
    expect(server.last()!.requests.map((q) => q.elements[0]!.name)).toContain('get-config');
  });

  it('AC2: the server certificate must be trusted, name the host and match a pin; failures say what was checked', async () => {
    home.targets({ bad: target({ port: untrusted.port }) });
    const notTrusted = await runNnc(['-c', 'connect bad'], { home });
    expect(notTrusted.code).toBe(3);
    expect(notTrusted.stderr).toContain(`server certificate check failed for localhost:${untrusted.port}`);
    expect(notTrusted.stderr).toContain(`checked against ca ${ca}`);

    home.targets({ wrong: target({ serverName: 'router9' }) });
    const wrongName = await runNnc(['-c', 'connect wrong'], { home });
    expect(wrongName.code).toBe(3);
    expect(wrongName.stderr).toMatch(/server certificate check failed .*router9/s);

    home.targets({ pinned: { transport: 'tls', host: '127.0.0.1', port: untrusted.port, cert, key, fingerprint: untrusted.fingerprint } });
    expect((await runNnc(['-c', 'connect pinned'], { home })).code).toBe(0);
    home.targets({ pinned: { transport: 'tls', host: '127.0.0.1', port: untrusted.port, cert, key, fingerprint: server.fingerprint } });
    const mismatch = await runNnc(['-c', 'connect pinned'], { home });
    expect(mismatch.code).toBe(3);
    expect(mismatch.stderr).toContain("doesn't match the pinned fingerprint");
  });

  it('AC3: "insecure": "insecure-accept-any" connects, warns with the fingerprint, and the prompt shows [insecure]', async () => {
    home.targets({ lab: { transport: 'tls', host: '127.0.0.1', port: untrusted.port, cert, key, insecure: 'insecure-accept-any' } });
    const r = await runNnc(['-i'], { home, stdin: 'connect lab\ndisconnect\n' });
    expect(r.stderr).toContain(
      `warning: the server certificate of 127.0.0.1:${untrusted.port} was not verified (insecure is insecure-accept-any); received fingerprint ${untrusted.fingerprint}`,
    );
    expect(r.stdout).toContain('nnc lab [insecure]> ');
  });

  it('AC4: a refused client certificate, or a close before the hello, is explained and never prompts for a password', async () => {
    home.targets({ router2: target({ cert: tlsFixture('other-client.pem'), key: tlsFixture('other-client.key') }) });
    const refused = await runNnc(['-c', 'connect router2'], { home, stdin: 'secret\n' });
    expect(refused.code).toBe(3);
    expect(refused.stderr).toMatch(/refused the client certificate|before sending its hello/);
    expect(refused.stderr).toContain(`client certificate ${tlsFixture('other-client.pem')}`);
    expect(refused.stdout + refused.stderr).not.toMatch(/password/i);

    home.targets({ unmapped: target({ port: silent.port }) });
    const unmapped = await runNnc(['-c', 'connect unmapped'], { home });
    expect(unmapped.code).toBe(3);
    expect(unmapped.stderr).toContain('cert-to-name');
  });

  it('AC5: connect host[:port] --tls connects ad hoc, and needs --cert, --key and --ca or --fingerprint', async () => {
    const ok = await runNnc(['-c', `connect localhost:${server.port} --tls --cert ${cert} --key ${key} --ca ${ca}`, '-c', 'status'], { home });
    expect(ok.code).toBe(0);
    expect(ok.stderr).toContain(`connected to localhost (localhost:${server.port} over TLS)`);
    const pinned = await runNnc(['-c', `connect 127.0.0.1:${server.port} --tls --cert ${cert} --key ${key} --fingerprint ${server.fingerprint}`], { home });
    expect(pinned.code).toBe(0);

    const noTrust = await runNnc(['-c', `connect localhost:${server.port} --tls --cert ${cert} --key ${key}`], { home });
    expect(noTrust.code).toBe(2);
    expect(noTrust.stderr).toContain('give --ca or --fingerprint');
    const noCert = await runNnc(['-c', `connect localhost --tls --ca ${ca}`], { home });
    expect(noCert.stderr).toContain('--cert and --key are required');
    const withUser = await runNnc(['-c', `connect admin@localhost --tls --cert ${cert} --key ${key} --ca ${ca}`], { home });
    expect(withUser.stderr).toContain('over TLS the client certificate names the user');
    const flagsWithoutTls = await runNnc(['-c', `connect router2 --ca ${ca}`], { home });
    expect(flagsWithoutTls.stderr).toContain('--ca is only used with --tls');
  });

  it('AC6: the targets file checks TLS targets field by field', async () => {
    const check = async (value: object, message: string): Promise<void> => {
      home.targets({ t: value });
      const r = await runNnc(['-c', 'connect t'], { home });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain(message);
    };
    await check({ transport: 'tls', host: 'h', key, ca }, 'field "cert" is required');
    await check({ transport: 'tls', host: 'h', cert, ca }, 'field "key" is required');
    await check({ transport: 'tls', host: 'h', cert, key }, 'field "ca" or fingerprint is required');
    await check({ transport: 'tls', host: 'h', cert, key, ca, insecure: 'insecure-accept-any' }, 'field "insecure" cannot be combined');
    await check({ transport: 'tls', host: 'h', cert, key, ca, username: 'admin' }, 'field "username" is not used by "transport": "tls" targets');
    await check({ transport: 'tls', host: 'h', cert, key, ca, password: { prompt: true } }, 'field "password" is not used');
    await check({ transport: 'tls', host: 'h', cert, key, ca: [] }, 'field "ca" must be');
    await check({ host: 'h', cert }, 'field "cert" is only for "transport": "tls" targets');
    await check({ transport: 'quic', host: 'h' }, 'field "transport" must be "ssh", "tls" or "sim"');
    await check({ transport: 'tls', host: 'h', cert, key, fingerprint: 'nope' }, 'neither SHA256');
  });

  it('AC7: targets lists a TLS target with its address and transport', async () => {
    home.targets({ router2: target() });
    const r = await runNnc(['-c', 'targets'], { home });
    expect(r.stdout).toMatch(new RegExp(`^router2 +localhost:${server.port} \\(TLS\\) `, 'm'));
  });
});
