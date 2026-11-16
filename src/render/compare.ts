/**
 * The compact view of a `<compare>` reply (RFC 9144, CLI OPS-13): one line per
 * difference, leaves inline, bigger values as indented XML, and a closing
 * count. `--xml`, `--json` and `--raw` show the other forms.
 *
 *   - delete   /clixon-example:table/parameter=a
 *       <parameter xmlns="urn:example:clixon">
 *         …
 *   ~ replace  /clixon-example:table/parameter=b/value   2 → 22
 *   3 differences (running → candidate)
 */

import { toObject, type XmlElement } from '@node-net/netconf/core';
import { parseCompareReply, type CompareEdit, type CompareResult } from '@node-net/netconf/operations/compare';
import { shownValue, toJson } from './safe.js';
import { prettyXml } from './xml.js';

const SIGNS: Readonly<Record<string, string>> = {
  create: '+',
  insert: '+',
  delete: '-',
  remove: '-',
  replace: '~',
  merge: '~',
  move: '>',
};

const safe = shownValue;

/** One element with no child elements or attributes (an origin annotation, say): a leaf, shown inline. */
function leafText(values: readonly XmlElement[]): string | undefined {
  if (values.length !== 1 || values[0]!.elements.length > 0 || values[0]!.attributes.length > 0) return undefined;
  return safe(values[0]!.textContent());
}

function block(values: readonly XmlElement[], label?: string): string[] {
  if (values.length === 0) return [];
  const lines = values.flatMap((v) => prettyXml(v).split('\n'));
  return label === undefined ? lines.map((l) => `    ${l}`) : [`    ${label}`, ...lines.map((l) => `      ${l}`)];
}

function editLines(edit: CompareEdit): string[] {
  const op = edit.operation;
  const sign = SIGNS[op] ?? '?';
  const where = edit.where !== undefined ? `   ${safe(edit.where)}${edit.point !== undefined ? ` ${safe(edit.point)}` : ''}` : '';
  const head = `${sign} ${safe(op).padEnd(8)} ${safe(edit.target)}${where}`;
  // RFC 9144 puts the old node in source-value; Clixon puts a deleted node in value.
  const before = edit.sourceValue.length > 0 ? edit.sourceValue : op === 'delete' || op === 'remove' ? edit.value : [];
  const after = op === 'delete' || op === 'remove' ? [] : edit.value;

  if (op === 'delete' || op === 'remove') {
    const leaf = leafText(before);
    return leaf !== undefined ? [`${head}   ${leaf}`] : [head, ...block(before)];
  }
  if (op === 'replace' || op === 'merge') {
    const was = leafText(before);
    const now = leafText(after);
    if ((was !== undefined || before.length === 0) && (now !== undefined || after.length === 0)) {
      // A server need not send the old value (source-value is optional).
      return [`${head}   ${was ?? '(not sent)'} → ${now ?? '(nothing)'}`];
    }
    return [head, ...block(before, 'was:'), ...block(after, 'now:')];
  }
  const leaf = leafText(after);
  return leaf !== undefined ? [`${head}   ${leaf}`] : [head, ...block(after)];
}

/** The compact diff, ending with a count of the differences between `source` and `target`. */
export function compareText(result: CompareResult, source: string, target: string): string {
  const between = `(${safe(source)} → ${safe(target)})`;
  if (result.noMatches) return `no matches ${between}`;
  if (result.edits.length === 0) return `no differences ${between}`;
  const lines = result.edits.flatMap(editLines);
  const n = result.edits.length;
  return [...lines, `${n} difference${n === 1 ? '' : 's'} ${between}`].join('\n');
}

/** The decoded differences as JSON: values as `{ name: toObject() }` entries. */
export function compareJson(result: CompareResult): string {
  const values = (els: readonly XmlElement[]) => els.map((e) => ({ [e.name]: toObject(e) }));
  return toJson(
    {
      noMatches: result.noMatches,
      ...(result.patchId !== undefined && result.patchId !== '' ? { patchId: result.patchId } : {}),
      ...(result.comment !== undefined ? { comment: result.comment } : {}),
      edits: result.edits.map((e) => ({
        editId: e.editId,
        operation: e.operation,
        target: e.target,
        ...(e.point !== undefined ? { point: e.point } : {}),
        ...(e.where !== undefined ? { where: e.where } : {}),
        value: values(e.value),
        sourceValue: values(e.sourceValue),
      })),
    },
    2,
  );
}

/** The diff and JSON forms of a compare reply, or undefined when the reply isn't one (left as XML). */
export function compareForms(reply: XmlElement, source: string, target: string): { readonly text: string; readonly json: string } | undefined {
  let result: CompareResult;
  try {
    result = parseCompareReply(reply);
  } catch {
    return undefined;
  }
  return { text: compareText(result, source, target), json: compareJson(result) };
}
