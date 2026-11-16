/**
 * SESS-01: Connect to a named target and open a client session.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { knownHostsLine, makeHome, runNnc, type Home } from './support/nnc.js';
import { startSshServer, type TestSshServer } from './support/ssh-server.js';

const LAB_CAPS = [
  'urn:ietf:params:netconf:base:1.0',
  'urn:ietf:params:netconf:base:1.1',
  'urn:example:lab-mod?module=lab-mod&revision=2024-01-01',
];

const LAB_PROFILE = JSON.stringify({ id: 'lab-test', match: { anyModule: ['lab-mod'] } });

describe('SESS-01 connect to a named target', () => {
  let server: TestSshServer;
  let home: Home;

  beforeAll(async () => {
    server = await startSshServer({ fake: { sessionId: 57, capabilities: LAB_CAPS } });
    home = makeHome();
    home.knownHosts([knownHostsLine(server.port, server.publicKeyLine)]);
    const pw = home.file('router1.pass', 'secret\n');
    const profiles = `${home.dir}/profiles`;
    await import('node:fs').then((fs) => {
      fs.mkdirSync(profiles, { recursive: true });
      fs.writeFileSync(`${profiles}/lab-test.json`, LAB_PROFILE);
    });
    home.targets({
      router1: { host: '127.0.0.1', port: server.port, username: 'admin', password: { file: pw }, readOnly: true, profilesDir: profiles, profile: 'lab-test' },
      lab1: { host: '127.0.0.1', port: server.port, username: 'admin', password: { file: pw }, profilesDir: profiles },
      plain: { host: '127.0.0.1', port: server.port, username: 'admin', password: { file: pw } },
    });
  });
  afterAll(() => server.close());

  it('AC1: opens SSH to the target host, port and user and completes the hello exchange', async () => {
    const r = await runNnc(['router1', '-c', 'status'], { home });
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/^connected to router1 /);
    expect(server.authAttempts).toContain('password:admin');
    const hello = await server.last()!.clientHello;
    expect(hello.name).toBe('hello');
  });

  it('AC2: prints one line with target, host:port, session-id, base version, profile and read-only', async () => {
    const r = await runNnc(['-c', 'connect router1'], { home });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    const lines = r.stderr.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(`connected to router1 (127.0.0.1:${server.port}) · session-id 57 · base:1.1 · profile lab-test · read-only`);
  });

  it('AC3: the prompt changes from nnc> to nnc router1>', async () => {
    const r = await runNnc(['-i'], { home, stdin: 'connect router1\nstatus\n' });
    expect(r.code).toBe(0);
    expect(r.stdout.startsWith('nnc> ')).toBe(true);
    expect(r.stdout).toContain('nnc router1 [ro]> ');
  });

  it('AC4: a named profile is used; with none named, the profile is auto-detected and named', async () => {
    const detected = await runNnc(['-c', 'connect lab1'], { home });
    expect(detected.stderr).toContain('profile lab-test');
    const status = await runNnc(['lab1', '-c', 'status'], { home });
    expect(status.stdout).toMatch(/profile\s+lab-test \(detected\)/);
    const named = await runNnc(['router1', '-c', 'status'], { home });
    expect(named.stdout).toMatch(/profile\s+lab-test \(named by the target\)/);
    const none = await runNnc(['-c', 'connect plain'], { home });
    expect(none.code).toBe(0);
    expect(none.stderr).toContain('no profile matched');
  });

  it('AC5: an unknown name fails, naming the target and the file searched, and nothing is sent', async () => {
    const before = server.authAttempts.length;
    const r = await runNnc(['-c', 'connect router9'], { home });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('unknown target "router9"');
    expect(r.stderr).toContain(home.targetsFile);
    expect(server.authAttempts.length).toBe(before);
  });

  it('AC6: connect with no argument fails with a usage message', async () => {
    const r = await runNnc(['-c', 'connect'], { home });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('usage: connect <target>');
  });
});
