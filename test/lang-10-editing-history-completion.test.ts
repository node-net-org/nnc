/**
 * LANG-10: Edit commands, recall history and complete with Tab.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BASE_OPERATIONS, CapabilitySet } from '@node-net/netconf';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Cli, type CliIo } from '../src/cli.js';
import { createRegistry } from '../src/commands/index.js';
import { createNodeHost } from '../src/node/host.js';
import { wordBackspace } from '../src/node/line-input.js';
import { completer } from '../src/repl.js';
import type { ActiveSession } from '../src/sessions/active.js';
import { FULL } from './support/caps.js';
import type { Fixture } from './support/fixture.js';
import { runNnc } from './support/nnc.js';
import { outputFixture } from './support/output.js';
import { HAS_PTY, plain, runPty } from './support/pty.js';

const PROMPT = /nnc router1> $/;
const KEY = {
  up: '\u001b[A',
  left: '\u001b[D',
  right: '\u001b[C',
  home: '\u001b[H',
  end: '\u001b[F',
  ctrlA: '\u0001',
  ctrlC: '\u0003',
  ctrlE: '\u0005',
  ctrlG: '\u0007',
  ctrlR: '\u0012',
  ctrlU: '\u0015',
  ctrlW: '\u0017',
  esc: '\u001b',
  backspace: '\u007f',
  ctrlBackspace: '\b',
  tab: '\t',
};
/** A lone Esc is told from an escape sequence by readline's timeout (500 ms). */
const ESC_PAUSE = 700;
/** The output of `status` and of `targets`, each followed by the next prompt. */
const AFTER_STATUS = /^session-id\s+1$[\s\S]*nnc router1> $/m;
const AFTER_TARGETS = /^router1\s+\S*127\.0\.0\.1[\s\S]*nnc router1> $/m;

