/**
 * The Node host's editor and pager (docs/cli.md §6.1, §6.6): $EDITOR and
 * $PAGER run with the terminal handed over to them. Moved from main.ts and
 * commands/xml-input.ts.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LineEditor } from '../host.js';

/**
 * `--edit`: open $EDITOR (else vi) on `text` in a temporary file named for
 * `name`, and resolve to what was saved. An editor that fails, a file left
 * unsaved, or an empty file resolves to undefined.
 */
export async function editText(text: string, name: string, editor: LineEditor | undefined): Promise<string | undefined> {
  const dir = await mkdtemp(join(tmpdir(), 'nnc-edit-'));
  const file = join(dir, `${name}.xml`);
  try {
    await writeFile(file, text);
    const before = (await stat(file)).mtimeMs;
    if ((await runEditor(file, editor)) !== 0) return undefined;
    const saved = (await stat(file)).mtimeMs !== before;
    const edited = (await readFile(file, 'utf8')).trim();
    return saved && edited !== '' ? edited : undefined;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Run $EDITOR (else vi) on a file with the terminal handed over to it, and resolve to its exit status. */
function runEditor(path: string, editor: LineEditor | undefined): Promise<number> {
  const command = process.env['EDITOR'] !== undefined && process.env['EDITOR'] !== '' ? process.env['EDITOR'] : 'vi';
  const raw = process.stdin.isTTY && process.stdin.isRaw;
  editor?.suspend();
  if (raw) process.stdin.setRawMode(false);
  return new Promise((resolve) => {
    // The editor may carry its own arguments (EDITOR="code --wait"), so the shell splits it; the path is passed as $1.
    const child = spawn('/bin/sh', ['-c', `${command} "$1"`, 'nnc-edit', path], { stdio: 'inherit' });
    const finish = (code: number): void => {
      if (raw) process.stdin.setRawMode(true);
      editor?.resume();
      resolve(code);
    };
    child.on('error', () => finish(1));
    child.on('exit', (code) => finish(code ?? 1));
  });
}

/**
 * Show a result through $PAGER (else `less -R`) when standard output is a
 * terminal and the result is taller than it (docs/cli.md §6.6). Resolves to
 * false, leaving the caller to print it, when it doesn't need paging.
 */
export function runPager(text: string, editor: LineEditor | undefined): Promise<boolean> {
  const rows = process.stdout.rows;
  if (!process.stdout.isTTY || rows === undefined || text.split('\n').length - 1 < rows) return Promise.resolve(false);
  const pager = process.env['PAGER'] !== undefined && process.env['PAGER'] !== '' ? process.env['PAGER'] : 'less -R';
  const raw = process.stdin.isTTY && process.stdin.isRaw;
  editor?.suspend();
  if (raw) process.stdin.setRawMode(false);
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', pager], { stdio: ['pipe', 'inherit', 'inherit'] });
    const finish = (paged: boolean): void => {
      if (raw) process.stdin.setRawMode(true);
      editor?.resume();
      resolve(paged);
    };
    // Quitting the pager early closes its input; that's not an error.
    child.stdin.on('error', () => undefined);
    child.stdin.end(text);
    child.on('error', () => finish(false));
    // 126/127: the shell couldn't run the pager (not found, not executable); show the result here instead.
    child.on('exit', (code) => finish(code !== 126 && code !== 127));
  });
}
