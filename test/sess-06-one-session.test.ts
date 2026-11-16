/**
 * SESS-06: Work with one session at a time, of a kind fixed when connecting.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRegistry } from '../src/commands/index.js';
import { fixture, type Fixture } from './support/fixture.js';
import { runNnc } from './support/nnc.js';

describe('SESS-06 one session, kind fixed at connect', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await fixture();
    f.home.targets({ router1: f.target(), lab1: f.target() });
  });
  afterAll(() => f.close());

  it('AC1: connect while a session is open fails, naming it and saying to disconnect; the session is unaffected', async () => {
    const r = await runNnc(['-i'], { home: f.home, stdin: 'connect router1\nconnect lab1\nstatus\n' });
    expect(r.stderr).toContain('already connected to router1 (client session); disconnect first');
    expect(r.stdout).toMatch(/target\s+router1$/m);
    expect(f.server.authAttempts.filter((a) => a === 'password:admin')).toHaveLength(1);
  });

  it('AC2: a client session stays a client session; nothing switches it to framed or raw', async () => {
    const r = await runNnc(['-i'], { home: f.home, stdin: 'connect router1\nconnect router1 --framed\nconnect router1 --raw\nstatus\n' });
    expect(r.stderr.match(/already connected to router1/g)).toHaveLength(2);
    expect(r.stdout).toMatch(/^kind\s+client$/m);
    const names = createRegistry().names();
    expect(names.filter((n) => /framed|raw|switch/.test(n))).toEqual([]);
  });

  it('AC3: a command of another session kind fails, naming the kinds that offer it, and nothing is sent', async () => {
    const client = await runNnc(['router1', '-c', 'send <hello/>'], { home: f.home });
    expect(client.code).toBe(2);
    expect(client.stderr).toContain('send is available in framed and raw sessions, not in this client session; nothing was sent');
    expect(f.rpcsSent()).toBe(0);

    const raw = await runNnc(['router1', '--raw', '--script', '-'], { home: f.home, stdin: 'set on-error continue\nget-config running\nframing chunked\nhello\n' });
    expect(raw.stderr).toContain('get-config is available in client sessions, not in this raw session; nothing was sent');
    expect(raw.stderr).toContain('framing is available in framed sessions, not in this raw session; nothing was sent');
    expect(raw.stderr).toContain('hello is available in client and framed sessions, not in this raw session; nothing was sent');
    expect(f.server.lastBytes().length).toBe(0);

    const framed = await runNnc(['router1', '--framed', '-c', 'eof'], { home: f.home });
    expect(framed.stderr).toContain('eof is available in raw sessions, not in this framed session; nothing was sent');
    expect(f.server.lastBytes().length).toBe(0);
  });

  it('AC4: help lists only the commands available in the current session kind', async () => {
    const none = await runNnc(['-c', 'help'], { home: f.home });
    expect(none.stdout).toContain('commands with no session open:');
    expect(none.stdout).not.toMatch(/^\s+hello\s/m);
    expect(none.stdout).not.toMatch(/^\s+capabilities\s/m);
    const client = await runNnc(['router1', '-c', 'help'], { home: f.home });
    expect(client.stdout).toContain('commands in a client session:');
    expect(client.stdout).toMatch(/^\s+hello\s/m);
    expect(client.stdout).toMatch(/^\s+capabilities\s/m);
    // Commands shared by kinds are described as they act in this one.
    const framed = await runNnc(['router1', '--framed', '-c', 'help', '-c', 'help send'], { home: f.home });
    expect(framed.stdout).toContain('commands in a framed session:');
    expect(framed.stdout).toMatch(/^\s+send\s+Send a message exactly as written, framed in the current framing/m);
    expect(framed.stdout).toMatch(/^\s+hello\s+Send a client <hello>/m);
    expect(framed.stdout).not.toMatch(/^\s+(capabilities|get-config|send-hex)\s/m);
    expect(framed.stdout).toContain('(in raw sessions: Write the rest of the line as UTF-8 bytes');
    const raw = await runNnc(['router1', '--raw', '-c', 'help', '-c', 'help send'], { home: f.home });
    expect(raw.stdout).toContain('commands in a raw session:');
    expect(raw.stdout).toMatch(/^\s+send\s+Write the rest of the line as UTF-8 bytes/m);
    expect(raw.stdout).toMatch(/^\s+output\s+Show received bytes as text or as a hex dump/m);
    expect(raw.stdout).toContain('In this raw session the rest of the line is taken exactly as typed');
    expect(raw.stdout).not.toMatch(/^\s+(hello|framing|show)\s/m);
  });
});
