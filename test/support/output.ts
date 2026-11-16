/**
 * A device for the output and prompt tests (LANG-06..12).
 */
import { x } from '@node-net/netconf';
import type { RpcHandler } from '@node-net/netconf/testing';
import { FULL } from './caps.js';
import { fixture, type Fixture } from './fixture.js';

export const LAB = 'urn:example:lab';
export const CONFIG = x('system', { xmlns: LAB }, x('hostname', 'router1'));
/** Forty interfaces: taller than a small terminal. */
export const BIG = x('interfaces', { xmlns: LAB }, ...Array.from({ length: 40 }, (_v, i) => x('interface', x('name', `eth${i}`))));

export const RPC = {
  big: `rpc <big-please xmlns="${LAB}"/>`,
  fail: `rpc <fail-please xmlns="${LAB}"/>`,
  full: `rpc <full-error-please xmlns="${LAB}"/>`,
  two: `rpc <two-errors-please xmlns="${LAB}"/>`,
  /** An error message with control characters well-formed XML allows (DEL, C1, tab). */
  bell: `rpc <bell-please xmlns="${LAB}"/>`,
  warn: `rpc <warn-please xmlns="${LAB}"/>`,
  /** A notification arrives, then the reply after 300 ms. */
  notify: `rpc <notify-please xmlns="${LAB}"/>`,
} as const;

const handler: RpcHandler = async (_rpc, ctx) => {
  switch (ctx.operation?.name) {
    case 'get-config':
      return { data: CONFIG };
    case 'big-please':
      return { data: BIG };
    case 'fail-please':
      return { errors: [{ type: 'application', tag: 'operation-failed', message: 'nope' }] };
    case 'full-error-please':
      return {
        errors: [
          {
            type: 'application',
            tag: 'invalid-value',
            appTag: 'too-big',
            path: '/lab:system/lab:mtu',
            message: 'MTU out of range',
            info: [x('bad-element', 'mtu')],
          },
        ],
      };
    case 'two-errors-please':
      return {
        errors: [
          { type: 'protocol', tag: 'lock-denied', message: 'first' },
          { type: 'application', tag: 'operation-failed', message: 'second' },
        ],
      };
    case 'bell-please':
      return { errors: [{ type: 'application', tag: 'operation-failed', message: 'ring\u007fring\u009b2J\ttab' }] };
    case 'warn-please':
      return { errors: [{ type: 'application', tag: 'operation-failed', severity: 'warning', message: 'careful' }] };
    case 'notify-please':
      ctx.server.notify(x('link-down', { xmlns: LAB }, x('interface', 'eth0')), '2026-11-07T10:00:00Z');
      await new Promise((resolve) => setTimeout(resolve, 300));
      return 'ok';
    default:
      return 'ok';
  }
};

/** `router1`, `ro` (read-only) and `lab` (host key not verified). */
export async function outputFixture(): Promise<Fixture> {
  const f = await fixture({ fake: { capabilities: FULL, handler } });
  f.home.targets({ router1: f.target(), ro: f.target({ readOnly: true }), lab: f.target({ hostKey: 'insecure-accept-any' }) });
  return f;
}
