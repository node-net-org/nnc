/**
 * Commands offered in every session kind (docs/cli.md §6.2).
 */

import { BASE_OPERATIONS } from '@node-net/netconf/core';
import { CliError } from '../errors.js';
import { guardLowLevel } from '../guard.js';
import { subscriptionWhat } from '../render/notifications.js';
import { formatTable } from '../render/table.js';
import type { ActiveSession } from '../sessions/active.js';
import type { LowSession } from '../sessions/low.js';
import { openCalledHomeSession, openClientSession, simDevice, type ConnectRequest } from '../sessions/connect.js';
import { closeLowSession } from '../sessions/low.js';
import { byteCount, openLow } from './low.js';
import { Tracer } from '../trace/tracer.js';
import { hostKeyPin, loadTargets, parseAdHoc, targetNamesSync, targetsPath, type Target } from '../targets.js';
import type { Cli } from '../cli.js';
import { describeOperation, operationsOf } from './descriptor.js';
import { helpIndex, isLayer, layerHelp } from './help-index.js';
import { LAYERS, usageOf, type Command, type CommandResult } from './registry.js';
import { TIMEOUT_OPTION, timeoutOf } from './xml-input.js';

const ALL = ['none', 'client', 'framed', 'raw'] as const;

/** Target names from the targets file, offered by Tab after connect and listen. */
const targetNames = (cli: Cli): readonly string[] => targetNamesSync(cli.host, targetsPath(cli.host, cli.options.targetsPath));

export const connectCommand: Command = {
  name: 'connect',
  group: 'connection',
  example: 'connect router1 --read-only',
  summary: 'Open a session to a target from the targets file, to user@host[:port], or over TLS to host[:port] --tls',
  args: [{ name: 'target', description: 'a target name, user@host[:port], or host[:port] with --tls', values: targetNames }],
  options: {
    'read-only': { type: 'boolean', description: 'refuse state-changing commands for the life of the session' },
    framed: { type: 'boolean', description: 'a framed session: the transport and framing only; you send the hello and every message' },
    raw: { type: 'boolean', description: 'a raw session: the netconf subsystem (or TLS stream) only; you send bytes' },
    tls: { type: 'boolean', description: 'connect ad hoc over TLS (RFC 7589, port 6513 by default) with --cert and --key' },
    cert: { type: 'string', value: '<path>', description: 'with --tls: the client certificate (PEM)' },
    key: { type: 'string', value: '<path>', description: "with --tls: the client certificate's private key (PEM)" },
    ca: { type: 'string', value: '<path>', multiple: true, description: "with --tls: a CA certificate to verify the server's certificate against" },
    fingerprint: { type: 'string', value: '<sha256>', multiple: true, description: "with --tls: the server certificate's SHA-256 fingerprint" },
    'server-name': { type: 'string', value: '<name>', description: 'with --tls: the name the server certificate must carry, if not the host' },
    timeout: { ...TIMEOUT_OPTION, description: "wait this long to connect and for the server's hello" },
    yang: { type: 'string', value: '<dir>', multiple: true, description: 'a directory of YANG modules for --json output, used before the bundled IETF modules and <get-schema>' },
  },
  kinds: ALL,
  async run(cli, args, signal) {
    const open = cli.open;
    if (open !== undefined) {
      throw new CliError(`already connected to ${open.name} (${open.kind} session); disconnect first`);
    }
    if (args.options['framed'] === true && args.options['raw'] === true) throw new CliError('connect: use --framed or --raw, not both');
    const timeout = timeoutOf(args, 'connect');
    const resolved = await resolveTarget(cli, args.positional[0]!, args.options);
    const timed: Target = timeout === undefined ? resolved : { ...resolved, timeouts: { ...resolved.timeouts, connect: timeout, hello: timeout } };
    const yangDirs = args.options['yang'];
    const target: Target =
      Array.isArray(yangDirs) && yangDirs.length > 0
        ? { ...timed, yang: { ...timed.yang, modules: [...(yangDirs as string[]), ...(timed.yang?.modules ?? [])] } }
        : timed;
    const readOnly = args.options['read-only'] === true || target.readOnly === true;
    const lowLevel = args.options['framed'] === true ? 'framed' : args.options['raw'] === true ? 'raw' : undefined;
    if (lowLevel !== undefined) {
      // Checked first: whatever is typed in a low-level session can't be guarded.
      if (readOnly) guardLowLevel(target.name, lowLevel);
      return { text: await openLow(cli, lowLevel, target, signal), message: true };
    }
    const session = await openClientSession({ target, readOnly, signal, ...sessionHooks(cli, target) });
    return { text: announce(cli, session), message: true };
  },
};

