/**
 * Open a client session to a target (docs/cli.md §4, §8): choose the device
 * profile, reach the target through the host's transports (SSH and TLS in the
 * Node host, src/node/transports.ts; an in-process device for a sim target),
 * and wrap the client as the CLI's session with its hello capture, trace and
 * notifications. Failures are explained by the transport that met them
 * (SESS-07).
 */

import {
  autoDetect,
  builtinDeviceProfiles,
  connect,
  DEFAULT_TIMEOUTS,
  type AutoDetect,
  type Connection,
  type ConnectionFactory,
  type ConnectOptions,
  type DeviceProfile,
  type Logger,
  type NetconfClient,
} from '@node-net/netconf/core';
import { compare } from '@node-net/netconf/operations/compare';
import { monitoring } from '@node-net/netconf/operations/monitoring';
import { nmda } from '@node-net/netconf/operations/nmda';
import { notifications } from '@node-net/netconf/operations/notifications';
import { partialLock } from '@node-net/netconf/operations/partial-lock';
import { subscriptions } from '@node-net/netconf/operations/subscriptions';
import { withDefaults } from '@node-net/netconf/operations/with-defaults';
import { yangLibrary } from '@node-net/netconf/operations/yang-library';
import { CliError, EXIT } from '../errors.js';
import type { NncHost, SecretPrompt } from '../host.js';
import { expandHome } from '../paths.js';
import type { Target } from '../targets.js';
import type { ShownItem } from '../render/notifications.js';
import { MessageLog, type ActiveSession } from './active.js';
import { SessionSubscriptions } from './subscriptions.js';
import { HelloCapture, recordingConnection, type Recorder } from './recording.js';

/** The library's extensions. Their operations become commands from their descriptors. */
export const EXTENSIONS = [withDefaults, monitoring, nmda, yangLibrary, notifications, partialLock, subscriptions, compare] as const;

export interface ConnectRequest {
  /** Where nnc runs: its transports reach the target, and it may load a target's profiles. */
  readonly host: NncHost;
  readonly target: Target;
  readonly readOnly: boolean;
  readonly signal: AbortSignal;
  readonly prompt: SecretPrompt;
  /** Called for each notification while nobody is following them (1-based number). */
  /** A notification, subscription update or subscription end to show above the prompt. */
  readonly onNotification: (session: ActiveSession, item: ShownItem) => void;
  /** Called when the session closes without `disconnect` (the server or the connection ended it). */
  readonly onLost: (session: ActiveSession, cause: Error | undefined) => void;
  /** Called with each warning the library logs (from capabilityCheck "warn", a failed unlock, and the like). */
  readonly onWarning?: (text: string) => void;
  /** Also watch the connection's bytes (the trace). Created when the connection opens; it feeds `log` the messages received. */
  readonly recorder?: (log: MessageLog) => Recorder;
}

export async function openClientSession(req: ConnectRequest): Promise<ActiveSession> {
  const device = await chooseProfile(req.host, req.target);
  return req.host.transports.reach(req.target, req.prompt, (factory, port, shape, describe) => establish(req, device, port, factory, shape, describe));
}

/** What a framed or raw session needs to open its connection (docs/cli.md §11). */
export interface ConnectionRequest {
  readonly host: NncHost;
  readonly target: Target;
  readonly signal: AbortSignal;
  readonly prompt: SecretPrompt;
}

/** A connection opened through the same host-key, certificate and credential checks as a client session. */
export interface OpenedConnection {
  readonly connection: Connection;
  readonly port: number;
  readonly shape: SessionShape;
}

/**
 * Open the transport only (SSH netconf subsystem, TLS, or a sim device), for
 * framed and raw sessions: nothing is sent. Failures are explained as for
 * client sessions.
 */
export function openConnection(req: ConnectionRequest): Promise<OpenedConnection> {
  const { target } = req;
  const ms = target.timeouts?.connect ?? DEFAULT_TIMEOUTS.connect;
  return req.host.transports.reach(target, req.prompt, async (factory, port, shape, describe) => {
    const timer = AbortSignal.timeout(ms);
    try {
      return { connection: await factory(AbortSignal.any([req.signal, timer])), port, shape };
    } catch (err) {
      if (timer.aborted && !req.signal.aborted) {
        throw new CliError(`cannot reach ${target.transport === 'sim' ? `sim:${simDevice(target)}` : `${target.host}:${port}`}: timed out (no connection within ${ms} ms)`, EXIT.connection);
      }
      throw describe(err);
    }
  });
}

