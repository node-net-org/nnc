/**
 * SCRIPT-03: Keep results separate from messages and traces.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseXml } from '@node-net/netconf';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Fixture } from './support/fixture.js';
import { runNnc } from './support/nnc.js';
import { RPC, scriptFixture } from './support/script.js';

const CONFIG_XML = '<system xmlns="urn:example:lab">\n  <hostname>router1</hostname>\n</system>\n';

describe('SCRIPT-03 standard output and standard error', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await scriptFixture();
  });
  afterAll(() => f.close());

  it('AC1: command results go to standard output', async () => {
    const r = await runNnc(['router1', '-c', 'get-config running', '-c', RPC.ok, '-c', 'status'], { home: f.home });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(CONFIG_XML);
    expect(r.stdout).toMatch(/^ok$/m);
    expect(r.stdout).toMatch(/^target\s+router1$/m);
    expect(r.stderr).not.toContain('<hostname>');
  });

  it('AC2: errors, warnings, notifications, connect and disconnect messages and traces go to standard error', async () => {
    f.home.knownHosts([]);
    f.home.targets({ insecure: f.target({ hostKey: 'insecure-accept-any', timeouts: { rpc: 500 } }) });
    try {
      const script = f.home.file(
        'noisy.nnc',
        ['connect insecure', RPC.notify, 'trace xml', 'get-config running', RPC.warn, 'set on-error continue', RPC.fail, 'disconnect'].join('\n'),
      );
      const r = await runNnc(['--script', script], { home: f.home });
      expect(r.code).toBe(1);
      expect(r.stdout).toBe(`ok\ntrace: xml · redaction on\n${CONFIG_XML}ok\n`);
      expect(r.stderr).toContain('notification 1 · 2026-11-07T10:00:00Z · link-down');
      expect(r.stderr).toContain('warning: the host key of 127.0.0.1');
      expect(r.stderr).toMatch(/^connected to insecure /m);
      expect(r.stderr).toContain('<get-config>');
      expect(r.stderr).toContain('warning: operation-failed\n  type      application\n  severity  warning\n  message   careful\n');
      expect(r.stderr).toContain('rpc-error: operation-failed\n  type      application\n  severity  error\n  message   nope\n');
      expect(r.stderr).toMatch(/^disconnected from insecure$/m);
    } finally {
      await f.close();
      f = await scriptFixture();
    }
  });

  it("AC3: nnc router1 -c 'get-config running' > running.xml writes only the configuration XML", async () => {
    const r = await runNnc(['router1', '-c', 'get-config running'], { home: f.home });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(CONFIG_XML);
    expect(parseXml(r.stdout).name).toBe('system');
    // The command language's own redirection gives the same file.
    const own = await runNnc(['router1', '-c', 'get-config running > running.xml'], { home: f.home });
    expect(own.stdout).toBe('');
    expect(readFileSync(join(f.home.dir, 'running.xml'), 'utf8')).toBe(CONFIG_XML);
  });

  it("AC4: nnc router1 -c 'get-config running --json' | jq . sees only the JSON", async () => {
    const r = await runNnc(['router1', '-c', 'get-config running --json'], { home: f.home });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ 'lab:system': { hostname: 'router1' } });
  });
});
