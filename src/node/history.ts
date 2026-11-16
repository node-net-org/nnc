/**
 * Persistent command history.
 *
 * Only command lines are recorded. No command takes a secret, and secrets are
 * read through a prompt that never reaches here (docs/cli.md §9).
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { HistoryStore } from '../host.js';

/** The history kept in ~/.config/net-netconf/history, as the Node host offers it. */
export function nodeHistory(path = historyPath()): HistoryStore {
  return {
    load: () => loadHistory(path),
    append: (line) => appendHistory(line, path),
  };
}

/** History kept, in the file and in memory (docs/cli.md §6.2). */
const MAX_LOADED = 1000;

export function historyPath(): string {
  return join(homedir(), '.config', 'net-netconf', 'history');
}

/** Earlier commands, oldest first. A missing or unreadable file is an empty history. */
export function loadHistory(path = historyPath()): string[] {
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '')
      .slice(-MAX_LOADED);
  } catch {
    return [];
  }
}

/** Append a command. Failure to write history never fails the command. */
export function appendHistory(line: string, path = historyPath()): void {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed === 'exit') return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${trimmed}\n`, { mode: 0o600 });
    // Keep the file to the last MAX_LOADED commands.
    const all = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim() !== '');
    if (all.length > MAX_LOADED) writeFileSync(path, `${all.slice(-MAX_LOADED).join('\n')}\n`, { mode: 0o600 });
  } catch {
    // ignore: history is a convenience
  }
}
