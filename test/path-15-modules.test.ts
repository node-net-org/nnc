/**
 * PATH-15: `modules` lists the device's YANG modules and features from
 * client.content.modules(): the YANG library's on an NMDA server, the hello's
 * module capabilities otherwise, saying which; --all-features adds the features
 * each module's source declares.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serializeXml, x, type XmlElement } from '@node-net/netconf';
import type { RpcHandler } from '@node-net/netconf/testing';
import { BASE10, BASE11 } from './support/caps.js';
import { fixture, type Fixture } from './support/fixture.js';
import { runNnc } from './support/nnc.js';

const YL = 'urn:ietf:params:xml:ns:yang:ietf-yang-library';
const DS = 'urn:ietf:params:xml:ns:yang:ietf-datastores';
const NC = 'urn:ietf:params:xml:ns:netconf:base:1.0';
const FD = 'urn:ietf:params:xml:ns:yang:ietf-factory-default';
const YL_CAP = 'urn:ietf:params:netconf:capability:yang-library:1.1?revision=2019-01-04&content-id=1';

const mod = (name: string, ns: string, revision: string, ...rest: XmlElement[]): XmlElement =>
  x('module', x('name', name), x('revision', revision), x('namespace', ns), ...rest);

const LIBRARY = x('yang-library', { xmlns: YL, 'xmlns:ds': DS, 'xmlns:fd': FD },
  x('module-set', x('name', 'config'),
    mod('ietf-netconf', NC, '2011-06-01', x('feature', 'writable-running'), x('feature', 'candidate'), x('feature', 'vendor-extra')),
    mod('acme', 'urn:example:acme', '2026-01-01', x('feature', 'turbo'), x('deviation', 'acme-dev')),
    x('import-only-module', x('name', 'ietf-inet-types'), x('revision', '2013-07-15'), x('namespace', 'urn:ietf:params:xml:ns:yang:ietf-inet-types')),
  ),
  x('module-set', x('name', 'state'), mod('ietf-factory-default', FD, '2020-08-31')),
  x('schema', x('name', 'config'), x('module-set', 'config')),
  x('schema', x('name', 'complete'), x('module-set', 'config'), x('module-set', 'state')),
  x('datastore', x('name', 'ds:running'), x('schema', 'config')),
  x('datastore', x('name', 'ds:operational'), x('schema', 'complete')),
  x('datastore', x('name', 'fd:factory-default'), x('schema', 'complete')),
  x('content-id', '1'),
);

const HELLO_MODULE = `${NC}?module=ietf-netconf&revision=2011-06-01&features=writable-running,candidate`;

const isLibraryGet = (op: XmlElement | undefined): boolean => op?.name === 'get' && serializeXml(op).includes(YL);
const handler: RpcHandler = (_rpc, ctx) => (isLibraryGet(ctx.operation) ? { data: LIBRARY } : { data: [] });

describe('PATH-15 modules', () => {
  let nmda: Fixture;
  let classic: Fixture;
  let denied: Fixture;
  beforeAll(async () => {
    nmda = await fixture({ fake: { capabilities: [BASE10, BASE11, YL_CAP], handler } });
    nmda.home.targets({ router1: nmda.target(), ro: nmda.target({ readOnly: true }) });
    classic = await fixture({ fake: { capabilities: [BASE10, BASE11, HELLO_MODULE], handler } });
    classic.home.targets({ router1: classic.target() });
    denied = await fixture({
      fake: { capabilities: [BASE10, BASE11, YL_CAP], handler: () => ({ errors: [{ type: 'application', tag: 'access-denied', message: 'no library for you' }] }) },
    });
    denied.home.targets({ router1: denied.target() });
  });
  afterAll(async () => {
    await Promise.all([nmda.close(), classic.close(), denied.close()]);
  });

  const run = (f: Fixture, target: string, ...cmds: string[]) => runNnc([target, ...cmds.flatMap((c) => ['-c', c])], { home: f.home });
  const lines = (stdout: string): string[] => stdout.trimEnd().split('\n');

  it("AC1: running's modules from the YANG library, as a table, with the datastore, schema and source", async () => {
    const r = await run(nmda, 'router1', 'modules');
    expect(r.code).toBe(0);
    const out = lines(r.stdout);
    expect(out.slice(0, 4)).toEqual(['Source: YANG library', 'Datastore: running', 'Schema: config', '']);
    expect(out[4]).toMatch(/^MODULE\s+REVISION\s+CONFORMANCE\s+FEATURES\s+DEVIATIONS$/);
    expect(out.find((l) => l.startsWith('ietf-netconf '))).toMatch(/^ietf-netconf\s+2011-06-01\s+implement\s+writable-running,candidate,vendor-extra$/);
    expect(out.find((l) => l.startsWith('acme '))).toMatch(/^acme\s+2026-01-01\s+implement\s+turbo\s+acme-dev$/);
    expect(out.find((l) => l.startsWith('ietf-inet-types'))).toMatch(/^ietf-inet-types\s+2013-07-15\s+import$/);
    expect(out.some((l) => l.startsWith('ietf-factory-default'))).toBe(false);
  });

  it('AC1: without a YANG library, the hello modules and nothing sent', async () => {
    const r = await run(classic, 'router1', 'modules');
    expect(r.code).toBe(0);
    const out = lines(r.stdout);
    expect(out.find((l) => l.startsWith('ietf-netconf'))).toMatch(/^ietf-netconf\s+2011-06-01\s+implement\s+writable-running,candidate$/);
    expect(out.slice(0, 2)).toEqual(["Source: the hello's module capabilities (the server has no YANG library)", '']);
    expect(classic.rpcsSent()).toBe(0);
  });

  it('AC2: one module; another datastore by name or module:name; a schema by name', async () => {
    const one = await run(nmda, 'router1', 'modules acme');
    expect(lines(one.stdout).filter((l) => /^\w/.test(l) && !l.startsWith('MODULE') && !/^\w+: /.test(l))).toHaveLength(1);
    const operational = await run(nmda, 'router1', 'modules ietf-factory-default --datastore operational');
    expect(operational.stdout).toMatch(/^ietf-factory-default\s+2020-08-31\s+implement/m);
    expect(lines(operational.stdout).slice(0, 3)).toEqual(['Source: YANG library', 'Datastore: operational', 'Schema: complete']);
    const identity = await run(nmda, 'router1', 'modules ietf-factory-default --datastore ietf-factory-default:factory-default');
    expect(identity.code).toBe(0);
    expect(identity.stdout).toMatch(/^ietf-factory-default\s/m);
    const schema = await run(nmda, 'router1', 'modules --schema complete');
    expect(schema.stdout).toMatch(/^ietf-factory-default\s/m);
    expect(lines(schema.stdout).slice(0, 3)).toEqual(['Source: YANG library', 'Schema: complete', '']);
    const none = await run(nmda, 'router1', 'modules no-such-module');
    expect(lines(none.stdout)).toEqual(['Source: YANG library', 'Datastore: running', 'Schema: config', '', '(no modules)']);
  });

  it('AC2: --datastore with --schema is a usage error and sends nothing; an unlisted datastore is an error', async () => {
    const both = await run(classic, 'router1', 'modules --datastore running --schema config');
    expect(both.code).not.toBe(0);
    expect(both.stdout + both.stderr).toContain('not both');
    expect(classic.rpcsSent()).toBe(0);
    const unlisted = await run(nmda, 'router1', 'modules --datastore candidate');
    expect(unlisted.code).not.toBe(0);
    expect(unlisted.stdout + unlisted.stderr).toContain("doesn't list datastore candidate");
    const bad = await run(nmda, 'router1', 'modules --datastore nonsense');
    expect(bad.code).not.toBe(0);
    expect(bad.stdout + bad.stderr).toContain('module:name');
  });

  it('AC3: --all-features lists each declared feature with whether it is supported', async () => {
    const r = await run(nmda, 'router1', 'modules --all-features');
    expect(r.code).toBe(0);
    const out = lines(r.stdout);
    expect(out[4]).toMatch(/^MODULE\s+FEATURE\s+SUPPORTED$/);
    expect(out).toContainEqual(expect.stringMatching(/^ietf-netconf\s+candidate\s+yes$/));
    expect(out).toContainEqual(expect.stringMatching(/^ietf-netconf\s+url\s+no$/));
    expect(out).toContainEqual(expect.stringMatching(/^ietf-netconf\s+vendor-extra\s+yes \(not in the module's source\)$/));
    expect(out).toContainEqual(expect.stringMatching(/^acme\s+\(source not found\)$/));
    expect(out.some((l) => l.startsWith('ietf-inet-types'))).toBe(false);
  });

  it('AC4: --json prints the library result', async () => {
    const r = await run(classic, 'router1', 'modules --json');
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      source: 'capabilities',
      modules: [{ name: 'ietf-netconf', revision: '2011-06-01', namespace: NC, conformance: 'implement', features: ['writable-running', 'candidate'], deviations: [], submodules: [], locations: [] }],
    });
  });

  it('AC5: one library read, and it runs on a read-only target', async () => {
    const r = await run(nmda, 'ro', 'modules', 'datastores', 'modules ietf-netconf');
    expect(r.code).toBe(0);
    expect(nmda.sent().filter(isLibraryGet)).toHaveLength(1);
  });

  it('AC5: a failed library read is shown as an rpc-error', async () => {
    const r = await run(denied, 'router1', 'modules');
    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).toContain('access-denied');
  });

  it('AC6: help lists it', async () => {
    const r = await run(classic, 'router1', 'help modules');
    expect(r.stdout).toContain('modules');
    expect(r.stdout).toContain('--all-features');
  });
});
