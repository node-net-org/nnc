/**
 * OPS-01: Send any RPC body and see the reply.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { x } from '@node-net/netconf';
import type { RpcHandler } from '@node-net/netconf/testing';
import { FULL } from './support/caps.js';
import { fixture, type Fixture } from './support/fixture.js';
import { runNnc } from './support/nnc.js';

const handler: RpcHandler = (_rpc, ctx) => {
  switch (ctx.operation?.name) {
    case 'get-chassis-inventory':
      return { data: x('chassis', { xmlns: 'urn:example:lab' }, x('serial', 'ABC123')) };
    case 'fail-please':
      return { errors: [{ type: 'application', tag: 'operation-failed', message: 'nope' }] };
    default:
      return 'ok';
  }
};

describe('OPS-01 rpc', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await fixture({ fake: { capabilities: FULL, handler } });
  });
  afterAll(() => f.close());

  it('AC1: rpc sends the body wrapped in <rpc> with the next message-id and prints the reply', async () => {
    const r = await runNnc(['router1', '-c', 'rpc <get-chassis-inventory xmlns="urn:example:lab"/>', '-c', 'rpc <commit/>'], { home: f.home });
    expect(r.code).toBe(0);
    const rpcs = f.server.last()!.requests.filter((q) => q.elements[0]?.name !== 'close-session');
    expect(rpcs.map((q) => q.name)).toEqual(['rpc', 'rpc']);
    const ids = rpcs.map((q) => Number(q.attr('message-id')));
    expect(ids[1]).toBe(ids[0]! + 1);
    expect(rpcs[0]!.elements[0]!.name).toBe('get-chassis-inventory');
    expect(r.stdout).toContain('<serial>ABC123</serial>');
  });

  it('AC2: an <rpc> root fails, saying the wrapper is added automatically', async () => {
    const r = await runNnc(['router1', '-c', 'rpc <rpc><get/></rpc>'], { home: f.home });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('the <rpc> wrapper and message-id are added automatically');
    expect(f.rpcsSent()).toBe(0);
  });

  it('AC3: a body that is not well-formed fails with the parse error and its position; nothing is sent', async () => {
    const r = await runNnc(['router1', '-c', 'rpc <get><filter></get>'], { home: f.home });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/rpc: the operation isn't well-formed XML: .*line 1.*column \d+/is);
    expect(f.rpcsSent()).toBe(0);
  });

  it('AC4: a body with more than one root element fails before sending', async () => {
    const r = await runNnc(['router1', '-c', 'rpc <get/><get-config/>'], { home: f.home });
    expect(r.code).toBe(2);
    expect(f.rpcsSent()).toBe(0);
  });

  it('AC5: a reply with <ok/> prints ok', async () => {
    const r = await runNnc(['router1', '-c', 'rpc <discard-changes/>'], { home: f.home });
    expect(r.stdout).toBe('ok\n');
  });

  it('AC6: a reply with data prints the data', async () => {
    const r = await runNnc(['router1', '-c', 'rpc <get-chassis-inventory xmlns="urn:example:lab"/>'], { home: f.home });
    expect(r.stdout).toBe('<chassis xmlns="urn:example:lab">\n  <serial>ABC123</serial>\n</chassis>\n');
  });

  it('AC7: a reply with an rpc-error prints the error and exits 1', async () => {
    const r = await runNnc(['router1', '-c', 'rpc <fail-please xmlns="urn:example:lab"/>'], { home: f.home });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('rpc-error: operation-failed\n  type      application\n  severity  error\n  message   nope\n');
  });
});
