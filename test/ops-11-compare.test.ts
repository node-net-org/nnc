/**
 * OPS-11 for the compare module (library OPS-24): `compare` is a command built
 * from its descriptor, prints the reply, and refuses mistakes before sending.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serializeXml, x } from '@node-net/netconf';
import type { RpcHandler } from '@node-net/netconf/testing';
import { BARE, FULL } from './support/caps.js';
import { fixture, type Fixture } from './support/fixture.js';
import { block } from './support/help.js';
import { runNnc } from './support/nnc.js';

const CMP = 'urn:ietf:params:xml:ns:yang:ietf-nmda-compare';
const DS = 'urn:ietf:params:xml:ns:yang:ietf-datastores';
const EX = 'urn:example:lab';
const YL_CAP = 'urn:ietf:params:netconf:capability:yang-library:1.1?revision=2019-01-04&content-id=1';

const DIFFERENCES = x('differences', { xmlns: CMP },
  x('yang-patch', x('patch-id', 'patch'),
    x('edit', x('edit-id', '1'), x('operation', 'replace'), x('target', '/lab:top/leaf'),
      x('value', x('leaf', { xmlns: EX }, '22')),
      x('source-value', x('leaf', { xmlns: EX }, '2')))),
);

let same = true;
const handler: RpcHandler = (_rpc, ctx) =>
  ctx.operation?.name === 'compare' ? { body: [same ? x('no-matches', { xmlns: CMP }) : DIFFERENCES] } : 'ok';

describe('OPS-11 compare command', () => {
  let f: Fixture;
  let bare: Fixture;
  beforeAll(async () => {
    f = await fixture({ fake: { capabilities: [...FULL, YL_CAP], handler } });
    f.home.targets({ router1: f.target(), ro: f.target({ readOnly: true }) });
    bare = await fixture({ fake: { capabilities: BARE, handler } });
  });
  afterAll(async () => {
    await f.close();
    await bare.close();
  });

  it('is listed with help built from its descriptor', async () => {
    const help = await runNnc(['router1', '-c', 'help'], { home: f.home });
    expect(block(help.stdout, 'compare · RFC 9144')).toMatch(/^\s+compare\s+Show how two NMDA datastores differ \(RFC 9144\)$/m);
    const usage = await runNnc(['router1', '-c', 'help compare'], { home: f.home });
    expect(usage.stdout).toContain('usage: compare <source> <target> [options]');
    expect(usage.stdout).toMatch(/--report-origin\s+Include origin annotations from operational/);
    expect(usage.stdout).toContain('changes state: no');
  });

  it('sends <compare> with datastores, flags and an XPath filter, and prints the differences', async () => {
    same = false;
    const r = await runNnc(['router1', '-c', 'compare running candidate --all --report-origin --filter xpath /lab:top'], { home: f.home });
    expect(r.stderr.split('\n').slice(1).join('\n')).toBe('');
    expect(r.code).toBe(0);
    expect(serializeXml(f.sent()[0]!)).toBe(
      `<compare xmlns="${CMP}">` +
        `<source xmlns:ds="${DS}">ds:running</source><target xmlns:ds="${DS}">ds:candidate</target>` +
        '<all/><report-origin/>' +
        `<xpath-filter xmlns:lab="${EX}">/lab:top</xpath-filter></compare>`,
    );
    // The compact diff by default (CLI OPS-13); --xml shows the reply's XML.
    expect(r.stdout).toBe('~ replace  /lab:top/leaf   2 → 22\n1 difference (running → candidate)\n');
    const xml = await runNnc(['router1', '-c', 'compare running candidate --xml'], { home: f.home });
    expect(xml.stdout).toContain('<operation>replace</operation>');
    expect(xml.stdout).toMatch(/<source-value>\s*<leaf xmlns="urn:example:lab">2<\/leaf>/);
  });

  it('reports <no-matches/> when nothing differs, and works on a read-only target', async () => {
    same = true;
    const r = await runNnc(['ro', '-c', 'compare intended operational'], { home: f.home });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('no matches (intended → operational)\n');
  });

  it('refuses an unknown datastore, and a device without the YANG library, before sending', async () => {
    const bad = await runNnc(['router1', '-c', 'compare running scratch'], { home: f.home });
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('compare: <target> can\'t be "scratch"; allowed: running, candidate, startup, intended, operational');
    expect(f.rpcsSent()).toBe(0);

    const none = await runNnc(['router1', '-c', 'compare running candidate'], { home: bare.home });
    expect(none.code).toBe(2);
    expect(none.stderr).toContain(':yang-library:1.1');
    expect(none.stderr).toContain('nothing was sent');
    expect(bare.rpcsSent()).toBe(0);
  });
});
