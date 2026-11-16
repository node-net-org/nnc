/**
 * OPS-15: Follow a dynamic subscription's updates and how it ends.
 */
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { x, type XmlElement } from '@node-net/netconf';
import type { FakeServer, RpcHandler } from '@node-net/netconf/testing';
import { FULL } from './support/caps.js';
import { fixture, type Fixture } from './support/fixture.js';
import { collect, runNnc, startNnc } from './support/nnc.js';

const SN = 'urn:ietf:params:xml:ns:yang:ietf-subscribed-notifications';
const YP = 'urn:ietf:params:xml:ns:yang:ietf-yang-push';
const IF = 'urn:ietf:params:xml:ns:yang:ietf-interfaces';
const LAB = 'urn:example:lab1';
const CAPS = [
  ...FULL,
  'urn:ietf:params:netconf:capability:notification:1.0',
  'urn:ietf:params:netconf:capability:interleave:1.0',
  `${SN}?module=ietf-subscribed-notifications&revision=2019-09-09`,
  `${YP}?module=ietf-yang-push&revision=2019-09-09&features=on-change`,
];

const linkDown = (ifName: string): XmlElement => x('link-down', { xmlns: LAB }, x('interface', ifName));
const sn = (name: string, id: number, ...rest: XmlElement[]): XmlElement => x(name, { xmlns: SN }, x('id', String(id)), ...rest);
const reason = (identity: string): XmlElement => x('reason', { 'xmlns:sn': SN }, `sn:${identity}`);
/** A plain notification line for an event, which a subscription's event must never also get. */
const PLAIN_EVENT = /notification \d+ · \S+ · link-down/;

interface Options {
  /** Events the device sends before the establish-subscription reply. */
  readonly early?: number;
  /** Refuse the establish with an rpc-error. */
  readonly refuse?: boolean;
}

/** Stream subscriptions get id 7, datastore ones 8; everything else is answered ok. */
function handler(options: Options = {}): RpcHandler {
  return (_rpc, ctx) => {
    const op = ctx.operation;
    if (op?.name === 'establish-subscription') {
      for (let i = 0; i < (options.early ?? 0); i++) ctx.server.notify(linkDown(`early${i}`), '2026-11-08T10:00:00Z');
      if (options.refuse === true) return { errors: [{ type: 'application', tag: 'operation-failed', message: 'no' }] };
      const datastore = op.elements.some((e) => e.name === 'datastore');
      return { body: [x('id', { xmlns: SN }, datastore ? '8' : '7')] };
    }
    return 'ok';
  };
}

