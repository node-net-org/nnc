/**
 * The origins view of a `<get-data>` reply made with `--with-origin` (RFC 8526,
 * CLI OPS-14): one line per leaf with its path, value and resolved origin, and
 * a count by origin. `--xml`, `--json` and `--raw` show the other forms.
 *
 *   /ietf-interfaces:interfaces/interface[name=eth0]/name          eth0  intended
 *   /ietf-interfaces:interfaces/interface[name=eth0]/oper-status   up    learned
 *   2 leaves: 1 intended, 1 learned
 *
 * The library is schema-agnostic, so list keys are inferred: elements that
 * repeat among their siblings are a list's entries, keyed by their first leaf,
 * or by as many leading leaves as it takes to tell all the entries apart, the
 * same for every entry of that list (NETCONF's XML encoding puts a list's keys
 * first, in order, RFC 7950 §7.8.5). A list with a single entry shows no key.
 *
 * Device text can't fake the view's structure: key values that aren't plain
 * words, origin names that aren't YANG identifiers and odd namespaces are
 * quoted, values follow compare's quoting, and the count is by resolved
 * origin, not by its displayed text. The walk is linear in the reply's size.
 */

import { NETCONF_NS, type XmlElement } from '@node-net/netconf/core';
import { NMDA_NS, origins } from '@node-net/netconf/operations/nmda';
import { escapeTerminal, shownValue, toJson } from './safe.js';

/** One leaf: its path, its text, and its resolved origin (null when none is in its ancestry). */
export interface OriginLine {
  readonly path: string;
  readonly value: string;
  readonly origin: string | null;
}

/** A namespace's YANG module name, if the session knows it. */
export type ModuleOf = (namespace: string) => string | undefined;

/** The reply's `<data>` (RFC 8526 puts it in the NMDA namespace; accept NETCONF's too). */
function dataOf(reply: XmlElement): XmlElement | undefined {
  return reply.child('data', NMDA_NS) ?? reply.child('data', NETCONF_NS);
}

const isLeaf = (el: XmlElement): boolean => el.elements.length === 0;

