/**
 * SAFE-08: Refuse framed and raw sessions on read-only targets.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixture, type Fixture } from './support/fixture.js';
import { runNnc } from './support/nnc.js';
import { entryHeads, sentEntries } from './support/trace.js';

describe('SAFE-08 no low-level sessions on read-only targets', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await fixture({}, { readOnly: true });
  });
  afterAll(() => f.close());

  it('AC1: connect --framed and --raw fail on a read-only target, and no connection is opened', async () => {
    for (const kind of ['framed', 'raw']) {
      const r = await runNnc(['-c', `connect router1 --${kind}`], { home: f.home });
      expect(r.code, kind).toBe(4);
      expect(r.stderr, kind).toBe(
        `connect --${kind}: refused: router1 is read-only, and low-level sessions (framed, raw) aren't allowed on read-only targets; nothing was opened\n`,
      );
    }
    expect(f.server.authAttempts).toHaveLength(0);
  });

  it('AC2: an ad hoc connect with --raw --read-only fails the same way', async () => {
    const r = await runNnc(['-c', `connect admin@127.0.0.1:${f.server.port} --raw --read-only`], { home: f.home });
    expect(r.code).toBe(4);
    expect(r.stderr).toContain("low-level sessions (framed, raw) aren't allowed on read-only targets");
    expect(f.server.authAttempts).toHaveLength(0);
  });

  it('AC3: tracing in a read-only client session is still allowed', async () => {
    const r = await runNnc(['router1', '-c', 'trace bytes xml', '-c', 'get-config running'], { home: f.home });
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/· read-only\n/);
    expect(r.stderr).not.toContain('refused');
    // The get-config itself is traced (not just the close-session at the end), both ways.
    expect(sentEntries(r.stderr).some((h) => h.includes('get-config'))).toBe(true);
    expect(entryHeads(r.stderr).some((h) => h.startsWith('<<') && h.includes('rpc-reply message-id=1'))).toBe(true);
  });
});
