/**
 * Drive an interactive nnc (`-i`) a line at a time, for framed and raw
 * sessions, where what the server sends arrives between commands.
 */
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { collect, startNnc, type Home, type RunResult } from './nnc.js';

export interface Driver {
  /** Type a line (a newline is added). Standard output printed before it is no longer waited on. */
  line(text: string): void;
  /** Resolve once `stream`, after what earlier waits on it consumed, matches `pattern`; returns the match's text up to its end. */
  until(stream: 'stdout' | 'stderr', pattern: RegExp, timeoutMs?: number): Promise<string>;
  /** Everything printed so far. */
  out(): string;
  err(): string;
  /** End input and wait for nnc to exit. */
  finish(): Promise<RunResult>;
}

export function drive(args: readonly string[], home: Home, env?: Readonly<Record<string, string | undefined>>): Driver {
  const child: ChildProcessWithoutNullStreams = startNnc(['-i', ...args], { home, ...(env !== undefined ? { env } : {}) });
  const text = { stdout: '', stderr: '' };
  const cursor = { stdout: 0, stderr: 0 };
  const waiters: (() => void)[] = [];
  const wake = (): void => {
    for (const w of waiters.splice(0)) w();
  };
  child.stdout.on('data', (c: Buffer) => ((text.stdout += c.toString()), wake()));
  child.stderr.on('data', (c: Buffer) => ((text.stderr += c.toString()), wake()));
  const result = collect(child, undefined, 30_000);
  return {
    line: (t) => {
      cursor.stdout = text.stdout.length;
      child.stdin.write(`${t}\n`);
    },
    until: (stream, pattern, timeoutMs = 10_000) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timed out waiting for ${pattern} on ${stream}; saw:\n${text[stream].slice(cursor[stream])}\n--- other stream:\n${text[stream === 'stdout' ? 'stderr' : 'stdout']}`)),
          timeoutMs,
        );
        const check = (): void => {
          const rest = text[stream].slice(cursor[stream]);
          const m = pattern.exec(rest);
          if (m === null) {
            waiters.push(check);
            return;
          }
          clearTimeout(timer);
          const seen = rest.slice(0, m.index + m[0].length);
          cursor[stream] += seen.length;
          resolve(seen);
        };
        check();
      }),
    out: () => text.stdout,
    err: () => text.stderr,
    finish: () => {
      child.stdin.end();
      return result;
    },
  };
}

export const NS = 'urn:ietf:params:xml:ns:netconf:base:1.0';
/** An <rpc> with a message-id, as typed at the prompt. */
export const rpc = (id: string, body = '<get/>'): string => `<rpc message-id="${id}" xmlns="${NS}">${body}</rpc>`;
