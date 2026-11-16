/**
 * Framed and raw sessions (docs/cli.md §6.4, §6.5; LOW-01..07): open one, and
 * the commands that drive it. Nothing is sent for the user: the hello, the
 * framing switch and every byte are theirs.
 */

import { FramingError, parseXml } from '@node-net/netconf/core';
import { byteLength, concat, fromHex, utf8 } from '../bytes.js';
import type { Cli } from '../cli.js';
import { CliError, EXIT, usageError } from '../errors.js';
import { expandHome } from '../paths.js';
import { prettyXml } from '../render/xml.js';
import { openLowSession, type LowKind, type LowSession, type ReceivedMessage } from '../sessions/low.js';
import type { Target } from '../targets.js';
import { escapeBytes, timestamp } from '../trace/format.js';
import { Tracer } from '../trace/tracer.js';
import type { Command, CommandResult, ParsedArgs } from './registry.js';
import { escapeControls } from './results.js';
import { EDIT_OPTION, editXml, xmlText } from './xml-input.js';

const NETCONF_NS = 'urn:ietf:params:xml:ns:netconf:base:1.0';
const BASE_10 = 'urn:ietf:params:netconf:base:1.0';
const BASE_11 = 'urn:ietf:params:netconf:base:1.1';

function low(cli: Cli, kind: LowKind): LowSession {
  const s = cli.low;
  if (s?.kind !== kind) throw new CliError('not connected');
  return s;
}

export function byteCount(n: number): string {
  return `${n} byte${n === 1 ? '' : 's'}`;
}

// --- opening -----------------------------------------------------------------------------

/** Open a framed or raw session and say what was opened and what the user drives. */
export async function openLow(cli: Cli, kind: LowKind, target: Target, signal: AbortSignal): Promise<string> {
  const session = await openLowSession({
    kind,
    target,
    host: cli.host,
    signal,
    prompt: (text) => cli.io.secret(text),
    tracer: () => {
      cli.trace.sessionStarted(target.name);
      // A framed session's trace follows its channel's framing (`framing chunked`); a raw one guesses from the hellos.
      return new Tracer(cli.trace, undefined, { autoFraming: kind === 'raw' });
    },
    onMessage: (_s, message, number) => cli.io.notice(messageText(message, number, true)),
    onBytes: (_s, chunk, offset) => cli.io.notice(`<< ${byteCount(chunk.length)}\n${bytesText(chunk, offset, cli.output.bytes)}`),
    onEnd: (ended, reason) => {
      if (cli.low !== ended) return;
      cli.low = undefined;
      cli.io.notice(`${ended.kind} session to ${ended.name} ended: ${reason}`);
    },
  });
  cli.low = session;
  if (session.insecure) {
    cli.io.err(
      `warning: the ${session.transport === 'tls' ? 'server certificate' : 'host key'} of ${session.host}:${session.port} was not verified; ` +
        `received fingerprint ${session.fingerprint ?? 'unknown'}`,
    );
  }
  const where = `${session.host}:${session.port}${session.via === undefined ? '' : ` via ${session.via}`}${session.transport === 'tls' ? ' over TLS' : ''}`;
  return kind === 'framed'
    ? `opened a framed session to ${session.name} (${where}) · end-of-message framing · nothing sent: you send the hello (hello, send, framing, show; help lists them)`
    : `opened a raw session to ${session.name} (${where}) · no framing · nothing sent: bytes go exactly as you give them (send, send-hex, send-file, eof; help lists them)`;
}

// --- showing what arrives ------------------------------------------------------------------

/** The root element's name, or undefined if the message isn't well-formed XML. */
function rootOf(text: string): string | undefined {
  try {
    return parseXml(text).name;
  } catch {
    return undefined;
  }
}

/** A received message: a header line, then indented XML, or the text with the parse error. */
function messageText(message: ReceivedMessage, number: number, header: boolean): string {
  const size = `${byteLength(message.text)} B`;
  try {
    const element = parseXml(message.text);
    const pretty = prettyXml(element);
    return header ? `message ${number} · ${element.name} · ${size}\n${pretty}` : pretty;
  } catch (err) {
    const why = `not well-formed XML: ${(err as Error).message}`;
    return `${header ? `message ${number} · ${size} · ` : ''}${why}\n${message.text.split('\n').map(escapeControls).join('\n')}`;
  }
}

