/**
 * LANG-01: Type commands with shell-like words, quoting and options.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Fixture } from './support/fixture.js';
import { LAB, langFixture, sentNames } from './support/lang.js';
import { runNnc } from './support/nnc.js';

describe('LANG-01 words, quoting and options', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await langFixture();
  });
  afterAll(() => f.close());

  it('AC1: a command is a name and arguments separated by spaces; extra spaces are ignored', async () => {
    const r = await runNnc(['router1', '-c', '   get-config      running   '], { home: f.home });
    expect(r.code).toBe(0);
    expect(sentNames(f)).toEqual(['get-config']);
    expect(f.sent()[0]!.child('source')!.elements[0]!.name).toBe('running');
  });

  it('AC2: single and double quotes group words, and \\ escapes the next character', async () => {
    f.home.file('my config.xml', `<config><system xmlns="${LAB}"><hostname>a</hostname></system></config>`);
    for (const word of [`'@my config.xml'`, `"@my config.xml"`, '@my\\ config.xml']) {
      const r = await runNnc(['router1', '-c', `edit-config candidate ${word}`], { home: f.home });
      expect(r.stderr).not.toMatch(/error|cannot/);
      expect(r.code).toBe(0);
      expect(f.sent()[0]!.child('config')!.textContent()).toBe('a');
    }
  });

  it('AC3: positional arguments first, then --name value options and --flag alone', async () => {
    const r = await runNnc(['router1', '-c', `edit-config candidate <config/> --default-operation replace`, '-c', 'get-config running --json'], {
      home: f.home,
    });
    expect(r.code).toBe(0);
    expect(f.sent()[0]!.child('default-operation')!.textContent()).toBe('replace');
    expect(JSON.parse(r.stdout.slice(r.stdout.indexOf('{')))).toEqual({ 'lab:system': { hostname: 'router1' } });
  });

  it('AC4: an unterminated quote fails showing where it started; nothing is run', async () => {
    const r = await runNnc(['router1', '-c', "rpc --timeout '500"], { home: f.home });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("unterminated ' starting at column 15");
    expect(sentNames(f)).toEqual([]);
  });

  it('AC5: # starts a comment to the end of the line, except inside quotes or XML', async () => {
    const r = await runNnc(['router1'], {
      home: f.home,
      stdin: [`rpc <ping xmlns="${LAB}">#1</ping>   # a comment`, `set on-error '#2' # another`].join('\n'),
    });
    expect(f.sent()[0]!.textContent()).toBe('#1');
    expect(r.stderr).toContain('set on-error: use continue or stop (got "#2")');
  });

  it('AC6: an empty line, or a line with only a comment, does nothing', async () => {
    const r = await runNnc(['router1'], { home: f.home, stdin: '\n   \n# just a comment\n  # indented\n' });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/^connected to router1 [^\n]*\n$/);
    expect(sentNames(f)).toEqual([]);
  });

  it('AC7: inside [...] quotes are kept as typed, so a YANG path needs no extra quoting', async () => {
    // The path reaches the command with its quotes (and the space inside them): the error quotes it back.
    const r = await runNnc(['router1', '-c', 'resolve /acme:ports/port[name="eth 0"]'], { home: f.home });
    expect(r.stderr).toContain('resolve: Unknown YANG module "acme" in "/acme:ports/port[name=\\"eth 0\\"]"');
    const open = await runNnc(['router1', '-c', 'read /acme:ports/port[name="eth0]'], { home: f.home });
    expect(open.code).toBe(2);
    expect(open.stderr).toMatch(/unterminated " starting at /);
    expect(sentNames(f)).toEqual([]);
  });
});
