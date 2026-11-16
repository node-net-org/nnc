/**
 * LANG-12: See from the prompt where I am and any unsafe settings.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Fixture } from './support/fixture.js';
import { runNnc } from './support/nnc.js';
import { outputFixture } from './support/output.js';
import { HAS_PTY, runPty } from './support/pty.js';
import { CAPS as PATH_CAPS, pathFixture } from './support/path.js';

describe('LANG-12 the prompt', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await outputFixture();
    f.home.knownHosts([]);
    f.home.targets({ router1: f.target(), ro: f.target({ readOnly: true }), lab: f.target({ hostKey: 'insecure-accept-any' }) });
    // router1 and ro need the host key; lab doesn't check it.
    const { knownHostsLine } = await import('./support/nnc.js');
    f.home.knownHosts([knownHostsLine(f.server.port, f.server.publicKeyLine)]);
  });
  afterAll(() => f.close());

  it('AC1: with no session the prompt is nnc>', async () => {
    const r = await runNnc(['-i'], { home: f.home, stdin: 'status\n' });
    expect(r.stdout).toBe('nnc> not connected\nnnc> ');
  });

  it('AC2: in a client session it is nnc router1>; framed and raw sessions show their kind and framing state', async () => {
    const r = await runNnc(['router1', '-i'], { home: f.home, stdin: 'status\n' });
    expect(r.stdout).toContain('\nnnc router1> ');
    const framed = await runNnc(['router1', '--framed', '-i'], { home: f.home, stdin: 'framing chunked\nstatus\n' });
    expect(framed.stdout).toContain('nnc router1 [framed eom]> ');
    expect(framed.stdout).toContain('nnc router1 [framed chunked]> ');
    const raw = await runNnc(['router1', '--raw', '-i'], { home: f.home, stdin: 'status\neof\nstatus\n' });
    expect(raw.stdout).toContain('nnc router1 [raw]> ');
    expect(raw.stdout).toContain('nnc router1 [raw eof]> ');
  });

  it('AC3: on a read-only target it adds [ro]', async () => {
    const r = await runNnc(['ro', '-i'], { home: f.home, stdin: 'status\n' });
    expect(r.stdout).toContain('\nnnc ro [ro]> ');
    const inline = await runNnc(['router1', '--read-only', '-i'], { home: f.home, stdin: 'status\n' });
    expect(inline.stdout).toContain('\nnnc router1 [ro]> ');
  });

  it('AC4: an unverified host key adds [insecure]; tracing without redaction adds [no-redact]', async () => {
    const r = await runNnc(['lab', '-i'], { home: f.home, stdin: 'trace --no-redact\nstatus\n' });
    expect(r.stdout).toContain('\nnnc lab [insecure]> ');
    expect(r.stdout).toContain('nnc lab [insecure] [no-redact]> ');
  });

  it('AC5: an open transaction adds [tx N]; a pending confirmed commit adds [confirm m:ss]', async () => {
    const lab = await pathFixture({ caps: [...PATH_CAPS, 'urn:ietf:params:netconf:capability:confirmed-commit:1.1'] });
    try {
      const r = await runNnc(['lab1', '-i'], { home: lab.home, stdin: 'begin\nset @systemName r2\napply --confirmed --confirm-timeout 90\nrevert\n' });
      expect(r.stdout).toContain('nnc lab1 [tx 0]> ');
      expect(r.stdout).toContain('nnc lab1 [tx 1]> ');
      expect(r.stdout).toMatch(/nnc lab1 \[confirm 1:(30|29)\]> /);
    } finally {
      await lab.close();
    }
  });

  it.skipIf(!HAS_PTY)('AC6: the markers are coloured on a terminal and plain text otherwise', async () => {
    const out = await runPty(['ro'], [{ wait: /nnc ro \[ro\]> $/, send: 'trace --no-redact\r' }, { wait: /\[no-redact\]> $/, send: 'exit\r' }], {
      home: f.home,
      env: { NO_COLOR: undefined },
    });
    expect(out).toContain('nnc ro \u001b[33m[ro]\u001b[0m> ');
    expect(out).toContain('\u001b[33m[ro]\u001b[0m \u001b[31m[no-redact]\u001b[0m> ');
    const framed = await runPty(['router1', '--framed'], [{ wait: /\[framed eom\]/, send: 'exit\r' }], { home: f.home, env: { NO_COLOR: undefined } });
    expect(framed).toContain('nnc router1 \u001b[36m[framed eom]\u001b[0m> ');
    const raw = await runPty(['router1', '--raw'], [{ wait: /\[raw\]/, send: 'exit\r' }], { home: f.home, env: { NO_COLOR: undefined } });
    expect(raw).toContain('nnc router1 \u001b[35m[raw]\u001b[0m> ');
    const piped = await runNnc(['ro', '-i'], { home: f.home, stdin: 'status\n', env: { NO_COLOR: undefined } });
    expect(piped.stdout).toContain('nnc ro [ro]> ');
    expect(piped.stdout).not.toContain('\u001b[');
  });
});
