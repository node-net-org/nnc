/**
 * The Node.js host (docs/cli.md §2.6): what the `nnc` command gives the
 * portable CLI. Standard input, output and error, readline, the files on
 * disk, $EDITOR and $PAGER, SIGINT, and SSH, TLS and call home.
 */

import { closeSync, openSync, readdirSync, readFileSync, writeSync } from 'node:fs';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { connect, loadDeviceProfiles } from '@node-net/netconf';
import type { HostFiles, NncHost, NncTerminal, Transports } from '../host.js';
import { simTransports, type SimDevices } from '../sim.js';
import { nodeHistory } from './history.js';
import { LineInput } from './line-input.js';
import { editText, runPager } from './terminal-tools.js';
import { defaultUsername, nodeTransports } from './transports.js';

export interface NodeHostOptions {
  /** Simulated devices for sim targets (tests); SSH and TLS reach every other target. */
  readonly sims?: SimDevices;
  /** Keep command history in ~/.config/net-netconf/history. Default true. */
  readonly history?: boolean;
}

export function createNodeHost(options: NodeHostOptions = {}): NncHost {
  // Sim targets always go through simTransports, so the nnc command (which has no simulated devices) names the missing device instead of trying SSH.
  const transports: Transports = simTransports(options.sims ?? {}, nodeTransports);
  return {
    terminal: nodeTerminal,
    files: nodeFiles,
    transports,
    ...(options.history === false ? {} : { history: nodeHistory() }),
    env: (name) => process.env[name],
    homeDir: homedir(),
    username: defaultUsername(),
    connect,
    loadProfiles: (dir) => loadDeviceProfiles(dir),
  };
}

/** Colour on a stream: on a terminal unless NO_COLOR is set; FORCE_COLOR turns it on anyway. */
function colour(isTerminal: boolean): boolean {
  const force = process.env['FORCE_COLOR'];
  if (force !== undefined && force !== '' && force !== '0') return true;
  if (process.env['NO_COLOR'] !== undefined && process.env['NO_COLOR'] !== '') return false;
  return isTerminal;
}

const nodeTerminal: NncTerminal = {
  out: (text) => void process.stdout.write(text),
  err: (text) => void process.stderr.write(text),
  inIsTerminal: process.stdin.isTTY,
  outIsTerminal: process.stdout.isTTY,
  errIsTerminal: process.stderr.isTTY,
  colourOut: colour(process.stdout.isTTY),
  colourErr: colour(process.stderr.isTTY),
  lineEditor: (options) => new LineInput(options),
  onInterrupt(handler) {
    process.on('SIGINT', handler);
    return () => void process.off('SIGINT', handler);
  },
  exit: (code) => process.exit(code),
  page: runPager,
  edit: editText,
};

const nodeFiles: HostFiles = {
  readText: (path) => readFile(path, 'utf8'),
  readBytes: (path) => readFile(path),
  readTextSync: (path) => readFileSync(path, 'utf8'),
  write: (path, data, append) => (append ? appendFile(path, data) : writeFile(path, data)),
  list: (dir) => readdirSync(dir, { withFileTypes: true }).map((e) => ({ name: e.name, directory: e.isDirectory() })),
  openLog(path) {
    const full = resolve(process.cwd(), path);
    const fd = openSync(full, 'a', 0o600);
    return {
      path: full,
      write: (line) => void writeSync(fd, `${line}\n`),
      close() {
        try {
          closeSync(fd);
        } catch {
          // Already gone; nothing to do.
        }
      },
    };
  },
};
