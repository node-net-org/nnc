/**
 * LANG-11: Get help on the commands available now.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASE_OPERATIONS } from '@node-net/netconf';
import { firstSentence } from '../src/commands/help-index.js';
import { createRegistry } from '../src/commands/index.js';
import { LAYERS, type SessionKind } from '../src/commands/registry.js';
import { EXTENSIONS } from '../src/sessions/connect.js';
import { FULL } from './support/caps.js';
import { fixture, type Fixture } from './support/fixture.js';
import { block, section, sectionTitles } from './support/help.js';
import { runNnc } from './support/nnc.js';
import { outputFixture } from './support/output.js';
import { pathFixture, type PathFixture } from './support/path.js';

const CONTENT = 'Content layer · client.content';
const OPERATIONS = 'Operations layer · client.ops';
const MESSAGES = 'Messages layer · client.session';

/** The names help lists in a section, in order (without the * mark). */
const names = (text: string): string[] => [...text.matchAll(/^ {2,4}(\S+(?: on-error)?)(?: \*)? {2,}\S/gm)].map((m) => m[1]!);

describe('LANG-11 help', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await outputFixture();
  });
  afterAll(() => f.close());

  it('AC1: help with no session lists the commands available before connecting', async () => {
    const r = await runNnc(['-c', 'help'], { home: f.home });
    expect(r.stdout).toMatch(/^commands with no session open:\n/);
    for (const name of ['connect', 'targets', 'trace', 'output', 'history', 'help', 'exit']) expect(r.stdout).toMatch(new RegExp(`^  ${name} +\\S`, 'm'));
    expect(r.stdout).not.toMatch(/^ {2,4}get-config /m);
    expect(sectionTitles(r.stdout)).toEqual(['Connection', 'nnc']);
  });

  it('AC2: in a session, help lists its commands by RFC 6241 layer, top-down, then device, connection and nnc, in a set order', async () => {
    const r = await runNnc(['router1', '-c', 'help'], { home: f.home });
    expect(sectionTitles(r.stdout)).toEqual([CONTENT, OPERATIONS, MESSAGES, 'Device profile', 'Connection', 'nnc']);
    // Content: path commands, then (after a blank line) the transaction commands in the order they are used.
    expect(section(r.stdout, CONTENT).split('\n\n').map(names)).toEqual([
      ['read', 'value', 'set', 'remove', 'resolve', 'diff', 'datastores', 'modules', 'namespaces'],
      ['begin', 'changes', 'apply', 'confirm', 'revert', 'abandon'],
    ]);
    expect(names(section(r.stdout, MESSAGES))).toEqual(['hello', 'capabilities', 'rpc', 'notifications']);
    expect(names(section(r.stdout, 'Connection'))).toEqual(['connect', 'listen', 'disconnect', 'status', 'targets']);
    expect(names(section(r.stdout, 'nnc'))).toEqual(['output', 'show-last', 'trace', 'set on-error', 'history', 'help', 'exit']);
    expect(section(r.stdout, MESSAGES)).toMatch(/^ {2}rpc +Send any operation/m);
    expect(section(r.stdout, 'Connection')).toMatch(/^ {2}connect +Open a session/m);
    // The lower layer's own commands are in framed and raw sessions.
    const framed = await runNnc(['router1', '--framed', '-c', 'help'], { home: f.home });
    expect(sectionTitles(framed.stdout)).toEqual(['Transport layer · framed messages', 'Connection', 'nnc']);
    expect(names(section(framed.stdout, 'Transport layer · framed messages'))).toEqual(['hello', 'send', 'framing', 'server-hello', 'show']);
    const raw = await runNnc(['router1', '--raw', '-c', 'help'], { home: f.home });
    expect(sectionTitles(raw.stdout)).toEqual(['Transport layer · bytes', 'Connection', 'nnc']);
    expect(names(section(raw.stdout, 'Transport layer · bytes'))).toEqual(['send', 'send-hex', 'send-file', 'eof', 'received']);
  });

  it('AC3: help <command> shows usage, description, arguments, options with types, defaults and allowed values, and an example', async () => {
    const output = await runNnc(['-c', 'help output'], { home: f.home });
    expect(output.stdout).toMatch(/^usage: output \[<format>\] \[--page\]\n\nSet the default output format/);
    expect(output.stdout).toContain('arguments:\n  <format>  xml, json or raw; in a raw session, text or hex (optional)');
    expect(output.stdout).toContain('--page  page long results on a terminal (--no-page: never) (on/off (--no-page); default on)');
    expect(output.stdout).toContain('example: output json --no-page');
    const op = await runNnc(['router1', '-c', 'help lock'], { home: f.home });
    expect(op.stdout).toMatch(/^usage: lock <target>/);
    expect(op.stdout).toMatch(/<target> .*one of running, candidate, startup/);
    expect(op.stdout).toContain('--timeout <ms>');
    expect(op.stdout).toContain('example: lock running');
  });

  it('AC4: help for an unknown command says so and suggests the closest name', async () => {
    const r = await runNnc(['router1', '-c', 'help get-confg'], { home: f.home });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('help: unknown command get-confg (did you mean get-config?)');
    const typed = await runNnc(['-c', 'targts'], { home: f.home });
    expect(typed.stderr).toContain('unknown command: targts (did you mean targets?)');
  });

  it('AC5: every command that changes state is marked, content commands included, and the mark is explained', async () => {
    const r = await runNnc(['router1', '-c', 'help'], { home: f.home });
    expect(r.stdout).toMatch(/^ {4}edit-config \* +\S/m);
    expect(r.stdout).toMatch(/^ {4}get-config {3,}\S/m);
    const marked = [...section(r.stdout, CONTENT).matchAll(/^ {2}(\S+) \*/gm)].map((m) => m[1]);
    expect(marked).toEqual(['set', 'remove', 'apply', 'confirm', 'revert']);
    expect(r.stdout).toContain('\n* changes state; refused on read-only targets.\n');
    expect(r.stdout).not.toContain('is read-only: commands marked * are refused.');
    const op = await runNnc(['router1', '-c', 'help edit-config'], { home: f.home });
    expect(op.stdout).toContain('changes state: yes');
    const ro = await runNnc(['ro', '-c', 'help'], { home: f.home });
    expect(ro.stdout).toContain('ro is read-only: commands marked * are refused.');
  });

  it('AC6: operations are listed under their extension with its RFCs, base first; missing capabilities listed apart', async () => {
    // Every extension's capabilities but partial-lock's.
    const ext = await fixture({
      fake: {
        capabilities: [
          ...FULL,
          'urn:ietf:params:netconf:capability:yang-library:1.1?revision=2019-01-04&content-id=1',
          'urn:ietf:params:xml:ns:yang:ietf-netconf-monitoring?module=ietf-netconf-monitoring&revision=2010-10-04',
          'urn:ietf:params:netconf:capability:notification:1.0',
          'urn:ietf:params:xml:ns:yang:ietf-subscribed-notifications?module=ietf-subscribed-notifications&revision=2019-09-09',
          'urn:ietf:params:xml:ns:yang:ietf-yang-push?module=ietf-yang-push&revision=2019-09-09&features=on-change',
          'urn:ietf:params:xml:ns:yang:ietf-netconf-nmda?module=ietf-netconf-nmda&revision=2019-01-07',
        ],
      },
    });
    ext.home.targets({ router1: ext.target() });
    const r = await runNnc(['router1', '-c', 'help'], { home: ext.home });
    await ext.close();
    const headings = [...section(r.stdout, OPERATIONS).matchAll(/^ {2}(\S.*)$/gm)].map((m) => m[1]);
    expect(headings[0]).toBe('base · RFC 6241');
    expect(headings).toEqual(
      expect.arrayContaining(['monitoring · RFC 6022', 'nmda · RFC 8526', 'notifications · RFC 5277', 'subscriptions · RFC 8639, 8641', 'compare · RFC 9144']),
    );
    expect(names(block(r.stdout, 'base · RFC 6241'))).toEqual(BASE_OPERATIONS.filter((d) => d.name !== 'close-session').map((d) => d.name));
    expect(names(block(r.stdout, 'nmda · RFC 8526'))).toEqual(['get-data', 'edit-data']);
    // The index shows an operation's first sentence; help <operation> shows all of it.
    expect(block(r.stdout, 'notifications · RFC 5277')).toMatch(/^ {4}create-subscription +Subscribe to an event stream \(RFC 5277\)$/m);
    // Without a capability an operation is listed apart, with what it needs (FULL lacks partial-lock).
    expect(headings.at(-1)).toBe('not available on router1 (missing capabilities)');
    expect(block(r.stdout, 'not available on router1 (missing capabilities)')).toMatch(/^ {4}partial-lock \* +needs \S*partial-lock/m);
  });

  it('AC7: set is listed for each use: set <path> under content in client sessions, set on-error with nnc everywhere', async () => {
    const client = await runNnc(['router1', '-c', 'help'], { home: f.home });
    expect(section(client.stdout, CONTENT)).toMatch(/^ {2}set \* +Set a value at a path or @name/m);
    expect(section(client.stdout, 'nnc')).toMatch(/^ {2}set on-error +Whether a script goes on after a failed command/m);
    for (const args of [[], ['router1', '--framed'], ['router1', '--raw']]) {
      const r = await runNnc([...args, '-c', 'help'], { home: f.home });
      expect(r.stdout).toMatch(/^ {2}set on-error +\S/m);
      expect(r.stdout).not.toMatch(/^ {2}set(?: \*)? {2,}/m);
    }
  });

  it('AC8: help <layer> shows just that section, or says which session kinds have it', async () => {
    const full = await runNnc(['router1', '-c', 'help'], { home: f.home });
    for (const [layer, title] of [
      ['content', CONTENT],
      ['operations', OPERATIONS],
      ['messages', MESSAGES],
    ] as const) {
      const r = await runNnc(['router1', '-c', `help ${layer}`], { home: f.home });
      expect(r.code).toBe(0);
      expect(r.stdout.split('\n')[0]).toBe(title);
      expect(names(r.stdout)).toEqual(names(section(full.stdout, title)));
    }
    const transport = await runNnc(['router1', '-c', 'help transport'], { home: f.home });
    expect(transport.stdout).toBe(
      'no transport-layer commands in a client session; they are in framed and raw sessions (connect --framed or connect --raw)\n',
    );
    const framed = await runNnc(['router1', '--framed', '-c', 'help transport', '-c', 'help content'], { home: f.home });
    expect(framed.stdout).toMatch(/^Transport layer · framed messages\n {2}hello +Send a client <hello>/);
    expect(framed.stdout).toContain('no content-layer commands in a framed session; they are in client sessions (connect <target>)');
    const none = await runNnc(['-c', 'help operations'], { home: f.home });
    expect(none.stdout).toBe('no operations-layer commands with no session open; they are in client sessions (connect <target>)\n');
    expect(full.stdout).toContain('help <command> describes one; help content|operations|messages|transport shows one layer.');
  });

  it('AC8: no command or operation is named after a layer, so help <layer> never hides one', () => {
    const descriptors = [...BASE_OPERATIONS, ...EXTENSIONS.flatMap((e) => ('descriptors' in e ? (e.descriptors ?? []) : []))];
    const taken = [...createRegistry().names(), ...descriptors.map((d) => d.name)];
    expect(taken.filter((n) => (LAYERS as readonly string[]).includes(n))).toEqual([]);
  });

  it('AC9: every command available in a session kind appears in that kind\'s help', async () => {
    const registry = createRegistry();
    const runs: [SessionKind, string[]][] = [
      ['none', []],
      ['client', ['router1']],
      ['framed', ['router1', '--framed']],
      ['raw', ['router1', '--raw']],
    ];
    for (const [kind, args] of runs) {
      const r = await runNnc([...args, '-c', 'help'], { home: f.home });
      for (const cmd of registry.available(kind)) expect(r.stdout, `${cmd.name} in a ${kind} session`).toMatch(new RegExp(`^ {2}${cmd.name}\\b`, 'm'));
    }
  });
});

