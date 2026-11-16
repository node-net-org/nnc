/**
 * An in-memory host for running nnc in-process (SESS-09, SAFE-11): files in a
 * map, output collected, simulated devices for sim targets, and no Node.js.
 */

import { FakeServer, type FakeServerOptions } from '@node-net/netconf/testing';
import type { HostFiles, NncHost, NncTerminal } from '../../src/host.js';
import { simTransports, type SimDevices } from '../../src/sim.js';

export const HOME = '/home/tutorial';
export const TARGETS = `${HOME}/.config/net-netconf/targets.json`;

export interface MemoryHost {
  readonly host: NncHost;
  readonly files: Map<string, string>;
  /** Everything written to standard output and standard error, so far. */
  out(): string;
  err(): string;
}

/** A sim device backed by a FakeServer. */
export function fakeDevice(options: FakeServerOptions = { handler: () => ({ data: [] }) }): () => ReturnType<FakeServer['transport']> {
  return () => new FakeServer(options).transport();
}

export function memoryHost(options: { targets?: unknown; sims?: SimDevices; terminal?: Partial<NncTerminal> } = {}): MemoryHost {
  const files = new Map<string, string>();
  if (options.targets !== undefined) files.set(TARGETS, JSON.stringify(options.targets));
  const out: string[] = [];
  const err: string[] = [];
  const read = (path: string): string => {
    const text = files.get(path);
    if (text === undefined) throw Object.assign(new Error(`no such file: ${path}`), { code: 'ENOENT', path });
    return text;
  };
  const hostFiles: HostFiles = {
    readText: (path) => Promise.resolve().then(() => read(path)),
    readBytes: (path) => Promise.resolve().then(() => new TextEncoder().encode(read(path))),
    readTextSync: read,
    write(path, data, append) {
      const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
      files.set(path, append ? (files.get(path) ?? '') + text : text);
      return Promise.resolve();
    },
    list: () => [],
    openLog: (path) => ({ path, write: (line) => void files.set(path, `${files.get(path) ?? ''}${line}\n`), close: () => undefined }),
  };
  const terminal: NncTerminal = {
    out: (text) => void out.push(text),
    err: (text) => void err.push(text),
    inIsTerminal: false,
    outIsTerminal: false,
    errIsTerminal: false,
    colourOut: false,
    colourErr: false,
    lineEditor: () => {
      throw new Error('no line editor in this host');
    },
    onInterrupt: () => () => undefined,
    exit: (code) => {
      throw new Error(`exit ${code}`);
    },
    ...options.terminal,
  };
  return {
    host: {
      terminal,
      files: hostFiles,
      transports: simTransports(options.sims ?? { router: fakeDevice() }),
      env: () => undefined,
      homeDir: HOME,
      username: 'tutorial',
    },
    files,
    out: () => out.join(''),
    err: () => err.join(''),
  };
}
