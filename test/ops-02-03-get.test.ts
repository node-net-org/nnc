/**
 * OPS-02: Retrieve configuration from a datastore.
 * OPS-03: Retrieve configuration and state together.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serializeXml, x } from '@node-net/netconf';
import type { RpcHandler } from '@node-net/netconf/testing';
import { BARE, FULL } from './support/caps.js';
import { fixture, type Fixture } from './support/fixture.js';
import { runNnc } from './support/nnc.js';

const LAB = 'urn:example:lab';
const handler: RpcHandler = (_rpc, ctx) => ({ data: x('system', { xmlns: LAB }, x('name', `from ${ctx.operation?.name ?? '?'}`)) });

describe('OPS-02 get-config and OPS-03 get', () => {
  let f: Fixture;
  let bare: Fixture;
  beforeAll(async () => {
    f = await fixture({ fake: { capabilities: FULL, handler } });
    bare = await fixture({ fake: { capabilities: BARE, handler } });
  });
  afterAll(async () => {
    await f.close();
    await bare.close();
  });

  const sentXml = (fx: Fixture): string => serializeXml(fx.sent()[0]!);

  it('OPS-02 AC1: get-config running prints the whole running configuration', async () => {
    const r = await runNnc(['router1', '-c', 'get-config running'], { home: f.home });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`<system xmlns="${LAB}">\n  <name>from get-config</name>\n</system>\n`);
    expect(sentXml(f)).toBe('<get-config xmlns="urn:ietf:params:xml:ns:netconf:base:1.0"><source><running/></source></get-config>');
  });

  it('OPS-02 AC2: get-config candidate and startup work when advertised', async () => {
    for (const ds of ['candidate', 'startup']) {
      const r = await runNnc(['router1', '-c', `get-config ${ds}`], { home: f.home });
      expect(r.code, ds).toBe(0);
      expect(sentXml(f)).toContain(`<source><${ds}/></source>`);
    }
  });

  it('OPS-02 AC3: get-config candidate without the candidate capability fails naming it; nothing is sent', async () => {
    const r = await runNnc(['router1', '-c', 'get-config candidate'], { home: bare.home });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(':candidate');
    expect(r.stderr).toContain('nothing was sent');
    expect(bare.rpcsSent()).toBe(0);
  });

  it('OPS-02 AC4: --filter subtree sends a subtree filter', async () => {
    const r = await runNnc(['router1', '-c', `get-config running --filter subtree <system xmlns="${LAB}"><name/></system>`], { home: f.home });
    expect(r.code).toBe(0);
    expect(sentXml(f)).toContain(`<filter type="subtree"><system xmlns="${LAB}"><name/></system></filter>`);
  });

  it('OPS-02 AC5: --filter subtree @filter.xml reads the filter from the file', async () => {
    f.home.file('filter.xml', `<?xml version="1.0"?>\n<system xmlns="${LAB}">\n  <name/>\n</system>\n`);
    const r = await runNnc(['router1', '-c', 'get-config running --filter subtree @filter.xml'], { home: f.home });
    expect(r.code).toBe(0);
    expect(sentXml(f)).toMatch(new RegExp(`<filter type="subtree"><system xmlns="${LAB}">\\s*<name/>\\s*</system></filter>`));
  });

  it('OPS-02 AC6: --filter xpath sends an XPath filter when advertised, and fails before sending when not', async () => {
    const r = await runNnc(['router1', '-c', "get-config running --filter xpath '/lab:system/lab:name'"], { home: f.home });
    expect(r.code).toBe(0);
    const filter = f.sent()[0]!.elements.find((e) => e.name === 'filter')!;
    expect(filter.attr('type')).toBe('xpath');
    expect(filter.attr('select')).toBe('/lab:system/lab:name');
    expect(sentXml(f)).toContain(`xmlns:lab="${LAB}"`);

    const no = await runNnc(['router1', '-c', "get-config running --filter xpath '/lab:system'"], { home: bare.home });
    expect(no.code).toBe(2);
    expect(no.stderr).toContain(':xpath');
    expect(bare.rpcsSent()).toBe(0);
  });

  // OPS-02 AC7 (--with-defaults) is tested in ops-11-extensions.test.ts with the other extension options.

  it('OPS-02 AC8: an unknown datastore fails with a usage message listing the valid names', async () => {
    const r = await runNnc(['router1', '-c', 'get-config scratch'], { home: f.home });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('get-config: <source> can\'t be "scratch"; allowed: running, candidate, startup');
    expect(f.rpcsSent()).toBe(0);
  });

  it('OPS-03 AC1: get with no filter sends <get/> and prints the data', async () => {
    const r = await runNnc(['router1', '-c', 'get'], { home: f.home });
    expect(r.code).toBe(0);
    expect(sentXml(f)).toBe('<get xmlns="urn:ietf:params:xml:ns:netconf:base:1.0"/>');
    expect(r.stdout).toContain('<name>from get</name>');
  });

  it('OPS-03 AC2: get --filter subtree and --filter xpath behave as for get-config', async () => {
    const sub = await runNnc(['router1', '-c', `get --filter subtree <system xmlns="${LAB}"/>`], { home: f.home });
    expect(sub.code).toBe(0);
    expect(sentXml(f)).toContain('<filter type="subtree">');
    const xp = await runNnc(['router1', '-c', "get --filter xpath '/lab:system'"], { home: bare.home });
    expect(xp.code).toBe(2);
    expect(xp.stderr).toContain(':xpath');
  });

  it('OPS-03 AC3: an empty <data/> reply prints (no data)', async () => {
    const empty = await fixture({ fake: { capabilities: FULL, handler: () => ({ data: [] }) } });
    try {
      const r = await runNnc(['router1', '-c', 'get'], { home: empty.home });
      expect(r.stdout).toBe('(no data)\n');
    } finally {
      await empty.close();
    }
  });
});
