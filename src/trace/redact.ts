/**
 * Redaction for traces (TRACE-05, docs/cli.md §5).
 *
 * Which element names are secret is the library's rule: `redactXml` is asked
 * about each name, so the CLI never keeps a second list. What differs is how
 * the rule is applied. `redactXml` works on whole messages; a bytes trace sees
 * chunks as they arrive, so a secret, or the tag that announces it, can be
 * split across reads. The scanners here keep their state between chunks
 * instead, so nothing is held back and nothing slips through a boundary.
 *
 * Text (and CDATA) anywhere inside a secret-named element becomes `***`.
 * Leading whitespace is kept so indented XML stays indented. Tags pass
 * unchanged: names and attributes are never secret.
 */

import { redactXml } from '@node-net/netconf/core';
import { fromUtf8, utf8 } from '../bytes.js';

const secretNames = new Map<string, boolean>();

/** Whether the library's redaction treats an element with this name as secret. */
export function isSecretName(qname: string): boolean {
  const local = qname.slice(qname.indexOf(':') + 1);
  let known = secretNames.get(local);
  if (known === undefined) {
    const probe = `<${local}>x</${local}>`;
    known = /^[\w.-]+$/.test(local) && redactXml(probe) !== probe;
    if (secretNames.size < 10_000) secretNames.set(local, known);
  }
  return known;
}

const LT = 0x3c;
const GT = 0x3e;
const SLASH = 0x2f;
const BANG = 0x21;
const QUESTION = 0x3f;
const MASK = utf8('***');
/** Longest element name checked against the secret-name rule. */
const MAX_NAME = 1024;

function isSpace(b: number): boolean {
  return b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d;
}

type XmlState =
  | 'text'
  | 'lt' // just read <
  | 'open' // reading an open tag's name
  | 'attrs' // inside an open tag, after its name
  | 'close' // inside a close tag
  | 'bang' // read <! and deciding between comment, CDATA and a declaration
  | 'comment'
  | 'cdata'
  | 'decl'
  | 'pi';

/** Streams XML bytes through, replacing secret text with `***`. */
export class XmlRedactor {
  private state: XmlState = 'text';
  /** Each open element's name, and whether text inside it is secret. */
  private stack: { name: string; secret: boolean }[] = [];
  /** Inside a declaration: the open quote, and `[` depth (a DOCTYPE internal subset). */
  private declQuote = 0;
  private declDepth = 0;
  private secretDepth = 0;
  private name = '';
  private quote = 0;
  private prev = 0;
  private bang = '';
  /** How far the end marker of a comment, CDATA section or PI has matched. */
  private endMatch = 0;
  /** In the current run of secret text: `***` already written. */
  private masked = false;
  /** Something was replaced since the last `take()`. */
  private replaced = false;
  private out: number[] = [];

  /** Forget everything: a new message starts. */
  reset(): void {
    this.state = 'text';
    this.stack = [];
    this.secretDepth = 0;
    this.masked = false;
  }

  /** Feed bytes; their (possibly redacted) form is collected for `take()`. */
  write(bytes: Uint8Array): void {
    for (const b of bytes) this.byte(b);
  }

  /** Feed one byte. */
  writeByte(b: number): void {
    this.byte(b);
  }

  /** The output collected so far, and whether anything in it was replaced. */
  take(): { bytes: Uint8Array; redacted: boolean } {
    const result = { bytes: Uint8Array.from(this.out), redacted: this.replaced };
    this.out = [];
    this.replaced = false;
    return result;
  }

  /** A new trace entry starts: a secret that continues into it gets its own `***`. */
  newEntry(): void {
    this.masked = false;
  }

  private secretText(b: number): void {
    if (this.masked) return;
    if (isSpace(b)) {
      this.out.push(b);
      return;
    }
    for (const m of MASK) this.out.push(m);
    this.masked = true;
    this.replaced = true;
  }

  private byte(b: number): void {
    switch (this.state) {
      case 'text':
        if (b === LT) {
          this.masked = false;
          this.out.push(b);
          this.state = 'lt';
        } else if (this.secretDepth > 0) this.secretText(b);
        else this.out.push(b);
        return;
      case 'cdata':
        // ]]> ends the section. Up to two ] are held until we know whether they're content or the end marker.
        if (b === 0x5d) {
          if (this.endMatch < 2) this.endMatch++;
          else this.cdataContent(0x5d);
        } else if (b === GT && this.endMatch === 2) {
          this.endMatch = 0;
          this.masked = false;
          this.out.push(0x5d, 0x5d, GT);
          this.state = 'text';
        } else {
          for (; this.endMatch > 0; this.endMatch--) this.cdataContent(0x5d);
          this.cdataContent(b);
        }
        return;
      default:
        this.out.push(b);
        this.markup(b);
    }
  }

