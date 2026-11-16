/**
 * --json on operation commands: YANG data from get, get-config and get-data as
 * RFC 7951 JSON (OPS-26), other replies as toObject() data.
 */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASE_1_0, BASE_1_1, x } from '@node-net/netconf';
import type { RpcHandler } from '@node-net/netconf/testing';
import { FULL } from './support/caps.js';
import { fixture, type Fixture } from './support/fixture.js';
import { runNnc } from './support/nnc.js';

const LAB = 'urn:example:lab';
const handler: RpcHandler = (_rpc, ctx) => {
  switch (ctx.operation?.name) {
    case 'get-config':
      return {
        data: x(
          'configure',
          { xmlns: LAB },
          x('port', x('port-id', '1/1/1'), x('mtu', '9212')),
          x('port', x('port-id', '1/1/2'), x('mtu', '1500')),
          x('system', x('name', 'lab1')),
        ),
      };
    case 'get':
      return { data: [] };
    case 'get-chassis':
      return { data: x('chassis', { xmlns: LAB }, x('serial', 'ABC123')) };
    default:
      return 'ok';
  }
};

describe('--json output', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await fixture({ fake: { capabilities: FULL, handler } });
  });
  afterAll(() => f.close());

  it('get-config --json without a schema for the data: RFC 7951 names, text values, arrays where elements repeat, and a warning', async () => {
    const r = await runNnc(['router1', '-c', 'get-config running --json'], { home: f.home });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      'lab:configure': {
        port: [
          { 'port-id': '1/1/1', mtu: '9212' },
          { 'port-id': '1/1/2', mtu: '1500' },
        ],
        system: { name: 'lab1' },
      },
    });
    expect(r.stderr).toContain('lab:configure was converted without a YANG schema');
  });

  it('rpc --json <xml> prints the reply data as JSON (the option comes first: inline XML runs to the end of the line)', async () => {
    const r = await runNnc(['router1', '-c', `rpc --json <get-chassis xmlns="${LAB}"/>`], { home: f.home });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ chassis: { serial: 'ABC123' } });
  });

  it('an <ok/> reply prints {"ok": true}, and empty data prints {}', async () => {
    const ok = await runNnc(['router1', '-c', 'validate running --json'], { home: f.home });
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.stdout)).toEqual({ ok: true });
    const empty = await runNnc(['router1', '-c', 'get --json'], { home: f.home });
    expect(empty.code).toBe(0);
    expect(JSON.parse(empty.stdout)).toEqual({});
  });

  it('without --json the output is still XML, and help lists the option', async () => {
    const r = await runNnc(['router1', '-c', 'get-config running', '-c', 'help get-config'], { home: f.home });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^<configure xmlns="urn:example:lab">/);
    expect(r.stdout).toContain('--json');
  });
});

/** The modules of @node-net/netconf's JSON output tests: ex-json, and ex-aug augmenting it. */
const MODULES = fileURLToPath(new URL('fixtures/yang/json/', import.meta.url));
const EJ = 'urn:example:json';

describe('--json output typed by YANG modules given with --yang (OPS-26, CLIENT-06)', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await fixture({
      fake: {
        capabilities: [BASE_1_0, BASE_1_1, `${EJ}?module=ex-json&revision=2026-11-09`, 'urn:example:aug?module=ex-aug&revision=2026-11-09'],
        handler: (_rpc, ctx) =>
          ctx.operation?.name === 'get-config'
            ? { data: x('top', { xmlns: EJ }, x('item', x('name', 'a'), x('count', '-5'), x('size', '7'), x('on', 'true'), x('flag'), x('extra', { xmlns: 'urn:example:aug' }, 'e'))) }
            : 'ok',
      },
    });
  });
  afterAll(() => f.close());

  it('connect --yang <dir> types the values: a one-entry list is an array, int64 a string, uint32 a number, empty [null]', async () => {
    const r = await runNnc(['-c', `connect router1 --yang ${MODULES}`, '-c', 'get-config running --json'], { home: f.home });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout.slice(r.stdout.indexOf('{')))).toEqual({
      'ex-json:top': { item: [{ name: 'a', count: '-5', size: 7, on: true, flag: [null], 'ex-aug:extra': 'e' }] },
    });
    expect(r.stderr).not.toContain('without a YANG schema');
  });

  it('show-last --json after an XML get-config converts it to RFC 7951 JSON then', async () => {
    const r = await runNnc(['-c', `connect router1 --yang ${MODULES}`, '-c', 'get-config running > /dev/null', '-c', 'show-last --json'], { home: f.home });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout.slice(r.stdout.indexOf('{')))).toEqual({
      'ex-json:top': { item: [{ name: 'a', count: '-5', size: 7, on: true, flag: [null], 'ex-aug:extra': 'e' }] },
    });
  });

  it('the targets file yang.modules does the same', async () => {
    f.home.targets({ router1: f.target({ yang: { modules: [MODULES] } }) });
    const r = await runNnc(['router1', '-c', 'get-config running --json'], { home: f.home });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ 'ex-json:top': { item: [{ name: 'a', count: '-5', size: 7, on: true, flag: [null], 'ex-aug:extra': 'e' }] } });
  });
});
