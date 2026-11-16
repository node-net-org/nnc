/**
 * RFC 7951 JSON input on operation commands (OPS-27): edit-config and
 * edit-data take JSON config, inline or from @file, and get, get-config and
 * get-data take a JSON subtree filter; the library converts both with the
 * YANG modules given with --yang.
 */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASE_1_0, BASE_1_1, serializeXml } from '@node-net/netconf';
import { fixture, type Fixture } from './support/fixture.js';
import { runNnc } from './support/nnc.js';

const MODULES = fileURLToPath(new URL('fixtures/yang/json/', import.meta.url));
const EJ = 'urn:example:json';
const EE = 'urn:example:edit';
const NC = 'urn:ietf:params:xml:ns:netconf:base:1.0';
const CAPS = [
  BASE_1_0,
  BASE_1_1,
  'urn:ietf:params:netconf:capability:writable-running:1.0',
  'urn:ietf:params:netconf:capability:candidate:1.0',
  `${EJ}?module=ex-json&revision=2026-11-09`,
  'urn:example:aug?module=ex-aug&revision=2026-11-09',
  `${EE}?module=ex-edit&revision=2026-11-09`,
];

describe('JSON input on operation commands (OPS-27)', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await fixture({ fake: { capabilities: CAPS, handler: (_rpc, ctx) => (ctx.operation?.name === 'get-config' || ctx.operation?.name === 'get' ? { data: [] } : 'ok') } });
    f.home.targets({ router1: f.target({ yang: { modules: [MODULES] } }) });
  });
  afterAll(() => f.close());

  const op = (name: string) => f.sent().find((e) => e.name === name)!;
  const inner = (name: string, child: string): string => op(name).child(child, NC)!.elements.map((e) => serializeXml(e)).join('');

  it('edit-config takes inline JSON config, converted with the schema (metadata becomes nc:operation)', async () => {
    const json = JSON.stringify({ 'ex-edit:sys': { host: 'r1', mtu: null, '@mtu': { 'ietf-netconf:operation': 'delete' } } });
    const r = await runNnc(['router1', '-c', `edit-config running ${json}`], { home: f.home });
    expect(r.stderr).not.toContain('without a YANG schema');
    expect(r.code).toBe(0);
    expect(inner('edit-config', 'config')).toBe(`<sys xmlns="${EE}"><host>r1</host><mtu xmlns:nc="${NC}" nc:operation="delete"/></sys>`);
  });

  it('edit-config takes a JSON file with @', async () => {
    const file = f.home.file('edit.json', JSON.stringify({ 'ex-edit:sys': { dns: ['9.9.9.9'] } }, null, 2));
    const r = await runNnc(['router1', '-c', `edit-config candidate @${file}`], { home: f.home });
    expect(r.code).toBe(0);
    expect(inner('edit-config', 'config')).toBe(`<sys xmlns="${EE}"><dns>9.9.9.9</dns></sys>`);
  });

  it('JSON that does not match the schema is refused with its path, and nothing is sent', async () => {
    const r = await runNnc(['router1', '-c', `edit-config running {"ex-edit:sys": {"mtu": 1}}`], { home: f.home });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('/ex-edit:sys/mtu');
    expect(f.sent().some((e) => e.name === 'edit-config')).toBe(false);
  });

  it('malformed JSON is reported as such', async () => {
    const r = await runNnc(['router1', '-c', 'edit-config running {"ex-edit:sys": '], { home: f.home });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("isn't valid JSON");
  });

  it('get-config --filter subtree takes a JSON filter', async () => {
    const r = await runNnc(['router1', '-c', `get-config running --filter subtree {"ex-json:top": {"item": {"name": "a", "size": null}}}`], { home: f.home });
    expect(r.code).toBe(0);
    expect(inner('get-config', 'filter')).toBe(`<top xmlns="${EJ}"><item><name>a</name><size/></item></top>`);
  });

  it('XML input still works unchanged', async () => {
    const r = await runNnc(['router1', '-c', `edit-config running <sys xmlns="${EE}"><host>x</host></sys>`], { home: f.home });
    expect(r.code).toBe(0);
    expect(inner('edit-config', 'config')).toBe(`<sys xmlns="${EE}"><host>x</host></sys>`);
  });
});

describe('JSON input on NMDA commands (OPS-27)', () => {
  let f: Fixture;
  const NMDA_NS = 'urn:ietf:params:xml:ns:yang:ietf-netconf-nmda';
  beforeAll(async () => {
    f = await fixture({
      fake: {
        capabilities: [...CAPS, 'urn:ietf:params:netconf:capability:yang-library:1.1?revision=2019-01-04&content-id=1'],
        handler: (_rpc, ctx) => (ctx.operation?.name === 'get' || ctx.operation?.name === 'get-data' ? { data: [] } : 'ok'),
      },
    });
    f.home.targets({ router1: f.target({ yang: { modules: [MODULES] } }) });
  });
  afterAll(() => f.close());

  it('edit-data takes JSON config and get-data a JSON filter', async () => {
    const r = await runNnc(['router1', '-c', 'edit-data running {"ex-edit:sys": {"host": "r9"}}', '-c', 'get-data operational --filter subtree {"ex-edit:sys": {}}'], { home: f.home });
    expect(r.code).toBe(0);
    const sent = f.sent();
    const edit = sent.find((e) => e.name === 'edit-data')!;
    expect(edit.child('config', NMDA_NS)!.elements.map((e) => serializeXml(e)).join('')).toBe(`<sys xmlns="${EE}"><host>r9</host></sys>`);
    const get = sent.find((e) => e.name === 'get-data')!;
    expect(get.child('subtree-filter', NMDA_NS)!.elements.map((e) => serializeXml(e)).join('')).toBe(`<sys xmlns="${EE}"/>`);
  });

  it('a JSON filter is refused where the library does not convert one', async () => {
    const r = await runNnc(['router1', '-c', 'create-subscription --filter subtree {"ex-edit:sys": {}}'], { home: f.home });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("can't be JSON for create-subscription");
  });
});
