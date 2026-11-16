/**
 * LANG-06: View results as XML, JSON or raw.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Fixture } from './support/fixture.js';
import { runNnc } from './support/nnc.js';
import { RPC, outputFixture } from './support/output.js';
import { HAS_PTY, SGR, plain, runPty } from './support/pty.js';

const CONFIG_XML = '<system xmlns="urn:example:lab">\n  <hostname>router1</hostname>\n</system>\n';

describe('LANG-06 XML, JSON and raw', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await outputFixture();
  });
  afterAll(() => f.close());

  it('AC1: data replies are shown as indented XML without the <rpc-reply> wrapper', async () => {
    const r = await runNnc(['router1', '-c', 'get-config running'], { home: f.home });
    expect(r.stdout).toBe(CONFIG_XML);
  });

  it.skipIf(!HAS_PTY)('AC2: on a terminal names, attributes and text are coloured; not with NO_COLOR, nor off a terminal', async () => {
    const steps = [{ wait: /nnc router1> $/, send: 'get-config running\r' }, { wait: /nnc router1> $/, send: 'exit\r' }];
    const coloured = await runPty(['router1'], steps, { home: f.home, env: { NO_COLOR: undefined } });
    expect(coloured).toContain('\u001b[36m<system\u001b[0m \u001b[33mxmlns\u001b[0m=\u001b[32m"urn:example:lab"\u001b[0m');
    expect(plain(coloured)).toContain('<hostname>router1</hostname>');
    const noColor = await runPty(['router1'], steps, { home: f.home, env: { NO_COLOR: '1' } });
    expect(noColor).not.toMatch(SGR);
    expect(noColor).toContain('<hostname>router1</hostname>');
    const piped = await runNnc(['router1', '-c', 'get-config running'], { home: f.home, env: { NO_COLOR: undefined } });
    expect(piped.stdout).not.toMatch(SGR);
  });

  it('AC3: --json shows the result as JSON', async () => {
    const r = await runNnc(['router1', '-c', 'get-config running --json', '-c', `${RPC.big} --json`], { home: f.home });
    expect(r.code).toBe(0);
    const [config] = r.stdout.split('\n}\n');
    expect(JSON.parse(`${config!}\n}`)).toEqual({ 'lab:system': { hostname: 'router1' } });
  });

  it('AC4: --raw shows the reply exactly as received, wrapper included', async () => {
    const r = await runNnc(['router1', '-c', 'get-config running --raw', '-c', 'rpc <get/> --raw'], { home: f.home });
    expect(r.code).toBe(0);
    const replies = r.stdout.trim().split('\n');
    expect(replies).toHaveLength(2);
    expect(replies[0]).toMatch(/^(<\?xml[^>]*\?>)?<rpc-reply xmlns="urn:ietf:params:xml:ns:netconf:base:1\.0" message-id="1"><data><system xmlns="urn:example:lab"><hostname>router1<\/hostname><\/system><\/data><\/rpc-reply>$/);
    expect(replies[1]).toMatch(/message-id="2"><ok\/><\/rpc-reply>$/);
  });

  it('AC5: output json, xml or raw sets the session default; --xml, --json and --raw override it for one command', async () => {
    const r = await runNnc(
      ['router1', '-c', 'output', '-c', 'output json', '-c', 'output', '-c', 'get-config running', '-c', 'get-config running --xml', '-c', 'output raw', '-c', 'rpc <get/>'],
      { home: f.home },
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(
      'format xml · paging on\nformat json · paging on\n' +
        '{\n  "lab:system": {\n    "hostname": "router1"\n  }\n}\n' +
        CONFIG_XML +
        r.stdout.split('\n').at(-2)! +
        '\n',
    );
    expect(r.stdout.split('\n').at(-2)).toMatch(/<rpc-reply [^>]*message-id="3"><ok\/><\/rpc-reply>$/);
  });

  it('AC6: show-last shows the last result again; show-last --raw shows it exactly as received', async () => {
    const r = await runNnc(['router1', '-c', 'get-config running', '-c', 'status', '-c', 'show-last', '-c', 'show-last --raw', '-c', 'show-last --json'], {
      home: f.home,
    });
    expect(r.code).toBe(0);
    // The result, status, then the same result again, as received, and as JSON.
    expect(r.stdout.split(CONFIG_XML)).toHaveLength(3);
    expect(r.stdout.indexOf(CONFIG_XML)).toBe(0);
    expect(r.stdout).toMatch(/\n(<\?xml[^>]*\?>)?<rpc-reply [^>]*><data><system xmlns="urn:example:lab"><hostname>router1<\/hostname><\/system><\/data><\/rpc-reply>\n/);
    expect(r.stdout).toMatch(/\{\n {2}"lab:system": \{\n {4}"hostname": "router1"\n {2}\}\n\}\n$/);
    const nothing = await runNnc(['-c', 'show-last'], { home: f.home });
    expect(nothing.stdout).toBe('nothing to show yet\n');
  });
});
