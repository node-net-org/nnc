/**
 * Commands built from operation descriptors (docs/cli.md §7).
 *
 * Every NETCONF operation the session's client describes becomes a command:
 * its arguments, checks, help and completion all come from the descriptor,
 * so a new operation needs no CLI code. The library builds the request and
 * checks capabilities (client.ops.run); the CLI converts words into the
 * descriptor's argument values and refuses mistakes before anything is sent.
 */

import { AbortError, parseXml, PathError, subtree, xpath, type JsonDatastore, type OperationDescriptor, type ParamDescriptor, type XmlElement } from '@node-net/netconf/core';
import { NMDA_COMPARE_NS } from '@node-net/netconf/operations/compare';
import { NMDA_NS } from '@node-net/netconf/operations/nmda';
import type { SubscriptionsOps } from '@node-net/netconf/operations/subscriptions';
import type { YangLibraryContent } from '@node-net/netconf/operations/yang-library';
import { CliError } from '../errors.js';
import { guardOperation } from '../guard.js';
import type { ActiveSession } from '../sessions/active.js';
import type { Cli } from '../cli.js';
import type { ArgSpec, Command, CommandResult, OptionSpec, OptionValue, ParsedArgs } from './registry.js';
import { compareForms } from '../render/compare.js';
import { subscriptionJson, subscriptionWhat } from '../render/notifications.js';
import { namespacesIn, originsForms } from '../render/origins.js';
import { toJson } from '../render/safe.js';
import { prettyXml } from '../render/xml.js';
import { JSON_OPTION, OUTPUT_OPTIONS, renderResult, send, wantsJson } from './results.js';
import { EDIT_OPTION, TIMEOUT_OPTION, editXml, timeoutOf, xmlText as readXmlArg, type FileSource } from './xml-input.js';

const DATASTORES = ['running', 'candidate', 'startup'];
const URL_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;

