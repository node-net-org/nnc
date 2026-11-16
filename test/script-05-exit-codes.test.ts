/**
 * SCRIPT-05: Tell what went wrong from the exit code.
 */
import { createServer } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Fixture } from './support/fixture.js';
import { runNnc } from './support/nnc.js';
import { RPC, scriptFixture } from './support/script.js';

/** A port nothing listens on. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe('SCRIPT-05 exit codes', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await scriptFixture();
  });
  afterAll(() => f.close());

  it('AC1: 0 when every command succeeded, including a reply with only warnings', async () => {
    const r = await runNnc(['router1', '-c', 'get-config running', '-c', RPC.ok], { home: f.home });
    expect(r.code).toBe(0);
    const warned = await runNnc(['router1', '-c', RPC.warn], { home: f.home });
    expect(warned.code).toBe(0);
    expect(warned.stderr).toContain('careful');
  });

  it('AC2: 1 when the device returned an rpc-error', async () => {
    const r = await runNnc(['router1', '-c', RPC.fail], { home: f.home });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('rpc-error: operation-failed');
  });

  it('AC3: 2 when a command could not be parsed or was used wrongly', async () => {
    const unknown = await runNnc(['router1', '-c', 'no-such-command'], { home: f.home });
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain('unknown command: no-such-command');
    const badArgs = await runNnc(['router1', '-c', 'get-config running --no-such-option'], { home: f.home });
    expect(badArgs.code).toBe(2);
    const unparsed = await runNnc(['-c', "status 'unterminated"], { home: f.home });
    expect(unparsed.code).toBe(2);
    const badOption = await runNnc(['--no-such-option'], { home: f.home });
    expect(badOption.code).toBe(2);
  });

  it('AC4: 3 for a connection, authentication or host-key failure', async () => {
    const port = await closedPort();
    f.home.targets({ router1: f.target(), refused: f.target({ port }), badpass: f.target({ password: { env: 'WRONG_PASSWORD' } }) });
    try {
      const refused = await runNnc(['refused', '-c', 'status'], { home: f.home });
      expect(refused.code).toBe(3);
      const auth = await runNnc(['badpass', '-c', 'status'], { home: f.home, env: { WRONG_PASSWORD: 'not-the-password' } });
      expect(auth.code).toBe(3);
      expect(auth.stderr).toContain('authentication failed');
      f.home.knownHosts([]);
      const hostKey = await runNnc(['router1', '-c', 'status'], { home: f.home });
      expect(hostKey.code).toBe(3);
      expect(hostKey.stderr).toContain('host key');
    } finally {
      await f.close();
      f = await scriptFixture();
    }
  });

  it('AC5: 4 when the read-only guard refused a command', async () => {
    const r = await runNnc(['ro', '-c', 'rpc <commit/>'], { home: f.home });
    expect(r.code).toBe(4);
    expect(r.stderr).toContain('refused');
    expect(f.rpcsSent()).toBe(0);
  });

  it('AC6: 5 for a timeout, a protocol or framing error, or the session closing unexpectedly', async () => {
    const timeout = await runNnc(['router1', '-c', RPC.silent], { home: f.home });
    expect(timeout.code).toBe(5);
    const framing = await runNnc(['router1', '-c', RPC.garbage], { home: f.home });
    expect(framing.code).toBe(5);
    const dropped = await runNnc(['router1', '-c', RPC.drop], { home: f.home });
    expect(dropped.code).toBe(5);
  });

  it('AC7: nnc --help lists these codes', async () => {
    const r = await runNnc(['--help'], { home: f.home });
    expect(r.code).toBe(0);
    for (const line of [
      /^ {2}0 {2}every command succeeded$/m,
      /^ {2}1 {2}the device returned an <rpc-error>$/m,
      /^ {2}2 {2}a command couldn't be parsed or was used wrongly$/m,
      /^ {2}3 {2}a connection, authentication or host-key failure$/m,
      /^ {2}4 {2}refused by the read-only guard$/m,
      /^ {2}5 {2}a timeout, a protocol or framing error, or the session closed unexpectedly$/m,
    ]) {
      expect(r.stdout).toMatch(line);
    }
  });
});
