/**
 * Content commands (docs/cli.md §6.3): read, value, resolve, set and remove,
 * by YANG path or a named path from the device profile (`@name`).
 *
 * Paths are resolved by the library from the device's own capabilities and
 * profile, so a path error (bad syntax, unknown module, unknown name) is found
 * before anything is sent. Writes follow the profile's configure workflow
 * (client.set and client.remove) and show each step as it completes.
 */

import { AbortError, PathError, RpcError, SchemaUnavailableError, TimeoutError, TransactionError, XmlElement, YangDataError, toObject, type ConfigureStep, type DatastoreChange, type Filter, type ModuleNamespaceInfo, type NamedPathTemplate, type NamespaceSource, type ServerDatastore } from '@node-net/netconf/core';
import { CliError, EXIT, usageError } from '../errors.js';
import { guardWrite } from '../guard.js';
import { diffJson, diffText } from '../render/diff.js';
import { toJson } from '../render/safe.js';
import { formatTable } from '../render/table.js';
import { prettyXml } from '../render/xml.js';
import type { Cli } from '../cli.js';
import type { ActiveSession } from '../sessions/active.js';
import type { Command, CommandResult, OptionSpec, ParsedArgs } from './registry.js';
import { OUTPUT_OPTIONS, describeErrors, escapeControls, send } from './results.js';
import { TIMEOUT_OPTION, timeoutOf } from './xml-input.js';

/** The commands whose first argument is a path: completion offers modules and named paths there. */
export const PATH_COMMANDS: readonly string[] = ['read', 'value', 'set', 'remove', 'resolve', 'diff'];

const DATASTORES = ['running', 'candidate', 'startup'] as const;

const PATH_ARG = {
  name: 'path',
  description: 'a YANG path such as /ietf-interfaces:interfaces/interface[name="eth0"], or @name for a named path from the device profile, with any parameters as @name(value, param=value)',
};

const READ_OPTIONS: Record<string, OptionSpec> = {
  datastore: { type: 'string', value: '<datastore>', values: DATASTORES, default: 'running', description: 'the configuration datastore to read' },
  state: { type: 'boolean', description: 'read configuration and state together, with <get>' },
  timeout: TIMEOUT_OPTION,
};

function session(cli: Cli): ActiveSession {
  if (cli.session === undefined) throw new CliError('not connected');
  return cli.session;
}

/** Run a library call that resolves a path, turning a path error into a message: nothing was sent. */
async function withPath<T>(command: string, run: () => Promise<T> | T): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof PathError) throw new CliError(`${command}: ${err.message}; nothing was sent`);
    throw err;
  }
}

/** The source read() reads from: `--state` (configuration and state, by `<get>`) or `--datastore` (default running). */
function sourceOf(args: ParsedArgs, command: string): (typeof DATASTORES)[number] | 'config+state' {
  const datastore = args.options['datastore'];
  const state = args.options['state'] === true;
  if (state && datastore !== undefined) throw usageError(`${command}: give --state or --datastore, not both`);
  if (state) return 'config+state';
  if (datastore === undefined) return 'running';
  if (typeof datastore !== 'string' || !(DATASTORES as readonly string[]).includes(datastore)) {
    throw usageError(`${command}: --datastore must be one of ${DATASTORES.join(', ')}`);
  }
  return datastore as (typeof DATASTORES)[number];
}

async function readPath(cli: Cli, args: ParsedArgs, signal: AbortSignal, command: string): Promise<XmlElement[]> {
  const s = session(cli);
  const path = args.positional[0]!;
  const source = sourceOf(args, command);
  const timeout = timeoutOf(args, command);
  return withPath(command, () => send(() => s.client.content.read(path, { source, signal, ...(timeout !== undefined ? { timeout } : {}), format: 'xml' })));
}

