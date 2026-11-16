/**
 * Where secrets come from (docs/cli.md §8, §9): a file, an environment
 * variable, a prompt, or an SSH agent. Never from a command or the targets file.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { CliError, EXIT } from '../errors.js';
import type { SecretPrompt } from '../host.js';
import { expandHome as expandFrom } from '../paths.js';
import type { PasswordSource } from '../targets.js';

const expandHome = (path: string): string => expandFrom(path, homedir());

export type { SecretPrompt };

/**
 * Read a password source. `what` names it in prompts and errors, e.g. `admin@router1`,
 * or `key ~/.ssh/id_lab` for a key's passphrase (`noun` 'passphrase').
 */
export async function readSecret(source: PasswordSource, what: string, prompt: SecretPrompt, noun: SecretNoun = 'password'): Promise<string> {
  if ('file' in source) {
    const path = expandHome(source.file);
    try {
      return (await readFile(path, 'utf8')).trim();
    } catch (err) {
      throw new CliError(`cannot read the ${noun} file for ${what} (${path}): ${(err as NodeJS.ErrnoException).code ?? 'error'}`, EXIT.connection);
    }
  }
  if ('env' in source) {
    const value = process.env[source.env];
    if (value === undefined) throw new CliError(`the ${noun} for ${what} comes from $${source.env}, which is not set`, EXIT.connection);
    return value;
  }
  return askSecret(`${noun === 'password' ? 'Password' : 'Passphrase'} for ${what}: `, prompt, noun);
}

/** What a secret is, in prompts and errors. */
export type SecretNoun = 'password' | 'passphrase';

export async function askSecret(text: string, prompt: SecretPrompt, noun: SecretNoun = 'password'): Promise<string> {
  const value = await prompt(text);
  if (value === undefined) throw new CliError(`no ${noun} given (input ended)`, EXIT.connection);
  return value;
}

/**
 * The agent socket to use, or undefined. Unless `agent` is true, an endpoint
 * with its own password or key doesn't offer the agent's keys: each key the
 * server refuses counts against its failed-login limit (MaxAuthTries,
 * lockouts), unlike OpenSSH's default. `agent: true` without a running agent
 * is an error.
 */
export function agentSocket(agent: boolean | undefined, what: string, hasOwnCredentials: boolean): string | undefined {
  if (agent === false || (agent === undefined && hasOwnCredentials)) return undefined;
  const sock = process.env['SSH_AUTH_SOCK'];
  if (sock === undefined || sock === '') {
    if (agent === true) throw new CliError(`${what} uses the SSH agent, but SSH_AUTH_SOCK is not set`, EXIT.connection);
    return undefined;
  }
  return sock;
}

export async function readKeyFile(path: string, what: string): Promise<Buffer> {
  const full = expandHome(path);
  try {
    return await readFile(full);
  } catch (err) {
    throw new CliError(`cannot read the private key for ${what} (${full}): ${(err as NodeJS.ErrnoException).code ?? 'error'}`, EXIT.connection);
  }
}
