/**
 * LANG-02: Enter or paste multi-line XML inline.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Fixture } from './support/fixture.js';
import { LAB, langFixture, prompt, sentNames } from './support/lang.js';
import { collect, runNnc, startNnc } from './support/nnc.js';

const PING = [`rpc <ping xmlns="${LAB}">`, '  <n>1</n>', '</ping>'];

describe('LANG-02 multi-line XML', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await langFixture();
  });
  afterAll(() => f.close());

  it('AC1: an argument starting with < takes the XML, which needs no quoting', async () => {
    const r = await runNnc(['router1', '-c', `rpc <ping xmlns="${LAB}" note='a b c'>x y</ping>`], { home: f.home });
    expect(r.code).toBe(0);
    expect(f.sent()[0]!.attr('note')).toBe('a b c');
    expect(f.sent()[0]!.textContent()).toBe('x y');
  });

  it('AC2: while the XML is unbalanced the prompt is ...> and reading continues', async () => {
    const r = await runNnc(['router1', '-i'], { home: f.home, stdin: `${PING.join('\n')}\n` });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('nnc router1> ...> ...> ok\n');
    expect(f.sent()[0]!.child('n')!.textContent()).toBe('1');
  });

  it('AC3: a pasted multi-line block runs the command once, after the closing tag', async () => {
    const r = await runNnc(['router1', '-i'], { home: f.home, stdin: `${PING.join('\n')}\nget-config running\n` });
    expect(sentNames(f)).toEqual(['ping', 'get-config']);
    expect(r.stdout.split('ok\n')).toHaveLength(2);
  });

  it('AC4: Ctrl-C at ...> abandons the command and returns to the normal prompt; nothing is sent', async () => {
    const child = startNnc(['router1', '-i'], { home: f.home });
    const done = collect(child, undefined);
    let shown = prompt(child, 'nnc router1> ');
    await shown;
    shown = prompt(child, '...> ');
    child.stdin.write(`${PING[0]}\n${PING[1]}\n`);
    await shown;
    shown = prompt(child, 'nnc router1> ');
    child.kill('SIGINT');
    await shown;
    child.stdin.end('status\n');
    const r = await done;
    expect(r.code).toBe(0);
    expect(sentNames(f)).toEqual([]);
    expect(r.stdout).toMatch(/target\s+router1$/m);
  });

  it('AC5: quotes, # and > inside the XML are XML, not command syntax', async () => {
    const xml = `<ping xmlns="${LAB}" a='x>y' b="it's"># not a comment > "quoted"</ping>`;
    const r = await runNnc(['router1', '-c', `rpc ${xml}`], { home: f.home });
    expect(r.code).toBe(0);
    const sent = f.sent()[0]!;
    expect(sent.attr('a')).toBe('x>y');
    expect(sent.attr('b')).toBe("it's");
    expect(sent.textContent()).toBe('# not a comment > "quoted"');
  });

  it('AC6: in a script, multi-line XML follows the same rule', async () => {
    const script = f.home.file('multi.nnc', ['get-config running', ...PING, 'bogus'].join('\n'));
    const r = await runNnc(['router1', '--script', script], { home: f.home });
    expect(r.code).toBe(2);
    expect(sentNames(f)).toEqual(['get-config', 'ping']);
    expect(f.sent()[1]!.child('n')!.textContent()).toBe('1');
    expect(r.stderr).toContain(`${script}:5: unknown command: bogus`);
    const unclosed = f.home.file('unclosed.nnc', `get-config running\n${PING[0]}\n${PING[1]}\n`);
    const open = await runNnc(['router1', '--script', unclosed], { home: f.home });
    expect(open.code).toBe(2);
    expect(open.stderr).toContain(`${unclosed}:2: rpc: the operation isn't well-formed XML`);
    expect(sentNames(f)).toEqual(['get-config']);
  });
});