/** How a client session reports to the CLI: notifications, the trace, warnings, and the server closing it. */
function sessionHooks(cli: Cli, target: Target): Pick<ConnectRequest, 'host' | 'prompt' | 'onNotification' | 'recorder' | 'onWarning' | 'onLost'> {
  return {
    host: cli.host,
    prompt: (text) => cli.io.secret(text),
    onNotification: (_s, item) => cli.io.notice(item.line),
    recorder: (log) => {
      cli.trace.sessionStarted(target.name);
      return new Tracer(cli.trace, (direction, text) => {
        if (direction === 'received') log.add(text);
      });
    },
    onWarning: (text) => cli.io.err(`warning: ${text}`),
    onLost: (lost, cause) => {
      if (cli.session !== lost) return;
      cli.session = undefined;
      cli.io.notice(`server closed the session to ${lost.name}${cause === undefined ? '' : ` (${cause.message})`}`);
    },
  };
}

/** Make `session` the open session, warn if it wasn't verified, and return the line that says so. */
function announce(cli: Cli, session: ActiveSession): string {
    cli.session = session;
    if (session.insecure) {
      cli.io.err(
        session.transport === 'tls'
          ? `warning: the server certificate of ${session.host}:${session.port} was not verified (insecure is insecure-accept-any); ` +
              `received fingerprint ${session.fingerprint ?? 'unknown'}`
          : `warning: the host key of ${session.host}:${session.port} was not verified (hostKey is insecure-accept-any); ` +
              `received fingerprint ${session.fingerprint ?? 'unknown'}`,
      );
    }
    const parts = [
      session.calledHome
        ? `${session.name} called home from ${session.host}:${session.port}${session.transport === 'tls' ? ' over TLS' : ''}`
        : `connected to ${session.name} (${place(session)}${session.via === undefined ? '' : ` via ${session.via}`}${session.transport === 'tls' ? ' over TLS' : ''})`,
      `session-id ${session.client.session.sessionId}`,
      `base:${session.client.session.baseVersion}`,
      session.profile === undefined ? 'no profile matched' : `profile ${session.profile}`,
      ...(session.readOnly ? ['read-only'] : []),
      ...(session.insecure ? ['insecure'] : []),
    ];
    return parts.join(' · ');
}

export const listenCommand: Command = {
  name: 'listen',
  group: 'connection',
  example: 'listen router1 --read-only',
  summary: "Wait for a target's device to call home (RFC 8071) and open a client session on its call",
  args: [{ name: 'target', description: 'a target name, or user@host[:port]; the caller must prove it is this target', values: targetNames }],
  options: {
    'read-only': { type: 'boolean', description: 'refuse state-changing commands for the life of the session' },
    port: { type: 'string', value: '<port>', description: 'the port to listen on (default 4334 for SSH, 4335 for TLS)' },
    address: { type: 'string', value: '<address>', description: 'the local address to listen on (default all)' },
    timeout: { ...TIMEOUT_OPTION, description: 'stop waiting for the call after this long' },
  },
  kinds: ALL,
  async run(cli, args, signal) {
    const open = cli.open;
    if (open !== undefined) {
      throw new CliError(`already connected to ${open.name} (${open.kind} session); disconnect first`);
    }
    const timeout = timeoutOf(args, 'listen');
    const portText = args.options['port'];
    let port: number | undefined;
    if (portText !== undefined) {
      port = Number(portText);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new CliError(`listen: --port ${String(portText)} is not a port number (1 to 65535)`);
    }
    const address = args.options['address'] as string | undefined;
    const target = await resolveTarget(cli, args.positional[0]!, {});
    const readOnly = args.options['read-only'] === true || target.readOnly === true;
    const session = await openCalledHomeSession({
      target,
      readOnly,
      signal,
      ...sessionHooks(cli, target),
      ...(port !== undefined ? { port } : {}),
      ...(address !== undefined ? { address } : {}),
      ...(timeout !== undefined ? { timeout } : {}),
      onListening: (where) => cli.io.notice(`listening for ${target.name} on ${where}; Ctrl-C stops waiting`),
      onRefused: (text) => cli.io.notice(text),
    });
    return { text: announce(cli, session), message: true };
  },
};

