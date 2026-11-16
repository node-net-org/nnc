/**
 * The targets file (docs/cli.md §8): named devices as data.
 *
 * Read from `--targets <path>`, else `$NNC_TARGETS`, else
 * `~/.config/net-netconf/targets.json`. Every field is checked, and an error
 * names the file, the target and the field. Passwords are never stored here:
 * only where to get one.
 */

import { MAX_PARSE_DEPTH, type CapabilityCheck, type XmlParseLimits } from '@node-net/netconf/core';
import { usageError } from './errors.js';
import type { NncHost } from './host.js';
import { expandHome } from './paths.js';

export type PasswordSource = { readonly file: string } | { readonly env: string } | { readonly prompt: true };

export interface EndpointSpec {
  readonly host: string;
  readonly port?: number;
  readonly username?: string;
  readonly password?: PasswordSource;
  /** Path of a private key file. */
  readonly privateKey?: string;
  readonly passphrase?: PasswordSource;
  /**
   * Use the SSH agent at `$SSH_AUTH_SOCK`. Default: use it when one is running and
   * the endpoint has no `password` or `privateKey` of its own.
   */
  readonly agent?: boolean;
  /**
   * `known-hosts` (the default), `insecure-accept-any`, or a pin: a `SHA256:`
   * fingerprint or a public key line, or a non-empty list of them.
   */
  readonly hostKey?: 'known-hosts' | 'insecure-accept-any' | HostKeyPin;
  /** known_hosts file to check against. Default `~/.ssh/known_hosts`. */
  readonly knownHosts?: string;
}

/** Pinned host keys: `SHA256:` fingerprints and/or public key lines, as the library's `hostKey` takes them. */
// `string & {}` keeps 'known-hosts' and 'insecure-accept-any' distinct in EndpointSpec['hostKey'], as the library's HostKeyPolicy does.
export type HostKeyPin = (string & {}) | readonly string[];

/** The pin of a `hostKey`, or undefined for known-hosts and insecure-accept-any. */
export function hostKeyPin(hostKey: EndpointSpec['hostKey']): HostKeyPin | undefined {
  return hostKey === undefined || hostKey === 'known-hosts' || hostKey === 'insecure-accept-any' ? undefined : hostKey;
}

export interface Timeouts {
  readonly connect?: number;
  readonly hello?: number;
  readonly rpc?: number;
  readonly close?: number;
}

/** NETCONF over TLS (RFC 7589): the fields match the library's `TlsOptions`. */
export interface TlsSpec {
  /** Path of our certificate (PEM). */
  readonly cert: string;
  /** Path of its private key (PEM). The key's passphrase is the target's `passphrase`. */
  readonly key: string;
  /** Paths of CA certificates to trust for the server. */
  readonly ca?: readonly string[];
  /** SHA-256 pins of the server certificate. */
  readonly fingerprint?: readonly string[];
  /** The name to check the server certificate against, if not `host`. */
  readonly serverName?: string;
  /** Skip verifying the server. */
  readonly insecure?: 'insecure-accept-any';
}

export interface Target extends EndpointSpec {
  readonly name: string;
  /** `ssh` (the default), `tls`, or `sim` (a simulated device the host provides). */
  readonly transport?: 'ssh' | 'tls' | 'sim';
  /** Set when `transport` is `sim`: the device's name, else the target's. */
  readonly device?: string;
  /** Set when `transport` is `tls`. */
  readonly tls?: TlsSpec;
  /** The jump hosts to go through, in order (`jumpHost` in the file: one object or a list). Empty for none. */
  readonly jumpHosts?: readonly EndpointSpec[];
  readonly profile?: string;
  readonly profilesDir?: string;
  readonly readOnly?: boolean;
  /** RPC element names allowed on a read-only target (the read-only guard). */
  readonly allowRpcs?: readonly string[];
  readonly timeouts?: Timeouts;
  /** Session options passed to the library's connect() under the same names (docs/cli.md §8). */
  readonly maxInFlight?: number;
  readonly maxMessageBytes?: number;
  readonly parseLimits?: XmlParseLimits;
  readonly capabilityCheck?: CapabilityCheck;
  readonly namespaces?: Readonly<Record<string, string>>;
  /** YANG schemas for RFC 7951 JSON output: module directories, and whether a schema-less conversion is refused. */
  readonly yang?: { readonly modules?: readonly string[]; readonly requireSchema?: boolean };
  /** The targets file the target came from (for hints); unset for ad hoc targets. */
  readonly file?: string;
  /** True for `user@host[:port]` connections that aren't in the targets file. */
  readonly adHoc?: boolean;
}

