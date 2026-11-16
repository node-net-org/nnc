/**
 * SCRIPT-06: Start the interactive prompt from the shell.
 *
 * A subprocess's standard input is a pipe, never a terminal, so the terminal
 * cases run with -i, which starts the prompt exactly as a terminal does.
 */
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Fixture } from './support/fixture.js';
import { runNnc } from './support/nnc.js';
import { RPC, scriptFixture, sentNames } from './support/script.js';

const require = createRequire(import.meta.url);

describe('SCRIPT-06 the prompt from the shell', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await scriptFixture();
  });
  afterAll(() => f.close());

  it('AC1: nnc with no -c or --script starts the prompt with no session open', async () => {
    const before = f.server.authAttempts.length;
    const r = await runNnc(['-i'], { home: f.home, stdin: 'status\n' });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('nnc> not connected\nnnc> ');
    expect(f.server.authAttempts.length).toBe(before);
  });

  it('AC2: nnc router1 starts the prompt connected; if the connection fails, it starts with no session and the failure shown', async () => {
    const ok = await runNnc(['router1', '-i'], { home: f.home, stdin: 'get-config running\n' });
    expect(ok.code).toBe(0);
    expect(ok.stdout).toMatch(/^connected to router1 [^\n]*\nnnc router1> <system/);

    f.home.knownHosts([]);
    try {
      const failed = await runNnc(['router1', '-i'], { home: f.home, stdin: 'status\n' });
      expect(failed.code).toBe(0);
      expect(failed.stderr).toContain('host key for 127.0.0.1');
      expect(failed.stdout).toBe('nnc> not connected\nnnc> ');
    } finally {
      await f.close();
      f = await scriptFixture();
    }
  });

  it("AC3: with standard input that isn't a terminal and no --script, nnc reads commands from it as --script - does", async () => {
    const stdin = `${RPC.ok}\nbogus\nget-config running\n`;
    const piped = await runNnc(['router1'], { home: f.home, stdin });
    const sent = sentNames(f);
    const script = await runNnc(['router1', '--script', '-'], { home: f.home, stdin });
    expect(piped.code).toBe(2);
    expect(piped).toEqual(script);
    expect(sent).toEqual(['ping']);
    expect(piped.stdout).toBe('ok\n');
    expect(piped.stderr).toContain('<stdin>:2: unknown command: bogus');
  });

  it('AC4: nnc --help prints usage, the options and the exit codes; nnc --version prints the CLI and library versions', async () => {
    const help = await runNnc(['--help'], { home: f.home });
    expect(help.code).toBe(0);
    expect(help.stdout).toMatch(/^usage: nnc /);
    for (const option of ['--read-only', '--framed, --raw', '-c, --command', '-s, --script <file|->', '-i, --interactive', '-t, --targets <path>', '-C, --config <path>', '-V, --version', '-h, --help']) {
      expect(help.stdout).toContain(`  ${option}`);
    }
    expect(help.stdout).toContain('Exit codes:');
    const version = await runNnc(['--version'], { home: f.home });
    const cli = require('../package.json') as { version: string };
    const lib = require('@node-net/netconf/package.json') as { version: string };
    expect(version.stdout).toBe(`nnc ${cli.version} (@node-net/netconf ${lib.version})\n`);
  });

  it("AC5: nnc -i starts the prompt even when standard input isn't a terminal", async () => {
    const r = await runNnc(['router1', '--interactive'], { home: f.home, stdin: `bogus\n${RPC.ok}\n` });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('nnc router1> ');
    expect(sentNames(f)).toEqual(['ping']);
    const both = await runNnc(['-i', '-c', 'status'], { home: f.home });
    expect(both.code).toBe(2);
    expect(both.stderr).toContain("-i starts the prompt; it can't be used with -c");
  });
});
