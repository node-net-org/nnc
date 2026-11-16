/**
 * OPS-09: See the notifications the device sends during a session.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { x, type XmlElement } from '@node-net/netconf';
import type { RpcHandler } from '@node-net/netconf/testing';
import { fixture, type Fixture } from './support/fixture.js';
import { collect, runNnc, startNnc, waitFor } from './support/nnc.js';

const NCN = 'urn:ietf:params:xml:ns:yang:ietf-netconf-notifications';
const LAB = 'urn:example:lab1';

const configChange = (): XmlElement =>
  x('netconf-config-change', { xmlns: NCN }, x('changed-by', x('username', 'admin'), x('session-id', '9')), x('datastore', 'running'));
const linkDown = (ifName: string): XmlElement => x('link-down', { xmlns: LAB }, x('interface', ifName));

/** Each `get` is answered after the device has sent a notification. */
const notifyThenReply: RpcHandler = async (_rpc, ctx) => {
  if (ctx.operation?.name === 'get') {
    ctx.server.notify(linkDown('eth0'), '2026-11-07T10:00:00Z');
    await new Promise((r) => setTimeout(r, 50));
    return { data: x('system', { xmlns: LAB }, x('hostname', 'router1')) };
  }
  return 'ok';
};

describe('OPS-09 notifications', () => {
  let f: Fixture | undefined;
  afterEach(async () => {
    await f?.close();
    f = undefined;
  });

  it('AC1: a notification arriving at the prompt is shown above it with its number, time and event', async () => {
    f = await fixture();
    const child = startNnc(['-i'], { home: f.home });
    const done = collect(child, undefined);
    child.stdin.write('connect router1\n');
    await waitFor(child, 'stdout', /nnc router1> /);
    f.server.last()!.notify(linkDown('eth1'), '2026-11-07T10:00:00Z');
    await waitFor(child, 'stderr', /notification 1 · 2026-11-07T10:00:00Z · link-down/);
    child.stdin.end('notifications\n');
    const r = await done;
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('notification 1 · 2026-11-07T10:00:00Z · link-down\n');
  });

  it('AC1/AC6: a notification between a request and its reply is noticed and kept, and the reply is still the result', async () => {
    f = await fixture({ fake: { handler: notifyThenReply } });
    const r = await runNnc(['router1', '-c', 'get', '-c', 'notifications'], { home: f.home });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('<hostname>router1</hostname>');
    expect(r.stdout).toContain('notification 1 · 2026-11-07T10:00:00Z · link-down');
    expect(r.stderr).toContain('notification 1 · 2026-11-07T10:00:00Z · link-down');
  });

  it('AC2/AC5: notifications lists every notification received, oldest first, and says when there are none', async () => {
    f = await fixture({ fake: { handler: notifyThenReply } });
    const none = await runNnc(['router1', '-c', 'notifications'], { home: f.home });
    expect(none.stdout).toBe('(no notifications)\n');
    const two = await runNnc(['router1', '-c', 'get', '-c', 'get', '-c', 'notifications'], { home: f.home });
    expect(two.stdout).toMatch(/notification 1 · [^\n]+ · link-down\nnotification 2 · [^\n]+ · link-down\n$/);
  });

  it('AC4: --json gives each notification as data, with base notifications decoded', async () => {
    f = await fixture({
      fake: {
        handler: (_rpc, ctx) => {
          if (ctx.operation?.name === 'get') {
            ctx.server.notify(configChange(), '2026-11-07T10:00:00Z');
            ctx.server.notify(x('netconf-session-end', { xmlns: NCN }, x('username', 'admin')), '2026-11-07T10:00:01Z');
          }
          return 'ok';
        },
      },
    });
    const r = await runNnc(['router1', '-c', 'get', '-c', 'notifications --json'], { home: f.home });
    expect(r.code).toBe(0);
    const list = JSON.parse(r.stdout.slice(r.stdout.indexOf('['))) as Record<string, unknown>[];
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({
      number: 1,
      eventTime: '2026-11-07T10:00:00Z',
      event: 'netconf-config-change',
      namespace: NCN,
      content: { 'changed-by': { username: 'admin', 'session-id': '9' }, datastore: 'running' },
      decoded: { type: 'netconf-config-change', datastore: 'running', changedBy: { username: 'admin', sessionId: 9 } },
    });
    // A base notification that breaks its module keeps its content and says why it was not decoded.
    expect(list[1]).toMatchObject({ number: 2, event: 'netconf-session-end', content: { username: 'admin' } });
    expect(list[1]!['decodeError']).toMatch(/termination-reason is missing/);
    expect(list[1]).not.toHaveProperty('decoded');
  });

  it('AC3: notifications --follow prints each new notification until Ctrl-C, then the next command runs', async () => {
    f = await fixture();
    const child = startNnc(['router1', '-c', 'notifications --follow --json', '-c', 'notifications'], { home: f.home });
    const done = collect(child, undefined);
    await waitFor(child, 'stderr', /connected to router1/);
    // The follower registers just after the connect line; keep sending until one reaches standard output.
    const seen = waitFor(child, 'stdout', /"number":\d+/);
    let n = 0;
    const timer = setInterval(() => f!.server.last()!.notify(linkDown(`eth${n++}`)), 100);
    await seen;
    clearInterval(timer);
    child.kill('SIGINT');
    const r = await done;
    expect(r.code).toBe(0);
    const followed = r.stdout.split('\n').filter((l) => l.startsWith('{'));
    expect(followed.length).toBeGreaterThan(0);
    expect(JSON.parse(followed[0]!)).toMatchObject({ event: 'link-down', namespace: LAB });
    // While following, notifications go to standard output only, not also as notices.
    const followedNumbers = followed.map((l) => (JSON.parse(l) as { number: number }).number);
    for (const k of followedNumbers) expect(r.stderr).not.toContain(`notification ${k} ·`);
    // The list afterwards has all of them, including any noticed before the follow began.
    expect(r.stdout).toContain(`notification ${n} · `);
  });

  it('AC3: notifications --follow > file writes the followed notifications to the file when Ctrl-C ends the follow', async () => {
    f = await fixture();
    const out = join(f.home.dir, 'followed.txt');
    const child = startNnc(['router1', '-c', `notifications --follow > ${out}`], { home: f.home });
    const done = collect(child, undefined);
    await waitFor(child, 'stderr', /connected to router1/);
    await new Promise((r) => setTimeout(r, 300));
    for (let i = 0; i < 3; i++) f.server.last()!.notify(linkDown(`eth${i}`), '2026-11-07T10:00:00Z');
    await new Promise((r) => setTimeout(r, 300));
    child.kill('SIGINT');
    const r = await done;
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(readFileSync(out, 'utf8')).toMatch(/^(notification \d+ · 2026-11-07T10:00:00Z · link-down\n)+$/);
  });

  it('AC3: --follow returns when the session closes', async () => {
    f = await fixture();
    const child = startNnc(['router1', '-c', 'notifications --follow', '-c', 'status'], { home: f.home });
    const done = collect(child, undefined);
    await waitFor(child, 'stderr', /connected to router1/);
    await new Promise((r) => setTimeout(r, 300));
    f.server.last()!.destroy();
    const r = await done;
    expect(r.stderr).toContain('server closed the session to router1');
    expect(r.stdout).toMatch(/not connected/);
  });
});