/** `confirmTimeout` → `confirm-timeout`. */
export function kebab(name: string): string {
  return name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/** Operations offered as commands: the client's own, not device profile ones (`device`) or close-session (`disconnect`). */
export function operationsOf(session: ActiveSession): OperationDescriptor[] {
  return session.client.ops.list.filter((d) => d.device === undefined && d.name !== 'close-session');
}

/** The capabilities an operation always needs that the device doesn't advertise. */
export function missingCapabilities(session: ActiveSession, d: OperationDescriptor): string[] {
  return d.requires.filter((c) => !session.client.session.serverCapabilities.has(c));
}

function placeholder(p: ParamDescriptor): string {
  switch (p.type) {
    case 'filter':
      return 'subtree <xml> | xpath <expr>';
    case 'xpath':
      return '<yang-path>|<xpath>';
    case 'xml':
      return '<xml>|@file';
    case 'config-source':
      return '<datastore>|<url>|<config>';
    case 'config-target':
      return '<datastore>|<url>';
    default:
      return p.values !== undefined ? p.values.join('|') : `<${p.type}>`;
  }
}

/** A command for one operation. */
export function operationCommand(d: OperationDescriptor): Command {
  const positional = d.params.filter((p) => p.kind === 'positional');
  // --edit writes the first XML parameter (edit-config's config, a filter's subtree aside).
  const editParam = d.params.find((p) => p.type === 'xml' || p.type === 'config-source');
  const args: ArgSpec[] = positional.map((p, i) => ({
    name: kebab(p.name),
    description: p.description,
    // With --edit, the XML argument comes from the editor; its absence is checked when the command runs.
    optional: p.required !== true || p === editParam,
    // A repeatable last argument takes the remaining words.
    ...(p.multiple === true && i === positional.length - 1 ? { variadic: true } : {}),
  }));
  const options: Record<string, OptionSpec> = {};
  for (const p of d.params.filter((x) => x.kind === 'option')) {
    options[kebab(p.name)] = {
      type: p.type === 'boolean' ? 'boolean' : 'string',
      description: p.description,
      value: placeholder(p),
      ...(p.type === 'filter' ? { arity: 2 as const } : {}),
      ...(p.multiple === true ? { multiple: true } : {}),
    };
  }
  // The output options; an operation with a parameter of the same name (json, say) keeps it.
  // An extension read resolves with decoded data, shown as JSON: it has no XML or raw reply to show.
  for (const [name, spec] of Object.entries(OUTPUT_OPTIONS)) {
    if (d.kind === 'read' && (name === 'xml' || name === 'raw')) continue;
    options[name] ??= spec;
  }
  const json = options['json'] === JSON_OPTION;
  options['timeout'] ??= TIMEOUT_OPTION;
  if (editParam !== undefined) options['edit'] ??= EDIT_OPTION;
  return {
    name: d.name,
    summary: summaryOf(d),
    args,
    options,
    kinds: ['client'],
    group: 'operations',
    example: exampleOf(d),
    async run(cli, typed, signal) {
      const s = cli.session;
      if (s === undefined) throw new CliError('not connected');
      const timeout = timeoutOf(typed, d.name);
      const parsed = await withEditedXml(cli, d, editParam, positional, typed);
      // Refuse on a read-only target before converting: converting may read the YANG library.
      guardOperation(s, d, d.name);
      const values = await convertArgs(s, cli.host, d, positional, parsed, { signal, ...(timeout !== undefined ? { timeout } : {}) });
      if (d.name === 'kill-session' && values['sessionId'] === s.client.session.sessionId) {
        throw new CliError(`kill-session: ${s.client.session.sessionId} is this session; use disconnect to close it`);
      }
      // What --edit starts from next time: the XML as sent (after the guard, so a refusal doesn't count).
      if (editParam !== undefined) {
        const given = editParam.kind === 'positional' ? parsed.positional[positional.indexOf(editParam)] : parsed.options[kebab(editParam.name)];
        if (typeof given === 'string' && (given.startsWith('<') || given.startsWith('@'))) {
          cli.lastXml.set(d.name, await xmlText(cli.host, given, d.name, kebab(editParam.name)));
        }
      }
      const rpc = { signal, ...(timeout !== undefined ? { timeout } : {}) };
      const subscriptionOp = SUBSCRIPTION_OPERATIONS[d.name];
      if (subscriptionOp !== undefined) {
        const shown = await send(() => subscriptionOp(s, values, rpc));
        if (!json && shown !== undefined && 'forms' in shown && shown.forms !== undefined) {
          const { json: _json, ...forms } = shown.forms;
          return { ...shown, forms };
        }
        return shown;
      }
      const result = await send(() => s.client.ops.run(d.name, values, rpc));
      remember(s, d.name, values);
      let shown = renderResult(result);
      // YANG data as RFC 7951 JSON, typed by the device's schema. Converting may read the schemas, so it is
      // done now only when JSON is what will be shown, and otherwise left for show-last --json.
      const datastore = YANG_DATA_READS[d.name]?.(values);
      if (datastore !== undefined && json && isReply(result) && shown !== undefined && 'forms' in shown && shown.forms !== undefined) {
        const reply = result.element;
        const data = reply.elements.find((e) => e.name === 'data');
        if (data !== undefined) {
          const convert = async (): Promise<string> => toJson(await s.client.content.toJson(data, { datastore, scope: reply.declarations }), 2);
          shown = wantsJson(cli, typed)
            ? { ...shown, forms: { ...shown.forms, json: await send(convert) } }
            : { ...shown, forms: { ...shown.forms, jsonLater: convert } };
        }
      }
      const view = d.namespace !== undefined ? RESULT_VIEWS[d.namespace] : undefined;
      // Worked out even with --xml or --raw: show-last shows the view afterwards.
      if (view !== undefined && shown !== undefined && 'forms' in shown && shown.forms !== undefined && isReply(result)) {
        const forms = await view(result.element, values, s, { signal, ...(timeout !== undefined ? { timeout } : {}) });
        if (forms !== undefined) shown = { ...shown, forms: { ...shown.forms, ...forms } };
      }
      if (!json && shown !== undefined && 'forms' in shown && shown.forms !== undefined) {
        // --json belongs to the operation: there is no JSON form of its result.
        const { json: _json, ...forms } = shown.forms;
        return { ...shown, forms };
      }
      return shown;
    },
  };
}

// --- dynamic subscriptions (OPS-15) ---------------------------------------------------------

type SubscriptionOperation = (s: ActiveSession, values: Readonly<Record<string, unknown>>, rpc: Rpc) => Promise<CommandResult>;

function subscriptionsOf(s: ActiveSession): SubscriptionsOps {
  const ops = (s.client.ops as { readonly subscriptions?: SubscriptionsOps }).subscriptions;
  if (ops === undefined) throw new CliError('the subscriptions extension is not enabled in this session');
  return ops;
}

/**
 * The subscription operations nnc runs through the library rather than as bare
 * RPCs, so that a subscription this session holds is opened, read, modified and
 * deleted as one (docs/cli.md §6.3). kill-subscription stays a bare RPC: it is
 * for any session's subscription, and the server's subscription-terminated ends
 * one of ours.
 */
const SUBSCRIPTION_OPERATIONS: Readonly<Record<string, SubscriptionOperation>> = {
  'establish-subscription': async (s, values, rpc) => {
    const before = s.received.count;
    const sub = await s.subscriptions.establish({ ...values, ...rpc } as Parameters<SessionSubscriptionsEstablish>[0]);
    const line = `subscription ${sub.id} · ${subscriptionWhat(sub)}`;
    // --xml: the reply's contents, as for any operation (the subscription keeps no reply of its own).
    const reply = s.received.lastReplySince(before);
    const xml = reply === undefined ? line : parseXml(reply).elements.map((e) => prettyXml(e)).join('\n') || 'ok';
    return { text: line, forms: { xml, text: line, json: toJson(subscriptionJson(sub), 2) } };
  },
  'modify-subscription': async (s, values, rpc) => {
    const { id, ...rest } = values;
    await subscriptionsOf(s).modify(id as number, { ...rest, ...rpc });
    return renderResult(undefined);
  },
  'delete-subscription': async (s, values, rpc) => {
    await subscriptionsOf(s).delete(values['id'] as number, rpc);
    return renderResult(undefined);
  },
  'resync-subscription': async (s, values, rpc) => {
    await subscriptionsOf(s).resync(values['id'] as number, rpc);
    return renderResult(undefined);
  },
};

type SessionSubscriptionsEstablish = ActiveSession['subscriptions']['establish'];

/** Summaries nnc gives instead of the descriptor's, where nnc does more than send the RPC. */
const SUMMARIES: Readonly<Record<string, string>> = {
  'establish-subscription':
    'Subscribe to an event stream, or (YANG-Push) to a datastore periodically or on change (RFC 8639, 8641). nnc reads the subscription and shows each update above the prompt, and how it ends',
};

/** What an operation does, as nnc runs it: the descriptor's description, unless nnc runs it differently. */
export function summaryOf(d: OperationDescriptor): string {
  return SUMMARIES[d.name] ?? d.description;
}

type ViewForms = { readonly text?: string; readonly json?: string } | undefined;
type ResultView = (
  reply: XmlElement,
  values: Readonly<Record<string, unknown>>,
  session: ActiveSession,
  rpc: { readonly signal: AbortSignal; readonly timeout?: number },
) => ViewForms | Promise<ViewForms>;

/** Operations whose replies have a view of their own, by the descriptor's namespace (docs/cli.md §6.6). */
const RESULT_VIEWS: Readonly<Record<string, ResultView>> = {
  // compare (RFC 9144): a compact diff by default, and the decoded differences as JSON.
  [NMDA_COMPARE_NS]: (reply, values) => compareForms(reply, datastoreName(values['source']), datastoreName(values['target'])),
  // get-data --with-origin (RFC 8526): each leaf's path, value and resolved origin.
  [NMDA_NS]: async (reply, values, session, rpc) =>
    values['withOrigin'] === true ? originsForms(reply, await moduleNames(session, namespacesIn(reply), rpc)) : undefined,
};

/**
 * Namespace → YANG module name for `wanted`: from the hello, then (for any
 * still unknown) the session's YANG library, read at most once per session
 * (a read-only <get>). Unknown namespaces are left out.
 */
async function moduleNames(
  session: ActiveSession,
  wanted: ReadonlySet<string>,
  rpc: { readonly signal: AbortSignal; readonly timeout?: number },
): Promise<(namespace: string) => string | undefined> {
  const names = new Map<string, string>();
  const caps = session.client.session.serverCapabilities;
  for (const m of caps.helloModules) names.set(m.namespace, m.name);
  const hasLibrary = caps.has(':yang-library:1.1') || caps.has(':yang-library:1.0');
  if (hasLibrary && !libraryUnreadable.has(session) && [...wanted].some((ns) => !names.has(ns))) {
    const content = session.client.content as { readonly yangLibrary?: YangLibraryContent };
    try {
      // The command's own signal and timeout: Ctrl-C and --timeout stop this read too.
      const library = await content.yangLibrary?.load(rpc);
      for (const set of library?.moduleSets ?? []) {
        for (const m of [...set.modules, ...set.importOnlyModules]) if (!names.has(m.namespace)) names.set(m.namespace, m.name);
      }
      for (const ds of library?.datastores ?? []) {
        for (const m of [...ds.modules, ...ds.importOnlyModules]) if (!names.has(m.namespace)) names.set(m.namespace, m.name);
      }
    } catch (err) {
      // Cancelled: the command was. Otherwise the library can't be read: don't try again this session,
      // and paths show those namespaces instead.
      if (rpc.signal.aborted) throw err;
      libraryUnreadable.add(session);
    }
  }
  return (namespace) => names.get(namespace);
}

/** Sessions whose YANG library couldn't be read for the origins view. */
const libraryUnreadable = new WeakSet<ActiveSession>();

/** The reads that return YANG datastore content, and the datastore each read (which picks the schema for --json). */
const YANG_DATA_READS: Readonly<Record<string, (values: Readonly<Record<string, unknown>>) => JsonDatastore>> = {
  get: () => 'operational',
  'get-config': (values) => (typeof values['source'] === 'string' ? values['source'] : 'running'),
  'get-data': (values) => (values['datastore'] as JsonDatastore | undefined) ?? 'operational',
};

function isReply(value: unknown): value is { readonly element: XmlElement } {
  return typeof value === 'object' && value !== null && 'element' in value;
}

/** A datastore argument as typed: a standard name, or an identity's name. */
function datastoreName(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null && typeof (value as { name?: unknown }).name === 'string') return (value as { name: string }).name;
  return '?';
}