export function defaultTargetsPath(host: NncHost): string {
  return expandHome('~/.config/net-netconf/targets.json', host.homeDir);
}

export function targetsPath(host: NncHost, fromArgs: string | undefined): string {
  if (fromArgs !== undefined) return fromArgs;
  const env = host.env('NNC_TARGETS');
  return env !== undefined && env !== '' ? env : defaultTargetsPath(host);
}

export interface TargetsFile {
  readonly path: string;
  /** False when the file doesn't exist (not an error). */
  readonly exists: boolean;
  readonly targets: ReadonlyMap<string, Target>;
}

/** The target names in a targets file, sorted, unchecked; none if it can't be read (for Tab completion). */
export function targetNamesSync(host: NncHost, path: string): string[] {
  try {
    const json = JSON.parse(host.files.readTextSync(path)) as unknown;
    return typeof json === 'object' && json !== null && !Array.isArray(json) ? Object.keys(json).sort() : [];
  } catch {
    return [];
  }
}

export async function loadTargets(host: NncHost, path: string): Promise<TargetsFile> {
  let text: string;
  try {
    text = await host.files.readText(path);
  } catch (err) {
    if ((err as { code?: unknown }).code === 'ENOENT') return { path, exists: false, targets: new Map() };
    throw usageError(`targets file ${path}: cannot read it: ${(err as Error).message}`);
  }
  checkPin = host.transports.checkHostKey;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw usageError(`targets file ${path}: not valid JSON: ${(err as Error).message}`);
  }
  if (!isObject(json)) throw usageError(`targets file ${path}: must be a JSON object of target names to targets`);
  const targets = new Map<string, Target>();
  for (const [name, value] of Object.entries(json)) {
    targets.set(name, parseTarget(path, name, value));
  }
  return { path, exists: true, targets };
}

