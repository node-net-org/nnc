/**
 * `set`, in two forms that share the name (docs/cli.md §6.3, §10):
 *
 * - `set on-error continue|stop`: what a script or a run of -c commands does
 *   after a failed command. The prompt never stops on a failure, so there the
 *   setting is accepted and has no effect.
 * - `set <path> <value>`: the content write (content.ts). A path starts with
 *   `/` or `@`, so it can't be mistaken for a setting.
 */

import { usageError } from '../errors.js';
import type { OnError } from '../cli.js';
import { setPath } from './content.js';
import type { Command } from './registry.js';
import { JSON_OPTION } from './results.js';
import { TIMEOUT_OPTION } from './xml-input.js';

const VALUES: readonly OnError[] = ['stop', 'continue'];

export const setCommand: Command = {
  name: 'set',
  group: 'nnc',
  // One name, two commands: a content write (client sessions) and nnc's on-error setting (everywhere).
  listings: [
    { group: 'content', kinds: ['client'], summary: "Set a value at a path or @name, following the profile's workflow", mutates: true },
    { group: 'nnc', label: 'set on-error', summary: 'Whether a script goes on after a failed command: continue or stop' },
  ],
  example: 'set @systemName router1-new',
  summary: "Set a value by path, following the profile's workflow: set <path> <value>. Also set on-error continue|stop (whether a script goes on after a failure)",
  args: [
    { name: 'path', description: 'a YANG path or @name to write; or on-error, the setting', optional: true },
    { name: 'value', description: 'the value to write; for on-error, continue or stop', optional: true },
  ],
  options: { timeout: TIMEOUT_OPTION, json: JSON_OPTION },
  kinds: ['none', 'client', 'framed', 'raw'],
  run(cli, args, signal) {
    const [first, value] = args.positional;
    if (first !== undefined && (first.startsWith('/') || first.startsWith('@'))) return setPath(cli, args, signal);
    if (args.options['timeout'] !== undefined || args.options['json'] !== undefined) throw usageError('set on-error takes no options');
    if (first === undefined) return Promise.resolve({ text: `on-error ${cli.onError}` });
    if (first !== 'on-error') {
      throw usageError(`set: ${JSON.stringify(first)} is neither a path (starting with / or @) nor a setting (on-error)\nusage: set <path> <value> | set on-error continue|stop`);
    }
    if (value === undefined) return Promise.resolve({ text: `on-error ${cli.onError}` });
    if (!(VALUES as readonly string[]).includes(value)) throw usageError(`set on-error: use continue or stop (got ${JSON.stringify(value)})`);
    cli.onError = value as OnError;
    return Promise.resolve(undefined);
  },
};
