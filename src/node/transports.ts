/**
 * The Node host's transports (docs/cli.md §4, §8): SSH (with jump hosts and
 * host-key verification against known_hosts or pins) and TLS, the credentials
 * they need, call home, and plain explanations of failures (SESS-07).
 *
 * Moved from sessions/connect.ts, which keeps the portable part (profile
 * choice, the session's hello capture and trace, the session object) and
 * reaches targets through NncHost.transports.
 */

import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import {
  AbortError,
  AuthenticationError,
  CALL_HOME_SSH_PORT,
  CALL_HOME_TLS_PORT,
  CertificateError,
  FramingError,
  HelloError,
  HostKeyError,
  INSECURE_ACCEPT_ANY,
  TimeoutError,
  TransportError,
  XmlError,
  ProtocolError,
  knownHosts,
  toVerifier,
  listenCallHome,
  ssh,
  tls,
  type CallHomeCaller,
  type ConnectionFactory,
  type CallHomeDevice,
  type CallHomeListener,
  type CallHomeSshListen,
  type HostKeyInfo,
  type HostKeyVerifier,
  type SshEndpoint,
} from '@node-net/netconf';
import { CliError, EXIT } from '../errors.js';
import type { SecretPrompt, Transports } from '../host.js';
import { expandHome as expandFrom } from '../paths.js';
import type { ActiveSession } from '../sessions/active.js';
import { chooseProfile, clientOptions, toSession, watchSession, type ListenRequest, type SessionWatch, type Use } from '../sessions/connect.js';
import { hostKeyPin, type EndpointSpec, type Target, type TlsSpec } from '../targets.js';
import { agentSocket, askSecret, readKeyFile, readSecret } from './credentials.js';

/** SSH and TLS, call home, and the library's check of host-key pins. */
export const nodeTransports: Transports = {
  reach,
  listen: openCalledHomeSession,
  checkHostKey: (pin) => void toVerifier(pin),
};

/** The username for a target that names none: the user running nnc. */
export function defaultUsername(): string {
  try {
    return userInfo().username;
  } catch {
    return process.env['USER'] ?? 'root';
  }
}

function expandHome(path: string): string {
  return expandFrom(path, homedir());
}

/** What one hop's host-key check saw. */
interface HostKeyOutcome {
  readonly label: string;
  /** The known_hosts file checked; undefined when the hop's hostKey is a pin. */
  readonly file: string | undefined;
  fingerprint?: string;
  accepted?: boolean;
  /** The file has an entry for this host (so a rejection means the key differs). */
  listed?: boolean;
}

/** Build the transport for a target (SSH with its jump host and host-key policy, or TLS) and hand it to `use`. */
async function reach<T>(target: Target, prompt: SecretPrompt, use: Use<T>): Promise<T> {
  if (target.tls !== undefined) return reachTls(target, target.tls, prompt, use);
  const port = target.port ?? 830;

  const deviceWhat = `${target.username ?? defaultUsername()}@${target.host}`;
  const jumps = target.jumpHosts ?? [];
  const hops = jumps.map((jump) => ({ jump, port: jump.port ?? 22, label: `${jump.host}:${jump.port ?? 22}` }));

  // Credentials gathered up front, hop by hop; the device password may be asked for later if the agent or key is refused.
  const jumpAuths: Awaited<ReturnType<typeof endpointAuth>>[] = [];
  for (const { jump } of hops) jumpAuths.push(await endpointAuth(jump, `${jump.username ?? defaultUsername()}@${jump.host} (jump host)`, prompt, true));
  const deviceAuth = await endpointAuth(target, deviceWhat, prompt, false);
  const via = hops.length === 0 ? undefined : hops.map((h) => h.label).join(' → ');

  const attempt = async (password: string | undefined): Promise<T> => {
    const outcomes: HostKeyOutcome[] = [];
    const jumpOptions = hops.map(({ jump, port, label }, i) =>
      endpointOptions(jump, port, jumpAuths[i]!.auth, jumpAuths[i]!.password, hostKeyPolicy(jump, `jump host ${label}`, outcomes)),
    );
    const deviceOptions = endpointOptions(
      target,
      port,
      deviceAuth.auth,
      password,
      hostKeyPolicy(target, `${target.host}:${port}`, outcomes),
    );
    const factory = ssh({ ...deviceOptions, ...(jumpOptions.length > 0 ? { jump: jumpOptions } : {}) });
    return use(
      factory,
      port,
      { via, insecure: target.hostKey === 'insecure-accept-any', transport: 'ssh' },
      (err) => describeFailure(err, { target, port, outcomes }),
    );
  };

  try {
    return await attempt(deviceAuth.password);
  } catch (err) {
    // Agent or key refused and no password source given: ask, and try once more.
    if (err instanceof AuthFailure && !err.atJumpHost && deviceAuth.password === undefined && deviceAuth.promptOnFailure) {
      const password = await prompt(`Password for ${deviceWhat}: `);
      // No password to try (input has ended): the agent or key failure is the answer.
      if (password === undefined) throw err.cliError;
      try {
        return await attempt(password);
      } catch (retry) {
        throw retry instanceof AuthFailure ? retry.cliError : retry;
      }
    }
    throw err instanceof AuthFailure ? err.cliError : err;
  }
}