/** `user@host` or `user@host:port`, or undefined if `text` isn't in that form. */
export function parseAdHoc(text: string): Target | undefined {
  const m = /^([^@\s:]+)@([^@\s:]+)(?::(\d+))?$/.exec(text);
  if (m === null) return undefined;
  const port = m[3] === undefined ? 830 : Number(m[3]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw usageError(`port ${m[3]} is out of range`);
  return { name: m[2]!, host: m[2]!, port, username: m[1]!, adHoc: true };
}

// --- validation ---------------------------------------------------------------

type Fields = Record<string, unknown>;

const ENDPOINT_FIELDS = ['host', 'port', 'username', 'password', 'privateKey', 'passphrase', 'agent', 'hostKey', 'knownHosts'];
/** The library's connect() options a target may set (docs/cli.md §8). extensionCheck isn't one: nnc enables every module. */
const SESSION_FIELDS = ['maxInFlight', 'maxMessageBytes', 'parseLimits', 'capabilityCheck', 'namespaces', 'yang'];
const COMMON_FIELDS = ['host', 'port', 'profile', 'profilesDir', 'readOnly', 'allowRpcs', 'timeouts', 'transport', ...SESSION_FIELDS];
const TARGET_FIELDS = [...new Set([...ENDPOINT_FIELDS, ...COMMON_FIELDS, 'jumpHost'])];
/** Fields of a `"transport": "tls"` target. Credentials are the certificate and key; there is no username or password. */
const TLS_FIELDS = [...COMMON_FIELDS, 'cert', 'key', 'passphrase', 'ca', 'fingerprint', 'serverName', 'insecure'];
const TLS_ONLY = ['cert', 'key', 'ca', 'fingerprint', 'serverName', 'insecure'];
const TIMEOUT_FIELDS = ['connect', 'hello', 'rpc', 'close'];

function isObject(v: unknown): v is Fields {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseTarget(file: string, name: string, value: unknown): Target {
  const fail = (field: string, message: string): never => {
    throw usageError(`targets file ${file}: target "${name}": field "${field}" ${message}`);
  };
  if (!isObject(value)) throw usageError(`targets file ${file}: target "${name}" must be an object`);
  const transport = value['transport'];
  if (transport !== undefined && transport !== 'ssh' && transport !== 'tls' && transport !== 'sim') fail('transport', 'must be "ssh", "tls" or "sim"');
  if (transport === 'tls') return { ...parseTlsTarget(value, name, fail), file };
  if (transport === 'sim') return { ...parseSimTarget(value, name, fail), file };
  for (const key of TLS_ONLY) {
    if (value[key] !== undefined) fail(key, 'is only for "transport": "tls" targets');
  }
  return { ...parseSshTarget(value, name, fail), file };
}

function parseSshTarget(value: Fields, name: string, fail: (f: string, m: string) => never): Target {
  checkKnown(value, TARGET_FIELDS, '', fail);
  const endpoint = parseEndpoint(value, '', 830, fail);
  const target: { -readonly [K in keyof Target]: Target[K] } = { name, ...endpoint };
  if (value['jumpHost'] !== undefined) {
    const jump = value['jumpHost'];
    // One jump host is an object (fields named jumpHost.x); a chain is a list (jumpHost[i].x).
    const hop = (j: unknown, prefix: string): EndpointSpec => {
      if (!isObject(j)) fail(prefix.slice(0, -1), 'must be an object');
      checkKnown(j, ENDPOINT_FIELDS, prefix, fail);
      return parseEndpoint(j, prefix, 22, fail);
    };
    if (Array.isArray(jump)) {
      if (jump.length === 0) fail('jumpHost', 'must be an object, or a non-empty list of them');
      target.jumpHosts = jump.map((j, i) => hop(j, `jumpHost[${i}].`));
    } else {
      if (!isObject(jump)) fail('jumpHost', 'must be an object, or a list of them for a chain');
      target.jumpHosts = [hop(jump, 'jumpHost.')];
    }
  }
  const profile = optString(value, 'profile', '', fail);
  if (profile !== undefined) target.profile = profile;
  const profilesDir = optString(value, 'profilesDir', '', fail);
  if (profilesDir !== undefined) target.profilesDir = profilesDir;
  if (value['readOnly'] !== undefined) {
    if (typeof value['readOnly'] !== 'boolean') fail('readOnly', 'must be true or false');
    target.readOnly = value['readOnly'];
  }
  if (value['allowRpcs'] !== undefined) {
    const a = value['allowRpcs'];
    if (!Array.isArray(a) || !a.every((x) => typeof x === 'string' && x !== '')) fail('allowRpcs', 'must be a list of RPC element names');
    target.allowRpcs = a as string[];
  }
  if (value['timeouts'] !== undefined) {
    const t = value['timeouts'];
    if (!isObject(t)) fail('timeouts', 'must be an object');
    const tf = t;
    checkKnown(tf, TIMEOUT_FIELDS, 'timeouts.', fail);
    const timeouts: Record<string, number> = {};
    for (const k of TIMEOUT_FIELDS) {
      const v = tf[k];
      if (v === undefined) continue;
      if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) fail(`timeouts.${k}`, 'must be a positive whole number of milliseconds');
      timeouts[k] = v;
    }
    target.timeouts = timeouts;
  }
  parseSessionOptions(value, target, fail);
  return target;
}

type SessionOptions = Pick<Target, 'maxInFlight' | 'maxMessageBytes' | 'parseLimits' | 'capabilityCheck' | 'namespaces' | 'yang'>;

/** The connect() options a target may set: checked, then copied onto the target. */
function parseSessionOptions(value: Fields, target: { -readonly [K in keyof SessionOptions]: SessionOptions[K] }, fail: (f: string, m: string) => never): void {
  const positive = (v: unknown, field: string): number => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) fail(field, 'must be a positive whole number');
    return v;
  };
  if (value['maxInFlight'] !== undefined) target.maxInFlight = positive(value['maxInFlight'], 'maxInFlight');
  if (value['maxMessageBytes'] !== undefined) target.maxMessageBytes = positive(value['maxMessageBytes'], 'maxMessageBytes');
  if (value['parseLimits'] !== undefined) {
    const p = value['parseLimits'];
    if (!isObject(p)) fail('parseLimits', 'must be an object with maxDepth and/or maxNodes');
    checkKnown(p, ['maxDepth', 'maxNodes'], 'parseLimits.', fail);
    const limits: { maxDepth?: number; maxNodes?: number } = {};
    if (p['maxDepth'] !== undefined) {
      limits.maxDepth = positive(p['maxDepth'], 'parseLimits.maxDepth');
      if (limits.maxDepth > MAX_PARSE_DEPTH) fail('parseLimits.maxDepth', `must be at most ${MAX_PARSE_DEPTH}`);
    }
    if (p['maxNodes'] !== undefined) limits.maxNodes = positive(p['maxNodes'], 'parseLimits.maxNodes');
    target.parseLimits = limits;
  }
  if (value['capabilityCheck'] !== undefined) {
    const c = value['capabilityCheck'];
    if (c !== 'strict' && c !== 'warn' && c !== 'off') fail('capabilityCheck', 'must be "strict", "warn" or "off"');
    target.capabilityCheck = c;
  }
  if (value['namespaces'] !== undefined) {
    const n = value['namespaces'];
    if (!isObject(n) || !Object.entries(n).every(([k, v]) => k !== '' && typeof v === 'string' && v !== '')) {
      fail('namespaces', 'must be an object of YANG module names to namespaces (non-empty strings)');
    }
    target.namespaces = n as Record<string, string>;
  }
  if (value['yang'] !== undefined) {
    const y = value['yang'];
    if (!isObject(y)) fail('yang', 'must be an object with modules and/or requireSchema');
    checkKnown(y, ['modules', 'requireSchema'], 'yang.', fail);
    const m = y['modules'];
    if (m !== undefined && (!Array.isArray(m) || !m.every((d) => typeof d === 'string' && d !== ''))) fail('yang.modules', 'must be a list of directories');
    const r = y['requireSchema'];
    if (r !== undefined && typeof r !== 'boolean') fail('yang.requireSchema', 'must be true or false');
    target.yang = { ...(m !== undefined ? { modules: m as string[] } : {}), ...(r !== undefined ? { requireSchema: r } : {}) };
  }
}

