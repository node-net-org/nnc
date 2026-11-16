/**
 * TRACE-05: Keep secrets out of traces.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RpcHandler } from '@node-net/netconf/testing';
import { fixture, type Fixture } from './support/fixture.js';
import { runNnc } from './support/nnc.js';
import { chunked, entryHeads, reply, sendPieces } from './support/trace.js';

const SECRETS = ['hunter2', 'pr1vkey', 'publicx', 'psk-value', 'swordfish'];
const DATA =
  '<data><user><name>admin</name><password>hunter2</password></user>' +
  '<ssh><private-key>pr1vkey</private-key></ssh>' +
  '<snmp><community><name>publicx</name></community></snmp>' +
  '<ike><pre-shared-key><![CDATA[psk-value]]></pre-shared-key></ike></data>';

const handler: RpcHandler = (_rpc, ctx) => {
  const op = ctx.operation?.name;
  if (op === 'split') {
    // <password>swordfish</password>, split inside the tag name, and inside the value across a chunk header.
    const text = reply(ctx.messageId, '<data><password>swordfish</password></data>');
    const at = text.indexOf('swordfish');
    const parts = [text.slice(0, at - 6), text.slice(at - 6, at + 4), text.slice(at + 4)];
    const wire = chunked(parts);
    // Cut the wire inside the tag name "pass|word" and inside "sword|fish".
    const cut1 = wire.indexOf('<pass') + 5;
    const cut2 = wire.indexOf('fish') - 1;
    void sendPieces(ctx.server, [wire.slice(0, cut1), wire.slice(cut1, cut2), wire.slice(cut2)]);
    return undefined;
  }
  if (op === 'lose') {
    ctx.server.sendRaw('\n#5\n<rpc-');
    ctx.server.sendRaw('BROKEN<password>swordfish</password>');
    return undefined;
  }
  return 'ok';
};

describe('TRACE-05 secrets in traces', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await fixture({
      fake: {
        handler: (rpc, ctx) => {
          if (ctx.operation?.name === 'get-config') {
            ctx.server.send(reply(ctx.messageId, DATA));
            return undefined;
          }
          return handler(rpc, ctx);
        },
      },
    });
  });
  afterAll(() => f.close());

  const GET = 'rpc "<get-config><source><running/></source></get-config>"';

  it('AC1: in frames and xml traces, the text of secret-named elements is ***', async () => {
    const r = await runNnc(['router1', '-c', 'trace frames xml', '-c', GET], { home: f.home });
    expect(r.code).toBe(0);
    for (const s of SECRETS.slice(0, 4)) expect(r.stderr).not.toContain(s);
    expect(r.stderr).toContain('<password>***</password>');
    expect(r.stderr).toContain('<private-key>***</private-key>');
    expect(r.stderr).toContain('<name>***</name>');
    expect(r.stderr).toContain('<![CDATA[***]]>');
    // Not secret: left alone.
    expect(r.stderr).toContain('<name>admin</name>');
    // The result itself is not a trace and is not redacted.
    expect(r.stdout).toContain('hunter2');
  });

  it('AC2: in bytes traces the values are *** and the entry is marked redacted', async () => {
    const r = await runNnc(['router1', '-c', 'trace bytes', '-c', GET], { home: f.home });
    for (const s of SECRETS.slice(0, 4)) expect(r.stderr).not.toContain(s);
    const reply1 = entryHeads(r.stderr).find((h) => h.startsWith('<<') && h.includes('<password>'));
    expect(reply1).toMatch(/^<< .* bytes \d+ B \(redacted\): .*<password>\*\*\*<\/password>/);
    const plain = entryHeads(r.stderr).find((h) => h.startsWith('>>') && h.includes('get-config'));
    expect(plain).not.toContain('(redacted)');
  });

  it('AC3: redaction applies only to the trace; the device receives the secret unchanged', async () => {
    const edit = 'rpc "<set-user xmlns=\'urn:example:lab\'><password>swordfish</password></set-user>"';
    const r = await runNnc(['router1', '-c', 'trace bytes frames xml', '-c', edit], { home: f.home });
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain('swordfish');
    expect(f.server.lastBytes().toString()).toContain('<password>swordfish</password>');
  });

  it('AC4, AC5: --no-redact shows secrets and marks the prompt [no-redact]; --redact hides them again', async () => {
    const r = await runNnc(['router1', '-i'], {
      home: f.home,
      stdin: `trace xml --no-redact\n${GET}\ntrace --redact\n${GET}\n`,
    });
    expect(r.stdout).toContain('nnc router1 [no-redact]> ');
    const [before, after] = r.stderr.split(/(?=^>> .* xml \d+ B rpc message-id=2$)/m);
    expect(before).toContain('<password>hunter2</password>');
    expect(after).toContain('<password>***</password>');
    expect(after).not.toContain('hunter2');
    // The mark goes once redaction is back on.
    expect(r.stdout.split('trace: xml · redaction on')[1]).not.toContain('[no-redact]');
  });

  it('AC4: [no-redact] shows without a session too', async () => {
    const r = await runNnc(['-i'], { home: f.home, stdin: 'trace --no-redact\n' });
    expect(r.stdout).toContain('nnc [no-redact]> ');
  });

  it('AC6: a secret split across reads and across a chunk header is still replaced', async () => {
    const r = await runNnc(['router1', '-c', 'trace bytes frames xml', '-c', 'rpc <split xmlns="urn:example:lab"/>'], { home: f.home });
    expect(r.code).toBe(0);
    const bytes = entryHeads(r.stderr).filter((h) => h.startsWith('<<') && / bytes /.test(h));
    // Arrived in pieces, and each piece holding part of the value says it was redacted.
    expect(bytes.length).toBeGreaterThanOrEqual(3);
    // ("sword" itself appears: it ends the tag name "password", here split by a chunk header.)
    for (const piece of ['fish', 'swordf', '>sword', 'sword<', 'ordfi']) expect(r.stderr).not.toContain(piece);
    expect(r.stderr).toMatch(/<pas\\n#\d+\\nsword>\*\*\*/);
    expect(r.stderr).toContain('<password>***</password>');
  });

  it('AC6: when the bytes trace loses the framing it hides the rest rather than risk showing a secret', async () => {
    const r = await runNnc(['router1', '-c', 'trace bytes', '-c', 'rpc <lose xmlns="urn:example:lab"/>'], { home: f.home, timeoutMs: 30_000 });
    expect(r.stderr).not.toContain('swordfish');
    expect(r.stderr).toMatch(/B hidden: the trace lost the framing and can't redact what follows; trace --no-redact shows it/);
  });
});

