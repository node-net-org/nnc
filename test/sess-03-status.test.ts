/**
 * SESS-03: See the status of the current session.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixture, type Fixture } from './support/fixture.js';
import { runNnc } from './support/nnc.js';

describe('SESS-03 status', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await fixture({ fake: { sessionId: 42 } }, { readOnly: true });
  });
  afterAll(() => f.close());

  it('AC1: shows target, host and port, kind, session-id, base, framing, profile, read-only, host-key fingerprint and time connected', async () => {
    const r = await runNnc(['router1', '-c', 'status'], { home: f.home });
    expect(r.code).toBe(0);
    const out = r.stdout;
    expect(out).toMatch(/^target\s+router1$/m);
    expect(out).toMatch(new RegExp(`^host\\s+127\\.0\\.0\\.1:${f.server.port}$`, 'm'));
    expect(out).toMatch(/^kind\s+client$/m);
    expect(out).toMatch(/^session-id\s+42$/m);
    expect(out).toMatch(/^base\s+1\.1$/m);
    expect(out).toMatch(/^framing\s+chunked$/m);
    expect(out).toMatch(/^profile\s+\(none\)$/m);
    expect(out).toMatch(/^read-only\s+yes$/m);
    expect(out).toContain(`host key    ${f.server.fingerprint}`);
    expect(out).toMatch(/^connected\s+\d{4}-\d\d-\d\dT[\d:.]+Z \(\d+s ago\)$/m);
  });

  it('AC1: base 1.0 sessions report eom framing', async () => {
    const g = await fixture({ fake: { capabilities: ['urn:ietf:params:netconf:base:1.0'] } });
    try {
      const r = await runNnc(['router1', '-c', 'status'], { home: g.home });
      expect(r.stdout).toMatch(/^base\s+1\.0$/m);
      expect(r.stdout).toMatch(/^framing\s+eom$/m);
    } finally {
      await g.close();
    }
  });

  it('AC2: framed and raw sessions show their kind and framing, and leave out session-id and profile', async () => {
    const g = await fixture();
    try {
      const framed = await runNnc(['router1', '--framed', '-c', 'status'], { home: g.home });
      expect(framed.code).toBe(0);
      expect(framed.stdout).toMatch(/^kind\s+framed$/m);
      expect(framed.stdout).toMatch(/^framing\s+eom$/m);
      expect(framed.stdout).toMatch(/^target\s+router1$/m);
      expect(framed.stdout).toContain(`host key   ${g.server.fingerprint}`);
      expect(framed.stdout).not.toMatch(/^(session-id|profile|base)\s/m);
      const raw = await runNnc(['router1', '--raw', '-c', 'status'], { home: g.home });
      expect(raw.code).toBe(0);
      expect(raw.stdout).toMatch(/^kind\s+raw$/m);
      expect(raw.stdout).toMatch(/^framing\s+none \(raw bytes\)$/m);
      expect(raw.stdout).toMatch(/^sending\s+open$/m);
      expect(raw.stdout).not.toMatch(/^(session-id|profile|base)\s/m);
    } finally {
      await g.close();
    }
  });

  it('AC3: with no session open, status prints "not connected"', async () => {
    const r = await runNnc(['-c', 'status'], { home: f.home });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('not connected\n');
  });

  it('AC4: status sends nothing to the device', async () => {
    const r = await runNnc(['router1', '-c', 'status', '-c', 'status'], { home: f.home });
    expect(r.code).toBe(0);
    expect(f.rpcsSent()).toBe(0);
  });
});
