/**
 * Run the built nnc as a subprocess (docs/cli.md §12), with its own HOME so
 * known_hosts, the targets file and history never touch the real ones.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const NNC = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../dist/main.js');

export interface Home {
  readonly dir: string;
  readonly targetsFile: string;
  readonly knownHostsFile: string;
  readonly historyFile: string;
  /** Write the targets file (an object, or raw text). */
  targets(content: object | string): void;
  /** Write ~/.ssh/known_hosts. */
  knownHosts(lines: readonly string[]): void;
  /** Write a file under HOME and return its path. */
  file(name: string, content: string): string;
}

export function makeHome(): Home {
  const dir = mkdtempSync(join(tmpdir(), 'nnc-test-'));
  const config = join(dir, '.config', 'net-netconf');
  mkdirSync(config, { recursive: true });
  mkdirSync(join(dir, '.ssh'), { recursive: true });
  const targetsFile = join(config, 'targets.json');
  const knownHostsFile = join(dir, '.ssh', 'known_hosts');
  return {
    dir,
    targetsFile,
    knownHostsFile,
    historyFile: join(config, 'history'),
    targets: (content) => writeFileSync(targetsFile, typeof content === 'string' ? content : JSON.stringify(content, null, 2)),
    knownHosts: (lines) => writeFileSync(knownHostsFile, lines.map((l) => `${l}\n`).join('')),
    file: (name, content) => {
      const path = join(dir, name);
      writeFileSync(path, content);
      return path;
    },
  };
}

/** A known_hosts line for a test server on 127.0.0.1. */
export function knownHostsLine(port: number, publicKeyLine: string, host = '127.0.0.1'): string {
  return `${port === 22 ? host : `[${host}]:${port}`} ${publicKeyLine}`;
}

export interface RunOptions {
  readonly home: Home;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Text written to standard input, which is then closed. */
  readonly stdin?: string;
  readonly timeoutMs?: number;
}

export interface RunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export function childEnv(home: Home, extra: Readonly<Record<string, string | undefined>> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home.dir, NO_COLOR: '1' };
  delete env['SSH_AUTH_SOCK'];
  delete env['NNC_TARGETS'];
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

export function startNnc(args: readonly string[], options: Omit<RunOptions, 'stdin'>): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [NNC, ...args], { env: childEnv(options.home, options.env), cwd: options.home.dir });
}

/** Run nnc to completion. */
export function runNnc(args: readonly string[], options: RunOptions): Promise<RunResult> {
  const child = startNnc(args, options);
  return collect(child, options.stdin ?? '', options.timeoutMs ?? 20_000);
}

export function collect(child: ChildProcessWithoutNullStreams, stdin: string | undefined, timeoutMs = 20_000): Promise<RunResult> {
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
  child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
  if (stdin !== undefined) {
    child.stdin.end(stdin);
  }
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`nnc did not exit within ${timeoutMs} ms\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    });
  });
}

/** Resolve once `stream` has printed text matching `pattern`. */
export function waitFor(child: ChildProcessWithoutNullStreams, stream: 'stdout' | 'stderr', pattern: RegExp, timeoutMs = 10_000): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let seen = '';
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${pattern} on ${stream}; saw: ${seen}`)), timeoutMs);
    const onData = (c: Buffer): void => {
      seen += c.toString();
      if (pattern.test(seen)) {
        clearTimeout(timer);
        child[stream].off('data', onData);
        resolvePromise(seen);
      }
    };
    child[stream].on('data', onData);
  });
}
