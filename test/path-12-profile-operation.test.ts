/**
 * PATH-12: See a profile operation's full definition without running it (profile <operation>).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CapabilitySet, type OperationDescriptor } from '@node-net/netconf';
import { Cli, type CliIo } from '../src/cli.js';
import { createRegistry } from '../src/commands/index.js';
import { createNodeHost } from '../src/node/host.js';
import { completer } from '../src/repl.js';
import type { ActiveSession } from '../src/sessions/active.js';
import { runNnc } from './support/nnc.js';
import { HAS_PTY, plain, runPty } from './support/pty.js';
import { pathFixture, type PathFixture } from './support/path.js';

/** A Cli whose session has a profile with these operations, for what nnc can't load from a file. */
function cliWith(profile: object, list: readonly OperationDescriptor[]): Cli {
  const io: CliIo = { out: () => undefined, err: () => undefined, notice: () => undefined, secret: () => Promise.resolve(undefined) };
  const cli = new Cli(createRegistry(), io, { host: createNodeHost() });
  cli.session = {
    kind: 'client',
    name: 'lab1',
    readOnly: false,
    client: { ops: { list }, profile, content: { namedPathTemplate: () => undefined }, session: { serverCapabilities: new CapabilitySet([]) } },
  } as unknown as ActiveSession;
  return cli;
}

describe('PATH-12 profile <operation>', () => {
  let f: PathFixture;
  beforeAll(async () => {
    f = await pathFixture();
  });
  afterAll(() => f.close());

  it('AC1: shows the name and profile, description, whether it changes state, parameters, the request as written, how the result is read, and how to run it', async () => {
    const r = await runNnc(['lab1', '-c', 'profile show'], { home: f.home });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(
      [
        'operation  show  (profile lab-test)',
        'about      Run a show command',
        'changes    no',
        'params     --command <string>',
        'request    <show xmlns="urn:example:lab"><command>{{command}}</command></show>',
        'result     output, as text',
        'run with   device show --command <string>',
        '',
      ].join('\n'),
    );
    // An operation that doesn't say whether it changes state counts as a change; no result rule means the whole reply.
    const reboot = await runNnc(['lab1', '-c', 'profile reboot'], { home: f.home });
    expect(reboot.stdout).toMatch(/^changes {4}counted as yes \(the profile doesn't say, so it is treated as a change\)$/m);
    expect(reboot.stdout).toMatch(/^params {5}\(none\)$/m);
    expect(reboot.stdout).toMatch(/^result {5}the whole reply$/m);
    expect(reboot.stdout).toMatch(/^run with {3}device reboot$/m);
  });

  it('AC2: --json gives the same, with the definition as the profile states it', async () => {
    const r = await runNnc(['lab1', '-c', 'profile show --json'], { home: f.home });
    expect(JSON.parse(r.stdout)).toEqual({
      name: 'show',
      profile: 'lab-test',
      description: 'Run a show command',
      mutates: false,
      params: [{ name: 'command', type: 'string', required: true }],
      definition: {
        description: 'Run a show command',
        mutates: false,
        params: { command: 'string' },
        request: '<show xmlns="urn:example:lab"><command>{{command}}</command></show>',
        result: { path: 'output', as: 'text' },
      },
    });
    // reboot leaves mutates out, and the definition says so; the descriptor counts it as a change.
    const reboot = JSON.parse((await runNnc(['lab1', '-c', 'profile reboot --json'], { home: f.home })).stdout) as { mutates: boolean; definition: object };
    expect(reboot.mutates).toBe(true);
    expect(reboot.definition).not.toHaveProperty('mutates');
  });

  it('AC3: a profile written in code shows what is known and says the request is defined in code', async () => {
    const descriptor = {
      name: 'restart',
      namespace: 'urn:x',
      method: 'call',
      description: 'Restart a process',
      mutates: true,
      requires: [],
      params: [{ name: 'process', type: 'string', required: true, description: '' }],
      device: 'in-code',
    } as unknown as OperationDescriptor;
    const cli = cliWith({ id: 'in-code' }, [descriptor]);
    const r = await profileRun(cli, ['restart']);
    expect(r).toBe(
      [
        'operation  restart  (profile in-code)',
        'about      Restart a process',
        'changes    yes',
        'params     --process <string>',
        'request    (defined in code)',
        'run with   device restart --process <string>',
      ].join('\n'),
    );
    expect(JSON.parse(await profileRun(cli, ['restart'], true))).toMatchObject({ name: 'restart', profile: 'in-code', mutates: true, definition: null });
    // And the profile view's --json says it has no definition.
    expect(JSON.parse(await profileRun(cli, [], true))).toMatchObject({ profile: 'in-code', definition: null });
  });

  it("AC4: an unknown operation fails listing the profile's operations; with no profile, it says none is in use", async () => {
    const unknown = await runNnc(['lab1', '-c', 'profile restart'], { home: f.home });
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain(`profile: profile lab-test has no operation "restart" (the profile's operations: show, reboot)`);
    const none = await runNnc(['plain1', '-c', 'profile show'], { home: f.home });
    expect(none.code).toBe(2);
    expect(none.stderr).toContain('profile show: no device profile is in use in this session, so it has no operations');
    // It takes no operation parameters.
    const extra = await runNnc(['lab1', '-c', 'profile show --command x'], { home: f.home });
    expect(extra.code).toBe(2);
    expect(f.rpcsSent()).toBe(0);
  });

  it('AC5: sends nothing, and works on read-only targets, for operations that change state too', async () => {
    const r = await runNnc(['router1', '-c', 'profile reboot', '-c', 'profile show --json'], { home: f.home });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^operation {2}reboot {2}\(profile lab-test\)$/m);
    expect(f.rpcsSent()).toBe(0);
  });

  it('AC6: Tab completes operation names after profile (and after device)', () => {
    const show = { name: 'show', device: 'lab-test', params: [], requires: [] } as unknown as OperationDescriptor;
    const reboot = { name: 'reboot', device: 'lab-test', params: [], requires: [] } as unknown as OperationDescriptor;
    const base = { name: 'get', params: [], requires: [] } as unknown as OperationDescriptor;
    const complete = completer(cliWith({ id: 'lab-test' }, [base, show, reboot]));
    expect(complete('profile s')[0]).toEqual(['show ']);
    expect(complete('profile ')[0]).toEqual(expect.arrayContaining(['show', 'reboot']));
    expect(complete('profile ')[0]).not.toContain('get');
    expect(complete('device re')[0]).toEqual(['reboot ']);
  });

  it.skipIf(!HAS_PTY)('AC6: at the prompt, Tab completes profile and device operation names', async () => {
    const typing = (text: string) => [
      { wait: /nnc lab1> $/ },
      ...[...text].map((c) => ({ pause: 20, send: c })),
      { pause: 100, send: '\t' },
      { pause: 300, send: '\u0015exit\r' },
    ];
    expect(plain(await runPty(['lab1'], typing('profile reb'), { home: f.home }))).toContain('profile reboot');
    expect(plain(await runPty(['lab1'], typing('device sh'), { home: f.home }))).toContain('device show');
  });
});

/** Run `profile` directly, returning its text. */
async function profileRun(cli: Cli, positional: string[], json = false): Promise<string> {
  const cmd = cli.registry.get('profile')!;
  const result = await cmd.run(cli, { positional, options: json ? { json: true } : {} }, new AbortController().signal);
  return (result as { text: string }).text;
}
