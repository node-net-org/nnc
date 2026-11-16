/**
 * Run nnc on a pseudo-terminal, through util-linux script(1), for what only
 * happens on a terminal: colour, paging, line editing and redrawing the prompt
 * (docs/cli.md §12). Tests using it are skipped where script(1) isn't there.
 */
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { childEnv, NNC, type Home } from './nnc.js';

export const HAS_PTY = (() => {
  const r = spawnSync('script', ['--version'], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.includes('util-linux');
})();

/** One step: wait for the output (escape sequences removed) to match `wait`, if given, then type `send`. */
export interface Step {
  readonly wait?: RegExp;
  readonly send?: string;
  /** Pause before typing, in ms. */
  readonly pause?: number;
  /** Run when the step's wait is satisfied, before typing. */
  readonly then?: () => void | Promise<void>;
}

export interface PtyOptions {
  readonly home: Home;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly rows?: number;
  readonly cols?: number;
  readonly timeoutMs?: number;
}

const quote = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;

/** The terminal output of a run, with \r\n as \n. Resolves when nnc exits. */
export function runPty(args: readonly string[], steps: readonly Step[], options: PtyOptions): Promise<string> {
  const { home, rows = 24, cols = 100, timeoutMs = 20_000 } = options;
  const command = `stty rows ${rows} cols ${cols}; exec ${[process.execPath, NNC, ...args].map(quote).join(' ')}`;
  const child = spawn('script', ['-qfec', command, '/dev/null'], { env: childEnv(home, options.env ?? {}), cwd: home.dir });
  let out = '';
  child.stdout.on('data', (c: Buffer) => (out += c.toString()));
  child.stderr.on('data', (c: Buffer) => (out += c.toString()));
  const until = async (pattern: RegExp, from: number): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!pattern.test(plain(out.slice(from)))) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${pattern}; output so far:\n${JSON.stringify(out)}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  const done = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`nnc did not exit; output:\n${JSON.stringify(out)}`));
    }, timeoutMs);
    child.on('close', () => {
      clearTimeout(timer);
      resolve(out.replaceAll('\r\n', '\n'));
    });
  });
  void (async () => {
    let from = 0;
    for (const step of steps) {
      if (step.wait !== undefined) {
        await until(step.wait, from);
        from = out.length;
      }
      if (step.then !== undefined) await step.then();
      if (step.pause !== undefined) await new Promise((r) => setTimeout(r, step.pause));
      if (step.send !== undefined) {
        // One key at a time, as typed: a burst reads as a paste, where Tab is text, not completion.
        for (const key of keys(step.send)) {
          child.stdin.write(key);
          await new Promise((r) => setTimeout(r, 15));
        }
      }
    }
  })().catch((err: unknown) => {
    child.kill('SIGKILL');
    out += `\n[steps failed: ${(err as Error).message}]`;
  });
  return done;
}

/** The keys in typed text: escape sequences (arrows, Home, End) stay whole. */
function keys(text: string): string[] {
  // eslint-disable-next-line no-control-regex
  return text.match(/\u001b\[[0-9;]*[A-Za-z~]|[\s\S]/g) ?? [];
}

/** SGR colour sequences (not readline's cursor movement). */
// eslint-disable-next-line no-control-regex
export const SGR = /\u001b\[\d+(;\d+)*m/;

/** Text without escape sequences. */
export function plain(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
}

/**
 * A pager that records what it was given (and its arguments) to `log`, then
 * prints `[paged N lines]`. Returns the command for $PAGER, and a directory
 * holding a `less` that does the same, for testing the default.
 */
export function recordingPager(home: Home): { command: string; log: string; binDir: string; saw: () => string } {
  mkdirSync(home.dir, { recursive: true });
  const dir = mkdtempSync(join(home.dir, 'pager-'));
  const log = join(dir, 'paged.log');
  const script = join(dir, 'pager.mjs');
  writeFileSync(
    script,
    `import { appendFileSync, readFileSync } from 'node:fs';
const text = readFileSync(0, 'utf8');
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), text }) + '\\n');
process.stdout.write('[paged ' + (text.split('\\n').length - 1) + ' lines]\\n');
`,
  );
  const less = join(dir, 'less');
  writeFileSync(less, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`);
  chmodSync(less, 0o755);
  return {
    command: `${process.execPath} ${script}`,
    log,
    binDir: dir,
    saw: () => (existsSync(log) ? readFileSync(log, 'utf8') : ''),
  };
}