/**
 * With --edit, put the editor's XML where the operation's XML parameter goes;
 * without it, a required XML argument must have been given.
 */
async function withEditedXml(
  cli: Cli,
  d: OperationDescriptor,
  editParam: ParamDescriptor | undefined,
  positional: readonly ParamDescriptor[],
  parsed: ParsedArgs,
): Promise<ParsedArgs> {
  if (editParam === undefined) return parsed;
  const at = positional.indexOf(editParam);
  const name = kebab(editParam.name);
  const given = at === -1 ? parsed.options[name] : parsed.positional[at];
  if (parsed.options['edit'] !== true) {
    if (given === undefined && editParam.required === true) throw new CliError(`${d.name}: missing <${name}> (or use --edit)`);
    return parsed;
  }
  if (given !== undefined) throw new CliError(`${d.name}: give the ${name} XML or --edit, not both`);
  const text = await editXml(cli, d.name);
  if (at === -1) return { ...parsed, options: { ...parsed.options, [name]: text } };
  if (parsed.positional.length < at) throw new CliError(`${d.name}: give the arguments before <${name}> when using --edit`);
  const positionals = [...parsed.positional];
  positionals.splice(at, 0, text);
  return { ...parsed, positional: positionals };
}

/** A typical use: the operation with its required arguments, each its first allowed value or a placeholder. */
function exampleOf(d: OperationDescriptor): string {
  const words = d.params
    .filter((p) => p.kind === 'positional' && p.required === true)
    .map((p) => p.values?.[0] ?? (p.type === 'datastore' ? 'running' : `<${kebab(p.name)}>`));
  return [d.name, ...words].join(' ');
}

