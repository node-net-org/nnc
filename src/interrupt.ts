/**
 * Ctrl-C cancels the command in progress through its AbortSignal
 * (docs/cli.md §6.1).
 */

export class Interrupt {
  private active: AbortController | undefined;

  /** Run `work` with a signal that aborts on Ctrl-C. */
  async run<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const previous = this.active;
    this.active = controller;
    try {
      return await work(controller.signal);
    } finally {
      this.active = previous;
    }
  }

  /** Cancel the running command. False when nothing is running. */
  trigger(): boolean {
    if (this.active === undefined) return false;
    this.active.abort(new Error('cancelled (Ctrl-C)'));
    return true;
  }
}

export type SigintAction = 'cancelled' | 'clearLine' | 'ignore';

/** What Ctrl-C does at the prompt: cancel a running command, else clear typed text, else nothing. */
export function sigintAction(line: string, interrupt: Interrupt): SigintAction {
  if (interrupt.trigger()) return 'cancelled';
  return line.length > 0 ? 'clearLine' : 'ignore';
}