/** How a session was reached, for the connect line and status. */

// --- call home ---------------------------------------------------------------------------

/** What `listen` needs: a client session's request, plus where to listen and how to report calls it refuses. */
async function openCalledHomeSession(req: ListenRequest): Promise<ActiveSession> {
  const { target } = req;
  if ((target.jumpHosts ?? []).length > 0) {
    throw new CliError(`listen: target "${target.name}" goes through a jump host, but a device calling home connects straight to us; nothing was opened`, EXIT.usage);
  }
  const device = await chooseProfile(req.host, target);
  const prepared = target.tls !== undefined ? await callHomeTls(req, target.tls) : await callHomeSsh(req);
  if (prepared.insecure) {
    // Said before listening: with connect an impostor must be on the path; here anyone who can reach the port may call.
    req.onWarning?.(
      target.tls !== undefined
        ? `${target.name} is insecure (insecure-accept-any): the first device to call will be taken as ${target.name}, whatever its certificate`
        : `${target.name}'s hostKey is insecure-accept-any: the first device to call will be taken as ${target.name} and given its credentials`,
    );
  }
  const port = req.port ?? (target.tls !== undefined ? CALL_HOME_TLS_PORT : CALL_HOME_SSH_PORT);
  const listen = { port, ...(req.address !== undefined ? { host: req.address } : {}) };
  const kind = target.tls !== undefined ? 'tls' : 'ssh';
  const stop = new AbortController();
  const timer = req.timeout === undefined ? undefined : setTimeout(() => stop.abort(), req.timeout);
  // Each identified call is watched on its own (hello, messages, trace, log), so a call that fails can't leak into the one taken.
  const watches = new Map<CallHomeCaller, SessionWatch>();
  let listener: CallHomeListener;
  try {
    listener = await listenCallHome({
      ...(target.tls !== undefined ? { tls: { ...listen, ...prepared.tls! } } : { ssh: { ...listen, ...prepared.ssh } }),
      identify: async (caller) => {
        const answer = await prepared.identify(caller);
        if (answer === undefined) return undefined;
        const watch = watchSession(req);
        watches.set(caller, watch);
        return { ...answer, connect: { logger: watch.logger } };
      },
      connect: clientOptions(target, device, {}),
      wrapConnection: (connection, caller) => watches.get(caller)!.wrap(connection),
      ...(target.timeouts?.connect !== undefined ? { handshakeTimeout: target.timeouts.connect } : {}),
      maxQueued: 1,
    });
  } catch (err) {
    clearTimeout(timer);
    const cause = (err as Error).cause as NodeJS.ErrnoException | undefined;
    const why = cause?.code === 'EADDRINUSE' ? 'the port is in use' : cause?.code === 'EACCES' ? 'no permission to listen there' : (cause?.message ?? (err as Error).message);
    throw new CliError(`listen: cannot listen on ${hostPort(req.address ?? '0.0.0.0', port)}: ${why}`, EXIT.connection);
  }
  listener.on('rejected', (e) => {
    if (listener.closed) return;
    // identify said no: say what the caller was checked against.
    const hint = e.reason.startsWith('unknown device') ? `; ${prepared.checkedAgainst}` : '';
    req.onRefused(`refused a call from ${hostPort(e.remote.address, e.remote.port)}: ${e.reason}${hint}`);
  });
  listener.on('failed', (e) => req.onRefused(`a call from ${hostPort(e.remote.address, e.remote.port)} failed: ${e.error.message}`));
  const bound = listener.addresses[kind];
  req.onListening(`${bound === undefined ? hostPort(req.address ?? '*', port) : hostPort(bound.address, bound.port)} (${kind})`);

  let onUser: (() => void) | undefined;
  const cancelled = new Promise<'cancelled' | 'timeout'>((resolve) => {
    onUser = () => resolve('cancelled');
    if (req.signal.aborted) resolve('cancelled');
    req.signal.addEventListener('abort', onUser, { once: true });
    stop.signal.addEventListener('abort', () => resolve('timeout'), { once: true });
  });
  const taking = listener.next();
  let taken = false;
  try {
    const next = await Promise.race([taking, cancelled]);
    if (next === 'cancelled') throw new AbortError('listen was cancelled');
    if (next === 'timeout') throw new CliError(`listen: ${target.name} did not call within ${req.timeout} ms; nothing was opened`, EXIT.connection);
    if (next.done === true) throw new CliError('listen: the listener closed before a call came', EXIT.connection);
    const { client, caller } = next.value;
    taken = true;
    return toSession(req, client, watches.get(caller)!, device, {
      host: caller.remote.address,
      port: caller.remote.port,
      shape: { via: undefined, insecure: prepared.insecure, transport: caller.transport },
      calledHome: true,
    });
  } finally {
    clearTimeout(timer);
    if (onUser !== undefined) req.signal.removeEventListener('abort', onUser);
    // Stops listening and ends the wait; the call taken is the session's now and stays open.
    await listener.close();
    // A call that arrived just as Ctrl-C or the timeout won: nobody will use it, so close it.
    if (!taken) void taking.then((r) => (r.done === true ? undefined : r.value.client.close()));
  }
}

