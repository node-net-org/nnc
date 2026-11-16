/**
 * A real SSH server (ssh2) on 127.0.0.1 whose `netconf` subsystem is bridged
 * to a FakeServer, so the spawned nnc runs over genuine SSH.
 * Adapted from the library's test/support/ssh-server.ts, using only public exports.
 */
import { createHash } from 'node:crypto';
import { connect as tcpConnect, type AddressInfo, type Socket } from 'node:net';
import { Server, utils, type AuthContext, type Connection } from 'ssh2';
import { FakeServer, type FakeServerOptions } from '@node-net/netconf/testing';

export interface TestSshServer {
  readonly port: number;
  /** OpenSSH fingerprint of the host key. */
  readonly fingerprint: string;
  /** `ssh-ed25519 AAAA...` line for the host key. */
  readonly publicKeyLine: string;
  /** Every authentication attempt, as `method:username`. */
  readonly authAttempts: string[];
  /** The FakeServer behind the most recent netconf subsystem. */
  readonly last: () => FakeServer | undefined;
  /** Every byte the client sent on the most recent netconf subsystem, in order. */
  readonly lastBytes: () => Buffer;
  /** Every direct-tcpip (jump host) request, as `host:port`. */
  readonly forwards: string[];
  /** The live server-side connections, to drop them from a test. */
  readonly clients: () => Connection[];
  /**
   * Call home (RFC 8071): dial the listener on 127.0.0.1:`port`, then serve SSH
   * (and NETCONF) over that connection. Resolves with the socket once dialled;
   * rejects if nothing listens there.
   */
  callHome(port: number): Promise<Socket>;
  close(): Promise<void>;
}

export interface TestSshServerOptions {
  readonly username?: string;
  readonly password?: string;
  /** Accepted client public key (OpenSSH format). */
  readonly clientPublicKey?: string;
  readonly fake?: FakeServerOptions;
  /** Host key (private, OpenSSH format). Default: a key shared by all servers in this process. */
  readonly hostKey?: string;
  /** Act as a jump host: allow direct-tcpip forwarding to 127.0.0.1. */
  readonly allowForwarding?: boolean;
  /** Swallow the client's <close-session>, so it is never answered. */
  readonly dropCloseSession?: boolean;
  /** When the client ends its side of the netconf channel (EOF), send these bytes and then close it. */
  readonly eofReply?: string;
}

/**
 * An ed25519 key pair that ssh2 can parse. ssh2's generateKeyPairSync now and
 * then returns a private key its own parser rejects ("Malformed OpenSSH private
 * key"), which made whole test files fail at random; generate until one parses.
 */
export function generateKey(): { private: string; public: string } {
  for (let attempt = 0; attempt < 20; attempt++) {
    const pair = utils.generateKeyPairSync('ed25519');
    if (!(utils.parseKey(pair.private) instanceof Error) && !(utils.parseKey(pair.public) instanceof Error)) return pair;
  }
  throw new Error('could not generate a parseable ed25519 key');
}

export const HOST_KEY = generateKey();

export function keyLine(privateKey: string): { fingerprint: string; line: string } {
  const parsed = utils.parseKey(privateKey);
  if (parsed instanceof Error) throw parsed;
  const blob = parsed.getPublicSSH();
  return {
    fingerprint: `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`,
    line: `${parsed.type} ${blob.toString('base64')}`,
  };
}

export async function startSshServer(options: TestSshServerOptions = {}): Promise<TestSshServer> {
  const username = options.username ?? 'admin';
  const password = options.password ?? 'secret';
  const hostKey = options.hostKey ?? HOST_KEY.private;
  const authAttempts: string[] = [];
  let last: FakeServer | undefined;
  let lastBytes: Buffer[] = [];
  const forwards: string[] = [];
  const live = new Set<Connection>();
  const allowedKey = options.clientPublicKey === undefined ? undefined : (utils.parseKey(options.clientPublicKey));
  if (allowedKey instanceof Error) throw allowedKey;

  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    live.add(client);
    client.on('close', () => live.delete(client));
    client.on('error', () => undefined);
    client.on('authentication', (ctx: AuthContext) => {
      authAttempts.push(`${ctx.method}:${ctx.username}`);
      if (ctx.username !== username) return ctx.reject(['password', 'publickey']);
      if (ctx.method === 'password' && ctx.password === password) return ctx.accept();
      if (ctx.method === 'publickey' && allowedKey !== undefined && ctx.key.data.equals(allowedKey.getPublicSSH())) {
        if (ctx.signature === undefined) return ctx.accept(); // key probe
        const ok = allowedKey.verify(ctx.blob!, ctx.signature, ctx.hashAlgo);
        return ok === true ? ctx.accept() : ctx.reject();
      }
      ctx.reject(['password', 'publickey']);
    });
    client.on('ready', () => {
      client.on('tcpip', (accept, reject, info) => {
        forwards.push(`${info.destIP}:${info.destPort}`);
        if (options.allowForwarding !== true || info.destIP !== '127.0.0.1') return reject();
        const sock = tcpConnect(info.destPort, info.destIP);
        let accepted = false;
        sock.on('error', () => (accepted ? sock.destroy() : reject()));
        sock.once('connect', () => {
          accepted = true;
          const channel = accept();
          channel.pipe(sock).pipe(channel);
          channel.on('close', () => sock.destroy());
          sock.on('close', () => channel.destroy());
        });
      });
      client.on('session', (accept) => {
        const session = accept();
        session.on('subsystem', (acceptSub, rejectSub, info) => {
          if (info.name !== 'netconf') return rejectSub();
          const channel = acceptSub();
          const fake = new FakeServer(options.fake);
          last = fake;
          const bytes: Buffer[] = [];
          lastBytes = bytes;
          channel.on('data', (chunk: Buffer) => {
            bytes.push(Buffer.from(chunk));
            if (options.dropCloseSession === true && chunk.includes('close-session')) return;
            fake.connection.write(chunk);
          });
          // What the fake server sends goes to the client; when it ends or drops, so does the channel.
          fake.connection.receive({
            data: (chunk) => channel.write(chunk),
            end: () => channel.end(),
            close: () => channel.destroy(),
          });
          if (options.eofReply !== undefined) {
            const reply = options.eofReply;
            channel.on('end', () => setTimeout(() => channel.end(reply), 100));
          }
          channel.on('close', () => fake.destroy());
        });
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const { fingerprint, line } = keyLine(hostKey);
  return {
    port,
    fingerprint,
    publicKeyLine: line,
    authAttempts,
    last: () => last,
    lastBytes: () => Buffer.concat(lastBytes),
    forwards,
    clients: () => [...live],
    callHome: (listenerPort) =>
      new Promise<Socket>((resolve, reject) => {
        const sock = tcpConnect(listenerPort, '127.0.0.1');
        sock.once('error', reject);
        sock.once('connect', () => {
          sock.removeListener('error', reject);
          sock.on('error', () => undefined);
          (server as Server & { injectSocket(s: Socket): void }).injectSocket(sock);
          resolve(sock);
        });
      }),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const c of live) c.end();
      }),
  };
}