/** Session state some operations change: locks held, and a pending confirmed commit. */
function remember(s: ActiveSession, name: string, values: Readonly<Record<string, unknown>>): void {
  if (name === 'lock') s.locks.add(String(values['target']));
  else if (name === 'unlock') s.locks.delete(String(values['target']));
  else if (name === 'commit') {
    if (values['confirmed'] === true) {
      const seconds = typeof values['confirmTimeout'] === 'number' ? values['confirmTimeout'] : 600;
      s.confirmedCommit = {
        rollbackAt: new Date(Date.now() + seconds * 1000),
        persist: typeof values['persist'] === 'string' ? values['persist'] : undefined,
      };
    } else s.confirmedCommit = undefined;
    // A commit settles whatever confirmed commit was pending, apply --confirmed's included.
    s.pending = undefined;
  } else if (name === 'cancel-commit') {
    s.confirmedCommit = undefined;
    s.pending = undefined;
  }
}

/** Turn the words given into the descriptor's argument values, refusing mistakes. */
async function convertArgs(
  s: ActiveSession,
  src: FileSource,
  d: OperationDescriptor,
  positional: readonly ParamDescriptor[],
  parsed: ParsedArgs,
  rpc: Rpc,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [i, text] of parsed.positional.entries()) {
    const last = i >= positional.length - 1;
    const p = positional[Math.min(i, positional.length - 1)]!;
    if (last && p.multiple === true) {
      // The variadic last argument: a list of every remaining word.
      const before = out[p.name];
      out[p.name] = [...(Array.isArray(before) ? (before as unknown[]) : []), await convert(s, src, d, p, text, rpc)];
    } else out[p.name] = await convert(s, src, d, p, text, rpc);
  }
  for (const p of d.params.filter((x) => x.kind === 'option')) {
    const given = parsed.options[kebab(p.name)];
    if (given === undefined) continue;
    out[p.name] = await convert(s, src, d, p, given, rpc);
  }
  return out;
}