/** `host:port`, with an IPv6 address in brackets. */
function hostPort(host: string, port: number): string {
  return `${host.includes(':') ? `[${host}]` : host}:${port}`;
}

interface PreparedCallHome {
  readonly identify: (caller: CallHomeCaller) => Promise<CallHomeDevice | undefined>;
  /** What a caller must match, for refusal notices. */
  readonly checkedAgainst: string;
  readonly tls?: { readonly cert: Buffer; readonly key: Buffer; readonly passphrase?: string; readonly ca?: Buffer[] };
  /** SSH listen options: the host-key types known_hosts holds for the target come first, as connect asks for them. */
  readonly ssh?: Pick<CallHomeSshListen, 'algorithms'>;
  readonly insecure: boolean;
}

/** SSH: credentials gathered now (a prompt mustn't hold up a call), and the caller's host key checked as connect checks it. */
async function callHomeSsh(req: ListenRequest): Promise<PreparedCallHome> {
  const { target } = req;
  const port = target.port ?? 830;
  const what = `${target.username ?? defaultUsername()}@${target.host}`;
  const { auth, password } = await endpointAuth(target, what, req.prompt, true);
  const insecure = target.hostKey === 'insecure-accept-any';
  const outcomes: HostKeyOutcome[] = [];
  const policy = insecure ? undefined : (hostKeyPolicy(target, `${target.host}:${port}`, outcomes) as HostKeyVerifier);
  const credentials: CallHomeDevice = {
    name: target.name,
    username: target.username ?? defaultUsername(),
    ...(password !== undefined ? { password } : {}),
    ...(auth.agent !== undefined ? { agent: auth.agent } : {}),
    ...(auth.privateKey !== undefined ? { privateKey: auth.privateKey } : {}),
    ...(auth.passphrase !== undefined ? { passphrase: auth.passphrase } : {}),
  };
  const file = target.knownHosts === undefined ? join(homedir(), '.ssh', 'known_hosts') : expandHome(target.knownHosts);
  const pinned = hostKeyPin(target.hostKey) !== undefined;
  // Ask the device for a host key of a type known_hosts (or a pin of key lines) holds for it, as connect does;
  // otherwise a device with several keys might present one we lack and be refused.
  const types = policy?.knownKeyTypes === undefined ? [] : await policy.knownKeyTypes(target.host, port);
  const serverHostKey = types.flatMap((t) => (t === 'ssh-rsa' ? ['rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa'] : [t]));
  return {
    insecure,
    ...(serverHostKey.length > 0 ? { ssh: { algorithms: { serverHostKey } } } : {}),
    checkedAgainst: pinned
      ? `not the target's pinned hostKey`
      : `not the host key ${file} lists for ${target.host}${port === 22 ? '' : `:${port}`}`,
    identify: async (caller) => {
      if (policy === undefined) return credentials;
      // The pinned key, or the key the target's known_hosts entry (its host and port, as connect looks it up) records.
      const known = caller.key !== undefined && (await policy({ host: target.host, port, key: caller.key, fingerprint: caller.fingerprint }));
      return known ? credentials : undefined;
    },
  };
}

