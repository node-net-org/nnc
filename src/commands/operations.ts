/**
 * Commands that send operations (docs/cli.md §6.3), each checked by the
 * read-only guard before anything is sent. The full set of base-operation
 * commands built from descriptors comes with the operations stories; these two
 * are the general-purpose ones.
 */

import type { XmlElement} from '@node-net/netconf/core';
import { NETCONF_NS, parseXml, type OperationDescriptor } from '@node-net/netconf/core';
import { CliError } from '../errors.js';
import { guardOperation, guardRpc } from '../guard.js';
import { OUTPUT_OPTIONS, escapeControls, renderReply, renderResult, send } from './results.js';
import { toJson } from '../render/safe.js';
import type { Cli } from '../cli.js';
import type { ActiveSession } from '../sessions/active.js';
import type { Command, CommandResult, ParsedArgs } from './registry.js';
import { EDIT_OPTION, TIMEOUT_OPTION, editXml, stopWaiting, timeoutOf, xmlText } from './xml-input.js';
import { paramList } from './content.js';

function session(cli: Cli): ActiveSession {
  if (cli.session === undefined) throw new CliError('not connected');
  return cli.session;
}

export const rpcCommand: Command = {
  name: 'rpc',
  summary: 'Send any operation: rpc <operation-xml> (the session adds <rpc> and the message-id)',
  args: [{ name: 'xml', description: 'the operation element, e.g. <get-config><source><running/></source></get-config>, or @file', optional: true }],
  options: { ...OUTPUT_OPTIONS, timeout: TIMEOUT_OPTION, edit: EDIT_OPTION },
  group: 'messages',
  example: 'rpc <get-config><source><running/></source></get-config> --json',
  kinds: ['client'],
  async run(cli, args, signal) {
    const s = session(cli);
    const timeout = timeoutOf(args, 'rpc');
    const given = args.positional[0];
    if (given !== undefined && args.options['edit'] === true) throw new CliError('rpc: give the XML or --edit, not both');
    if (given === undefined && args.options['edit'] !== true) throw new CliError('rpc: missing <xml> (or use --edit)\nusage: rpc <xml>|@file [--json] [--timeout <ms>] [--edit]');
    const text = given === undefined ? await editXml(cli, 'rpc') : await xmlText(cli.host, given, (path, reason) => `rpc: cannot read ${path}: ${reason}`);
    let body: XmlElement;
    try {
      // Parsed as Session.rpc() parses text: unqualified elements are in the NETCONF namespace.
      body = parseXml(text, { defaultNamespace: NETCONF_NS });
    } catch (err) {
      throw new CliError(`rpc: the operation isn't well-formed XML: ${(err as Error).message}`);
    }
    if (body.name === 'rpc' && body.ns === NETCONF_NS) {
      throw new CliError('rpc: the <rpc> wrapper and message-id are added automatically; give only the operation inside it');
    }
    guardRpc(s, body);
    cli.lastXml.set('rpc', text);
    return renderReply(await send(() => s.client.session.rpc(body, { signal, ...(timeout !== undefined ? { timeout } : {}) })));
  },
};

/** The profile's operations on this connection (client.ops.list entries marked with the profile). */
function profileOps(s: ActiveSession): OperationDescriptor[] {
  return s.client.ops.list.filter((d) => d.device !== undefined);
}

/** Tab completion for an operation argument: the profile's operation names. */
function profileOpNames(cli: Cli): readonly string[] {
  return cli.session === undefined ? [] : profileOps(cli.session).map((d) => d.name);
}

/** Each operation with its description and parameters, as `device` and `help device` show them. */
function operationLines(ops: readonly OperationDescriptor[]): string[] {
  return ops.flatMap((d) => [
    `  ${d.name}${d.mutates ? ' *' : ''}  ${d.description}`,
    ...d.params.map((p) => `      --${kebab(p.name)} <${p.type}>${p.required === true ? '' : ' (optional)'}${p.description === '' ? '' : `  ${p.description}`}`),
  ]);
}

