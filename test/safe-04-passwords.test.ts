/**
 * SAFE-04: Supply passwords without exposing them.
 */
import { readFileSync } from 'node:fs';
import { utils } from 'ssh2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRegistry } from '../src/commands/index.js';
import { startAgent, type TestAgent } from './support/agent.js';
import { fixture, type Fixture } from './support/fixture.js';
import { runNnc } from './support/nnc.js';
import { generateKey } from './support/ssh-server.js';

const PASSWORD = 's3cret-Pa55';

describe('SAFE-04 password sources', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await fixture({ password: PASSWORD });
  });
  afterAll(() => f.close());

  it('AC1: { file } reads the password from that file, with surrounding whitespace removed', async () => {
    const path = f.home.file('padded.pass', `  ${PASSWORD} \n\n`);
    f.home.targets({ router1: f.target({ password: { file: path } }) });
    const r = await runNnc(['-c', 'connect router1'], { home: f.home });
    expect(r.code).toBe(0);
    const tilde = f.home.file('tilde.pass', PASSWORD);
    f.home.targets({ router1: f.target({ password: { file: '~/tilde.pass' } }) });
    expect(tilde).toContain(f.home.dir);
    expect((await runNnc(['-c', 'connect router1'], { home: f.home })).code).toBe(0);
  });

  it('AC2: { env } reads it from that variable; an unset variable fails naming it', async () => {
    f.home.targets({ router1: f.target({ password: { env: 'ROUTER1_PASSWORD' } }) });
    const ok = await runNnc(['-c', 'connect router1'], { home: f.home, env: { ROUTER1_PASSWORD: PASSWORD } });
    expect(ok.code).toBe(0);
    const unset = await runNnc(['-c', 'connect router1'], { home: f.home });
    expect(unset.code).toBe(3);
    expect(unset.stderr).toContain('$ROUTER1_PASSWORD, which is not set');
  });

  it('AC3: { prompt: true }, or no source and no usable agent key, prompts for the password', async () => {
    f.home.targets({ router1: f.target({ password: { prompt: true } }) });
    const explicit = await runNnc(['-c', 'connect router1'], { home: f.home, stdin: `${PASSWORD}\n` });
    expect(explicit.code).toBe(0);
    expect(explicit.stderr).toMatch(/^Password for admin@127\.0\.0\.1: connected to router1 /);
    expect(explicit.stderr).not.toContain(PASSWORD);

    const noSource = { ...(f.target() as Record<string, unknown>) };
    delete noSource['password'];
    f.home.targets({ router1: noSource });
    const implicit = await runNnc(['-c', 'connect router1'], { home: f.home, stdin: `${PASSWORD}\n` });
    expect(implicit.code).toBe(0);
    expect(implicit.stderr).toMatch(/^Password for admin@127\.0\.0\.1: connected to router1 /);
  });

  it('AC4: a password written as a string in the targets file is rejected', async () => {
    f.home.targets({ router1: f.target({ password: PASSWORD }) });
    const r = await runNnc(['-c', 'connect router1'], { home: f.home });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('field "password" must not hold a password itself: use { "file": path }, { "env": variable } or { "prompt": true }');
    expect(r.stderr).not.toContain(PASSWORD);
  });

  it('AC5: no command accepts a password as an argument', async () => {
    const registry = createRegistry();
    for (const name of registry.names()) {
      const cmd = registry.get(name)!;
      expect(Object.keys(cmd.options).filter((o) => /pass|secret/i.test(o))).toEqual([]);
      expect(cmd.args.filter((a) => /pass|secret/i.test(a.name))).toEqual([]);
    }
    f.home.targets({ router1: f.target() });
    const r = await runNnc(['-c', `connect router1 --password ${PASSWORD}`], { home: f.home });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('connect: unknown option --password');
  });

  it('AC6: passwords never appear in history, error messages or status output', async () => {
    f.home.targets({ router1: f.target({ password: { prompt: true } }) });
    const r = await runNnc(['-i'], { home: f.home, stdin: `connect router1\n${PASSWORD}\nstatus\nhello\n` });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/read-only\s+no/);
    expect(r.stdout + r.stderr).not.toContain(PASSWORD);
    const history = readFileSync(f.home.historyFile, 'utf8');
    expect(history).toContain('connect router1');
    expect(history).not.toContain(PASSWORD);

    const wrong = await runNnc(['-c', 'connect router1'], { home: f.home, stdin: 'wrong-guess-123\n' });
    expect(wrong.code).toBe(3);
    expect(wrong.stdout + wrong.stderr).not.toContain('wrong-guess-123');
    f.home.targets({ router1: f.target() });
  });
});

