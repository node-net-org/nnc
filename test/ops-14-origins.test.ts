/**
 * OPS-14: `get-data --with-origin` shows each leaf's path, value and resolved
 * origin (RFC 8526) by default; --xml, --json and --raw show the other forms.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NETCONF_NS, parseXml, x, type XmlElement } from '@node-net/netconf';
import type { RpcHandler } from '@node-net/netconf/testing';
import { FULL } from './support/caps.js';
import { fixture, type Fixture } from './support/fixture.js';
import { runNnc } from './support/nnc.js';

const NMDA = 'urn:ietf:params:xml:ns:yang:ietf-netconf-nmda';
const OR = 'urn:ietf:params:xml:ns:yang:ietf-origin';
const IF = 'urn:ietf:params:xml:ns:yang:ietf-interfaces';
const YL = 'urn:ietf:params:xml:ns:yang:ietf-yang-library';
const CAPS = [
  ...FULL,
  'urn:ietf:params:netconf:capability:yang-library:1.1?revision=2019-01-04&content-id=1',
  // ietf-interfaces is named in the hello; urn:example:ext only in the YANG library.
  `${IF}?module=ietf-interfaces&revision=2018-02-20`,
];

const DATA = `<data xmlns="${NMDA}" xmlns:or="${OR}">
  <interfaces xmlns="${IF}" or:origin="or:intended">
    <interface>
      <name>eth0</name>
      <enabled>true</enabled>
      <oper-status or:origin="or:learned">up</oper-status>
      <speed or:origin="or:system">1000000</speed>
    </interface>
    <interface>
      <name>eth1</name>
      <description> padded </description>
      <alias>a\u009b31mb‮</alias>
    </interface>
  </interfaces>
  <counters xmlns="urn:example:ext"><hits>5</hits></counters>
  <thing xmlns="urn:example:unknown" xmlns:ex="urn:example:ext" or:origin="ex:custom"><x>1</x></thing>
</data>`;

const topOf = (op: XmlElement | undefined): string | undefined => (op?.name === 'get' ? op.child('filter', NETCONF_NS)?.elements[0]?.name : undefined);

let data = DATA;
let libraryFails = false;
const handler: RpcHandler = (_rpc, { operation }) => {
  if (operation?.name === 'get-data') return { body: [parseXml(data)] };
  if (topOf(operation) === 'yang-library' && libraryFails) return { errors: [{ type: 'application', tag: 'operation-failed', message: 'no library here' }] };
  if (topOf(operation) === 'yang-library') {
    return { data: [x('yang-library', { xmlns: YL }, x('module-set', x('name', 'all'), x('module', x('name', 'example-ext'), x('namespace', 'urn:example:ext'))), x('content-id', '1'))] };
  }
  return { data: [] };
};

/** The view's rows as [path, value, origin]. */
const rows = (text: string): string[][] =>
  text
    .trimEnd()
    .split('\n')
    .slice(0, -1)
    .map((l) => l.split(/ {3,}/));