/** TLS: our certificate is the target's; the caller's certificate is checked as connect checks the server's. */
async function callHomeTls(req: ListenRequest, spec: TlsSpec): Promise<PreparedCallHome> {
  const { target } = req;
  const where = `calls from ${target.name}`;
  const cert = await readPem(spec.cert, 'client certificate', where);
  const key = await readPem(spec.key, "client certificate's private key", where);
  const ca = spec.ca === undefined ? undefined : await Promise.all(spec.ca.map((path) => readPem(path, 'CA certificate', where)));
  const passphrase = target.passphrase === undefined ? undefined : await readSecret(target.passphrase, `key ${spec.key}`, req.prompt, 'passphrase');
  const pins = (spec.fingerprint ?? []).map((f) => normalisePin(f, target.name));
  const name = spec.serverName ?? target.host;
  const insecure = spec.insecure !== undefined;
  const trust = [...(spec.ca !== undefined ? [`ca ${spec.ca.join(', ')} for ${name}`] : []), ...(spec.fingerprint !== undefined ? [`fingerprint ${spec.fingerprint.join(', ')}`] : [])];
  return {
    insecure,
    checkedAgainst: `its certificate doesn't match ${trust.join(' and ')}`,
    tls: { cert, key, ...(passphrase !== undefined ? { passphrase } : {}), ...(ca !== undefined ? { ca } : {}) },
    // As tls() checks a server: every check the target gives must pass. The library has already checked the chain against ca.
    identify: (caller) => {
      const pinned = pins.length === 0 || pins.includes(caller.fingerprint);
      const named =
        ca === undefined ||
        (caller.certificate !== undefined && (isIP(name) !== 0 ? caller.certificate.checkIP(name) : caller.certificate.checkHost(name)) !== undefined);
      return Promise.resolve(insecure || (pinned && named) ? { name: target.name } : undefined);
    },
  };
}

