/**
 * The `help` index (docs/cli.md §6.2): commands by RFC 6241 layer, top-down
 * (content, operations, messages, transport), then the sections beside the
 * layers (device profile, connection, nnc). `help <layer>` shows one layer.
 *
 * Which section a command is in comes from the command itself (`group`, or
 * `listings`); this module only knows each section's heading and order. A
 * command its section's order doesn't name is listed at the end of the
 * section, so a new command can't drop out of help.
 */

import type { OperationDescriptor } from '@node-net/netconf/core';
import type { Cli } from '../cli.js';
import type { ActiveSession } from '../sessions/active.js';
import { EXTENSIONS } from '../sessions/connect.js';
import { missingCapabilities, operationsOf, summaryOf } from './descriptor.js';
import { LAYERS, type Command, type CommandGroup, type Layer, type SessionKind } from './registry.js';

interface Section {
  readonly group: CommandGroup;
  readonly title: (kind: SessionKind) => string;
  /** Labels in the order help lists them; '' starts a new block (a blank line). */
  readonly order: readonly string[];
}

const SECTIONS: readonly Section[] = [
  {
    group: 'content',
    title: () => 'Content layer · client.content',
    order: ['read', 'value', 'set', 'remove', 'resolve', 'diff', 'datastores', 'modules', 'namespaces', '', 'begin', 'changes', 'apply', 'confirm', 'revert', 'abandon'],
  },
  { group: 'operations', title: () => 'Operations layer · client.ops', order: [] },
  { group: 'messages', title: () => 'Messages layer · client.session', order: ['hello', 'capabilities', 'rpc', 'notifications'] },
  {
    group: 'transport',
    title: (kind) => `Transport layer · ${kind === 'raw' ? 'bytes' : 'framed messages'}`,
    order: ['hello', 'send', 'send-hex', 'send-file', 'framing', 'server-hello', 'show', 'eof', 'received'],
  },
  { group: 'profile', title: () => 'Device profile', order: ['profile'] },
  { group: 'connection', title: () => 'Connection', order: ['connect', 'listen', 'disconnect', 'status', 'targets'] },
  { group: 'nnc', title: () => 'nnc', order: ['output', 'show-last', 'trace', 'set on-error', 'history', 'help', 'exit'] },
];

/** A line of the index: a name (indented, with * when it changes state) and its description. */
interface Line {
  readonly indent: number;
  readonly label: string;
  readonly mutates: boolean;
  readonly text: string;
}

/** A section's content: lines, a heading inside the section (an extension), or a blank line. */
type Row = Line | { readonly heading: string } | 'blank';

const ONE_LAYER = `help ${LAYERS.join('|')} shows one layer.`;

export function isLayer(word: string): word is Layer {
  return (LAYERS as readonly string[]).includes(word);
}

/** `help`: every section with something in it, for the current session kind. */
export function helpIndex(cli: Cli): string[] {
  const sections = SECTIONS.map((s) => ({ s, rows: rowsOf(cli, s, cli.kind) })).filter((x) => x.rows.length > 0);
  const lines = [`commands ${where(cli.kind)}:`];
  const width = widthOf(sections.flatMap((x) => x.rows));
  for (const { s, rows } of sections) lines.push('', s.title(cli.kind), ...render(rows, width));
  lines.push(...footer(cli, sections.flatMap((x) => x.rows)), '', `help <command> describes one; ${ONE_LAYER}`);
  return lines;
}

/** `help <layer>`: that layer's section, or where to find it when this session kind has none. */
export function layerHelp(cli: Cli, layer: Layer): string[] {
  const section = SECTIONS.find((s) => s.group === layer)!;
  const rows = rowsOf(cli, section, cli.kind);
  if (rows.length > 0) return [section.title(cli.kind), ...render(rows, widthOf(rows)), ...footer(cli, rows)];
  const kinds = kindsWith(cli, layer).filter((k) => k !== cli.kind);
  const flags = kinds.map((k) => (k === 'client' ? 'connect <target>' : `connect --${k}`));
  return [`no ${layer}-layer commands ${where(cli.kind)}; they are in ${kinds.join(' and ')} sessions (${flags.join(' or ')})`];
}

function where(kind: SessionKind): string {
  return kind === 'none' ? 'with no session open' : `in a ${kind} session`;
}

/** The session kinds with something at this layer. Operations come from descriptors, so only client sessions have them. */
function kindsWith(cli: Cli, layer: Layer): SessionKind[] {
  const kinds: SessionKind[] = ['client', 'framed', 'raw'];
  return kinds.filter((k) => (layer === 'operations' && k === 'client') || commandLines(cli, layer, k).length > 0);
}

function rowsOf(cli: Cli, section: Section, kind: SessionKind): Row[] {
  const own = ordered(commandLines(cli, section.group, kind), section.order);
  const session = kind === 'client' ? cli.session : undefined;
  if (session === undefined) return own;
  if (section.group === 'operations') {
    // `device` is listed with the profile's operations it runs, not on its own.
    const device = own.find((r): r is Line => typeof r === 'object' && 'label' in r && r.label === 'device');
    const rest = own.filter((r) => r !== device);
    return [...rest, ...(rest.length > 0 ? ['blank' as const] : []), ...operationRows(session, device)];
  }
  return own;
}

/** The registry's commands listed in this group for this session kind. */
function commandLines(cli: Cli, group: CommandGroup, kind: SessionKind): Line[] {
  return cli.registry.available(kind).flatMap((cmd) => listingsOf(cmd, kind).filter((l) => l.group === group).map((l) => l.line));
}

