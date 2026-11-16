/**
 * Transactions (docs/cli.md §6.3, PATH-09..11): `begin` collects `set` and
 * `remove` changes without sending them, `apply` sends them in one edit through
 * the profile's workflow, optionally as a confirmed commit, which `confirm`
 * makes permanent and `revert` rolls back. `changes` lists the queue and
 * `abandon` drops it.
 *
 * The names avoid the base operations `commit`, `cancel-commit` and
 * `discard-changes`, which stay available as they are.
 */

import { TransactionError, type PendingCommit } from '@node-net/netconf/core';
import { CliError, EXIT, usageError } from '../errors.js';
import { guardWrite } from '../guard.js';
import type { Cli } from '../cli.js';
import type { ActiveSession } from '../sessions/active.js';
import { okResult, replay, runWorkflow } from './content.js';
import type { Command, CommandResult } from './registry.js';
import { escapeControls, send } from './results.js';
import { TIMEOUT_OPTION, timeoutOf } from './xml-input.js';

function session(cli: Cli): ActiveSession {
  if (cli.session === undefined) throw new CliError('not connected');
  return cli.session;
}

function open(cli: Cli, command: string): ActiveSession & { transaction: NonNullable<ActiveSession['transaction']> } {
  const s = session(cli);
  if (s.transaction === undefined) throw new CliError(`${command}: no transaction is open (begin starts one)`);
  return s as ActiveSession & { transaction: NonNullable<ActiveSession['transaction']> };
}

const plural = (n: number): string => `${n} change${n === 1 ? '' : 's'}`;

