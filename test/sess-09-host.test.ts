/**
 * SESS-09: nnc runs on a host that supplies its terminal, files, transports
 * and environment. In-process, on an in-memory host with no Node.js in it.
 */

import { describe, expect, it } from 'vitest';
import { runNnc } from '../src/run.js';
import { HOME, memoryHost } from './support/memory-host.js';

const TARGETS = { lab: { transport: 'sim', device: 'router' } };

describe('SESS-09 nnc on a host', () => {
  it('reads the targets file and writes redirects and the trace file through the host', async () => {
    const m = memoryHost({ targets: TARGETS });
    const exitCode = await runNnc(m.host, {
      source: { kind: 'commands', commands: ['trace frames --file /tmp/t.log', 'connect lab', 'get-config running > ~/cfg.xml', 'disconnect'] },
    });
    expect(exitCode).toBe(0);
    expect(m.files.get(`${HOME}/cfg.xml`)).toContain('(no data)');
    expect(m.files.get('/tmp/t.log')).toMatch(/# nnc trace · lab/);
    expect(m.files.get('/tmp/t.log')).toMatch(/frames \d+ B chunked/);
  });

  it('a host with no call home makes listen fail, saying so', async () => {
    const m = memoryHost({ targets: TARGETS });
    const exitCode = await runNnc(m.host, { source: { kind: 'commands', commands: ['listen lab'] } });
    expect(exitCode).toBe(2);
    expect(m.err()).toContain('listen: waiting for a device to call home is not available here');
  });

  it('a host with no editor makes --edit fail, saying so', async () => {
    const m = memoryHost({ targets: TARGETS });
    const exitCode = await runNnc(m.host, { source: { kind: 'commands', commands: ['connect lab', 'rpc --edit'] } });
    expect(exitCode).toBe(2);
    expect(m.err()).toContain('rpc: --edit needs an editor, and there is none here');
  });

  it('only sim targets can be reached when the host has no other transport', async () => {
    const m = memoryHost();
    const exitCode = await runNnc(m.host, { source: { kind: 'commands', commands: ['connect admin@192.0.2.1'] } });
    expect(exitCode).toBe(3);
    expect(m.err()).toContain('only simulated devices ("transport": "sim") can be reached here');
  });

  it('runs a script with line numbers in its errors, and history is optional', async () => {
    const m = memoryHost({ targets: TARGETS });
    const exitCode = await runNnc(m.host, { source: { kind: 'script', label: 'lab.nnc', lines: ['connect lab', 'history', 'nonsense', 'disconnect'] } });
    expect(exitCode).toBe(2);
    expect(m.out()).toContain('(history is not kept here)');
    expect(m.err()).toContain('lab.nnc:3: unknown command: nonsense');
  });
});