export const readCommand: Command = {
  name: 'read',
  group: 'content',
  summary: 'Read the nodes at a YANG path or @name (running config by default)',
  example: 'read /ietf-interfaces:interfaces/interface[name="eth0"]',
  args: [PATH_ARG],
  options: { ...READ_OPTIONS, ...OUTPUT_OPTIONS },
  kinds: ['client'],
  async run(cli, args, signal) {
    const found = await readPath(cli, args, signal, 'read');
    const forms =
      found.length === 0
        ? { xml: '(no data)', json: toJson([], 2) }
        : { xml: found.map((e) => prettyXml(e)).join('\n'), json: toJson(found.map((e) => ({ [e.name]: toObject(e) })), 2) };
    return { text: forms.xml, forms };
  },
};

export const valueCommand: Command = {
  name: 'value',
  group: 'content',
  summary: "Print one leaf's value as plain text, at a YANG path or @name",
  example: 'value @systemName',
  args: [PATH_ARG],
  options: { ...READ_OPTIONS, ...OUTPUT_OPTIONS },
  kinds: ['client'],
  async run(cli, args, signal) {
    const found = await readPath(cli, args, signal, 'value');
    if (found.length === 0) return { text: '(not set)', message: true };
    if (found.length > 1) throw new CliError(`value: the path matches ${found.length} nodes; value needs exactly one leaf (use read to see them)`);
    const leaf = found[0]!;
    if (leaf.elements.length > 0) throw new CliError(`value: <${escapeControls(leaf.name)}> isn't a leaf: it has child elements (use read to see it)`);
    const text = leaf.textContent().trim();
    return { text: escapeControls(text), forms: { xml: escapeControls(text), json: toJson(text, 2) } };
  },
};

/** `ifName (optional), port`: a named path's parameters, marking those a read may leave out. */
export function paramList(template: NamedPathTemplate): string {
  return template.params.map((p) => (template.optional.has(p) ? `${p} (optional)` : p)).join(', ');
}

/** A `--source` or `--target` datastore: running, candidate or startup. */
function datastoreOption(args: ParsedArgs, name: 'source' | 'target', fallback: (typeof DATASTORES)[number]): (typeof DATASTORES)[number] {
  const given = args.options[name];
  if (given === undefined) return fallback;
  if (typeof given !== 'string' || !(DATASTORES as readonly string[]).includes(given)) {
    throw usageError(`diff: --${name} must be one of ${DATASTORES.join(', ')}`);
  }
  return given as (typeof DATASTORES)[number];
}

/**
 * The filter `read` sends for a path. A module only the YANG library lists
 * (every YANG 1.1 module) resolves once the library is loaded, so a path error
 * reads it once and tries again.
 */
async function filterFor(s: ActiveSession, path: string, signal: AbortSignal): Promise<Filter | undefined> {
  try {
    return s.client.content.readFilter(path);
  } catch (err) {
    if (!(err instanceof PathError) || !s.client.session.serverCapabilities.has(':yang-library:1.1')) throw err;
    await send(() => s.client.content.loadModules({ signal }));
    return s.client.content.readFilter(path);
  }
}

