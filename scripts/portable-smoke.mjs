// What portable:check runs, bundled for the browser platform, in a context
// with only web-platform globals (scripts/portable-check.mjs). It imports the
// portable entries only: @node-net/nnc's core and @node-net/netconf/testing, and
// runs nnc on an in-memory host against a simulated device.

import { FakeServer } from '@node-net/netconf/testing';
import { runNnc, simTransports } from '../dist/core.js';

const HOME = '/home/tutorial';
const TARGETS = `${HOME}/.config/net-netconf/targets.json`;

function memoryHost(out, err) {
  const files = new Map([[TARGETS, JSON.stringify({ lab: { transport: 'sim', device: 'router' } })]]);
  const missing = (path) => Object.assign(new Error(`no such file: ${path}`), { code: 'ENOENT', path });
  const read = (path) => {
    const text = files.get(path);
    if (text === undefined) throw missing(path);
    return text;
  };
  return {
    terminal: {
      out: (text) => out.push(text),
      err: (text) => err.push(text),
      inIsTerminal: false,
      outIsTerminal: false,
      errIsTerminal: false,
      colourOut: false,
      colourErr: false,
      lineEditor: () => {
        throw new Error('no line editor in the smoke run');
      },
      onInterrupt: () => () => undefined,
      exit: (code) => {
        throw new Error(`exit ${code}`);
      },
    },
    files: {
      readText: (path) => Promise.resolve().then(() => read(path)),
      readBytes: (path) => Promise.resolve().then(() => new TextEncoder().encode(read(path))),
      readTextSync: read,
      write: (path, data, append) => {
        const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
        files.set(path, append ? (files.get(path) ?? '') + text : text);
        return Promise.resolve();
      },
      list: () => [],
      openLog: (path) => ({ path, write: (line) => files.set(path, (files.get(path) ?? '') + `${line}\n`), close: () => undefined }),
    },
    transports: simTransports({ router: () => new FakeServer({ handler: () => ({ data: [] }) }).transport() }),
    env: () => undefined,
    homeDir: HOME,
    username: 'tutorial',
  };
}

globalThis.portableSmoke = async () => {
  const out = [];
  const err = [];
  const exitCode = await runNnc(memoryHost(out, err), {
    source: { kind: 'commands', commands: ['trace frames', 'connect lab', 'status', 'capabilities', 'get-config running', 'disconnect'] },
  });
  return { exitCode, out: out.join(''), err: err.join('') };
};