async function convert(
  s: ActiveSession,
  src: FileSource,
  d: OperationDescriptor,
  p: ParamDescriptor,
  given: OptionValue,
  rpc: Rpc,
): Promise<unknown> {
  const label = p.kind === 'positional' ? `<${kebab(p.name)}>` : `--${kebab(p.name)}`;
  const fail = (message: string): never => {
    throw new CliError(`${d.name}: ${label} ${message}`);
  };
  const oneOf = (value: string, allowed: readonly string[], extra = ''): string => {
    if (!allowed.includes(value)) fail(`can't be ${JSON.stringify(value)}; allowed: ${allowed.join(', ')}${extra}`);
    return value;
  };

  if (p.type === 'boolean') return given !== false;
  if (p.multiple === true && Array.isArray(given)) {
    const values = given as readonly string[];
    return p.values === undefined ? [...values] : values.map((v) => oneOf(v, p.values!));
  }
  if (p.type === 'filter') {
    const pair = given as readonly string[];
    if (!Array.isArray(given) || pair.length !== 2) return fail('needs a filter type and a value: subtree <xml or JSON> or xpath <expr>');
    const [kind, value] = pair as [string, string];
    if (kind === 'subtree') {
      // RFC 7951 JSON (inline or @file), which the library turns into a subtree filter with the schema.
      const json = await jsonArg(src, value, d.name, label);
      if (json !== undefined && !JSON_FILTER_OPS.has(d.name)) fail(`can't be JSON for ${d.name}; JSON filters work on ${[...JSON_FILTER_OPS].join(', ')}`);
      return json ?? subtree(...(await xmlFragment(src, value, d.name, label)));
    }
    if (kind === 'xpath') return xpath(value, await prefixNamespaces(s, value, d.name, rpc));
    return fail(`must start with subtree or xpath, not ${JSON.stringify(kind)}`);
  }
  if (typeof given !== 'string') return fail('needs a value');

  switch (p.type) {
    case 'number': {
      const n = Number(given);
      if (given.trim() === '' || !Number.isFinite(n)) fail(`must be a number, not ${JSON.stringify(given)}`);
      return n;
    }
    case 'datastore':
      return oneOf(given, p.values ?? DATASTORES);
    case 'xml': {
      // RFC 7951 JSON (inline or @file) goes to the library as an object, which converts it with the schema.
      const json = await jsonArg(src, given, d.name, label);
      if (json !== undefined) return json;
      // Given wrapped in an element named after the parameter (<config> for config), use what's inside.
      const el = await xmlElement(src, given, d.name, label);
      return el.name === p.name ? el.children : el;
    }
    case 'config-target':
      if (URL_PATTERN.test(given)) return { url: given };
      return oneOf(given, p.values ?? DATASTORES, ', or a URL');
    case 'config-source': {
      if (URL_PATTERN.test(given)) return { url: given };
      if (given.startsWith('{')) return { config: (await jsonArg(src, given, d.name, label))! };
      if (given.startsWith('<') || given.startsWith('@')) {
        const json = await jsonArg(src, given, d.name, label);
        if (json !== undefined) return { config: json };
        const el = await xmlElement(src, given, d.name, label);
        return { config: el.name === 'config' ? el.children : el };
      }
      return oneOf(given, p.values ?? DATASTORES, ', a URL, or <config> XML');
    }
    case 'string':
      return p.values !== undefined ? oneOf(given, p.values) : given;
    case 'xpath':
      return await xpathArg(s, given, d.name, label, rpc);
    default:
      return given;
  }
}