export const diffCommand: Command = {
  name: 'diff',
  group: 'content',
  summary: 'Show how two datastores differ, compared here with the YANG schema: by default what the candidate would commit (running → candidate)',
  example: 'diff /ietf-interfaces:interfaces',
  args: [{ ...PATH_ARG, optional: true, description: `limit the comparison to this part of the configuration: ${PATH_ARG.description}` }],
  options: {
    source: { type: 'string', value: '<datastore>', values: DATASTORES, default: 'running', description: 'the datastore the changes start from' },
    target: { type: 'string', value: '<datastore>', values: DATASTORES, default: 'candidate', description: 'the datastore the changes lead to' },
    timeout: TIMEOUT_OPTION,
    json: OUTPUT_OPTIONS.json,
    page: OUTPUT_OPTIONS.page,
  },
  kinds: ['client'],
  async run(cli, args, signal) {
    const s = session(cli);
    const source = datastoreOption(args, 'source', 'running');
    const target = datastoreOption(args, 'target', 'candidate');
    const timeout = timeoutOf(args, 'diff');
    const path = args.positional[0];
    let filter: Filter | undefined;
    if (path !== undefined) {
      filter = await withPath('diff', () => filterFor(s, path, signal));
      if (filter === undefined) {
        throw new CliError("diff: the device profile says this device can't filter reads (subtreeFilter: 'unsupported'), so a path can't limit the comparison; run diff without one");
      }
    }
    let changes: DatastoreChange[];
    try {
      changes = await send(() =>
        s.client.content.compareDatastores({ source, target, signal, ...(filter !== undefined ? { filter } : {}), ...(timeout !== undefined ? { timeout } : {}) }),
      );
    } catch (err) {
      if (err instanceof SchemaUnavailableError) {
        throw new CliError(`diff: ${err.message}. In nnc, list the module directories in the target's yang.modules`);
      }
      if (err instanceof YangDataError) throw new CliError(`diff: the data doesn't match the device's YANG schema: ${err.message}`);
      throw err;
    }
    const text = diffText(changes, source, target);
    return { text, forms: { xml: text, text, json: diffJson(changes) } };
  },
};

/** The module of the standard datastore identities, as datastores() names them: `ietf-datastores:running`. */
const STANDARD_DATASTORE = 'ietf-datastores:';

export const datastoresCommand: Command = {
  name: 'datastores',
  group: 'content',
  summary: "List the device's datastores: from its YANG library (NMDA), or else from its capabilities",
  example: 'datastores',
  args: [],
  options: { timeout: TIMEOUT_OPTION, json: OUTPUT_OPTIONS.json },
  kinds: ['client'],
  async run(cli, args, signal) {
    const s = session(cli);
    const timeout = timeoutOf(args, 'datastores');
    const result = await send(() => s.client.content.datastores({ signal, ...(timeout !== undefined ? { timeout } : {}) }));
    // The standard datastores are shown by name; another module's identity keeps its module.
    const label = (d: ServerDatastore): string => escapeControls(d.name.startsWith(STANDARD_DATASTORE) ? d.name.slice(STANDARD_DATASTORE.length) : d.name);
    const fromLibrary = result.source === 'yang-library';
    const table = fromLibrary
      ? formatTable(['DATASTORE', 'SCHEMA'], result.datastores.map((d) => [label(d), escapeControls(d.schema ?? '')]))
      : formatTable(['DATASTORE'], result.datastores.map((d) => [label(d)]));
    const note = fromLibrary ? '(from the YANG library)' : "(from the hello's capabilities: the server has no YANG library datastore list)";
    const text = [...table, note].join('\n');
    return { text, forms: { xml: text, text, json: toJson(result, 2) } };
  },
};

const STANDARD_DATASTORES = ['running', 'candidate', 'startup', 'intended', 'operational'] as const;