/** A certificate pin as the listener reports fingerprints: `SHA256:` + unpadded base64. */
function normalisePin(pin: string, targetName: string): string {
  const text = pin.trim();
  // Re-encoded from the bytes, so any base64 spelling of the same digest matches the listener's canonical form.
  if (/^SHA256:[A-Za-z0-9+/]{43}=?$/.test(text)) return `SHA256:${Buffer.from(text.slice(7), 'base64').toString('base64').replace(/=+$/, '')}`;
  const hex = text.replace(/:/g, '');
  if (/^[0-9A-Fa-f]{64}$/.test(hex)) return `SHA256:${Buffer.from(hex, 'hex').toString('base64').replace(/=+$/, '')}`;
  throw new CliError(`target "${targetName}": fingerprint ${JSON.stringify(pin)} is neither SHA256:<base64> nor a 64-digit hex SHA-256`, EXIT.usage);
}

// --- TLS ---------------------------------------------------------------------------------

/**
 * A session over NETCONF-over-TLS (RFC 7589). The client certificate is the
 * credential, so there's no username, password prompt or retry; the server is
 * verified by the library from `ca`, `fingerprint` or neither (insecure).
 */
async function reachTls<T>(target: Target, spec: TlsSpec, prompt: SecretPrompt, use: Use<T>): Promise<T> {
  const port = target.port ?? 6513;
  const where = `${target.host}:${port}`;
  const cert = await readPem(spec.cert, 'client certificate', where);
  const key = await readPem(spec.key, "client certificate's private key", where);
  const ca = spec.ca === undefined ? undefined : await Promise.all(spec.ca.map((path) => readPem(path, 'CA certificate', where)));
  const passphrase = target.passphrase === undefined ? undefined : await readSecret(target.passphrase, `key ${spec.key}`, prompt, 'passphrase');
  let factory: ConnectionFactory;
  try {
    factory = tls({
      host: target.host,
      port,
      cert,
      key,
      ...(passphrase !== undefined ? { passphrase } : {}),
      ...(ca !== undefined ? { ca } : {}),
      ...(spec.fingerprint !== undefined ? { fingerprint: spec.fingerprint } : {}),
      ...(spec.serverName !== undefined ? { serverName: spec.serverName } : {}),
      ...(spec.insecure !== undefined ? { insecure: INSECURE_ACCEPT_ANY } : {}),
    });
  } catch (err) {
    // Only bad configuration gets here, such as a malformed fingerprint.
    throw new CliError(`target "${target.name}": ${(err as Error).message.replace(/^tls\(\): /, '')}`, EXIT.usage);
  }
  return use(factory, port, { via: undefined, insecure: spec.insecure !== undefined, transport: 'tls' }, (err) =>
    describeTlsFailure(err, target, where, spec),
  );
}

async function readPem(path: string, what: string, where: string): Promise<Buffer> {
  const full = expandHome(path);
  try {
    return await readFile(full);
  } catch (err) {
    throw new CliError(`cannot read the ${what} for ${where} (${full}): ${(err as NodeJS.ErrnoException).code ?? 'error'}`, EXIT.connection);
  }
}

function describeTlsFailure(err: unknown, target: Target, where: string, spec: TlsSpec): Error {
  const fail = (message: string): CliError => new CliError(message, EXIT.connection);
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof CertificateError) {
    const trust = [
      ...(spec.ca !== undefined ? [`ca ${spec.ca.join(', ')}`] : []),
      ...(spec.fingerprint !== undefined ? [`fingerprint ${spec.fingerprint.join(', ')}`] : []),
    ].join(' and ');
    return fail(
      `server certificate check failed for ${where}: ${message}\n` +
        `  checked against ${trust}${spec.serverName !== undefined ? `, as ${spec.serverName}` : ''}`,
    );
  }
  if (err instanceof AuthenticationError) {
    return fail(`${message}\n  client certificate ${expandHome(spec.cert)}`);
  }
  return describeFailure(err, { target, port: Number(where.slice(where.lastIndexOf(':') + 1)), outcomes: [] });
}


// --- credentials -------------------------------------------------------------------------

interface Auth {
  readonly agent: string | undefined;
  readonly privateKey: Buffer | undefined;
  readonly passphrase: string | undefined;
}