/** Inline XML, or the contents of `@file`. */
function xmlText(src: FileSource, given: string, op: string, label: string): Promise<string> {
  return readXmlArg(src, given, (path, reason) => `${op}: ${label} cannot read ${path}: ${reason}`);
}

async function xmlElement(src: FileSource, given: string, op: string, label: string): Promise<XmlElement> {
  const text = await xmlText(src, given, op, label);
  try {
    return parseXml(text);
  } catch (err) {
    throw new CliError(`${op}: ${label} isn't well-formed XML: ${(err as Error).message}`);
  }
}

/** Operations whose filter the library converts from RFC 7951 JSON. */
const JSON_FILTER_OPS: ReadonlySet<string> = new Set(['get', 'get-config', 'get-data', 'compare']);

/**
 * RFC 7951 JSON given inline or in `@file`: text starting with `{`. Undefined
 * for anything else (XML). JSON that doesn't parse, or isn't an object, fails.
 */
async function jsonArg(src: FileSource, given: string, op: string, label: string): Promise<Record<string, unknown> | undefined> {
  if (!given.startsWith('{') && !given.startsWith('@')) return undefined;
  const text = given.startsWith('{') ? given : await xmlText(src, given, op, label);
  if (!text.trimStart().startsWith('{')) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new CliError(`${op}: ${label} isn't valid JSON: ${(err as Error).message}`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new CliError(`${op}: ${label} must be a JSON object of RFC 7951 members`);
  return value as Record<string, unknown>;
}

/** One or more elements (a subtree filter may select several). */
async function xmlFragment(src: FileSource, given: string, op: string, label: string): Promise<XmlElement[]> {
  const text = await xmlText(src, given, op, label);
  try {
    return parseXml(`<fragment>${text.replace(/^\s*<\?xml[^>]*\?>/, '')}</fragment>`).elements;
  } catch (err) {
    throw new CliError(`${op}: ${label} isn't well-formed XML: ${(err as Error).message}`);
  }
}

/** The command's signal and timeout, for anything it sends while converting arguments. */
interface Rpc {
  readonly signal?: AbortSignal;
  readonly timeout?: number;
}

/**
 * Load the server's YANG library (once per client), so modules only it lists
 * (every YANG 1.1 module) resolve too. Undefined when it loaded; otherwise why
 * not, for the error message. Ctrl-C (an abort) ends the command.
 */
async function loadLibrary(s: ActiveSession, rpc: Rpc): Promise<string | undefined> {
  if (!s.client.session.serverCapabilities.has(':yang-library:1.1')) return 'the device has no YANG library';
  try {
    await s.client.content.loadModules(rpc);
    return undefined;
  } catch (err) {
    if (err instanceof AbortError) throw err;
    return `reading the YANG library failed: ${(err as Error).message}`;
  }
}

/** The prefixes an XPath expression uses, ignoring string literals and `axis::` names. */
function prefixesIn(expr: string): string[] {
  const code = expr.replace(/'[^']*'|"[^"]*"/g, ' ');
  return [...new Set([...code.matchAll(/([A-Za-z_][\w.-]*):(?!:)/g)].map((m) => m[1]!))];
}

/** Namespaces for the prefixes in an XPath expression, taken as module names the device knows (hello or YANG library). */
async function prefixNamespaces(
  s: ActiveSession,
  expr: string,
  op: string,
  rpc: Rpc,
  /** Set when this command already tried the library: its outcome, so it isn't read twice. */
  tried?: { readonly problem: string | undefined },
): Promise<Record<string, string>> {
  const prefixes = prefixesIn(expr);
  let libraryProblem = tried?.problem;
  if (tried === undefined && prefixes.some((p) => s.client.content.moduleNamespace(p) === undefined)) libraryProblem = await loadLibrary(s, rpc);
  const out: Record<string, string> = {};
  for (const prefix of prefixes) {
    const ns = s.client.content.moduleNamespace(prefix);
    if (ns === undefined) {
      const why = libraryProblem !== undefined && libraryProblem.startsWith('reading') ? ` (${libraryProblem})` : '';
      throw new CliError(`${op}: XPath prefix "${prefix}" isn't a module the device advertises${why}`);
    }
    out[prefix] = ns;
  }
  return out;
}

/** A path error's message for nnc: without the library API's loadModules() hint. */
function pathMessage(err: unknown): string {
  return err instanceof PathError && err.cause instanceof PathError ? err.cause.message : (err as Error).message;
}

/**
 * An XPath argument: a YANG path (or `@alias`) the device's modules resolve,
 * turned into an instance-identifier; otherwise an XPath whose prefixes are
 * module names the device knows. Modules only the YANG library lists are
 * found by loading it once.
 */
async function xpathArg(s: ActiveSession, given: string, op: string, label: string, rpc: Rpc): Promise<unknown> {
  let pathProblem: string;
  let tried: { problem: string | undefined } | undefined;
  try {
    return s.client.content.toXPath(given);
  } catch (err) {
    pathProblem = pathMessage(err);
    if (err instanceof PathError && err.module !== undefined) {
      const libraryProblem = await loadLibrary(s, rpc);
      tried = { problem: libraryProblem };
      if (libraryProblem === undefined) {
        try {
          return s.client.content.toXPath(given);
        } catch (retry) {
          pathProblem = pathMessage(retry);
        }
      } else if (libraryProblem.startsWith('reading')) {
        pathProblem = `${pathProblem}; ${libraryProblem}`;
      }
    }
  }
  if (given.startsWith('@')) throw new CliError(`${op}: ${label} ${pathProblem}`);
  try {
    return xpath(given, await prefixNamespaces(s, given, op, rpc, tried));
  } catch (err) {
    throw new CliError(`${op}: ${label} is neither a YANG path (${pathProblem}) nor an XPath over advertised modules (${(err as Error).message})`);
  }
}

/** Long help for one operation (help <op>). */
export function describeOperation(d: OperationDescriptor, session: ActiveSession | undefined): string {
  const cmd = operationCommand(d);
  const arg = (a: ArgSpec): string => `<${a.name}>${a.variadic === true ? '...' : ''}`;
  const usage = [cmd.name, ...cmd.args.map((a) => (a.optional === true ? `[${arg(a)}]` : arg(a))), '[options]'].join(' ');
  const lines = [`usage: ${usage}`, '', d.description];
  const param = (p: ParamDescriptor): string => {
    const name = p.kind === 'positional' ? `<${kebab(p.name)}>` : `--${kebab(p.name)}`;
    const facts = [
      p.type,
      ...(p.values !== undefined ? [`one of ${p.values.join(', ')}`] : []),
      ...(p.required === true ? ['required'] : []),
      ...(p.default !== undefined ? [`default ${String(p.default)}`] : []),
      ...(p.requires !== undefined && p.requires.length > 0 ? [`needs ${p.requires.join(', ')}`] : []),
    ];
    return `  ${name}  ${p.description} (${facts.join('; ')})`;
  };
  const pos = d.params.filter((p) => p.kind === 'positional');
  const opts = d.params.filter((p) => p.kind === 'option');
  if (pos.length > 0) lines.push('', 'arguments:', ...pos.map(param));
  // Options the CLI adds to every operation (output, --timeout, --edit), unless the operation has its own of that name.
  const own = new Set(opts.map((p) => kebab(p.name)));
  const output = Object.entries(cmd.options)
    .filter(([name]) => !own.has(name))
    .map(([name, o]) => `  --${name}${o.type === 'string' ? ` ${o.value ?? '<value>'}` : ''}  ${o.description}`);
  if (opts.length + output.length > 0) lines.push('', 'options:', ...opts.map(param), ...output);
  lines.push('', `capabilities: ${d.requires.length > 0 ? d.requires.join(', ') : 'none beyond base'}`);
  if (session !== undefined) {
    const missing = missingCapabilities(session, d);
    if (missing.length > 0) lines.push(`not available on ${session.name}: it doesn't advertise ${missing.join(', ')}`);
  }
  if (d.extension !== undefined) lines.push(`extension: ${d.extension}`);
  lines.push(`changes state: ${d.mutates ? 'yes' : 'no'}`);
  lines.push('', `example: ${cmd.example ?? d.name}`);
  return lines.join('\n');
}

/** Completions after an operation's name: its options, or the fixed values of the next positional argument. */
export function completeArguments(d: OperationDescriptor, words: readonly string[], partial: string): string[] {
  if (partial.startsWith('-')) return d.params.filter((p) => p.kind === 'option').map((p) => `--${kebab(p.name)}`);
  const previous = words.at(-1);
  const option = previous?.startsWith('--') === true ? d.params.find((p) => `--${kebab(p.name)}` === previous) : undefined;
  if (option !== undefined) return option.type === 'filter' ? ['subtree', 'xpath'] : [...(option.values ?? [])];
  const positionalSoFar = words.filter((w, i) => !w.startsWith('--') && !(words[i - 1]?.startsWith('--') ?? false)).length;
  const next = d.params.filter((p) => p.kind === 'positional')[positionalSoFar];
  const values = next?.values ?? (next?.type === 'datastore' ? DATASTORES : []);
  return [...values, ...d.params.filter((p) => p.kind === 'option').map((p) => `--${kebab(p.name)}`)];
}