/** One way of using a prepared transport: a client session, or a bare connection. */
export type Use<T> = (factory: ConnectionFactory, port: number, shape: SessionShape, describe: (err: unknown) => Error) => Promise<T>;

/** How a session was reached, for the connect line and status. */
export interface SessionShape {
  readonly via: string | undefined;
  readonly insecure: boolean;
  readonly transport: 'ssh' | 'tls' | 'sim';
}

/** The simulated device a sim target names: its `device`, else the target's name. */
export function simDevice(target: Target): string {
  return target.device ?? target.name;
}

/** Connect over `factory` and wrap the client as the CLI's session. `describe` turns a failure into a plain message. */
/** @internal */
export async function establish(
  req: ConnectRequest,
  device: DeviceProfile | AutoDetect,
  port: number,
  factory: ConnectionFactory,
  shape: SessionShape,
  describe: (err: unknown) => Error,
): Promise<ActiveSession> {
  const watch = watchSession(req);
  let client: NetconfClient;
  try {
    client = await (req.host.connect ?? connect)({
      ...clientOptions(req.target, device, watch.logger),
      transport: async (signal) => watch.wrap(await factory(signal)),
      signal: req.signal,
    });
  } catch (err) {
    throw describe(err);
  }
  return toSession(req, client, watch, device, { host: req.target.host, port, shape, calledHome: false });
}

/** What watches a client session's connection: the hello as received, the messages received, the trace, and the library's log. */
/** @internal */
export interface SessionWatch {
  readonly capture: HelloCapture;
  readonly received: MessageLog;
  readonly logger: Logger;
  /** Wrap the connection so the hello, the messages and the trace are seen. */
  wrap(inner: Connection): Connection;
  /** The connection wrapped, once there is one. */
  readonly connection: Connection | undefined;
  /** The session, once it exists (the logger notes a missed close-session reply on it). */
  session: ActiveSession | undefined;
}

/** @internal */
export function watchSession(req: ConnectRequest): SessionWatch {
  const watch: SessionWatch = {
    capture: new HelloCapture(),
    received: new MessageLog(),
    // The session's close() never rejects; its debug log is the only sign the close-session reply didn't come.
    logger: {
      warn: (message, data) => {
        const err = (data as { err?: unknown } | undefined)?.err;
        req.onWarning?.(err instanceof Error ? `${message}: ${err.message}` : message);
      },
      debug: (message) => {
        if (message.startsWith('close-session did not complete') && watch.session !== undefined) watch.session.closeReplyMissed = true;
      },
    },
    connection: undefined,
    session: undefined,
    wrap(inner) {
      const wrapped =
        req.recorder === undefined ? recordingConnection(inner, watch.capture) : recordingConnection(inner, watch.capture, req.recorder(watch.received));
      (watch as { connection: Connection | undefined }).connection = wrapped;
      return wrapped;
    },
  };
  return watch;
}

/** The library connect() options a target gives, apart from the transport and signal. */
/** @internal */
export function clientOptions(target: Target, profile: DeviceProfile | AutoDetect, logger: Logger): Omit<ConnectOptions<typeof EXTENSIONS>, 'transport' | 'signal'> {
  return {
    profile,
    logger,
    // Every extension, on every device: its operations are listed whatever the device
    // supports, and each is still checked against the device's capabilities before it is sent
    // (capabilityCheck). So extensionCheck stays 'off' and isn't a target field.
    extensions: EXTENSIONS,
    extensionCheck: 'off',
    ...(target.maxInFlight !== undefined ? { maxInFlight: target.maxInFlight } : {}),
    ...(target.maxMessageBytes !== undefined ? { maxMessageBytes: target.maxMessageBytes } : {}),
    ...(target.parseLimits !== undefined ? { parseLimits: target.parseLimits } : {}),
    ...(target.capabilityCheck !== undefined ? { capabilityCheck: target.capabilityCheck } : {}),
    ...(target.namespaces !== undefined ? { namespaces: target.namespaces } : {}),
    ...(target.yang !== undefined ? { yang: target.yang } : {}),
    ...(target.timeouts !== undefined ? { timeouts: target.timeouts } : {}),
  };
}

