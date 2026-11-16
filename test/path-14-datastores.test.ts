/**
 * PATH-14: `datastores` lists the device's datastores from
 * client.content.datastores(): the YANG library's list on an NMDA server, the
 * capabilities otherwise, saying which.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serializeXml, x, type XmlElement } from '@node-net/netconf';
import type { RpcHandler } from '@node-net/netconf/testing';
import { BARE, FULL } from './support/caps.js';
import { fixture, type Fixture } from './support/fixture.js';
import { runNnc } from './support/nnc.js';

const YL = 'urn:ietf:params:xml:ns:yang:ietf-yang-library';
const DS = 'urn:ietf:params:xml:ns:yang:ietf-datastores';
const FD = 'urn:ietf:params:xml:ns:yang:ietf-factory-default';
const UNKNOWN = 'urn:example:unlisted';
const YL_CAP = 'urn:ietf:params:netconf:capability:yang-library:1.1?revision=2019-01-04&content-id=1';

const LIBRARY = x('yang-library', { xmlns: YL, 'xmlns:ds': DS, 'xmlns:fd': FD, 'xmlns:u': UNKNOWN },
  x('module-set', x('name', 'all'), x('module', x('name', 'ietf-factory-default'), x('namespace', FD))),
  x('schema', x('name', 'complete'), x('module-set', 'all')),
  x('datastore', x('name', 'ds:running'), x('schema', 'complete')),
  x('datastore', x('name', 'ds:operational'), x('schema', 'complete')),
  x('datastore', x('name', 'fd:factory-default'), x('schema', 'complete')),
  x('datastore', x('name', 'u:scratch'), x('schema', 'complete')),
  x('content-id', '1'),
);

const isLibraryGet = (op: XmlElement | undefined): boolean => op?.name === 'get' && serializeXml(op).includes(YL);
const handler: RpcHandler = (_rpc, ctx) => (isLibraryGet(ctx.operation) ? { data: LIBRARY } : { data: [] });

describe('PATH-14 datastores', () => {
  let nmda: Fixture;
  let classic: Fixture;
  let denied: Fixture;
  beforeAll(async () => {
    nmda = await fixture({ fake: { capabilities: [...BARE, YL_CAP], handler } });
    nmda.home.targets({ router1: nmda.target(), ro: nmda.target({ readOnly: true }) });
    classic = await fixture({ fake: { capabilities: FULL, handler } });
    classic.home.targets({ router1: classic.target() });
    denied = await fixture({
      fake: { capabilities: [...BARE, YL_CAP], handler: () => ({ errors: [{ type: 'application', tag: 'access-denied', message: 'no library for you' }] }) },
    });
    denied.home.targets({ router1: denied.target() });
  });
  afterAll(async () => {
    await Promise.all([nmda.close(), classic.close(), denied.close()]);
  });

  const run = (f: Fixture, target: string, ...cmds: string[]) => runNnc([target, ...cmds.flatMap((c) => ['-c', c])], { home: f.home });

  it('AC1, AC2: on an NMDA server, the library list with schemas, other modules as module:name, and the source', async () => {
    const r = await run(nmda, 'router1', 'datastores');
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(
      [
        'DATASTORE                             SCHEMA',
        '─'.repeat(46),
        'running                               complete',
        'operational                           complete',
        'ietf-factory-default:factory-default  complete',
        'urn:example:unlisted:scratch          complete',
        '(from the YANG library)',
        '',
      ].join('\n'),
    );
  });

  it('AC4: one library read, and it runs on a read-only target', async () => {
    const r = await run(nmda, 'ro', 'datastores', 'datastores');
    expect(r.code).toBe(0);
    expect(nmda.sent().filter(isLibraryGet)).toHaveLength(1);
  });

  it('AC1: without a YANG library, the capabilities list and nothing sent', async () => {
    const r = await run(classic, 'router1', 'datastores');
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(
      ['DATASTORE', '─────────', 'running', 'candidate', 'startup', "(from the hello's capabilities: the server has no YANG library datastore list)", ''].join('\n'),
    );
    expect(classic.rpcsSent()).toBe(0);
  });

  it('AC3: --json prints the library result', async () => {
    const r = await run(classic, 'router1', 'datastores --json');
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      source: 'capabilities',
      datastores: ['running', 'candidate', 'startup'].map((name) => ({ name: `ietf-datastores:${name}` })),
    });
  });

  it('AC4: a failed library read is shown as an rpc-error', async () => {
    const r = await run(denied, 'router1', 'datastores');
    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).toContain('access-denied');
  });

  it('AC5: help lists it in the content section', async () => {
    const r = await run(classic, 'router1', 'help datastores');
    expect(r.stdout).toContain('datastores');
    expect(r.stdout).toContain('YANG library');
  });
});
