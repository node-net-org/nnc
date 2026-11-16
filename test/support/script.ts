/**
 * A device for the script-mode tests (SCRIPT-01..06): it answers get-config
 * with a small configuration and has operations that fail in each way an exit
 * code distinguishes.
 */
import { x } from '@node-net/netconf';
import type { RpcHandler } from '@node-net/netconf/testing';
import { FULL } from './caps.js';
import { fixture, type Fixture } from './fixture.js';

export const LAB = 'urn:example:lab';

/** The configuration get-config returns. */
export const CONFIG = x('system', { xmlns: LAB }, x('hostname', 'router1'));

/** `rpc` bodies for the lab operations. */
export const RPC = {
  ok: `rpc <ping xmlns="${LAB}"/>`,
  fail: `rpc <fail-please xmlns="${LAB}"/>`,
  warn: `rpc <warn-please xmlns="${LAB}"/>`,
  /** No reply: the rpc timeout fires. */
  silent: `rpc <silent-please xmlns="${LAB}"/>`,
  /** A chunk header that isn't one (RFC 6242 §4.2): a framing error. */
  garbage: `rpc <garbage-please xmlns="${LAB}"/>`,
  /** A notification arrives before the reply. */
  notify: `rpc <notify-please xmlns="${LAB}"/>`,
  /** The server drops the connection without replying. */
  drop: `rpc <drop-please xmlns="${LAB}"/>`,
} as const;

const handler: RpcHandler = async (_rpc, ctx) => {
  switch (ctx.operation?.name) {
    case 'get-config':
      return { data: CONFIG };
    case 'fail-please':
      return { errors: [{ type: 'application', tag: 'operation-failed', message: 'nope' }] };
    case 'warn-please':
      return { errors: [{ type: 'application', tag: 'operation-failed', severity: 'warning', message: 'careful' }] };
    case 'silent-please':
      return undefined;
    case 'garbage-please':
      ctx.server.sendRaw('\n#zz\n<rpc-reply/>');
      return undefined;
    case 'notify-please':
      ctx.server.notify(x('link-down', { xmlns: LAB }, x('interface', 'eth0')), '2026-11-07T10:00:00Z');
      await new Promise((resolve) => setTimeout(resolve, 50));
      return 'ok';
    case 'drop-please':
      ctx.server.destroy();
      return undefined;
    default:
      return 'ok';
  }
};

/** `router1` as usual, `ro` read-only, both with a short rpc timeout. */
export async function scriptFixture(): Promise<Fixture> {
  const f = await fixture({ fake: { capabilities: FULL, handler } });
  const timeouts = { rpc: 500, close: 500 };
  f.home.targets({ router1: f.target({ timeouts }), ro: f.target({ timeouts, readOnly: true }) });
  return f;
}

/** The names of the operations the most recent session received, in order. */
export function sentNames(f: Fixture): string[] {
  return f.sent().map((op) => op.name);
}