/** Fields of a `"transport": "sim"` target: a simulated device the host provides, so no endpoint or credentials. */
const SIM_FIELDS = ['transport', 'device', 'profile', 'profilesDir', 'readOnly', 'allowRpcs', 'timeouts', ...SESSION_FIELDS];

function parseSimTarget(value: Fields, name: string, fail: (f: string, m: string) => never): Target {
  for (const key of Object.keys(value)) {
    if (!SIM_FIELDS.includes(key)) {
      fail(key, TARGET_FIELDS.includes(key) || TLS_FIELDS.includes(key) ? 'is not used by "transport": "sim" targets (the host provides the device)' : 'is not a known field');
    }
  }
  const device = optString(value, 'device', '', fail);
  // The common fields are checked as for SSH, with a placeholder endpoint that is then dropped.
  const shared = Object.fromEntries(Object.entries(value).filter(([k]) => k !== 'transport' && k !== 'device'));
  const { host: _host, port: _port, ...common } = parseSshTarget({ host: 'sim', ...shared }, name, fail);
  const shownAs = `sim:${device ?? name}`;
  return { ...common, host: shownAs, port: 0, transport: 'sim', ...(device !== undefined ? { device } : {}) };
}

function parseTlsTarget(value: Fields, name: string, fail: (f: string, m: string) => never): Target {
  for (const key of Object.keys(value)) {
    if (!TLS_FIELDS.includes(key)) {
      fail(key, TARGET_FIELDS.includes(key) ? 'is not used by "transport": "tls" targets (the client certificate is the credential)' : 'is not a known field');
    }
  }
  // host, port, passphrase and the common fields are checked as for SSH; then the TLS fields.
  const shared = ['host', 'port', 'passphrase', 'profile', 'profilesDir', 'readOnly', 'allowRpcs', 'timeouts', ...SESSION_FIELDS];
  const subset: Fields = Object.fromEntries(Object.entries(value).filter(([k]) => shared.includes(k)));
  const common = parseSshTarget({ port: 6513, ...subset }, name, fail);
  const cert = optString(value, 'cert', '', fail);
  if (cert === undefined) fail('cert', 'is required: the path of the client certificate (PEM)');
  const key = optString(value, 'key', '', fail);
  if (key === undefined) fail('key', "is required: the path of the client certificate's private key (PEM)");
  const list = (field: string, what: string): string[] | undefined => {
    const v = value[field];
    if (v === undefined) return undefined;
    const items = typeof v === 'string' ? [v] : v;
    if (!Array.isArray(items) || items.length === 0 || !items.every((x) => typeof x === 'string' && x !== '')) {
      fail(field, `must be ${what}, or a non-empty list of them`);
    }
    return items as string[];
  };
  const ca = list('ca', 'the path of a CA certificate (PEM)');
  const fingerprint = list('fingerprint', 'a SHA-256 fingerprint');
  const serverName = optString(value, 'serverName', '', fail);
  const insecure = value['insecure'];
  if (insecure !== undefined && insecure !== 'insecure-accept-any') fail('insecure', 'must be "insecure-accept-any"');
  if (insecure !== undefined && (ca !== undefined || fingerprint !== undefined)) fail('insecure', 'cannot be combined with ca or fingerprint');
  if (insecure === undefined && ca === undefined && fingerprint === undefined) {
    fail('ca', 'or fingerprint is required, to verify the server (or "insecure": "insecure-accept-any")');
  }
  const { host, port, passphrase, profile, profilesDir, readOnly, allowRpcs, timeouts, maxInFlight, maxMessageBytes, parseLimits, capabilityCheck, namespaces, yang } = common;
  return {
    name,
    ...(yang !== undefined ? { yang } : {}),
    ...(maxInFlight !== undefined ? { maxInFlight } : {}),
    ...(maxMessageBytes !== undefined ? { maxMessageBytes } : {}),
    ...(parseLimits !== undefined ? { parseLimits } : {}),
    ...(capabilityCheck !== undefined ? { capabilityCheck } : {}),
    ...(namespaces !== undefined ? { namespaces } : {}),
    host,
    transport: 'tls',
    ...(port !== undefined ? { port } : {}),
    ...(passphrase !== undefined ? { passphrase } : {}),
    ...(profile !== undefined ? { profile } : {}),
    ...(profilesDir !== undefined ? { profilesDir } : {}),
    ...(readOnly !== undefined ? { readOnly } : {}),
    ...(allowRpcs !== undefined ? { allowRpcs } : {}),
    ...(timeouts !== undefined ? { timeouts } : {}),
    tls: {
      cert: cert,
      key: key,
      ...(ca !== undefined ? { ca } : {}),
      ...(fingerprint !== undefined ? { fingerprint } : {}),
      ...(serverName !== undefined ? { serverName } : {}),
      ...(insecure !== undefined ? { insecure: 'insecure-accept-any' as const } : {}),
    },
  };
}

