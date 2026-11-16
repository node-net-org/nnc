/**
 * A device for the command-language tests (LANG-01..05): it records what it
 * receives, answers get-config, never answers `get` or silent-please, answers
 * late-please after a delay, and fails fail-please. A device profile adds a
 * `nap` operation that never gets an answer, for `device --timeout`.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { x } from '@node-net/netconf';
import type { RpcHandler } from '@node-net/netconf/testing';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { FULL } from './caps.js';
import { fixture, type Fixture } from './fixture.js';
import { waitFor } from './nnc.js';

export const LAB = 'urn:example:lab';
export const CONFIG = x('system', { xmlns: LAB }, x('hostname', 'router1'));
export const CONFIG_XML = '<system xmlns="urn:example:lab">\n  <hostname>router1</hostname>\n</system>\n';

/** How long late-please waits before replying. */
export const LATE_MS = 400;

const handler: RpcHandler = async (_rpc, ctx) => {
  switch (ctx.operation?.name) {
    case 'get-config':
      return { data: CONFIG };
    case 'get':
    case 'silent-please':
      return undefined;
    case 'late-please':
      await new Promise((resolve) => setTimeout(resolve, LATE_MS));
      return { data: x('late', { xmlns: LAB }, 'too late') };
    case 'fail-please':
      return { errors: [{ type: 'application', tag: 'operation-failed', message: 'nope' }] };
    default:
      return 'ok';
  }
};

const PROFILE = {
  id: 'lang-test',
  match: { anyModule: ['lab'] },
  operations: {
    nap: { description: 'Never answers', mutates: false, request: `<silent-please xmlns="${LAB}"/>` },
  },
};

/** `router1` (rpc timeout 600 ms) and `slow` (30 s), both with the lang-test profile. */
export async function langFixture(): Promise<Fixture> {
  const f = await fixture({ fake: { capabilities: FULL, handler } });
  const profilesDir = f.profile(PROFILE);
  f.home.targets({
    router1: f.target({ profilesDir, timeouts: { rpc: 600, close: 500 } }),
    slow: f.target({ profilesDir, timeouts: { rpc: 30_000, close: 500 } }),
  });
  return f;
}

export function sentNames(f: Fixture): string[] {
  return f.sent().map((op) => op.name);
}

/** Resolve once the most recent session has received `count` requests (other than close-session). */
export async function received(f: Fixture, count: number, timeoutMs = 5000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (f.rpcsSent() < count) {
    if (Date.now() > until) throw new Error(`the server received ${f.rpcsSent()} requests, not ${count}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * An $EDITOR for --edit tests: a node script that appends what it was given to
 * `log`, then writes the next of `writes` into the file (or leaves it alone
 * for `null`), and exits with `status`.
 */
export function editor(f: Fixture, name: string, writes: readonly (string | null)[], status = 0): { command: string; log: string } {
  const dir = join(f.home.dir, 'editors');
  mkdirSync(dir, { recursive: true });
  const log = join(dir, `${name}.log`);
  const script = join(dir, `${name}.mjs`);
  writeFileSync(
    script,
    `import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
const file = process.argv[2];
const log = ${JSON.stringify(log)};
const runs = existsSync(log) ? readFileSync(log, 'utf8').split('\\u0000').length - 1 : 0;
appendFileSync(log, readFileSync(file, 'utf8') + '\\u0000');
const writes = ${JSON.stringify(writes)};
const next = writes[Math.min(runs, writes.length - 1)];
if (next !== null) writeFileSync(file, next);
process.exit(${status});
`,
  );
  return { command: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`, log };
}

/** What the editor was given on each run. */
export function editorSaw(log: string): string[] {
  return readFileSync(log, 'utf8').split('\u0000').slice(0, -1);
}

/** Wait for the prompt (the last thing on standard output). */
export function prompt(child: ChildProcessWithoutNullStreams, text: string): Promise<string> {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return waitFor(child, 'stdout', new RegExp(`${escaped}$`));
}