function listingsOf(cmd: Command, kind: SessionKind): { group: CommandGroup; line: Line }[] {
  const text = cmd.describe?.[kind] ?? cmd.summary;
  const own = (cmd.listings ?? []).filter((l) => l.kinds === undefined || l.kinds.includes(kind));
  // No listing for this kind: the command's own group, so it is never left out.
  if (own.length === 0) return [{ group: cmd.group, line: { indent: 2, label: cmd.name, mutates: cmd.mutates === true, text } }];
  return own.map((l) => ({
    group: l.group,
    line: { indent: 2, label: l.label ?? cmd.name, mutates: l.mutates ?? cmd.mutates === true, text: l.summary ?? text },
  }));
}

/** Lines in the section's order, split into its blocks; any it doesn't name go last, alphabetically. */
function ordered(lines: readonly Line[], order: readonly string[]): Row[] {
  const blocks: Line[][] = [[]];
  for (const label of order) {
    if (label === '') blocks.push([]);
    else blocks[blocks.length - 1]!.push(...lines.filter((l) => l.label === label));
  }
  const rest = lines.filter((l) => !order.includes(l.label)).sort((a, b) => a.label.localeCompare(b.label));
  blocks[blocks.length - 1]!.push(...rest);
  const rows: Row[] = [];
  for (const block of blocks.filter((b) => b.length > 0)) rows.push(...(rows.length > 0 ? ['blank' as const] : []), ...block);
  return rows;
}

/**
 * The session's operations by extension: base first, then each extension in
 * nnc's order, named by id (as on client.ops) with the RFCs from its own
 * description; then those the device lacks capabilities for.
 */
function operationRows(session: ActiveSession, device: Line | undefined): Row[] {
  const ops = operationsOf(session);
  const available = ops.filter((d) => missingCapabilities(session, d).length === 0);
  const unavailable = ops.filter((d) => missingCapabilities(session, d).length > 0);
  const ids = [...new Set([...EXTENSIONS.map((e) => e.id as string), ...ops.flatMap((d) => (d.extension === undefined ? [] : [d.extension]))])];
  const rows: Row[] = [];
  const base = available.filter((d) => d.extension === undefined);
  if (base.length > 0) rows.push({ heading: 'base · RFC 6241' }, ...base.map((d) => opLine(d, firstSentence(summaryOf(d)))));
  for (const id of ids) {
    const mine = available.filter((d) => d.extension === id);
    if (mine.length > 0) rows.push({ heading: extensionHeading(id) }, ...mine.map((d) => opLine(d, firstSentence(summaryOf(d)))));
  }
  rows.push(...deviceRows(session, device));
  if (unavailable.length > 0) {
    rows.push(
      { heading: `not available on ${session.name} (missing capabilities)` },
      ...unavailable.map((d) => opLine(d, `needs ${missingCapabilities(session, d).join(', ')}`)),
    );
  }
  return rows;
}

function opLine(d: OperationDescriptor, text: string): Line {
  return { indent: 4, label: d.name, mutates: d.mutates, text };
}

/** `nmda · RFC 8526`: the RFCs are the part of the extension's description before its colon. */
function extensionHeading(id: string): string {
  const description = EXTENSIONS.find((e) => e.id === id)?.description ?? '';
  const rfcs = /^(RFC [^:]+):/.exec(description)?.[1];
  return rfcs === undefined ? id : `${id} · ${rfcs}`;
}

/**
 * The device profile's operations, run as `device <operation>` (client.ops.device), under
 * the profile's name, with `device` itself first: it lists them.
 */
function deviceRows(session: ActiveSession, device: Line | undefined): Row[] {
  const profile = session.client.profile;
  const ops = session.client.ops.list.filter((d) => d.device !== undefined);
  const heading = profile === undefined ? 'device · no device profile in use' : `device · profile ${profile.id}`;
  const own: Line[] = device === undefined ? [] : [{ ...device, indent: 4, text: ops.length === 0 ? 'no operations to list or run' : "list the profile's operations and their parameters" }];
  const rows = ops.map((d) => opLine({ ...d, name: `device ${d.name}` }, firstSentence(d.description)));
  return own.length + rows.length === 0 ? [] : [{ heading }, ...own, ...rows];
}

/**
 * The first sentence of a description, for the index; `help <command>` shows all of it.
 * A sentence ends at a full stop before a capital, so "e.g. x" doesn't end one.
 */
export function firstSentence(text: string): string {
  const end = text.search(/\.\s+(?=[A-Z])/);
  return end === -1 ? text.replace(/\.$/, '') : text.slice(0, end);
}

function labelOf(line: Line): string {
  return `${' '.repeat(line.indent)}${line.label}${line.mutates ? ' *' : ''}`;
}

function widthOf(rows: readonly Row[]): number {
  return Math.max(0, ...rows.filter(isLine).map((l) => labelOf(l).length));
}

function isLine(row: Row): row is Line {
  return typeof row === 'object' && 'label' in row;
}

function render(rows: readonly Row[], width: number): string[] {
  return rows.map((r) => (r === 'blank' ? '' : isLine(r) ? `${labelOf(r).padEnd(width)}  ${r.text}` : `  ${r.heading}`));
}

function footer(cli: Cli, rows: readonly Row[]): string[] {
  if (!rows.some((r) => isLine(r) && r.mutates)) return [];
  const s = cli.kind === 'client' ? cli.session : undefined;
  return ['', '* changes state; refused on read-only targets.', ...(s?.readOnly === true ? [`${s.name} is read-only: commands marked * are refused.`] : [])];
}