  private cdataContent(b: number): void {
    if (this.secretDepth > 0) this.secretText(b);
    else this.out.push(b);
  }

  private markup(b: number): void {
    switch (this.state) {
      case 'lt':
        if (b === SLASH) {
          this.state = 'close';
          this.name = '';
        }
        else if (b === BANG) {
          this.state = 'bang';
          this.bang = '';
        } else if (b === QUESTION) {
          this.state = 'pi';
          this.endMatch = 0;
        } else {
          this.state = 'open';
          this.name = String.fromCharCode(b);
          this.quote = 0;
          this.prev = 0;
        }
        return;
      case 'open':
        if (isSpace(b) || b === SLASH || b === GT) {
          this.state = 'attrs';
          this.markup(b);
        } else if (this.name.length <= MAX_NAME) this.name += String.fromCharCode(b);
        return;
      case 'attrs':
        if (this.quote !== 0) {
          if (b === this.quote) this.quote = 0;
        } else if (b === 0x22 || b === 0x27) this.quote = b;
        else if (b === GT) {
          // A name too long to check is treated as secret: better a hidden value than a leaked one.
          if (this.prev !== SLASH) this.push(this.name, this.name.length > MAX_NAME || isSecretName(this.name));
          this.state = 'text';
        }
        this.prev = b;
        return;
      case 'close':
        if (b === GT) {
          this.pop(this.name.trim());
          this.state = 'text';
        } else if (this.name.length <= MAX_NAME) this.name += String.fromCharCode(b);
        return;
      case 'bang':
        this.bang += String.fromCharCode(b);
        if (this.bang === '--') {
          this.state = 'comment';
          this.endMatch = 0;
        } else if (this.bang === '[CDATA[') {
          this.state = 'cdata';
          this.endMatch = 0;
        } else if (!'--'.startsWith(this.bang) && !'[CDATA['.startsWith(this.bang)) {
          this.state = b === GT ? 'text' : 'decl';
          this.declQuote = 0;
          this.declDepth = 0;
          if (b !== GT) this.markup(b);
        }
        return;
      case 'comment':
        // -->
        if (b === 0x2d) this.endMatch = Math.min(this.endMatch + 1, 2);
        else if (b === GT && this.endMatch === 2) this.state = 'text';
        else this.endMatch = 0;
        return;
      case 'pi':
        if (b === GT && this.endMatch === 1) this.state = 'text';
        else this.endMatch = b === QUESTION ? 1 : 0;
        return;
      case 'decl':
        // A '>' inside a quoted value or a DOCTYPE internal subset doesn't end the declaration.
        if (this.declQuote !== 0) {
          if (b === this.declQuote) this.declQuote = 0;
        } else if (b === 0x22 || b === 0x27) this.declQuote = b;
        else if (b === 0x5b) this.declDepth++;
        else if (b === 0x5d) this.declDepth = Math.max(0, this.declDepth - 1);
        else if (b === GT && this.declDepth === 0) this.state = 'text';
        return;
      case 'text':
      case 'cdata':
        // Handled in byte().
        return;
    }
  }

  private push(name: string, secret: boolean): void {
    this.stack.push({ name, secret });
    if (secret) this.secretDepth++;
  }

  /**
   * Close the element named, and any left open inside it. A close tag that
   * matches nothing open is ignored: in malformed XML, guessing which element
   * it closes could end a secret early.
   */
  private pop(name: string): void {
    let i = this.stack.length - 1;
    while (i >= 0 && this.stack[i]!.name !== name) i--;
    if (i < 0) return;
    while (this.stack.length > i) {
      if (this.stack.pop()!.secret) this.secretDepth--;
    }
  }
}

/** Redact one whole message. */
export function redactMessage(text: string): string {
  const r = new XmlRedactor();
  r.write(utf8(text));
  return fromUtf8(r.take().bytes);
}

export type FramingMode = 'eom' | 'chunked';

const EOM = utf8(']]>]]>');
const MAX_CHUNK = 4294967295;

type ChunkState = 'lf' | 'hash' | 'first' | 'size' | 'endLf' | 'data';

