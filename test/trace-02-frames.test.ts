/**
 * TRACE-02: Trace whole messages after framing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RpcHandler } from '@node-net/netconf/testing';
import { fixture, type Fixture } from './support/fixture.js';
import { runNnc } from './support/nnc.js';
import { chunked, entryHeads, reply, sendPieces } from './support/trace.js';

/** Lines of stderr from the entry whose header matches, up to the next entry. */
function entry(stderr: string, header: RegExp): string[] {
  const lines = stderr.split('\n');
  const start = lines.findIndex((l) => header.test(l));
  if (start === -1) return [];
  const end = lines.findIndex((l, i) => i > start && /^(>>|<<) \d\d:/.test(l));
  return lines.slice(start, end === -1 ? undefined : end);
}

const handler: RpcHandler = (_rpc, ctx) => {
  const op = ctx.operation?.name;
  if (op === 'pieces') {
    // One reply in three chunks, written as three separate reads.
    const text = reply(ctx.messageId, '<data><v>one-two-three</v></data>');
    const a = text.slice(0, 40);
    const b = text.slice(40, 90);
    const c = text.slice(90);
    void sendPieces(ctx.server, [chunked([a]).slice(0, -4), chunked([b]).slice(0, -4), chunked([c])]);
    return undefined;
  }
  if (op === 'bad-chunk') {
    ctx.server.sendRaw('\n#12x\n<rpc-reply/>\n##\n');
    return undefined;
  }
  if (op === 'not-xml') {
    ctx.server.sendRaw(chunked([`<rpc-reply message-id="${ctx.messageId}"><ok/>`]));
    return undefined;
  }
  return 'ok';
};

describe('TRACE-02 trace frames', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await fixture({ fake: { handler } });
  });
  afterAll(() => f.close());

  it('AC1, AC2: each whole message as text, with direction, time, size and framing', async () => {
    const r = await runNnc(['router1', '-c', 'trace frames', '-c', 'rpc <get/>'], { home: f.home });
    expect(r.code).toBe(0);
    const sent = entry(r.stderr, /^>> .* frames \d+ B chunked$/);
    expect(sent[1]).toMatch(/^<\?xml.*<rpc .*message-id="1"><get\/><\/rpc>$/);
    const [, size] = / frames (\d+) B /.exec(sent[0]!)!;
    expect(Buffer.byteLength(sent[1]!)).toBe(Number(size));
    const got = entry(r.stderr, /^<< .* frames \d+ B chunked$/);
    expect(got[1]).toContain('<rpc-reply');
    for (const h of entryHeads(r.stderr)) expect(h).toMatch(/^(>>|<<) \d\d:\d\d:\d\d\.\d{3} frames \d+ B (eom|chunked)$/);
  });

  it('AC3: a message sent in several chunks appears once, reassembled', async () => {
    const r = await runNnc(['router1', '-c', 'trace frames', '-c', 'rpc <pieces xmlns="urn:example:lab"/>'], { home: f.home });
    expect(r.code).toBe(0);
    const replies = entryHeads(r.stderr).filter((h) => h.startsWith('<<'));
    const matching = r.stderr.split('\n').filter((l) => l.includes('<v>one-two-three</v>'));
    expect(matching).toHaveLength(1);
    expect(replies.length).toBeGreaterThanOrEqual(1);
  });

  it('AC4: the hellos are eom, messages after the switch are chunked', async () => {
    const r = await runNnc(['-c', 'trace frames', '-c', 'connect router1', '-c', 'rpc <get/>'], { home: f.home });
    expect(r.code).toBe(0);
    const heads = entryHeads(r.stderr);
    const hellos = heads.slice(0, 2);
    for (const h of hellos) expect(h).toMatch(/ eom$/);
    expect(heads.slice(2).every((h) => h.endsWith(' chunked'))).toBe(true);
    expect(heads.length).toBeGreaterThan(2);
  });

  it('AC5: a framing error is an entry describing it and the bytes where it was found', async () => {
    const r = await runNnc(['router1', '-c', 'trace frames --no-redact', '-c', 'rpc <bad-chunk xmlns="urn:example:lab"/>'], { home: f.home });
    const err = entryHeads(r.stderr).find((h) => h.includes('framing error'));
    expect(err).toMatch(/^<< .* frames framing error: .*; last bytes: .*\\n#12x/);
  });

  it('AC5: while redacting, the bytes around a framing error are left out (they may be part of a secret)', async () => {
    const r = await runNnc(['router1', '-c', 'trace frames', '-c', 'rpc <bad-chunk xmlns="urn:example:lab"/>'], { home: f.home });
    const err = entryHeads(r.stderr).find((h) => h.includes('framing error'));
    expect(err).toMatch(/^<< .* frames framing error: .*; last bytes hidden while redaction is on \(trace --no-redact shows them\)/);
    expect(err).not.toContain('12x');
  });

  it('AC6: a message that is not well-formed is shown as received', async () => {
    const r = await runNnc(['router1', '-c', 'trace frames', '-c', 'rpc <not-xml xmlns="urn:example:lab"/>'], { home: f.home });
    const got = entry(r.stderr, /^<< .* frames \d+ B chunked$/);
    expect(got[1]).toMatch(/^<rpc-reply message-id="\d+"><ok\/>$/);
  });
});