async function endpointAuth(
  spec: EndpointSpec,
  what: string,
  prompt: SecretPrompt,
  isJump: boolean,
): Promise<{ auth: Auth; password: string | undefined; promptOnFailure: boolean }> {
  const agent = agentSocket(spec.agent, what, spec.password !== undefined || spec.privateKey !== undefined);
  const privateKey = spec.privateKey === undefined ? undefined : await readKeyFile(spec.privateKey, what);
  const passphrase = spec.passphrase === undefined ? undefined : await readSecret(spec.passphrase, `key ${spec.privateKey ?? 'of ' + what}`, prompt, 'passphrase');
  const auth = { agent, privateKey, passphrase };
  if (spec.password !== undefined) return { auth, password: await readSecret(spec.password, what, prompt), promptOnFailure: false };
  if (agent === undefined && privateKey === undefined) {
    // Nothing else to authenticate with: the password is the only way.
    return { auth, password: await askSecret(`Password for ${what}: `, prompt), promptOnFailure: false };
  }
  return { auth, password: undefined, promptOnFailure: !isJump };
}

function endpointOptions(
  spec: EndpointSpec,
  port: number,
  auth: Auth,
  password: string | undefined,
  hostKey: SshEndpoint['hostKey'],
): SshEndpoint {
  return {
    host: spec.host,
    port,
    username: spec.username ?? defaultUsername(),
    hostKey,
    ...(password !== undefined ? { password } : {}),
    ...(auth.agent !== undefined ? { agent: auth.agent } : {}),
    ...(auth.privateKey !== undefined ? { privateKey: auth.privateKey } : {}),
    ...(auth.passphrase !== undefined ? { passphrase: auth.passphrase } : {}),
  };
}

// --- host keys -----------------------------------------------------------------------------

function hostKeyPolicy(spec: EndpointSpec, label: string, outcomes: HostKeyOutcome[]): SshEndpoint['hostKey'] {
  if (spec.hostKey === 'insecure-accept-any') return INSECURE_ACCEPT_ANY;
  const pin = hostKeyPin(spec.hostKey);
  if (pin !== undefined) {
    // The library's own pin check, watched so a refusal can be explained.
    const pinned = toVerifier(pin);
    const outcome: HostKeyOutcome = { label, file: undefined };
    outcomes.push(outcome);
    const verifier: HostKeyVerifier = async (info: HostKeyInfo) => {
      outcome.fingerprint = info.fingerprint;
      const accepted = await pinned(info);
      outcome.accepted = accepted;
      return accepted;
    };
    if (pinned.knownKeyTypes !== undefined) verifier.knownKeyTypes = pinned.knownKeyTypes;
    return verifier;
  }
  const file = spec.knownHosts === undefined ? join(homedir(), '.ssh', 'known_hosts') : expandHome(spec.knownHosts);
  const outcome: HostKeyOutcome = { label, file };
  outcomes.push(outcome);
  const read = (): Promise<string> => readFile(file, 'utf8').catch(() => '');
  const verifier: HostKeyVerifier = async (info: HostKeyInfo) => {
    const kh = knownHosts(await read());
    outcome.fingerprint = info.fingerprint;
    // Usable (non-revoked) keys of a supported type for this host and port.
    outcome.listed = (await kh.knownKeyTypes!(info.host, info.port)).length > 0;
    outcome.accepted = await kh(info);
    return outcome.accepted;
  };
  verifier.knownKeyTypes = async (host, port) => knownHosts(await read()).knownKeyTypes!(host, port);
  return verifier;
}

// --- failures --------------------------------------------------------------------------------

/** An authentication failure, kept apart so the caller can retry with a password. */
class AuthFailure extends Error {
  constructor(
    readonly cliError: CliError,
    readonly atJumpHost: boolean,
  ) {
    super(cliError.message);
  }
}

interface FailureContext {
  readonly target: Target;
  readonly port: number;
  readonly outcomes: readonly HostKeyOutcome[];
}