describe('OPS-14 origins view', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await fixture({ fake: { capabilities: CAPS, handler } });
  });
  afterAll(async () => {
    await f.close();
  });

  const run = (...cmds: string[]) => runNnc(['router1', ...cmds.flatMap((c) => ['-c', c])], { home: f.home });

  it('AC1-AC3, AC5: one row per leaf with its path, value and resolved origin; inherited origins, inferred keys, module names, escaping', async () => {
    data = DATA;
    const r = await run('get-data operational --with-origin');
    expect(r.code).toBe(0);
    expect(rows(r.stdout)).toEqual([
      ['/ietf-interfaces:interfaces/interface[name=eth0]/name', 'eth0', 'intended'],
      ['/ietf-interfaces:interfaces/interface[name=eth0]/enabled', 'true', 'intended'],
      ['/ietf-interfaces:interfaces/interface[name=eth0]/oper-status', 'up', 'learned'],
      ['/ietf-interfaces:interfaces/interface[name=eth0]/speed', '1000000', 'system'],
      ['/ietf-interfaces:interfaces/interface[name=eth1]/name', 'eth1', 'intended'],
      ['/ietf-interfaces:interfaces/interface[name=eth1]/description', '" padded "', 'intended'],
      ['/ietf-interfaces:interfaces/interface[name=eth1]/alias', 'a\\x9b31mb\\u202e', 'intended'],
      ['/example-ext:counters/hits', '5', '-'],
      ['/{urn:example:unknown}:thing/x', '1', 'example-ext:custom'],
    ]);
    // Columns line up.
    const lines = r.stdout.split('\n').slice(0, 9);
    const valueColumn = (l: string): number => {
      const gap = / {3,}/.exec(l)!;
      return gap.index + gap[0].length;
    };
    expect(new Set(lines.map(valueColumn)).size).toBe(1);
  });

  it('AC2 (real-server finding): entries sharing a first leaf are told apart by as many leading leaves as it takes; long values do not widen every row', async () => {
    const NCM = 'urn:ietf:params:xml:ns:yang:ietf-netconf-monitoring';
    data = `<data xmlns="${NMDA}" xmlns:or="${OR}"><netconf-state xmlns="${NCM}" or:origin="or:unknown"><schemas>
      <schema><identifier>nn-lab</identifier><version>1</version><format>yang</format><location>NETCONF</location></schema>
      <schema><identifier>nn-lab</identifier><version>1</version><format>yin</format><location>NETCONF</location></schema>
      <schema><identifier>other</identifier><version>1</version><format>yang</format><location>${'L'.repeat(200)}</location></schema>
    </schemas></netconf-state></data>`;
    const r = await run('get-data operational --with-origin');
    const paths = rows(r.stdout).map((row) => row[0]);
    expect(paths).toContain('/{urn:ietf:params:xml:ns:yang:ietf-netconf-monitoring}:netconf-state/schemas/schema[identifier=nn-lab][version=1][format=yin]/location');
    // One key depth per list (review): every entry of the list shows the same keys.
    expect(paths).toContain('/{urn:ietf:params:xml:ns:yang:ietf-netconf-monitoring}:netconf-state/schemas/schema[identifier=other][version=1][format=yang]/location');
    expect(new Set(paths).size).toBe(paths.length);
    // The 200-character value pads no other row: short rows stay short.
    const short = r.stdout.split('\n').find((l) => l.includes('[format=yang]/identifier'))!;
    expect(short.length).toBeLessThan(220);
  });

  it('AC2: the YANG library is read once, only for namespaces the hello does not name', async () => {
    data = DATA;
    await run('get-data operational --with-origin', 'get-data operational --with-origin');
    expect(f.sent().filter((op) => topOf(op) === 'yang-library')).toHaveLength(1);
    data = `<data xmlns="${NMDA}" xmlns:or="${OR}"><interfaces xmlns="${IF}" or:origin="or:intended"><interface><name>eth0</name></interface></interfaces></data>`;
    await run('get-data operational --with-origin');
    expect(f.sent().filter((op) => topOf(op) === 'yang-library')).toHaveLength(0);
  });

  it('AC4: the last line counts the leaves by origin; empty data says no data; one leaf is singular', async () => {
    data = DATA;
    const r = await run('get-data operational --with-origin');
    expect(r.stdout.trimEnd().split('\n').at(-1)).toBe('9 leaves: 5 intended, 1 learned, 1 system, 1 without an origin, 1 example-ext:custom');
    data = `<data xmlns="${NMDA}"/>`;
    expect((await run('get-data operational --with-origin')).stdout).toBe('no data\n');
    data = `<data xmlns="${NMDA}" xmlns:or="${OR}"><hostname xmlns="urn:example:ext" or:origin="or:intended">r1</hostname></data>`;
    expect((await run('get-data operational --with-origin')).stdout).toBe('/example-ext:hostname   r1   intended\n1 leaf: 1 intended\n');
  });

  it('review: a very large list renders in linear time', async () => {
    const n = 20_000;
    const entries = Array.from({ length: n }, (_, i) => `<route><prefix>10.${i >> 8}.${i & 255}.0/24</prefix><next-hop>x</next-hop></route>`).join('');
    data = `<data xmlns="${NMDA}" xmlns:or="${OR}"><routes xmlns="urn:example:ext" or:origin="or:learned">${entries}</routes></data>`;
    const started = Date.now();
    const r = await run('get-data operational --with-origin');
    expect(r.code).toBe(0);
    expect(r.stdout.trimEnd().split('\n').at(-1)).toBe(`${2 * n} leaves: ${2 * n} learned`);
    // Quadratic keying took over 3 minutes for this; linear takes a second or two, connection included.
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 30_000);

  it("review: device text can't fake paths, columns, the no-origin marker or the tally", async () => {
    data = `<data xmlns="${NMDA}" xmlns:or="${OR}"><t xmlns="urn:example:ext" or:origin="or:intended">
      <e><n>x]/f[n=y</n><v>1</v></e>
      <e><n>two words</n><v>2</v></e>
      <odd or:origin="or:-">a</odd>
      <comma or:origin="or:a, 3 learned">b</comma>
      <spaced>up   learned</spaced>
    </t></data>`;
    const r = await run('get-data operational --with-origin');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('/example-ext:t/e[n="x]/f[n=y"]/v');
    expect(r.stdout).toContain('/example-ext:t/e[n="two words"]/v');
    expect(r.stdout).toMatch(/\/example-ext:t\/odd {3,}a {3,}"-"/);
    expect(r.stdout).toContain('"up   learned"');
    expect(r.stdout.trimEnd().split('\n').at(-1)).toBe('7 leaves: 5 intended, 1 "-", 1 "a, 3 learned"');
    expect(r.stdout).not.toContain('without an origin');
  });

  it('review: an origin prefix declared on <rpc-reply> or deep inside still resolves', async () => {
    data = `<data xmlns="${NMDA}"><a xmlns="urn:example:ext"><b xmlns:o="${OR}" o:origin="o:system"><c>1</c></b></a></data>`;
    const r = await run('get-data operational --with-origin');
    expect(r.stdout).toBe('/example-ext:a/b/c   1   system\n1 leaf: 1 system\n');
  });

  it('review: the YANG library is not read without --with-origin; a failed read is not retried in the session', async () => {
    data = DATA;
    await run('get-data operational');
    expect(f.sent().filter((op) => topOf(op) === 'yang-library')).toHaveLength(0);
    libraryFails = true;
    try {
      const r = await run('get-data operational --with-origin', 'get-data operational --with-origin');
      expect(r.code).toBe(0);
      expect(f.sent().filter((op) => topOf(op) === 'yang-library')).toHaveLength(1);
      expect(r.stdout).toContain('/{urn:example:ext}:counters/hits');
    } finally {
      libraryFails = false;
    }
  });

  it('AC6: the view also goes to a > file and to show-last', async () => {
    data = `<data xmlns="${NMDA}" xmlns:or="${OR}"><hostname xmlns="urn:example:ext" or:origin="or:intended">r1</hostname></data>`;
    const file = `${f.home.dir}/origins.txt`;
    const r = await run(`get-data operational --with-origin > ${file}`, 'show-last');
    expect(readFileSync(file, 'utf8')).toBe('/example-ext:hostname   r1   intended\n1 leaf: 1 intended\n');
    expect(r.stdout.endsWith('/example-ext:hostname   r1   intended\n1 leaf: 1 intended\n')).toBe(true);
  });

  it('AC6: --xml shows the reply XML with its annotations, --json the rows, --raw the reply; without --with-origin nothing changes', async () => {
    data = DATA;
    const xml = await run('get-data operational --with-origin --xml');
    expect(xml.stdout).toContain('or:origin="or:learned"');
    expect(xml.stdout).not.toContain('9 leaves');

    const json = JSON.parse((await run('get-data operational --with-origin --json')).stdout) as { path: string; value: string; origin: string | null }[];
    expect(json).toHaveLength(9);
    expect(json[2]).toEqual({ path: '/ietf-interfaces:interfaces/interface[name=eth0]/oper-status', value: 'up', origin: 'learned' });
    expect(json[7]).toEqual({ path: '/example-ext:counters/hits', value: '5', origin: null });

    const raw = await run('get-data operational --with-origin --raw');
    expect(raw.stdout).toMatch(/^(<\?xml[^>]*\?>)?<rpc-reply /);

    const plain = await run('get-data operational');
    expect(plain.stdout).toContain('<interfaces');
    expect(plain.stdout).not.toContain('leaves:');

    const setting = await run('output json', 'get-data operational --with-origin');
    expect(setting.stdout).toContain('"origin": "learned"');
  });
});
