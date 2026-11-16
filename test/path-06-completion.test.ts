/**
 * PATH-06: Complete paths and named paths with Tab.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HAS_PTY, plain, runPty } from './support/pty.js';
import { pathFixture, type PathFixture } from './support/path.js';

const PROMPT = /nnc lab1> $/;
const TAB = '\t';

/** Type `text` key by key at the prompt, press Tab twice, then clear the line and exit. */
function completing(text: string): { wait?: RegExp; send?: string; pause?: number }[] {
  return [
    { wait: PROMPT },
    ...[...text].map((c) => ({ pause: 20, send: c })),
    { pause: 100, send: TAB },
    { pause: 200, send: TAB },
    { pause: 300, send: '\u0015exit\r' },
  ];
}

describe('PATH-06 completion', () => {
  let f: PathFixture;
  beforeAll(async () => {
    f = await pathFixture();
  });
  afterAll(() => f.close());

  it.skipIf(!HAS_PTY)('AC1: after read / (and value, set, remove, resolve), Tab offers the advertised modules, each followed by :', async () => {
    for (const cmd of ['read', 'value', 'set', 'remove', 'resolve']) {
      const out = plain(await runPty(['lab1'], completing(`${cmd} /`), { home: f.home }));
      expect(out, cmd).toContain('/ietf-interfaces:');
      expect(out, cmd).toContain('/lab:');
    }
    // A unique prefix completes in place.
    const one = plain(await runPty(['lab1'], completing('read /ietf'), { home: f.home }));
    expect(one).toContain('read /ietf-interfaces:');
  });

  it.skipIf(!HAS_PTY)("AC2: after @, Tab offers the profile's named paths", async () => {
    const out = plain(await runPty(['lab1'], completing('value @'), { home: f.home }));
    expect(out).toContain('@systemName');
    expect(out).toContain('@interfaces');
    const one = plain(await runPty(['lab1'], completing('read @sys'), { home: f.home }));
    expect(one).toContain('read @systemName');
  });

  it.skipIf(!HAS_PTY)('AC3: completion uses only the hello; it sends nothing', async () => {
    await runPty(['lab1'], completing('read /'), { home: f.home });
    expect(f.rpcsSent()).toBe(0);
  });
});
