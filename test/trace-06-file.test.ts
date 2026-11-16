/**
 * TRACE-06: Write a trace to a file.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixture, type Fixture } from './support/fixture.js';
import { runNnc } from './support/nnc.js';
import { entryHeads } from './support/trace.js';

describe('TRACE-06 trace files', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await fixture();
  });
  afterAll(() => f.close());
  const read = (name: string): string => readFileSync(join(f.home.dir, name), 'utf8');

  it('AC1: trace xml --file writes entries to the file as well as the screen', async () => {
    const r = await runNnc(['router1', '-c', 'trace xml --file ac1.log', '-c', 'rpc <get/>'], { home: f.home });
    expect(r.code).toBe(0);
    const screen = entryHeads(r.stderr);
    const file = entryHeads(read('ac1.log'));
    expect(screen.length).toBeGreaterThan(0);
    expect(file).toEqual(screen);
  });

  it('AC2: --quiet with --file writes entries only to the file', async () => {
    const r = await runNnc(['router1', '-c', 'trace xml --file ac2.log --quiet', '-c', 'rpc <get/>', '-c', 'trace'], { home: f.home });
    expect(r.code).toBe(0);
    expect(entryHeads(r.stderr)).toEqual([]);
    expect(entryHeads(read('ac2.log')).length).toBeGreaterThan(0);
    expect(r.stdout).toContain(`file ${f.home.dir}/ac2.log (quiet)`);
  });

  it('AC2: --quiet without a file is refused', async () => {
    const r = await runNnc(['-c', 'trace xml --quiet'], { home: f.home });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('trace: --quiet needs a trace file (--file <path>)');
  });

  it('AC3: entries in the file have no colour and the same direction, time and size fields', async () => {
    const r = await runNnc(['router1', '-c', 'trace xml --file ac3.log', '-c', 'rpc <get/>'], {
      home: f.home,
      env: { NO_COLOR: undefined, FORCE_COLOR: '1' },
    });
    expect(r.stderr).toContain('\u001b[');
    const text = read('ac3.log');
    expect(text).not.toContain('\u001b[');
    for (const h of entryHeads(text)) expect(h).toMatch(/^(>>|<<) \d\d:\d\d:\d\d\.\d{3} xml \d+ B /);
    expect(entryHeads(text)).toEqual(entryHeads(r.stderr));
  });

  it('AC4: trace off closes the file; later entries are not written', async () => {
    const r = await runNnc(['router1', '-c', 'trace xml --file ac4.log', '-c', 'rpc <get/>', '-c', 'trace off', '-c', 'trace xml', '-c', 'rpc <get/>'], { home: f.home });
    expect(r.code).toBe(0);
    const file = entryHeads(read('ac4.log'));
    expect(file.some((h) => h.includes('message-id=1'))).toBe(true);
    expect(file.some((h) => h.includes('message-id=2'))).toBe(false);
    expect(entryHeads(r.stderr).some((h) => h.includes('message-id=2'))).toBe(true);
  });

  it('AC4: exit and the end of a script close the file with every entry written', async () => {
    const exit = await runNnc(['router1', '-i'], { home: f.home, stdin: 'trace xml --file ac4b.log\nrpc <get/>\nexit\n' });
    expect(exit.code).toBe(0);
    // The close-session exchange happens on the way out and is in the file too.
    expect(read('ac4b.log')).toContain('<close-session/>');
    const script = await runNnc(['router1', '-c', 'trace xml --file ac4c.log', '-c', 'rpc <get/>'], { home: f.home });
    expect(script.code).toBe(0);
    expect(read('ac4c.log')).toContain('<close-session/>');
  });

  it("AC5: a file that can't be opened fails naming it, and the settings are unchanged", async () => {
    const r = await runNnc(['-i'], { home: f.home, stdin: 'trace bytes\ntrace xml --no-redact --file no/such/dir/t.log\ntrace\n' });
    expect(r.stderr).toContain(`trace: cannot open trace file ${f.home.dir}/no/such/dir/t.log: ENOENT`);
    const statuses = r.stdout.split('\n').filter((l) => l.includes('trace: '));
    expect(statuses.at(-1)).toMatch(/trace: bytes · redaction on$/);
    expect(r.stdout).not.toContain('[no-redact]');
  });

  it('AC6: an existing file is appended to, and each session starts with a header line', async () => {
    writeFileSync(join(f.home.dir, 'ac6.log'), 'earlier trace\n');
    await runNnc(['-c', 'trace xml --file ac6.log', '-c', 'connect router1', '-c', 'disconnect', '-c', 'connect router1'], { home: f.home });
    const lines = read('ac6.log').split('\n');
    expect(lines[0]).toBe('earlier trace');
    const headers = lines.filter((l) => l.startsWith('# nnc trace · '));
    expect(headers).toHaveLength(3);
    expect(headers[0]).toMatch(/^# nnc trace · no session · \d{4}-\d\d-\d\dT/);
    expect(headers[1]).toMatch(/^# nnc trace · router1 · /);
    expect(headers[2]).toMatch(/^# nnc trace · router1 · /);
  });
});
