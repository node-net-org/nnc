/**
 * The interactive prompt (docs/cli.md §6, REQ-17): line editing, history,
 * completion of commands and their arguments, Ctrl-C and Ctrl-D.
 */

import type { Cli } from './cli.js';
import { expandHome } from './paths.js';
import { PATH_COMMANDS } from './commands/content.js';
import { completeArguments, missingCapabilities, operationsOf } from './commands/descriptor.js';
import { disconnect } from './commands/common.js';
import type { Command, OptionSpec } from './commands/registry.js';
import type { LineEditor, NncHost } from './host.js';
import { sigintAction, type Interrupt } from './interrupt.js';

/** The prompt shown while a command's XML continues onto more lines (docs/cli.md §6.1). */
export const MORE_PROMPT = '...> ';

export async function runRepl(cli: Cli, input: LineEditor, interrupt: Interrupt): Promise<void> {
  const { terminal } = cli.host;
  // A command whose XML is still open; Ctrl-C drops it.
  let pending = false;
  let abandoned = false;
  const onInterrupt = (keypress: boolean): void => {
    if (interrupt.trigger()) return;
    if (pending) {
      pending = false;
      abandoned = true;
      terminal.out('\n');
      input.prompt(cli.promptText());
      return;
    }
    // Ctrl-C at the prompt clears what was typed; with nothing typed it does nothing.
    if (keypress && sigintAction(input.line(), interrupt) === 'clearLine') input.clearLine();
  };
  // The keypress at the prompt, and an interrupt from outside it (kill -INT, or input that isn't a terminal).
  const stopKeypress = input.onInterrupt(() => onInterrupt(true));
  const stopSignal = terminal.onInterrupt(() => onInterrupt(false));

  try {
    for (;;) {
      input.prompt(cli.promptText());
      let text = await input.next();
      if (text === undefined) {
        // Ctrl-D, or the end of piped input.
        if (input.terminal) terminal.out('\n');
        break;
      }
      while (text !== undefined && cli.incomplete(text)) {
        pending = true;
        input.prompt(MORE_PROMPT);
        const more = await input.next();
        // Ctrl-C at ...> dropped the command; this line starts a new one.
        text = abandoned ? more : more === undefined ? text : `${text}\n${more}`;
        if (abandoned) abandoned = false;
        if (more === undefined) break;
      }
      pending = false;
      if (text === undefined) break;
      if (text.trim() === '') continue;
      cli.host.history?.append(text.replaceAll('\n', ' '));
      const command = text;
      await interrupt.run((signal) => cli.execute(command, signal));
      if (cli.exitRequested) break;
    }
  } finally {
    stopSignal();
    stopKeypress();
  }
  // Leaving (exit or Ctrl-D): what arrives now, such as the trace of the closing exchange, isn't followed by a prompt.
  cli.exitRequested = true;
  if (cli.open !== undefined) cli.showMessage(`${await disconnect(cli)}\n`);
}

/**
 * What Tab offers for the word being typed. `last` says, for a completed word,
 * that nothing more is expected after it, so no space is added.
 */
interface Offer {
  readonly candidates: readonly string[];
  readonly last?: boolean | ((word: string) => boolean);
}

/**
 * Tab completion: the commands and operations available now (operations only
 * when the device has their capabilities), then a command's arguments and
 * options from its spec: an argument's values (fixed, or from the CLI's state,
 * such as target names after `connect` and command names after `help`), an
 * option's values, and file paths for a `<path>` option. A single match is
 * completed with a space after it when more can follow, so the next Tab goes
 * straight on to the next word; a directory or a module prefix (`/module:`)
 * goes on without one.
 */
export function completer(cli: Cli): (line: string) => [string[], string] {
  return (line) => {
    const params = parameterCompletion(cli, line);
    if (params !== undefined) return params;
    const words = line.trimStart().split(/\s+/);
    const partial = words.at(-1) ?? '';
    const offer = offerFor(cli, words, partial);
    if (offer === undefined) return [[], line];
    const hits = offer.candidates.filter((c) => c.startsWith(partial));
    const last = typeof offer.last === 'function' ? offer.last : (): boolean => offer.last === true;
    if (hits.length === 1 && !/[/:]$/.test(hits[0]!) && !last(hits[0]!)) return [[`${hits[0]!} `], partial];
    return [hits, partial];
  };
}

/**
 * After `@`: the profile's named paths. One that takes parameters gets no
 * space after it, so `(` can follow.
 */
function namedPathOffer(
  content: { namedPathTemplate(name: string): { readonly params: readonly string[] } | undefined },
  paths: Readonly<Record<string, string>>,
): Offer {
  const takesParams = (word: string): boolean => (content.namedPathTemplate(word.slice(1))?.params.length ?? 0) > 0;
  return { candidates: Object.keys(paths).map((n) => `@${n}`).sort(), last: takesParams };
}

/**
 * Inside a content command's `@name(…)`, still open at the end of the line:
 * the parameters not yet given (by position or by name), as `param=`, for the
 * argument being typed. Only the names are listed, and a single match is
 * completed with its `=`. Nothing while a value is being typed. Undefined when
 * the line isn't in a named path's arguments.
 */