export const modulesCommand: Command = {
  name: 'modules',
  group: 'content',
  summary: "List the device's YANG modules and the features it supports, for a datastore or schema (--all-features: also those it doesn't)",
  example: 'modules ietf-netconf --all-features',
  args: [{ name: 'module', optional: true, description: 'only this module' }],
  options: {
    datastore: {
      type: 'string',
      value: '<datastore>',
      values: STANDARD_DATASTORES,
      description: 'the datastore whose modules to list (default running): a standard name, or module:name for another datastore identity',
    },
    schema: { type: 'string', value: '<name>', description: 'a YANG library schema by name, instead of a datastore' },
    'all-features': { type: 'boolean', description: "read each module's YANG source and list every feature it declares, supported or not" },
    timeout: TIMEOUT_OPTION,
    json: OUTPUT_OPTIONS.json,
  },
  kinds: ['client'],
  async run(cli, args, signal) {
    const s = session(cli);
    const datastoreArg = args.options['datastore'] as string | undefined;
    const schema = args.options['schema'] as string | undefined;
    if (datastoreArg !== undefined && schema !== undefined) throw usageError('modules: give --datastore or --schema, not both');
    const timeout = timeoutOf(args, 'modules');
    const rpc = { signal, ...(timeout !== undefined ? { timeout } : {}) };
    const datastore = datastoreArg === undefined ? undefined : await datastoreRef(s, datastoreArg, rpc);
    const module = args.positional[0];
    const declared = args.options['all-features'] === true;
    const result = await send(() =>
      s.client.content.modules({
        ...rpc,
        ...(datastore !== undefined ? { datastore } : {}),
        ...(schema !== undefined ? { schema } : {}),
        ...(module !== undefined ? { module } : {}),
        ...(declared ? { declared } : {}),
      }),
    );
    const e = escapeControls;
    const header =
      result.source === 'yang-library'
        ? [
            'Source: YANG library',
            ...(schema === undefined ? [`Datastore: ${e(datastoreArg ?? 'running')}`] : []),
            ...(schema !== undefined || result.schema !== undefined ? [`Schema: ${e(schema ?? result.schema ?? '')}`] : []),
          ]
        : ["Source: the hello's module capabilities (the server has no YANG library)"];
    let lines: string[];
    if (declared) {
      const rows = result.modules
        .filter((m) => m.conformance === 'implement')
        .flatMap((m): string[][] => {
          if (m.declared === undefined) return [[e(m.name), '', '(source not found)']];
          return [
            ...m.declared.map((f) => [e(m.name), e(f.name), f.supported ? 'yes' : 'no']),
            ...(m.undeclared ?? []).map((f) => [e(m.name), e(f), "yes (not in the module's source)"]),
          ];
        });
      lines = rows.length === 0 ? ['(no modules)'] : formatTable(['MODULE', 'FEATURE', 'SUPPORTED'], rows);
    } else {
      const rows = result.modules.map((m) => [e(m.name), e(m.revision ?? ''), m.conformance, e(m.features.join(',')), e(m.deviations.join(','))]);
      lines = rows.length === 0 ? ['(no modules)'] : formatTable(['MODULE', 'REVISION', 'CONFORMANCE', 'FEATURES', 'DEVIATIONS'], rows);
    }
    const text = [...header, '', ...lines].join('\n');
    return { text, forms: { xml: text, text, json: toJson(result, 2) } };
  },
};

/** A --datastore value as the library takes it: a standard name, or module:name resolved to its module's namespace. */
async function datastoreRef(
  s: ActiveSession,
  value: string,
  rpc: { readonly signal: AbortSignal; readonly timeout?: number },
): Promise<(typeof STANDARD_DATASTORES)[number] | { name: string; namespace: string }> {
  if ((STANDARD_DATASTORES as readonly string[]).includes(value)) return value as (typeof STANDARD_DATASTORES)[number];
  const colon = value.indexOf(':');
  if (colon <= 0 || colon === value.length - 1) {
    throw usageError(`modules: --datastore must be one of ${STANDARD_DATASTORES.join(', ')}, or module:name for another datastore identity`);
  }
  const module = value.slice(0, colon);
  const namespace = s.client.content.moduleNamespace(module) ?? (await s.client.content.loadModules(rpc)).get(module);
  if (namespace === undefined) throw new CliError(`modules: no module ${module} is known to the device, so datastore ${value} can't be found`);
  return { name: value.slice(colon + 1), namespace };
}

const NAMESPACE_SOURCES: readonly NamespaceSource[] = ['given', 'profile', 'hello', 'library'];