describe('SAFE-04 the SSH agent alongside a password', () => {
  const key = generateKey();
  let f: Fixture;
  let agent: TestAgent;
  beforeAll(async () => {
    // The server accepts the agent's key, so any key offered would log in.
    f = await fixture({ password: PASSWORD, clientPublicKey: key.public });
    agent = await startAgent(f.home.dir, key.private);
  });
  afterAll(async () => {
    await agent.close();
    await f.close();
  });

  /** Run `connect router1` with the agent running, and return the auth attempts it made. */
  const connectWithAgent = async (target: object, stdin?: string) => {
    f.home.targets({ router1: f.target(target) });
    const before = f.server.authAttempts.length;
    const r = await runNnc(['-c', 'connect router1'], { home: f.home, env: { SSH_AUTH_SOCK: agent.socket }, ...(stdin !== undefined ? { stdin } : {}) });
    return { r, attempts: f.server.authAttempts.slice(before).filter((a) => !a.startsWith('none')) };
  };

  it('a target with a password and no "agent" field offers no agent keys, so a wrong password is an authentication failure', async () => {
    const { r, attempts } = await connectWithAgent({ password: { prompt: true } }, 'wrong-guess-123\n');
    expect(r.code).toBe(3);
    expect(r.stderr).toContain(`authentication failed for user admin at 127.0.0.1:${f.server.port}`);
    expect(attempts).toEqual(['password:admin']);
  });

  it('"agent": true offers the agent\'s keys as well as the password', async () => {
    const signs = agent.signs();
    const { r, attempts } = await connectWithAgent({ password: { prompt: true }, agent: true }, 'wrong-guess-123\n');
    expect(r.code).toBe(0);
    expect(attempts).toContain('password:admin');
    expect(attempts).toContain('publickey:admin');
    expect(agent.signs()).toBeGreaterThan(signs);
  });

  it('with no password or key, the agent is used and no password is asked for', async () => {
    const signs = agent.signs();
    const { r, attempts } = await connectWithAgent({ password: undefined });
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain('Password for');
    expect(attempts).toContain('publickey:admin');
    expect(agent.signs()).toBeGreaterThan(signs);
  });
});

describe('SAFE-04 a private key passphrase', () => {
  // ecdsa: ssh2's ed25519 generation is occasionally unparseable (see generateKey()).
  const key = utils.generateKeyPairSync('ecdsa', { bits: 256, passphrase: 'right-phrase', cipher: 'aes256-ctr' });
  let f: Fixture;
  beforeAll(async () => {
    // The server also takes PASSWORD: a password prompt after a bad passphrase would log in.
    f = await fixture({ password: PASSWORD, clientPublicKey: key.public });
    f.home.file('lab-key', key.private);
  });
  afterAll(() => f.close());

  const keyTarget = (extra: object = {}) => ({ password: undefined, privateKey: '~/lab-key', passphrase: { prompt: true }, agent: false, ...extra });

  it('prompts "Passphrase for key <path>", naming the key as the target writes it', async () => {
    f.home.targets({ router1: f.target(keyTarget()) });
    const r = await runNnc(['-c', 'connect router1'], { home: f.home, stdin: 'right-phrase\n' });
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/^Passphrase for key ~\/lab-key: connected to router1 /);
    expect(r.stderr).not.toContain('right-phrase');
  });

  it('a wrong passphrase names the key file, exits 3, and asks for no password', async () => {
    f.home.targets({ router1: f.target(keyTarget()) });
    const before = f.server.authAttempts.length;
    const r = await runNnc(['-c', 'connect router1'], { home: f.home, stdin: `wrong-phrase-123\n${PASSWORD}\n` });
    expect(r.code).toBe(3);
    expect(r.stderr).toBe('Passphrase for key ~/lab-key: the private key ~/lab-key could not be decrypted (wrong passphrase?)\n');
    expect(r.stderr).not.toContain('Password for');
    expect(r.stdout + r.stderr).not.toContain('wrong-phrase-123');
    expect(f.server.authAttempts.slice(before)).toEqual([]);
  });

  it('an encrypted key with no passphrase says so', async () => {
    const { passphrase: _p, ...noPassphrase } = keyTarget();
    f.home.targets({ router1: f.target(noPassphrase) });
    const r = await runNnc(['-c', 'connect router1'], { home: f.home, stdin: `${PASSWORD}\n` });
    expect(r.code).toBe(3);
    expect(r.stderr).toBe('the private key ~/lab-key is encrypted, but no passphrase was given\n');
  });

  it('a passphrase source names the key in its errors', async () => {
    f.home.targets({ router1: f.target(keyTarget({ passphrase: { env: 'LAB_KEY_PASSPHRASE' } })) });
    const r = await runNnc(['-c', 'connect router1'], { home: f.home });
    expect(r.code).toBe(3);
    expect(r.stderr).toBe('the passphrase for key ~/lab-key comes from $LAB_KEY_PASSPHRASE, which is not set\n');
    f.home.targets({ router1: f.target() });
  });
});