function parameterCompletion(cli: Cli, line: string): [string[], string] | undefined {
  const m = /^\s*(\S+)\s+@([^\s()]+)\((.*)$/.exec(line);
  if (m === null || cli.session === undefined || !PATH_COMMANDS.includes(m[1]!)) return undefined;
  const args = splitArgs(m[3]!);
  if (args === undefined) return undefined; // closed, or inside a quote
  const template = cli.session.client.content.namedPathTemplate(m[2]!);
  if (template === undefined) return [[], ''];
  const typing = args.pop()!.trimStart();
  if (typing.includes('=') || /^["']/.test(typing)) return [[], typing];
  const named = new Set(args.map((a) => /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(a)?.[1]).filter((n) => n !== undefined));
  const byPosition = args.filter((a) => !/^\s*[A-Za-z_][A-Za-z0-9_]*\s*=/.test(a)).length;
  const open = template.params.filter((p, i) => i >= byPosition && !named.has(p));
  return [open.map((p) => `${p}=`).filter((c) => c.startsWith(typing)), typing];
}

/** A named path's argument text split at commas outside quotes; undefined if a `)` closes it or a quote is open. */
function splitArgs(text: string): string[] | undefined {
  const args: string[] = [];
  let current = '';
  let quote: string | undefined;
  for (const ch of text) {
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ')') return undefined;
    else if (ch === ',') {
      args.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (quote !== undefined) return undefined;
  args.push(current);
  return args;
}

function offerFor(cli: Cli, words: readonly string[], partial: string): Offer | undefined {
  const ops = cli.session === undefined ? [] : operationsOf(cli.session);
  const available = cli.session === undefined ? [] : ops.filter((d) => missingCapabilities(cli.session!, d).length === 0);
  if (words.length <= 1) {
    // A command that takes nothing is the whole line.
    const takesNothing = (name: string): boolean => {
      const cmd = cli.registry.get(name);
      return cmd !== undefined && cmd.args.length === 0 && Object.keys(cmd.options).length === 0 && !available.some((d) => d.name === name);
    };
    return { candidates: [...cli.registry.available(cli.kind).map((c) => c.name), ...available.map((d) => d.name)].sort(), last: takesNothing };
  }
  // A content command's path: modules from the hello after /, the profile's named paths after @.
  if (cli.session !== undefined && words.length === 2 && PATH_COMMANDS.includes(words[0]!)) {
    if (partial.startsWith('@')) return namedPathOffer(cli.session.client.content, cli.session.client.profile?.paths ?? {});
    if (partial.startsWith('/') && !partial.includes(':')) {
      return { candidates: [...new Set(cli.session.client.session.serverCapabilities.helloModules.map((m) => `/${m.name}:`))].sort() };
    }
  }
  // File paths after @ (XML from a file) and after > or >> (a result to a file, the end of the line).
  if (partial.startsWith('@')) return { candidates: completePath(cli.host, partial.slice(1)).map((p) => `@${p}`) };
  const before = words.at(-2);
  if (before === '>' || before === '>>') return { candidates: completePath(cli.host, partial), last: true };
  const op = available.find((d) => d.name === words[0]);
  if (op !== undefined) return { candidates: completeArguments(op, words.slice(1, -1), partial) };
  const cmd = cli.registry.available(cli.kind).find((c) => c.name === words[0]);
  if (cmd !== undefined && cmd.rawLineIn?.includes(cli.kind) !== true) return completeCommand(cli, cmd, words.slice(1, -1), partial);
  return undefined;
}

/** A command's options and argument values, from its spec; `words` are those between its name and the word being typed. */
function completeCommand(cli: Cli, cmd: Command, words: readonly string[], partial: string): Offer {
  const spec = (name: string): OptionSpec | undefined => (Object.prototype.hasOwnProperty.call(cmd.options, name) ? cmd.options[name] : undefined);
  // Options already given (either way, --page or --no-page) aren't offered again, unless they can be repeated.
  const given = new Set(words.filter((w) => w.startsWith('--')).map((w) => w.slice(2).replace(/^no-(?=.)/, '')));
  // A boolean option that's on by default is offered both ways, --page and --no-page.
  const options = Object.keys(cmd.options)
    .filter((n) => cmd.options[n]!.multiple === true || !given.has(n))
    .flatMap((n) => (cmd.options[n]!.type === 'boolean' && cmd.options[n]!.default === 'on' ? [`--${n}`, `--no-${n}`] : [`--${n}`]));
  if (partial.startsWith('-')) return { candidates: options };
  // Walk the words: an option's value isn't an argument, and the word being typed may be one.
  const positional: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const option = w.startsWith('--') ? spec(w.slice(2)) : undefined;
    if (option === undefined) {
      if (!w.startsWith('--')) positional.push(w);
      continue;
    }
    if (option.type !== 'string') continue;
    const arity = option.arity ?? 1;
    if (i + arity >= words.length) {
      return { candidates: option.values ?? (option.value === '<path>' ? completePath(cli.host, partial) : []) };
    }
    i += arity;
  }
  const args = cmd.args;
  const index = positional.length;
  const arg = args[index] ?? (args.at(-1)?.variadic === true ? args.at(-1) : undefined);
  const values = typeof arg?.values === 'function' ? arg.values(cli) : (arg?.values ?? []);
  const more = index + 1 < args.length || arg?.variadic === true || options.length > 0;
  return {
    // A value already given (trace bytes …) isn't offered again.
    candidates: [...values.filter((v) => !positional.includes(v)), ...options],
    last: (word) => !word.startsWith('--') && !more,
  };
}

/** Paths that start with `partial` (`~` is the home directory); directories end in `/`. */
export function completePath(host: NncHost, partial: string): string[] {
  const slash = partial.lastIndexOf('/');
  const dirPart = slash === -1 ? '' : partial.slice(0, slash + 1);
  const base = partial.slice(slash + 1);
  try {
    return host.files
      .list(dirPart === '' ? '.' : expandHome(dirPart, host.homeDir))
      .filter((e) => e.name.startsWith(base) && (base.startsWith('.') || !e.name.startsWith('.')))
      .map((e) => `${dirPart}${e.name}${e.directory ? '/' : ''}`)
      .sort();
  } catch {
    return [];
  }
}
