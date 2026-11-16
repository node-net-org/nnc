/**
 * Library CONTENT-04 in nnc: YANG path and XPath arguments may name modules
 * only the server's YANG library lists (every YANG 1.1 module). nnc reads the
 * library once, the first time an argument needs it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serializeXml, x, XmlElement } from '@node-net/netconf';
import type { RpcHandler } from '@node-net/netconf/testing';
import { BARE, FULL } from './support/caps.js';
import { fixture, type Fixture } from './support/fixture.js';
import { runNnc } from './support/nnc.js';

const YL = 'urn:ietf:params:xml:ns:yang:ietf-yang-library';
const YL_CAP = 'urn:ietf:params:netconf:capability:yang-library:1.1?revision=2019-01-04&content-id=1';
const PL_CAP = 'urn:ietf:params:netconf:capability:partial-lock:1.0';
const PL = 'urn:ietf:params:xml:ns:netconf:partial-lock:1.0';
const ONLY = 'urn:example:library-only';

const LIBRARY = x('yang-library', { xmlns: YL },
  x('module-set', x('name', 'all'), x('module', x('name', 'library-only'), x('revision', '2024-01-01'), x('namespace', ONLY))),
  x('content-id', '1'),
);

const isLibraryGet = (op: XmlElement | undefined): boolean => op?.name === 'get' && serializeXml(op).includes(YL);

const handler: RpcHandler = (_rpc, ctx) => {
  if (isLibraryGet(ctx.operation)) return { data: LIBRARY };
  if (ctx.operation?.name === 'partial-lock') {
    const select = ctx.operation.elements[0]!;
    return { body: [x('lock-id', { xmlns: PL }, '7'), new XmlElement({ ...select, name: 'locked-node', ns: PL })] };
  }
  return ctx.operation?.name === 'partial-unlock' ? 'ok' : { data: [] };
};

describe('OPS-11 arguments over YANG-library-only modules', () => {
  let f: Fixture;
  let noLibrary: Fixture;
  let denied: Fixture;
  let silent: Fixture;
  beforeAll(async () => {
    f = await fixture({ fake: { capabilities: [...FULL, YL_CAP, PL_CAP], handler } });
    f.home.targets({ router1: f.target(), ro: f.target({ readOnly: true }) });
    noLibrary = await fixture({ fake: { capabilities: [...BARE, PL_CAP], handler } });
    // The library read is refused.
    denied = await fixture({
      fake: {
        capabilities: [...FULL, YL_CAP, PL_CAP],
        handler: (rpc, ctx) =>
          isLibraryGet(ctx.operation) ? { errors: [{ type: 'application', tag: 'access-denied', message: 'no library for you' }] } : handler(rpc, ctx),
      },
    });
    // The library read is never answered.
    silent = await fixture({
      fake: { capabilities: [...FULL, YL_CAP, PL_CAP], handler: (rpc, ctx) => (isLibraryGet(ctx.operation) ? undefined : handler(rpc, ctx)) },
    });
  });
  afterAll(async () => {
    await f.close();
    await noLibrary.close();
    await denied.close();
    await silent.close();
  });

  const ops = (fx: Fixture): string[] => fx.sent().map((e) => (isLibraryGet(e) ? 'yang-library' : e.name));

  it('a partial-lock select by YANG path reads the library once, then locks', async () => {
    const r = await runNnc(['router1', '-c', `partial-lock "/library-only:top/item[name='a']"`], { home: f.home });
    expect(r.stderr.split('\n').slice(1).join('\n')).toBe('');
    expect(r.code).toBe(0);
    expect(ops(f)).toEqual(['yang-library', 'partial-lock']);
    expect(serializeXml(f.sent()[1]!)).toContain(
      `<select xmlns:library-only="${ONLY}">/library-only:top/library-only:item[library-only:name='a']</select>`,
    );
  });

  it('an XPath filter whose prefix is a library-only module resolves it the same way', async () => {
    const r = await runNnc(['router1', '-c', 'get --filter xpath /library-only:top'], { home: f.home });
    expect(r.code).toBe(0);
    expect(ops(f)).toEqual(['yang-library', 'get']);
    expect(serializeXml(f.sent()[1]!)).toContain(`xmlns:library-only="${ONLY}"`);
  });

  it('a read-only target refuses partial-lock before reading the library: nothing is sent', async () => {
    const r = await runNnc(['ro', '-c', 'partial-lock /library-only:top'], { home: f.home });
    expect(r.code).toBe(4);
    expect(r.stderr).toContain('partial-lock: refused: ro is read-only');
    expect(r.stderr).toContain('nothing was sent');
    expect(f.rpcsSent()).toBe(0);
  });

  it('a failed library read is reported, without the library API hint', async () => {
    const r = await runNnc(['router1', '-c', 'partial-lock /library-only:top'], { home: denied.home });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('reading the YANG library failed');
    expect(r.stderr).toContain('no library for you');
    expect(r.stderr).not.toContain('loadModules');
    expect(ops(denied)).toEqual(['yang-library']);
  });

  it('--timeout bounds the library read', async () => {
    const started = Date.now();
    const r = await runNnc(['router1', '-c', 'partial-lock /library-only:top --timeout 300'], { home: silent.home });
    expect(r.code).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(8000);
    expect(ops(silent)).toEqual(['yang-library']);
  });

  it("a prefix-like string literal in an XPath doesn't make nnc read the library", async () => {
    const r = await runNnc(['router1', '-c', `get --filter xpath "/lab:top[lab:name='urn:x']"`], { home: f.home });
    expect(r.code).toBe(0);
    expect(ops(f)).toEqual(['get']);
  });

  it('without a YANG library the module stays unknown and nothing is sent', async () => {
    const r = await runNnc(['router1', '-c', `partial-lock /library-only:top`], { home: noLibrary.home });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('library-only');
    expect(noLibrary.rpcsSent()).toBe(0);
  });
});
