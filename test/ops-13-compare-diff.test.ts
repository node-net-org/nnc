/**
 * OPS-13: `compare` shows the differences between two datastores as a compact
 * diff by default; --xml, --json and --raw show the other forms.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { x, type XmlElement } from '@node-net/netconf';
import type { RpcHandler } from '@node-net/netconf/testing';
import { FULL } from './support/caps.js';
import { fixture, type Fixture } from './support/fixture.js';
import { runNnc } from './support/nnc.js';

const CMP = 'urn:ietf:params:xml:ns:yang:ietf-nmda-compare';
const EX = 'urn:example:lab';
const YL_CAP = 'urn:ietf:params:netconf:capability:yang-library:1.1?revision=2019-01-04&content-id=1';

const edit = (id: string, operation: string, target: string, parts: { value?: XmlElement[]; source?: XmlElement[]; point?: string; where?: string } = {}) =>
  x('edit', x('edit-id', id), x('operation', operation), x('target', target),
    parts.point !== undefined && x('point', parts.point),
    parts.where !== undefined && x('where', parts.where),
    parts.value !== undefined && x('value', parts.value),
    parts.source !== undefined && x('source-value', parts.source));
const entry = (name: string, value: string) => x('parameter', { xmlns: EX }, x('name', name), x('value', value));
const leaf = (value: string) => x('value', { xmlns: EX }, value);

/** Every kind of edit, in Clixon's and RFC 9144's shapes. */
const DIFFERENCES = x('differences', { xmlns: CMP },
  x('yang-patch', x('patch-id', 'p1'), x('comment', 'diff between running (source) and candidate (target)'),
    // Clixon: a deleted entry in <value>.
    edit('1', 'delete', '/lab:table/parameter=a', { value: [entry('a', '1')] }),
    edit('2', 'replace', '/lab:table/parameter=b/value', { value: [leaf('22')], source: [leaf('2')] }),
    edit('3', 'create', '/lab:table/parameter=c', { value: [entry('c', '3')] }),
    // RFC 9144: the removed leaf in <source-value>.
    edit('4', 'remove', '/lab:table/parameter=d/value', { source: [leaf('4')] }),
    edit('5', 'replace', '/lab:table/parameter=e', { value: [entry('e', 'new')], source: [entry('e', 'old')] }),
    edit('6', 'create', '/lab:list=x', { value: [x('list', { xmlns: EX }, x('k', 'x'))] }),
    edit('7', 'move', '/lab:list=y', { point: '/lab:list=x', where: 'after' }),
    edit('8', 'create', '/lab:motd', { value: [x('motd', { xmlns: EX }, 'hi\u009b31mred\u202e')] }),
  ),
);

let reply: XmlElement = DIFFERENCES;
const handler: RpcHandler = (_rpc, ctx) => (ctx.operation?.name === 'compare' ? { body: [reply] } : 'ok');

const EXPECTED = [
  '- delete   /lab:table/parameter=a',
  '    <parameter xmlns="urn:example:lab">',
  '      <name>a</name>',
  '      <value>1</value>',
  '    </parameter>',
  '~ replace  /lab:table/parameter=b/value   2 → 22',
  '+ create   /lab:table/parameter=c',
  '    <parameter xmlns="urn:example:lab">',
  '      <name>c</name>',
  '      <value>3</value>',
  '    </parameter>',
  '- remove   /lab:table/parameter=d/value   4',
  '~ replace  /lab:table/parameter=e',
  '    was:',
  '      <parameter xmlns="urn:example:lab">',
  '        <name>e</name>',
  '        <value>old</value>',
  '      </parameter>',
  '    now:',
  '      <parameter xmlns="urn:example:lab">',
  '        <name>e</name>',
  '        <value>new</value>',
  '      </parameter>',
  '+ create   /lab:list=x',
  '    <list xmlns="urn:example:lab">',
  '      <k>x</k>',
  '    </list>',
  '> move     /lab:list=y   after /lab:list=x',
  '+ create   /lab:motd   hi\\x9b31mred\\u202e',
  '8 differences (running → candidate)',
  '',
].join('\n');

