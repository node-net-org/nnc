/**
 * LANG-03: Load XML from a file or edit it in my editor.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Fixture } from './support/fixture.js';
import { LAB, editor, editorSaw, langFixture, sentNames } from './support/lang.js';
import { runNnc } from './support/nnc.js';

const ping = (n: number): string => `<ping xmlns="${LAB}"><n>${n}</n></ping>`;

describe('LANG-03 @file and --edit', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await langFixture();
  });
  afterAll(() => f.close());

  it('AC1: @path reads the XML from that file, and ~ is the home directory', async () => {
    f.home.file('ping.xml', ping(7));
    f.home.file('cfg.xml', `<config><system xmlns="${LAB}"><hostname>b</hostname></system></config>`);
    const r = await runNnc(['router1', '-c', 'rpc @~/ping.xml', '-c', 'edit-config candidate @~/cfg.xml', '-c', 'rpc @ping.xml'], { home: f.home });
    expect(r.stderr).not.toMatch(/cannot/);
    expect(r.code).toBe(0);
    expect(sentNames(f)).toEqual(['ping', 'edit-config', 'ping']);
    expect(f.sent()[0]!.child('n')!.textContent()).toBe('7');
    expect(f.sent()[1]!.child('config')!.textContent()).toBe('b');
  });

  it('AC2: a missing or unreadable file fails naming it; nothing is sent', async () => {
    const rpc = await runNnc(['router1', '-c', 'rpc @~/missing.xml'], { home: f.home });
    expect(rpc.code).toBe(2);
    expect(rpc.stderr).toContain('rpc: cannot read ~/missing.xml: ENOENT');
    const edit = await runNnc(['router1', '-c', 'edit-config candidate @nope/cfg.xml'], { home: f.home });
    expect(edit.code).toBe(2);
    expect(edit.stderr).toContain('cannot read nope/cfg.xml: ENOENT');
    expect(sentNames(f)).toEqual([]);
  });

  it('AC3: --edit opens $EDITOR on a temporary file and sends what is saved when it exits', async () => {
    const ed = editor(f, 'ac3', [ping(3)]);
    const r = await runNnc(['router1', '-c', 'rpc --edit'], { home: f.home, env: { EDITOR: ed.command } });
    expect(r.code).toBe(0);
    expect(f.sent()[0]!.child('n')!.textContent()).toBe('3');
    const cfg = editor(f, 'ac3-config', [`<config><system xmlns="${LAB}"><hostname>c</hostname></system></config>`]);
    const config = await runNnc(['router1', '-c', 'edit-config candidate --edit'], { home: f.home, env: { EDITOR: cfg.command } });
    expect(config.code).toBe(0);
    expect(f.sent()[0]!.child('config')!.textContent()).toBe('c');
  });

  it('AC4: the file starts with the XML last sent by the same command this session, or empty the first time', async () => {
    const ed = editor(f, 'ac4', [ping(1), ping(2)]);
    const r = await runNnc(['router1', '-c', 'rpc --edit', '-c', 'rpc --edit', '-c', `rpc ${ping(9)}`, '-c', 'rpc --edit'], {
      home: f.home,
      env: { EDITOR: ed.command },
    });
    expect(r.code).toBe(0);
    expect(editorSaw(ed.log)).toEqual(['', ping(1), ping(9)]);
    expect(f.sent().map((op) => op.child('n')!.textContent())).toEqual(['1', '2', '9', '2']);
  });

  it('AC5: leaving the editor without saving, or with an empty file, cancels with "cancelled"; nothing is sent', async () => {
    for (const [name, writes, status] of [
      ['unsaved', [null], 0],
      ['empty', ['  \n'], 0],
      ['failed', [ping(5)], 1],
    ] as const) {
      const ed = editor(f, name, writes, status);
      const r = await runNnc(['router1', '-c', 'rpc --edit', '-c', 'status'], { home: f.home, env: { EDITOR: ed.command } });
      expect(r.stderr, name).toContain('cancelled');
      expect(r.code, name).toBe(130);
      expect(sentNames(f), name).toEqual([]);
    }
  });
});
