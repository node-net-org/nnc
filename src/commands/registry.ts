/**
 * Commands and the registry that holds them (docs/cli.md §11).
 *
 * A command declares its arguments, its options and the session kinds it runs
 * in, and returns a result rather than printing, so the prompt, one-shot mode
 * and tests all treat it alike.
 */

import { usageError } from '../errors.js';
import type { Word } from '../lexer.js';
import type { Cli } from '../cli.js';

/** `none` means no session is open. */
export type SessionKind = 'none' | 'client' | 'framed' | 'raw';

export interface OptionSpec {
  readonly type: 'boolean' | 'string';
  readonly description: string;
  /** Placeholder for the value in help, e.g. `<ms>`. */
  readonly value?: string;
  /** Number of words the value takes (default 1); a two-word value is given as a pair. */
  readonly arity?: 1 | 2;
  /** The option may be given more than once; its value is then the list of values. */
  readonly multiple?: boolean;
  /** Allowed values, for help. */
  readonly values?: readonly string[];
  /** The value used when the option isn't given, for help. */
  readonly default?: string;
}

export interface ArgSpec {
  readonly name: string;
  readonly description: string;
  readonly optional?: boolean;
  /** The last argument only: it takes every remaining word. */
  readonly variadic?: boolean;
  /**
   * The words Tab offers for this argument: fixed, or worked out from the CLI's
   * state (target names, the session's commands). Offered, not enforced.
   */
  readonly values?: readonly string[] | ((cli: Cli) => readonly string[]);
}

/** A reply's result in each output format; the CLI shows the one asked for (docs/cli.md §6.6). */
export interface ResultForms {
  /** Pretty-printed XML, or plain text where the result isn't XML. */
  readonly xml: string;
  /**
   * A human view (compare's diff), shown by default: when neither --xml,
   * --json nor --raw is given and the `output` format is xml. --xml shows `xml`.
   */
  readonly text?: string;
  readonly json?: string;
  /**
   * The JSON form, worked out only when asked for: YANG data as RFC 7951 JSON,
   * which may read the device's schemas. `show-last --json` uses it in place of `json`.
   */
  readonly jsonLater?: () => Promise<string>;
  /** The <rpc-reply> exactly as received; the CLI attaches it after the command. */
  readonly raw?: string;
}

/**
 * What a command produces: text (a newline is added when printed) or raw text written exactly.
 * `message` marks text that reports what happened (connected, disconnected) rather than a result:
 * at the prompt it is shown like a result; without a prompt it goes to standard error (docs/cli.md §10).
 * `warnings` (rpc-error warning blocks) are shown on standard error after the result.
 * `forms` makes the result a reply the output format applies to; `text` is then its XML form.
 * `bytes` is written to a redirect's file unchanged, while the screen gets `screen` (received data).
 */
export type CommandResult =
  | undefined
  | { readonly text: string; readonly message?: boolean; readonly warnings?: readonly string[]; readonly forms?: ResultForms }
  | { readonly raw: string }
  | { readonly bytes: Uint8Array; readonly screen: string };

/** The RFC 6241 layers `help` lists commands by, top-down (docs/cli.md §6.2); `help <layer>` shows one. */
export const LAYERS = ['content', 'operations', 'messages', 'transport'] as const;
export type Layer = (typeof LAYERS)[number];

/** Where `help` lists a command: a layer, or one of the sections beside the layers (docs/cli.md §6.2). */
export type CommandGroup = Layer | 'profile' | 'connection' | 'nnc';

/**
 * One place `help` lists a command, for a command listed differently by session
 * kind (hello) or listed twice (set <path> and set on-error).
 */
export interface HelpListing {
  readonly group: CommandGroup;
  /** Session kinds this listing applies to (default: all the command's kinds). */
  readonly kinds?: readonly SessionKind[];
  /** What help shows as the name (default: the command's name). */
  readonly label?: string;
  /** The one-line description (default: the command's own). */
  readonly summary?: string;
  /** Marked * in help (default: the command's `mutates`). */
  readonly mutates?: boolean;
}

/** An option's value: a flag, a word, or a list (a two-word option, or a repeated one). */
export type OptionValue = string | boolean | readonly string[];

export interface ParsedArgs {
  readonly positional: readonly string[];
  readonly options: Readonly<Record<string, OptionValue | undefined>>;
}

export interface Command {
  readonly name: string;
  readonly summary: string;
  readonly args: readonly ArgSpec[];
  readonly options: Readonly<Record<string, OptionSpec>>;
  /**
   * Accept options not in `options` (as strings, or true when no value follows),
   * for commands whose options come from descriptors at run time.
   */
  readonly freeOptions?: boolean;
  /** Session kinds the command is offered in. */
  readonly kinds: readonly SessionKind[];
  /** Where `help` lists it. */
  readonly group: CommandGroup;
  /** Where `help` lists it, where that depends on the session kind or the command is listed twice; overrides `group`. */
  readonly listings?: readonly HelpListing[];
  /**
   * Can change device state: marked * in help. Display only; the read-only guard
   * decides from descriptors and its own checks.
   */
  readonly mutates?: boolean;
  /** A typical use, shown by `help <command>`. */
  readonly example?: string;
  /** What the command does in a session kind, where that differs from `summary` (shown by help in that kind). */
  readonly describe?: Partial<Record<SessionKind, string>>;
  /**
   * Session kinds in which the command takes the rest of the line verbatim, as its one argument:
   * no quoting, comments, options or redirects, and the line never continues onto the next.
   */
  readonly rawLineIn?: readonly SessionKind[];
  /** More for `help <command>`, from the open session (a device profile's operations, say). */
  moreHelp?(cli: Cli): readonly string[];
  run(cli: Cli, args: ParsedArgs, signal: AbortSignal): Promise<CommandResult>;
}

