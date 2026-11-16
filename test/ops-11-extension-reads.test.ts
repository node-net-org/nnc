/**
 * OPS-11 (extension commands) for extension reads: @node-net/netconf OPS-25 AC5.
 * An extension's read helpers (`kind: 'read'` descriptors) are commands with no CLI
 * code of their own: monitoring-sessions, -schemas, -datastores, -statistics,
 * notification-streams, subscription-streams, -list, -support, yang-library.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NETCONF_NS, parseXml, x, type XmlElement } from '@node-net/netconf';
import type { RpcHandler } from '@node-net/netconf/testing';
import { FULL } from './support/caps.js';
import { fixture, type Fixture } from './support/fixture.js';
import { block } from './support/help.js';
import { runNnc } from './support/nnc.js';

const NCM = 'urn:ietf:params:xml:ns:yang:ietf-netconf-monitoring';
const YL = 'urn:ietf:params:xml:ns:yang:ietf-yang-library';
/** The capabilities the extensions need. */
const EXTENSION_CAPS = [
  'urn:ietf:params:netconf:capability:yang-library:1.1?revision=2019-01-04&content-id=1',
  `${NCM}?module=ietf-netconf-monitoring&revision=2010-10-04`,
  'urn:ietf:params:netconf:capability:notification:1.0',
];

const topOf = (op: XmlElement | undefined): string | undefined => (op?.name === 'get' ? op.child('filter', NETCONF_NS)?.elements[0]?.name : undefined);

const handler: RpcHandler = (_rpc, ctx) => {
  const top = topOf(ctx.operation);
  if (top === 'netconf-state') {
    return {
      data: [parseXml(`<netconf-state xmlns="${NCM}"><sessions><session><session-id>4</session-id><transport>netconf-ssh</transport>` +
        '<username>admin\u009b31m\u202e</username><source-host>192.0.2.1</source-host><login-time>2026-11-07T00:00:00Z</login-time></session></sessions></netconf-state>')],
    };
  }
  if (top === 'yang-library') {
    return { data: [x('yang-library', { xmlns: YL }, x('module-set', x('name', 'all'), x('module', x('name', 'lab'), x('revision', '2024-01-01'), x('namespace', 'urn:example:lab'))), x('content-id', '1'))] };
  }
  return { data: [] };
};

describe('OPS-11 extension reads as commands (@node-net/netconf OPS-25 AC5)', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await fixture({ fake: { capabilities: [...FULL, ...EXTENSION_CAPS], handler } });
    f.home.targets({ router1: f.target(), ro: f.target({ readOnly: true }) });
  });
  afterAll(async () => {
    await f.close();
  });

  /** Gets of `top` the most recent session sent. */
  const gets = (top: string): number => f.sent().filter((op) => topOf(op) === top).length;

  it('help lists the reads with their extensions, none marked as changing state', async () => {
    const help = await runNnc(['router1', '-c', 'help'], { home: f.home });
    expect(block(help.stdout, 'monitoring · RFC 6022')).toMatch(/^\s+monitoring-sessions\s+The open NETCONF sessions /m);
    expect(block(help.stdout, 'yangLibrary · RFC 8525 (and RFC 7895)')).toMatch(/^\s+yang-library\s+\S/m);
    expect(block(help.stdout, 'notifications · RFC 5277')).toMatch(/^\s+notification-streams\s+\S/m);
    expect(block(help.stdout, 'subscriptions · RFC 8639, 8641')).toMatch(/^\s+subscription-support\s+\S/m);
    expect(help.stdout).not.toMatch(/^\s+(monitoring-\w+|notification-streams|subscription-\w+|yang-library) \*/m);
    const one = await runNnc(['router1', '-c', 'help yang-library'], { home: f.home });
    expect(one.stdout).toContain('--refresh');
    // A read resolves with decoded data: there is no reply XML or raw reply to offer.
    expect(one.stdout).toContain('--json');
    expect(one.stdout).not.toMatch(/--xml|--raw/);
  });

  it('a read shows its decoded result as JSON, the same with --json, and runs on a read-only target', async () => {
    const r = await runNnc(['ro', '-c', 'monitoring-sessions'], { home: f.home });
    expect(r.code).toBe(0);
    // Device text can't control the terminal (LANG-13): C1 and bidi characters arrive escaped.
    expect(r.stdout).not.toMatch(/[\u0080-\u009f\u202a-\u202e]/);
    const shown = JSON.parse(r.stdout) as unknown[];
    expect(shown).toEqual([expect.objectContaining({ sessionId: 4, username: 'admin\u009b31m\u202e', transport: 'ietf-netconf-monitoring:netconf-ssh' })]);
    const json = await runNnc(['ro', '-c', 'monitoring-sessions --json'], { home: f.home });
    expect(JSON.parse(json.stdout)).toEqual(shown);
  });

  it('yang-library is read once per session; --refresh reads it again', async () => {
    const r = await runNnc(['router1', '-c', 'yang-library', '-c', 'yang-library', '-c', 'yang-library --refresh'], { home: f.home });
    expect(r.code).toBe(0);
    expect(gets('yang-library')).toBe(2);
    expect(r.stdout).toContain('"contentId": "1"');
  });

  it('an option a read does not have is refused before anything is sent', async () => {
    const r = await runNnc(['router1', '-c', 'monitoring-sessions --bogus'], { home: f.home });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/bogus/);
    expect(f.sent()).toEqual([]);
  });

  it("review: on a read-only target a raw rpc named like a read is still refused (a read isn't an RPC)", async () => {
    const r = await runNnc(['ro', '-c', 'rpc <monitoring-sessions xmlns="urn:ietf:params:xml:ns:yang:ietf-netconf-monitoring"/>'], { home: f.home });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/read-only/);
    expect(f.sent()).toEqual([]);
  });
});