describe('LANG-10 line editing, history and completion', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await outputFixture();
  });
  afterAll(() => f.close());

  it.skipIf(!HAS_PTY)('AC1: arrows, Home, End, Ctrl-A, Ctrl-E, Ctrl-W, Ctrl-Backspace and Ctrl-U edit the line', async () => {
    const steps = [
      // "tatus", Home, "s", End, Enter → status
      { wait: PROMPT, send: `tatus${KEY.home}s${KEY.end}\r` },
      // "stats", Left, "u", Enter → status
      { wait: PROMPT, send: `stats${KEY.left}u\r` },
      // "argets", Ctrl-A, "t", Ctrl-E, Enter → targets
      { wait: PROMPT, send: `argets${KEY.ctrlA}t${KEY.ctrlE}\r` },
      // "status nonsense", Ctrl-Backspace, Enter → status
      { wait: PROMPT, send: `status nonsense${KEY.ctrlBackspace}\r` },
      // "nonsense words" Ctrl-W Ctrl-U, then "exit"
      { wait: PROMPT, send: `nonsense words${KEY.ctrlW}${KEY.ctrlU}exit\r` },
    ];
    const out = plain(await runPty(['router1'], steps, { home: f.home }));
    expect(out.match(/^session-id\s+1$/gm)).toHaveLength(3);
    expect(out).toMatch(/^router1\s+\S*127\.0\.0\.1/m);
    expect(out).not.toContain('unknown command');
  });

  it('AC1: Ctrl-Backspace (^H) reaches readline as Ctrl-W, except on Windows, where ^H is Backspace', () => {
    const backspace = { sequence: '\b', name: 'backspace', ctrl: false, meta: false, shift: false };
    expect(wordBackspace('\b', backspace, 'linux')).toEqual(['\u0017', { sequence: '\u0017', name: 'w', ctrl: true, meta: false, shift: false }]);
    expect(wordBackspace('\b', backspace, 'darwin')[1]?.name).toBe('w');
    expect(wordBackspace('\b', backspace, 'win32')).toEqual(['\b', backspace]);
    const del = { sequence: '\u007f', name: 'backspace', ctrl: false, meta: false, shift: false };
    expect(wordBackspace('\u007f', del, 'linux')).toEqual(['\u007f', del]);
  });

  it.skipIf(!HAS_PTY)('AC2: Up and Down recall earlier commands, including those from earlier runs', async () => {
    await runNnc(['-i'], { home: f.home, stdin: 'targets\n' });
    const out = plain(await runPty(['router1'], [{ wait: PROMPT, send: `${KEY.up}\r` }, { wait: PROMPT, send: 'exit\r' }], { home: f.home }));
    expect(out).toMatch(/^router1\s+\S*127\.0\.0\.1/m);
  });

  it('AC3: history is kept in ~/.config/net-netconf/history, up to 1000 commands; a multi-line XML command is one entry', async () => {
    const file = f.home.historyFile;
    mkdirSync(join(f.home.dir, '.config', 'net-netconf'), { recursive: true });
    writeFileSync(file, Array.from({ length: 1005 }, (_v, i) => `old ${i}`).join('\n') + '\n');
    await runNnc(['router1', '-i'], { home: f.home, stdin: 'rpc <get>\n<filter/>\n</get>\nstatus\n' });
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1000);
    expect(lines.at(-2)).toBe('rpc <get> <filter/> </get>');
    expect(lines.at(-1)).toBe('status');
    expect(lines[0]).toBe('old 7');
  });

  it('AC4: history lists the recalled commands, numbered', async () => {
    writeFileSync(f.home.historyFile, 'targets\nstatus\n');
    const r = await runNnc(['-c', 'history'], { home: f.home });
    expect(r.stdout).toBe('1  targets\n2  status\n');
  });

  it('AC5: Tab completes command names, options, fixed values, targets after connect, and paths after @, > and >>', () => {
    const io: CliIo = { out: () => undefined, err: () => undefined, notice: () => undefined, secret: () => Promise.resolve(undefined) };
    const offline = new Cli(createRegistry(), io, { host: createNodeHost(), targetsPath: f.home.targetsFile });
    const complete = completer(offline);
    // A single match is completed with a space when another word can follow.
    expect(complete('conn')[0]).toEqual(['connect ']);
    expect(complete('connect r')[0]).toEqual(['ro', 'router1']);
    expect(complete('connect rou')[0]).toEqual(['router1 ']);
    expect(complete('connect router1 --re')[0]).toEqual(['--read-only ']);
    // trace: its levels and options; a partial word narrows them; a level given isn't offered again.
    expect(complete('trace ')[0]).toEqual(['bytes', 'frames', 'xml', 'off', '--redact', '--no-redact', '--file', '--quiet']);
    expect(complete('trace f')[0]).toEqual(['frames ']);
    expect(complete('trace bytes ')[0]).toEqual(['frames', 'xml', 'off', '--redact', '--no-redact', '--file', '--quiet']);
    expect(complete('output j')[0]).toEqual(['json ']);
    // A boolean option that's on by default is offered both ways; given either way, neither is offered again.
    expect(complete('output --')[0]).toEqual(['--page', '--no-page']);
    expect(complete('output --no')[0]).toEqual(['--no-page ']);
    expect(complete('output --no-page ')[0]).toEqual(['xml', 'json', 'raw']);
    // Nothing follows help's command name, so no space.
    expect(complete('help trac')[0]).toEqual(['trace']);
    // help also takes a layer (LANG-11).
    expect(complete('help tran')[0]).toEqual(['transport']);
    expect(complete('help mes')[0]).toEqual(['messages']);
    // Paths are relative to the working directory, as nnc's are.
    const cwd = process.cwd();
    process.chdir(f.home.dir);
    try {
      f.home.file('cfg-one.xml', '<config/>');
      f.home.file('cfg-two.xml', '<config/>');
      expect(complete('edit-config candidate @cfg-')[0]).toEqual(['@cfg-one.xml', '@cfg-two.xml']);
      expect(complete('get-config running > cfg-o')[0]).toEqual(['cfg-one.xml']);
      expect(complete('get-config running >> .con')[0]).toEqual(['.config/']);
      // A redirect's file ends the line; an option's <path> value is a file.
      expect(complete('get-config running > cfg-t')[0]).toEqual(['cfg-two.xml']);
      expect(complete('trace xml --file cfg-t')[0]).toEqual(['cfg-two.xml ']);
    } finally {
      process.chdir(cwd);
    }
    // In a session: operations, their options and fixed values.
    const online = new Cli(createRegistry(), io, { host: createNodeHost() });
    online.session = {
      kind: 'client',
      name: 'router1',
      readOnly: false,
      client: { ops: { list: BASE_OPERATIONS }, session: { serverCapabilities: new CapabilitySet(FULL) } },
    } as unknown as ActiveSession;
    const inSession = completer(online);
    expect(inSession('get-con')[0]).toEqual(['get-config ']);
    expect(inSession('get-config running --filt')[0]).toEqual(['--filter ']);
    expect(inSession('lock ca')[0]).toEqual(['candidate ']);
    expect(inSession('help get-con')[0]).toEqual(['get-config']);
  });

  it.skipIf(!HAS_PTY)('AC6: when several completions match, a second Tab lists them', async () => {
    const steps = [{ wait: PROMPT, send: `c${KEY.tab}${KEY.tab}` }, { pause: 300, send: `${KEY.ctrlU}exit\r` }];
    const out = plain(await runPty(['router1'], steps, { home: f.home }));
    expect(out).toMatch(/cancel-commit\s+capabilities\s+changes\s+commit\s+confirm\s+connect/);
  });

  it.skipIf(!HAS_PTY)('AC6: a second Tab after trace lists its levels and options; one match completes with a space', async () => {
    const steps = [
      { wait: PROMPT, send: `trace ${KEY.tab}${KEY.tab}` },
      { wait: /bytes\s+frames\s+xml\s+off\s+--redact\s+--no-redact\s+--file\s+--quiet/, send: `${KEY.ctrlU}tra${KEY.tab}x${KEY.tab}\r` },
      { wait: PROMPT, send: 'exit\r' },
    ];
    const out = plain(await runPty(['router1'], steps, { home: f.home }));
    expect(out).not.toContain('steps failed');
    // "tra" Tab "x" Tab ran `trace xml `.
    expect(out).toMatch(/trace: xml/i);
  });

  it.skipIf(!HAS_PTY)('AC7: Ctrl-R searches history backwards as you type; Ctrl-R steps older, Backspace shortens, no match says failed', async () => {
    writeFileSync(f.home.historyFile, 'targets\nhelp status\nstatus\nhelp targets\n');
    const steps = [
      { wait: PROMPT, send: `${KEY.ctrlR}help` },
      { wait: /\(reverse-i-search\)`help': help targets/, send: KEY.ctrlR },
      { wait: /\(reverse-i-search\)`help': help status/, send: KEY.ctrlR },
      // Nothing older contains "help": the last match stays on show.
      { wait: /\(failed reverse-i-search\)`help': help status/, send: KEY.backspace },
      // A shorter query searches again from the newest.
      { wait: /\(reverse-i-search\)`hel': help targets/, send: `${KEY.ctrlG}exit\r` },
    ];
    const out = plain(await runPty(['router1'], steps, { home: f.home }));
    expect(out).not.toContain('steps failed');
  });

  it.skipIf(!HAS_PTY)('AC8: Enter runs the match; Esc, arrows and Ctrl-E put it on the line for editing', async () => {
    writeFileSync(f.home.historyFile, 'targetsX\nxstatus\nstatus\n');
    const steps = [
      // Enter runs the match as it is.
      { wait: PROMPT, send: `${KEY.ctrlR}stat` },
      { wait: /reverse-i-search\)`stat': status/, send: '\r' },
      // Esc leaves "targetsX" on the line; End and Backspace make it "targets".
      { wait: AFTER_STATUS, send: `${KEY.ctrlR}targetsX` },
      { wait: /reverse-i-search\)`targetsX': targetsX/, send: KEY.esc },
      { pause: ESC_PAUSE, send: `${KEY.end}${KEY.backspace}\r` },
      // Right arrow leaves the search with the cursor after the match's start: "xstatus" loses its x.
      { wait: AFTER_TARGETS, send: `${KEY.ctrlR}xst` },
      { wait: /reverse-i-search\)`xst': xstatus/, send: `${KEY.right}${KEY.backspace}\r` },
      // Ctrl-E leaves the search at the end of the line: "targetsX" loses its X.
      { wait: AFTER_STATUS, send: `${KEY.ctrlR}getsX` },
      { wait: /reverse-i-search\)`getsX': targetsX/, send: `${KEY.ctrlE}${KEY.backspace}\r` },
      { wait: AFTER_TARGETS, send: 'exit\r' },
    ];
    const out = plain(await runPty(['router1'], steps, { home: f.home }));
    expect(out).not.toContain('steps failed');
    expect(out).not.toContain('unknown command');
  });

  it.skipIf(!HAS_PTY)('AC9: Ctrl-G or Ctrl-C leaves the search and restores the line from before', async () => {
    writeFileSync(f.home.historyFile, 'targets\nstatus\n');
    const steps = [
      // "statu", search for targets, Ctrl-C: "statu" is back with the cursor at its end, so "s" makes "status".
      { wait: PROMPT, send: `statu${KEY.ctrlR}targ` },
      { wait: /reverse-i-search\)`targ': targets/, send: `${KEY.ctrlC}s\r` },
      // The same with Ctrl-G: "target" is back, and "s" makes "targets".
      { wait: AFTER_STATUS, send: `target${KEY.ctrlR}stat` },
      { wait: /reverse-i-search\)`stat': status/, send: `${KEY.ctrlG}s\r` },
      { wait: AFTER_TARGETS, send: 'exit\r' },
    ];
    const out = plain(await runPty(['router1'], steps, { home: f.home }));
    expect(out).not.toContain('steps failed');
    expect(out.match(/^session-id\s+1$/gm)).toHaveLength(1);
    expect(out).not.toContain('unknown command');
  });
});