export const profileCommand: Command = {
  name: 'profile',
  summary: "Show the device profile in use (how it was chosen, quirks, workflow, named paths, operations), or one operation's full definition: profile <operation>. Sends nothing",
  args: [{ name: 'operation', description: 'a profile operation to describe (it is not run)', optional: true, values: profileOpNames }],
  options: { json: OUTPUT_OPTIONS.json },
  kinds: ['client'],
  group: 'profile',
  example: 'profile cli',
  run(cli, args) {
    const s = session(cli);
    const json = args.options['json'] === true;
    const name = args.positional[0];
    return Promise.resolve(name === undefined ? profileView(s, json) : operationView(s, name, json));
  },
};

export const deviceCommand: Command = {
  name: 'device',
  summary: "Run one of the device profile's operations on the device: device <operation> [--param value]... With no operation, list them",
  args: [{ name: 'operation', description: 'a profile operation to run', optional: true, values: profileOpNames }],
  options: { ...OUTPUT_OPTIONS },
  freeOptions: true,
  kinds: ['client'],
  group: 'operations',
  example: 'device cli --command "show version"',
  moreHelp(cli) {
    const s = cli.session;
    const profile = s?.client.profile;
    if (s === undefined || profile === undefined) return [];
    const ops = profileOps(s);
    if (ops.length === 0) return [`profile ${profile.id} has no operations.`];
    return [`operations of profile ${profile.id} (* changes state):`, ...operationLines(ops), `profile <operation> shows one's full definition.`];
  },
  async run(cli, args, signal) {
    const s = session(cli);
    const profile = s.client.profile;
    const name = args.positional[0];
    if (name === undefined) {
      const extra = Object.keys(args.options).filter((k) => !(k in OUTPUT_OPTIONS));
      if (extra.length > 0) throw new CliError('device: name an operation before its options');
      return operationsList(s, args.options['json'] === true);
    }
    if (profile === undefined) throw new CliError(`device ${name}: no device profile is in use in this session, so it has no operations; nothing was sent`);
    const ops = profileOps(s);
    const listed = `the profile's operations: ${ops.map((d) => d.name).join(', ') || 'none'}`;
    const descriptor = ops.find((d) => d.name === name);
    if (descriptor === undefined) {
      throw new CliError(`device: profile ${profile.id} has no operation "${name}" (${listed})`);
    }
    // The output options and --timeout are ours unless the operation has a parameter of that name.
    const own = (name: string): boolean => descriptor.params.some((p) => p.name === name);
    const ours = new Set([...Object.keys(OUTPUT_OPTIONS), 'timeout'].filter((k) => !own(k)));
    const timeout = own('timeout') ? undefined : timeoutOf(args, `device ${name}`);
    const options = Object.fromEntries(Object.entries(args.options).filter(([k, v]) => v !== undefined && !ours.has(k)));
    const params = deviceArgs(descriptor, options, listed);
    guardOperation(s, descriptor, `device ${name}`);
    // Profile operations take no per-call options, so stop waiting here on Ctrl-C or --timeout.
    const result = renderResult(await send(() => stopWaiting(s.client.ops.run(name, params), signal, timeout, `device ${name}`)));
    // An operation with a json parameter of its own has no JSON form here.
    if (own('json') && result !== undefined && 'forms' in result && result.forms !== undefined) {
      const { json: _json, ...forms } = result.forms;
      return { ...result, forms };
    }
    return result;
  },
};