export function usageOf(cmd: Command): string {
  const args = cmd.args.map((a) => {
    const name = `<${a.name}>${a.variadic === true ? '...' : ''}`;
    return a.optional === true ? `[${name}]` : name;
  });
  const opts = Object.entries(cmd.options).map(([name, o]) => (o.type === 'boolean' ? `[--${name}]` : `[--${name} ${o.value ?? '<value>'}]`));
  return [cmd.name, ...args, ...opts].join(' ');
}

/** Split words into positional arguments and options, checking them against the command's spec. */
export function parseArgs(cmd: Command, words: readonly Word[]): ParsedArgs {
  const positional: string[] = [];
  const options: Record<string, OptionValue> = {};
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (!w.literal && w.text.startsWith('--') && w.text.length > 2) {
      const name = w.text.slice(2);
      const spec = Object.prototype.hasOwnProperty.call(cmd.options, name) ? cmd.options[name] : undefined;
      // --no-<flag> sets a boolean option to false.
      if (spec === undefined && name.startsWith('no-')) {
        const flag = name.slice(3);
        const flagSpec = Object.prototype.hasOwnProperty.call(cmd.options, flag) ? cmd.options[flag] : undefined;
        if (flagSpec?.type === 'boolean') {
          options[flag] = false;
          continue;
        }
      }
      if (spec === undefined && cmd.freeOptions === true) {
        const next = words[i + 1];
        if (next !== undefined && (next.literal || !next.text.startsWith('--'))) {
          options[name] = next.text;
          i++;
        } else options[name] = true;
        continue;
      }
      if (spec === undefined) {
        const near = closest(name, Object.keys(cmd.options));
        throw usageError(`${cmd.name}: unknown option --${name}${near === undefined ? '' : ` (did you mean --${near}?)`}\nusage: ${usageOf(cmd)}`);
      }
      if (spec.type === 'boolean') options[name] = true;
      else if (spec.arity === 2) {
        const a = words[i + 1];
        const b = words[i + 2];
        if (a === undefined || b === undefined) throw usageError(`${cmd.name}: --${name} needs two values: ${spec.value ?? '<a> <b>'}\nusage: ${usageOf(cmd)}`);
        options[name] = [a.text, b.text];
        i += 2;
      } else {
        const value = words[i + 1];
        if (value === undefined) throw usageError(`${cmd.name}: --${name} needs a value\nusage: ${usageOf(cmd)}`);
        if (spec.multiple === true) {
          const before = options[name];
          options[name] = [...(Array.isArray(before) ? (before as readonly string[]) : []), value.text];
        } else options[name] = value.text;
        i++;
      }
    } else positional.push(w.text);
  }
  const required = cmd.args.filter((a) => a.optional !== true).length;
  if (positional.length < required) {
    throw usageError(`${cmd.name}: missing <${cmd.args[positional.length]!.name}>\nusage: ${usageOf(cmd)}`);
  }
  if (positional.length > cmd.args.length && cmd.args.at(-1)?.variadic !== true) {
    throw usageError(`${cmd.name}: unexpected argument ${JSON.stringify(positional[cmd.args.length])}\nusage: ${usageOf(cmd)}`);
  }
  return { positional, options };
}

/** The candidate nearest to `word`: a prefix match, or within two edits. */
export function closest(word: string, candidates: readonly string[]): string | undefined {
  const prefixed = candidates.filter((c) => c.startsWith(word));
  if (prefixed.length === 1) return prefixed[0];
  let best: string | undefined;
  let bestDistance = 3;
  for (const c of candidates) {
    const d = distance(word, c);
    if (d < bestDistance) {
      best = c;
      bestDistance = d;
    }
  }
  return best;
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_v, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = temp;
    }
  }
  return row[b.length]!;
}

export class Registry {
  private readonly commands = new Map<string, Command>();

  add(...commands: readonly Command[]): this {
    for (const c of commands) {
      if (this.commands.has(c.name)) throw new TypeError(`command ${c.name} is registered twice`);
      this.commands.set(c.name, c);
    }
    return this;
  }

  get(name: string): Command | undefined {
    return this.commands.get(name);
  }

  /** Every command name, sorted. */
  names(): string[] {
    return [...this.commands.keys()].sort();
  }

  /** Commands offered in this session kind, by name. */
  available(kind: SessionKind): Command[] {
    return [...this.commands.values()].filter((c) => c.kinds.includes(kind)).sort((a, b) => a.name.localeCompare(b.name));
  }
}
