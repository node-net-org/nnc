/**
 * OPS-11: Use extension operations as commands.
 * OPS-02 AC7: get-config --with-defaults (a with-defaults extension option).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serializeXml, x, XmlElement } from '@node-net/netconf';
import type { RpcHandler } from '@node-net/netconf/testing';
import { BARE, FULL } from './support/caps.js';
import { fixture, type Fixture } from './support/fixture.js';
import { block } from './support/help.js';
import { runNnc } from './support/nnc.js';

const SN = 'urn:ietf:params:xml:ns:yang:ietf-subscribed-notifications';
/** The capabilities the extensions need, plus a YANG module to path into. */
const EXTENSION_CAPS = [
  'urn:ietf:params:netconf:capability:yang-library:1.1?revision=2019-01-04&content-id=1',
  'urn:ietf:params:xml:ns:yang:ietf-netconf-monitoring?module=ietf-netconf-monitoring&revision=2010-10-04',
  'urn:ietf:params:netconf:capability:with-defaults:1.0?basic-mode=explicit&also-supported=report-all,trim',
  'urn:ietf:params:netconf:capability:notification:1.0',
  'urn:ietf:params:netconf:capability:partial-lock:1.0',
  'urn:ietf:params:xml:ns:yang:ietf-interfaces?module=ietf-interfaces&revision=2018-02-20',
  // establish-subscription runs through the library, which checks the server implements them (OPS-15).
  `${SN}?module=ietf-subscribed-notifications&revision=2019-09-09`,
  'urn:ietf:params:xml:ns:yang:ietf-yang-push?module=ietf-yang-push&revision=2019-09-09&features=on-change',
];
const YANG = 'module lab {\n  namespace "urn:example:lab";\n  prefix lab;\n}';
const PL = 'urn:ietf:params:xml:ns:netconf:partial-lock:1.0';
const IF = 'urn:ietf:params:xml:ns:yang:ietf-interfaces';

const handler: RpcHandler = (_rpc, ctx) => {
  if (ctx.operation?.name === 'get-schema') return { data: YANG };
  if (ctx.operation?.name === 'establish-subscription') return { body: [x('id', { xmlns: SN }, '1')] };
  if (ctx.operation?.name === 'partial-lock') {
    // Grant lock 127 on what the first select names.
    const select = ctx.operation.elements[0]!;
    return { body: [x('lock-id', { xmlns: PL }, '127'), new XmlElement({ ...select, name: 'locked-node', ns: PL })] };
  }
  return ctx.operation?.name === 'partial-unlock' ? 'ok' : { data: [] };
};

