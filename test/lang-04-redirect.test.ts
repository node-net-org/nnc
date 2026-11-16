/**
 * LANG-04: Save a command's result to a file.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Fixture } from './support/fixture.js';
import { CONFIG_XML, LAB, langFixture } from './support/lang.js';
import { runNnc } from './support/nnc.js';

describe('LANG-04 > and >>', () => {
  let f: Fixture;
  const at = (name: string): string => join(f.home.dir, name);
  beforeAll(async () => {
    f = await langFixture();
  });
  afterAll(() => f.close());

  it('AC1: > path writes the result to the file instead of the screen, replacing it', async () => {
    writeFileSync(at('out.xml'), 'old contents that are longer than the new ones '.repeat(10));
    const r = await runNnc(['router1', '-c', 'get-config running > out.xml'], { home: f.home });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(readFileSync(at('out.xml'), 'utf8')).toBe(CONFIG_XML);
  });

  it('AC2: >> path appends', async () => {
    writeFileSync(at('log.xml'), 'first\n');
    const r = await runNnc(['router1', '-c', 'get-config running >> log.xml', '-c', `rpc <ping xmlns="${LAB}"/> >> ~/log.xml`], { home: f.home });
    expect(r.code).toBe(0);
    expect(readFileSync(at('log.xml'), 'utf8')).toBe(`first\n${CONFIG_XML}ok\n`);
  });

  it("AC3: the file gets the result in the command's output format, without colour", async () => {
    const env = { NO_COLOR: undefined, FORCE_COLOR: '1' };
    const r = await runNnc(['router1', '-c', 'trace xml', '-c', 'get-config running --json > out.json', '-c', 'get-config running > out.xml'], {
      home: f.home,
      env,
    });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('\x1b[');
    expect(JSON.parse(readFileSync(at('out.json'), 'utf8'))).toEqual({ 'lab:system': { hostname: 'router1' } });
    expect(readFileSync(at('out.xml'), 'utf8')).toBe(CONFIG_XML);
  });

  it('AC4: a confirmation line names the file and the number of bytes written', async () => {
    const r = await runNnc(['router1', '-c', 'get-config running > out.xml', '-c', 'get-config running >> out.xml'], { home: f.home });
    const bytes = Buffer.byteLength(CONFIG_XML);
    expect(r.stderr).toContain(`wrote ${bytes} bytes to out.xml\nappended ${bytes} bytes to out.xml\n`);
    const prompt = await runNnc(['router1', '-i'], { home: f.home, stdin: 'get-config running > out.xml\n' });
    expect(prompt.stdout).toContain(`nnc router1> wrote ${bytes} bytes to out.xml\n`);
  });

  it("AC5: if the file can't be written, the message names it and the reason, and the result is shown instead", async () => {
    const r = await runNnc(['router1', '-c', 'get-config running > no/such/dir/out.xml'], { home: f.home });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('cannot write no/such/dir/out.xml: ENOENT; the result follows');
    expect(r.stdout).toBe(CONFIG_XML);
  });

  it("AC6: when the command fails, the file isn't created or changed, and the error is shown", async () => {
    writeFileSync(at('kept.xml'), 'kept\n');
    const r = await runNnc(
      ['router1', '-c', 'set on-error continue', '-c', `rpc <fail-please xmlns="${LAB}"/> > kept.xml`, '-c', `rpc <fail-please xmlns="${LAB}"/> > new.xml`],
      { home: f.home },
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('rpc-error: operation-failed');
    expect(readFileSync(at('kept.xml'), 'utf8')).toBe('kept\n');
    expect(existsSync(at('new.xml'))).toBe(false);
  });
});