/** Where a session reached its device. For a call home, the caller's address. */
/** @internal */
export interface SessionPlace {
  readonly host: string;
  readonly port: number;
  readonly shape: SessionShape;
  readonly calledHome: boolean;
}

/** Wrap a connected client as the CLI's session, and route its notifications and close. */
/** @internal */
export function toSession(req: ConnectRequest, client: NetconfClient, watch: SessionWatch, device: DeviceProfile | AutoDetect, place: SessionPlace): ActiveSession {
  const { target } = req;
  const profileId = client.profile?.id;
  const session: ActiveSession = {
    kind: 'client',
    name: target.name,
    target,
    host: place.host,
    port: place.port,
    via: place.shape.via,
    transport: place.shape.transport,
    calledHome: place.calledHome,
    client,
    readOnly: req.readOnly || target.readOnly === true,
    insecure: place.shape.insecure,
    fingerprint: watch.connection?.peer.identity,
    rawHello: watch.capture.hello,
    received: watch.received,
    profile: profileId,
    profileSource: profileId === undefined ? 'none' : 'autoDetect' in device ? 'detected' : 'named',
    considered: 'autoDetect' in device ? [...new Set(device.autoDetect.map((p) => p.id))] : [],
    connectedAt: new Date(),
    disconnecting: false,
    closeReplyMissed: false,
    locks: new Set(),
    confirmedCommit: undefined,
    transaction: undefined,
    pending: undefined,
    notifications: [],
    followers: new Set(),
    // `notifications --follow` takes what would be shown above the prompt while it runs.
    subscriptions: new SessionSubscriptions(client, (item) => {
      if (session.followers.size > 0) for (const follow of session.followers) follow(item);
      else req.onNotification(session, item);
    }),
  };
  watch.session = session;
  client.session.on('notification', (notification) => {
    session.notifications.push(notification);
    session.subscriptions.received(notification, session.notifications.length);
  });
  client.session.on('closed', ({ cause }) => {
    if (!session.disconnecting) req.onLost(session, cause);
  });
  return session;
}


// --- call home ---------------------------------------------------------------------------

/** What `listen` needs: a client session's request, plus where to listen and how to report calls it refuses. */
export interface ListenRequest extends ConnectRequest {
  /** Default 4334 (SSH) or 4335 (TLS). */
  readonly port?: number;
  /** Interface address. Default: all. */
  readonly address?: string;
  /** Stop waiting after this many milliseconds. Default: wait until the signal aborts. */
  readonly timeout?: number;
  /** Called once listening, with where. */
  readonly onListening: (where: string) => void;
  /** Called for each call refused or failed while waiting. */
  readonly onRefused: (text: string) => void;
}

/**
 * Wait for the target's device to call home (RFC 8071) and open a client
 * session on that call, as `connect` would (docs/cli.md §4). Only a host that
 * can listen offers it: the Node host's transports do (src/node/transports.ts).
 */
export function openCalledHomeSession(req: ListenRequest): Promise<ActiveSession> {
  const listen = req.host.transports.listen;
  if (listen === undefined) return Promise.reject(new CliError('listen: waiting for a device to call home is not available here', EXIT.usage));
  return listen(req);
}

// --- profiles --------------------------------------------------------------------------

/** @internal The profile a target names, else auto-detection among the built-ins and the target's profilesDir. */
export async function chooseProfile(host: NncHost, target: Target): Promise<DeviceProfile | AutoDetect> {
  const profiles = [...(await builtinDeviceProfiles())];
  if (target.profilesDir !== undefined) {
    const dir = expandHome(target.profilesDir, host.homeDir);
    if (host.loadProfiles === undefined) throw new CliError(`target "${target.name}": profilesDir needs files, and there are none here`, EXIT.usage);
    try {
      profiles.unshift(...(await host.loadProfiles(dir)));
    } catch (err) {
      throw new CliError(`target "${target.name}": cannot load profiles from ${dir}: ${(err as Error).message}`, EXIT.usage);
    }
  }
  if (target.profile === undefined) return autoDetect(profiles);
  const named = profiles.find((p) => p.id === target.profile);
  if (named === undefined) {
    const known = [...new Set(profiles.map((p) => p.id))].sort().join(', ');
    throw new CliError(`target "${target.name}": unknown profile "${target.profile}" (known profiles: ${known})`, EXIT.usage);
  }
  return named;
}