/** The jump host an error is about: the library names a hop as `jump host <host>:<port>` or `jump host <user>@<host>:<port>`. */
function failingHop(target: Target, message: string): { index: number; jump: EndpointSpec; label: string } | undefined {
  const jumps = target.jumpHosts ?? [];
  for (const [index, jump] of jumps.entries()) {
    const label = `${jump.host}:${jump.port ?? 22}`;
    const user = `${jump.username ?? defaultUsername()}@`;
    if (message.includes(`jump host ${label}`) || message.includes(`jump host ${user}${label}`)) return { index, jump, label };
  }
  return undefined;
}

const NETWORK_ERRORS: Readonly<Record<string, string>> = {
  ECONNREFUSED: 'connection refused',
  ETIMEDOUT: 'timed out',
  EHOSTUNREACH: 'host unreachable',
  ENETUNREACH: 'network unreachable',
  ENOTFOUND: 'host not found',
  EAI_AGAIN: 'host name lookup failed',
  ECONNRESET: 'connection reset',
};

function describeFailure(err: unknown, ctx: FailureContext): Error {
  const where = `${ctx.target.host}:${ctx.port}`;
  const fail = (message: string): CliError => new CliError(message, EXIT.connection);
  const message = err instanceof Error ? err.message : String(err);
  const hop = failingHop(ctx.target, message);
  const atJump = hop !== undefined;
  const jumpPrefix = atJump ? `failed at jump host ${hop.label}: ` : '';
  const lastJump = ctx.target.jumpHosts?.at(-1);

  if (err instanceof HostKeyError) {
    // Lead with the outcome: the rest reads like advice, and a jump-host failure already says "failed at".
    const lead = jumpPrefix || 'not connected: ';
    const rejected = ctx.outcomes.find((o) => o.accepted === false);
    if (rejected?.fingerprint !== undefined) {
      const [host, port] = splitLabel(rejected.label);
      if (rejected.file === undefined) {
        const isJump = rejected.label.startsWith('jump host ');
        const jump = isJump ? `of ${rejected.label} ` : '';
        return fail(
          `${lead}host key for ${rejected.label} does not match ${isJump ? 'its' : "the target's"} pinned hostKey\n` +
            `  received fingerprint ${rejected.fingerprint}\n` +
            `  if the key changed legitimately, update hostKey ${jump}for ${ctx.target.name} in ${ctx.target.file ?? 'the targets file'}`,
        );
      }
      if (rejected.listed === true) {
        return fail(
          `${lead}host key for ${rejected.label} does not match ${rejected.file}\n` +
            `  received fingerprint ${rejected.fingerprint}\n` +
            `  if the key changed legitimately, remove the old entry with: ssh-keygen -R '${knownHostsName(host, port)}' -f ${rejected.file}`,
        );
      }
      // Behind jump hosts a name may only resolve from the hop before it, so scan from there, through the hops before that.
      const jumps = ctx.target.jumpHosts ?? [];
      const rejectedHop = jumps.findIndex((j) => rejected.label === `jump host ${j.host}:${j.port ?? 22}`);
      const before = rejectedHop === -1 ? jumps : jumps.slice(0, rejectedHop);
      const scan = `ssh-keyscan -p ${port} ${host}`;
      const add = before.length === 0 ? scan : `${sshThrough(before)} ${scan}`;
      return fail(
        `${lead}host key for ${rejected.label} is not in ${rejected.file}\n` +
          `  received fingerprint ${rejected.fingerprint}\n` +
          `  check it with the device's administrator, then add it with: ${add} >> ${rejected.file}`,
      );
    }
    return fail(`${lead}host-key verification failed: ${message}`);
  }
  if (err instanceof AuthenticationError && err.reason === 'key') {
    // Our own key, not the server's refusal: no password prompt follows, as nothing was sent.
    const path = (atJump ? hop.jump : ctx.target).privateKey;
    const what = /(could not be decrypted.*|is encrypted, but .*|could not be read: .*)$/.exec(message)?.[1];
    if (path === undefined || what === undefined) return fail(`${jumpPrefix}${message}`);
    return fail(`${jumpPrefix}the private key ${path} ${what}`);
  }
  if (err instanceof AuthenticationError) {
    const user = atJump ? (hop.jump.username ?? defaultUsername()) : (ctx.target.username ?? defaultUsername());
    const text = atJump
      ? `authentication failed at jump host ${hop.label} for user ${user}`
      : `authentication failed for user ${user} at ${where}`;
    return new AuthFailure(fail(text), atJump);
  }
  if (err instanceof TimeoutError) {
    if (err.phase === 'hello') return fail(`hello exchange failed: no hello from ${where} (${err.message})`);
    return fail(`${jumpPrefix || `cannot reach ${where}: `}timed out (${err.message})`);
  }
  if (err instanceof AbortError) return fail(`connect to ${where} cancelled`);
  if (err instanceof HelloError) return fail(`hello exchange failed with ${where}: ${message}`);
  // Before the session exists, a message that can't be read can only be the hello.
  if (err instanceof XmlError || err instanceof FramingError || err instanceof ProtocolError) {
    return fail(`hello exchange failed with ${where}: malformed hello: ${message}`);
  }
  if (err instanceof TransportError) {
    const code = codeOf(err);
    const network = code !== undefined ? NETWORK_ERRORS[code] : undefined;
    // A hop couldn't open the next connection: say so once, with the reason, not the library's sentence that names the hop again.
    const open = /^The (jump host \S+) could not open a connection to (\S+): (?:\(SSH\) Channel open failure: )?(.*)$/s.exec(message);
    if (open !== undefined && open !== null) {
      const reason = open[3]!.trim();
      return fail(`failed at ${open[1]}: it could not reach ${open[2]}${reason === '' ? '' : ` (${reason.charAt(0).toLowerCase()}${reason.slice(1)})`}`);
    }
    if (atJump) return fail(`${jumpPrefix}${network ?? message}`);
    if (/could not open a connection/i.test(message) && lastJump !== undefined) {
      return fail(`failed at jump host ${lastJump.host}:${lastJump.port ?? 22}: it could not reach ${where}`);
    }
    // "cannot reach" only for the network itself; anything else got further than that.
    return fail(network !== undefined ? `cannot reach ${where}: ${network}` : `connection to ${where} failed: ${message}`);
  }
  if (err instanceof CliError) return err;
  return fail(`connect to ${where} failed: ${message}`);
}

