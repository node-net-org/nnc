/**
 * How results are shown (docs/cli.md §6.6): `output` sets the session's
 * format and paging, `show-last` shows the last result or rpc-error again,
 * and `history` lists the commands kept from this and earlier runs.
 */

import type { BytesView, OutputFormat } from '../cli.js';
import { usageError } from '../errors.js';
import type { Command } from './registry.js';
import { OUTPUT_OPTIONS, send, wantsJson } from './results.js';

const ALL = ['none', 'client', 'framed', 'raw'] as const;
const FORMATS: readonly OutputFormat[] = ['xml', 'json', 'raw'];
const VIEWS: readonly BytesView[] = ['text', 'hex'];

export const outputCommand: Command = {
  name: 'output',
  summary: 'Set the default output format (xml, json or raw) and paging for the session; with nothing, show them',
  describe: { raw: 'Show received bytes as text or as a hex dump, and set paging; with nothing, show them' },
  args: [{ name: 'format', description: 'xml, json or raw; in a raw session, text or hex', optional: true, values: (cli) => (cli.kind === 'raw' ? VIEWS : FORMATS) }],
  options: { page: { type: 'boolean', description: 'page long results on a terminal (--no-page: never)', default: 'on' } },
  kinds: ALL,
  group: 'nnc',
  example: 'output json --no-page',
  run(cli, args) {
    const format = args.positional[0];
    const raw = cli.kind === 'raw';
    if (format !== undefined) {
      if (raw) {
        if (!(VIEWS as readonly string[]).includes(format)) {
          const why = (FORMATS as readonly string[]).includes(format) ? `${format} is for replies in client sessions; ` : '';
          throw usageError(`output: in this raw session, use text or hex (${why}got ${JSON.stringify(format)})`);
        }
        cli.output.bytes = format as BytesView;
      } else {
        if (!(FORMATS as readonly string[]).includes(format)) {
          const why = (VIEWS as readonly string[]).includes(format) ? `${format} is for received bytes in raw sessions; ` : '';
          throw usageError(`output: use xml, json or raw (${why}got ${JSON.stringify(format)})`);
        }
        cli.output.format = format as OutputFormat;
      }
    }
    const page = args.options['page'];
    if (typeof page === 'boolean') cli.output.page = page;
    if (format !== undefined || page !== undefined) return Promise.resolve(undefined);
    const shown = raw ? `received bytes as ${cli.output.bytes}` : `format ${cli.output.format}`;
    return Promise.resolve({ text: `${shown} · paging ${cli.output.page ? 'on' : 'off'}` });
  },
};

export const showLastCommand: Command = {
  name: 'show-last',
  summary: 'Show the last result or rpc-error again (--raw: the reply exactly as received)',
  args: [],
  options: { ...OUTPUT_OPTIONS },
  kinds: ALL,
  group: 'nnc',
  example: 'show-last --raw',
  run(cli, args) {
    const last = cli.last;
    if (last === undefined) return Promise.resolve({ text: 'nothing to show yet' });
    if (last.kind === 'result') {
      const result = last.result;
      // YANG data first shown in another format: convert it to RFC 7951 JSON now, once.
      if ('forms' in result && result.forms?.jsonLater !== undefined && wantsJson(cli, args)) {
        const { jsonLater, ...forms } = result.forms;
        return send(jsonLater).then((json) => {
          const converted = { ...result, forms: { ...forms, json } };
          cli.last = { kind: 'result', result: converted };
          return converted;
        });
      }
      return Promise.resolve(result);
    }
    if (args.options['raw'] === true) {
      return Promise.resolve(last.raw === undefined ? { text: '(the reply was not captured)' } : { raw: last.raw.endsWith('\n') ? last.raw : `${last.raw}\n` });
    }
    // The last thing shown was an error: show its blocks again, where errors go.
    cli.io.err(last.message);
    return Promise.resolve(undefined);
  },
};

export const historyCommand: Command = {
  name: 'history',
  summary: 'List the commands kept from this and earlier runs, numbered (~/.config/net-netconf/history)',
  args: [],
  options: {},
  kinds: ALL,
  group: 'nnc',
  example: 'history',
  run(cli) {
    const history = cli.host.history;
    if (history === undefined) return Promise.resolve({ text: '(history is not kept here)' });
    const lines = history.load();
    if (lines.length === 0) return Promise.resolve({ text: '(no history)' });
    const width = String(lines.length).length;
    return Promise.resolve({ text: lines.map((l, i) => `${String(i + 1).padStart(width)}  ${l}`).join('\n') });
  },
};
