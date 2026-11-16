/**
 * SESS-08: `listen <target>` waits for the target's device to call home
 * (RFC 8071) and opens a client session on the call, as `connect` would.
 * The "device" is a test SSH server that dials nnc's listening port.
 */
import { createHash, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { connect as tcp, createServer, type Server, type Socket } from 'node:net';
import { TLSSocket } from 'node:tls';
import { duplexConnection, joinConnections } from '@node-net/netconf';
import { FakeServer } from '@node-net/netconf/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixture, type Fixture } from './support/fixture.js';
import { collect, runNnc, startNnc, waitFor } from './support/nnc.js';
import { generateKey, keyLine, startSshServer, type TestSshServer } from './support/ssh-server.js';
import { tlsFixture } from './support/tls-server.js';

const pem = (name: string): Buffer => readFileSync(tlsFixture(name));
const fingerprintOf = (name: string): string =>
  `SHA256:${createHash('sha256').update(new X509Certificate(pem(name)).raw).digest('base64').replace(/=+$/, '')}`;

/** A TLS device calling home: dial the listener, then serve TLS (server side) and NETCONF over that connection. */
function tlsCallHome(port: number, cert = 'server'): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const raw = tcp(port, '127.0.0.1');
    raw.once('error', reject);
    raw.once('connect', () => {
      raw.on('error', () => undefined);
      const t = new TLSSocket(raw, { isServer: true, cert: pem(`${cert}.pem`), key: pem(`${cert}.key`), requestCert: true, rejectUnauthorized: true, ca: [pem('ca.pem')] });
      t.on('error', () => undefined);
      t.on('secure', () => {
        const fake = new FakeServer();
        joinConnections(duplexConnection(t, { peer: { host: 'test-listener', port: 0 } }), fake.connection);
        t.on('close', () => fake.destroy());
      });
      resolve(raw);
    });
  });
}

/** A port free right now on 127.0.0.1. */
function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

describe('SESS-08 listen for a TLS call home', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await fixture();
    const tls = (extra: object) => ({ transport: 'tls', cert: tlsFixture('client.pem'), key: tlsFixture('client.key'), ...extra });
    f.home.targets({
      // The device's certificate names 127.0.0.1 and is signed by ca.
      byCa: { host: '127.0.0.1', ...tls({ ca: [tlsFixture('ca.pem')] }) },
      // Same chain, but the target is another host: connect would refuse the name, and so does listen.
      wrongName: { host: 'elsewhere.example', ...tls({ ca: [tlsFixture('ca.pem')] }) },
      // Pinned to the other CA's server certificate.
      pinned: { host: 'elsewhere.example', ...tls({ fingerprint: [fingerprintOf('other-server.pem')] }) },
      // By name: the certificate's DNS name, through serverName.
      byName: { host: 'elsewhere.example', ...tls({ ca: [tlsFixture('ca.pem')], serverName: 'localhost' }) },
      // ca and fingerprint together: both must pass, and the name too, as tls() checks a server.
      bothWrongName: { host: 'elsewhere.example', ...tls({ ca: [tlsFixture('ca.pem')], fingerprint: [fingerprintOf('server.pem')] }) },
      anyCert: { host: 'elsewhere.example', ...tls({ insecure: 'insecure-accept-any' }) },
    });
  });
  afterAll(async () => {
    await f.close();
  });

  async function callIn(commands: string[], port: number, certs: string[]) {
    const child = startNnc(commands.flatMap((c) => ['-c', c]), { home: f.home });
    const done = collect(child, undefined, 20_000);
    await waitFor(child, 'stderr', /listening for /);
    for (const cert of certs) await tlsCallHome(port, cert);
    return done;
  }

  it('AC2, AC4: a device whose certificate chains to ca and names the target is the session, over TLS', async () => {
    const port = await freePort();
    const r = await callIn([`listen byCa --port ${port} --address 127.0.0.1`, 'get-config running', 'status'], port, ['server']);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain(`listening for byCa on 127.0.0.1:${port} (tls)`);
    expect(r.stderr).toMatch(/byCa called home from 127\.0\.0\.1:\d+ over TLS · session-id/);
    expect(r.stdout).toMatch(/^transport\s+TLS \(RFC 7589\)$/m);
  });

  it("AC2, AC3: a certificate that doesn't name the target is refused, as connect would refuse it", async () => {
    const port = await freePort();
    const r2 = await callIn([`listen wrongName --port ${port} --address 127.0.0.1 --timeout 3000`], port, ['server']);
    expect(r2.code).not.toBe(0);
    expect(r2.stderr).toMatch(new RegExp(`refused a call from 127\\.0\\.0\\.1:\\d+: unknown device \\(${fingerprintOf('server.pem').replace(/[+/]/g, '\\$&')}\\)`));
    expect(r2.stderr).toContain(`; its certificate doesn't match ca ${tlsFixture('ca.pem')} for elsewhere.example`);
    expect(r2.stderr).toContain('did not call within 3000 ms');
  });

  it('AC2 (review): serverName is the name checked; ca with fingerprint needs the name as well; insecure takes any certificate, with a warning first', async () => {
    let port = await freePort();
    const byName = await callIn([`listen byName --port ${port} --address 127.0.0.1`, 'get-config running'], port, ['server']);
    expect(byName.code).toBe(0);
    expect(byName.stderr).toMatch(/byName called home from/);

    port = await freePort();
    const both = await callIn([`listen bothWrongName --port ${port} --address 127.0.0.1 --timeout 3000`], port, ['server']);
    expect(both.code).not.toBe(0);
    expect(both.stderr).toMatch(/refused a call from .*: unknown device/);

    port = await freePort();
    const any = await callIn([`listen anyCert --port ${port} --address 127.0.0.1`, 'get-config running'], port, ['other-server']);
    expect(any.code).toBe(0);
    expect(any.stderr.indexOf('warning: anyCert is insecure')).toBeLessThan(any.stderr.indexOf('listening for anyCert'));
    expect(any.stderr).toMatch(/anyCert called home from .* · insecure/);
  });

  it('AC2: a fingerprint pin accepts that certificate, whatever its chain', async () => {
    const port = await freePort();
    const r = await callIn([`listen pinned --port ${port} --address 127.0.0.1`, 'get-config running'], port, ['other-server']);
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/pinned called home from 127\.0\.0\.1:\d+ over TLS/);
  });
});