/** An interactive nnc, with everything it writes to standard error kept from the start. */
function session(f: Fixture): { child: ChildProcessWithoutNullStreams; err: () => string; out: () => string; until: (stream: 'out' | 'err', re: RegExp) => Promise<void> } {
  const child = startNnc(['-i'], { home: f.home });
  let err = '';
  let out = '';
  child.stderr.on('data', (c: Buffer) => (err += c.toString()));
  child.stdout.on('data', (c: Buffer) => (out += c.toString()));
  const until = async (stream: 'out' | 'err', re: RegExp): Promise<void> => {
    const deadline = Date.now() + 10_000;
    while (!re.test(stream === 'out' ? out : err)) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${re}; stdout: ${out}\nstderr: ${err}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  return { child, err: () => err, out: () => out, until };
}

async function connected(f: Fixture): Promise<ReturnType<typeof session> & { server: FakeServer }> {
  const s = session(f);
  s.child.stdin.write('connect router1\n');
  await s.until('out', /nnc router1> /);
  return { ...s, server: f.server.last()! };
}

describe('OPS-15 dynamic subscriptions', () => {
  let f: Fixture | undefined;
  afterEach(async () => {
    await f?.close();
    f = undefined;
  });

  it('AC1: establish-subscription opens the subscription and says what it subscribes to; --json and --xml show it as data and as the reply', async () => {
    f = await fixture({ fake: { capabilities: CAPS, handler: handler() } });
    const r = await runNnc(
      ['router1', '-c', 'establish-subscription --stream NETCONF', '-c', 'establish-subscription --datastore operational --on-change --json'],
      { home: f.home },
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('subscription 7 · stream NETCONF\n');
    expect(JSON.parse(r.stdout.slice(r.stdout.indexOf('{')))).toEqual({ id: 8, kind: 'datastore', datastore: 'ietf-datastores:operational', trigger: 'on-change', replay: false });

    const xml = await runNnc(['router1', '-c', 'establish-subscription --stream NETCONF --xml'], { home: f.home });
    expect(xml.stdout).toBe(`<id xmlns="${SN}">7</id>\n`);
  });

  it('AC2/AC4/AC7: updates are shown as subscription lines, never also as plain notifications, and status lists the subscription', async () => {
    f = await fixture({ fake: { capabilities: CAPS, handler: handler() } });
    const s = await connected(f);
    s.child.stdin.write('establish-subscription --stream NETCONF\n');
    await s.until('out', /subscription 7 · stream NETCONF/);
    s.server.notify(linkDown('eth0'), '2026-11-08T10:00:01Z');
    s.server.notify(sn('subscription-suspended', 7, reason('insufficient-resources')), '2026-11-08T10:00:02Z');
    s.server.notify(sn('subscription-resumed', 7), '2026-11-08T10:00:03Z');
    s.server.notify(sn('subscription-modified', 7, x('stream', 'NETCONF')), '2026-11-08T10:00:04Z');
    await s.until('err', /subscription 7 · modified/);
    expect(s.err()).toContain('notification 1 · 2026-11-08T10:00:01Z · subscription 7 · event · link-down\n');
    expect(s.err()).toContain('notification 2 · 2026-11-08T10:00:02Z · subscription 7 · suspended · insufficient-resources\n');
    expect(s.err()).toContain('notification 3 · 2026-11-08T10:00:03Z · subscription 7 · resumed\n');
    expect(s.err()).toContain('notification 4 · 2026-11-08T10:00:04Z · subscription 7 · modified\n');
    expect(s.err()).not.toMatch(PLAIN_EVENT);
    expect(s.err()).not.toMatch(/· subscription-suspended/);

    s.child.stdin.write('status\n');
    await s.until('out', /subscriptions +7 stream NETCONF\n/);
    s.child.stdin.end();
    await collect(s.child, undefined);
  });

  it('AC2: YANG-Push updates name what they carry, count their edits, and say when the server marks them incomplete', async () => {
    f = await fixture({ fake: { capabilities: CAPS, handler: handler() } });
    const s = await connected(f);
    s.child.stdin.write('establish-subscription --datastore operational --period 100\n');
    await s.until('out', /subscription 8 · datastore operational · periodic/);
    s.server.notify(x('push-update', { xmlns: YP }, x('id', '8'), x('datastore-contents', x('interfaces', { xmlns: IF }), x('system', { xmlns: LAB }))));
    s.server.notify(
      x('push-change-update', { xmlns: YP }, x('id', '8'), x('incomplete-update'),
        x('datastore-changes', x('yang-patch', { xmlns: 'urn:ietf:params:xml:ns:yang:ietf-yang-patch' }, x('patch-id', 'p1'),
          x('edit', x('edit-id', 'e1'), x('operation', 'delete'), x('target', '/ietf-interfaces:interfaces/interface[name=eth1]')),
          x('edit', x('edit-id', 'e2'), x('operation', 'merge'), x('target', '/ietf-interfaces:interfaces/interface[name=eth0]'),
            x('value', x('interface', { xmlns: IF }, x('name', 'eth0'))))))),
    );
    await s.until('err', /push-change-update/);
    expect(s.err()).toMatch(/notification 1 · \S+ · subscription 8 · push-update · interfaces, system\n/);
    expect(s.err()).toMatch(/notification 2 · \S+ · subscription 8 · push-change-update · 2 edits · incomplete\n/);
    s.child.stdin.end();
    await collect(s.child, undefined);
  });

  it('AC4: notifications sent before the establish reply belong to the subscription, and are shown as plain notifications if it is refused', async () => {
    f = await fixture({ fake: { capabilities: CAPS, handler: handler({ early: 2 }) } });
    const r = await runNnc(['router1', '-c', 'establish-subscription --stream NETCONF', '-c', 'notifications'], { home: f.home });
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/notification 1 · \S+ · subscription 7 · event · link-down\nnotification 2 · \S+ · subscription 7 · event · link-down\n/);
    expect(r.stderr).not.toMatch(PLAIN_EVENT);

    await f.close();
    f = await fixture({ fake: { capabilities: CAPS, handler: handler({ early: 1, refuse: true }) } });
    const refused = await runNnc(['router1', '-c', 'establish-subscription --stream NETCONF'], { home: f.home });
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('notification 1 · 2026-11-08T10:00:00Z · link-down\n');
    expect(refused.stderr).not.toContain('subscription 7');
  });

  it('AC3/AC6: delete-subscription ends it as deleted; a server termination and kill-subscription end it as terminated; a closing session prints no end line', async () => {
    f = await fixture({ fake: { capabilities: CAPS, handler: handler() } });
    const s = await connected(f);
    s.child.stdin.write('establish-subscription --stream NETCONF\n');
    await s.until('out', /subscription 7 · stream NETCONF/);
    s.child.stdin.write('delete-subscription 7\n');
    await s.until('err', /subscription 7 ended · deleted\n/);
    expect(f.sent().map((e) => e.name)).toContain('delete-subscription');

    s.child.stdin.write('establish-subscription --datastore operational --on-change\n');
    await s.until('out', /subscription 8 · datastore operational · on-change/);
    s.child.stdin.write('kill-subscription 8\n');
    for (let i = 0; i < 200 && f.sent().at(-1)?.name !== 'kill-subscription'; i++) await new Promise((r) => setTimeout(r, 20));
    expect(f.sent().at(-1)!.name).toBe('kill-subscription');
    // The server's answer to a kill: the subscription is terminated.
    s.server.notify(sn('subscription-terminated', 8, reason('no-such-subscription')));
    await s.until('err', /subscription 8 ended · terminated \(no-such-subscription\)\n/);
    expect(s.err()).not.toMatch(/subscription 8 · terminated/);

    s.child.stdin.write('establish-subscription --stream NETCONF\n');
    await s.until('out', /subscription 7 · stream NETCONF[^]*subscription 7 · stream NETCONF/);
    s.child.stdin.end('disconnect\n');
    await collect(s.child, undefined);
    expect(s.err().match(/ended/g)).toHaveLength(2);
  });

  it('AC6: modify-subscription and resync-subscription act on a held subscription by id', async () => {
    f = await fixture({ fake: { capabilities: CAPS, handler: handler() } });
    const r = await runNnc(
      ['router1', '-c', 'establish-subscription --datastore operational --on-change', '-c', 'modify-subscription 8 --datastore operational --dampening-period 50', '-c', 'resync-subscription 8'],
      { home: f.home },
    );
    expect(r.code).toBe(0);
    const [, modify, resync] = f.sent();
    expect(modify!.name).toBe('modify-subscription');
    expect(modify!.child('id', SN)?.text()).toBe('8');
    expect(resync!.name).toBe('resync-subscription');
  });

  it('AC5: notifications lists subscription updates as such, --json carries the subscription and decoded update, and --follow prints them as they arrive', async () => {
    let server: FakeServer | undefined;
    f = await fixture({
      fake: {
        capabilities: CAPS,
        handler: (rpc, ctx) => {
          server = ctx.server;
          return handler()(rpc, ctx);
        },
      },
    });
    const s = await connected(f);
    s.child.stdin.write('establish-subscription --stream NETCONF\n');
    await s.until('out', /subscription 7 · stream NETCONF/);
    s.server.notify(sn('subscription-suspended', 7, reason('insufficient-resources')), '2026-11-08T10:00:02Z');
    await s.until('err', /suspended/);
    s.child.stdin.write('notifications --json\n');
    await s.until('out', /"update"[^]*\]\n/);
    const listed = JSON.parse(s.out().slice(s.out().indexOf('['), s.out().lastIndexOf(']') + 1)) as Record<string, unknown>[];
    expect(listed[0]).toMatchObject({
      number: 1,
      event: 'subscription-suspended',
      subscription: 7,
      update: { type: 'suspended', eventTime: '2026-11-08T10:00:02Z', reason: 'ietf-subscribed-notifications:insufficient-resources' },
    });

    s.child.stdin.write('notifications --follow\n');
    await new Promise((r) => setTimeout(r, 200));
    server!.notify(linkDown('eth3'), '2026-11-08T10:00:05Z');
    await s.until('out', /notification 2 · 2026-11-08T10:00:05Z · subscription 7 · event · link-down\n/);
    expect(s.err()).not.toContain('notification 2');
    server!.end();
    s.child.stdin.end();
    await collect(s.child, undefined);
  });

  it('AC8: nnc keeps reading while idle, so more updates than the queue holds do not overflow the subscription', async () => {
    f = await fixture({ fake: { capabilities: CAPS, handler: handler() } });
    const s = await connected(f);
    s.child.stdin.write('establish-subscription --stream NETCONF\n');
    await s.until('out', /subscription 7 · stream NETCONF/);
    for (let i = 1; i <= 1200; i++) s.server.notify(linkDown(`eth${i}`), '2026-11-08T10:00:00Z');
    await s.until('err', /notification 1200 · \S+ · subscription 7 · event · link-down/);
    expect(s.err()).not.toContain('overflow');
    s.child.stdin.end('status\n');
    await collect(s.child, undefined);
    expect(s.out()).toMatch(/subscriptions +7 stream NETCONF/);
  }, 30_000);
});
