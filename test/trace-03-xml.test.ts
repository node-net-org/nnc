/**
 * TRACE-03: Trace messages as readable XML.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RpcHandler } from '@node-net/netconf/testing';
import { fixture, type Fixture } from './support/fixture.js';
import { runNnc } from './support/nnc.js';
import { chunked, entryHeads } from './support/trace.js';

const handler: RpcHandler = (_rpc, ctx) => {
  if (ctx.operation?.name === 'broken') {
    ctx.server.sendRaw(chunked([`<rpc-reply message-id="${ctx.messageId}">\n<data>\n</rpc-reply>`]));
    return undefined;
  }
  return 'ok';
};

describe('TRACE-03 trace xml', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await fixture({ fake: { handler } });
  });
  afterAll(() => f.close());

  it('AC1: each message is indented XML, with the <rpc> wrapper and message-id the user did not type', async () => {
    const r = await runNnc(['router1', '-c', 'trace xml', '-c', 'rpc "<get-config><source><running/></source></get-config>"'], { home: f.home });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain(
      [
        '<rpc xmlns="urn:ietf:params:xml:ns:netconf:base:1.0" message-id="1">',
        '  <get-config>',
        '    <source>',
        '      <running/>',
        '    </source>',
        '  </get-config>',
        '</rpc>',
      ].join('\n'),
    );
  });

  it('AC2: each entry has direction, time and size, and the message-id for rpc and rpc-reply', async () => {
    const r = await runNnc(['router1', '-c', 'trace xml', '-c', 'rpc <get/>'], { home: f.home });
    const heads = entryHeads(r.stderr);
    expect(heads).toContainEqual(expect.stringMatching(/^>> \d\d:\d\d:\d\d\.\d{3} xml \d+ B rpc message-id=1$/));
    expect(heads).toContainEqual(expect.stringMatching(/^<< \d\d:\d\d:\d\d\.\d{3} xml \d+ B rpc-reply message-id=1$/));
  });

  it('AC3: the hello messages in both directions are shown', async () => {
    const r = await runNnc(['-c', 'trace xml', '-c', 'connect router1'], { home: f.home });
    const heads = entryHeads(r.stderr);
    expect(heads).toContainEqual(expect.stringMatching(/^>> .* xml \d+ B hello$/));
    expect(heads).toContainEqual(expect.stringMatching(/^<< .* xml \d+ B hello$/));
    expect(r.stderr).toContain('<capability>urn:ietf:params:netconf:base:1.1</capability>');
  });

  it('AC4: a message that is not well-formed is shown as text with the parse error, line and column', async () => {
    const r = await runNnc(['router1', '-c', 'trace xml', '-c', 'rpc <broken xmlns="urn:example:lab"/>'], { home: f.home });
    const head = entryHeads(r.stderr).find((h) => h.includes('not well-formed'));
    expect(head).toMatch(/^<< .* xml \d+ B not well-formed: .*line \d+, column \d+/);
    expect(r.stderr).toContain('<rpc-reply message-id="1">\n<data>\n</rpc-reply>');
  });

  it('AC5: on a colour terminal the XML is coloured; with NO_COLOR it is not', async () => {
    const coloured = await runNnc(['router1', '-c', 'trace xml', '-c', 'rpc <get/>'], { home: f.home, env: { NO_COLOR: undefined, FORCE_COLOR: '1' } });
    expect(coloured.stderr).toContain('\u001b[36m<rpc\u001b[0m');
    expect(coloured.stderr).toContain('\u001b[33mmessage-id\u001b[0m');
    expect(coloured.stdout).not.toContain('\u001b[');
    const plain = await runNnc(['router1', '-c', 'trace xml', '-c', 'rpc <get/>'], { home: f.home });
    expect(plain.stderr).not.toContain('\u001b[');
  });
});
