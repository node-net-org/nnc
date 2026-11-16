/**
 * OPS-10: Discover the operations this device supports.
 * OPS-12: See argument mistakes before anything is sent.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CapabilitySet, NETCONF_NS } from '@node-net/netconf';
import { Cli, type CliIo } from '../src/cli.js';
import { createRegistry } from '../src/commands/index.js';
import { createNodeHost } from '../src/node/host.js';
import { completer } from '../src/repl.js';
import type { ActiveSession } from '../src/sessions/active.js';
import { BASE10, BASE11, FULL, LAB_MODULE } from './support/caps.js';
import { fixture, type Fixture } from './support/fixture.js';
import { runNnc } from './support/nnc.js';
import { sentEntries } from './support/trace.js';

/** A Cli whose session is on a device with the given capabilities (for completion, which runs in-process). */
async function cliOn(capabilities: readonly string[]): Promise<Cli> {
  const { BASE_OPERATIONS } = await import('@node-net/netconf');
  const io: CliIo = { out: () => undefined, err: () => undefined, notice: () => undefined, secret: () => Promise.resolve(undefined) };
  const cli = new Cli(createRegistry(), io, { host: createNodeHost() });
  cli.session = {
    kind: 'client',
    name: 'router1',
    readOnly: false,
    client: { ops: { list: BASE_OPERATIONS }, session: { serverCapabilities: new CapabilitySet(capabilities) } },
  } as unknown as ActiveSession;
  return cli;
}

describe('OPS-10 discovering operations', () => {
  let bare: Fixture;
  beforeAll(async () => {
    bare = await fixture({ fake: { capabilities: [BASE10, BASE11, LAB_MODULE] } });
  });
  afterAll(() => bare.close());

  it('AC1: Tab on an empty prompt offers every operation the device supports', async () => {
    const [offered] = completer(await cliOn(FULL))('');
    for (const op of ['get', 'get-config', 'edit-config', 'copy-config', 'delete-config', 'lock', 'unlock', 'validate', 'commit', 'cancel-commit', 'discard-changes', 'kill-session']) {
      expect(offered, op).toContain(op);
    }
    expect(offered).toContain('status');
    expect(offered).not.toContain('close-session');
  });

  it('AC2: operations whose capabilities are missing are not offered', async () => {
    const [offered] = completer(await cliOn([BASE10, BASE11]))('');
    expect(offered).toContain('get-config');
    expect(offered).not.toContain('commit');
    expect(offered).not.toContain('discard-changes');
    expect(offered).not.toContain('validate');
  });

  it('AC3: help lists unavailable operations separately, each with the capability it needs', async () => {
    const r = await runNnc(['router1', '-c', 'help'], { home: bare.home });
    const [available, unavailable] = r.stdout.split('not available on router1 (missing capabilities)');
    expect(available).toMatch(/^\s+get-config\s/m);
    expect(unavailable).toMatch(/^\s+commit \*\s+needs :candidate$/m);
    expect(unavailable).toMatch(/^\s+validate\s+needs :validate$/m);
    expect(unavailable).not.toMatch(/^\s+get-config\s/m);
  });

  it('AC4: Tab after an operation offers its options and fixed argument values', async () => {
    const cli = await cliOn(FULL);
    const complete = completer(cli);
    expect(complete('get-config ')[0]).toEqual(expect.arrayContaining(['running', 'candidate', 'startup', '--filter']));
    expect(complete('edit-config candidate --')[0]).toEqual(
      expect.arrayContaining(['--url', '--default-operation', '--test-option', '--error-option']),
    );
    expect(complete('edit-config candidate --default-operation ')[0]).toEqual(['merge', 'replace', 'none']);
    expect(complete('get-config running --filter ')[0]).toEqual(['subtree', 'xpath']);
  });

  it('AC5: help get-config shows description, arguments and options with types and values, capabilities and whether it changes state', async () => {
    const r = await runNnc(['router1', '-c', 'help get-config', '-c', 'help commit'], { home: bare.home });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('usage: get-config [<source>] [options]');
    expect(r.stdout).toContain('Read configuration from a datastore');
    expect(r.stdout).toMatch(/<source>\s+The datastore to read \(datastore; one of running, candidate, startup; default running\)/);
    expect(r.stdout).toMatch(/--filter\s+Select part of the data.* \(filter\)/);
    expect(r.stdout).toMatch(/changes state: no/);
    expect(r.stdout).toContain('capabilities: :candidate');
    expect(r.stdout).toContain("not available on router1: it doesn't advertise :candidate");
    expect(r.stdout).toMatch(/changes state: yes/);
    // Also without a session, from the base descriptors.
    const offline = await runNnc(['-c', 'help lock'], { home: bare.home });
    expect(offline.stdout).toContain('Lock a datastore');
  });
});

describe('OPS-12 argument mistakes are caught before sending', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await fixture({ fake: { capabilities: FULL } });
  });
  afterAll(() => f.close());

  const refused = async (line: string, message: string | RegExp): Promise<void> => {
    const r = await runNnc(['router1', '-c', line], { home: f.home });
    expect(r.code, line).toBe(2);
    if (typeof message === 'string') expect(r.stderr, line).toContain(message);
    else expect(r.stderr, line).toMatch(message);
    expect(f.rpcsSent(), line).toBe(0);
  };

  it('AC1: a missing required argument fails naming it', async () => {
    await refused('lock', 'lock: missing <target>');
    await refused('kill-session', 'kill-session: missing <session-id>');
  });

  it('AC2: an unknown option fails naming it and suggesting the closest valid one', async () => {
    await refused(`get-config running --filtr subtree <a xmlns="urn:x"/>`, 'get-config: unknown option --filtr (did you mean --filter?)');
    await refused('commit --confrimed', 'commit: unknown option --confrimed (did you mean --confirmed?)');
  });

  it('AC3: a value of the wrong type fails naming the argument and the expected type', async () => {
    await refused('kill-session abc', 'kill-session: <session-id> must be a number, not "abc"');
    await refused('commit --confirmed --confirm-timeout soon', 'commit: --confirm-timeout must be a number, not "soon"');
  });

  it('AC4: a value outside a fixed set fails listing the allowed values', async () => {
    await refused('lock scratch', 'lock: <target> can\'t be "scratch"; allowed: running, candidate, startup');
    await refused('get-config running --filter regex x', 'get-config: --filter must start with subtree or xpath, not "regex"');
  });

  it('AC5: none of these failures sends anything; a byte trace shows no outgoing bytes', async () => {
    for (const line of ['lock', 'get-config running --filtr subtree <a/>', 'kill-session abc', 'lock scratch']) {
      const r = await runNnc(['router1', '-c', 'trace bytes', '-c', line], { home: f.home });
      expect(r.code, line).toBe(2);
      expect(sentEntries(r.stderr), line).toEqual([]);
    }
    // The trace is really on: a valid command shows its outgoing bytes.
    const control = await runNnc(['router1', '-c', 'trace bytes', '-c', 'lock candidate'], { home: f.home });
    expect(control.code).toBe(0);
    expect(sentEntries(control.stderr).length).toBeGreaterThan(0);
  });

  it('is not specific to one session: unknown words still say "unknown command"', async () => {
    const r = await runNnc(['router1', '-c', 'get-confgi running'], { home: f.home });
    expect(r.stderr).toContain('unknown command: get-confgi');
    const offline = await runNnc(['-c', 'get-config running'], { home: f.home });
    expect(offline.stderr).toBe('not connected\n');
    expect(NETCONF_NS).toBeTruthy();
  });
});