/** `confirmTimeout` → `confirm-timeout`. */
function kebab(name: string): string {
  return name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/** Plain `device`: the operations this connection can run (PATH-08). */
function operationsList(s: ActiveSession, json: boolean): CommandResult {
  const profile = s.client.profile;
  const ops = profile === undefined ? [] : profileOps(s);
  if (json) {
    const operations = ops.map((d) => ({
      name: d.name,
      description: d.description,
      mutates: d.mutates,
      params: d.params.map((p) => ({ name: p.name, type: p.type, required: p.required === true })),
    }));
    return { text: toJson({ profile: profile?.id ?? null, operations }, 2) };
  }
  if (profile === undefined) return { text: 'no device profile is in use in this session, so it has no operations', message: true };
  if (ops.length === 0) return { text: `profile ${profile.id} has no operations`, message: true };
  return { text: [`operations of profile ${profile.id} (* changes state):`, ...operationLines(ops)].map((l) => escapeControls(l)).join('\n') };
}

/** `profile <operation>`: one operation's full definition, from the profile; nothing is sent (PATH-12). */
function operationView(s: ActiveSession, name: string, json: boolean): CommandResult {
  const profile = s.client.profile;
  if (profile === undefined) throw new CliError(`profile ${name}: no device profile is in use in this session, so it has no operations`);
  const ops = profileOps(s);
  const descriptor = ops.find((d) => d.name === name);
  if (descriptor === undefined) {
    throw new CliError(`profile: profile ${profile.id} has no operation "${name}" (the profile's operations: ${ops.map((d) => d.name).join(', ') || 'none'})`);
  }
  const spec = profile.definition?.operations?.[name];
  const params = descriptor.params.map((p) => ({ name: p.name, type: p.type, required: p.required === true }));
  if (json) {
    return { text: toJson({ name, profile: profile.id, description: descriptor.description, mutates: descriptor.mutates, params, definition: spec ?? null }, 2) };
  }
  const changes = spec === undefined
    ? descriptor.mutates ? 'yes' : 'no'
    : spec.mutates === undefined ? 'counted as yes (the profile doesn\'t say, so it is treated as a change)' : spec.mutates ? 'yes' : 'no';
  const paramText = params.length === 0 ? '(none)' : params.map((p) => `--${kebab(p.name)} <${p.type}>${p.required ? '' : ' (optional)'}`).join('  ');
  const run = `device ${name}${params.filter((p) => p.required).map((p) => ` --${kebab(p.name)} <${p.type}>`).join('')}`;
  const lines = [
    `operation  ${name}  (profile ${profile.id})`,
    `about      ${descriptor.description === '' ? '(no description)' : descriptor.description}`,
    `changes    ${changes}`,
    `params     ${paramText}`,
    ...(spec === undefined
      ? ['request    (defined in code)']
      : [`request    ${spec.request ?? '(none)'}`, `result     ${resultText(spec.result)}`]),
    `run with   ${run}`,
  ];
  return { text: lines.map((l) => escapeControls(l)).join('\n') };
}

/** How a JSON operation's reply is read, as the library applies it. */
function resultText(result: { readonly path?: string; readonly as?: string } | undefined): string {
  const as = result?.as ?? (result?.path !== undefined ? 'element' : 'reply');
  if (as === 'reply') return result?.path === undefined ? 'the whole reply' : `the whole reply (path ${result.path} ignored)`;
  return `${result?.path ?? '(the reply)'}, as ${as}`;
}

/** Plain `profile`: the profile in use and what it changes (PATH-07). Nothing is sent. */
function profileView(s: ActiveSession, json: boolean): CommandResult {
  const profile = s.client.profile;
  if (profile === undefined) {
    const considered = s.considered;
    const data = { profile: null, considered };
    const text = [
      'no device profile is in use in this session',
      ...(considered.length > 0 ? [`auto-detection considered ${considered.join(', ')}; none matched the device's hello`] : ['the target names no profile and auto-detection was not tried']),
    ].join('\n');
    return json ? { text: toJson(data, 2) } : { text, message: true };
  }
  const source = profile.source === undefined ? 'defined in code' : profile.source.type === 'builtin' ? 'built in' : profile.source.type === 'file' ? profile.source.file! : 'given inline';
  const match = profile.match === undefined ? undefined : Object.entries(profile.match).map(([k, v]) => `${k} ${(v as readonly string[]).join(', ')}`).join('; ');
  const chosen = s.profileSource === 'named' ? `named by target ${s.name}` : `auto-detected${match === undefined ? '' : ` (match: ${match})`}`;
  const quirks = Object.entries(profile.quirks ?? {});
  const workflow = Object.entries(profile.workflow ?? {});
  const paths = Object.entries(profile.paths ?? {});
  const ops = profileOps(s);
  if (json) {
    return {
      text: toJson(
        {
          profile: profile.id,
          source: profile.source ?? null,
          chosen: s.profileSource === 'named' ? { by: 'target', target: s.name } : { by: 'auto-detection', match: profile.match ?? null, considered: s.considered },
          ...(profile.status !== undefined ? { status: profile.status } : {}),
          quirks: Object.fromEntries(quirks),
          workflow: Object.fromEntries(workflow),
          paths: Object.fromEntries(paths),
          pathParams: Object.fromEntries(
            paths.flatMap(([n]) => {
              const t = s.client.content.namedPathTemplate(n);
              return t === undefined || t.params.length === 0 ? [] : [[n, t.params.map((p) => ({ name: p, optional: t.optional.has(p) }))]];
            }),
          ),
          operations: ops.map((d) => ({ name: d.name, description: d.description, mutates: d.mutates })),
          definition: profile.definition ?? null,
        },
        2,
      ),
    };
  }
  const width = Math.max(0, ...paths.map(([n]) => n.length + 1), ...ops.map((d) => d.name.length + 2));
  const text = [
    `profile   ${profile.id}${profile.status === undefined ? '' : ` (${profile.status})`}`,
    `source    ${source}`,
    `chosen    ${chosen}`,
    `quirks    ${quirks.length === 0 ? '(none)' : quirks.map(([k, v]) => `${k} ${String(v)}`).join(', ')}`,
    `workflow  ${workflow.length === 0 ? '(library defaults)' : `${workflow.map(([k, v]) => `${k} ${String(v)}`).join(', ')} (the rest: library defaults)`}`,
    '',
    ...(paths.length === 0 ? ['(no named paths)'] : ['named paths:', ...paths.flatMap(([n, p]) => namedPathLines(s, n, p, width))]),
    '',
    ...(ops.length === 0 ? ['(no operations)'] : ['operations (* changes state):', ...ops.map((d) => `  ${`${d.name}${d.mutates ? ' *' : ''}`.padEnd(width)}  ${d.description}`)]),
  ].map((l) => escapeControls(l)).join('\n');
  return { text };
}

/** A named path's line in the profile view, and its parameters' line if it takes any. */
function namedPathLines(s: ActiveSession, name: string, path: string, width: number): string[] {
  const line = `  ${`@${name}`.padEnd(width)}  ${path}`;
  const template = s.client.content.namedPathTemplate(name);
  if (template === undefined || template.params.length === 0) return [line];
  return [line, `  ${''.padEnd(width)}    params: ${paramList(template)}`];
}

/** Map `--some-param value` options onto the descriptor's parameters, typed and checked. */
function deviceArgs(d: OperationDescriptor, options: ParsedArgs['options'], listed: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const camel = (s: string): string => s.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
  for (const [given, value] of Object.entries(options)) {
    const p = d.params.find((x) => x.name === given || x.name === camel(given));
    if (p === undefined) {
      const known = d.params.map((x) => `--${x.name}`).join(', ') || 'none';
      throw new CliError(`device ${d.name}: unknown option --${given} (options: ${known})`);
    }
    if (Array.isArray(value)) throw new CliError(`device ${d.name}: --${given} takes one value`);
    if (p.type === 'boolean') out[p.name] = value === true || value === 'true';
    else if (value === true || value === undefined) throw new CliError(`device ${d.name}: --${given} needs a value`);
    else if (p.type === 'number') {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new CliError(`device ${d.name}: --${given} must be a number`);
      out[p.name] = n;
    } else out[p.name] = value;
  }
  const missing = d.params.filter((p) => p.required === true && out[p.name] === undefined);
  if (missing.length > 0) throw new CliError(`device ${d.name}: missing ${missing.map((p) => `--${p.name}`).join(', ')}; nothing was sent (${listed})`);
  return out;
}