describe('LANG-11 the index shows the first sentence of a description', () => {
  it('ends a sentence at a full stop before a capital, not at an abbreviation', () => {
    expect(firstSentence('Subscribe to an event stream (RFC 5277). Run from a descriptor, this only sends the RPC')).toBe('Subscribe to an event stream (RFC 5277)');
    expect(firstSentence('Run a CLI command, e.g. show version. Needs admin')).toBe('Run a CLI command, e.g. show version');
    expect(firstSentence('One sentence only.')).toBe('One sentence only');
    expect(firstSentence('No full stop')).toBe('No full stop');
  });
});

describe('LANG-11 help with a device profile', () => {
  let p: PathFixture;
  beforeAll(async () => {
    p = await pathFixture();
  });
  afterAll(() => p.close());

  it("AC6: the device profile's operations are listed with the operations, as device <operation> under the profile's name", async () => {
    const r = await runNnc(['lab1', '-c', 'help'], { home: p.home });
    const ops = section(r.stdout, OPERATIONS);
    expect(ops).toMatch(/^ {2}device · profile lab-test\n {4}device +list the profile's operations and their parameters\n {4}device show +Run a show command\n {4}device reboot \* +Reboot the device$/m);
    // The profile section has profile, and no operations.
    const profile = section(r.stdout, 'Device profile');
    expect(profile).toMatch(/^ {2}profile +Show the device profile in use/m);
    expect(profile).not.toMatch(/^ +device/m);
  });

  it('AC9: with no profile in use, device is still listed', async () => {
    const r = await runNnc(['plain1', '-c', 'help'], { home: p.home });
    expect(section(r.stdout, OPERATIONS)).toMatch(/^ {2}device · no device profile in use\n {4}device +no operations to list or run$/m);
  });
});