const TLS_OPTIONS = ['cert', 'key', 'ca', 'fingerprint', 'server-name'] as const;

async function resolveTarget(cli: Cli, name: string, options: Readonly<Record<string, unknown>>): Promise<Target> {
  const given = TLS_OPTIONS.filter((o) => options[o] !== undefined);
  if (options['tls'] === true) return adHocTls(name, options);
  if (given.length > 0) {
    throw new CliError(`connect: --${given[0]} is only used with --tls; a TLS target in the targets file carries its own certificate settings`);
  }
  if (name.includes('@')) {
    const adHoc = parseAdHoc(name);
    if (adHoc === undefined) throw new CliError(`connect: ${JSON.stringify(name)} is not in user@host[:port] form`);
    return adHoc;
  }
  const file = await loadTargets(cli.host, targetsPath(cli.host, cli.options.targetsPath));
  const target = file.targets.get(name);
  if (target === undefined) {
    throw new CliError(
      `unknown target "${name}": not in ${file.path}${file.exists ? '' : ' (file not found)'}; use a target name from that file, or user@host[:port]`,
    );
  }
  return target;
}

/** `connect host[:port] --tls --cert … --key … (--ca … | --fingerprint …)`: TLS without a targets entry. */
function adHocTls(text: string, options: Readonly<Record<string, unknown>>): Target {
  const m = /^([^@\s:/]+)(?::(\d+))?$/.exec(text);
  if (m === null) {
    throw new CliError(
      `connect --tls: ${JSON.stringify(text)} is not in host[:port] form${text.includes('@') ? ' (over TLS the client certificate names the user)' : ''}`,
    );
  }
  const port = m[2] === undefined ? 6513 : Number(m[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new CliError(`port ${m[2]} is out of range`);
  const cert = options['cert'];
  const key = options['key'];
  if (typeof cert !== 'string' || typeof key !== 'string') throw new CliError('connect --tls: --cert and --key are required');
  const ca = options['ca'] as readonly string[] | undefined;
  const fingerprint = options['fingerprint'] as readonly string[] | undefined;
  if (ca === undefined && fingerprint === undefined) {
    throw new CliError("connect --tls: give --ca or --fingerprint to verify the server's certificate");
  }
  const serverName = options['server-name'] as string | undefined;
  return {
    name: m[1]!,
    host: m[1]!,
    port,
    transport: 'tls',
    adHoc: true,
    tls: {
      cert,
      key,
      ...(ca !== undefined ? { ca } : {}),
      ...(fingerprint !== undefined ? { fingerprint } : {}),
      ...(serverName !== undefined ? { serverName } : {}),
    },
  };
}

export const disconnectCommand: Command = {
  name: 'disconnect',
  group: 'connection',
  example: 'disconnect',
  summary: 'Close the session (a client session sends <close-session> first)',
  args: [],
  options: {},
  kinds: ALL,
  async run(cli) {
    return { text: await disconnect(cli), message: true };
  },
};

/** Close the open session, if any, and say what happened. */
export async function disconnect(cli: Cli): Promise<string> {
  const l = cli.low;
  if (l !== undefined) {
    cli.low = undefined;
    await closeLowSession(l);
    return `disconnected from ${l.name} (${l.kind} session; nothing was sent)`;
  }
  const s = cli.session;
  if (s === undefined) return 'not connected';
  s.disconnecting = true;
  const queued = s.transaction?.changes.length;
  const pending = s.confirmedCommit !== undefined && s.confirmedCommit.rollbackAt.getTime() > Date.now() ? s.confirmedCommit : undefined;
  s.transaction = undefined;
  s.pending = undefined;
  await s.client.close();
  cli.session = undefined;
  const notes = [
    ...(queued !== undefined ? [`the open transaction was dropped: ${queued} queued change${queued === 1 ? ' was' : 's were'} not applied`] : []),
    ...(pending === undefined
      ? []
      : pending.persist === undefined
        ? ['the pending confirmed commit is rolled back by the device now that the session has closed']
        : [`the pending confirmed commit (persist id ${pending.persist}) rolls back at ${pending.rollbackAt.toISOString()} unless confirmed from another session with commit --persist-id ${pending.persist}`]),
    ...(s.locks.size > 0 ? [`locks on ${[...s.locks].join(', ')} released as the session closed`] : []),
    ...(s.closeReplyMissed ? ['no reply to <close-session> in time; the connection was closed anyway'] : []),
  ];
  return `disconnected from ${s.name}${notes.length > 0 ? ` (${notes.join('; ')})` : ''}`;
}

export const statusCommand: Command = {
  name: 'status',
  group: 'connection',
  example: 'status',
  summary: 'Show the open session: target, kind, session-id, base, framing, profile, read-only, host key, time connected',
  args: [],
  options: {},
  kinds: ALL,
  run(cli): Promise<CommandResult> {
    if (cli.low !== undefined) return Promise.resolve({ text: lowStatus(cli.low) });
    const s = cli.session;
    if (s === undefined) return Promise.resolve({ text: 'not connected' });
    const base = s.client.session.baseVersion;
    const since = s.connectedAt;
    const rows: [string, string][] = [
      ['target', s.name],
      ['host', `${place(s)}${viaJumps(s.via)}${s.calledHome ? ' (called home)' : ''}`],
      ['transport', transportName(s.transport)],
      ['kind', s.kind],
      ['session-id', String(s.client.session.sessionId)],
      ['base', base],
      ['framing', base === '1.1' ? 'chunked' : 'eom'],
      ['profile', s.profile === undefined ? '(none)' : `${s.profile} (${s.profileSource === 'named' ? 'named by the target' : 'detected'})`],
      ['read-only', s.readOnly ? 'yes' : 'no'],
      ...(s.transport === 'sim' ? [] : [[s.transport === 'tls' ? 'server certificate' : 'host key', hostKeyText(s)] as [string, string]]),
      ['connected', `${since.toISOString()} (${elapsed(Date.now() - since.getTime())} ago)`],
      ['locks', s.locks.size > 0 ? [...s.locks].join(', ') : '(none)'],
    ];
    const t = s.target;
    const options = [
      ...(t.maxInFlight !== undefined ? [`maxInFlight ${t.maxInFlight}`] : []),
      ...(t.maxMessageBytes !== undefined ? [`maxMessageBytes ${t.maxMessageBytes}`] : []),
      ...(t.parseLimits?.maxDepth !== undefined ? [`parseLimits.maxDepth ${t.parseLimits.maxDepth}`] : []),
      ...(t.parseLimits?.maxNodes !== undefined ? [`parseLimits.maxNodes ${t.parseLimits.maxNodes}`] : []),
      ...(t.capabilityCheck !== undefined ? [`capabilityCheck ${t.capabilityCheck}`] : []),
      ...(t.namespaces !== undefined ? [`namespaces ${Object.entries(t.namespaces).map(([m, ns]) => `${m}=${ns}`).join(' ')}`] : []),
    ];
    if (options.length > 0) rows.push(['session options', options.join(', ')]);
    // OPS-15: the dynamic subscriptions this session holds and reads.
    const subs = [...s.subscriptions.active.values()];
    if (subs.length > 0) rows.push(['subscriptions', subs.map((sub) => `${sub.id} ${subscriptionWhat(sub).replaceAll(' · ', ' ')}`).join('; ')]);
    if (s.transaction !== undefined) rows.push(['transaction', `open: ${s.transaction.changes.length} change${s.transaction.changes.length === 1 ? '' : 's'} queued (apply sends them; abandon drops them)`]);
    const pending = s.confirmedCommit;
    if (pending !== undefined && pending.rollbackAt.getTime() > Date.now()) {
      rows.push([
        'confirmed commit',
        `pending: rolls back at ${pending.rollbackAt.toISOString()} (in ${elapsed(pending.rollbackAt.getTime() - Date.now())}) unless confirmed` +
          (pending.persist === undefined ? '' : `; persist id ${pending.persist}`),
      ]);
    }
    const width = Math.max(...rows.map(([k]) => k.length));
    return Promise.resolve({ text: rows.map(([k, v]) => `${k.padEnd(width)}  ${v}`).join('\n') });
  },
};

/** The status `host key` (or `server certificate`) value: the fingerprint, and how it was checked unless by known_hosts or ca. */
function hostKeyText(s: { readonly fingerprint: string | undefined; readonly insecure: boolean; readonly transport: 'ssh' | 'tls' | 'sim'; readonly target: Target }): string {
  const how = s.insecure ? ' (not verified: insecure-accept-any)' : s.transport === 'ssh' && hostKeyPin(s.target.hostKey) !== undefined ? ' (pinned)' : '';
  return `${s.fingerprint ?? 'unknown'}${how}`;
}

/** Where a session is: host:port, or `sim:<device>` for a simulated device (which has no port). */
function place(s: { readonly host: string; readonly port: number; readonly transport: 'ssh' | 'tls' | 'sim' }): string {
  return s.transport === 'sim' ? s.host : `${s.host}:${s.port}`;
}

function transportName(transport: 'ssh' | 'tls' | 'sim'): string {
  return transport === 'tls' ? 'TLS (RFC 7589)' : transport === 'sim' ? 'simulated device (in memory)' : 'SSH';
}

/** `status` for a framed or raw session: kind and framing, and none of a client session's fields. */
function lowStatus(s: LowSession): string {
  const since = s.connectedAt;
  const rows: [string, string][] = [
    ['target', s.name],
    ['host', `${place(s)}${viaJumps(s.via)}`],
    ['transport', transportName(s.transport)],
    ['kind', s.kind],
    ['framing', s.kind === 'framed' ? (s.channel?.framing ?? 'eom') : 'none (raw bytes)'],
    ...(s.transport === 'sim' ? [] : [[s.transport === 'tls' ? 'server certificate' : 'host key', hostKeyText(s)] as [string, string]]),
    ['connected', `${since.toISOString()} (${elapsed(Date.now() - since.getTime())} ago)`],
    s.kind === 'framed' ? ['received', `${s.messages.length} message${s.messages.length === 1 ? '' : 's'}`] : ['received', byteCount(s.receivedBytes)],
    ...(s.kind === 'raw' ? [['sending', s.eof ? 'ended (eof)' : 'open'] as [string, string]] : []),
  ];
  const width = Math.max(...rows.map(([k]) => k.length));
  return rows.map(([k, v]) => `${k.padEnd(width)}  ${v}`).join('\n');
}

function elapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export const targetsCommand: Command = {
  name: 'targets',
  group: 'connection',
  example: 'targets',
  summary: 'List the targets in the targets file',
  args: [],
  options: {},
  kinds: ALL,
  async run(cli) {
    const file = await loadTargets(cli.host, targetsPath(cli.host, cli.options.targetsPath));
    if (file.targets.size === 0) {
      return { text: `(no targets) in ${file.path}${file.exists ? '' : ' (file not found)'}` };
    }
    const rows = [...file.targets.values()].map((t) => [
      t.name,
      t.transport === 'tls'
        ? `${t.host}:${t.port ?? 6513} (TLS)`
        : t.transport === 'sim'
          ? `sim:${simDevice(t)} (simulated)`
          : `${t.username ?? '(local user)'}@${t.host}:${t.port ?? 830}${t.jumpHosts === undefined || t.jumpHosts.length === 0 ? '' : ` via ${t.jumpHosts.map((j) => j.host).join(' → ')}`}`,
      t.profile ?? '(auto-detect)',
      t.readOnly === true ? 'read-only' : '',
    ]);
    return { text: [`targets in ${file.path}`, ...formatTable(['NAME', 'ADDRESS', 'PROFILE', 'READ-ONLY'], rows)].join('\n') };
  },
};

export const helpCommand: Command = {
  name: 'help',
  group: 'nnc',
  example: 'help get-config',
  summary: 'List the commands available in this session by layer, show one layer, or describe one command',
  args: [
    {
      name: 'command',
      description: `a command to describe, or a layer to list (${LAYERS.join(', ')})`,
      optional: true,
      values: (cli) => [...LAYERS, ...cli.registry.names(), ...(cli.session === undefined ? [] : operationsOf(cli.session).map((d) => d.name))].sort(),
    },
  ],
  options: {},
  kinds: ALL,
  run(cli, args): Promise<CommandResult> {
    const name = args.positional[0];
    if (name === undefined) return Promise.resolve({ text: helpIndex(cli).join('\n') });
    // Layer names come first: no command or operation uses one (test/lang-11-help.test.ts checks).
    if (isLayer(name)) return Promise.resolve({ text: layerHelp(cli, name).join('\n') });
    const cmd = cli.registry.get(name);
    if (cmd === undefined) {
      const d = (cli.session === undefined ? BASE_OPERATIONS : operationsOf(cli.session)).find((o) => o.name === name);
      if (d === undefined) throw new CliError(`help: unknown command ${name}${suggestion(cli, name)}`);
      return Promise.resolve({ text: describeOperation(d, cli.session) });
    }
    const lines = [`usage: ${usageOf(cmd)}`, '', cmd.describe?.[cli.kind] ?? cmd.summary];
    if (cmd.describe !== undefined && cmd.describe[cli.kind] !== undefined) {
      const others = Object.entries(cmd.describe).filter(([k]) => k !== cli.kind);
      lines.push(...others.map(([k, text]) => `  (in ${k} sessions: ${text})`));
    }
    if (cmd.rawLineIn?.includes(cli.kind) === true) lines.push(`In this ${cli.kind} session the rest of the line is taken exactly as typed: no quoting, comments, options or redirects.`);
    if (cmd.args.length > 0) lines.push('', 'arguments:', ...cmd.args.map((a) => `  <${a.name}>  ${a.description}${a.optional === true ? ' (optional)' : ''}`));
    const opts = Object.entries(cmd.options);
    if (opts.length > 0) {
      lines.push(
        '',
        'options:',
        ...opts.map(([n, o]) => {
          const facts = [
            ...(o.type === 'boolean' ? [`on/off (--no-${n})`] : []),
            ...(o.values !== undefined ? [`one of ${o.values.join(', ')}`] : []),
            ...(o.default !== undefined ? [`default ${o.default}`] : []),
          ];
          return `  --${n}${o.type === 'string' ? ` ${o.value ?? '<value>'}` : ''}  ${o.description}${facts.length > 0 ? ` (${facts.join('; ')})` : ''}`;
        }),
      );
    }
    const more = cmd.moreHelp?.(cli) ?? [];
    if (more.length > 0) lines.push('', ...more);
    const kinds = cmd.kinds.map((k) => (k === 'none' ? 'with no session' : `${k} sessions`)).join(', ');
    lines.push('', `available: ${kinds}`);
    if (cmd.example !== undefined) lines.push(`example: ${cmd.example}`);
    return Promise.resolve({ text: lines.join('\n') });
  },
};

/** ` (did you mean x?)`, or nothing. */
function suggestion(cli: Cli, name: string): string {
  const s = cli.suggest(name);
  return s === undefined ? '' : ` (${s})`;
}

export const exitCommand: Command = {
  name: 'exit',
  group: 'nnc',
  example: 'exit',
  summary: 'Disconnect and quit',
  args: [],
  options: {},
  kinds: ALL,
  run(cli) {
    cli.exitRequested = true;
    return Promise.resolve(undefined);
  },
};

/** ` via jump host a:22`, or ` via jump hosts a:22 → b:22` for a chain, for status. */
function viaJumps(via: string | undefined): string {
  if (via === undefined) return '';
  return via.includes(' → ') ? ` via jump hosts ${via}` : ` via jump host ${via}`;
}
