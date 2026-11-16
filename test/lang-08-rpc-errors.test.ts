/**
 * LANG-08: Read rpc-errors and warnings clearly.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Fixture } from './support/fixture.js';
import { runNnc } from './support/nnc.js';
import { RPC, outputFixture } from './support/output.js';
import { HAS_PTY, plain, runPty } from './support/pty.js';

describe('LANG-08 rpc-errors and warnings', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await outputFixture();
  });
  afterAll(() => f.close());

  it('AC1: each rpc-error is a block with tag, type, severity, app tag, path, message and info; fields not sent are left out', async () => {
    const full = await runNnc(['router1', '-c', RPC.full], { home: f.home });
    expect(full.code).toBe(1);
    expect(full.stderr).toContain(
      'rpc-error: invalid-value\n  type      application\n  severity  error\n  app-tag   too-big\n  path      /lab:system/lab:mtu\n  message   MTU out of range\n  info      bad-element mtu\n',
    );
    const sparse = await runNnc(['router1', '-c', RPC.fail], { home: f.home });
    expect(sparse.stderr).toContain('rpc-error: operation-failed\n  type      application\n  severity  error\n  message   nope\n');
    expect(sparse.stderr).not.toMatch(/app-tag|path|info/);
  });

  it('AC2: several rpc-errors each get their own numbered block', async () => {
    const r = await runNnc(['router1', '-c', RPC.two], { home: f.home });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(
      'rpc-error 1 of 2: lock-denied\n  type      protocol\n  severity  error\n  message   first\n' +
        'rpc-error 2 of 2: operation-failed\n  type      application\n  severity  error\n  message   second\n',
    );
  });

  it('AC3: messages are shown as sent, with control characters as escapes', async () => {
    const r = await runNnc(['router1', '-c', RPC.bell], { home: f.home });
    expect(r.stderr).toContain('  message   ring\\x7fring\\x9b2J\\ttab\n');
    expect(r.stderr).not.toMatch(/[\u007f-\u009f\t]/);
  });

  it.skipIf(!HAS_PTY)('AC4: a reply that succeeded with warnings shows the result first, then each warning marked warning', async () => {
    const out = plain(await runPty(['router1'], [{ wait: /nnc router1> $/, send: `${RPC.warn}\r` }, { wait: /nnc router1> $/, send: 'exit\r' }], { home: f.home }));
    const result = out.indexOf('\nok\n');
    const warning = out.indexOf('warning: operation-failed\n  type      application\n  severity  warning\n  message   careful\n');
    expect(result).toBeGreaterThan(-1);
    expect(warning).toBeGreaterThan(result);
    const piped = await runNnc(['router1', '-c', RPC.warn], { home: f.home });
    expect(piped.code).toBe(0);
    expect(piped.stdout).toBe('ok\n');
  });

  it('AC5: show-last --raw shows the full reply XML for the last error', async () => {
    const r = await runNnc(['router1', '-c', 'set on-error continue', '-c', RPC.two, '-c', 'show-last --raw', '-c', 'show-last'], { home: f.home });
    expect(r.stdout).toMatch(/^(<\?xml[^>]*\?>)?<rpc-reply [^>]*message-id="1"><rpc-error><error-type>protocol<\/error-type><error-tag>lock-denied<\/error-tag>.*<\/rpc-reply>\n$/);
    // show-last without --raw shows the blocks again, on standard error.
    expect(r.stderr.split('rpc-error 1 of 2: lock-denied')).toHaveLength(3);
  });

  it('AC6: errors and warnings go to standard error; results to standard output', async () => {
    const r = await runNnc(['router1', '-c', 'set on-error continue', '-c', RPC.warn, '-c', RPC.fail, '-c', 'get-config running'], { home: f.home });
    expect(r.stdout).toBe('ok\n<system xmlns="urn:example:lab">\n  <hostname>router1</hostname>\n</system>\n');
    expect(r.stderr).toContain('warning: operation-failed');
    expect(r.stderr).toContain('rpc-error: operation-failed');
  });
});
