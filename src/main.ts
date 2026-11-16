#!/usr/bin/env node
/**
 * nnc: the @node-net/netconf command-line client (docs/cli.md).
 *
 *   nnc [<target> [--read-only] [--framed | --raw]] [-t <path>] [-c <command>... | -s <file|-> | -i]
 *
 * Given a target, nnc connects first. With -c or --script it runs those
 * commands and exits, stopping at the first failure unless the commands say
 * `set on-error continue`. Otherwise it starts the prompt, or, when standard
 * input isn't a terminal, reads a script from it (docs/cli.md §10).
 */

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { EXIT, type ExitCode } from './errors.js';
import { createNodeHost } from './node/host.js';
import { runNnc } from './run.js';

const USAGE = `usage: nnc [<target> [--read-only] [--framed | --raw]] [-t <path>]
           [-c <command>]... | -s <file|-> | -i

  <target>             connect to this target (a name from the targets file, or user@host[:port]) first
  --read-only          open that session read-only
  --framed, --raw      open a framed or raw session instead of a client session
  -c, --command <cmd>  run a command and exit; may be repeated
  -s, --script <file|->
                       run the commands in a file and exit; - reads them from standard input
  -i, --interactive    start the prompt even when standard input isn't a terminal
  -t, --targets <path> the targets file (default $NNC_TARGETS, else ~/.config/net-netconf/targets.json)
  -C, --config <path>  the same as --targets
  -V, --version        print the version
  -h, --help           print this help

With no -c or --script, nnc starts the prompt when standard input is a terminal,
and otherwise reads a script from standard input. Type help at the prompt for the
commands. Scripts and -c stop at the first failed command unless they say
set on-error continue; the exit code is then that of the first failure.

Exit codes:
  0  every command succeeded
  1  the device returned an <rpc-error>
  2  a command couldn't be parsed or was used wrongly
  3  a connection, authentication or host-key failure
  4  refused by the read-only guard
  5  a timeout, a protocol or framing error, or the session closed unexpectedly
130  cancelled with Ctrl-C`;

async function main(argv: readonly string[]): Promise<ExitCode> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        command: { type: 'string', short: 'c', multiple: true },
        script: { type: 'string', short: 's' },
        interactive: { type: 'boolean', short: 'i' },
        targets: { type: 'string', short: 't' },
        config: { type: 'string', short: 'C' },
        'read-only': { type: 'boolean' },
        framed: { type: 'boolean' },
        raw: { type: 'boolean' },
        version: { type: 'boolean', short: 'V' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err) {
    return usage((err as Error).message);
  }
  const { values, positionals } = parsed;
  if (values.version === true) {
    const require = createRequire(import.meta.url);
    const cli = require('../package.json') as { version: string };
    const lib = require('@node-net/netconf/package.json') as { version: string };
    process.stdout.write(`nnc ${cli.version} (@node-net/netconf ${lib.version})\n`);
    return EXIT.ok;
  }
  if (values.help === true) {
    process.stdout.write(`${USAGE}\n`);
    return EXIT.ok;
  }
  if (positionals.length > 1) return usage(`one target at most (got ${positionals.join(', ')})`);
  const target = positionals[0];
  const connectOptions = (['read-only', 'framed', 'raw'] as const).filter((o) => values[o] === true);
  if (target === undefined && connectOptions.length > 0) return usage(`--${connectOptions[0]} applies to a target; give one`);

  if (values.targets !== undefined && values.config !== undefined) return usage('--config is another name for --targets; give one');
  const targetsPath = values.targets ?? values.config;

  const commands = values.command ?? [];
  const scriptPath = values.script;
  if (commands.length > 0 && scriptPath !== undefined) return usage('use -c or --script, not both');
  if (values.interactive === true && (commands.length > 0 || scriptPath !== undefined)) {
    return usage(`-i starts the prompt; it can't be used with ${commands.length > 0 ? '-c' : '--script'}`);
  }
  const prompt = commands.length === 0 && scriptPath === undefined && (values.interactive === true || process.stdin.isTTY);

  // A script file is read before anything connects, so a missing one costs nothing.
  let fileLines: string[] | undefined;
  if (scriptPath !== undefined && scriptPath !== '-') {
    try {
      fileLines = (await readFile(scriptPath, 'utf8')).split(/\r?\n/);
    } catch (err) {
      process.stderr.write(`nnc: cannot read script ${scriptPath}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}\n`);
      return EXIT.usage;
    }
    if (fileLines.at(-1) === '') fileLines.pop();
  }

  return runNnc(createNodeHost(), {
    ...(target !== undefined ? { target, connectOptions } : {}),
    ...(targetsPath !== undefined ? { targetsPath } : {}),
    source: prompt
      ? { kind: 'prompt' }
      : commands.length > 0
        ? { kind: 'commands', commands }
        : fileLines !== undefined && scriptPath !== undefined
          ? { kind: 'script', label: scriptPath, lines: fileLines }
          : { kind: 'input' },
  });
}

function usage(message: string): ExitCode {
  process.stderr.write(`nnc: ${message}\n${USAGE}\n`);
  return EXIT.usage;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`nnc: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exitCode = EXIT.protocol;
  },
);