export const namespacesCommand: Command = {
  name: 'namespaces',
  group: 'content',
  summary: 'List the module namespaces paths resolve with, and where each came from: given, profile, hello or YANG library',
  example: 'namespaces ietf-interfaces',
  args: [{ name: 'module', optional: true, description: 'only this module' }],
  options: {
    source: {
      type: 'string',
      value: '<source>',
      values: NAMESPACE_SOURCES,
      description: "only this source's own list, whether or not an earlier source wins: given, profile, hello or library",
    },
    timeout: TIMEOUT_OPTION,
    json: OUTPUT_OPTIONS.json,
  },
  kinds: ['client'],
  async run(cli, args, signal) {
    const s = session(cli);
    const source = args.options['source'] as string | undefined;
    if (source !== undefined && !(NAMESPACE_SOURCES as readonly string[]).includes(source)) {
      throw usageError(`namespaces: --source must be one of ${NAMESPACE_SOURCES.join(', ')}`);
    }
    const timeout = timeoutOf(args, 'namespaces');
    // The YANG library completes the list; read once per session, nothing sent without one.
    let problem: string | undefined;
    try {
      await s.client.content.loadModules({ signal, ...(timeout !== undefined ? { timeout } : {}) });
    } catch (err) {
      if (err instanceof AbortError || err instanceof TimeoutError) throw err;
      // Only the merged view and the library's own list miss what it would add.
      if (source === undefined || source === 'library') problem = `reading the YANG library failed: ${(err as Error).message}`;
    }
    const module = args.positional[0];
    const info = s.client.content.moduleNamespacesInfo(source === undefined ? {} : { source: source as NamespaceSource });
    const all = [...info].filter(([name]) => module === undefined || name === module);
    if (module !== undefined && all.length === 0) {
      const where = source === undefined ? 'known to the device' : `in the ${source} namespaces`;
      throw new CliError(`namespaces: no module ${module} is ${where}${problem === undefined ? '' : ` (${problem})`}`);
    }
    const e = escapeControls;
    const overrides = (i: ModuleNamespaceInfo): string => (i.overrides ?? []).map((o) => `${o.source} ${e(o.namespace)}`).join('; ');
    // With --source every row has that source, so the column goes.
    const rows = all.map(([name, i]) => [e(name), e(i.namespace), ...(source === undefined ? [i.source] : []), overrides(i)]);
    const header = ['MODULE', 'NAMESPACE', ...(source === undefined ? ['SOURCE'] : [])];
    if (rows.some((r) => r[header.length] !== '')) header.push('OVERRIDES');
    const table = rows.length === 0 ? ['(no modules)'] : formatTable(header, rows.map((r) => r.slice(0, header.length)));
    const text = [...table, ...(problem === undefined ? [] : ['', `(${e(problem)}: modules only it lists are missing)`])].join('\n');
    const json = toJson(all.map(([name, i]) => ({ module: name, ...i })), 2);
    return { text, forms: { xml: text, text, json } };
  },
};