describe('OPS-11 extension commands', () => {
  let f: Fixture;
  let bare: Fixture;
  beforeAll(async () => {
    f = await fixture({ fake: { capabilities: [...FULL, ...EXTENSION_CAPS], handler } });
    f.home.targets({ router1: f.target(), ro: f.target({ readOnly: true }) });
    bare = await fixture({ fake: { capabilities: BARE, handler } });
  });
  afterAll(async () => {
    await f.close();
    await bare.close();
  });

  const sentXml = (fx: Fixture): string => serializeXml(fx.sent()[0]!);

  it('AC1: extension operations appear as commands on devices that advertise its capabilities', async () => {
    const help = await runNnc(['router1', '-c', 'help'], { home: f.home });
    expect(block(help.stdout, 'nmda · RFC 8526')).toMatch(/^\s+get-data\s+Read data from any NMDA datastore$/m);
    expect(block(help.stdout, 'nmda · RFC 8526')).toMatch(/^\s+edit-data \*\s+\S/m);
    expect(block(help.stdout, 'monitoring · RFC 6022')).toMatch(/^\s+get-schema\s+\S/m);
    expect(block(help.stdout, 'notifications · RFC 5277')).toMatch(/^\s+create-subscription\s+\S/m);

    const r = await runNnc(
      ['router1', '-c', 'get-data operational --origin-filter intended --origin-filter learned --max-depth unbounded --no-config-filter'],
      { home: f.home },
    );
    expect(r.stderr.split('\n').slice(1).join('\n')).toBe('');
    expect(r.code).toBe(0);
    const sent = sentXml(f);
    expect(sent).toContain('<get-data xmlns="urn:ietf:params:xml:ns:yang:ietf-netconf-nmda"');
    expect(sent).toMatch(/<datastore[^>]*>[\w-]+:operational<\/datastore>/);
    expect(sent.match(/<origin-filter[^>]*>[\w-]+:(intended|learned)<\/origin-filter>/g)).toHaveLength(2);
    expect(sent).toContain('<config-filter>false</config-filter>');
    expect(sent).toContain('<max-depth>unbounded</max-depth>');
  });

  it('AC1: get-data --max-depth takes a number of levels, and a bad one is refused before sending', async () => {
    const r = await runNnc(['router1', '-c', 'get-data operational --max-depth 2'], { home: f.home });
    expect(r.stderr.split('\n').slice(1).join('\n')).toBe('');
    expect(r.code).toBe(0);
    expect(sentXml(f)).toContain('<max-depth>2</max-depth>');

    const bad = await runNnc(['router1', '-c', 'get-data operational --max-depth 0'], { home: f.home });
    expect(bad.code).not.toBe(0);
    expect(bad.stderr).toContain('maxDepth must be an integer from 1 to 65535');
    expect(f.rpcsSent()).toBe(0);
  });

  it('AC1: get-schema prints the schema text', async () => {
    const r = await runNnc(['router1', '-c', 'get-schema lab --format yang'], { home: f.home });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`${YANG}\n`);
    expect(sentXml(f)).toContain('<identifier>lab</identifier><format>yang</format>');
  });

  it('AC2: extension commands have help, argument checking and completion from their descriptors', async () => {
    const help = await runNnc(['router1', '-c', 'help get-data'], { home: f.home });
    expect(help.stdout).toContain('usage: get-data <datastore> [options]');
    expect(help.stdout).toMatch(/--origin-filter\s+Keep configuration nodes with these origins/);
    expect(help.stdout).toContain('extension: nmda');
    expect(help.stdout).toContain('changes state: no');

    const bad = await runNnc(['router1', '-c', 'get-data scratch'], { home: f.home });
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('get-data: <datastore> can\'t be "scratch"; allowed: running, candidate, startup, intended, operational');
    const badOrigin = await runNnc(['router1', '-c', 'get-data operational --origin-filter elsewhere'], { home: f.home });
    expect(badOrigin.code).toBe(2);
    expect(badOrigin.stderr).toContain('--origin-filter can\'t be "elsewhere"');
    const typo = await runNnc(['router1', '-c', 'get-data operational --with-orign'], { home: f.home });
    expect(typo.stderr).toContain('did you mean --with-origin?');
    expect(f.rpcsSent()).toBe(0);
  });

  it("AC3: on a device without an extension's capabilities its commands are listed as unavailable and fail before sending", async () => {
    const help = await runNnc(['router1', '-c', 'help'], { home: bare.home });
    const unavailable = help.stdout.split('not available on router1 (missing capabilities)')[1]!;
    expect(unavailable).toMatch(/^\s+get-data\s+needs :yang-library:1.1$/m);
    expect(unavailable).toMatch(/^\s+get-schema\s+needs urn:ietf:params:xml:ns:yang:ietf-netconf-monitoring$/m);
    expect(unavailable).toMatch(/^\s+create-subscription\s+needs :notification:1.0$/m);

    for (const [line, cap] of [
      ['get-data running', ':yang-library:1.1'],
      ['get-schema lab', 'ietf-netconf-monitoring'],
      ['create-subscription', ':notification:1.0'],
    ] as const) {
      const r = await runNnc(['router1', '-c', line], { home: bare.home });
      expect(r.code, line).toBe(2);
      expect(r.stderr, line).toContain(cap);
      expect(r.stderr, line).toContain('nothing was sent');
      expect(bare.rpcsSent(), line).toBe(0);
    }
  });

  it('AC4: an extension operation that changes state is refused on read-only targets', async () => {
    const r = await runNnc(['ro', '-c', 'edit-data running <config><a xmlns="urn:example:lab">1</a></config>'], { home: f.home });
    expect(r.code).toBe(4);
    expect(r.stderr).toContain('edit-data: refused: ro is read-only and edit-data changes device state; nothing was sent');
    expect(f.rpcsSent()).toBe(0);
    const read = await runNnc(['ro', '-c', 'get-data running'], { home: f.home });
    expect(read.code).toBe(0);
  });

  it('AC1: partial-lock takes YANG paths or XPaths over advertised modules, and partial-unlock releases by lock-id', async () => {
    const help = await runNnc(['router1', '-c', 'help partial-lock'], { home: f.home });
    expect(help.stdout).toContain('usage: partial-lock <select>... [options]');
    expect(help.stdout).toContain('changes state: yes');

    const r = await runNnc(
      // Quoted whole, as in a shell: nnc's lexer removes quotes inside a word.
      ['router1', '-c', `partial-lock "/ietf-interfaces:interfaces/interface[name='eth0']" "/ietf-interfaces:interfaces/ietf-interfaces:interface[ietf-interfaces:enabled='false']"`],
      { home: f.home },
    );
    expect(r.stderr.split('\n').slice(1).join('\n')).toBe('');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('127');
    expect(sentXml(f)).toBe(
      `<partial-lock xmlns="${PL}">` +
        `<select xmlns:ietf-interfaces="${IF}">/ietf-interfaces:interfaces/ietf-interfaces:interface[ietf-interfaces:name='eth0']</select>` +
        `<select xmlns:ietf-interfaces="${IF}">/ietf-interfaces:interfaces/ietf-interfaces:interface[ietf-interfaces:enabled='false']</select>` +
        '</partial-lock>',
    );

    const unlock = await runNnc(['router1', '-c', 'partial-unlock 127'], { home: f.home });
    expect(unlock.code).toBe(0);
    expect(sentXml(f)).toBe(`<partial-unlock xmlns="${PL}"><lock-id>127</lock-id></partial-unlock>`);

    const unknown = await runNnc(['router1', '-c', 'partial-lock /nope:top'], { home: f.home });
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain('partial-lock: <select> is neither a YANG path');
    // The device has a YANG library, so nnc read it (a read-only <get>) looking for "nope"; no lock was sent.
    expect(f.sent().map((op) => op.name)).toEqual(['get']);
    expect(serializeXml(f.sent()[0]!)).toContain('urn:ietf:params:xml:ns:yang:ietf-yang-library');

    const ro = await runNnc(['ro', '-c', `partial-lock /ietf-interfaces:interfaces`], { home: f.home });
    expect(ro.code).toBe(4);
    expect(ro.stderr).toContain('partial-lock: refused: ro is read-only');
    expect(f.rpcsSent()).toBe(0);
  });

  it('AC1: subscription commands build establish-subscription for YANG-Push, and kill-subscription is refused read-only', async () => {
    const help = await runNnc(['router1', '-c', 'help'], { home: f.home });
    expect(block(help.stdout, 'subscriptions · RFC 8639, 8641')).toMatch(/^\s+establish-subscription\s+\S/m);
    expect(block(help.stdout, 'subscriptions · RFC 8639, 8641')).toMatch(/^\s+kill-subscription \*\s+\S/m);

    const r = await runNnc(
      ['router1', '-c', 'establish-subscription --datastore operational --on-change --dampening-period 0 --excluded-change delete --excluded-change move'],
      { home: f.home },
    );
    expect(r.stderr.split('\n').slice(1).join('\n')).toBe('');
    expect(sentXml(f)).toBe(
      '<establish-subscription xmlns="urn:ietf:params:xml:ns:yang:ietf-subscribed-notifications">' +
        '<datastore xmlns:ds="urn:ietf:params:xml:ns:yang:ietf-datastores" xmlns="urn:ietf:params:xml:ns:yang:ietf-yang-push">ds:operational</datastore>' +
        '<on-change xmlns="urn:ietf:params:xml:ns:yang:ietf-yang-push"><dampening-period>0</dampening-period>' +
        '<excluded-change>delete</excluded-change><excluded-change>move</excluded-change></on-change></establish-subscription>',
    );

    const bad = await runNnc(['router1', '-c', 'establish-subscription --datastore running'], { home: f.home });
    expect(bad.code).not.toBe(0);
    expect(bad.stderr).toContain('needs periodic or onChange');
    expect(f.rpcsSent()).toBe(0);

    const ro = await runNnc(['ro', '-c', 'kill-subscription 3'], { home: f.home });
    expect(ro.code).toBe(4);
    expect(ro.stderr).toContain('kill-subscription: refused: ro is read-only');
    expect(f.rpcsSent()).toBe(0);
  });

  it('OPS-02 AC7: --with-defaults is sent when the device supports the mode, and refused before sending otherwise', async () => {
    const r = await runNnc(['router1', '-c', 'get-config running --with-defaults report-all'], { home: f.home });
    expect(r.code).toBe(0);
    expect(sentXml(f)).toContain('<with-defaults xmlns="urn:ietf:params:xml:ns:yang:ietf-netconf-with-defaults">report-all</with-defaults>');

    const unsupported = await runNnc(['router1', '-c', 'get-config running --with-defaults report-all-tagged'], { home: f.home });
    expect(unsupported.code).toBe(2);
    expect(unsupported.stderr).toContain('nothing was sent');
    expect(f.rpcsSent()).toBe(0);

    const none = await runNnc(['router1', '-c', 'get-config running --with-defaults report-all'], { home: bare.home });
    expect(none.code).toBe(2);
    expect(none.stderr).toContain('with-defaults');
    expect(bare.rpcsSent()).toBe(0);
  });
});
