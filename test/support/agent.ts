/**
 * A minimal SSH agent on a Unix socket, holding one key, so tests can check
 * that nnc authenticates with an agent and doesn't prompt.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { AgentProtocol, utils } from 'ssh2';

export interface TestAgent {
  readonly socket: string;
  /** Number of signing requests served. */
  readonly signs: () => number;
  close(): Promise<void>;
}

export async function startAgent(dir: string, privateKey: string): Promise<TestAgent> {
  const key = utils.parseKey(privateKey);
  if (key instanceof Error) throw key;
  const socket = join(dir, `agent-${randomUUID().slice(0, 8)}.sock`);
  let signs = 0;
  const server: Server = createServer((sock) => {
    const proto = new AgentProtocol(false);
    sock.pipe(proto).pipe(sock);
    sock.on('error', () => undefined);
    proto.on('identities', (req) => proto.getIdentitiesReply(req, [key]));
    proto.on('sign', (req, _pub, data, opts) => {
      signs++;
      const sig = key.sign(data, opts?.hash);
      if (sig instanceof Error) proto.failureReply(req);
      else proto.signReply(req, sig);
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  return {
    socket,
    signs: () => signs,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
