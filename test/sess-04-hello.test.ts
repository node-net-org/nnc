/**
 * SESS-04: View the server's hello.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixture, type Fixture } from './support/fixture.js';
import { runNnc } from './support/nnc.js';

// Odd but valid spacing, so "exactly as received" is visible.
const HELLO =
  '<?xml version="1.0" encoding="UTF-8"?>\n<hello xmlns="urn:ietf:params:xml:ns:netconf:base:1.0">' +
  '<capabilities>  <capability>urn:ietf:params:netconf:base:1.1</capability>\n' +
  '<capability>urn:ietf:params:netconf:base:1.0</capability></capabilities><session-id>9</session-id></hello>';

// The fake server, like most devices, ends a hello with a newline before ]]>]]>; it is part of what was received.
const RECEIVED = `${HELLO}\n`;

describe('SESS-04 hello', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await fixture({ fake: { hello: HELLO, sessionId: 9 } });
  });
  afterAll(() => f.close());

  it('AC1: hello prints the server hello as pretty-printed XML', async () => {
    const r = await runNnc(['router1', '-c', 'hello'], { home: f.home });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(
      [
        '<hello xmlns="urn:ietf:params:xml:ns:netconf:base:1.0">',
        '  <capabilities>',
        '    <capability>urn:ietf:params:netconf:base:1.1</capability>',
        '    <capability>urn:ietf:params:netconf:base:1.0</capability>',
        '  </capabilities>',
        '  <session-id>9</session-id>',
        '</hello>',
        '',
      ].join('\n'),
    );
  });

  it('AC2: hello --raw prints the message exactly as received', async () => {
    const r = await runNnc(['router1', '-c', 'hello --raw'], { home: f.home });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(RECEIVED);
  });

  it('AC3: hello --raw > hello.xml writes the received message unchanged', async () => {
    const r = await runNnc(['router1', '-c', 'hello --raw > hello.xml'], { home: f.home });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(readFileSync(join(f.home.dir, 'hello.xml'), 'utf8')).toBe(RECEIVED);
  });

  it('AC4: hello sends nothing to the device', async () => {
    await runNnc(['router1', '-c', 'hello', '-c', 'hello --raw'], { home: f.home });
    expect(f.rpcsSent()).toBe(0);
  });

  it('AC5: hello with no session open fails with "not connected"', async () => {
    const r = await runNnc(['-c', 'hello'], { home: f.home });
    expect(r.code).toBe(2);
    expect(r.stderr).toBe('not connected\n');
  });
});