describe('TRACE-05 redaction edge cases', () => {
  it('a secret-looking element name too long to check is treated as secret', async () => {
    const { redactMessage } = await import('../dist/trace/redact.js');
    const long = `${'x'.repeat(2000)}-password`;
    expect(redactMessage(`<a><${long}>s3cret</${long}><name>ok</name></a>`)).toBe(`<a><${long}>***</${long}><name>ok</name></a>`);
    const longPlain = 'y'.repeat(2000);
    expect(redactMessage(`<${longPlain}>s3cret</${longPlain}>`)).toBe(`<${longPlain}>***</${longPlain}>`);
  });
});

describe('TRACE-05 redaction of malformed and hostile input', () => {
  it('a framing error right after a secret does not show it', async () => {
    const { Tracer } = await import('../dist/trace/tracer.js');
    const { TraceSettings } = await import('../dist/trace/settings.js');
    const shown: string[] = [];
    const settings = new TraceSettings((t: string) => shown.push(t), false);
    settings.setLevels(['bytes', 'frames', 'xml']);
    const tracer = new Tracer(settings);
    const hello = '<hello xmlns="urn:ietf:params:xml:ns:netconf:base:1.0"><capabilities><capability>urn:ietf:params:netconf:base:1.1</capability></capabilities></hello>]]>]]>';
    tracer.sent(Buffer.from(hello));
    tracer.received(Buffer.from(hello));
    tracer.received(Buffer.from('\n#10\n<password>SECRET</password>\n##\n'));
    expect(shown.join('\n')).toContain('framing error');
    expect(shown.join('\n')).not.toContain('SECRET');
  });

  it('a DOCTYPE with > inside a quoted value does not end early and swallow a secret', async () => {
    const { redactMessage } = await import('../dist/trace/redact.js');
    for (const opener of ['<!--', '<![CDATA[', '<?']) {
      const out = redactMessage(`<!DOCTYPE r [<!ENTITY e "><${opener.slice(1)}">]><r><password>SECRET</password><!-- --></r>`);
      expect(out).not.toContain('SECRET');
    }
  });

  it('a close tag that matches nothing open does not end the secret', async () => {
    const { redactMessage } = await import('../dist/trace/redact.js');
    expect(redactMessage('<password>a</password2>SECRET</password>')).not.toContain('SECRET');
    expect(redactMessage('<password><x/></y>SECRET</password>')).not.toContain('SECRET');
    expect(redactMessage('<a><password>s</password><name>ok</name></a>')).toBe('<a><password>***</password><name>ok</name></a>');
  });
});