/** Bytes as text (control and non-UTF-8 bytes as `\xHH`, a newline shown as `\n` and then taken), or as a hex dump. */
export function bytesText(bytes: Uint8Array, offset: number, view: 'text' | 'hex'): string {
  if (view === 'hex') return hexDump(bytes, offset);
  const lines: string[] = [];
  let start = 0;
  for (let i = bytes.indexOf(0x0a); i !== -1; i = bytes.indexOf(0x0a, start)) {
    lines.push(`${escapeBytes(bytes.subarray(start, i))}\\n`);
    start = i + 1;
  }
  if (start < bytes.length || lines.length === 0) lines.push(escapeBytes(bytes.subarray(start)));
  return lines.join('\n');
}

/** `00000010  3c 72 70 63 20 6d 65 73  73 61 67 65 2d 69 64 3d  |<rpc message-id=|` */
export function hexDump(bytes: Uint8Array, offset: number): string {
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const row = bytes.subarray(i, i + 16);
    const hex = [...row].map((b) => b.toString(16).padStart(2, '0'));
    const left = hex.slice(0, 8).join(' ');
    const right = hex.slice(8).join(' ');
    const text = [...row].map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('');
    lines.push(`${(offset + i).toString(16).padStart(8, '0')}  ${left.padEnd(23)}  ${right.padEnd(23)}  |${text}|`);
  }
  return lines.join('\n');
}

// --- framed --------------------------------------------------------------------------------

/** `hello` in a framed session: send a client hello advertising base:1.0 and base:1.1, or only the one `--base` names. */
export function sendHello(cli: Cli, args: ParsedArgs): Promise<CommandResult> {
  const s = low(cli, 'framed');
  const base = args.options['base'];
  if (base !== undefined && base !== '1.0' && base !== '1.1') throw usageError(`hello: --base is 1.0 or 1.1 (got ${JSON.stringify(base)})`);
  const caps = base === '1.0' ? [BASE_10] : base === '1.1' ? [BASE_11] : [BASE_10, BASE_11];
  const hello = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<hello xmlns="${NETCONF_NS}">`,
    '  <capabilities>',
    ...caps.map((c) => `    <capability>${c}</capability>`),
    '  </capabilities>',
    '</hello>',
  ].join('\n');
  return Promise.resolve(writeFramed(s, hello, 'hello'));
}

function writeFramed(s: LowSession, text: string, command: string): CommandResult {
  const channel = s.channel!;
  let framed: Uint8Array;
  try {
    framed = channel.encode(text);
  } catch (err) {
    if (err instanceof FramingError) {
      throw new CliError(`${command}: can't frame this message in end-of-message framing: it contains ]]>]]>; a raw session can send it; nothing was sent`);
    }
    throw err;
  }
  channel.write(framed);
  return { text: `sent ${byteCount(framed.length)} (framed, ${channel.framing})`, message: true };
}

export const serverHelloCommand: Command = {
  name: 'server-hello',
  group: 'transport',
  example: 'server-hello',
  summary: "Show the server's <hello>, once it has arrived",
  args: [],
  options: { raw: { type: 'boolean', description: 'exactly as received' } },
  kinds: ['framed'],
  run(cli, args) {
    const first = low(cli, 'framed').messages[0];
    if (first === undefined || rootOf(first.text) !== 'hello') return Promise.resolve({ text: "the server's hello hasn't arrived" });
    if (args.options['raw'] === true) return Promise.resolve({ bytes: utf8(first.text), screen: first.text });
    return Promise.resolve({ text: messageText(first, 1, false) });
  },
};

