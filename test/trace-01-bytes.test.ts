/**
 * TRACE-01: Trace the bytes on the channel.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixture, type Fixture } from './support/fixture.js';
import { runNnc } from './support/nnc.js';
import { BASE10 } from './support/caps.js';
import { drive } from './support/low.js';
import { entryHeads, reply } from './support/trace.js';

const GET = 'rpc "<get-config><source><running/></source></get-config>"';

describe('TRACE-01 trace bytes', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await fixture();
  });
  afterAll(() => f.close());

  it('AC1, AC2: each chunk sent or received is an entry with direction, timestamp in ms and byte count', async () => {
    const r = await runNnc(['router1', '-c', 'trace bytes', '-c', GET], { home: f.home });
    expect(r.code).toBe(0);
    const heads = entryHeads(r.stderr);
    expect(heads.length).toBeGreaterThanOrEqual(2);
    for (const h of heads) expect(h).toMatch(/^(>>|<<) \d\d:\d\d:\d\d\.\d{3} bytes \d+ B: /);
    const sent = heads.find((h) => h.startsWith('>>') && h.includes('get-config'))!;
    const received = heads.find((h) => h.startsWith('<<') && h.includes('rpc-reply'))!;
    expect(sent).toBeDefined();
    expect(received).toBeDefined();
    // The count is the bytes on the wire: the escaped text decodes back to that many bytes.
    const [, count, text] = /bytes (\d+) B: (.*)$/.exec(sent)!;
    expect(Buffer.byteLength(text!.replaceAll('\\n', '\n'))).toBe(Number(count));
    // In the order they happened.
    expect(heads.indexOf(sent)).toBeLessThan(heads.indexOf(received));
  });

  it('AC3: framing appears as on the wire: ]]>]]> on the hellos, chunk headers afterwards', async () => {
    const r = await runNnc(['-c', 'trace bytes', '-c', 'connect router1', '-c', GET], { home: f.home });
    expect(r.code).toBe(0);
    const heads = entryHeads(r.stderr);
    expect(heads.some((h) => h.startsWith('<<') && h.includes('<hello') && h.includes(']]>]]>'))).toBe(true);
    expect(heads.some((h) => h.startsWith('>>') && h.includes('<hello') && h.includes(']]>]]>'))).toBe(true);
    expect(heads.some((h) => h.startsWith('>>') && /: \\n#\d+\\n<\?xml.*get-config.*\\n##\\n$/.test(h))).toBe(true);
  });

  it('AC5: trace bytes before connecting applies from the next connect', async () => {
    const r = await runNnc(['-c', 'trace bytes', '-c', 'connect router1'], { home: f.home });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('trace: bytes');
    // The very first bytes of the session, the hellos, are traced.
    const heads = entryHeads(r.stderr);
    expect(heads[0]).toMatch(/hello/);
  });

  it('AC5: trace bytes works in framed and raw sessions too', async () => {
    const framed = drive([], f.home);
    framed.line('trace bytes');
    framed.line('connect router1 --framed');
    await framed.until('stderr', /<< [^\n]* bytes \d+ B: <\?xml[^\n]*<hello[^\n]*\]\]>\]\]>/);
    framed.line('hello --base 1.0');
    await framed.until('stderr', />> [^\n]* bytes \d+ B: <\?xml[^\n]*<hello[^\n]*\\n\]\]>\]\]>/);
    await framed.finish();

    const raw = drive([], f.home);
    raw.line('trace bytes');
    raw.line('connect router1 --raw');
    await raw.until('stderr', /<< [^\n]* bytes \d+ B: <\?xml[^\n]*<hello/);
    raw.line('send abc\\x01');
    await raw.until('stderr', />> [^\n]* bytes 4 B: abc\\x01\n/);
    await raw.finish();
  });

  it('AC6: the same commands send the same bytes with tracing on or off', async () => {
    const commands = ['-c', GET, '-c', 'rpc <get/>'];
    await runNnc(['-c', 'trace off', '-c', 'connect router1', ...commands], { home: f.home });
    const off = f.server.lastBytes();
    await runNnc(['-c', 'trace bytes frames xml', '-c', 'connect router1', ...commands], { home: f.home });
    const on = f.server.lastBytes();
    expect(on.length).toBeGreaterThan(0);
    expect(on.equals(off)).toBe(true);
  });
});

describe('TRACE-01 AC4: escaping', () => {
  let f: Fixture;
  beforeAll(async () => {
    // End-of-message framing, so stray bytes after a reply sit harmlessly in the buffer.
    f = await fixture({
      fake: {
        capabilities: [BASE10],
        handler: (_rpc, ctx) => {
          ctx.server.sendRaw(`${reply(ctx.messageId, '<data><d>tab\there\r\ncafé \\</d></data>')}]]>]]>`);
          ctx.server.sendRaw(Buffer.from([0x01, 0xff, 0x7f]));
          return undefined;
        },
      },
    });
  });
  afterAll(() => f.close());

  it('control bytes and invalid UTF-8 are \\xHH; newlines, tabs, CR and backslash are escaped; other text is as is', async () => {
    const r = await runNnc(['router1', '-c', 'trace bytes', '-c', 'rpc <get/>'], { home: f.home });
    const heads = entryHeads(r.stderr).filter((h) => h.startsWith('<<'));
    expect(heads.some((h) => h.includes('<d>tab\\there\\r\\ncafé \\\\</d>'))).toBe(true);
    expect(heads.some((h) => h.endsWith(': \\x01\\xff\\x7f'))).toBe(true);
    // Every entry stays on one line.
    for (const h of heads) expect(h).not.toContain('\r');
  });
});