/** Every namespace an element in the reply's data uses, so the caller can look up module names first. */
export function namespacesIn(reply: XmlElement): Set<string> {
  const out = new Set<string>();
  const walk = (el: XmlElement): void => {
    if (el.ns !== undefined) out.add(el.ns);
    for (const c of el.elements) walk(c);
  };
  for (const top of dataOf(reply)?.elements ?? []) walk(top);
  return out;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
/** A key value that reads as itself inside `[k=v]`: no brackets, slashes, equals signs, quotes or whitespace. */
const PLAIN_KEY = /^[^[\]/="'\s\\]+$/;

/** `"…"` with `"` and `\` escaped, for text that isn't plain. */
const quoted = (text: string): string => JSON.stringify(text);

/** The leading leaf children of a list entry: where its keys are. */
function leadingLeaves(el: XmlElement): XmlElement[] {
  const out: XmlElement[] = [];
  for (const c of el.elements) {
    if (!isLeaf(c)) break;
    out.push(c);
  }
  return out;
}

/** `[k1=v1]…` for each entry of one list: the fewest leading leaves that tell all its entries apart. */
function listKeys(entries: readonly XmlElement[]): Map<XmlElement, string> {
  const leaves = entries.map(leadingLeaves);
  const most = Math.max(0, ...leaves.map((l) => l.length));
  const tuple = (i: number, n: number): string =>
    leaves[i]!
      .slice(0, n)
      .map((l) => `${l.name}\u0000${l.textContent()}`)
      .join('\u0001');
  let n = Math.min(1, most);
  while (n < most && new Set(entries.map((_, i) => tuple(i, n))).size < entries.length) n++;
  const out = new Map<XmlElement, string>();
  entries.forEach((entry, i) => {
    const text = leaves[i]!
      .slice(0, n)
      .map((l) => {
        const v = l.textContent();
        return `[${l.name}=${PLAIN_KEY.test(v) ? v : quoted(v)}]`;
      })
      .join('');
    out.set(entry, text);
  });
  return out;
}

/** The leaves of the reply's data in document order, with paths and resolved origins. */
export function originLines(reply: XmlElement, moduleOf: ModuleOf): OriginLine[] {
  const data = dataOf(reply);
  if (data === undefined) return [];
  // Resolved from the reply root, so origins inherit; prefixes resolve wherever the server declared them.
  const resolved = origins(reply, { moduleOf });
  const qualified = (ns: string | undefined, name: string): string => {
    if (ns === undefined || ns === '') return name;
    const module = moduleOf(ns);
    return `${module !== undefined && IDENTIFIER.test(module) ? module : `{${ns.replace(/[{}\\]/g, (c) => `\\${c}`)}}`}:${name}`;
  };
  // A standard origin by name (`intended`); another module's as module:name, or {namespace}:name for a module the session doesn't know.
  const originText = (id: string | undefined): string | null => {
    if (id === undefined) return null;
    const colon = id.lastIndexOf(':');
    const module = id.slice(0, colon);
    const name = IDENTIFIER.test(id.slice(colon + 1)) ? id.slice(colon + 1) : quoted(id.slice(colon + 1));
    if (module === 'ietf-origin') return name;
    return IDENTIFIER.test(module) ? `${module}:${name}` : `{${module.replace(/[{}\\]/g, (c) => `\\${c}`)}}:${name}`;
  };

  const lines: OriginLine[] = [];
  const walk = (children: readonly XmlElement[], parentPath: string, parentNs: string | undefined): void => {
    // Siblings grouped once per parent, so each list's keys are worked out once.
    const groups = new Map<string, XmlElement[]>();
    for (const c of children) {
      const k = `${c.ns ?? ''}\u0000${c.name}`;
      const g = groups.get(k);
      if (g === undefined) groups.set(k, [c]);
      else g.push(c);
    }
    const keys = new Map<XmlElement, string>();
    for (const g of groups.values()) if (g.length > 1) for (const [el, key] of listKeys(g)) keys.set(el, key);
    for (const el of children) {
      const step = (el.ns === parentNs ? el.name : qualified(el.ns, el.name)) + (keys.get(el) ?? '');
      const path = `${parentPath}/${step}`;
      if (isLeaf(el)) lines.push({ path, value: el.textContent(), origin: originText(resolved.get(el)) });
      else walk(el.elements, path, el.ns);
    }
  };
  walk(data.elements, '', undefined);
  return lines;
}

/** Widest path and value columns padded to; longer ones just push the next column along. */
const MAX_PATH_COLUMN = 80;
const MAX_VALUE_COLUMN = 32;

/** The view: aligned path, value and origin columns, then a count by resolved origin. */
export function originsText(lines: readonly OriginLine[]): string {
  if (lines.length === 0) return 'no data';
  const shown = lines.map((l) => ({ path: escapeTerminal(l.path), value: shownValue(l.value), origin: l.origin === null ? '-' : escapeTerminal(l.origin) }));
  const pathWidth = Math.min(MAX_PATH_COLUMN, Math.max(...shown.map((l) => l.path.length)));
  const valueWidth = Math.min(MAX_VALUE_COLUMN, Math.max(...shown.map((l) => l.value.length)));
  // Counted by the resolved origin, so no origin name can pass for "none" or for another count.
  const counts = new Map<string | null, number>();
  for (const l of lines) counts.set(l.origin, (counts.get(l.origin) ?? 0) + 1);
  const n = lines.length;
  const tally = [...counts].map(([origin, count]) => `${count} ${origin === null ? 'without an origin' : escapeTerminal(origin)}`).join(', ');
  return [
    ...shown.map((l) => `${l.path.padEnd(pathWidth)}   ${l.value.padEnd(valueWidth)}   ${l.origin}`),
    `${n} lea${n === 1 ? 'f' : 'ves'}: ${tally}`,
  ].join('\n');
}

/** The view and its JSON form (`[{ path, value, origin }]`). */
export function originsForms(reply: XmlElement, moduleOf: ModuleOf): { readonly text: string; readonly json: string } {
  const lines = originLines(reply, moduleOf);
  return { text: originsText(lines), json: toJson(lines, 2) };
}