export const sendCommand: Command = {
  name: 'send',
  group: 'transport',
  example: 'send <rpc message-id="7" xmlns="urn:ietf:params:netconf:base:1.0"><get/></rpc>',
  summary: 'Send a message exactly as written (framed sessions), or text as bytes (raw sessions)',
  describe: {
    framed: 'Send a message exactly as written, framed in the current framing: inline XML, @file or --edit; nothing is checked or added',
    raw: 'Write the rest of the line as UTF-8 bytes, no newline added; \\n \\r \\t \\\\ and \\xHH give those bytes',
  },
  args: [{ name: 'message', description: 'framed: the message (inline, or @file); raw: the text, taken verbatim to the end of the line', optional: true, variadic: true }],
  options: { edit: EDIT_OPTION },
  kinds: ['framed', 'raw'],
  rawLineIn: ['raw'],
  async run(cli, args) {
    if (cli.kind === 'raw') {
      const s = writable(cli, 'send');
      const text = args.positional[0] ?? '';
      if (text === '') throw usageError('send: give the text to send (escapes: \\n \\r \\t \\\\ \\xHH)');
      return writeRaw(s, unescape(text));
    }
    const s = low(cli, 'framed');
    let text: string;
    if (args.options['edit'] === true) {
      if (args.positional.length > 0) throw usageError('send: give the message or --edit, not both');
      text = await editXml(cli, 'send');
    } else {
      const given = args.positional.join(' ');
      if (given === '') throw usageError('send: give the message: inline XML, @file or --edit');
      text = await xmlText(cli.host, given, (path, reason) => `send: cannot read ${path}: ${reason}`);
    }
    cli.lastXml.set('send', text);
    return writeFramed(s, text, 'send');
  },
};

export const framingCommand: Command = {
  name: 'framing',
  group: 'transport',
  example: 'framing chunked',
  summary: 'Show the framing, or switch both directions to chunked framing from the next message (it cannot be undone)',
  args: [{ name: 'mode', description: 'chunked (eom only while it is still in use)', optional: true, values: ['chunked'] }],
  options: {},
  kinds: ['framed'],
  run(cli, args) {
    const s = low(cli, 'framed');
    const channel = s.channel!;
    const mode = args.positional[0];
    if (mode === undefined) return Promise.resolve({ text: channel.framing === 'eom' ? 'eom (end-of-message, ]]>]]>)' : 'chunked' });
    if (mode === 'eom') {
      if (channel.framing === 'chunked') throw new CliError("framing: can't switch back to end-of-message framing: the switch to chunked can't be undone");
      return Promise.resolve({ text: 'framing is already eom', message: true });
    }
    if (mode !== 'chunked') throw usageError(`framing: use chunked (got ${JSON.stringify(mode)})`);
    if (channel.framing === 'chunked') return Promise.resolve({ text: 'framing is already chunked', message: true });
    try {
      channel.useChunkedFraming();
    } catch (err) {
      throw new CliError(`framing: can't switch now: ${(err as Error).message}`, EXIT.protocol);
    }
    s.tracer?.setFraming('chunked');
    return Promise.resolve({ text: 'switched to chunked framing in both directions, from the next message', message: true });
  },
};

export const showCommand: Command = {
  name: 'show',
  group: 'transport',
  example: 'show 3 --raw > reply.xml',
  summary: 'List the messages received, or show message N again (--raw: exactly as received)',
  args: [{ name: 'number', description: 'the message number, from 1', optional: true }],
  options: { raw: { type: 'boolean', description: 'exactly as received, with no indenting' } },
  kinds: ['framed'],
  run(cli, args) {
    const { messages } = low(cli, 'framed');
    const given = args.positional[0];
    if (given === undefined) {
      if (messages.length === 0) return Promise.resolve({ text: 'no messages received yet' });
      const width = String(messages.length).length;
      const sizes = messages.map((m) => `${byteLength(m.text)} B`);
      const sizeWidth = Math.max(...sizes.map((x) => x.length));
      const lines = messages.map(
        (m, i) => `${String(i + 1).padStart(width)}  ${timestamp(m.at)}  ${sizes[i]!.padStart(sizeWidth)}  ${rootOf(m.text) ?? '(not well-formed XML)'}`,
      );
      return Promise.resolve({ text: lines.join('\n') });
    }
    const n = Number(given);
    if (!Number.isInteger(n) || n < 1 || n > messages.length) {
      throw usageError(`show: no message ${given} (${messages.length === 0 ? 'none received yet' : `1 to ${messages.length}`})`);
    }
    const message = messages[n - 1]!;
    if (args.options['raw'] === true) return Promise.resolve({ bytes: utf8(message.text), screen: message.text });
    return Promise.resolve({ text: messageText(message, n, false) });
  },
};

// --- raw -----------------------------------------------------------------------------------

function writable(cli: Cli, command: string): LowSession {
  const s = low(cli, 'raw');
  if (s.eof) throw new CliError(`${command}: the stream has been ended (eof); nothing was sent`);
  return s;
}