describe('SESS-08 listen for a call home', () => {
  let f: Fixture;
  let impostor: TestSshServer;
  beforeAll(async () => {
    f = await fixture();
    // Same credentials, another host key: it must not be taken for router1.
    impostor = await startSshServer({ hostKey: generateKey().private });
    f.home.targets({
      router1: f.target(),
      ro: f.target({ readOnly: true }),
      anykey: f.target({ hostKey: 'insecure-accept-any' }),
      pinned: f.target({ hostKey: [keyLine(generateKey().private).line, f.server.publicKeyLine] }),
      jumped: f.target({ jumpHost: { host: '127.0.0.1', port: 1, username: 'u', password: { file: f.passwordFile } } }),
    });
  });
  afterAll(async () => {
    await impostor.close();
    await f.close();
  });

  /** Run nnc with `commands`; once it listens, `device` calls it. */
  async function callIn(commands: string[], port: number, devices: TestSshServer[]) {
    const child = startNnc(commands.flatMap((c) => ['-c', c]), { home: f.home });
    const done = collect(child, undefined, 20_000);
    await waitFor(child, 'stderr', /listening for /);
    for (const device of devices) await device.callHome(port);
    return done;
  }

  it('AC1, AC4: waits on the given port, then the call is the session: commands, status and the connect line', async () => {
    const port = await freePort();
    const r = await callIn([`listen router1 --port ${port} --address 127.0.0.1`, 'get-config running', 'status'], port, [f.server]);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain(`listening for router1 on 127.0.0.1:${port} (ssh); Ctrl-C stops waiting`);
    expect(r.stderr).toMatch(/router1 called home from 127\.0\.0\.1:\d+ · session-id \d+ · base:1\.1 · /);
    expect(r.stdout).toMatch(/^host\s+127\.0\.0\.1:\d+ \(called home\)$/m);
    expect(r.stdout).toMatch(new RegExp(`^host key\\s+${f.server.fingerprint.replace(/[+/]/g, '\\$&')}$`, 'm'));
    expect(f.sent().map((op) => op.name)).toEqual(['get-config']);
  });

  it('AC2, AC3: a caller with another host key is refused before any credentials are sent, and the target is still taken', async () => {
    const port = await freePort();
    const before = impostor.authAttempts.length;
    const r = await callIn([`listen router1 --port ${port} --address 127.0.0.1`, 'get-config running'], port, [impostor, f.server]);
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(new RegExp(`refused a call from 127\\.0\\.0\\.1:\\d+: unknown device \\(${impostor.fingerprint.replace(/[+/]/g, '\\$&')}\\)`));
    expect(r.stderr).toContain(`; not the host key ${f.home.dir}/.ssh/known_hosts lists for 127.0.0.1:${f.server.port}`);
    // identify runs before any authentication method is offered: no password reached the impostor.
    expect(impostor.authAttempts.slice(before).filter((a) => a.startsWith('password'))).toEqual([]);
    expect(r.stderr).toMatch(/router1 called home from/);
  });

  it('AC2, AC3: a pinned hostKey takes only a caller with a pinned key, and status shows (pinned)', async () => {
    const port = await freePort();
    const before = impostor.authAttempts.length;
    const r = await callIn([`listen pinned --port ${port} --address 127.0.0.1`, 'status'], port, [impostor, f.server]);
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(new RegExp(`refused a call from 127\\.0\\.0\\.1:\\d+: unknown device \\(${impostor.fingerprint.replace(/[+/]/g, '\\$&')}\\); not the target's pinned hostKey`));
    expect(impostor.authAttempts.slice(before).filter((a) => a.startsWith('password'))).toEqual([]);
    expect(r.stderr).toMatch(/pinned called home from/);
    expect(r.stdout).toMatch(new RegExp(`^host key\\s+${f.server.fingerprint.replace(/[+/]/g, '\\$&')} \\(pinned\\)$`, 'm'));
  });

  it('AC2: hostKey insecure-accept-any takes any caller, with the usual warning', async () => {
    const port = await freePort();
    const r = await callIn([`listen anykey --port ${port} --address 127.0.0.1`, 'status'], port, [impostor]);
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/warning: the host key of 127\.0\.0\.1:\d+ was not verified/);
    expect(r.stderr).toMatch(/anykey called home from .* · insecure/);
    // Said before listening, since anyone who can reach the port could call.
    expect(r.stderr.indexOf("warning: anykey's hostKey is insecure-accept-any")).toBeGreaterThanOrEqual(0);
    expect(r.stderr.indexOf("warning: anykey's hostKey")).toBeLessThan(r.stderr.indexOf('listening for anykey'));
  });

  it('review: a call that is identified but fails its hello leaves nothing in the session taken next', async () => {
    // Same host key as router1 (the shared test key), so it passes identify; then its hello lacks a base capability.
    const broken = await startSshServer({ fake: { hello: '<hello xmlns="urn:ietf:params:xml:ns:netconf:base:1.0"><capabilities><capability>urn:example:BADCALL</capability></capabilities></hello>' } });
    try {
      const port = await freePort();
      const child = startNnc(['-c', `listen router1 --port ${port} --address 127.0.0.1`, '-c', 'hello --raw', '-c', 'status'], { home: f.home });
      const done = collect(child, undefined, 20_000);
      await waitFor(child, 'stderr', /listening for /);
      await broken.callHome(port);
      // Let the broken call fail first, then the good one calls.
      await waitFor(child, 'stderr', /failed: /);
      await f.server.callHome(port);
      const r = await done;
      expect(r.code).toBe(0);
      expect(r.stderr).toMatch(/a call from 127\.0\.0\.1:\d+ failed: /);
      expect(r.stdout).not.toContain('BADCALL');
      expect(r.stdout).toContain('urn:ietf:params:netconf:base:1.1');
    } finally {
      await broken.close();
    }
  });

  it('AC6: Ctrl-C stops waiting with nothing opened', async () => {
    const port = await freePort();
    const child = startNnc(['-c', `listen router1 --port ${port} --address 127.0.0.1`, '-c', 'status'], { home: f.home });
    const done = collect(child, undefined, 20_000);
    await waitFor(child, 'stderr', /listening for /);
    child.kill('SIGINT');
    const r = await done;
    expect(r.code).toBe(130);
    expect(r.stdout).not.toContain('session-id');
    // The port is free again.
    const again = createServer();
    await new Promise<void>((resolve, reject) => {
      again.once('error', reject);
      again.listen(port, '127.0.0.1', () => resolve());
    });
    again.close();
  });

  it('AC4: --read-only (or a read-only target) guards the called-home session', async () => {
    const port = await freePort();
    const r = await callIn([`listen ro --port ${port} --address 127.0.0.1`, 'lock running'], port, [f.server]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/read-only/);
    expect(f.sent()).toEqual([]);
  });

  it('AC6: --timeout stops waiting with nothing opened', async () => {
    const port = await freePort();
    const r = await runNnc(['-c', `listen router1 --port ${port} --address 127.0.0.1 --timeout 300`, '-c', 'status'], { home: f.home });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('listen: router1 did not call within 300 ms; nothing was opened');
    expect(r.stdout).not.toContain('session-id');
  });

  it('AC6: listen while a session is open fails as connect does', async () => {
    const r = await runNnc(['router1', '-c', 'listen router1 --port 1'], { home: f.home });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/already connected to router1 .*disconnect first/);
  });

  it('AC5: a target with a jump host is refused', async () => {
    const r = await runNnc(['-c', 'listen jumped'], { home: f.home });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/listen: target "jumped" goes through a jump host/);
  });

  it('AC7: a port in use fails with a message naming the address and port', async () => {
    const busy: Server = createServer();
    const port = await new Promise<number>((resolve) => busy.listen(0, '127.0.0.1', () => resolve((busy.address() as { port: number }).port)));
    try {
      const r = await runNnc(['-c', `listen router1 --port ${port} --address 127.0.0.1`], { home: f.home });
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain(`listen: cannot listen on 127.0.0.1:${port}: the port is in use`);
    } finally {
      busy.close();
    }
  });
});
