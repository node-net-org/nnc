/**
 * The compact view of `diff` (CLI PATH-13): how two datastores differ, as the
 * library's client-side comparison reports it, in the shape of compare's diff
 * (render/compare.ts). One line per change, a leaf's value inline, a
 * container's or list entry's value as indented JSON, and a closing count.
 *
 *   ~ replace  /ietf-interfaces:interfaces/interface[name='eth0']/mtu   1500 → 9000
 *   + create   /ietf-interfaces:interfaces/interface[name='eth1']
 *       {
 *         "name": "eth1"
 *       }
 *   2 changes (running → candidate)
 */

import type { DatastoreChange } from '@node-net/netconf/core';
import { shownValue, toJson } from './safe.js';

type Value = Exclude<DatastoreChange['value'], undefined>;

const SIGNS: Readonly<Record<DatastoreChange['operation'], string>> = { create: '+', delete: '-', replace: '~', move: '>' };

/** A value shown on the change's own line: a string, number or boolean, or an empty leaf's `[null]`. */
function inline(value: Value | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return shownValue(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value) && value.length === 1 && value[0] === null) return '[null]';
  return undefined;
}

/** A bigger value as indented JSON, under an optional label. */
function block(value: Value | undefined, label?: string): string[] {
  if (value === undefined) return [];
  const lines = toJson(value, 2).split('\n');
  return label === undefined ? lines.map((l) => `    ${l}`) : [`    ${label}`, ...lines.map((l) => `      ${l}`)];
}

function changeLines(change: DatastoreChange): string[] {
  const { operation, position } = change;
  const where = position === undefined ? '' : position.where === 'first' ? '   first' : `   after ${shownValue(position.anchor)}`;
  const head = `${SIGNS[operation]} ${operation.padEnd(8)} ${shownValue(change.path)}${where}`;
  if (operation === 'move') return [head];
  if (operation === 'replace') {
    const was = inline(change.previous);
    const now = inline(change.value);
    if (was !== undefined && now !== undefined) return [`${head}   ${was} → ${now}`];
    return [head, ...block(change.previous, 'was:'), ...block(change.value, 'now:')];
  }
  const value = operation === 'delete' ? change.previous : change.value;
  const leaf = inline(value);
  return leaf !== undefined ? [`${head}   ${leaf}`] : [head, ...block(value)];
}

/** The compact diff, ending with a count of the changes from `source` to `target`. */
export function diffText(changes: readonly DatastoreChange[], source: string, target: string): string {
  const between = `(${source} → ${target})`;
  if (changes.length === 0) return `no differences ${between}`;
  const n = changes.length;
  return [...changes.flatMap(changeLines), `${n} change${n === 1 ? '' : 's'} ${between}`].join('\n');
}

/** The changes as JSON, as the library returns them. */
export function diffJson(changes: readonly DatastoreChange[]): string {
  return toJson(changes, 2);
}
