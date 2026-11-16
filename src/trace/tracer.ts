/**
 * The tracer for one connection (docs/cli.md §5). It is a Recorder on the
 * recording connection: it sees a copy of every chunk in both directions and
 * never touches the stream itself.
 *
 * Each direction is decoded by its own FrameDecoder (the library's) from the
 * start of the connection, whatever is being traced, so a level turned on
 * mid-session starts in step with the framing. The trace follows the switch
 * to chunked framing itself: once both hellos have been seen and both offer
 * base:1.1. A framed session turns that off (`autoFraming: false`) and
 * calls setFraming() from its `framing chunked` command, so its trace
 * follows the channel rather than guessing.
 */

import { FrameDecoder, parseXml, type FramingMode, type XmlElement } from '@node-net/netconf/core';
import { byteLength, concat } from '../bytes.js';
import { prettyXml } from '../render/xml.js';
import type { Recorder } from '../sessions/recording.js';
import { colourXml, escapeBytes } from './format.js';
import { BytesRedactor, redactMessage } from './redact.js';
import type { TraceSettings } from './settings.js';

const BASE_11 = 'urn:ietf:params:netconf:base:1.1';
/** Raw bytes kept per direction to show where a framing error was found. */
const TAIL_BYTES = 64;

type Direction = 'sent' | 'received';

class Side {
  readonly decoder = new FrameDecoder();
  readonly bytes = new BytesRedactor();
  tail: Uint8Array = new Uint8Array(0);
  messages = 0;
  /** This side's hello offered base:1.1 (undefined until the hello has been seen). */
  offers11: boolean | undefined;
  /** Decoding stopped after a framing error. */
  failed = false;

  constructor(readonly direction: Direction) {}
}

export class Tracer implements Recorder {
  private readonly sides: Record<Direction, Side> = { sent: new Side('sent'), received: new Side('received') };
  private broken = false;

  /**
   * @param onMessage called with each whole message, whether or not tracing is on (the CLI keeps
   *   received replies for `--raw`); a fault in it is the trace's and stops it like any other.
   * @param options.autoFraming switch to chunked framing when both hellos offer base:1.1 (default true).
   */
  constructor(
    private readonly settings: TraceSettings,
    private readonly onMessage?: (direction: Direction, text: string) => void,
    private readonly options: { readonly autoFraming?: boolean } = {},
  ) {}

  sent(chunk: Uint8Array): void {
    this.record(this.sides.sent, chunk);
  }

  received(chunk: Uint8Array): void {
    this.record(this.sides.received, chunk);
  }

  /** Both directions use this framing from their next message on. */
  setFraming(mode: FramingMode): void {
    if (mode !== 'chunked') return;
    for (const side of Object.values(this.sides)) {
      side.bytes.useChunked();
      if (!side.failed && side.decoder.mode !== 'chunked') {
        try {
          side.decoder.setMode('chunked');
        } catch {
          // In the middle of a message: the decoder has failed and says so on its next read.
        }
      }
    }
  }

  private record(side: Side, chunk: Uint8Array): void {
    // A fault in the trace must never reach the session: report it once and stop tracing this connection.
    if (this.broken) return;
    const at = new Date();
    try {
      side.tail = concat([side.tail, chunk]).subarray(-TAIL_BYTES);
      // Messages first, so a switch to chunked framing that this chunk completes is known to the bytes level.
      const messages = this.decode(side, chunk);
      this.bytesEntry(side, chunk, at);
      for (const m of messages) {
        this.onMessage?.(side.direction, m.text);
        this.messageEntries(side, m.text, m.mode, at);
      }
    } catch (err) {
      this.broken = true;
      this.settings.emit({
        direction: side.direction,
        at,
        level: this.settings.has('bytes') ? 'bytes' : this.settings.has('frames') ? 'frames' : 'xml',
        header: `trace stopped for this session: ${(err as Error).message}`,
      });
    }
  }