function codeOf(err: Error): string | undefined {
  let e: unknown = err;
  for (let i = 0; i < 5 && e instanceof Error; i++) {
    const code = (e as NodeJS.ErrnoException).code;
    if (typeof code === 'string' && !code.startsWith('ERR_NETCONF')) return code;
    e = e.cause;
  }
  return undefined;
}

function splitLabel(label: string): [string, number] {
  const hostPort = label.replace(/^jump host /, '');
  const i = hostPort.lastIndexOf(':');
  return [hostPort.slice(0, i), Number(hostPort.slice(i + 1))];
}

/** The `ssh` command that logs in to a jump host, for hints. */
function sshTo(jump: EndpointSpec): string {
  const port = jump.port === undefined || jump.port === 22 ? '' : `-p ${jump.port} `;
  return `ssh ${port}${jump.username === undefined ? '' : `${jump.username}@`}${jump.host}`;
}

/** The `ssh` command that logs in to the last of these jump hosts through the others (`ssh -J`), for hints. */
function sshThrough(jumps: readonly EndpointSpec[]): string {
  if (jumps.length === 1) return sshTo(jumps[0]!);
  const spec = (j: EndpointSpec): string => `${j.username === undefined ? '' : `${j.username}@`}${j.host}${j.port === undefined || j.port === 22 ? '' : `:${j.port}`}`;
  return `${sshTo(jumps.at(-1)!).replace(/^ssh /, `ssh -J ${jumps.slice(0, -1).map(spec).join(',')} `)}`;
}

function knownHostsName(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${port}`;
}
