/**
 * OPS-04: Change configuration with edit-config.
 * OPS-05: Copy and delete whole configuration datastores.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serializeXml } from '@node-net/netconf';
import { BARE, BASE10, BASE11, CANDIDATE, FULL, LAB_MODULE } from './support/caps.js';
import { fixture, type Fixture } from './support/fixture.js';
import { runNnc } from './support/nnc.js';

const LAB = 'urn:example:lab';
const NC = 'urn:ietf:params:xml:ns:netconf:base:1.0';

describe('OPS-04 edit-config and OPS-05 copy-config / delete-config', () => {
  let f: Fixture;
  let bare: Fixture;
  beforeAll(async () => {
    f = await fixture({ fake: { capabilities: FULL } });
    f.home.targets({ router1: f.target(), ro: f.target({ readOnly: true }) });
    // Candidate, but no :validate, :rollback-on-error, :writable-running or :startup.
    bare = await fixture({ fake: { capabilities: [BASE10, BASE11, CANDIDATE, LAB_MODULE] } });
  });
  afterAll(async () => {
    await f.close();
    await bare.close();
  });

  const sentXml = (fx: Fixture): string => serializeXml(fx.sent()[0]!);
  const CONFIG = `<config><system xmlns="${LAB}"><name>lab1</name></system></config>`;

  it('OPS-04 AC1: edit-config candidate <config> sends the content to candidate and prints ok', async () => {
    const r = await runNnc(['router1', '-c', `edit-config candidate ${CONFIG}`], { home: f.home });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('ok\n');
    expect(sentXml(f)).toBe(
      `<edit-config xmlns="${NC}"><target><candidate/></target><config><system xmlns="${LAB}"><name>lab1</name></system></config></edit-config>`,
    );
  });

  it('OPS-04 AC2: the configuration may come from @file', async () => {
    f.home.file('change.xml', CONFIG);
    const r = await runNnc(['router1', '-c', 'edit-config candidate @change.xml'], { home: f.home });
    expect(r.code).toBe(0);
    expect(sentXml(f)).toContain(`<config><system xmlns="${LAB}"><name>lab1</name></system></config>`);
  });

  it('OPS-04 AC2: the configuration may continue across lines, or come from --edit', async () => {
    const lines = ['edit-config candidate <config>', `  <system xmlns="${LAB}">`, '    <name>lab1</name>', '  </system>', '</config>'];
    const prompt = await runNnc(['router1', '-i'], { home: f.home, stdin: `${lines.join('\n')}\n` });
    expect(prompt.stdout).toContain('...> ...> ...> ...> ok\n');
    const script = await runNnc(['router1', '--script', f.home.file('edit.nnc', lines.join('\n'))], { home: f.home });
    expect(script.code).toBe(0);
    expect(f.sent()[0]!.child('config')!.child('system')!.child('name')!.textContent()).toBe('lab1');
    const editor = f.home.file('editor.mjs', `import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[2], ${JSON.stringify(CONFIG)});`);
    const edited = await runNnc(['router1', '-c', 'edit-config candidate --edit'], { home: f.home, env: { EDITOR: `${process.execPath} ${editor}` } });
    expect(edited.code).toBe(0);
    expect(sentXml(f)).toContain(`<config><system xmlns="${LAB}"><name>lab1</name></system></config>`);
  });

  it('OPS-04 AC3: --default-operation takes merge, replace or none; any other value fails', async () => {
    const ok = await runNnc(['router1', '-c', `edit-config candidate --default-operation replace ${CONFIG}`], { home: f.home });
    expect(ok.code).toBe(0);
    expect(sentXml(f)).toContain('<default-operation>replace</default-operation>');
    const bad = await runNnc(['router1', '-c', `edit-config candidate --default-operation delete ${CONFIG}`], { home: f.home });
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('edit-config: --default-operation can\'t be "delete"; allowed: merge, replace, none');
    expect(f.rpcsSent()).toBe(0);
  });

  it('OPS-04 AC4: --test-option and --error-option are sent only when the device has their capabilities', async () => {
    const ok = await runNnc(
      ['router1', '-c', `edit-config candidate --test-option test-only --error-option rollback-on-error ${CONFIG}`],
      { home: f.home },
    );
    expect(ok.code).toBe(0);
    expect(sentXml(f)).toContain('<test-option>test-only</test-option><error-option>rollback-on-error</error-option>');

    const test = await runNnc(['router1', '-c', `edit-config candidate --test-option set ${CONFIG}`], { home: bare.home });
    expect(test.code).toBe(2);
    expect(test.stderr).toContain(':validate');
    const rollback = await runNnc(['router1', '-c', `edit-config candidate --error-option rollback-on-error ${CONFIG}`], { home: bare.home });
    expect(rollback.code).toBe(2);
    expect(rollback.stderr).toContain(':rollback-on-error');
    expect(bare.rpcsSent()).toBe(0);
  });

  it('OPS-04 AC5: edit-config running without writable-running fails naming the capability', async () => {
    const r = await runNnc(['router1', '-c', `edit-config running ${CONFIG}`], { home: bare.home });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(':writable-running');
    expect(bare.rpcsSent()).toBe(0);
  });

  it('OPS-04 AC6 / OPS-05 AC6: on a read-only target edit-config, copy-config and delete-config are refused', async () => {
    for (const line of [`edit-config candidate ${CONFIG}`, 'copy-config startup running', 'delete-config startup']) {
      const r = await runNnc(['ro', '-c', line], { home: f.home });
      expect(r.code, line).toBe(4);
      expect(f.rpcsSent(), line).toBe(0);
    }
  });

  it('OPS-05 AC1: copy-config startup running copies running to startup and prints ok', async () => {
    const r = await runNnc(['router1', '-c', 'copy-config startup running'], { home: f.home });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('ok\n');
    expect(sentXml(f)).toBe(`<copy-config xmlns="${NC}"><target><startup/></target><source><running/></source></copy-config>`);
  });

  it('OPS-05 AC2: the source may be inline <config> XML', async () => {
    const r = await runNnc(['router1', '-c', `copy-config candidate ${CONFIG}`], { home: f.home });
    expect(r.code).toBe(0);
    expect(sentXml(f)).toContain(`<source><config><system xmlns="${LAB}"><name>lab1</name></system></config></source>`);
  });

  it('OPS-05 AC3: copy-config fails before sending when a datastore is not advertised', async () => {
    const r = await runNnc(['router1', '-c', 'copy-config startup running'], { home: bare.home });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(':startup');
    expect(bare.rpcsSent()).toBe(0);
  });

  it('OPS-05 AC4: delete-config startup sends a delete-config and prints ok', async () => {
    const r = await runNnc(['router1', '-c', 'delete-config startup'], { home: f.home });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('ok\n');
    expect(sentXml(f)).toBe(`<delete-config xmlns="${NC}"><target><startup/></target></delete-config>`);
  });

  it('OPS-05 AC5: delete-config running fails with a usage message; nothing is sent', async () => {
    const r = await runNnc(['router1', '-c', 'delete-config running'], { home: f.home });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('delete-config: <target> can\'t be "running"; allowed: startup, or a URL');
    expect(f.rpcsSent()).toBe(0);
  });

  it('copy-config and delete-config accept a URL target where the device has :url (checked by the library)', async () => {
    const r = await runNnc(['router1', '-c', 'delete-config file:///tmp/x.xml'], { home: bare.home });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(':url');
    expect(BARE).not.toContain('url');
  });
});