/**
 * Redaction for the bytes level: follows the framing itself, so only message
 * content reaches the XML scanner. Chunk headers pass unchanged and can never
 * split a tag name. If the framing stops making sense, everything after is
 * hidden: the scanner can no longer tell content from framing, and showing
 * bytes it can't vouch for could show a secret.
 */
export class BytesRedactor {
  private readonly xml = new XmlRedactor();
  private mode: FramingMode = 'eom';
  private messages = 0;
  /** Non-whitespace bytes since the last message boundary. */
  private pending = 0;
  private wantChunked = false;
  private eomMatch = 0;
  private chunk: ChunkState = 'lf';
  private size = 0;
  private digits = 0;
  private remaining = 0;
  /** After the switch: whitespace left over from end-of-message framing is allowed. */
  private atSwitch = false;
  /** Set once the framing is lost: nothing more is shown. */
  lost = false;
  private out: number[] = [];

  /**
   * Switch to chunked framing at the next message boundary, or now if one
   * has just passed. Called once both hellos agree on base:1.1, or by a
   * framed session's `framing chunked`. It must be called before the bytes
   * of the first chunked message are written here: called late, chunk
   * headers would reach the XML scanner and could split a tag name.
   */
  useChunked(): void {
    this.wantChunked = true;
    if (this.messages > 0 && this.pending === 0) this.switchNow();
  }

  /** Redact one chunk. `hidden` counts the bytes withheld because the framing was lost. */
  write(chunk: Uint8Array): { bytes: Uint8Array; redacted: boolean; hidden: number } {
    let hidden = 0;
    this.xml.newEntry();
    for (let i = 0; i < chunk.length; i++) {
      if (this.lost) {
        hidden = chunk.length - i;
        break;
      }
      const b = chunk[i]!;
      if (this.mode === 'eom') this.eomByte(b);
      else this.chunkedByte(b);
    }
    this.flushXml();
    const result = { bytes: Uint8Array.from(this.out), redacted: this.redacted, hidden };
    this.out = [];
    this.redacted = false;
    return result;
  }

  private redacted = false;

  private flushXml(): void {
    const { bytes, redacted } = this.xml.take();
    for (const b of bytes) this.out.push(b);
    if (redacted) this.redacted = true;
  }

  private eomByte(b: number): void {
    this.xml.writeByte(b);
    if (!isSpace(b)) this.pending++;
    if (b === EOM[this.eomMatch]) {
      this.eomMatch++;
      if (this.eomMatch === EOM.length) {
        this.eomMatch = 0;
        this.boundary();
      }
    } else this.eomMatch = b === EOM[0] ? 1 : 0;
  }

  private boundary(): void {
    this.flushXml();
    this.xml.reset();
    this.messages++;
    this.pending = 0;
    if (this.wantChunked && this.mode === 'eom') this.switchNow();
  }

  private switchNow(): void {
    this.mode = 'chunked';
    this.chunk = 'lf';
    this.atSwitch = true;
  }

  private chunkedByte(b: number): void {
    if (this.chunk === 'data') {
      this.xml.writeByte(b);
      if (--this.remaining === 0) {
        this.flushXml();
        this.chunk = 'lf';
      }
      return;
    }
    // Framing bytes pass through as they are.
    this.flushXml();
    this.out.push(b);
    switch (this.chunk) {
      case 'lf':
        if (b === 0x0a) this.chunk = 'hash';
        else if (!(this.atSwitch && isSpace(b))) this.lose();
        return;
      case 'hash':
        if (b === 0x23) {
          this.chunk = 'first';
          this.atSwitch = false;
        } else if (!(this.atSwitch && isSpace(b))) this.lose();
        return;
      case 'first':
        if (b === 0x23) this.chunk = 'endLf';
        else if (b >= 0x31 && b <= 0x39) {
          this.size = b - 0x30;
          this.digits = 1;
          this.chunk = 'size';
        } else this.lose();
        return;
      case 'size':
        if (b === 0x0a) {
          this.remaining = this.size;
          this.chunk = 'data';
          this.pending++;
        } else if (b >= 0x30 && b <= 0x39 && this.digits < 10) {
          this.size = this.size * 10 + (b - 0x30);
          this.digits++;
          if (this.size > MAX_CHUNK) this.lose();
        } else this.lose();
        return;
      case 'endLf':
        if (b === 0x0a) {
          this.chunk = 'lf';
          this.boundary();
        } else this.lose();
        return;
    }
  }

  private lose(): void {
    this.lost = true;
  }
}