function writeRaw(s: LowSession, bytes: Uint8Array): CommandResult {
  s.connection.write(bytes);
  return { text: `sent ${byteCount(bytes.length)} (raw)`, message: true };
}

/** Text with `\n \r \t \\ \xHH` escapes, as UTF-8 bytes. An unknown escape fails, pointing at it. */
export function unescape(text: string): Uint8Array {
  const parts: Uint8Array[] = [];
  let plain = '';
  const flush = (): void => {
    if (plain !== '') parts.push(utf8(plain));
    plain = '';
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c !== '\\') {
      plain += c;
      continue;
    }
    const e = text[i + 1];
    const simple: Record<string, string> = { n: '\n', r: '\r', t: '\t', '\\': '\\' };
    if (e !== undefined && simple[e] !== undefined) {
      plain += simple[e];
      i++;
    } else if (e === 'x' && /^[0-9a-fA-F]{2}$/.test(text.slice(i + 2, i + 4))) {
      flush();
      parts.push(Uint8Array.of(parseInt(text.slice(i + 2, i + 4), 16)));
      i += 3;
    } else {
      const shown = e === 'x' ? text.slice(i, i + 4) : text.slice(i, i + 2);
      throw usageError(
        `send: invalid escape ${JSON.stringify(shown)} at column ${i + 1} (use \\n \\r \\t \\\\ or \\xHH); nothing was sent\n  ${text}\n  ${' '.repeat(i)}^`,
      );
    }
  }
  flush();
  return concat(parts);
}

export const sendHexCommand: Command = {
  name: 'send-hex',
  group: 'transport',
  example: 'send-hex 3c 68 65 6c 6c 6f',
  summary: 'Write the bytes given in hex (spaces optional)',
  args: [{ name: 'hex', description: 'hex digits, two per byte', variadic: true }],
  options: {},
  kinds: ['raw'],
  run(cli, args) {
    const s = writable(cli, 'send-hex');
    const digits = args.positional.join('').replace(/\s+/g, '');
    const bad = /[^0-9a-fA-F]/.exec(digits);
    if (bad !== null) throw usageError(`send-hex: ${JSON.stringify(bad[0])} is not a hex digit; nothing was sent`);
    if (digits.length % 2 !== 0) throw usageError(`send-hex: an odd number of hex digits (${digits.length}); give two per byte; nothing was sent`);
    return Promise.resolve(writeRaw(s, fromHex(digits)));
  },
};

export const sendFileCommand: Command = {
  name: 'send-file',
  group: 'transport',
  example: 'send-file reply.bin',
  summary: "Write a file's bytes unchanged",
  args: [{ name: 'path', description: 'the file to send' }],
  options: {},
  kinds: ['raw'],
  async run(cli, args) {
    const s = writable(cli, 'send-file');
    const path = args.positional[0]!;
    let bytes: Uint8Array;
    try {
      bytes = await cli.host.files.readBytes(expandHome(path, cli.host.homeDir));
    } catch (err) {
      throw new CliError(`send-file: cannot read ${path}: ${(err as { code?: string }).code ?? (err as Error).message}; nothing was sent`);
    }
    return writeRaw(s, bytes);
  },
};

export const receivedCommand: Command = {
  name: 'received',
  group: 'transport',
  example: 'received > dump.bin',
  summary: 'Show everything received in this session (as text or hex, per output); > file saves the bytes unchanged',
  args: [],
  options: {},
  kinds: ['raw'],
  run(cli) {
    const s = low(cli, 'raw');
    const bytes = concat(s.received);
    const screen = bytes.length === 0 ? 'nothing received yet' : bytesText(bytes, 0, cli.output.bytes);
    return Promise.resolve({ bytes, screen });
  },
};

export const eofCommand: Command = {
  name: 'eof',
  group: 'transport',
  example: 'eof',
  summary: "End the sending side of the stream; what the server sends is still shown until it closes",
  args: [],
  options: {},
  kinds: ['raw'],
  run(cli) {
    const s = low(cli, 'raw');
    if (s.eof) return Promise.resolve({ text: 'the stream has already been ended (eof)', message: true });
    s.eof = true;
    s.connection.end();
    return Promise.resolve({ text: 'ended the sending side of the stream (eof); received bytes are still shown until the server closes', message: true });
  },
};
