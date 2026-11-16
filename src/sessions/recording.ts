/**
 * A recording Connection (docs/cli.md §5): wraps a Connection so every chunk
 * passes through unchanged and is shown to the recorders on the way. Watching
 * never changes what is sent.
 *
 * Recorders: HelloCapture keeps the server's hello exactly as received (the
 * bytes before the first `]]>]]>`; a hello is always end-of-message framed,
 * RFC 6242 §4.1), and the trace (cli/src/trace) watches every chunk. A
 * recorder that throws is ignored: watching must never break the session.
 */

import type { Connection } from '@node-net/netconf/core';
import { concat, fromUtf8, indexOf, utf8 } from '../bytes.js';

const EOM = utf8(']]>]]>');
/** Stop looking for the hello after this many bytes. */
const MAX_HELLO_BYTES = 16 * 1024 * 1024;

export interface Recorder {
  /** Bytes received from the server. */
  received?(chunk: Uint8Array): void;
  /** Bytes sent to the server. */
  sent?(chunk: Uint8Array): void;
}

export function recordingConnection(inner: Connection, ...recorders: readonly Recorder[]): Connection {
  const sent = (chunk: Uint8Array): void => {
    for (const r of recorders) {
      try {
        r.sent?.(chunk);
      } catch {
        // A recorder's fault stays with the recorder.
      }
    }
  };
  const received = (chunk: Uint8Array): void => {
    for (const r of recorders) {
      try {
        r.received?.(chunk);
      } catch {
        // As above.
      }
    }
  };
  return {
    peer: inner.peer,
    receive(receiver) {
      inner.receive({
        data: (chunk) => {
          received(chunk);
          receiver.data(chunk);
        },
        end: () => receiver.end(),
        close: (err) => receiver.close(err),
      });
    },
    write(bytes) {
      sent(bytes);
      inner.write(bytes);
    },
    end: () => inner.end(),
    destroy: () => inner.destroy(),
    close: () => inner.close(),
  };
}

/** Collects the server's hello from the received bytes. */
export class HelloCapture implements Recorder {
  private chunks: Uint8Array[] = [];
  private size = 0;
  private done = false;
  /** The hello as received, without the `]]>]]>` delimiter, once it has arrived. */
  hello: string | undefined;

  received(chunk: Uint8Array): void {
    if (this.done) return;
    this.chunks.push(chunk);
    this.size += chunk.length;
    const all = concat(this.chunks);
    const end = indexOf(all, EOM);
    if (end !== -1) {
      this.hello = fromUtf8(all.subarray(0, end));
      this.finish();
    } else if (this.size > MAX_HELLO_BYTES) this.finish();
  }

  private finish(): void {
    this.done = true;
    this.chunks = [];
  }
}
