/**
 * PATH-13: `diff` shows how two configuration datastores differ, compared in
 * nnc with the device's YANG schema (client.content.compareDatastores), as a
 * compact diff or JSON. The schema comes from the target's yang.modules: the
 * @node-net/netconf JSON fixtures ex-edit (ordered-by-user list and leaf-list) and
 * ex-json (a keyed list).
 */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NETCONF_NS, parseXml, type XmlElement } from '@node-net/netconf';
import type { RpcHandler } from '@node-net/netconf/testing';
import { BARE, FULL } from './support/caps.js';
import { fixture, type Fixture } from './support/fixture.js';
import { runNnc } from './support/nnc.js';

const MODULES = fileURLToPath(new URL('fixtures/yang/json/', import.meta.url));
const EE = 'urn:example:edit';
const EJ = 'urn:example:json';
const MODS = [`${EE}?module=ex-edit&revision=2026-11-09`, `${EJ}?module=ex-json&revision=2026-11-09`];

const RUNNING =
  `<sys xmlns="${EE}"><host>a</host><mtu>1500</mtu>` +
  `<user><name>x</name><uid>1</uid></user><user><name>y</name></user>` +
  `<dns>1</dns><dns>2</dns></sys>` +
  `<top xmlns="${EJ}"><item><name>a</name></item></top>`;
const CANDIDATE =
  `<sys xmlns="${EE}"><host>b</host>` +
  `<user><name>y</name></user><user><name>x</name><uid>2</uid></user><user><name>z</name></user>` +
  `<dns>2</dns><dns>1</dns><dns>3</dns></sys>` +
  `<top xmlns="${EJ}"><item><name>a</name></item><item><name>b</name><count>5</count></item></top>`;

let stores: Record<string, string> = { running: RUNNING, candidate: CANDIDATE, startup: RUNNING };
const sourceOf = (op: XmlElement): string => op.child('source', NETCONF_NS)!.elements[0]!.name;
const handler: RpcHandler = (_rpc, ctx) =>
  ctx.operation?.name === 'get-config' ? { data: parseXml(`<data xmlns="${NETCONF_NS}">${stores[sourceOf(ctx.operation)] ?? ''}</data>`).elements } : 'ok';

const EXPECTED = [
  "~ replace  /ex-edit:sys/host   a → b",
  "> move     /ex-edit:sys/user[name='y']   first",
  "+ create   /ex-edit:sys/user[name='z']   after /ex-edit:sys/user[name='x']",
  '    {',
  '      "name": "z"',
  '    }',
  "~ replace  /ex-edit:sys/user[name='x']/uid   1 → 2",
  "> move     /ex-edit:sys/dns[.='2']   first",
  "+ create   /ex-edit:sys/dns[.='3']   after /ex-edit:sys/dns[.='1']   3",
  '- delete   /ex-edit:sys/mtu   1500',
  "+ create   /ex-json:top/item[name='b']",
  '    {',
  '      "name": "b",',
  '      "count": "5"',
  '    }',
  '8 changes (running → candidate)',
  '',
].join('\n');

