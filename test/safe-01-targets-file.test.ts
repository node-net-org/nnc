/**
 * SAFE-01: Define devices as named targets in a targets file.
 */
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixture, type Fixture } from './support/fixture.js';
import { runNnc } from './support/nnc.js';

describe('SAFE-01 targets file', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await fixture();
  });
  afterAll(() => f.close());

  it('AC1: read from ~/.config/net-netconf/targets.json, else $NNC_TARGETS, and --targets wins over both', async () => {
    const envFile = f.home.file('env-targets.json', JSON.stringify({ fromenv: { host: 'router1' } }));
    const argFile = f.home.file('arg-targets.json', JSON.stringify({ fromarg: { host: 'router1' } }));

    const byDefault = await runNnc(['-c', 'targets'], { home: f.home });
    expect(byDefault.stdout).toContain(`targets in ${f.home.targetsFile}`);
    expect(byDefault.stdout).toMatch(/^router1\s/m);

    const byEnv = await runNnc(['-c', 'targets'], { home: f.home, env: { NNC_TARGETS: envFile } });
    expect(byEnv.stdout).toContain(`targets in ${envFile}`);
    expect(byEnv.stdout).toMatch(/^fromenv\s/m);

    const byArg = await runNnc(['--targets', argFile, '-c', 'targets'], { home: f.home, env: { NNC_TARGETS: envFile } });
    expect(byArg.stdout).toContain(`targets in ${argFile}`);
    expect(byArg.stdout).toMatch(/^fromarg\s/m);

    // -t, -C and --config are other names for --targets.
    for (const option of ['-t', '-C', '--config']) {
      const r = await runNnc([option, argFile, '-c', 'targets'], { home: f.home, env: { NNC_TARGETS: envFile } });
      expect(r.stdout).toContain(`targets in ${argFile}`);
    }
    const both = await runNnc(['--targets', argFile, '--config', envFile, '-c', 'targets'], { home: f.home });
    expect(both.code).toBe(2);
    expect(both.stderr).toContain('--config is another name for --targets; give one');
  });

  it('AC2: a target may set every documented field', async () => {
    const dir = f.profile({ id: 'lab-test', match: { anyModule: ['lab-mod'] } });
    const file = f.home.file(
      'full-targets.json',
      JSON.stringify({
        router1: f.target({
          hostKey: 'known-hosts',
          knownHosts: f.home.knownHostsFile,
          agent: false,
          profilesDir: dir,
          readOnly: true,
          allowRpcs: ['get-schema'],
          timeouts: { connect: 5000, hello: 5000, rpc: 5000, close: 1000 },
          jumpHost: { host: 'jump1', port: 22, username: 'lab1', password: { prompt: true }, privateKey: '~/.ssh/id_ed25519', agent: true, hostKey: 'known-hosts' },
        }),
        lab1: { host: 'lab1', profile: 'lab-test', privateKey: '~/.ssh/id_ed25519', passphrase: { env: 'KEY_PASSPHRASE' } },
      }),
    );
    const r = await runNnc(['--targets', file, '-c', 'targets'], { home: f.home });
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^lab1\s/m);
  });

  it('AC3: targets lists name, user@host:port, profile and read-only, without password details', async () => {
    f.home.targets({ router1: f.target({ readOnly: true, profile: 'nokia-7210-sas' }), lab1: { host: 'lab1', username: 'netconf', port: 2830 } });
    const r = await runNnc(['-c', 'targets'], { home: f.home });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`^router1\\s+admin@127\\.0\\.0\\.1:${f.server.port}\\s+nokia-7210-sas\\s+read-only$`, 'm'));
    expect(r.stdout).toMatch(/^lab1\s+netconf@lab1:2830\s+\(auto-detect\)$/m);
    expect(r.stdout).not.toContain(f.passwordFile);
    expect(r.stdout).not.toContain('password');
    f.home.targets({ router1: f.target() });
  });

  it('AC4: invalid JSON, an unknown field or a wrong type fails naming the file, target and field; nothing is attempted', async () => {
    const before = f.server.authAttempts.length;
    const bad = (content: string): string => f.home.file('bad-targets.json', content);

    const notJson = await runNnc(['--targets', bad('{ "router1": '), '-c', 'connect router1'], { home: f.home });
    expect(notJson.code).toBe(2);
    expect(notJson.stderr).toContain(`targets file ${join(f.home.dir, 'bad-targets.json')}: not valid JSON`);

    const unknown = await runNnc(['--targets', bad(JSON.stringify({ router1: f.target({ colour: 'red' }) })), '-c', 'connect router1'], { home: f.home });
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain('target "router1": field "colour" is not a known field');

    const wrongType = await runNnc(['--targets', bad(JSON.stringify({ router1: f.target({ port: '830' }) })), '-c', 'connect router1'], { home: f.home });
    expect(wrongType.code).toBe(2);
    expect(wrongType.stderr).toContain(`targets file ${join(f.home.dir, 'bad-targets.json')}: target "router1": field "port" must be a whole number`);

    const nested = await runNnc(
      ['--targets', bad(JSON.stringify({ router1: f.target({ jumpHost: { host: 'jump1', agent: 'yes' } }) })), '-c', 'connect router1'],
      { home: f.home },
    );
    expect(nested.stderr).toContain('target "router1": field "jumpHost.agent" must be true or false');
    expect(f.server.authAttempts.length).toBe(before);
  });

  it('AC7: a pinned hostKey is checked when the file is read: a malformed pin, an empty list, or knownHosts with a pin is refused', async () => {
    const before = f.server.authAttempts.length;
    const run = (extra: object) =>
      runNnc(['--targets', f.home.file('pin-targets.json', JSON.stringify({ router1: f.target(extra) })), '-c', 'connect router1'], { home: f.home });

    const malformed = await run({ hostKey: 'SHA256:short' });
    expect(malformed.code).toBe(2);
    expect(malformed.stderr).toContain(
      `target "router1": field "hostKey" must be "known-hosts", "insecure-accept-any", a SHA256: fingerprint or public key line, or a non-empty list of them: "SHA256:short" is neither`,
    );
    const inList = await run({ jumpHost: { host: 'jump1', hostKey: ['ssh-ed25519 not-base64!'] } });
    expect(inList.code).toBe(2);
    expect(inList.stderr).toContain('target "router1": field "jumpHost.hostKey" must be');
    const empty = await run({ hostKey: [] });
    expect(empty.code).toBe(2);
    expect(empty.stderr).toContain('target "router1": field "hostKey" must not be an empty list');
    const notString = await run({ hostKey: 42 });
    expect(notString.code).toBe(2);
    expect(notString.stderr).toContain('target "router1": field "hostKey" must be "known-hosts"');
    const both = await run({ hostKey: f.server.fingerprint, knownHosts: '~/.ssh/other_known_hosts' });
    expect(both.code).toBe(2);
    expect(both.stderr).toContain('target "router1": field "knownHosts" cannot be used with a pinned hostKey');
    expect(f.server.authAttempts.length).toBe(before);
  });

  it('AC5: a missing targets file is not an error: targets prints "(no targets)" and the file it looked for', async () => {
    const missing = join(f.home.dir, 'nowhere.json');
    const r = await runNnc(['--targets', missing, '-c', 'targets'], { home: f.home });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`(no targets) in ${missing} (file not found)\n`);
  });

  it('AC6: profilesDir makes the profiles in that directory available to the target', async () => {
    const dir = f.profile({ id: 'my-new-profile', match: { anyModule: ['never-advertised'] } });
    f.home.targets({ router1: f.target({ profilesDir: dir, profile: 'my-new-profile' }) });
    const r = await runNnc(['-c', 'connect router1'], { home: f.home });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('profile my-new-profile');
    f.home.targets({ router1: f.target({ profile: 'my-new-profile' }) });
    const without = await runNnc(['-c', 'connect router1'], { home: f.home });
    expect(without.code).toBe(2);
    expect(without.stderr).toContain('unknown profile "my-new-profile"');
    f.home.targets({ router1: f.target() });
  });
});