function checkKnown(value: Fields, known: readonly string[], prefix: string, fail: (f: string, m: string) => never): void {
  for (const key of Object.keys(value)) {
    if (!known.includes(key)) fail(`${prefix}${key}`, 'is not a known field');
  }
}

function optString(value: Fields, key: string, prefix: string, fail: (f: string, m: string) => never): string | undefined {
  const v = value[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || v === '') fail(`${prefix}${key}`, 'must be a non-empty string');
  return v;
}

function parseEndpoint(value: Fields, prefix: string, defaultPort: number, fail: (f: string, m: string) => never): EndpointSpec {
  const host = optString(value, 'host', prefix, fail);
  if (host === undefined) fail(`${prefix}host`, 'is required');
  const out: { -readonly [K in keyof EndpointSpec]: EndpointSpec[K] } = { host: host, port: defaultPort };
  if (value['port'] !== undefined) {
    const p = value['port'];
    if (typeof p !== 'number' || !Number.isInteger(p) || p < 1 || p > 65535) fail(`${prefix}port`, 'must be a whole number from 1 to 65535');
    out.port = p;
  }
  const username = optString(value, 'username', prefix, fail);
  if (username !== undefined) out.username = username;
  const password = parsePasswordSource(value['password'], `${prefix}password`, fail);
  if (password !== undefined) out.password = password;
  const passphrase = parsePasswordSource(value['passphrase'], `${prefix}passphrase`, fail);
  if (passphrase !== undefined) out.passphrase = passphrase;
  const privateKey = optString(value, 'privateKey', prefix, fail);
  if (privateKey !== undefined) out.privateKey = privateKey;
  if (value['agent'] !== undefined) {
    if (typeof value['agent'] !== 'boolean') fail(`${prefix}agent`, 'must be true or false');
    out.agent = value['agent'];
  }
  const hostKey = parseHostKey(value['hostKey'], `${prefix}hostKey`, fail);
  if (hostKey !== undefined) out.hostKey = hostKey;
  const knownHosts = optString(value, 'knownHosts', prefix, fail);
  if (knownHosts !== undefined) {
    if (hostKeyPin(out.hostKey) !== undefined) fail(`${prefix}knownHosts`, 'cannot be used with a pinned hostKey: the pin is the only key accepted');
    out.knownHosts = knownHosts;
  }
  return out;
}

