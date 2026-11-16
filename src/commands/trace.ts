/**
 * `trace` (docs/cli.md §5, TRACE-01..06): choose the levels to watch, whether
 * secrets are hidden, and whether entries also go to a file.
 */

import { CliError, usageError } from '../errors.js';
import { TRACE_LEVELS, TraceSettings, type TraceLevel } from '../trace/settings.js';
import { usageOf, type Command } from './registry.js';

const LEVEL_ARG = { name: 'level', description: 'bytes, frames or xml; or off', optional: true, values: [...TRACE_LEVELS, 'off'] } as const;

export const traceCommand: Command = {
  name: 'trace',
  group: 'nnc',
  example: 'trace bytes xml --file session.log',
  summary: 'Watch the layers: bytes on the channel, whole messages (frames), or messages as XML; trace off stops',
  args: [LEVEL_ARG, LEVEL_ARG, LEVEL_ARG],
  options: {
    redact: { type: 'boolean', description: 'hide secret values in traces; --no-redact shows them', default: 'on' },
    file: { type: 'string', value: '<path>', description: 'also append entries to this file' },
    quiet: { type: 'boolean', description: 'with a file: write entries only to the file' },
  },
  kinds: ['none', 'client', 'framed', 'raw'],
  run(cli, args) {
    const settings = cli.trace;
    const words = args.positional;
    const { redact, file, quiet } = args.options;

    if (words.includes('off')) {
      if (words.length > 1 || file !== undefined || quiet !== undefined) {
        throw usageError(`trace: off takes nothing else\nusage: ${usageOf(traceCommand)}`);
      }
      settings.off();
      if (typeof redact === 'boolean') settings.redact = redact;
      return Promise.resolve({ text: settings.describe() });
    }

    const levels: TraceLevel[] = [];
    for (const w of words) {
      if (!(TRACE_LEVELS as readonly string[]).includes(w)) {
        throw usageError(`trace: unknown level ${JSON.stringify(w)} (bytes, frames, xml or off)\nusage: ${usageOf(traceCommand)}`);
      }
      if (!levels.includes(w as TraceLevel)) levels.push(w as TraceLevel);
    }
    if (quiet === true && file === undefined && settings.filePath === undefined) {
      throw new CliError('trace: --quiet needs a trace file (--file <path>)');
    }

    // Open the file first: if it fails, nothing changes.
    const opened = typeof file === 'string' ? TraceSettings.openFile(cli.host.files, file) : undefined;
    if (levels.length > 0) settings.setLevels(levels);
    if (typeof redact === 'boolean') settings.redact = redact;
    if (opened !== undefined) settings.useFile(opened, cli.open?.name);
    if (typeof quiet === 'boolean') settings.quiet = quiet;
    return Promise.resolve({ text: settings.describe() });
  },
};
