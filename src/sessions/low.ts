/**
 * Framed and raw sessions (docs/cli.md §11, LOW-01..07): the transport is
 * opened exactly as for a client session, and then the user drives it.
 *
 * - framed: the library's message channel does the framing (end-of-message
 *   until `framing chunked`); nothing else is sent for the user, not even the
 *   hello. Each received message is kept, numbered from 1.
 * - raw: the SSH netconf subsystem (or TLS stream) with no framing at all.
 *   Every received chunk is kept.
 */

import { FramingError, SessionClosedError, openChannel, type Connection, type MessageChannel, type NetconfError } from '@node-net/netconf/core';
import type { NncHost, SecretPrompt } from '../host.js';
import type { Target } from '../targets.js';
import type { Tracer } from '../trace/tracer.js';
import { openConnection } from './connect.js';
import { recordingConnection } from './recording.js';

export type LowKind = 'framed' | 'raw';

/** A message received in a framed session. */
export interface ReceivedMessage {
  readonly text: string;
  readonly at: Date;
}

export interface LowSession {
  readonly kind: LowKind;
  readonly name: string;
  readonly target: Target;
  readonly host: string;
  readonly port: number;
  readonly via: string | undefined;
  readonly transport: 'ssh' | 'tls' | 'sim';
  readonly insecure: boolean;
  readonly fingerprint: string | undefined;
  readonly connectedAt: Date;
  /** The (recording) connection; a raw session writes to its stream. */
  readonly connection: Connection;
  /** The framing channel, in a framed session. */
  readonly channel: MessageChannel | undefined;
  /** The session's trace, told when the user switches framing. */
  readonly tracer: Tracer | undefined;
  /** Framed: messages received, oldest first (message N is messages[N - 1]). */
  readonly messages: ReceivedMessage[];
  /** Raw: chunks received, oldest first. */
  readonly received: Uint8Array[];
  /** Raw: bytes received in all. */
  receivedBytes: number;
  /** Raw: the user has ended the sending side (`eof`). */
  eof: boolean;
  /** Set while `disconnect` closes the session, so the close isn't reported as the server's. */
  disconnecting: boolean;
}

export interface LowRequest {
  readonly kind: LowKind;
  readonly target: Target;
  readonly host: NncHost;
  readonly signal: AbortSignal;
  readonly prompt: SecretPrompt;
  /** The trace for this connection, if it is wanted. */
  readonly tracer?: () => Tracer;
  /** Framed: message `number` (1-based) has arrived. */
  readonly onMessage: (session: LowSession, message: ReceivedMessage, number: number) => void;
  /** Raw: bytes have arrived; `offset` is where they start in everything received. */
  readonly onBytes: (session: LowSession, chunk: Uint8Array, offset: number) => void;
  /** The session ended without `disconnect`: the server closed it, the framing broke, or the connection failed. */
  readonly onEnd: (session: LowSession, reason: string) => void;
}

export async function openLowSession(req: LowRequest): Promise<LowSession> {
  const { connection: inner, port, shape } = await openConnection(req);
  const tracer = req.tracer?.();
  const connection = tracer === undefined ? inner : recordingConnection(inner, tracer);
  const { target } = req;
  let ended = false;
  const end = (reason: string): void => {
    if (ended) return;
    ended = true;
    void connection.close().catch(() => undefined);
    if (!session.disconnecting) req.onEnd(session, reason);
  };
  const base = {
    kind: req.kind,
    name: target.name,
    target,
    host: target.host,
    port,
    via: shape.via,
    transport: shape.transport,
    insecure: shape.insecure,
    fingerprint: inner.peer.identity,
    connectedAt: new Date(),
    connection,
    tracer,
    messages: [] as ReceivedMessage[],
    received: [] as Uint8Array[],
    receivedBytes: 0,
    eof: false,
    disconnecting: false,
  };
  let session: LowSession;
  if (req.kind === 'framed') {
    const channel = openChannel(connection, {
      message: (text) => {
        const message = { text, at: new Date() };
        session.messages.push(message);
        req.onMessage(session, message, session.messages.length);
      },
      end: (reason: NetconfError) => end(endReason(reason)),
    });
    session = { ...base, channel };
  } else {
    session = { ...base, channel: undefined };
    connection.receive({
      data: (bytes) => {
        const chunk = bytes;
        const offset = session.receivedBytes;
        session.received.push(chunk);
        session.receivedBytes += chunk.length;
        req.onBytes(session, chunk, offset);
      },
      end: () => end('the server closed the stream'),
      close: (err) => end(err === undefined ? 'the connection closed' : `the connection failed: ${err.message}`),
    });
  }
  return session;
}

/** Why a framed session ended, in words. */
function endReason(reason: NetconfError): string {
  if (reason instanceof FramingError) return `framing error: ${reason.message}`;
  if (reason instanceof SessionClosedError) return 'the server closed the session';
  return reason.message;
}

/** Close a low-level session at the user's request. Nothing is sent first. */
export async function closeLowSession(session: LowSession): Promise<void> {
  session.disconnecting = true;
  await (session.channel !== undefined ? session.channel.close() : session.connection.close().catch(() => undefined));
}