/** The host's check of host-key pins, for the targets file being read now (loadTargets sets it). */
let checkPin: ((pin: string | readonly string[]) => void) | undefined;

const HOST_KEY_FORMS ='"known-hosts", "insecure-accept-any", a SHA256: fingerprint or public key line, or a non-empty list of them';

function parseHostKey(h: unknown, field: string, fail: (f: string, m: string) => never): EndpointSpec['hostKey'] {
  if (h === undefined) return undefined;
  if (h === 'known-hosts' || h === 'insecure-accept-any') return h;
  const pin = typeof h === 'string' && h !== '' ? h : Array.isArray(h) && h.every((e) => typeof e === 'string') ? h : undefined;
  if (pin === undefined) fail(field, `must be ${HOST_KEY_FORMS}`);
  if (Array.isArray(pin) && pin.length === 0) fail(field, 'must not be an empty list: pin at least one fingerprint or key line');
  try {
    // The host's transports check it (the library's own check in Node), so a pin nnc accepts is one ssh() accepts.
    checkPin?.(pin);
  } catch (err) {
    fail(field, `must be ${HOST_KEY_FORMS}: ${(err as Error).message.replace(/^hostKey: /, '')}`);
  }
  return pin;
}

function parsePasswordSource(v: unknown, field: string, fail: (f: string, m: string) => never): PasswordSource | undefined {
  if (v === undefined) return undefined;
  if (typeof v === 'string') {
    fail(field, 'must not hold a password itself: use { "file": path }, { "env": variable } or { "prompt": true }');
  }
  if (!isObject(v)) fail(field, 'must be { "file": path }, { "env": variable } or { "prompt": true }');
  const o = v;
  const keys = Object.keys(o);
  if (keys.length !== 1) fail(field, 'must have exactly one of "file", "env" or "prompt"');
  if (typeof o['file'] === 'string' && o['file'] !== '') return { file: o['file'] };
  if (typeof o['env'] === 'string' && o['env'] !== '') return { env: o['env'] };
  if (o['prompt'] === true) return { prompt: true };
  return fail(field, 'must be { "file": path }, { "env": variable } or { "prompt": true }');
}