describe('PATH-13 diff', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await fixture({ fake: { capabilities: [...FULL, ...MODS], handler } });
    f.home.targets({ router1: f.target({ yang: { modules: [MODULES] } }), ro: f.target({ yang: { modules: [MODULES] }, readOnly: true }) });
  });
  afterAll(async () => {
    await f.close();
  });

  const run = (target: string, ...cmds: string[]) => runNnc([target, ...cmds.flatMap((c) => ['-c', c])], { home: f.home });

  it('AC1, AC4, AC5: plain diff shows running → candidate: one line per change, leaves inline, entries as JSON, positions, a count', async () => {
    stores = { running: RUNNING, candidate: CANDIDATE };
    const r = await run('router1', 'diff');
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(EXPECTED);
    expect(f.sent().map((op) => `${op.name} ${sourceOf(op)}`)).toEqual(['get-config running', 'get-config candidate']);
  });

  it('AC1: it sends no edit, so it runs on a read-only target', async () => {
    stores = { running: RUNNING, candidate: CANDIDATE };
    const r = await run('ro', 'diff');
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(EXPECTED);
  });

  it('AC2: --source and --target pick the datastores; anything else is a usage error and nothing is sent', async () => {
    stores = { running: RUNNING, startup: CANDIDATE };
    const r = await run('router1', 'diff --source startup --target running');
    expect(r.code).toBe(0);
    expect(r.stdout.split('\n').at(-2)).toBe('8 changes (startup → running)');
    expect(f.sent().map(sourceOf)).toEqual(['startup', 'running']);

    const bad = await run('router1', 'diff --target operational');
    expect(bad.code).not.toBe(0);
    expect(bad.stderr).toContain('--target must be one of running, candidate, startup');
    expect(f.rpcsSent()).toBe(0);
  });

  it('AC5: identical datastores say no differences; one change is singular', async () => {
    stores = { running: RUNNING, candidate: RUNNING };
    expect((await run('router1', 'diff')).stdout).toBe('no differences (running → candidate)\n');
    stores = { running: RUNNING, candidate: RUNNING.replace('<host>a</host>', '<host>c</host>') };
    expect((await run('router1', 'diff')).stdout).toBe('~ replace  /ex-edit:sys/host   a → c\n1 change (running → candidate)\n');
  });

  it('AC3: a path limits both reads to the filter read sends for it', async () => {
    stores = { running: RUNNING, candidate: CANDIDATE };
    const r = await run('router1', 'diff /ex-edit:sys/host');
    expect(r.code).toBe(0);
    const filters = f.sent().map((op) => op.child('filter', NETCONF_NS));
    expect(filters).toHaveLength(2);
    for (const filter of filters) {
      expect(filter?.attr('type')).toBe('subtree');
      expect(filter?.path('sys/host')).toBeDefined();
    }
  });

  it('AC3: a bad path or an unknown module is reported and nothing is sent', async () => {
    const bad = await run('router1', 'diff ex-edit:sys');
    expect(bad.code).not.toBe(0);
    expect(bad.stderr).toContain('nothing was sent');
    expect(f.rpcsSent()).toBe(0);
    const unknown = await run('router1', 'diff /nope:sys');
    expect(unknown.code).not.toBe(0);
    expect(unknown.stderr).toContain('nope');
    expect(f.rpcsSent()).toBe(0);
  });

  it('AC6: device text is escaped, so a value cannot add lines or control sequences', async () => {
    stores = { running: RUNNING, candidate: RUNNING.replace('<host>a</host>', '<host>x\n~ replace  /ex-edit:sys/spoof   1 → 2\u009b31m</host>') };
    const r = await run('router1', 'diff');
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('~ replace  /ex-edit:sys/host   a → "x\\n~ replace  /ex-edit:sys/spoof   1 → 2\\x9b31m"\n1 change (running → candidate)\n');
  });

  it('AC7: --json prints the change array', async () => {
    stores = { running: RUNNING, candidate: RUNNING.replace('<mtu>1500</mtu>', '<mtu>9000</mtu>') };
    const r = await run('router1', 'diff --json');
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([{ operation: 'replace', path: '/ex-edit:sys/mtu', value: 9000, previous: 1500 }]);
  });

  it('AC8: a device without the datastore is refused before sending', async () => {
    const bare = await fixture({ fake: { capabilities: [...BARE, ...MODS], handler } });
    try {
      bare.home.targets({ router1: bare.target({ yang: { modules: [MODULES] } }) });
      const r = await runNnc(['router1', '-c', 'diff'], { home: bare.home });
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain(':candidate');
      expect(bare.sent().filter((op) => sourceOf(op) === 'candidate')).toEqual([]);
    } finally {
      await bare.close();
    }
  });

  it('AC8: data without a YANG schema fails and says to supply the modules', async () => {
    stores = { running: RUNNING, candidate: `<other xmlns="urn:example:unknown"/>` };
    const r = await run('router1', 'diff');
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("yang.modules");
  });
});
