/**
 * Where a command's XML comes from (docs/cli.md §6.1): inline, `@file`, or
 * `--edit` in the user's editor; and `--timeout`, which every command that
 * sends a request takes.
 */

import type { Cli } from '../cli.js';
import { CliError, EXIT, usageError } from '../errors.js';
import type { NncHost } from '../host.js';
import { expandHome } from '../paths.js';
import type { OptionSpec, ParsedArgs } from './registry.js';

export const TIMEOUT_OPTION: OptionSpec = { type: 'string', value: '<ms>', description: 'wait this long for the reply instead of the session default' };
export const EDIT_OPTION: OptionSpec = { type: 'boolean', description: "write the XML in $EDITOR, starting from what this command last sent" };

/** `--timeout <ms>`, if given: a positive whole number of milliseconds. */
export function timeoutOf(args: ParsedArgs, command: string): number | undefined {
  const given = args.options['timeout'];
  if (given === undefined) return undefined;
  const ms = typeof given === 'string' ? Number(given) : NaN;
  if (!Number.isInteger(ms) || ms <= 0) throw usageError(`${command}: --timeout must be a positive whole number of milliseconds`);
  return ms;
}

/** Where `@path` arguments are read from. */
export type FileSource = Pick<NncHost, 'files' | 'homeDir'>;

/** Inline XML as given, or the contents of `@path` (`~` is the home directory). */
export async function xmlText(src: FileSource, given: string, failure: (path: string, reason: string) => string): Promise<string> {
  if (!given.startsWith('@')) return given;
  const path = given.slice(1);
  try {
    return await src.files.readText(expandHome(path, src.homeDir));
  } catch (err) {
    throw new CliError(failure(path, (err as { code?: string }).code ?? (err as Error).message));
  }
}

const cancelled = (): CliError => new CliError('cancelled', EXIT.cancelled);

/**
 * `--edit`: let the user edit the XML this command last sent (or nothing)
 * and return what was saved. An editor that fails, a file left unsaved, or
 * an empty file cancels the command.
 */
export async function editXml(cli: Cli, command: string): Promise<string> {
  if (cli.io.edit === undefined) throw usageError(`${command}: --edit needs an editor, and there is none here`);
  const text = await cli.io.edit(cli.lastXml.get(command) ?? '', command);
  if (text === undefined) throw cancelled();
  return text;
}

/**
 * Wait for work the library can't be told to stop (a device-profile operation
 * takes no per-call options), but give up on Ctrl-C or after `timeout` ms.
 */
export function stopWaiting<T>(work: Promise<T>, signal: AbortSignal, timeout: number | undefined, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = (): void => {
      done();
      reject(cancelled());
    };
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    if (timeout !== undefined) {
      timer = setTimeout(() => {
        done();
        reject(new CliError(`${what}: stopped waiting after ${timeout} ms; the operation may still complete on the device`, EXIT.protocol));
      }, timeout);
    }
    work.then(
      (value) => {
        done();
        resolve(value);
      },
      (err: unknown) => {
        done();
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}