export const resolveCommand: Command = {
  name: 'resolve',
  group: 'content',
  summary: 'Show how a path or @name resolves: its steps, modules, namespaces and keys, and the filter a read sends. Sends nothing',
  example: 'resolve @systemName',
  args: [PATH_ARG],
  options: { json: OUTPUT_OPTIONS.json, xml: OUTPUT_OPTIONS.xml },
  kinds: ['client'],
  async run(cli, args) {
    const s = session(cli);
    const given = args.positional[0]!;
    const named = given.startsWith('@') ? given.slice(1).split(/[(/]/)[0]! : undefined;
    const steps = await withPath('resolve', () => s.client.content.resolvePath(given));
    const filter = await withPath('resolve', () => s.client.content.readFilter(given));
    const full = s.client.content.expandPath(given);
    const template = named === undefined ? undefined : s.client.content.namedPathTemplate(named);
    const params = template === undefined || template.params.length === 0 ? undefined : template;
    const filterXml = filter === undefined ? undefined : 'content' in filter ? filter.content.filter((n): n is XmlElement => n instanceof XmlElement).map((n) => prettyXml(n)).join('\n') : undefined;

    const keysOf = (step: (typeof steps)[number]): string => step.keys.map((k) => `${k.name}=${JSON.stringify(k.value)}`).join(' ');
    const lines = [`path  ${escapeControls(full)}${named === undefined ? '' : `  (@${escapeControls(named)})`}`];
    if (params !== undefined) {
      lines.push(`  template  ${escapeControls(params.path)}`, `  params    ${escapeControls(paramList(params))}`);
    }
    steps.forEach((step, i) => {
      lines.push('', `step ${i + 1}  ${escapeControls(step.name)}`, `  module     ${escapeControls(step.moduleName)}`, `  namespace  ${escapeControls(step.ns)}`);
      if (step.keys.length > 0) lines.push(`  keys       ${escapeControls(keysOf(step))}`);
      if (step.value !== undefined) lines.push(`  value      ${escapeControls(JSON.stringify(step.value))}`);
    });
    lines.push('', 'filter a read sends:');
    if (filterXml !== undefined) lines.push(...filterXml.split('\n').map((l) => `  ${l}`));
    else lines.push("  none: the profile's subtreeFilter quirk says the device can't filter, so a read fetches the whole datastore and selects locally");

    const json = toJson(
      {
        path: full,
        ...(named !== undefined ? { named } : {}),
        ...(params !== undefined ? { template: params.path, params: params.params.map((p) => ({ name: p, optional: params.optional.has(p) })) } : {}),
        steps: steps.map((st) => ({
          name: st.name,
          module: st.moduleName,
          namespace: st.ns,
          keys: Object.fromEntries(st.keys.map((k) => [k.name, k.value])),
          ...(st.value !== undefined ? { value: st.value } : {}),
        })),
        filter: filterXml ?? null,
      },
      2,
    );
    return { text: lines.join('\n'), forms: { xml: lines.join('\n'), json } };
  },
};

// --- writes -------------------------------------------------------------------------------------

const PHASE_OPERATION: Record<string, ConfigureStep['operation']> = {
  lock: 'lock',
  discard: 'discard-changes',
  edit: 'edit-config',
  validate: 'validate',
  commit: 'commit',
};

/**
 * Apply a write with the profile's workflow, showing each step as it
 * completes. On failure, name the step that failed and show its rpc-error.
 */
async function write(cli: Cli, command: string, args: ParsedArgs, signal: AbortSignal, apply: (s: ActiveSession, options: object) => Promise<unknown>): Promise<CommandResult> {
  const s = session(cli);
  guardWrite(s, command);
  await runWorkflow(cli, s, command, timeoutOf(args, command), signal, (options) => apply(s, options));
  return okResult();
}

export function okResult(): CommandResult {
  return { text: 'ok', forms: { xml: 'ok', json: toJson({ ok: true }, 2) } };
}

/**
 * Run a write through the profile's workflow, showing each step as it
 * completes; on failure, the error names the failing step with its rpc-error.
 * Resolves with what `apply` resolves with (a pending confirmed commit, say).
 */
export async function runWorkflow<T>(
  cli: Cli,
  s: ActiveSession,
  command: string,
  timeout: number | undefined,
  signal: AbortSignal,
  apply: (options: { onStep: (step: ConfigureStep) => void; signal: AbortSignal; timeout?: number }) => Promise<T>,
): Promise<T> {
  const done: ConfigureStep[] = [];
  const onStep = (step: ConfigureStep): void => {
    done.push(step);
    cli.showMessage(`${step.operation} ${step.datastore}: ok\n`);
  };
  try {
    return await withPath(command, () => apply({ onStep, signal, ...(timeout !== undefined ? { timeout } : {}) }));
  } catch (err) {
    throw failure(s, command, err, done);
  }
}

/** A change queued in a transaction (PATH-09). */
export interface QueuedChange {
  readonly operation: 'set' | 'remove';
  readonly path: string;
  readonly value?: string;
}

/** Inside a transaction, queue the change instead of sending it, after checking it with everything already queued. */
async function queue(cli: Cli, change: QueuedChange): Promise<CommandResult> {
  const s = session(cli);
  const txn = s.transaction!;
  guardWrite(s, change.operation);
  const all = [...txn.changes, change];
  await withPath(change.operation, () => s.client.content.checkEdits((t) => replay(t, all)));
  txn.changes.push(change);
  return { text: `queued (${txn.changes.length} change${txn.changes.length === 1 ? '' : 's'})`, message: true };
}

/** Make the queued changes on a configure() transaction. */
export function replay(txn: { set(path: string, value: string): unknown; remove(path: string): unknown }, changes: readonly QueuedChange[]): void {
  for (const c of changes) {
    if (c.operation === 'set') txn.set(c.path, c.value!);
    else txn.remove(c.path);
  }
}

/** The error for a failed write: the failing step, what was cleaned up, and the device's rpc-error. */
function failure(s: ActiveSession, command: string, err: unknown, done: readonly ConfigureStep[]): unknown {
  if (err instanceof TransactionError) {
    const step = PHASE_OPERATION[err.phase] ?? err.phase;
    const cleanup =
      err.cleanupErrors.length === 0
        ? 'the changes were discarded and the locks released'
        : `cleaning up also failed (${err.cleanupErrors.length} step${err.cleanupErrors.length === 1 ? '' : 's'}); check the device's locks and candidate`;
    const cause = err.cause instanceof RpcError ? `\n${describeErrors(err.cause.errors, 'rpc-error')}` : err.cause instanceof Error ? `\n${escapeControls(err.cause.message)}` : '';
    return new CliError(`${command}: failed at ${step}; ${cleanup}${cause}`, err.cause instanceof RpcError ? EXIT.rpcError : EXIT.protocol);
  }
  if (err instanceof RpcError) {
    // The running workflow: lock (unless the profile turns it off), edit-config, validate.
    const lockOff = s.client.profile?.workflow?.lock === false;
    const order: ConfigureStep['operation'][] = [...(lockOff ? [] : ['lock' as const]), 'edit-config', 'validate'];
    const step = order.find((o) => !done.some((d) => d.operation === o)) ?? 'edit-config';
    const released = done.some((d) => d.operation === 'lock') ? 'the lock was released' : 'nothing was changed';
    return new CliError(`${command}: failed at ${step}; ${released}\n${describeErrors(err.errors, 'rpc-error')}`, EXIT.rpcError);
  }
  return err;
}

/** `set <path> <value>` (the content write; `set on-error` is the setting, in settings.ts). */
export async function setPath(cli: Cli, args: ParsedArgs, signal: AbortSignal): Promise<CommandResult> {
  const [path, value] = args.positional;
  if (cli.session === undefined && cli.low !== undefined) {
    throw new CliError(`set <path> is available in client sessions, not in this ${cli.low.kind} session; nothing was sent`);
  }
  if (value === undefined) throw usageError('set: missing <value>\nusage: set <path> <value>');
  if (cli.session?.transaction !== undefined) return queue(cli, { operation: 'set', path: path!, value });
  return write(cli, 'set', args, signal, (s, options) => s.client.content.set(path!, value, options));
}

export const removeCommand: Command = {
  name: 'remove',
  group: 'content',
  mutates: true,
  summary: "Remove the node at a path or @name, if it exists, following the profile's workflow",
  example: 'remove /ietf-interfaces:interfaces/interface[name="eth9"]',
  args: [PATH_ARG],
  options: { timeout: TIMEOUT_OPTION, json: OUTPUT_OPTIONS.json },
  kinds: ['client'],
  run(cli, args, signal) {
    if (cli.session?.transaction !== undefined) return queue(cli, { operation: 'remove', path: args.positional[0]! });
    return write(cli, 'remove', args, signal, (s, options) => s.client.content.remove(args.positional[0]!, options));
  },
};
