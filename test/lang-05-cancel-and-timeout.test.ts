/**
 * LANG-05: Cancel a slow command or set its timeout.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Fixture } from './support/fixture.js';
import { fixture } from './support/fixture.js';
import { LAB, LATE_MS, langFixture, prompt, received, sentNames } from './support/lang.js';
import { collect, runNnc, startNnc } from './support/nnc.js';

const SILENT = `rpc <silent-please xmlns="${LAB}"/>`;
const LATE = `rpc <late-please xmlns="${LAB}"/>`;

describe('LANG-05 Ctrl-C and --timeout', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await langFixture();
  });
  afterAll(() => f.close());

  it('AC1: Ctrl-C while waiting for a reply cancels it, prints cancelled and returns to the prompt; the session stays open', async () => {
    const child = startNnc(['slow', '-i'], { home: f.home });
    const done = collect(child, undefined);
    await prompt(child, 'nnc slow> ');
    child.stdin.write(`${SILENT}\n`);
    await received(f, 1);
    const back = prompt(child, 'nnc slow> ');
    const started = Date.now();
    child.kill('SIGINT');
    await back;
    expect(Date.now() - started).toBeLessThan(5000);
    child.stdin.end('get-config running\n');
    const r = await done;
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('cancelled\n');
    expect(r.stdout).toContain('<hostname>router1</hostname>');
    expect(sentNames(f)).toEqual(['silent-please', 'get-config']);

    // Connecting is a command too: Ctrl-C cancels it, and the prompt starts with no session.
    const mute = await fixture({ fake: { hello: false } }, { timeouts: { hello: 30_000 } });
    try {
      const connecting = startNnc(['router1', '-i'], { home: mute.home });
      const ended = collect(connecting, undefined);
      while (mute.server.last() === undefined) await new Promise((resolve) => setTimeout(resolve, 20));
      const empty = prompt(connecting, 'nnc> ');
      connecting.kill('SIGINT');
      await empty;
      connecting.stdin.end('status\n');
      const c = await ended;
      expect(c.code).toBe(0);
      expect(c.stderr).toContain('cancelled');
      expect(c.stdout).toContain('nnc> not connected\n');
    } finally {
      await mute.close();
    }
  });

  it('AC2: a reply that arrives after its command was cancelled is not shown as the result of a later command', async () => {
    const child = startNnc(['slow', '-i'], { home: f.home });
    const done = collect(child, undefined);
    await prompt(child, 'nnc slow> ');
    child.stdin.write(`${LATE}\n`);
    await received(f, 1);
    const back = prompt(child, 'nnc slow> ');
    child.kill('SIGINT');
    await back;
    // The late reply arrives while the next command is still waiting for its own.
    child.stdin.end(`${SILENT} --timeout ${LATE_MS * 3}\nget-config running\n`);
    const r = await done;
    expect(r.code).toBe(0);
    expect(r.stderr).toContain(`rpc: no reply within ${LATE_MS * 3} ms`);
    expect(r.stdout + r.stderr).not.toContain('too late');
    expect(r.stdout).toContain('<hostname>router1</hostname>');
    expect(sentNames(f)).toEqual(['late-please', 'silent-please', 'get-config']);
  });

  it('AC3: commands that send requests take --timeout <ms>; a timeout names the command and time, and the session stays open', async () => {
    const started = Date.now();
    const r = await runNnc(
      ['slow', '-c', 'set on-error continue', '-c', `${SILENT} --timeout 200`, '-c', 'get --timeout 250', '-c', 'device nap --timeout 300', '-c', 'get-config running'],
      { home: f.home },
    );
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(r.code).toBe(5);
    expect(r.stderr).toContain('rpc: no reply within 200 ms; the session is still open');
    expect(r.stderr).toContain('get: no reply within 250 ms; the session is still open');
    expect(r.stderr).toContain('device nap: stopped waiting after 300 ms; the operation may still complete on the device');
    expect(r.stdout).toContain('<hostname>router1</hostname>');
    const bad = await runNnc(['slow', '-c', `${SILENT} --timeout soon`], { home: f.home });
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('rpc: --timeout must be a positive whole number of milliseconds');

    // connect --timeout covers connecting and the hello. It is each phase's
    // budget, so it must outlast the SSH handshake: with ssh2's pure-JS crypto
    // (Node 26) that alone can take longer than 300 ms.
    const mute = await fixture({ fake: { hello: false } });
    try {
      const connect = await runNnc(['-c', 'connect router1 --timeout 2000'], { home: mute.home });
      expect(connect.code).toBe(3);
      expect(connect.stderr).toMatch(/hello.*2000 ms/);
    } finally {
      await mute.close();
    }
  });

  it("AC4: without --timeout, the session's default timeout applies", async () => {
    const r = await runNnc(['router1', '-c', SILENT], { home: f.home });
    expect(r.code).toBe(5);
    expect(r.stderr).toContain('rpc: no reply within 600 ms; the session is still open');
  });

  it("AC5: Ctrl-C at an empty prompt does nothing; it doesn't exit or disconnect", async () => {
    const child = startNnc(['router1', '-i'], { home: f.home });
    const done = collect(child, undefined);
    await prompt(child, 'nnc router1> ');
    child.kill('SIGINT');
    await new Promise((resolve) => setTimeout(resolve, 200));
    child.stdin.end('status\n');
    const r = await done;
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/target\s+router1$/m);
    expect(r.stderr).not.toContain('cancelled');
  });
});