describe('OPS-13 compare as a compact diff', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await fixture({ fake: { capabilities: [...FULL, YL_CAP], handler } });
  });
  afterAll(async () => {
    await f.close();
  });

  const run = (...cmds: string[]) => runNnc(['router1', ...cmds.flatMap((c) => ['-c', c])], { home: f.home });

  it('AC1-AC4, AC6: one line per difference, leaves inline, larger values indented, moves with their place, device text escaped', async () => {
    reply = DIFFERENCES;
    const r = await run('compare running candidate');
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(EXPECTED);
  });

  it('AC5: an empty patch says no differences, <no-matches/> says no matches, one edit is singular', async () => {
    reply = x('differences', { xmlns: CMP }, x('yang-patch', x('patch-id', 'p')));
    expect((await run('compare intended operational')).stdout).toBe('no differences (intended → operational)\n');
    reply = x('no-matches', { xmlns: CMP });
    expect((await run('compare intended operational')).stdout).toBe('no matches (intended → operational)\n');
    reply = x('differences', { xmlns: CMP }, x('yang-patch', x('patch-id', 'p'), edit('1', 'create', '/lab:x', { value: [leaf('1')] })));
    expect((await run('compare running startup')).stdout).toBe('+ create   /lab:x   1\n1 difference (running → startup)\n');
  });

  it('AC6 (review): device text cannot forge diff lines; empty, padded and annotated values stay visible', async () => {
    const OR = 'urn:ietf:params:xml:ns:yang:ietf-origin';
    reply = x('differences', { xmlns: CMP }, x('yang-patch', x('patch-id', 'p'),
      edit('1', 'replace', '/lab:banner', {
        value: [x('banner', { xmlns: EX }, 'line1\n- delete   /lab:spoof\n1 difference (running → candidate)')],
        source: [x('banner', { xmlns: EX }, 'old')],
      }),
      edit('2', 'replace', '/lab:x', { value: [leaf('v ')], source: [leaf('v')] }),
      edit('3', 'delete', '/lab:y', { value: [leaf('')] }),
      edit('4', 'replace', '/lab:z', { value: [leaf('1')] }),
      edit('5', 'replace', '/lab:o', {
        value: [x('o', { xmlns: EX, 'xmlns:or': OR, origin: { ns: OR, prefix: 'or', value: 'or:learned' } }, '2')],
        source: [x('o', { xmlns: EX, 'xmlns:or': OR, origin: { ns: OR, prefix: 'or', value: 'or:intended' } }, '2')],
      }),
      edit('6', 'insert', '/lab:l=2', { point: '/lab:l=1', where: 'after', value: [x('l', { xmlns: EX }, '2')] }),
      edit('7', 'create', '/lab:leaf-list', { value: [x('ll', { xmlns: EX }, 'a'), x('ll', { xmlns: EX }, 'b')] }),
    ));
    const r = await run('compare running candidate');
    expect(r.code).toBe(0);
    expect(r.stdout).toBe([
      '~ replace  /lab:banner   old → "line1\\n- delete   /lab:spoof\\n1 difference (running → candidate)"',
      '~ replace  /lab:x   v → "v "',
      '- delete   /lab:y   ""',
      '~ replace  /lab:z   (not sent) → 1',
      '~ replace  /lab:o',
      '    was:',
      '      <o xmlns:or="urn:ietf:params:xml:ns:yang:ietf-origin" xmlns="urn:example:lab" or:origin="or:intended">2</o>',
      '    now:',
      '      <o xmlns:or="urn:ietf:params:xml:ns:yang:ietf-origin" xmlns="urn:example:lab" or:origin="or:learned">2</o>',
      '+ insert   /lab:l=2   after /lab:l=1   2',
      '+ create   /lab:leaf-list',
      '    <ll xmlns="urn:example:lab">a</ll>',
      '    <ll xmlns="urn:example:lab">b</ll>',
      '7 differences (running → candidate)',
      '',
    ].join('\n'));
    // An absent patch-id is left out of --json.
    reply = x('differences', { xmlns: CMP }, x('yang-patch'));
    expect(JSON.parse((await run('compare running candidate --json')).stdout)).not.toHaveProperty('patchId');
  });

  it('AC6 (review): control characters are escaped in the indented XML and in --json too', async () => {
    reply = x('differences', { xmlns: CMP }, x('yang-patch', x('patch-id', 'p'),
      edit('1', 'create', '/lab:c', { value: [x('c', { xmlns: EX }, x('d', 'x\u009b31m‮'))] })));
    const text = (await run('compare running candidate')).stdout;
    const json = (await run('compare running candidate --json')).stdout;
    for (const out of [text, json]) {
      expect(out).not.toMatch(/[\u0080-\u009f‪-‮⁦-⁩]/);
      expect(out).toContain('x');
    }
  });

  it('a reply that is not a compare reply is shown as XML', async () => {
    reply = x('unexpected', { xmlns: EX }, 'z');
    const r = await run('compare running candidate');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('<unexpected xmlns="urn:example:lab">z</unexpected>');
    expect(r.stdout).not.toContain('difference');
  });

  it('AC7: --xml shows the reply XML, --json the decoded differences, --raw the reply as received', async () => {
    reply = DIFFERENCES;
    const xml = await run('compare running candidate --xml');
    expect(xml.stdout).toContain('<differences xmlns="urn:ietf:params:xml:ns:yang:ietf-nmda-compare">');
    expect(xml.stdout).not.toContain('8 differences');
    expect(xml.stdout).toContain('<operation>move</operation>');

    const json = JSON.parse((await run('compare running candidate --json')).stdout) as {
      noMatches: boolean; patchId: string; comment: string;
      edits: { editId: string; operation: string; target: string; point?: string; where?: string; value: unknown[]; sourceValue: unknown[] }[];
    };
    expect(json.noMatches).toBe(false);
    expect(json.patchId).toBe('p1');
    expect(json.comment).toBe('diff between running (source) and candidate (target)');
    expect(json.edits).toHaveLength(8);
    expect(json.edits[1]).toEqual({ editId: '2', operation: 'replace', target: '/lab:table/parameter=b/value', value: [{ value: '22' }], sourceValue: [{ value: '2' }] });
    expect(json.edits[6]).toMatchObject({ operation: 'move', point: '/lab:list=x', where: 'after', value: [], sourceValue: [] });
    expect(json.edits[0]!.value).toEqual([{ parameter: { name: 'a', value: '1' } }]);

    const raw = await run('compare running candidate --raw');
    expect(raw.stdout).toMatch(/^(<\?xml[^>]*\?>)?<rpc-reply [^>]*message-id="\d+"[^>]*>/);
    expect(raw.stdout).toContain('<edit-id>7</edit-id>');
  });

  it('AC8: output json/raw set the format; output xml keeps the diff as the default; --xml gives XML; redirects and show-last follow', async () => {
    reply = DIFFERENCES;
    const jsonSetting = await run('output json', 'compare running candidate');
    expect(JSON.parse(jsonSetting.stdout.slice(jsonSetting.stdout.indexOf('{')))).toMatchObject({ patchId: 'p1' });

    const rawSetting = await run('output raw', 'compare running candidate');
    expect(rawSetting.stdout).toMatch(/<rpc-reply [^>]*message-id="\d+"/);
    expect(rawSetting.stdout).not.toContain('8 differences');

    const xmlSetting = await run('output xml', 'compare running candidate');
    expect(xmlSetting.stdout.endsWith(EXPECTED)).toBe(true);

    const file = join(f.home.dir, 'diff.txt');
    const redirected = await run(`compare running candidate > ${file}`);
    expect(redirected.code).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(EXPECTED);

    const again = await run('compare running candidate --xml', 'show-last');
    expect(again.stdout.endsWith(EXPECTED)).toBe(true);
  });
});
