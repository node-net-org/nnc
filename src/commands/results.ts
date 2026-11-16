/**
 * Sending a request and showing what came back, shared by every command that
 * sends an operation.
 */

import { CapabilityError, RpcError, XmlElement, toObject, type RpcErrorDetail, type RpcReply } from '@node-net/netconf/core';
import { CliError, EXIT } from '../errors.js';
import { toJson } from '../render/safe.js';
import { prettyXml } from '../render/xml.js';
import type { Cli } from '../cli.js';
import type { CommandResult, ParsedArgs, ResultForms } from './registry.js';

/**
 * Run a request, turning rpc-errors, missing capabilities and argument errors
 * into CLI errors. The library checks capabilities and builds the request
 * before writing anything, so those failures send nothing.
 */
export async function send<T>(request: () => Promise<T>): Promise<T> {
  try {
    return await request();
  } catch (err) {
    if (err instanceof RpcError) throw new CliError(describeRpcError(err), EXIT.rpcError);
    if (err instanceof CapabilityError) throw new CliError(`${err.message}; nothing was sent`);
    // Argument errors from building the request: thrown before anything is written.
    if (err instanceof TypeError || err instanceof RangeError) throw new CliError(err.message);
    throw err;
  }
}

/** Each rpc-error as a block (docs/cli.md §6.6). */
export function describeRpcError(err: RpcError): string {
  return describeErrors(err.errors, 'rpc-error');
}

/**
 * Control characters as escapes, so a device's message can't move the cursor
 * or ring the bell: \n, \r and \t by name, the rest of C0, DEL and C1 as \xNN.
 */
export function escapeControls(text: string): string {
  // Matching control characters is the point here.
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, (c) => {
    if (c === '\n') return '\\n';
    if (c === '\r') return '\\r';
    if (c === '\t') return '\\t';
    return `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`;
  });
}

/**
 * One block per error, numbered when there are several; only the fields the
 * device sent:
 *
 *   rpc-error 1 of 2: lock-denied
 *     type      protocol
 *     severity  error
 *     message   Lock failed
 *     info      session-id 7
 */
export function describeErrors(errors: readonly RpcErrorDetail[], label: 'rpc-error' | 'warning'): string {
  return errors
    .map((e, i) => {
      const head = errors.length === 1 ? `${label}: ${escapeControls(e.tag)}` : `${label} ${i + 1} of ${errors.length}: ${escapeControls(e.tag)}`;
      const info = e.info?.elements.map((el) => `${el.name} ${el.textContent().trim()}`).join(', ');
      const fields: [string, string | undefined][] = [
        ['type', e.type],
        ['severity', e.severity],
        ['app-tag', e.appTag],
        ['path', e.path],
        ['message', e.message],
        ['info', info === '' ? undefined : info],
      ];
      return [head, ...fields.filter(([, v]) => v !== undefined).map(([k, v]) => `  ${k.padEnd(9)} ${escapeControls(v!)}`)].join('\n');
    })
    .join('\n');
}

/** The output options every command that shows a reply takes (docs/cli.md §6.6). */
export const JSON_OPTION = {
  type: 'boolean',
  description: 'show the result as JSON: YANG data from get, get-config and get-data as RFC 7951 JSON typed by the device schema; other replies as toObject() (local names, string values)',
} as const;
export const XML_OPTION = { type: 'boolean', description: "show the result as XML (the default, unless output says otherwise or the result has a view of its own, like compare's diff)" } as const;
export const RAW_OPTION = { type: 'boolean', description: 'show the reply exactly as received, <rpc-reply> included' } as const;
export const PAGE_OPTION = { type: 'boolean', description: 'page a long result on a terminal (--no-page: never)', default: 'on' } as const;
export const OUTPUT_OPTIONS = { xml: XML_OPTION, json: JSON_OPTION, raw: RAW_OPTION, page: PAGE_OPTION } as const;

/**
 * A reply in each format. Data is shown without its wrapper; with JSON, data
 * becomes `toObject()` of the data's children, text data a JSON string, and
 * `<ok/>` `{"ok": true}`. Its rpc-error warnings go with it, to be shown on
 * standard error after the result (docs/cli.md §6.6).
 */
export function renderReply(reply: RpcReply): CommandResult {
  const warnings = reply.warnings.length === 0 ? undefined : [describeErrors(reply.warnings, 'warning')];
  const forms = replyForms(reply);
  return { text: forms.xml, forms, ...(warnings !== undefined ? { warnings } : {}) };
}

function replyForms(reply: RpcReply): ResultForms {
  if (reply.data !== undefined) {
    if (reply.data.elements.length > 0) {
      return { xml: reply.data.elements.map((e) => prettyXml(e)).join('\n'), json: asJson(toObject(reply.data)) };
    }
    // Data that is text, such as a YANG module from get-schema.
    const text = reply.data.textContent();
    return { xml: text.trim() === '' ? '(no data)' : text.replace(/\n$/, ''), json: asJson(text.trim() === '' ? {} : text) };
  }
  // A reply holding only warnings succeeded (RFC 6241 §4.3).
  const onlyWarnings = reply.warnings.length > 0 && reply.element.elements.every((e) => e.name === 'rpc-error');
  if (reply.ok || onlyWarnings) return { xml: 'ok', json: asJson({ ok: true }) };
  return { xml: prettyXml(reply.element), json: asJson(toObject(reply.element)) };
}

/** An operation returns a reply, or (a profile operation) text, an element or plain data. */
export function renderResult(result: unknown): CommandResult {
  const shown = (forms: ResultForms): CommandResult => ({ text: forms.xml, forms });
  if (result === undefined || result === null) return shown({ xml: 'ok', json: asJson({ ok: true }) });
  if (typeof result === 'string') return shown({ xml: result, json: asJson(result) });
  if (result instanceof XmlElement) return shown({ xml: prettyXml(result), json: asJson({ [result.name]: toObject(result) }) });
  if (typeof result === 'object' && 'element' in result && (result).element instanceof XmlElement) {
    return renderReply(result as RpcReply);
  }
  return shown({ xml: asJson(result), json: asJson(result) });
}

function asJson(value: unknown): string {
  return toJson(value, 2);
}

/** Whether a command's result is shown as JSON: --json, or `output json` without --xml or --raw. */
export function wantsJson(cli: Pick<Cli, 'output'>, args: ParsedArgs): boolean {
  if (args.options['json'] === true) return true;
  return cli.output.format === 'json' && args.options['xml'] !== true && args.options['raw'] !== true;
}