  private decode(side: Side, chunk: Uint8Array): { text: string; mode: FramingMode }[] {
    const out: { text: string; mode: FramingMode }[] = [];
    if (side.failed) return out;
    try {
      side.decoder.push(chunk);
      for (;;) {
        const mode = side.decoder.mode;
        const text = side.decoder.next();
        if (text === undefined) break;
        out.push({ text, mode });
        side.messages++;
        if (side.messages === 1) this.sawHello(side, text);
      }
    } catch (err) {
      side.failed = true;
      const level = this.settings.has('frames') ? 'frames' : 'xml';
      this.settings.emit({
        direction: side.direction,
        at: new Date(),
        level,
        header: `framing error: ${this.framingDetail(err as Error, side)}; frames and xml stop here for ${side.direction} messages`,
      });
    }
    return out;
  }

  /**
   * The error and the bytes where it was found. Those bytes can be part of a
   * secret (the framing broke mid-value), and with no framing there's no way
   * to tell, so while redacting they are left out, along with the sample the
   * library quotes in its message.
   */
  private framingDetail(err: Error, side: Side): string {
    if (!this.settings.redact) return `${err.message}; last bytes: ${escapeBytes(side.tail)}`;
    return `${err.message.replace(/"[^"]*"/g, '"…"')}; last bytes hidden while redaction is on (trace --no-redact shows them)`;
  }

  private sawHello(side: Side, text: string): void {
    if (this.options.autoFraming === false) return;
    side.offers11 = offersBase11(text);
    const { sent, received } = this.sides;
    if (sent.offers11 === true && received.offers11 === true) this.setFraming('chunked');
  }

  private bytesEntry(side: Side, chunk: Uint8Array, at: Date): void {
    if (!this.settings.has('bytes')) {
      // Keep the redactor in step with the framing even while bytes aren't shown.
      side.bytes.write(chunk);
      return;
    }
    const size = `${chunk.length} B`;
    if (!this.settings.redact) {
      side.bytes.write(chunk);
      this.settings.emit({ direction: side.direction, at, level: 'bytes', header: `${size}: ${escapeBytes(chunk)}` });
      return;
    }
    const { bytes, redacted, hidden } = side.bytes.write(chunk);
    const shown = escapeBytes(bytes);
    const note = hidden > 0 ? ` [${hidden} B hidden: the trace lost the framing and can't redact what follows; trace --no-redact shows it]` : '';
    this.settings.emit({
      direction: side.direction,
      at,
      level: 'bytes',
      header: `${size}${redacted || hidden > 0 ? ' (redacted)' : ''}: ${shown}${note}`,
    });
  }

  private messageEntries(side: Side, text: string, mode: FramingMode, at: Date): void {
    const size = `${byteLength(text)} B`;
    if (this.settings.has('frames')) {
      this.settings.emit({
        direction: side.direction,
        at,
        level: 'frames',
        header: `${size} ${mode}`,
        body: this.settings.redact ? redactMessage(text) : text,
        exact: true,
      });
    }
    if (this.settings.has('xml')) {
      let element: XmlElement;
      try {
        element = parseXml(text);
      } catch (err) {
        this.settings.emit({
          direction: side.direction,
          at,
          level: 'xml',
          header: `${size} not well-formed: ${(err as Error).message}`,
          body: this.settings.redact ? redactMessage(text) : text,
          exact: true,
        });
        return;
      }
      const id = element.attr('message-id');
      const pretty = prettyXml(element);
      const body = this.settings.redact ? redactMessage(pretty) : pretty;
      this.settings.emit({
        direction: side.direction,
        at,
        level: 'xml',
        header: `${size} ${element.name}${id === undefined ? '' : ` message-id=${id}`}`,
        body,
        colouredBody: colourXml(body),
      });
    }
  }
}

function offersBase11(hello: string): boolean {
  try {
    const el = parseXml(hello);
    return (el.child('capabilities')?.childrenNamed('capability') ?? []).some((c) => c.text().trim() === BASE_11);
  } catch {
    return false;
  }
}
