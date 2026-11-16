/**
 * LOW-05: Open a raw session on the NETCONF subsystem.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fixture, type Fixture } from './support/fixture.js';
import { drive } from './support/low.js';
import { makeHome, runNnc } from './support/nnc.js';
import { startTlsServer, tlsFixture } from './support/tls-server.js';

describe('LOW-05 raw session', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await fixture();
  });
  afterAll(() => f.close());

  it('AC1: connect --raw opens the subsystem and sends nothing; the prompt and message say so, and show eof', async () => {
    const d = drive([], f.home);
    d.line('connect router1 --raw');
    const opened = await d.until('stdout', /nnc router1 \[raw\]> $/);
    expect(opened).toMatch(/opened a raw session to router1 \(127\.0\.0\.1:\d+\) · no framing · nothing sent: bytes go exactly as you give them/);
    await d.until('stderr', /hello/);
    expect(f.server.lastBytes().length).toBe(0);
    d.line('eof');
    await d.until('stdout', /nnc router1 \[raw eof\]> $/);
    await d.finish();
    expect(f.server.lastBytes().length).toBe(0);
  });

  it('AC1: an unknown host key refuses a raw or framed session exactly as it does a client session', async () => {
    const home = makeHome();
    home.knownHosts([]);
    home.targets({ router1: f.target() });
    for (const kind of ['--raw', '--framed']) {
      const r = await runNnc(['router1', kind, '-c', 'status'], { home });
      expect(r.code).toBe(3);
      expect(r.stderr).toContain(`host key for 127.0.0.1:${f.server.port} is not in`);
      expect(r.stderr).toContain(`received fingerprint ${f.server.fingerprint}`);
    }
  });

  it('AC1: framed and raw sessions open over TLS too, through the same certificate checks', async () => {
    const [server, untrusted] = await Promise.all([startTlsServer(), startTlsServer({ untrusted: true })]);
    try {
      const home = makeHome();
      const tls = { transport: 'tls', host: 'localhost', cert: tlsFixture('client.pem'), key: tlsFixture('client.key'), ca: tlsFixture('ca.pem') };
      home.targets({ lab1: { ...tls, port: server.port }, bad: { ...tls, port: untrusted.port } });
      const raw = await runNnc(['lab1', '--raw', '-c', 'status'], { home });
      expect(raw.code).toBe(0);
      expect(raw.stderr).toContain(`opened a raw session to lab1 (localhost:${server.port} over TLS)`);
      expect(raw.stdout).toContain(`server certificate  ${server.fingerprint}`);
      const framed = await runNnc(['lab1', '--framed', '-c', 'status'], { home });
      expect(framed.code).toBe(0);
      expect(framed.stdout).toMatch(/^kind +framed$/m);
      const refused = await runNnc(['bad', '--raw', '-c', 'status'], { home });
      expect(refused.code).toBe(3);
      expect(refused.stderr).toContain(`server certificate check failed for localhost:${untrusted.port}`);
    } finally {
      await Promise.all([server.close(), untrusted.close()]);
    }
  });

  it('AC2: no framing in either direction: bytes are sent and shown exactly as they are', async () => {
    const d = drive(['router1', '--raw'], f.home);
    // The server's hello arrives with its ]]>]]> delimiter, as on the wire.
    await d.until('stderr', /<\/hello>\\n\n\]\]>\]\]>/);
    d.line('send <rpc/>');
    await d.until('stdout', /sent 6 bytes \(raw\)/);
    await vi.waitFor(() => expect(f.server.lastBytes().toString()).toBe('<rpc/>'));
    await d.finish();
  });

  it('AC3: received bytes are printed above the prompt as they arrive, with control and non-UTF-8 bytes as \\xHH', async () => {
    const d = drive(['router1', '--raw'], f.home);
    await d.until('stderr', /\]\]>\]\]>/);
    f.server.last()!.sendRaw(Buffer.from([0x41, 0x01, 0xff, 0x42, 0x0a, 0x43]));
    const shown = await d.until('stderr', /<< 6 bytes\n[^\n]*\n[^\n]*\n/);
    expect(shown).toContain('<< 6 bytes\nA\\x01\\xffB\\n\nC\n');
    await d.finish();
  });

  it('AC4: when the server closes the stream, a message says so and the prompt returns to nnc>', async () => {
    const d = drive(['router1', '--raw'], f.home);
    await d.until('stderr', /\]\]>\]\]>/);
    f.server.last()!.end();
    await d.until('stderr', /raw session to router1 ended: the server closed the stream/);
    await d.until('stdout', /nnc> $/);
    d.line('status');
    await d.until('stdout', /not connected/);
    await d.finish();
  });
});
