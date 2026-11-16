/**
 * PATH-16: `namespaces` lists the module namespaces paths resolve with, from
 * client.content.moduleNamespacesInfo(): each module's namespace and where it
 * came from (given, profile, hello or library), with what it overrode. With
 * --source, that source's own list, whether or not an earlier source wins.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RpcHandler } from '@node-net/netconf/testing';
import { BASE_OPERATIONS, CapabilitySet, serializeXml, x, type XmlElement } from '@node-net/netconf';
import { Cli, type CliIo } from '../src/cli.js';
import { createRegistry } from '../src/commands/index.js';
import { createNodeHost } from '../src/node/host.js';
import { completer } from '../src/repl.js';
import type { ActiveSession } from '../src/sessions/active.js';
import { BASE10, BASE11, FULL } from './support/caps.js';
import { fixture, type Fixture } from './support/fixture.js';
import { runNnc } from './support/nnc.js';

const YL = 'urn:ietf:params:xml:ns:yang:ietf-yang-library';
const YL_CAP = 'urn:ietf:params:netconf:capability:yang-library:1.1?revision=2019-01-04&content-id=1';
const IF = 'urn:ietf:params:xml:ns:yang:ietf-interfaces';
const HELLO_IF = `${IF}?module=ietf-interfaces&revision=2018-02-20`;
const ONLY = 'urn:example:library-only';

const LIBRARY = x('yang-library', { xmlns: YL },
  x('module-set', x('name', 'all'),
    x('module', x('name', 'ietf-interfaces'), x('revision', '2018-02-20'), x('namespace', 'urn:example:wrong')),
    x('module', x('name', 'library-only'), x('revision', '2024-01-01'), x('namespace', ONLY)),
  ),
  x('content-id', '1'),
);

const isLibraryGet = (op: XmlElement | undefined): boolean => op?.name === 'get' && serializeXml(op).includes(YL);
const handler: RpcHandler = (_rpc, ctx) => (isLibraryGet(ctx.operation) ? { data: LIBRARY } : { data: [] });

describe('PATH-16 namespaces', () => {
  let f: Fixture;
  let classic: Fixture;
  let denied: Fixture;
  beforeAll(async () => {
    f = await fixture({ fake: { capabilities: [BASE10, BASE11, YL_CAP, HELLO_IF], handler } });
    f.home.targets({ router1: f.target(), given: f.target({ namespaces: { 'ietf-interfaces': 'urn:given:if' } }) });
    classic = await fixture({ fake: { capabilities: [BASE10, BASE11, HELLO_IF], handler } });
    denied = await fixture({
      fake: {
        capabilities: [BASE10, BASE11, YL_CAP, HELLO_IF],
        handler: () => ({ errors: [{ type: 'application', tag: 'access-denied', message: 'no library for you' }] }),
      },
    });
  });
  afterAll(async () => {
    await Promise.all([f.close(), classic.close(), denied.close()]);
  });

  /** Output lines without the table's rule under the header. */
  const rows = (out: string): string[] => out.trim().split('\n').filter((l) => !l.startsWith('─'));
  const ops = (fx: Fixture): string[] => fx.sent().map((e) => (isLibraryGet(e) ? 'yang-library' : e.name));

  it('lists the hello modules, then those only the library lists, reading it once', async () => {
    const r = await runNnc(['router1', '-c', 'namespaces', '-c', 'namespaces'], { home: f.home });
    expect(r.code).toBe(0);
    const lines = rows(r.stdout);
    expect(lines[0]).toMatch(/^MODULE\s+NAMESPACE\s+SOURCE\s+OVERRIDES$/);
    expect(lines[1]).toMatch(new RegExp(`^ietf-interfaces\\s+${IF}\\s+hello\\s+library urn:example:wrong$`));
    expect(lines[2]).toMatch(new RegExp(`^library-only\\s+${ONLY}\\s+library$`));
    expect(ops(f)).toEqual(['yang-library']);
  });

  it('shows a namespace the target gives, and what it overrides', async () => {
    const r = await runNnc(['given', '-c', 'namespaces ietf-interfaces --json'], { home: f.home });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([
      {
        module: 'ietf-interfaces',
        namespace: 'urn:given:if',
        source: 'given',
        overrides: [
          { source: 'hello', namespace: IF },
          { source: 'library', namespace: 'urn:example:wrong' },
        ],
      },
    ]);
  });

  it('without a YANG library sends nothing and has no OVERRIDES column when nothing is overridden', async () => {
    const r = await runNnc(['router1', '-c', 'namespaces'], { home: classic.home });
    expect(r.code).toBe(0);
    expect(rows(r.stdout)).toEqual([expect.stringMatching(/^MODULE\s+NAMESPACE\s+SOURCE$/), expect.stringMatching(/^ietf-interfaces\s+\S+\s+hello$/)]);
    expect(classic.rpcsSent()).toBe(0);
  });

  it('an unknown module is an error', async () => {
    const r = await runNnc(['router1', '-c', 'namespaces nowhere'], { home: classic.home });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('namespaces: no module nowhere is known to the device');
  });

  it('a failed library read still lists what the session knows, saying so', async () => {
    const r = await runNnc(['router1', '-c', 'namespaces'], { home: denied.home });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^ietf-interfaces\s+\S+\s+hello$/m);
    expect(r.stdout).toContain('reading the YANG library failed');
    expect(r.stdout).toContain('no library for you');
  });
  it('--source hello lists the hello\'s own namespaces, without a SOURCE column', async () => {
    const r = await runNnc(['given', '-c', 'namespaces --source hello'], { home: f.home });
    expect(r.code).toBe(0);
    expect(rows(r.stdout)).toEqual([expect.stringMatching(/^MODULE\s+NAMESPACE$/), expect.stringMatching(new RegExp(`^ietf-interfaces\\s+${IF}$`))]);
  });

  it('--source library lists the library\'s own list, reading it, though the hello wins', async () => {
    const r = await runNnc(['router1', '-c', 'namespaces --source library --json'], { home: f.home });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([
      { module: 'ietf-interfaces', namespace: 'urn:example:wrong', source: 'library' },
      { module: 'library-only', namespace: ONLY, source: 'library' },
    ]);
  });

  it('--source given with a module lists that source only; one it lacks is an error', async () => {
    const r = await runNnc(['given', '-c', 'namespaces ietf-interfaces --source given'], { home: f.home });
    expect(r.code).toBe(0);
    expect(rows(r.stdout)).toEqual([expect.stringMatching(/^MODULE\s+NAMESPACE$/), expect.stringMatching(/^ietf-interfaces\s+urn:given:if$/)]);
    const missing = await runNnc(['given', '-c', 'namespaces library-only --source given'], { home: f.home });
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain('namespaces: no module library-only is in the given namespaces');
  });

  it('--source profile with no profile namespaces lists none', async () => {
    const r = await runNnc(['router1', '-c', 'namespaces --source profile'], { home: classic.home });
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('(no modules)');
  });

  it('a failed library read is noted for --source library, not for --source hello', async () => {
    const lib = await runNnc(['router1', '-c', 'namespaces --source library'], { home: denied.home });
    expect(lib.code).toBe(0);
    expect(lib.stdout).toContain('(no modules)');
    expect(lib.stdout).toContain('no library for you');
    const hello = await runNnc(['router1', '-c', 'namespaces --source hello'], { home: denied.home });
    expect(hello.code).toBe(0);
    expect(hello.stdout).not.toContain('YANG library failed');
  });

  it('an unknown --source is a usage error naming the four', async () => {
    const r = await runNnc(['router1', '-c', 'namespaces --source yang'], { home: classic.home });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('namespaces: --source must be one of given, profile, hello, library');
    expect(classic.rpcsSent()).toBe(0);
  });

  it('Tab completes --source and its values', () => {
    const io: CliIo = { out: () => undefined, err: () => undefined, notice: () => undefined, secret: () => Promise.resolve(undefined) };
    const cli = new Cli(createRegistry(), io, { host: createNodeHost() });
    cli.session = {
      kind: 'client',
      name: 'router1',
      readOnly: false,
      client: { ops: { list: BASE_OPERATIONS }, session: { serverCapabilities: new CapabilitySet(FULL) } },
    } as unknown as ActiveSession;
    const complete = completer(cli);
    expect(complete('namespaces --sou')[0]).toEqual(['--source ']);
    expect(complete('namespaces --source ')[0]).toEqual(['given', 'profile', 'hello', 'library']);
    expect(complete('namespaces --source l')[0]).toEqual(['library ']);
  });
});
