/**
 * PATH-10: Named paths with parameters: @name(value, param=value).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CapabilitySet, compileNamedPath } from '@node-net/netconf';
import { Cli, type CliIo } from '../src/cli.js';
import { createRegistry } from '../src/commands/index.js';
import { createNodeHost } from '../src/node/host.js';
import { completer } from '../src/repl.js';
import type { ActiveSession } from '../src/sessions/active.js';
import { runNnc } from './support/nnc.js';
import { HAS_PTY, plain, runPty } from './support/pty.js';
import { PROFILE, pathFixture, type PathFixture } from './support/path.js';

const PATHS = {
  ...PROFILE.paths,
  ifDescription: '/ietf-interfaces:interfaces/interface[name={{ifName}}]/description',
  interface: '/ietf-interfaces:interfaces/interface[name={{ifName}}]',
  route: '/lab:routes/route[prefix={{prefix}}][next-hop={{nextHop}}]',
};
const PARAMS_PROFILE = { ...PROFILE, id: 'lab-params', paths: PATHS };

describe('PATH-10 named paths with parameters', () => {
  let f: PathFixture;
  beforeAll(async () => {
    f = await pathFixture({ profile: PARAMS_PROFILE });
  });
  afterAll(() => f.close());

  it('AC1: value and read fill in a parameter given by position or by name', async () => {
    const v = await runNnc(['lab1', '-c', 'value @ifDescription(eth1)'], { home: f.home });
    expect(v.stdout.trim()).toBe('spare');
    const named = await runNnc(['lab1', '-c', 'value @ifDescription( ifName = "eth0" )'], { home: f.home });
    expect(named.stdout.trim()).toBe('uplink');
    const entry = await runNnc(['lab1', '-c', 'read @interface(eth0)'], { home: f.home });
    expect(entry.stdout).toContain('<name>eth0</name>');
    expect(entry.stdout).not.toContain('eth1');
  });

  it('AC2: a read that leaves out a whole predicate value reads every entry', async () => {
    const all = await runNnc(['lab1', '-c', 'read @ifDescription'], { home: f.home });
    expect(all.code).toBe(0);
    expect(all.stdout).toContain('uplink');
    expect(all.stdout).toContain('spare');
    const list = await runNnc(['lab1', '-c', 'read @interface()'], { home: f.home });
    expect(list.stdout).toContain('<name>eth0</name>');
    expect(list.stdout).toContain('<name>eth1</name>');
  });

  it('AC3: set and remove need every parameter, and send nothing without one', async () => {
    const set = await runNnc(['lab1', '-c', 'set @ifDescription spare2'], { home: f.home });
    expect(set.code).toBe(2);
    expect(set.stderr).toContain('set: @ifDescription needs ifName: a change must name every list entry it edits; nothing was sent');
    expect(f.rpcsSent()).toBe(0);
    const remove = await runNnc(['lab1', '-c', 'remove @interface'], { home: f.home });
    expect(remove.code).toBe(2);
    expect(f.rpcsSent()).toBe(0);
    const ok = await runNnc(['lab1', '-c', 'set @ifDescription(eth1) spare2'], { home: f.home });
    expect(ok.code).toBe(0);
    const edit = f.sent().find((e) => e.name === 'edit-config')!;
    const iface = edit.child('config')!.elements[0]!.elements[0]!;
    expect(iface.child('name')?.text()).toBe('eth1');
    expect(iface.child('description')?.text()).toBe('spare2');
  });

  it('AC3b: more of the path may follow a named path, as in set @interface(eth1)/description', async () => {
    const v = await runNnc(['lab1', '-c', 'value @interface(eth0)/description'], { home: f.home });
    expect(v.stdout.trim()).toBe('uplink');
    const ok = await runNnc(['lab1', '-c', 'set @interface(eth1)/description spare3'], { home: f.home });
    expect(ok.code).toBe(0);
    const edit = f.sent().filter((e) => e.name === 'edit-config').at(-1)!;
    const iface = edit.child('config')!.elements[0]!.elements[0]!;
    expect(iface.child('name')?.text()).toBe('eth1');
    expect(iface.child('description')?.text()).toBe('spare3');
    const r = await runNnc(['lab1', '-c', 'resolve @interface(eth0)/description'], { home: f.home });
    expect(r.stdout).toContain('(@interface)');
    expect(r.stdout).toContain('description');
  });

  it('AC4: bad arguments fail before anything is sent', async () => {
    for (const [arg, message] of [
      ['@ifDescription(name=eth0)', '@ifDescription has no parameter name (it takes ifName)'],
      ['@ifDescription(eth0,eth1)', '@ifDescription takes ifName, but 2 values were given'],
      ['@systemName(x)', '@systemName takes no parameters'],
    ] as const) {
      const r = await runNnc(['lab1', '-c', `read ${arg}`], { home: f.home });
      expect(r.code, arg).toBe(2);
      expect(r.stderr, arg).toContain(message);
      expect(f.rpcsSent(), arg).toBe(0);
    }
  });

  it('AC5: resolve shows the template, its parameters and the path filled in', async () => {
    const r = await runNnc(['lab1', '-c', 'resolve @ifDescription(eth0)'], { home: f.home });
    expect(r.stdout).toMatch(/^path {2}\/ietf-interfaces:interfaces\/interface\[name="eth0"\]\/description {2}\(@ifDescription\)\n/);
    expect(r.stdout).toContain(`  template  ${PATHS.ifDescription}\n  params    ifName (optional)\n`);
    const json = JSON.parse((await runNnc(['lab1', '-c', 'resolve @ifDescription --json'], { home: f.home })).stdout) as Record<string, unknown>;
    expect(json).toMatchObject({
      path: '/ietf-interfaces:interfaces/interface/description',
      named: 'ifDescription',
      template: PATHS.ifDescription,
      params: [{ name: 'ifName', optional: true }],
    });
  });

  it('AC6: profile lists each named path\'s parameters', async () => {
    const r = await runNnc(['lab1', '-c', 'profile'], { home: f.home });
    expect(r.stdout).toMatch(/^ {2}@ifDescription +\/ietf-interfaces:interfaces\/interface\[name=\{\{ifName\}\}\]\/description\n +params: ifName \(optional\)$/m);
    expect(r.stdout).toMatch(/^ {2}@systemName +\/lab:system\/name\n {2}@interfaces /m);
  });

  it('AC7: Tab completes a named path without a space when it takes parameters, then its parameter names with their =', () => {
    const io: CliIo = { out: () => undefined, err: () => undefined, notice: () => undefined, secret: () => Promise.resolve(undefined) };
    const cli = new Cli(createRegistry(), io, { host: createNodeHost() });
    const templates = new Map(Object.entries(PATHS).map(([n, p]) => [n, compileNamedPath(p)]));
    cli.session = {
      kind: 'client',
      name: 'lab1',
      readOnly: false,
      client: {
        ops: { list: [] },
        profile: { id: 'lab-params', paths: PATHS },
        content: { namedPathTemplate: (n: string) => templates.get(n) },
        session: { serverCapabilities: new CapabilitySet([]) },
      },
    } as unknown as ActiveSession;
    const complete = completer(cli);
    expect(complete('read @ifD')[0]).toEqual(['@ifDescription']);
    expect(complete('read @sys')[0]).toEqual(['@systemName ']);
    // One parameter: completed with its '=', replacing only what is typed after '('.
    expect(complete('read @interface(')).toEqual([['ifName='], '']);
    expect(complete('value @ifDescription(if')).toEqual([['ifName='], 'if']);
    // Several: the names alone are listed.
    expect(complete('read @route(')).toEqual([['prefix=', 'nextHop='], '']);
    expect(complete('read @route(n')).toEqual([['nextHop='], 'n']);
    // Those already given, by name or by position, are left out, with or without a space after the comma.
    expect(complete('read @route(prefix=10.0.0.0/8,')).toEqual([['nextHop='], '']);
    expect(complete('read @route(10.0.0.0/8, ')).toEqual([['nextHop='], '']);
    expect(complete('read @route(nextHop="a,b", ')).toEqual([['prefix='], '']);
    expect(complete('read @interface(ifName=eth0,')).toEqual([[], '']);
    // Nothing while a value is typed, inside a quote, or after the closing ')'.
    expect(complete('read @route(prefix=10')[0]).toEqual([]);
    expect(complete('read @route("10.0')[0]).toEqual([]);
    expect(complete('read @route(a) ')[0]).not.toContain('nextHop=');
    // Not a content command, or an unknown name: no parameters.
    expect(complete('help @route(')[0]).not.toContain('prefix=');
    expect(complete('read @nope(')).toEqual([[], '']);
  });

  it.skipIf(!HAS_PTY)('AC8: at the prompt, Tab inside @name( lists the parameter names, or completes the only one', async () => {
    const typing = (text: string) => [
      { wait: /nnc lab1> $/ },
      ...[...text].map((c) => ({ pause: 20, send: c })),
      { pause: 100, send: '\t' },
      { pause: 200, send: '\t' },
      { pause: 300, send: '\u0015exit\r' },
    ];
    const many = plain(await runPty(['lab1'], typing('read @route('), { home: f.home }));
    expect(many).toMatch(/prefix= +nextHop=/);
    expect(many).not.toContain('@route(prefix=');
    const one = plain(await runPty(['lab1'], typing('read @interface('), { home: f.home }));
    expect(one).toContain('read @interface(ifName=');
  });
});
