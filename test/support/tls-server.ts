/**
 * A real TLS server (RFC 7589 style: client certificate required) whose
 * connections are bridged to a FakeServer, so the spawned nnc runs over
 * genuine mutual TLS. Uses the library's TEST-ONLY certificates.
 */
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { createServer, type TLSSocket } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { duplexConnection, joinConnections } from '@node-net/netconf';
import { FakeServer, type FakeServerOptions } from '@node-net/netconf/testing';

/** Path of a file in test/fixtures/tls: the test-only certificates (scripts/tls-fixtures.sh). */
export const tlsFixture = (name: string): string =>
  fileURLToPath(new URL(`../fixtures/tls/${name}`, import.meta.url));

export interface TestTlsServer {
  readonly port: number;
  /** The server certificate's `SHA256:` fingerprint, as nnc prints it. */
  readonly fingerprint: string;
  /** The FakeServer behind the most recent connection. */
  readonly last: () => FakeServer | undefined;
  close(): Promise<void>;
}

export interface TestTlsServerOptions {
  /** Present the certificate signed by the untrusted CA. */
  readonly untrusted?: boolean;
  /** Complete the handshake, then close before sending a hello (as a server whose cert-to-name finds no user). */
  readonly closeAfterHandshake?: boolean;
  readonly fake?: FakeServerOptions;
}

export async function startTlsServer(options: TestTlsServerOptions = {}): Promise<TestTlsServer> {
  const certFile = tlsFixture(options.untrusted === true ? 'other-server.pem' : 'server.pem');
  const sockets = new Set<TLSSocket>();
  let last: FakeServer | undefined;
  const server = createServer(
    {
      cert: readFileSync(certFile),
      key: readFileSync(tlsFixture(options.untrusted === true ? 'other-server.key' : 'server.key')),
      ca: [readFileSync(tlsFixture('ca.pem'))],
      requestCert: true,
      rejectUnauthorized: true,
      maxVersion: 'TLSv1.3',
    },
    (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => undefined);
      if (options.closeAfterHandshake === true) {
        socket.end();
        return;
      }
      const fake = new FakeServer(options.fake);
      last = fake;
      joinConnections(duplexConnection(socket, { peer: { host: 'test-client', port: 0 } }), fake.connection);
    },
  );
  server.on('tlsClientError', () => undefined);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { createHash, X509Certificate } = await import('node:crypto');
  const der = new X509Certificate(readFileSync(certFile)).raw;
  return {
    port: (server.address() as AddressInfo).port,
    fingerprint: `SHA256:${createHash('sha256').update(der).digest('base64').replace(/=+$/, '')}`,
    last: () => last,
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}
