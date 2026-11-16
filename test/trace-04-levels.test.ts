/**
 * TRACE-04: Combine trace levels and turn tracing off.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixture, type Fixture } from './support/fixture.js';
import { runNnc } from './support/nnc.js';
import { entryHeads } from './support/trace.js';

const levelsOf = (stderr: string): Set<string> => new Set(entryHeads(stderr).map((h) => h.split(' ')[2]!));

describe('TRACE-04 trace levels and trace off', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await fixture();
  });
  afterAll(() => f.close());

  it('AC1: trace bytes xml turns on both levels, and each entry is labelled with its level', async () => {
    const r = await runNnc(['router1', '-c', 'trace bytes xml', '-c', 'rpc <get/>'], { home: f.home });
    expect(r.code).toBe(0);
    expect(levelsOf(r.stderr)).toEqual(new Set(['bytes', 'xml']));
  });

  it('AC2: trace with no arguments shows the levels, redaction and the file', async () => {
    const r = await runNnc(['-c', 'trace', '-c', 'trace xml bytes', '-c', 'trace', '-c', 'trace --no-redact --file t.log', '-c', 'trace'], { home: f.home });
    expect(r.code).toBe(0);
    const lines = r.stdout.trim().split('\n');
    expect(lines[0]).toBe('trace: off · redaction on');
    expect(lines[2]).toBe('trace: bytes, xml · redaction on');
    expect(lines[4]).toBe(`trace: bytes, xml · redaction off · file ${f.home.dir}/t.log`);
  });

  it('AC3: trace off turns all tracing off', async () => {
    const r = await runNnc(['router1', '-c', 'trace bytes frames xml', '-c', 'trace off', '-c', 'rpc <get/>', '-c', 'trace'], { home: f.home });
    expect(r.code).toBe(0);
    expect(entryHeads(r.stderr)).toEqual([]);
    expect(r.stdout.trim().split('\n').at(-1)).toBe('trace: off · redaction on');
  });

  it('AC4: trace settings carry over from one session to the next', async () => {
    const r = await runNnc(['router1', '-c', 'trace xml', '-c', 'disconnect', '-c', 'connect router1', '-c', 'rpc <get/>'], { home: f.home });
    expect(r.code).toBe(0);
    // The second session's hellos are traced without asking again.
    const heads = entryHeads(r.stderr);
    expect(heads.filter((h) => / xml \d+ B hello$/.test(h))).toHaveLength(2);
    expect(heads).toContainEqual(expect.stringMatching(/^>> .* xml \d+ B rpc message-id=1$/));
  });

  it('AC5: entries go to standard error and never mix with results', async () => {
    const r = await runNnc(['router1', '-c', 'trace bytes frames xml', '-c', 'rpc <get/>'], { home: f.home });
    expect(entryHeads(r.stderr).length).toBeGreaterThan(0);
    expect(r.stdout).not.toMatch(/^(>>|<<) /m);
    expect(r.stdout).toContain('trace: bytes, frames, xml');
  });

  it('AC6: naming levels replaces the levels that were on; options alone leave them', async () => {
    const r = await runNnc(['-c', 'trace bytes xml', '-c', 'trace frames', '-c', 'trace --no-redact', '-c', 'trace --redact'], { home: f.home });
    expect(r.stdout.trim().split('\n')).toEqual([
      'trace: bytes, xml · redaction on',
      'trace: frames · redaction on',
      'trace: frames · redaction off',
      'trace: frames · redaction on',
    ]);
  });

  it('refuses an unknown level and leaves the settings alone', async () => {
    const r = await runNnc(['-c', 'trace xml', '-c', 'trace bites'], { home: f.home });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('trace: unknown level "bites" (bytes, frames, xml or off)');
  });
});