/** `m:ss` until a time, for the prompt and messages. */
export function remaining(until: Date): string {
  const seconds = Math.max(0, Math.ceil((until.getTime() - Date.now()) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export const beginCommand: Command = {
  name: 'begin',
  group: 'content',
  summary: 'Start a transaction: set and remove then queue their changes until apply (or abandon)',
  example: 'begin',
  args: [],
  options: {},
  kinds: ['client'],
  run(cli) {
    const s = session(cli);
    guardWrite(s, 'begin');
    if (s.transaction !== undefined) throw new CliError(`begin: a transaction is already open (${plural(s.transaction.changes.length)} queued); apply or abandon it first`);
    s.transaction = { changes: [] };
    return Promise.resolve({ text: 'transaction started: set and remove now queue their changes; apply sends them', message: true });
  },
};

export const changesCommand: Command = {
  name: 'changes',
  group: 'content',
  summary: "List the open transaction's queued changes, in order",
  example: 'changes',
  args: [],
  options: {},
  kinds: ['client'],
  run(cli) {
    const s = open(cli, 'changes');
    if (s.transaction.changes.length === 0) return Promise.resolve({ text: '(no changes queued)' });
    const lines = s.transaction.changes.map(
      (c, i) => `${String(i + 1).padStart(3)}  ${c.operation.padEnd(6)}  ${escapeControls(c.path)}${c.value === undefined ? '' : `  ${escapeControls(JSON.stringify(c.value))}`}`,
    );
    return Promise.resolve({ text: lines.join('\n') });
  },
};

export const abandonCommand: Command = {
  name: 'abandon',
  group: 'content',
  summary: "Drop the open transaction's queued changes; nothing is sent",
  example: 'abandon',
  args: [],
  options: {},
  kinds: ['client'],
  run(cli) {
    const s = open(cli, 'abandon');
    const n = s.transaction.changes.length;
    (s as ActiveSession).transaction = undefined;
    return Promise.resolve({ text: `transaction abandoned: ${plural(n)} dropped; nothing was sent`, message: true });
  },
};

export const applyCommand: Command = {
  name: 'apply',
  group: 'content',
  mutates: true,
  summary: "Send the transaction's changes in one edit through the profile's workflow (--confirmed: a confirmed commit to confirm or revert)",
  example: 'apply --confirmed --confirm-timeout 120',
  args: [],
  options: {
    confirmed: { type: 'boolean', description: 'commit as a confirmed commit: the device rolls it back unless you confirm it' },
    'confirm-timeout': { type: 'string', value: '<s>', default: '600', description: 'seconds before the device rolls back an unconfirmed commit' },
    persist: { type: 'string', value: '<id>', description: 'let the confirmed commit outlive this session; confirm it from another with commit --persist-id <id>' },
    timeout: TIMEOUT_OPTION,
  },
  kinds: ['client'],
  async run(cli, args, signal): Promise<CommandResult> {
    const s = session(cli);
    guardWrite(s, 'apply');
    if (s.transaction === undefined) throw new CliError('apply: no transaction is open (begin starts one)');
    const confirmed = args.options['confirmed'] === true;
    const given = args.options['confirm-timeout'];
    const persist = args.options['persist'];
    if (!confirmed && (given !== undefined || persist !== undefined)) throw usageError('apply: --confirm-timeout and --persist go with --confirmed');
    let seconds: number | undefined;
    if (given !== undefined) {
      seconds = typeof given === 'string' ? Number(given) : NaN;
      if (!Number.isInteger(seconds) || seconds <= 0) throw usageError('apply: --confirm-timeout must be a positive whole number of seconds');
    }
    // A plain commit would confirm a pending confirmed commit (RFC 6241 §8.4), so settle that first.
    if (s.confirmedCommit !== undefined && s.confirmedCommit.rollbackAt.getTime() > Date.now()) {
      throw new CliError('apply: a confirmed commit is pending; confirm or revert it first (applying now would confirm it); nothing was sent');
    }
    const changes = [...s.transaction.changes];
    if (changes.length === 0) {
      s.transaction = undefined;
      return { text: 'transaction closed: no changes were queued, so nothing was sent', message: true };
    }
    const timeout = timeoutOf(args, 'apply');
    if (!confirmed) {
      await runWorkflow(cli, s, 'apply', timeout, signal, (options) => s.client.content.configure((txn) => replay(txn, changes), options));
      s.transaction = undefined;
      return okResult();
    }
    const options = { ...(seconds !== undefined ? { timeout: seconds } : {}), ...(typeof persist === 'string' ? { persist } : {}) };
    const pending = await runWorkflow(cli, s, 'apply', timeout, signal, (rpc) =>
      send(() => s.client.content.configure((txn) => replay(txn, changes), { ...rpc, confirmed: options })),
    );
    s.transaction = undefined;
    if (pending !== undefined) hold(cli, s, pending);
    cli.showMessage(
      `confirmed commit pending: the device rolls it back in ${remaining(pending?.expires ?? new Date())} unless you confirm it (confirm, or revert to roll back now)\n`,
    );
    return okResult();
  },
};

/** Keep the pending commit, and say when the device rolls it back without a confirm. */
function hold(cli: Cli, s: ActiveSession, pending: PendingCommit): void {
  s.pending = pending;
  s.confirmedCommit = { rollbackAt: pending.expires, persist: pending.persistId };
  const timer = setTimeout(() => {
    if (s.pending !== pending || pending.state === 'confirmed' || pending.state === 'cancelled') return;
    s.pending = undefined;
    s.confirmedCommit = undefined;
    if (cli.session === s) cli.io.notice('the confirmed commit was not confirmed in time: the device rolled the change back');
  }, Math.max(0, pending.expires.getTime() - Date.now()) + 250);
  // Where timers can be unref'd (Node), this one doesn't keep nnc running.
  (timer as { unref?: () => void }).unref?.();
}

function pendingOf(cli: Cli, command: string): { s: ActiveSession; pending: PendingCommit } {
  const s = session(cli);
  guardWrite(s, command);
  const pending = s.pending;
  if (pending === undefined || pending.state !== 'pending') {
    if (s.confirmedCommit !== undefined && s.confirmedCommit.rollbackAt.getTime() > Date.now()) {
      throw new CliError(`${command}: the pending confirmed commit was made with commit --confirmed; use ${command === 'confirm' ? 'commit' : 'cancel-commit'} for it`);
    }
    throw new CliError(`${command}: no confirmed commit is pending (apply --confirmed makes one)`);
  }
  return { s, pending };
}

/** Run a confirm or cancel, turning the library's refusals into messages. */
async function settle(command: string, run: () => Promise<void>): Promise<void> {
  try {
    await send(run);
  } catch (err) {
    if (err instanceof TransactionError && /about to expire|has expired/.test(err.message)) {
      throw new CliError(`${command}: refused: the confirmed commit is about to roll back, or already has; the change may already have been rolled back (check with read)`);
    }
    if (err instanceof TransactionError && err.cause instanceof Error) throw new CliError(`${command}: ${escapeControls(err.cause.message)}`, EXIT.rpcError);
    throw err;
  }
}

export const confirmCommand: Command = {
  name: 'confirm',
  group: 'content',
  mutates: true,
  summary: 'Make the pending confirmed commit (from apply --confirmed) permanent',
  example: 'confirm',
  args: [],
  options: { timeout: TIMEOUT_OPTION },
  kinds: ['client'],
  async run(cli, args) {
    const { s, pending } = pendingOf(cli, 'confirm');
    const timeout = timeoutOf(args, 'confirm');
    await settle('confirm', () => pending.confirm(timeout !== undefined ? { timeout } : {}));
    s.pending = undefined;
    s.confirmedCommit = undefined;
    return okResult();
  },
};

export const revertCommand: Command = {
  name: 'revert',
  group: 'content',
  mutates: true,
  summary: 'Roll back the pending confirmed commit (from apply --confirmed) now',
  example: 'revert',
  args: [],
  options: { timeout: TIMEOUT_OPTION },
  kinds: ['client'],
  async run(cli, args) {
    const { s, pending } = pendingOf(cli, 'revert');
    const timeout = timeoutOf(args, 'revert');
    await settle('revert', () => pending.cancel(timeout !== undefined ? { timeout } : {}));
    s.pending = undefined;
    s.confirmedCommit = undefined;
    return okResult();
  },
};
